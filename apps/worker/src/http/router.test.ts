import { describe, expect, it } from "vitest";

import type { Env } from "../env";
import { routeRequest } from "./router";

function testEnv(overrides: Partial<Env> = {}): Env {
  const assets = {
    fetch: async () => new Response("<!doctype html><title>EdgeSSH</title>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  };
  return {
    ASSETS: assets as unknown as Fetcher,
    DB: {} as D1Database,
    FILES: {} as R2Bucket,
    SSH_SESSIONS: {} as DurableObjectNamespace,
    SSH_SESSION_REGISTRY: {} as DurableObjectNamespace,
    AUTH_LIMITER: {} as DurableObjectNamespace,
    APP_ENV: "test",
    ...overrides,
  };
}

describe("Worker HTTP router", () => {
  it("returns a non-secret health response with security headers", async () => {
    const response = await routeRequest(new Request("https://workbench.test/api/health"), testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toMatchObject({
      status: "ok",
      runtime: "cloudflare-workers",
      bindings: { d1: true, r2: true, durableObjects: true },
    });
  });

  it("returns contract-shaped JSON for an unknown API route", async () => {
    const response = await routeRequest(new Request("https://workbench.test/api/missing"), testEnv());
    const body = await response.json() as { error: Record<string, unknown> };
    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(body.error.requestId).toBe(response.headers.get("X-Request-ID"));
  });

  it("rejects a state-changing request without an Origin before authentication", async () => {
    const response = await routeRequest(new Request("https://workbench.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "not-used" }),
    }), testEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });

  it("answers preflight only for an explicitly allowed origin", async () => {
    const request = new Request("https://workbench.test/api/settings", {
      method: "OPTIONS",
      headers: {
        Origin: "https://admin.example",
        "Access-Control-Request-Method": "PATCH",
      },
    });
    const response = await routeRequest(request, testEnv({ ALLOWED_ORIGINS: "https://admin.example" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.example");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("redirects production asset requests to HTTPS", async () => {
    const request = new Request("http://workbench.test/", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    });
    const response = await routeRequest(request, testEnv({ APP_ENV: "production" }));
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://workbench.test/");
  });

  it("adds a restrictive CSP to HTML assets", async () => {
    const response = await routeRequest(new Request("https://workbench.test/"), testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
