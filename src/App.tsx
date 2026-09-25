import { useEffect, useState, type ReactNode } from "react";
import { demoCases, makeDemoEvent } from "./data/demoCases";
import { BackendConnectionError, checkBackendHealth, isBackendConfigured, loadIngressHistory, processIngress } from "./lib/agentApi";
import { evaluateJevCase, loadJevStatus } from "./lib/jevApi";
import { classificationLabel } from "./types";
import type { AdministrativeVerdict, AgentResponse, AlertLevel, DemoCase, JevEvaluation, JevRelation, NotificationResult } from "./types";

type IconName = "pulse" | "overview" | "intake" | "shield" | "clock" | "hospital" | "bell" | "arrow" | "check" | "spark" | "network" | "refresh";
type BackendStatus = "local" | "checking" | "online" | "offline";
type JevStatus = "checking" | "ready" | "missing" | "unavailable";
type SectionId = "overview" | "simulate" | "activity";

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

function ResultPanel({ result, pending }: { result: AgentResponse | null; pending: boolean }) {
  if (pending) {
    return (
      <section className="glassPanel resultPanel" aria-live="polite" aria-busy="true">
        <PanelHeading eyebrow="ANÁLISIS EN CURSO" title="Procesando el ingreso" />
        <div className="processingState">
          <div className="radar"><span /><span /><span /><i /></div>
          <p>Validando la referencia administrativa y preparando los dos avisos.</p>
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
        <p>Elige uno de los casos sintéticos para ver la validación de póliza, la revisión de antecedentes y los mensajes para ambos equipos.</p>
        <div className="emptyFlow"><span>Evento</span><Icon name="arrow" size={14} /><span>Agente</span><Icon name="arrow" size={14} /><span>2 avisos</span></div>
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
                      {classification.source === "kev"
                        ? classification.relation === "PENDIENTE"
                          ? "Kev sin clasificación confirmada · revisión humana"
                          : "Kev · sugerencia · revisión humana"
                        : classification.source === "groq"
                          ? classification.relation === "PENDIENTE"
                            ? "Groq sin clasificación confirmada · revisión humana"
                            : "Groq · sugerencia · revisión humana"
                          : "Backend · revisión humana"}
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
        <NotificationCard title="Admisiones del hospital" notification={result.notifications.admissions} message={result.messages.admissions} icon="hospital" />
        <NotificationCard title="Gestor de casos" notification={result.notifications.case_manager} message={result.messages.case_manager} icon="bell" />
      </div>
      <div className="administrativeNotice"><Icon name="shield" size={16} /><p>Esta señal es administrativa. No reemplaza el criterio clínico ni debe retrasar la atención del paciente.</p></div>
    </section>
  );
}

function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="panelHeading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>;
}

function NotificationCard({ title, notification, message, icon }: { title: string; notification: NotificationResult; message: string; icon: IconName }) {
  return (
    <article className="notificationCard">
      <div className="notificationIcon"><Icon name={icon} size={16} /></div>
      <div className="notificationCopy"><div className="notificationName"><strong>{title}</strong><span>{channelLabel(notification.channel)}</span></div><p>{message}</p></div>
      <span className={`deliveryStatus ${notificationTone(notification)}`}><i />{notificationLabel(notification)}</span>
    </article>
  );
}

function ActivityPanel({ entries, error, loading, activeEventId, onRefresh, onSelect }: { entries: AgentResponse[]; error: string; loading: boolean; activeEventId: string; onRefresh: () => void; onSelect: (entry: AgentResponse) => void }) {
  return (
    <section className="glassPanel activityPanel" id="activity" aria-live="polite" aria-busy={loading} aria-label="Historial de ingresos">
      <div className="activityHeading">
        <div>
          <PanelHeading eyebrow="REGISTRO DE EVENTOS" title="Actividad reciente" />
          <p>{isBackendConfigured ? "Últimos ingresos registrados por Vigilia." : "Resultados de esta sesión; la demo local no guarda ingresos en el backend."}</p>
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
            <li className={`activityRow${entry.event_id === activeEventId ? " selected" : ""}`} key={entry.event_id}>
              <button className="activitySelect" type="button" aria-label={`Ver detalle de ${entry.event_id}`} aria-pressed={entry.event_id === activeEventId} onClick={() => onSelect(entry)}>
                <span className="activityIdentity"><strong>{entry.event_id}</strong><span>{formatDate(entry.created_at)}</span></span>
                <span className="activityBadges"><span className="verdictTag">{verdictLabel(entry.verdict)}</span><span className={`activityLevel ${entry.administrative_level}`}>{levelLabel(entry.administrative_level)}</span></span>
                <span className="activityOpen">Ver detalle <Icon name="arrow" size={13} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="activityEmpty"><span className="hintDot" /><span>{error ? "No se pudo cargar la actividad." : loading ? "Consultando los ingresos recientes…" : isBackendConfigured ? "Todavía no hay ingresos registrados." : "Procesa un escenario para ver el registro de esta sesión."}</span></div>
      )}
    </section>
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
  const availabilityMessage = availability === "ready"
    ? "Disponible para comparar dos casos sintéticos."
    : availability === "missing"
      ? "Agrega AI_GATEWAY_API_KEY a .env.local y reinicia pnpm dev. El archivo está ignorado por Git."
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
        <span className={`jevState ${availability}`}><i />{availability === "ready" ? "Disponible" : availability === "missing" ? "Falta la clave" : availability === "unavailable" ? "Ruta local" : "Conectando"}</span>
      </div>
      <div className="jevExperimentAction">
        <span>{enabled ? "Solo se envía el identificador de este caso de prueba; el servidor toma sus datos ficticios." : "Este escenario no tiene antecedentes sintéticos para comparar."}</span>
        <button className="secondaryButton" type="button" onClick={onEvaluate} disabled={!enabled || availability !== "ready" || pending}>
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
        </div>
      )}
    </section>
  );
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<AgentResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [completedCount, setCompletedCount] = useState(0);
  const [history, setHistory] = useState<AgentResponse[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(isBackendConfigured);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(isBackendConfigured ? "checking" : "local");
  const [jevStatus, setJevStatus] = useState<JevStatus>("checking");
  const [jevEvaluation, setJevEvaluation] = useState<JevEvaluation | null>(null);
  const [jevPending, setJevPending] = useState(false);
  const [jevError, setJevError] = useState("");
  const selectedCase = demoCases.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    let cancelled = false;
    loadJevStatus()
      .then((status) => {
        if (!cancelled) setJevStatus(status.configured ? "ready" : "missing");
      })
      .catch(() => {
        if (!cancelled) setJevStatus("unavailable");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const sectionIds: SectionId[] = ["overview", "simulate", "activity"];
    const updateActiveSection = () => {
      const marker = window.scrollY + Math.min(window.innerHeight * 0.8, 720);
      let nextSection: SectionId = "overview";
      for (const sectionId of sectionIds) {
        const section = document.getElementById(sectionId);
        if (section && section.getBoundingClientRect().top + window.scrollY <= marker) {
          nextSection = sectionId;
        }
      }
      setActiveSection(nextSection);
    };

    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, []);

  async function refreshHistory() {
    if (!isBackendConfigured) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const entries = await loadIngressHistory();
      setBackendStatus("online");
      setHistory((current) => mergeHistory(current, entries));
    } catch (loadError) {
      if (loadError instanceof BackendConnectionError) setBackendStatus("offline");
      setHistoryError(loadError instanceof Error ? loadError.message : "No se pudo cargar el historial.");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (!isBackendConfigured) return;
    let cancelled = false;
    checkBackendHealth().then((online) => {
      if (!cancelled) setBackendStatus(online ? "online" : "offline");
    });
    loadIngressHistory()
      .then((entries) => {
        if (!cancelled) {
          setBackendStatus("online");
          setHistory((current) => mergeHistory(current, entries));
          setHistoryError("");
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          if (loadError instanceof BackendConnectionError) setBackendStatus("offline");
          setHistoryError(loadError instanceof Error ? loadError.message : "No se pudo cargar el historial.");
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function selectCase(id: string) {
    setSelectedId(id);
    setResult(null);
    setError("");
    setJevEvaluation(null);
    setJevError("");
  }

  async function runJevEvaluation() {
    if (!selectedCase || selectedCase.preexistingConditions.length === 0 || jevPending) return;
    setJevPending(true);
    setJevError("");
    setJevEvaluation(null);
    try {
      setJevEvaluation(await evaluateJevCase(selectedCase.id));
    } catch (evaluationError) {
      const message = evaluationError instanceof Error ? evaluationError.message : "Jev no pudo completar la evaluación.";
      setJevError(message);
      if (/AI_GATEWAY_API_KEY/.test(message)) setJevStatus("missing");
    } finally {
      setJevPending(false);
    }
  }

  async function submitIngress() {
    if (!selectedCase || pending) return;
    setPending(true);
    setError("");
    setResult(null);
    const event = makeDemoEvent(selectedCase);
    try {
      const response = await processIngress(event, selectedCase);
      if (response.source === "backend") setBackendStatus("online");
      setResult(response);
      setHistory((current) => mergeHistory([response], current));
      setCompletedCount((count) => count + 1);
    } catch (submitError) {
      if (submitError instanceof BackendConnectionError) setBackendStatus("offline");
      setError(submitError instanceof Error ? submitError.message : "No se pudo procesar el ingreso.");
    } finally {
      setPending(false);
    }
  }

  function selectHistoryEntry(entry: AgentResponse) {
    setResult(entry);
    setError("");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resultRegion = document.getElementById("result");
    resultRegion?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    resultRegion?.focus({ preventScroll: true });
  }

  const modeLabel = backendStatus === "local"
    ? "Simulación local"
    : backendStatus === "checking"
      ? "Comprobando backend"
      : backendStatus === "online" ? "Backend en línea" : "Backend no disponible";
  const modeClass = backendStatus === "local" ? "local" : backendStatus === "online" ? "configured" : backendStatus;

  return (
    <div className="appFrame">
      <a className="skipLink" href="#main">Saltar al contenido</a>
      <div className="ambient ambientOne" aria-hidden="true" />
      <div className="ambient ambientTwo" aria-hidden="true" />
      <aside className="sideRail glassSurface" aria-label="Navegación principal">
        <a className="brand" href="#overview" aria-label="Vigilia, inicio">
          <span className="brandMark"><Icon name="pulse" size={23} /></span>
          <span className="brandText"><strong>VIGILIA</strong><small>SISTEMA DE ALERTAS</small></span>
        </a>
        <span className="navLabel">OPERACIÓN</span>
        <nav className="mainNav">
          <a className={`navLink${activeSection === "overview" ? " active" : ""}`} href="#overview" aria-current={activeSection === "overview" ? "location" : undefined}><Icon name="overview" /><span>Vista general</span></a>
          <a className={`navLink${activeSection === "simulate" ? " active" : ""}`} href="#simulate" aria-current={activeSection === "simulate" ? "location" : undefined}><Icon name="intake" /><span>Simular ingreso</span></a>
          <a className={`navLink${activeSection === "activity" ? " active" : ""}`} href="#activity" aria-current={activeSection === "activity" ? "location" : undefined}><Icon name="clock" /><span>Actividad reciente</span></a>
        </nav>
        <div className="railSpacer" />
        <div className="railCallout">
          <span className="eyebrow">PRINCIPIO DE VIGILIA</span>
          <strong>La atención sigue.</strong>
          <p>La alerta ordena una revisión administrativa; nunca decide una urgencia clínica.</p>
        </div>
        <div className="railFooter"><span className="miniSignal"><i /></span><span>BillieJSON <b>·</b> Reto 04</span></div>
      </aside>

      <main id="main" className="mainArea">
        <header className="topbar glassSurface" id="overview">
          <div className="crumbs"><span>Vigilia</span><i>/</i><strong>Centro de alertas</strong></div>
          <div className="topbarRight"><span className={`modeBadge ${modeClass}`}><i />{modeLabel}</span><span className="privacyBadge"><Icon name="shield" size={14} />Datos ficticios</span></div>
        </header>

        <section className="heroBlock">
          <div className="heroCopy">
            <span className="heroEyebrow"><span className="pulseMark" />HACKIATHON · RETO 04</span>
            <h1>Una alerta clara.<br /><em>Dos equipos informados.</em></h1>
            <p>Cuando llega un ingreso a emergencias, Vigilia revisa los datos administrativos de la póliza y comparte el contexto necesario con admisiones y el gestor de casos.</p>
          </div>
          <div className="heroFlow glassPanel" aria-label="Flujo: ingreso, revisión administrativa, dos notificaciones">
            <div className="flowNode"><span className="flowIcon"><Icon name="hospital" size={17} /></span><small>INGRESO</small></div>
            <span className="flowConnector"><i /></span>
            <div className="flowNode"><span className="flowIcon agent"><Icon name="spark" size={17} /></span><small>AGENTE</small></div>
            <span className="flowConnector split"><i /></span>
            <div className="flowDestinations"><div><Icon name="hospital" size={14} /><small>Admisiones</small></div><div><Icon name="bell" size={14} /><small>Gestor</small></div></div>
          </div>
        </section>

        <div className="statsStrip" aria-label="Resumen del flujo">
          <div className="statItem"><span className="statIcon mint"><Icon name="network" size={16} /></span><div><strong>1 <small>→</small> 2</strong><span>un evento · dos destinos</span></div></div>
          <span className="statDivider" />
          <div className="statItem"><span className="statIcon blue"><Icon name="shield" size={16} /></span><div><strong>Revisión humana</strong><span>el agente señala, el equipo revisa</span></div></div>
          <span className="statDivider" />
          <div className="statItem"><span className="statIcon amber"><Icon name="clock" size={16} /></span><div><strong>{completedCount} procesados</strong><span>en esta sesión de demostración</span></div></div>
        </div>

        <div className="contentGrid">
          <section className="glassPanel intakePanel" id="simulate">
            <div className="panelHeadRow"><PanelHeading eyebrow="ENTRADA DE EMERGENCIA" title="Simular un ingreso" /><span className="demoTag">ENTORNO DE PRUEBA</span></div>
            <p className="panelIntro">Selecciona un escenario sintético para recorrer los distintos caminos administrativos del agente.</p>
            <fieldset className="caseFieldset" disabled={pending}>
              <legend className="srOnly">Escenario de prueba</legend>
              {demoCases.map((demoCase, index) => <CaseOption key={demoCase.id} demoCase={demoCase} selected={selectedId === demoCase.id} onSelect={() => selectCase(demoCase.id)} index={index} />)}
            </fieldset>

            {selectedCase ? (
              <div className="eventPreview" aria-live="polite">
                <div className="previewHead"><span className="eyebrow">DATOS SINTÉTICOS DEL EVENTO</span><span className="previewId">Cédula {selectedCase.insuredId}</span></div>
                <div className="previewGrid">
                  <div><span>Hospital</span><strong>{selectedCase.hospitalName}</strong></div>
                  <div className="previewWide"><span>Motivo reportado</span><strong>{selectedCase.reason}</strong></div>
                  {selectedCase.preexistingConditions.length > 0 && <div className="previewWide"><span>Antecedentes sintéticos</span><strong>{selectedCase.preexistingConditions.join(" · ")}</strong></div>}
                </div>
              </div>
            ) : (
              <div className="chooseHint"><span className="hintDot" /><span>Selecciona uno de los seis escenarios sintéticos para revisar el evento.</span></div>
            )}

            <JevExperiment
              availability={jevStatus}
              enabled={Boolean(selectedCase?.preexistingConditions.length)}
              evaluation={jevEvaluation}
              pending={jevPending}
              error={jevError}
              onEvaluate={runJevEvaluation}
            />

            {error && <div className="errorBanner" role="alert"><span className="errorMark">!</span><div><strong>No se pudo procesar</strong><p>{error}</p><small>El evento no se reenvió automáticamente para evitar notificaciones duplicadas.</small></div></div>}

            <div className="formFooter">
              <p><Icon name="shield" size={15} />{isBackendConfigured ? "Usa solo datos ficticios. La API puede enviar avisos a los canales Slack configurados." : "Solo usa referencias ficticias; no ingreses datos de pacientes reales."}</p>
              <button className="primaryButton" type="button" onClick={submitIngress} disabled={!selectedCase || pending}>
                {pending ? <><span className="buttonSpinner" />Procesando…</> : <>Procesar ingreso <Icon name="arrow" size={16} /></>}
              </button>
            </div>
          </section>

          <div id="result" className="resultColumn" role="region" aria-label="Detalle del ingreso seleccionado" tabIndex={-1}>
            <ResultPanel result={result} pending={pending} />
            <div className="flowFootnote"><span className="footnoteLine" /><p>{isBackendConfigured ? "El backend aplica las reglas administrativas de póliza y devuelve dos avisos con su canal y estado. La relación con antecedentes puede quedar pendiente de revisión humana." : "La demo local recorre escenarios sintéticos sin llamar al backend ni enviar avisos. Al conectar el servicio, usa solo las referencias ficticias del equipo."}</p></div>
          </div>
        </div>

        <ActivityPanel entries={history} error={historyError} loading={historyLoading} activeEventId={result?.event_id ?? ""} onRefresh={refreshHistory} onSelect={selectHistoryEntry} />

        <footer className="pageFooter"><span>Vigilia · BillieJSON</span><span>Demostración administrativa con datos sintéticos</span><a href="https://github.com/rgkue/vigilia-project" target="_blank" rel="noreferrer">Repositorio en GitHub <span aria-hidden="true">↗</span></a></footer>
      </main>
    </div>
  );
}

export default App;
