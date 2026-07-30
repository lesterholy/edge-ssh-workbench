import { ProfileResponseSchema } from "@edgesh/contracts";
import { describe, expect, it } from "vitest";

import { ConnectionSessionRepository, redactCommand } from "./history";
import { decodeTimeCursor, encodeTimeCursor } from "./pagination";
import { OAuthRepository } from "./oauth";
import { ProfileRepository } from "./profiles";

const masterKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("storage helpers", () => {
  it("uses opaque, round-trippable history cursors", () => {
    const cursor = { createdAt: "2026-07-28T07:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeTimeCursor(encodeTimeCursor(cursor))).toEqual(cursor);
    expect(() => decodeTimeCursor("not-a-cursor")).toThrow("Invalid pagination cursor");
  });

  it("irreversibly redacts common credential forms", () => {
    expect(redactCommand("curl --token abc123 https://example.test")).toBe("curl --token [REDACTED] https://example.test");
    expect(redactCommand("export API_KEY=abc123")).toBe("export API_KEY=[REDACTED]");
    expect(redactCommand("cat <<EOF\n-----BEGIN PRIVATE KEY-----\nabc")).toBe("[REDACTED]");
  });

  it("stores Tailscale SSH session history without violating the legacy auth constraint", async () => {
    let boundValues: unknown[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          expect(values).toHaveLength((sql.match(/\?/g) ?? []).length);
          boundValues = values;
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      }),
    } as unknown as D1Database;
    const result = await new ConnectionSessionRepository(database).start(
      "22222222-2222-4222-8222-222222222222",
      {
        id: "33333333-3333-4333-8333-333333333333",
        profileId: "11111111-1111-4111-8111-111111111111",
        profileName: "Tailnet",
        host: "vps-01.example-tailnet.ts.net",
        port: 22,
        username: "deploy",
        authenticationMethod: "tailscale_ssh",
      },
    );

    expect(result.authenticationMethod).toBe("tailscale_ssh");
    expect(boundValues).toContain("password");
    expect(boundValues).toContain(1);
  });

  it("does not enumerate internal profile fields in API JSON", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      owner_id: "22222222-2222-4222-8222-222222222222",
      name: "Production", host: "ssh.example.test", port: 22, username: "root",
      auth_kind: "password", tailscale_ssh: 0, credential_persistence: "saved", notes: "", initial_command: null,
      terminal_type: "xterm-256color", encoding: "utf-8", collect_history: 1,
      password_ciphertext: "opaque", password_iv: "opaque", password_version: 1,
      private_key_ciphertext: null, private_key_iv: null, private_key_version: null,
      passphrase_ciphertext: null, passphrase_iv: null, passphrase_version: null,
      last_connected_at: null, last_connected_username: null, last_host_fingerprint: null,
      created_at: "2026-07-28T07:00:00.000Z", updated_at: "2026-07-28T07:00:00.000Z",
    };
    const database = {
      prepare: () => ({
        bind: () => ({ first: async () => row }),
      }),
    } as unknown as D1Database;
    const profile = await new ProfileRepository(database, "unused").get(row.owner_id, row.id);
    expect(profile).not.toBeNull();
    expect(profile?.authKind).toBe("password");
    const serialized = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
    expect(serialized).not.toHaveProperty("ownerId");
    expect(serialized).not.toHaveProperty("authKind");
    expect(serialized).not.toHaveProperty("password_ciphertext");
    expect(ProfileResponseSchema.safeParse(serialized).success).toBe(true);
  });

  it("encrypts profile credentials before binding an INSERT", async () => {
    let boundValues: unknown[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          expect(values).toHaveLength((sql.match(/\?/g) ?? []).length);
          boundValues = values;
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      }),
    } as unknown as D1Database;
    const profile = await new ProfileRepository(database, masterKey).create(
      "22222222-2222-4222-8222-222222222222",
      {
        name: "Production", host: "ssh.example.test", username: "root", authKind: "private_key",
        privateKey: "-----BEGIN PRIVATE KEY-----\nplaintext-key\n-----END PRIVATE KEY-----",
        passphrase: "plaintext-passphrase",
      },
    );
    expect(profile.hasPrivateKey).toBe(true);
    expect(profile.hasPassphrase).toBe(true);
    expect(JSON.stringify(boundValues)).not.toContain("plaintext-key");
    expect(JSON.stringify(boundValues)).not.toContain("plaintext-passphrase");
  });

  it("stores Tailscale SSH profiles without credential material", async () => {
    let boundValues: unknown[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          expect(values).toHaveLength((sql.match(/\?/g) ?? []).length);
          boundValues = values;
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      }),
    } as unknown as D1Database;
    const repository = new ProfileRepository(database, masterKey);
    const profile = await repository.create(
      "22222222-2222-4222-8222-222222222222",
      {
        name: "Tailnet",
        host: "vps-01.example-tailnet.ts.net",
        port: 22,
        username: "root",
        authKind: "tailscale_ssh",
        credentialPersistence: "none",
      },
    );

    expect(profile).toMatchObject({
      authenticationMethod: "tailscale_ssh",
      credentialPersistence: "none",
      hasPassword: false,
      hasPrivateKey: false,
      hasPassphrase: false,
    });
    expect(boundValues[7]).toBe(1);
    await expect(repository.create(
      "22222222-2222-4222-8222-222222222222",
      {
        name: "Wrong port",
        host: "vps-01.example-tailnet.ts.net",
        port: 7022,
        username: "root",
        authKind: "tailscale_ssh",
      },
    )).rejects.toThrow("port 22");
  });

  it("clears stored credentials when a profile switches to Tailscale SSH", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      owner_id: "22222222-2222-4222-8222-222222222222",
      name: "Production", host: "vps-01.example-tailnet.ts.net", port: 22, username: "root",
      auth_kind: "password", tailscale_ssh: 0, credential_persistence: "saved", notes: "", initial_command: null,
      terminal_type: "xterm-256color", encoding: "utf-8", collect_history: 1,
      password_ciphertext: "opaque-password", password_iv: "opaque-iv", password_version: 1,
      private_key_ciphertext: null, private_key_iv: null, private_key_version: null,
      passphrase_ciphertext: null, passphrase_iv: null, passphrase_version: null,
      last_connected_at: null, last_connected_username: null, last_host_fingerprint: null,
      created_at: "2026-07-28T07:00:00.000Z", updated_at: "2026-07-28T07:00:00.000Z",
    };
    let updateValues: unknown[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => row,
          run: async () => {
            expect(values).toHaveLength((sql.match(/\?/g) ?? []).length);
            updateValues = values;
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const profile = await new ProfileRepository(database, masterKey).updateFromRequest(
      row.owner_id,
      row.id,
      { credential: { method: "tailscale_ssh" } },
    );

    expect(profile).toMatchObject({
      authenticationMethod: "tailscale_ssh",
      credentialPersistence: "none",
      hasPassword: false,
    });
    expect(updateValues).not.toContain("opaque-password");
  });
});

describe("OAuth storage", () => {
  it("encrypts nonce and PKCE verifier at rest and atomically returns them once", async () => {
    let attemptRow: Record<string, unknown> | null = null;
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO oauth_login_attempts")) {
              attemptRow = {
                state_hash: values[0], browser_hash: values[1], transaction_ciphertext: values[2],
                transaction_iv: values[3], transaction_version: values[4], return_to: values[5], expires_at: values[6],
              };
            }
            return { meta: { changes: 1 } };
          },
          first: async () => sql.includes("UPDATE oauth_login_attempts") ? attemptRow : null,
        }),
      }),
    } as unknown as D1Database;
    const repository = new OAuthRepository(database, masterKey);
    await repository.begin({
      stateHash: "state-hash",
      browserHash: "browser-hash",
      nonce: "plaintext-nonce",
      codeVerifier: "plaintext-pkce-verifier",
      returnTo: "/workspace",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(JSON.stringify(attemptRow)).not.toContain("plaintext-nonce");
    expect(JSON.stringify(attemptRow)).not.toContain("plaintext-pkce-verifier");
    await expect(repository.consume("state-hash", "browser-hash")).resolves.toMatchObject({
      nonce: "plaintext-nonce",
      codeVerifier: "plaintext-pkce-verifier",
      returnTo: "/workspace",
    });
  });

  it("binds through a SQL guard requiring exactly one existing user", async () => {
    let identity: Record<string, unknown> | null = null;
    let guardedInsert = "";
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (sql.includes("COUNT(*) AS user_count")) return { user_count: 1, owner_exists: 1 };
            if (sql.includes("subject = ?") && identity?.subject === values[0]) return identity;
            if (sql.includes("email_normalized = ?") && identity?.email_normalized === values[0]) return identity;
            return null;
          },
          run: async () => {
            if (sql.includes("INSERT INTO oauth_identities")) {
              guardedInsert = sql;
              identity = {
                provider: "google", subject: values[0], email_normalized: values[1],
                created_at: values[2], last_login_at: values[3], owner_id: values[4],
              };
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const repository = new OAuthRepository(database, masterKey);
    const ownerId = "11111111-1111-4111-8111-111111111111";
    await expect(repository.bindGoogleIdentity(ownerId, "google-subject", "admin@example.com"))
      .resolves.toMatchObject({ ownerId, subject: "google-subject", email: "admin@example.com" });
    expect(guardedInsert).toContain("(SELECT COUNT(*) FROM users) = 1");
    expect(guardedInsert).not.toContain("INSERT INTO users");
  });
});
