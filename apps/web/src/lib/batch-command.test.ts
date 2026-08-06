import { describe, expect, it } from "vitest";
import type { ProfileResponse } from "@edgesh/contracts";
import {
	connectedBatchCommandTargets,
	MAX_BATCH_COMMAND_LENGTH,
	sendBatchCommand,
	terminalCommandInput,
} from "./batch-command";
import type { SessionChannel } from "./session-channel";
import {
	createWorkbenchSession,
	type WorkbenchSession,
	type WorkbenchSessionsState,
} from "./workbench-sessions";

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

function channel(
	clientSessionId: string,
	options: {
		open?: boolean;
		acceptInput?: boolean;
		attemptId?: string;
		sessionId?: string;
	} = {},
) {
	const inputs: string[] = [];
	const value: SessionChannel = {
		clientSessionId,
		sessionId: options.sessionId ?? `${clientSessionId}-server`,
		attemptId: options.attemptId ?? `${clientSessionId}-attempt`,
		send: () => `${clientSessionId}-request`,
		sendInput: (data) => {
			inputs.push(data);
			return options.acceptInput === false ? null : `${clientSessionId}-input`;
		},
		sendBinary: async () => undefined,
		subscribe: () => () => undefined,
		subscribeBinary: () => () => undefined,
		close: () => undefined,
		isOpen: () => options.open !== false,
		bufferedAmount: () => 0,
	};
	return { value, inputs };
}

function session(
	id: string,
	target: ProfileResponse,
	value: SessionChannel | null,
	state: WorkbenchSession["state"],
): WorkbenchSession {
	return {
		...createWorkbenchSession(target, {
			id,
			attemptId: value?.attemptId ?? `${id}-attempt`,
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
		channel: value,
		state,
	};
}

function workbench(sessions: WorkbenchSession[]): WorkbenchSessionsState {
	return {
		sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
		order: sessions.map((item) => item.id),
		activeId: sessions[0]?.id,
		layout: "single",
		panes: [sessions[0]?.id, undefined],
		focusedPane: 0,
	};
}

describe("batch commands", () => {
	it("lists only connected open sessions and disambiguates duplicate profiles", () => {
		const alpha = profile("profile-alpha", "Alpha");
		const first = channel("session-a");
		const second = channel("session-b");
		const state = workbench([
			session("session-a", alpha, first.value, "connected"),
			session("session-b", alpha, second.value, "connected"),
			session("session-c", alpha, null, "closed"),
			session(
				"session-d",
				profile("profile-beta", "Beta"),
				channel("session-d", { open: false }).value,
				"connected",
			),
		]);

		expect(connectedBatchCommandTargets(state)).toEqual([
			{
				id: "session-a",
				attemptId: "session-a-attempt",
				sessionId: "session-a-server",
				label: "Alpha #1",
				endpoint: "root@alpha.example.com:22",
			},
			{
				id: "session-b",
				attemptId: "session-b-attempt",
				sessionId: "session-b-server",
				label: "Alpha #2",
				endpoint: "root@alpha.example.com:22",
			},
		]);
	});

	it("accepts one auditable command and rejects empty, multiline, or oversized input", () => {
		expect(terminalCommandInput("uptime && whoami")).toBe("uptime && whoami\r");
		expect(terminalCommandInput("uptime\nwhoami")).toBeNull();
		expect(terminalCommandInput("pwd\r")).toBeNull();
		expect(terminalCommandInput("   ")).toBeNull();
		expect(terminalCommandInput("x".repeat(MAX_BATCH_COMMAND_LENGTH))).toBe(
			`${"x".repeat(MAX_BATCH_COMMAND_LENGTH)}\r`,
		);
		expect(
			terminalCommandInput("x".repeat(MAX_BATCH_COMMAND_LENGTH + 1)),
		).toBeNull();
	});

	it("sends independently and skips stale, closed, duplicate, or rejected targets", () => {
		const accepted = channel("session-a");
		const rejected = channel("session-b", { acceptInput: false });
		const state = workbench([
			session(
				"session-a",
				profile("profile-a", "Alpha"),
				accepted.value,
				"connected",
			),
			session(
				"session-b",
				profile("profile-b", "Beta"),
				rejected.value,
				"connected",
			),
			session("session-c", profile("profile-c", "Gamma"), null, "closed"),
		]);

		const targets = connectedBatchCommandTargets(state);
		const closedTarget = {
			id: "session-c",
			attemptId: "session-c-attempt",
			sessionId: "session-c-server",
			label: "Gamma",
			endpoint: "root@gamma.example.com:22",
		};
		const missingTarget = {
			...closedTarget,
			id: "missing",
			label: "Missing",
		};
		const result = sendBatchCommand(
			state,
			[targets[0]!, targets[1]!, closedTarget, missingTarget, targets[0]!],
			"uptime && whoami",
		);

		expect(result.sentTargets.map((target) => target.id)).toEqual([
			"session-a",
		]);
		expect(result.skippedTargets.map((target) => target.id)).toEqual([
			"session-b",
			"session-c",
			"missing",
		]);
		expect(accepted.inputs).toEqual(["uptime && whoami\r"]);
		expect(rejected.inputs).toEqual(["uptime && whoami\r"]);
	});

	it("rejects a selection captured from an earlier connection attempt", () => {
		const original = channel("session-a");
		const originalState = workbench([
			session(
				"session-a",
				profile("profile-a", "Alpha"),
				original.value,
				"connected",
			),
		]);
		const selectedTarget = connectedBatchCommandTargets(originalState)[0]!;
		const replacement = channel("session-a", {
			attemptId: "replacement-attempt",
			sessionId: "replacement-session",
		});
		const reconnectedState = workbench([
			session(
				"session-a",
				profile("profile-a", "Alpha"),
				replacement.value,
				"connected",
			),
		]);

		const result = sendBatchCommand(
			reconnectedState,
			[selectedTarget],
			"uptime",
		);

		expect(result.sentTargets).toEqual([]);
		expect(result.skippedTargets).toEqual([selectedTarget]);
		expect(replacement.inputs).toEqual([]);
	});
});
