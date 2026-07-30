import { describe, expect, it } from "vitest";
import { CloudflareSSHTransportFactory } from "./cloudflare-transport";

describe("Cloudflare SSH transport policy", () => {
  it("enforces ALLOWED_SSH_PORTS before DNS or socket access", async () => {
    const transport = new CloudflareSSHTransportFactory(new Set([22, 2222]));
    await expect(transport.connect("ssh.example.test", 2200, 1_000)).rejects.toMatchObject({
      code: "PROHIBITED_PORT"
    });
  });

  it("always prohibits outbound SMTP port 25", async () => {
    const transport = new CloudflareSSHTransportFactory(null);
    await expect(transport.connect("ssh.example.test", 25, 1_000)).rejects.toMatchObject({
      code: "PROHIBITED_PORT"
    });
  });
});
