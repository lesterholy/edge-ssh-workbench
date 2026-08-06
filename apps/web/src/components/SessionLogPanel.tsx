import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SessionEvent } from "@edgesh/contracts";
import { api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import type { WorkbenchSession } from "../lib/workbench-sessions";

type Props = {
	session: WorkbenchSession;
	t: (key: MessageKey) => string;
};

export function SessionLogPanel({ session, t }: Props) {
	const [remoteEvents, setRemoteEvents] = useState<SessionEvent[]>([]);
	const [error, setError] = useState("");
	const generation = useRef(0);

	async function load() {
		const sessionId = session.channel?.sessionId;
		const expectedGeneration = generation.current;
		if (!sessionId) return;
		try {
			const response = await api.sessionEvents(sessionId);
			if (
				generation.current !== expectedGeneration ||
				session.channel?.sessionId !== sessionId
			)
				return;
			setRemoteEvents(response.items);
			setError("");
		} catch (caught) {
			if (generation.current !== expectedGeneration) return;
			setError(
				caught instanceof Error
					? caught.message
					: "Unable to load session events",
			);
		}
	}

	useEffect(() => {
		generation.current += 1;
		if (!session.channel) return;
		setRemoteEvents([]);
		void load();
	}, [session.channel?.sessionId, session.state]);

	const remoteKeys = new Set(
		remoteEvents.map((event) => `${event.createdAt}:${event.message}`),
	);
	const localOnly = session.events
		.filter((event) => !remoteKeys.has(`${event.occurredAt}:${event.message}`))
		.reverse();

	return (
		<section className="session-log-panel">
			<div className="session-log-toolbar">
				<span>{session.profile.name}</span>
				<button
					type="button"
					title={t("refresh")}
					disabled={!session.channel}
					onClick={() => void load()}
				>
					<RefreshCw size={15} />
				</button>
			</div>
			<div className="event-list">
				{remoteEvents.map((event) => (
					<div className="event-item" key={event.id}>
						<span>{new Date(event.createdAt).toLocaleTimeString()}</span>
						<strong>{event.code}</strong>
						<p>{event.message}</p>
					</div>
				))}
				{localOnly.map((event) => (
					<div className="event-item" key={event.id}>
						<span>{new Date(event.occurredAt).toLocaleTimeString()}</span>
						<strong>{event.level}</strong>
						<p>{event.message}</p>
					</div>
				))}
				{error ? <p className="form-error">{error}</p> : null}
			</div>
		</section>
	);
}
