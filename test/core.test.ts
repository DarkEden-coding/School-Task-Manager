import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { schoolItemsFromToolCall } from "../src/classify.js";
import { AppDatabase } from "../src/database.js";
import { readableEmailBody } from "../src/google.js";
import { eventFingerprint, validateEventDraft } from "../src/event-validation.js";
import { isExpiredCodexAuthError } from "../src/openai.js";
import { isOpenRouterBatchModel, OpenRouterService, openRouterInferenceModelId } from "../src/openrouter.js";

test("dedicated school import tool rejects unsafe payload fields", () => {
  const base = { type: "toolCall" as const, id: "1", name: "submit_school_import" };
  assert.throws(() => schoolItemsFromToolCall({ ...base, arguments: { school: [{ kind: "term", operation: "createOrUpdate", payload: { name: "Fall", start: "2026-08-01", end: "2026-12-01", status: "active", unsafe: true } }] } }));
  assert.deepEqual(schoolItemsFromToolCall({ ...base, arguments: { school: [{ kind: "assignment", operation: "createOrUpdate", payload: { classId: 7, className: "Biology", classCode: "BIO 101", termName: "Fall", title: "Lab", due: null, type: "lab", usefulLink: "", notes: "", warningMinutes: 60 } }] } }), [{ kind: "assignment", operation: "createOrUpdate", payload: { classId: 7, className: "Biology", classCode: "BIO 101", termName: "Fall", title: "Lab", due: null, type: "lab", usefulLink: "", notes: "", warningMinutes: 60 } }]);
});

function withDatabase(run: (database: AppDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  try { run(database); } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("school migration preserves existing data and CRUD keeps completion durable", () => withDatabase((database) => {
  database.updateSettings({ calendarId: "existing-calendar" });
  const term = database.createTerm({ name: "Spring 2027", start: "2027-01-01", end: "2027-05-01", status: "active" });
  const schoolClass = database.createClass({ termId: term.id, name: "Algorithms", code: "CS 301", instructor: "Ada", contact: "ada@example.test", schedule: "MW", location: "Room 1", officeHours: "Friday", links: "", syllabusNotes: "", notes: "" });
  const assignment = database.createAssignment({ classId: schoolClass.id, title: "Proof", due: "2027-02-01T12:00:00Z", type: "Homework", usefulLink: "", notes: "", warningMinutes: 30 });
  assert.equal(database.getSettings().calendarId, "existing-calendar");
  assert.equal(database.getSchoolDashboard().assignments[0]?.status, "open");
  database.completeAssignment(assignment.id);
  const edited = database.updateAssignment(assignment.id, { title: "Proof revised", due: null });
  assert.equal(edited.status, "done");
  assert.ok(edited.completedAt);
  assert.deepEqual(database.listClasses(term.id).map((item) => item.id), [schoolClass.id]);
  database.deleteTerm(term.id);
  assert.equal(database.getAssignment(assignment.id), undefined);
}));

test("school import creates a related term, class, and assignment atomically", () => withDatabase((database) => {
  const proposal = database.stageSchoolImport("text", [
    { kind: "term", operation: "createOrUpdate", payload: { name: "Fall 2027", start: "2027-08-20", end: "2027-12-20", status: "active" } },
    { kind: "class", operation: "createOrUpdate", payload: { termId: null, termName: "Fall 2027", name: "Biology", code: "BIO 101", instructor: "", contact: "", schedule: "", location: "", officeHours: "", links: "", syllabusNotes: "", notes: "" } },
    { kind: "assignment", operation: "createOrUpdate", payload: { classId: null, className: "Biology", classCode: "BIO 101", termName: "Fall 2027", title: "Lab 1", due: "2027-09-01T17:00:00Z", type: "Lab", usefulLink: "", notes: "", warningMinutes: 1440 } },
  ]);
  database.applySchoolImport(proposal.id, proposal.items.map((item) => ({ id: item.id })));
  assert.equal(database.listTerms()[0]?.name, "Fall 2027");
  assert.equal(database.listClasses()[0]?.code, "BIO 101");
  assert.equal(database.listAssignments()[0]?.title, "Lab 1");
  assert.equal(database.getSchoolImport(proposal.id), undefined);
}));

test("school import flags due-date conflicts and preserves completion", () => withDatabase((database) => {
  const term = database.createTerm({ name: "Spring", start: "2027-01-01", end: "2027-05-01", status: "active" });
  const schoolClass = database.createClass({ termId: term.id, name: "Math", code: "MATH 1", instructor: "", contact: "", schedule: "", location: "", officeHours: "", links: "", syllabusNotes: "", notes: "" });
  const assignment = database.createAssignment({ classId: schoolClass.id, title: "Quiz", due: "2027-02-01T12:00:00Z", type: "", usefulLink: "", notes: "", warningMinutes: null });
  database.completeAssignment(assignment.id);
  const proposal = database.stageSchoolImport("text", [{ kind: "assignment", operation: "createOrUpdate", payload: { classId: schoolClass.id, className: "Math", classCode: "MATH 1", termName: "Spring", title: "Quiz", due: "2027-02-02T12:00:00Z", type: "", usefulLink: "", notes: "", warningMinutes: null } }]);
  assert.deepEqual(proposal.items[0]?.conflicts, ["due"]);
  database.applySchoolImport(proposal.id, [{ id: proposal.items[0]!.id }]);
  assert.equal(database.getAssignment(assignment.id)?.status, "done");
  assert.equal(database.getAssignment(assignment.id)?.due, "2027-02-02T12:00:00Z");
}));

test("school import does not cross term boundaries and Gmail retries deduplicate", () => withDatabase((database) => {
  const term = database.createTerm({ name: "Spring", start: "2027-01-01", end: "2027-05-01", status: "active" });
  database.createClass({ termId: term.id, name: "Biology", code: "BIO 101", instructor: "", contact: "", schedule: "", location: "", officeHours: "", links: "", syllabusNotes: "", notes: "" });
  const extracted = [{ kind: "class" as const, operation: "createOrUpdate" as const, payload: { termId: null, termName: "Unknown term", name: "Biology", code: "BIO 101", instructor: "", contact: "", schedule: "", location: "", officeHours: "", links: "", syllabusNotes: "", notes: "" } }];
  const proposal = database.stageSchoolImport("text", extracted);
  assert.equal(proposal.items[0]?.action, "create");
  assert.equal(proposal.items[0]?.targetId, null);
  database.stageGmailSchoolImport("message-1", extracted);
  database.stageGmailSchoolImport("message-1", extracted);
  assert.equal(database.listSchoolImports().filter((item) => item.inputMethod === "gmail").length, 1);
  assert.throws(() => database.stageSchoolImport("text", []), /no school records/i);
}));

test("agent can stage an update for a Google Calendar event ID", () => withDatabase((database) => {
  const draft = validateEventDraft({ title: "Moved lab", start: "2027-02-02T12:00:00Z", end: "2027-02-02T13:00:00Z", timezone: "UTC" }, "UTC");
  const candidate = database.saveAgentCandidate(draft, eventFingerprint(draft), "calendar", "update", undefined, "google-event-id_123");
  assert.equal(candidate.changeKind, "update");
  assert.equal(candidate.targetCalendarEventId, "google-event-id_123");
}));

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

test("expired Codex authentication errors are recognized", () => {
  assert.equal(isExpiredCodexAuthError(new Error("Provided authentication token is expired")), true);
  assert.equal(isExpiredCodexAuthError(new Error("Agent request timed out")), false);
});

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

test("OpenRouter lists live catalog models with batch variants and reasoning levels", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://openrouter.ai/api/v1/models");
      return new Response(JSON.stringify({ data: [{
        id: "brand-new/model-9", name: "Brand New: Model 9", context_length: 200000,
        pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0" },
        top_provider: { max_completion_tokens: 64000 },
        supported_parameters: ["reasoning_effort"], reasoning: { supported_efforts: ["high", "low", "none"] },
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const service = new OpenRouterService(database);
    const models = await service.listModels();
    const live = models.find((item) => item.id === "brand-new/model-9");
    assert.ok(live);
    assert.deepEqual(live.reasoningLevels, ["off", "low", "high"]);
    assert.deepEqual(models.find((item) => item.id === "brand-new/model-9:batch"), { ...live, id: "brand-new/model-9:batch", batch: true });
    assert.ok(models.some((item) => item.id === "aion-labs/aion-2.0"), "bundled catalog stays listed");
    const resolved = await service.listModels("brand-new");
    assert.ok(resolved.every((item) => item.id.includes("brand-new")));
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// The batch test below runs with the live-models cache pre-warmed by the test above,
// so its /api/v1/models mock response is only a safety net for cache expiry.
test("OpenRouter authenticates batch submission and polling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    const service = new OpenRouterService(database);
    const model = (await service.listModels()).find((item) => item.batch);
    assert.ok(model);
    database.updateSettings({ modelProvider: "openrouter", modelId: model.id });
    await service.login("sk-or-test-key-123456789");
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      requests.push({ url, init });
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
    for (const request of requests) {
      assert.equal(new Headers(request.init?.headers).get("Authorization"), "Bearer sk-or-test-key-123456789");
    }
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
