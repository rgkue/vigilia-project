import type { JevEvaluation, JevRelation, JevRoutingAudit, JevSuggestion } from "../types";

export interface JevStatus {
  configured: boolean;
  model: "typesafe-ai/jev";
}

const RELATIONS = new Set<JevRelation>(["DIRECTA", "POSIBLE", "NINGUNA", "PENDIENTE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const externalSignal = init.signal ?? undefined;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    if (externalSignal?.aborted) throw error;
    if (error instanceof TypeError) throw new Error("No se pudo conectar con la evaluación Jev.");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error
      : `La evaluación de Jev respondió HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

function parseStatus(value: unknown): JevStatus {
  if (!isRecord(value) || typeof value.configured !== "boolean" || value.model !== "typesafe-ai/jev") {
    throw new Error("El servicio Jev devolvió un estado inesperado.");
  }
  return value as unknown as JevStatus;
}

function parseSuggestion(value: unknown): JevSuggestion {
  if (!isRecord(value)
    || typeof value.condition !== "string"
    || !RELATIONS.has(value.relation as JevRelation)
    || !(value.probability === null || (typeof value.probability === "number" && Number.isFinite(value.probability) && value.probability >= 0 && value.probability <= 1))
    || typeof value.explanation !== "string"
    || value.source !== "jev"
    || value.reviewRequired !== true) {
    throw new Error("Jev devolvió una sugerencia incompleta o inválida.");
  }
  return value as unknown as JevSuggestion;
}

function parseRoutingAudit(value: unknown): JevRoutingAudit | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)
    || !(value.finalProvider === null || typeof value.finalProvider === "string")
    || !(value.planningReasoning === null || typeof value.planningReasoning === "string")
    || typeof value.noTrainingRequested !== "boolean"
    || typeof value.zeroDataRetentionRequested !== "boolean") {
    throw new Error("Jev devolvió una auditoría de ruta inválida.");
  }
  return value as unknown as JevRoutingAudit;
}

function parseEvaluation(value: unknown): JevEvaluation {
  if (!isRecord(value)
    || value.model !== "typesafe-ai/jev"
    || typeof value.threshold !== "number"
    || !Number.isFinite(value.threshold)
    || value.threshold < 0
    || value.threshold > 1
    || !Array.isArray(value.suggestions)
    || typeof value.note !== "string") {
    throw new Error("Jev devolvió una evaluación con un formato inesperado.");
  }
  return {
    model: "typesafe-ai/jev",
    threshold: value.threshold,
    suggestions: value.suggestions.map(parseSuggestion),
    note: value.note,
    routingAudit: parseRoutingAudit(value.routingAudit),
  };
}

export async function loadJevStatus(signal?: AbortSignal): Promise<JevStatus> {
  const response = await fetchWithTimeout(
    "/api/jev",
    { headers: { Accept: "application/json" }, signal },
    5_000,
    "La consulta del estado de Jev tardó demasiado.",
  );
  return parseStatus(await responseJson(response));
}

export async function evaluateJevCase(caseId: string, signal?: AbortSignal): Promise<JevEvaluation> {
  const response = await fetchWithTimeout(
    "/api/jev",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ caseId }),
      signal,
    },
    18_000,
    "La evaluación Jev tardó demasiado. El caso sigue pendiente de revisión.",
  );
  return parseEvaluation(await responseJson(response));
}
