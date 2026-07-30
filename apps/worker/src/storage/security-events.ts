import { createId, nowIso } from "./internal";

export interface SecurityEventRecord {
  id: string;
  ownerId: string | null;
  code: string;
  sourceIpHash: string | null;
  message: string;
  createdAt: string;
}

interface SecurityEventRow {
  id: string;
  owner_id: string | null;
  event_code: string;
  source_ip_hash: string | null;
  message_safe: string;
  created_at: string;
}

function sanitizeMessage(message: string): string {
  const value = message.trim().slice(0, 512);
  if (!value) throw new Error("Security event message is empty");
  return value.replace(/\b(password|token|secret|private[_ -]?key)\s*(=|:)\s*\S+/gi, "$1$2[REDACTED]");
}

export class SecurityEventRepository {
  constructor(private readonly db: D1Database) {}

  async append(input: Omit<SecurityEventRecord, "id" | "createdAt" | "message"> & { message: string }): Promise<SecurityEventRecord> {
    const record: SecurityEventRecord = {
      ...input,
      id: createId("sec"),
      message: sanitizeMessage(input.message),
      createdAt: nowIso(),
    };
    await this.db.prepare(
      "INSERT INTO security_events (id, owner_id, event_code, source_ip_hash, message_safe, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(record.id, record.ownerId, record.code, record.sourceIpHash, record.message, record.createdAt).run();
    return record;
  }

  async list(ownerId: string, limit = 50): Promise<SecurityEventRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.db.prepare(
      "SELECT * FROM security_events WHERE owner_id = ? OR owner_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?",
    ).bind(ownerId, bounded).all<SecurityEventRow>();
    return result.results.map((row) => ({
      id: row.id, ownerId: row.owner_id, code: row.event_code, sourceIpHash: row.source_ip_hash,
      message: row.message_safe, createdAt: row.created_at,
    }));
  }
}
