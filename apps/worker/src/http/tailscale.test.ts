import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { routeTailscale } from "./tailscale";

const mocks = vi.hoisted(() => ({
	requireAuthentication: vi.fn(),
	fetchTailscaleDevices: vi.fn(),
	listProfileTargets: vi.fn(),
	createProfile: vi.fn(),
	getTailscaleConfiguration: vi.fn(),
	resolveTailscaleConfiguration: vi.fn(),
	updateTailscaleConfiguration: vi.fn(),
}));

vi.mock("./auth", () => ({
	requireAuthentication: mocks.requireAuthentication,
}));

vi.mock("../tailscale/client", () => ({
	fetchTailscaleDevices: mocks.fetchTailscaleDevices,
}));

vi.mock("../storage/profiles", () => ({
	ProfileRepository: class {
		listTargetsByHosts = mocks.listProfileTargets;
		createFromRequest = mocks.createProfile;
	},
}));

vi.mock("../storage/tailscale-configuration", () => ({
	TailscaleConfigurationRepository: class {
		get = mocks.getTailscaleConfiguration;
		resolve = mocks.resolveTailscaleConfiguration;
		update = mocks.updateTailscaleConfiguration;
	},
}));

function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		DB: {} as D1Database,
		SSH_TRANSPORT: "tailnet_connector",
		TAILNET_CONNECTOR_URL: "https://connector.example.test/v1/connect",
		TAILNET_CONNECTOR_HMAC_KEY: "A".repeat(43),
		ALLOWED_SSH_PORTS: "22,7022",
		CREDENTIAL_MASTER_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
		...overrides,
	} as Env;
}

function importRequest(
	authenticationMethod: "tailscale_ssh" | "password" | "private_key",
	port = 22,
): Request {
	return new Request("https://workbench.test/api/tailscale/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			deviceIds: ["new", "duplicate", "unauthorized", "gone"],
			username: "root",
			port,
			authenticationMethod,
		}),
	});
}

describe("Tailscale device import route", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireAuthentication.mockResolvedValue({ ownerId: "usr_admin" });
		mocks.getTailscaleConfiguration.mockResolvedValue({
			tailnet: "example.com",
			apiTokenConfigured: true,
			configured: true,
		});
		mocks.resolveTailscaleConfiguration.mockResolvedValue({
			TAILSCALE_TAILNET: "example.com",
			TAILSCALE_API_TOKEN: "test-token",
		});
		mocks.updateTailscaleConfiguration.mockResolvedValue({
			tailnet: "example.com",
			apiTokenConfigured: true,
			configured: true,
		});
		mocks.fetchTailscaleDevices.mockResolvedValue({
			tailnet: "example.com",
			devices: [
				{
					id: "new",
					name: "alpha",
					host: "alpha.tail1234.ts.net",
					addresses: [],
					os: "linux",
					authorized: true,
					online: true,
					lastSeen: null,
				},
				{
					id: "duplicate",
					name: "beta",
					host: "beta.tail1234.ts.net",
					addresses: [],
					os: "linux",
					authorized: true,
					online: true,
					lastSeen: null,
				},
				{
					id: "unauthorized",
					name: "gamma",
					host: "gamma.tail1234.ts.net",
					addresses: [],
					os: "linux",
					authorized: false,
					online: false,
					lastSeen: null,
				},
			],
		});
		mocks.listProfileTargets.mockResolvedValue([
			{
				host: "beta.tail1234.ts.net",
				port: 22,
				username: "root",
			},
		]);
		mocks.createProfile.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			name: "alpha",
			host: "alpha.tail1234.ts.net",
			port: 22,
			username: "root",
			notes: "Imported from Tailscale (new)",
			authenticationMethod: "tailscale_ssh",
			credentialPersistence: "none",
			hasPassword: false,
			hasPrivateKey: false,
			hasPassphrase: false,
			terminalType: "xterm-256color",
			encoding: "utf-8",
			initialCommand: null,
			lastConnectedAt: null,
			lastSuccessfulUsername: null,
			lastHostKeyFingerprint: null,
			createdAt: "2026-08-04T04:00:00.000Z",
			updatedAt: "2026-08-04T04:00:00.000Z",
		});
	});

	it("returns configuration status without exposing the API token", async () => {
		const response = await routeTailscale(
			new Request("https://workbench.test/api/tailscale/configuration"),
			testEnv(),
			"/api/tailscale/configuration",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tailnet: "example.com",
			apiTokenConfigured: true,
			configured: true,
		});
	});

	it("requires a token when no stored or environment token exists", async () => {
		mocks.getTailscaleConfiguration.mockResolvedValue({
			tailnet: null,
			apiTokenConfigured: false,
			configured: false,
		});
		const request = new Request(
			"https://workbench.test/api/tailscale/configuration",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tailnet: "example.com" }),
			},
		);

		await expect(
			routeTailscale(request, testEnv(), "/api/tailscale/configuration"),
		).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
		expect(mocks.updateTailscaleConfiguration).not.toHaveBeenCalled();
	});

	it("saves a new configuration through the repository", async () => {
		mocks.getTailscaleConfiguration.mockResolvedValue({
			tailnet: null,
			apiTokenConfigured: false,
			configured: false,
		});
		const request = new Request(
			"https://workbench.test/api/tailscale/configuration",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tailnet: "example.com",
					apiToken: "tskey-api-new-token",
				}),
			},
		);

		const response = await routeTailscale(
			request,
			testEnv(),
			"/api/tailscale/configuration",
		);

		expect(response.status).toBe(200);
		expect(mocks.updateTailscaleConfiguration).toHaveBeenCalledWith(
			"usr_admin",
			{ tailnet: "example.com", apiToken: "tskey-api-new-token" },
			expect.objectContaining({ TAILNET_CONNECTOR_URL: expect.any(String) }),
		);
		expect(JSON.stringify(await response.json())).not.toContain(
			"tskey-api-new-token",
		);
	});

	it("rechecks discovery and skips duplicate, unauthorized, and missing devices", async () => {
		const response = await routeTailscale(
			importRequest("tailscale_ssh"),
			testEnv(),
			"/api/tailscale/import",
		);
		const body = (await response.json()) as {
			created: Array<{ id: string }>;
			skipped: Array<{ deviceId: string; reason: string }>;
		};

		expect(response.status).toBe(201);
		expect(body.created).toEqual([
			expect.objectContaining({
				id: "11111111-1111-4111-8111-111111111111",
				name: "alpha",
			}),
		]);
		expect(body.skipped).toEqual([
			{ deviceId: "duplicate", name: "beta", reason: "duplicate" },
			{ deviceId: "unauthorized", name: "gamma", reason: "unauthorized" },
			{ deviceId: "gone", name: "gone", reason: "missing_magic_dns" },
		]);
		expect(mocks.fetchTailscaleDevices).toHaveBeenCalledOnce();
		expect(mocks.listProfileTargets).toHaveBeenCalledWith("usr_admin", [
			"alpha.tail1234.ts.net",
			"beta.tail1234.ts.net",
		]);
		expect(mocks.createProfile).toHaveBeenCalledOnce();
		expect(mocks.createProfile).toHaveBeenCalledWith(
			"usr_admin",
			expect.objectContaining({
				host: "alpha.tail1234.ts.net",
				port: 22,
				username: "root",
				credential: { method: "tailscale_ssh" },
			}),
		);
	});

	it("creates private-key profiles in prompt-only mode", async () => {
		mocks.listProfileTargets.mockResolvedValue([]);
		mocks.createProfile.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			name: "alpha",
			host: "alpha.tail1234.ts.net",
			port: 7022,
			username: "root",
			notes: "Imported from Tailscale (new)",
			authenticationMethod: "private_key",
			credentialPersistence: "prompt",
			hasPassword: false,
			hasPrivateKey: false,
			hasPassphrase: false,
			terminalType: "xterm-256color",
			encoding: "utf-8",
			initialCommand: null,
			lastConnectedAt: null,
			lastSuccessfulUsername: null,
			lastHostKeyFingerprint: null,
			createdAt: "2026-08-04T04:00:00.000Z",
			updatedAt: "2026-08-04T04:00:00.000Z",
		});
		const request = importRequest("private_key", 7022);
		const body = (await request.json()) as { deviceIds: string[] };
		body.deviceIds = ["new"];

		const response = await routeTailscale(
			new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			}),
			testEnv(),
			"/api/tailscale/import",
		);

		expect(response.status).toBe(201);
		expect(mocks.createProfile).toHaveBeenCalledWith(
			"usr_admin",
			expect.objectContaining({
				port: 7022,
				credential: {
					method: "private_key",
					persistence: "prompt",
					savePassphrase: false,
				},
			}),
		);
	});

	it("rejects imports when the Worker is not using the Tailnet Connector", async () => {
		await expect(
			routeTailscale(
				importRequest("tailscale_ssh"),
				testEnv({ SSH_TRANSPORT: "direct" }),
				"/api/tailscale/import",
			),
		).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
		expect(mocks.fetchTailscaleDevices).not.toHaveBeenCalled();
	});
});
