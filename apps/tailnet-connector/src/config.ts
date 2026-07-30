export interface ConnectorConfig {
  listenHost: string;
  port: number;
  hmacKey: Buffer;
  allowedSuffix: string;
  allowedPorts: ReadonlySet<number>;
  connectTimeoutMs: number;
  authWindowMs: number;
  maxConnections: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  maxBufferedBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ConnectorConfig {
  return {
    listenHost: parseListenHost(env.LISTEN_HOST),
    port: integer(env.PORT, 8789, 1, 65_535, "PORT"),
    hmacKey: parseHmacKey(env.CONNECTOR_HMAC_KEY),
    allowedSuffix: parseAllowedSuffix(env.TAILNET_ALLOWED_SUFFIX),
    allowedPorts: parsePorts(env.TAILNET_ALLOWED_PORTS),
    connectTimeoutMs: integer(env.CONNECT_TIMEOUT_MS, 10_000, 1_000, 60_000, "CONNECT_TIMEOUT_MS"),
    authWindowMs: integer(env.AUTH_WINDOW_SECONDS, 30, 5, 300, "AUTH_WINDOW_SECONDS") * 1000,
    maxConnections: integer(env.MAX_CONNECTIONS, 20, 1, 1000, "MAX_CONNECTIONS"),
    idleTimeoutMs: integer(env.IDLE_TIMEOUT_MS, 1_800_000, 10_000, 86_400_000, "IDLE_TIMEOUT_MS"),
    maxSessionMs: integer(env.MAX_SESSION_MS, 28_800_000, 60_000, 86_400_000, "MAX_SESSION_MS"),
    maxBufferedBytes: integer(env.MAX_BUFFERED_BYTES, 1_048_576, 65_536, 16_777_216, "MAX_BUFFERED_BYTES"),
  };
}

function parseListenHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("LISTEN_HOST must be the loopback address 127.0.0.1 or ::1");
  }
  return host;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be an integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseHmacKey(value: string | undefined): Buffer {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new Error("CONNECTOR_HMAC_KEY must be a base64url-encoded 32-byte secret");
  }
  const key = Buffer.from(normalized, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== normalized) {
    throw new Error("CONNECTOR_HMAC_KEY must be a canonical base64url-encoded 32-byte secret");
  }
  return key;
}

function parseAllowedSuffix(value: string | undefined): string {
  const suffix = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
  if (!suffix) throw new Error("TAILNET_ALLOWED_SUFFIX is required");
  if (suffix.length > 253 || !suffix.endsWith(".ts.net") || !isDnsName(suffix)) {
    throw new Error("TAILNET_ALLOWED_SUFFIX must be a valid tailnet DNS suffix ending in .ts.net");
  }
  return suffix;
}

function parsePorts(value: string | undefined): ReadonlySet<number> {
  const items = (value?.trim() || "22").split(",").map((item) => item.trim());
  if (items.some((item) => !/^\d+$/.test(item))) throw new Error("TAILNET_ALLOWED_PORTS contains an invalid port");
  const ports = items.map(Number);
  if (ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535 || port === 25)) {
    throw new Error("TAILNET_ALLOWED_PORTS contains an invalid or prohibited port");
  }
  return new Set(ports);
}

function isDnsName(value: string): boolean {
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
