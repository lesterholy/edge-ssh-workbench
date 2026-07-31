import { describe, expect, it } from "vitest";

import { WORKER_SAFE_ALGORITHMS, sshClientAuthenticationOptions } from "./ssh2-engine";

describe("SSH client algorithms", () => {
  it("keeps runtime-filtered KEX and cipher defaults", () => {
    expect(WORKER_SAFE_ALGORITHMS).not.toHaveProperty("kex");
    expect(WORKER_SAFE_ALGORITHMS).not.toHaveProperty("cipher");
    expect(WORKER_SAFE_ALGORITHMS.serverHostKey.remove).toContain("ssh-rsa");
    expect(WORKER_SAFE_ALGORITHMS.hmac.remove).toEqual([
      "hmac-sha1-etm@openssh.com",
      "hmac-sha1",
    ]);
  });
});

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
