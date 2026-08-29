import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import { readableEmailBody } from "../src/google.js";
import { eventFingerprint, validateEventDraft } from "../src/event-validation.js";
import { isOpenRouterBatchModel, OpenRouterService, openRouterInferenceModelId } from "../src/openrouter.js";

function withDatabase(run: (database: AppDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  try { run(database); } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("candidate validation rejects reversed dates", () => {
  assert.throws(() => validateEventDraft({ title: "Bad", start: "2027-01-02T12:00:00Z", end: "2027-01-02T11:00:00Z" }, "UTC"), /end must be after/i);
});

test("duplicate candidates group source messages", () => withDatabase((database) => {
  database.queueMessage({ id: "mail-1", threadId: "thread-1", internalDate: "1" });
  database.queueMessage({ id: "mail-2", threadId: "thread-2", internalDate: "2" });
  const draft = validateEventDraft({ title: "Robotics Club", start: "2027-01-02T12:00:00Z", end: "2027-01-02T13:00:00Z", location: "Lab", timezone: "UTC" }, "UTC");
  const fingerprint = eventFingerprint(draft);
  const first = database.saveCandidate(draft, "mail-1", fingerprint, "calendar");
  const second = database.saveCandidate(draft, "mail-2", fingerprint, "calendar");
  assert.equal(first, second);
  assert.deepEqual(database.getCandidate(first)?.sourceMessageIds.sort(), ["mail-1", "mail-2"]);
}));

test("queue claim and retry preserve durable state", () => withDatabase((database) => {
  assert.equal(database.queueMessage({ id: "mail", threadId: "thread", internalDate: "1" }), true);
  assert.equal(database.queueMessage({ id: "mail", threadId: "thread", internalDate: "1" }), false);
  assert.equal(database.claimMessage()?.gmailId, "mail");
  database.finishMessage("mail", "temporary failure");
  assert.equal(database.getQueueStatus().queued, 1);
}));

test("readableEmailBody uses HTML when plain text is only whitespace", () => {
  const body = readableEmailBody({ text: "\n\n\n", html: "<p>Robotics club meets Thursday</p>" });
  assert.match(body, /Robotics club meets Thursday/);
});

test("queue claims are unique under contention", () => withDatabase((database) => {
  database.queueMessage({ id: "a", threadId: "a", internalDate: "1" });
  database.queueMessage({ id: "b", threadId: "b", internalDate: "2" });
  database.queueMessage({ id: "c", threadId: "c", internalDate: "3" });
  const claimed = [database.claimMessage(), database.claimMessage(), database.claimMessage(), database.claimMessage()]
    .flatMap((row) => row ? [row.gmailId] : []);
  assert.deepEqual(claimed.sort(), ["a", "b", "c"]);
}));

test("reclaimProcessing returns abandoned claims to the queue", () => withDatabase((database) => {
  database.queueMessage({ id: "stuck", threadId: "stuck", internalDate: "1" });
  assert.equal(database.claimMessage()?.gmailId, "stuck");
  assert.equal(database.reclaimProcessing(), 1);
  assert.equal(database.getQueueStatus().queued, 1);
  assert.equal(database.getQueueStatus().processing, 0);
}));

test("retryFailedMessages returns failed messages to the queue", () => withDatabase((database) => {
  database.queueMessage({ id: "failed", threadId: "failed", internalDate: "1" });
  database.failMessage("failed", "provider error");
  assert.equal(database.retryFailedMessages(), 1);
  assert.equal(database.getQueueStatus().failed, 0);
  assert.equal(database.getQueueStatus().queued, 1);
  assert.equal(database.claimMessage()?.attempts, 1);
}));

test("claimAllQueued marks every queued message processing", () => withDatabase((database) => {
  database.queueMessage({ id: "a", threadId: "a", internalDate: "1" });
  database.queueMessage({ id: "b", threadId: "b", internalDate: "2" });
  assert.deepEqual(database.claimAllQueued().map((row) => row.gmailId).sort(), ["a", "b"]);
  assert.equal(database.getQueueStatus().queued, 0);
  assert.equal(database.getQueueStatus().processing, 2);
}));

test("OpenRouter batch slugs keep a separate inference id", () => {
  assert.equal(isOpenRouterBatchModel("anthropic/claude-sonnet-4.6:batch"), true);
  assert.equal(isOpenRouterBatchModel("anthropic/claude-sonnet-4.6"), false);
  assert.equal(openRouterInferenceModelId("anthropic/claude-sonnet-4.6:batch"), "anthropic/claude-sonnet-4.6");
});

test("OpenRouter login stores a separate credential from Codex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  try {
    await database.modify("openai-codex", async () => ({ type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 }));
    await new OpenRouterService(database).login("Bearer \"sk-or-test-key-123456789\"");
    assert.equal((await database.read("openai-codex"))?.type, "oauth");
    assert.deepEqual(await database.read("openrouter"), { type: "api_key", key: "sk-or-test-key-123456789" });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("OpenRouter login rejects non-key text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  try {
    await assert.rejects(new OpenRouterService(database).login("ordinary sentence text"), /valid OpenRouter API key/);
    assert.equal(await database.read("openrouter"), undefined);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("OpenRouter authenticates batch submission and polling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    const service = new OpenRouterService(database);
    const model = service.listModels().find((item) => item.batch);
    assert.ok(model);
    database.updateSettings({ modelProvider: "openrouter", modelId: model.id });
    await service.login("sk-or-test-key-123456789");
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return new Response(JSON.stringify({ id: "batch-test", status: "validating" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (requests.length === 2) return new Response(JSON.stringify({ error: { message: "Batch job batch-test not found." } }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ id: "batch-test", status: "completed", results: [{ custom_id: "mail", error: "expected test result" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const results = await service.classifyEmails([{
      id: "mail", threadId: "thread", subject: "Subject", sender: "sender@example.com",
      date: "2026-08-26T12:00:00Z", body: "Body", calendarText: "", gmailUrl: "https://mail.google.com/mail/u/0/#all/mail",
    }]);
    assert.equal(results[0]?.error, "expected test result");
    assert.equal(requests.length, 3);
    for (const request of requests) assert.equal(new Headers(request.init?.headers).get("Authorization"), "Bearer sk-or-test-key-123456789");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
