import { describe, expect, it } from "vitest";
import { resolveTailnetTarget } from "../src/targets";

const sshOnly = new Set([22]);

describe("Tailnet target policy", () => {
  it("rejects literal IPs and non-allowlisted ports", async () => {
    await expect(resolveTailnetTarget("100.64.0.1", 22, sshOnly, "example-tailnet.ts.net")).rejects.toThrow(/Literal/);
    await expect(resolveTailnetTarget("fd7a:115c:a1e0::1", 22, sshOnly, "example-tailnet.ts.net")).rejects.toThrow(/Literal/);
    await expect(resolveTailnetTarget("db-1.example-tailnet.ts.net", 443, sshOnly, "example-tailnet.ts.net")).rejects.toThrow(/port/);
  });

  it("pins allowed MagicDNS names to verified Tailnet results", async () => {
    const result = await resolveTailnetTarget(
      "db-1.example-tailnet.ts.net",
      22,
      sshOnly,
      "example-tailnet.ts.net",
      async () => [
        { address: "100.100.10.20", family: 4 },
        { address: "fd7a:115c:a1e0::20", family: 6 },
      ],
    );
    expect(result.addresses).toEqual([
      { address: "100.100.10.20", family: 4 },
      { address: "fd7a:115c:a1e0::20", family: 6 },
    ]);
  });

  it("rejects suffix confusion and mixed public DNS answers", async () => {
    await expect(resolveTailnetTarget(
      "db-1.example-tailnet.ts.net.attacker.test",
      22,
      sshOnly,
      "example-tailnet.ts.net",
      async () => [{ address: "100.100.10.20", family: 4 }],
    )).rejects.toThrow(/suffix/);
    await expect(resolveTailnetTarget(
      "db-1.example-tailnet.ts.net",
      22,
      sshOnly,
      "example-tailnet.ts.net",
      async () => [
        { address: "100.100.10.20", family: 4 },
        { address: "203.0.113.10", family: 4 },
      ],
    )).rejects.toThrow(/non-Tailscale/);
  });
});
