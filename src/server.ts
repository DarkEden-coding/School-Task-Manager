import { join } from "node:path";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AuthService } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import type { AppDatabase } from "./database.js";
import { assertApprovable } from "./event-validation.js";
import type { GoogleService } from "./google.js";
import type { OpenAIService } from "./openai.js";
import type { AppSettings, EventDraft } from "./types.js";
import type { ScanWorker } from "./worker.js";

interface Services { database: AppDatabase; google: GoogleService; openai: OpenAIService; worker: ScanWorker; }

/** Builds the localhost web server and its authenticated JSON API. */
export async function createServer(config: RuntimeConfig, services: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
  const auth = new AuthService(services.database, config.secureCookies);
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 100_000, files: 1 } });
  await app.register(staticFiles, { root: join(process.cwd(), "public"), wildcard: false });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://auth.openai.com https://chatgpt.com");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  app.get("/api/bootstrap", async (request) => {
    const session = auth.getSession(request);
    return { configured: auth.isConfigured(), authenticated: Boolean(session), csrfToken: session?.csrfToken ?? null, googleCallbackUrl: `${config.baseUrl}/api/google/callback` };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    const password = stringBody(request.body, "password");
    auth.setPassword(password);
    return auth.createSession(reply);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const password = stringBody(request.body, "password");
    if (!auth.verifyPassword(password)) { await new Promise((resolve) => setTimeout(resolve, 750)); return reply.code(401).send({ error: "Invalid password" }); }
    return auth.createSession(reply);
  });

  app.post("/api/auth/logout", { preHandler: auth.requireCsrf.bind(auth) }, async (request, reply) => { auth.logout(request, reply); return { ok: true }; });

  const sessionGuard = { preHandler: auth.requireSession.bind(auth) };
  const mutationGuard = { preHandler: auth.requireCsrf.bind(auth) };

  app.get("/api/dashboard", sessionGuard, async () => {
    const queue = services.database.getQueueStatus();
    const worker = services.worker.status();
    const settings = services.database.getSettings();
    return {
      setupComplete: Boolean(services.database.getMarker("initialScanComplete")),
      googleConnected: services.google.isConnected(),
      openaiConnected: await services.openai.isConnected(),
      pendingCount: services.database.listCandidates("pending").length,
      queuedCount: queue.queued,
      failedCount: queue.failed,
      lastSuccessfulScan: services.database.getMarker("lastSuccessfulScan"),
      nextScan: `${settings.scanTime} ${settings.timezone}`,
      scanRunning: worker.running,
      scanPaused: settings.scanPaused,
      lastError: worker.lastError,
    };
  });

  app.get("/api/settings", sessionGuard, async () => services.database.getSettings());
  app.patch("/api/settings", mutationGuard, async (request) => {
    const patch = request.body as Partial<AppSettings>;
    validateSettings(patch);
    const settings = services.database.updateSettings(patch);
    if (!settings.scanPaused) void services.worker.processQueue();
    return settings;
  });

  app.post("/api/google/client", mutationGuard, async (request) => {
    const part = await request.file();
    if (!part) throw new Error("Choose a Google OAuth client JSON file");
    const content = await part.toBuffer();
    services.google.saveClientJson(JSON.parse(content.toString("utf8")) as unknown);
    return { ok: true };
  });
  app.get("/api/google/connect", sessionGuard, async () => ({ url: services.google.getAuthorizationUrl() }));
  app.get("/api/google/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) throw new Error(`Google authorization failed: ${query.error}`);
    if (!query.code || !query.state) throw new Error("Google callback is missing code or state");
    await services.google.acceptAuthorizationCode(query.code, query.state);
    return reply.redirect("/#setup-google-connected");
  });
  app.get("/api/google/labels", sessionGuard, async () => services.google.listLabels());
  app.get("/api/google/calendars", sessionGuard, async () => services.google.listCalendars());

  app.post("/api/openai/login", mutationGuard, async (request) => {
    const method = stringBody(request.body, "method");
    if (method !== "browser" && method !== "device_code") throw new Error("Invalid OpenAI login method");
    return services.openai.startLogin(method);
  });
  app.get("/api/openai/login", sessionGuard, async () => services.openai.loginStatus());
  app.get("/api/openai/models", sessionGuard, async () => services.openai.listModels());

  app.get("/api/candidates", sessionGuard, async (request) => {
    const status = (request.query as { status?: string }).status === "history" ? "history" : "pending";
    return services.database.listCandidates(status);
  });
  app.patch("/api/candidates/:id", mutationGuard, async (request) => services.database.updateCandidate(routeId(request.params), request.body as Partial<EventDraft & { calendarId: string }>));
  app.post("/api/candidates/:id/deny", mutationGuard, async (request) => {
    const id = routeId(request.params);
    const candidate = services.database.getCandidate(id);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.status === "pending") services.database.setCandidateStatus(id, "denied");
    return services.database.getCandidate(id);
  });
  app.post("/api/candidates/:id/approve", mutationGuard, async (request) => {
    const id = routeId(request.params);
    const candidate = services.database.getCandidate(id);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.status !== "pending") return candidate;
    if (candidate.changeKind !== "cancel") assertApprovable(candidate);
    if (!candidate.calendarId) throw new Error("Choose a destination calendar");
    const relatedId = services.database.getRelatedCandidateId(id);
    const related = relatedId ? services.database.getCandidate(relatedId) : undefined;
    const calendarEventId = await services.google.applyCandidate(candidate, related);
    services.database.setCandidateStatus(id, "approved", calendarEventId);
    if (relatedId && candidate.changeKind !== "create") services.database.setCandidateStatus(relatedId, "superseded");
    return services.database.getCandidate(id);
  });

  app.post("/api/scan/count", mutationGuard, async () => services.worker.countInitialScan());
  app.post("/api/scan/confirm", mutationGuard, async (request) => services.worker.confirmInitialScan(Number((request.body as { runId?: number }).runId)));
  app.post("/api/scan/now", mutationGuard, async () => services.worker.scanNow("manual"));
  app.get("/api/queue", sessionGuard, async () => services.database.getQueueStatus());
  app.post("/api/queue/pause", mutationGuard, async () => services.database.updateSettings({ scanPaused: true }));
  app.post("/api/queue/resume", mutationGuard, async () => { const settings = services.database.updateSettings({ scanPaused: false }); void services.worker.processQueue(); return settings; });

  app.setNotFoundHandler(async (request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
  app.setErrorHandler(async (failure, request, reply) => {
    request.log.error(failure);
    const error = failure instanceof Error ? failure : new Error(String(failure));
    const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400;
    const status = statusCode >= 400 ? statusCode : 400;
    return reply.code(status).send({ error: status >= 500 ? "Internal server error" : error.message });
  });
  return app;
}

/** Extracts a required string property from a JSON request body. */
function stringBody(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>)[key] !== "string") throw new Error(`${key} is required`);
  return (body as Record<string, string>)[key]!;
}

/** Parses a positive integer route parameter. */
function routeId(params: unknown): number {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id) || id < 1) throw new Error("Invalid candidate id");
  return id;
}

/** Validates consequential settings before persistence. */
function validateSettings(patch: Partial<AppSettings>): void {
  if (patch.scanTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.scanTime)) throw new Error("Scan time must use HH:MM");
  if (patch.timezone) try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }); } catch { throw new Error("Invalid timezone"); }
  if (patch.gmailLabelIds && (!Array.isArray(patch.gmailLabelIds) || patch.gmailLabelIds.some((id) => typeof id !== "string"))) throw new Error("Invalid Gmail labels");
  if (patch.interests && patch.interests.length > 5000) throw new Error("Interest profile is too long");
  if (patch.filterRules && patch.filterRules.length > 5000) throw new Error("Filter rules are too long");
}
