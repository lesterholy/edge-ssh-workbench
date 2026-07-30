import type { ApiErrorCode, ValidationIssue } from "@edgesh/contracts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      retryAfterSeconds?: number;
      issues?: ValidationIssue[];
      headers?: HeadersInit;
    } = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function methodNotAllowed(allowed: readonly string[]): never {
  throw new HttpError(405, "BAD_REQUEST", "Method not allowed", {
    headers: { Allow: allowed.join(", ") },
  });
}
