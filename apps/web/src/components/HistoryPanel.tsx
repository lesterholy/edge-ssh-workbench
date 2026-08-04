import { useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Eraser, History, RefreshCw, Search, TerminalSquare } from "lucide-react";
import type { CommandHistoryItem, ServerWebSocketMessage } from "@edgesh/contracts";
import type { SessionChannel } from "./TerminalPane";
import type { ProfileResponse } from "@edgesh/contracts";
import { api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";

type Source = "workbench" | "bash";

type WorkbenchHistoryItem = CommandHistoryItem & { source: "workbench" };
type BashHistoryItem = {
  id: string;
  source: "bash";
  command: string;
  executedAt?: string;
  profileName: string;
  host: string;
  username: string;
};
type HistoryItem = WorkbenchHistoryItem | BashHistoryItem;

function sortByExecutionTime(items: HistoryItem[]): HistoryItem[] {
  return [...items].sort((left, right) => {
    const leftTime = left.executedAt ? Date.parse(left.executedAt) : Number.NaN;
    const rightTime = right.executedAt ? Date.parse(right.executedAt) : Number.NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return 0;
  });
}

type Props = {
  t: (key: MessageKey) => string;
  connected: boolean;
  channel: SessionChannel | null;
  profile?: ProfileResponse;
  message: ServerWebSocketMessage | null;
};

export function HistoryPanel({ t, connected, channel, profile, message }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<"all" | Source>("all");
  const [bashLoading, setBashLoading] = useState(false);
  const [bashError, setBashError] = useState("");
  const pendingBashRequest = useRef<string>();

  async function loadSession() {
    try {
      setError("");
      const response = await api.commandHistory(query);
      setItems((current) => {
        const bashItems = current.filter((item) => item.source === "bash");
        const sessionItems = response.items.map((item): WorkbenchHistoryItem => ({ ...item, source: "workbench" }));
        return sortByExecutionTime([...sessionItems, ...bashItems]);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load history");
    }
  }

  function loadBash() {
    if (!channel || !profile) return;
    const requestId = channel.send({ type: "shell-history", limit: 50 });
    if (!requestId) return;
    pendingBashRequest.current = requestId;
    setBashLoading(true);
    setBashError("");
  }

  function clear() {
    if (!window.confirm(`${t("clear")} ${t("history")}?`)) return;
    void api.clearCommandHistory();
    setItems((current) => current.filter((item) => item.source === "bash"));
  }

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    pendingBashRequest.current = undefined;
    setBashLoading(false);
    setBashError("");
    setItems((current) => current.filter((item) => item.source === "workbench"));
  }, [profile?.id]);

  useEffect(() => {
    if (!message) return;
    if (message.type === "shell-history-result" && message.requestId === pendingBashRequest.current) {
      pendingBashRequest.current = undefined;
      setBashLoading(false);
      const bashItems: BashHistoryItem[] = message.entries
        .filter((entry) => entry.command.trim())
        .map((entry) => ({
          id: crypto.randomUUID(),
          profileName: profile?.name ?? "server",
          host: profile?.host ?? "",
          username: profile?.username ?? "",
          command: entry.command.trim(),
          executedAt: entry.executedAt,
          source: "bash",
        }));
      setItems((current) => {
        const sessionItems = current.filter((item) => item.source === "workbench");
        return sortByExecutionTime([...sessionItems, ...bashItems]);
      });
      return;
    }
    if (message.type === "error" && message.requestId === pendingBashRequest.current) {
      pendingBashRequest.current = undefined;
      setBashLoading(false);
      setBashError(message.message);
    }
  }, [message, profile]);

  const filtered = useMemo(() => {
    let list = source === "all" ? items : items.filter((item) => item.source === source);
    if (!query.trim()) return list;
    const value = query.toLowerCase();
    return list.filter((item) =>
      [item.command, item.profileName, item.host, item.username].some((field) => field.toLowerCase().includes(value))
    );
  }, [items, query, source]);

  return (
    <section className="history-panel">
      <div className="history-toolbar">
        <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("commandSearch")} /></label>
        <div className="history-source">
          <button className={source === "all" ? "active" : ""} type="button" onClick={() => setSource("all")}>{t("all")}</button>
          <button className={source === "workbench" ? "active" : ""} type="button" onClick={() => setSource("workbench")} title={t("workbenchHistory")}><TerminalSquare size={13} /></button>
          <button className={source === "bash" ? "active" : ""} type="button" onClick={() => setSource("bash")} title={t("bashHistory")}><History size={13} /></button>
        </div>
        <button type="button" title={t("loadBashHistory")} disabled={!connected || bashLoading} onClick={() => void loadBash()}><History size={15} /></button>
        <button type="button" title={t("refresh")} onClick={() => void loadSession()}><RefreshCw size={15} /></button>
        <button type="button" title={t("clear")} onClick={() => void clear()}><Eraser size={15} /></button>
      </div>
      {bashError ? <p className="form-error">{bashError}</p> : null}
      <div className="history-list">
        {filtered.map((item) => (
          <div className="history-item" key={item.id}>
            {item.source === "bash" ? <History size={14} /> : <Clock3 size={14} />}
            <div>
              <code>{item.command}<span className="history-item-source">{item.source === "bash" ? t("historySourceBash") : t("historySourceWorkbench")}</span></code>
              <small>{item.profileName} · {item.username}@{item.host} · {item.executedAt ? new Date(item.executedAt).toLocaleString() : t("historyTimeUnavailable")}</small>
            </div>
          </div>
        ))}
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </section>
  );
}
