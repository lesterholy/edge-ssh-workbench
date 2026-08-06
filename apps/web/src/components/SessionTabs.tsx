import {
	Columns2,
	LoaderCircle,
	PlugZap,
	RotateCw,
	SendHorizontal,
	Unplug,
	X,
} from "lucide-react";
import type { MessageKey } from "../lib/i18n";
import {
	isSessionRunning,
	sessionDisplayName,
	type WorkbenchSessionsState,
} from "../lib/workbench-sessions";

type Props = {
	state: WorkbenchSessionsState;
	t: (key: MessageKey) => string;
	onSelect: (id: string) => void;
	onDisconnect: (id: string) => void;
	onReconnect: (id: string) => void;
	onClose: (id: string) => void;
	onToggleSplit: () => void;
	onBatchCommand: () => void;
	connectedCount: number;
};

export function SessionTabs({
	state,
	t,
	onSelect,
	onDisconnect,
	onReconnect,
	onClose,
	onToggleSplit,
	onBatchCommand,
	connectedCount,
}: Props) {
	const active = state.activeId ? state.sessions[state.activeId] : undefined;
	const canSplit = state.order.length > 1;

	return (
		<div className="session-tabs">
			<div
				className="session-tabs-scroll"
				role="tablist"
				aria-label={t("sessions")}
			>
				{state.order.map((id) => {
					const session = state.sessions[id];
					if (!session) return null;
					const selected = id === state.activeId;
					const visible = state.panes.includes(id);
					const displayName =
						sessionDisplayName(state, id) ?? session.profile.name;
					return (
						<div
							className={`session-tab${selected ? " selected" : ""}${visible ? " in-pane" : ""}`}
							key={id}
						>
							<button
								type="button"
								className="session-tab-main"
								role="tab"
								aria-selected={selected}
								title={`${displayName} · ${session.profile.username}@${session.profile.host}:${session.profile.port}`}
								onClick={() => onSelect(id)}
							>
								<span
									className={`session-status-dot state-${session.state}`}
									aria-hidden="true"
								/>
								<span className="session-tab-label">
									{displayName}
									{session.closing ? (
										<LoaderCircle
											className="session-spinner"
											size={12}
											aria-label={t("closingSession")}
										/>
									) : null}
								</span>
								<span className="session-tab-target">
									{session.profile.username}@{session.profile.host}
								</span>
							</button>
							{session.attention !== "none" ? (
								<span
									className={`session-attention attention-${session.attention}`}
									aria-hidden="true"
								/>
							) : null}
							<button
								type="button"
								className="session-tab-close"
								title={t("closeSession")}
								aria-label={`${t("closeSession")}: ${displayName}`}
								disabled={session.closing}
								onClick={() => onClose(id)}
							>
								<X size={13} />
							</button>
						</div>
					);
				})}
			</div>
			{active ? (
				<div className="session-toolbar">
					{isSessionRunning(active) ? (
						<button
							type="button"
							title={t("disconnectKeepTab")}
							disabled={active.closing}
							onClick={() => onDisconnect(active.id)}
						>
							<Unplug size={16} />
						</button>
					) : (
						<button
							type="button"
							title={t("reconnect")}
							disabled={active.closing}
							onClick={() => onReconnect(active.id)}
						>
							<RotateCw size={16} />
						</button>
					)}
					<button
						type="button"
						title={`${t("batchCommand")} (${connectedCount})`}
						aria-label={`${t("batchCommand")} (${connectedCount})`}
						aria-haspopup="dialog"
						data-batch-command-trigger
						disabled={connectedCount === 0}
						onClick={onBatchCommand}
					>
						<SendHorizontal size={16} />
					</button>
					<button
						type="button"
						className={state.layout === "split" ? "active" : ""}
						title={
							state.layout === "split" ? t("exitSplitView") : t("splitView")
						}
						disabled={!canSplit}
						onClick={onToggleSplit}
					>
						<Columns2 size={16} />
					</button>
					<span className="session-count" title={t("sessions")}>
						<PlugZap size={13} />
						{state.order.length}
					</span>
				</div>
			) : null}
		</div>
	);
}
