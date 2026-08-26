import { join } from "node:path";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { GoogleService } from "./google.js";
import { OpenAIService } from "./openai.js";
import { createServer } from "./server.js";
import { ScanWorker } from "./worker.js";

/** Starts the database, integrations, worker, and localhost HTTP service. */
async function main(): Promise<void> {
  const config = loadConfig();
  const database = new AppDatabase(join(config.stateDir, "email-manager.sqlite"), config.stateDir);
  const google = new GoogleService(database, `${config.baseUrl}/api/google/callback`);
  const openai = new OpenAIService(database);
  const worker = new ScanWorker(database, google, openai);
  const app = await createServer(config, { database, google, openai, worker });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    worker.stop();
    await app.close();
    database.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  worker.start();
}

await main();
