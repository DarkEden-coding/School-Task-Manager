import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import { eventFingerprint, validateEventDraft } from "../src/event-validation.js";
import type { GoogleService } from "../src/google.js";
import type { OpenAIService } from "../src/openai.js";
import { ScanWorker } from "../src/worker.js";

test("successful scans advance and reuse the Gmail checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const checkpoints: Array<number | undefined> = [];
  const google = {
    isConnected: () => true,
    queueMessages: async (_labels: string[], after?: number) => { checkpoints.push(after); return 0; },
  } as unknown as GoogleService;
  const worker = new ScanWorker(database, google, {} as OpenAIService);
  try {
    await worker.scanNow();
    const first = database.getMarker("lastSuccessfulScan");
    assert.ok(first);
    await worker.scanNow();
    assert.equal(checkpoints[0], undefined);
    assert.equal(checkpoints[1], Math.floor(Date.parse(first) / 1000));
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("scanned school mail stages assignments for review without creating classes or deadline events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const email = { id: "mail-1", subject: "Homework 1 due Friday", sender: "prof@example.edu", date: "2027-01-01T12:00:00Z", body: "Homework 1 is due Friday", calendarText: "", gmailUrl: "https://mail.google.com/mail/u/0/#all/mail-1" };
  database.queueMessage({ id: email.id, threadId: "thread-1", internalDate: "1" });
  const school = [{ kind: "assignment" as const, operation: "createOrUpdate" as const, payload: { classId: null, className: "Calculus", classCode: "MATH 101", termName: "Spring", title: "Homework 1", due: "2027-01-08T17:00:00Z", type: "Homework", usefulLink: email.gmailUrl, notes: "", warningMinutes: null } }];
  const google = { getMessage: async () => email } as unknown as GoogleService;
  const openai = { classifyEmail: async () => ({ events: [], school }) } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    await worker.processQueue();
    assert.equal(database.getQueueStatus().processed, 1);
    assert.equal(database.listCandidates().length, 0);
    assert.equal(database.listClasses().length, 0);
    assert.equal(database.listAssignments().length, 0);
    const imports = database.listSchoolImports();
    assert.equal(imports.length, 1);
    assert.equal(database.getSchoolImport(imports[0]!.id)?.items[0]?.kind, "assignment");
    assert.equal(database.getSchoolImport(imports[0]!.id)?.items[0]?.payload.title, "Homework 1");
    database.stageGmailSchoolImport(email.id, school);
    assert.equal(database.listSchoolImports().length, 1);
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("scanned event mail stages a calendar proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  database.updateSettings({ calendarId: "calendar-1" });
  const email = { id: "mail-event", subject: "Robotics meetup", sender: "club@example.edu", date: "2027-01-01T12:00:00Z", body: "Meet in the lab", calendarText: "", gmailUrl: "https://mail.google.com/mail/u/0/#all/mail-event" };
  database.queueMessage({ id: email.id, threadId: "thread-event", internalDate: "1" });
  const draft = validateEventDraft({ title: "Robotics meetup", start: "2027-01-08T17:00:00Z", end: "2027-01-08T18:00:00Z", timezone: "UTC" }, "UTC");
  const google = { getMessage: async () => email } as unknown as GoogleService;
  const openai = { classifyEmail: async () => ({ school: [], events: [{ draft, fingerprint: eventFingerprint(draft), changeKind: "create" as const }] }) } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    await worker.processQueue();
    assert.equal(database.getQueueStatus().processed, 1);
    assert.equal(database.listCandidates()[0]?.title, "Robotics meetup");
    assert.equal(database.listSchoolImports().length, 0);
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
