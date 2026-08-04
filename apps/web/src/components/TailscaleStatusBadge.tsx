import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import {
	tailscaleStatusFromDevices,
	tailscaleStatusFromError,
	type TailscaleStatus,
} from "../lib/tailscale-status";

type Props = {
	t: (key: MessageKey) => string;
	refreshSignal?: number;
	onOpenImport?: () => void;
};

export function TailscaleStatusBadge({
	t,
	refreshSignal = 0,
	onOpenImport,
}: Props) {
	const [status, setStatus] = useState<TailscaleStatus>({ kind: "loading" });
	const mountedRef = useRef(true);

	const load = useCallback(async () => {
		setStatus({ kind: "loading" });
		try {
			const configuration = await api.tailscaleConfiguration();
			if (!configuration.configured) {
				if (mountedRef.current) setStatus({ kind: "not_configured" });
				return;
			}
			const response = await api.tailscaleDevices();
			if (mountedRef.current) setStatus(tailscaleStatusFromDevices(response));
		} catch (caught) {
			if (mountedRef.current) setStatus(tailscaleStatusFromError(caught));
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		void load();
		return () => {
			mountedRef.current = false;
		};
	}, [load, refreshSignal]);

	const statusText =
		status.kind === "ready"
			? `${status.tailnet} · ${status.online} ${t("deviceOnline")} · ${status.offline} ${t("deviceOffline")}`
			: status.kind === "loading"
				? `${t("loading")}...`
				: status.kind === "not_configured"
					? t("tailscaleNotConfigured")
					: t("tailscaleUnavailable");

	return (
		<div
			className={`tailscale-status tailscale-status-${status.kind}`}
			role="status"
			aria-live="polite"
			aria-label={t("tailscaleStatus")}
		>
			<span
				className="tailscale-status-dot"
				data-state={status.kind}
				aria-hidden="true"
			/>
			{status.kind !== "loading" && onOpenImport ? (
				<button
					type="button"
					className="tailscale-status-main"
					title={
						status.kind === "ready"
							? t("importFromTailscale")
							: t("tailscaleSettings")
					}
					onClick={onOpenImport}
				>
					<span className="tailscale-status-label">Tailscale</span>
					<span className="tailscale-status-text">{statusText}</span>
				</button>
			) : (
				<span className="tailscale-status-main">
					<span className="tailscale-status-label">Tailscale</span>
					<span className="tailscale-status-text">{statusText}</span>
				</span>
			)}
			{status.kind === "error" ? (
				<button
					type="button"
					className="icon-button tailscale-status-retry"
					title={t("refresh")}
					aria-label={t("refresh")}
					onClick={() => void load()}
				>
					<RefreshCw size={13} />
				</button>
			) : null}
		</div>
	);
}
