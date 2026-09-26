import { useState, type FormEvent, type RefObject } from "react";
import { classificationLabel } from "../types";
import type { AgentResponse, ClassificationResult, JevRelation } from "../types";
import { formatDate, integrationLabel, integrationStatusLabel, levelLabel, notificationLabel, relationName, relativeTime, verdictLabel } from "../lib/labels";
import { CopyButton } from "./CopyButton";
import { Sheet } from "./Dialogs";
import { ResultPanel } from "./ResultPanel";

type ReviewRelation = Exclude<JevRelation, "PENDIENTE">;

function ClassificationReviewCard({ classification, index, reviewerName, onReview }: {
  classification: ClassificationResult;
  index: number;
  reviewerName: (id: string | null | undefined) => string;
  onReview: (index: number, relation: ReviewRelation, reason: string) => Promise<void>;
}) {
  const [relation, setRelation] = useState<ReviewRelation>(() => {
    const suggestion = classification.suggestedRelation ?? classification.relation;
    return suggestion === "DIRECTA" || suggestion === "NINGUNA" ? suggestion : "POSIBLE";
  });
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  if (classification.reviewed) {
    return <article className="reviewCard resolved">
      <div><strong>{classification.condition}</strong><span>Resuelta · {classificationLabel(classification)}</span></div>
      <p>Sugerencia original: {relationName(classification.suggestedRelation)}.{classification.reviewReason ? ` Motivo: ${classification.reviewReason}` : ""}</p>
      <small>{classification.reviewerId ? `${reviewerName(classification.reviewerId)} · ` : ""}{formatDate(classification.reviewedAt)}</small>
    </article>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || reason.trim().length < 3) return;
    setWorking(true);
    setError("");
    try {
      await onReview(index, relation, reason.trim());
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "No se pudo guardar la revisión.");
    } finally {
      setWorking(false);
    }
  }

  return <form className="reviewCard" onSubmit={submit}>
    <div><strong>{classification.condition}</strong><span>{classification.suggestedRelation ? `Sugerencia: ${relationName(classification.suggestedRelation)}` : "Clasificación pendiente"}</span></div>
    {!classification.suggestedRelation && <p>La fuente no entregó una sugerencia confirmada. Puedes completar una clasificación humana.</p>}
    <label className="reviewField"><span>Resolución</span><select value={relation} onChange={(event) => setRelation(event.target.value as ReviewRelation)}>
      <option value="DIRECTA">Confirmar relación directa</option><option value="POSIBLE">Marcar relación posible</option><option value="NINGUNA">Descartar relación</option>
    </select></label>
    <label className="reviewField"><span>Motivo de revisión</span><textarea required minLength={3} maxLength={1000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explica brevemente la resolución" /></label>
    {error && <p className="reviewError" role="alert">{error}</p>}
    <button className="primaryButton" type="submit" disabled={working || reason.trim().length < 3}>{working ? "Guardando revisión…" : "Guardar resolución"}</button>
  </form>;
}

type StepTone = "done" | "pending" | "warn";

function timeline(entry: AgentResponse, reviewerName: (id: string | null | undefined) => string): { title: string; detail: string; tone: StepTone }[] {
  const sources = entry.integrations;
  const failedSource = sources.some((source) => ["unavailable", "invalid_response", "not_configured"].includes(source.status));
  const deliveries = [entry.notifications.admissions, entry.notifications.case_manager];
  const failedDelivery = deliveries.some((item) => item.status === "failed" || item.status === "not_configured");
  const total = entry.classifications.length;
  const pending = entry.classifications.filter((item) => !item.reviewed).length;
  const lastReview = entry.classifications
    .filter((item) => item.reviewed && item.reviewedAt)
    .sort((left, right) => Date.parse(right.reviewedAt ?? "") - Date.parse(left.reviewedAt ?? ""))[0];

  return [
    { title: "Ingreso recibido", detail: formatDate(entry.created_at), tone: "done" },
    {
      title: "Fuentes consultadas",
      detail: sources.length ? sources.map((source) => `${integrationLabel(source.kind)}: ${integrationStatusLabel(source.status, true).toLowerCase()}`).join(" · ") : "Sin consulta de fuentes registrada",
      tone: failedSource ? "warn" : "done",
    },
    {
      title: "Avisos",
      detail: `Admisiones: ${notificationLabel(entry.notifications.admissions).toLowerCase()} · Gestor de casos: ${notificationLabel(entry.notifications.case_manager).toLowerCase()}`,
      tone: failedDelivery ? "warn" : "done",
    },
    {
      title: "Revisión humana",
      detail: total === 0
        ? "Sin antecedentes que revisar"
        : pending > 0
          ? `${pending} de ${total} antecedentes por revisar`
          : `Resuelta${lastReview ? ` · ${reviewerName(lastReview.reviewerId)} · ${formatDate(lastReview.reviewedAt)}` : ""}`,
      tone: total > 0 && pending > 0 ? "pending" : "done",
    },
  ];
}

export function IngressDetailSheet({ entry, onClose, returnFocusRef, canReview, reviewerName, onReview }: {
  entry: AgentResponse;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  canReview: boolean;
  reviewerName: (id: string | null | undefined) => string;
  onReview: (eventId: string, index: number, relation: ReviewRelation, reason: string) => Promise<void>;
}) {
  const steps = timeline(entry, reviewerName);
  return (
    <Sheet
      eyebrow="DETALLE DEL INGRESO"
      title={entry.hospital || "Ingreso sin centro registrado"}
      subtitle={entry.reason ?? undefined}
      closeLabel="Cerrar detalle"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      headerExtra={<>
        <div className="detailBadges">
          <span className="verdictTag">{verdictLabel(entry.verdict)}</span>
          <span className={`activityLevel ${entry.administrative_level}`}>{levelLabel(entry.administrative_level)}</span>
          {entry.reviewPending && <span className="reviewBadge">Revisión pendiente</span>}
        </div>
        <div className="detailMeta">
          <span title={formatDate(entry.created_at)}>{relativeTime(entry.created_at)}</span>
          {entry.maskedId && <span>Asegurado {entry.maskedId}</span>}
          <span className="detailReference"><code>{entry.event_id}</code><CopyButton value={entry.event_id} label="Copiar referencia" compact /></span>
        </div>
      </>}
    >
      <ol className="detailTimeline" aria-label="Seguimiento del ingreso">
        {steps.map((step) => <li key={step.title} className={step.tone}><i aria-hidden="true" /><div><strong>{step.title}</strong><span>{step.detail}</span></div></li>)}
      </ol>
      <ResultPanel result={entry} pending={false} embedded emptyDescription="No hay más información para este ingreso." />
      {canReview && entry.classifications.some((classification) => classification.reviewRequired) && <section className="classificationReviewSection">
        <span className="eyebrow">REVISIÓN HUMANA</span>
        <h3>Resolución de sugerencias</h3>
        <p>La resolución queda auditada y no modifica avisos que ya fueron enviados.</p>
        {entry.classifications.map((classification, index) => classification.reviewRequired && <ClassificationReviewCard key={`${classification.condition}-${index}`} classification={classification} index={index} reviewerName={reviewerName} onReview={(classificationIndex, relation, reason) => onReview(entry.event_id, classificationIndex, relation, reason)} />)}
      </section>}
    </Sheet>
  );
}
