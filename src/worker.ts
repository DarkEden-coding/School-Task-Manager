import type { AppDatabase } from "./database.js";
import type { GoogleService } from "./google.js";
import type { OpenAIService } from "./openai.js";
import type { EmailForModel } from "./classify.js";
import { isOpenRouterBatchSettings } from "./openrouter.js";
import type { QueueStatus } from "./types.js";

/** Coordinates Gmail discovery, persistent queue processing, and daily scheduling. */
export class ScanWorker {
  #processing = false;
  #filling = false;
  #timer: NodeJS.Timeout | null = null;
  #lastError: string | null = null;
  #batchState: QueueStatus["batchState"] = "idle";
  #batchMessage: string | null = null;
  #runTotal = 0;
  #runCompleted = 0;
  #providerCompleted = 0;

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
  public status(): { running: boolean; lastError: string | null; batchState: QueueStatus["batchState"]; batchMessage: string | null; runTotal: number; runCompleted: number; providerCompleted: number } {
    return {
      running: this.#processing, lastError: this.#lastError, batchState: this.#batchState, batchMessage: this.#batchMessage,
      runTotal: this.#runTotal, runCompleted: this.#runCompleted, providerCompleted: this.#providerCompleted,
    };
  }

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

  /** Discovers the confirmed initial messages while consumers classify IDs as they land. */
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

  /** Processes the durable queue using streaming workers or one full OpenRouter batch. */
  public async processQueue(): Promise<void> {
    if (this.#processing || this.database.getSettings().scanPaused) return;
    this.#processing = true;
    this.#runCompleted = 0;
    this.#providerCompleted = 0;
    try {
      if (isOpenRouterBatchSettings(this.database.getSettings())) await this.processBatchQueue();
      else await this.processStreamingQueue();
    } finally {
      this.#processing = false;
      this.#batchState = "idle";
    }
  }

  /** Submits every queued message in one OpenRouter Batch API request. */
  private async processBatchQueue(): Promise<void> {
    this.#batchState = "preparing";
    this.#batchMessage = "Collecting the full queue for one OpenRouter batch…";
    while (this.#filling && !this.database.getSettings().scanPaused) {
      const queue = this.database.getQueueStatus();
      this.#runTotal = queue.queued + queue.processing;
      this.#batchMessage = `Collecting the full queue for one OpenRouter batch… ${this.#runTotal} messages so far.`;
      await sleep(400);
    }
    if (this.database.getSettings().scanPaused) return;
    const claimed = this.database.claimAllQueued();
    this.#runTotal = claimed.length;
    this.#runCompleted = 0;
    if (!claimed.length) {
      this.#batchMessage = null;
      return;
    }
    this.#batchMessage = `Preparing ${claimed.length} messages for OpenRouter batch…`;
    const emails: EmailForModel[] = [];
    for (const message of claimed) {
      if (this.database.getSettings().scanPaused && emails.length === 0) {
        this.database.reclaimProcessing();
        return;
      }
      try {
        emails.push(await this.google.getMessage(message.gmailId));
      } catch (error) {
        this.#lastError = errorText(error);
        this.database.finishMessage(message.gmailId, this.#lastError);
        this.#runCompleted += 1;
      }
    }
    if (!emails.length) {
      this.#batchMessage = "Batch finished with Gmail fetch errors.";
      return;
    }
    this.#batchState = "in_route";
    this.#batchMessage = `Full batch in route — ${emails.length} messages submitted to OpenRouter.`;
    try {
      const results = await this.openai.openrouter.classifyEmails(emails, (progress) => {
        this.#providerCompleted = progress.completed;
        this.#runTotal = Math.max(this.#runTotal, progress.total);
        this.#batchMessage = `Full batch in route — ${progress.total} messages submitted to OpenRouter.`;
      });
      this.#batchState = "applying";
      this.#batchMessage = "Applying batch results…";
      const calendarId = this.database.getSettings().calendarId;
      for (const result of results) {
        if (result.error) this.database.finishMessage(result.emailId, result.error);
        else {
          for (const event of result.events) this.database.saveCandidate(event.draft, result.emailId, event.fingerprint, calendarId, event.changeKind, event.relatedCandidateId);
          this.database.finishMessage(result.emailId);
          this.#lastError = null;
        }
        this.#runCompleted += 1;
      }
      this.#batchMessage = `Batch complete — ${emails.length} messages processed.`;
    } catch (error) {
      this.#lastError = errorText(error);
      this.#batchMessage = this.#lastError;
      if (/rate|quota|usage limit|429/i.test(this.#lastError)) {
        this.database.reclaimProcessing();
        this.database.updateSettings({ scanPaused: true });
      } else {
        for (const email of emails) this.database.finishMessage(email.id, this.#lastError);
      }
    }
  }

  /** Processes up to three queued messages concurrently until paused or empty. */
  private async processStreamingQueue(): Promise<void> {
    this.#batchState = "idle";
    this.#batchMessage = null;
    this.#runTotal = this.database.getQueueStatus().queued;
    let stop = false;
    const consume = async (): Promise<void> => {
      while (!stop && !this.database.getSettings().scanPaused) {
        const message = this.database.claimMessage();
        if (!message) {
          if (this.#filling) {
            this.#runTotal = Math.max(this.#runTotal, this.database.getQueueStatus().queued + this.#runCompleted);
            await sleep(400);
            continue;
          }
          return;
        }
        this.#runTotal = Math.max(this.#runTotal, this.#runCompleted + this.database.getQueueStatus().queued + this.database.getQueueStatus().processing);
        try {
          const email = await this.google.getMessage(message.gmailId);
          const classified = await this.openai.classifyEmail(email);
          const calendarId = this.database.getSettings().calendarId;
          for (const event of classified.events) this.database.saveCandidate(event.draft, message.gmailId, event.fingerprint, calendarId, event.changeKind, event.relatedCandidateId);
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
        this.#runCompleted += 1;
        if (!stop) await sleep(1500);
      }
    };
    await Promise.all([consume(), consume(), consume()]);
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

/** Waits before the next queue claim or batch poll. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
