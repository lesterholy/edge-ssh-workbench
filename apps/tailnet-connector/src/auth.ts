import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  TAILNET_CONNECTOR_HEADERS,
  TailnetConnectorHandshakeSchema,
  canonicalizeTailnetConnectorHandshake,
  type TailnetConnectorHandshake,
} from "@edgesh/contracts";

const MAX_CLOCK_SKEW_MS = 5_000;

export class NonceReplayCache {
  private readonly entries = new Map<string, number>();

  consume(nonce: string, expiresAt: number, now: number): boolean {
    for (const [storedNonce, storedExpiry] of this.entries) {
      if (storedExpiry < now) this.entries.delete(storedNonce);
    }
    if (this.entries.has(nonce)) return false;
    this.entries.set(nonce, expiresAt);
    return true;
  }
}

export function authenticateUpgrade(
  headers: IncomingHttpHeaders,
  key: Buffer,
  authWindowMs: number,
  replayCache: NonceReplayCache,
  now = Date.now(),
): TailnetConnectorHandshake {
  const signature = requiredHeader(headers, TAILNET_CONNECTOR_HEADERS.signature);
  const handshakeResult = TailnetConnectorHandshakeSchema.safeParse({
    version: parseIntegerHeader(headers, TAILNET_CONNECTOR_HEADERS.version),
    sessionId: requiredHeader(headers, TAILNET_CONNECTOR_HEADERS.sessionId),
    host: requiredHeader(headers, TAILNET_CONNECTOR_HEADERS.host),
    port: parseIntegerHeader(headers, TAILNET_CONNECTOR_HEADERS.port),
    expiresAt: parseIntegerHeader(headers, TAILNET_CONNECTOR_HEADERS.expiresAt),
    nonce: requiredHeader(headers, TAILNET_CONNECTOR_HEADERS.nonce),
  });
  if (!handshakeResult.success) throw new Error("Invalid connector authentication headers");
  const handshake = handshakeResult.data;
  if (handshake.expiresAt < now || handshake.expiresAt > now + authWindowMs + MAX_CLOCK_SKEW_MS) {
    throw new Error("Connector authentication has expired");
  }

  const supplied = decodeSignature(signature);
  const expected = createHmac("sha256", key)
    .update(canonicalizeTailnetConnectorHandshake(handshake), "utf8")
    .digest();
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid connector signature");
  }
  if (!replayCache.consume(handshake.nonce, handshake.expiresAt, now)) {
    throw new Error("Connector authentication was replayed");
  }
  return handshake;
}

function requiredHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}

function parseIntegerHeader(headers: IncomingHttpHeaders, name: string): number | null {
  const value = requiredHeader(headers, name);
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return Buffer.alloc(0);
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : Buffer.alloc(0);
}
