import { assertAllowedSshPort, normalizeHost } from "../security/network";
import { createId, nowIso } from "./internal";

export interface KnownHostRecord {
  id: string;
  profileId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  keyBlob: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface KnownHostRow {
  id: string;
  profile_id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  key_blob: string;
  first_seen_at: string;
  last_seen_at: string;
}

function toRecord(row: KnownHostRow): KnownHostRecord {
  return {
    id: row.id, profileId: row.profile_id, host: row.host, port: row.port, keyType: row.key_type,
    fingerprint: row.fingerprint, keyBlob: row.key_blob, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
  };
}

export type HostKeyCheck =
  | { status: "unknown" }
  | { status: "match"; knownHost: KnownHostRecord }
  | { status: "changed"; knownHost: KnownHostRecord };

export interface PresentedHostKey {
  keyType: string;
  fingerprint: string;
  keyBlob: string;
}

export class KnownHostRepository {
  constructor(private readonly db: D1Database) {}

  async get(ownerId: string, profileId: string, host: string, port: number): Promise<KnownHostRecord | null> {
    assertAllowedSshPort(port);
    const normalizedHost = normalizeHost(host);
    const row = await this.db.prepare(
      `SELECT kh.* FROM known_hosts kh JOIN profiles p ON p.id = kh.profile_id
       WHERE kh.profile_id = ? AND kh.host = ? AND kh.port = ? AND p.owner_id = ?`,
    ).bind(profileId, normalizedHost, port, ownerId).first<KnownHostRow>();
    return row ? toRecord(row) : null;
  }

  async check(ownerId: string, profileId: string, host: string, port: number, presented: PresentedHostKey): Promise<HostKeyCheck> {
    const knownHost = await this.get(ownerId, profileId, host, port);
    if (!knownHost) return { status: "unknown" };
    const matches = knownHost.keyType === presented.keyType
      && knownHost.fingerprint === presented.fingerprint
      && knownHost.keyBlob === presented.keyBlob;
    if (!matches) return { status: "changed", knownHost };
    await this.db.prepare("UPDATE known_hosts SET last_seen_at = ? WHERE id = ?").bind(nowIso(), knownHost.id).run();
    return { status: "match", knownHost: { ...knownHost, lastSeenAt: nowIso() } };
  }

  async pin(ownerId: string, profileId: string, host: string, port: number, presented: PresentedHostKey): Promise<KnownHostRecord> {
    const normalizedHost = normalizeHost(host);
    assertAllowedSshPort(port);
    const current = await this.get(ownerId, profileId, normalizedHost, port);
    if (current) {
      if (current.keyType !== presented.keyType || current.fingerprint !== presented.fingerprint || current.keyBlob !== presented.keyBlob) {
        throw new Error("SSH host key changed");
      }
      await this.db.prepare("UPDATE known_hosts SET last_seen_at = ? WHERE id = ?").bind(nowIso(), current.id).run();
      return { ...current, lastSeenAt: nowIso() };
    }
    const ownsProfile = await this.db.prepare("SELECT id FROM profiles WHERE id = ? AND owner_id = ?")
      .bind(profileId, ownerId).first<{ id: string }>();
    if (!ownsProfile) throw new Error("Profile not found");
    const id = createId("kh");
    const now = nowIso();
    await this.db.prepare(
      `INSERT INTO known_hosts (id, profile_id, host, port, key_type, fingerprint, key_blob, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, profileId, normalizedHost, port, presented.keyType, presented.fingerprint, presented.keyBlob, now, now).run();
    return { id, profileId, host: normalizedHost, port, ...presented, firstSeenAt: now, lastSeenAt: now };
  }

  async delete(ownerId: string, profileId: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM known_hosts WHERE profile_id IN (SELECT id FROM profiles WHERE id = ? AND owner_id = ?)",
    ).bind(profileId, ownerId).run();
  }
}
