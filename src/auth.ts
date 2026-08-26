import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDatabase } from "./database.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Single-user password and session management. */
export class AuthService {
  public constructor(private readonly database: AppDatabase, private readonly secureCookies: boolean) {}

  /** Reports whether the initial password has been configured. */
  public isConfigured(): boolean { return Boolean(this.database.getSecret<string>("password")); }

  /** Stores the initial password using scrypt. */
  public setPassword(password: string): void {
    if (this.isConfigured()) throw new Error("Password is already configured");
    if (password.length < 12) throw new Error("Password must be at least 12 characters");
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.database.setSecret("password", `${salt.toString("base64url")}.${hash.toString("base64url")}`);
  }

  /** Verifies a password without leaking timing information. */
  public verifyPassword(password: string): boolean {
    const stored = this.database.getSecret<string>("password");
    if (!stored) return false;
    const [saltText, hashText] = stored.split(".");
    if (!saltText || !hashText) return false;
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length);
    return timingSafeEqual(actual, expected);
  }

  /** Creates a browser session and sets its cookie. */
  public createSession(reply: FastifyReply): { csrfToken: string } {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + SESSION_SECONDS * 1000);
    this.database.db.prepare("INSERT INTO sessions(token_hash,csrf_token,expires_at) VALUES(?,?,?)")
      .run(hashToken(token), csrfToken, expires.toISOString());
    reply.setCookie("email_manager_session", token, { httpOnly: true, sameSite: "strict", secure: this.secureCookies, path: "/", maxAge: SESSION_SECONDS });
    return { csrfToken };
  }

  /** Deletes the current session and clears its cookie. */
  public logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies.email_manager_session;
    if (token) this.database.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(token));
    reply.clearCookie("email_manager_session", { path: "/" });
  }

  /** Returns current session data when the cookie is valid. */
  public getSession(request: FastifyRequest): { csrfToken: string } | undefined {
    const token = request.cookies.email_manager_session;
    if (!token) return undefined;
    this.database.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
    const row = this.database.db.prepare("SELECT csrf_token FROM sessions WHERE token_hash=? AND expires_at>?").get(hashToken(token), new Date().toISOString()) as { csrf_token: string } | undefined;
    return row ? { csrfToken: row.csrf_token } : undefined;
  }

  /** Requires a valid session for a route. */
  public async requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.getSession(request)) await reply.code(401).send({ error: "Authentication required" });
  }

  /** Requires matching CSRF data on authenticated mutations. */
  public async requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = this.getSession(request);
    if (!session) { await reply.code(401).send({ error: "Authentication required" }); return; }
    if (request.headers["x-csrf-token"] !== session.csrfToken) await reply.code(403).send({ error: "Invalid CSRF token" });
  }
}

/** Hashes bearer session tokens before database storage. */
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
