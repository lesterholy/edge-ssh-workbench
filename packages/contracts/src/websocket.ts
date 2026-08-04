import { z } from "zod";

import {
  ApiErrorCodeSchema,
  EntityIdSchema,
  MAX_JSON_MESSAGE_BYTES,
  ProtocolVersionSchema,
  RequestIdSchema,
  TimestampSchema,
} from "./common";
import { SessionCloseReasonSchema, SessionStateSchema } from "./history";
import {
  HostKeyFingerprintSchema,
  HostSchema,
  PortSchema,
  UsernameSchema,
} from "./profiles";
import { TerminalEncodingSchema, TerminalTypeSchema } from "./settings";

export const RemotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL");
export type RemotePath = z.infer<typeof RemotePathSchema>;

export const FileModeSchema = z.number().int().min(0).max(0o7777);
export const TransferDirectionSchema = z.enum(["upload", "download"]);
export type TransferDirection = z.infer<typeof TransferDirectionSchema>;

export const TransferStatusSchema = z.enum([
  "queued",
  "uploading_to_r2",
  "transferring",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const BinaryFrameKindSchema = z.enum([
  "terminal-input",
  "terminal-output",
  "sftp-upload-chunk",
  "sftp-download-chunk",
]);
export type BinaryFrameKind = z.infer<typeof BinaryFrameKindSchema>;

// The encoded header precedes the raw payload; the transport implementation
// must reject frames whose payload byte length does not match this declaration.
export const BinaryFrameHeaderSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    kind: BinaryFrameKindSchema,
    sessionId: EntityIdSchema,
    transferId: EntityIdSchema.optional(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    payloadBytes: z.number().int().min(1).max(65_536),
  })
  .strict()
  .superRefine((value, context) => {
    const isTransfer = value.kind.startsWith("sftp-");
    if (isTransfer && (!value.transferId || value.offset === undefined)) {
      context.addIssue({
        code: "custom",
        message: "SFTP binary frames require transferId and offset",
      });
    }
    if (!isTransfer && (value.transferId || value.offset !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Terminal binary frames must not include transfer fields",
      });
    }
  });
export type BinaryFrameHeader = z.infer<typeof BinaryFrameHeaderSchema>;

const ClientMessageBase = {
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
} as const;

export const ClientHelloMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("hello"),
    attemptId: EntityIdSchema,
  })
  .strict();
export type ClientHelloMessage = z.infer<typeof ClientHelloMessageSchema>;

export const ClientConnectMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("connect"),
    attemptId: EntityIdSchema,
    terminal: z
      .object({
        columns: z.number().int().min(2).max(1000),
        rows: z.number().int().min(1).max(500),
        type: TerminalTypeSchema,
        encoding: TerminalEncodingSchema,
      })
      .strict(),
  })
  .strict();
export type ClientConnectMessage = z.infer<typeof ClientConnectMessageSchema>;

export const ClientHostKeyDecisionMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("host-key-decision"),
    attemptId: EntityIdSchema,
    fingerprint: HostKeyFingerprintSchema,
    decision: z.enum(["trust_once", "trust_and_save", "reject"]),
  })
  .strict();
export type ClientHostKeyDecisionMessage = z.infer<
  typeof ClientHostKeyDecisionMessageSchema
>;

export const ClientTerminalInputMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("input"),
    attemptId: EntityIdSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    data: z.string().min(1).max(65_536),
  })
  .strict();
export type ClientTerminalInputMessage = z.infer<typeof ClientTerminalInputMessageSchema>;

export const ClientResizeMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("resize"),
    attemptId: EntityIdSchema,
    columns: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(500),
    pixelWidth: z.number().int().nonnegative().max(100_000).optional(),
    pixelHeight: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();
export type ClientResizeMessage = z.infer<typeof ClientResizeMessageSchema>;

export const ClientDisconnectMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("disconnect"),
    attemptId: EntityIdSchema,
  })
  .strict();
export type ClientDisconnectMessage = z.infer<typeof ClientDisconnectMessageSchema>;

export const ClientShellHistoryMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("shell-history"),
    limit: z.number().int().min(1).max(50).default(50),
  })
  .strict();
export type ClientShellHistoryMessage = z.infer<typeof ClientShellHistoryMessageSchema>;

export const ClientSftpListMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-list"),
    path: RemotePathSchema,
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ClientSftpListMessage = z.infer<typeof ClientSftpListMessageSchema>;

export const ClientSftpReadMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-read"),
    path: RemotePathSchema,
    maxBytes: z.number().int().min(1).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
  })
  .strict();
export type ClientSftpReadMessage = z.infer<typeof ClientSftpReadMessageSchema>;

export const ClientSftpWriteMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-write"),
    path: RemotePathSchema,
    size: z.number().int().nonnegative().max(2 * 1024 * 1024),
    expectedSize: z.number().int().nonnegative().max(2 * 1024 * 1024),
    expectedModifiedAt: TimestampSchema,
  })
  .strict();
export type ClientSftpWriteMessage = z.infer<typeof ClientSftpWriteMessageSchema>;

export const ClientSftpMkdirMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-mkdir"),
    path: RemotePathSchema,
    mode: FileModeSchema.default(0o755),
  })
  .strict();
export type ClientSftpMkdirMessage = z.infer<typeof ClientSftpMkdirMessageSchema>;

export const ClientSftpRenameMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-rename"),
    sourcePath: RemotePathSchema,
    destinationPath: RemotePathSchema,
  })
  .strict();
export type ClientSftpRenameMessage = z.infer<typeof ClientSftpRenameMessageSchema>;

export const ClientSftpDeleteMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-delete"),
    path: RemotePathSchema,
    kind: z.enum(["file", "empty_directory"]),
  })
  .strict();
export type ClientSftpDeleteMessage = z.infer<typeof ClientSftpDeleteMessageSchema>;

export const ClientSftpChmodMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-chmod"),
    path: RemotePathSchema,
    mode: FileModeSchema,
  })
  .strict();
export type ClientSftpChmodMessage = z.infer<typeof ClientSftpChmodMessageSchema>;

export const ClientSftpUploadStartMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-upload-start"),
    path: RemotePathSchema,
    size: z.number().int().nonnegative().max(100 * 1024 * 1024),
    modifiedAt: TimestampSchema.optional(),
  })
  .strict();
export type ClientSftpUploadStartMessage = z.infer<
  typeof ClientSftpUploadStartMessageSchema
>;

export const ClientSftpDownloadStartMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("sftp-download-start"),
    path: RemotePathSchema,
  })
  .strict();
export type ClientSftpDownloadStartMessage = z.infer<
  typeof ClientSftpDownloadStartMessageSchema
>;

export const ClientTransferControlMessageSchema = z
  .object({
    ...ClientMessageBase,
    type: z.literal("transfer-control"),
    transferId: EntityIdSchema,
    action: z.enum(["pause", "resume", "cancel"]),
  })
  .strict();
export type ClientTransferControlMessage = z.infer<
  typeof ClientTransferControlMessageSchema
>;

const hasValidJsonSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_JSON_MESSAGE_BYTES;

export const ClientWebSocketMessageSchema = z
  .union([
    ClientHelloMessageSchema,
    ClientConnectMessageSchema,
    ClientHostKeyDecisionMessageSchema,
    ClientTerminalInputMessageSchema,
    ClientResizeMessageSchema,
    ClientDisconnectMessageSchema,
    ClientShellHistoryMessageSchema,
    ClientSftpListMessageSchema,
    ClientSftpReadMessageSchema,
    ClientSftpWriteMessageSchema,
    ClientSftpMkdirMessageSchema,
    ClientSftpRenameMessageSchema,
    ClientSftpDeleteMessageSchema,
    ClientSftpChmodMessageSchema,
    ClientSftpUploadStartMessageSchema,
    ClientSftpDownloadStartMessageSchema,
    ClientTransferControlMessageSchema,
  ])
  .refine(hasValidJsonSize, `JSON messages must not exceed ${MAX_JSON_MESSAGE_BYTES} bytes`);
export type ClientWebSocketMessage = z.infer<typeof ClientWebSocketMessageSchema>;

const ServerMessageBase = {
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema.optional(),
  sessionId: EntityIdSchema,
} as const;

export const ServerStatusMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("status"),
    attemptId: EntityIdSchema,
    state: SessionStateSchema,
    message: z.string().min(1).max(512),
    occurredAt: TimestampSchema,
    closeReason: SessionCloseReasonSchema.optional(),
    connection: z
      .object({
        host: HostSchema,
        port: PortSchema,
        username: UsernameSchema,
        latencyMs: z.number().nonnegative().max(3_600_000),
        keyExchange: z.string().min(1).max(128),
        hostKeyAlgorithm: z.string().min(1).max(128),
        cipher: z.string().min(1).max(128),
        mac: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServerStatusMessage = z.infer<typeof ServerStatusMessageSchema>;

export const ServerHostKeyMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("host-key"),
    attemptId: EntityIdSchema,
    host: HostSchema,
    port: PortSchema,
    algorithm: z.string().min(1).max(128),
    fingerprint: HostKeyFingerprintSchema,
    changed: z.boolean(),
    previousFingerprint: HostKeyFingerprintSchema.optional(),
    confirmationExpiresAt: TimestampSchema,
  })
  .strict();
export type ServerHostKeyMessage = z.infer<typeof ServerHostKeyMessageSchema>;

export const ServerTerminalOutputMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("output"),
    attemptId: EntityIdSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stream: z.enum(["stdout", "stderr"]),
    data: z.string().min(1).max(65_536),
  })
  .strict();
export type ServerTerminalOutputMessage = z.infer<
  typeof ServerTerminalOutputMessageSchema
>;

export const MetricSupportSchema = z.enum(["supported", "unsupported", "error"]);
export type MetricSupport = z.infer<typeof MetricSupportSchema>;

export const MetricValueSchema = <T extends z.ZodType>(valueSchema: T) =>
  z.union([
    z
      .object({
        support: z.literal("supported"),
        value: valueSchema,
      })
      .strict(),
    z
      .object({
        support: z.enum(["unsupported", "error"]),
        value: z.null(),
      })
      .strict(),
  ]);

export const ProcessMetricSchema = z
  .object({
    pid: z.number().int().positive(),
    user: z.string().min(1).max(128),
    cpuPercent: z.number().nonnegative().max(100_000),
    memoryPercent: z.number().nonnegative().max(100),
    command: z.string().min(1).max(512),
  })
  .strict();
export type ProcessMetric = z.infer<typeof ProcessMetricSchema>;

export const FirewallRuleSchema = z
  .object({
    destination: z.string().min(1).max(256),
    action: z.string().min(1).max(32),
    source: z.string().min(1).max(256),
  })
  .strict();
export type FirewallRule = z.infer<typeof FirewallRuleSchema>;

export const FirewallMetricSchema = z
  .object({
    backend: z.literal("ufw"),
    status: z.enum(["active", "inactive"]),
    logging: z.string().min(1).max(64).optional(),
    defaultIncoming: z.string().min(1).max(32).optional(),
    defaultOutgoing: z.string().min(1).max(32).optional(),
    rules: z.array(FirewallRuleSchema).max(50),
  })
  .strict();
export type FirewallMetric = z.infer<typeof FirewallMetricSchema>;

const UsageMetricSchema = z
  .object({
    usedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    percent: z.number().nonnegative().max(100),
  })
  .strict();

export const ServerMetricsMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("metrics"),
    sampledAt: TimestampSchema,
    cpu: MetricValueSchema(z.number().nonnegative().max(100)),
    memory: MetricValueSchema(UsageMetricSchema),
    swap: MetricValueSchema(UsageMetricSchema),
    rootDisk: MetricValueSchema(UsageMetricSchema),
    processes: MetricValueSchema(z.array(ProcessMetricSchema).max(8)),
    firewall: MetricValueSchema(FirewallMetricSchema),
  })
  .strict();
export type ServerMetricsMessage = z.infer<typeof ServerMetricsMessageSchema>;

export const ShellHistoryEntrySchema = z
  .object({
    command: z.string().min(1).max(768),
    executedAt: TimestampSchema.optional(),
  })
  .strict();
export type ShellHistoryEntry = z.infer<typeof ShellHistoryEntrySchema>;

export const ServerShellHistoryResultMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("shell-history-result"),
    shell: z.literal("bash"),
    source: z.literal("~/.bash_history"),
    entries: z.array(ShellHistoryEntrySchema).max(50),
  })
  .strict();
export type ServerShellHistoryResultMessage = z.infer<typeof ServerShellHistoryResultMessageSchema>;

export const SftpEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes("\0"), "Name must not contain NUL"),
    path: RemotePathSchema,
    kind: z.enum(["file", "directory", "symlink", "other"]),
    size: z.number().int().nonnegative(),
    mode: FileModeSchema,
    modifiedAt: TimestampSchema,
  })
  .strict();
export type SftpEntry = z.infer<typeof SftpEntrySchema>;

const SftpResultBase = {
  ...ServerMessageBase,
  type: z.literal("file-result"),
} as const;

export const ServerSftpListResultMessageSchema = z
  .object({
    ...SftpResultBase,
    operation: z.literal("list"),
    path: RemotePathSchema,
    entries: z.array(SftpEntrySchema).max(500),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ServerSftpListResultMessage = z.infer<
  typeof ServerSftpListResultMessageSchema
>;

export const ServerSftpReadResultMessageSchema = z
  .object({
    ...SftpResultBase,
    operation: z.literal("read"),
    path: RemotePathSchema,
    size: z.number().int().nonnegative().max(2 * 1024 * 1024),
    mode: FileModeSchema,
    modifiedAt: TimestampSchema,
  })
  .strict();
export type ServerSftpReadResultMessage = z.infer<
  typeof ServerSftpReadResultMessageSchema
>;

export const ServerSftpMutationResultMessageSchema = z
  .object({
    ...SftpResultBase,
    operation: z.enum(["write", "mkdir", "rename", "delete", "chmod"]),
    path: RemotePathSchema,
    destinationPath: RemotePathSchema.optional(),
  })
  .strict();
export type ServerSftpMutationResultMessage = z.infer<
  typeof ServerSftpMutationResultMessageSchema
>;

export const ServerFileResultMessageSchema = z.union([
  ServerSftpListResultMessageSchema,
  ServerSftpReadResultMessageSchema,
  ServerSftpMutationResultMessageSchema,
]);
export type ServerFileResultMessage = z.infer<typeof ServerFileResultMessageSchema>;

export const ServerTransferReadyMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("transfer-ready"),
    transferId: EntityIdSchema,
    direction: TransferDirectionSchema,
    path: RemotePathSchema,
    totalBytes: z.number().int().nonnegative(),
    chunkSize: z.number().int().min(1024).max(65_536),
    resumeOffset: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resumeOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["resumeOffset"],
        message: "resumeOffset must not exceed totalBytes",
      });
    }
  });
export type ServerTransferReadyMessage = z.infer<typeof ServerTransferReadyMessageSchema>;

export const ServerTransferProgressMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("transfer-progress"),
    transferId: EntityIdSchema,
    direction: TransferDirectionSchema,
    status: TransferStatusSchema,
    path: RemotePathSchema,
    transferredBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    bytesPerSecond: z.number().nonnegative(),
    estimatedSecondsRemaining: z.number().nonnegative().nullable(),
    acknowledgedOffset: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transferredBytes > value.totalBytes || value.acknowledgedOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["transferredBytes"],
        message: "Transfer offsets must not exceed totalBytes",
      });
    }
  });
export type ServerTransferProgressMessage = z.infer<
  typeof ServerTransferProgressMessageSchema
>;

export const ServerErrorMessageSchema = z
  .object({
    ...ServerMessageBase,
    type: z.literal("error"),
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    fatal: z.boolean(),
  })
  .strict();
export type ServerErrorMessage = z.infer<typeof ServerErrorMessageSchema>;

export const ServerWebSocketMessageSchema = z
  .union([
    ServerStatusMessageSchema,
    ServerHostKeyMessageSchema,
    ServerTerminalOutputMessageSchema,
    ServerMetricsMessageSchema,
    ServerShellHistoryResultMessageSchema,
    ServerSftpListResultMessageSchema,
    ServerSftpReadResultMessageSchema,
    ServerSftpMutationResultMessageSchema,
    ServerTransferReadyMessageSchema,
    ServerTransferProgressMessageSchema,
    ServerErrorMessageSchema,
  ])
  .refine(hasValidJsonSize, `JSON messages must not exceed ${MAX_JSON_MESSAGE_BYTES} bytes`);
export type ServerWebSocketMessage = z.infer<typeof ServerWebSocketMessageSchema>;

export const WebSocketCloseReasonSchema = z.enum([
  "NORMAL",
  "AUTHENTICATION_REQUIRED",
  "FORBIDDEN_ORIGIN",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "TICKET_INVALID",
  "MESSAGE_INVALID",
  "MESSAGE_TOO_LARGE",
  "SESSION_TERMINATED",
]);
export type WebSocketCloseReason = z.infer<typeof WebSocketCloseReasonSchema>;

export const WEBSOCKET_CLOSE_CODES = {
  NORMAL: 1000,
  AUTHENTICATION_REQUIRED: 4401,
  FORBIDDEN_ORIGIN: 4403,
  PROTOCOL_VERSION_UNSUPPORTED: 4406,
  TICKET_INVALID: 4408,
  MESSAGE_INVALID: 4400,
  MESSAGE_TOO_LARGE: 4409,
  SESSION_TERMINATED: 4500,
} as const satisfies Record<WebSocketCloseReason, number>;

export const WebSocketCloseCodeSchema = z.union([
  z.literal(WEBSOCKET_CLOSE_CODES.NORMAL),
  z.literal(WEBSOCKET_CLOSE_CODES.AUTHENTICATION_REQUIRED),
  z.literal(WEBSOCKET_CLOSE_CODES.FORBIDDEN_ORIGIN),
  z.literal(WEBSOCKET_CLOSE_CODES.PROTOCOL_VERSION_UNSUPPORTED),
  z.literal(WEBSOCKET_CLOSE_CODES.TICKET_INVALID),
  z.literal(WEBSOCKET_CLOSE_CODES.MESSAGE_INVALID),
  z.literal(WEBSOCKET_CLOSE_CODES.MESSAGE_TOO_LARGE),
  z.literal(WEBSOCKET_CLOSE_CODES.SESSION_TERMINATED),
]);
export type WebSocketCloseCode = z.infer<typeof WebSocketCloseCodeSchema>;
