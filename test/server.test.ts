import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import { validateEventDraft, eventFingerprint } from "../src/event-validation.js";
import { createServer } from "../src/server.js";
import type { GoogleService } from "../src/google.js";
import type { OpenAIService } from "../src/openai.js";
import type { ScanWorker } from "../src/worker.js";

const config = { host: "127.0.0.1", port: 8787, baseUrl: "http://127.0.0.1:8787", secureCookies: false } as const;

test("processed email override requires a session and CSRF token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-server-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  database.queueMessage({ id: "mail-skipped", threadId: "thread", internalDate: "1234567890000", subject: "General notice" });
  database.claimMessage();
  database.skipJevMessage("mail-skipped", { school: 0.03, event: 0.04, opportunity: 0.06 });
  const worker = { scheduleJevOverride: (id: string) => database.scheduleJevOverride(id, "2027-04-02") } as unknown as ScanWorker;
  const app = await createServer({ ...config, stateDir: directory }, { database, google: {} as GoogleService, openai: {} as OpenAIService, worker });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/messages" })).statusCode, 401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery staple" } });
    const cookie = { cookie: `email_manager_session=${setup.cookies[0]?.value}` };
    const csrf = setup.json().csrfToken as string;
    const list = await app.inject({ method: "GET", url: "/api/messages", headers: cookie });
    assert.equal(list.json()[0].jevResult, "skipped");
    assert.equal(list.json()[0].subject, "General notice");
    assert.equal((await app.inject({ method: "POST", url: "/api/messages/mail-skipped/override", headers: cookie })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/messages/mail-skipped/override", headers: { ...cookie, "x-csrf-token": csrf } })).statusCode, 200);
    assert.equal(database.listProcessedMessages()[0]?.overrideAt, "2027-04-02");
  } finally { await app.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("approval is idempotent across repeated requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-server-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  database.queueMessage({ id: "mail", threadId: "thread", internalDate: "1" });
  const draft = validateEventDraft({ title: "Hike", start: "2027-04-01T15:00:00Z", end: "2027-04-01T17:00:00Z", timezone: "UTC", location: "Trail" }, "UTC");
  const id = database.saveCandidate(draft, "mail", eventFingerprint(draft), "calendar");
  let writes = 0;
  const google = {
    isConnected: () => true,
    applyCandidate: async () => { writes += 1; return "event-id"; },
  } as unknown as GoogleService;
  const openai = { isConnected: async () => true, isOpenRouterConnected: async () => false } as unknown as OpenAIService;
  const worker = { status: () => ({ running: false, lastError: null }) } as unknown as ScanWorker;
  const app = await createServer({ ...config, stateDir: directory }, { database, google, openai, worker });
  try {
    const unauthenticated = await app.inject({ method: "GET", url: "/api/dashboard" });
    assert.equal(unauthenticated.statusCode, 401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery staple" } });
    assert.equal(setup.statusCode, 200);
    const cookie = setup.cookies[0]?.value;
    const csrf = setup.json().csrfToken as string;
    const cookieHeader = { cookie: `email_manager_session=${cookie}` };
    const rejected = await app.inject({ method: "POST", url: `/api/candidates/${id}/approve`, headers: cookieHeader });
    assert.equal(rejected.statusCode, 403);
    const headers = { ...cookieHeader, "x-csrf-token": csrf };
    const first = await app.inject({ method: "POST", url: `/api/candidates/${id}/approve`, headers });
    const second = await app.inject({ method: "POST", url: `/api/candidates/${id}/approve`, headers });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(writes, 1);

    const secondId = database.saveCandidate({ ...draft, title: "Second hike" }, "mail", "second-hike", "calendar");
    const thirdId = database.saveCandidate({ ...draft, title: "Third hike" }, "mail", "third-hike", "calendar");
    assert.equal((await app.inject({ method: "POST", url: "/api/candidates/deny-all" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/candidates/deny-all", headers: cookieHeader })).statusCode, 403);
    const denied = await app.inject({ method: "POST", url: "/api/candidates/deny-all", headers });
    assert.equal(denied.json().denied, 2);
    assert.equal(database.getCandidate(secondId)?.status, "denied");
    assert.equal(database.getCandidate(thirdId)?.status, "denied");
    assert.equal(database.getCandidate(id)?.status, "approved");
    assert.equal((await app.inject({ method: "POST", url: "/api/candidates/deny-all", headers })).json().denied, 0);

    const termPayload = { name: "Fall 2027", start: "2027-08-01", end: "2027-12-20", status: "active" };
    assert.equal((await app.inject({ method: "POST", url: "/api/terms", headers: cookieHeader, payload: termPayload })).statusCode, 403);
    const term = await app.inject({ method: "POST", url: "/api/terms", headers, payload: termPayload });
    assert.equal(term.statusCode, 200);
    assert.equal(term.json().name, "Fall 2027");
    assert.equal((await app.inject({ method: "GET", url: "/api/school/dashboard", headers: cookieHeader })).json().terms.length, 1);
  } finally { await app.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
