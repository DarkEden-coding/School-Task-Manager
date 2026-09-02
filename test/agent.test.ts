import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DocumentAgent } from "../src/agent.js";
import { AppDatabase } from "../src/database.js";
import { DocumentStore } from "../src/documents.js";
import type { GoogleService } from "../src/google.js";
import type { OpenAIService } from "../src/openai.js";

test("chat agent can search Gmail and consume the results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "email-manager-agent-"));
  const database = new AppDatabase(join(directory, "test.sqlite"), directory);
  const searches: string[] = [];
  const google = {
    searchMessages: async (query: string) => { searches.push(query); return [{ id: "mail-1", subject: "Lab deadline" }]; },
  } as unknown as GoogleService;
  let turn = 0;
  const openai = {
    completeAgent: async () => turn++ === 0
      ? { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "app_action", arguments: { action: "search_gmail", input: JSON.stringify({ query: "subject:(lab deadline)" }) } }], timestamp: Date.now(), stopReason: "toolUse" }
      : { role: "assistant", content: [{ type: "text", text: "Found it." }], timestamp: Date.now(), stopReason: "stop" },
  } as unknown as OpenAIService;
  try {
    const agent = new DocumentAgent(database, new DocumentStore(database, directory), google, openai);
    const conversation = agent.createConversation() as { id: number };
    await agent.run(conversation.id, "Find the lab deadline email", () => {});
    assert.deepEqual(searches, ["subject:(lab deadline)"]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
