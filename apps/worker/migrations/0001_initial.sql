PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_ciphertext TEXT,
  totp_iv TEXT,
  totp_version INTEGER,
  pending_totp_ciphertext TEXT,
  pending_totp_iv TEXT,
  pending_totp_version INTEGER,
  pending_totp_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((totp_ciphertext IS NULL AND totp_iv IS NULL AND totp_version IS NULL)
      OR (totp_ciphertext IS NOT NULL AND totp_iv IS NOT NULL AND totp_version IS NOT NULL)),
  CHECK ((pending_totp_ciphertext IS NULL AND pending_totp_iv IS NULL AND pending_totp_version IS NULL AND pending_totp_expires_at IS NULL)
      OR (pending_totp_ciphertext IS NOT NULL AND pending_totp_iv IS NOT NULL AND pending_totp_version IS NOT NULL AND pending_totp_expires_at IS NOT NULL))
);

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT,
  source_ip_hash TEXT
);
CREATE INDEX auth_sessions_owner_expires_idx ON auth_sessions(owner_id, expires_at DESC);
CREATE INDEX auth_sessions_active_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('password', 'private_key')),
  credential_persistence TEXT NOT NULL DEFAULT 'saved' CHECK (credential_persistence IN ('saved', 'prompt')),
  notes TEXT NOT NULL DEFAULT '',
  initial_command TEXT,
  terminal_type TEXT NOT NULL DEFAULT 'xterm-256color',
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  collect_history INTEGER NOT NULL DEFAULT 1 CHECK (collect_history IN (0, 1)),
  password_ciphertext TEXT,
  password_iv TEXT,
  password_version INTEGER,
  private_key_ciphertext TEXT,
  private_key_iv TEXT,
  private_key_version INTEGER,
  passphrase_ciphertext TEXT,
  passphrase_iv TEXT,
  passphrase_version INTEGER,
  last_connected_at TEXT,
  last_connected_username TEXT,
  last_host_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((password_ciphertext IS NULL AND password_iv IS NULL AND password_version IS NULL)
      OR (password_ciphertext IS NOT NULL AND password_iv IS NOT NULL AND password_version IS NOT NULL)),
  CHECK ((private_key_ciphertext IS NULL AND private_key_iv IS NULL AND private_key_version IS NULL)
      OR (private_key_ciphertext IS NOT NULL AND private_key_iv IS NOT NULL AND private_key_version IS NOT NULL)),
  CHECK ((passphrase_ciphertext IS NULL AND passphrase_iv IS NULL AND passphrase_version IS NULL)
      OR (passphrase_ciphertext IS NOT NULL AND passphrase_iv IS NOT NULL AND passphrase_version IS NOT NULL))
);
CREATE INDEX profiles_owner_updated_idx ON profiles(owner_id, updated_at DESC, id DESC);
CREATE UNIQUE INDEX profiles_owner_identity_idx ON profiles(owner_id, host, port, username, name);

CREATE TABLE known_hosts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  key_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_blob TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  replaced_at TEXT,
  UNIQUE(profile_id, host, port)
);
CREATE INDEX known_hosts_fingerprint_idx ON known_hosts(fingerprint);

CREATE TABLE connection_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  target_host TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  target_username TEXT NOT NULL,
  profile_name_snapshot TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('password', 'private_key')),
  host_key_type TEXT,
  host_fingerprint TEXT,
  kex_algorithm TEXT,
  cipher_in TEXT,
  cipher_out TEXT,
  started_at TEXT NOT NULL,
  connected_at TEXT,
  closed_at TEXT,
  close_code TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX connection_sessions_profile_created_idx ON connection_sessions(profile_id, created_at DESC, id DESC);
CREATE INDEX connection_sessions_owner_created_idx ON connection_sessions(owner_id, created_at DESC, id DESC);

CREATE TABLE command_history (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES connection_sessions(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  profile_name_snapshot TEXT NOT NULL,
  host_snapshot TEXT NOT NULL,
  username_snapshot TEXT NOT NULL,
  command_redacted TEXT NOT NULL,
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('verified', 'best_effort')),
  created_at TEXT NOT NULL
);
CREATE INDEX command_history_profile_created_idx ON command_history(profile_id, created_at DESC, id DESC);
CREATE INDEX command_history_owner_created_idx ON command_history(owner_id, created_at DESC, id DESC);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES connection_sessions(id) ON DELETE CASCADE,
  event_code TEXT NOT NULL,
  message_safe TEXT NOT NULL,
  details_safe_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX session_events_session_created_idx ON session_events(session_id, created_at ASC, id ASC);
CREATE INDEX session_events_owner_created_idx ON session_events(owner_id, created_at DESC, id DESC);

CREATE TABLE settings (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'zh-CN' CHECK (language IN ('zh-CN', 'en')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  terminal_font_family TEXT NOT NULL DEFAULT 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  terminal_font_size INTEGER NOT NULL DEFAULT 14 CHECK (terminal_font_size BETWEEN 10 AND 32),
  terminal_scrollback INTEGER NOT NULL DEFAULT 10000 CHECK (terminal_scrollback BETWEEN 1000 AND 100000),
  terminal_cursor_blink INTEGER NOT NULL DEFAULT 1 CHECK (terminal_cursor_blink IN (0, 1)),
  default_encoding TEXT NOT NULL DEFAULT 'utf-8' CHECK (default_encoding IN ('utf-8', 'gb18030', 'big5')),
  default_terminal_type TEXT NOT NULL DEFAULT 'xterm-256color' CHECK (default_terminal_type IN ('xterm-256color', 'xterm', 'screen-256color')),
  monitoring_refresh_seconds INTEGER NOT NULL DEFAULT 8 CHECK (monitoring_refresh_seconds BETWEEN 5 AND 60),
  monitoring_reduce_when_hidden INTEGER NOT NULL DEFAULT 1 CHECK (monitoring_reduce_when_hidden IN (0, 1)),
  command_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (command_retention_days BETWEEN 1 AND 3650),
  event_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (event_retention_days BETWEEN 1 AND 3650),
  collect_commands INTEGER NOT NULL DEFAULT 1 CHECK (collect_commands IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  event_code TEXT NOT NULL,
  source_ip_hash TEXT,
  message_safe TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX security_events_owner_created_idx ON security_events(owner_id, created_at DESC, id DESC);

CREATE TABLE transfer_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  remote_path TEXT NOT NULL,
  temporary_remote_path TEXT,
  r2_key TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  confirmed_offset INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_offset >= 0),
  sha256 TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX transfer_jobs_owner_status_idx ON transfer_jobs(owner_id, status);
