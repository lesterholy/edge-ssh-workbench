import { decodeBase64Secret, encodeBase64Url, randomBase64Url, toArrayBufferView } from "../security/encoding";

export const SESSION_COOKIE_NAME = "__Host-edgesh_session";
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function createSessionToken(): string {
  return randomBase64Url(32);
}

export async function hashSessionToken(token: string, hmacSecret: string | undefined): Promise<string> {
  if (!hmacSecret) throw new Error("SESSION_HMAC_KEY is required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid session token");
  const secret = decodeBase64Secret(hmacSecret, 32);
  const data = new TextEncoder().encode(`edgesh:session:v1:${token}`);
  const keyBytes = toArrayBufferView(secret);
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
  } finally {
    secret.fill(0);
    keyBytes.fill(0);
    data.fill(0);
  }
}

export async function hashSessionMetadata(
  value: string,
  purpose: "source-ip" | "user-agent" | "oidc-state" | "oidc-browser",
  hmacSecret: string | undefined,
): Promise<string> {
  if (!hmacSecret) throw new Error("SESSION_HMAC_KEY is required");
  const secret = decodeBase64Secret(hmacSecret, 32);
  const data = new TextEncoder().encode(`edgesh:${purpose}:v1:${value}`);
  const keyBytes = toArrayBufferView(secret);
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
  } finally {
    secret.fill(0);
    keyBytes.fill(0);
    data.fill(0);
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function readSessionToken(request: Request): string | null {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function sessionCookie(token: string, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid session token");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 24 * 60 * 60) {
    throw new Error("Invalid session TTL");
  }
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
