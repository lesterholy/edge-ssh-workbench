import type { Env } from "../env";
import { getClientAddress } from "../security";
import { HttpError } from "./errors";

interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface LoginLimiters {
  ip: DurableObjectStub;
  account: DurableObjectStub;
}

async function opaqueKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.slice(0, 512));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loginLimiters(request: Request, env: Env): Promise<LoginLimiters> {
  const addressHash = await opaqueKey(getClientAddress(request));
  return {
    ip: env.AUTH_LIMITER.get(env.AUTH_LIMITER.idFromName(`ip:${addressHash}`)),
    account: env.AUTH_LIMITER.get(env.AUTH_LIMITER.idFromName("account:admin")),
  };
}

async function invoke(
  stub: DurableObjectStub,
  action: "check" | "attempt" | "failure" | "success",
  scope?: "ip" | "account",
): Promise<RateLimitResult> {
  const response = await stub.fetch(`https://auth-limiter.internal/${action}`, {
    method: "POST",
    headers: scope ? { "X-Rate-Limit-Scope": scope } : undefined,
  });
  if (!response.ok) throw new Error("Authentication rate limiter is unavailable");
  return response.json<RateLimitResult>();
}

export async function assertLoginAllowed(limiters: LoginLimiters): Promise<void> {
  // Reserving before the expensive password hash closes the concurrent-request
  // window where many attempts could all pass a read-only limit check.
  const ip = await invoke(limiters.ip, "attempt", "ip");
  if (!ip.allowed) {
    throw new HttpError(429, "RATE_LIMITED", "Too many login attempts", {
      retryable: true,
      retryAfterSeconds: Math.max(1, ip.retryAfterSeconds ?? 1),
    });
  }
  // Do not consume the shared account budget once this source IP is blocked.
  const account = await invoke(limiters.account, "attempt", "account");
  if (account.allowed) return;
  throw new HttpError(429, "RATE_LIMITED", "Too many login attempts", {
    retryable: true,
    retryAfterSeconds: Math.max(1, account.retryAfterSeconds ?? 1),
  });
}

export async function clearLoginFailures(limiters: LoginLimiters): Promise<void> {
  await Promise.all([invoke(limiters.ip, "success"), invoke(limiters.account, "success")]);
}
