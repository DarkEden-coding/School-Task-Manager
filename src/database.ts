import { DatabaseSync } from "node:sqlite";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { SCHEMA } from "./schema.js";
import type { AppSettings, CandidateStatus, EventCandidate, EventDraft, MessageStatus, QueueStatus, ReasoningLevel } from "./types.js";
import { CryptoStore } from "./crypto-store.js";

const DEFAULT_SETTINGS: AppSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  scanTime: "08:00",
  gmailLabelIds: ["INBOX"],
  calendarId: "",
  modelId: "",
  reasoningLevel: "medium",
  interests: "Engineering, robotics, hiking, and outdoor activities",
  filterRules: "Prefer catching plausible opportunities over missing them. Exclude vague promotions without a real event.",
  scanPaused: false,
};

/** SQLite persistence and encrypted credential storage for the service. */
export class AppDatabase implements CredentialStore {
  readonly db: DatabaseSync;
  readonly crypto: CryptoStore;
  readonly #locks = new Map<string, Promise<void>>();

  public constructor(path: string, stateDir: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.crypto = new CryptoStore(stateDir);
  }

  /** Closes the SQLite connection. */
  public close(): void { this.db.close(); }

  /** Reads all editable settings with defaults for unset values. */
  public getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...DEFAULT_SETTINGS, ...stored } as AppSettings;
  }

  /** Updates known settings and returns the complete settings object. */
  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const statement = this.db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) statement.run(key, JSON.stringify(value));
    return this.getSettings();
  }

  /** Reads and decrypts an application secret. */
  public getSecret<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM secrets WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(this.crypto.decrypt(row.value)) as T : undefined;
  }

  /** Encrypts and stores an application secret. */
  public setSecret(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO secrets(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP")
      .run(key, this.crypto.encrypt(JSON.stringify(value)));
  }

  /** Deletes an application secret. */
  public deleteSecret(key: string): void { this.db.prepare("DELETE FROM secrets WHERE key=?").run(key); }

  /** Reads one stored model-provider credential. */
  public async read(providerId: string): Promise<Credential | undefined> { return this.getSecret<Credential>(`credential:${providerId}`); }

  /** Lists credential metadata without returning secret values. */
  public async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.db.prepare("SELECT key, value FROM secrets WHERE key LIKE 'credential:%'").all() as Array<{ key: string; value: string }>;
    return rows.map((row) => ({ providerId: row.key.slice(11), type: (JSON.parse(this.crypto.decrypt(row.value)) as Credential).type }));
  }

  /** Serializes credential refreshes and writes for one provider. */
  public async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const previous = this.#locks.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.#locks.set(providerId, chain);
    await previous;
    try {
      const next = await fn(await this.read(providerId));
      if (next) this.setSecret(`credential:${providerId}`, next);
      return next ?? await this.read(providerId);
    } finally {
      release();
      if (this.#locks.get(providerId) === chain) this.#locks.delete(providerId);
    }
  }

  /** Removes a provider credential. */
  public async delete(providerId: string): Promise<void> { this.deleteSecret(`credential:${providerId}`); }

  /** Queues a Gmail message once and reports whether it was new. */
  public queueMessage(message: { id: string; threadId: string; internalDate: string; subject?: string; sender?: string }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages(gmail_id,thread_id,internal_date,subject,sender,status) VALUES(?,?,?,?,?,'queued')`)
      .run(message.id, message.threadId, message.internalDate, message.subject ?? "", message.sender ?? "");
    return result.changes > 0;
  }

  /** Claims the oldest queued message for processing. */
  public claimMessage(): { gmailId: string; threadId: string; attempts: number } | undefined {
    const row = this.db.prepare(`UPDATE messages SET status='processing', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE rowid=(SELECT rowid FROM messages WHERE status='queued' ORDER BY internal_date LIMIT 1) RETURNING gmail_id, thread_id, attempts`).get() as { gmail_id: string; thread_id: string; attempts: number } | undefined;
    return row ? { gmailId: row.gmail_id, threadId: row.thread_id, attempts: row.attempts } : undefined;
  }

  /** Returns abandoned processing rows to the queue so workers can retry them. */
  public reclaimProcessing(): number {
    return Number(this.db.prepare("UPDATE messages SET status='queued', updated_at=CURRENT_TIMESTAMP WHERE status='processing'").run().changes);
  }

  /** Marks a message failed without retrying. */
  public failMessage(gmailId: string, error: string): void {
    this.db.prepare("UPDATE messages SET status='failed', last_error=?, updated_at=CURRENT_TIMESTAMP WHERE gmail_id=?").run(error.slice(0, 1000), gmailId);
  }

  /** Marks a message complete or returns it to the queue after a failure. */
  public finishMessage(gmailId: string, error?: string): void {
    if (!error) {
      this.db.prepare("UPDATE messages SET status='processed', processed_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE gmail_id=?").run(gmailId);
      return;
    }
    const row = this.db.prepare("SELECT attempts FROM messages WHERE gmail_id=?").get(gmailId) as { attempts: number };
    const status: MessageStatus = row.attempts >= 5 ? "failed" : "queued";
    this.db.prepare("UPDATE messages SET status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE gmail_id=?").run(status, error.slice(0, 1000), gmailId);
  }

  /** Returns aggregate queue counts. */
  public getQueueStatus(): QueueStatus {
    const rows = this.db.prepare("SELECT status, COUNT(*) count FROM messages GROUP BY status").all() as Array<{ status: MessageStatus; count: number }>;
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<Record<MessageStatus, number>>;
    return { queued: counts.queued ?? 0, processing: counts.processing ?? 0, processed: counts.processed ?? 0, failed: counts.failed ?? 0, paused: this.getSettings().scanPaused };
  }

  /** Finds a candidate likely to represent the same event. */
  public findCandidateByFingerprint(fingerprint: string): number | undefined {
    const row = this.db.prepare("SELECT id FROM candidates WHERE fingerprint=? AND status!='denied' ORDER BY id DESC LIMIT 1").get(fingerprint) as { id: number } | undefined;
    return row?.id;
  }

  /** Inserts a candidate or links another source message to its duplicate. */
  public saveCandidate(draft: EventDraft, gmailId: string, fingerprint: string, calendarId: string, changeKind: "create" | "update" | "cancel" = "create", relatedCandidateId?: number): number {
    const duplicate = changeKind === "create" ? this.findCandidateByFingerprint(fingerprint) : undefined;
    if (duplicate) {
      this.db.prepare("INSERT OR IGNORE INTO candidate_messages(candidate_id,gmail_id) VALUES(?,?)").run(duplicate, gmailId);
      return duplicate;
    }
    const result = this.db.prepare(`INSERT INTO candidates(status,change_kind,related_candidate_id,title,start,end,timezone,location,description,organizer,registration_url,confidence,uncertainty_notes,source_excerpt,calendar_id,fingerprint) VALUES('pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(changeKind, relatedCandidateId ?? null, draft.title, draft.start, draft.end, draft.timezone, draft.location, draft.description, draft.organizer, draft.registrationUrl, draft.confidence, JSON.stringify(draft.uncertaintyNotes), draft.sourceExcerpt, calendarId, fingerprint);
    const id = Number(result.lastInsertRowid);
    this.db.prepare("INSERT INTO candidate_messages(candidate_id,gmail_id) VALUES(?,?)").run(id, gmailId);
    return id;
  }

  /** Lists candidate records for review or history. */
  public listCandidates(status: "pending" | "history" = "pending"): EventCandidate[] {
    const where = status === "pending" ? "c.status='pending'" : "c.status!='pending'";
    const rows = this.db.prepare(`SELECT c.*, COALESCE(json_group_array(cm.gmail_id) FILTER (WHERE cm.gmail_id IS NOT NULL),'[]') source_ids FROM candidates c LEFT JOIN candidate_messages cm ON cm.candidate_id=c.id WHERE ${where} GROUP BY c.id ORDER BY c.updated_at DESC`).all() as Record<string, unknown>[];
    return rows.map(rowToCandidate);
  }

  /** Reads one candidate by id. */
  public getCandidate(id: number): EventCandidate | undefined {
    const row = this.db.prepare("SELECT c.*, COALESCE(json_group_array(cm.gmail_id) FILTER (WHERE cm.gmail_id IS NOT NULL),'[]') source_ids FROM candidates c LEFT JOIN candidate_messages cm ON cm.candidate_id=c.id WHERE c.id=? GROUP BY c.id").get(id) as Record<string, unknown> | undefined;
    return row ? rowToCandidate(row) : undefined;
  }

  /** Applies user edits to an unreviewed candidate. */
  public updateCandidate(id: number, patch: Partial<EventDraft & { calendarId: string }>): EventCandidate {
    const fields: Record<string, string> = { title: "title", start: "start", end: "end", timezone: "timezone", location: "location", description: "description", organizer: "organizer", registrationUrl: "registration_url", confidence: "confidence", uncertaintyNotes: "uncertainty_notes", sourceExcerpt: "source_excerpt", calendarId: "calendar_id" };
    for (const [key, column] of Object.entries(fields)) {
      if (!(key in patch)) continue;
      const value = key === "uncertaintyNotes" ? JSON.stringify(patch.uncertaintyNotes) : patch[key as keyof typeof patch] ?? null;
      this.db.prepare(`UPDATE candidates SET ${column}=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(value as string | number | null, id);
    }
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error("Candidate not found");
    return candidate;
  }

  /** Returns the original candidate linked to a proposed change. */
  public getRelatedCandidateId(id: number): number | undefined {
    const row = this.db.prepare("SELECT related_candidate_id FROM candidates WHERE id=?").get(id) as { related_candidate_id: number | null } | undefined;
    return row?.related_candidate_id ?? undefined;
  }

  /** Changes candidate review state and optionally records a Calendar event id. */
  public setCandidateStatus(id: number, status: CandidateStatus, calendarEventId?: string | null): void {
    this.db.prepare("UPDATE candidates SET status=?, calendar_event_id=COALESCE(?,calendar_event_id), updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, calendarEventId ?? null, id);
  }

  /** Stores a scalar operational marker. */
  public setMarker(key: string, value: string): void { this.db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`marker:${key}`, JSON.stringify(value)); }

  /** Reads a scalar operational marker. */
  public getMarker(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key=?").get(`marker:${key}`) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as string : null;
  }
}

/** Converts a database candidate row to the public contract. */
function rowToCandidate(row: Record<string, unknown>): EventCandidate {
  return {
    id: Number(row.id), status: row.status as CandidateStatus, changeKind: row.change_kind as EventCandidate["changeKind"],
    title: String(row.title), start: row.start ? String(row.start) : null, end: row.end ? String(row.end) : null,
    timezone: String(row.timezone), location: String(row.location), description: String(row.description), organizer: String(row.organizer),
    registrationUrl: String(row.registration_url), confidence: Number(row.confidence), uncertaintyNotes: JSON.parse(String(row.uncertainty_notes)) as string[],
    sourceExcerpt: String(row.source_excerpt), calendarId: String(row.calendar_id), calendarEventId: row.calendar_event_id ? String(row.calendar_event_id) : null,
    sourceMessageIds: JSON.parse(String(row.source_ids)) as string[], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
