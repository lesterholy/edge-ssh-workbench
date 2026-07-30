import { describe, expect, it } from "vitest";

import { sshClientAuthenticationOptions } from "./ssh2-engine";

describe("SSH client authentication options", () => {
  it("uses only none authentication for Tailscale SSH", () => {
    const options = sshClientAuthenticationOptions({ kind: "tailscale-ssh" });

    expect(options).toEqual({ authHandler: ["none"] });
    expect(options).not.toHaveProperty("password");
    expect(options).not.toHaveProperty("privateKey");
  });

  it("keeps credential authentication separate", () => {
    expect(sshClientAuthenticationOptions({ kind: "password", password: "secret" }))
      .toEqual({ password: "secret" });
    expect(sshClientAuthenticationOptions({ kind: "private-key", privateKey: "key", passphrase: "phrase" }))
      .toEqual({ privateKey: "key", passphrase: "phrase" });
  });
});
