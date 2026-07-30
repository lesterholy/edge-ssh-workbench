import { describe, expect, it } from "vitest";

import { getRuntimeConfig, type Env } from "./env";

const hmacKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("SSH transport runtime configuration", () => {
  it("defaults to direct transport without requiring Connector secrets", () => {
    const config = getRuntimeConfig({} as Env);
    expect(config.sshTransport).toBe("direct");
    expect(config.tailnetConnector).toBeNull();
  });

  it("parses a Tailnet Connector and an optional complete Access service token", () => {
    const config = getRuntimeConfig({
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "wss://connector.example.test/v1/connect",
      TAILNET_CONNECTOR_HMAC_KEY: hmacKey,
      TAILNET_CONNECTOR_ACCESS_CLIENT_ID: "client-id.access",
      TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET: "access-secret"
    } as Env);
    expect(config.tailnetConnector).toEqual({
      url: "wss://connector.example.test/v1/connect",
      hmacKey,
      accessClientId: "client-id.access",
      accessClientSecret: "access-secret"
    });
  });

  it("rejects incomplete, insecure, or malformed Connector configuration", () => {
    expect(() => getRuntimeConfig({ SSH_TRANSPORT: "unknown" } as Env)).toThrow("SSH_TRANSPORT");
    expect(() => getRuntimeConfig({
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "http://connector.example.test/tunnel",
      TAILNET_CONNECTOR_HMAC_KEY: hmacKey
    } as Env)).toThrow("wss:// or https://");
    expect(() => getRuntimeConfig({
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "wss://connector.example.test/tunnel",
      TAILNET_CONNECTOR_HMAC_KEY: hmacKey
    } as Env)).toThrow("/v1/connect");
    expect(() => getRuntimeConfig({
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "wss://connector.example.test/v1/connect",
      TAILNET_CONNECTOR_HMAC_KEY: hmacKey,
      TAILNET_CONNECTOR_ACCESS_CLIENT_ID: "client-id.access"
    } as Env)).toThrow("configured together");
    expect(() => getRuntimeConfig({
      SSH_TRANSPORT: "tailnet_connector",
      TAILNET_CONNECTOR_URL: "wss://connector.example.test/v1/connect",
      TAILNET_CONNECTOR_HMAC_KEY: "not-a-32-byte-key"
    } as Env)).toThrow("base64url-encoded 32-byte");
  });
});
