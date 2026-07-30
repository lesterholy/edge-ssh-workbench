import { describe, expect, it, vi } from "vitest";

import { GoogleOidcError, type GoogleOidcService } from "../auth";
import type { Env } from "../env";
import { routeAuth, type AuthRouteDependencies } from "./auth";

const ownerId = "11111111-1111-4111-8111-111111111111";
const state = "s".repeat(43);
const browserToken = "b".repeat(43);

function testEnv(
  database: D1Database,
  limiterResult: { allowed: boolean; retryAfterSeconds?: number } = { allowed: true },
): Env {
  const limiter = {
    fetch: async () => Response.json(limiterResult),
  } as unknown as DurableObjectStub;
  return {
    DB: database,
    AUTH_LIMITER: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => limiter,
    } as unknown as DurableObjectNamespace,
    APP_ENV: "test",
    ADMIN_PASSWORD_HASH: "configured-password-hash",
    CREDENTIAL_MASTER_KEY: "Hh8cHRobGBcWFRQTEhEQDw4NDAsKCQgHBgUEAwIBAAA",
    SESSION_HMAC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "https://workbench.example/api/auth/google/callback",
    GOOGLE_ALLOWED_EMAILS: "admin@example.com",
  } as Env;
}

function databaseFixture() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const user = {
    id: ownerId,
    username: "admin",
    password_hash: "configured-password-hash",
    totp_ciphertext: null,
    totp_iv: null,
    totp_version: null,
    pending_totp_ciphertext: null,
    pending_totp_iv: null,
    pending_totp_version: null,
    pending_totp_expires_at: null,
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
  };
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return {
          first: async () => sql.includes("SELECT * FROM users") ? user : null,
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    }),
  } as unknown as D1Database;
  return { database, statements };
}

describe("Google auth HTTP routes", () => {
  it("advertises Google login only when the complete strict configuration exists", async () => {
    const fixture = databaseFixture();
    const enabled = await routeAuth(
      new Request("https://workbench.example/api/auth/state"),
      testEnv(fixture.database),
      "/api/auth/state",
    );
    expect(await enabled.json()).toMatchObject({ status: "anonymous", googleLoginEnabled: true });

    const disabled = await routeAuth(
      new Request("https://workbench.example/api/auth/state"),
      { ...testEnv(fixture.database), GOOGLE_ALLOWED_EMAILS: "*@example.com" },
      "/api/auth/state",
    );
    expect(await disabled.json()).toMatchObject({ status: "anonymous", googleLoginEnabled: false });
  });

  it("returns the authorization URL with an HttpOnly transaction cookie", async () => {
    const fixture = databaseFixture();
    const service = {
      begin: vi.fn(async () => ({
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        browserToken,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })),
    } as unknown as GoogleOidcService;
    const dependencies: AuthRouteDependencies = { createGoogleOidcService: () => service };
    const response = await routeAuth(
      new Request("https://workbench.example/api/auth/google/start?returnTo=%2Fworkspace", {
        method: "POST",
        headers: { Origin: "https://workbench.example" },
      }),
      testEnv(fixture.database),
      "/api/auth/google/start",
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorizationUrl: expect.stringContaining("https://accounts.google.com/") });
    expect(response.headers.get("Set-Cookie")).toContain("__Host-edgesh_google_oidc=");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(service.begin).toHaveBeenCalledWith("/workspace");
  });

  it("rejects a start request without an Origin before creating a login attempt", async () => {
    const fixture = databaseFixture();
    const begin = vi.fn();
    const service = { begin } as unknown as GoogleOidcService;
    await expect(routeAuth(
      new Request("https://workbench.example/api/auth/google/start", {
        method: "POST",
      }),
      testEnv(fixture.database),
      "/api/auth/google/start",
      { createGoogleOidcService: () => service },
    )).rejects.toMatchObject({ status: 403 });
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects a same-site sibling origin before creating a login attempt", async () => {
    const fixture = databaseFixture();
    const begin = vi.fn();
    const service = { begin } as unknown as GoogleOidcService;
    await expect(routeAuth(
      new Request("https://workbench.example/api/auth/google/start", {
        method: "POST",
        headers: {
          Origin: "https://sibling.example",
          "Sec-Fetch-Site": "same-site",
        },
      }),
      testEnv(fixture.database),
      "/api/auth/google/start",
      { createGoogleOidcService: () => service },
    )).rejects.toMatchObject({ status: 403 });
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects login when the application and callback origins differ", async () => {
    const fixture = databaseFixture();
    const begin = vi.fn();
    const service = { begin } as unknown as GoogleOidcService;
    await expect(routeAuth(
      new Request("https://other.example/api/auth/google/start", {
        method: "POST",
        headers: { Origin: "https://other.example" },
      }),
      testEnv(fixture.database),
      "/api/auth/google/start",
      { createGoogleOidcService: () => service },
    )).rejects.toMatchObject({ status: 503, code: "AUTH_CONFIGURATION_MISSING" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("applies the login limiter before writing an OIDC transaction", async () => {
    const fixture = databaseFixture();
    const begin = vi.fn();
    const service = { begin } as unknown as GoogleOidcService;
    await expect(routeAuth(
      new Request("https://workbench.example/api/auth/google/start", {
        method: "POST",
        headers: { Origin: "https://workbench.example" },
      }),
      testEnv(fixture.database, { allowed: false, retryAfterSeconds: 30 }),
      "/api/auth/google/start",
      { createGoogleOidcService: () => service },
    )).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("binds the existing admin result and issues the normal application session", async () => {
    const fixture = databaseFixture();
    const service = {
      complete: vi.fn(async () => ({
        returnTo: "/workspace",
        identity: {
          provider: "google", subject: "google-subject", ownerId, email: "admin@example.com",
          createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString(),
        },
      })),
    } as unknown as GoogleOidcService;
    const response = await routeAuth(
      new Request(`https://workbench.example/api/auth/google/callback?state=${state}&code=authorization-code`, {
        headers: { Cookie: `__Host-edgesh_google_oidc=${browserToken}` },
      }),
      testEnv(fixture.database),
      "/api/auth/google/callback",
      { createGoogleOidcService: () => service },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/workspace");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-edgesh_session=");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-edgesh_google_oidc=;");
    expect(service.complete).toHaveBeenCalledWith({ state, browserToken, code: "authorization-code", ownerId });
    expect(fixture.statements.some(({ sql }) => sql.includes("INSERT INTO auth_sessions"))).toBe(true);
    expect(fixture.statements.some(({ sql }) => sql.includes("INSERT INTO users"))).toBe(false);
  });

  it("clears the transaction cookie and returns one generic browser error on callback failure", async () => {
    const fixture = databaseFixture();
    const service = {
      complete: vi.fn(async () => { throw new GoogleOidcError("email_not_allowed", "not exposed"); }),
    } as unknown as GoogleOidcService;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await routeAuth(
      new Request(`https://workbench.example/api/auth/google/callback?state=${state}&code=authorization-code`, {
        headers: { Cookie: `__Host-edgesh_google_oidc=${browserToken}` },
      }),
      testEnv(fixture.database),
      "/api/auth/google/callback",
      { createGoogleOidcService: () => service },
    );
    warning.mockRestore();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/?authError=google_login_failed");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await response.text()).not.toContain("not exposed");
  });

  it("rejects a callback received on an origin different from the configured redirect URI", async () => {
    const fixture = databaseFixture();
    const complete = vi.fn();
    const service = { complete } as unknown as GoogleOidcService;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await routeAuth(
      new Request(`https://other.example/api/auth/google/callback?state=${state}&code=authorization-code`, {
        headers: { Cookie: `__Host-edgesh_google_oidc=${browserToken}` },
      }),
      testEnv(fixture.database),
      "/api/auth/google/callback",
      { createGoogleOidcService: () => service },
    );
    warning.mockRestore();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/?authError=google_login_failed");
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects duplicate callback parameters before exchanging a code", async () => {
    const fixture = databaseFixture();
    const complete = vi.fn();
    const service = { complete } as unknown as GoogleOidcService;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await routeAuth(
      new Request(`https://workbench.example/api/auth/google/callback?state=${state}&state=${state}&code=one&code=two`, {
        headers: { Cookie: `__Host-edgesh_google_oidc=${browserToken}` },
      }),
      testEnv(fixture.database),
      "/api/auth/google/callback",
      { createGoogleOidcService: () => service },
    );
    warning.mockRestore();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/?authError=google_login_failed");
    expect(complete).not.toHaveBeenCalled();
  });
});
