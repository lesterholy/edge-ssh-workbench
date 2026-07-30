const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64url value");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error("Non-canonical base64url value");
  return bytes;
}

export function decodeBase64Secret(value: string, expectedBytes?: number): Uint8Array {
  const trimmed = value.trim();
  let bytes: Uint8Array;
  if (BASE64URL_PATTERN.test(trimmed) && !trimmed.includes("=")) {
    bytes = decodeBase64Url(trimmed);
  } else {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
      throw new Error("Secret must be canonical base64 or base64url");
    }
    let binary: string;
    try {
      binary = atob(trimmed);
    } catch {
      throw new Error("Secret must be canonical base64 or base64url");
    }
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    let canonical = "";
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    if (btoa(canonical) !== trimmed) throw new Error("Secret must be canonical base64");
  }
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new Error(`Secret must decode to exactly ${expectedBytes} bytes`);
  }
  return bytes;
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
