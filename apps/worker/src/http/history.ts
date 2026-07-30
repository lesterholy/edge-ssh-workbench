import {
  CommandHistoryQuerySchema,
  HistoryClearRequestSchema,
  SessionHistoryQuerySchema,
  type CommandHistoryQuery,
  type SessionHistoryQuery,
} from "@edgesh/contracts";

import type { Env } from "../env";
import {
  CommandHistoryRepository,
  ConnectionSessionRepository,
  decodeTimeCursor,
  SessionEventRepository,
} from "../storage";
import { requireAuthentication } from "./auth";
import { HttpError, methodNotAllowed } from "./errors";
import { parseJson, parseQuery } from "./request";
import { apiJson } from "./response";

function validateCursor(cursor: string | undefined): void {
  if (!cursor) return;
  try {
    decodeTimeCursor(cursor);
  } catch {
    throw new HttpError(400, "VALIDATION_FAILED", "Invalid history cursor");
  }
}

async function commandHistory(request: Request, env: Env, ownerId: string): Promise<Response> {
  const repository = new CommandHistoryRepository(env.DB);
  if (request.method === "GET") {
    const query = parseQuery(new URL(request.url), CommandHistoryQuerySchema) as CommandHistoryQuery;
    validateCursor(query.cursor);
    const result = await repository.list(ownerId, query);
    return apiJson({
      items: result.items,
      page: { nextCursor: result.nextCursor, hasMore: result.hasMore },
    });
  }
  if (request.method === "DELETE") {
    const input = await parseJson(request, HistoryClearRequestSchema, 16 * 1024);
    const deletedCount = await repository.clear(ownerId, input);
    return apiJson({ deletedCount });
  }
  return methodNotAllowed(["GET", "DELETE"]);
}

async function sessionHistory(request: Request, env: Env, ownerId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const query = parseQuery(new URL(request.url), SessionHistoryQuerySchema) as SessionHistoryQuery;
  validateCursor(query.cursor);
  const result = await new ConnectionSessionRepository(env.DB).list(ownerId, query);
  return apiJson({
    items: result.items,
    page: { nextCursor: result.nextCursor, hasMore: result.hasMore },
  });
}

async function sessionEvents(
  request: Request,
  env: Env,
  ownerId: string,
  sessionId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Invalid session identifier");
  }
  const items = await new SessionEventRepository(env.DB).list(ownerId, sessionId);
  return apiJson({ items });
}

export async function routeHistory(request: Request, env: Env, path: string): Promise<Response> {
  const auth = await requireAuthentication(request, env);
  if (path === "/api/history/commands") return commandHistory(request, env, auth.ownerId);
  if (path === "/api/history/sessions") return sessionHistory(request, env, auth.ownerId);
  const match = path.match(/^\/api\/history\/sessions\/([^/]+)\/events$/);
  if (match) return sessionEvents(request, env, auth.ownerId, decodeURIComponent(match[1] ?? ""));
  throw new HttpError(404, "NOT_FOUND", "Route not found");
}
