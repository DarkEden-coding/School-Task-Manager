import type { AppDatabase } from "./database.js";
import type { GoogleService } from "./google.js";
import type { OpenAIService } from "./openai.js";

/** Coordinates Gmail discovery, persistent queue processing, and daily scheduling. */
export class ScanWorker {
  #processing = false;
  #filling = false;
  #timer: NodeJS.Timeout | null = null;
  #lastError: string | null = null;

  public constructor(private readonly database: AppDatabase, private readonly google: GoogleService, private readonly openai: OpenAIService) {}

  /** Starts queue processing and the minute-level daily schedule check. */
  public start(): void {
    if (this.#timer) return;
    this.database.reclaimProcessing();
    this.#timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  /** Stops future worker activity. */
  public stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  /** Returns transient worker state for the dashboard. */
  public status(): { running: boolean; lastError: string | null } { return { running: this.#processing, lastError: this.#lastError }; }

  /** Counts the initial Gmail corpus and creates a confirmation checkpoint. */
  public async countInitialScan(): Promise<{ runId: number; messageCount: number }> {
    const count = await this.google.countMessages(this.database.getSettings().gmailLabelIds);
    const result = this.database.db.prepare("INSERT INTO scan_runs(kind,status,message_count) VALUES('initial','awaiting_confirmation',?)").run(count);
    return { runId: Number(result.lastInsertRowid), messageCount: count };
  }

  /** Confirms the initial corpus and starts discovery without blocking the browser. */
  public async confirmInitialScan(runId: number): Promise<{ queuedCount: number }> {
    const run = this.database.db.prepare("SELECT status, message_count FROM scan_runs WHERE id=? AND kind='initial'").get(runId) as { status: string; message_count: number } | undefined;
    if (run?.status !== "awaiting_confirmation") throw new Error("Initial scan is not awaiting confirmation");
    this.database.db.prepare("UPDATE scan_runs SET status='running' WHERE id=?").run(runId);
    this.database.updateSettings({ scanPaused: false });
    void this.runInitialScan(runId);
    return { queuedCount: run.message_count };
  }

  /** Discovers the confirmed initial messages while three consumers classify IDs as they land. */
  private async runInitialScan(runId: number): Promise<void> {
    this.#filling = true;
    void this.processQueue();
    try {
      const queued = await this.google.queueMessages(this.database.getSettings().gmailLabelIds);
      this.database.db.prepare("UPDATE scan_runs SET status='complete', queued_count=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(queued, runId);
      const completed = new Date().toISOString();
      this.database.setMarker("initialScanComplete", completed);
      this.database.setMarker("lastSuccessfulScan", completed);
    } catch (error) {
      this.#lastError = errorText(error);
      this.database.db.prepare("UPDATE scan_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(this.#lastError, runId);
    } finally {
      this.#filling = false;
      await this.processQueue();
    }
  }

  /** Discovers new messages since the last successful scan. */
  public async scanNow(kind: "manual" | "scheduled" = "manual"): Promise<{ queuedCount: number }> {
    if (!this.google.isConnected()) throw new Error("Google is not connected");
    const result = this.database.db.prepare("INSERT INTO scan_runs(kind,status) VALUES(?,'running')").run(kind);
    const runId = Number(result.lastInsertRowid);
    try {
      const checkpoint = this.database.getMarker("lastSuccessfulScan");
      const afterSeconds = checkpoint ? Math.floor(Date.parse(checkpoint) / 1000) : undefined;
      const queued = await this.google.queueMessages(this.database.getSettings().gmailLabelIds, afterSeconds);
      const completed = new Date().toISOString();
      this.database.setMarker("lastSuccessfulScan", completed);
      this.database.db.prepare("UPDATE scan_runs SET status='complete', queued_count=?, completed_at=? WHERE id=?").run(queued, completed, runId);
      void this.processQueue();
      return { queuedCount: queued };
    } catch (error) {
      this.#lastError = errorText(error);
      this.database.db.prepare("UPDATE scan_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(this.#lastError, runId);
      throw error;
    }
  }

  /** Processes up to three queued messages concurrently until paused or empty. */
  public async processQueue(): Promise<void> {
    if (this.#processing || this.database.getSettings().scanPaused) return;
    this.#processing = true;
    let stop = false;
    const consume = async (): Promise<void> => {
      while (!stop && !this.database.getSettings().scanPaused) {
        const message = this.database.claimMessage();
        if (!message) {
          if (this.#filling) { await new Promise((resolve) => setTimeout(resolve, 400)); continue; }
          return;
        }
        try {
          const email = await this.google.getMessage(message.gmailId);
          const events = await this.openai.classifyEmail(email);
          const calendarId = this.database.getSettings().calendarId;
          for (const event of events) this.database.saveCandidate(event.draft, message.gmailId, event.fingerprint, calendarId, event.changeKind, event.relatedCandidateId);
          this.database.finishMessage(message.gmailId);
          this.#lastError = null;
        } catch (error) {
          this.#lastError = errorText(error);
          if (/rate|quota|usage limit|429/i.test(this.#lastError)) {
            this.database.failMessage(message.gmailId, this.#lastError);
            this.database.updateSettings({ scanPaused: true });
            stop = true;
          } else {
            this.database.finishMessage(message.gmailId, this.#lastError);
          }
        }
        if (!stop) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    };
    try { await Promise.all([consume(), consume(), consume()]); }
    finally { this.#processing = false; }
  }

  /** Runs due scheduled scans and resumes queue work. */
  private async tick(): Promise<void> {
    const settings = this.database.getSettings();
    if (!settings.scanPaused) void this.processQueue();
    if (!this.google.isConnected() || !this.database.getMarker("initialScanComplete")) return;
    const local = localClock(settings.timezone);
    const lastDate = this.database.getMarker("lastScheduledDate");
    if (local.time >= settings.scanTime && local.date !== lastDate) {
      this.database.setMarker("lastScheduledDate", local.date);
      try { await this.scanNow("scheduled"); } catch { /* exposed through status */ }
    }
  }
}

/** Gets sortable local date and time fields in an IANA timezone. */
function localClock(timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

/** Converts an unknown failure into bounded log text. */
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
