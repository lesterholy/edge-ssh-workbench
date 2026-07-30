import { z } from "zod";

import { SuccessResponseSchema, TimestampSchema } from "./common";

export const TotpCodeSchema = z.string().regex(/^\d{6}$/, "TOTP code must contain 6 digits");
// Password strength is enforced when the deployment secret is provisioned.
// Login must accept every value that can already be configured server-side.
export const PasswordSchema = z.string().min(1).max(1024);

export const AuthSessionSchema = z
  .object({
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const AnonymousAuthStateSchema = z
  .object({
    status: z.literal("anonymous"),
    authenticated: z.literal(false),
    totpEnabled: z.boolean(),
    totpRequired: z.literal(false),
    googleLoginEnabled: z.boolean(),
  })
  .strict();
export type AnonymousAuthState = z.infer<typeof AnonymousAuthStateSchema>;

export const AuthenticatedAuthStateSchema = z
  .object({
    status: z.literal("authenticated"),
    authenticated: z.literal(true),
    totpEnabled: z.boolean(),
    totpRequired: z.literal(false),
    session: AuthSessionSchema,
  })
  .strict();
export type AuthenticatedAuthState = z.infer<typeof AuthenticatedAuthStateSchema>;

export const PendingTotpAuthStateSchema = z
  .object({
    status: z.literal("totp_required"),
    authenticated: z.literal(false),
    totpEnabled: z.literal(true),
    totpRequired: z.literal(true),
  })
  .strict();
export type PendingTotpAuthState = z.infer<typeof PendingTotpAuthStateSchema>;

export const AuthStateSchema = z.discriminatedUnion("status", [
  AnonymousAuthStateSchema,
  AuthenticatedAuthStateSchema,
  PendingTotpAuthStateSchema,
]);
export type AuthState = z.infer<typeof AuthStateSchema>;

export const LoginRequestSchema = z
  .object({
    password: PasswordSchema,
    totpCode: TotpCodeSchema.optional(),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = AuthStateSchema;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const LogoutResponseSchema = SuccessResponseSchema;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const GoogleAuthorizationStartResponseSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict();
export type GoogleAuthorizationStartResponse = z.infer<typeof GoogleAuthorizationStartResponseSchema>;

export const TotpEnrollmentStartResponseSchema = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
    otpauthUri: z.string().url().startsWith("otpauth://totp/"),
    expiresAt: TimestampSchema,
  })
  .strict();
export type TotpEnrollmentStartResponse = z.infer<typeof TotpEnrollmentStartResponseSchema>;

export const TotpEnrollmentConfirmRequestSchema = z
  .object({ code: TotpCodeSchema })
  .strict();
export type TotpEnrollmentConfirmRequest = z.infer<typeof TotpEnrollmentConfirmRequestSchema>;

export const TotpEnrollmentConfirmResponseSchema = z
  .object({
    enabled: z.literal(true),
    enabledAt: TimestampSchema,
  })
  .strict();
export type TotpEnrollmentConfirmResponse = z.infer<typeof TotpEnrollmentConfirmResponseSchema>;

export const TotpDisableRequestSchema = z
  .object({
    password: PasswordSchema,
    code: TotpCodeSchema,
  })
  .strict();
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;

export const TotpDisableResponseSchema = z
  .object({ enabled: z.literal(false) })
  .strict();
export type TotpDisableResponse = z.infer<typeof TotpDisableResponseSchema>;
