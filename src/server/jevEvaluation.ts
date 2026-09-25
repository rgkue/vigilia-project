import { experimental_evaluate as evaluate } from "ai";
import type { JevEvaluation, JevRelation, JevRoutingAudit, JevSuggestion } from "../types";

const MODEL = "typesafe-ai/jev" as const;
const MIN_PROBABILITY = 0.75;
const MAX_CALLS_PER_MINUTE = 8;
const WINDOW_MS = 60_000;

const fixtures: Record<string, { reason: string; conditions: string[] }> = {
  "vig-demo-01": {
    reason: "Consulta por fiebre",
    conditions: ["Asma leve"],
  },
  "vig-demo-04": {
    reason: "Dolor torácico opresivo",
    conditions: ["Hipertensión arterial", "Diabetes mellitus tipo 2"],
  },
  "vig-demo-07": {
    reason: "Asma leve",
    conditions: ["Asma leve"],
  },
};

const requestCounts = new Map<string, { count: number; resetsAt: number }>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function hasGatewayCredentials(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

function requiresZdrForSynthetic(): boolean {
  return process.env.JEV_SYNTHETIC_REQUIRE_ZDR === "true";
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function isRateLimited(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = forwarded || "local";
  const now = Date.now();
  const current = requestCounts.get(key);
  if (!current || current.resetsAt <= now) {
    requestCounts.set(key, { count: 1, resetsAt: now + WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > MAX_CALLS_PER_MINUTE;
}

function relation(value: unknown): JevRelation {
  return value === "DIRECTA" || value === "POSIBLE" || value === "NINGUNA"
    ? value
    : "PENDIENTE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readUpstreamStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const statusCode = error.statusCode;
  return typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : null;
}

function readRoutingAudit(providerMetadata: unknown): JevRoutingAudit | null {
  if (!isRecord(providerMetadata) || !isRecord(providerMetadata.gateway)) return null;
  const routing = providerMetadata.gateway.routing;
  if (!isRecord(routing)) return null;

  const finalProvider = typeof routing.finalProvider === "string" ? routing.finalProvider.slice(0, 80) : null;
  const planningReasoning = typeof routing.planningReasoning === "string"
    ? routing.planningReasoning.slice(0, 320)
    : null;
  const reasoning = planningReasoning?.toLowerCase() ?? "";
  const zeroDataRetentionRequested = /zdr requested|zero data retention requested/i.test(reasoning);

  return {
    finalProvider,
    planningReasoning,
    noTrainingRequested: Boolean(finalProvider && (zeroDataRetentionRequested || /no[ -]training|disallow prompt training/i.test(reasoning))),
    zeroDataRetentionRequested,
  };
}

async function classifyCase(caseId: string): Promise<JevEvaluation> {
  const fixture = fixtures[caseId];
  if (!fixture) throw new RangeError("Caso de prueba no disponible.");

  const questions = Object.fromEntries(fixture.conditions.map((condition, index) => [
    `antecedente_${index + 1}`,
    {
      type: "choice" as const,
      instructions: `Propón una categoría orientativa para la relación administrativa entre el motivo de ingreso y el antecedente «${condition}». No infieras diagnósticos y no determines cobertura ni atención.`,
      criteria: {
        DIRECTA: "Los textos describen la misma condición o una relación directa y explícita.",
        POSIBLE: "Podría existir una relación, pero la información no la establece; requiere revisión humana.",
        NINGUNA: "No se aprecia una relación entre los textos aportados; esto no prueba que clínicamente no exista.",
      },
    },
  ]));

  const response = await evaluate({
    model: MODEL,
    state: { motivo_ingreso: fixture.reason },
    questions,
    providerOptions: {
      gateway: {
        ...(requiresZdrForSynthetic()
          ? { zeroDataRetention: true, only: ["typesafe-ai"] }
          : { disallowPromptTraining: true, only: ["typesafe-ai"] }),
      },
    },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(12_000),
  });

  const routingAudit = readRoutingAudit(response.providerMetadata);
  const policyConfirmed = routingAudit?.finalProvider === "typesafe-ai"
    && (requiresZdrForSynthetic()
      ? routingAudit.zeroDataRetentionRequested
      : routingAudit.noTrainingRequested);
  if (!policyConfirmed) {
    throw new Error("Jev no confirmó el proveedor y la política de privacidad requeridos.");
  }

  const suggestions: JevSuggestion[] = fixture.conditions.map((condition, index) => {
    const answer = response.answers[`antecedente_${index + 1}`] as unknown as {
      choice?: unknown;
      probabilities?: Record<string, unknown>;
    } | undefined;
    const proposed = relation(answer?.choice);
    const rawProbability = answer?.probabilities?.[proposed];
    const probability = typeof rawProbability === "number" && Number.isFinite(rawProbability)
      && rawProbability >= 0 && rawProbability <= 1
      ? rawProbability
      : null;

    const acceptedRelation = probability !== null && proposed !== "PENDIENTE" && probability >= MIN_PROBABILITY
      ? proposed
      : "PENDIENTE";

    return {
      condition,
      relation: acceptedRelation,
      probability,
      explanation: acceptedRelation === "PENDIENTE"
        ? "La salida no alcanzó el umbral de confianza configurado; requiere revisión humana."
        : "Sugerencia experimental de Jev; requiere revisión humana.",
      source: "jev",
      reviewRequired: true,
    };
  });

  return {
    model: MODEL,
    threshold: MIN_PROBABILITY,
    suggestions,
    note: "Prueba con datos sintéticos. Cada sugerencia requiere revisión humana y no determina cobertura ni atención.",
    routingAudit,
  };
}

export async function handleJevRequest(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json({
      configured: hasGatewayCredentials(),
      model: MODEL,
      zdrRequired: requiresZdrForSynthetic(),
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Método no permitido." }, 405);
  }

  if (!isSameOrigin(request)) {
    return json({ error: "La evaluación solo acepta solicitudes del mismo origen." }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "La solicitud no contiene JSON válido." }, 400);
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "La solicitud debe indicar un caso sintético." }, 400);
  }

  const keys = Object.keys(payload);
  const caseId = (payload as { caseId?: unknown }).caseId;
  if (keys.length !== 1 || keys[0] !== "caseId" || typeof caseId !== "string" || !fixtures[caseId]) {
    return json({ error: "El caso no está en la lista de escenarios sintéticos permitidos." }, 400);
  }

  if (!hasGatewayCredentials()) {
    return json({ error: "Falta configurar una credencial de Vercel AI Gateway en el entorno del servidor." }, 503);
  }

  if (isRateLimited(request)) {
    return json({ error: "Límite temporal alcanzado. Intenta de nuevo en un minuto." }, 429);
  }

  try {
    return json(await classifyCase(caseId));
  } catch (error) {
    console.warn("Jev synthetic evaluation failed:", {
      status: readUpstreamStatus(error) ?? "unknown",
      errorType: error instanceof Error ? error.name : typeof error,
      causeType: error instanceof Error && error.cause instanceof Error ? error.cause.name : "none",
    });
    return json({ error: "Jev no pudo completar la evaluación. El caso queda pendiente de revisión humana." }, 502);
  }
}
