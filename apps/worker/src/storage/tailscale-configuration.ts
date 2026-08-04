import type {
	TailscaleConfigurationResponse,
	TailscaleConfigurationUpdateRequest,
} from "@edgesh/contracts";

import type { Env } from "../env";
import {
	decryptSecret,
	encryptSecret,
	type EncryptedEnvelope,
} from "../security/envelope";
import { nowIso } from "./internal";

interface TailscaleConfigurationRow {
	owner_id: string;
	tailnet: string;
	api_token_ciphertext: string | null;
	api_token_iv: string | null;
	api_token_version: number | null;
	updated_at: string;
}

export type TailscaleApiBindings = Pick<
	Env,
	"TAILSCALE_TAILNET" | "TAILSCALE_API_TOKEN"
>;

function configuredValue(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

function tokenEnvelope(
	row: TailscaleConfigurationRow | null,
): EncryptedEnvelope | null {
	if (
		!row?.api_token_ciphertext ||
		!row.api_token_iv ||
		row.api_token_version !== 1
	)
		return null;
	return {
		version: 1,
		ciphertext: row.api_token_ciphertext,
		iv: row.api_token_iv,
	};
}

export class TailscaleConfigurationRepository {
	constructor(
		private readonly db: D1Database,
		private readonly masterKey?: string,
	) {}

	private async getRow(
		ownerId: string,
	): Promise<TailscaleConfigurationRow | null> {
		return this.db
			.prepare("SELECT * FROM tailscale_configuration WHERE owner_id = ?")
			.bind(ownerId)
			.first<TailscaleConfigurationRow>();
	}

	async get(
		ownerId: string,
		environment: TailscaleApiBindings,
	): Promise<TailscaleConfigurationResponse> {
		const row = await this.getRow(ownerId);
		const tailnet =
			row?.tailnet ?? configuredValue(environment.TAILSCALE_TAILNET) ?? null;
		const apiTokenConfigured =
			tokenEnvelope(row) !== null ||
			configuredValue(environment.TAILSCALE_API_TOKEN) !== undefined;
		return {
			tailnet,
			apiTokenConfigured,
			configured: tailnet !== null && apiTokenConfigured,
		};
	}

	async resolve(
		ownerId: string,
		environment: TailscaleApiBindings,
	): Promise<TailscaleApiBindings> {
		const row = await this.getRow(ownerId);
		const envelope = tokenEnvelope(row);
		const token = envelope
			? await decryptSecret(this.masterKey, envelope, {
					ownerId,
					recordId: "tailscale-configuration",
					field: "tailscaleApiToken",
				})
			: environment.TAILSCALE_API_TOKEN;
		return {
			TAILSCALE_TAILNET: row?.tailnet ?? environment.TAILSCALE_TAILNET,
			TAILSCALE_API_TOKEN: token,
		};
	}

	async update(
		ownerId: string,
		input: TailscaleConfigurationUpdateRequest,
		environment: TailscaleApiBindings,
	): Promise<TailscaleConfigurationResponse> {
		const existing = await this.getRow(ownerId);
		let envelope = tokenEnvelope(existing);
		if (input.apiToken) {
			envelope = await encryptSecret(this.masterKey, input.apiToken, {
				ownerId,
				recordId: "tailscale-configuration",
				field: "tailscaleApiToken",
			});
		}
		if (!envelope && !configuredValue(environment.TAILSCALE_API_TOKEN)) {
			throw new Error("A Tailscale API token is required");
		}
		await this.db
			.prepare(
				`INSERT INTO tailscale_configuration
        (owner_id, tailnet, api_token_ciphertext, api_token_iv, api_token_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         tailnet = excluded.tailnet,
         api_token_ciphertext = excluded.api_token_ciphertext,
         api_token_iv = excluded.api_token_iv,
         api_token_version = excluded.api_token_version,
         updated_at = excluded.updated_at`,
			)
			.bind(
				ownerId,
				input.tailnet,
				envelope?.ciphertext ?? null,
				envelope?.iv ?? null,
				envelope?.version ?? null,
				nowIso(),
			)
			.run();
		return {
			tailnet: input.tailnet,
			apiTokenConfigured: true,
			configured: true,
		};
	}
}
