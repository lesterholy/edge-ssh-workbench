import {
	TailscaleDeviceListResponseSchema,
	type TailscaleDevice,
	type TailscaleDeviceListResponse,
} from "@edgesh/contracts";

import { normalizeHost } from "../security/network";
import { HttpError } from "../http/errors";

const API_BASE = "https://api.tailscale.com/api/v2";
const ONLINE_WINDOW_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type Fetcher = typeof fetch;

interface TailscaleApiConfig {
	tailnet: string;
	token: string;
}

export interface TailscaleApiBindings {
	TAILSCALE_TAILNET?: string;
	TAILSCALE_API_TOKEN?: string;
}

function configuredValue(
	value: string | undefined,
	name: string,
	maxLength: number,
): string {
	const normalized = value?.trim();
	if (
		!normalized ||
		normalized.length > maxLength ||
		/[\u0000-\u001f\u007f]/.test(normalized)
	) {
		throw new HttpError(
			503,
			"AUTH_CONFIGURATION_MISSING",
			`${name} is not configured`,
		);
	}
	return normalized;
}

function configuration(env: TailscaleApiBindings): TailscaleApiConfig {
	const config = {
		tailnet: configuredValue(env.TAILSCALE_TAILNET, "TAILSCALE_TAILNET", 256),
		token: configuredValue(
			env.TAILSCALE_API_TOKEN,
			"TAILSCALE_API_TOKEN",
			4_096,
		),
	};
	if (!/^[\x21-\x7e]+$/.test(config.token)) {
		throw new HttpError(
			503,
			"AUTH_CONFIGURATION_MISSING",
			"TAILSCALE_API_TOKEN is invalid",
		);
	}
	if (
		config.tailnet !== "-" &&
		!/^[A-Za-z0-9](?:[A-Za-z0-9.@_+-]{0,254}[A-Za-z0-9])?$/.test(config.tailnet)
	) {
		throw new HttpError(
			503,
			"AUTH_CONFIGURATION_MISSING",
			"TAILSCALE_TAILNET is invalid",
		);
	}
	return config;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized &&
		normalized.length <= maxLength &&
		!/[\u0000-\u001f\u007f]/.test(normalized)
		? normalized
		: null;
}

function timestamp(value: unknown): string | null {
	const normalized = text(value, 64);
	if (!normalized) return null;
	const milliseconds = Date.parse(normalized);
	return Number.isFinite(milliseconds)
		? new Date(milliseconds).toISOString()
		: null;
}

function magicDnsHost(value: unknown): string | null {
	const candidate = text(value, 254)?.toLowerCase().replace(/\.$/, "");
	if (!candidate || !candidate.endsWith(".ts.net")) return null;
	try {
		return normalizeHost(candidate);
	} catch {
		return null;
	}
}

function deviceDisplayName(host: string): string {
	return host.split(".")[0]?.slice(0, 100) || host.slice(0, 100);
}

function addresses(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.flatMap((entry) => {
				const address = text(entry, 64);
				return address && /^[0-9a-f:.]+$/i.test(address)
					? [address.toLowerCase()]
					: [];
			}),
		),
	].slice(0, 16);
}

export function parseTailscaleDevices(
	payload: unknown,
	now = Date.now(),
): TailscaleDevice[] {
	const root = record(payload);
	if (!root || !Array.isArray(root.devices) || root.devices.length > 5_000) {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Tailscale returned an invalid device response",
			{ retryable: true },
		);
	}

	const devices: TailscaleDevice[] = [];
	const seenIds = new Set<string>();
	for (const value of root.devices) {
		const raw = record(value);
		if (!raw) continue;
		const id = text(raw.id, 128);
		const host = magicDnsHost(raw.name);
		if (!id || !host || seenIds.has(id)) continue;
		seenIds.add(id);
		const lastSeen = timestamp(raw.lastSeen);
		const lastSeenAt = lastSeen === null ? Number.NaN : Date.parse(lastSeen);
		const recentlySeen =
			Number.isFinite(lastSeenAt) &&
			now >= lastSeenAt &&
			now - lastSeenAt <= ONLINE_WINDOW_MS;
		const online =
			typeof raw.online === "boolean"
				? raw.online
				: typeof raw.connectedToControl === "boolean"
					? raw.connectedToControl
					: recentlySeen;
		devices.push({
			id,
			displayName: deviceDisplayName(host),
			hostname: text(raw.hostname, 255),
			host,
			addresses: addresses(raw.addresses),
			os: text(raw.os, 64),
			authorized: raw.authorized === true,
			online,
			lastSeen,
		});
		if (devices.length >= 500) break;
	}

	return devices.sort(
		(left, right) =>
			Number(right.online) - Number(left.online) ||
			left.displayName.localeCompare(right.displayName),
	);
}

async function readBoundedBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel("Tailscale device response is too large");
				throw new HttpError(
					502,
					"SERVICE_UNAVAILABLE",
					"Tailscale device response is too large",
					{ retryable: true },
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Tailscale returned invalid UTF-8",
			{ retryable: true },
		);
	}
}

export async function fetchTailscaleDevices(
	env: TailscaleApiBindings,
	fetcher: Fetcher = fetch,
): Promise<TailscaleDeviceListResponse> {
	const config = configuration(env);
	const url = `${API_BASE}/tailnet/${encodeURIComponent(config.tailnet)}/devices`;
	let response: Response;
	try {
		response = await fetcher(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Basic ${btoa(`${config.token}:`)}`,
			},
			// Workerd rejects redirect="error"; manual keeps credentials from following redirects.
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Unable to reach the Tailscale API",
			{ retryable: true },
		);
	}

	if (response.status === 401 || response.status === 403) {
		throw new HttpError(
			502,
			"AUTH_CONFIGURATION_MISSING",
			"Tailscale rejected the configured API token",
		);
	}
	if (response.status === 429) {
		throw new HttpError(
			503,
			"RATE_LIMITED",
			"Tailscale API rate limit reached",
			{
				retryable: true,
				retryAfterSeconds: 30,
			},
		);
	}
	if (!response.ok) {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Tailscale device discovery failed",
			{ retryable: true },
		);
	}

	const declaredLength = Number(response.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Tailscale device response is too large",
			{ retryable: true },
		);
	}
	let body: string;
	try {
		body = await readBoundedBody(response);
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Unable to read the Tailscale device response",
			{ retryable: true },
		);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new HttpError(
			502,
			"SERVICE_UNAVAILABLE",
			"Tailscale returned invalid JSON",
			{ retryable: true },
		);
	}
	return TailscaleDeviceListResponseSchema.parse({
		tailnet: config.tailnet,
		devices: parseTailscaleDevices(payload),
	});
}
