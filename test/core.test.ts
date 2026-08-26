import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import { readableEmailBody } from "../src/google.js";
import { eventFingerprint, validateEventDraft } from "../src/event-validation.js";

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
