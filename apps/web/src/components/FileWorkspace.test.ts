import { describe, expect, it } from "vitest";
import type { ServerFileResultMessage } from "@edgesh/contracts";
import { matchesPendingWriteResult } from "./FileWorkspace";

const common = {
	protocolVersion: 2 as const,
	type: "file-result" as const,
	sessionId: "11111111-1111-4111-8111-111111111111",
	attemptId: "22222222-2222-4222-8222-222222222222",
	requestId: "33333333-3333-4333-8333-333333333333",
	path: "/tmp/example.txt",
};

describe("matchesPendingWriteResult", () => {
	it("matches only the active write request", () => {
		const message: ServerFileResultMessage = { ...common, operation: "write" };

		expect(matchesPendingWriteResult(message, common.requestId)).toBe(true);
		expect(
			matchesPendingWriteResult(
				message,
				"44444444-4444-4444-8444-444444444444",
			),
		).toBe(false);
		expect(matchesPendingWriteResult(message, undefined)).toBe(false);
	});

	it("does not let another SFTP mutation finish an upload", () => {
		const message: ServerFileResultMessage = {
			...common,
			operation: "mkdir",
			path: "/tmp/new-directory",
		};

		expect(matchesPendingWriteResult(message, common.requestId)).toBe(false);
	});
});
