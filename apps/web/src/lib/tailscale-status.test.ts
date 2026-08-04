import { describe, expect, it } from "vitest";

import type { TailscaleDevice, TailscaleDeviceListResponse } from "@edgesh/contracts";

import { ApiError } from "./api";
import { tailscaleStatusFromDevices, tailscaleStatusFromError } from "./tailscale-status";

function device(id: string, online: boolean): TailscaleDevice {
  return {
    id,
    name: `node-${id}`,
    host: `node-${id}.tailnet.ts.net`,
    addresses: ["100.64.0.1"],
    os: "linux",
    authorized: true,
    online,
    lastSeen: "2026-08-04T00:00:00.000Z"
  };
}

function response(devices: TailscaleDevice[]): TailscaleDeviceListResponse {
  return { tailnet: "example.ts.net", devices };
}

describe("tailscaleStatusFromDevices", () => {
  it("summarizes online and offline device counts", () => {
    expect(tailscaleStatusFromDevices(response([device("a", true), device("b", false), device("c", true)]))).toEqual({
      kind: "ready",
      tailnet: "example.ts.net",
      total: 3,
      online: 2,
      offline: 1
    });
  });

  it("handles an empty tailnet", () => {
    expect(tailscaleStatusFromDevices(response([]))).toEqual({
      kind: "ready",
      tailnet: "example.ts.net",
      total: 0,
      online: 0,
      offline: 0
    });
  });
});

describe("tailscaleStatusFromError", () => {
  it("maps missing Tailscale configuration to not_configured", () => {
    const error = new ApiError("TAILSCALE_API_TOKEN is not configured", "AUTH_CONFIGURATION_MISSING", 503);
    expect(tailscaleStatusFromError(error)).toEqual({ kind: "not_configured" });
  });

  it("maps other API failures to error", () => {
    const error = new ApiError("upstream unavailable", "SERVICE_UNAVAILABLE", 502, true);
    expect(tailscaleStatusFromError(error)).toEqual({ kind: "error" });
  });

  it("maps non-API failures to error", () => {
    expect(tailscaleStatusFromError(new TypeError("network down"))).toEqual({ kind: "error" });
    expect(tailscaleStatusFromError("unknown")).toEqual({ kind: "error" });
  });
});
