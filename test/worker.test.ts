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
  const worker = new ScanWorker(database, google, { openrouter: { isConnected: async () => false } } as unknown as OpenAIService);
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
  const openai = { openrouter: { isConnected: async () => false }, classifyEmail: async () => ({ events: [], school }) } as unknown as OpenAIService;
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

test("Jev skips low-scoring mail and a next-day override processes it without scoring again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  database.queueMessage({ id: "mail-skipped", threadId: "thread-skipped", internalDate: "1234567890000" });
  database.updateSettings({ timezone: "UTC" });
  database.setMarker("lastScheduledDate", new Date().toISOString().slice(0, 10));
  const email = { id: "mail-skipped", subject: "Robotics event", sender: "club@example.edu", date: "2027-01-01T12:00:00Z", body: "Nothing new", calendarText: "", gmailUrl: "https://mail.google.com/mail/u/0/#all/mail-skipped" };
  let scored = 0;
  let classified = 0;
  const google = { getMessage: async () => email } as unknown as GoogleService;
  const openai = {
    openrouter: { isConnected: async () => true, prefilterEmail: async () => { scored++; return { school: 0.03, event: 0.07, opportunity: 0.09 }; } },
    classifyEmail: async () => { classified++; return { events: [], school: [] }; },
  } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    await worker.processQueue();
    assert.equal(classified, 0);
    assert.equal(scored, 1);
    assert.equal(database.listProcessedMessages()[0]?.jevResult, "skipped");
    assert.equal(database.listProcessedMessages()[0]?.subject, email.subject);
    assert.equal(database.listProcessedMessages()[0]?.sender, email.sender);
    assert.equal(database.listProcessedMessages()[0]?.internalDate, String(Date.parse(email.date)));
    worker.scheduleJevOverride("mail-skipped");
    const row = database.listProcessedMessages()[0]!;
    assert.equal(row.override, true);
    assert.ok(row.overrideAt);
    assert.equal(database.releaseJevOverrides(new Date().toISOString().slice(0, 10)), 0);
    assert.equal(database.releaseJevOverrides(row.overrideAt!), 1);
    await worker.processQueue();
    assert.equal(scored, 1);
    assert.equal(classified, 1);
    assert.equal(database.listProcessedMessages()[0]?.status, "processed");
    assert.equal(database.listProcessedMessages()[0]?.override, true);
    assert.deepEqual(database.listProcessedMessages()[0]?.jevScores, { school: 0.03, event: 0.07, opportunity: 0.09 });
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("daily scan releases scheduled overrides into normal processing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const today = new Date().toISOString().slice(0, 10);
  database.updateSettings({ timezone: "UTC", scanTime: "00:00" });
  database.setMarker("initialScanComplete", today);
  database.queueMessage({ id: "mail-due", threadId: "thread", internalDate: "1234567890000" });
  database.claimMessage();
  database.skipJevMessage("mail-due", { school: 0.02, event: 0.03, opportunity: 0.04 });
  database.scheduleJevOverride("mail-due", today);
  let classified = 0;
  const google = { isConnected: () => true, queueMessages: async () => 0, getMessage: async () => ({ id: "mail-due", subject: "", sender: "", date: today, body: "", calendarText: "", gmailUrl: "" }) } as unknown as GoogleService;
  const openai = { openrouter: { isConnected: async () => true, prefilterEmail: async () => { throw new Error("Jev should be bypassed"); } }, classifyEmail: async () => { classified++; return { events: [], school: [] }; } } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    worker.start();
    for (let i = 0; i < 70 && (!classified || database.listProcessedMessages()[0]?.status !== "processed" || worker.status().running); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(classified, 1, JSON.stringify({ worker: worker.status(), queue: database.getQueueStatus(), rows: database.listProcessedMessages(), lastScan: database.getMarker("lastScheduledDate") }));
    assert.equal(database.listProcessedMessages()[0]?.status, "processed");
    assert.equal(database.listProcessedMessages()[0]?.overrideAt, null);
    assert.equal(database.getMarker("lastScheduledDate"), today);
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Jev failure passes through to the main classifier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-worker-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  database.queueMessage({ id: "mail-error", threadId: "thread-error", internalDate: "1234567890000" });
  const google = { getMessage: async () => ({ id: "mail-error", subject: "Homework", sender: "teacher@example.edu", date: "2027-01-01", body: "Assignment due soon", calendarText: "", gmailUrl: "" }) } as unknown as GoogleService;
  let classified = 0;
  const openai = { openrouter: { isConnected: async () => true, prefilterEmail: async () => { throw new Error("Jev unavailable"); } }, classifyEmail: async () => { classified++; return { events: [], school: [] }; } } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    await worker.processQueue();
    assert.equal(classified, 1);
    assert.equal(database.listProcessedMessages()[0]?.jevResult, "error");
    assert.equal(database.listProcessedMessages()[0]?.status, "processed");
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
  const openai = { openrouter: { isConnected: async () => false }, classifyEmail: async () => ({ school: [], events: [{ draft, fingerprint: eventFingerprint(draft), changeKind: "create" as const }] }) } as unknown as OpenAIService;
  const worker = new ScanWorker(database, google, openai);
  try {
    await worker.processQueue();
    assert.equal(database.getQueueStatus().processed, 1);
    assert.equal(database.listCandidates()[0]?.title, "Robotics meetup");
    assert.equal(database.listSchoolImports().length, 0);
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
