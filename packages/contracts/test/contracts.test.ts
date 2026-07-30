import { describe, expect, it } from "vitest";

import {
  AuthStateSchema,
  BinaryFrameHeaderSchema,
  ClientResizeMessageSchema,
  ProfileCreateRequestSchema,
  ProfileResponseSchema,
  ServerMetricsMessageSchema,
  ServerTransferProgressMessageSchema,
  SettingsPatchRequestSchema,
  TAILNET_CONNECTOR_PROTOCOL_VERSION,
  TailnetConnectorHandshakeSchema,
  canonicalizeTailnetConnectorHandshake,
  WS_PROTOCOL_VERSION,
} from "../src/index";

const id = "cc6f137f-5da4-44cf-a5a4-8e017ecb7a77";
const now = "2026-07-28T07:00:00Z";

describe("public contracts", () => {
  it("models Tailscale SSH as a credentialless port-22 profile", () => {
    const input = ProfileCreateRequestSchema.parse({
      name: "tailnet-vps",
      host: "vps-01.example-tailnet.ts.net",
      port: 22,
      username: "root",
      notes: "",
      terminalType: "xterm-256color",
      encoding: "utf-8",
      initialCommand: null,
      credential: { method: "tailscale_ssh" },
    });
    expect(input.credential).toEqual({ method: "tailscale_ssh" });
    expect(ProfileCreateRequestSchema.safeParse({ ...input, port: 7022 }).success).toBe(false);
    expect(ProfileCreateRequestSchema.safeParse({
      ...input,
      credential: { method: "tailscale_ssh", password: "must-not-be-accepted" },
    }).success).toBe(false);
    const response = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      notes: input.notes,
      authenticationMethod: "tailscale_ssh",
      credentialPersistence: "none",
      hasPassword: false,
      hasPrivateKey: false,
      hasPassphrase: false,
      terminalType: input.terminalType,
      encoding: input.encoding,
      initialCommand: null,
      lastConnectedAt: null,
      lastSuccessfulUsername: null,
      lastHostKeyFingerprint: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(ProfileResponseSchema.safeParse(response).success).toBe(true);
    expect(ProfileResponseSchema.safeParse({ ...response, port: 7022 }).success).toBe(false);
  });

  it("rejects unknown profile response fields, including credentials", () => {
    const result = ProfileResponseSchema.safeParse({
      id,
      name: "prod",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      notes: "",
      authenticationMethod: "password",
      credentialPersistence: "saved",
      hasPassword: true,
      hasPrivateKey: false,
      hasPassphrase: false,
      terminalType: "xterm-256color",
      encoding: "utf-8",
      initialCommand: null,
      lastConnectedAt: null,
      lastSuccessfulUsername: null,
      lastHostKeyFingerprint: null,
      createdAt: now,
      updatedAt: now,
      password: "must-not-cross-the-response-boundary",
    });

    expect(result.success).toBe(false);
  });

  it("uses an unambiguous auth-state discriminator", () => {
    expect(
      AuthStateSchema.parse({
        status: "totp_required",
        authenticated: false,
        totpEnabled: true,
        totpRequired: true,
      }),
    ).toMatchObject({ status: "totp_required" });
  });

  it("exposes Google login availability only on anonymous auth state", () => {
    expect(
      AuthStateSchema.parse({
        status: "anonymous",
        authenticated: false,
        totpEnabled: false,
        totpRequired: false,
        googleLoginEnabled: true,
      }),
    ).toMatchObject({ status: "anonymous", googleLoginEnabled: true });

    expect(
      AuthStateSchema.safeParse({
        status: "anonymous",
        authenticated: false,
        totpEnabled: false,
        totpRequired: false,
      }).success,
    ).toBe(false);

    expect(
      AuthStateSchema.safeParse({
        status: "authenticated",
        authenticated: true,
        totpEnabled: false,
        totpRequired: false,
        session: { createdAt: now, expiresAt: now },
      }).success,
    ).toBe(true);
  });

  it("rejects empty and unknown settings patches", () => {
    expect(SettingsPatchRequestSchema.safeParse({}).success).toBe(false);
    expect(SettingsPatchRequestSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(SettingsPatchRequestSchema.safeParse({ terminal: {} }).success).toBe(false);
  });

  it("requires transfer metadata only for SFTP binary frames", () => {
    expect(
      BinaryFrameHeaderSchema.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        kind: "sftp-upload-chunk",
        sessionId: id,
        sequence: 0,
        payloadBytes: 1024,
      }).success,
    ).toBe(false);

    expect(
      BinaryFrameHeaderSchema.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        kind: "terminal-input",
        sessionId: id,
        sequence: 0,
        payloadBytes: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects resize control messages from another protocol version", () => {
    expect(
      ClientResizeMessageSchema.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION + 1,
        requestId: id,
        type: "resize",
        attemptId: id,
        columns: 120,
        rows: 40,
      }).success,
    ).toBe(false);
  });

  it("rejects progress offsets beyond total size", () => {
    expect(
      ServerTransferProgressMessageSchema.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        sessionId: id,
        type: "transfer-progress",
        transferId: id,
        direction: "upload",
        status: "transferring",
        path: "/tmp/archive.tar",
        transferredBytes: 101,
        totalBytes: 100,
        bytesPerSecond: 20,
        estimatedSecondsRemaining: 0,
        acknowledgedOffset: 100,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });

  it("requires a value whenever a metric is supported", () => {
    expect(
      ServerMetricsMessageSchema.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        sessionId: id,
        type: "metrics",
        sampledAt: now,
        cpu: { support: "supported", value: null },
        memory: { support: "unsupported", value: null },
        swap: { support: "unsupported", value: null },
        rootDisk: { support: "unsupported", value: null },
        processes: { support: "unsupported", value: null },
      }).success,
    ).toBe(false);
  });

  it("uses a stable Tailnet Connector signing payload", () => {
    const handshake = TailnetConnectorHandshakeSchema.parse({
      version: TAILNET_CONNECTOR_PROTOCOL_VERSION,
      sessionId: id,
      host: "web-1.example-tailnet.ts.net",
      port: 22,
      expiresAt: 1_785_283_230_000,
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(canonicalizeTailnetConnectorHandshake(handshake)).toBe(
      '[1,"cc6f137f-5da4-44cf-a5a4-8e017ecb7a77","web-1.example-tailnet.ts.net",22,1785283230000,"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]',
    );
  });
});
