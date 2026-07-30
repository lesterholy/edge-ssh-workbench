import { assertOwnerId, nowIso } from "./internal";

export interface AuthSessionRecord {
  idHash: string;
  ownerId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgentHash: string | null;
  sourceIpHash: string | null;
}

interface AuthSessionRow {
  id_hash: string;
  owner_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent_hash: string | null;
  source_ip_hash: string | null;
}

function toRecord(row: AuthSessionRow): AuthSessionRecord {
  return {
    idHash: row.id_hash, ownerId: row.owner_id, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, userAgentHash: row.user_agent_hash, sourceIpHash: row.source_ip_hash,
  };
}

export interface CreateAuthSessionInput {
  idHash: string;
  ownerId: string;
  expiresAt: string;
  userAgentHash?: string | null;
  sourceIpHash?: string | null;
}

export class AuthSessionRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    assertOwnerId(input.ownerId);
    if (!input.idHash || Date.parse(input.expiresAt) <= Date.now()) throw new Error("Invalid auth session");
    const now = nowIso();
    await this.db.prepare(
      `INSERT INTO auth_sessions
        (id_hash, owner_id, created_at, last_seen_at, expires_at, revoked_at, user_agent_hash, source_ip_hash)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(input.idHash, input.ownerId, now, now, input.expiresAt, input.userAgentHash ?? null, input.sourceIpHash ?? null).run();
    return { ...input, createdAt: now, lastSeenAt: now, revokedAt: null, userAgentHash: input.userAgentHash ?? null, sourceIpHash: input.sourceIpHash ?? null };
  }

  async findActive(idHash: string, touch = false): Promise<AuthSessionRecord | null> {
    const row = await this.db.prepare(
      "SELECT * FROM auth_sessions WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    ).bind(idHash, nowIso()).first<AuthSessionRow>();
    if (!row) return null;
    if (touch) {
      row.last_seen_at = nowIso();
      await this.db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?")
        .bind(row.last_seen_at, idHash).run();
    }
    return toRecord(row);
  }

  async listActive(ownerId: string, limit = 50): Promise<AuthSessionRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.db.prepare(
      "SELECT * FROM auth_sessions WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT ?",
    ).bind(ownerId, nowIso(), bounded).all<AuthSessionRow>();
    return result.results.map(toRecord);
  }

  async revoke(idHash: string, ownerId?: string): Promise<void> {
    const sql = ownerId
      ? "UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ? AND owner_id = ? AND revoked_at IS NULL"
      : "UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL";
    const statement = this.db.prepare(sql);
    await (ownerId ? statement.bind(nowIso(), idHash, ownerId) : statement.bind(nowIso(), idHash)).run();
  }

  async revokeAll(ownerId: string, exceptIdHash?: string): Promise<void> {
    if (exceptIdHash) {
      await this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE owner_id = ? AND id_hash <> ? AND revoked_at IS NULL")
        .bind(nowIso(), ownerId, exceptIdHash).run();
    } else {
      await this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL")
        .bind(nowIso(), ownerId).run();
    }
  }

  async deleteExpired(batchSize = 500): Promise<number> {
    const bounded = Math.min(Math.max(Math.trunc(batchSize), 1), 1000);
    const result = await this.db.prepare(
      "DELETE FROM auth_sessions WHERE id_hash IN (SELECT id_hash FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL LIMIT ?)",
    ).bind(nowIso(), bounded).run();
    return result.meta.changes;
  }
}
