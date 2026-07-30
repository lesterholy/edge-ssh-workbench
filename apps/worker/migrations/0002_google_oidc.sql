PRAGMA foreign_keys = ON;

CREATE TABLE oauth_identities (
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, email_normalized)
);
CREATE INDEX oauth_identities_owner_idx ON oauth_identities(owner_id, provider);

CREATE TABLE oauth_login_attempts (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  transaction_ciphertext TEXT NOT NULL,
  transaction_iv TEXT NOT NULL,
  transaction_version INTEGER NOT NULL CHECK (transaction_version = 1),
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_login_attempts_expires_idx ON oauth_login_attempts(expires_at);
