import { FormEvent, useEffect, useState } from "react";
import { KeyRound, Languages, LogIn, Moon, ShieldCheck, Sun } from "lucide-react";
import type { Language, Theme } from "@edgesh/contracts";
import { ApiError, api } from "../lib/api";
import type { MessageKey } from "../lib/i18n";

type Props = {
  language: Language;
  theme: Theme;
  googleLoginEnabled: boolean;
  t: (key: MessageKey) => string;
  onLanguage: (language: Language) => void;
  onTheme: (theme: Theme) => void;
  onAuthenticated: (totpEnabled: boolean) => void;
};

export function LoginView({ language, theme, googleLoginEnabled, t, onLanguage, onTheme, onAuthenticated }: Props) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("authError") !== "google_login_failed") return;
    setError(t("googleSignInFailed"));
    url.searchParams.delete("authError");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const state = await api.login({ password, totpCode: totpCode || undefined });
      if (state.authenticated) onAuthenticated(state.totpEnabled);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setTotpRequired(apiError?.code === "TOTP_REQUIRED" || apiError?.code === "TOTP_INVALID");
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function startGoogleLogin() {
    setBusy(true);
    setError("");
    try {
      const { authorizationUrl } = await api.startGoogleLogin();
      window.location.assign(authorizationUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-form" onSubmit={submit}>
        <div className="login-toolbar">
          <span className="brand-mark"><KeyRound size={20} /></span>
          <div className="toolbar-actions">
            <button type="button" className="icon-button" title={t("language")} onClick={() => onLanguage(language === "zh-CN" ? "en" : "zh-CN")}>
              <Languages size={17} />
            </button>
            <button type="button" className="icon-button" title={t("theme")} onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </div>
        <div className="login-heading">
          <h1>{t("appName")}</h1>
          <p>{t("product")}</p>
        </div>
        {googleLoginEnabled ? (
          <>
            <button className="secondary-button oauth-button" type="button" disabled={busy} onClick={() => void startGoogleLogin()}>
              <LogIn size={17} />
              {t("googleSignIn")}
            </button>
            <div className="login-divider"><span>{t("orPassword")}</span></div>
          </>
        ) : null}
        <label>
          <span>{t("adminPassword")}</span>
          <input type="password" maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        {totpRequired ? (
          <label>
            <span>{t("totpCode")}</span>
            <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value)} autoComplete="one-time-code" required />
          </label>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>
          <ShieldCheck size={17} />
          {busy ? `${t("loading")}...` : t("signIn")}
        </button>
      </form>
    </main>
  );
}
