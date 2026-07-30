import { decryptSecret, encryptSecret, type EncryptedEnvelope } from "../security/envelope";
import { nowIso } from "./internal";

export interface OAuthLoginAttemptInput {
  stateHash: string;
  browserHash: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: string;
}

export interface ConsumedOAuthLoginAttempt {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: string;
}

interface OAuthAttemptRow {
  state_hash: string;
  browser_hash: string;
  transaction_ciphertext: string;
  transaction_iv: string;
  transaction_version: number;
  return_to: string;
  expires_at: string;
}

interface OAuthIdentityRow {
  provider: "google";
  subject: string;
  owner_id: string;
  email_normalized: string;
  created_at: string;
  last_login_at: string;
}

export interface OAuthIdentityRecord {
  provider: "google";
  subject: string;
  ownerId: string;
  email: string;
  createdAt: string;
  lastLoginAt: string;
}

function toIdentity(row: OAuthIdentityRow): OAuthIdentityRecord {
  return {
    provider: row.provider,
    subject: row.subject,
    ownerId: row.owner_id,
    email: row.email_normalized,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function validateSubject(subject: string): void {
  if (!subject || subject.length > 255 || !/^[\x21-\x7e]+$/.test(subject)) {
    throw new Error("Invalid OAuth subject");
  }
}

export class OAuthRepository {
  constructor(private readonly db: D1Database, private readonly masterKey?: string) {}

  async begin(input: OAuthLoginAttemptInput): Promise<void> {
    if (!input.stateHash || !input.browserHash || Date.parse(input.expiresAt) <= Date.now()) {
      throw new Error("Invalid OAuth login attempt");
    }
    const transaction = await encryptSecret(
      this.masterKey,
      JSON.stringify({ nonce: input.nonce, codeVerifier: input.codeVerifier }),
      { ownerId: "oidc", recordId: input.stateHash, field: "oauthTransaction" },
    );
    await this.db.prepare(
      `INSERT INTO oauth_login_attempts
        (state_hash, browser_hash, transaction_ciphertext, transaction_iv, transaction_version,
         return_to, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      input.stateHash,
      input.browserHash,
      transaction.ciphertext,
      transaction.iv,
      transaction.version,
      input.returnTo,
      input.expiresAt,
      nowIso(),
    ).run();
  }

  async consume(stateHash: string, browserHash: string): Promise<ConsumedOAuthLoginAttempt | null> {
    const consumedAt = nowIso();
    const row = await this.db.prepare(
      `UPDATE oauth_login_attempts SET consumed_at = ?
       WHERE state_hash = ? AND browser_hash = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING state_hash, browser_hash, transaction_ciphertext, transaction_iv,
         transaction_version, return_to, expires_at`,
    ).bind(consumedAt, stateHash, browserHash, consumedAt).first<OAuthAttemptRow>();
    if (!row) return null;
    if (row.transaction_version !== 1) throw new Error("Invalid OAuth transaction envelope");
    const envelope: EncryptedEnvelope = {
      ciphertext: row.transaction_ciphertext,
      iv: row.transaction_iv,
      version: 1,
    };
    const plaintext = await decryptSecret(
      this.masterKey,
      envelope,
      { ownerId: "oidc", recordId: row.state_hash, field: "oauthTransaction" },
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(plaintext);
    } catch {
      throw new Error("Invalid OAuth transaction payload");
    }
    if (!decoded || typeof decoded !== "object"
      || typeof (decoded as Record<string, unknown>).nonce !== "string"
      || typeof (decoded as Record<string, unknown>).codeVerifier !== "string") {
      throw new Error("Invalid OAuth transaction payload");
    }
    return {
      nonce: (decoded as { nonce: string }).nonce,
      codeVerifier: (decoded as { codeVerifier: string }).codeVerifier,
      returnTo: row.return_to,
      expiresAt: row.expires_at,
    };
  }

  async bindGoogleIdentity(ownerId: string, subject: string, email: string): Promise<OAuthIdentityRecord> {
    validateSubject(subject);
    const ownership = await this.db.prepare(
      "SELECT COUNT(*) AS user_count, SUM(CASE WHEN id = ? THEN 1 ELSE 0 END) AS owner_exists FROM users",
    ).bind(ownerId).first<{ user_count: number; owner_exists: number }>();
    if (ownership?.user_count !== 1 || ownership.owner_exists !== 1) {
      throw new Error("OAuth identity requires the single existing administrator");
    }
    const existingSubject = await this.findGoogleBySubject(subject);
    if (existingSubject && existingSubject.ownerId !== ownerId) throw new Error("OAuth identity is already bound");
    const existingEmail = await this.findGoogleByEmail(email);
    if (existingEmail && existingEmail.subject !== subject) throw new Error("OAuth email is already bound");

    const timestamp = nowIso();
    try {
      await this.db.prepare(
        `INSERT INTO oauth_identities (provider, subject, owner_id, email_normalized, created_at, last_login_at)
         SELECT 'google', ?, u.id, ?, ?, ? FROM users u
         WHERE u.id = ? AND (SELECT COUNT(*) FROM users) = 1
         ON CONFLICT(provider, subject) DO UPDATE SET
           email_normalized = excluded.email_normalized,
           last_login_at = excluded.last_login_at
         WHERE oauth_identities.owner_id = excluded.owner_id`,
      ).bind(subject, email, timestamp, timestamp, ownerId).run();
    } catch {
      throw new Error("OAuth identity could not be bound");
    }
    const identity = await this.findGoogleBySubject(subject);
    if (!identity || identity.ownerId !== ownerId || identity.email !== email) {
      throw new Error("OAuth identity could not be bound to the single administrator");
    }
    return identity;
  }

  async findGoogleBySubject(subject: string): Promise<OAuthIdentityRecord | null> {
    validateSubject(subject);
    const row = await this.db.prepare(
      "SELECT * FROM oauth_identities WHERE provider = 'google' AND subject = ?",
    ).bind(subject).first<OAuthIdentityRow>();
    return row ? toIdentity(row) : null;
  }

  async findGoogleByEmail(email: string): Promise<OAuthIdentityRecord | null> {
    const row = await this.db.prepare(
      "SELECT * FROM oauth_identities WHERE provider = 'google' AND email_normalized = ?",
    ).bind(email).first<OAuthIdentityRow>();
    return row ? toIdentity(row) : null;
  }

  async deleteExpiredAttempts(batchSize = 500): Promise<number> {
    const bounded = Math.min(Math.max(Math.trunc(batchSize), 1), 1000);
    const result = await this.db.prepare(
      `DELETE FROM oauth_login_attempts WHERE state_hash IN (
         SELECT state_hash FROM oauth_login_attempts
         WHERE expires_at <= ? OR consumed_at IS NOT NULL ORDER BY created_at ASC LIMIT ?
       )`,
    ).bind(nowIso(), bounded).run();
    return result.meta.changes;
  }
}
