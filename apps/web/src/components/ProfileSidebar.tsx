import { FormEvent, useMemo, useState } from "react";
import { Eye, EyeOff, Pencil, Plug, Plus, Search, Server, Trash2, X } from "lucide-react";
import type { ProfileCreateRequest, ProfileResponse, ProfileUpdateRequest } from "@edgesh/contracts";
import type { MessageKey } from "../lib/i18n";

type Props = {
  profiles: ProfileResponse[];
  selectedId?: string;
  busy?: boolean;
  t: (key: MessageKey) => string;
  onSelect: (id: string) => void;
  onCreate: (input: ProfileCreateRequest) => Promise<void>;
  onUpdate: (id: string, input: ProfileUpdateRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

type Draft = {
  name: string;
  host: string;
  port: number;
  username: string;
  method: "password" | "private_key" | "tailscale_ssh";
  persistence: "saved" | "prompt";
  password: string;
  privateKey: string;
  passphrase: string;
  notes: string;
  initialCommand: string;
};

const emptyDraft = (): Draft => ({
  name: "",
  host: "",
  port: 22,
  username: "root",
  method: "password",
  persistence: "saved",
  password: "",
  privateKey: "",
  passphrase: "",
  notes: "",
  initialCommand: ""
});

export function ProfileSidebar({ profiles, selectedId, busy, t, onSelect, onCreate, onUpdate, onDelete }: Props) {
  const [filter, setFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const editingProfile = editingId ? profiles.find((profile) => profile.id === editingId) : undefined;
  const hasSavedCredential = draft.method === "password"
    ? editingProfile?.hasPassword === true
    : draft.method === "private_key"
      ? editingProfile?.hasPrivateKey === true
      : false;

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return profiles;
    return profiles.filter((profile) => [profile.name, profile.host, profile.username].some((value) => value.toLowerCase().includes(query)));
  }, [filter, profiles]);

  function startCreate() {
    setEditingId(undefined);
    setDraft(emptyDraft());
    setError("");
    setFormOpen(true);
  }

  function startEdit(profile: ProfileResponse) {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      method: profile.authenticationMethod,
      persistence: profile.credentialPersistence === "none" ? "saved" : profile.credentialPersistence,
      password: "",
      privateKey: "",
      passphrase: "",
      notes: profile.notes,
      initialCommand: profile.initialCommand ?? ""
    });
    setError("");
    setFormOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (editingId) {
        const credential: ProfileUpdateRequest["credential"] = draft.method === "tailscale_ssh"
          ? { method: "tailscale_ssh" }
          : draft.method === "password"
          ? {
              method: "password",
              persistence: draft.persistence,
              password: draft.persistence === "prompt"
                ? { action: "clear" }
                : draft.password ? { action: "replace", value: draft.password } : { action: "keep" }
            }
          : {
              method: "private_key",
              persistence: draft.persistence,
              privateKey: draft.persistence === "prompt"
                ? { action: "clear" }
                : draft.privateKey ? { action: "replace", value: draft.privateKey } : { action: "keep" },
              passphrase: draft.persistence === "prompt"
                ? { action: "clear" }
                : draft.passphrase ? { action: "replace", value: draft.passphrase } : { action: "keep" }
            };
        await onUpdate(editingId, {
          name: draft.name,
          host: draft.host,
          port: draft.port,
          username: draft.username,
          notes: draft.notes,
          initialCommand: draft.initialCommand || null,
          credential
        });
      } else {
        const credential: ProfileCreateRequest["credential"] = draft.method === "tailscale_ssh"
          ? { method: "tailscale_ssh" }
          : draft.method === "password"
          ? draft.persistence === "prompt"
            ? { method: "password", persistence: "prompt" }
            : { method: "password", persistence: "saved", password: draft.password }
          : {
              method: "private_key",
              persistence: draft.persistence,
              privateKey: draft.persistence === "saved" ? draft.privateKey : undefined,
              passphrase: draft.persistence === "saved" ? draft.passphrase || undefined : undefined,
              savePassphrase: draft.persistence === "saved" && Boolean(draft.passphrase)
            };
        await onCreate({
          name: draft.name,
          host: draft.host,
          port: draft.port,
          username: draft.username,
          notes: draft.notes,
          initialCommand: draft.initialCommand || null,
          terminalType: "xterm-256color",
          encoding: "utf-8",
          credential
        });
      }
      setFormOpen(false);
      setDraft(emptyDraft());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save profile");
    }
  }

  return (
    <aside className="server-sidebar">
      <div className="section-heading">
        <span><Server size={17} /> {t("servers")}</span>
        <button className="icon-button" type="button" title={t("addServer")} onClick={startCreate}><Plus size={17} /></button>
      </div>
      <label className="search-field">
        <Search size={15} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("filterServers")} />
      </label>
      <div className="server-list">
        {filtered.map((profile) => (
          <div className={`server-row${selectedId === profile.id ? " selected" : ""}`} key={profile.id}>
            <button className="server-main" type="button" onClick={() => onSelect(profile.id)}>
              <span className="server-avatar" aria-hidden="true">{(profile.name || profile.host).slice(0, 1).toUpperCase()}</span>
              <span className="server-meta">
                <span>{profile.name}</span>
                <small>{profile.username}@{profile.host}:{profile.port}</small>
              </span>
            </button>
            <div className="row-actions">
              <button type="button" title={t("connect")} onClick={() => onSelect(profile.id)}><Plug size={14} /></button>
              <button type="button" title={t("editServer")} onClick={() => startEdit(profile)}><Pencil size={14} /></button>
              <button type="button" title={t("deleteServer")} onClick={() => window.confirm(t("confirmDelete")) && void onDelete(profile.id)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {filtered.length === 0 ? <p className="empty-state">{t("noServer")}</p> : null}
      </div>
      {formOpen ? (
        <form className="profile-form" onSubmit={submit}>
          <div className="section-heading compact">
            <strong>{editingId ? t("editServer") : t("addServer")}</strong>
            <button type="button" className="icon-button" title={t("cancel")} onClick={() => setFormOpen(false)}><X size={16} /></button>
          </div>
          <input required maxLength={100} placeholder={t("name")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <input required maxLength={253} placeholder={t("host")} value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} />
          <div className="split-fields">
            <input required disabled={draft.method === "tailscale_ssh"} type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} />
            <input required maxLength={128} placeholder={t("username")} value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
          </div>
          <select value={draft.method} onChange={(event) => {
            const method = event.target.value as Draft["method"];
            setDraft({
              ...draft,
              method,
              port: method === "tailscale_ssh" ? 22 : draft.port,
              password: "",
              privateKey: "",
              passphrase: ""
            });
          }}>
            <option value="password">{t("password")}</option>
            <option value="private_key">{t("privateKey")}</option>
            <option value="tailscale_ssh">{t("tailscaleSsh")}</option>
          </select>
          {draft.method !== "tailscale_ssh" ? (
            <select value={draft.persistence} onChange={(event) => setDraft({ ...draft, persistence: event.target.value as Draft["persistence"], password: "", privateKey: "", passphrase: "" })}>
              <option value="saved">{t("saveCredential")}</option>
              <option value="prompt">{t("promptCredential")}</option>
            </select>
          ) : null}
          {draft.method !== "tailscale_ssh" && draft.persistence === "prompt" ? <p className="form-help">{t("promptCredentialHelp")}</p> : null}
          {draft.method === "password" && draft.persistence === "saved" ? (
            <span className="secret-input">
              <input required={!hasSavedCredential} type={showPassword ? "text" : "password"} maxLength={4096} placeholder={hasSavedCredential ? `${t("password")} (${t("save")}: optional)` : t("password")} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
              <button type="button" title={showPassword ? "Hide" : "Show"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </span>
          ) : draft.method === "private_key" && draft.persistence === "saved" ? (
            <>
              <textarea required={!hasSavedCredential} rows={5} placeholder={hasSavedCredential ? `${t("privateKey")} (${t("save")}: optional)` : t("privateKey")} value={draft.privateKey} onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })} />
              <input type="password" placeholder={t("passphrase")} value={draft.passphrase} onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })} />
            </>
          ) : null}
          <input maxLength={8192} placeholder={t("initialCommand")} value={draft.initialCommand} onChange={(event) => setDraft({ ...draft, initialCommand: event.target.value })} />
          <textarea rows={2} maxLength={4000} placeholder={t("notes")} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={busy}>{t("save")}</button>
        </form>
      ) : null}
    </aside>
  );
}
