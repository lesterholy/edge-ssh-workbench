import { constantTimeEqual, toArrayBufferView } from "../security/encoding";

// Base32/TOTP flow adapted from tafeng/worker/totp.ts (MIT) and verified against RFC vectors.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(secret: string): Uint8Array {
  const clean = secret.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  if (!clean) throw new Error("Invalid base32 secret");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = value << 5 | index;
    bits += 5;
    if (bits >= 8) {
      output.push(value >>> (bits - 8) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (value & (1 << bits) - 1) !== 0) throw new Error("Non-canonical base32 secret");
  return Uint8Array.from(output);
}

export function generateTotpSecret(byteLength = 20): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) throw new Error("Invalid TOTP secret length");
  return base32Encode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createOtpAuthUrl(secret: string, issuer = "Edge SSH Workbench", account = "admin"): string {
  base32Decode(secret);
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secret.replace(/\s+/g, "").toUpperCase(), issuer, algorithm: "SHA1", digits: "6", period: "30",
  });
  return `otpauth://totp/${label}?${params}`;
}

export async function generateHotpCode(secret: string, counter: number, digits = DEFAULT_DIGITS): Promise<string> {
  if (!Number.isSafeInteger(counter) || counter < 0 || digits < 6 || digits > 8) throw new Error("Invalid HOTP parameters");
  const secretBytes = base32Decode(secret);
  const keyBytes = toArrayBufferView(secretBytes);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000), false);
  view.setUint32(4, counter >>> 0, false);
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
    const offset = (signature[signature.length - 1] ?? 0) & 0x0f;
    const binary = ((signature[offset] ?? 0) & 0x7f) << 24
      | ((signature[offset + 1] ?? 0) & 0xff) << 16
      | ((signature[offset + 2] ?? 0) & 0xff) << 8
      | (signature[offset + 3] ?? 0) & 0xff;
    return String(binary % 10 ** digits).padStart(digits, "0");
  } finally {
    secretBytes.fill(0);
    keyBytes.fill(0);
  }
}

export async function generateTotpCode(
  secret: string,
  timestampMs = Date.now(),
  periodSeconds = DEFAULT_PERIOD,
): Promise<string> {
  return generateHotpCode(secret, Math.floor(timestampMs / 1000 / periodSeconds));
}

export async function verifyTotp(
  code: string | undefined,
  secret: string | null | undefined,
  options: { timestampMs?: number; window?: number; periodSeconds?: number } = {},
): Promise<boolean> {
  if (!code || !secret || !/^\d{6}$/.test(code)) return false;
  const timestampMs = options.timestampMs ?? Date.now();
  const window = options.window ?? 1;
  const period = options.periodSeconds ?? DEFAULT_PERIOD;
  if (!Number.isSafeInteger(window) || window < 0 || window > 5) return false;
  const provided = new TextEncoder().encode(code);
  const counter = Math.floor(timestampMs / 1000 / period);
  for (let offset = -window; offset <= window; offset += 1) {
    if (counter + offset < 0) continue;
    const expected = new TextEncoder().encode(await generateHotpCode(secret, counter + offset));
    if (constantTimeEqual(provided, expected)) return true;
  }
  return false;
}
