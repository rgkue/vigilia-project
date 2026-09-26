import { useId, useRef, useState } from "react";
import vigiliaLogo from "../assets/vigilia-card-nav-logo.svg";
import { useDialogFocus } from "./Dialogs";
import "../mode-selector.css";

export type InstallationMode = "demo" | "production";

const CHOICE_KEY = "vigilia:modo-elegido";

const MODES: Record<InstallationMode, { name: string; tagline: string; details: string[] }> = {
  demo: {
    name: "Demo",
    tagline: "Para evaluar el reto en minutos",
    details: [
      "Entras al instante, sin usuario ni contraseña.",
      "Registras ingresos, usas el simulador y revisas las sugerencias de la IA.",
      "Pólizas y antecedentes ficticios; la IA clasifica de verdad y los avisos llegan a Slack.",
      "La administración de personas e integraciones queda para el modo Producción.",
    ],
  },
  production: {
    name: "Producción",
    tagline: "Así lo usaría un hospital o una aseguradora",
    details: [
      "Cuentas de personal con ID, código de app autenticadora y contraseña, con permisos por rol.",
      "Administración de personas, integraciones con la aseguradora (aquí simulada) y auditoría.",
      "El webhook del hospital exige un token por integración.",
      "Para entrar necesitas las credenciales de evaluación que recibió el jurado.",
    ],
  },
};

/** ¿Ya se eligió modo en esta pestaña? También acepta ?modo= al llegar desde otra instalación. */
export function hasModeChoice(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("modo");
    if (requested === "demo" || requested === "production") {
      window.sessionStorage.setItem(CHOICE_KEY, requested);
      params.delete("modo");
      const query = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
      return true;
    }
    return window.sessionStorage.getItem(CHOICE_KEY) !== null;
  } catch {
    return false;
  }
}

export function rememberModeChoice(mode: InstallationMode) {
  try { window.sessionStorage.setItem(CHOICE_KEY, mode); } catch { /* sin almacenamiento: solo esta vista */ }
}

export function ModeSelector({ currentMode, availability, pending, error, onEnter }: {
  /** Modo de la sesión actual, si hay una. */
  currentMode: InstallationMode | null;
  /** Modos que esta instalación puede abrir (en sí misma o en otra dirección). */
  availability: Record<InstallationMode, boolean>;
  pending: boolean;
  error: string;
  onEnter: (mode: InstallationMode) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<InstallationMode | null>(null);
  // Es una puerta de entrada: Escape no la cierra sin elegir.
  useDialogFocus(dialogRef, firstOptionRef, () => undefined);

  const unavailable = selected !== null && !availability[selected];

  return <div className="modeGateBackdrop">
    <section className="modeGate glassPanel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1} aria-busy={pending}>
      <div className="modeGateBrand"><img src={vigiliaLogo} alt="Vigilia" /><span className="eyebrow">ALERTA TEMPRANA DE INGRESOS</span></div>
      <h2 id={titleId}>¿Cómo quieres conocer Vigilia?</h2>
      <p className="modeGateLead">Vigilia recibe el ingreso a emergencias, verifica la póliza y los antecedentes, y avisa a la vez a admisiones y al gestor de casos. Los dos modos usan esta misma instalación y los mismos datos ficticios.</p>

      <div className="modeGateOptions" role="group" aria-label="Modo de acceso">
        {(Object.keys(MODES) as InstallationMode[]).map((mode, index) => (
          <button key={mode} ref={index === 0 ? firstOptionRef : undefined} type="button"
            className={`modeGateOption${selected === mode ? " selected" : ""}`} aria-pressed={selected === mode}
            disabled={pending} onClick={() => setSelected(mode)}>
            <strong>{MODES[mode].name}</strong>
            <span>{MODES[mode].tagline}</span>
            {currentMode === mode && <small>Estás en este modo</small>}
          </button>
        ))}
      </div>

      {selected && <div className="modeGateDetail" aria-live="polite">
        <h3>Para qué sirve el modo {MODES[selected].name}</h3>
        <ul>{MODES[selected].details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        {unavailable && <p className="modeGateNote">Este modo no está habilitado en esta instalación.</p>}
        {error && <p className="modeGateNote" role="alert">{error}</p>}
        <button className="primaryButton" type="button" disabled={unavailable || pending} onClick={() => onEnter(selected)}>
          {pending ? "Entrando…" : `Entrar modo ${MODES[selected].name}`}
        </button>
      </div>}

      <p className="modeGateFoot">Puedes cambiar de modo cuando quieras desde el pie de la página.</p>
    </section>
  </div>;
}
