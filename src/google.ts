import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { google, type calendar_v3, type gmail_v1 } from "googleapis";
import type { AppDatabase } from "./database.js";
import type { EventCandidate } from "./types.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

interface GoogleClientJson {
  web?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
}

/** Gmail and Calendar OAuth and API operations. */
export class GoogleService {
  public constructor(private readonly database: AppDatabase, private readonly callbackUrl: string) {}

  /** Validates and stores a Google web OAuth client definition. */
  public saveClientJson(value: unknown): void {
    const parsed = value as GoogleClientJson;
    if (!parsed.web?.client_id || !parsed.web.client_secret) throw new Error("Upload a Google OAuth web client JSON file");
    this.database.setSecret("google:client", parsed.web);
  }

  /** Reports whether both client configuration and user tokens exist. */
  public isConnected(): boolean { return Boolean(this.database.getSecret("google:client") && this.database.getSecret("google:tokens")); }

  /** Returns the authorization URL for the configured Google client. */
  public getAuthorizationUrl(): string {
    const client = this.createOAuthClient(false);
    const state = randomBytes(24).toString("base64url");
    this.database.setSecret("google:oauth-state", state);
    return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES, include_granted_scopes: true, state });
  }

  /** Exchanges Google's callback code after validating its OAuth state. */
  public async acceptAuthorizationCode(code: string, state: string): Promise<void> {
    const expected = this.database.getSecret<string>("google:oauth-state");
    if (!expected || expected.length !== state.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(state))) throw new Error("Invalid Google OAuth state");
    this.database.deleteSecret("google:oauth-state");
    const client = this.createOAuthClient(false);
    const result = await client.getToken(code);
    this.database.setSecret("google:tokens", result.tokens);
  }

  /** Lists selectable Gmail labels. */
  public async listLabels(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.gmail().users.labels.list({ userId: "me" });
    return (response.data.labels ?? []).flatMap((label) => label.id && label.name ? [{ id: label.id, name: label.name }] : []);
  }

  /** Lists writable destination calendars. */
  public async listCalendars(): Promise<Array<{ id: string; name: string; primary: boolean }>> {
    const response = await this.calendar().calendarList.list({ minAccessRole: "writer" });
    return (response.data.items ?? []).flatMap((item) => item.id ? [{ id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, primary: item.primary ?? false }] : []);
  }

  /** Counts messages in selected labels from Gmail label totals. */
  public async countMessages(labelIds: string[]): Promise<number> {
    if (labelIds.length === 1) {
      const response = await this.gmail().users.labels.get({ userId: "me", id: labelIds[0]! });
      return Number(response.data.messagesTotal ?? 0);
    }
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params: gmail_v1.Params$Resource$Users$Messages$List = { userId: "me", labelIds, maxResults: 500 };
      if (pageToken) params.pageToken = pageToken;
      const response = await this.gmail().users.messages.list(params);
      for (const item of response.data.messages ?? []) if (item.id) ids.add(item.id);
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids.size;
  }

  /** Queues Gmail message IDs from list results without fetching each body. */
  public async queueMessages(labelIds: string[], afterSeconds?: number): Promise<number> {
    let queued = 0;
    let pageToken: string | undefined;
    do {
      const params: gmail_v1.Params$Resource$Users$Messages$List = { userId: "me", labelIds, maxResults: 500 };
      if (pageToken) params.pageToken = pageToken;
      if (afterSeconds) params.q = `after:${afterSeconds}`;
      const response = await this.gmail().users.messages.list(params);
      for (const item of response.data.messages ?? []) {
        if (!item.id) continue;
        queued += this.database.queueMessage({ id: item.id, threadId: item.threadId ?? item.id, internalDate: String(Date.now()) }) ? 1 : 0;
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return queued;
  }

  /** Fetches and cleans one complete Gmail message for model analysis. */
  public async getMessage(id: string): Promise<{ id: string; threadId: string; subject: string; sender: string; date: string; body: string; calendarText: string; gmailUrl: string }> {
    const response = await this.gmail().users.messages.get({ userId: "me", id, format: "full" });
    const headers = headerMap(response.data.payload?.headers);
    const content = await this.collectMessageParts(id, response.data.payload);
    return {
      id,
      threadId: response.data.threadId ?? id,
      subject: headers.subject ?? "",
      sender: headers.from ?? "",
      date: headers.date ?? new Date(Number(response.data.internalDate ?? Date.now())).toISOString(),
      body: readableEmailBody(content, response.data.snippet ?? "").slice(0, 30_000),
      calendarText: content.calendar.trim().slice(0, 10_000),
      gmailUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
    };
  }

  /** Reads a bounded Calendar window for agent duplicate and conflict checks. */
  public async listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<Array<{ id: string; title: string; start: string | null; end: string | null; location: string }>> {
    if (!calendarId) throw new Error("Choose a calendar in Settings");
    if (Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax)) || Date.parse(timeMax) <= Date.parse(timeMin)) throw new Error("Invalid Calendar date window");
    if (Date.parse(timeMax) - Date.parse(timeMin) > 2 * 365 * 86_400_000) throw new Error("Calendar window must be two years or less");
    const response = await this.calendar().events.list({ calendarId, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 500 });
    return (response.data.items ?? []).flatMap((event) => event.id ? [{ id: event.id, title: event.summary ?? "", start: event.start?.dateTime ?? event.start?.date ?? null, end: event.end?.dateTime ?? event.end?.date ?? null, location: event.location ?? "" }] : []);
  }

  /** Applies an approved create, update, or cancellation to Google Calendar. */
  public async applyCandidate(candidate: EventCandidate, related?: EventCandidate): Promise<string | null> {
    const calendar = this.calendar();
    const calendarId = candidate.calendarId;
    if (candidate.changeKind === "cancel") {
      if (!related?.calendarEventId) throw new Error("The original Calendar event is not linked");
      try { await calendar.events.delete({ calendarId: related.calendarId, eventId: related.calendarEventId, sendUpdates: "none" }); }
      catch (error) { if (!hasHttpStatus(error, 404) && !hasHttpStatus(error, 410)) throw error; }
      return related.calendarEventId;
    }
    const resource = toCalendarEvent(candidate);
    if (candidate.changeKind === "update") {
      if (!related?.calendarEventId) throw new Error("The original Calendar event is not linked");
      await calendar.events.patch({ calendarId: related.calendarId, eventId: related.calendarEventId, requestBody: resource, sendUpdates: "none" });
      return related.calendarEventId;
    }
    const eventId = deterministicCalendarId(candidate.id);
    try {
      const response = await calendar.events.insert({ calendarId, requestBody: { ...resource, id: eventId }, sendUpdates: "none" });
      return response.data.id ?? eventId;
    } catch (error) {
      if (hasHttpStatus(error, 409)) return eventId;
      throw error;
    }
  }

  /** Collects inline text and downloads text or calendar parts stored as attachments. */
  private async collectMessageParts(messageId: string, part: gmail_v1.Schema$MessagePart | undefined): Promise<{ text: string; html: string; calendar: string }> {
    const result = collectInlinePart(part);
    if (!part) return result;
    const wantsBody = part.mimeType === "text/plain" || part.mimeType === "text/html" || part.mimeType === "text/calendar" || Boolean(part.filename?.toLowerCase().endsWith(".ics"));
    if (wantsBody && part.body?.attachmentId && !part.body.data) {
      const attachment = await this.gmail().users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId });
      const decoded = attachment.data.data ? Buffer.from(attachment.data.data, "base64url").toString("utf8") : "";
      if (part.mimeType === "text/plain") result.text = decoded;
      else if (part.mimeType === "text/html") result.html = decoded;
      else result.calendar = decoded;
    }
    for (const child of part.parts ?? []) {
      const nested = await this.collectMessageParts(messageId, child);
      result.text = joinParts(result.text, nested.text);
      result.html = joinParts(result.html, nested.html);
      result.calendar = joinParts(result.calendar, nested.calendar);
    }
    return result;
  }

  /** Creates an authorized OAuth client and persists refreshed token fields. */
  private createOAuthClient(withTokens = true) {
    const config = this.database.getSecret<{ client_id: string; client_secret: string }>("google:client");
    if (!config) throw new Error("Google OAuth client is not configured");
    const client = new google.auth.OAuth2(config.client_id, config.client_secret, this.callbackUrl);
    if (withTokens) {
      const tokens = this.database.getSecret<Record<string, unknown>>("google:tokens");
      if (!tokens) throw new Error("Google account is not connected");
      client.setCredentials(tokens);
      client.on("tokens", (next) => this.database.setSecret("google:tokens", { ...tokens, ...next }));
    }
    return client;
  }

  /** Returns an authorized Gmail client. */
  private gmail(): gmail_v1.Gmail { return google.gmail({ version: "v1", auth: this.createOAuthClient() }); }

  /** Returns an authorized Calendar client. */
  private calendar(): calendar_v3.Calendar { return google.calendar({ version: "v3", auth: this.createOAuthClient() }); }
}

/** Produces a lowercase map of mail headers. */
function headerMap(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
  return Object.fromEntries((headers ?? []).map((header) => [header.name?.toLowerCase() ?? "", header.value ?? ""]));
}

/** Collects the inline content of one MIME part. */
function collectInlinePart(part: gmail_v1.Schema$MessagePart | undefined): { text: string; html: string; calendar: string } {
  const result = { text: "", html: "", calendar: "" };
  if (!part) return result;
  const body = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
  if (part.mimeType === "text/plain") result.text = body;
  if (part.mimeType === "text/html") result.html = body;
  if (part.mimeType === "text/calendar" || part.filename?.toLowerCase().endsWith(".ics")) result.calendar = body;
  return result;
}

/** Joins MIME fragments without turning empty children into a truthy body. */
function joinParts(left: string, right: string): string {
  if (!left.trim()) return right;
  if (!right.trim()) return left;
  return `${left}\n${right}`;
}

/** Reduces simple HTML email to readable text. */
function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Removes common quoted replies and signatures to limit unrelated model input. */
function stripQuotedHistory(text: string): string {
  return text.split(/\n(?:On .+ wrote:|-----Original Message-----)/i, 1)[0]?.replace(/\n>.*(?:\n>.*)*/g, "").replace(/\n{3,}/g, "\n\n").trim() ?? "";
}

/** Picks a non-empty body, preferring plain text, then HTML, then the Gmail snippet. */
export function readableEmailBody(parts: { text: string; html: string }, snippet = ""): string {
  const raw = parts.text.trim() || htmlToText(parts.html).trim() || snippet.trim();
  return stripQuotedHistory(raw) || raw;
}

/** Returns a retry-safe Calendar identifier using its base32hex alphabet. */
function deterministicCalendarId(candidateId: number): string {
  return createHash("sha256").update(`email-manager:${candidateId}`).digest("hex").slice(0, 32);
}

/** Checks a Google API error for one HTTP status. */
function hasHttpStatus(error: unknown, status: number): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return value.code === status || value.response?.status === status;
}

/** Maps a validated candidate to Calendar event fields. */
function toCalendarEvent(candidate: EventCandidate): calendar_v3.Schema$Event {
  return {
    summary: candidate.title,
    ...(candidate.location ? { location: candidate.location } : {}),
    description: candidate.description,
    start: { dateTime: candidate.start!, timeZone: candidate.timezone },
    end: { dateTime: candidate.end!, timeZone: candidate.timezone },
    extendedProperties: { private: { emailManagerCandidateId: String(candidate.id), sourceMessageIds: candidate.sourceMessageIds.join(",") } },
  };
}
