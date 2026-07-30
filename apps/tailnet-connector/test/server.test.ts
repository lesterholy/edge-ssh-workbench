import { createHmac } from "node:crypto";
import { createServer as createTcpServer, createConnection, Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  TAILNET_CONNECTOR_HEADERS,
  TAILNET_CONNECTOR_PROTOCOL_VERSION,
  canonicalizeTailnetConnectorHandshake,
  type TailnetConnectorHandshake,
} from "@edgesh/contracts";
import type { ConnectorConfig } from "../src/config";
import { createConnectorServer, type ConnectorServer } from "../src/server";

const key = Buffer.alloc(32, 9);
const now = 1_785_283_200_000;
const connectors: ConnectorServer[] = [];

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.close()));
});

describe("Tailnet Connector server", () => {
  it("rejects unauthenticated upgrades", async () => {
    const connector = await startConnector();
    const port = (connector.server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`);
      webSocket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      webSocket.once("error", reject);
    });
    expect(status).toBe(401);
  });

  it("relays binary WebSocket frames to the verified TCP connection", async () => {
    const echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as AddressInfo).port;
    const connector = await startConnector({
      connectTcp: async () => new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: echoPort });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      }),
    });
    const port = (connector.server.address() as AddressInfo).port;
    const handshake: TailnetConnectorHandshake = {
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId: "cc6f137f-5da4-44cf-a5a4-8e017ecb7a77",
      host: "node.example-tailnet.ts.net",
      port: 22,
      expiresAt: now + 30_000,
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(handshake))
      .digest("base64url");
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`, {
      headers: connectorHeaders(handshake, signature),
    });
    await new Promise<void>((resolve, reject) => {
      webSocket.once("open", resolve);
      webSocket.once("error", reject);
    });
    const received = new Promise<Buffer>((resolve) => webSocket.once("message", (data) => resolve(Buffer.from(data as Buffer))));
    webSocket.send(Buffer.from("ssh-test"));
    await expect(received).resolves.toEqual(Buffer.from("ssh-test"));
    webSocket.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it("releases a pending reservation when the Upgrade client disconnects", async () => {
    const connector = await startConnector({
      connectTcp: async () => new Promise<never>(() => undefined),
    });
    const port = (connector.server.address() as AddressInfo).port;
    const handshake: TailnetConnectorHandshake = {
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId: "cc6f137f-5da4-44cf-a5a4-8e017ecb7a77",
      host: "node.example-tailnet.ts.net",
      port: 22,
      expiresAt: now + 30_000,
      nonce: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    };
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(handshake))
      .digest("base64url");
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`, {
      headers: connectorHeaders(handshake, signature),
    });
    webSocket.on("error", () => undefined);
    await waitFor(() => connector.activeConnections() === 1);
    webSocket.terminate();
    await waitFor(() => connector.activeConnections() === 0);
  });

  it("cleans up a target socket after a malformed authenticated Upgrade", async () => {
    const targetSocket = new Socket();
    const connector = await startConnector({ connectTcp: async () => targetSocket });
    const port = (connector.server.address() as AddressInfo).port;
    const handshake: TailnetConnectorHandshake = {
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId: "cc6f137f-5da4-44cf-a5a4-8e017ecb7a77",
      host: "node.example-tailnet.ts.net",
      port: 22,
      expiresAt: now + 30_000,
      nonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    };
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(handshake))
      .digest("base64url");
    const rawClient = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      rawClient.once("connect", resolve);
      rawClient.once("error", reject);
    });
    const response = new Promise<string>((resolve) => rawClient.once("data", (chunk) => resolve(chunk.toString("utf8"))));
    const authHeaders = connectorHeaders(handshake, signature);
    rawClient.write([
      "GET /v1/connect HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      ...Object.entries(authHeaders).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"));
    await expect(response).resolves.toMatch(/^HTTP\/1\.1 400 /);
    await waitFor(() => connector.activeConnections() === 0 && targetSocket.destroyed);
    rawClient.destroy();
  });
});

async function startConnector(overrides: Parameters<typeof createConnectorServer>[1] = {}): Promise<ConnectorServer> {
  const config: ConnectorConfig = {
    listenHost: "127.0.0.1",
    port: 0,
    hmacKey: key,
    allowedSuffix: "example-tailnet.ts.net",
    allowedPorts: new Set([22]),
    connectTimeoutMs: 1000,
    authWindowMs: 30_000,
    maxConnections: 2,
    idleTimeoutMs: 10_000,
    maxSessionMs: 60_000,
    maxBufferedBytes: 65_536,
  };
  const connector = createConnectorServer(config, {
    now: () => now,
    lookupAll: async () => [{ address: "100.64.0.2", family: 4 }],
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  connectors.push(connector);
  await connector.listen();
  return connector;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Connector state");
}

function connectorHeaders(handshake: TailnetConnectorHandshake, signature: string): Record<string, string> {
  return {
    [TAILNET_CONNECTOR_HEADERS.version]: String(handshake.version),
    [TAILNET_CONNECTOR_HEADERS.sessionId]: handshake.sessionId,
    [TAILNET_CONNECTOR_HEADERS.host]: handshake.host,
    [TAILNET_CONNECTOR_HEADERS.port]: String(handshake.port),
    [TAILNET_CONNECTOR_HEADERS.expiresAt]: String(handshake.expiresAt),
    [TAILNET_CONNECTOR_HEADERS.nonce]: handshake.nonce,
    [TAILNET_CONNECTOR_HEADERS.signature]: signature,
  };
}
