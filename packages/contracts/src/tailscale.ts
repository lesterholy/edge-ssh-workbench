import { z } from "zod";

import { TimestampSchema } from "./common";
import {
	AuthenticationMethodSchema,
	HostSchema,
	PortSchema,
	ProfileResponseSchema,
	UsernameSchema,
} from "./profiles";

export const TailscaleConfigurationResponseSchema = z
	.object({
		tailnet: z.string().min(1).max(256).nullable(),
		apiTokenConfigured: z.boolean(),
		configured: z.boolean(),
	})
	.strict();
export type TailscaleConfigurationResponse = z.infer<
	typeof TailscaleConfigurationResponseSchema
>;

const TailscaleTailnetSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			value === "-" ||
			/^[A-Za-z0-9](?:[A-Za-z0-9.@_+-]{0,254}[A-Za-z0-9])?$/.test(value),
		"Tailnet name is invalid",
	);

export const TailscaleConfigurationUpdateRequestSchema = z
	.object({
		tailnet: TailscaleTailnetSchema,
		apiToken: z
			.string()
			.trim()
			.min(1)
			.max(4_096)
			.regex(
				/^[\x21-\x7e]+$/,
				"API token must contain printable ASCII characters",
			)
			.optional(),
	})
	.strict();
export type TailscaleConfigurationUpdateRequest = z.infer<
	typeof TailscaleConfigurationUpdateRequestSchema
>;

export const TailscaleDeviceSchema = z
	.object({
		id: z.string().min(1).max(128),
		displayName: z.string().min(1).max(100),
		hostname: z.string().min(1).max(255).nullable(),
		host: HostSchema,
		addresses: z.array(z.string().min(2).max(64)).max(16),
		os: z.string().min(1).max(64).nullable(),
		authorized: z.boolean(),
		online: z.boolean(),
		lastSeen: TimestampSchema.nullable(),
	})
	.strict();
export type TailscaleDevice = z.infer<typeof TailscaleDeviceSchema>;

export const TailscaleDeviceListResponseSchema = z
	.object({
		tailnet: z.string().min(1).max(256),
		devices: z.array(TailscaleDeviceSchema).max(500),
	})
	.strict();
export type TailscaleDeviceListResponse = z.infer<
	typeof TailscaleDeviceListResponseSchema
>;

export const TailscaleImportRequestSchema = z
	.object({
		deviceIds: z
			.array(z.string().min(1).max(128))
			.min(1)
			.max(50)
			.refine(
				(value) => new Set(value).size === value.length,
				"Device identifiers must be unique",
			),
		username: UsernameSchema,
		port: PortSchema,
		authenticationMethod: AuthenticationMethodSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.authenticationMethod === "tailscale_ssh" && value.port !== 22) {
			context.addIssue({
				code: "custom",
				path: ["port"],
				message: "Tailscale SSH imports must use port 22",
			});
		}
	});
export type TailscaleImportRequest = z.infer<
	typeof TailscaleImportRequestSchema
>;

export const TailscaleImportSkippedSchema = z
	.object({
		deviceId: z.string().min(1).max(128),
		name: z.string().min(1).max(100),
		reason: z.enum(["duplicate", "unauthorized", "missing_magic_dns"]),
	})
	.strict();
export type TailscaleImportSkipped = z.infer<
	typeof TailscaleImportSkippedSchema
>;

export const TailscaleImportResponseSchema = z
	.object({
		created: z.array(ProfileResponseSchema).max(50),
		skipped: z.array(TailscaleImportSkippedSchema).max(50),
	})
	.strict();
export type TailscaleImportResponse = z.infer<
	typeof TailscaleImportResponseSchema
>;
