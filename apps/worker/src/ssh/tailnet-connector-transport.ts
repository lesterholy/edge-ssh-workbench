import {
  TAILNET_CONNECTOR_HEADERS,
  TAILNET_CONNECTOR_PROTOCOL_VERSION,
  TailnetConnectorHandshakeSchema,
  canonicalizeTailnetConnectorHandshake,
  type TailnetConnectorHandshake
} from "@edgesh/contracts";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";

import { decodeBase64Secret, encodeBase64Url, randomBase64Url, toArrayBufferView } from "../security/encoding";
import { assertAllowedSshPort, normalizeHost } from "../security/network";
import type { SSHTransport, SSHTransportFactory } from "./types";

const CONNECTOR_HANDSHAKE_TTL_MS = 30_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
const MAX_INBOUND_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_IO_TIMEOUT_MS = 10_000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface TailnetConnectorTransportOptions {
  url: string;
  hmacKey: string;
  sessionId: string;
  allowedPorts: ReadonlySet<number> | null;
  accessClientId?: string;
  accessClientSecret?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

export class TailnetConnectorWebSocketDuplex extends Duplex implements SSHTransport {
  private closing: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private socketClosed = false;
  private readableFinished = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS
  ) {
    super();
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onError);
  }

  override _read(): void {
    // WebSocket delivery drives the readable side.
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : new Uint8Array(chunk);
    this.send(bytes).then(() => callback(), (error: unknown) => callback(asError(error)));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.close().then(() => callback(), (error: unknown) => callback(asError(error)));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.close().then(() => callback(error), (closeError: unknown) => callback(asError(closeError)));
  }

  close(): Promise<void> {
    if (this.socketClosed || this.socket.readyState === WS_CLOSED) {
      this.finishReadable();
      return Promise.resolve();
    }
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
      const timeout = setTimeout(() => {
        this.socketClosed = true;
        this.finishReadable();
        this.resolveClose?.();
        this.resolveClose = null;
      }, this.ioTimeoutMs);
      const finish = this.resolveClose;
      this.resolveClose = () => {
        clearTimeout(timeout);
        finish();
      };
      try {
        if (this.socket.readyState === WS_OPEN || this.socket.readyState === WS_CONNECTING) {
          this.socket.close(1000, "SSH transport closed");
        } else if (this.socket.readyState !== WS_CLOSING) {
          this.resolveClose();
        }
      } catch {
        this.resolveClose();
      }
    });
    return this.closing;
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.socketClosed) return;
    if (!(event.data instanceof ArrayBuffer)) {
      this.destroy(new Error("Tailnet Connector sent a non-binary tunnel frame"));
      return;
    }
    if (event.data.byteLength > MAX_INBOUND_FRAME_BYTES
      || this.readableLength + event.data.byteLength > MAX_INBOUND_BUFFER_BYTES) {
      this.destroy(new Error("Tailnet Connector exceeded the inbound buffer limit"));
      return;
    }
    this.push(Buffer.from(event.data));
  };

  private readonly onClose = (event: CloseEvent): void => {
    this.socketClosed = true;
    this.finishReadable();
    this.resolveClose?.();
    this.resolveClose = null;
    if (event.code !== 1000 && event.code !== 1001 && !this.destroyed) {
      this.destroy(new Error("Tailnet Connector WebSocket closed unexpectedly"));
    }
  };

  private readonly onError = (): void => {
    if (!this.destroyed) this.destroy(new Error("Tailnet Connector WebSocket failed"));
  };

  private async send(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > MAX_BUFFERED_BYTES) {
      throw new Error("Tailnet Connector outbound frame exceeds the buffer limit");
    }
    const deadline = Date.now() + this.ioTimeoutMs;
    while (this.socket.readyState === WS_CONNECTING
      || this.socket.bufferedAmount + bytes.byteLength > MAX_BUFFERED_BYTES) {
      if (this.socketClosed || this.socket.readyState === WS_CLOSING || this.socket.readyState === WS_CLOSED) {
        throw new Error("Tailnet Connector WebSocket is closed");
      }
      if (Date.now() >= deadline) throw new Error("Tailnet Connector WebSocket backpressure timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.socketClosed || this.socket.readyState !== WS_OPEN) {
      throw new Error("Tailnet Connector WebSocket is closed");
    }
    this.socket.send(toArrayBufferView(bytes));
  }

  private finishReadable(): void {
    if (this.readableFinished) return;
    this.readableFinished = true;
    this.push(null);
  }
}

export class TailnetConnectorTransportFactory implements SSHTransportFactory {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(private readonly options: TailnetConnectorTransportOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBase64Url(24));
    if (Boolean(options.accessClientId) !== Boolean(options.accessClientSecret)) {
      throw new Error("Tailnet Connector Access service token ID and secret must be configured together");
    }
  }

  async connect(host: string, port: number, timeoutMs: number): Promise<SSHTransport> {
    assertAllowedSshPort(port, this.options.allowedPorts);
    const normalizedHost = normalizeHost(host);
    const issuedAt = this.now();
    const handshake = TailnetConnectorHandshakeSchema.parse({
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId: this.options.sessionId,
      host: normalizedHost,
      port,
      expiresAt: issuedAt + CONNECTOR_HANDSHAKE_TTL_MS,
      nonce: this.nonce()
    }) satisfies TailnetConnectorHandshake;
    const signature = await signHandshake(this.options.hmacKey, handshake);
    const headers = new Headers({
      Upgrade: "websocket",
      [TAILNET_CONNECTOR_HEADERS.version]: String(handshake.version),
      [TAILNET_CONNECTOR_HEADERS.sessionId]: handshake.sessionId,
      [TAILNET_CONNECTOR_HEADERS.host]: handshake.host,
      [TAILNET_CONNECTOR_HEADERS.port]: String(handshake.port),
      [TAILNET_CONNECTOR_HEADERS.expiresAt]: String(handshake.expiresAt),
      [TAILNET_CONNECTOR_HEADERS.nonce]: handshake.nonce,
      [TAILNET_CONNECTOR_HEADERS.signature]: signature
    });
    if (this.options.accessClientId && this.options.accessClientSecret) {
      headers.set("CF-Access-Client-Id", this.options.accessClientId);
      headers.set("CF-Access-Client-Secret", this.options.accessClientSecret);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Tailnet Connector WebSocket upgrade timed out")), timeoutMs);
    try {
      const response = await this.fetcher(connectorFetchUrl(this.options.url), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`Tailnet Connector WebSocket upgrade failed with status ${response.status}`);
      }
      const transport = new TailnetConnectorWebSocketDuplex(response.webSocket, Math.max(1_000, timeoutMs));
      try {
        response.webSocket.binaryType = "arraybuffer";
        response.webSocket.accept({ allowHalfOpen: true });
      } catch (error) {
        await transport.close();
        throw asError(error);
      }
      return transport;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Tailnet Connector WebSocket upgrade timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function connectorFetchUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Tailnet Connector URL must be secure and must not contain credentials, query, or fragment");
  }
  return url.toString();
}

async function signHandshake(secret: string, handshake: TailnetConnectorHandshake): Promise<string> {
  const bytes = decodeBase64Secret(secret, 32);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBufferView(bytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalizeTailnetConnectorHandshake(handshake))
    );
    return encodeBase64Url(new Uint8Array(signature));
  } finally {
    bytes.fill(0);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
