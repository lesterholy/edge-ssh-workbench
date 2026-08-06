import type {
	BinaryFrameKind,
	ServerWebSocketMessage,
} from "@edgesh/contracts";
import type { DecodedBinaryFrame } from "./binary-frame";

export type SessionMessageSender = (
	message: Record<string, unknown>,
) => string | null;
export type SessionInputSender = (data: string) => string | null;

export type SessionChannel = {
	clientSessionId: string;
	sessionId: string;
	attemptId: string;
	send: SessionMessageSender;
	sendInput: SessionInputSender;
	sendBinary: (
		kind: BinaryFrameKind,
		payload: Uint8Array,
		options: { sequence: number; transferId?: string; offset?: number },
	) => Promise<void>;
	subscribe: (
		listener: (message: ServerWebSocketMessage) => void,
	) => () => void;
	subscribeBinary: (
		listener: (frame: DecodedBinaryFrame) => void,
	) => () => void;
	close: (reason?: string) => void;
	isOpen: () => boolean;
	bufferedAmount: () => number;
};

export function createTerminalInputSender(
	send: SessionMessageSender,
): SessionInputSender {
	let sequence = 0;
	return (data) => {
		const requestId = send({ type: "input", sequence, data });
		if (requestId) sequence += 1;
		return requestId;
	};
}

export function matchesChannelIdentity(
	channel: Pick<SessionChannel, "sessionId" | "attemptId">,
	identity: { sessionId: string; attemptId: string },
): boolean {
	return (
		channel.sessionId === identity.sessionId &&
		channel.attemptId === identity.attemptId
	);
}
