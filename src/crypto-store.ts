import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Encrypts OAuth credentials at rest with an application-local AES key. */
export class CryptoStore {
  readonly #key: Buffer;

  public constructor(stateDir: string) {
    const keyPath = join(stateDir, "secret.key");
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    chmodSync(keyPath, 0o600);
    this.#key = readFileSync(keyPath);
    if (this.#key.length !== 32) throw new Error(`${keyPath} must contain exactly 32 bytes`);
  }

  /** Encrypts a UTF-8 value into a versioned base64 envelope. */
  public encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  /** Decrypts a value created by encrypt. */
  public decrypt(value: string): string {
    const [version, iv, tag, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }
}
