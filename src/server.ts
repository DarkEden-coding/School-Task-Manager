import { join } from "node:path";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { DocumentAgent } from "./agent.js";
import { AuthService } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import type { AppDatabase } from "./database.js";
import type { DocumentStore } from "./documents.js";
import { assertApprovable } from "./event-validation.js";
import type { GoogleService } from "./google.js";
import type { OpenAIService } from "./openai.js";
import { isOpenRouterBatchSettings } from "./openrouter.js";
import type { AppSettings, EventDraft, ModelProviderId, SchoolAssignmentInput, SchoolClassInput, SchoolTermInput } from "./types.js";
import type { ScanWorker } from "./worker.js";

interface Services { database: AppDatabase; google: GoogleService; openai: OpenAIService; documents: DocumentStore; agent: DocumentAgent; worker: ScanWorker; }

/** Builds the localhost web server and its authenticated JSON API. */
export async function createServer(config: RuntimeConfig, services: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 45_000_000 });
  const auth = new AuthService(services.database, config.secureCookies);
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 5_000_000, files: 8, fields: 10, parts: 18 } });
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
      openrouterConnected: await services.openai.isOpenRouterConnected(),
      pendingCount: services.database.listCandidates("pending").length,
      queuedCount: queue.queued,
      failedCount: queue.failed,
      lastSuccessfulScan: services.database.getMarker("lastSuccessfulScan"),
      nextScan: `${settings.scanTime} ${settings.timezone}`,
      scanRunning: worker.running,
      scanPaused: settings.scanPaused,
      lastError: worker.lastError,
      school: services.database.getSchoolDashboard(),
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
  app.post("/api/openrouter/login", mutationGuard, async (request) => {
    await services.openai.openrouter.login(stringBody(request.body, "apiKey"));
    return { connected: true };
  });
  app.get("/api/openrouter/models", sessionGuard, async (request) => {
    const query = typeof (request.query as { q?: unknown }).q === "string" ? (request.query as { q: string }).q : "";
    return services.openai.openrouter.listModels(query);
  });

  app.get("/api/school", sessionGuard, async () => services.database.getSchoolDashboard());
  app.get("/api/school/dashboard", sessionGuard, async () => services.database.getSchoolDashboard());
  app.get("/api/terms", sessionGuard, async () => services.database.listTerms());
  app.post("/api/terms", mutationGuard, async (request) => services.database.createTerm(termInput(request.body)));
  app.patch("/api/terms/:id", mutationGuard, async (request) => services.database.updateTerm(routeId(request.params), termPatch(request.body)));
  app.delete("/api/terms/:id", mutationGuard, async (request) => { services.database.deleteTerm(routeId(request.params)); return { ok: true }; });
  app.get("/api/classes", sessionGuard, async (request) => services.database.listClasses(optionalQueryId(request.query, "termId")));
  app.post("/api/classes", mutationGuard, async (request) => services.database.createClass(classInput(request.body)));
  app.patch("/api/classes/:id", mutationGuard, async (request) => services.database.updateClass(routeId(request.params), classPatch(request.body)));
  app.delete("/api/classes/:id", mutationGuard, async (request) => { services.database.deleteClass(routeId(request.params)); return { ok: true }; });
  app.get("/api/assignments", sessionGuard, async (request) => services.database.listAssignments(optionalQueryId(request.query, "classId")));
  app.post("/api/assignments", mutationGuard, async (request) => services.database.createAssignment(assignmentInput(request.body)));
  app.patch("/api/assignments/:id", mutationGuard, async (request) => services.database.updateAssignment(routeId(request.params), assignmentPatch(request.body)));
  app.post("/api/assignments/:id/complete", mutationGuard, async (request) => services.database.completeAssignment(routeId(request.params)));
  app.post("/api/assignments/:id/reopen", mutationGuard, async (request) => services.database.reopenAssignment(routeId(request.params)));
  app.delete("/api/assignments/:id", mutationGuard, async (request) => { services.database.deleteAssignment(routeId(request.params)); return { ok: true }; });

  app.get("/api/documents", sessionGuard, async () => services.documents.list());
  app.post("/api/documents", mutationGuard, async (request) => {
    const saved = [];
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new Error("Each file must be smaller than 5 MB");
        saved.push(services.documents.addSource(part.filename, part.mimetype || "application/octet-stream", buffer, "upload"));
      } else if (part.fieldname === "text" && String(part.value).trim()) {
        saved.push(services.documents.addSource("Pasted text.txt", "text/plain", Buffer.from(String(part.value).slice(0, 100_000)), "paste"));
      }
    }
    if (!saved.length) throw new Error("Provide pasted text or at least one file");
    return saved;
  });
  app.get("/api/agent/conversations", sessionGuard, async () => services.agent.listConversations());
  app.post("/api/agent/conversations", mutationGuard, async () => services.agent.createConversation());
  app.get("/api/agent/conversations/:id", sessionGuard, async (request) => services.agent.getConversation(routeId(request.params)));
  app.post("/api/agent/conversations/:id/messages", mutationGuard, async (request, reply) => {
    const text = stringBody(request.body, "text");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const emit = (event: Record<string, unknown>): void => { reply.raw.write(`${JSON.stringify(event)}\n`); };
    try { await services.agent.run(routeId(request.params), text, emit); } catch (error) { emit({ type: "error", text: error instanceof Error ? error.message : String(error) }); }
    reply.raw.end();
  });
  app.post("/api/agent/confirmations/:id", mutationGuard, async (request, reply) => {
    const confirm = Boolean((request.body as { confirm?: unknown })?.confirm);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const emit = (event: Record<string, unknown>): void => { reply.raw.write(`${JSON.stringify(event)}\n`); };
    try { await services.agent.resolveConfirmation(routeId(request.params), confirm, emit); } catch (error) { emit({ type: "error", text: error instanceof Error ? error.message : String(error) }); }
    reply.raw.end();
  });

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
  app.get("/api/queue", sessionGuard, async () => {
    const queue = services.database.getQueueStatus();
    const worker = services.worker.status();
    const settings = services.database.getSettings();
    return {
      ...queue,
      paused: settings.scanPaused,
      running: worker.running,
      batchMode: isOpenRouterBatchSettings(settings),
      batchState: worker.batchState,
      batchMessage: worker.batchMessage,
      runTotal: worker.runTotal,
      runCompleted: worker.runCompleted,
      providerCompleted: worker.providerCompleted,
    };
  });
  app.post("/api/queue/pause", mutationGuard, async () => services.database.updateSettings({ scanPaused: true }));
  app.post("/api/queue/resume", mutationGuard, async () => { const settings = services.database.updateSettings({ scanPaused: false }); void services.worker.processQueue(); return settings; });
  app.post("/api/queue/retry-failed", mutationGuard, async () => {
    const retried = services.database.retryFailedMessages();
    if (!services.database.getSettings().scanPaused) void services.worker.processQueue();
    return { retried };
  });

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
  if (!Number.isInteger(id) || id < 1) throw new Error("Invalid id");
  return id;
}

/** Validates a JSON object and rejects fields outside its public contract. */
function schoolBody(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error("Unknown school data field");
  return record;
}
function requiredString(record: Record<string, unknown>, key: string): string { if (typeof record[key] !== "string") throw new Error(`${key} is required`); return record[key]; }
function optionalString(record: Record<string, unknown>, key: string): string | undefined { if (!(key in record)) return undefined; if (typeof record[key] !== "string") throw new Error(`${key} must be a string`); return record[key] as string; }
function optionalId(record: Record<string, unknown>, key: string): number | undefined { if (!(key in record)) return undefined; const value = record[key]; if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${key} must be a positive integer`); return value as number; }
function termInput(body: unknown): SchoolTermInput { const r = schoolBody(body, ["name", "start", "end", "status"]); const status = requiredString(r, "status"); if (status !== "active" && status !== "archived") throw new Error("Invalid term status"); return { name: requiredString(r, "name"), start: requiredString(r, "start"), end: requiredString(r, "end"), status }; }
function termPatch(body: unknown): Partial<SchoolTermInput> { const r = schoolBody(body, ["name", "start", "end", "status"]); const result: Partial<SchoolTermInput> = {}; for (const key of ["name", "start", "end"] as const) { const value = optionalString(r, key); if (value !== undefined) result[key] = value; } if ("status" in r) { const status = requiredString(r, "status"); if (status !== "active" && status !== "archived") throw new Error("Invalid term status"); result.status = status; } return result; }
function classInput(body: unknown): SchoolClassInput { const r = schoolBody(body, classFields); return { termId: requiredId(r, "termId"), name: requiredString(r, "name"), code: requiredString(r, "code"), instructor: requiredString(r, "instructor"), contact: requiredString(r, "contact"), schedule: requiredString(r, "schedule"), location: requiredString(r, "location"), officeHours: requiredString(r, "officeHours"), links: requiredString(r, "links"), syllabusNotes: requiredString(r, "syllabusNotes"), notes: requiredString(r, "notes") }; }
const classFields = ["termId", "name", "code", "instructor", "contact", "schedule", "location", "officeHours", "links", "syllabusNotes", "notes"] as const;
function classPatch(body: unknown): Partial<SchoolClassInput> { const r = schoolBody(body, classFields); return patchFields(r, classFields) as Partial<SchoolClassInput>; }
const assignmentFields = ["classId", "title", "due", "type", "usefulLink", "notes", "warningMinutes"] as const;
function assignmentInput(body: unknown): SchoolAssignmentInput { const r = schoolBody(body, assignmentFields); return { classId: requiredId(r, "classId"), title: requiredString(r, "title"), due: nullableString(r, "due", true) as string | null, type: requiredString(r, "type"), usefulLink: requiredString(r, "usefulLink"), notes: requiredString(r, "notes"), warningMinutes: nullableInteger(r, "warningMinutes", true) as number | null }; }
function assignmentPatch(body: unknown): Partial<SchoolAssignmentInput> { const r = schoolBody(body, assignmentFields); return patchFields(r, assignmentFields) as Partial<SchoolAssignmentInput>; }
function requiredId(record: Record<string, unknown>, key: string): number { return optionalId(record, key) ?? (() => { throw new Error(`${key} is required`); })(); }
function nullableString(record: Record<string, unknown>, key: string, required = false): string | null | undefined { if (!(key in record)) { if (required) throw new Error(`${key} is required`); return undefined; } if (record[key] !== null && typeof record[key] !== "string") throw new Error(`${key} must be a string or null`); return record[key] as string | null; }
function nullableInteger(record: Record<string, unknown>, key: string, required = false): number | null | undefined { if (!(key in record)) { if (required) throw new Error(`${key} is required`); return undefined; } if (record[key] !== null && !Number.isInteger(record[key])) throw new Error(`${key} must be an integer or null`); return record[key] as number | null; }
function patchFields(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> { const result: Record<string, unknown> = {}; for (const field of fields) { if (!(field in record)) continue; result[field] = field === "termId" || field === "classId" ? requiredId(record, field) : field === "due" ? nullableString(record, field) : field === "warningMinutes" ? nullableInteger(record, field) : optionalString(record, field); } return result; }
function optionalQueryId(query: unknown, key: string): number | undefined { const value = (query as Record<string, unknown>)[key]; if (value === undefined) return undefined; const id = Number(value); if (!Number.isInteger(id) || id < 1) throw new Error(`Invalid ${key}`); return id; }

/** Checks the fixed file signatures for accepted screenshot formats. */
function hasImageSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/gif") return buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a";
  return mimeType === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

/** Validates consequential settings before persistence. */
function validateSettings(patch: Partial<AppSettings>): void {
  if (patch.scanTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.scanTime)) throw new Error("Scan time must use HH:MM");
  if (patch.timezone) try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }); } catch { throw new Error("Invalid timezone"); }
  if (patch.gmailLabelIds && (!Array.isArray(patch.gmailLabelIds) || patch.gmailLabelIds.some((id) => typeof id !== "string"))) throw new Error("Invalid Gmail labels");
  if (patch.interests && patch.interests.length > 5000) throw new Error("Interest profile is too long");
  if (patch.filterRules && patch.filterRules.length > 5000) throw new Error("Filter rules are too long");
  if (patch.schoolImportRules !== undefined && (typeof patch.schoolImportRules !== "string" || patch.schoolImportRules.length > 5000)) throw new Error("School import rules are too long");
  if (patch.modelProvider && !isModelProvider(patch.modelProvider)) throw new Error("Invalid model provider");
}

function importSelections(body: unknown): Array<{ id: number; payload?: Record<string, unknown> }> {
  const items = (body as { items?: unknown })?.items; if (!Array.isArray(items) || items.length > 1000) throw new Error("items must be a bounded array");
  return items.map((item) => { if (!item || typeof item !== "object" || !Number.isInteger((item as {id?:unknown}).id)) throw new Error("Invalid import item"); const payload = (item as {payload?:unknown}).payload; if (payload !== undefined && (!payload || typeof payload !== "object" || Array.isArray(payload))) throw new Error("Invalid import payload"); return { id: (item as {id:number}).id, ...(payload ? { payload: payload as Record<string, unknown> } : {}) }; });
}

/** Narrows a settings value to a known model provider. */
function isModelProvider(value: string): value is ModelProviderId {
  return value === "openai-codex" || value === "openrouter";
}
