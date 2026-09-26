import { useRef, useState, type FormEvent } from "react";
import vigiliaLogo from "../assets/vigilia-card-nav-logo.svg";
import { changePassword, type CurrentSession } from "../lib/clientApi";
import { Icon } from "./Icon";
import "../auth.css";

type Field = "current" | "next" | "confirm";

/** Mismas reglas que el servidor (local_accounts.validate_new_password), para avisar antes de enviar. */
function validate(current: string, next: string, confirm: string, accountId: string): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!current) errors.current = "Escribe tu contraseña actual.";
  if (next.length < 12) errors.next = "Usa al menos 12 caracteres; una frase de varias palabras es fácil de recordar.";
  else if (next !== next.trim()) errors.next = "No empieces ni termines con espacios.";
  else if (accountId && next.toLowerCase().includes(accountId.toLowerCase())) errors.next = "No incluyas tu ID de acceso.";
  else if (next === current) errors.next = "Debe ser distinta de la contraseña actual.";
  if (!errors.next && confirm !== next) errors.confirm = "Las contraseñas no coinciden.";
  return errors;
}

export function PasswordChangeForm({ accountId, temporary = false, onDone }: { accountId: string; temporary?: boolean; onDone: (session: CurrentSession) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refs = { current: useRef<HTMLInputElement>(null), next: useRef<HTMLInputElement>(null), confirm: useRef<HTMLInputElement>(null) };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const nextErrors = validate(current, next, confirm, accountId);
    setErrors(nextErrors); setError("");
    const first = (["current", "next", "confirm"] as Field[]).find((key) => nextErrors[key]);
    if (first) { refs[first].current?.focus(); return; }
    setBusy(true);
    try {
      onDone(await changePassword(current, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cambiar la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  const field = (key: Field, label: string, value: string, onChange: (value: string) => void, autoComplete: string) => (
    <label className="adminField">
      <span>{label}</span>
      <input ref={refs[key]} type="password" autoComplete={autoComplete} maxLength={128} required value={value} disabled={busy}
        aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `password-${key}-error` : undefined}
        onChange={(event) => { onChange(event.target.value); setErrors((previous) => ({ ...previous, [key]: undefined })); setError(""); }} />
      {errors[key] && <span id={`password-${key}-error`} className="authFieldError" role="alert">{errors[key]}</span>}
    </label>
  );

  return (
    <form className="authForm passwordForm" noValidate aria-busy={busy} onSubmit={(event) => void submit(event)}>
      {field("current", temporary ? "Contraseña temporal" : "Contraseña actual", current, setCurrent, "current-password")}
      {field("next", "Nueva contraseña", next, setNext, "new-password")}
      {field("confirm", "Repite la nueva contraseña", confirm, setConfirm, "new-password")}
      <p className="passwordHint">Mínimo 12 caracteres. Una frase de varias palabras es segura y fácil de recordar. Al cambiarla se cierran tus otras sesiones.</p>
      {error && <p className="adminNotice error" role="alert">{error}</p>}
      <button className="primaryButton" type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
    </form>
  );
}

/** Pantalla obligatoria tras entrar con una contraseña temporal: nada más está disponible hasta cambiarla. */
export function PasswordChangeGate({ session, onSession, onSignOut, signingOut }: { session: CurrentSession; onSession: (session: CurrentSession) => void; onSignOut: () => void; signingOut: boolean }) {
  return <main className="authGate appFrame">
    <div className="ambient ambientOne" aria-hidden="true" />
    <div className="ambient ambientTwo" aria-hidden="true" />
    <div className="authGateCard glassPanel authAccessCard">
      <div className="authBrand"><img src={vigiliaLogo} alt="Vigilia" /><span className="eyebrow">PRIMER ACCESO</span></div>
      <h1>Crea tu contraseña</h1>
      <p className="authLead">Hola, {session.user.display_name}. Entraste con una contraseña temporal; cámbiala por una tuya para continuar.</p>
      <PasswordChangeForm accountId={session.user.employee_id ?? ""} temporary onDone={onSession} />
      <button type="button" className="authSwitch authAlternate" onClick={onSignOut} disabled={signingOut}>{signingOut ? "Cerrando sesión…" : "Salir sin cambiarla"}</button>
      <p className="authFooter"><Icon name="shield" size={14} />Acceso auditado · tus permisos se verifican en el servidor.</p>
    </div>
  </main>;
}
