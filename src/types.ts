export type DeliveryStatus =
  | "sent"
  | "failed"
  | "not_configured"
  | "simulated"
  | "unknown";

export type AlertLevel = "informativa" | "revision" | "prioritaria";
export type AdministrativeVerdict = "VALIDA" | "VALIDA_CON_ALERTAS" | "NO_VALIDA" | "NO_ENCONTRADO" | "PENDIENTE";

export interface DemoCase {
  id: string;
  label: string;
  caption: string;
  insuredId: string;
  hospitalName: string;
  reason: string;
  triage?: number;
  policyStatus: string;
  policyExplanation: string;
  preexistingMatch: boolean | null;
  preexistingExplanation: string;
  preexistingConditions: string[];
  alertLevel: AlertLevel;
  verdict: AdministrativeVerdict;
  summary: string;
  messageAdmissions: string;
  messageCaseManager: string;
}

export type JevRelation = "DIRECTA" | "POSIBLE" | "NINGUNA" | "PENDIENTE";

export interface ClassificationResult {
  condition: string;
  relation: JevRelation;
  probability: number | null;
  explanation: string;
  source: "jev" | "kev" | "groq" | "backend";
  reviewRequired: boolean;
}

/** Jev is one producer of the normalized classification result. */
export type JevSuggestion = ClassificationResult;

export function classificationLabel(result: ClassificationResult): string {
  switch (result.relation) {
    case "DIRECTA": return "Relación directa";
    case "POSIBLE": return "Relación posible";
    case "NINGUNA": return "Sin relación identificada";
    default: return "Revisión pendiente";
  }
}

export interface JevEvaluation {
  model: "typesafe-ai/jev";
  threshold: number;
  suggestions: JevSuggestion[];
  note: string;
  routingAudit: JevRoutingAudit | null;
}

export interface JevRoutingAudit {
  finalProvider: string | null;
  planningReasoning: string | null;
  noTrainingRequested: boolean;
  zeroDataRetentionRequested: boolean;
}

/** Exact request schema from backend/app/schemas.py. */
export interface IngressEvent {
  evento_id: string;
  cedula: string;
  hospital: string;
  motivo_ingreso: string;
  triage?: number;
  fecha_ingreso: string;
}

export interface NotificationResult {
  status: DeliveryStatus;
  channel: string;
}

export interface AgentResponse {
  event_id: string;
  created_at?: string;
  administrative_level: AlertLevel;
  verdict: AdministrativeVerdict;
  summary: string;
  policy: {
    number: string | null;
    plan: string | null;
    status: string;
    explanation: string;
  };
  preexisting: {
    match: boolean | null;
    explanation: string;
  };
  classifications: ClassificationResult[];
  messages: {
    admissions: string;
    case_manager: string;
  };
  notifications: {
    admissions: NotificationResult;
    case_manager: NotificationResult;
  };
  source: "local_demo" | "backend";
}
