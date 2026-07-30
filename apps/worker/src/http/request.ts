import type { ValidationIssue } from "@edgesh/contracts";

import { HttpError } from "./errors";

export const MAX_API_JSON_BYTES = 1024 * 1024;

interface ParseSuccess<T> {
  success: true;
  data: T;
}

interface ParseFailure {
  success: false;
  error: { issues: Array<{ path: PropertyKey[]; message: string }> };
}

interface Schema<T> {
  safeParse(value: unknown): ParseSuccess<T> | ParseFailure;
}

export function requestId(request: Request): string {
  const supplied = request.headers.get("X-Request-ID")?.trim();
  return supplied && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied.toLowerCase()
    : crypto.randomUUID();
}

export async function parseJson<T>(
  request: Request,
  schema: Schema<T>,
  maxBytes = MAX_API_JSON_BYTES,
): Promise<T> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "BAD_REQUEST", "Expected an application/json request body");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpError(400, "BAD_REQUEST", "Invalid Content-Length header");
    }
    if (length > maxBytes) throw new HttpError(413, "BAD_REQUEST", "Request body is too large");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "BAD_REQUEST", "Request body is too large");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "Request body is not valid JSON");
  }

  const parsed = schema.safeParse(decoded);
  if (parsed.success) return parsed.data;

  const issues: ValidationIssue[] = parsed.error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.slice(0, 16)
      .filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    message: issue.message.slice(0, 256),
  }));
  throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", { issues });
}

export function parseQuery<T>(url: URL, schema: Schema<T>): T {
  const decoded: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in decoded) {
      throw new HttpError(400, "VALIDATION_FAILED", `Query parameter ${key} may only appear once`);
    }
    decoded[key] = value;
  }
  if (decoded.limit !== undefined && /^\d+$/.test(decoded.limit)) {
    (decoded as Record<string, string | number>).limit = Number(decoded.limit);
  }
  const parsed = schema.safeParse(decoded);
  if (parsed.success) return parsed.data;
  const issues: ValidationIssue[] = parsed.error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.slice(0, 16)
      .filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    message: issue.message.slice(0, 256),
  }));
  throw new HttpError(400, "VALIDATION_FAILED", "Query validation failed", { issues });
}
