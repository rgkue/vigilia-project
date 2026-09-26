import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { ActivityRows } from "../components/ActivityRows";
import { Icon } from "../components/Icon";
import { MetricCount } from "../components/ResultPanel";
import type { IntegrationStatus } from "../lib/adminApi";
import { BackendConnectionError, loadIngressList, loadIngressSummary } from "../lib/agentApi";
import { formatCount, formatDate, integrationLabel, integrationStatusLabel } from "../lib/labels";
import type { AgentResponse, IngressSummary } from "../types";

const REFRESH_MS = 60_000;
const LEVEL_ORDER = { prioritaria: 0, revision: 1, informativa: 2 } as const;

function greeting(date: Date) {
  const hour = date.getHours();
  return hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
}

function FlowConnector({ id, delayed = false }: { id: string; delayed?: boolean }) {
  return <span className="clientFlowConnector" aria-hidden="true"><svg viewBox="0 0 100 24" preserveAspectRatio="none" focusable="false"><path id={id} className="flowLinkBase" d="M0 12H38L47 4L54 20L63 12H100" /><circle className="flowLinkSpark" r="2.2"><animateMotion dur="2.8s" begin={delayed ? "1.4s" : "0s"} repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.42;1"><mpath href={`#${id}`} /></animateMotion><animate attributeName="opacity" dur="2.8s" begin={delayed ? "1.4s" : "0s"} values="0;1;1;0;0" keyTimes="0;0.02;0.4;0.44;1" repeatCount="indefinite" /></circle></svg></span>;
}

export function OverviewPage({
  displayName, canReadIngress, canSubmitIngress, canReview, canManageIntegrations, backendStatus, statuses,
  refreshKey, activeEventId, highlightedEventId, onSelect, onNavigate, onConnection,
}: {
  displayName: string;
  canReadIngress: boolean;
  canSubmitIngress: boolean;
  canReview: boolean;
  canManageIntegrations: boolean;
  backendStatus: "local" | "checking" | "online" | "offline";
  statuses: IntegrationStatus[];
  refreshKey: number;
  activeEventId: string;
  highlightedEventId: string;
  onSelect: (entry: AgentResponse, trigger: HTMLButtonElement) => void;
  onNavigate: (path: string) => void;
  onConnection: (online: boolean) => void;
}) {
  const [summary, setSummary] = useState<IngressSummary | null>(null);
  const [recent, setRecent] = useState<AgentResponse[]>([]);
  const [attention, setAttention] = useState<AgentResponse[]>([]);
  const [loading, setLoading] = useState(canReadIngress);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const operationsView = canReview || canManageIntegrations;

  const load = useCallback(async (quiet = false) => {
    if (!canReadIngress) return;
    if (!quiet) setLoading(true);
    try {
      const [nextSummary, nextRecent, pending] = await Promise.all([
        loadIngressSummary(),
        loadIngressList({}, 1, 5),
        canReview ? loadIngressList({ pendingReview: true }, 1, 25) : Promise.resolve(null),
      ]);
      setSummary(nextSummary);
      setRecent(nextRecent.items);
      setAttention(pending ? [...pending.items].sort((left, right) => LEVEL_ORDER[left.administrative_level] - LEVEL_ORDER[right.administrative_level]).slice(0, 5) : []);
      setError("");
      setNow(Date.now());
      onConnection(true);
    } catch (loadError) {
      if (loadError instanceof BackendConnectionError) onConnection(false);
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el resumen.");
    } finally {
      setLoading(false);
    }
  }, [canReadIngress, canReview, onConnection]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  function link(path: string) {
    return { href: path, onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onNavigate(path); } };
  }

  const today = new Date(now);
  const firstName = displayName.split(/\s+/)[0] || displayName;
  const statusText = backendStatus === "online" ? "Servicio conectado" : backendStatus === "checking" ? "Comprobando el servicio" : backendStatus === "offline" ? "Servicio sin respuesta" : "Servicio sin configurar";
  const statusTone = backendStatus === "online" ? "configured" : backendStatus;
  const ready = Boolean(summary) && !error;
  const deliveries = summary?.deliveriesToday;
  const deliveryIssues = deliveries ? deliveries.failed + deliveries.notConfigured : 0;
  const metricHint = (text: string) => ready ? text : loading ? "Consultando el servicio…" : "No disponible con la conexión actual";
  const problemSources = statuses.filter((source) => ["unavailable", "invalid_response", "not_configured"].includes(source.status));

  return (
    <div className="clientPageStack">
      <section className="clientHero overviewHero">
        <div className="clientHeroCopy">
          <span className="clientEyebrow"><span className="pulseMark" />CENTRO DE COORDINACIÓN</span>
          <h1>{greeting(today)}, <em>{firstName}.</em></h1>
          <p className="overviewDate">{new Intl.DateTimeFormat("es-PA", { weekday: "long", day: "numeric", month: "long" }).format(today)} · <span className={`flowLiveBadge ${statusTone}`}><i />{statusText}</span></p>
          <div className="clientHeroActions">
            {canSubmitIngress && <button className="primaryButton" type="button" onClick={() => onNavigate("/ingreso")}>Registrar ingreso <Icon name="arrow" size={16} /></button>}
            <button className="secondaryButton" type="button" onClick={() => onNavigate(operationsView ? "/actividad?revision=pendiente" : "/actividad?periodo=hoy")}>{operationsView ? "Revisar pendientes" : "Ver ingresos de hoy"}</button>
          </div>
          <div className="clientPrinciple"><Icon name="shield" size={17} /><p>La verificación es administrativa: el equipo clínico conserva el criterio asistencial y la atención no debe retrasarse.</p></div>
        </div>
        <div className="clientFlowCard glassPanel">
          <div className="clientFlowHeading"><span className="eyebrow">FLUJO DE HOY</span><span className={`flowLiveBadge ${statusTone}`}><i />{backendStatus === "online" ? "En vivo" : backendStatus === "checking" ? "Verificando" : backendStatus === "offline" ? "Sin conexión" : "Sin configurar"}</span></div>
          <div className="clientFlowSteps">
            <div><span className="clientFlowIcon"><Icon name="hospital" size={19} /></span><strong>Ingresos recibidos</strong><small className="flowFigure">{ready ? `${formatCount(summary!.today.total)} hoy` : "—"}</small></div>
            <FlowConnector id="flow-link-intake-review" />
            <div><span className="clientFlowIcon"><Icon name="shield" size={19} /></span><strong>Revisión humana</strong><small className="flowFigure">{ready ? `${formatCount(summary!.pendingReview)} pendientes` : "—"}</small></div>
            <FlowConnector id="flow-link-review-followup" delayed />
            <div><span className="clientFlowIcon"><Icon name="bell" size={19} /></span><strong>Avisos</strong><small className="flowFigure">{ready && deliveries ? `${formatCount(deliveries.sent + deliveries.internal)} enviados${deliveryIssues ? ` · ${formatCount(deliveryIssues)} con error` : ""}` : "—"}</small></div>
          </div>
          <div className="clientFlowNote">{error ? error : "Las sugerencias automatizadas requieren revisión del equipo responsable."}</div>
        </div>
      </section>

      {canReadIngress && <section className={`clientMetrics${operationsView ? " four" : ""}`} aria-label="Indicadores de hoy">
        <a className="clientMetric metricLink" {...link("/actividad?periodo=hoy")}><span>Ingresos de hoy</span>{ready ? <MetricCount value={summary!.today.total} /> : <strong>—</strong>}<small>{metricHint(`${formatCount(summary?.last24h ?? 0)} en las últimas 24 horas`)}</small></a>
        {operationsView && <a className="clientMetric metricLink" {...link("/actividad?revision=pendiente")}><span>Revisión humana pendiente</span>{ready ? <MetricCount value={summary!.pendingReview} /> : <strong>—</strong>}<small>{metricHint(`Ingresos de los últimos ${summary?.reviewWindowDays ?? 30} días`)}</small></a>}
        <a className="clientMetric metricLink" {...link("/actividad?nivel=prioritaria&periodo=hoy")}><span>Prioridad administrativa</span>{ready ? <MetricCount value={summary!.today.byLevel.prioritaria} /> : <strong>—</strong>}<small>{metricHint("Registrados hoy")}</small></a>
        {operationsView && <a className="clientMetric metricLink" {...link("/actividad?periodo=hoy")}><span>Avisos con error</span>{ready ? <MetricCount value={deliveryIssues} /> : <strong>—</strong>}<small>{metricHint(deliveries ? `${formatCount(deliveries.sent)} externos · ${formatCount(deliveries.internal)} internos hoy` : "")}</small></a>}
      </section>}

      {canReview && <>
        <section className="clientSectionHeading"><div><span className="eyebrow">REQUIERE ATENCIÓN</span><h2>Revisiones pendientes</h2><p>Antecedentes con sugerencias que el equipo aún no ha resuelto, primero los prioritarios.</p></div><button className="textAction" type="button" onClick={() => onNavigate("/actividad?revision=pendiente")}>Ver todas <Icon name="arrow" size={15} /></button></section>
        <section className="glassPanel activityPanel" aria-busy={loading} aria-label="Revisiones pendientes">
          {attention.length > 0
            ? <ActivityRows entries={attention} activeEventId={activeEventId} highlightedEventId={highlightedEventId} now={now} onSelect={onSelect} />
            : <div className="activityEmpty"><span className="hintDot" /><span>{loading ? "Consultando revisiones…" : error ? "No se pudieron consultar las revisiones." : `No hay revisiones pendientes en los últimos ${summary?.reviewWindowDays ?? 30} días.`}</span></div>}
        </section>
      </>}

      {operationsView && <section className="adminStatusRail operationalStatusRail" aria-label="Estado de Vigilia y sus integraciones">
        <article><span className="eyebrow">VIGILIA</span><strong className={`connectorStatus ${backendStatus === "online" ? "connected" : backendStatus}`}>{backendStatus === "online" ? "API activa" : backendStatus === "checking" ? "Comprobando" : backendStatus === "offline" ? "Sin respuesta" : "Sin configurar"}</strong><small>Servicio de esta instalación</small></article>
        {statuses.map((source) => <article key={source.kind}>
          <span className="eyebrow">{integrationLabel(source.kind)}</span>
          <strong className={`connectorStatus ${source.status}`}>{integrationStatusLabel(source.status)}</strong>
          <small>{source.last_checked_at ? formatDate(source.last_checked_at) : "Sin prueba reciente"}</small>
          {canManageIntegrations && problemSources.includes(source) && <a className="railAction" {...link("/administracion/integraciones")}>Configurar</a>}
        </article>)}
      </section>}

      <section className="clientSectionHeading"><div><span className="eyebrow">SEGUIMIENTO</span><h2>Actividad reciente</h2><p>Últimos ingresos recibidos por el servicio.</p></div><button className="textAction" type="button" onClick={() => onNavigate("/actividad")}>Ver historial <Icon name="arrow" size={15} /></button></section>
      <section className="glassPanel activityPanel" aria-busy={loading} aria-label="Actividad reciente">
        {recent.length > 0
          ? <ActivityRows entries={recent} activeEventId={activeEventId} highlightedEventId={highlightedEventId} now={now} onSelect={onSelect} />
          : <div className="activityEmpty"><span className="hintDot" /><span>{!canReadIngress ? "Tu perfil no tiene permiso para consultar el historial de ingresos." : loading ? "Consultando los ingresos recientes…" : error ? "No se pudo cargar la actividad." : "Todavía no hay ingresos registrados."}</span></div>}
      </section>
    </div>
  );
}
