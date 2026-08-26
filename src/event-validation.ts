import { createHash } from "node:crypto";
import type { EventDraft } from "./types.js";

/** Validates and normalizes untrusted model output into an event draft. */
export function validateEventDraft(value: unknown, fallbackTimezone: string): EventDraft {
  if (!value || typeof value !== "object") throw new Error("Model did not return an event object");
  const input = value as Record<string, unknown>;
  const start = nullableDate(input.start);
  const end = nullableDate(input.end);
  if (start && end && Date.parse(end) <= Date.parse(start)) throw new Error("Event end must be after its start");
  return {
    title: text(input.title, 300),
    start,
    end,
    timezone: text(input.timezone, 100) || fallbackTimezone,
    location: text(input.location, 500),
    description: text(input.description, 5000),
    organizer: text(input.organizer, 300),
    registrationUrl: safeUrl(input.registrationUrl),
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
    uncertaintyNotes: Array.isArray(input.uncertaintyNotes) ? input.uncertaintyNotes.slice(0, 10).map((item) => text(item, 500)).filter(Boolean) : [],
    sourceExcerpt: text(input.sourceExcerpt, 1000),
  };
}

/** Creates a stable duplicate-detection key from the meaningful event fields. */
export function eventFingerprint(event: EventDraft): string {
  const normalized = [event.title, event.start?.slice(0, 16) ?? "", event.location]
    .map((part) => part.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Checks whether a candidate has the required fields for Calendar insertion. */
export function assertApprovable(event: EventDraft): void {
  if (!event.title.trim()) throw new Error("Title is required");
  if (!event.start || !event.end) throw new Error("Start and end are required");
  if (!event.timezone.trim()) throw new Error("Timezone is required");
  if (Date.parse(event.end) <= Date.parse(event.start)) throw new Error("End must be after start");
}

/** Coerces bounded plain text. */
function text(value: unknown, max: number): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

/** Accepts valid ISO-compatible dates or null. */
function nullableDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (!Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Accepts only HTTP registration URLs. */
function safeUrl(value: unknown): string {
  const raw = text(value, 2000);
  if (!raw) return "";
  try { const url = new URL(raw); return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
}
