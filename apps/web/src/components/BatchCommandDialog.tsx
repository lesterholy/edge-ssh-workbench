import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SendHorizontal, X } from "lucide-react";
import {
	batchCommandTargetKey,
	MAX_BATCH_COMMAND_LENGTH,
	type BatchCommandSendResult,
	type BatchCommandTarget,
} from "../lib/batch-command";
import type { MessageKey } from "../lib/i18n";

type Props = {
	targets: BatchCommandTarget[];
	t: (key: MessageKey) => string;
	onClose: () => void;
	onSend: (
		targets: BatchCommandTarget[],
		command: string,
	) => BatchCommandSendResult;
};

const FOCUSABLE_SELECTOR = [
	"button:not([disabled])",
	"input:not([disabled])",
	"textarea:not([disabled])",
	"select:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
	return Boolean(
		element?.isConnected &&
			!element.matches(":disabled") &&
			element.getAttribute("aria-hidden") !== "true",
	);
}

function restoreDialogFocus(preferred: HTMLElement | null) {
	if (canReceiveFocus(preferred)) {
		preferred.focus();
		return;
	}
	const fallbackSelectors = [
		"[data-batch-command-trigger]:not(:disabled)",
		".session-tab-main[aria-selected='true']",
		".app-header button:not(:disabled)",
	];
	for (const selector of fallbackSelectors) {
		const fallback = document.querySelector<HTMLElement>(selector);
		if (!canReceiveFocus(fallback)) continue;
		fallback.focus();
		return;
	}
}

export function BatchCommandDialog({ targets, t, onClose, onSend }: Props) {
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [command, setCommand] = useState("");
	const [inputError, setInputError] = useState("");
	const [result, setResult] = useState<BatchCommandSendResult>();
	const dialogRef = useRef<HTMLFormElement>(null);
	const commandRef = useRef<HTMLInputElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const targetKeys = useMemo(
		() => new Set(targets.map(batchCommandTargetKey)),
		[targets],
	);
	const allSelected =
		targets.length > 0 &&
		targets.every((target) => selectedKeys.has(batchCommandTargetKey(target)));
	const canSend =
		selectedKeys.size > 0 &&
		command.trim().length > 0 &&
		command.length <= MAX_BATCH_COMMAND_LENGTH &&
		!inputError;

	useEffect(() => {
		setSelectedKeys((current) => {
			const next = new Set([...current].filter((key) => targetKeys.has(key)));
			if (next.size === current.size) return current;
			return next;
		});
	}, [targetKeys]);

	useEffect(() => {
		const activeElement = document.activeElement;
		if (activeElement instanceof HTMLElement)
			returnFocusRef.current = activeElement;
		commandRef.current?.focus();

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const dialog = dialogRef.current;
			if (!dialog) return;
			const focusable = [
				...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
			];
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) {
				event.preventDefault();
				return;
			}
			const active = document.activeElement;
			if (event.shiftKey && (active === first || !dialog.contains(active))) {
				event.preventDefault();
				last.focus();
			} else if (
				!event.shiftKey &&
				(active === last || !dialog.contains(active))
			) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			restoreDialogFocus(returnFocusRef.current);
		};
	}, []);

	function toggleTarget(target: BatchCommandTarget) {
		const key = batchCommandTargetKey(target);
		setResult(undefined);
		setSelectedKeys((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	function toggleAll() {
		setResult(undefined);
		setSelectedKeys(
			allSelected ? new Set() : new Set(targets.map(batchCommandTargetKey)),
		);
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!canSend) return;
		const selectedTargets = targets.filter((target) =>
			selectedKeys.has(batchCommandTargetKey(target)),
		);
		const nextResult = onSend(selectedTargets, command);
		setResult(nextResult);
		if (nextResult.sentTargets.length > 0) setCommand("");
	}

	return (
		<div className="dialog-backdrop" role="presentation">
			<form
				ref={dialogRef}
				className="host-dialog batch-command-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="batch-command-title"
				aria-describedby="batch-command-description"
				onSubmit={submit}
			>
				<div className="dialog-heading">
					<div>
						<h2 id="batch-command-title">
							<SendHorizontal size={19} />
							{t("batchCommand")}
						</h2>
						<p id="batch-command-description">{t("selectConnectedSessions")}</p>
					</div>
					<button
						type="button"
						className="icon-button"
						title={t("close")}
						aria-label={t("close")}
						onClick={onClose}
					>
						<X size={17} />
					</button>
				</div>

				<div className="batch-command-toolbar">
					<button
						type="button"
						className="text-button"
						disabled={targets.length === 0}
						onClick={toggleAll}
					>
						{allSelected ? t("clearSelection") : t("selectAll")}
					</button>
					<span>
						{t("selectedSessions")}: {selectedKeys.size} / {targets.length}
					</span>
				</div>

				<div
					className="batch-command-targets"
					role="group"
					aria-label={t("selectConnectedSessions")}
				>
					{targets.map((target) => {
						const key = batchCommandTargetKey(target);
						return (
							<label
								className={`batch-command-target${selectedKeys.has(key) ? " selected" : ""}`}
								key={key}
							>
								<input
									type="checkbox"
									checked={selectedKeys.has(key)}
									onChange={() => toggleTarget(target)}
								/>
								<span className="batch-target-status" aria-hidden="true" />
								<span className="batch-target-meta">
									<strong>{target.label}</strong>
									<small>{target.endpoint}</small>
								</span>
							</label>
						);
					})}
					{targets.length === 0 ? (
						<p className="empty-copy">{t("noConnectedSessions")}</p>
					) : null}
				</div>

				<label className="field batch-command-input">
					<span>{t("batchCommandInput")}</span>
					<input
						ref={commandRef}
						type="text"
						autoComplete="off"
						maxLength={MAX_BATCH_COMMAND_LENGTH}
						value={command}
						placeholder={t("batchCommandPlaceholder")}
						spellCheck={false}
						onPaste={(event) => {
							if (/[\r\n]/.test(event.clipboardData.getData("text"))) {
								event.preventDefault();
								setResult(undefined);
								setInputError(t("batchSingleCommandOnly"));
							}
						}}
						onChange={(event) => {
							setCommand(event.target.value);
							setInputError("");
							setResult(undefined);
						}}
					/>
				</label>
				{inputError ? (
					<p className="batch-command-input-error" role="alert">
						{inputError}
					</p>
				) : null}

				{result ? (
					<p className="batch-command-result" aria-live="polite">
						{t("batchSent")}: <strong>{result.sentTargets.length}</strong>
						{result.skippedTargets.length > 0 ? (
							<>
								{" "}
								· {t("batchSkipped")}:{" "}
								<strong>{result.skippedTargets.length}</strong>
								<span className="batch-skipped-targets">
									(
									{result.skippedTargets
										.map((target) => target.label)
										.join(", ")}
									)
								</span>
							</>
						) : null}
					</p>
				) : null}

				<div className="dialog-actions">
					<button type="button" className="secondary-button" onClick={onClose}>
						{t("cancel")}
					</button>
					<button type="submit" className="primary-button" disabled={!canSend}>
						<SendHorizontal size={15} />
						{t("sendBatchCommand")}
					</button>
				</div>
			</form>
		</div>
	);
}
