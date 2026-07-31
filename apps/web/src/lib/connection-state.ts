import type { SessionState } from "@edgesh/contracts";

const CONNECTING_STATES = new Set<SessionState>([
  "authorizing",
  "tcp_connecting",
  "ssh_handshake",
  "host_confirmation",
  "authenticating",
]);

export function isSessionConnecting(state: SessionState): boolean {
  return CONNECTING_STATES.has(state);
}

export function isSessionBusy(state: SessionState): boolean {
  return isSessionConnecting(state) || state === "connected" || state === "disconnecting";
}
