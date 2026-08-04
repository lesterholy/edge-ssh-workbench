import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Files, KeyRound, Languages, LogOut, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, ShieldCheck, Sun, TerminalSquare } from "lucide-react";
import type {
  EphemeralCredential,
  Language,
  ProfileCreateRequest,
  ProfileResponse,
  ProfileUpdateRequest,
  ServerHostKeyMessageSchema,
  ServerMetricsMessageSchema,
  ServerWebSocketMessage,
  SessionState,
  Settings,
  TailscaleImportResponse,
  Theme
} from "@edgesh/contracts";
import { LoginView } from "./components/LoginView";
import { ProfileSidebar } from "./components/ProfileSidebar";
import type { SessionChannel } from "./components/TerminalPane";
import { MonitorPanel } from "./components/MonitorPanel";
import { FileWorkspace } from "./components/FileWorkspace";
import { HistoryPanel } from "./components/HistoryPanel";
import { CredentialDialog } from "./components/CredentialDialog";
import { SecurityDialog } from "./components/SecurityDialog";
import { TailscaleImportDialog } from "./components/TailscaleImportDialog";
import { api } from "./lib/api";
import { isSessionBusy, isSessionConnecting } from "./lib/connection-state";
import { translate } from "./lib/i18n";

const TerminalPane = lazy(async () => {
  const module = await import("./components/TerminalPane");
  return { default: module.TerminalPane };
});

type HostKeyMessage = typeof ServerHostKeyMessageSchema._output;
type MetricsMessage = typeof ServerMetricsMessageSchema._output;
type WorkTab = "files" | "history" | "log";
type ResizeSide = "left" | "right" | "bottom";

const MIN_SIDEBAR_W = 220;
const MAX_SIDEBAR_W = 480;
const MIN_MONITOR_W = 240;
const MAX_MONITOR_W = 560;
const MIN_BOTTOM_H = 150;
const MAX_BOTTOM_H = 600;
const MIN_CENTER_W = 520;
const MIN_TERMINAL_AREA_H = 360;

const now = () => new Date().toISOString();
const fallbackSettings: Settings = {
  language: (localStorage.getItem("edgesh.language") as Language) || "zh-CN",
  theme: (localStorage.getItem("edgesh.theme") as Theme) || "dark",
  terminal: { encoding: "utf-8", type: "xterm-256color", fontSize: 14, fontFamily: '"SFMono-Regular", "Cascadia Code", monospace', cursorBlink: true, scrollbackLines: 5000 },
  monitoring: { refreshIntervalSeconds: 8, reduceWhenHidden: true },
  history: { commandRetentionDays: 365, sessionRetentionDays: 90, collectCommands: true },
  updatedAt: now()
};

function clampSize(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [googleLoginEnabled, setGoogleLoginEnabled] = useState(false);
  const [settings, setSettings] = useState(fallbackSettings);
  const [profiles, setProfiles] = useState<ProfileResponse[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [connectSequence, setConnectSequence] = useState(0);
  const [channel, setChannel] = useState<SessionChannel | null>(null);
  const [lastMessage, setLastMessage] = useState<ServerWebSocketMessage | null>(null);
  const [metrics, setMetrics] = useState<MetricsMessage>();
  const [events, setEvents] = useState<string[]>([]);
  const [hostKey, setHostKey] = useState<{ message: HostKeyMessage; respond: (decision: "trust_once" | "trust_and_save" | "reject") => void }>();
  const [tab, setTab] = useState<WorkTab>("files");
  const [notice, setNotice] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [monitorOpen, setMonitorOpen] = useState(true);
  const [connectionState, setConnectionState] = useState<SessionState>("idle");
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [ephemeralCredential, setEphemeralCredential] = useState<EphemeralCredential>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState("");
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false);
  const [tailscaleImportOpen, setTailscaleImportOpen] = useState(false);
  const [tailscaleRefreshSignal, setTailscaleRefreshSignal] = useState(0);
  const selected = profiles.find((profile) => profile.id === selectedId);
  const t = useMemo(() => translate(settings.language), [settings.language]);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSize(Number(localStorage.getItem("edgesh.sidebarWidth")) || 288, MIN_SIDEBAR_W, MAX_SIDEBAR_W));
  const [monitorWidth, setMonitorWidth] = useState(() => clampSize(Number(localStorage.getItem("edgesh.monitorWidth")) || 300, MIN_MONITOR_W, MAX_MONITOR_W));
  const [bottomHeight, setBottomHeight] = useState(() => clampSize(Number(localStorage.getItem("edgesh.bottomHeight")) || 240, MIN_BOTTOM_H, MAX_BOTTOM_H));
  const sizesRef = useRef({ sidebarWidth, monitorWidth, bottomHeight });
  const centerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ axis: "x" | "y"; side: ResizeSide; startClient: number; startSize: number; min: number; max: number } | null>(null);

  useEffect(() => {
    api.authState().then((state) => {
      setAuthenticated(state.authenticated);
      setTotpEnabled(state.totpEnabled);
      setGoogleLoginEnabled(state.status === "anonymous" && state.googleLoginEnabled);
    }).catch(() => setAuthenticated(false)).finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.lang = settings.language;
  }, [settings.language, settings.theme]);
  useEffect(() => {
    sizesRef.current = { sidebarWidth, monitorWidth, bottomHeight };
  }, [sidebarWidth, monitorWidth, bottomHeight]);
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      const delta =
        drag.axis === "x"
          ? drag.side === "left"
            ? event.clientX - drag.startClient
            : drag.startClient - event.clientX
          : drag.startClient - event.clientY;
      const next = clampSize(drag.startSize + delta, drag.min, drag.max);
      if (drag.side === "left") {
        sizesRef.current.sidebarWidth = next;
        setSidebarWidth(next);
      } else if (drag.side === "right") {
        sizesRef.current.monitorWidth = next;
        setMonitorWidth(next);
      } else {
        sizesRef.current.bottomHeight = next;
        setBottomHeight(next);
      }
    }
    function finishResize(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const size = drag.side === "left" ? sizesRef.current.sidebarWidth
        : drag.side === "right" ? sizesRef.current.monitorWidth : sizesRef.current.bottomHeight;
      const key = drag.side === "left" ? "sidebarWidth" : drag.side === "right" ? "monitorWidth" : "bottomHeight";
      localStorage.setItem(`edgesh.${key}`, String(size));
      event.preventDefault();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    void Promise.all([api.profiles(), api.settings()]).then(([profileList, savedSettings]) => {
      setProfiles(profileList.items);
      setSelectedId(profileList.items[0]?.id);
      setSettings(savedSettings);
    }).catch((error) => setNotice(error instanceof Error ? error.message : "Unable to load workbench"));
  }, [authenticated]);
  useEffect(() => {
    setCredentialDialogOpen(false);
    setEphemeralCredential(undefined);
    setCredentialBusy(false);
    setCredentialError("");
  }, [selectedId]);

  function setLanguage(language: Language) {
    localStorage.setItem("edgesh.language", language);
    setSettings((current) => ({ ...current, language }));
    if (authenticated) void api.updateSettings({ language }).catch(() => undefined);
  }
  function setTheme(theme: Theme) {
    localStorage.setItem("edgesh.theme", theme);
    setSettings((current) => ({ ...current, theme }));
    if (authenticated) void api.updateSettings({ theme }).catch(() => undefined);
  }
  async function createProfile(input: ProfileCreateRequest) {
    const profile = await api.createProfile(input);
    setProfiles((current) => [profile, ...current]);
    setSelectedId(profile.id);
  }
  function selectProfile(id: string) {
    setSelectedId(id);
    setConnectionState("idle");
  }
  async function updateProfile(id: string, input: ProfileUpdateRequest) {
    const profile = await api.updateProfile(id, input);
    setProfiles((current) => current.map((item) => item.id === id ? profile : item));
  }
  async function deleteProfile(id: string) {
    await api.deleteProfile(id);
    setProfiles((current) => current.filter((profile) => profile.id !== id));
    if (selectedId === id) setSelectedId(undefined);
  }
  function handleTailscaleImport(response: TailscaleImportResponse) {
    setProfiles((current) => [...response.created, ...current]);
    if (response.created.length > 0 && !selectedId) {
      setSelectedId(response.created[0]!.id);
    }
  }
  function protocolMessage(message: ServerWebSocketMessage) {
    setLastMessage(message);
    if (message.type === "metrics") setMetrics(message);
    if (message.type === "status") {
      setConnectionState(message.state);
      setEvents((current) => [`${new Date(message.occurredAt).toLocaleTimeString()}  ${message.message}`, ...current].slice(0, 200));
    }
    if (message.type === "error") setEvents((current) => [`${new Date().toLocaleTimeString()}  ERROR  ${message.message}`, ...current].slice(0, 200));
  }
  function beginConnection(profile: ProfileResponse) {
    if (isSessionBusy(connectionState)) return;
    setSelectedId(profile.id);
    setEphemeralCredential(undefined);
    setCredentialBusy(false);
    setCredentialError("");
    if (profile.credentialPersistence === "prompt") {
      setCredentialDialogOpen(true);
      return;
    }
    setConnectionState("authorizing");
    setConnectSequence((value) => value + 1);
  }
  function connect() {
    if (selected) beginConnection(selected);
  }
  function resizeBounds(side: ResizeSide): { min: number; max: number } {
    if (side === "bottom") {
      const available = (centerRef.current?.clientHeight ?? window.innerHeight) - MIN_TERMINAL_AREA_H;
      return { min: MIN_BOTTOM_H, max: Math.max(MIN_BOTTOM_H, Math.min(MAX_BOTTOM_H, available)) };
    }
    const monitorVisible = monitorOpen && window.matchMedia("(min-width: 1200px)").matches;
    const otherWidth = side === "left"
      ? (monitorVisible ? sizesRef.current.monitorWidth : 0)
      : (sidebarOpen ? sizesRef.current.sidebarWidth : 0);
    const hardMax = side === "left" ? MAX_SIDEBAR_W : MAX_MONITOR_W;
    const min = side === "left" ? MIN_SIDEBAR_W : MIN_MONITOR_W;
    return { min, max: Math.max(min, Math.min(hardMax, window.innerWidth - otherWidth - MIN_CENTER_W)) };
  }
  function setPanelSize(side: ResizeSide, value: number) {
    const bounds = resizeBounds(side);
    const next = clampSize(value, bounds.min, bounds.max);
    if (side === "left") setSidebarWidth(next);
    else if (side === "right") setMonitorWidth(next);
    else setBottomHeight(next);
    sizesRef.current = {
      ...sizesRef.current,
      ...(side === "left" ? { sidebarWidth: next } : side === "right" ? { monitorWidth: next } : { bottomHeight: next })
    };
    const key = side === "left" ? "sidebarWidth" : side === "right" ? "monitorWidth" : "bottomHeight";
    localStorage.setItem(`edgesh.${key}`, String(next));
  }
  function startResize(event: React.PointerEvent, axis: "x" | "y", side: ResizeSide) {
    event.preventDefault();
    const startSize = side === "left" ? sidebarWidth : side === "right" ? monitorWidth : bottomHeight;
    dragRef.current = { axis, side, startClient: axis === "x" ? event.clientX : event.clientY, startSize, ...resizeBounds(side) };
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }
  function resizeWithKeyboard(event: React.KeyboardEvent, side: ResizeSide) {
    const step = event.shiftKey ? 40 : 12;
    let delta = 0;
    if (side === "left" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) delta = event.key === "ArrowRight" ? step : -step;
    if (side === "right" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) delta = event.key === "ArrowLeft" ? step : -step;
    if (side === "bottom" && (event.key === "ArrowUp" || event.key === "ArrowDown")) delta = event.key === "ArrowUp" ? step : -step;
    if (!delta) return;
    event.preventDefault();
    const current = side === "left" ? sidebarWidth : side === "right" ? monitorWidth : bottomHeight;
    setPanelSize(side, current + delta);
  }

  function connectProfile(id: string) {
    const profile = profiles.find((item) => item.id === id);
    if (profile) beginConnection(profile);
  }
  function connectWithCredential(credential: EphemeralCredential) {
    setEphemeralCredential(credential);
    setCredentialBusy(true);
    setCredentialError("");
    setConnectionState("authorizing");
    setConnectSequence((value) => value + 1);
  }
  function disconnect() {
    if (!channel) {
      setConnectionState("closed");
      return;
    }
    setConnectionState("disconnecting");
    if (!channel.send({ type: "disconnect", attemptId: channel.attemptId })) {
      setChannel(null);
      setConnectionState("closed");
    }
  }
  function closeCredentialDialog() {
    setCredentialDialogOpen(false);
    setEphemeralCredential(undefined);
    setCredentialBusy(false);
    setCredentialError("");
  }
  async function logout() {
    channel?.send({ type: "disconnect", attemptId: channel.attemptId });
    await api.logout();
    setCredentialDialogOpen(false);
    setEphemeralCredential(undefined);
    setCredentialBusy(false);
    setCredentialError("");
    setSecurityDialogOpen(false);
    setAuthenticated(false);
  }

  if (booting) return <main className="boot-screen">{t("loading")}...</main>;
  if (!authenticated) return <LoginView language={settings.language} theme={settings.theme} googleLoginEnabled={googleLoginEnabled} t={t} onLanguage={setLanguage} onTheme={setTheme} onAuthenticated={(enabled) => { setTotpEnabled(enabled); setAuthenticated(true); }} />;

  const connected = connectionState === "connected";
  const connectionBusy = isSessionBusy(connectionState);
  const connecting = isSessionConnecting(connectionState);
  const gridClass = `workspace-grid${sidebarOpen ? "" : " sidebar-hidden"}${monitorOpen ? "" : " monitor-hidden"}`;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark"><KeyRound size={16} /></span>
          <div className="brand-text">
            <strong>{t("appName")}</strong>
            <span>{selected ? `${selected.username}@${selected.host}:${selected.port}` : t("noServer")}</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" title={t("servers")} aria-label={t("servers")} onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <button className="icon-button" type="button" title={t("liveStatus")} aria-label={t("liveStatus")} onClick={() => setMonitorOpen((value) => !value)}>
            <Activity size={17} />
          </button>
          <button className="icon-button security-button" type="button" title={t("securitySettings")} aria-label={t("securitySettings")} onClick={() => setSecurityDialogOpen(true)}>
            <ShieldCheck size={17} />
            <span className={totpEnabled ? "security-dot enabled" : "security-dot"} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" title={t("language")} onClick={() => setLanguage(settings.language === "zh-CN" ? "en" : "zh-CN")}><Languages size={17} /></button>
          <button className="icon-button" type="button" title={t("theme")} onClick={() => setTheme(settings.theme === "dark" ? "light" : "dark")}>{settings.theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button className="logout-button" type="button" onClick={() => void logout()}><LogOut size={16} /> {t("signOut")}</button>
        </div>
      </header>
      {notice ? <div className="notice" role="alert">{notice}</div> : null}
      <main
        className={gridClass}
        style={{
          "--sidebar-w": `${sidebarWidth}px`,
          "--monitor-w": `${monitorWidth}px`,
          "--bottom-h": `${bottomHeight}px`,
        } as React.CSSProperties}
      >
        {sidebarOpen ? (
          <div
            className="resize-handle resize-handle-v resize-handle-left"
            role="separator"
            aria-label={t("resizeServers")}
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_W}
            aria-valuemax={MAX_SIDEBAR_W}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={(event) => startResize(event, "x", "left")}
            onKeyDown={(event) => resizeWithKeyboard(event, "left")}
          />
        ) : null}
        {monitorOpen ? (
          <div
            className="resize-handle resize-handle-v resize-handle-right"
            role="separator"
            aria-label={t("resizeStatus")}
            aria-orientation="vertical"
            aria-valuemin={MIN_MONITOR_W}
            aria-valuemax={MAX_MONITOR_W}
            aria-valuenow={monitorWidth}
            tabIndex={0}
            onPointerDown={(event) => startResize(event, "x", "right")}
            onKeyDown={(event) => resizeWithKeyboard(event, "right")}
          />
        ) : null}

        <ProfileSidebar profiles={profiles} selectedId={selectedId} connectionBusy={connectionBusy} t={t} onSelect={selectProfile} onConnect={connectProfile} onCreate={createProfile} onUpdate={updateProfile} onDelete={deleteProfile} onTailscaleImportOpen={() => setTailscaleImportOpen(true)} tailscaleRefreshSignal={tailscaleRefreshSignal} />
        <div className="center-workspace" ref={centerRef}>
          <div
            className="resize-handle resize-handle-h resize-handle-bottom"
            role="separator"
            aria-label={t("resizeTerminal")}
            aria-orientation="horizontal"
            aria-valuemin={MIN_BOTTOM_H}
            aria-valuemax={MAX_BOTTOM_H}
            aria-valuenow={bottomHeight}
            tabIndex={0}
            onPointerDown={(event) => startResize(event, "y", "bottom")}
            onKeyDown={(event) => resizeWithKeyboard(event, "bottom")}
          />
          <div className="connection-strip">
            <div className="connection-target">
              <span className={`status-pulse${connected ? " on" : ""}${connectionState === "error" ? " err" : ""}`} aria-hidden="true" />
              <div className="brand-text">
                <span className="target-name">{selected?.name ?? t("noServer")}</span>
                {selected ? <span className="target-sub">{selected.username}@{selected.host}:{selected.port}</span> : null}
              </div>
            </div>
            <div>
              {channel && connectionBusy ? <button type="button" className="secondary-button compact-button" disabled={connectionState === "disconnecting"} onClick={disconnect}>{t("disconnect")}</button> : null}
              <button type="button" className="primary-button compact-button" disabled={!selected || connectionBusy} onClick={connect}>
                {connecting ? `${t("connecting")}...` : t("connect")}
              </button>
            </div>
          </div>
          <Suspense fallback={<section className="terminal-panel boot-screen">{t("loading")}...</section>}>
            <TerminalPane
              profile={selected}
              connectSequence={connectSequence}
              ephemeralCredential={ephemeralCredential}
              settings={settings}
              t={t}
              onMessage={protocolMessage}
              onChannel={setChannel}
              onStateChange={setConnectionState}
              onHostKey={(message, respond) => setHostKey({ message, respond })}
              onCredentialRequired={() => { setEphemeralCredential(undefined); setCredentialBusy(false); setCredentialError(t("credentialRequired")); setCredentialDialogOpen(true); }}
              onTicketIssued={() => { setEphemeralCredential(undefined); setCredentialBusy(false); setCredentialError(""); setCredentialDialogOpen(false); }}
              onTicketError={(message) => {
                setEphemeralCredential(undefined);
                if (credentialDialogOpen) {
                  setCredentialBusy(false);
                  setCredentialError(message);
                }
              }}
            />
          </Suspense>
          <div className="bottom-workspace">
            <div className="work-tabs" role="tablist">
              <button className={tab === "files" ? "active" : ""} type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}><Files size={15} />{t("files")}</button>
              <button className={tab === "history" ? "active" : ""} type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><TerminalSquare size={15} />{t("history")}</button>
              <button className={tab === "log" ? "active" : ""} type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}><ScrollText size={15} />{t("sessionLog")}</button>
            </div>
            <div className="tab-content">
              {tab === "files" ? <FileWorkspace channel={connected ? channel : null} message={lastMessage} t={t} /> : null}
              {tab === "history" ? <HistoryPanel t={t} connected={connected} channel={connected ? channel : null} profile={selected} message={lastMessage} /> : null}
              {tab === "log" ? <div className="event-log">{events.map((event, index) => <code key={`${index}-${event}`}>{event}</code>)}</div> : null}
            </div>
          </div>
        </div>
        <MonitorPanel metrics={metrics} t={t} />
      </main>
      {hostKey ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="host-dialog" role="dialog" aria-modal="true" aria-labelledby="host-dialog-title">
            <h2 id="host-dialog-title">{hostKey.message.changed ? t("changedHostKey") : t("firstHostKey")}</h2>
            <p>{hostKey.message.host}:{hostKey.message.port}</p>
            <dl><dt>{hostKey.message.algorithm}</dt><dd>{hostKey.message.fingerprint}</dd>{hostKey.message.previousFingerprint ? <><dt>Previous</dt><dd>{hostKey.message.previousFingerprint}</dd></> : null}</dl>
            <div className="dialog-actions">
              <button type="button" className="danger-button" onClick={() => { hostKey.respond("reject"); setHostKey(undefined); }}>{t("reject")}</button>
              {!hostKey.message.changed ? <button type="button" className="secondary-button" onClick={() => { hostKey.respond("trust_once"); setHostKey(undefined); }}>{t("trustOnce")}</button> : null}
              {!hostKey.message.changed ? <button type="button" className="primary-button" onClick={() => { hostKey.respond("trust_and_save"); setHostKey(undefined); }}>{t("trustSave")}</button> : null}
            </div>
          </div>
        </div>
      ) : null}
      {credentialDialogOpen && selected ? <CredentialDialog profile={selected} busy={credentialBusy} requestError={credentialError} t={t} onCancel={closeCredentialDialog} onSubmit={connectWithCredential} /> : null}
      {tailscaleImportOpen ? <TailscaleImportDialog t={t} onClose={() => { setTailscaleImportOpen(false); setTailscaleRefreshSignal((value) => value + 1); }} onImported={handleTailscaleImport} /> : null}
      {securityDialogOpen ? <SecurityDialog enabled={totpEnabled} t={t} onClose={() => setSecurityDialogOpen(false)} onChanged={setTotpEnabled} /> : null}
    </div>
  );
}
