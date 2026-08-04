import {
	TailscaleConfigurationResponseSchema,
	TailscaleConfigurationUpdateRequestSchema,
	TailscaleDeviceListResponseSchema,
	TailscaleImportRequestSchema,
	TailscaleImportResponseSchema,
	type ProfileCreateRequest,
	type TailscaleImportResponse,
} from "@edgesh/contracts";

import type { Env } from "../env";
import { getRuntimeConfig } from "../env";
import { assertAllowedSshPort, normalizeHost } from "../security/network";
import { ProfileRepository } from "../storage/profiles";
import { TailscaleConfigurationRepository } from "../storage/tailscale-configuration";
import { fetchTailscaleDevices } from "../tailscale/client";
import { requireAuthentication } from "./auth";
import { HttpError, methodNotAllowed } from "./errors";
import { parseJson } from "./request";
import { apiJson } from "./response";

function importCredential(
	method: ProfileCreateRequest["credential"]["method"],
): ProfileCreateRequest["credential"] {
	if (method === "tailscale_ssh") return { method: "tailscale_ssh" };
	if (method === "password")
		return { method: "password", persistence: "prompt" };
	return {
		method: "private_key",
		persistence: "prompt",
		savePassphrase: false,
	};
}

function configurationRepository(env: Env): TailscaleConfigurationRepository {
	return new TailscaleConfigurationRepository(
		env.DB,
		env.CREDENTIAL_MASTER_KEY,
	);
}

async function getConfiguration(env: Env, ownerId: string): Promise<Response> {
	const configuration = await configurationRepository(env).get(ownerId, env);
	return apiJson(TailscaleConfigurationResponseSchema.parse(configuration));
}

async function updateConfiguration(
	request: Request,
	env: Env,
	ownerId: string,
): Promise<Response> {
	const input = await parseJson(
		request,
		TailscaleConfigurationUpdateRequestSchema,
	);
	const repository = configurationRepository(env);
	const current = await repository.get(ownerId, env);
	if (!input.apiToken && !current.apiTokenConfigured) {
		throw new HttpError(
			400,
			"VALIDATION_FAILED",
			"A Tailscale API token is required",
		);
	}
	if (input.apiToken && !env.CREDENTIAL_MASTER_KEY) {
		throw new HttpError(
			503,
			"AUTH_CONFIGURATION_MISSING",
			"Credential encryption is not configured",
		);
	}
	return apiJson(
		TailscaleConfigurationResponseSchema.parse(
			await repository.update(ownerId, input, env),
		),
	);
}

async function listDevices(env: Env, ownerId: string): Promise<Response> {
	const configuration = await configurationRepository(env).resolve(
		ownerId,
		env,
	);
	return apiJson(
		TailscaleDeviceListResponseSchema.parse(
			await fetchTailscaleDevices(configuration),
		),
	);
}

async function importDevices(
	request: Request,
	env: Env,
	ownerId: string,
): Promise<Response> {
	const input = await parseJson(request, TailscaleImportRequestSchema);
	if (env.SSH_TRANSPORT?.trim() !== "tailnet_connector") {
		throw new HttpError(
			400,
			"VALIDATION_FAILED",
			"Tailscale imports require tailnet_connector transport",
		);
	}
	const runtime = getRuntimeConfig(env);
	assertAllowedSshPort(input.port, runtime.allowedSshPorts);

	const configuration = await configurationRepository(env).resolve(
		ownerId,
		env,
	);
	const discovery = await fetchTailscaleDevices(configuration);
	const available = new Map(
		discovery.devices.map((device) => [device.id, device]),
	);
	const repository = new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY);
	const selectedHosts = input.deviceIds.flatMap((deviceId) => {
		const device = available.get(deviceId);
		return device?.authorized ? [device.host] : [];
	});
	const existing = await repository.listTargetsByHosts(ownerId, selectedHosts);
	const existingTargets = new Set(
		existing.map(
			(profile) =>
				`${normalizeHost(profile.host)}\u0000${profile.port}\u0000${profile.username}`,
		),
	);
	const username = input.username.trim();
	const result: TailscaleImportResponse = { created: [], skipped: [] };

	for (const deviceId of input.deviceIds) {
		const device = available.get(deviceId);
		if (!device) {
			result.skipped.push({
				deviceId,
				name: deviceId.slice(0, 100),
				reason: "missing_magic_dns",
			});
			continue;
		}
		if (!device.authorized) {
			result.skipped.push({
				deviceId,
				name: device.name,
				reason: "unauthorized",
			});
			continue;
		}
		const targetKey = `${device.host}\u0000${input.port}\u0000${username}`;
		if (existingTargets.has(targetKey)) {
			result.skipped.push({ deviceId, name: device.name, reason: "duplicate" });
			continue;
		}

		const profile = await repository.createFromRequest(ownerId, {
			name: device.name,
			host: device.host,
			port: input.port,
			username,
			notes: `Imported from Tailscale (${device.id})`,
			terminalType: "xterm-256color",
			encoding: "utf-8",
			initialCommand: null,
			credential: importCredential(input.authenticationMethod),
		});
		result.created.push(profile);
		existingTargets.add(targetKey);
	}

	return apiJson(TailscaleImportResponseSchema.parse(result), 201);
}

export async function routeTailscale(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	const auth = await requireAuthentication(request, env);
	if (path === "/api/tailscale/configuration") {
		if (request.method === "GET") return getConfiguration(env, auth.ownerId);
		if (request.method === "PUT")
			return updateConfiguration(request, env, auth.ownerId);
		return methodNotAllowed(["GET", "PUT"]);
	}
	if (path === "/api/tailscale/devices") {
		if (request.method === "GET") return listDevices(env, auth.ownerId);
		return methodNotAllowed(["GET"]);
	}
	if (path === "/api/tailscale/import") {
		if (request.method === "POST")
			return importDevices(request, env, auth.ownerId);
		return methodNotAllowed(["POST"]);
	}
	throw new HttpError(404, "NOT_FOUND", "Route not found");
}
