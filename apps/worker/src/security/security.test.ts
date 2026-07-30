import { describe, expect, it } from "vitest";

import type { Env } from "../env";
import { decryptSecret, encryptSecret } from "./envelope";
import { encodeBase64Url } from "./encoding";
import { assertRequestOrigin } from "./http";
import { assertPublicTarget, isPrivateOrReservedAddress, normalizeHost } from "./network";
import { createSshTicket, verifySshTicket } from "./tickets";

const masterKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));

describe("credential envelope", () => {
  it("round-trips with bound AAD and rejects record substitution", async () => {
    const context = { ownerId: "owner", recordId: "profile-1", field: "password" as const };
    const encrypted = await encryptSecret(masterKey, "not stored in plaintext", context);
    expect(JSON.stringify(encrypted)).not.toContain("not stored in plaintext");
    expect(await decryptSecret(masterKey, encrypted, context)).toBe("not stored in plaintext");
    await expect(decryptSecret(masterKey, encrypted, { ...context, recordId: "profile-2" }))
      .rejects.toThrow("authentication failed");
  });
});

describe("network target classification", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "rejects reserved address %s",
    (address) => expect(isPrivateOrReservedAddress(address)).toBe(true),
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "example.com."])(
    "accepts public target syntax %s",
    (address) => expect(isPrivateOrReservedAddress(address)).toBe(false),
  );

  it("normalizes host names", () => expect(normalizeHost("Example.COM.")).toBe("example.com"));

  it("rejects mixed public and private DNS answers", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get("type");
      return Response.json({
        Status: 0,
        Answer: type === "A" ? [{ type: 1, data: "1.1.1.1" }, { type: 1, data: "10.0.0.1" }] : [],
      }, { headers: { "Content-Type": "application/dns-json" } });
    }) as typeof fetch;
    await expect(assertPublicTarget("example.test", 22, null, { fetcher })).rejects.toThrow("private or reserved");
  });
});

describe("request origin", () => {
  const env = { ALLOWED_ORIGINS: "https://admin.example" } as Env;

  it("allows same-origin and explicitly configured origins", () => {
    expect(() => assertRequestOrigin(new Request("https://ssh.example/api/settings", { method: "PATCH", headers: { Origin: "https://ssh.example" } }), env)).not.toThrow();
    expect(() => assertRequestOrigin(new Request("https://ssh.example/api/settings", { method: "PATCH", headers: { Origin: "https://admin.example" } }), env)).not.toThrow();
  });

  it("rejects missing and cross-site origins", () => {
    expect(() => assertRequestOrigin(new Request("https://ssh.example/api/settings", { method: "PATCH" }), env)).toThrow("not allowed");
    expect(() => assertRequestOrigin(new Request("https://ssh.example/api/settings", {
      method: "PATCH", headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    }), env)).toThrow("not allowed");
  });
});

describe("SSH tickets", () => {
  it("binds owner, session, profile, attempt and origin", async () => {
    const input = {
      ownerId: "owner-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
      profileId: "22222222-2222-4222-8222-222222222222",
      attemptId: "33333333-3333-4333-8333-333333333333",
      origin: "https://ssh.example.test",
      now: 1_000_000,
    };
    const { ticket } = await createSshTicket(masterKey, input);
    expect(await verifySshTicket(masterKey, ticket, input, 1_000_001)).toMatchObject({ ownerId: "owner-1" });
    expect(await verifySshTicket(masterKey, ticket, { ...input, ownerId: "owner-2" }, 1_000_001)).toBeNull();
    expect(await verifySshTicket(masterKey, ticket, input, 1_061_000)).toBeNull();
  });
});
