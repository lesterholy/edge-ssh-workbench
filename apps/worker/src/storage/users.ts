import { decryptSecret, encryptSecret, type EncryptedEnvelope } from "../security/envelope";
import { createId, nowIso } from "./internal";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_ciphertext: string | null;
  totp_iv: string | null;
  totp_version: number | null;
  pending_totp_ciphertext: string | null;
  pending_totp_iv: string | null;
  pending_totp_version: number | null;
  pending_totp_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  totpEnabled: boolean;
  pendingTotpExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    totpEnabled: row.totp_ciphertext !== null,
    pendingTotpExpiresAt: row.pending_totp_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function envelope(ciphertext: string | null, iv: string | null, version: number | null): EncryptedEnvelope | null {
  return ciphertext !== null && iv !== null && version === 1 ? { ciphertext, iv, version } : null;
}

export class UserRepository {
  constructor(private readonly db: D1Database) {}

  async ensureAdmin(passwordHash: string, username = "admin"): Promise<UserRecord> {
    if (!passwordHash) throw new Error("Admin password hash is required");
    const existing = await this.findByUsername(username);
    if (existing) {
      if (existing.passwordHash !== passwordHash) {
        const updatedAt = nowIso();
        await this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
          .bind(passwordHash, updatedAt, existing.id).run();
        return { ...existing, passwordHash, updatedAt };
      }
      return existing;
    }
    const id = createId("usr");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, username, passwordHash, now, now).run();
    return { id, username, passwordHash, totpEnabled: false, pendingTotpExpiresAt: null, createdAt: now, updatedAt: now };
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
    return row ? toUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
    return row ? toUser(row) : null;
  }

  async savePendingTotp(userId: string, secret: string, masterKey: string | undefined, ttlSeconds = 600): Promise<string> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error("Invalid pending TOTP TTL");
    const encrypted = await encryptSecret(masterKey, secret, { ownerId: userId, recordId: userId, field: "pendingTotp" });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.db.prepare(
      `UPDATE users SET pending_totp_ciphertext = ?, pending_totp_iv = ?, pending_totp_version = ?,
        pending_totp_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(encrypted.ciphertext, encrypted.iv, encrypted.version, expiresAt, nowIso(), userId).run();
    return expiresAt;
  }

  async getPendingTotp(userId: string, masterKey: string | undefined): Promise<string | null> {
    const row = await this.db.prepare(
      "SELECT pending_totp_ciphertext, pending_totp_iv, pending_totp_version, pending_totp_expires_at FROM users WHERE id = ?",
    ).bind(userId).first<Pick<UserRow, "pending_totp_ciphertext" | "pending_totp_iv" | "pending_totp_version" | "pending_totp_expires_at">>();
    const encrypted = row && envelope(row.pending_totp_ciphertext, row.pending_totp_iv, row.pending_totp_version);
    if (!row || !encrypted || !row.pending_totp_expires_at) return null;
    if (Date.parse(row.pending_totp_expires_at) <= Date.now()) {
      await this.clearPendingTotp(userId);
      return null;
    }
    return decryptSecret(masterKey, encrypted, { ownerId: userId, recordId: userId, field: "pendingTotp" });
  }

  async enableTotp(userId: string, secret: string, masterKey: string | undefined): Promise<void> {
    const encrypted = await encryptSecret(masterKey, secret, { ownerId: userId, recordId: userId, field: "totp" });
    await this.db.prepare(
      `UPDATE users SET totp_ciphertext = ?, totp_iv = ?, totp_version = ?,
        pending_totp_ciphertext = NULL, pending_totp_iv = NULL, pending_totp_version = NULL,
        pending_totp_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(encrypted.ciphertext, encrypted.iv, encrypted.version, nowIso(), userId).run();
  }

  async getTotpSecret(userId: string, masterKey: string | undefined): Promise<string | null> {
    const row = await this.db.prepare("SELECT totp_ciphertext, totp_iv, totp_version FROM users WHERE id = ?")
      .bind(userId).first<Pick<UserRow, "totp_ciphertext" | "totp_iv" | "totp_version">>();
    const encrypted = row && envelope(row.totp_ciphertext, row.totp_iv, row.totp_version);
    return encrypted ? decryptSecret(masterKey, encrypted, { ownerId: userId, recordId: userId, field: "totp" }) : null;
  }

  async disableTotp(userId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE users SET totp_ciphertext = NULL, totp_iv = NULL, totp_version = NULL,
        pending_totp_ciphertext = NULL, pending_totp_iv = NULL, pending_totp_version = NULL,
        pending_totp_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), userId).run();
  }

  async clearPendingTotp(userId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE users SET pending_totp_ciphertext = NULL, pending_totp_iv = NULL,
        pending_totp_version = NULL, pending_totp_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), userId).run();
  }
}
