import { lazy, Suspense } from "react";
import type {
	EphemeralCredential,
	ServerHostKeyMessage,
	ServerWebSocketMessage,
	SessionState,
	Settings,
} from "@edgesh/contracts";
import type { MessageKey } from "../lib/i18n";
import type { SessionChannel } from "../lib/session-channel";
import type { WorkbenchSession } from "../lib/workbench-sessions";

const TerminalPane = lazy(async () => {
	const module = await import("./TerminalPane");
	return { default: module.TerminalPane };
});

type Props = {
	session: WorkbenchSession;
	credential?: EphemeralCredential;
	visible: boolean;
	focused: boolean;
	pageVisible: boolean;
	monitoringEnabled: boolean;
	settings: Settings;
	t: (key: MessageKey) => string;
	onFocus: (id: string) => void;
	onMessage: (
		id: string,
		attemptId: string,
		message: ServerWebSocketMessage,
	) => void;
	onChannel: (
		id: string,
		attemptId: string,
		channel: SessionChannel | null,
	) => void;
	onStateChange: (id: string, attemptId: string, state: SessionState) => void;
	onHostKey: (
		id: string,
		attemptId: string,
		message: ServerHostKeyMessage,
		respond: (decision: "trust_once" | "trust_and_save" | "reject") => void,
	) => void;
	onCredentialRequired: (id: string, attemptId: string) => void;
	onTicketIssued: (id: string, attemptId: string) => void;
	onTicketError: (id: string, attemptId: string, message: string) => void;
};

export function SessionWorkspace({
	session,
	credential,
	visible,
	focused,
	pageVisible,
	monitoringEnabled,
	settings,
	t,
	onFocus,
	onMessage,
	onChannel,
	onStateChange,
	onHostKey,
	onCredentialRequired,
	onTicketIssued,
	onTicketError,
}: Props) {
	return (
		<div
			className={`session-workspace${visible ? " visible" : ""}${focused ? " focused" : ""}`}
			aria-hidden={!visible}
			onPointerDown={() => {
				if (visible && !focused) onFocus(session.id);
			}}
			onFocusCapture={() => {
				if (visible && !focused) onFocus(session.id);
			}}
		>
			<Suspense
				fallback={
					<div className="terminal-loading">{t("loadingTerminal")}</div>
				}
			>
				<TerminalPane
					clientSessionId={session.id}
					profile={session.profile}
					attemptId={session.attemptId}
					connectRequested={session.connectRequested}
					ephemeralCredential={credential}
					state={session.state}
					active={focused}
					pageVisible={pageVisible}
					monitoringEnabled={monitoringEnabled}
					settings={settings}
					t={t}
					onMessage={(attemptId, message) =>
						onMessage(session.id, attemptId, message)
					}
					onChannel={(attemptId, channel) =>
						onChannel(session.id, attemptId, channel)
					}
					onStateChange={(attemptId, state) =>
						onStateChange(session.id, attemptId, state)
					}
					onHostKey={(attemptId, message, respond) =>
						onHostKey(session.id, attemptId, message, respond)
					}
					onCredentialRequired={(attemptId) =>
						onCredentialRequired(session.id, attemptId)
					}
					onTicketIssued={(attemptId) => onTicketIssued(session.id, attemptId)}
					onTicketError={(attemptId, message) =>
						onTicketError(session.id, attemptId, message)
					}
				/>
			</Suspense>
		</div>
	);
}
