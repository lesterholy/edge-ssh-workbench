import {
  EntityIdSchema,
  SshTicketRequestSchema,
  SshTicketResponseSchema,
  WS_PROTOCOL_VERSION,
} from "@edgesh/contracts";

import type { Env } from "../env";
import { requireAuthentication } from "./auth";
import { HttpError, methodNotAllowed } from "./errors";
import { parseJson } from "./request";
import { apiJson } from "./response";

interface InternalTicketResponse {
  ticket: string;
  expiresAt: string;
  sessionId: string;
}

function verifiedOrigin(request: Request): string {
  const value = request.headers.get("Origin");
  if (!value) throw new HttpError(403, "CSRF_REJECTED", "Request origin is not allowed");
  return value;
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromName(sessionId));
}

export async function createSshTicket(
  request: Request,
  env: Env,
  currentRequestId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const auth = await requireAuthentication(request, env);
  if (!env.SESSION_HMAC_KEY) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "SSH ticket signing is not configured");
  }
  const input = await parseJson(request, SshTicketRequestSchema);
  const sessionId = crypto.randomUUID();
  const origin = verifiedOrigin(request);
  const response = await sessionStub(env, sessionId).fetch("https://ssh-session.internal/ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-auth": env.SESSION_HMAC_KEY,
      "x-verified-origin": origin,
    },
    body: JSON.stringify({ ownerId: auth.ownerId, sessionId, request: input }),
  });
  if (!response.ok) {
    if (response.status === 404) throw new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found");
    if (response.status === 422) {
      throw new HttpError(400, "PROFILE_CREDENTIAL_REQUIRED", "A connection credential is required");
    }
    if (response.status === 409) throw new HttpError(409, "CONFLICT", "An SSH ticket already exists");
    throw new HttpError(503, "SERVICE_UNAVAILABLE", "Unable to create an SSH ticket", { retryable: true });
  }
  const issued = await response.json<InternalTicketResponse>();
  return apiJson(SshTicketResponseSchema.parse({
    requestId: currentRequestId,
    sessionId: issued.sessionId,
    ticket: issued.ticket,
    webSocketPath: "/ws/ssh",
    expiresAt: issued.expiresAt,
    protocolVersion: WS_PROTOCOL_VERSION,
  }), 201);
}

export async function upgradeSsh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "BAD_REQUEST", "WebSocket upgrade required", {
      headers: { Upgrade: "websocket" },
    });
  }
  const auth = await requireAuthentication(request, env);
  const url = new URL(request.url);
  const sessionResult = EntityIdSchema.safeParse(url.searchParams.get("session"));
  const ticket = url.searchParams.get("ticket");
  const protocolVersion = url.searchParams.get("protocolVersion");
  if (!sessionResult.success || !ticket || ticket.length > 4096) {
    throw new HttpError(401, "SSH_TICKET_INVALID", "Invalid SSH session ticket");
  }
  if (protocolVersion !== String(WS_PROTOCOL_VERSION)) {
    throw new HttpError(400, "PROTOCOL_VERSION_UNSUPPORTED", "WebSocket protocol version is unsupported");
  }

  const origin = verifiedOrigin(request);
  const response = await sessionStub(env, sessionResult.data).fetch(
    `https://ssh-session.internal/connect?ticket=${encodeURIComponent(ticket)}`,
    {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        "x-owner-id": auth.ownerId,
        "x-verified-origin": origin,
      },
    },
  );
  if (response.status === 401) {
    throw new HttpError(401, "SSH_TICKET_INVALID", "SSH ticket is invalid, expired, or already used");
  }
  if (!response.webSocket) {
    throw new HttpError(503, "SERVICE_UNAVAILABLE", "Unable to open the SSH WebSocket", { retryable: true });
  }
  return response;
}
