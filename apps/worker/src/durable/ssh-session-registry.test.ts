import { describe, expect, it } from "vitest";
import {
	acquireSessionLease,
	pruneSessionLeases,
	releaseSessionLease,
	renewSessionLease,
} from "./ssh-session-registry";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const sessionIds = Array.from(
	{ length: 6 },
	(_, index) =>
		`${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}-1111-4111-8111-111111111111`,
);

describe("SSH session lease registry", () => {
	it("enforces a per-owner limit while allowing idempotent reacquisition", () => {
		const acquired = acquireSessionLease(undefined, first, 1, 1_000, 100);
		expect(acquired).toMatchObject({
			acquired: true,
			active: 1,
			expiresAt: 1_100,
		});
		expect(
			acquireSessionLease(acquired.state, first, 1, 1_010, 100),
		).toMatchObject({ acquired: true, active: 1 });
		expect(
			acquireSessionLease(acquired.state, second, 1, 1_010, 100),
		).toMatchObject({ acquired: false, active: 1 });
	});

	it("rejects only the sixth concurrent session at the default limit", () => {
		let state;
		for (const sessionId of sessionIds.slice(0, 5)) {
			const result = acquireSessionLease(state, sessionId, 5, 1_000, 100);
			expect(result).toMatchObject({ acquired: true });
			state = result.state;
		}

		expect(
			acquireSessionLease(state, sessionIds[5]!, 5, 1_000, 100),
		).toMatchObject({
			acquired: false,
			active: 5,
		});
	});

	it("renews, releases, and reclaims expired leases", () => {
		const acquired = acquireSessionLease(undefined, first, 2, 1_000, 100);
		expect(renewSessionLease(acquired.state, first, 1_050, 100).expiresAt).toBe(
			1_150,
		);
		expect(releaseSessionLease(acquired.state, first, 1_050).active).toBe(0);
		expect(pruneSessionLeases(acquired.state, 1_101).active).toBe(0);
		expect(renewSessionLease(acquired.state, first, 1_101, 100).acquired).toBe(
			false,
		);
	});
});
