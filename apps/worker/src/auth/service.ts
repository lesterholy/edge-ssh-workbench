import type { Env } from "../env";
import { getClientAddress } from "../security/http";
import { createRepositories, type AuthSessionRecord, type UserRecord } from "../storage";
import { verifyPassword } from "./password";
import {
  createSessionToken,
  DEFAULT_SESSION_TTL_SECONDS,
  hashSessionMetadata,
  hashSessionToken,
  readSessionToken,
  sessionCookie,
} from "./session";
import { verifyTotp } from "./totp";

export interface AuthContext {
  user: UserRecord;
  session: AuthSessionRecord;
  tokenHash: string;
}

export type LoginCheck =
  | { status: "ok"; user: UserRecord }
  | { status: "totp_required" }
  | { status: "invalid" };

export interface IssuedSession {
  token: string;
  cookie: string;
  session: AuthSessionRecord;
}

export class AuthService {
  private readonly repositories;

  constructor(private readonly env: Env) {
    this.repositories = createRepositories(env);
  }

  async ensureAdmin(): Promise<UserRecord> {
    if (!this.env.ADMIN_PASSWORD_HASH) throw new Error("ADMIN_PASSWORD_HASH is required");
    return this.repositories.users.ensureAdmin(this.env.ADMIN_PASSWORD_HASH);
  }

  async checkLogin(password: string, totpCode?: string): Promise<LoginCheck> {
    const user = await this.ensureAdmin();
    if (!await verifyPassword(password, user.passwordHash)) return { status: "invalid" };
    if (!user.totpEnabled) return { status: "ok", user };
    if (!totpCode) return { status: "totp_required" };
    const secret = await this.repositories.users.getTotpSecret(user.id, this.env.CREDENTIAL_MASTER_KEY);
    return await verifyTotp(totpCode, secret) ? { status: "ok", user } : { status: "invalid" };
  }

  async issueSession(userId: string, request: Request, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS): Promise<IssuedSession> {
    const token = createSessionToken();
    const idHash = await hashSessionToken(token, this.env.SESSION_HMAC_KEY);
    const sourceAddress = getClientAddress(request);
    const userAgent = request.headers.get("User-Agent") ?? "unknown";
    const [sourceIpHash, userAgentHash] = await Promise.all([
      hashSessionMetadata(sourceAddress, "source-ip", this.env.SESSION_HMAC_KEY),
      hashSessionMetadata(userAgent, "user-agent", this.env.SESSION_HMAC_KEY),
    ]);
    const session = await this.repositories.authSessions.create({
      idHash,
      ownerId: userId,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      sourceIpHash,
      userAgentHash,
    });
    return { token, cookie: sessionCookie(token, ttlSeconds), session };
  }

  async authenticate(request: Request, touch = false): Promise<AuthContext | null> {
    const token = readSessionToken(request);
    if (!token) return null;
    let tokenHash: string;
    try {
      tokenHash = await hashSessionToken(token, this.env.SESSION_HMAC_KEY);
    } catch {
      return null;
    }
    const session = await this.repositories.authSessions.findActive(tokenHash, touch);
    if (!session) return null;
    const user = await this.repositories.users.findById(session.ownerId);
    return user ? { user, session, tokenHash } : null;
  }

  async revokeCurrent(request: Request): Promise<void> {
    const token = readSessionToken(request);
    if (!token) return;
    try {
      await this.repositories.authSessions.revoke(await hashSessionToken(token, this.env.SESSION_HMAC_KEY));
    } catch {
      // A malformed or obsolete cookie is already unauthenticated.
    }
  }
}
