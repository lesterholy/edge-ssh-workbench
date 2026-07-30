import type { Env } from "../env";

const REGISTRY_KEY = "active-ssh-session-leases";
export const SSH_SESSION_LEASE_TTL_MS = 120_000;
export const SSH_SESSION_LEASE_RENEW_MS = 40_000;

export interface SessionLeaseState {
  leases: Record<string, number>;
}

export interface LeaseUpdateResult {
  state: SessionLeaseState;
  acquired: boolean;
  active: number;
  expiresAt?: number;
  nextAlarm: number | null;
}

function freshLeases(current: SessionLeaseState | undefined, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(current?.leases ?? {}).filter(([, expiresAt]) => expiresAt > now));
}

function result(state: SessionLeaseState, acquired: boolean, expiresAt?: number): LeaseUpdateResult {
  const expirations = Object.values(state.leases);
  return {
    state,
    acquired,
    active: expirations.length,
    expiresAt,
    nextAlarm: expirations.length > 0 ? Math.min(...expirations) : null
  };
}

export function acquireSessionLease(
  current: SessionLeaseState | undefined,
  sessionId: string,
  maximum: number,
  now: number,
  ttlMs = SSH_SESSION_LEASE_TTL_MS
): LeaseUpdateResult {
  const leases = freshLeases(current, now);
  const existing = leases[sessionId];
  if (existing === undefined && Object.keys(leases).length >= maximum) return result({ leases }, false);
  const expiresAt = now + ttlMs;
  leases[sessionId] = expiresAt;
  return result({ leases }, true, expiresAt);
}

export function renewSessionLease(
  current: SessionLeaseState | undefined,
  sessionId: string,
  now: number,
  ttlMs = SSH_SESSION_LEASE_TTL_MS
): LeaseUpdateResult {
  const leases = freshLeases(current, now);
  if (leases[sessionId] === undefined) return result({ leases }, false);
  const expiresAt = now + ttlMs;
  leases[sessionId] = expiresAt;
  return result({ leases }, true, expiresAt);
}

export function releaseSessionLease(
  current: SessionLeaseState | undefined,
  sessionId: string,
  now: number
): LeaseUpdateResult {
  const leases = freshLeases(current, now);
  delete leases[sessionId];
  return result({ leases }, true);
}

export function pruneSessionLeases(current: SessionLeaseState | undefined, now: number): LeaseUpdateResult {
  return result({ leases: freshLeases(current, now) }, true);
}

export class SSHSessionRegistryDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    if (!constantTimeTextEqual(request.headers.get("x-internal-auth") ?? "", this.env.SESSION_HMAC_KEY ?? "")) {
      return Response.json({ error: "Unauthorized internal request" }, { status: 401 });
    }
    let sessionId: string;
    let maximum = 1;
    try {
      const body = await request.json<{ sessionId?: unknown; maximum?: unknown }>();
      if (typeof body.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) throw new Error();
      sessionId = body.sessionId;
      if (body.maximum !== undefined) {
        if (!Number.isInteger(body.maximum) || Number(body.maximum) < 1 || Number(body.maximum) > 20) throw new Error();
        maximum = Number(body.maximum);
      }
    } catch {
      return Response.json({ error: "Invalid lease request" }, { status: 400 });
    }

    const path = new URL(request.url).pathname;
    if (path !== "/acquire" && path !== "/renew" && path !== "/release") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const update = await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionLeaseState>(REGISTRY_KEY);
      const now = Date.now();
      const next = path === "/acquire" ? acquireSessionLease(current, sessionId, maximum, now)
        : path === "/renew" ? renewSessionLease(current, sessionId, now)
          : releaseSessionLease(current, sessionId, now);
      if (next.active > 0) {
        await transaction.put(REGISTRY_KEY, next.state);
        await transaction.setAlarm(next.nextAlarm ?? now + SSH_SESSION_LEASE_TTL_MS);
      } else {
        await transaction.delete(REGISTRY_KEY);
        await transaction.deleteAlarm();
      }
      return next;
    });
    return Response.json(
      { acquired: update.acquired, active: update.active, expiresAt: update.expiresAt },
      { status: update.acquired ? 200 : 409, headers: { "Cache-Control": "no-store" } }
    );
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionLeaseState>(REGISTRY_KEY);
      const update = pruneSessionLeases(current, Date.now());
      if (update.active > 0) {
        await transaction.put(REGISTRY_KEY, update.state);
        await transaction.setAlarm(update.nextAlarm ?? Date.now() + SSH_SESSION_LEASE_TTL_MS);
      } else {
        await transaction.delete(REGISTRY_KEY);
        await transaction.deleteAlarm();
      }
    });
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}
