PRAGMA foreign_keys = ON;

CREATE TABLE tailscale_configuration (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tailnet TEXT NOT NULL,
  api_token_ciphertext TEXT,
  api_token_iv TEXT,
  api_token_version INTEGER,
  updated_at TEXT NOT NULL,
  CHECK ((api_token_ciphertext IS NULL AND api_token_iv IS NULL AND api_token_version IS NULL)
      OR (api_token_ciphertext IS NOT NULL AND api_token_iv IS NOT NULL AND api_token_version IS NOT NULL))
);
