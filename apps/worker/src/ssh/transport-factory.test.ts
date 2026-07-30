import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../env";
import { CloudflareSSHTransportFactory } from "./cloudflare-transport";
import { TailnetConnectorTransportFactory } from "./tailnet-connector-transport";
import { createSSHTransportFactory } from "./transport-factory";

const base: RuntimeConfig = {
  appEnv: "test",
  allowedOrigins: [],
  connectTimeoutMs: 10_000,
  maxSessionsPerUser: 5,
  allowedSshPorts: new Set([22]),
  sshTransport: "direct",
  tailnetConnector: null
};

describe("SSH transport selection", () => {
  it("keeps direct transport as the default path", () => {
    expect(createSSHTransportFactory(base, crypto.randomUUID())).toBeInstanceOf(CloudflareSSHTransportFactory);
  });

  it("selects the deployment-level Tailnet Connector path", () => {
    const factory = createSSHTransportFactory({
      ...base,
      sshTransport: "tailnet_connector",
      tailnetConnector: {
        url: "wss://connector.example.test/v1/connect",
        hmacKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
      }
    }, crypto.randomUUID());
    expect(factory).toBeInstanceOf(TailnetConnectorTransportFactory);
  });
});
