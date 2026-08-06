import { describe, expect, it, vi } from "vitest";

import { fetchTailscaleDevices, parseTailscaleDevices } from "./client";

const now = Date.parse("2026-08-04T04:00:00.000Z");

describe("Tailscale device discovery", () => {
	it("keeps the configured Tailscale name separate from the OS hostname", () => {
		const devices = parseTailscaleDevices(
			{
				devices: [
					{
						id: "device-1",
						hostname: "alpha-os",
						name: "production-db.tail3870ff.ts.net.",
						addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
						os: "linux",
						authorized: true,
						lastSeen: "2026-08-04T03:58:30Z",
					},
					{
						id: "device-2",
						hostname: "short-name-only",
						name: "short-name-only",
						authorized: true,
					},
				],
			},
			now,
		);

		expect(devices).toEqual([
			{
				id: "device-1",
				displayName: "production-db",
				hostname: "alpha-os",
				host: "production-db.tail3870ff.ts.net",
				addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
				os: "linux",
				authorized: true,
				online: true,
				lastSeen: "2026-08-04T03:58:30.000Z",
			},
		]);
	});

	it("does not treat a future last-seen timestamp as online", () => {
		const [device] = parseTailscaleDevices(
			{
				devices: [
					{
						id: "device-future",
						hostname: "future",
						name: "future.example-tailnet.ts.net",
						authorized: true,
						lastSeen: "2026-08-04T04:01:00Z",
					},
				],
			},
			now,
		);

		expect(device).toMatchObject({ online: false });
	});

	it("deduplicates device identifiers from an invalid upstream response", () => {
		const devices = parseTailscaleDevices(
			{
				devices: [
					{
						id: "device-1",
						hostname: "alpha",
						name: "alpha.example-tailnet.ts.net",
						authorized: true,
					},
					{
						id: "device-1",
						hostname: "substituted",
						name: "substituted.example-tailnet.ts.net",
						authorized: true,
					},
				],
			},
			now,
		);

		expect(devices).toHaveLength(1);
		expect(devices[0]).toMatchObject({
			displayName: "alpha",
			hostname: "alpha",
			host: "alpha.example-tailnet.ts.net",
		});
	});

	it("prefers an explicit offline state over a recent last-seen timestamp", () => {
		const [device] = parseTailscaleDevices(
			{
				devices: [
					{
						id: "device-offline",
						hostname: "offline",
						name: "offline.example-tailnet.ts.net",
						authorized: true,
						online: false,
						lastSeen: "2026-08-04T03:59:00Z",
					},
				],
			},
			now,
		);

		expect(device).toMatchObject({ online: false });
	});

	it("uses HTTP Basic without exposing the token in the URL", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ devices: [] }),
		);
		await fetchTailscaleDevices(
			{
				TAILSCALE_TAILNET: "example.com",
				TAILSCALE_API_TOKEN: "tskey-api-test-token",
			},
			fetcher as typeof fetch,
		);

		expect(fetcher).toHaveBeenCalledOnce();
		const call = fetcher.mock.calls[0];
		expect(call).toBeDefined();
		const [url, init] = call!;
		expect(url).toBe(
			"https://api.tailscale.com/api/v2/tailnet/example.com/devices",
		);
		expect(String(url)).not.toContain("tskey-api-test-token");
		expect(init?.redirect).toBe("manual");
		expect(init?.headers).toMatchObject({
			Authorization: `Basic ${btoa("tskey-api-test-token:")}`,
		});
	});

	it("reports missing configuration without making a request", async () => {
		const fetcher = vi.fn();
		await expect(
			fetchTailscaleDevices({}, fetcher as typeof fetch),
		).rejects.toMatchObject({
			status: 503,
			code: "AUTH_CONFIGURATION_MISSING",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects non-ASCII tokens before constructing the authorization header", async () => {
		const fetcher = vi.fn();
		await expect(
			fetchTailscaleDevices(
				{
					TAILSCALE_TAILNET: "example.com",
					TAILSCALE_API_TOKEN: "tskey-api-invalid-密钥",
				},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			status: 503,
			code: "AUTH_CONFIGURATION_MISSING",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects an invalid tailnet name before making a request", async () => {
		const fetcher = vi.fn();
		await expect(
			fetchTailscaleDevices(
				{
					TAILSCALE_TAILNET: "invalid tailnet",
					TAILSCALE_API_TOKEN: "tskey-api-test-token",
				},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			status: 503,
			code: "AUTH_CONFIGURATION_MISSING",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects an oversized response from its declared content length", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response("{}", {
					headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
				}),
		);

		await expect(
			fetchTailscaleDevices(
				{
					TAILSCALE_TAILNET: "example.com",
					TAILSCALE_API_TOKEN: "tskey-api-test-token",
				},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			status: 502,
			code: "SERVICE_UNAVAILABLE",
		});
	});

	it("rejects an oversized response even without a content-length header", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
		);

		await expect(
			fetchTailscaleDevices(
				{
					TAILSCALE_TAILNET: "example.com",
					TAILSCALE_API_TOKEN: "tskey-api-test-token",
				},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			status: 502,
			code: "SERVICE_UNAVAILABLE",
		});
	});

	it("maps an interrupted response body to a retryable upstream error", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("upstream disconnected"));
						},
					}),
				),
		);

		await expect(
			fetchTailscaleDevices(
				{
					TAILSCALE_TAILNET: "example.com",
					TAILSCALE_API_TOKEN: "tskey-api-test-token",
				},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			status: 502,
			code: "SERVICE_UNAVAILABLE",
			options: { retryable: true },
		});
	});
});
