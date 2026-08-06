import { useEffect, useRef } from "react";
import { Maximize2, PlugZap } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
	BinaryFrameHeaderSchema,
	ServerWebSocketMessageSchema,
	WS_PROTOCOL_VERSION,
	type EphemeralCredential,
	type ProfileResponse,
	type ServerHostKeyMessage,
	type ServerWebSocketMessage,
	type SessionState,
	type Settings,
} from "@edgesh/contracts";
import { ApiError, api } from "../lib/api";
import {
	decodeBinaryFrame,
	encodeBinaryFrame,
	type DecodedBinaryFrame,
} from "../lib/binary-frame";
import type { MessageKey } from "../lib/i18n";
import {
	createTerminalInputSender,
	type SessionChannel,
} from "../lib/session-channel";

const BINARY_HIGH_WATER_BYTES = 1024 * 1024;
const BINARY_LOW_WATER_BYTES = 256 * 1024;
const BINARY_DRAIN_TIMEOUT_MS = 10_000;

function terminalTheme(theme: Settings["theme"]) {
	return theme === "light"
		? {
				background: "#10141b",
				foreground: "#d6e0ea",
				cursor: "#3ddc97",
				cursorAccent: "#04120c",
				selectionBackground: "#274a3f",
				black: "#10141b",
				brightBlack: "#4b5869",
			}
		: {
				background: "#0b0e13",
				foreground: "#d6e0ea",
				cursor: "#3ddc97",
				cursorAccent: "#04120c",
				selectionBackground: "#274a3f",
				black: "#0b0e13",
				brightBlack: "#4b5869",
			};
}

type Props = {
	clientSessionId: string;
	profile: ProfileResponse;
	attemptId: string;
	connectRequested: boolean;
	ephemeralCredential?: EphemeralCredential;
	state: SessionState;
	active: boolean;
	pageVisible: boolean;
	monitoringEnabled: boolean;
	settings: Settings;
	t: (key: MessageKey) => string;
	onMessage: (attemptId: string, message: ServerWebSocketMessage) => void;
	onChannel: (attemptId: string, channel: SessionChannel | null) => void;
	onStateChange: (attemptId: string, state: SessionState) => void;
	onHostKey: (
		attemptId: string,
		message: ServerHostKeyMessage,
		respond: (decision: "trust_once" | "trust_and_save" | "reject") => void,
	) => void;
	onCredentialRequired: (attemptId: string) => void;
	onTicketIssued: (attemptId: string) => void;
	onTicketError: (attemptId: string, message: string) => void;
};

export function TerminalPane(props: Props) {
	const {
		clientSessionId,
		profile,
		attemptId,
		connectRequested,
		ephemeralCredential,
		state,
		active,
		pageVisible,
		monitoringEnabled,
		settings,
		t,
	} = props;
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal>();
	const fitRef = useRef<FitAddon>();
	const socketRef = useRef<WebSocket>();
	const channelRef = useRef<SessionChannel>();
	const statusRef = useRef<SessionState>(state);
	const activeRef = useRef(active);
	const callbacksRef = useRef(props);

	callbacksRef.current = props;
	statusRef.current = state;
	activeRef.current = active;

	function updateStatus(targetAttemptId: string, nextState: SessionState) {
		statusRef.current = nextState;
		callbacksRef.current.onStateChange(targetAttemptId, nextState);
	}

	function fitTerminal(focus: boolean) {
		const host = hostRef.current;
		const terminal = terminalRef.current;
		if (!host || !terminal || host.clientWidth < 2 || host.clientHeight < 1)
			return;
		fitRef.current?.fit();
		if (focus) terminal.focus();
	}

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const terminal = new Terminal({
			cursorBlink: settings.terminal.cursorBlink,
			fontFamily: settings.terminal.fontFamily,
			fontSize: settings.terminal.fontSize,
			scrollback: settings.terminal.scrollbackLines,
			theme: terminalTheme(settings.theme),
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.loadAddon(new WebLinksAddon());
		terminal.open(host);
		terminalRef.current = terminal;
		fitRef.current = fit;

		let selectionAtPointerDown = "";
		const rememberSelection = () => {
			selectionAtPointerDown = terminal.getSelection();
		};
		const copySelection = async () => {
			const text = terminal.getSelection();
			if (!text || text === selectionAtPointerDown) return;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				// Clipboard access is optional.
			}
		};
		const observer = new ResizeObserver(() => {
			if (activeRef.current) fitTerminal(false);
		});
		host.addEventListener("pointerdown", rememberSelection);
		host.addEventListener("pointerup", copySelection);
		observer.observe(host);
		fitTerminal(false);

		return () => {
			observer.disconnect();
			const socket = socketRef.current;
			socketRef.current = undefined;
			channelRef.current = undefined;
			socket?.close(1000, "workspace disposed");
			terminal.dispose();
			terminalRef.current = undefined;
			fitRef.current = undefined;
			host.removeEventListener("pointerdown", rememberSelection);
			host.removeEventListener("pointerup", copySelection);
		};
	}, []);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		terminal.options.cursorBlink = settings.terminal.cursorBlink;
		terminal.options.fontFamily = settings.terminal.fontFamily;
		terminal.options.fontSize = settings.terminal.fontSize;
		terminal.options.scrollback = settings.terminal.scrollbackLines;
		terminal.options.theme = terminalTheme(settings.theme);
		if (active) requestAnimationFrame(() => fitTerminal(false));
	}, [active, settings]);

	useEffect(() => {
		if (!active || !pageVisible) return;
		const frame = requestAnimationFrame(() => fitTerminal(true));
		return () => cancelAnimationFrame(frame);
	}, [active, pageVisible, attemptId]);

	useEffect(() => {
		const channel = channelRef.current;
		if (!channel || channel.attemptId !== attemptId) return;
		channel.send({
			type: "activity",
			active,
			visible: pageVisible,
			monitoring: monitoringEnabled,
			reduceWhenHidden: settings.monitoring.reduceWhenHidden,
			refreshIntervalSeconds: settings.monitoring.refreshIntervalSeconds,
		});
	}, [
		active,
		attemptId,
		monitoringEnabled,
		pageVisible,
		settings.monitoring.reduceWhenHidden,
		settings.monitoring.refreshIntervalSeconds,
	]);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal || !connectRequested) return;
		let disposed = false;
		let attemptSocket: WebSocket | undefined;

		terminal.clear();
		terminal.writeln(
			`\x1b[38;2;61;220;151m● Connecting to ${profile.username}@${profile.host}:${profile.port}\x1b[0m`,
		);
		updateStatus(attemptId, "authorizing");

		void api
			.createTicket({
				profileId: profile.id,
				attemptId,
				terminal: {
					columns: Math.max(2, terminal.cols),
					rows: Math.max(1, terminal.rows),
					type: profile.terminalType,
					encoding: profile.encoding,
				},
				ephemeralCredential,
			})
			.then((ticket) => {
				if (disposed) return;
				callbacksRef.current.onTicketIssued(attemptId);
				const protocol = location.protocol === "https:" ? "wss:" : "ws:";
				const url = new URL(ticket.webSocketPath, location.href);
				url.protocol = protocol;
				url.searchParams.set("session", ticket.sessionId);
				url.searchParams.set("ticket", ticket.ticket);
				url.searchParams.set("protocolVersion", String(ticket.protocolVersion));
				const socket = new WebSocket(url);
				attemptSocket = socket;
				socket.binaryType = "arraybuffer";
				const previousSocket = socketRef.current;
				socketRef.current = socket;
				previousSocket?.close(1000, "superseded");
				const messageListeners = new Set<
					(message: ServerWebSocketMessage) => void
				>();
				const binaryListeners = new Set<(frame: DecodedBinaryFrame) => void>();
				let binaryQueue = Promise.resolve();

				const isCurrentSocket = () => !disposed && socketRef.current === socket;
				const send = (message: Record<string, unknown>) => {
					if (!isCurrentSocket() || socket.readyState !== WebSocket.OPEN)
						return null;
					const requestId = crypto.randomUUID();
					socket.send(
						JSON.stringify({
							...message,
							protocolVersion: WS_PROTOCOL_VERSION,
							requestId,
							attemptId,
						}),
					);
					return requestId;
				};
				const sendInput = createTerminalInputSender(send);
				const waitForBrowserDrain = async () => {
					if (socket.bufferedAmount <= BINARY_HIGH_WATER_BYTES) return;
					const deadline = Date.now() + BINARY_DRAIN_TIMEOUT_MS;
					while (socket.bufferedAmount > BINARY_LOW_WATER_BYTES) {
						if (!isCurrentSocket() || socket.readyState !== WebSocket.OPEN) {
							throw new Error("SSH WebSocket closed during file transfer");
						}
						if (Date.now() >= deadline)
							throw new Error("SSH WebSocket backpressure timeout");
						await new Promise<void>((resolve) => setTimeout(resolve, 16));
					}
				};
				const sendBinary: SessionChannel["sendBinary"] = (
					kind,
					payload,
					options,
				) => {
					const transmit = async () => {
						await waitForBrowserDrain();
						if (!isCurrentSocket() || socket.readyState !== WebSocket.OPEN) {
							throw new Error("SSH WebSocket is not connected");
						}
						const header = BinaryFrameHeaderSchema.parse({
							protocolVersion: WS_PROTOCOL_VERSION,
							kind,
							sessionId: ticket.sessionId,
							attemptId,
							transferId: options.transferId,
							sequence: options.sequence,
							offset: options.offset,
							payloadBytes: payload.byteLength,
						});
						socket.send(encodeBinaryFrame(header, payload));
					};
					binaryQueue = binaryQueue.then(transmit, transmit);
					return binaryQueue;
				};
				const channel: SessionChannel = {
					clientSessionId,
					sessionId: ticket.sessionId,
					attemptId,
					send,
					sendInput,
					sendBinary,
					subscribe: (listener) => {
						messageListeners.add(listener);
						return () => messageListeners.delete(listener);
					},
					subscribeBinary: (listener) => {
						binaryListeners.add(listener);
						return () => binaryListeners.delete(listener);
					},
					close: (reason = "session closed") => {
						if (
							socket.readyState === WebSocket.OPEN ||
							socket.readyState === WebSocket.CONNECTING
						) {
							socket.close(1000, reason.slice(0, 120));
						}
					},
					isOpen: () =>
						isCurrentSocket() && socket.readyState === WebSocket.OPEN,
					bufferedAmount: () => socket.bufferedAmount,
				};

				socket.addEventListener("open", () => {
					if (!isCurrentSocket()) return;
					updateStatus(attemptId, "ssh_handshake");
					send({ type: "hello" });
					send({
						type: "connect",
						terminal: {
							columns: Math.max(2, terminal.cols),
							rows: Math.max(1, terminal.rows),
							type: profile.terminalType,
							encoding: profile.encoding,
						},
					});
					channelRef.current = channel;
					callbacksRef.current.onChannel(attemptId, channel);
					send({
						type: "activity",
						active: activeRef.current,
						visible: document.visibilityState === "visible",
						monitoring: callbacksRef.current.monitoringEnabled,
						reduceWhenHidden:
							callbacksRef.current.settings.monitoring.reduceWhenHidden,
						refreshIntervalSeconds:
							callbacksRef.current.settings.monitoring.refreshIntervalSeconds,
					});
				});
				socket.addEventListener("message", (event) => {
					if (!isCurrentSocket()) return;
					if (event.data instanceof ArrayBuffer) {
						try {
							const frame = decodeBinaryFrame(event.data);
							if (
								frame.header.sessionId !== ticket.sessionId ||
								frame.header.attemptId !== attemptId
							) {
								socket.close(4400, "Binary frame identity mismatch");
								return;
							}
							for (const listener of binaryListeners) listener(frame);
						} catch {
							socket.close(4400, "Invalid binary frame");
						}
						return;
					}
					if (typeof event.data !== "string") return;
					let parsed: unknown;
					try {
						parsed = JSON.parse(event.data) as unknown;
					} catch {
						socket.close(4400, "Invalid JSON message");
						return;
					}
					const result = ServerWebSocketMessageSchema.safeParse(parsed);
					if (!result.success) {
						socket.close(4400, "Invalid server message");
						return;
					}
					const message = result.data;
					if (
						message.sessionId !== ticket.sessionId ||
						message.attemptId !== attemptId
					) {
						socket.close(4400, "Server message identity mismatch");
						return;
					}
					callbacksRef.current.onMessage(attemptId, message);
					for (const listener of messageListeners) listener(message);
					if (message.type === "output") terminal.write(message.data);
					if (message.type === "status") updateStatus(attemptId, message.state);
					if (message.type === "error") {
						terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
						if (message.fatal) updateStatus(attemptId, "error");
					}
					if (message.type === "host-key") {
						callbacksRef.current.onHostKey(attemptId, message, (decision) => {
							send({
								type: "host-key-decision",
								fingerprint: message.fingerprint,
								decision,
							});
						});
					}
				});
				socket.addEventListener("close", (event) => {
					if (!isCurrentSocket()) return;
					socketRef.current = undefined;
					channelRef.current = undefined;
					if (statusRef.current !== "error")
						updateStatus(attemptId, event.code === 1000 ? "closed" : "error");
					callbacksRef.current.onChannel(attemptId, null);
				});
				socket.addEventListener("error", () => {
					if (isCurrentSocket()) updateStatus(attemptId, "error");
				});

				const input = terminal.onData((data) => {
					if (activeRef.current) channel.sendInput(data);
				});
				const resize = terminal.onResize(({ cols, rows }) => {
					if (cols >= 2 && rows >= 1)
						send({ type: "resize", columns: cols, rows });
				});
				socket.addEventListener(
					"close",
					() => {
						input.dispose();
						resize.dispose();
					},
					{ once: true },
				);
			})
			.catch((error: unknown) => {
				if (disposed) return;
				if (
					error instanceof ApiError &&
					error.code === "PROFILE_CREDENTIAL_REQUIRED"
				) {
					updateStatus(attemptId, "idle");
					callbacksRef.current.onCredentialRequired(attemptId);
					return;
				}
				updateStatus(attemptId, "error");
				const message =
					error instanceof Error ? error.message : "Connection failed";
				callbacksRef.current.onTicketError(attemptId, message);
				terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
			});

		return () => {
			disposed = true;
			callbacksRef.current.onChannel(attemptId, null);
			if (socketRef.current === attemptSocket) {
				socketRef.current = undefined;
				channelRef.current = undefined;
			}
			attemptSocket?.close(1000, "connection changed");
		};
	}, [attemptId, connectRequested]);

	function toggleFullscreen() {
		const node = hostRef.current?.closest(
			".terminal-panel",
		) as HTMLElement | null;
		if (!node) return;
		if (document.fullscreenElement) void document.exitFullscreen();
		else void node.requestFullscreen();
	}

	return (
		<section className="terminal-panel">
			<div className="terminal-toolbar">
				<span className="traffic-lights" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				<div className="terminal-title">
					<PlugZap size={14} />
					<span>
						{profile.username}@{profile.host}
					</span>
				</div>
				<span className={`connection-state state-${state}`}>
					{state.replaceAll("_", " ")}
				</span>
				<button
					type="button"
					className="icon-button"
					title="Fullscreen"
					onClick={toggleFullscreen}
				>
					<Maximize2 size={16} />
				</button>
			</div>
			<div className="terminal-host" ref={hostRef}>
				{state === "idle" || state === "closed" || state === "error" ? (
					<div className="terminal-idle" aria-hidden="true">
						<span className="terminal-idle-glyph">›_</span>
						<p>
							{profile.username}@{profile.host}:{profile.port}
						</p>
						<small>{state === "error" ? state : t("readyToConnect")}</small>
					</div>
				) : null}
			</div>
		</section>
	);
}
