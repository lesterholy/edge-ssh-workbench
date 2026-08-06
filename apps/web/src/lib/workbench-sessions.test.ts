import { describe, expect, it } from "vitest";

import type { ProfileResponse } from "@edgesh/contracts";
import {
	createWorkbenchSession,
	initialWorkbenchSessionsState,
	profileSessionCounts,
	visibleSessionIds,
	workbenchSessionsReducer,
	type WorkbenchSession,
} from "./workbench-sessions";

const attemptA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const attemptB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function profile(id: string, name: string): ProfileResponse {
	return {
		id,
		name,
		host: `${name.toLowerCase()}.example.com`,
		port: 22,
		username: "root",
		notes: "",
		authenticationMethod: "password",
		credentialPersistence: "saved",
		hasPassword: true,
		hasPrivateKey: false,
		hasPassphrase: false,
		terminalType: "xterm-256color",
		encoding: "utf-8",
		initialCommand: null,
		lastConnectedAt: null,
		lastSuccessfulUsername: null,
		lastHostKeyFingerprint: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function session(
	id: string,
	target: ProfileResponse,
	attemptId = attemptA,
): WorkbenchSession {
	return createWorkbenchSession(target, {
		id,
		attemptId,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
}

describe("workbench session reducer", () => {
	it("keeps sessions independent and focuses the newly opened session", () => {
		const first = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		const second = workbenchSessionsReducer(first, {
			type: "open",
			session: session(
				"session-b",
				profile("22222222-2222-4222-8222-222222222222", "Beta"),
				attemptB,
			),
		});
		const updated = workbenchSessionsReducer(second, {
			type: "state",
			id: "session-a",
			attemptId: attemptA,
			state: "connected",
		});

		expect(updated.activeId).toBe("session-b");
		expect(updated.sessions["session-a"]?.state).toBe("connected");
		expect(updated.sessions["session-b"]?.state).toBe("authorizing");
		expect(visibleSessionIds(updated)).toEqual(["session-b"]);
	});

	it("rejects stale updates from a previous connection attempt", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "reconnect",
			id: "session-a",
			attemptId: attemptB,
		});
		state = workbenchSessionsReducer(state, {
			type: "state",
			id: "session-a",
			attemptId: attemptA,
			state: "error",
		});

		expect(state.sessions["session-a"]?.attemptId).toBe(attemptB);
		expect(state.sessions["session-a"]?.state).toBe("authorizing");
	});

	it("uses two distinct panes and focuses an existing pane instead of duplicating it", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "open",
			session: session(
				"session-b",
				profile("22222222-2222-4222-8222-222222222222", "Beta"),
				attemptB,
			),
		});
		state = workbenchSessionsReducer(state, { type: "toggle-split" });

		expect(state.layout).toBe("split");
		expect(new Set(visibleSessionIds(state))).toEqual(
			new Set(["session-a", "session-b"]),
		);

		const selected = workbenchSessionsReducer(state, {
			type: "select",
			id: state.panes[1]!,
		});
		expect(selected.focusedPane).toBe(1);
		expect(selected.panes).toEqual(state.panes);
	});

	it("collapses split mode and selects a remaining session when one closes", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "open",
			session: session(
				"session-b",
				profile("22222222-2222-4222-8222-222222222222", "Beta"),
				attemptB,
			),
		});
		state = workbenchSessionsReducer(state, { type: "toggle-split" });
		state = workbenchSessionsReducer(state, {
			type: "remove",
			id: "session-b",
		});

		expect(state.layout).toBe("single");
		expect(state.activeId).toBe("session-a");
		expect(state.panes).toEqual(["session-a", undefined]);
	});

	it("keeps the target snapshot immutable until reconnect explicitly refreshes it", () => {
		const original = profile("11111111-1111-4111-8111-111111111111", "Alpha");
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session("session-a", original),
		});
		const edited = { ...original, name: "Renamed", host: "new.example.com" };
		original.name = "Mutated outside";

		expect(state.sessions["session-a"]?.profile.name).toBe("Alpha");
		state = workbenchSessionsReducer(state, {
			type: "reconnect",
			id: "session-a",
			attemptId: attemptB,
			profile: edited,
		});
		expect(state.sessions["session-a"]?.profile).toEqual(edited);
	});

	it("supports explicit duplicate sessions for one profile and counts both tabs", () => {
		const target = profile("11111111-1111-4111-8111-111111111111", "Alpha");
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session("session-a", target),
		});
		state = workbenchSessionsReducer(state, {
			type: "open",
			session: session("session-b", target, attemptB),
		});

		expect(state.order).toEqual(["session-a", "session-b"]);
		expect(profileSessionCounts(state)[target.id]).toBe(2);
	});

	it("can prepare a credential-prompt reconnect without starting a ticket request", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "reconnect",
			id: "session-a",
			attemptId: attemptB,
			connectRequested: false,
		});

		expect(state.sessions["session-a"]).toMatchObject({
			attemptId: attemptB,
			connectRequested: false,
			state: "idle",
			channel: null,
		});
	});

	it("does not rerender the workbench for repeated terminal output once attention is represented", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		const output = {
			protocolVersion: 2 as const,
			type: "output" as const,
			sessionId: "33333333-3333-4333-8333-333333333333",
			attemptId: attemptA,
			sequence: 0,
			stream: "stdout" as const,
			data: "hello",
		};
		const activeResult = workbenchSessionsReducer(state, {
			type: "message",
			id: "session-a",
			attemptId: attemptA,
			message: output,
			receivedAt: "2026-01-01T00:00:01.000Z",
		});
		expect(activeResult).toBe(state);

		state = workbenchSessionsReducer(state, {
			type: "open",
			session: session(
				"session-b",
				profile("22222222-2222-4222-8222-222222222222", "Beta"),
				attemptB,
			),
		});
		const firstBackgroundOutput = workbenchSessionsReducer(state, {
			type: "message",
			id: "session-a",
			attemptId: attemptA,
			message: output,
			receivedAt: "2026-01-01T00:00:01.000Z",
		});
		const repeatedBackgroundOutput = workbenchSessionsReducer(
			firstBackgroundOutput,
			{
				type: "message",
				id: "session-a",
				attemptId: attemptA,
				message: { ...output, sequence: 1 },
				receivedAt: "2026-01-01T00:00:02.000Z",
			},
		);
		expect(firstBackgroundOutput.sessions["session-a"]?.attention).toBe(
			"activity",
		);
		expect(repeatedBackgroundOutput).toBe(firstBackgroundOutput);
	});

	it("keeps the highest-priority background attention until selected", () => {
		let state = workbenchSessionsReducer(initialWorkbenchSessionsState, {
			type: "open",
			session: session(
				"session-a",
				profile("11111111-1111-4111-8111-111111111111", "Alpha"),
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "open",
			session: session(
				"session-b",
				profile("22222222-2222-4222-8222-222222222222", "Beta"),
				attemptB,
			),
		});
		state = workbenchSessionsReducer(state, {
			type: "attention",
			id: "session-a",
			attention: "error",
		});
		state = workbenchSessionsReducer(state, {
			type: "attention",
			id: "session-a",
			attention: "activity",
		});
		expect(state.sessions["session-a"]?.attention).toBe("error");

		state = workbenchSessionsReducer(state, {
			type: "select",
			id: "session-a",
		});
		expect(state.sessions["session-a"]?.attention).toBe("none");
	});
});
