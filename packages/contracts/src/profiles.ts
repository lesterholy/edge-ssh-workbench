import { z } from "zod";

import { EntityIdSchema, NonEmptyPatch, PageInfoSchema, TimestampSchema } from "./common";
import { TerminalEncodingSchema, TerminalTypeSchema } from "./settings";

export const HostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !/[\u0000-\u0020/\\?#@]/u.test(value), "Invalid host");
export const PortSchema = z.number().int().min(1).max(65_535);
export const UsernameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000\r\n]/u.test(value), "Invalid username");
export const SshPasswordSchema = z.string().min(1).max(4096);
export const PrivateKeySchema = z.string().min(32).max(1024 * 1024);
export const PrivateKeyPassphraseSchema = z.string().min(1).max(4096);
export const HostKeyFingerprintSchema = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Invalid SHA-256 host-key fingerprint");

export const AuthenticationMethodSchema = z.enum(["password", "private_key"]);
export type AuthenticationMethod = z.infer<typeof AuthenticationMethodSchema>;

export const CredentialPersistenceSchema = z.enum(["saved", "prompt"]);
export type CredentialPersistence = z.infer<typeof CredentialPersistenceSchema>;

export const PasswordCredentialInputSchema = z
  .object({
    method: z.literal("password"),
    persistence: CredentialPersistenceSchema,
    password: SshPasswordSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.persistence === "saved" && value.password === undefined) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "A password is required when persistence is saved",
      });
    }
    if (value.persistence === "prompt" && value.password !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Prompt-only credentials must be supplied when creating a ticket",
      });
    }
  });
export type PasswordCredentialInput = z.infer<typeof PasswordCredentialInputSchema>;

export const PrivateKeyCredentialInputSchema = z
  .object({
    method: z.literal("private_key"),
    persistence: CredentialPersistenceSchema,
    privateKey: PrivateKeySchema.optional(),
    passphrase: PrivateKeyPassphraseSchema.optional(),
    savePassphrase: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.persistence === "saved" && value.privateKey === undefined) {
      context.addIssue({
        code: "custom",
        path: ["privateKey"],
        message: "A private key is required when persistence is saved",
      });
    }
    if (value.savePassphrase && value.passphrase === undefined) {
      context.addIssue({
        code: "custom",
        path: ["passphrase"],
        message: "A passphrase is required when savePassphrase is true",
      });
    }
    if (
      value.persistence === "prompt" &&
      (value.privateKey !== undefined || value.passphrase !== undefined || value.savePassphrase)
    ) {
      context.addIssue({
        code: "custom",
        message: "Prompt-only credentials must be supplied when creating a ticket",
      });
    }
  });
export type PrivateKeyCredentialInput = z.infer<typeof PrivateKeyCredentialInputSchema>;

export const ProfileCredentialInputSchema = z.union([
  PasswordCredentialInputSchema,
  PrivateKeyCredentialInputSchema,
]);
export type ProfileCredentialInput = z.infer<typeof ProfileCredentialInputSchema>;

const ProfileEditableFields = {
  name: z.string().trim().min(1).max(100),
  host: HostSchema,
  port: PortSchema,
  username: UsernameSchema,
  notes: z.string().max(4000),
  terminalType: TerminalTypeSchema,
  encoding: TerminalEncodingSchema,
  initialCommand: z.string().max(8192).nullable(),
} as const;

export const ProfileCreateRequestSchema = z
  .object({
    ...ProfileEditableFields,
    credential: ProfileCredentialInputSchema,
  })
  .strict();
export type ProfileCreateRequest = z.infer<typeof ProfileCreateRequestSchema>;

const createSecretMutationSchema = <T extends z.ZodType<string>>(valueSchema: T) => z.union([
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z
    .object({
      action: z.literal("replace"),
      value: valueSchema,
    })
    .strict(),
]);

export const PasswordSecretMutationSchema = createSecretMutationSchema(SshPasswordSchema);
export type PasswordSecretMutation = z.infer<typeof PasswordSecretMutationSchema>;

export const PrivateKeySecretMutationSchema = createSecretMutationSchema(PrivateKeySchema);
export type PrivateKeySecretMutation = z.infer<typeof PrivateKeySecretMutationSchema>;

export const PassphraseSecretMutationSchema = createSecretMutationSchema(
  PrivateKeyPassphraseSchema,
);
export type PassphraseSecretMutation = z.infer<typeof PassphraseSecretMutationSchema>;

export const PasswordCredentialUpdateSchema = z
  .object({
    method: z.literal("password"),
    persistence: CredentialPersistenceSchema,
    password: PasswordSecretMutationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.persistence === "prompt" && value.password.action === "replace") {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "Prompt-only credentials cannot be saved",
      });
    }
  });
export type PasswordCredentialUpdate = z.infer<typeof PasswordCredentialUpdateSchema>;

export const PrivateKeyCredentialUpdateSchema = z
  .object({
    method: z.literal("private_key"),
    persistence: CredentialPersistenceSchema,
    privateKey: PrivateKeySecretMutationSchema,
    passphrase: PassphraseSecretMutationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.persistence === "prompt" &&
      (value.privateKey.action === "replace" || value.passphrase.action === "replace")
    ) {
      context.addIssue({
        code: "custom",
        message: "Prompt-only credentials cannot be saved",
      });
    }
  });
export type PrivateKeyCredentialUpdate = z.infer<typeof PrivateKeyCredentialUpdateSchema>;

export const ProfileCredentialUpdateSchema = z.union([
  PasswordCredentialUpdateSchema,
  PrivateKeyCredentialUpdateSchema,
]);
export type ProfileCredentialUpdate = z.infer<typeof ProfileCredentialUpdateSchema>;

export const ProfileUpdateRequestSchema = NonEmptyPatch(
  z
    .object({
      name: ProfileEditableFields.name.optional(),
      host: ProfileEditableFields.host.optional(),
      port: ProfileEditableFields.port.optional(),
      username: ProfileEditableFields.username.optional(),
      notes: ProfileEditableFields.notes.optional(),
      terminalType: ProfileEditableFields.terminalType.optional(),
      encoding: ProfileEditableFields.encoding.optional(),
      initialCommand: ProfileEditableFields.initialCommand.optional(),
      credential: ProfileCredentialUpdateSchema.optional(),
    })
    .strict(),
);
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequestSchema>;

export const ProfileResponseSchema = z
  .object({
    id: EntityIdSchema,
    name: ProfileEditableFields.name,
    host: HostSchema,
    port: PortSchema,
    username: UsernameSchema,
    notes: ProfileEditableFields.notes,
    authenticationMethod: AuthenticationMethodSchema,
    credentialPersistence: CredentialPersistenceSchema,
    hasPassword: z.boolean(),
    hasPrivateKey: z.boolean(),
    hasPassphrase: z.boolean(),
    terminalType: TerminalTypeSchema,
    encoding: TerminalEncodingSchema,
    initialCommand: ProfileEditableFields.initialCommand,
    lastConnectedAt: TimestampSchema.nullable(),
    lastSuccessfulUsername: UsernameSchema.nullable(),
    lastHostKeyFingerprint: HostKeyFingerprintSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

export const ProfileListResponseSchema = z
  .object({
    items: z.array(ProfileResponseSchema).max(100),
    page: PageInfoSchema,
  })
  .strict();
export type ProfileListResponse = z.infer<typeof ProfileListResponseSchema>;

export const ProfileDeleteResponseSchema = z
  .object({
    deleted: z.literal(true),
    id: EntityIdSchema,
  })
  .strict();
export type ProfileDeleteResponse = z.infer<typeof ProfileDeleteResponseSchema>;
