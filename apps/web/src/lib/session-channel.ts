import type {
	BinaryFrameKind,
	ServerWebSocketMessage,
} from "@edgesh/contracts";
import type { DecodedBinaryFrame } from "./binary-frame";

export type SessionChannel = {
	clientSessionId: string;
	sessionId: string;
	attemptId: string;
	send: (message: Record<string, unknown>) => string | null;
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

export function matchesChannelIdentity(
	channel: Pick<SessionChannel, "sessionId" | "attemptId">,
	identity: { sessionId: string; attemptId: string },
): boolean {
	return (
		channel.sessionId === identity.sessionId &&
		channel.attemptId === identity.attemptId
	);
}
