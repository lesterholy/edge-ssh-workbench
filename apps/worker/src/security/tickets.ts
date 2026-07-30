import { decodeBase64Secret, decodeBase64Url, encodeBase64Url, randomBase64Url, toArrayBufferView } from "./encoding";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const SSH_TICKET_TTL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SshTicketClaims {
  version: 1;
  nonce: string;
  ownerId: string;
  sessionId: string;
  profileId: string;
  attemptId: string;
  origin: string;
  expiresAt: number;
}

export interface CreateSshTicketInput {
  ownerId: string;
  sessionId: string;
  profileId: string;
  attemptId: string;
  origin: string;
  now?: number;
}

async function hmacKey(secret: string | undefined, usage: KeyUsage[]): Promise<{ key: CryptoKey; bytes: Uint8Array }> {
  if (!secret) throw new Error("SESSION_HMAC_KEY is required");
  const bytes = decodeBase64Secret(secret, 32);
  const keyBytes = toArrayBufferView(bytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, usage);
  bytes.fill(0);
  return { key, bytes: keyBytes };
}

export async function createSshTicket(secret: string | undefined, input: CreateSshTicketInput): Promise<{ ticket: string; claims: SshTicketClaims }> {
  const now = input.now ?? Date.now();
  if (![input.sessionId, input.profileId, input.attemptId].every((value) => UUID_PATTERN.test(value))) {
    throw new Error("SSH ticket IDs must be UUIDs");
  }
  const claims: SshTicketClaims = {
    version: 1,
    nonce: randomBase64Url(24),
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    profileId: input.profileId,
    attemptId: input.attemptId,
    origin: new URL(input.origin).origin,
    expiresAt: now + SSH_TICKET_TTL_MS,
  };
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signedPayload = encoder.encode(`edgesh:ssh-ticket:v1:${payload}`);
  const imported = await hmacKey(secret, ["sign"]);
  try {
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", imported.key, signedPayload));
    return { ticket: `${payload}.${encodeBase64Url(signature)}`, claims };
  } finally {
    imported.bytes.fill(0);
  }
}

export async function verifySshTicket(
  secret: string | undefined,
  ticket: string,
  expected: Partial<Pick<SshTicketClaims, "ownerId" | "sessionId" | "profileId" | "attemptId" | "origin">> = {},
  now = Date.now(),
): Promise<SshTicketClaims | null> {
  const parts = ticket.split(".");
  if (parts.length !== 2 || (parts[0]?.length ?? 0) > 2048 || (parts[1]?.length ?? 0) > 128) return null;
  try {
    const imported = await hmacKey(secret, ["verify"]);
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify("HMAC", imported.key, toArrayBufferView(decodeBase64Url(parts[1] ?? "")), encoder.encode(`edgesh:ssh-ticket:v1:${parts[0] ?? ""}`));
    } finally {
      imported.bytes.fill(0);
    }
    if (!valid) return null;
    const claims = JSON.parse(decoder.decode(decodeBase64Url(parts[0] ?? ""))) as Partial<SshTicketClaims>;
    if (claims.version !== 1 || typeof claims.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(claims.nonce)
      || typeof claims.ownerId !== "string" || typeof claims.sessionId !== "string" || !UUID_PATTERN.test(claims.sessionId)
      || typeof claims.profileId !== "string" || !UUID_PATTERN.test(claims.profileId)
      || typeof claims.attemptId !== "string" || !UUID_PATTERN.test(claims.attemptId)
      || typeof claims.origin !== "string" || typeof claims.expiresAt !== "number"
      || claims.expiresAt < now || claims.expiresAt > now + SSH_TICKET_TTL_MS + 5000) return null;
    if (expected.ownerId !== undefined && claims.ownerId !== expected.ownerId) return null;
    if (expected.sessionId !== undefined && claims.sessionId !== expected.sessionId) return null;
    if (expected.profileId !== undefined && claims.profileId !== expected.profileId) return null;
    if (expected.attemptId !== undefined && claims.attemptId !== expected.attemptId) return null;
    if (expected.origin !== undefined && claims.origin !== new URL(expected.origin).origin) return null;
    return claims as SshTicketClaims;
  } catch {
    return null;
  }
}
