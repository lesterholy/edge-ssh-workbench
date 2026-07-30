import { decodeBase64Url, encodeBase64Url } from "../security/encoding";

export interface TimeCursor {
  createdAt: string;
  id: string;
}

export function encodeTimeCursor(cursor: TimeCursor): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify([cursor.createdAt, cursor.id])));
}

export function decodeTimeCursor(value: string | undefined): TimeCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value))) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
      throw new Error();
    }
    if (!Number.isFinite(Date.parse(decoded[0])) || !/^[0-9a-f-]{36}$/i.test(decoded[1])) throw new Error();
    return { createdAt: decoded[0], id: decoded[1] };
  } catch {
    throw new Error("Invalid pagination cursor");
  }
}
