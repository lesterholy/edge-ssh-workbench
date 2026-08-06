import { describe, expect, it } from "vitest";
import {
	enqueuePrompt,
	removePrompt,
	removeSessionPrompts,
	type PromptIdentity,
} from "./prompt-queue";

const prompt = (
	id: string,
	kind: PromptIdentity["kind"],
	clientSessionId: string,
	attemptId: string,
): PromptIdentity => ({
	id,
	kind,
	clientSessionId,
	attemptId,
});

describe("prompt queue", () => {
	it("preserves FIFO order across credential and host-key prompts", () => {
		let queue: PromptIdentity[] = [];
		queue = enqueuePrompt(queue, prompt("one", "credential", "a", "attempt-a"));
		queue = enqueuePrompt(queue, prompt("two", "host-key", "b", "attempt-b"));
		expect(queue.map((item) => item.id)).toEqual(["one", "two"]);
		expect(removePrompt(queue, "one").at(0)?.id).toBe("two");
	});

	it("deduplicates the same prompt identity", () => {
		const item = prompt("one", "credential", "a", "attempt-a");
		expect(enqueuePrompt([item], { ...item, id: "duplicate" })).toEqual([item]);
	});

	it("removes stale attempts while retaining the current attempt", () => {
		const queue = [
			prompt("old", "credential", "a", "attempt-old"),
			prompt("current", "host-key", "a", "attempt-current"),
			prompt("other", "credential", "b", "attempt-b"),
		];
		expect(
			removeSessionPrompts(queue, "a", "attempt-current").map(
				(item) => item.id,
			),
		).toEqual(["current", "other"]);
	});
});
