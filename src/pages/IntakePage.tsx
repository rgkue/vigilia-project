import { useRef, useState, type FormEvent } from "react";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { DateTimeField, Select, SuggestInput } from "../components/Pickers";
import { ResultPanel } from "../components/ResultPanel";
import type { AgentResponse, IngressEvent } from "../types";

export type LiveIngressDraft = Pick<IngressEvent, "cedula" | "hospital" | "motivo_ingreso" | "triage"> & { fecha_ingreso: string };
type FieldErrors = Partial<Record<"cedula" | "hospital" | "motivo_ingreso" | "fecha_ingreso", string>>;

// Cédula panameña: provincia (1–13), PE, E o N, con AV/PI opcional; tomo y asiento numéricos.
const PANAMA_ID = /^(?:PE|E|N|1[0-3]|[1-9])(?:AV|PI)?-\d{1,4}-\d{1,6}$/i;

const TRIAGE_OPTIONS = [
  { value: "", label: "Sin clasificación" },
  { value: "1", label: "1 · Atención inmediata" },
  { value: "2", label: "2 · Muy urgente" },
  { value: "3", label: "3 · Urgente" },
  { value: "4", label: "4 · Menos urgente" },
  { value: "5", label: "5 · No urgente" },
];

function localDateTimeValue(date = new Date()) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 16);
}

function emptyDraft(): LiveIngressDraft {
  return { cedula: "", hospital: "", motivo_ingreso: "", triage: undefined, fecha_ingreso: localDateTimeValue() };
}

function validate(draft: LiveIngressDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.cedula.trim()) errors.cedula = "Escribe la identificación del asegurado.";
  if (!draft.hospital.trim()) errors.hospital = "Indica el centro de atención.";
  if (draft.motivo_ingreso.trim().length < 3) errors.motivo_ingreso = "Describe el motivo con al menos 3 caracteres.";
  const admitted = Date.parse(draft.fecha_ingreso);
  if (!draft.fecha_ingreso || Number.isNaN(admitted)) errors.fecha_ingreso = "Indica la fecha y hora del ingreso.";
  else if (admitted > Date.now() + 5 * 60_000) errors.fecha_ingreso = "La fecha de ingreso no puede estar en el futuro.";
  return errors;
}

export function IntakePage({ available, statusMessage, result, pending, error, hospitals, onSubmit }: {
  available: boolean;
  statusMessage: string;
  result: AgentResponse | null;
  pending: boolean;
  error: string;
  hospitals: string[];
  onSubmit: (draft: LiveIngressDraft) => Promise<AgentResponse | null>;
}) {
  const [draft, setDraft] = useState<LiveIngressDraft>(emptyDraft);
  const [authorized, setAuthorized] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [registered, setRegistered] = useState<AgentResponse | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const idWarning = draft.cedula.trim() && !PANAMA_ID.test(draft.cedula.trim())
    ? "No coincide con el formato de cédula panameña (ej. 8-123-4567). Puedes enviarla si es otro documento."
    : "";

  function update<K extends keyof LiveIngressDraft>(key: K, value: LiveIngressDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRegistered(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || pending || !authorized) return;
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    const firstInvalid = (Object.keys(nextErrors) as (keyof FieldErrors)[]).find((key) => nextErrors[key]);
    if (firstInvalid) {
      document.getElementById(`intake-${firstInvalid}`)?.focus();
      return;
    }
    const response = await onSubmit({ ...draft, cedula: draft.cedula.trim(), hospital: draft.hospital.trim(), motivo_ingreso: draft.motivo_ingreso.trim() });
    if (response) {
      setRegistered(response);
      setDraft(emptyDraft());
      setAuthorized(false);
    }
  }

  function startAnother() {
    setRegistered(null);
    setErrors({});
    firstField.current?.focus();
  }

  const fieldProps = (key: keyof FieldErrors) => ({
    id: `intake-${key}`,
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `intake-${key}-error` : undefined,
  });
  const fieldError = (key: keyof FieldErrors) => errors[key] ? <span id={`intake-${key}-error`} className="fieldError" role="alert">{errors[key]}</span> : null;

  return (
    <div className="pageStack">
      <header className="pageIntro">
        <span className="eyebrow">COORDINACIÓN DE INGRESOS</span>
        <h1>Registrar ingreso</h1>
        <p>Envía la referencia del ingreso para consultar la información administrativa y preparar el seguimiento del equipo.</p>
      </header>
      <div className="liveWorkspace">
        <form className="glassPanel liveFormPanel" onSubmit={submit} noValidate>
          <div className="formPanelHeading liveFormHeading">
            <div><span className="eyebrow">NUEVO REGISTRO</span><h2>Detalles del ingreso</h2></div>
            <span className={`serviceState${available ? " ready" : " paused"}`}><i />{available ? "Servicio disponible" : "Registro inactivo"}</span>
          </div>
          {registered && <div className="adminNotice intakeSuccess" role="status">
            <div><strong>Ingreso registrado</strong><span>Referencia <code>{registered.event_id}</code></span></div>
            <div className="intakeSuccessActions"><CopyButton value={registered.event_id} label="Copiar referencia" /><button className="secondaryButton" type="button" onClick={startAnother}>Registrar otro</button></div>
          </div>}
          <p className="panelIntro">Completa los datos que aparecen en el aviso del centro de atención.</p>
          <fieldset className="liveFields" disabled={pending}>
            <label className="liveField"><span>Identificación del asegurado</span><input ref={firstField} {...fieldProps("cedula")} autoComplete="off" inputMode="text" maxLength={20} required value={draft.cedula} onChange={(event) => update("cedula", event.target.value)} placeholder="8-123-4567" />{fieldError("cedula") ?? (idWarning && <span className="fieldHint">{idWarning}</span>)}</label>
            <label className="liveField"><span>Centro de atención</span><SuggestInput {...fieldProps("hospital")} suggestions={hospitals} autoComplete="off" maxLength={80} required value={draft.hospital} onChange={(value) => update("hospital", value)} placeholder="Nombre del centro" />{fieldError("hospital")}</label>
            <label className="liveField liveFieldWide"><span>Motivo del ingreso</span><textarea {...fieldProps("motivo_ingreso")} autoComplete="off" maxLength={300} minLength={3} required rows={4} value={draft.motivo_ingreso} onChange={(event) => update("motivo_ingreso", event.target.value)} placeholder="Descripción recibida por admisiones" />{fieldError("motivo_ingreso")}</label>
            <label className="liveField"><span>Nivel de triage <small>Opcional</small></span><Select value={draft.triage ? String(draft.triage) : ""} onChange={(value) => update("triage", value ? Number(value) : undefined)} options={TRIAGE_OPTIONS} /></label>
            <label className="liveField"><span>Fecha y hora de ingreso</span><DateTimeField {...fieldProps("fecha_ingreso")} required max={localDateTimeValue()} value={draft.fecha_ingreso} onChange={(value) => update("fecha_ingreso", value)} />{fieldError("fecha_ingreso")}</label>
          </fieldset>
          <label className="authorizationCheck"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /><span>Confirmo que estoy autorizado para compartir esta información con el servicio de Vigilia.</span></label>
          <div className="livePrivacyNote"><Icon name="shield" size={16} /><p>El resultado es administrativo y debe revisarlo el equipo responsable antes de actuar.</p></div>
          {error && <div className="errorBanner" role="alert"><span className="errorMark">!</span><div><strong>No se pudo registrar el ingreso</strong><p>{error}</p><small>Comprueba la actividad antes de volver a enviarlo.</small></div></div>}
          <div className="liveSubmitRow"><p role="status">{statusMessage}</p><button className="primaryButton" type="submit" disabled={!available || pending || !authorized}>{pending ? <><span className="buttonSpinner" />Procesando…</> : <>Enviar ingreso <Icon name="arrow" size={16} /></>}</button></div>
        </form>
        <div id="live-result" className="liveResult" role="region" aria-label="Resultado del ingreso" tabIndex={-1}>
          <ResultPanel result={result} pending={pending} emptyDescription="El resultado administrativo aparecerá aquí después de enviar un ingreso." />
        </div>
      </div>
    </div>
  );
}
