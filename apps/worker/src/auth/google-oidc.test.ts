import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { decodeBase64Url, encodeBase64Url } from "../security/encoding";
import type { OAuthIdentityRecord, OAuthRepository } from "../storage/oauth";
import {
  getGoogleOidcConfig,
  GoogleOidcService,
  googleOidcConfigured,
  verifyGoogleIdToken,
} from "./google-oidc";

const sessionKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const masterKey = "Hh8cHRobGBcWFRQTEhEQDw4NDAsKCQgHBgUEAwIBAAA";

function oidcEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "test",
    DB: {} as D1Database,
    SESSION_HMAC_KEY: sessionKey,
    CREDENTIAL_MASTER_KEY: masterKey,
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "https://workbench.example/api/auth/google/callback",
    GOOGLE_ALLOWED_EMAILS: "admin@example.com, second@example.com",
    ...overrides,
  } as Env;
}

describe("Google OIDC configuration", () => {
  it("normalizes an exact email allowlist and rejects wildcard-style entries", () => {
    const config = getGoogleOidcConfig(oidcEnv({ GOOGLE_ALLOWED_EMAILS: " ADMIN@EXAMPLE.COM " }));
    expect([...config.allowedEmails]).toEqual(["admin@example.com"]);
    expect(googleOidcConfigured(oidcEnv({ GOOGLE_ALLOWED_EMAILS: "*@example.com" }))).toBe(false);
    expect(googleOidcConfigured(oidcEnv({ GOOGLE_ALLOWED_EMAILS: "" }))).toBe(false);
  });

  it("requires the fixed callback path and HTTPS in production", () => {
    expect(() => getGoogleOidcConfig(oidcEnv({ APP_ENV: "production", GOOGLE_REDIRECT_URI: "http://workbench.example/api/auth/google/callback" })))
      .toThrow("GOOGLE_REDIRECT_URI");
    expect(() => getGoogleOidcConfig(oidcEnv({ GOOGLE_REDIRECT_URI: "https://workbench.example/other" })))
      .toThrow("GOOGLE_REDIRECT_URI");
  });
});

describe("Google ID token verification", () => {
  it("uses jose to validate signature, issuer, audience, expiry, nonce, and verified email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const getKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test", alg: "RS256", use: "sig" }] });
    const config = getGoogleOidcConfig(oidcEnv());
    const token = await new SignJWT({
      email: "Admin@Example.com",
      email_verified: true,
      nonce: "expected-nonce",
      azp: config.clientId,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience(config.clientId)
      .setSubject("google-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyGoogleIdToken(token, config, "expected-nonce", getKey)).resolves.toEqual({
      subject: "google-subject",
      email: "admin@example.com",
    });
    await expect(verifyGoogleIdToken(token, config, "wrong-nonce", getKey)).rejects.toMatchObject({ code: "token_invalid" });
    await expect(verifyGoogleIdToken(token, { ...config, clientId: "wrong-audience" }, "expected-nonce", getKey))
      .rejects.toMatchObject({ code: "token_invalid" });
    const tokenParts = token.split(".");
    const signature = decodeBase64Url(tokenParts[2] ?? "");
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = `${tokenParts[0]}.${tokenParts[1]}.${encodeBase64Url(signature)}`;
    await expect(verifyGoogleIdToken(tampered, config, "expected-nonce", getKey))
      .rejects.toMatchObject({ code: "token_invalid" });

    const wrongIssuer = await new SignJWT({ email: "admin@example.com", email_verified: true, nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://attacker.example")
      .setAudience(config.clientId)
      .setSubject("google-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyGoogleIdToken(wrongIssuer, config, "expected-nonce", getKey))
      .rejects.toMatchObject({ code: "token_invalid" });

    const expired = await new SignJWT({ email: "admin@example.com", email_verified: true, nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience(config.clientId)
      .setSubject("google-subject")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);
    await expect(verifyGoogleIdToken(expired, config, "expected-nonce", getKey))
      .rejects.toMatchObject({ code: "token_invalid" });

    const unverified = await new SignJWT({ email: "admin@example.com", email_verified: false, nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience(config.clientId)
      .setSubject("google-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyGoogleIdToken(unverified, config, "expected-nonce", getKey))
      .rejects.toMatchObject({ code: "token_invalid" });
  });
});

describe("Google OIDC service", () => {
  it("binds the default runtime fetch to the Worker global object", async () => {
    const identity: OAuthIdentityRecord = {
      provider: "google",
      subject: "google-subject",
      ownerId: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.com",
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    const repository = {
      consume: vi.fn(async () => ({
        nonce: "nonce",
        codeVerifier: "verifier",
        returnTo: "/",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      bindGoogleIdentity: vi.fn(async () => identity),
    } as unknown as OAuthRepository;
    const runtimeFetch = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ id_token: "signed-token" }));
    });
    vi.stubGlobal("fetch", runtimeFetch);
    try {
      const verifyToken = vi.fn(async () => ({ subject: identity.subject, email: identity.email })) as unknown as typeof verifyGoogleIdToken;
      const service = new GoogleOidcService(oidcEnv(), { repository, verifyToken });
      await expect(service.complete({
        state: "a".repeat(43),
        browserToken: "b".repeat(43),
        code: "authorization-code",
        ownerId: identity.ownerId,
      })).resolves.toEqual({ identity, returnTo: "/" });
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates state, nonce and S256 PKCE, then consumes once and binds the existing owner", async () => {
    let attempt: Parameters<OAuthRepository["begin"]>[0] | undefined;
    const identity: OAuthIdentityRecord = {
      provider: "google",
      subject: "google-subject",
      ownerId: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.com",
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    const consumedAttempt = () => attempt ? {
      nonce: attempt.nonce,
      codeVerifier: attempt.codeVerifier,
      returnTo: attempt.returnTo,
      expiresAt: attempt.expiresAt,
    } : null;
    const repository = {
      deleteExpiredAttempts: vi.fn(async () => 0),
      begin: vi.fn(async (value: Parameters<OAuthRepository["begin"]>[0]) => { attempt = value; }),
      consume: vi.fn()
        .mockImplementationOnce(async () => consumedAttempt())
        .mockImplementation(async () => null),
      bindGoogleIdentity: vi.fn(async () => identity),
    } as unknown as OAuthRepository;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("code_verifier")).toBe(attempt?.codeVerifier);
      expect(body.get("client_secret")).toBe("client-secret");
      return Response.json({ id_token: "signed-token" });
    }) as unknown as typeof fetch;
    const verifyToken = vi.fn(async (_token: string, _config: unknown, nonce: string) => {
      expect(nonce).toBe(attempt?.nonce);
      return { subject: "google-subject", email: "admin@example.com" };
    }) as unknown as typeof verifyGoogleIdToken;
    const service = new GoogleOidcService(oidcEnv(), { repository, fetcher, verifyToken });
    const started = await service.begin("/workspace?tab=terminal");
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("nonce")).toBe(attempt?.nonce);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).not.toBe(attempt?.codeVerifier);

    await expect(service.complete({
      state: authorization.searchParams.get("state") ?? "",
      browserToken: started.browserToken,
      code: "authorization-code",
      ownerId: identity.ownerId,
    })).resolves.toEqual({ identity, returnTo: "/workspace?tab=terminal" });
    expect(repository.bindGoogleIdentity).toHaveBeenCalledWith(identity.ownerId, identity.subject, identity.email);
    await expect(service.complete({
      state: authorization.searchParams.get("state") ?? "",
      browserToken: started.browserToken,
      code: "authorization-code",
      ownerId: identity.ownerId,
    })).rejects.toMatchObject({ code: "invalid_state" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed account outside the exact allowlist before binding", async () => {
    const repository = {
      consume: vi.fn(async () => ({ nonce: "nonce", codeVerifier: "verifier", returnTo: "/", expiresAt: new Date(Date.now() + 60_000).toISOString() })),
      bindGoogleIdentity: vi.fn(),
    } as unknown as OAuthRepository;
    const fetcher = vi.fn(async () => Response.json({ id_token: "signed-token" })) as unknown as typeof fetch;
    const verifyToken = vi.fn(async () => ({ subject: "subject", email: "intruder@example.com" })) as unknown as typeof verifyGoogleIdToken;
    const service = new GoogleOidcService(oidcEnv(), { repository, fetcher, verifyToken });
    await expect(service.complete({
      state: "a".repeat(43), browserToken: "b".repeat(43), code: "code",
      ownerId: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ code: "email_not_allowed" });
    expect(repository.bindGoogleIdentity).not.toHaveBeenCalled();
  });

  it("logs only a safe provider code when Google rejects the token exchange", async () => {
    const repository = {
      consume: vi.fn(async () => ({
        nonce: "nonce",
        codeVerifier: "verifier",
        returnTo: "/",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } as unknown as OAuthRepository;
    const fetcher = vi.fn(async () => Response.json({
      error: "invalid_grant",
      error_description: "must-not-appear-in-logs",
    }, { status: 400 })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const service = new GoogleOidcService(oidcEnv(), { repository, fetcher });
      await expect(service.complete({
        state: "a".repeat(43),
        browserToken: "b".repeat(43),
        code: "authorization-code",
        ownerId: "11111111-1111-4111-8111-111111111111",
      })).rejects.toMatchObject({ code: "provider_error" });
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(JSON.parse(logged)).toMatchObject({
        event: "google_oidc_token_exchange_failed",
        stage: "provider_rejected",
        status: 400,
        providerError: "invalid_grant",
      });
      expect(logged).not.toContain("must-not-appear-in-logs");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a bounded runtime error when the token fetch fails", async () => {
    const repository = {
      consume: vi.fn(async () => ({
        nonce: "nonce",
        codeVerifier: "verifier",
        returnTo: "/",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } as unknown as OAuthRepository;
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed\nwith-control-character");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const service = new GoogleOidcService(oidcEnv(), { repository, fetcher });
      await expect(service.complete({
        state: "a".repeat(43), browserToken: "b".repeat(43), code: "authorization-code",
        ownerId: "11111111-1111-4111-8111-111111111111",
      })).rejects.toMatchObject({ code: "provider_error" });
      const logged = JSON.parse(String(warn.mock.calls[0]?.[0] ?? ""));
      expect(logged).toMatchObject({
        event: "google_oidc_token_exchange_failed",
        stage: "network",
        runtimeError: "TypeError: fetch failed with-control-character",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
