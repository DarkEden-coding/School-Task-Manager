/** SQLite schema for the single-user application. */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  gmail_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  internal_date TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status, internal_date);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'superseded')),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'cancel')),
  related_candidate_id INTEGER REFERENCES candidates(id),
  title TEXT NOT NULL,
  start TEXT,
  end TEXT,
  timezone TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  organizer TEXT NOT NULL DEFAULT '',
  registration_url TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  uncertainty_notes TEXT NOT NULL DEFAULT '[]',
  source_excerpt TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT '',
  calendar_event_id TEXT,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS candidates_fingerprint_idx ON candidates(fingerprint);

CREATE TABLE IF NOT EXISTS candidate_messages (
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL REFERENCES messages(gmail_id) ON DELETE CASCADE,
  PRIMARY KEY (candidate_id, gmail_id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('counting', 'awaiting_confirmation', 'running', 'complete', 'failed')),
  message_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT
);
`;
