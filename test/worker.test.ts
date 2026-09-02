import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import type { DocumentAgent } from "../src/agent.js";
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
  const worker = new ScanWorker(database, google, {} as OpenAIService, {} as DocumentAgent);
  try {
    await worker.scanNow();
    const first = database.getMarker("lastSuccessfulScan");
    assert.ok(first);
    await worker.scanNow();
    assert.equal(checkpoints[0], undefined);
    assert.equal(checkpoints[1], Math.floor(Date.parse(first) / 1000));
  } finally { worker.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
