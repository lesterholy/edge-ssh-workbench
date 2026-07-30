interface RateLimitState {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

const STATE_KEY = "login-rate-limit";
const BASE_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 15 * 60;
const STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const IP_FAILURE_THRESHOLD = 5;
const ACCOUNT_FAILURE_THRESHOLD = 20;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export class AuthRateLimiterDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const path = new URL(request.url).pathname;
    if (path === "/check") return json(await this.check());
    if (path === "/attempt") {
      const scope = request.headers.get("X-Rate-Limit-Scope") === "account" ? "account" : "ip";
      return json(await this.reserveAttempt(scope));
    }
    if (path === "/failure") {
      const scope = request.headers.get("X-Rate-Limit-Scope") === "account" ? "account" : "ip";
      return json(await this.recordFailure(scope));
    }
    if (path === "/success") {
      await this.clear();
      return json({ allowed: true } satisfies RateLimitResult);
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.clear();
  }

  private async check(): Promise<RateLimitResult> {
    const stored = await this.readFreshState();
    if (!stored || stored.blockedUntil <= Date.now()) return { allowed: true };

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((stored.blockedUntil - Date.now()) / 1_000)),
    };
  }

  private async recordFailure(scope: "ip" | "account"): Promise<RateLimitResult> {
    return this.updateFailureState(scope, false);
  }

  private async reserveAttempt(scope: "ip" | "account"): Promise<RateLimitResult> {
    const current = await this.check();
    if (!current.allowed) return current;
    return this.updateFailureState(scope, true);
  }

  private async updateFailureState(
    scope: "ip" | "account",
    allowCurrentAttempt: boolean,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const previous = await this.readFreshState();
    const failures = Math.min((previous?.failures ?? 0) + 1, 31);
    const threshold = scope === "account" ? ACCOUNT_FAILURE_THRESHOLD : IP_FAILURE_THRESHOLD;
    const delaySeconds = failures < threshold
      ? 0
      : Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** (failures - threshold));
    const next: RateLimitState = {
      failures,
      blockedUntil: now + delaySeconds * 1_000,
      lastFailureAt: now,
    };

    await this.state.storage.put(STATE_KEY, next);
    await this.state.storage.setAlarm(now + STATE_TTL_MS);

    if (allowCurrentAttempt) return { allowed: true };
    return delaySeconds === 0
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: delaySeconds };
  }

  private async readFreshState(): Promise<RateLimitState | undefined> {
    const stored = await this.state.storage.get<RateLimitState>(STATE_KEY);
    if (!stored) return undefined;
    if (stored.lastFailureAt + STATE_TTL_MS > Date.now()) return stored;

    await this.clear();
    return undefined;
  }

  private async clear(): Promise<void> {
    await this.state.storage.delete(STATE_KEY);
    await this.state.storage.deleteAlarm();
  }
}
