import type {
	ProfileResponse,
	ServerMetricsMessage,
	ServerWebSocketMessage,
	SessionState,
} from "@edgesh/contracts";
import type { SessionChannel } from "./session-channel";

export type SessionAttention = "none" | "activity" | "action" | "error";
export type SessionLayout = "single" | "split";
export type SessionPane = 0 | 1;
export type WorkTab = "files" | "history" | "log";

export type SessionLogEntry = {
	id: string;
	occurredAt: string;
	level: "info" | "error";
	message: string;
};

export type WorkbenchSession = {
	id: string;
	profile: ProfileResponse;
	attemptId: string;
	connectRequested: boolean;
	state: SessionState;
	channel: SessionChannel | null;
	metrics?: ServerMetricsMessage;
	events: SessionLogEntry[];
	workTab: WorkTab;
	attention: SessionAttention;
	closing: boolean;
	createdAt: string;
};

export type WorkbenchSessionsState = {
	sessions: Record<string, WorkbenchSession>;
	order: string[];
	activeId?: string;
	layout: SessionLayout;
	panes: [string | undefined, string | undefined];
	focusedPane: SessionPane;
};

export type WorkbenchSessionsAction =
	| { type: "open"; session: WorkbenchSession }
	| { type: "select"; id: string }
	| { type: "focus-pane"; pane: SessionPane }
	| { type: "toggle-split" }
	| {
			type: "reconnect";
			id: string;
			attemptId: string;
			profile?: ProfileResponse;
			connectRequested?: boolean;
	  }
	| {
			type: "pause";
			id: string;
			attemptId: string;
			state?: Extract<SessionState, "idle" | "closed" | "error">;
	  }
	| { type: "state"; id: string; attemptId: string; state: SessionState }
	| {
			type: "channel";
			id: string;
			attemptId: string;
			channel: SessionChannel | null;
	  }
	| {
			type: "message";
			id: string;
			attemptId: string;
			message: ServerWebSocketMessage;
			receivedAt: string;
	  }
	| { type: "work-tab"; id: string; tab: WorkTab }
	| { type: "attention"; id: string; attention: SessionAttention }
	| { type: "closing"; id: string; closing: boolean }
	| { type: "remove"; id: string }
	| { type: "clear" };

export const initialWorkbenchSessionsState: WorkbenchSessionsState = {
	sessions: {},
	order: [],
	layout: "single",
	panes: [undefined, undefined],
	focusedPane: 0,
};

const attentionPriority: Record<SessionAttention, number> = {
	none: 0,
	activity: 1,
	action: 2,
	error: 3,
};

export function createWorkbenchSession(
	profile: ProfileResponse,
	options: {
		start?: boolean;
		connectRequested?: boolean;
		id?: string;
		clientSessionId?: string;
		attemptId?: string;
		createdAt?: string;
	} = {},
): WorkbenchSession {
	const start = options.connectRequested ?? options.start ?? true;
	return {
		id: options.clientSessionId ?? options.id ?? crypto.randomUUID(),
		profile: structuredClone(profile),
		attemptId: options.attemptId ?? crypto.randomUUID(),
		connectRequested: start,
		state: start ? "authorizing" : "idle",
		channel: null,
		events: [],
		workTab: "files",
		attention: "none",
		closing: false,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
}

function nextAvailable(
	order: string[],
	excluded: Array<string | undefined>,
): string | undefined {
	return order.find((id) => !excluded.includes(id));
}

function selectSession(
	state: WorkbenchSessionsState,
	id: string,
): WorkbenchSessionsState {
	const session = state.sessions[id];
	if (!session) return state;
	const existingPane = state.panes.indexOf(id);
	const focusedPane =
		state.layout === "split" && existingPane >= 0
			? (existingPane as SessionPane)
			: state.focusedPane;
	const panes: WorkbenchSessionsState["panes"] = [...state.panes];
	panes[focusedPane] = id;
	if (state.layout === "single") panes[1] = undefined;
	return {
		...state,
		sessions: {
			...state.sessions,
			[id]: { ...session, attention: "none" },
		},
		activeId: id,
		focusedPane,
		panes,
	};
}

function removeSession(
	state: WorkbenchSessionsState,
	id: string,
): WorkbenchSessionsState {
	if (!state.sessions[id]) return state;
	const sessions = { ...state.sessions };
	delete sessions[id];
	const order = state.order.filter((candidate) => candidate !== id);
	let panes = state.panes.map((candidate) =>
		candidate === id ? undefined : candidate,
	) as WorkbenchSessionsState["panes"];

	if (!panes[0]) panes[0] = nextAvailable(order, [panes[1]]);
	if (state.layout === "split" && !panes[1])
		panes[1] = nextAvailable(order, [panes[0]]);

	const layout =
		state.layout === "split" && panes[0] && panes[1] ? "split" : "single";
	if (layout === "single") {
		const preferred =
			panes[state.focusedPane] ?? panes[0] ?? panes[1] ?? order[0];
		panes = [preferred, undefined];
	}
	const focusedPane: SessionPane =
		layout === "split" && state.focusedPane === 1 && panes[1] ? 1 : 0;
	const activeId =
		state.activeId === id || !state.activeId
			? (panes[focusedPane] ?? panes[0] ?? order[0])
			: state.activeId;

	return { sessions, order, panes, layout, focusedPane, activeId };
}

function toggleSplit(state: WorkbenchSessionsState): WorkbenchSessionsState {
	if (state.layout === "split") {
		const activeId =
			state.activeId ?? state.panes[state.focusedPane] ?? state.panes[0];
		return {
			...state,
			layout: "single",
			panes: [activeId, undefined],
			focusedPane: 0,
			activeId,
		};
	}
	const primary = state.activeId ?? state.panes[0] ?? state.order[0];
	const secondary = nextAvailable(state.order, [primary]);
	if (!primary || !secondary) return state;
	return {
		...state,
		layout: "split",
		panes: [primary, secondary],
		focusedPane: 0,
		activeId: primary,
	};
}

function backgroundAttention(
	state: WorkbenchSessionsState,
	id: string,
	current: SessionAttention,
	incoming: SessionAttention,
): SessionAttention {
	if (state.activeId === id) return "none";
	return attentionPriority[incoming] > attentionPriority[current]
		? incoming
		: current;
}

export function workbenchSessionsReducer(
	state: WorkbenchSessionsState,
	action: WorkbenchSessionsAction,
): WorkbenchSessionsState {
	switch (action.type) {
		case "open": {
			if (state.sessions[action.session.id]) return state;
			const opened = {
				...state,
				sessions: { ...state.sessions, [action.session.id]: action.session },
				order: [...state.order, action.session.id],
			};
			return selectSession(opened, action.session.id);
		}
		case "select":
			return selectSession(state, action.id);
		case "focus-pane": {
			if (state.layout !== "split") return state;
			const activeId = state.panes[action.pane];
			if (!activeId) return state;
			return selectSession({ ...state, focusedPane: action.pane }, activeId);
		}
		case "toggle-split":
			return toggleSplit(state);
		case "reconnect": {
			const session = state.sessions[action.id];
			if (!session) return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: {
						...session,
						profile: action.profile
							? structuredClone(action.profile)
							: session.profile,
						attemptId: action.attemptId,
						connectRequested: action.connectRequested ?? true,
						state: action.connectRequested === false ? "idle" : "authorizing",
						channel: null,
						metrics: undefined,
						events: [],
						attention: "none",
						closing: false,
					},
				},
			};
		}
		case "pause": {
			const session = state.sessions[action.id];
			if (!session || session.attemptId !== action.attemptId) return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: {
						...session,
						connectRequested: false,
						state: action.state ?? "idle",
						channel: null,
					},
				},
			};
		}
		case "state": {
			const session = state.sessions[action.id];
			if (!session || session.attemptId !== action.attemptId) return state;
			const terminalState =
				action.state === "idle" ||
				action.state === "closed" ||
				action.state === "error";
			const attention =
				action.state === "error"
					? backgroundAttention(state, action.id, session.attention, "error")
					: session.attention;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: {
						...session,
						state: action.state,
						connectRequested: terminalState ? false : session.connectRequested,
						attention,
					},
				},
			};
		}
		case "channel": {
			const session = state.sessions[action.id];
			if (!session || session.attemptId !== action.attemptId) return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: { ...session, channel: action.channel },
				},
			};
		}
		case "message": {
			const session = state.sessions[action.id];
			if (!session || session.attemptId !== action.attemptId) return state;
			let event: SessionLogEntry | undefined;
			if (action.message.type === "status") {
				event = {
					id: crypto.randomUUID(),
					occurredAt: action.message.occurredAt,
					level: "info",
					message: action.message.message,
				};
			} else if (action.message.type === "error") {
				event = {
					id: crypto.randomUUID(),
					occurredAt: action.receivedAt,
					level: "error",
					message: action.message.message,
				};
			}
			const incomingAttention: SessionAttention =
				action.message.type === "error"
					? "error"
					: action.message.type === "host-key"
						? "action"
						: action.message.type === "output"
							? "activity"
							: "none";
			const metrics =
				action.message.type === "metrics" ? action.message : session.metrics;
			const attention = backgroundAttention(
				state,
				action.id,
				session.attention,
				incomingAttention,
			);
			if (
				!event &&
				metrics === session.metrics &&
				attention === session.attention
			)
				return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: {
						...session,
						metrics,
						events: event
							? [event, ...session.events].slice(0, 200)
							: session.events,
						attention,
					},
				},
			};
		}
		case "work-tab": {
			const session = state.sessions[action.id];
			if (!session) return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: { ...session, workTab: action.tab },
				},
			};
		}
		case "attention": {
			const session = state.sessions[action.id];
			if (!session) return state;
			const attention = backgroundAttention(
				state,
				action.id,
				session.attention,
				action.attention,
			);
			return {
				...state,
				sessions: { ...state.sessions, [action.id]: { ...session, attention } },
			};
		}
		case "closing": {
			const session = state.sessions[action.id];
			if (!session) return state;
			return {
				...state,
				sessions: {
					...state.sessions,
					[action.id]: { ...session, closing: action.closing },
				},
			};
		}
		case "remove":
			return removeSession(state, action.id);
		case "clear":
			return initialWorkbenchSessionsState;
	}
}

export function visibleSessionIds(state: WorkbenchSessionsState): string[] {
	return state.layout === "split"
		? state.panes.filter((id): id is string => Boolean(id))
		: state.panes[0]
			? [state.panes[0]]
			: [];
}

export function profileSessionCounts(
	state: WorkbenchSessionsState,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const session of Object.values(state.sessions)) {
		counts[session.profile.id] = (counts[session.profile.id] ?? 0) + 1;
	}
	return counts;
}

export function sessionDisplayName(
	state: WorkbenchSessionsState,
	id: string,
): string | undefined {
	const session = state.sessions[id];
	if (!session) return undefined;
	const matchingIds = state.order.filter(
		(candidate) => state.sessions[candidate]?.profile.id === session.profile.id,
	);
	if (matchingIds.length <= 1) return session.profile.name;
	return `${session.profile.name} #${matchingIds.indexOf(id) + 1}`;
}

export function isSessionRunning(session: WorkbenchSession): boolean {
	return !["idle", "closed", "error"].includes(session.state);
}
