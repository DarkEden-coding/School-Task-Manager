/** Lifecycle states for a proposed calendar event. */
export type CandidateStatus = "pending" | "approved" | "denied" | "superseded";

/** Review actions created from follow-up email. */
export type ChangeKind = "create" | "update" | "cancel";

/** Durable processing state for one Gmail message. */
export type MessageStatus = "queued" | "processing" | "processed" | "failed";

/** Supported model reasoning levels. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Model backends that can classify email. */
export type ModelProviderId = "openai-codex" | "openrouter";

/** Lifecycle state for an academic term. */
export type TermStatus = "active" | "archived";

/** Durable completion state for a class assignment. */
export type AssignmentStatus = "open" | "done";

/** An academic term used to organize classes. */
export interface SchoolTerm {
  id: number;
  name: string;
  start: string;
  end: string;
  status: TermStatus;
  createdAt: string;
  updatedAt: string;
}

/** A class attached to an academic term. */
export interface SchoolClass {
  id: number;
  termId: number;
  name: string;
  code: string;
  instructor: string;
  contact: string;
  schedule: string;
  location: string;
  officeHours: string;
  links: string;
  syllabusNotes: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A tracked assignment attached to one class. */
export interface SchoolAssignment {
  id: number;
  classId: number;
  title: string;
  due: string | null;
  type: string;
  usefulLink: string;
  notes: string;
  warningMinutes: number | null;
  status: AssignmentStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** School records needed to render the dashboard. */
export interface SchoolDashboard {
  terms: SchoolTerm[];
  classes: SchoolClass[];
  assignments: SchoolAssignment[];
}

/** Fields accepted when creating or editing a term. */
export interface SchoolTermInput { name: string; start: string; end: string; status: TermStatus; }
/** Fields accepted when creating or editing a class. */
export interface SchoolClassInput { termId: number; name: string; code: string; instructor: string; contact: string; schedule: string; location: string; officeHours: string; links: string; syllabusNotes: string; notes: string; }
/** Editable assignment fields; status is deliberately excluded. */
export interface SchoolAssignmentInput { classId: number; title: string; due: string | null; type: string; usefulLink: string; notes: string; warningMinutes: number | null; }

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
  sourceUrl: string;
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
  modelProvider: ModelProviderId;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  interests: string;
  filterRules: string;
  schoolImportRules: string;
  scanPaused: boolean;
}

/** A model-extracted school record before it is matched to local IDs. */
export interface ExtractedSchoolItem {
  kind: "term" | "class" | "assignment";
  operation: "createOrUpdate" | "delete";
  payload: Record<string, unknown>;
}

export type SchoolImportKind = ExtractedSchoolItem["kind"];
export interface SchoolImportItem { id: number; kind: SchoolImportKind; action: "create" | "update" | "delete" | "noop"; targetId: number | null; needsReview: boolean; payload: Record<string, unknown>; conflicts: string[]; }
export interface SchoolImportProposal { id: number; status: "pending"; inputMethod: "text" | "images" | "text+images" | "gmail"; createdAt: string; items: SchoolImportItem[]; }
export interface SchoolImportLog { id: number; status: "pending" | "applied" | "discarded" | "failed"; inputMethod: string; createdAt: string; itemCount: number; successCount: number; failureCount: number; }

/** Public connection and processing state shown on the dashboard. */
export interface DashboardStatus {
  setupComplete: boolean;
  googleConnected: boolean;
  openaiConnected: boolean;
  openrouterConnected: boolean;
  pendingCount: number;
  queuedCount: number;
  failedCount: number;
  lastSuccessfulScan: string | null;
  nextScan: string | null;
  scanRunning: boolean;
  scanPaused: boolean;
  lastError: string | null;
}

/** One model available through the selected provider. */
export interface AvailableModel {
  id: string;
  name: string;
  reasoningLevels: ReasoningLevel[];
  batch: boolean;
}

/** Queue progress returned to the browser. */
export interface QueueStatus {
  queued: number;
  processing: number;
  processed: number;
  failed: number;
  paused: boolean;
  running: boolean;
  batchMode: boolean;
  batchState: "idle" | "preparing" | "in_route" | "applying";
  batchMessage: string | null;
  runTotal: number;
  runCompleted: number;
  providerCompleted: number;
}
