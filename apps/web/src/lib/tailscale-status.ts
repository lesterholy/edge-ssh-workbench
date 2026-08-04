import type { TailscaleDeviceListResponse } from "@edgesh/contracts";

import { ApiError } from "./api";

export type TailscaleStatus =
  | { kind: "loading" }
  | { kind: "ready"; tailnet: string; total: number; online: number; offline: number }
  | { kind: "not_configured" }
  | { kind: "error" };

export function tailscaleStatusFromDevices(response: TailscaleDeviceListResponse): TailscaleStatus {
  const total = response.devices.length;
  const online = response.devices.filter((device) => device.online).length;
  return { kind: "ready", tailnet: response.tailnet, total, online, offline: total - online };
}

export function tailscaleStatusFromError(error: unknown): TailscaleStatus {
  if (error instanceof ApiError && error.code === "AUTH_CONFIGURATION_MISSING") {
    return { kind: "not_configured" };
  }
  return { kind: "error" };
}
