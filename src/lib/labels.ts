import type { AdministrativeVerdict, AgentResponse, AlertLevel, JevRelation, NotificationResult } from "../types";

export function levelLabel(level: AlertLevel) {
  if (level === "prioritaria") return "Prioridad administrativa";
  if (level === "informativa") return "Aviso administrativo";
  return "Revisión administrativa";
}

export function notificationLabel(notification: NotificationResult) {
  switch (notification.status) {
    case "sent": return "Enviada";
    case "failed": return "No se pudo enviar";
    case "not_configured": return "Canal sin configurar";
    case "simulated": return notification.channel === "log" ? "Simulada en servidor" : "Solo simulada";
    default: return "Sin confirmación";
  }
}

export function notificationTone(notification: NotificationResult) {
  if (notification.status === "sent") return "good";
  if (notification.status === "failed") return "bad";
  return "quiet";
}

export function channelLabel(channel: string) {
  if (channel.toLowerCase() === "log") return "Registro del backend";
  if (channel.toLowerCase() === "slack") return "Slack";
  if (channel.toLowerCase() === "demo local") return "Demo local";
  return channel;
}

export function verdictLabel(verdict: AdministrativeVerdict) {
  switch (verdict) {
    case "VALIDA": return "Válida";
    case "VALIDA_CON_ALERTAS": return "Válida con alertas";
    case "NO_VALIDA": return "No vigente";
    case "NO_ENCONTRADO": return "No encontrado";
    default: return "Pendiente";
  }
}

export function integrationLabel(kind: string) {
  switch (kind) {
    case "coverage": return "Cobertura";
    case "history": return "Antecedentes";
    case "ingress": return "Ingreso";
    case "admissions": return "Admisiones";
    case "case_manager": return "Gestor de casos";
    default: return kind;
  }
}

export function integrationStatusLabel(status: string, eventSource = false) {
  switch (status) {
    case "connected": return eventSource ? "Respondió" : "Conectada";
    case "not_found": return "Sin registro";
    case "invalid_response": return "Respuesta inválida";
    case "unavailable": return "Sin respuesta";
    case "pending": return "Pendiente";
    default: return "Sin configurar";
  }
}

export function preexistingLabel(preexisting: AgentResponse["preexisting"]) {
  if (preexisting.match === true) return "Relación para revisar";
  if (preexisting.match === false) return "Sin relación identificada";
  return /\bpendiente\b/i.test(preexisting.explanation) ? "Revisión pendiente" : "Sin datos para comparar";
}

export function jevRelationLabel(relation: JevRelation) {
  switch (relation) {
    case "DIRECTA": return "Relación directa sugerida";
    case "POSIBLE": return "Posible relación · revisar";
    case "NINGUNA": return "Sin relación sugerida";
    default: return "Revisión humana · señal insuficiente";
  }
}

/** Short relation name for suggestions shown next to a human decision. */
export function relationName(relation: JevRelation | null | undefined) {
  switch (relation) {
    case "DIRECTA": return "relación directa";
    case "POSIBLE": return "relación posible";
    case "NINGUNA": return "sin relación";
    default: return "sin sugerencia";
  }
}

export const ROLE_LABELS: Record<string, string> = {
  administrador: "Administrador",
  operador: "Operador",
  recepcionista: "Recepcionista",
  revisor: "Revisor",
  auditor: "Auditor",
  configurador_ia: "Configurador de IA",
};

export function rolesLabel(roles: string[]) {
  return roles.map((role) => ROLE_LABELS[role] ?? role).join(", ") || "Sin rol";
}

const AUDIT_ACTIONS: Record<string, string> = {
  "auth.login": "Inicio de sesión corporativo",
  "auth.logout": "Cierre de sesión",
  "auth.demo.login": "Inicio de sesión de demostración",
  "auth.demo_access.login": "Entrada en modo Demo",
  "auth.employee.login": "Inicio de sesión de empleado",
  "auth.employee.denied": "Acceso de empleado rechazado",
  "audit.read": "Consulta de auditoría",
  "user.create": "Perfil creado",
  "user.update": "Perfil actualizado",
  "user.deactivate": "Acceso desactivado",
  "user.list": "Consulta de perfiles",
  "permissions.catalog.read": "Consulta del catálogo de permisos",
  "employee.create": "Empleado creado",
  "employee.update": "Empleado actualizado",
  "employee.totp.replace": "Autenticador configurado o reemplazado",
  "employee.provision": "Cuenta de evaluación restablecida",
  "employee.demo_fixture.disable": "Cuenta de prueba pública desactivada",
  "integration.create": "Integración creada",
  "integration.update": "Integración actualizada",
  "integration.disable": "Integración desactivada",
  "integration.test": "Prueba de integración",
  "integration.list": "Consulta de integraciones",
  "integration.status.read": "Consulta del estado de integraciones",
  "integration.credential.issue": "Credencial de ingreso emitida",
  "integration.credential.list": "Consulta de credenciales",
  "integration.credential.revoke": "Credencial de ingreso revocada",
  "ingress.receive": "Ingreso recibido",
  "ingress.history.read": "Consulta de actividad",
  "ingress.summary.read": "Consulta del resumen",
  "ingress.outcome.update": "Resultado recalculado tras la revisión",
  "classification.review": "Revisión humana guardada",
  "ai.configure": "Proveedor de IA configurado",
  "ai.select": "Proveedor de IA activado",
  "ai.test": "Prueba de proveedor de IA",
  "ai.classify": "Clasificación automática",
  "ai.provision": "IA compartida aplicada",
  "ai.oauth.started": "Autorización de suscripción iniciada",
  "ai.oauth.completed": "Suscripción conectada",
  "ai.oauth.disconnected": "Suscripción desconectada",
  "ai.assignment.nominate": "Responsable de IA propuesto",
  "ai.assignment.revoke": "Asignación de IA revocada",
};

export const AUDIT_ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "Todas las acciones" },
  { value: "auth.", label: "Accesos" },
  { value: "user.", label: "Perfiles" },
  { value: "employee.", label: "Empleados" },
  { value: "integration.", label: "Integraciones" },
  { value: "ingress.", label: "Ingresos" },
  { value: "classification.", label: "Revisiones" },
  { value: "ai.", label: "Inteligencia artificial" },
];

export function auditActionLabel(action: string) {
  if (AUDIT_ACTIONS[action]) return AUDIT_ACTIONS[action];
  if (action.startsWith("ai.assignment.")) return "Autorización de IA actualizada";
  return action;
}

export function formatDate(value?: string | null) {
  if (!value) return "Fecha no disponible";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : new Intl.DateTimeFormat("es-PA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const relativeFormatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export function relativeTime(value?: string | null, now = Date.now()) {
  if (!value) return "Fecha no disponible";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "Fecha no disponible";
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "hace un momento";
  if (abs < 3600) return relativeFormatter.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormatter.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 7) return relativeFormatter.format(Math.round(seconds / 86400), "day");
  return formatDate(value);
}

export function formatCount(value: number) {
  return new Intl.NumberFormat("es-PA").format(value);
}
