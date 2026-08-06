export type PromptIdentity = {
	id: string;
	kind: "credential" | "host-key";
	clientSessionId: string;
	attemptId: string;
};

export function enqueuePrompt<T extends PromptIdentity>(
	queue: T[],
	prompt: T,
): T[] {
	const duplicate = queue.some(
		(item) =>
			item.kind === prompt.kind &&
			item.clientSessionId === prompt.clientSessionId &&
			item.attemptId === prompt.attemptId,
	);
	return duplicate ? queue : [...queue, prompt];
}

export function removePrompt<T extends PromptIdentity>(
	queue: T[],
	id: string,
): T[] {
	return queue.filter((prompt) => prompt.id !== id);
}

export function removeSessionPrompts<T extends PromptIdentity>(
	queue: T[],
	clientSessionId: string,
	currentAttemptId?: string,
): T[] {
	return queue.filter(
		(prompt) =>
			prompt.clientSessionId !== clientSessionId ||
			(currentAttemptId !== undefined && prompt.attemptId === currentAttemptId),
	);
}
