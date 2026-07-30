import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import type { Repositories } from "../storage";
import { SSHSessionAudit } from "./session-audit";
import type { SSHConnectionProfile } from "./types";

const profile: SSHConnectionProfile = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  profileName: "Production",
  host: "ssh.example.test",
  port: 22,
  username: "deploy",
  authentication: { kind: "password", password: "not-logged" },
  collectHistory: true,
  collectCommands: true
};

function repositorySpies() {
  const connectionSessions = {
    start: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined)
  };
  const sessionEvents = { append: vi.fn(async () => undefined) };
  const commands = { append: vi.fn(async () => undefined), prune: vi.fn(async () => 0) };
  const profiles = { markConnected: vi.fn(async () => undefined) };
  const securityEvents = { append: vi.fn(async () => undefined) };
  return {
    repositories: { connectionSessions, sessionEvents, commands, profiles, securityEvents } as unknown as Repositories,
    connectionSessions,
    sessionEvents,
    commands,
    profiles,
    securityEvents
  };
}

describe("SSH session audit", () => {
  it("serializes lifecycle, command, security, and final negotiated metadata", async () => {
    const spies = repositorySpies();
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const audit = await SSHSessionAudit.start({} as Env, sessionId, profile, spies.repositories);

    audit.state("tcp_connecting", "tcp_connecting", "Opening TCP connection");
    audit.hostKey("SHA256:fingerprint", "ssh-ed25519");
    audit.algorithms({
      keyExchange: "curve25519-sha256",
      hostKeyAlgorithm: "ssh-ed25519",
      cipherIn: "chacha20-poly1305@openssh.com",
      cipherOut: "chacha20-poly1305@openssh.com"
    }, false);
    audit.connected();
    audit.command("uname -a");
    audit.security("ssh_host_key_pinned", "Host key accepted");
    audit.algorithms({
      keyExchange: "curve25519-sha256",
      hostKeyAlgorithm: "ssh-ed25519",
      cipherIn: "aes256-gcm@openssh.com",
      cipherOut: "aes256-gcm@openssh.com"
    }, true);
    await audit.finish("closed", "user_disconnect", "User disconnected");

    expect(spies.connectionSessions.start).toHaveBeenCalledWith(profile.ownerId, expect.objectContaining({
      id: sessionId,
      profileName: profile.profileName,
      authenticationMethod: "password"
    }));
    expect(spies.commands.append).toHaveBeenCalledWith(profile.ownerId, expect.objectContaining({
      command: "uname -a",
      captureQuality: "best_effort"
    }));
    expect(spies.profiles.markConnected).toHaveBeenCalledWith(
      profile.ownerId,
      profile.profileId,
      profile.username,
      "SHA256:fingerprint"
    );
    expect(spies.securityEvents.append).toHaveBeenCalledWith(expect.objectContaining({ code: "ssh_host_key_pinned" }));
    const stateCalls = spies.connectionSessions.setState.mock.calls as unknown[][];
    expect(stateCalls.map((call) => call[2])).toEqual([
      "tcp_connecting",
      "ssh_handshake",
      "connected"
    ]);
    expect(stateCalls[0]?.[3]).toBeUndefined();
    expect(stateCalls[1]?.[3]).toBeUndefined();
    expect(stateCalls[2]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spies.connectionSessions.finish).toHaveBeenCalledWith(profile.ownerId, sessionId, expect.objectContaining({
      finalState: "closed",
      closeReason: "user_disconnect",
      hostKeyType: "ssh-ed25519",
      hostFingerprint: "SHA256:fingerprint",
      kexAlgorithm: "curve25519-sha256",
      cipherIn: "aes256-gcm@openssh.com"
    }));
    const eventCalls = spies.sessionEvents.append.mock.calls as unknown[][];
    expect(eventCalls.map((call) => call[2])).toEqual([
      "authorized",
      "tcp_connecting",
      "ssh_handshake_complete",
      "authentication_succeeded",
      "pty_opened",
      "shell_opened",
      "rekey_started",
      "rekey_completed",
      "disconnected"
    ]);
  });

  it("does not persist commands when either history switch is disabled", async () => {
    const spies = repositorySpies();
    const audit = await SSHSessionAudit.start(
      {} as Env,
      "44444444-4444-4444-8444-444444444444",
      { ...profile, collectCommands: false },
      spies.repositories
    );
    audit.command("whoami");
    await audit.finish("closed", "user_disconnect", "Done");
    expect(spies.commands.append).not.toHaveBeenCalled();
  });

  it("records Tailscale SSH as a distinct credentialless authentication method", async () => {
    const spies = repositorySpies();
    const tailscaleProfile: SSHConnectionProfile = {
      ...profile,
      port: 22,
      authentication: { kind: "tailscale-ssh" },
    };
    await SSHSessionAudit.start(
      {} as Env,
      "77777777-7777-4777-8777-777777777777",
      tailscaleProfile,
      spies.repositories,
    );

    expect(spies.connectionSessions.start).toHaveBeenCalledWith(
      tailscaleProfile.ownerId,
      expect.objectContaining({ authenticationMethod: "tailscale_ssh" }),
    );
  });

  it("finalizes the inserted session if the initial event write fails", async () => {
    const spies = repositorySpies();
    spies.sessionEvents.append.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(SSHSessionAudit.start(
      {} as Env,
      "55555555-5555-4555-8555-555555555555",
      profile,
      spies.repositories
    )).rejects.toThrow("D1 unavailable");
    expect(spies.connectionSessions.finish).toHaveBeenCalledWith(
      profile.ownerId,
      "55555555-5555-4555-8555-555555555555",
      { finalState: "error", closeReason: "internal_error" }
    );
  });

  it("finishes the session even if the final event write fails", async () => {
    const spies = repositorySpies();
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const audit = await SSHSessionAudit.start({} as Env, sessionId, profile, spies.repositories);
    spies.sessionEvents.append.mockRejectedValueOnce(new Error("D1 event write failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await audit.finish("error", "network_error", "Connection failed");
    consoleError.mockRestore();
    expect(spies.connectionSessions.finish).toHaveBeenCalledWith(profile.ownerId, sessionId, expect.objectContaining({
      finalState: "error",
      closeReason: "network_error"
    }));
  });
});
