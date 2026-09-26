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
      "Pólizas y antecedentes ficticios ya cargados.",
      "Entras sin contraseña con el QR del administrador de demostración.",
      "Incluye un simulador de casos y un webhook de prueba con clave pública.",
      "La IA clasifica de verdad y los avisos llegan a Slack.",
    ],
  },
  production: {
    name: "Producción",
    tagline: "Así lo usaría un hospital o una aseguradora",
    details: [
      "Cuentas de personal con ID, código de app autenticadora y contraseña, con permisos por rol.",
      "Pólizas y antecedentes llegan desde la API de la aseguradora; aquí, una aseguradora simulada.",
      "El webhook exige un token por integración y cada acción queda en la auditoría.",
      "Para entrar necesitas las credenciales de evaluación que recibió el jurado.",
    ],
  },
};

/** Recuerda la elección durante la pestaña; si falla el almacenamiento, el selector vuelve a mostrarse. */
export function readModeChoice(currentMode: InstallationMode | null): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("modo");
    if (requested && requested === currentMode) {
      window.sessionStorage.setItem(CHOICE_KEY, requested);
      params.delete("modo");
      const query = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
      return true;
    }
    return window.sessionStorage.getItem(CHOICE_KEY) === currentMode;
  } catch {
    return false;
  }
}

function rememberChoice(mode: InstallationMode) {
  try { window.sessionStorage.setItem(CHOICE_KEY, mode); } catch { /* sin almacenamiento: solo esta vista */ }
}

export function ModeSelector({ currentMode, demoUrl, productionUrl, onEnter }: {
  currentMode: InstallationMode | null;
  demoUrl: string | null;
  productionUrl: string | null;
  onEnter: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<InstallationMode | null>(null);
  // Es una puerta de entrada: Escape no la cierra sin elegir.
  useDialogFocus(dialogRef, firstOptionRef, () => undefined);

  const targetUrl = selected === "demo" ? demoUrl : selected === "production" ? productionUrl : null;
  const here = selected !== null && selected === currentMode;
  const unavailable = selected !== null && !here && !targetUrl;

  function enter() {
    if (!selected) return;
    if (here) {
      rememberChoice(selected);
      onEnter();
      return;
    }
    if (targetUrl) window.location.assign(`${targetUrl}/?modo=${selected}`);
  }

  return <div className="modeGateBackdrop">
    <section className="modeGate glassPanel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
      <div className="modeGateBrand"><img src={vigiliaLogo} alt="Vigilia" /><span className="eyebrow">ALERTA TEMPRANA DE INGRESOS</span></div>
      <h2 id={titleId}>¿Cómo quieres conocer Vigilia?</h2>
      <p className="modeGateLead">Vigilia recibe el ingreso a emergencias, verifica la póliza y los antecedentes, y avisa a la vez a admisiones y al gestor de casos. Elige una de las dos instalaciones.</p>

      <div className="modeGateOptions" role="group" aria-label="Modo de la instalación">
        {(Object.keys(MODES) as InstallationMode[]).map((mode, index) => (
          <button key={mode} ref={index === 0 ? firstOptionRef : undefined} type="button"
            className={`modeGateOption${selected === mode ? " selected" : ""}`} aria-pressed={selected === mode}
            onClick={() => setSelected(mode)}>
            <strong>{MODES[mode].name}</strong>
            <span>{MODES[mode].tagline}</span>
            {currentMode === mode && <small>Estás en esta instalación</small>}
          </button>
        ))}
      </div>

      {selected && <div className="modeGateDetail" aria-live="polite">
        <h3>Para qué sirve el modo {MODES[selected].name}</h3>
        <ul>{MODES[selected].details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        {unavailable && <p className="modeGateNote">Esta instalación aún no tiene una dirección publicada.</p>}
        <button className="primaryButton" type="button" disabled={unavailable} onClick={enter}>Entrar modo {MODES[selected].name}</button>
      </div>}

      <p className="modeGateFoot">Puedes cambiar de modo cuando quieras desde el pie de la página.</p>
    </section>
  </div>;
}
