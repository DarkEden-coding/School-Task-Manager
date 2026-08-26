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
  const openai = { isConnected: async () => true } as unknown as OpenAIService;
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
  } finally { await app.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
