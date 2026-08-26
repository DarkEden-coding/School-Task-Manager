/** Lifecycle states for a proposed calendar event. */
export type CandidateStatus = "pending" | "approved" | "denied" | "superseded";

/** Review actions created from follow-up email. */
export type ChangeKind = "create" | "update" | "cancel";

/** Durable processing state for one Gmail message. */
export type MessageStatus = "queued" | "processing" | "processed" | "failed";

/** Supported model reasoning levels. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Editable event data produced by the model and reviewed by the user. */
export interface EventDraft {
  title: string;
  start: string | null;
  end: string | null;
  timezone: string;
  location: string;
  description: string;
  organizer: string;
  registrationUrl: string;
  confidence: number;
  uncertaintyNotes: string[];
  sourceExcerpt: string;
}

/** Stored event candidate returned to the browser. */
export interface EventCandidate extends EventDraft {
  id: number;
  status: CandidateStatus;
  changeKind: ChangeKind;
  calendarId: string;
  calendarEventId: string | null;
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** User-editable application settings. */
export interface AppSettings {
  timezone: string;
  scanTime: string;
  gmailLabelIds: string[];
  calendarId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  interests: string;
  filterRules: string;
  scanPaused: boolean;
}

/** Public connection and processing state shown on the dashboard. */
export interface DashboardStatus {
  setupComplete: boolean;
  googleConnected: boolean;
  openaiConnected: boolean;
  pendingCount: number;
  queuedCount: number;
  failedCount: number;
  lastSuccessfulScan: string | null;
  nextScan: string | null;
  scanRunning: boolean;
  scanPaused: boolean;
  lastError: string | null;
}

/** One model available through the connected OpenAI subscription. */
export interface AvailableModel {
  id: string;
  name: string;
  reasoningLevels: ReasoningLevel[];
}

/** Queue progress returned to the browser. */
export interface QueueStatus {
  queued: number;
  processing: number;
  processed: number;
  failed: number;
  paused: boolean;
}
