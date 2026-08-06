import { describe, expect, it } from "vitest";
import { WS_PROTOCOL_VERSION } from "@edgesh/contracts";
import { decodeBinaryFrame, encodeBinaryFrame } from "./binary-frame";

const sessionId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";

describe("binary frames", () => {
	it("round-trips session and attempt identity", () => {
		const payload = new Uint8Array([1, 2, 3]);
		const buffer = encodeBinaryFrame(
			{
				protocolVersion: WS_PROTOCOL_VERSION,
				kind: "terminal-output",
				sessionId,
				attemptId,
				sequence: 0,
				payloadBytes: payload.byteLength,
			},
			payload,
		);

		expect(decodeBinaryFrame(buffer)).toEqual({
			header: {
				protocolVersion: WS_PROTOCOL_VERSION,
				kind: "terminal-output",
				sessionId,
				attemptId,
				sequence: 0,
				payloadBytes: payload.byteLength,
			},
			payload,
		});
	});
});
