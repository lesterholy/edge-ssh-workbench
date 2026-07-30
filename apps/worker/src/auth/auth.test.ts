import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";
import { generateHotpCode, generateTotpCode, verifyTotp } from "./totp";

describe("password hashing", () => {
  it("round-trips PBKDF2 hashes and rejects a different password", async () => {
    const encoded = await hashPassword("correct horse battery staple", 100_000);
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(await verifyPassword("wrong password", encoded)).toBe(false);
  });
});

describe("TOTP", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches RFC 4226 HOTP vectors", async () => {
    expect(await generateHotpCode(rfcSecret, 0)).toBe("755224");
    expect(await generateHotpCode(rfcSecret, 1)).toBe("287082");
    expect(await generateHotpCode(rfcSecret, 9)).toBe("520489");
  });

  it("matches the six-digit RFC 6238 value and window verification", async () => {
    expect(await generateTotpCode(rfcSecret, 59_000)).toBe("287082");
    expect(await verifyTotp("287082", rfcSecret, { timestampMs: 59_000, window: 0 })).toBe(true);
    expect(await verifyTotp("287083", rfcSecret, { timestampMs: 59_000, window: 0 })).toBe(false);
  });
});
