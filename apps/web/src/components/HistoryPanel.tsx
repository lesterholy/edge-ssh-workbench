import { useEffect, useMemo, useState } from "react";
import { Clock3, Eraser, RefreshCw, Search } from "lucide-react";
import type { CommandHistoryItem } from "@edgesh/contracts";
import { api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";

export function HistoryPanel({ t }: { t: (key: MessageKey) => string }) {
  const [items, setItems] = useState<CommandHistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const filtered = useMemo(() => {
    const value = query.toLowerCase();
    return value ? items.filter((item) => [item.command, item.profileName, item.host, item.username].some((field) => field.toLowerCase().includes(value))) : items;
  }, [items, query]);

  async function load() {
    try { setItems((await api.commandHistory(query)).items); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to load history"); }
  }
  async function clear() {
    if (!window.confirm(`${t("clear")} ${t("history")}?`)) return;
    await api.clearCommandHistory();
    setItems([]);
  }
  useEffect(() => { void load(); }, []);

  return (
    <section className="history-panel">
      <div className="history-toolbar">
        <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("commandSearch")} /></label>
        <button type="button" title={t("refresh")} onClick={() => void load()}><RefreshCw size={15} /></button>
        <button type="button" title={t("clear")} onClick={() => void clear()}><Eraser size={15} /></button>
      </div>
      <div className="history-list">
        {filtered.map((item) => (
          <div className="history-item" key={item.id}>
            <Clock3 size={14} />
            <div><code>{item.command}</code><small>{item.profileName} · {item.username}@{item.host} · {new Date(item.executedAt).toLocaleString()}</small></div>
          </div>
        ))}
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </section>
  );
}
