import {
  LoginRequestSchema,
  TotpDisableRequestSchema,
  TotpEnrollmentConfirmRequestSchema,
  type AuthState,
} from "@edgesh/contracts";

import {
  clearSessionCookie,
  clearGoogleOidcCookie,
  createOtpAuthUrl,
  createSessionToken,
  DEFAULT_SESSION_TTL_SECONDS,
  generateTotpSecret,
  googleOidcConfigured,
  googleOidcCookie,
  GoogleOidcError,
  GoogleOidcService,
  GOOGLE_OIDC_COOKIE_NAME,
  getGoogleOidcConfig,
  hashSessionMetadata,
  hashSessionToken,
  readSessionToken,
  readCookie,
  sessionCookie,
  verifyPassword,
  verifyTotp,
  validateGoogleCallbackUrl,
} from "../auth";
import type { Env } from "../env";
import { assertRequestOrigin, getClientAddress } from "../security";
import { AuthSessionRepository } from "../storage/auth-sessions";
import { SecurityEventRepository } from "../storage/security-events";
import { UserRepository, type UserRecord } from "../storage/users";
import { HttpError, methodNotAllowed } from "./errors";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginLimiters,
} from "./rate-limit";
import { parseJson } from "./request";
import { apiJson } from "./response";

export interface AuthenticatedRequest {
  ownerId: string;
  sessionIdHash: string;
  user: UserRecord;
  session: {
    createdAt: string;
    expiresAt: string;
  };
}

interface AuthRepositories {
  users: UserRepository;
  authSessions: AuthSessionRepository;
}

interface IssuedAppSession {
  cookie: string;
  session: { createdAt: string; expiresAt: string };
}

export interface AuthRouteDependencies {
  createGoogleOidcService(env: Env): GoogleOidcService;
}

const defaultAuthRouteDependencies: AuthRouteDependencies = {
  createGoogleOidcService: (env) => new GoogleOidcService(env),
};

export function authRepositories(env: Env): AuthRepositories {
  return {
    users: new UserRepository(env.DB),
    authSessions: new AuthSessionRepository(env.DB),
  };
}

function assertSessionConfiguration(env: Env): asserts env is Env & { SESSION_HMAC_KEY: string } {
  if (!env.SESSION_HMAC_KEY) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Authentication is not configured");
  }
}

async function adminUser(repositories: AuthRepositories, env: Env): Promise<UserRecord | null> {
  if (!env.ADMIN_PASSWORD_HASH) return null;
  return repositories.users.ensureAdmin(env.ADMIN_PASSWORD_HASH);
}

async function issueAppSession(
  request: Request,
  env: Env & { SESSION_HMAC_KEY: string },
  repositories: AuthRepositories,
  user: UserRecord,
): Promise<IssuedAppSession> {
  const token = createSessionToken();
  const idHash = await hashSessionToken(token, env.SESSION_HMAC_KEY);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1_000).toISOString();
  const [sourceIpHash, userAgentHash] = await Promise.all([
    hashSessionMetadata(getClientAddress(request), "source-ip", env.SESSION_HMAC_KEY),
    hashSessionMetadata(request.headers.get("User-Agent") ?? "unknown", "user-agent", env.SESSION_HMAC_KEY),
  ]);
  const session = await repositories.authSessions.create({
    idHash,
    ownerId: user.id,
    expiresAt,
    sourceIpHash,
    userAgentHash,
  });
  return {
    cookie: sessionCookie(token),
    session: { createdAt: session.createdAt, expiresAt: session.expiresAt },
  };
}

export async function optionalAuthentication(
  request: Request,
  env: Env,
  repositories = authRepositories(env),
): Promise<AuthenticatedRequest | null> {
  const token = readSessionToken(request);
  if (!token || !env.SESSION_HMAC_KEY) return null;
  let idHash: string;
  try {
    idHash = await hashSessionToken(token, env.SESSION_HMAC_KEY);
  } catch {
    return null;
  }
  const session = await repositories.authSessions.findActive(idHash, true);
  if (!session) return null;
  const user = await repositories.users.findById(session.ownerId);
  if (!user) return null;
  return {
    ownerId: user.id,
    sessionIdHash: idHash,
    user,
    session: { createdAt: session.createdAt, expiresAt: session.expiresAt },
  };
}

export async function requireAuthentication(
  request: Request,
  env: Env,
  repositories = authRepositories(env),
): Promise<AuthenticatedRequest> {
  assertSessionConfiguration(env);
  const authenticated = await optionalAuthentication(request, env, repositories);
  if (!authenticated) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required");
  return authenticated;
}

async function handleLogin(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  assertSessionConfiguration(env);
  if (!env.ADMIN_PASSWORD_HASH) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Authentication is not configured");
  }
  const limiters = await loginLimiters(request, env);
  await assertLoginAllowed(limiters);
  const input = await parseJson(request, LoginRequestSchema, 8 * 1024);
  const user = await adminUser(repositories, env);
  const passwordValid = Boolean(user) && await verifyPassword(input.password, env.ADMIN_PASSWORD_HASH);
  if (!passwordValid || !user) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid login credentials");
  }
  if (user.totpEnabled) {
    if (!env.CREDENTIAL_MASTER_KEY) {
      throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Credential encryption is not configured");
    }
    if (!input.totpCode) {
      throw new HttpError(401, "TOTP_REQUIRED", "A two-factor authentication code is required");
    }
    const secret = await repositories.users.getTotpSecret(user.id, env.CREDENTIAL_MASTER_KEY);
    if (!await verifyTotp(input.totpCode, secret)) {
      throw new HttpError(401, "TOTP_INVALID", "The two-factor authentication code is invalid");
    }
  }

  await clearLoginFailures(limiters);
  const issued = await issueAppSession(request, env, repositories, user);
  const state: AuthState = {
    status: "authenticated",
    authenticated: true,
    totpEnabled: user.totpEnabled,
    totpRequired: false,
    session: issued.session,
  };
  return apiJson(state, 200, { "Set-Cookie": issued.cookie });
}

function singleQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

function redirectResponse(location: string, cookies: readonly string[], status = 303): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

function failureRedirect(returnTo = "/"): string {
  const location = new URL(returnTo, "https://edgesh.invalid");
  location.searchParams.set("authError", "google_login_failed");
  return `${location.pathname}${location.search}${location.hash}`;
}

async function handleGoogleStart(
  request: Request,
  env: Env,
  repositories: AuthRepositories,
  dependencies: AuthRouteDependencies,
): Promise<Response> {
  assertSessionConfiguration(env);
  assertRequestOrigin(request, env);
  if (!env.CREDENTIAL_MASTER_KEY || !env.ADMIN_PASSWORD_HASH) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Google authentication is not configured");
  }
  try {
    const config = getGoogleOidcConfig(env);
    if (new URL(request.url).origin !== new URL(config.redirectUri).origin) {
      throw new GoogleOidcError("configuration", "Google callback origin does not match this application");
    }
    const limiters = await loginLimiters(request, env);
    await assertLoginAllowed(limiters);
    await adminUser(repositories, env);
    const service = dependencies.createGoogleOidcService(env);
    const started = await service.begin(new URL(request.url).searchParams.get("returnTo") ?? "/");
    return apiJson(
      { authorizationUrl: started.authorizationUrl },
      200,
      { "Set-Cookie": googleOidcCookie(started.browserToken) },
    );
  } catch (error) {
    if (error instanceof GoogleOidcError && error.code === "configuration") {
      throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Google authentication is not configured");
    }
    throw error;
  }
}

async function handleGoogleCallback(
  request: Request,
  env: Env,
  repositories: AuthRepositories,
  dependencies: AuthRouteDependencies,
): Promise<Response> {
  let returnTo = "/";
  try {
    assertSessionConfiguration(env);
    if (!env.CREDENTIAL_MASTER_KEY || !env.ADMIN_PASSWORD_HASH) {
      throw new GoogleOidcError("configuration", "Google authentication is not configured");
    }
    const config = getGoogleOidcConfig(env);
    const service = dependencies.createGoogleOidcService(env);
    const url = new URL(request.url);
    const state = singleQueryValue(url, "state");
    const browserToken = readCookie(request, GOOGLE_OIDC_COOKIE_NAME);
    if (!state || !browserToken) throw new GoogleOidcError("invalid_state", "Google login transaction is invalid");
    if (singleQueryValue(url, "error")) {
      returnTo = await service.cancel(state, browserToken);
      return redirectResponse(failureRedirect(returnTo), [clearGoogleOidcCookie()]);
    }
    validateGoogleCallbackUrl(request, config);
    const code = singleQueryValue(url, "code");
    if (!code) throw new GoogleOidcError("provider_error", "Google authorization code is missing");
    // The start route bootstraps the canonical password-backed admin. The callback
    // may bind only that already-existing row and never creates a Google user.
    const user = await repositories.users.findByUsername("admin");
    if (!user) throw new GoogleOidcError("configuration", "Administrator is not configured");
    const completed = await service.complete({ state, browserToken, code, ownerId: user.id });
    returnTo = completed.returnTo;
    await clearLoginFailures(await loginLimiters(request, env)).catch(() => undefined);
    const issued = await issueAppSession(request, env, repositories, user);
    await new SecurityEventRepository(env.DB).append({
      ownerId: user.id,
      code: "google_login_succeeded",
      sourceIpHash: await hashSessionMetadata(getClientAddress(request), "source-ip", env.SESSION_HMAC_KEY),
      message: "Google OIDC login succeeded",
    }).catch(() => undefined);
    return redirectResponse(returnTo, [clearGoogleOidcCookie(), issued.cookie]);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "google_oidc_login_failed",
      reason: error instanceof GoogleOidcError ? error.code : "internal",
    }));
    return redirectResponse(failureRedirect(returnTo), [clearGoogleOidcCookie()]);
  }
}

async function handleLogout(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  if (env.SESSION_HMAC_KEY) {
    const token = readSessionToken(request);
    if (token) {
      try {
        await repositories.authSessions.revoke(await hashSessionToken(token, env.SESSION_HMAC_KEY));
      } catch {
        // An invalid cookie is cleared below without exposing parsing details.
      }
    }
  }
  return apiJson({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function handleState(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  const authenticated = await optionalAuthentication(request, env, repositories);
  if (authenticated) {
    const state: AuthState = {
      status: "authenticated",
      authenticated: true,
      totpEnabled: authenticated.user.totpEnabled,
      totpRequired: false,
      session: authenticated.session,
    };
    return apiJson(state);
  }
  const user = await adminUser(repositories, env);
  const state: AuthState = {
    status: "anonymous",
    authenticated: false,
    totpEnabled: user?.totpEnabled ?? false,
    totpRequired: false,
    googleLoginEnabled: googleOidcConfigured(env)
      && Boolean(env.SESSION_HMAC_KEY && env.CREDENTIAL_MASTER_KEY && env.ADMIN_PASSWORD_HASH),
  };
  return apiJson(state);
}

async function handleTotpSetup(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  const auth = await requireAuthentication(request, env, repositories);
  if (!env.CREDENTIAL_MASTER_KEY) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Credential encryption is not configured");
  }
  const secret = generateTotpSecret();
  const expiresAt = await repositories.users.savePendingTotp(
    auth.ownerId,
    secret,
    env.CREDENTIAL_MASTER_KEY,
    10 * 60,
  );
  return apiJson({
    secret,
    otpauthUri: createOtpAuthUrl(secret),
    expiresAt,
  }, 201);
}

async function handleTotpConfirm(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  const auth = await requireAuthentication(request, env, repositories);
  const input = await parseJson(request, TotpEnrollmentConfirmRequestSchema, 8 * 1024);
  const secret = await repositories.users.getPendingTotp(auth.ownerId, env.CREDENTIAL_MASTER_KEY);
  if (!secret) throw new HttpError(400, "TOTP_ENROLLMENT_EXPIRED", "TOTP enrollment has expired");
  if (!await verifyTotp(input.code, secret)) {
    throw new HttpError(400, "TOTP_INVALID", "The TOTP code is invalid");
  }
  await repositories.users.enableTotp(auth.ownerId, secret, env.CREDENTIAL_MASTER_KEY);
  return apiJson({ enabled: true, enabledAt: new Date().toISOString() });
}

async function handleTotpDisable(request: Request, env: Env, repositories: AuthRepositories): Promise<Response> {
  const auth = await requireAuthentication(request, env, repositories);
  const input = await parseJson(request, TotpDisableRequestSchema, 8 * 1024);
  const passwordValid = await verifyPassword(input.password, auth.user.passwordHash);
  const secret = await repositories.users.getTotpSecret(auth.ownerId, env.CREDENTIAL_MASTER_KEY);
  if (!passwordValid || !await verifyTotp(input.code, secret)) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid login credentials");
  }
  await repositories.users.disableTotp(auth.ownerId);
  return apiJson({ enabled: false });
}

export async function routeAuth(
  request: Request,
  env: Env,
  path: string,
  dependencies: AuthRouteDependencies = defaultAuthRouteDependencies,
): Promise<Response> {
  const repositories = authRepositories(env);
  if (path === "/api/auth/google/start") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return handleGoogleStart(request, env, repositories, dependencies);
  }
  if (path === "/api/auth/google/callback") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return handleGoogleCallback(request, env, repositories, dependencies);
  }
  if (path === "/api/auth/login") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return handleLogin(request, env, repositories);
  }
  if (path === "/api/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return handleLogout(request, env, repositories);
  }
  if (path === "/api/auth/state") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return handleState(request, env, repositories);
  }
  if (path === "/api/auth/totp/setup") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return handleTotpSetup(request, env, repositories);
  }
  if (path === "/api/auth/totp/confirm") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return handleTotpConfirm(request, env, repositories);
  }
  if (path === "/api/auth/totp") {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    return handleTotpDisable(request, env, repositories);
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found");
}
