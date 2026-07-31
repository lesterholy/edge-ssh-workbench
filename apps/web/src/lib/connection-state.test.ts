import { describe, expect, it } from "vitest";

import type { SessionState } from "@edgesh/contracts";
import { isSessionBusy, isSessionConnecting } from "./connection-state";

describe("connection state", () => {
  it.each<SessionState>([
    "authorizing",
    "tcp_connecting",
    "ssh_handshake",
    "host_confirmation",
    "authenticating",
  ])("treats %s as connecting and busy", (state) => {
    expect(isSessionConnecting(state)).toBe(true);
    expect(isSessionBusy(state)).toBe(true);
  });

  it.each<SessionState>(["connected", "disconnecting"])("treats %s as busy but not connecting", (state) => {
    expect(isSessionConnecting(state)).toBe(false);
    expect(isSessionBusy(state)).toBe(true);
  });

  it.each<SessionState>(["idle", "closed", "error"])("allows connecting again from %s", (state) => {
    expect(isSessionConnecting(state)).toBe(false);
    expect(isSessionBusy(state)).toBe(false);
  });
});
