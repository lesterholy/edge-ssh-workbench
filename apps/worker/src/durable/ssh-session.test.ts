import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { SSHSessionDO } from "./ssh-session";

describe("SSHSessionDO restart recovery", () => {
  it("finalizes an attached live session and releases its owner lease", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return {
            first: async () => sql.includes("SELECT owner_id") ? { owner_id: ownerId } : null,
            run: async () => ({ meta: { changes: 1 } })
          };
        }
      })
    } as unknown as D1Database;
    const registryFetch = vi.fn(async () => Response.json({ acquired: true, active: 0 }));
    const registry = {
      idFromName: vi.fn(() => ({ toString: () => ownerId })),
      get: vi.fn(() => ({ fetch: registryFetch }))
    } as unknown as DurableObjectNamespace;
    const socket = {
      deserializeAttachment: () => ({ phase: "connected", sessionId, ownerId }),
      close: vi.fn()
    } as unknown as WebSocket;
    let recovery: Promise<unknown> = Promise.resolve();
    const state = {
      getWebSockets: () => [socket],
      blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
        recovery = callback();
        return recovery;
      }
    } as unknown as DurableObjectState;
    const env = {
      DB: database,
      SSH_SESSION_REGISTRY: registry,
      SESSION_HMAC_KEY: "test-internal-secret"
    } as Env;

    new SSHSessionDO(state, env);
    await recovery;

    expect(statements.some(({ sql, values }) => sql.includes("UPDATE connection_sessions")
      && values.includes("worker_restart"))).toBe(true);
    expect(statements.some(({ sql, values }) => sql.includes("INSERT INTO session_events")
      && values.includes("error"))).toBe(true);
    expect(registryFetch).toHaveBeenCalledWith("https://ssh-registry.internal/release", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId })
    }));
    expect(socket.close).toHaveBeenCalledWith(1012, "Worker restarted; reconnect required");
  });
});
