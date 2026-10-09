CREATE TABLE IF NOT EXISTS circle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  with_whom TEXT,
  notes TEXT,
  completed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_appointments_starts ON appointments(starts_at);

CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dose TEXT NOT NULL,
  times TEXT NOT NULL,
  with_food INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS med_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_med_log_taken ON med_log(taken_at);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_at ON journal(at);

-- OAuth 2.1 authorization server state (authorization-code + PKCE, refresh rotation).
-- Codes and tokens are stored as SHA-256 hashes; the raw values never touch disk.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
