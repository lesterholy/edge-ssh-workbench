import type { ApiErrorCode, ApiErrorResponse } from "@edgesh/contracts";

import { jsonResponse } from "../security";
import { HttpError } from "./errors";

export function apiJson(data: unknown, status = 200, headers?: HeadersInit): Response {
  return jsonResponse(data, { status, headers });
}

export function apiError(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  status: number,
  options: HttpError["options"] = {},
): Response {
  const body: ApiErrorResponse = {
    error: {
      code,
      message,
      requestId,
      retryable: options.retryable ?? false,
      ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }),
      ...(options.issues === undefined ? {} : { issues: options.issues }),
    },
  };
  const headers = new Headers(options.headers);
  if (options.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(options.retryAfterSeconds));
  }
  return apiJson(body, status, headers);
}

export function httpErrorResponse(error: HttpError, currentRequestId: string): Response {
  return apiError(currentRequestId, error.code, error.message, error.status, error.options);
}
