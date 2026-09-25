import { jsonRequest } from "./clientApi";

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  active: boolean;
  roles: string[];
  permissions: string[];
  effective_permissions: string[];
  identity_linked: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntegrationConfig {
  id: string;
  kind: "ingress" | "coverage" | "history" | "admissions" | "case_manager";
  name: string;
  endpoint_url: string;
  method: "GET" | "POST";
  lookup_parameter: string;
  field_map: Record<string, string>;
  enabled: boolean;
  has_secret: boolean;
  status: string;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface PermissionCatalog {
  roles: Record<string, string[]>;
  permissions: Record<string, string>;
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface IntegrationStatus {
  kind: string;
  status: string;
  last_checked_at?: string | null;
  last_error?: string | null;
}

export interface IntegrationCredential {
  id: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

export const getUsers = () => jsonRequest<UserProfile[]>("/admin/users");
export const getPermissions = () => jsonRequest<PermissionCatalog>("/admin/permissions");
export const getAudit = () => jsonRequest<AuditEntry[]>("/admin/audit?limit=100");
export const getIntegrations = () => jsonRequest<IntegrationConfig[]>("/admin/integrations");
export const getIntegrationStatuses = () => jsonRequest<IntegrationStatus[]>("/admin/integrations/status");
export const getOperationalIntegrationStatuses = () => jsonRequest<IntegrationStatus[]>("/integrations/status");

export function saveUser(user: Partial<UserProfile> & Pick<UserProfile, "email" | "display_name" | "roles" | "permissions">) {
  return jsonRequest<UserProfile>(user.id ? `/admin/users/${encodeURIComponent(user.id)}` : "/admin/users", {
    method: user.id ? "PUT" : "POST",
    body: JSON.stringify({ email: user.email, display_name: user.display_name, roles: user.roles, permissions: user.permissions }),
  });
}

export const deactivateUser = (id: string) => jsonRequest<{ ok: boolean; active: boolean }>(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });

export function saveIntegration(config: Partial<IntegrationConfig> & Pick<IntegrationConfig, "kind" | "name" | "endpoint_url" | "method" | "lookup_parameter" | "field_map" | "enabled"> & { secret?: string }) {
  const body = {
    kind: config.kind,
    name: config.name,
    endpoint_url: config.endpoint_url,
    method: config.method,
    lookup_parameter: config.lookup_parameter,
    field_map: config.field_map,
    enabled: config.enabled,
    ...(config.secret ? { secret: config.secret } : {}),
  };
  return jsonRequest<IntegrationConfig>(config.id ? `/admin/integrations/${encodeURIComponent(config.id)}` : "/admin/integrations", {
    method: config.id ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
}

export const disableIntegration = (id: string) => jsonRequest<{ ok: boolean }>(`/admin/integrations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testIntegration = (id: string) => jsonRequest<{ status: string; last_checked_at: string; message: string | null }>(`/admin/integrations/${encodeURIComponent(id)}/test`, { method: "POST" });
export const issueCredential = (id: string) => jsonRequest<{ id: string; token: string; shown_once: boolean }>(`/admin/integrations/${encodeURIComponent(id)}/credentials`, { method: "POST" });
export const getCredentials = (id: string) => jsonRequest<IntegrationCredential[]>(`/admin/integrations/${encodeURIComponent(id)}/credentials`);
export const revokeCredential = (integrationId: string, credentialId: string) => jsonRequest<{ ok: boolean }>(`/admin/integrations/${encodeURIComponent(integrationId)}/credentials/${encodeURIComponent(credentialId)}`, { method: "DELETE" });

export function reviewClassification(eventId: string, index: number, relation: string, reason: string) {
  return jsonRequest(`/ingresos/${encodeURIComponent(eventId)}/clasificaciones/${index}/revision`, {
    method: "POST",
    body: JSON.stringify({ relation, reason }),
  });
}
