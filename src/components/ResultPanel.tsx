import { useEffect, useRef, useState } from "react";
import { classificationLabel } from "../types";
import type { AgentResponse, ClassificationResult, NotificationResult } from "../types";
import { channelLabel, formatCount, formatDate, integrationLabel, integrationStatusLabel, levelLabel, notificationLabel, notificationTone, preexistingLabel, relationName, verdictLabel } from "../lib/labels";
import { CopyButton } from "./CopyButton";
import { Icon, type IconName } from "./Icon";

export function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="panelHeading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>;
}

function sourceName(classification: ClassificationResult) {
  return classification.source === "kev" ? "Kev" : classification.source === "groq" ? "Groq" : "Jev";
}

function classificationOrigin(classification: ClassificationResult) {
  if (classification.reviewed) return `Revisión humana · sugerencia original: ${relationName(classification.suggestedRelation)}`;
  if (classification.source === "backend") return "Backend · revisión humana";
  if (classification.relation === "PENDIENTE") return `${sourceName(classification)} sin clasificación confirmada · revisión humana`;
  return `${sourceName(classification)} · sugerencia · revisión humana`;
}

export function NotificationCard({ title, notification, message, icon, simulator = false }: { title: string; notification: NotificationResult; message: string; icon: IconName; simulator?: boolean }) {
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

export function ResultPanel({ result, pending, emptyDescription, simulator = false, embedded = false }: { result: AgentResponse | null; pending: boolean; emptyDescription: string; simulator?: boolean; embedded?: boolean }) {
  if (pending) {
    return (
      <section className="glassPanel resultPanel" aria-live="polite" aria-busy="true">
        <PanelHeading eyebrow="ANÁLISIS EN CURSO" title="Procesando el ingreso" />
        <div className="processingState">
          <div className="emptySignal isActive" aria-hidden="true"><span /><Icon name="pulse" size={25} /></div>
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
          <span className="verdictTag resultVerdict">{verdictLabel(result.verdict)}</span>
          <span className={`levelPill ${result.administrative_level}`}><span className="levelDot" />{levelLabel(result.administrative_level)}</span>
        </div>
      </div>
      <p className="resultSummary">{result.summary}</p>
      {!embedded && <div className="eventReference"><span>REFERENCIA DEL EVENTO</span><code>{result.event_id}</code><CopyButton value={result.event_id} label="Copiar referencia" compact /></div>}
      {result.integrations.length > 0 && <section className="sourceStates" aria-label="Estado de fuentes consultadas">
        <span className="eyebrow">ESTADO DE LAS FUENTES</span>
        <div>{result.integrations.map((source) => <span className={`sourceState ${source.status}`} key={source.kind}><strong>{integrationLabel(source.kind)}</strong><small>{integrationStatusLabel(source.status, true)}</small></span>)}</div>
      </section>}
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
                    {classificationOrigin(classification)}
                    {classification.probability === null ? "" : ` · Probabilidad: ${Math.round(classification.probability * 100)}%`}
                  </small>
                  {classification.reviewed && classification.reviewReason && <small>Motivo de resolución: {classification.reviewReason} · {formatDate(classification.reviewedAt)}</small>}
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

export function MetricCount({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const displayValueRef = useRef(displayValue);

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
