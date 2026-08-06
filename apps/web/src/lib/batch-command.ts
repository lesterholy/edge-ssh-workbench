import {
	sessionDisplayName,
	type WorkbenchSessionsState,
} from "./workbench-sessions";

export const MAX_BATCH_COMMAND_LENGTH = 2_048;

export type BatchCommandTarget = {
	id: string;
	attemptId: string;
	sessionId: string;
	label: string;
	endpoint: string;
};

export type BatchCommandSendResult = {
	sentTargets: BatchCommandTarget[];
	skippedTargets: BatchCommandTarget[];
};

export function batchCommandTargetKey(target: BatchCommandTarget): string {
	return `${target.id}:${target.attemptId}:${target.sessionId}`;
}

export function terminalCommandInput(command: string): string | null {
	if (
		command.trim().length === 0 ||
		command.length > MAX_BATCH_COMMAND_LENGTH ||
		/[\r\n]/.test(command)
	) {
		return null;
	}
	return `${command}\r`;
}

export function connectedBatchCommandTargets(
	state: WorkbenchSessionsState,
): BatchCommandTarget[] {
	return state.order.flatMap((id) => {
		const session = state.sessions[id];
		const channel = session?.channel;
		if (
			!session ||
			session.state !== "connected" ||
			!channel?.isOpen() ||
			channel.attemptId !== session.attemptId
		) {
			return [];
		}
		return [
			{
				id,
				attemptId: session.attemptId,
				sessionId: channel.sessionId,
				label: sessionDisplayName(state, id) ?? session.profile.name,
				endpoint: `${session.profile.username}@${session.profile.host}:${session.profile.port}`,
			},
		];
	});
}

export function sendBatchCommand(
	state: WorkbenchSessionsState,
	targets: Iterable<BatchCommandTarget>,
	command: string,
): BatchCommandSendResult {
	const uniqueTargets = [
		...new Map(
			[...targets].map((target) => [batchCommandTargetKey(target), target]),
		).values(),
	];
	const input = terminalCommandInput(command);
	const sentTargets: BatchCommandTarget[] = [];
	const skippedTargets: BatchCommandTarget[] = [];

	for (const target of uniqueTargets) {
		const session = state.sessions[target.id];
		const channel = session?.channel;
		if (
			!input ||
			!session ||
			session.state !== "connected" ||
			session.attemptId !== target.attemptId ||
			channel?.attemptId !== target.attemptId ||
			channel.sessionId !== target.sessionId ||
			!channel.isOpen()
		) {
			skippedTargets.push(target);
			continue;
		}
		try {
			if (channel.sendInput(input)) sentTargets.push(target);
			else skippedTargets.push(target);
		} catch {
			skippedTargets.push(target);
		}
	}

	return { sentTargets, skippedTargets };
}
