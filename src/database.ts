import { DatabaseSync } from "node:sqlite";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { SCHEMA } from "./schema.js";
import type { AppSettings, CandidateStatus, EventCandidate, EventDraft, ExtractedSchoolItem, MessageStatus, QueueStatus, ReasoningLevel, SchoolAssignment, SchoolAssignmentInput, SchoolClass, SchoolClassInput, SchoolDashboard, SchoolImportLog, SchoolImportProposal, SchoolTerm, SchoolTermInput } from "./types.js";
import { matchSchoolItems, resolveImportedClass, resolveImportedTerm } from "./school-import.js";
import { CryptoStore } from "./crypto-store.js";

const DEFAULT_SETTINGS: AppSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  scanTime: "08:00",
  gmailLabelIds: ["INBOX"],
  calendarId: "",
  modelProvider: "openai-codex",
  modelId: "",
  reasoningLevel: "medium",
  interests: "Engineering, robotics, hiking, and outdoor activities",
  filterRules: "Prefer catching plausible opportunities over missing them. Exclude vague promotions without a real event.",
  schoolImportRules: "",
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
    const candidateColumns = this.db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>;
    if (!candidateColumns.some((column) => column.name === "source_url")) this.db.exec("ALTER TABLE candidates ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.some((column) => column.name === "target_calendar_event_id")) this.db.exec("ALTER TABLE candidates ADD COLUMN target_calendar_event_id TEXT");
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

  /** Returns failed messages to the queue for a fresh set of attempts. */
  public retryFailedMessages(): number {
    return Number(this.db.prepare("UPDATE messages SET status='queued', attempts=0, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE status='failed'").run().changes);
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
    return {
      queued: counts.queued ?? 0, processing: counts.processing ?? 0, processed: counts.processed ?? 0, failed: counts.failed ?? 0,
      paused: this.getSettings().scanPaused, running: false, batchMode: false, batchState: "idle", batchMessage: null, runTotal: 0, runCompleted: 0, providerCompleted: 0,
    };
  }

  /** Claims every queued message for one full-queue batch submission. */
  public claimAllQueued(): Array<{ gmailId: string; threadId: string; attempts: number }> {
    const rows = this.db.prepare(`UPDATE messages SET status='processing', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE status='queued' RETURNING gmail_id, thread_id, attempts`).all() as Array<{ gmail_id: string; thread_id: string; attempts: number }>;
    return rows.map((row) => ({ gmailId: row.gmail_id, threadId: row.thread_id, attempts: row.attempts }));
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
    const result = this.db.prepare(`INSERT INTO candidates(status,change_kind,related_candidate_id,title,start,end,timezone,location,description,organizer,registration_url,source_url,confidence,uncertainty_notes,source_excerpt,calendar_id,fingerprint) VALUES('pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(changeKind, relatedCandidateId ?? null, draft.title, draft.start, draft.end, draft.timezone, draft.location, draft.description, draft.organizer, draft.registrationUrl, draft.sourceUrl, draft.confidence, JSON.stringify(draft.uncertaintyNotes), draft.sourceExcerpt, calendarId, fingerprint);
    const id = Number(result.lastInsertRowid);
    this.db.prepare("INSERT INTO candidate_messages(candidate_id,gmail_id) VALUES(?,?)").run(id, gmailId);
    return id;
  }

  /** Stages an agent-requested Google Calendar change for the existing review queue. */
  public saveAgentCandidate(draft: EventDraft, fingerprint: string, calendarId: string, changeKind: "create" | "update" | "cancel" = "create", relatedCandidateId?: number, targetCalendarEventId?: string): EventCandidate {
    const duplicate = changeKind === "create" ? this.findCandidateByFingerprint(fingerprint) : undefined;
    if (duplicate) return this.getCandidate(duplicate)!;
    if (changeKind !== "create" && !targetCalendarEventId && (!relatedCandidateId || !this.getCandidate(relatedCandidateId))) throw new Error("Calendar updates and cancellations require a candidate ID or Google Calendar event ID");
    const result = this.db.prepare(`INSERT INTO candidates(status,change_kind,related_candidate_id,title,start,end,timezone,location,description,organizer,registration_url,source_url,confidence,uncertainty_notes,source_excerpt,calendar_id,target_calendar_event_id,fingerprint) VALUES('pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(changeKind, relatedCandidateId ?? null, draft.title, draft.start, draft.end, draft.timezone, draft.location, draft.description, draft.organizer, draft.registrationUrl, draft.sourceUrl, draft.confidence, JSON.stringify(draft.uncertaintyNotes), draft.sourceExcerpt, calendarId, targetCalendarEventId ?? null, fingerprint);
    return this.getCandidate(Number(result.lastInsertRowid))!;
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
    const fields: Record<string, string> = { title: "title", start: "start", end: "end", timezone: "timezone", location: "location", description: "description", organizer: "organizer", registrationUrl: "registration_url", sourceUrl: "source_url", confidence: "confidence", uncertaintyNotes: "uncertainty_notes", sourceExcerpt: "source_excerpt", calendarId: "calendar_id" };
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

  /** Creates an academic term after validating its date range. */
  public createTerm(input: SchoolTermInput): SchoolTerm {
    validateTerm(input);
    if (input.status === "active") this.db.prepare("UPDATE school_terms SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE status='active'").run();
    const result = this.db.prepare("INSERT INTO school_terms(name,start,end,status) VALUES(?,?,?,?)").run(input.name.trim(), input.start, input.end, input.status);
    return this.requireTerm(Number(result.lastInsertRowid));
  }

  /** Lists terms with active terms first and newest terms first within each state. */
  public listTerms(): SchoolTerm[] {
    return (this.db.prepare("SELECT * FROM school_terms ORDER BY status='active' DESC, start DESC, id DESC").all() as Record<string, unknown>[]).map(rowToTerm);
  }

  /** Reads one academic term. */
  public getTerm(id: number): SchoolTerm | undefined {
    const row = this.db.prepare("SELECT * FROM school_terms WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToTerm(row) : undefined;
  }

  /** Updates a term and returns the persisted value. */
  public updateTerm(id: number, patch: Partial<SchoolTermInput>): SchoolTerm {
    const current = this.requireTerm(id);
    const next = { ...current, ...patch };
    validateTerm(next);
    if (next.status === "active") this.db.prepare("UPDATE school_terms SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE status='active' AND id!=?").run(id);
    this.db.prepare("UPDATE school_terms SET name=?,start=?,end=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(next.name.trim(), next.start, next.end, next.status, id);
    return this.requireTerm(id);
  }

  /** Deletes a term and its dependent classes and assignments. */
  public deleteTerm(id: number): void { this.requireTerm(id); this.db.prepare("DELETE FROM school_terms WHERE id=?").run(id); }

  /** Creates a class in an existing term. */
  public createClass(input: SchoolClassInput): SchoolClass {
    validateClass(input); this.requireTerm(input.termId);
    const result = this.db.prepare("INSERT INTO school_classes(term_id,name,code,instructor,contact,schedule,location,office_hours,links,syllabus_notes,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(input.termId, input.name.trim(), input.code, input.instructor, input.contact, input.schedule, input.location, input.officeHours, input.links, input.syllabusNotes, input.notes);
    return this.requireClass(Number(result.lastInsertRowid));
  }

  /** Lists classes, optionally restricted to one term, in deterministic name order. */
  public listClasses(termId?: number): SchoolClass[] {
    const query = termId === undefined ? "SELECT * FROM school_classes ORDER BY term_id, name COLLATE NOCASE, id" : "SELECT * FROM school_classes WHERE term_id=? ORDER BY name COLLATE NOCASE, id";
    return (this.db.prepare(query).all(...(termId === undefined ? [] : [termId])) as Record<string, unknown>[]).map(rowToClass);
  }

  /** Reads one class. */
  public getClass(id: number): SchoolClass | undefined { const row = this.db.prepare("SELECT * FROM school_classes WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? rowToClass(row) : undefined; }

  /** Updates a class and returns the persisted value. */
  public updateClass(id: number, patch: Partial<SchoolClassInput>): SchoolClass {
    const next = { ...this.requireClass(id), ...patch }; validateClass(next); this.requireTerm(next.termId);
    this.db.prepare("UPDATE school_classes SET term_id=?,name=?,code=?,instructor=?,contact=?,schedule=?,location=?,office_hours=?,links=?,syllabus_notes=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(next.termId, next.name.trim(), next.code, next.instructor, next.contact, next.schedule, next.location, next.officeHours, next.links, next.syllabusNotes, next.notes, id);
    return this.requireClass(id);
  }

  /** Deletes a class and its dependent assignments. */
  public deleteClass(id: number): void { this.requireClass(id); this.db.prepare("DELETE FROM school_classes WHERE id=?").run(id); }

  /** Creates an open assignment in an existing class. */
  public createAssignment(input: SchoolAssignmentInput): SchoolAssignment {
    validateAssignment(input); this.requireClass(input.classId);
    const result = this.db.prepare("INSERT INTO school_assignments(class_id,title,due,type,useful_link,notes,warning_minutes) VALUES(?,?,?,?,?,?,?)")
      .run(input.classId, input.title.trim(), input.due, input.type, input.usefulLink, input.notes, input.warningMinutes);
    return this.requireAssignment(Number(result.lastInsertRowid));
  }

  /** Lists assignments, optionally restricted to one class, with open due work first. */
  public listAssignments(classId?: number): SchoolAssignment[] {
    const query = classId === undefined ? "SELECT * FROM school_assignments ORDER BY status='open' DESC, due IS NULL, due, id" : "SELECT * FROM school_assignments WHERE class_id=? ORDER BY status='open' DESC, due IS NULL, due, id";
    return (this.db.prepare(query).all(...(classId === undefined ? [] : [classId])) as Record<string, unknown>[]).map(rowToAssignment);
  }

  /** Reads one assignment. */
  public getAssignment(id: number): SchoolAssignment | undefined { const row = this.db.prepare("SELECT * FROM school_assignments WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? rowToAssignment(row) : undefined; }

  /** Updates assignment details without changing its durable completion state. */
  public updateAssignment(id: number, patch: Partial<SchoolAssignmentInput>): SchoolAssignment {
    const next = { ...this.requireAssignment(id), ...patch }; validateAssignment(next); this.requireClass(next.classId);
    this.db.prepare("UPDATE school_assignments SET class_id=?,title=?,due=?,type=?,useful_link=?,notes=?,warning_minutes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(next.classId, next.title.trim(), next.due, next.type, next.usefulLink, next.notes, next.warningMinutes, id);
    return this.requireAssignment(id);
  }

  /** Marks an assignment done; imports and general edits cannot reopen it. */
  public completeAssignment(id: number): SchoolAssignment {
    this.requireAssignment(id);
    this.db.prepare("UPDATE school_assignments SET status='done', completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return this.requireAssignment(id);
  }

  /** Explicitly reopens completed work; imports cannot call this transition implicitly. */
  public reopenAssignment(id: number): SchoolAssignment { this.requireAssignment(id); this.db.prepare("UPDATE school_assignments SET status='open',completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id); return this.requireAssignment(id); }

  /** Deletes an assignment. */
  public deleteAssignment(id: number): void { this.requireAssignment(id); this.db.prepare("DELETE FROM school_assignments WHERE id=?").run(id); }

  /** Stages manual model output without retaining source text, images, URLs, or evidence. */
  public stageSchoolImport(inputMethod: SchoolImportProposal["inputMethod"], extracted: ExtractedSchoolItem[]): SchoolImportProposal {
    return this.insertSchoolImport(inputMethod, extracted);
  }

  /** Stages Gmail model output once even if queue processing retries the message. */
  public stageGmailSchoolImport(gmailId: string, extracted: ExtractedSchoolItem[]): void {
    const sourceKey = `gmail:${gmailId}`;
    if (this.db.prepare("SELECT 1 FROM school_imports WHERE source_key=?").get(sourceKey)) return;
    this.insertSchoolImport("gmail", extracted, sourceKey);
  }

  /** Atomically stores temporary proposal details and a metadata-only log header. */
  private insertSchoolImport(inputMethod: SchoolImportProposal["inputMethod"], extracted: ExtractedSchoolItem[], sourceKey?: string): SchoolImportProposal {
    if (!extracted.length) throw new Error("No school records were found in this import");
    if (extracted.length > 1000) throw new Error("Too many imported school records");
    const matched = matchSchoolItems(this, extracted);
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare("INSERT INTO school_imports(status,input_method,source_key,item_count) VALUES('pending',?,?,?)").run(inputMethod, sourceKey ?? null, matched.length);
      const id = Number(result.lastInsertRowid);
      const insert = this.db.prepare("INSERT INTO school_import_items(import_id,kind,action,target_id,needs_review,payload,conflicts) VALUES(?,?,?,?,?,?,?)");
      for (const item of matched) insert.run(id, item.kind, item.action, item.targetId, item.needsReview ? 1 : 0, JSON.stringify(item.payload), JSON.stringify(item.conflicts));
      this.db.exec("COMMIT");
      return this.getSchoolImport(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Reads a pending proposal; temporary details are unavailable after apply/discard. */
  public getSchoolImport(id: number): SchoolImportProposal | undefined {
    const head = this.db.prepare("SELECT * FROM school_imports WHERE id=? AND status='pending'").get(id) as Record<string, unknown> | undefined; if (!head) return undefined;
    const rows = this.db.prepare("SELECT * FROM school_import_items WHERE import_id=? ORDER BY id").all(id) as Record<string, unknown>[];
    return { id, status: "pending", inputMethod: head.input_method as SchoolImportProposal["inputMethod"], createdAt: String(head.created_at), items: rows.map((r) => ({ id: Number(r.id), kind: r.kind as never, action: r.action as never, targetId: r.target_id === null ? null : Number(r.target_id), needsReview: Boolean(r.needs_review), payload: JSON.parse(String(r.payload)) as Record<string, unknown>, conflicts: JSON.parse(String(r.conflicts)) as string[] })) };
  }

  /** Lists metadata-only import logs. */
  public listSchoolImports(): SchoolImportLog[] { return (this.db.prepare("SELECT * FROM school_imports ORDER BY id DESC").all() as Record<string, unknown>[]).map((r) => ({ id:Number(r.id),status:r.status as SchoolImportLog["status"],inputMethod:String(r.input_method),createdAt:String(r.created_at),itemCount:Number(r.item_count),successCount:Number(r.success_count),failureCount:Number(r.failure_count) })); }

  /** Applies selected items atomically, then destroys all temporary proposal details. */
  public applySchoolImport(id: number, selected: Array<{ id: number; payload?: Record<string, unknown> }>): SchoolImportLog {
    const proposal = this.getSchoolImport(id);
    if (!proposal) throw new Error("Pending school import not found");
    const chosen = new Map(selected.map((item) => [item.id, item]));
    const rank = { term: 0, class: 1, assignment: 2 } as const;
    const items = proposal.items.filter((item) => chosen.has(item.id) && item.action !== "noop")
      .sort((left, right) => left.action === "delete" || right.action === "delete" ? rank[right.kind] - rank[left.kind] : rank[left.kind] - rank[right.kind]);
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const payload = { ...item.payload, ...(chosen.get(item.id)?.payload ?? {}) };
        if (item.kind === "assignment") {
          delete payload.status;
          delete payload.completedAt;
        }
        if (item.action === "delete") {
          if (!item.targetId) throw new Error(`Cannot delete unmatched ${item.kind}`);
          if (item.kind === "term") this.deleteTerm(item.targetId);
          else if (item.kind === "class") this.deleteClass(item.targetId);
          else this.deleteAssignment(item.targetId);
        } else if (item.kind === "term") {
          const input = termImportInput(payload);
          if (item.action === "create") this.createTerm(input); else this.updateTerm(item.targetId!, input);
        } else if (item.kind === "class") {
          const term = resolveImportedTerm(this, payload);
          if (!term) throw new Error(`Choose or import a term for ${String(payload.name || "this class")}`);
          const input = classImportInput(payload, term.id);
          if (item.action === "create") this.createClass(input); else this.updateClass(item.targetId!, input);
        } else {
          const schoolClass = resolveImportedClass(this, payload);
          if (!schoolClass) throw new Error(`Choose or import a class for ${String(payload.title || "this assignment")}`);
          const input = assignmentImportInput(payload, schoolClass.id);
          if (item.action === "create") this.createAssignment(input); else this.updateAssignment(item.targetId!, input);
        }
      }
      this.db.prepare("DELETE FROM school_import_items WHERE import_id=?").run(id);
      this.db.prepare("UPDATE school_imports SET status='applied',success_count=?,failure_count=0 WHERE id=?").run(items.length, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listSchoolImports().find((item) => item.id === id)!;
  }

  /** Discards a pending proposal and its temporary details. */
  public discardSchoolImport(id: number): void { if (!this.getSchoolImport(id)) throw new Error("Pending school import not found"); this.db.prepare("DELETE FROM school_import_items WHERE import_id=?").run(id); this.db.prepare("UPDATE school_imports SET status='discarded' WHERE id=?").run(id); }

  /** Returns all school data for a dashboard in deterministic display order. */
  public getSchoolDashboard(): SchoolDashboard { return { terms: this.listTerms(), classes: this.listClasses(), assignments: this.listAssignments() }; }

  private requireTerm(id: number): SchoolTerm { const term = this.getTerm(id); if (!term) throw new Error("Term not found"); return term; }
  private requireClass(id: number): SchoolClass { const schoolClass = this.getClass(id); if (!schoolClass) throw new Error("Class not found"); return schoolClass; }
  private requireAssignment(id: number): SchoolAssignment { const assignment = this.getAssignment(id); if (!assignment) throw new Error("Assignment not found"); return assignment; }

  /** Stores a scalar operational marker. */
  public setMarker(key: string, value: string): void { this.db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`marker:${key}`, JSON.stringify(value)); }

  /** Reads a scalar operational marker. */
  public getMarker(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key=?").get(`marker:${key}`) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as string : null;
  }
}

/** Reads one required import string without accepting coerced values. */
function importString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

/** Narrows an imported term to the production input contract. */
function termImportInput(payload: Record<string, unknown>): SchoolTermInput {
  const status = payload.status;
  if (status !== "active" && status !== "archived") throw new Error("Invalid term status");
  return { name: importString(payload, "name"), start: importString(payload, "start"), end: importString(payload, "end"), status };
}

/** Narrows an imported class and supplies its resolved term. */
function classImportInput(payload: Record<string, unknown>, termId: number): SchoolClassInput {
  return {
    termId,
    name: importString(payload, "name"),
    code: importString(payload, "code"),
    instructor: importString(payload, "instructor"),
    contact: importString(payload, "contact"),
    schedule: importString(payload, "schedule"),
    location: importString(payload, "location"),
    officeHours: importString(payload, "officeHours"),
    links: importString(payload, "links"),
    syllabusNotes: importString(payload, "syllabusNotes"),
    notes: importString(payload, "notes"),
  };
}

/** Narrows an imported assignment and supplies its resolved class. */
function assignmentImportInput(payload: Record<string, unknown>, classId: number): SchoolAssignmentInput {
  const due = payload.due;
  const warningMinutes = payload.warningMinutes;
  if (due !== null && typeof due !== "string") throw new Error("due must be a string or null");
  if (warningMinutes !== null && !Number.isInteger(warningMinutes)) throw new Error("warningMinutes must be an integer or null");
  return {
    classId,
    title: importString(payload, "title"),
    due,
    type: importString(payload, "type"),
    usefulLink: importString(payload, "usefulLink"),
    notes: importString(payload, "notes"),
    warningMinutes: warningMinutes as number | null,
  };
}

function validateTerm(input: SchoolTermInput): void {
  if (!input.name.trim()) throw new Error("Term name is required");
  if (!isIsoDate(input.start) || !isIsoDate(input.end) || Date.parse(input.end) < Date.parse(input.start)) throw new Error("Term dates are invalid");
  if (input.status !== "active" && input.status !== "archived") throw new Error("Invalid term status");
}
function validateClass(input: SchoolClassInput): void { if (!Number.isInteger(input.termId) || input.termId < 1 || !input.name.trim()) throw new Error("Class term and name are required"); }
function validateAssignment(input: SchoolAssignmentInput): void {
  if (!Number.isInteger(input.classId) || input.classId < 1 || !input.title.trim()) throw new Error("Assignment class and title are required");
  if (input.due !== null && !isIsoDate(input.due)) throw new Error("Assignment due date must be ISO formatted");
  if (input.warningMinutes !== null && (!Number.isInteger(input.warningMinutes) || input.warningMinutes < 0)) throw new Error("Warning duration must be a non-negative integer");
}
function isIsoDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && !Number.isNaN(Date.parse(value)); }
function rowToTerm(row: Record<string, unknown>): SchoolTerm { return { id: Number(row.id), name: String(row.name), start: String(row.start), end: String(row.end), status: row.status as SchoolTerm["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToClass(row: Record<string, unknown>): SchoolClass { return { id: Number(row.id), termId: Number(row.term_id), name: String(row.name), code: String(row.code), instructor: String(row.instructor), contact: String(row.contact), schedule: String(row.schedule), location: String(row.location), officeHours: String(row.office_hours), links: String(row.links), syllabusNotes: String(row.syllabus_notes), notes: String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToAssignment(row: Record<string, unknown>): SchoolAssignment { return { id: Number(row.id), classId: Number(row.class_id), title: String(row.title), due: row.due ? String(row.due) : null, type: String(row.type), usefulLink: String(row.useful_link), notes: String(row.notes), warningMinutes: row.warning_minutes === null ? null : Number(row.warning_minutes), status: row.status as SchoolAssignment["status"], completedAt: row.completed_at ? String(row.completed_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }

function rowToCandidate(row: Record<string, unknown>): EventCandidate {
  return {
    id: Number(row.id), status: row.status as CandidateStatus, changeKind: row.change_kind as EventCandidate["changeKind"],
    title: String(row.title), start: row.start ? String(row.start) : null, end: row.end ? String(row.end) : null,
    timezone: String(row.timezone), location: String(row.location), description: String(row.description), organizer: String(row.organizer),
    registrationUrl: String(row.registration_url), sourceUrl: String(row.source_url), confidence: Number(row.confidence), uncertaintyNotes: JSON.parse(String(row.uncertainty_notes)) as string[],
    sourceExcerpt: String(row.source_excerpt), calendarId: String(row.calendar_id), calendarEventId: row.calendar_event_id ? String(row.calendar_event_id) : null,
    targetCalendarEventId: row.target_calendar_event_id ? String(row.target_calendar_event_id) : null, sourceMessageIds: JSON.parse(String(row.source_ids)) as string[], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
