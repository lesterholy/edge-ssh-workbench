import { describe, expect, it, vi } from "vitest";

import { WS_PROTOCOL_VERSION, type ClientWebSocketMessage } from "@edgesh/contracts";

import type { Env } from "../env";
import { D1SSHProfileRepository, SSHSessionDO } from "./ssh-session";

const connectorHmacKey = Buffer.alloc(32, 7).toString("base64url");

function tailscaleProfileDatabase(port = 22): D1Database {
  const profile = {
    id: "33333333-3333-4333-8333-333333333333",
    owner_id: "11111111-1111-4111-8111-111111111111",
    name: "Tailnet VPS",
    host: "vps-01.example-tailnet.ts.net",
    port,
    username: "deploy",
    auth_kind: "password",
    tailscale_ssh: 1,
    credential_persistence: "saved",
    collect_history: 1,
    password_ciphertext: null,
    password_iv: null,
    password_version: null,
    private_key_ciphertext: null,
    private_key_iv: null,
    private_key_version: null,
    passphrase_ciphertext: null,
    passphrase_iv: null,
    passphrase_version: null,
  };
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => sql.includes("FROM profiles") ? profile : { collect_commands: 1 },
      }),
    }),
  } as unknown as D1Database;
}

describe("D1 SSH profile resolution", () => {
  it("resolves Tailscale SSH without credential material", async () => {
    const repository = new D1SSHProfileRepository({
      DB: tailscaleProfileDatabase(),
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "https://connector.example.test/v1/connect",
      TAILNET_CONNECTOR_HMAC_KEY: connectorHmacKey,
    } as Env);

    await expect(repository.resolve(
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    )).resolves.toMatchObject({ authentication: { kind: "tailscale-ssh" }, port: 22 });
    await expect(repository.resolve(
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      { method: "password", password: "must-not-be-used" },
    )).rejects.toThrow("do not accept SSH credentials");
  });

  it("rejects Tailscale SSH outside its transport and port boundary", async () => {
    const direct = new D1SSHProfileRepository({
      DB: tailscaleProfileDatabase(),
      SSH_TRANSPORT: "direct",
    } as Env);
    await expect(direct.resolve(
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    )).rejects.toThrow("tailnet_connector");

    const wrongPort = new D1SSHProfileRepository({
      DB: tailscaleProfileDatabase(7022),
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "https://connector.example.test/v1/connect",
      TAILNET_CONNECTOR_HMAC_KEY: connectorHmacKey,
    } as Env);
    await expect(wrongPort.resolve(
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    )).rejects.toThrow("port 22");
  });
});

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

describe("SSHSessionDO message ordering", () => {
  it("finishes connect handling before processing a following resize", async () => {
    const state = {
      getWebSockets: () => [],
      blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(),
    } as unknown as DurableObjectState;
    const session = new SSHSessionDO(state, {} as Env);
    const socket = {} as WebSocket;
    const events: string[] = [];
    let finishConnect!: () => void;
    const connectPending = new Promise<void>((resolve) => { finishConnect = resolve; });
    const internals = session as unknown as {
      handleClientMessage(socket: WebSocket, message: ClientWebSocketMessage): Promise<void>;
    };
    internals.handleClientMessage = vi.fn(async (_socket, message) => {
      events.push(`${message.type}:start`);
      if (message.type === "connect") await connectPending;
      events.push(`${message.type}:end`);
    });
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const connect = JSON.stringify({
      protocolVersion: WS_PROTOCOL_VERSION,
      requestId: "22222222-2222-4222-8222-222222222222",
      type: "connect",
      attemptId,
      terminal: { columns: 120, rows: 40, type: "xterm-256color", encoding: "utf-8" },
    });
    const resize = JSON.stringify({
      protocolVersion: WS_PROTOCOL_VERSION,
      requestId: "33333333-3333-4333-8333-333333333333",
      type: "resize",
      attemptId,
      columns: 121,
      rows: 41,
    });

    const connectOperation = session.webSocketMessage(socket, connect);
    const resizeOperation = session.webSocketMessage(socket, resize);
    await Promise.resolve();
    expect(events).toEqual(["connect:start"]);

    finishConnect();
    await Promise.all([connectOperation, resizeOperation]);
    expect(events).toEqual(["connect:start", "connect:end", "resize:start", "resize:end"]);
  });
});
