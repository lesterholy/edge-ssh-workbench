import { z } from "zod";

import {
  EntityIdSchema,
  ProtocolVersionSchema,
  RequestIdSchema,
  TimestampSchema,
} from "./common";
import {
  PrivateKeyPassphraseSchema,
  PrivateKeySchema,
  SshPasswordSchema,
} from "./profiles";
import { TerminalEncodingSchema, TerminalTypeSchema } from "./settings";

export const EphemeralPasswordCredentialSchema = z
  .object({
    method: z.literal("password"),
    password: SshPasswordSchema,
  })
  .strict();
export type EphemeralPasswordCredential = z.infer<typeof EphemeralPasswordCredentialSchema>;

export const EphemeralPrivateKeyCredentialSchema = z
  .object({
    method: z.literal("private_key"),
    privateKey: PrivateKeySchema,
    passphrase: PrivateKeyPassphraseSchema.optional(),
  })
  .strict();
export type EphemeralPrivateKeyCredential = z.infer<
  typeof EphemeralPrivateKeyCredentialSchema
>;

export const EphemeralCredentialSchema = z.union([
  EphemeralPasswordCredentialSchema,
  EphemeralPrivateKeyCredentialSchema,
]);
export type EphemeralCredential = z.infer<typeof EphemeralCredentialSchema>;

export const SshTicketRequestSchema = z
  .object({
    profileId: EntityIdSchema,
    attemptId: EntityIdSchema,
    terminal: z
      .object({
        columns: z.number().int().min(2).max(1000),
        rows: z.number().int().min(1).max(500),
        type: TerminalTypeSchema,
        encoding: TerminalEncodingSchema,
      })
      .strict(),
    ephemeralCredential: EphemeralCredentialSchema.optional(),
  })
  .strict();
export type SshTicketRequest = z.infer<typeof SshTicketRequestSchema>;

export const SshTicketResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    sessionId: EntityIdSchema,
    ticket: z.string().min(32).max(4096),
    webSocketPath: z.literal("/ws/ssh"),
    expiresAt: TimestampSchema,
    protocolVersion: ProtocolVersionSchema,
  })
  .strict();
export type SshTicketResponse = z.infer<typeof SshTicketResponseSchema>;
