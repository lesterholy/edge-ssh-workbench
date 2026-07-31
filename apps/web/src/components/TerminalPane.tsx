import { useEffect, useRef, useState } from "react";
import { Maximize2, PlugZap } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  BinaryFrameHeaderSchema,
  ServerWebSocketMessageSchema,
  WS_PROTOCOL_VERSION,
  type BinaryFrameKind,
  type EphemeralCredential,
  type ProfileResponse,
  type ServerHostKeyMessageSchema,
  type ServerWebSocketMessage,
  type SessionState,
  type Settings
} from "@edgesh/contracts";
import { ApiError, api } from "../lib/api";
import { decodeBinaryFrame, encodeBinaryFrame, type DecodedBinaryFrame } from "../lib/binary-frame";
import type { MessageKey } from "../lib/i18n";

export type SessionChannel = {
  sessionId: string;
  attemptId: string;
  send: (message: Record<string, unknown>) => string | null;
  sendBinary: (
    kind: BinaryFrameKind,
    payload: Uint8Array,
    options: { sequence: number; transferId?: string; offset?: number },
  ) => void;
  subscribeBinary: (listener: (frame: DecodedBinaryFrame) => void) => () => void;
};

type HostKeyMessage = typeof ServerHostKeyMessageSchema._output;

// Keep the xterm palette in sync with styles.css so the terminal reads as part
// of the same surface system. Dark terminal stays dark in both UI themes.
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
  profile?: ProfileResponse;
  connectSequence: number;
  ephemeralCredential?: EphemeralCredential;
  settings: Settings;
  t: (key: MessageKey) => string;
  onMessage: (message: ServerWebSocketMessage) => void;
  onChannel: (channel: SessionChannel | null) => void;
  onStateChange: (state: SessionState) => void;
  onHostKey: (message: HostKeyMessage, respond: (decision: "trust_once" | "trust_and_save" | "reject") => void) => void;
  onCredentialRequired: () => void;
  onTicketIssued: () => void;
  onTicketError: (message: string) => void;
};

export function TerminalPane({ profile, connectSequence, ephemeralCredential, settings, t, onMessage, onChannel, onStateChange, onHostKey, onCredentialRequired, onTicketIssued, onTicketError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const socketRef = useRef<WebSocket>();
  const statusRef = useRef<SessionState>("idle");
  const [status, setStatus] = useState<SessionState>("idle");

  function updateStatus(nextStatus: SessionState) {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    onStateChange(nextStatus);
  }

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: settings.terminal.cursorBlink,
      fontFamily: settings.terminal.fontFamily,
      fontSize: settings.terminal.fontSize,
      scrollback: settings.terminal.scrollbackLines,
      theme: terminalTheme(settings.theme)
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(hostRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      const socket = socketRef.current;
      socketRef.current = undefined;
      socket?.close(1000, "component disposed");
      terminal.dispose();
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
    fitRef.current?.fit();
  }, [settings]);

  useEffect(() => {
    if (statusRef.current === "closed" || statusRef.current === "error") updateStatus("idle");
  }, [profile?.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || connectSequence === 0 || !profile) return;
    let disposed = false;
    let attemptSocket: WebSocket | undefined;
    const attemptId = crypto.randomUUID();
    let inputSequence = 0;
    terminal.clear();
    terminal.writeln(`\x1b[38;2;61;220;151m● Connecting to ${profile.username}@${profile.host}:${profile.port}\x1b[0m`);
    updateStatus("authorizing");

    void api.createTicket({
      profileId: profile.id,
      attemptId,
      terminal: {
        columns: terminal.cols,
        rows: terminal.rows,
        type: profile.terminalType,
        encoding: profile.encoding
      },
      ephemeralCredential
    }).then((ticket) => {
      if (disposed) return;
      onTicketIssued();
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
      const binaryListeners = new Set<(frame: DecodedBinaryFrame) => void>();

      const send = (message: Record<string, unknown>) => {
        if (socket.readyState !== WebSocket.OPEN) return null;
        const requestId = crypto.randomUUID();
        socket.send(JSON.stringify({ protocolVersion: WS_PROTOCOL_VERSION, requestId, ...message }));
        return requestId;
      };
      const sendBinary: SessionChannel["sendBinary"] = (kind, payload, options) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const header = BinaryFrameHeaderSchema.parse({
          protocolVersion: WS_PROTOCOL_VERSION,
          kind,
          sessionId: ticket.sessionId,
          transferId: options.transferId,
          sequence: options.sequence,
          offset: options.offset,
          payloadBytes: payload.byteLength,
        });
        socket.send(encodeBinaryFrame(header, payload));
      };

      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) return;
        updateStatus("ssh_handshake");
        send({ type: "hello", attemptId });
        send({
          type: "connect",
          attemptId,
          terminal: { columns: terminal.cols, rows: terminal.rows, type: profile.terminalType, encoding: profile.encoding }
        });
        onChannel({
          sessionId: ticket.sessionId,
          attemptId,
          send,
          sendBinary,
          subscribeBinary: (listener) => {
            binaryListeners.add(listener);
            return () => binaryListeners.delete(listener);
          },
        });
      });
      socket.addEventListener("message", (event) => {
        if (socketRef.current !== socket) return;
        if (event.data instanceof ArrayBuffer) {
          try {
            const frame = decodeBinaryFrame(event.data);
            for (const listener of binaryListeners) listener(frame);
          } catch {
            socket.close(4400, "Invalid binary frame");
          }
          return;
        }
        if (typeof event.data !== "string") return;
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { return; }
        const result = ServerWebSocketMessageSchema.safeParse(parsed);
        if (!result.success) return;
        const message = result.data;
        onMessage(message);
        if (message.type === "output") terminal.write(message.data);
        if (message.type === "status") updateStatus(message.state);
        if (message.type === "error") {
          terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
          if (message.fatal) updateStatus("error");
        }
        if (message.type === "host-key") {
          onHostKey(message, (decision) => send({ type: "host-key-decision", attemptId, fingerprint: message.fingerprint, decision }));
        }
      });
      socket.addEventListener("close", (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = undefined;
        if (statusRef.current !== "error") updateStatus(event.code === 1000 ? "closed" : "error");
        onChannel(null);
      });
      socket.addEventListener("error", () => {
        if (socketRef.current === socket) updateStatus("error");
      });

      const input = terminal.onData((data) => send({ type: "input", attemptId, sequence: inputSequence++, data }));
      const resize = terminal.onResize(({ cols, rows }) => send({ type: "resize", attemptId, columns: cols, rows }));
      socket.addEventListener("close", () => { input.dispose(); resize.dispose(); }, { once: true });
    }).catch((error) => {
      if (disposed) return;
      if (error instanceof ApiError && error.code === "PROFILE_CREDENTIAL_REQUIRED") {
        updateStatus("idle");
        onCredentialRequired();
        return;
      }
      updateStatus("error");
      const message = error instanceof Error ? error.message : "Connection failed";
      onTicketError(message);
      terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
    });

    return () => {
      disposed = true;
      onChannel(null);
      if (socketRef.current === attemptSocket) socketRef.current = undefined;
      attemptSocket?.close(1000, "connection changed");
    };
  }, [connectSequence]);

  function toggleFullscreen() {
    const node = hostRef.current?.closest(".terminal-panel") as HTMLElement | null;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen();
  }

  return (
    <section className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="traffic-lights" aria-hidden="true"><i /><i /><i /></span>
        <div className="terminal-title"><PlugZap size={14} /><span>{profile ? `${profile.username}@${profile.host}` : "terminal"}</span></div>
        <span className={`connection-state state-${status}`}>{status.replaceAll("_", " ")}</span>
        <button type="button" className="icon-button" title="Fullscreen" onClick={toggleFullscreen}><Maximize2 size={16} /></button>
      </div>
      <div className="terminal-host" ref={hostRef}>
        {status === "idle" ? (
          <div className="terminal-idle" aria-hidden="true">
            <span className="terminal-idle-glyph">›_</span>
            <p>{profile ? `${profile.username}@${profile.host}:${profile.port}` : "EdgeSSH Workbench"}</p>
            <small>{profile ? t("readyToConnect") : t("selectServerToBegin")}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}
