import type { Env } from "../env";
import { getRuntimeConfig } from "../env";

// Security-header baseline adapted from CF-Workers-WebSSH/src/http-security.ts (Apache-2.0).
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class OriginError extends Error {
  readonly status = 403;
  constructor(message = "Request origin is not allowed") {
    super(message);
    this.name = "OriginError";
  }
}

export function isTlsRequiredRedirect(request: Request, env: Env): boolean {
  return env.APP_ENV === "production"
    && new URL(request.url).protocol === "http:"
    && request.headers.has("CF-Connecting-IP");
}

export function httpsRedirect(request: Request): Response {
  const url = new URL(request.url);
  url.protocol = "https:";
  return withSecurityHeaders(new Response(null, {
    status: 308,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  }));
}

export function allowedRequestOrigins(request: Request, env: Env): ReadonlySet<string> {
  return new Set([new URL(request.url).origin, ...getRuntimeConfig(env).allowedOrigins]);
}

export function assertRequestOrigin(request: Request, env: Env, options: { websocket?: boolean } = {}): void {
  if (!options.websocket && !UNSAFE_METHODS.has(request.method.toUpperCase())) return;
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (fetchSite === "cross-site") throw new OriginError();
  const originValue = request.headers.get("Origin");
  if (!originValue || originValue === "null") throw new OriginError();
  let origin: string;
  try {
    origin = new URL(originValue).origin;
  } catch {
    throw new OriginError();
  }
  if (origin !== originValue || !allowedRequestOrigins(request, env).has(origin)) throw new OriginError();
}

export function preflightResponse(request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedRequestOrigins(request, env).has(origin)) throw new OriginError();
  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (!requestedMethod || !UNSAFE_METHODS.has(requestedMethod)) throw new OriginError();
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  return withSecurityHeaders(new Response(null, { status: 204, headers }));
}

export function withCorsForAllowedOrigin(response: Response, request: Request, env: Env): Response {
  if (response.webSocket) return response;
  const origin = request.headers.get("Origin");
  if (!origin || origin === new URL(request.url).origin || !allowedRequestOrigins(request, env).has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function withSecurityHeaders(response: Response): Response {
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return withSecurityHeaders(new Response(JSON.stringify(data), { ...init, headers }));
}

export function jsonError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, { status });
}

export function getClientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim()
    || request.headers.get("X-Real-IP")?.trim()
    || "unknown";
}
