import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Import, RefreshCw, Search, X } from "lucide-react";
import type { AuthenticationMethod, TailscaleDevice, TailscaleImportResponse } from "@edgesh/contracts";
import { api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";

type Props = {
  t: (key: MessageKey) => string;
  onClose: () => void;
  onImported: (response: TailscaleImportResponse) => void;
};

const MAX_DEVICES = 50;

const reasonKey: Record<TailscaleImportResponse["skipped"][number]["reason"], MessageKey> = {
  duplicate: "importSkippedDuplicate",
  unauthorized: "importSkippedUnauthorized",
  missing_magic_dns: "importSkippedMissingMagicDns"
};

export function TailscaleImportDialog({ t, onClose, onImported }: Props) {
  const [tailnet, setTailnet] = useState("");
  const [devices, setDevices] = useState<TailscaleDevice[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState("root");
  const [port, setPort] = useState(22);
  const [authenticationMethod, setAuthenticationMethod] = useState<AuthenticationMethod>("tailscale_ssh");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TailscaleImportResponse | null>(null);
  const mountedRef = useRef(true);
  const importingRef = useRef(false);
  importingRef.current = importing;

  useEffect(() => {
    if (authenticationMethod === "tailscale_ssh") setPort(22);
  }, [authenticationMethod]);

  useEffect(() => {
    mountedRef.current = true;
    void loadDevices();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importingRef.current) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const normalizedSearch = search.trim().toLowerCase();

  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      if (a.authorized !== b.authorized) return a.authorized ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [devices]);

  const filteredDevices = useMemo(() => {
    if (!normalizedSearch) return sortedDevices;
    return sortedDevices.filter(
      (device) =>
        device.name.toLowerCase().includes(normalizedSearch) ||
        device.host.toLowerCase().includes(normalizedSearch) ||
        (device.os && device.os.toLowerCase().includes(normalizedSearch))
    );
  }, [sortedDevices, normalizedSearch]);

  const authorizedDevices = useMemo(() => filteredDevices.filter((device) => device.authorized), [filteredDevices]);
  const allSelected = authorizedDevices.length > 0 && authorizedDevices.every((device) => selectedIds.has(device.id));
  const canSubmit = selectedIds.size > 0 && !importing && username.trim().length > 0 && port >= 1 && port <= 65535;
  const totalAuthorized = useMemo(() => sortedDevices.filter((device) => device.authorized).length, [sortedDevices]);

  async function loadDevices() {
    setLoading(true);
    setError("");
    try {
      const response = await api.tailscaleDevices();
      if (!mountedRef.current) return;
      setTailnet(response.tailnet);
      setDevices(response.devices);
      setSelectedIds(new Set());
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : t("tailscaleLoadFailed"));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  function toggleDevice(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      if (next.size >= MAX_DEVICES) return current;
      next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      const filteredIds = new Set(authorizedDevices.map((device) => device.id));
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of filteredIds) next.delete(id);
        return next;
      });
      return;
    }
    const toSelect = authorizedDevices.slice(0, MAX_DEVICES).map((device) => device.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of toSelect) {
        if (next.size >= MAX_DEVICES) break;
        next.add(id);
      }
      return next;
    });
  }

  async function submit() {
    if (selectedIds.size === 0) return;
    const trimmedUsername = username.trim();
    if (!trimmedUsername || port < 1 || port > 65535) return;
    setImporting(true);
    setError("");
    try {
      const response = await api.tailscaleImport({
        deviceIds: Array.from(selectedIds),
        username: trimmedUsername,
        port,
        authenticationMethod
      });
      if (!mountedRef.current) return;
      setResult(response);
      onImported(response);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : t("tailscaleImportFailed"));
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  }

  function close() {
    if (!importing) onClose();
  }

  function reset() {
    setResult(null);
    setError("");
    setSelectedIds(new Set());
    setSearch("");
  }

  if (result) {
    return (
      <div className="dialog-backdrop" role="presentation">
        <section className="host-dialog tailscale-import-dialog" role="dialog" aria-modal="true" aria-labelledby="tailscale-import-result-title">
          <div className="dialog-heading">
            <div>
              <h2 id="tailscale-import-result-title"><CheckCircle2 size={19} /> {t("importFromTailscale")}</h2>
              <p>{t("importResultSummary")}</p>
            </div>
          </div>
          <div className="tailscale-result">
            <p className="tailscale-result-count">
              <span className="tailscale-created">{t("importResultCreated")}: {result.created.length}</span>
              <span className="tailscale-skipped">{t("importResultSkipped")}: {result.skipped.length}</span>
            </p>
            {result.created.length > 0 ? (
              <ul className="tailscale-created-list">
                {result.created.map((profile) => (
                  <li key={profile.id}>
                    <span className="tailscale-created-name">{profile.name}</span>
                    <small>{profile.host}:{profile.port}</small>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.skipped.length > 0 ? (
              <ul className="tailscale-skipped-list">
                {result.skipped.map((item) => (
                  <li key={item.deviceId}>
                    <span>{item.name}</span>
                    <span className={`tailscale-skip-reason tailscale-skip-${item.reason}`}>{t(reasonKey[item.reason])}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={reset}>{t("importMore")}</button>
            <button type="button" className="primary-button" onClick={close}>{t("close")}</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="host-dialog tailscale-import-dialog" role="dialog" aria-modal="true" aria-labelledby="tailscale-import-title">
        <div className="dialog-heading">
          <div>
            <h2 id="tailscale-import-title"><Import size={19} /> {t("importFromTailscale")}</h2>
            <p>{t("importTailscaleHelp")}</p>
          </div>
          <button type="button" className="icon-button" title={t("cancel")} disabled={importing} onClick={close}><X size={17} /></button>
        </div>

        {tailnet ? <p className="tailscale-tailnet"><span>{t("tailscaleTailnet")}</span> {tailnet}</p> : null}

        <div className="dialog-field">
          <span>{t("authMethod")}</span>
          <select value={authenticationMethod} onChange={(event) => setAuthenticationMethod(event.target.value as AuthenticationMethod)}>
            <option value="tailscale_ssh">{t("tailscaleSsh")}</option>
            <option value="password">{t("password")}</option>
            <option value="private_key">{t("privateKey")}</option>
          </select>
        </div>

        <div className="dialog-field">
          <span>{t("username")}</span>
          <input type="text" maxLength={128} value={username} onChange={(event) => setUsername(event.target.value)} />
        </div>

        <div className="dialog-field">
          <span>{t("port")}</span>
          <input type="number" min={1} max={65535} disabled={authenticationMethod === "tailscale_ssh"} value={port} onChange={(event) => setPort(Math.max(1, Math.min(65535, Number(event.target.value) || 0)))} />
        </div>

        <div className="tailscale-toolbar">
          <button type="button" className="secondary-button" disabled={loading || importing} onClick={() => void loadDevices()}>
            <RefreshCw size={15} className={loading ? "icon-spin" : undefined} /> {loading ? `${t("loading")}...` : t("refreshDevices")}
          </button>
          <span className="tailscale-selected-count">{selectedIds.size} / {MAX_DEVICES} {t("selectedDevices")} · {totalAuthorized} {t("authorized")}</span>
          <button type="button" className="secondary-button" disabled={authorizedDevices.length === 0 || importing} onClick={toggleAll}>
            {allSelected ? t("clearSelection") : t("selectAll")}
          </button>
        </div>

        <label className="tailscale-search">
          <Search size={15} />
          <input type="search" placeholder={t("searchDevices")} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <div className="tailscale-device-list">
          {filteredDevices.length === 0 ? (
            <p className="empty-state">{loading ? `${t("loading")}...` : devices.length === 0 ? t("noTailscaleDevices") : t("noTailscaleDevicesMatching")}</p>
          ) : (
            filteredDevices.map((device) => {
              const selected = selectedIds.has(device.id);
              const disabled = !device.authorized || (!selected && selectedIds.size >= MAX_DEVICES);
              return (
                <label key={device.id} className={`tailscale-device-row${selected ? " selected" : ""}${device.authorized ? "" : " unauthorized"}`}>
                  <input type="checkbox" disabled={disabled} checked={selected} onChange={() => toggleDevice(device.id)} />
                  <span className="tailscale-device-status" aria-hidden="true" data-online={device.online} />
                  <span className="sr-only">{device.online ? t("deviceOnline") : t("deviceOffline")}</span>
                  <span className="tailscale-device-meta">
                    <span>{device.name}</span>
                    <small>{device.host} {device.os ? `· ${device.os}` : null}</small>
                  </span>
                  {!device.authorized ? <span className="tailscale-device-badge">{t("tailscaleDeviceUnauthorized")}</span> : null}
                </label>
              );
            })
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={importing} onClick={close}>{t("cancel")}</button>
          <button type="button" className="primary-button" disabled={!canSubmit} onClick={() => void submit()}>
            {importing ? `${t("loading")}...` : t("import")}
          </button>
        </div>
      </section>
    </div>
  );
}
