import type { SessionCloseReason, SessionEventCode, SessionState } from "@edgesh/contracts";
import type { Env } from "../env";
import { createRepositories, type Repositories } from "../storage";
import type { SSHConnectionProfile } from "./types";

export interface NegotiatedSSHAlgorithms {
  keyExchange: string;
  hostKeyAlgorithm: string;
  cipherIn: string;
  cipherOut: string;
}

export class SSHSessionAudit {
  private chain: Promise<void> = Promise.resolve();
  private finalized = false;
  private connectedAt: string | null = null;
  private hostKeyType: string | null = null;
  private hostFingerprint: string | null = null;
  private negotiated: NegotiatedSSHAlgorithms | null = null;

  private constructor(
    private readonly repositories: Repositories,
    readonly sessionId: string,
    readonly profile: SSHConnectionProfile
  ) {}

  static async start(
    env: Env,
    sessionId: string,
    profile: SSHConnectionProfile,
    repositories: Repositories = createRepositories(env)
  ): Promise<SSHSessionAudit> {
    const audit = new SSHSessionAudit(repositories, sessionId, profile);
    await repositories.connectionSessions.start(profile.ownerId, {
      id: sessionId,
      profileId: profile.profileId,
      profileName: profile.profileName,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authenticationMethod: profile.authentication.kind === "password" ? "password" : "private_key"
    });
    try {
      await repositories.sessionEvents.append(profile.ownerId, sessionId, "authorized", "SSH session authorization accepted");
    } catch (error) {
      await repositories.connectionSessions.finish(profile.ownerId, sessionId, {
        finalState: "error",
        closeReason: "internal_error"
      }).catch(() => undefined);
      throw error;
    }
    return audit;
  }

  state(state: SessionState, event: SessionEventCode, message: string): void {
    const connectedAt = this.connectedAt ?? undefined;
    this.enqueue(async () => {
      await this.repositories.connectionSessions.setState(this.profile.ownerId, this.sessionId, state, connectedAt);
      await this.repositories.sessionEvents.append(this.profile.ownerId, this.sessionId, event, message);
    });
  }

  hostKey(fingerprint: string, keyType: string): void {
    this.hostFingerprint = fingerprint;
    this.hostKeyType = keyType;
  }

  algorithms(value: NegotiatedSSHAlgorithms, rekey: boolean): void {
    this.negotiated = value;
    if (rekey) {
      this.enqueue(async () => {
        await this.repositories.sessionEvents.append(
          this.profile.ownerId,
          this.sessionId,
          "rekey_started",
          "SSH transport key renegotiation started"
        );
        await this.repositories.sessionEvents.append(
          this.profile.ownerId,
          this.sessionId,
          "rekey_completed",
          "SSH transport keys renegotiated"
        );
      });
      return;
    }
    this.state("ssh_handshake", "ssh_handshake_complete", "SSH transport handshake completed");
  }

  connected(): void {
    this.connectedAt ??= new Date().toISOString();
    this.enqueue(async () => {
      await this.repositories.connectionSessions.setState(this.profile.ownerId, this.sessionId, "connected", this.connectedAt ?? undefined);
      await this.repositories.sessionEvents.append(this.profile.ownerId, this.sessionId, "authentication_succeeded", "SSH authentication succeeded");
      await this.repositories.sessionEvents.append(this.profile.ownerId, this.sessionId, "pty_opened", "SSH pseudo-terminal opened");
      await this.repositories.sessionEvents.append(this.profile.ownerId, this.sessionId, "shell_opened", "SSH interactive shell opened");
      if (this.hostFingerprint) {
        await this.repositories.profiles.markConnected(
          this.profile.ownerId,
          this.profile.profileId,
          this.profile.username,
          this.hostFingerprint
        );
      }
    });
  }

  command(command: string): void {
    if (!this.profile.collectHistory || !this.profile.collectCommands) return;
    this.enqueue(async () => {
      await this.repositories.commands.append(this.profile.ownerId, {
        sessionId: this.sessionId,
        profileId: this.profile.profileId,
        profileName: this.profile.profileName,
        host: this.profile.host,
        username: this.profile.username,
        command,
        captureQuality: "best_effort"
      });
      await this.repositories.commands.prune(this.profile.ownerId);
    });
  }

  security(code: string, message: string): void {
    this.enqueue(async () => {
      await this.repositories.securityEvents.append({
        ownerId: this.profile.ownerId,
        code,
        sourceIpHash: null,
        message
      });
    });
  }

  async finish(finalState: "closed" | "error", closeReason: SessionCloseReason, message: string): Promise<void> {
    if (this.finalized) return this.chain;
    this.finalized = true;
    this.enqueue(async () => {
      try {
        await this.repositories.sessionEvents.append(
          this.profile.ownerId,
          this.sessionId,
          finalState === "error" ? "error" : "disconnected",
          message
        );
      } finally {
        await this.repositories.connectionSessions.finish(this.profile.ownerId, this.sessionId, {
          finalState,
          closeReason,
          connectedAt: this.connectedAt,
          hostKeyType: this.hostKeyType,
          hostFingerprint: this.hostFingerprint,
          kexAlgorithm: this.negotiated?.keyExchange,
          cipherIn: this.negotiated?.cipherIn,
          cipherOut: this.negotiated?.cipherOut
        });
      }
    });
    return this.chain;
  }

  private enqueue(operation: () => Promise<void>): void {
    this.chain = this.chain.then(operation).catch((error: unknown) => {
      console.error("SSH session audit write failed", error instanceof Error ? error.message : "unknown error");
    });
  }
}
