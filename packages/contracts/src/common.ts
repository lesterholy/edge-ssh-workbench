import { z } from "zod";

export const WS_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_WS_PROTOCOL_VERSIONS = [WS_PROTOCOL_VERSION] as const;
export const MAX_JSON_MESSAGE_BYTES = 64 * 1024;
export const MAX_TERMINAL_CHUNK_BYTES = 64 * 1024;

export const ProtocolVersionSchema = z.literal(WS_PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const EntityIdSchema = z.string().uuid();
export const RequestIdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
export const CursorSchema = z.string().min(1).max(512);

export const ApiErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "AUTH_CONFIGURATION_MISSING",
  "INVALID_CREDENTIALS",
  "TOTP_REQUIRED",
  "TOTP_INVALID",
  "TOTP_ENROLLMENT_EXPIRED",
  "PROFILE_NOT_FOUND",
  "PROFILE_CREDENTIAL_REQUIRED",
  "SSH_TICKET_INVALID",
  "SSH_TICKET_EXPIRED",
  "SSH_TICKET_REPLAYED",
  "SSH_TARGET_REJECTED",
  "SSH_CONNECTION_FAILED",
  "SSH_HOST_KEY_REJECTED",
  "SSH_HOST_KEY_CHANGED",
  "SSH_AUTHENTICATION_FAILED",
  "SSH_SESSION_CLOSED",
  "SFTP_NOT_AVAILABLE",
  "SFTP_PATH_INVALID",
  "SFTP_FILE_TOO_LARGE",
  "SFTP_CONFLICT",
  "TRANSFER_NOT_FOUND",
  "TRANSFER_QUOTA_EXCEEDED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(16),
    message: z.string().min(1).max(256),
  })
  .strict();
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(512),
    requestId: RequestIdSchema,
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
    issues: z.array(ValidationIssueSchema).max(32).optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z.object({ error: ApiErrorSchema }).strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const SuccessResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

export const PageRequestSchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type PageRequest = z.infer<typeof PageRequestSchema>;

export const PageInfoSchema = z
  .object({
    nextCursor: CursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const NonEmptyPatch = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });
