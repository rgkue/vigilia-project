import { jsonRequest } from "./clientApi";

export interface AIProvider { id: string; name: string; auth_modes: string[] }
export interface AIConfig {
  provider: string; model: string; auth_mode: string; has_secret: boolean;
  revision: string; status: "untested" | "verified" | "failed"; updated_at: string;
}
export interface AISettings {
  providers: AIProvider[]; configs: AIConfig[]; selected: string;
  can_manage_integrations: boolean; production_allowed: boolean;
}
export interface AIProviderTestCase {
  id: string; label: string; motive: string; condition: string;
  expected: string; actual: string; justification: string; valid: boolean;
  /** Coincide con la etiqueta de referencia; es orientativo y no mide precisión clínica. */
  match?: boolean;
}
const path = (id: string) => `/me/ai/providers/${encodeURIComponent(id)}`;
export const getAISettings = () => jsonRequest<AISettings>("/me/ai");
export const saveAIProvider = (id: string, body: {
  model: string; auth_mode: string; secret?: string; clear_secret: boolean; revision: string | null;
}) => jsonRequest<AIConfig>(path(id), { method: "PUT", body: JSON.stringify(body) });
export const getAIModels = (id: string) => jsonRequest<{ models: string[] }>(`${path(id)}/models`);
export const testAIProvider = (id: string, revision: string) => jsonRequest<{ ok: boolean; message: string; cases: AIProviderTestCase[] }>(`${path(id)}/test`, {
  method: "POST", body: JSON.stringify({ revision }),
});
export const selectAIProvider = (provider: string, revision?: string) => jsonRequest<{ selected: string }>("/me/ai/selection", {
  method: "PUT", body: JSON.stringify({ provider, revision }),
});
