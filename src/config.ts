import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Runtime configuration loaded from environment variables. */
export interface RuntimeConfig {
  host: string;
  port: number;
  baseUrl: string;
  stateDir: string;
  secureCookies: boolean;
}

/** Loads and validates the service's small environment configuration. */
export function loadConfig(): RuntimeConfig {
  const host = process.env.EMAIL_MANAGER_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.EMAIL_MANAGER_PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EMAIL_MANAGER_PORT must be a valid port");

  const stateDir = resolve(process.env.EMAIL_MANAGER_STATE_DIR ?? "data");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    host,
    port,
    stateDir,
    baseUrl: (process.env.EMAIL_MANAGER_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, ""),
    secureCookies: process.env.EMAIL_MANAGER_SECURE_COOKIES === "true",
  };
}
