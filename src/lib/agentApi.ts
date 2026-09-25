import { makeLocalResult } from "../data/demoCases";
import type { AdministrativeVerdict, AgentResponse, AlertLevel, ClassificationResult, DemoCase, IngressEvent, JevRelation, NotificationResult } from "../types";
import { apiConfigured, apiFetch, parseApiError } from "./clientApi";

export const isBackendConfigured = apiConfigured;

export class BackendConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendConnectionError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function alertLevel(value: unknown): AlertLevel {
  if (value === "BAJO") return "informativa";
  if (value === "ALTO") return "prioritaria";
  return "revision";
}

function administrativeVerdict(value: unknown): AdministrativeVerdict {
  if (value === "VALIDA" || value === "VALIDA_CON_ALERTAS" || value === "NO_VALIDA" || value === "NO_ENCONTRADO") return value;
  return "PENDIENTE";
}

function delivery(notification: JsonRecord | undefined): NotificationResult {
  if (!notification) return { status: "unknown", channel: "sin dato" };
  const state = notification.estado;
  const channel = text(notification.canal) ?? "sin dato";
  if (state === "NO_CONFIGURADA") return { status: "not_configured", channel };
  if (state === "ERROR") return { status: "failed", channel };
  if (state === "ENVIADA" && channel.toLowerCase() === "log") {
    return { status: "simulated", channel };
  }
  if (state === "ENVIADA") return { status: "sent", channel };
  return { status: "unknown", channel };
}

function notificationFor(notifications: unknown, destination: string): NotificationResult {
  if (!Array.isArray(notifications)) return delivery(undefined);
  const match = notifications
    .map(record)
    .find((item) => item.destino === destination);
  return delivery(match);
}

function policyExplanation(policy: JsonRecord): string {
  const details: string[] = [];
  if (text(policy.plan)) details.push(`Plan ${policy.plan}`);
  if (typeof policy.al_dia_pago === "boolean") {
    details.push(policy.al_dia_pago ? "pagos al día" : "pago pendiente");
  }
  if (typeof policy.en_carencia === "boolean") {
    details.push(policy.en_carencia ? "en período de carencia" : "fuera del período de carencia");
  }
  return details.length > 0
    ? details.join(" · ")
    : "El servicio no incluyó detalles adicionales de la póliza.";
}

function isAnalysisPending(item: JsonRecord): boolean {
  return /\bpendiente\b|\bno implementad[oa]\b|\bno disponible\b/i.test(text(item.justificacion) ?? "");
}

function normalizeClassifications(items: JsonRecord[]): ClassificationResult[] {
  const acceptedRelations = new Set<JevRelation>(["DIRECTA", "POSIBLE", "NINGUNA"]);
  return items.map((item) => {
    const explanation = text(item.justificacion) ?? "El backend no incluyó una explicación.";
    const rawRelation = text(item.relacion) as JevRelation | undefined;
    const reviewed = item.revisada === true;
    const unresolved = !reviewed && /^Revisión humana pendiente:/i.test(explanation);
    const relation = !unresolved && rawRelation && acceptedRelations.has(rawRelation)
      ? rawRelation
      : "PENDIENTE";

    return {
      condition: text(item.condicion) ?? "Antecedente",
      relation,
      probability: null,
      explanation,
      source: /^Kev sugiere\b/i.test(explanation) || /\bKev\b/i.test(explanation)
        ? "kev"
        : /^Groq sugiere\b/i.test(explanation) || /\bGroq\b/i.test(explanation)
          ? "groq"
          : /^Jev sugiere\b/i.test(explanation) || /\bJev\b/i.test(explanation)
            ? "jev"
            : "backend",
      reviewRequired: !reviewed,
      suggestedRelation: text(item.relacion_sugerida) as JevRelation | undefined,
      reviewed,
      reviewReason: text(item.motivo_revision) ?? null,
      reviewerId: text(item.revisor_id) ?? null,
      reviewedAt: text(item.revisada_en) ?? null,
    };
  });
}

function preexistingItemSummary(item: JsonRecord): string {
  const condition = text(item.condicion) ?? "Antecedente";
  const relation = text(item.relacion);
  const relationLabel = relation === "DIRECTA"
    ? "relación directa"
    : relation === "POSIBLE"
      ? "relación posible"
      : relation === "NINGUNA"
        ? "sin relación identificada"
        : relation ?? "sin relación indicada";
  const explanation = text(item.justificacion);
  return `${condition}: ${relationLabel}${explanation ? ` — ${explanation}` : ""}.`;
}

function preexistingExplanation(items: JsonRecord[], verdict: unknown): string {
  if (items.length === 0) {
    return verdict === "NO_ENCONTRADO"
      ? "No es posible revisar antecedentes sin un registro de asegurado y póliza."
      : "El backend no devolvió antecedentes registrados para este asegurado.";
  }
  const pendingItems = items.filter(isAnalysisPending);
  if (pendingItems.length > 0) {
    const conditions = [...new Set(pendingItems.map((item) => text(item.condicion) ?? "un antecedente"))];
    const reviewed = items.filter((item) => !isAnalysisPending(item)).map(preexistingItemSummary);
    return [...reviewed, `La evaluación del agente sigue pendiente para ${conditions.join(", ")}.`].join(" ");
  }
  return items.map(preexistingItemSummary).join(" ");
}

function summaryFor(verdict: unknown, hasPendingReview: boolean): string {
  switch (verdict) {
    case "VALIDA":
      if (hasPendingReview) return "La póliza aparece vigente y al día; la revisión de antecedentes sigue pendiente.";
      return "La póliza aparece vigente y al día, sin alertas administrativas en este caso.";
    case "VALIDA_CON_ALERTAS":
      return "El backend encontró una o más observaciones administrativas para revisión humana.";
    case "NO_VALIDA":
      return "El backend identificó una póliza no vigente. El equipo debe revisar el caso; la atención no se debe retrasar.";
    case "NO_ENCONTRADO":
      return "No se encontró un registro de asegurado o póliza. El equipo debe verificar los datos.";
    case "PENDIENTE":
      return "Una fuente necesaria no está configurada o no respondió. No se pudo completar la consulta.";
    default:
      return "El servicio procesó el evento; revisa los campos y avisos devueltos.";
  }
}

function normalizeResponse(value: unknown, eventId: string, createdFallback?: string): AgentResponse {
  const payload = record(value);
  const policyValue = payload.poliza;
  const policy = record(policyValue);
  const preexistingItems = Array.isArray(payload.preexistencias)
    ? payload.preexistencias.map(record)
    : [];
  const verdict = payload.veredicto;
  const hasPolicy = policyValue !== null && typeof policyValue === "object" && !Array.isArray(policyValue);
  const policyStatus = hasPolicy
    ? policy.vigente === true ? "Vigente" : policy.vigente === false ? "No vigente" : "Estado sin confirmar"
    : verdict === "NO_ENCONTRADO" ? "No encontrada" : "Sin datos";
  const hasPreexistingMatch = preexistingItems.some((item) => item.relacion === "DIRECTA" || item.relacion === "POSIBLE");
  const hasPendingReview = preexistingItems.some(isAnalysisPending);
  const allReviewedUnrelated = preexistingItems.length > 0 && preexistingItems.every((item) => item.relacion === "NINGUNA" && !isAnalysisPending(item));

  return {
    event_id: text(payload.evento_id) ?? eventId,
    created_at: text(payload.creado_en) ?? text(payload.created_at) ?? createdFallback,
    administrative_level: alertLevel(payload.nivel_alerta),
    verdict: administrativeVerdict(verdict),
    summary: summaryFor(verdict, hasPendingReview),
    policy: {
      number: text(policy.numero) ?? null,
      plan: text(policy.plan) ?? null,
      status: policyStatus,
      explanation: hasPolicy ? policyExplanation(policy) : "No se encontró una póliza vinculada a esta referencia.",
    },
    preexisting: {
      match: hasPreexistingMatch ? true : verdict === "NO_ENCONTRADO" || hasPendingReview || preexistingItems.length === 0 ? null : allReviewedUnrelated ? false : null,
      explanation: preexistingExplanation(preexistingItems, verdict),
    },
    classifications: normalizeClassifications(preexistingItems),
    messages: {
      admissions: text(payload.mensaje_admisiones) ?? "El backend no devolvió el aviso para admisiones.",
      case_manager: text(payload.mensaje_gestor) ?? "El backend no devolvió el aviso para el gestor de casos.",
    },
    notifications: {
      admissions: notificationFor(payload.notificaciones, "admisiones"),
      case_manager: notificationFor(payload.notificaciones, "gestor_casos"),
    },
    integrations: Array.isArray(payload.fuentes) ? payload.fuentes.map((item) => {
      const source = record(item);
      return {
        kind: text(source.tipo) ?? "fuente",
        status: (text(source.estado) ?? "unavailable") as AgentResponse["integrations"][number]["status"],
        checkedAt: text(source.revisada_en) ?? null,
        error: null,
      };
    }) : [],
    source: "backend",
  };
}

export async function checkBackendHealth(): Promise<boolean> {
  if (!isBackendConfigured) return false;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await apiFetch("/health", { signal: controller.signal });
    if (!response.ok) return false;
    const payload = record(await response.json().catch(() => ({})));
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loadIngressHistory(): Promise<AgentResponse[]> {
  if (!isBackendConfigured) return [];

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await apiFetch("/ingresos?limite=10", { signal: controller.signal });
    if (!response.ok) {
      throw await parseApiError(response);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!Array.isArray(body)) throw new Error("El servicio devolvió una respuesta inesperada. Contacta al administrador.");
    return body.map((item) => {
      const payload = record(item);
      return normalizeResponse(payload, text(payload.evento_id) ?? "EVENTO");
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("La consulta está tardando más de lo habitual. Inténtalo de nuevo.");
    }
    if (error instanceof TypeError) {
      throw new BackendConnectionError("No se pudo conectar con el servicio. Inténtalo de nuevo más tarde.");
    }
    throw error instanceof Error ? error : new Error("No se pudo cargar el historial.");
  } finally {
    window.clearTimeout(timeout);
  }
}

async function postIngress(event: IngressEvent, path: string): Promise<AgentResponse> {
  if (!isBackendConfigured) throw new BackendConnectionError("El servicio de ingresos no está configurado.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await apiFetch(path.startsWith("/") ? path : `/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw await parseApiError(response);
    }
    const body: unknown = await response.json().catch(() => ({}));
    return normalizeResponse(body, event.evento_id, event.fecha_ingreso);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("El servicio tardó demasiado en responder. Revisa la actividad antes de volver a enviar el evento.");
    }
    if (error instanceof TypeError) {
      throw new BackendConnectionError("No se pudo conectar con el servicio. Inténtalo de nuevo más tarde.");
    }
    throw error instanceof Error ? error : new Error("No se pudo procesar el ingreso.");
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Live intake never silently falls back to fabricated local records. */
export function processIngress(event: IngressEvent): Promise<AgentResponse> {
  return postIngress(event, "/ingresos");
}

/** Synthetic scenarios may run locally, isolated from the client-facing workflow. */
export async function processDemoIngress(event: IngressEvent, demoCase: DemoCase): Promise<AgentResponse> {
  if (!isBackendConfigured) {
    if (import.meta.env.DEV) {
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      return makeLocalResult(event, demoCase);
    }
    throw new BackendConnectionError("El simulador local solo está disponible durante el desarrollo.");
  }
  return postIngress(event, "/webhook/ingreso");
}
