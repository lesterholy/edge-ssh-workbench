import { FormEvent, useEffect, useState } from "react";
import { Copy, ShieldCheck, ShieldOff, X } from "lucide-react";
import type { TotpEnrollmentStartResponse } from "@edgesh/contracts";
import { ApiError, api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";

type Props = {
  enabled: boolean;
  t: (key: MessageKey) => string;
  onClose: () => void;
  onChanged: (enabled: boolean) => void;
};

function errorMessage(error: unknown, t: Props["t"]): string {
  if (error instanceof ApiError) {
    if (error.code === "TOTP_INVALID") return t("totpInvalid");
    if (error.code === "TOTP_ENROLLMENT_EXPIRED") return t("totpExpired");
    if (error.code === "INVALID_CREDENTIALS") return t("invalidSecurityCredentials");
  }
  return error instanceof Error ? error.message : t("securityRequestFailed");
}

export function SecurityDialog({ enabled, t, onClose, onChanged }: Props) {
  const [enrollment, setEnrollment] = useState<TotpEnrollmentStartResponse>();
  const [qrCode, setQrCode] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!enrollment) {
      setQrCode("");
      return;
    }
    let active = true;
    void import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(
      enrollment.otpauthUri,
      {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#101413", light: "#ffffff" }
      }
    )).then((value) => {
      if (active) setQrCode(value);
    }).catch((caught) => {
      if (active) setError(errorMessage(caught, t));
    });
    return () => { active = false; };
  }, [enrollment, t]);

  async function startEnrollment() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setEnrollment(await api.startTotpEnrollment());
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.confirmTotpEnrollment({ code });
      setEnrollment(undefined);
      setCode("");
      onChanged(true);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.disableTotp({ password, code });
      setPassword("");
      setCode("");
      onChanged(false);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
    } catch {
      setError(t("copyFailed"));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="host-dialog security-dialog" role="dialog" aria-modal="true" aria-labelledby="security-dialog-title">
        <div className="dialog-heading">
          <div>
            <h2 id="security-dialog-title"><ShieldCheck size={19} /> {t("securitySettings")}</h2>
            <p>{enabled ? t("totpEnabled") : t("totpDisabled")}</p>
          </div>
          <button type="button" className="icon-button" title={t("cancel")} disabled={busy} onClick={onClose}><X size={17} /></button>
        </div>

        {!enabled && !enrollment ? (
          <div className="security-summary">
            <ShieldCheck size={28} />
            <p>{t("totpEnableHelp")}</p>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void startEnrollment()}>
              {busy ? `${t("loading")}...` : t("startTotpEnrollment")}
            </button>
          </div>
        ) : null}

        {!enabled && enrollment ? (
          <form onSubmit={confirmEnrollment}>
            <p className="dialog-help">{t("scanTotpQr")}</p>
            <div className="totp-enrollment">
              <div className="qr-frame">
                {qrCode ? <img src={qrCode} width="220" height="220" alt={t("totpQrCode")} /> : <span>{t("loading")}...</span>}
              </div>
              <div className="totp-setup-fields">
                <span className="field-label">{t("totpSecret")}</span>
                <div className="secret-code">
                  <code>{enrollment.secret}</code>
                  <button type="button" className="icon-button" title={t("copySecret")} disabled={busy} onClick={() => void copySecret()}><Copy size={15} /></button>
                </div>
                {copied ? <small className="success-text">{t("copied")}</small> : null}
                <label className="dialog-field">
                  <span>{t("totpCode")}</span>
                  <input autoFocus required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" disabled={busy} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
                </label>
              </div>
            </div>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t("cancel")}</button>
              <button type="submit" className="primary-button" disabled={busy || code.length !== 6}>{busy ? `${t("loading")}...` : t("confirmEnable")}</button>
            </div>
          </form>
        ) : null}

        {enabled ? (
          <form onSubmit={disableTotp}>
            <div className="security-summary danger-summary"><ShieldOff size={28} /><p>{t("totpDisableHelp")}</p></div>
            <label className="dialog-field">
              <span>{t("adminPassword")}</span>
              <input autoFocus required type="password" maxLength={1024} autoComplete="current-password" disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="dialog-field">
              <span>{t("totpCode")}</span>
              <input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" disabled={busy} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t("cancel")}</button>
              <button type="submit" className="danger-button" disabled={busy || code.length !== 6}>{busy ? `${t("loading")}...` : t("disableTotp")}</button>
            </div>
          </form>
        ) : null}
        {!enabled && !enrollment && error ? <p className="form-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
