import { FormEvent, useState } from "react";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import type { EphemeralCredential, ProfileResponse } from "@edgesh/contracts";
import type { MessageKey } from "../lib/i18n";

type Props = {
  profile: ProfileResponse;
  busy: boolean;
  requestError: string;
  t: (key: MessageKey) => string;
  onCancel: () => void;
  onSubmit: (credential: EphemeralCredential) => void;
};

export function CredentialDialog({ profile, busy, requestError, t, onCancel, onSubmit }: Props) {
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (profile.authenticationMethod === "tailscale_ssh") return;
    if (profile.authenticationMethod === "password") {
      if (!password) {
        setError(t("credentialRequired"));
        return;
      }
      onSubmit({ method: "password", password });
      return;
    }
    if (!privateKey) {
      setError(t("credentialRequired"));
      return;
    }
    onSubmit({
      method: "private_key",
      privateKey,
      passphrase: passphrase || undefined
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="host-dialog credential-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title" onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <h2 id="credential-dialog-title"><KeyRound size={19} /> {t("connectionCredential")}</h2>
            <p>{profile.username}@{profile.host}:{profile.port}</p>
          </div>
          <button type="button" className="icon-button" title={t("cancel")} disabled={busy} onClick={onCancel}><X size={17} /></button>
        </div>
        <p className="dialog-help">{t("credentialMemoryOnly")}</p>
        {profile.authenticationMethod === "password" ? (
          <label className="dialog-field">
            <span>{t("password")}</span>
            <span className="secret-input">
              <input
                autoFocus
                required
                type={showPassword ? "text" : "password"}
                maxLength={4096}
                autoComplete="off"
                disabled={busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button type="button" title={showPassword ? t("hideSecret") : t("showSecret")} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </span>
          </label>
        ) : profile.authenticationMethod === "private_key" ? (
          <>
            <label className="dialog-field">
              <span>{t("privateKey")}</span>
              <textarea autoFocus required rows={9} maxLength={1024 * 1024} autoComplete="off" disabled={busy} value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} />
            </label>
            <label className="dialog-field">
              <span>{t("passphrase")} <small>({t("optional")})</small></span>
              <input type="password" maxLength={4096} autoComplete="off" disabled={busy} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
            </label>
          </>
        ) : null}
        {error || requestError ? <p className="form-error" role="alert">{error || requestError}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t("cancel")}</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? `${t("connecting")}...` : t("connect")}</button>
        </div>
      </form>
    </div>
  );
}
