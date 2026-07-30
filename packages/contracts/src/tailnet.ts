import { z } from "zod";

export const TAILNET_CONNECTOR_PROTOCOL_VERSION = 1 as const;

export const TAILNET_CONNECTOR_HEADERS = {
  version: "X-EdgeSSH-Version",
  sessionId: "X-EdgeSSH-Session",
  host: "X-EdgeSSH-Target-Host",
  port: "X-EdgeSSH-Target-Port",
  expiresAt: "X-EdgeSSH-Expires-At",
  nonce: "X-EdgeSSH-Nonce",
  signature: "X-EdgeSSH-Signature",
} as const;

export const TailnetConnectorHandshakeSchema = z
  .object({
    version: z.literal(TAILNET_CONNECTOR_PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    expiresAt: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  })
  .strict();

export type TailnetConnectorHandshake = z.infer<typeof TailnetConnectorHandshakeSchema>;

/** Keep this representation stable: both sides sign the UTF-8 bytes verbatim. */
export function canonicalizeTailnetConnectorHandshake(handshake: TailnetConnectorHandshake): string {
  return JSON.stringify([
    handshake.version,
    handshake.sessionId,
    handshake.host,
    handshake.port,
    handshake.expiresAt,
    handshake.nonce,
  ]);
}
