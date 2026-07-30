import { decodeBase64Secret, encodeBase64Url } from "./security/encoding";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES?: R2Bucket;
  SSH_SESSIONS: DurableObjectNamespace;
  SSH_SESSION_REGISTRY: DurableObjectNamespace;
  AUTH_LIMITER: DurableObjectNamespace;

  APP_ENV?: "development" | "test" | "production";
  ALLOWED_ORIGINS?: string;
  CONNECT_TIMEOUT_MS?: string;
  MAX_SESSIONS_PER_USER?: string;
  ALLOWED_SSH_PORTS?: string;
  SSH_TRANSPORT?: string;
  TAILNET_CONNECTOR_URL?: string;

  ADMIN_PASSWORD_HASH?: string;
  CREDENTIAL_MASTER_KEY?: string;
  SESSION_HMAC_KEY?: string;
  TAILNET_CONNECTOR_HMAC_KEY?: string;
  TAILNET_CONNECTOR_ACCESS_CLIENT_ID?: string;
  TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_ALLOWED_EMAILS?: string;
}

export interface TailnetConnectorConfig {
  url: string;
  hmacKey: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface RuntimeConfig {
  appEnv: "development" | "test" | "production";
  allowedOrigins: readonly string[];
  connectTimeoutMs: number;
  maxSessionsPerUser: number;
  allowedSshPorts: ReadonlySet<number> | null;
  sshTransport: "direct" | "tailnet_connector";
  tailnetConnector: TailnetConnectorConfig | null;
}

function parseTailnetConnectorUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error("TAILNET_CONNECTOR_URL is required for tailnet_connector transport");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("TAILNET_CONNECTOR_URL must be a valid secure WebSocket URL");
  }
  if ((url.protocol !== "wss:" && url.protocol !== "https:") || url.username || url.password
    || url.pathname !== "/v1/connect" || url.search || url.hash) {
    throw new Error("TAILNET_CONNECTOR_URL must use wss:// or https:// with the /v1/connect path and no credentials, query, or fragment");
  }
  return url.toString();
}

function connectorCredential(value: string | undefined, name: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 4_096 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function parseTailnetConnector(env: Env): TailnetConnectorConfig {
  const hmacKey = env.TAILNET_CONNECTOR_HMAC_KEY?.trim();
  if (!hmacKey) throw new Error("TAILNET_CONNECTOR_HMAC_KEY is required for tailnet_connector transport");
  if (!/^[A-Za-z0-9_-]{43}$/.test(hmacKey)) {
    throw new Error("TAILNET_CONNECTOR_HMAC_KEY must be a canonical base64url-encoded 32-byte secret");
  }
  const keyBytes = decodeBase64Secret(hmacKey, 32);
  if (encodeBase64Url(keyBytes) !== hmacKey) {
    keyBytes.fill(0);
    throw new Error("TAILNET_CONNECTOR_HMAC_KEY must be a canonical base64url-encoded 32-byte secret");
  }
  keyBytes.fill(0);
  const accessClientId = connectorCredential(
    env.TAILNET_CONNECTOR_ACCESS_CLIENT_ID,
    "TAILNET_CONNECTOR_ACCESS_CLIENT_ID"
  );
  const accessClientSecret = connectorCredential(
    env.TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET,
    "TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET"
  );
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error("Tailnet Connector Access service token ID and secret must be configured together");
  }
  return {
    url: parseTailnetConnectorUrl(env.TAILNET_CONNECTOR_URL),
    hmacKey,
    ...(accessClientId && accessClientSecret ? { accessClientId, accessClientSecret } : {})
  };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const url = new URL(item);
    if (!/^https?:$/.test(url.protocol) || url.origin !== item || url.username || url.password) {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: ${item}`);
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function parsePorts(value: string | undefined): ReadonlySet<number> | null {
  if (!value?.trim()) return null;
  const ports = value.split(",").map((item) => Number(item.trim()));
  if (ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535 || port === 25)) {
    throw new Error("ALLOWED_SSH_PORTS contains an invalid or prohibited port");
  }
  return new Set(ports);
}

export function getRuntimeConfig(env: Env): RuntimeConfig {
  const sshTransport = env.SSH_TRANSPORT?.trim() || "direct";
  if (sshTransport !== "direct" && sshTransport !== "tailnet_connector") {
    throw new Error("SSH_TRANSPORT must be direct or tailnet_connector");
  }
  return {
    appEnv: env.APP_ENV === "production" || env.APP_ENV === "test" ? env.APP_ENV : "development",
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    connectTimeoutMs: boundedInteger(env.CONNECT_TIMEOUT_MS, 10_000, 1_000, 60_000),
    maxSessionsPerUser: boundedInteger(env.MAX_SESSIONS_PER_USER, 5, 1, 20),
    allowedSshPorts: parsePorts(env.ALLOWED_SSH_PORTS),
    sshTransport,
    tailnetConnector: sshTransport === "tailnet_connector" ? parseTailnetConnector(env) : null,
  };
}

export function assertRequiredBindings(env: Env): void {
  if (!env.DB) throw new Error("Missing required DB binding");
  if (!env.ASSETS) throw new Error("Missing required ASSETS binding");
  if (!env.SSH_SESSIONS) throw new Error("Missing required SSH_SESSIONS binding");
  if (!env.SSH_SESSION_REGISTRY) throw new Error("Missing required SSH_SESSION_REGISTRY binding");
  if (!env.AUTH_LIMITER) throw new Error("Missing required AUTH_LIMITER binding");
  if (env.APP_ENV === "production" && !env.ADMIN_PASSWORD_HASH) {
    throw new Error("ADMIN_PASSWORD_HASH is required in production");
  }
  if (env.APP_ENV === "production" && !env.CREDENTIAL_MASTER_KEY) {
    throw new Error("CREDENTIAL_MASTER_KEY is required in production");
  }
  if (env.APP_ENV === "production" && !env.SESSION_HMAC_KEY) {
    throw new Error("SESSION_HMAC_KEY is required in production");
  }
}

export function hasCredentialMasterKey(env: Env): boolean {
  return Boolean(env.CREDENTIAL_MASTER_KEY?.trim());
}
