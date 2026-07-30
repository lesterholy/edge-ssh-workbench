import type { ApiErrorCode, HealthResponse } from "@edgesh/contracts";

import type { Env } from "../env";
import {
  assertRequestOrigin,
  httpsRedirect,
  isTlsRequiredRedirect,
  OriginError,
  preflightResponse,
  TargetValidationError,
  withCorsForAllowedOrigin,
  withSecurityHeaders,
} from "../security";
import { routeAuth } from "./auth";
import { HttpError } from "./errors";
import { routeHistory } from "./history";
import { routeProfiles } from "./profiles";
import { requestId } from "./request";
import { apiError, apiJson, httpErrorResponse } from "./response";
import { routeSettings } from "./settings";
import { createSshTicket, upgradeSsh } from "./ssh";

const APP_VERSION = "0.1.0";

function health(env: Env): Response {
  const bindings = {
    d1: Boolean(env.DB),
    r2: Boolean(env.FILES),
    durableObjects: Boolean(env.SSH_SESSIONS) && Boolean(env.AUTH_LIMITER),
  };
  const secretsReady = env.APP_ENV !== "production"
    || Boolean(env.ADMIN_PASSWORD_HASH && env.CREDENTIAL_MASTER_KEY && env.SESSION_HMAC_KEY);
  const result: HealthResponse = {
    status: Object.values(bindings).every(Boolean) && secretsReady ? "ok" : "degraded",
    version: APP_VERSION,
    runtime: "cloudflare-workers",
    timestamp: new Date().toISOString(),
    bindings,
  };
  return apiJson(result);
}

async function apiRoute(
  request: Request,
  env: Env,
  path: string,
  currentRequestId: string,
): Promise<Response> {
  if (path === "/api/health") {
    if (request.method !== "GET") throw new HttpError(405, "BAD_REQUEST", "Method not allowed", {
      headers: { Allow: "GET" },
    });
    return health(env);
  }
  if (path.startsWith("/api/auth/")) return routeAuth(request, env, path);
  if (path === "/api/settings") return routeSettings(request, env);
  if (path === "/api/profiles" || path.startsWith("/api/profiles/")) {
    return routeProfiles(request, env, path);
  }
  if (path.startsWith("/api/history/")) return routeHistory(request, env, path);
  if (path === "/api/ssh/tickets") return createSshTicket(request, env, currentRequestId);
  throw new HttpError(404, "NOT_FOUND", "Route not found");
}

function attachRequestId(response: Response, currentRequestId: string): Response {
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", currentRequestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function publicError(error: unknown, currentRequestId: string): Response {
  if (error instanceof HttpError) return httpErrorResponse(error, currentRequestId);
  if (error instanceof OriginError) {
    return apiError(currentRequestId, "CSRF_REJECTED", "Request origin is not allowed", 403);
  }
  if (error instanceof TargetValidationError) {
    return apiError(currentRequestId, "SSH_TARGET_REJECTED", error.message, 400);
  }
  return apiError(currentRequestId, "INTERNAL_ERROR", "Internal server error", 500, { retryable: true });
}

function logFailure(request: Request, currentRequestId: string, error: unknown): void {
  if (error instanceof HttpError && error.status < 500) return;
  if (error instanceof OriginError || error instanceof TargetValidationError) return;
  console.error(JSON.stringify({
    level: "error",
    event: "worker_request_failed",
    requestId: currentRequestId,
    method: request.method,
    path: new URL(request.url).pathname,
    error: error instanceof Error ? error.name : "UnknownError",
  }));
}

function finalizeApiResponse(response: Response, request: Request, env: Env, currentRequestId: string): Response {
  if (response.webSocket) return response;
  return attachRequestId(
    withSecurityHeaders(withCorsForAllowedOrigin(response, request, env)),
    currentRequestId,
  );
}

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const api = path === "/api" || path.startsWith("/api/");
  const websocket = path === "/ws" || path.startsWith("/ws/");
  const currentRequestId = requestId(request);

  try {
    if (isTlsRequiredRedirect(request, env)) {
      if (!api && !websocket && (request.method === "GET" || request.method === "HEAD")) {
        return httpsRedirect(request);
      }
      throw new HttpError(403, "UNAUTHORIZED", "HTTPS is required");
    }

    if (api && request.method === "OPTIONS") {
      return finalizeApiResponse(preflightResponse(request, env), request, env, currentRequestId);
    }
    if (api) {
      assertRequestOrigin(request, env);
      const response = await apiRoute(request, env, path, currentRequestId);
      return finalizeApiResponse(response, request, env, currentRequestId);
    }

    if (path === "/ws/ssh") {
      assertRequestOrigin(request, env, { websocket: true });
      return await upgradeSsh(request, env);
    }
    if (websocket) throw new HttpError(404, "NOT_FOUND", "Route not found");

    if (!env.ASSETS) throw new HttpError(503, "SERVICE_UNAVAILABLE", "Static assets are unavailable", {
      retryable: true,
    });
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  } catch (error) {
    logFailure(request, currentRequestId, error);
    const response = publicError(error, currentRequestId);
    return api || websocket
      ? finalizeApiResponse(response, request, env, currentRequestId)
      : withSecurityHeaders(response);
  }
}
