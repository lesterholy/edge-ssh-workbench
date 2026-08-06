import { describe, expect, it } from "vitest";
import { createTerminalInputSender } from "./session-channel";

describe("createTerminalInputSender", () => {
	it("uses one monotonic sequence for all terminal input sources", () => {
		const messages: Array<Record<string, unknown>> = [];
		const sendInput = createTerminalInputSender((message) => {
			messages.push(message);
			return `request-${messages.length}`;
		});

		expect(sendInput("typed")).toBe("request-1");
		expect(sendInput("batch\r")).toBe("request-2");
		expect(messages).toEqual([
			{ type: "input", sequence: 0, data: "typed" },
			{ type: "input", sequence: 1, data: "batch\r" },
		]);
	});

	it("does not consume a sequence number when the socket rejects a send", () => {
		const messages: Array<Record<string, unknown>> = [];
		let open = false;
		const sendInput = createTerminalInputSender((message) => {
			messages.push(message);
			return open ? "accepted" : null;
		});

		expect(sendInput("blocked")).toBeNull();
		open = true;
		expect(sendInput("accepted")).toBe("accepted");
		expect(messages.map((message) => message.sequence)).toEqual([0, 0]);
	});
});
