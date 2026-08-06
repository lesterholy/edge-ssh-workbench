import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	Activity,
	Files,
	KeyRound,
	Languages,
	LogOut,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	ScrollText,
	ShieldCheck,
	Sun,
	TerminalSquare,
} from "lucide-react";
import type {
	EphemeralCredential,
	Language,
	ProfileCreateRequest,
	ProfileResponse,
	ProfileUpdateRequest,
	ServerHostKeyMessageSchema,
	ServerWebSocketMessage,
	SessionState,
	Settings,
	TailscaleImportResponse,
	Theme,
} from "@edgesh/contracts";
import { CredentialDialog } from "./components/CredentialDialog";
import { FileWorkspace } from "./components/FileWorkspace";
import { HistoryPanel } from "./components/HistoryPanel";
import { LoginView } from "./components/LoginView";
import { MonitorPanel } from "./components/MonitorPanel";
import { ProfileSidebar } from "./components/ProfileSidebar";
import { SecurityDialog } from "./components/SecurityDialog";
import { SessionLogPanel } from "./components/SessionLogPanel";
import { SessionTabs } from "./components/SessionTabs";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { TailscaleImportDialog } from "./components/TailscaleImportDialog";
import { api } from "./lib/api";
import { translate } from "./lib/i18n";
import {
	enqueuePrompt,
	removePrompt,
	removeSessionPrompts,
	type PromptIdentity,
} from "./lib/prompt-queue";
import type { SessionChannel } from "./lib/session-channel";
import { TransferGate } from "./lib/transfer-gate";
import {
	createWorkbenchSession,
	initialWorkbenchSessionsState,
	isSessionRunning,
	profileSessionCounts,
	visibleSessionIds,
	workbenchSessionsReducer,
	type WorkbenchSessionsAction,
	type WorkbenchSessionsState,
} from "./lib/workbench-sessions";

type HostKeyMessage = typeof ServerHostKeyMessageSchema._output;
type ResizeSide = "left" | "right" | "bottom";
type CredentialPrompt = PromptIdentity & {
	kind: "credential";
	profile: ProfileResponse;
	error?: string;
};
type HostKeyPrompt = PromptIdentity & {
	kind: "host-key";
	message: HostKeyMessage;
	respond: (decision: "trust_once" | "trust_and_save" | "reject") => void;
};
type AppPrompt = CredentialPrompt | HostKeyPrompt;
type CredentialSecret = { attemptId: string; value: EphemeralCredential };

const MIN_SIDEBAR_W = 220;
const MAX_SIDEBAR_W = 480;
const MIN_MONITOR_W = 240;
const MAX_MONITOR_W = 560;
const MIN_BOTTOM_H = 150;
const MAX_BOTTOM_H = 600;
const MIN_CENTER_W = 520;
const MIN_TERMINAL_AREA_H = 360;
const SESSION_DRAIN_TIMEOUT_MS = 2_000;

const now = () => new Date().toISOString();
const fallbackSettings: Settings = {
	language: (localStorage.getItem("edgesh.language") as Language) || "zh-CN",
	theme: (localStorage.getItem("edgesh.theme") as Theme) || "dark",
	terminal: {
		encoding: "utf-8",
		type: "xterm-256color",
		fontSize: 14,
		fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
		cursorBlink: true,
		scrollbackLines: 5000,
	},
	monitoring: { refreshIntervalSeconds: 8, reduceWhenHidden: true },
	history: {
		commandRetentionDays: 365,
		sessionRetentionDays: 90,
		collectCommands: true,
	},
	updatedAt: now(),
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
	const [selectedProfileId, setSelectedProfileId] = useState<string>();
	const [workbench, setWorkbench] = useState<WorkbenchSessionsState>(
		initialWorkbenchSessionsState,
	);
	const [prompts, setPrompts] = useState<AppPrompt[]>([]);
	const [credentialSecrets, setCredentialSecrets] = useState<
		Record<string, CredentialSecret>
	>({});
	const [notice, setNotice] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [monitorOpen, setMonitorOpen] = useState(true);
	const [securityDialogOpen, setSecurityDialogOpen] = useState(false);
	const [tailscaleImportOpen, setTailscaleImportOpen] = useState(false);
	const [tailscaleRefreshSignal, setTailscaleRefreshSignal] = useState(0);
	const [pageVisible, setPageVisible] = useState(!document.hidden);
	const [draining, setDraining] = useState(false);
	const t = useMemo(() => translate(settings.language), [settings.language]);
	const [sidebarWidth, setSidebarWidth] = useState(() =>
		clampSize(
			Number(localStorage.getItem("edgesh.sidebarWidth")) || 288,
			MIN_SIDEBAR_W,
			MAX_SIDEBAR_W,
		),
	);
	const [monitorWidth, setMonitorWidth] = useState(() =>
		clampSize(
			Number(localStorage.getItem("edgesh.monitorWidth")) || 300,
			MIN_MONITOR_W,
			MAX_MONITOR_W,
		),
	);
	const [bottomHeight, setBottomHeight] = useState(() =>
		clampSize(
			Number(localStorage.getItem("edgesh.bottomHeight")) || 240,
			MIN_BOTTOM_H,
			MAX_BOTTOM_H,
		),
	);
	const sizesRef = useRef({ sidebarWidth, monitorWidth, bottomHeight });
	const centerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		axis: "x" | "y";
		side: ResizeSide;
		startClient: number;
		startSize: number;
		min: number;
		max: number;
	} | null>(null);
	const workbenchRef = useRef(workbench);
	const transferGate = useRef(new TransferGate());

	const activeSession = workbench.activeId
		? workbench.sessions[workbench.activeId]
		: undefined;
	const visibleIds = visibleSessionIds(workbench);
	const firstPrompt = prompts[0];
	const profileCounts = useMemo(
		() => profileSessionCounts(workbench),
		[workbench],
	);
	const runningProfileIds = useMemo(
		() =>
			new Set(
				Object.values(workbench.sessions)
					.filter(isSessionRunning)
					.map((session) => session.profile.id),
			),
		[workbench.sessions],
	);

	function dispatchWorkbench(action: WorkbenchSessionsAction) {
		setWorkbench((current) => {
			const next = workbenchSessionsReducer(current, action);
			workbenchRef.current = next;
			return next;
		});
	}

	function clearCredentialSecret(clientSessionId: string, attemptId?: string) {
		setCredentialSecrets((current) => {
			const secret = current[clientSessionId];
			if (!secret || (attemptId && secret.attemptId !== attemptId))
				return current;
			const next = { ...current };
			delete next[clientSessionId];
			return next;
		});
	}

	function clearSessionResources(clientSessionId: string) {
		transferGate.current.cancelSession(clientSessionId);
		clearCredentialSecret(clientSessionId);
		setPrompts((current) => removeSessionPrompts(current, clientSessionId));
	}

	useEffect(() => {
		workbenchRef.current = workbench;
	}, [workbench]);

	useEffect(() => {
		if (activeSession) setSelectedProfileId(activeSession.profile.id);
	}, [workbench.activeId]);

	useEffect(() => {
		api
			.authState()
			.then((state) => {
				setAuthenticated(state.authenticated);
				setTotpEnabled(state.totpEnabled);
				setGoogleLoginEnabled(
					state.status === "anonymous" && state.googleLoginEnabled,
				);
			})
			.catch(() => setAuthenticated(false))
			.finally(() => setBooting(false));
	}, []);

	useEffect(() => {
		document.documentElement.dataset.theme = settings.theme;
		document.documentElement.lang = settings.language;
	}, [settings.language, settings.theme]);

	useEffect(() => {
		const updateVisibility = () => setPageVisible(!document.hidden);
		document.addEventListener("visibilitychange", updateVisibility);
		return () =>
			document.removeEventListener("visibilitychange", updateVisibility);
	}, []);

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
			const size =
				drag.side === "left"
					? sizesRef.current.sidebarWidth
					: drag.side === "right"
						? sizesRef.current.monitorWidth
						: sizesRef.current.bottomHeight;
			const key =
				drag.side === "left"
					? "sidebarWidth"
					: drag.side === "right"
						? "monitorWidth"
						: "bottomHeight";
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
		void Promise.all([api.profiles(), api.settings()])
			.then(([profileList, savedSettings]) => {
				setProfiles(profileList.items);
				setSelectedProfileId(profileList.items[0]?.id);
				setSettings(savedSettings);
			})
			.catch((error) =>
				setNotice(
					error instanceof Error ? error.message : "Unable to load workbench",
				),
			);
	}, [authenticated]);

	useEffect(() => {
		const beforeUnload = () => {
			for (const session of Object.values(workbenchRef.current.sessions)) {
				session.channel?.send({ type: "disconnect" });
			}
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, []);

	function setLanguage(language: Language) {
		localStorage.setItem("edgesh.language", language);
		setSettings((current) => ({ ...current, language }));
		if (authenticated)
			void api.updateSettings({ language }).catch(() => undefined);
	}

	function setTheme(theme: Theme) {
		localStorage.setItem("edgesh.theme", theme);
		setSettings((current) => ({ ...current, theme }));
		if (authenticated)
			void api.updateSettings({ theme }).catch(() => undefined);
	}

	async function createProfile(input: ProfileCreateRequest) {
		const profile = await api.createProfile(input);
		setProfiles((current) => [profile, ...current]);
		setSelectedProfileId(profile.id);
	}

	function selectProfile(id: string) {
		setSelectedProfileId(id);
		const recentSessionId = [...workbench.order]
			.reverse()
			.find((sessionId) => workbench.sessions[sessionId]?.profile.id === id);
		if (recentSessionId)
			dispatchWorkbench({ type: "select", id: recentSessionId });
	}

	async function updateProfile(id: string, input: ProfileUpdateRequest) {
		const profile = await api.updateProfile(id, input);
		setProfiles((current) =>
			current.map((item) => (item.id === id ? profile : item)),
		);
	}

	async function deleteProfile(id: string) {
		if (runningProfileIds.has(id)) {
			setNotice(t("disconnectKeepTab"));
			return;
		}
		await api.deleteProfile(id);
		setProfiles((current) => current.filter((profile) => profile.id !== id));
		if (selectedProfileId === id) setSelectedProfileId(undefined);
	}

	function handleTailscaleImport(response: TailscaleImportResponse) {
		setProfiles((current) => [...response.created, ...current]);
		if (response.created.length > 0 && !selectedProfileId)
			setSelectedProfileId(response.created[0]?.id);
	}

	function queueCredentialPrompt(
		clientSessionId: string,
		attemptId: string,
		profile: ProfileResponse,
		error?: string,
	) {
		const current = workbenchRef.current.sessions[clientSessionId];
		if (!current || current.attemptId !== attemptId) return;
		dispatchWorkbench({ type: "pause", id: clientSessionId, attemptId });
		setPrompts((queue) =>
			enqueuePrompt(queue, {
				id: crypto.randomUUID(),
				kind: "credential",
				clientSessionId,
				attemptId,
				profile,
				error,
			}),
		);
	}

	function openProfileSession(profile: ProfileResponse) {
		const clientSessionId = crypto.randomUUID();
		const attemptId = crypto.randomUUID();
		const promptCredential = profile.credentialPersistence === "prompt";
		dispatchWorkbench({
			type: "open",
			session: createWorkbenchSession(profile, {
				clientSessionId,
				attemptId,
				connectRequested: !promptCredential,
			}),
		});
		setSelectedProfileId(profile.id);
		if (promptCredential) {
			setPrompts((queue) =>
				enqueuePrompt(queue, {
					id: crypto.randomUUID(),
					kind: "credential",
					clientSessionId,
					attemptId,
					profile,
				}),
			);
		}
	}

	function connectProfile(id: string) {
		const profile = profiles.find((item) => item.id === id);
		if (profile) openProfileSession(profile);
	}

	function reconnectSession(clientSessionId: string) {
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session || isSessionRunning(session)) return;
		clearSessionResources(clientSessionId);
		const profile =
			profiles.find((item) => item.id === session.profile.id) ??
			session.profile;
		const attemptId = crypto.randomUUID();
		const promptCredential = profile.credentialPersistence === "prompt";
		dispatchWorkbench({
			type: "reconnect",
			id: clientSessionId,
			attemptId,
			profile,
			connectRequested: !promptCredential,
		});
		if (promptCredential) {
			setPrompts((queue) =>
				enqueuePrompt(queue, {
					id: crypto.randomUUID(),
					kind: "credential",
					clientSessionId,
					attemptId,
					profile,
				}),
			);
		}
	}

	function connectWithCredential(credential: EphemeralCredential) {
		if (!firstPrompt || firstPrompt.kind !== "credential") return;
		const { clientSessionId, profile } = firstPrompt;
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session || session.attemptId !== firstPrompt.attemptId) {
			setPrompts((current) => removePrompt(current, firstPrompt.id));
			return;
		}
		const attemptId = crypto.randomUUID();
		const latestProfile =
			profiles.find((item) => item.id === profile.id) ?? profile;
		setCredentialSecrets((current) => ({
			...current,
			[clientSessionId]: { attemptId, value: credential },
		}));
		setPrompts((current) =>
			removeSessionPrompts(current, clientSessionId, attemptId),
		);
		dispatchWorkbench({
			type: "reconnect",
			id: clientSessionId,
			attemptId,
			profile: latestProfile,
		});
	}

	function cancelCredentialPrompt() {
		if (!firstPrompt || firstPrompt.kind !== "credential") return;
		const clientSessionId = firstPrompt.clientSessionId;
		setPrompts((current) => removePrompt(current, firstPrompt.id));
		clearSessionResources(clientSessionId);
		dispatchWorkbench({ type: "remove", id: clientSessionId });
	}

	function handleChannel(
		clientSessionId: string,
		attemptId: string,
		channel: SessionChannel | null,
	) {
		dispatchWorkbench({
			type: "channel",
			id: clientSessionId,
			attemptId,
			channel,
		});
	}

	function handleMessage(
		clientSessionId: string,
		attemptId: string,
		message: ServerWebSocketMessage,
	) {
		dispatchWorkbench({
			type: "message",
			id: clientSessionId,
			attemptId,
			message,
			receivedAt: now(),
		});
	}

	function handleState(
		clientSessionId: string,
		attemptId: string,
		state: SessionState,
	) {
		const activeAttempt = workbenchRef.current.sessions[clientSessionId];
		if (!activeAttempt || activeAttempt.attemptId !== attemptId) return;
		const terminal = state === "closed" || state === "error";
		if (terminal) clearSessionResources(clientSessionId);
		setWorkbench((current) => {
			const session = current.sessions[clientSessionId];
			if (!session || session.attemptId !== attemptId) return current;
			let next = workbenchSessionsReducer(current, {
				type: "state",
				id: clientSessionId,
				attemptId,
				state,
			});
			if (terminal && session.closing)
				next = workbenchSessionsReducer(next, {
					type: "remove",
					id: clientSessionId,
				});
			workbenchRef.current = next;
			return next;
		});
	}

	function handleTicketError(
		clientSessionId: string,
		attemptId: string,
		message: string,
	) {
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session || session.attemptId !== attemptId) return;
		clearCredentialSecret(clientSessionId, attemptId);
		setNotice(message);
	}

	function queueHostKey(
		clientSessionId: string,
		attemptId: string,
		message: HostKeyMessage,
		respond: HostKeyPrompt["respond"],
	) {
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session || session.attemptId !== attemptId) return;
		setPrompts((queue) =>
			enqueuePrompt(queue, {
				id: crypto.randomUUID(),
				kind: "host-key",
				clientSessionId,
				attemptId,
				message,
				respond,
			}),
		);
		dispatchWorkbench({
			type: "attention",
			id: clientSessionId,
			attention: "action",
		});
	}

	function answerHostKey(decision: "trust_once" | "trust_and_save" | "reject") {
		if (!firstPrompt || firstPrompt.kind !== "host-key") return;
		const session = workbenchRef.current.sessions[firstPrompt.clientSessionId];
		if (session?.attemptId === firstPrompt.attemptId)
			firstPrompt.respond(decision);
		setPrompts((current) => removePrompt(current, firstPrompt.id));
	}

	function disconnectSession(clientSessionId: string) {
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session) return;
		dispatchWorkbench({
			type: "state",
			id: clientSessionId,
			attemptId: session.attemptId,
			state: "disconnecting",
		});
		if (!session.channel?.send({ type: "disconnect" })) {
			session.channel?.close();
			handleState(clientSessionId, session.attemptId, "closed");
		}
	}

	function closeSession(clientSessionId: string) {
		const session = workbenchRef.current.sessions[clientSessionId];
		if (!session) return;
		clearSessionResources(clientSessionId);
		if (!session.channel) {
			dispatchWorkbench({ type: "remove", id: clientSessionId });
			return;
		}
		dispatchWorkbench({ type: "closing", id: clientSessionId, closing: true });
		session.channel.send({ type: "disconnect" });
		window.setTimeout(() => {
			const pending = workbenchRef.current.sessions[clientSessionId];
			if (pending?.closing && pending.attemptId === session.attemptId)
				pending.channel?.close();
		}, SESSION_DRAIN_TIMEOUT_MS);
	}

	async function drainAllSessions() {
		transferGate.current.cancelAll();
		setPrompts([]);
		setCredentialSecrets({});
		for (const session of Object.values(workbenchRef.current.sessions)) {
			if (!session.channel?.send({ type: "disconnect" }))
				session.channel?.close();
		}
		const deadline = Date.now() + SESSION_DRAIN_TIMEOUT_MS;
		while (
			Date.now() < deadline &&
			Object.values(workbenchRef.current.sessions).some((session) =>
				session.channel?.isOpen(),
			)
		) {
			await new Promise((resolve) => window.setTimeout(resolve, 50));
		}
		for (const session of Object.values(workbenchRef.current.sessions))
			session.channel?.close();
	}

	async function logout() {
		if (draining) return;
		setDraining(true);
		try {
			await drainAllSessions();
			await api.logout();
			dispatchWorkbench({ type: "clear" });
			setSecurityDialogOpen(false);
			setAuthenticated(false);
			setDraining(false);
		} catch (caught) {
			setNotice(
				caught instanceof Error ? caught.message : "Unable to sign out",
			);
			setDraining(false);
		}
	}

	function resizeBounds(side: ResizeSide): { min: number; max: number } {
		if (side === "bottom") {
			const available =
				(centerRef.current?.clientHeight ?? window.innerHeight) -
				MIN_TERMINAL_AREA_H;
			return {
				min: MIN_BOTTOM_H,
				max: Math.max(MIN_BOTTOM_H, Math.min(MAX_BOTTOM_H, available)),
			};
		}
		const monitorVisible =
			monitorOpen && window.matchMedia("(min-width: 1200px)").matches;
		const otherWidth =
			side === "left"
				? monitorVisible
					? sizesRef.current.monitorWidth
					: 0
				: sidebarOpen
					? sizesRef.current.sidebarWidth
					: 0;
		const hardMax = side === "left" ? MAX_SIDEBAR_W : MAX_MONITOR_W;
		const min = side === "left" ? MIN_SIDEBAR_W : MIN_MONITOR_W;
		return {
			min,
			max: Math.max(
				min,
				Math.min(hardMax, window.innerWidth - otherWidth - MIN_CENTER_W),
			),
		};
	}

	function setPanelSize(side: ResizeSide, value: number) {
		const bounds = resizeBounds(side);
		const next = clampSize(value, bounds.min, bounds.max);
		if (side === "left") setSidebarWidth(next);
		else if (side === "right") setMonitorWidth(next);
		else setBottomHeight(next);
		sizesRef.current = {
			...sizesRef.current,
			...(side === "left"
				? { sidebarWidth: next }
				: side === "right"
					? { monitorWidth: next }
					: { bottomHeight: next }),
		};
		const key =
			side === "left"
				? "sidebarWidth"
				: side === "right"
					? "monitorWidth"
					: "bottomHeight";
		localStorage.setItem(`edgesh.${key}`, String(next));
	}

	function startResize(
		event: React.PointerEvent,
		axis: "x" | "y",
		side: ResizeSide,
	) {
		event.preventDefault();
		const startSize =
			side === "left"
				? sidebarWidth
				: side === "right"
					? monitorWidth
					: bottomHeight;
		dragRef.current = {
			axis,
			side,
			startClient: axis === "x" ? event.clientX : event.clientY,
			startSize,
			...resizeBounds(side),
		};
		document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
		document.body.style.userSelect = "none";
		(event.target as Element).setPointerCapture?.(event.pointerId);
	}

	function resizeWithKeyboard(event: React.KeyboardEvent, side: ResizeSide) {
		const step = event.shiftKey ? 40 : 12;
		let delta = 0;
		if (
			side === "left" &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		)
			delta = event.key === "ArrowRight" ? step : -step;
		if (
			side === "right" &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		)
			delta = event.key === "ArrowLeft" ? step : -step;
		if (
			side === "bottom" &&
			(event.key === "ArrowUp" || event.key === "ArrowDown")
		)
			delta = event.key === "ArrowUp" ? step : -step;
		if (!delta) return;
		event.preventDefault();
		const current =
			side === "left"
				? sidebarWidth
				: side === "right"
					? monitorWidth
					: bottomHeight;
		setPanelSize(side, current + delta);
	}

	if (booting) return <main className="boot-screen">{t("loading")}...</main>;
	if (!authenticated)
		return (
			<LoginView
				language={settings.language}
				theme={settings.theme}
				googleLoginEnabled={googleLoginEnabled}
				t={t}
				onLanguage={setLanguage}
				onTheme={setTheme}
				onAuthenticated={(enabled) => {
					setTotpEnabled(enabled);
					setAuthenticated(true);
				}}
			/>
		);

	const gridClass = `workspace-grid${sidebarOpen ? "" : " sidebar-hidden"}${monitorOpen ? "" : " monitor-hidden"}`;

	return (
		<div className="app-shell">
			<header className="app-header">
				<div className="brand">
					<span className="brand-mark">
						<KeyRound size={16} />
					</span>
					<div className="brand-text">
						<strong>{t("appName")}</strong>
						<span>
							{activeSession
								? `${activeSession.profile.username}@${activeSession.profile.host}:${activeSession.profile.port}`
								: t("noServer")}
						</span>
					</div>
				</div>
				<div className="header-actions">
					<button
						className="icon-button"
						type="button"
						title={t("servers")}
						aria-label={t("servers")}
						onClick={() => setSidebarOpen((value) => !value)}
					>
						{sidebarOpen ? (
							<PanelLeftClose size={17} />
						) : (
							<PanelLeftOpen size={17} />
						)}
					</button>
					<button
						className="icon-button"
						type="button"
						title={t("liveStatus")}
						aria-label={t("liveStatus")}
						onClick={() => setMonitorOpen((value) => !value)}
					>
						<Activity size={17} />
					</button>
					<button
						className="icon-button security-button"
						type="button"
						title={t("securitySettings")}
						aria-label={t("securitySettings")}
						onClick={() => setSecurityDialogOpen(true)}
					>
						<ShieldCheck size={17} />
						<span
							className={totpEnabled ? "security-dot enabled" : "security-dot"}
							aria-hidden="true"
						/>
					</button>
					<button
						className="icon-button"
						type="button"
						title={t("language")}
						onClick={() =>
							setLanguage(settings.language === "zh-CN" ? "en" : "zh-CN")
						}
					>
						<Languages size={17} />
					</button>
					<button
						className="icon-button"
						type="button"
						title={t("theme")}
						onClick={() =>
							setTheme(settings.theme === "dark" ? "light" : "dark")
						}
					>
						{settings.theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
					</button>
					<button
						className="logout-button"
						type="button"
						disabled={draining}
						onClick={() => void logout()}
					>
						<LogOut size={16} /> {t("signOut")}
					</button>
				</div>
			</header>
			{notice ? (
				<div className="notice" role="alert">
					{notice}
				</div>
			) : null}
			<main
				className={gridClass}
				style={
					{
						"--sidebar-w": `${sidebarWidth}px`,
						"--monitor-w": `${monitorWidth}px`,
						"--bottom-h": `${bottomHeight}px`,
					} as React.CSSProperties
				}
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

				<ProfileSidebar
					profiles={profiles}
					selectedId={selectedProfileId}
					busy={draining}
					sessionCounts={profileCounts}
					activeProfileIds={runningProfileIds}
					t={t}
					onSelect={selectProfile}
					onConnect={connectProfile}
					onCreate={createProfile}
					onUpdate={updateProfile}
					onDelete={deleteProfile}
					onTailscaleImportOpen={() => setTailscaleImportOpen(true)}
					tailscaleRefreshSignal={tailscaleRefreshSignal}
				/>
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
					<SessionTabs
						state={workbench}
						t={t}
						onSelect={(id) => dispatchWorkbench({ type: "select", id })}
						onDisconnect={disconnectSession}
						onReconnect={reconnectSession}
						onClose={closeSession}
						onToggleSplit={() => dispatchWorkbench({ type: "toggle-split" })}
					/>
					<div className={`session-workspaces ${workbench.layout}`}>
						{workbench.order.map((id) => {
							const session = workbench.sessions[id];
							if (!session) return null;
							return (
								<SessionWorkspace
									key={id}
									session={session}
									settings={settings}
									t={t}
									visible={visibleIds.includes(id)}
									focused={workbench.activeId === id}
									pageVisible={pageVisible}
									monitoringEnabled={monitorOpen}
									credential={
										credentialSecrets[id]?.attemptId === session.attemptId
											? credentialSecrets[id]?.value
											: undefined
									}
									onFocus={(sessionId) =>
										dispatchWorkbench({ type: "select", id: sessionId })
									}
									onMessage={handleMessage}
									onChannel={handleChannel}
									onStateChange={handleState}
									onHostKey={queueHostKey}
									onCredentialRequired={(sessionId, attemptId) =>
										queueCredentialPrompt(
											sessionId,
											attemptId,
											session.profile,
											t("credentialRequired"),
										)
									}
									onTicketIssued={clearCredentialSecret}
									onTicketError={handleTicketError}
								/>
							);
						})}
						{workbench.order.length === 0 ? (
							<section className="terminal-panel session-empty">
								<TerminalSquare size={22} />
								<span>{t("noServer")}</span>
							</section>
						) : null}
					</div>
					<div className="bottom-workspace">
						<div className="work-tabs" role="tablist">
							<button
								className={activeSession?.workTab === "files" ? "active" : ""}
								type="button"
								role="tab"
								disabled={!activeSession}
								aria-selected={activeSession?.workTab === "files"}
								onClick={() =>
									activeSession &&
									dispatchWorkbench({
										type: "work-tab",
										id: activeSession.id,
										tab: "files",
									})
								}
							>
								<Files size={15} />
								{t("files")}
							</button>
							<button
								className={activeSession?.workTab === "history" ? "active" : ""}
								type="button"
								role="tab"
								disabled={!activeSession}
								aria-selected={activeSession?.workTab === "history"}
								onClick={() =>
									activeSession &&
									dispatchWorkbench({
										type: "work-tab",
										id: activeSession.id,
										tab: "history",
									})
								}
							>
								<TerminalSquare size={15} />
								{t("history")}
							</button>
							<button
								className={activeSession?.workTab === "log" ? "active" : ""}
								type="button"
								role="tab"
								disabled={!activeSession}
								aria-selected={activeSession?.workTab === "log"}
								onClick={() =>
									activeSession &&
									dispatchWorkbench({
										type: "work-tab",
										id: activeSession.id,
										tab: "log",
									})
								}
							>
								<ScrollText size={15} />
								{t("sessionLog")}
							</button>
							{activeSession ? (
								<span className="work-target">
									{activeSession.profile.name} ·{" "}
									{activeSession.profile.username}@{activeSession.profile.host}
								</span>
							) : null}
						</div>
						<div className="tab-content">
							{workbench.order.map((id) => {
								const session = workbench.sessions[id];
								if (!session) return null;
								const connected = session.state === "connected";
								return (
									<div
										className={`session-tool-pane${workbench.activeId === id ? " active" : ""}`}
										key={id}
									>
										<div
											className={`session-tool-view${session.workTab === "files" ? " active" : ""}`}
										>
											<FileWorkspace
												clientSessionId={id}
												channel={connected ? session.channel : null}
												transferGate={transferGate.current}
												t={t}
											/>
										</div>
										<div
											className={`session-tool-view${session.workTab === "history" ? " active" : ""}`}
										>
											<HistoryPanel
												t={t}
												connected={connected}
												channel={connected ? session.channel : null}
												profile={session.profile}
											/>
										</div>
										<div
											className={`session-tool-view${session.workTab === "log" ? " active" : ""}`}
										>
											<SessionLogPanel session={session} t={t} />
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>
				<MonitorPanel metrics={activeSession?.metrics} t={t} />
			</main>

			{firstPrompt?.kind === "host-key" ? (
				<div className="dialog-backdrop" role="presentation">
					<div
						className="host-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="host-dialog-title"
					>
						<h2 id="host-dialog-title">
							{firstPrompt.message.changed
								? t("changedHostKey")
								: t("firstHostKey")}
						</h2>
						<p>
							{firstPrompt.message.host}:{firstPrompt.message.port}
						</p>
						<dl>
							<dt>{firstPrompt.message.algorithm}</dt>
							<dd>{firstPrompt.message.fingerprint}</dd>
							{firstPrompt.message.previousFingerprint ? (
								<>
									<dt>Previous</dt>
									<dd>{firstPrompt.message.previousFingerprint}</dd>
								</>
							) : null}
						</dl>
						<div className="dialog-actions">
							<button
								type="button"
								className="danger-button"
								onClick={() => answerHostKey("reject")}
							>
								{t("reject")}
							</button>
							{!firstPrompt.message.changed ? (
								<button
									type="button"
									className="secondary-button"
									onClick={() => answerHostKey("trust_once")}
								>
									{t("trustOnce")}
								</button>
							) : null}
							{!firstPrompt.message.changed ? (
								<button
									type="button"
									className="primary-button"
									onClick={() => answerHostKey("trust_and_save")}
								>
									{t("trustSave")}
								</button>
							) : null}
						</div>
					</div>
				</div>
			) : null}
			{firstPrompt?.kind === "credential" ? (
				<CredentialDialog
					key={`${firstPrompt.clientSessionId}:${firstPrompt.attemptId}`}
					profile={firstPrompt.profile}
					busy={false}
					requestError={firstPrompt.error ?? ""}
					t={t}
					onCancel={cancelCredentialPrompt}
					onSubmit={connectWithCredential}
				/>
			) : null}
			{tailscaleImportOpen ? (
				<TailscaleImportDialog
					t={t}
					onClose={() => {
						setTailscaleImportOpen(false);
						setTailscaleRefreshSignal((value) => value + 1);
					}}
					onImported={handleTailscaleImport}
				/>
			) : null}
			{securityDialogOpen ? (
				<SecurityDialog
					enabled={totpEnabled}
					t={t}
					onClose={() => setSecurityDialogOpen(false)}
					onChanged={setTotpEnabled}
				/>
			) : null}
		</div>
	);
}
