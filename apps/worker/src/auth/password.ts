import { constantTimeEqual, decodeBase64Secret, encodeBase64Url, toArrayBufferView } from "../security/encoding";

const HASH_NAME = "pbkdf2-sha256";
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export interface ParsedPasswordHash {
  iterations: number;
  salt: Uint8Array;
  digest: Uint8Array;
}

export function parsePasswordHash(encoded: string): ParsedPasswordHash {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_NAME || !/^\d+$/.test(parts[1] ?? "")) {
    throw new Error("Invalid ADMIN_PASSWORD_HASH format");
  }
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error("Invalid PBKDF2 iteration count");
  }
  const salt = decodeBase64Secret(parts[2] ?? "");
  const digest = decodeBase64Secret(parts[3] ?? "");
  if (salt.byteLength < 16 || digest.byteLength !== 32) throw new Error("Invalid PBKDF2 hash parameters");
  return { iterations, salt, digest };
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = new TextEncoder().encode(password);
  const keyBytes = toArrayBufferView(material);
  const saltBytes = toArrayBufferView(salt);
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
      key,
      256,
    ));
  } finally {
    material.fill(0);
    keyBytes.fill(0);
    saltBytes.fill(0);
  }
}

export async function verifyPassword(password: string, encodedHash: string | undefined): Promise<boolean> {
  if (!encodedHash || typeof password !== "string" || password.length > 4096) return false;
  let parsed: ParsedPasswordHash;
  try {
    parsed = parsePasswordHash(encodedHash);
  } catch {
    return false;
  }
  const actual = await derive(password, parsed.salt, parsed.iterations);
  try {
    return constantTimeEqual(actual, parsed.digest);
  } finally {
    actual.fill(0);
    parsed.digest.fill(0);
    parsed.salt.fill(0);
  }
}

export async function hashPassword(password: string, iterations = 600_000): Promise<string> {
  if (password.length < 12 || password.length > 4096) throw new Error("Password length is invalid");
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error("Invalid PBKDF2 iteration count");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(password, salt, iterations);
  try {
    return `${HASH_NAME}$${iterations}$${encodeBase64Url(salt)}$${encodeBase64Url(digest)}`;
  } finally {
    salt.fill(0);
    digest.fill(0);
  }
}
