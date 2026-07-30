import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import type { Env } from "../env";
import { constantTimeEqual, encodeBase64Url, randomBase64Url, toArrayBufferView } from "../security/encoding";
import { OAuthRepository, type OAuthIdentityRecord } from "../storage/oauth";
import { hashSessionMetadata } from "./session";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  cacheMaxAge: 60 * 60 * 1000,
  cooldownDuration: 30_000,
  timeoutDuration: 5_000,
});
const OIDC_ATTEMPT_TTL_SECONDS = 10 * 60;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

export const GOOGLE_OIDC_COOKIE_NAME = "__Host-edgesh_google_oidc";

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedEmails: ReadonlySet<string>;
}

export type GoogleOidcErrorCode =
  | "configuration"
  | "invalid_state"
  | "provider_error"
  | "token_invalid"
  | "email_not_allowed"
  | "identity_conflict";

export class GoogleOidcError extends Error {
  constructor(readonly code: GoogleOidcErrorCode, message: string) {
    super(message);
    this.name = "GoogleOidcError";
  }
}

function requiredConfig(value: string | undefined, name: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new GoogleOidcError("configuration", `${name} is not configured`);
  }
  return normalized;
}

export function normalizeGoogleEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  const labels = domain.split(".");
  if (normalized.length > 254 || parts.length !== 2 || !local || local.length > 64
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+$/.test(local)
    || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new GoogleOidcError("token_invalid", "Google returned an invalid email address");
  }
  return normalized;
}

export function googleOidcConfigured(env: Env): boolean {
  const present = Boolean(env.GOOGLE_CLIENT_ID?.trim()
    && env.GOOGLE_CLIENT_SECRET?.trim()
    && env.GOOGLE_REDIRECT_URI?.trim()
    && env.GOOGLE_ALLOWED_EMAILS?.trim());
  if (!present) return false;
  try {
    getGoogleOidcConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function getGoogleOidcConfig(env: Env): GoogleOidcConfig {
  const clientId = requiredConfig(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID", 512);
  const clientSecret = requiredConfig(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET", 4096);
  const redirectUri = requiredConfig(env.GOOGLE_REDIRECT_URI, "GOOGLE_REDIRECT_URI", 2048);
  const allowedList = requiredConfig(env.GOOGLE_ALLOWED_EMAILS, "GOOGLE_ALLOWED_EMAILS", 8192);
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new GoogleOidcError("configuration", "GOOGLE_REDIRECT_URI is invalid");
  }
  if ((redirect.protocol !== "https:" && !(env.APP_ENV !== "production" && redirect.protocol === "http:"))
    || redirect.username || redirect.password || redirect.hash || redirect.search
    || redirect.pathname !== "/api/auth/google/callback") {
    throw new GoogleOidcError("configuration", "GOOGLE_REDIRECT_URI must be the absolute Google callback URL");
  }
  const rawEmails = allowedList.split(",");
  if (rawEmails.some((email) => !email.trim())) {
    throw new GoogleOidcError("configuration", "GOOGLE_ALLOWED_EMAILS contains an empty entry");
  }
  let emails: string[];
  try {
    emails = rawEmails.map(normalizeGoogleEmail);
  } catch {
    throw new GoogleOidcError("configuration", "GOOGLE_ALLOWED_EMAILS contains an invalid email address");
  }
  const allowedEmails = new Set(emails);
  if (!allowedEmails.size) throw new GoogleOidcError("configuration", "GOOGLE_ALLOWED_EMAILS is empty");
  return { clientId, clientSecret, redirectUri: redirect.toString(), allowedEmails };
}

export function validateGoogleCallbackUrl(request: Request, config: GoogleOidcConfig): void {
  const received = new URL(request.url);
  const expected = new URL(config.redirectUri);
  if (received.origin !== expected.origin || received.pathname !== expected.pathname) {
    throw new GoogleOidcError("invalid_state", "Google callback URL does not match configuration");
  }
}

export function normalizeReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (value.length > 512 || !value.startsWith("/") || value.startsWith("//")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  return value;
}

export function googleOidcCookie(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid Google OIDC cookie value");
  return `${GOOGLE_OIDC_COOKIE_NAME}=${value}; Path=/; Max-Age=${OIDC_ATTEMPT_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearGoogleOidcCookie(): string {
  return `${GOOGLE_OIDC_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBufferView(new TextEncoder().encode(verifier)));
  return encodeBase64Url(new Uint8Array(digest));
}

export interface GoogleAuthorizationStart {
  authorizationUrl: string;
  browserToken: string;
  expiresAt: string;
}

export interface GoogleIdentityClaims {
  subject: string;
  email: string;
}

export async function verifyGoogleIdToken(
  idToken: string,
  config: GoogleOidcConfig,
  expectedNonce: string,
  getKey: JWTVerifyGetKey = GOOGLE_JWKS,
): Promise<GoogleIdentityClaims> {
  if (!idToken || idToken.length > 16 * 1024) throw new GoogleOidcError("token_invalid", "Google ID token is invalid");
  try {
    const result = await jwtVerify(idToken, getKey, {
      algorithms: ["RS256"],
      audience: config.clientId,
      issuer: [...GOOGLE_ISSUERS],
      requiredClaims: ["sub", "email", "email_verified", "nonce", "iat", "exp"],
      clockTolerance: 5,
    });
    const { payload } = result;
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255
      || typeof payload.email !== "string" || payload.email_verified !== true
      || typeof payload.nonce !== "string") {
      throw new Error("Required Google claims are invalid");
    }
    const actualNonce = new TextEncoder().encode(payload.nonce);
    const nonce = new TextEncoder().encode(expectedNonce);
    if (!constantTimeEqual(actualNonce, nonce)) throw new Error("Google nonce mismatch");
    if (payload.azp !== undefined && payload.azp !== config.clientId) throw new Error("Google authorized party mismatch");
    return { subject: payload.sub, email: normalizeGoogleEmail(payload.email) };
  } catch (error) {
    if (error instanceof GoogleOidcError) throw error;
    throw new GoogleOidcError("token_invalid", "Google ID token validation failed");
  }
}

interface GoogleTokenResponse {
  id_token?: unknown;
}

function safeRuntimeError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const normalized = `${error.name}: ${error.message}`.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 200);
  return normalized || undefined;
}

function logTokenExchangeFailure(stage: string, status?: number, providerError?: string, runtimeError?: string): void {
  console.warn(JSON.stringify({
    level: "warn",
    event: "google_oidc_token_exchange_failed",
    stage,
    ...(status === undefined ? {} : { status }),
    ...(providerError ? { providerError } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  }));
}

async function safeGoogleProviderError(response: Response): Promise<string | undefined> {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return undefined;
  const contentLength = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) return undefined;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) return undefined;
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export interface GoogleOidcDependencies {
  fetcher?: typeof fetch;
  verifyToken?: typeof verifyGoogleIdToken;
  now?: () => number;
  repository?: OAuthRepository;
}

export class GoogleOidcService {
  private readonly config: GoogleOidcConfig;
  private readonly repository: OAuthRepository;
  private readonly fetcher: typeof fetch;
  private readonly verifyToken: typeof verifyGoogleIdToken;
  private readonly now: () => number;

  constructor(private readonly env: Env, dependencies: GoogleOidcDependencies = {}) {
    this.config = getGoogleOidcConfig(env);
    this.repository = dependencies.repository ?? new OAuthRepository(env.DB, env.CREDENTIAL_MASTER_KEY);
    this.fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
    this.verifyToken = dependencies.verifyToken ?? verifyGoogleIdToken;
    this.now = dependencies.now ?? Date.now;
  }

  async begin(returnTo = "/"): Promise<GoogleAuthorizationStart> {
    if (!this.env.SESSION_HMAC_KEY || !this.env.CREDENTIAL_MASTER_KEY) {
      throw new GoogleOidcError("configuration", "OIDC security keys are not configured");
    }
    const state = randomBase64Url(32);
    const browserToken = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const [stateHash, browserHash, challenge] = await Promise.all([
      hashSessionMetadata(state, "oidc-state", this.env.SESSION_HMAC_KEY),
      hashSessionMetadata(browserToken, "oidc-browser", this.env.SESSION_HMAC_KEY),
      pkceChallenge(codeVerifier),
    ]);
    const expiresAt = new Date(this.now() + OIDC_ATTEMPT_TTL_SECONDS * 1000).toISOString();
    await this.repository.deleteExpiredAttempts(100).catch(() => undefined);
    await this.repository.begin({ stateHash, browserHash, nonce, codeVerifier, returnTo: normalizeReturnTo(returnTo), expiresAt });
    const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorization.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { authorizationUrl: authorization.toString(), browserToken, expiresAt };
  }

  async complete(input: { state: string; browserToken: string; code: string; ownerId: string }): Promise<{ identity: OAuthIdentityRecord; returnTo: string }> {
    if (!this.env.SESSION_HMAC_KEY || !this.env.CREDENTIAL_MASTER_KEY) {
      throw new GoogleOidcError("configuration", "OIDC security keys are not configured");
    }
    if (!input.code || input.code.length > 4096) {
      throw new GoogleOidcError("invalid_state", "Google login transaction is invalid");
    }
    const attempt = await this.consumeAttempt(input.state, input.browserToken);
    const token = await this.exchangeCode(input.code, attempt.codeVerifier);
    const claims = await this.verifyToken(token, this.config, attempt.nonce);
    if (!this.config.allowedEmails.has(claims.email)) {
      throw new GoogleOidcError("email_not_allowed", "Google account is not allowed");
    }
    try {
      const identity = await this.repository.bindGoogleIdentity(input.ownerId, claims.subject, claims.email);
      return { identity, returnTo: attempt.returnTo };
    } catch {
      throw new GoogleOidcError("identity_conflict", "Google identity could not be bound");
    }
  }

  async cancel(state: string, browserToken: string): Promise<string> {
    return (await this.consumeAttempt(state, browserToken)).returnTo;
  }

  private async consumeAttempt(state: string, browserToken: string) {
    if (!this.env.SESSION_HMAC_KEY || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browserToken)) {
      throw new GoogleOidcError("invalid_state", "Google login transaction is invalid");
    }
    const [stateHash, browserHash] = await Promise.all([
      hashSessionMetadata(state, "oidc-state", this.env.SESSION_HMAC_KEY),
      hashSessionMetadata(browserToken, "oidc-browser", this.env.SESSION_HMAC_KEY),
    ]);
    const attempt = await this.repository.consume(stateHash, browserHash);
    if (!attempt) throw new GoogleOidcError("invalid_state", "Google login transaction is invalid or expired");
    return attempt;
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logTokenExchangeFailure("network", undefined, undefined, safeRuntimeError(error));
      throw new GoogleOidcError("provider_error", "Google token exchange failed");
    }
    if (!response.ok) {
      logTokenExchangeFailure("provider_rejected", response.status, await safeGoogleProviderError(response));
      throw new GoogleOidcError("provider_error", "Google token exchange failed");
    }
    if (response.url && new URL(response.url).origin !== "https://oauth2.googleapis.com") {
      logTokenExchangeFailure("unexpected_origin", response.status);
      throw new GoogleOidcError("provider_error", "Google token exchange failed");
    }
    if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      logTokenExchangeFailure("invalid_content_type", response.status);
      throw new GoogleOidcError("provider_error", "Google token response is invalid");
    }
    const contentLength = Number(response.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
      logTokenExchangeFailure("response_too_large", response.status);
      throw new GoogleOidcError("provider_error", "Google token response is too large");
    }
    let body: GoogleTokenResponse;
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error();
      body = JSON.parse(text) as GoogleTokenResponse;
    } catch {
      logTokenExchangeFailure("invalid_json", response.status);
      throw new GoogleOidcError("provider_error", "Google token response is invalid");
    }
    if (typeof body.id_token !== "string") {
      logTokenExchangeFailure("missing_id_token", response.status);
      throw new GoogleOidcError("provider_error", "Google ID token is missing");
    }
    return body.id_token;
  }
}
