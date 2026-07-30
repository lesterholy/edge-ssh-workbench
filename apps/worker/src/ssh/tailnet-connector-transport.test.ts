import {
  TAILNET_CONNECTOR_HEADERS,
  TAILNET_CONNECTOR_PROTOCOL_VERSION,
  canonicalizeTailnetConnectorHandshake
} from "@edgesh/contracts";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { decodeBase64Secret, encodeBase64Url, toArrayBufferView } from "../security/encoding";
import {
  TailnetConnectorTransportFactory,
  TailnetConnectorWebSocketDuplex,
  connectorFetchUrl
} from "./tailnet-connector-transport";

const sessionId = "11111111-1111-4111-8111-111111111111";
const hmacKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class FakeConnectorSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: "blob" | "arraybuffer" = "arraybuffer";
  readonly sent: Uint8Array[] = [];
  acceptCalls = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  accept(): void {
    this.acceptCalls += 1;
    this.readyState = 1;
  }

  send(value: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof value === "string") throw new Error("expected binary frame");
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.sent.push(Uint8Array.from(bytes));
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchClose(code ?? 1000, reason ?? "");
  }

  receive(bytes: Uint8Array): void {
    const event = new Event("message") as MessageEvent;
    Object.defineProperty(event, "data", { value: Uint8Array.from(bytes).buffer });
    this.dispatchEvent(event);
  }

  receiveText(value: string): void {
    const event = new Event("message") as MessageEvent;
    Object.defineProperty(event, "data", { value });
    this.dispatchEvent(event);
  }

  dispatchClose(code: number, reason: string): void {
    const event = new Event("close") as CloseEvent;
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: code === 1000 }
    });
    this.dispatchEvent(event);
  }
}

function upgraded(socket: FakeConnectorSocket): Response {
  return { status: 101, webSocket: socket as unknown as WebSocket } as Response;
}

async function expectedSignature(canonical: string): Promise<string> {
  const bytes = decodeBase64Secret(hmacKey, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBufferView(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  bytes.fill(0);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))));
}

describe("Tailnet Connector SSH transport", () => {
  it("opens an authenticated WSS tunnel with optional Cloudflare Access headers", async () => {
    const socket = new FakeConnectorSocket();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => upgraded(socket));
    const now = 1_785_283_200_000;
    const factory = new TailnetConnectorTransportFactory({
      url: "wss://connector.example.test/v1/connect",
      hmacKey,
      sessionId,
      allowedPorts: new Set([22]),
      accessClientId: "client-id.access",
      accessClientSecret: "access-secret",
      fetcher: fetcher as unknown as typeof fetch,
      now: () => now,
      nonce: () => nonce
    });

    const transport = await factory.connect("100.64.0.10", 22, 1_000);
    expect(transport).toBeInstanceOf(TailnetConnectorWebSocketDuplex);
    expect(socket.acceptCalls).toBe(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://connector.example.test/v1/connect");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    const handshake = {
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId,
      host: "100.64.0.10",
      port: 22,
      expiresAt: now + 30_000,
      nonce
    };
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.version)).toBe("1");
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.sessionId)).toBe(sessionId);
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.host)).toBe("100.64.0.10");
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.port)).toBe("22");
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.expiresAt)).toBe(String(now + 30_000));
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.nonce)).toBe(nonce);
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.signature)).toBe(
      await expectedSignature(canonicalizeTailnetConnectorHandshake(handshake))
    );
    expect(headers.get("CF-Access-Client-Id")).toBe("client-id.access");
    expect(headers.get("CF-Access-Client-Secret")).toBe("access-secret");
    await transport.close();
  });

  it("bridges binary data in both directions and waits for outbound backpressure", async () => {
    const socket = new FakeConnectorSocket();
    socket.accept();
    const transport = new TailnetConnectorWebSocketDuplex(socket as unknown as WebSocket, 200);
    const received = new Promise<Buffer>((resolve) => transport.once("data", resolve));
    socket.receive(new Uint8Array([1, 2, 3]));
    expect([...await received]).toEqual([1, 2, 3]);

    socket.bufferedAmount = 4 * 1024 * 1024 + 1;
    let completed = false;
    const written = new Promise<void>((resolve, reject) => {
      transport.write(Buffer.from([4, 5, 6]), (error) => {
        completed = true;
        error ? reject(error) : resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(completed).toBe(false);
    socket.bufferedAmount = 0;
    await written;
    expect(socket.sent.map((bytes) => [...bytes])).toEqual([[4, 5, 6]]);
    await transport.close();
  });

  it("rejects text tunnel frames and enforces one total upgrade timeout", async () => {
    const socket = new FakeConnectorSocket();
    socket.accept();
    const transport = new TailnetConnectorWebSocketDuplex(socket as unknown as WebSocket, 100);
    const streamError = new Promise<Error>((resolve) => transport.once("error", resolve));
    socket.receiveText("not-binary");
    await expect(streamError).resolves.toMatchObject({ message: expect.stringContaining("non-binary") });

    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const factory = new TailnetConnectorTransportFactory({
      url: "https://connector.example.test/v1/connect",
      hmacKey,
      sessionId,
      allowedPorts: new Set([22]),
      fetcher: fetcher as unknown as typeof fetch,
      nonce: () => nonce
    });
    await expect(factory.connect("100.64.0.10", 22, 20)).rejects.toThrow("upgrade timed out");
  });

  it("fails a write when Connector backpressure does not drain before its deadline", async () => {
    const socket = new FakeConnectorSocket();
    socket.accept();
    socket.bufferedAmount = 4 * 1024 * 1024;
    const transport = new TailnetConnectorWebSocketDuplex(socket as unknown as WebSocket, 25);
    transport.on("error", () => undefined);
    const result = new Promise<Error | null>((resolve) => {
      transport.write(Buffer.from([1]), (error) => resolve(error ?? null));
    });
    await expect(result).resolves.toMatchObject({ message: expect.stringContaining("backpressure timed out") });
    expect(socket.sent).toEqual([]);
  });

  it("keeps the configured SSH port policy without applying public-target DNS checks", async () => {
    const fetcher = vi.fn(async () => ({ status: 500 } as Response));
    const factory = new TailnetConnectorTransportFactory({
      url: "wss://connector.example.test/v1/connect",
      hmacKey,
      sessionId,
      allowedPorts: new Set([22]),
      fetcher: fetcher as unknown as typeof fetch,
      nonce: () => nonce
    });
    await expect(factory.connect("100.64.0.10", 2222, 100)).rejects.toMatchObject({ code: "PROHIBITED_PORT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes only secure WebSocket Connector URLs", () => {
    expect(connectorFetchUrl("wss://connector.example.test/tunnel")).toBe("https://connector.example.test/tunnel");
    expect(() => connectorFetchUrl("http://connector.example.test/tunnel")).toThrow("secure");
    expect(() => connectorFetchUrl("wss://connector.example.test/tunnel?host=target")).toThrow("query");
  });

  it("normalizes the target host before signing it", async () => {
    const socket = new FakeConnectorSocket();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => upgraded(socket));
    const factory = new TailnetConnectorTransportFactory({
      url: "wss://connector.example.test/v1/connect",
      hmacKey,
      sessionId,
      allowedPorts: new Set([22]),
      fetcher: fetcher as unknown as typeof fetch,
      nonce: () => nonce,
    });
    const transport = await factory.connect("NODE.Example-Tailnet.TS.NET.", 22, 1_000);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get(TAILNET_CONNECTOR_HEADERS.host)).toBe("node.example-tailnet.ts.net");
    await transport.close();
  });
});
