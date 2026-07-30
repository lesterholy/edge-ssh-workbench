import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TAILNET_CONNECTOR_HEADERS,
  TAILNET_CONNECTOR_PROTOCOL_VERSION,
  canonicalizeTailnetConnectorHandshake,
  type TailnetConnectorHandshake,
} from "@edgesh/contracts";
import { authenticateUpgrade, NonceReplayCache } from "../src/auth";

const key = Buffer.alloc(32);
const now = 1_785_283_200_000;
const handshake: TailnetConnectorHandshake = {
  version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
  sessionId: "cc6f137f-5da4-44cf-a5a4-8e017ecb7a77",
  host: "node.example-tailnet.ts.net",
  port: 22,
  expiresAt: now + 30_000,
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("Tailnet Connector authentication", () => {
  it("matches the fixed HMAC test vector", () => {
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(handshake))
      .digest("base64url");
    expect(signature).toBe("CmH4PhxGT8OhnEBzODLYRjD-aVjwVDpO0APF1UL_5qY");
    expect(authenticateUpgrade(headers(signature), key, 30_000, new NonceReplayCache(), now)).toEqual(handshake);
  });

  it("rejects expired, invalid, and replayed authentication", () => {
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(handshake))
      .digest("base64url");
    const cache = new NonceReplayCache();
    expect(() => authenticateUpgrade(headers(signature), key, 30_000, cache, now + 30_001)).toThrow(/expired/);
    expect(() => authenticateUpgrade(headers("A".repeat(43)), key, 30_000, cache, now)).toThrow(/signature/);
    expect(authenticateUpgrade(headers(signature), key, 30_000, cache, now)).toEqual(handshake);
    expect(() => authenticateUpgrade(headers(signature), key, 30_000, cache, now)).toThrow(/replayed/);
  });

  it("allows bounded positive clock skew but rejects distant future expiries", () => {
    const clockSkewed = { ...handshake, expiresAt: now + 35_000 };
    const signature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(clockSkewed))
      .digest("base64url");
    expect(authenticateUpgrade(headers(signature, clockSkewed), key, 30_000, new NonceReplayCache(), now)).toEqual(clockSkewed);

    const tooFar = { ...clockSkewed, expiresAt: now + 35_001, nonce: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
    const distantSignature = createHmac("sha256", key)
      .update(canonicalizeTailnetConnectorHandshake(tooFar))
      .digest("base64url");
    expect(() => authenticateUpgrade(headers(distantSignature, tooFar), key, 30_000, new NonceReplayCache(), now)).toThrow(/expired/);
  });
});

function headers(signature: string, values = handshake): Record<string, string> {
  return {
    [TAILNET_CONNECTOR_HEADERS.version.toLowerCase()]: String(values.version),
    [TAILNET_CONNECTOR_HEADERS.sessionId.toLowerCase()]: values.sessionId,
    [TAILNET_CONNECTOR_HEADERS.host.toLowerCase()]: values.host,
    [TAILNET_CONNECTOR_HEADERS.port.toLowerCase()]: String(values.port),
    [TAILNET_CONNECTOR_HEADERS.expiresAt.toLowerCase()]: String(values.expiresAt),
    [TAILNET_CONNECTOR_HEADERS.nonce.toLowerCase()]: values.nonce,
    [TAILNET_CONNECTOR_HEADERS.signature.toLowerCase()]: signature,
  };
}
