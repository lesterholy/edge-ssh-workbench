import { describe, expect, it } from "vitest";
import { TransferGate } from "./transfer-gate";

describe("TransferGate", () => {
	it("serializes transfers across workbench sessions in FIFO order", async () => {
		const gate = new TransferGate();
		const first = await gate.acquire("session-a");
		let secondResolved = false;
		const secondPromise = gate.acquire("session-b").then((lease) => {
			secondResolved = true;
			return lease;
		});

		await Promise.resolve();
		expect(secondResolved).toBe(false);
		expect(gate.activeClientSessionId).toBe("session-a");

		first.release();
		const second = await secondPromise;
		expect(secondResolved).toBe(true);
		expect(gate.activeClientSessionId).toBe("session-b");
		second.release();
		expect(gate.activeClientSessionId).toBeUndefined();
	});

	it("aborts an active transfer and advances the queue when a session closes", async () => {
		const gate = new TransferGate();
		const first = await gate.acquire("session-a");
		const secondPromise = gate.acquire("session-b");

		gate.cancelSession("session-a");
		expect(first.signal.aborted).toBe(true);
		const second = await secondPromise;
		expect(gate.activeClientSessionId).toBe("session-b");
		second.release();
	});

	it("rejects queued transfers when all sessions are drained", async () => {
		const gate = new TransferGate();
		const first = await gate.acquire("session-a");
		const queued = gate.acquire("session-b");

		gate.cancelAll();
		expect(first.signal.aborted).toBe(true);
		await expect(queued).rejects.toThrow("All SSH sessions closed");
	});
});
