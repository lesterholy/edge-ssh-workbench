import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
  Settings,
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
import { api } from "./lib/api";
import { translate } from "./lib/i18n";

const TerminalPane = lazy(async () => {
  const module = await import("./components/TerminalPane");
  return { default: module.TerminalPane };
});

type HostKeyMessage = typeof ServerHostKeyMessageSchema._output;
type MetricsMessage = typeof ServerMetricsMessageSchema._output;
type WorkTab = "files" | "history" | "log";

const now = () => new Date().toISOString();
const fallbackSettings: Settings = {
  language: (localStorage.getItem("edgesh.language") as Language) || "zh-CN",
  theme: (localStorage.getItem("edgesh.theme") as Theme) || "dark",
  terminal: { encoding: "utf-8", type: "xterm-256color", fontSize: 14, fontFamily: '"SFMono-Regular", "Cascadia Code", monospace', cursorBlink: true, scrollbackLines: 5000 },
  monitoring: { refreshIntervalSeconds: 8, reduceWhenHidden: true },
  history: { commandRetentionDays: 365, sessionRetentionDays: 90, collectCommands: true },
  updatedAt: now()
};

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
  const [connectionState, setConnectionState] = useState("idle");
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [ephemeralCredential, setEphemeralCredential] = useState<EphemeralCredential>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState("");
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false);
  const selected = profiles.find((profile) => profile.id === selectedId);
  const t = useMemo(() => translate(settings.language), [settings.language]);

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
  function protocolMessage(message: ServerWebSocketMessage) {
    setLastMessage(message);
    if (message.type === "metrics") setMetrics(message);
    if (message.type === "status") {
      setConnectionState(message.state);
      setEvents((current) => [`${new Date(message.occurredAt).toLocaleTimeString()}  ${message.message}`, ...current].slice(0, 200));
    }
    if (message.type === "error") setEvents((current) => [`${new Date().toLocaleTimeString()}  ERROR  ${message.message}`, ...current].slice(0, 200));
  }
  function connect() {
    if (!selected) return;
    setEphemeralCredential(undefined);
    setCredentialBusy(false);
    setCredentialError("");
    if (selected.credentialPersistence === "prompt") {
      setCredentialDialogOpen(true);
      return;
    }
    setConnectSequence((value) => value + 1);
  }
  function connectWithCredential(credential: EphemeralCredential) {
    setEphemeralCredential(credential);
    setCredentialBusy(true);
    setCredentialError("");
    setConnectSequence((value) => value + 1);
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
  const connecting = ["authorizing", "tcp_connecting", "ssh_handshake", "host_confirmation", "authenticating"].includes(connectionState);
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
      <main className={gridClass}>
        <ProfileSidebar profiles={profiles} selectedId={selectedId} t={t} onSelect={selectProfile} onCreate={createProfile} onUpdate={updateProfile} onDelete={deleteProfile} />
        <div className="center-workspace">
          <div className="connection-strip">
            <div className="connection-target">
              <span className={`status-pulse${connected ? " on" : ""}${connectionState === "error" ? " err" : ""}`} aria-hidden="true" />
              <div className="brand-text">
                <span className="target-name">{selected?.name ?? t("noServer")}</span>
                {selected ? <span className="target-sub">{selected.username}@{selected.host}:{selected.port}</span> : null}
              </div>
            </div>
            <div>
              {channel ? <button type="button" className="secondary-button compact-button" onClick={() => channel.send({ type: "disconnect", attemptId: channel.attemptId })}>{t("disconnect")}</button> : null}
              <button type="button" className="primary-button compact-button" disabled={!selected || connecting || connected} onClick={connect}>
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
          <div className="work-tabs" role="tablist">
            <button className={tab === "files" ? "active" : ""} type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}><Files size={15} />{t("files")}</button>
            <button className={tab === "history" ? "active" : ""} type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><TerminalSquare size={15} />{t("history")}</button>
            <button className={tab === "log" ? "active" : ""} type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}><ScrollText size={15} />{t("sessionLog")}</button>
          </div>
          <div className="tab-content">
            {tab === "files" ? <FileWorkspace channel={channel} message={lastMessage} t={t} /> : null}
            {tab === "history" ? <HistoryPanel t={t} /> : null}
            {tab === "log" ? <div className="event-log">{events.map((event, index) => <code key={`${index}-${event}`}>{event}</code>)}</div> : null}
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
      {securityDialogOpen ? <SecurityDialog enabled={totpEnabled} t={t} onClose={() => setSecurityDialogOpen(false)} onChanged={setTotpEnabled} /> : null}
    </div>
  );
}
