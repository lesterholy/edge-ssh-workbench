PRAGMA foreign_keys = ON;

-- D1 cannot alter the existing CHECK constraints in place. Separate flags keep
-- the migration additive while preserving all existing profile and audit rows.
ALTER TABLE profiles
  ADD COLUMN tailscale_ssh INTEGER NOT NULL DEFAULT 0 CHECK (tailscale_ssh IN (0, 1));

ALTER TABLE connection_sessions
  ADD COLUMN tailscale_ssh INTEGER NOT NULL DEFAULT 0 CHECK (tailscale_ssh IN (0, 1));
