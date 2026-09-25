import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CardNav } from "./components/CardNav";
import { demoCases, makeDemoEvent } from "./data/demoCases";
import { BackendConnectionError, checkBackendHealth, isBackendConfigured, loadIngressHistory, processDemoIngress, processIngress } from "./lib/agentApi";
import { evaluateJevCase, loadJevStatus } from "./lib/jevApi";
import { classificationLabel } from "./types";
import type { AdministrativeVerdict, AgentResponse, AlertLevel, DemoCase, IngressEvent, JevEvaluation, JevRelation, NotificationResult } from "./types";

type IconName = "pulse" | "overview" | "intake" | "shield" | "clock" | "hospital" | "bell" | "arrow" | "check" | "spark" | "network" | "refresh";
type BackendStatus = "local" | "checking" | "online" | "offline";
type JevStatus = "checking" | "configured" | "missing" | "unavailable";
type SectionId = "overview" | "intake" | "activity" | "simulator";

const ROUTE_BY_SECTION: Record<SectionId, string> = {
  overview: "/resumen",
  intake: "/ingreso",
  activity: "/actividad",
  simulator: "/simulador",
};

const SECTION_BY_ROUTE: Record<string, SectionId> = {
  "/": "overview",
  "/resumen": "overview",
  "/ingreso": "intake",
  "/actividad": "activity",
  "/simulador": "simulator",
};

const PAGE_TITLE: Record<SectionId, string> = {
  overview: "Centro de coordinación",
  intake: "Registrar ingreso",
  activity: "Actividad reciente",
  simulator: "Simulador",
};

function sectionForPath(pathname: string): SectionId {
  return SECTION_BY_ROUTE[pathname] ?? "overview";
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    pulse: <><path d="M2 12h4l2.2-6 4 12 2.3-6H22" /><path d="M4 4.5A9 9 0 0 1 18.8 3" opacity=".5" /></>,
    overview: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    intake: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 17v3h14v-3" /></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.3 8.5-8 10-4.7-1.5-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    hospital: <><path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" /><path d="M9 21v-4h6v4M12 7v6M9 10h6M8 15h.01M16 15h.01" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    spark: <><path d="m12 3 1.4 6.6L20 12l-6.6 1.4L12 20l-1.4-6.6L4 12l6.6-2.4L12 3Z" /><path d="m19 3 .6 2.4L22 6l-2.4.6L19 9l-.6-2.4L16 6l2.4-.6L19 3Z" /></>,
    network: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="m7 11 10-4M7 13l10 4" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function levelLabel(level: AlertLevel) {
  if (level === "prioritaria") return "Prioridad administrativa";
  if (level === "informativa") return "Aviso administrativo";
  return "Revisión administrativa";
}

function notificationLabel(notification: NotificationResult) {
  switch (notification.status) {
    case "sent": return "Enviada";
    case "failed": return "No se pudo enviar";
    case "not_configured": return "Canal sin configurar";
    case "simulated": return notification.channel === "log" ? "Simulada en servidor" : "Solo simulada";
    default: return "Sin confirmación";
  }
}

function notificationTone(notification: NotificationResult) {
  if (notification.status === "sent") return "good";
  if (notification.status === "failed") return "bad";
  return "quiet";
}

function channelLabel(channel: string) {
  if (channel.toLowerCase() === "log") return "Registro del backend";
  if (channel.toLowerCase() === "slack") return "Slack";
  if (channel.toLowerCase() === "demo local") return "Demo local";
  return channel;
}

function verdictLabel(verdict: AdministrativeVerdict) {
  switch (verdict) {
    case "VALIDA": return "Válida";
    case "VALIDA_CON_ALERTAS": return "Válida con alertas";
    case "NO_VALIDA": return "No vigente";
    case "NO_ENCONTRADO": return "No encontrado";
    default: return "Pendiente";
  }
}

function preexistingLabel(preexisting: AgentResponse["preexisting"]) {
  if (preexisting.match === true) return "Relación para revisar";
  if (preexisting.match === false) return "Sin relación identificada";
  return /\bpendiente\b/i.test(preexisting.explanation) ? "Revisión pendiente" : "Sin datos para comparar";
}

function jevRelationLabel(relation: JevRelation) {
  switch (relation) {
    case "DIRECTA": return "Relación directa sugerida";
    case "POSIBLE": return "Posible relación · revisar";
    case "NINGUNA": return "Sin relación sugerida";
    default: return "Revisión humana · señal insuficiente";
  }
}

function formatDate(value?: string) {
  if (!value) return "Fecha no disponible";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : new Intl.DateTimeFormat("es-PA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function mergeHistory(primary: AgentResponse[], secondary: AgentResponse[]) {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((entry) => {
    if (seen.has(entry.event_id)) return false;
    seen.add(entry.event_id);
    return true;
  }).sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? "") || 0;
    const rightTime = Date.parse(right.created_at ?? "") || 0;
    return rightTime - leftTime;
  }).slice(0, 10);
}

function CaseOption({
  demoCase,
  selected,
  onSelect,
  index,
}: {
  demoCase: DemoCase;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <label className={`caseOption${selected ? " selected" : ""}`}>
      <input type="radio" name="demo-case" checked={selected} onChange={onSelect} />
      <span className="caseNumber">{String(index + 1).padStart(2, "0")}</span>
      <span className="caseCopy">
        <strong>{demoCase.label}</strong>
        <small>{demoCase.caption}</small>
      </span>
      <span className="radioMark" aria-hidden="true"><span /></span>
    </label>
  );
}

function ResultPanel({ result, pending, emptyDescription, simulator = false }: { result: AgentResponse | null; pending: boolean; emptyDescription: string; simulator?: boolean }) {
  if (pending) {
    return (
      <section className="glassPanel resultPanel" aria-live="polite" aria-busy="true">
        <PanelHeading eyebrow="ANÁLISIS EN CURSO" title="Procesando el ingreso" />
        <div className="processingState">
          <div className="radar"><span /><span /><span /><i /></div>
          <p>Consultando el servicio y preparando la respuesta administrativa.</p>
          <div className="processingSteps"><span className="stepDone">Ingreso recibido</span><span className="stepLive">Verificación</span><span>Notificaciones</span></div>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="glassPanel resultPanel emptyResult">
        <PanelHeading eyebrow="RESPUESTA DE VIGILIA" title="Resultado administrativo" />
        <div className="emptySignal" aria-hidden="true"><span /><Icon name="pulse" size={25} /></div>
        <h3>Esperando un ingreso</h3>
        <p>{emptyDescription}</p>
        <div className="emptyFlow"><span>Evento</span><Icon name="arrow" size={14} /><span>Revisión</span><Icon name="arrow" size={14} /><span>{simulator ? "2 avisos" : "Seguimiento"}</span></div>
      </section>
    );
  }

  return (
    <section className="glassPanel resultPanel" aria-live="polite">
      <div className="resultTop">
        <PanelHeading eyebrow="RESPUESTA DE VIGILIA" title="Resultado administrativo" />
        <div className="resultBadgeStack">
          <span className="verdictTag resultVerdict" title={`Veredicto: ${result.verdict}`}>{verdictLabel(result.verdict)}</span>
          <span className={`levelPill ${result.administrative_level}`}><span className="levelDot" />{levelLabel(result.administrative_level)}</span>
        </div>
      </div>
      <p className="resultSummary">{result.summary}</p>
      <div className="eventReference"><span>REFERENCIA DEL EVENTO</span><code>{result.event_id}</code></div>
      <div className="verificationGrid">
        <div className="verificationTile">
          <div className="tileTop"><Icon name="shield" size={16} /><span>Estado de póliza</span></div>
          <strong>{result.policy.status}</strong>
          <p>{result.policy.explanation}{result.policy.number ? ` · Póliza ${result.policy.number}` : ""}</p>
        </div>
          <div className="verificationTile">
            <div className="tileTop"><Icon name="overview" size={16} /><span>Preexistencias</span></div>
            <strong>{preexistingLabel(result.preexisting)}</strong>
            <p>{result.preexisting.explanation}</p>
            {result.classifications.length > 0 && (
              <ul className="classificationList" aria-label="Clasificación por antecedente">
                {result.classifications.map((classification) => (
                  <li key={classification.condition}>
                    <div className="classificationLine"><strong>{classification.condition}</strong><span>{classificationLabel(classification)}</span></div>
                    <p>{classification.explanation}</p>
                    <small>
                      {classification.source === "backend"
                        ? "Backend · revisión humana"
                        : classification.relation === "PENDIENTE"
                          ? `${classification.source === "kev" ? "Kev" : classification.source === "groq" ? "Groq" : "Jev"} sin clasificación confirmada · revisión humana`
                          : `${classification.source === "kev" ? "Kev" : classification.source === "groq" ? "Groq" : "Jev"} · sugerencia · revisión humana`}
                      {classification.probability === null ? "" : ` · Probabilidad: ${Math.round(classification.probability * 100)}%`}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </div>
      </div>
      <div className="messageSection">
        <div className="sectionDivider"><span>AVISOS A DESTINATARIOS</span><span className="recipientCount">2 destinatarios</span></div>
        <NotificationCard title="Admisiones del hospital" notification={result.notifications.admissions} message={result.messages.admissions} icon="hospital" simulator={simulator} />
        <NotificationCard title="Gestor de casos" notification={result.notifications.case_manager} message={result.messages.case_manager} icon="bell" simulator={simulator} />
      </div>
      <div className="administrativeNotice"><Icon name="shield" size={16} /><p>Esta señal es administrativa. No reemplaza el criterio clínico ni debe retrasar la atención del paciente.</p></div>
    </section>
  );
}

function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="panelHeading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>;
}

function NotificationCard({ title, notification, message, icon, simulator = false }: { title: string; notification: NotificationResult; message: string; icon: IconName; simulator?: boolean }) {
  const statusText = notification.status === "simulated" && !simulator ? "Sin entrega externa" : notificationLabel(notification);
  const channelText = !simulator && notification.channel.toLowerCase() === "log" ? "Canal interno" : channelLabel(notification.channel);
  return (
    <article className="notificationCard">
      <div className="notificationIcon"><Icon name={icon} size={16} /></div>
      <div className="notificationCopy"><div className="notificationName"><strong>{title}</strong><span>{channelText}</span></div><p>{message}</p></div>
      <span className={`deliveryStatus ${notificationTone(notification)}`}><i />{statusText}</span>
    </article>
  );
}

function ActivityPanel({ entries, error, loading, activeEventId, highlightedEventId, onRefresh, onSelect }: { entries: AgentResponse[]; error: string; loading: boolean; activeEventId: string; highlightedEventId: string; onRefresh: () => void; onSelect: (entry: AgentResponse, trigger: HTMLButtonElement) => void }) {
  return (
    <section className="glassPanel activityPanel" id="activity" aria-live="polite" aria-busy={loading} aria-label="Historial de ingresos">
      <div className="activityHeading">
        <div>
          <PanelHeading eyebrow="REGISTRO DE EVENTOS" title="Actividad reciente" />
          <p>{isBackendConfigured ? "Registros recibidos por el servicio de Vigilia." : "El historial aparecerá cuando haya una conexión activa."}</p>
        </div>
        <div className="activityActions">
          <span className="activityCount">{entries.length} de 10</span>
          {isBackendConfigured && <button className="historyRefresh" type="button" onClick={onRefresh} disabled={loading}><Icon name="refresh" size={13} />{loading ? "Actualizando…" : "Actualizar"}</button>}
        </div>
      </div>
      {error && <p className="activityError" role="alert">{error}</p>}
      {entries.length > 0 ? (
        <ul className="activityList">
          {entries.map((entry) => (
            <li className={`activityRow${entry.event_id === activeEventId ? " selected" : ""}${entry.event_id === highlightedEventId ? " isNew" : ""}`} key={entry.event_id}>
              <button className="activitySelect" type="button" aria-label={`Ver detalle de ${entry.event_id}`} aria-pressed={entry.event_id === activeEventId} onClick={(event) => onSelect(entry, event.currentTarget)}>
                <span className="activityIdentity"><strong>{entry.event_id}</strong><span>{formatDate(entry.created_at)}</span></span>
                <span className="activityBadges"><span className="verdictTag">{verdictLabel(entry.verdict)}</span><span className={`activityLevel ${entry.administrative_level}`}>{levelLabel(entry.administrative_level)}</span></span>
                <span className="activityOpen">Ver detalle <Icon name="arrow" size={13} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="activityEmpty"><span className="hintDot" /><span>{error ? "No se pudo cargar la actividad." : loading ? "Consultando los ingresos recientes…" : isBackendConfigured ? "Todavía no hay ingresos registrados." : "El historial no está disponible sin conexión al servicio."}</span></div>
      )}
    </section>
  );
}

function ActivityDetailsSheet({ entry, onClose, returnFocusRef }: { entry: AgentResponse; onClose: () => void; returnFocusRef: { current: HTMLButtonElement | null } }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const lifecycleRef = useRef(0);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => {
        if (lifecycleRef.current !== lifecycle) return;
        const trigger = returnFocusRef.current;
        if (trigger?.isConnected) trigger.focus();
      });
    };
  }, [entry.event_id, returnFocusRef]);

  return (
    <div className="activitySheetBackdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="activitySheet" role="dialog" aria-modal="true" aria-labelledby="activity-detail-title" ref={dialogRef} tabIndex={-1}>
        <header className="activitySheetHeader">
          <div>
            <span className="eyebrow">DETALLE ADMINISTRATIVO</span>
            <h2 id="activity-detail-title">{entry.event_id}</h2>
            <p>{formatDate(entry.created_at)}</p>
          </div>
          <button ref={closeButtonRef} className="activitySheetClose" type="button" aria-label="Cerrar detalle" onClick={onClose}>×</button>
        </header>
        <div className="activitySheetBody">
          <ResultPanel result={entry} pending={false} emptyDescription="No hay más información para este ingreso." />
        </div>
      </aside>
    </div>
  );
}

function JevExperiment({
  availability,
  enabled,
  evaluation,
  pending,
  error,
  onEvaluate,
}: {
  availability: JevStatus;
  enabled: boolean;
  evaluation: JevEvaluation | null;
  pending: boolean;
  error: string;
  onEvaluate: () => void;
}) {
  const availabilityMessage = availability === "configured"
    ? "Credencial privada detectada. El primer caso sintético confirmará el acceso al modelo."
    : availability === "missing"
      ? "Agrega AI_GATEWAY_API_KEY a .env.local y reinicia pnpm dev; en Vercel también se admite OIDC. El archivo está ignorado por Git."
      : availability === "unavailable"
        ? "La ruta de prueba está disponible en pnpm dev o Vercel; Vite Preview no ejecuta funciones API."
        : "Comprobando el entorno privado de Jev…";

  return (
    <section className="jevExperiment" aria-live="polite" aria-busy={pending}>
      <div className="jevExperimentHead">
        <div>
          <span className="eyebrow">EXPERIMENTO · DATOS SINTÉTICOS</span>
          <h3>Probar clasificación Jev</h3>
          <p>{availabilityMessage}</p>
        </div>
        <span className={`jevState ${availability}`}><i />{availability === "configured" ? "Credencial lista" : availability === "missing" ? "Falta la clave" : availability === "unavailable" ? "Ruta no disponible" : "Comprobando"}</span>
      </div>
      <div className="jevExperimentAction">
        <span>{enabled ? "Solo se envía el identificador de este caso de prueba; el servidor toma sus datos ficticios." : "Este escenario no tiene antecedentes sintéticos para comparar."}</span>
        <button className="secondaryButton" type="button" onClick={onEvaluate} disabled={!enabled || availability !== "configured" || pending}>
          {pending ? <><span className="buttonSpinner" />Consultando…</> : <>Evaluar con Jev <Icon name="spark" size={15} /></>}
        </button>
      </div>
      {error && <p className="jevError" role="alert">{error}</p>}
      {evaluation && (
        <div className="jevSuggestions">
          {evaluation.suggestions.map((suggestion) => (
            <div className="jevSuggestion" key={suggestion.condition}>
              <strong>{suggestion.condition}</strong>
              <span>{jevRelationLabel(suggestion.relation)}</span>
              <small>{suggestion.probability === null ? "Sin probabilidad válida" : `Probabilidad asignada: ${Math.round(suggestion.probability * 100)}%`}</small>
            </div>
          ))}
          <p className="jevDisclaimer">{evaluation.note} La probabilidad del modelo no es una tasa de acierto.</p>
          <details className="jevRoutingAudit">
            <summary>{evaluation.routingAudit?.noTrainingRequested ? "Filtro No Training indicado por AI Gateway" : "Ruta de privacidad no verificada"}</summary>
            {evaluation.routingAudit?.finalProvider && <span>Proveedor: {evaluation.routingAudit.finalProvider}</span>}
            {evaluation.routingAudit?.planningReasoning && <p>{evaluation.routingAudit.planningReasoning}</p>}
            {!evaluation.routingAudit?.planningReasoning && <p>La respuesta no incluyó metadatos de enrutamiento suficientes para confirmar la política.</p>}
          </details>
        </div>
      )}
    </section>
  );
}

type LiveIngressDraft = Pick<IngressEvent, "cedula" | "hospital" | "motivo_ingreso" | "triage"> & { fecha_ingreso: string };

function localDateTimeValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function LiveIntakePage({
  available,
  statusMessage,
  result,
  pending,
  error,
  onSubmit,
}: {
  available: boolean;
  statusMessage: string;
  result: AgentResponse | null;
  pending: boolean;
  error: string;
  onSubmit: (draft: LiveIngressDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<LiveIngressDraft>(() => ({ cedula: "", hospital: "", motivo_ingreso: "", triage: undefined, fecha_ingreso: localDateTimeValue() }));
  const [authorized, setAuthorized] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || pending || !authorized) return;
    await onSubmit({ ...draft, cedula: draft.cedula.trim(), hospital: draft.hospital.trim(), motivo_ingreso: draft.motivo_ingreso.trim() });
  }

  return (
    <div className="pageStack">
      <header className="pageIntro">
        <span className="eyebrow">COORDINACIÓN DE INGRESOS</span>
        <h1>Registrar ingreso</h1>
        <p>Envía la referencia del ingreso para consultar la información administrativa y preparar el seguimiento del equipo.</p>
      </header>
      <div className="liveWorkspace">
        <form className="glassPanel liveFormPanel" onSubmit={submit}>
          <div className="formPanelHeading">
            <div><span className="eyebrow">NUEVO REGISTRO</span><h2>Detalles del ingreso</h2></div>
            <span className={`serviceState${available ? " ready" : " paused"}`}><i />{available ? "Servicio disponible" : "Registro inactivo"}</span>
          </div>
          <p className="panelIntro">Completa los datos que aparecen en el aviso del centro de atención.</p>
          <fieldset className="liveFields" disabled={pending}>
            <label className="liveField"><span>Identificación del asegurado</span><input autoComplete="off" inputMode="text" maxLength={20} required value={draft.cedula} onChange={(event) => setDraft({ ...draft, cedula: event.target.value })} placeholder="Número de identificación" /></label>
            <label className="liveField"><span>Centro de atención</span><input autoComplete="organization" maxLength={80} required value={draft.hospital} onChange={(event) => setDraft({ ...draft, hospital: event.target.value })} placeholder="Nombre del centro" /></label>
            <label className="liveField liveFieldWide"><span>Motivo del ingreso</span><textarea autoComplete="off" maxLength={300} minLength={3} required rows={4} value={draft.motivo_ingreso} onChange={(event) => setDraft({ ...draft, motivo_ingreso: event.target.value })} placeholder="Descripción recibida por admisiones" /></label>
            <label className="liveField"><span>Nivel de triage <small>Opcional</small></span><select value={draft.triage ?? ""} onChange={(event) => setDraft({ ...draft, triage: event.target.value ? Number(event.target.value) : undefined })}><option value="">Sin clasificación</option><option value="1">1 · Atención inmediata</option><option value="2">2 · Muy urgente</option><option value="3">3 · Urgente</option><option value="4">4 · Menos urgente</option><option value="5">5 · No urgente</option></select></label>
            <label className="liveField"><span>Fecha y hora de ingreso</span><input type="datetime-local" required value={draft.fecha_ingreso} onChange={(event) => setDraft({ ...draft, fecha_ingreso: event.target.value })} /></label>
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

function SimulatorPage({
  selectedCase,
  result,
  pending,
  error,
  jevStatus,
  jevEvaluation,
  jevPending,
  jevError,
  onSelect,
  onSubmit,
  onEvaluate,
}: {
  selectedCase: DemoCase | null;
  result: AgentResponse | null;
  pending: boolean;
  error: string;
  jevStatus: JevStatus;
  jevEvaluation: JevEvaluation | null;
  jevPending: boolean;
  jevError: string;
  onSelect: (id: string) => void;
  onSubmit: () => void;
  onEvaluate: () => void;
}) {
  return (
    <div className="pageStack simulatorPage">
      <header className="pageIntro">
        <span className="eyebrow">ÁREA DE PRUEBAS · HACKIATHON · RETO 04</span>
        <h1>Simulador</h1>
        <p>Recorre casos sintéticos y compara integraciones experimentales en un espacio separado del flujo operativo.</p>
      </header>
      <aside className="simulatorSafety" role="note"><Icon name="shield" size={18} /><div><strong>Usa únicamente datos ficticios</strong><p>No introduzcas información de pacientes. Los resultados no son clínicos, no determinan cobertura y requieren revisión humana.</p></div></aside>
      <div className="simulatorLayout">
        <section className="glassPanel simulatorCases">
          <div className="formPanelHeading"><div><span className="eyebrow">ESCENARIOS</span><h2>Selecciona un caso de prueba</h2></div><span className="simulatorTag">DATOS SINTÉTICOS</span></div>
          <p className="panelIntro">Cada escenario contiene una referencia ficticia y un resultado esperado para probar el flujo.</p>
          <fieldset className="caseFieldset" disabled={pending}><legend className="srOnly">Escenario de prueba</legend>{demoCases.map((demoCase, index) => <CaseOption key={demoCase.id} demoCase={demoCase} selected={selectedCase?.id === demoCase.id} onSelect={() => onSelect(demoCase.id)} index={index} />)}</fieldset>
          {selectedCase && <div className="eventPreview" key={selectedCase.id} aria-live="polite"><div className="previewHead"><span className="eyebrow">REFERENCIA FICTICIA</span><span className="previewId">{selectedCase.id}</span></div><div className="previewGrid"><div><span>Centro de atención</span><strong>{selectedCase.hospitalName}</strong></div><div><span>Identificación</span><strong>{selectedCase.insuredId}</strong></div><div className="previewWide"><span>Motivo</span><strong>{selectedCase.reason}</strong></div>{selectedCase.preexistingConditions.length > 0 && <div className="previewWide"><span>Antecedentes ficticios</span><strong>{selectedCase.preexistingConditions.join(" · ")}</strong></div>}</div></div>}
          <JevExperiment availability={jevStatus} enabled={Boolean(selectedCase?.preexistingConditions.length)} evaluation={jevEvaluation} pending={jevPending} error={jevError} onEvaluate={onEvaluate} />
          {error && <div className="errorBanner" role="alert"><span className="errorMark">!</span><div><strong>No se pudo ejecutar el escenario</strong><p>{error}</p><small>El evento no se reenvió automáticamente.</small></div></div>}
          <div className="simulatorAction"><p>El caso se envía al backend cuando está configurado; de lo contrario, se procesa solo en este navegador.</p><button className="primaryButton" type="button" onClick={onSubmit} disabled={!selectedCase || pending}>{pending ? <><span className="buttonSpinner" />Procesando…</> : <>Ejecutar escenario <Icon name="arrow" size={16} /></>}</button></div>
        </section>
        <div className="simulatorResult"><ResultPanel result={result} pending={pending} simulator emptyDescription="Selecciona un escenario para ver la respuesta y el estado de sus avisos." /></div>
      </div>
      <section className="simulatorLimits">
        <div className="limitsIntro"><span className="eyebrow">ESTADO DE VALIDACIÓN</span><h2>Integraciones aún no aprobadas para datos reales</h2><p>Esta aplicación conserva el contexto técnico y los límites que deben revisarse antes de activar un flujo real.</p></div>
        <div className="limitGrid">
          <article><span>01 · Persistencia</span><h3>Registros de muestra</h3><p>El backend actual inicializa SQLite con asegurados, pólizas y antecedentes ficticios; no es una base de clientes ni garantiza persistencia en un despliegue serverless.</p></article>
          <article><span>02 · Acceso</span><h3>Permisos del servicio</h3><p>La clave opcional del backend no reemplaza autenticación de usuarios, roles, auditoría y autorización comprobada desde el servidor.</p></article>
          <article><span>03 · IA y avisos</span><h3>Revisión humana</h3><p>Kev, Groq y Jev producen sugerencias por validar. Los avisos de canal interno o de prueba no confirman una entrega externa.</p></article>
        </div>
        <p className="featureGateNote"><code>VITE_LIVE_INGRESS_ENABLED</code> solo controla la interfaz; no protege la API. El backend debe aplicar sus propias reglas antes de tratar datos reales.</p>
      </section>
    </div>
  );
}

function isSyntheticEntry(entry: AgentResponse) {
  return /^(?:ING-DEMO-|VIG-DEMO-|TEST-|SYNTHETIC-)/i.test(entry.event_id);
}

function clientEntries(entries: AgentResponse[]) {
  return entries.filter((entry) => !isSyntheticEntry(entry));
}

function formatCount(value: number) {
  return new Intl.NumberFormat("es-PA").format(value);
}

function MetricCount({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const displayValueRef = useRef(0);

  useEffect(() => {
    const startedAt = performance.now();
    const duration = 560;
    const startingValue = displayValueRef.current;
    const difference = value - startingValue;
    let frame = 0;

    function step(now: number) {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = Math.round(startingValue + difference * eased);
      displayValueRef.current = nextValue;
      setDisplayValue(nextValue);
      if (progress < 1) frame = window.requestAnimationFrame(step);
    }

    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return <strong aria-label={formatCount(value)}>{formatCount(displayValue)}</strong>;
}

const liveIngressEnabled = import.meta.env.VITE_LIVE_INGRESS_ENABLED === "true";

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(() => sectionForPath(window.location.pathname));
  const [history, setHistory] = useState<AgentResponse[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(isBackendConfigured);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(isBackendConfigured ? "checking" : "local");
  const [liveResult, setLiveResult] = useState<AgentResponse | null>(null);
  const [livePending, setLivePending] = useState(false);
  const [liveError, setLiveError] = useState("");
  const [selectedId, setSelectedId] = useState(demoCases[0]?.id ?? "");
  const [demoResult, setDemoResult] = useState<AgentResponse | null>(null);
  const [demoPending, setDemoPending] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [jevStatus, setJevStatus] = useState<JevStatus>("checking");
  const [jevEvaluation, setJevEvaluation] = useState<JevEvaluation | null>(null);
  const [jevPending, setJevPending] = useState(false);
  const [jevError, setJevError] = useState("");
  const [selectedActivity, setSelectedActivity] = useState<AgentResponse | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState("");
  const activityReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const jevRequestControllerRef = useRef<AbortController | null>(null);
  const jevRequestIdRef = useRef(0);
  const selectedCase = demoCases.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    const syncRoute = () => {
      const currentPath = window.location.pathname;
      const nextSection = SECTION_BY_ROUTE[currentPath];
      if (!nextSection) {
        window.history.replaceState(null, "", ROUTE_BY_SECTION.overview);
        setActiveSection("overview");
      } else {
        if (currentPath === "/") window.history.replaceState(null, "", ROUTE_BY_SECTION.overview);
        setActiveSection(nextSection);
      }
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    syncRoute();
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    document.title = PAGE_TITLE[activeSection] + " · Vigilia";
  }, [activeSection]);

  useEffect(() => {
    setSelectedActivity(null);
  }, [activeSection]);

  useEffect(() => {
    if (!highlightedEventId) return;
    const timeout = window.setTimeout(() => setHighlightedEventId(""), 1900);
    return () => window.clearTimeout(timeout);
  }, [highlightedEventId]);

  useEffect(() => {
    if (activeSection !== "simulator") return;
    let cancelled = false;
    const controller = new AbortController();
    setJevStatus("checking");
    loadJevStatus(controller.signal)
      .then((status) => { if (!cancelled) setJevStatus(status.configured ? "configured" : "missing"); })
      .catch(() => { if (!cancelled && !controller.signal.aborted) setJevStatus("unavailable"); });
    return () => { cancelled = true; controller.abort(); };
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === "simulator") return;
    jevRequestIdRef.current += 1;
    jevRequestControllerRef.current?.abort();
    jevRequestControllerRef.current = null;
    setJevPending(false);
  }, [activeSection]);

  useEffect(() => () => jevRequestControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!isBackendConfigured) return;
    let cancelled = false;
    Promise.allSettled([checkBackendHealth(), loadIngressHistory()]).then(([healthResult, historyResult]) => {
      if (cancelled) return;
      const healthOnline = healthResult.status === "fulfilled" && healthResult.value;
      setBackendStatus(healthOnline || historyResult.status === "fulfilled" ? "online" : "offline");
      if (historyResult.status === "fulfilled") {
        setHistory(clientEntries(historyResult.value));
        setHistoryError("");
      } else {
        const reason = historyResult.reason;
        setHistoryError(reason instanceof Error ? reason.message : "No se pudo consultar la actividad.");
      }
      setHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  function navigateToPath(path: string) {
    const nextSection = SECTION_BY_ROUTE[path];
    if (!nextSection) return;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setActiveSection(nextSection);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshHistory() {
    if (!isBackendConfigured) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const entries = clientEntries(await loadIngressHistory());
      setBackendStatus("online");
      setHistory(entries);
    } catch (loadError) {
      if (loadError instanceof BackendConnectionError) setBackendStatus("offline");
      setHistoryError(loadError instanceof Error ? loadError.message : "No se pudo consultar la actividad.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function selectDemoCase(id: string) {
    jevRequestIdRef.current += 1;
    jevRequestControllerRef.current?.abort();
    jevRequestControllerRef.current = null;
    setJevPending(false);
    setSelectedId(id);
    setDemoResult(null);
    setDemoError("");
    setJevEvaluation(null);
    setJevError("");
  }

  async function runJevEvaluation() {
    if (!selectedCase || selectedCase.preexistingConditions.length === 0 || jevPending) return;
    const requestId = ++jevRequestIdRef.current;
    const controller = new AbortController();
    jevRequestControllerRef.current = controller;
    setJevPending(true);
    setJevError("");
    setJevEvaluation(null);
    try {
      const result = await evaluateJevCase(selectedCase.id, controller.signal);
      if (requestId === jevRequestIdRef.current) setJevEvaluation(result);
    } catch (evaluationError) {
      if (controller.signal.aborted || requestId !== jevRequestIdRef.current) return;
      const message = evaluationError instanceof Error ? evaluationError.message : "No se pudo completar la evaluación.";
      setJevError(message);
    } finally {
      if (requestId === jevRequestIdRef.current) {
        setJevPending(false);
        jevRequestControllerRef.current = null;
      }
    }
  }

  async function runDemoScenario() {
    if (!selectedCase || demoPending) return;
    setDemoPending(true);
    setDemoError("");
    setDemoResult(null);
    try {
      const response = await processDemoIngress(makeDemoEvent(selectedCase), selectedCase);
      setDemoResult(response);
    } catch (submitError) {
      setDemoError(submitError instanceof Error ? submitError.message : "No se pudo ejecutar el escenario.");
    } finally {
      setDemoPending(false);
    }
  }

  async function submitLiveIngress(draft: LiveIngressDraft) {
    if (!isBackendConfigured || backendStatus !== "online" || !liveIngressEnabled || livePending) return;
    setLivePending(true);
    setLiveError("");
    setLiveResult(null);
    const generatedId = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
    const event: IngressEvent = {
      evento_id: "ING-" + generatedId.replace(/-/g, "").slice(0, 32).toUpperCase(),
      cedula: draft.cedula,
      hospital: draft.hospital,
      motivo_ingreso: draft.motivo_ingreso,
      ...(draft.triage === undefined ? {} : { triage: draft.triage }),
      fecha_ingreso: new Date(draft.fecha_ingreso).toISOString(),
    };
    try {
      const response = await processIngress(event);
      setBackendStatus("online");
      setLiveResult(response);
      setHistory((current) => clientEntries(mergeHistory([response], current)));
      setHighlightedEventId(response.event_id);
    } catch (submitError) {
      if (submitError instanceof BackendConnectionError) setBackendStatus("offline");
      setLiveError(submitError instanceof Error ? submitError.message : "No se pudo registrar el ingreso.");
    } finally {
      setLivePending(false);
    }
  }

  function selectHistoryEntry(entry: AgentResponse, trigger: HTMLButtonElement) {
    activityReturnFocusRef.current = trigger;
    setSelectedActivity(entry);
  }

  function closeActivityDetails() {
    setSelectedActivity(null);
  }

  const modeLabel = backendStatus === "local"
    ? "Conexión no configurada"
    : backendStatus === "checking"
      ? "Comprobando servicio"
      : backendStatus === "online" ? "Servicio conectado" : "Servicio no disponible";
  const modeClass = backendStatus === "online" ? "configured" : backendStatus;
  const canSubmitLive = isBackendConfigured && backendStatus === "online" && liveIngressEnabled;
  const liveStatusMessage = !isBackendConfigured
    ? "La conexión con el servicio aún no está configurada."
    : backendStatus === "checking"
      ? "Comprobando la conexión segura con el servicio…"
      : backendStatus === "offline"
        ? "No se pudo conectar con el servicio. Vuelve a intentarlo más tarde."
        : !liveIngressEnabled
          ? "El registro no está habilitado en esta instalación."
          : "Servicio conectado. Revisa la información antes de enviarla.";

  const urgentCount = history.filter((entry) => entry.administrative_level === "prioritaria").length;
  const reviewCount = history.filter((entry) => entry.verdict === "VALIDA_CON_ALERTAS" || entry.verdict === "NO_ENCONTRADO" || entry.verdict === "PENDIENTE").length;
  const metricsReady = backendStatus === "online" && !historyLoading && !historyError;
  const metricUnavailable = historyLoading
    ? "Consultando el servicio…"
    : backendStatus === "local"
      ? "Se mostrará al conectar el servicio"
      : "No disponible con la conexión actual";

  return (
    <div className="appFrame clientAppFrame">
      <a className="skipLink" href="#main">Saltar al contenido</a>
      <div className="ambient ambientOne" aria-hidden="true" />
      <div className="ambient ambientTwo" aria-hidden="true" />
      <div className="mobileCardNav">
        <CardNav activeSection={activeSection === "simulator" ? "overview" : activeSection} status={modeLabel} statusTone={modeClass} onNavigate={navigateToPath} />
      </div>

      <main id="main" className="mainArea clientMainArea">
        <header className="topbar glassSurface clientTopbar">
          <a className="clientWordmark" href="/resumen" onClick={(event) => { event.preventDefault(); navigateToPath("/resumen"); }} aria-label="Vigilia, centro de coordinación">
            <span className="clientWordmarkIcon"><Icon name="pulse" size={17} /></span>
            <span><strong>Vigilia</strong><small>Coordinación de ingresos</small></span>
          </a>
          <div className="topbarRight"><span className={"modeBadge " + modeClass}><i />{modeLabel}</span></div>
        </header>

        <div key={activeSection} className={`routeView routeView-${activeSection}`}>
        {activeSection === "overview" && (
          <div className="clientPageStack">
            <section className="clientHero">
              <div className="clientHeroCopy">
                <span className="clientEyebrow"><span className="pulseMark" />COORDINACIÓN DE INGRESOS</span>
                <h1>Cada ingreso, <em>bien coordinado.</em></h1>
                <p>Consulta la información administrativa del ingreso y facilita el seguimiento entre el centro de atención y el equipo de casos.</p>
                <div className="clientHeroActions">
                  <button className="primaryButton" type="button" onClick={() => navigateToPath("/ingreso")}>Registrar ingreso <Icon name="arrow" size={16} /></button>
                  <button className="secondaryButton" type="button" onClick={() => navigateToPath("/actividad")}>Ver actividad reciente</button>
                </div>
                <div className="clientPrinciple"><Icon name="shield" size={17} /><p>La verificación es administrativa. El equipo clínico conserva el criterio asistencial y la atención no debe retrasarse.</p></div>
              </div>
              <div className="clientFlowCard glassPanel">
                <div className="clientFlowHeading"><span className="eyebrow">FLUJO DE COORDINACIÓN</span><span className={`flowLiveBadge ${modeClass}`}><i />{backendStatus === "online" ? "Conectado" : backendStatus === "checking" ? "Verificando" : backendStatus === "offline" ? "Sin conexión" : "Sin configurar"}</span></div>
                <div className="clientFlowSteps">
                  <div><span className="clientFlowIcon"><Icon name="hospital" size={19} /></span><strong>Centro de atención</strong><small>Registra el ingreso</small></div>
                  <span className="clientFlowConnector" aria-hidden="true"><svg viewBox="0 0 100 24" preserveAspectRatio="none" focusable="false"><path id="flow-link-intake-review" className="flowLinkBase" d="M0 12H38L47 4L54 20L63 12H100" /><circle className="flowLinkSpark" r="2.2"><animateMotion dur="2.8s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.42;1"><mpath href="#flow-link-intake-review" /></animateMotion><animate attributeName="opacity" dur="2.8s" values="0;1;1;0;0" keyTimes="0;0.02;0.4;0.44;1" repeatCount="indefinite" /></circle></svg></span>
                  <div><span className="clientFlowIcon"><Icon name="shield" size={19} /></span><strong>Revisión administrativa</strong><small>Consulta la información</small></div>
                  <span className="clientFlowConnector" aria-hidden="true"><svg viewBox="0 0 100 24" preserveAspectRatio="none" focusable="false"><path id="flow-link-review-followup" className="flowLinkBase" d="M0 12H38L47 4L54 20L63 12H100" /><circle className="flowLinkSpark" r="2.2"><animateMotion dur="2.8s" begin="1.4s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.42;1"><mpath href="#flow-link-review-followup" /></animateMotion><animate attributeName="opacity" dur="2.8s" begin="1.4s" values="0;1;1;0;0" keyTimes="0;0.02;0.4;0.44;1" repeatCount="indefinite" /></circle></svg></span>
                  <div><span className="clientFlowIcon"><Icon name="bell" size={19} /></span><strong>Seguimiento</strong><small>Coordina los avisos</small></div>
                </div>
                <div className="clientFlowNote">Las sugerencias automatizadas requieren revisión del equipo responsable.</div>
              </div>
            </section>

            <section className="clientMetrics" aria-label="Resumen de actividad">
              <article className="clientMetric"><span>Ingresos recientes consultados</span>{metricsReady ? <MetricCount value={history.length} /> : <strong>—</strong>}<small>{metricsReady ? "Registros disponibles en el servicio" : metricUnavailable}</small></article>
              <article className="clientMetric"><span>Requieren seguimiento</span>{metricsReady ? <MetricCount value={reviewCount} /> : <strong>—</strong>}<small>{metricsReady ? "Alertas o datos por verificar" : metricUnavailable}</small></article>
              <article className="clientMetric"><span>Prioridad administrativa</span>{metricsReady ? <MetricCount value={urgentCount} /> : <strong>—</strong>}<small>{metricsReady ? "Dentro de los registros consultados" : metricUnavailable}</small></article>
            </section>

            <section className="clientSectionHeading"><div><span className="eyebrow">SEGUIMIENTO</span><h2>Actividad reciente</h2><p>Consulta los ingresos recibidos por el servicio y abre su detalle administrativo.</p></div><button className="textAction" type="button" onClick={() => navigateToPath("/actividad")}>Ver historial <Icon name="arrow" size={15} /></button></section>
            <ActivityPanel entries={history.slice(0, 5)} error={historyError} loading={historyLoading} activeEventId={selectedActivity?.event_id ?? liveResult?.event_id ?? ""} highlightedEventId={highlightedEventId} onRefresh={refreshHistory} onSelect={selectHistoryEntry} />
          </div>
        )}

        {activeSection === "intake" && (
          <LiveIntakePage available={canSubmitLive} statusMessage={liveStatusMessage} result={liveResult} pending={livePending} error={liveError} onSubmit={submitLiveIngress} />
        )}

        {activeSection === "activity" && (
          <div className="clientPageStack">
            <header className="pageIntro clientPageIntro"><span className="eyebrow">SEGUIMIENTO DE INGRESOS</span><h1>Actividad reciente</h1><p>Revisa las respuestas administrativas que el servicio ha recibido y consulta su detalle.</p></header>
            <ActivityPanel entries={history} error={historyError} loading={historyLoading} activeEventId={selectedActivity?.event_id ?? liveResult?.event_id ?? ""} highlightedEventId={highlightedEventId} onRefresh={refreshHistory} onSelect={selectHistoryEntry} />
          </div>
        )}

        {activeSection === "simulator" && (
          <SimulatorPage selectedCase={selectedCase} result={demoResult} pending={demoPending} error={demoError} jevStatus={jevStatus} jevEvaluation={jevEvaluation} jevPending={jevPending} jevError={jevError} onSelect={selectDemoCase} onSubmit={runDemoScenario} onEvaluate={runJevEvaluation} />
        )}
        </div>

        {selectedActivity && <ActivityDetailsSheet entry={selectedActivity} onClose={closeActivityDetails} returnFocusRef={activityReturnFocusRef} />}

        <footer className="pageFooter clientFooter">
          <span className="footerBrand">Vigilia</span>
          <span>Coordinación administrativa de ingresos</span>
          <button className="footerSimulator" type="button" onClick={() => navigateToPath("/simulador")}>Simulador <span aria-hidden="true">↗</span></button>
        </footer>
      </main>
    </div>
  );
}

export default App;
