// Public-target validation is adapted from CF-Workers-WebSSH/src/backend/security.ts (Apache-2.0),
// with stricter IPv6 parsing, port policy, and injectable DNS transport for tests.
export const PROHIBITED_SSH_PORTS = new Set([25]);

export class TargetValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TargetValidationError";
    this.code = code;
  }
}

function parseIpv4(value: string): Uint8Array | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return Uint8Array.from(octets);
}

function parseIpv6(value: string): Uint8Array | null {
  let input = value.toLowerCase();
  if (input.startsWith("[") && input.endsWith("]")) input = input.slice(1, -1);
  if (!input || input.includes("%") || !/^[0-9a-f:.]+$/.test(input)) return null;

  let ipv4Tail: Uint8Array | null = null;
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return null;
    ipv4Tail = parseIpv4(input.slice(lastColon + 1));
    if (!ipv4Tail) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4Tail[0] ?? 0) << 8 | (ipv4Tail[1] ?? 0)).toString(16)}:${((ipv4Tail[2] ?? 0) << 8 | (ipv4Tail[3] ?? 0)).toString(16)}`;
  }

  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftText, rightText] = input.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const hasCompression = input.includes("::");
  const missing = 8 - left.length - right.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8) return null;
  const result = new Uint8Array(16);
  groups.forEach((group, index) => {
    result[index * 2] = group >>> 8;
    result[index * 2 + 1] = group & 0xff;
  });
  return result;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], prefixBits: number): boolean {
  const fullBytes = Math.floor(prefixBits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remaining = prefixBits % 8;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function isReservedIpv4(bytes: Uint8Array): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function embeddedIpv4(bytes: Uint8Array, offset: number): Uint8Array {
  return bytes.slice(offset, offset + 4);
}

function isReservedIpv6(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if (hasPrefix(bytes, [0xfc], 7) || hasPrefix(bytes, [0xfe, 0x80], 10) || hasPrefix(bytes, [0xff], 8)) return true;
  if (hasPrefix(bytes, [0x01, 0x00], 64)) return true; // discard-only 100::/64
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // documentation
  if (hasPrefix(bytes, [0x3f, 0xff], 20) || hasPrefix(bytes, [0x5f, 0x00], 16)) return true;
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return isReservedIpv4(embeddedIpv4(bytes, 12));
  }
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return isReservedIpv4(embeddedIpv4(bytes, 12));
  }
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return isReservedIpv4(embeddedIpv4(bytes, 2));
  return false;
}

export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (!value || value.length > 253 || /[\s/@\\?#]/.test(value)) {
    throw new TargetValidationError("INVALID_HOST", "SSH target host is invalid");
  }
  if (parseIpv4(value) || parseIpv6(value)) return value;
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")) {
    throw new TargetValidationError("PRIVATE_TARGET", "Private and reserved SSH targets are disabled");
  }
  const labels = value.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new TargetValidationError("INVALID_HOST", "SSH target host is invalid");
  }
  return value;
}

export function isPrivateOrReservedAddress(host: string): boolean {
  let value: string;
  try {
    value = normalizeHost(host);
  } catch {
    return true;
  }
  const ipv4 = parseIpv4(value);
  if (ipv4) return isReservedIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  if (ipv6) return isReservedIpv6(ipv6);
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")
    || value === "metadata.google.internal";
}

export function assertAllowedSshPort(port: number, allowedPorts: ReadonlySet<number> | null = null): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TargetValidationError("INVALID_PORT", "SSH target port is invalid");
  }
  if (PROHIBITED_SSH_PORTS.has(port) || (allowedPorts && !allowedPorts.has(port))) {
    throw new TargetValidationError("PROHIBITED_PORT", "SSH target port is not allowed");
  }
}

interface DnsAnswer { type?: number; data?: string }

export interface ResolveTargetOptions {
  fetcher?: typeof fetch;
  resolverUrl?: string;
  signal?: AbortSignal;
}

export async function resolvePublicAddresses(host: string, options: ResolveTargetOptions = {}): Promise<string[]> {
  const normalized = normalizeHost(host);
  if (isPrivateOrReservedAddress(normalized)) {
    throw new TargetValidationError("PRIVATE_TARGET", "Private and reserved SSH targets are disabled");
  }
  if (parseIpv4(normalized) || parseIpv6(normalized)) return [normalized];

  const fetcher = options.fetcher ?? fetch;
  const resolverUrl = options.resolverUrl ?? "https://cloudflare-dns.com/dns-query";
  const signal = options.signal ?? AbortSignal.timeout(5_000);
  const responses = await Promise.all(["A", "AAAA"].map((type) => {
    const url = new URL(resolverUrl);
    url.searchParams.set("name", normalized);
    url.searchParams.set("type", type);
    return fetcher(url, { headers: { Accept: "application/dns-json" }, redirect: "manual", signal });
  }));

  const addresses: string[] = [];
  for (const response of responses) {
    if (!response.ok || !response.headers.get("Content-Type")?.toLowerCase().startsWith("application/dns-json")) {
      throw new TargetValidationError("DNS_FAILED", "Unable to verify the SSH target DNS records");
    }
    const result = await response.json() as { Status?: number; Answer?: DnsAnswer[] };
    if (result.Status !== 0 && result.Status !== 3) {
      throw new TargetValidationError("DNS_FAILED", "Unable to verify the SSH target DNS records");
    }
    if ((result.Answer?.length ?? 0) > 64) {
      throw new TargetValidationError("DNS_LIMIT", "SSH target DNS response has too many records");
    }
    for (const answer of result.Answer ?? []) {
      if (answer.type !== 1 && answer.type !== 28) continue;
      if (typeof answer.data !== "string") continue;
      const candidate = answer.data.toLowerCase();
      if ((answer.type === 1 && parseIpv4(candidate)) || (answer.type === 28 && parseIpv6(candidate))) addresses.push(candidate);
    }
  }
  const unique = [...new Set(addresses)];
  if (!unique.length) throw new TargetValidationError("DNS_EMPTY", "SSH target did not resolve to an address");
  if (unique.length > 16) throw new TargetValidationError("DNS_LIMIT", "SSH target resolves to too many addresses");
  if (unique.some(isPrivateOrReservedAddress)) {
    throw new TargetValidationError("PRIVATE_TARGET", "SSH target DNS resolves to a private or reserved address");
  }
  return unique;
}

export async function assertPublicTarget(
  host: string,
  port = 22,
  allowedPorts: ReadonlySet<number> | null = null,
  options: ResolveTargetOptions = {},
): Promise<{ host: string; port: number; addresses: string[] }> {
  assertAllowedSshPort(port, allowedPorts);
  const normalized = normalizeHost(host);
  const addresses = await resolvePublicAddresses(normalized, options);
  return { host: normalized, port, addresses };
}

export function toSocketHostname(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}
