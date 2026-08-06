import { ProfileResponseSchema } from "@edgesh/contracts";
import { describe, expect, it } from "vitest";

import {
	CommandHistoryRepository,
	ConnectionSessionRepository,
	redactCommand,
} from "./history";
import { decodeTimeCursor, encodeTimeCursor } from "./pagination";
import { OAuthRepository } from "./oauth";
import { ProfileRepository } from "./profiles";
import { TailscaleConfigurationRepository } from "./tailscale-configuration";

const masterKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("storage helpers", () => {
	it("uses opaque, round-trippable history cursors", () => {
		const cursor = {
			createdAt: "2026-07-28T07:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		expect(decodeTimeCursor(encodeTimeCursor(cursor))).toEqual(cursor);
		expect(() => decodeTimeCursor("not-a-cursor")).toThrow(
			"Invalid pagination cursor",
		);
	});

	it("uses keyset pagination for profiles without a 500-row ceiling", async () => {
		const first = {
			id: "11111111-1111-4111-8111-111111111111",
			owner_id: "22222222-2222-4222-8222-222222222222",
			name: "First",
			host: "first.example.test",
			port: 22,
			username: "root",
			auth_kind: "password",
			tailscale_ssh: 0,
			credential_persistence: "prompt",
			notes: "",
			initial_command: null,
			terminal_type: "xterm-256color",
			encoding: "utf-8",
			collect_history: 1,
			password_ciphertext: null,
			password_iv: null,
			password_version: null,
			private_key_ciphertext: null,
			private_key_iv: null,
			private_key_version: null,
			passphrase_ciphertext: null,
			passphrase_iv: null,
			passphrase_version: null,
			last_connected_at: null,
			last_connected_username: null,
			last_host_fingerprint: null,
			created_at: "2026-08-04T04:00:00.000Z",
			updated_at: "2026-08-04T04:00:00.000Z",
		};
		const second = {
			...first,
			id: "00000000-0000-4000-8000-000000000000",
			name: "Second",
			host: "second.example.test",
			updated_at: "2026-08-04T03:00:00.000Z",
		};
		let sql = "";
		let bindings: unknown[] = [];
		const database = {
			prepare: (statement: string) => {
				sql = statement;
				return {
					bind: (...values: unknown[]) => {
						bindings = values;
						return { all: async () => ({ results: [first, second] }) };
					},
				};
			},
		} as unknown as D1Database;

		const page = await new ProfileRepository(database).listPage(
			first.owner_id,
			1,
		);

		expect(page.items).toHaveLength(1);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).not.toBeNull();
		expect(sql).toContain("ORDER BY updated_at DESC, id DESC LIMIT ?");
		expect(bindings).toEqual([first.owner_id, 2]);
		expect(decodeTimeCursor(page.nextCursor ?? undefined)).toEqual({
			createdAt: first.updated_at,
			id: first.id,
		});
	});

	it("checks imported targets by selected hosts without truncating the profile table", async () => {
		let sql = "";
		let bindings: unknown[] = [];
		const database = {
			prepare: (statement: string) => {
				sql = statement;
				return {
					bind: (...values: unknown[]) => {
						bindings = values;
						return {
							all: async () => ({
								results: [
									{
										host: "alpha.example-tailnet.ts.net",
										port: 22,
										username: "root",
									},
								],
							}),
						};
					},
				};
			},
		} as unknown as D1Database;

		const targets = await new ProfileRepository(database).listTargetsByHosts(
			"22222222-2222-4222-8222-222222222222",
			["alpha.example-tailnet.ts.net", "beta.example-tailnet.ts.net"],
		);

		expect(targets).toEqual([
			{ host: "alpha.example-tailnet.ts.net", port: 22, username: "root" },
		]);
		expect(sql).toContain("host IN (?, ?)");
		expect(sql).not.toContain("LIMIT");
		expect(bindings).toEqual([
			"22222222-2222-4222-8222-222222222222",
			"alpha.example-tailnet.ts.net",
			"beta.example-tailnet.ts.net",
		]);
	});

	it("irreversibly redacts common credential forms", () => {
		expect(redactCommand("curl --token abc123 https://example.test")).toBe(
			"curl --token [REDACTED] https://example.test",
		);
		expect(redactCommand("export API_KEY=abc123")).toBe(
			"export API_KEY=[REDACTED]",
		);
		expect(redactCommand("cat <<EOF\n-----BEGIN PRIVATE KEY-----\nabc")).toBe(
			"[REDACTED]",
		);
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
			name: "Production",
			host: "ssh.example.test",
			port: 22,
			username: "root",
			auth_kind: "password",
			tailscale_ssh: 0,
			credential_persistence: "saved",
			notes: "",
			initial_command: null,
			terminal_type: "xterm-256color",
			encoding: "utf-8",
			collect_history: 1,
			password_ciphertext: "opaque",
			password_iv: "opaque",
			password_version: 1,
			private_key_ciphertext: null,
			private_key_iv: null,
			private_key_version: null,
			passphrase_ciphertext: null,
			passphrase_iv: null,
			passphrase_version: null,
			last_connected_at: null,
			last_connected_username: null,
			last_host_fingerprint: null,
			created_at: "2026-07-28T07:00:00.000Z",
			updated_at: "2026-07-28T07:00:00.000Z",
		};
		const database = {
			prepare: () => ({
				bind: () => ({ first: async () => row }),
			}),
		} as unknown as D1Database;
		const profile = await new ProfileRepository(database, "unused").get(
			row.owner_id,
			row.id,
		);
		expect(profile).not.toBeNull();
		expect(profile?.authKind).toBe("password");
		const serialized = JSON.parse(JSON.stringify(profile)) as Record<
			string,
			unknown
		>;
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
				name: "Production",
				host: "ssh.example.test",
				username: "root",
				authKind: "private_key",
				privateKey:
					"-----BEGIN PRIVATE KEY-----\nplaintext-key\n-----END PRIVATE KEY-----",
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
		await expect(
			repository.create("22222222-2222-4222-8222-222222222222", {
				name: "Wrong port",
				host: "vps-01.example-tailnet.ts.net",
				port: 7022,
				username: "root",
				authKind: "tailscale_ssh",
			}),
		).rejects.toThrow("port 22");
	});

	it("encrypts a browser-managed Tailscale API token and resolves it for discovery", async () => {
		const ownerId = "22222222-2222-4222-8222-222222222222";
		let row: Record<string, unknown> | null = null;
		const database = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => ({
					first: async () => row,
					run: async () => {
						if (sql.includes("INSERT INTO tailscale_configuration")) {
							row = {
								owner_id: values[0],
								tailnet: values[1],
								api_token_ciphertext: values[2],
								api_token_iv: values[3],
								api_token_version: values[4],
								updated_at: values[5],
							};
						}
						return { meta: { changes: 1 } };
					},
				}),
			}),
		} as unknown as D1Database;
		const repository = new TailscaleConfigurationRepository(
			database,
			masterKey,
		);

		const status = await repository.update(
			ownerId,
			{
				tailnet: "example.com",
				apiToken: "tskey-api-plaintext-token",
			},
			{},
		);

		expect(status).toEqual({
			tailnet: "example.com",
			apiTokenConfigured: true,
			configured: true,
		});
		expect(JSON.stringify(row)).not.toContain("tskey-api-plaintext-token");
		await expect(repository.resolve(ownerId, {})).resolves.toEqual({
			TAILSCALE_TAILNET: "example.com",
			TAILSCALE_API_TOKEN: "tskey-api-plaintext-token",
		});

		await repository.update(ownerId, { tailnet: "renamed.example.com" }, {});
		await expect(repository.resolve(ownerId, {})).resolves.toEqual({
			TAILSCALE_TAILNET: "renamed.example.com",
			TAILSCALE_API_TOKEN: "tskey-api-plaintext-token",
		});
	});

	it("clears stored credentials when a profile switches to Tailscale SSH", async () => {
		const row = {
			id: "11111111-1111-4111-8111-111111111111",
			owner_id: "22222222-2222-4222-8222-222222222222",
			name: "Production",
			host: "vps-01.example-tailnet.ts.net",
			port: 22,
			username: "root",
			auth_kind: "password",
			tailscale_ssh: 0,
			credential_persistence: "saved",
			notes: "",
			initial_command: null,
			terminal_type: "xterm-256color",
			encoding: "utf-8",
			collect_history: 1,
			password_ciphertext: "opaque-password",
			password_iv: "opaque-iv",
			password_version: 1,
			private_key_ciphertext: null,
			private_key_iv: null,
			private_key_version: null,
			passphrase_ciphertext: null,
			passphrase_iv: null,
			passphrase_version: null,
			last_connected_at: null,
			last_connected_username: null,
			last_host_fingerprint: null,
			created_at: "2026-07-28T07:00:00.000Z",
			updated_at: "2026-07-28T07:00:00.000Z",
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
		const profile = await new ProfileRepository(
			database,
			masterKey,
		).updateFromRequest(row.owner_id, row.id, {
			credential: { method: "tailscale_ssh" },
		});

		expect(profile).toMatchObject({
			authenticationMethod: "tailscale_ssh",
			credentialPersistence: "none",
			hasPassword: false,
		});
		expect(updateValues).not.toContain("opaque-password");
	});

	it("scopes command history reads and clears to one SSH session", async () => {
		const statements: Array<{ sql: string; values: unknown[] }> = [];
		const database = {
			prepare: (sql: string) => ({
				bind: (...values: unknown[]) => {
					statements.push({ sql, values });
					return {
						all: async () => ({ results: [] }),
						run: async () => ({ meta: { changes: 0 } }),
					};
				},
			}),
		} as unknown as D1Database;
		const ownerId = "11111111-1111-4111-8111-111111111111";
		const sessionId = "22222222-2222-4222-8222-222222222222";
		const repository = new CommandHistoryRepository(database);

		await repository.list(ownerId, { sessionId });
		await repository.clear(ownerId, { sessionId });

		expect(statements).toHaveLength(2);
		for (const statement of statements) {
			expect(statement.sql).toContain("session_id = ?");
			expect(statement.values).toContain(ownerId);
			expect(statement.values).toContain(sessionId);
		}
	});

	it("deletes a profile only when no active connection session references it", async () => {
		let sql = "";
		let bindings: unknown[] = [];
		const database = {
			prepare: (statement: string) => {
				sql = statement;
				return {
					bind: (...values: unknown[]) => {
						bindings = values;
						return { run: async () => ({ meta: { changes: 1 } }) };
					},
				};
			},
		} as unknown as D1Database;
		const repository = new ProfileRepository(database, masterKey);
		const deleted = await repository.deleteIfNoActiveSessions(
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		);

		expect(deleted).toBe(true);
		expect(sql).toContain("NOT EXISTS");
		expect(sql).toContain("status NOT IN ('closed', 'error')");
		expect(bindings).toEqual([
			"22222222-2222-4222-8222-222222222222",
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
			"11111111-1111-4111-8111-111111111111",
		]);
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
								state_hash: values[0],
								browser_hash: values[1],
								transaction_ciphertext: values[2],
								transaction_iv: values[3],
								transaction_version: values[4],
								return_to: values[5],
								expires_at: values[6],
							};
						}
						return { meta: { changes: 1 } };
					},
					first: async () =>
						sql.includes("UPDATE oauth_login_attempts") ? attemptRow : null,
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
		await expect(
			repository.consume("state-hash", "browser-hash"),
		).resolves.toMatchObject({
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
						if (sql.includes("COUNT(*) AS user_count"))
							return { user_count: 1, owner_exists: 1 };
						if (sql.includes("subject = ?") && identity?.subject === values[0])
							return identity;
						if (
							sql.includes("email_normalized = ?") &&
							identity?.email_normalized === values[0]
						)
							return identity;
						return null;
					},
					run: async () => {
						if (sql.includes("INSERT INTO oauth_identities")) {
							guardedInsert = sql;
							identity = {
								provider: "google",
								subject: values[0],
								email_normalized: values[1],
								created_at: values[2],
								last_login_at: values[3],
								owner_id: values[4],
							};
						}
						return { meta: { changes: 1 } };
					},
				}),
			}),
		} as unknown as D1Database;
		const repository = new OAuthRepository(database, masterKey);
		const ownerId = "11111111-1111-4111-8111-111111111111";
		await expect(
			repository.bindGoogleIdentity(
				ownerId,
				"google-subject",
				"admin@example.com",
			),
		).resolves.toMatchObject({
			ownerId,
			subject: "google-subject",
			email: "admin@example.com",
		});
		expect(guardedInsert).toContain("(SELECT COUNT(*) FROM users) = 1");
		expect(guardedInsert).not.toContain("INSERT INTO users");
	});
});
