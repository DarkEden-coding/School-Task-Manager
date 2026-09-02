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
  source_url TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS school_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS school_terms_status_idx ON school_terms(status, start DESC, id DESC);

CREATE TABLE IF NOT EXISTS school_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL REFERENCES school_terms(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  code TEXT NOT NULL DEFAULT '',
  instructor TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  office_hours TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '',
  syllabus_notes TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS school_classes_term_idx ON school_classes(term_id, name, id);

CREATE TABLE IF NOT EXISTS school_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES school_classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  due TEXT,
  type TEXT NOT NULL DEFAULT '',
  useful_link TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  warning_minutes INTEGER CHECK (warning_minutes IS NULL OR warning_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS school_assignments_class_idx ON school_assignments(class_id, status, due, id);

CREATE TABLE IF NOT EXISTS school_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK(status IN ('pending','applied','discarded','failed')),
  input_method TEXT NOT NULL,
  source_key TEXT UNIQUE,
  item_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS school_import_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES school_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('term','class','assignment')),
  action TEXT NOT NULL CHECK(action IN ('create','update','delete','noop')),
  target_id INTEGER,
  needs_review INTEGER NOT NULL,
  payload TEXT NOT NULL,
  conflicts TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS school_import_items_import_idx ON school_import_items(import_id,id);

CREATE TABLE IF NOT EXISTS document_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES document_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES document_folders(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1,
  derived_from_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents(folder_id,name);
CREATE TABLE IF NOT EXISTS agent_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_call_id TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx ON agent_messages(conversation_id,id);
CREATE TABLE IF NOT EXISTS agent_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  arguments TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

DELETE FROM school_import_items WHERE import_id IN (SELECT id FROM school_imports WHERE status='pending');
UPDATE school_imports SET status='discarded' WHERE status='pending';
`;
