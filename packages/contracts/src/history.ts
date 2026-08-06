import { z } from "zod";

import {
	CursorSchema,
	EntityIdSchema,
	PageInfoSchema,
	TimestampSchema,
} from "./common";
import { AuthenticationMethodSchema } from "./profiles";

export const CommandCaptureQualitySchema = z.enum(["verified", "best_effort"]);
export type CommandCaptureQuality = z.infer<typeof CommandCaptureQualitySchema>;

export const CommandHistoryItemSchema = z
	.object({
		id: EntityIdSchema,
		sessionId: EntityIdSchema,
		profileId: EntityIdSchema.nullable(),
		profileName: z.string().min(1).max(100),
		host: z.string().min(1).max(253),
		username: z.string().min(1).max(128),
		command: z.string().min(1).max(8192),
		captureQuality: CommandCaptureQualitySchema,
		executedAt: TimestampSchema,
	})
	.strict();
export type CommandHistoryItem = z.infer<typeof CommandHistoryItemSchema>;

export const CommandHistoryQuerySchema = z
	.object({
		cursor: CursorSchema.optional(),
		limit: z.number().int().min(1).max(100).default(50),
		query: z.string().trim().min(1).max(256).optional(),
		profileId: EntityIdSchema.optional(),
		sessionId: EntityIdSchema.optional(),
		from: TimestampSchema.optional(),
		to: TimestampSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.from &&
			value.to &&
			Date.parse(value.from) > Date.parse(value.to)
		) {
			context.addIssue({
				code: "custom",
				path: ["to"],
				message: "to must not be earlier than from",
			});
		}
	});
export type CommandHistoryQuery = z.infer<typeof CommandHistoryQuerySchema>;

export const CommandHistoryResponseSchema = z
	.object({
		items: z.array(CommandHistoryItemSchema).max(100),
		page: PageInfoSchema,
	})
	.strict();
export type CommandHistoryResponse = z.infer<
	typeof CommandHistoryResponseSchema
>;

export const HistoryClearRequestSchema = z
	.object({
		before: TimestampSchema.optional(),
		profileId: EntityIdSchema.optional(),
		sessionId: EntityIdSchema.optional(),
	})
	.strict();
export type HistoryClearRequest = z.infer<typeof HistoryClearRequestSchema>;

export const HistoryClearResponseSchema = z
	.object({ deletedCount: z.number().int().nonnegative() })
	.strict();
export type HistoryClearResponse = z.infer<typeof HistoryClearResponseSchema>;

export const SessionStateSchema = z.enum([
	"idle",
	"authorizing",
	"tcp_connecting",
	"ssh_handshake",
	"host_confirmation",
	"authenticating",
	"connected",
	"disconnecting",
	"closed",
	"error",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionCloseReasonSchema = z.enum([
	"user_disconnect",
	"remote_closed",
	"authentication_failed",
	"host_key_rejected",
	"connection_timeout",
	"idle_timeout",
	"keepalive_failed",
	"network_error",
	"worker_restart",
	"internal_error",
]);
export type SessionCloseReason = z.infer<typeof SessionCloseReasonSchema>;

export const SessionHistoryItemSchema = z
	.object({
		id: EntityIdSchema,
		profileId: EntityIdSchema.nullable(),
		profileName: z.string().min(1).max(100),
		host: z.string().min(1).max(253),
		port: z.number().int().min(1).max(65_535),
		username: z.string().min(1).max(128),
		authenticationMethod: AuthenticationMethodSchema,
		startedAt: TimestampSchema,
		connectedAt: TimestampSchema.nullable(),
		endedAt: TimestampSchema.nullable(),
		finalState: SessionStateSchema,
		closeReason: SessionCloseReasonSchema.nullable(),
	})
	.strict();
export type SessionHistoryItem = z.infer<typeof SessionHistoryItemSchema>;

export const SessionHistoryQuerySchema = z
	.object({
		cursor: CursorSchema.optional(),
		limit: z.number().int().min(1).max(100).default(50),
		profileId: EntityIdSchema.optional(),
		state: SessionStateSchema.optional(),
	})
	.strict();
export type SessionHistoryQuery = z.infer<typeof SessionHistoryQuerySchema>;

export const SessionHistoryResponseSchema = z
	.object({
		items: z.array(SessionHistoryItemSchema).max(100),
		page: PageInfoSchema,
	})
	.strict();
export type SessionHistoryResponse = z.infer<
	typeof SessionHistoryResponseSchema
>;

export const SessionEventCodeSchema = z.enum([
	"authorized",
	"tcp_connecting",
	"tcp_connected",
	"ssh_handshake_started",
	"ssh_handshake_complete",
	"host_key_confirmation_required",
	"host_key_accepted",
	"host_key_rejected",
	"authentication_started",
	"authentication_succeeded",
	"authentication_failed",
	"pty_opened",
	"shell_opened",
	"keepalive_failed",
	"rekey_started",
	"rekey_completed",
	"disconnected",
	"error",
]);
export type SessionEventCode = z.infer<typeof SessionEventCodeSchema>;

export const SessionEventSchema = z
	.object({
		id: EntityIdSchema,
		sessionId: EntityIdSchema,
		code: SessionEventCodeSchema,
		message: z.string().min(1).max(512),
		createdAt: TimestampSchema,
	})
	.strict();
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionEventListResponseSchema = z
	.object({
		items: z.array(SessionEventSchema).max(500),
	})
	.strict();
export type SessionEventListResponse = z.infer<
	typeof SessionEventListResponseSchema
>;
