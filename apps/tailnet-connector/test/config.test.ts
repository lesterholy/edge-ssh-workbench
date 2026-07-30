import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const validKey = Buffer.alloc(32, 7).toString("base64url");

describe("Tailnet Connector configuration", () => {
  it("uses locked-down defaults", () => {
    const config = loadConfig({ CONNECTOR_HMAC_KEY: validKey, TAILNET_ALLOWED_SUFFIX: "example-tailnet.ts.net" });
    expect(config.listenHost).toBe("127.0.0.1");
    expect([...config.allowedPorts]).toEqual([22]);
    expect(config.allowedSuffix).toBe("example-tailnet.ts.net");
  });

  it("rejects weak secrets, prohibited ports, and non-tailnet suffixes", () => {
    expect(() => loadConfig({ CONNECTOR_HMAC_KEY: "short" })).toThrow(/32-byte/);
    expect(() => loadConfig({
      CONNECTOR_HMAC_KEY: validKey,
      TAILNET_ALLOWED_SUFFIX: "example-tailnet.ts.net",
      TAILNET_ALLOWED_PORTS: "22,25",
    })).toThrow(/prohibited/);
    expect(() => loadConfig({ CONNECTOR_HMAC_KEY: validKey, TAILNET_ALLOWED_SUFFIX: "example.com" })).toThrow(/\.ts\.net/);
    expect(() => loadConfig({
      CONNECTOR_HMAC_KEY: validKey,
      TAILNET_ALLOWED_SUFFIX: "example-tailnet.ts.net",
      LISTEN_HOST: "0.0.0.0",
    })).toThrow(/loopback/);
    expect(() => loadConfig({ CONNECTOR_HMAC_KEY: validKey })).toThrow(/TAILNET_ALLOWED_SUFFIX/);
  });
});
