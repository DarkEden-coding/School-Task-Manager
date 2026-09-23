import assert from "node:assert/strict";
import test from "node:test";
import { scoreEmailWithJev, shouldProcessJevScores } from "../src/jev.js";
import type { EmailForModel } from "../src/classify.js";
import type { AppSettings } from "../src/types.js";

test("Jev sends course-aware questions and keeps uncertain messages", async () => {
  const originalFetch = globalThis.fetch;
  let submitted: Record<string, any> | undefined;
  globalThis.fetch = async (_url, options) => {
    submitted = JSON.parse(String(options?.body)) as Record<string, any>;
    return Response.json({ answers: { school: { noul: 0.09 }, event: { noul: 0.1 }, opportunity: { noul: 0.02 } } });
  };
  const email: EmailForModel = { id: "mail-1", subject: "New assignment", sender: "teacher@example.edu", date: "2027-01-01", body: "Due next week", calendarText: "", gmailUrl: "" };
  const settings = { interests: "Robotics, outdoors", filterRules: "Skip generic ads", schoolImportRules: "" } as AppSettings;
  try {
    const scores = await scoreEmailWithJev(email, settings, ["ROB 101", "MATH 116"], "test-key");
    assert.deepEqual(scores, { school: 0.09, event: 0.1, opportunity: 0.02 });
    assert.equal(shouldProcessJevScores(scores), true);
    assert.equal(shouldProcessJevScores({ school: 0.09, event: 0.07, opportunity: 0.02 }), false);
    assert.match(submitted?.questions.school.instructions, /ROB 101/);
    assert.match(submitted?.questions.school.instructions, /MATH 116/);
    assert.equal(submitted?.state.body, email.body);
  } finally { globalThis.fetch = originalFetch; }
});

test("Jev rejects malformed responses so the worker can fail open", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ answers: { school: { noul: "yes" }, event: { noul: 0.2 }, opportunity: { noul: 0.1 } } });
  try {
    await assert.rejects(scoreEmailWithJev({ id: "mail-1", subject: "", sender: "", date: "", body: "", calendarText: "", gmailUrl: "" }, { interests: "", filterRules: "", schoolImportRules: "" } as AppSettings, [], "test-key"), /invalid scores/);
  } finally { globalThis.fetch = originalFetch; }
});
