const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
let csrfToken = "";

export const apiConfigured = Boolean(apiBase) || !import.meta.env.DEV;
export const apiUrl = (path: string) => `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;

export function setCsrfToken(value: string) {
  csrfToken = value;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return fetch(apiUrl(path), { ...init, headers, credentials: "include" });
}

export async function parseApiError(response: Response): Promise<Error> {
  const payload: unknown = await response.json().catch(() => ({}));
  const detail = payload && typeof payload === "object" && "detail" in payload
    ? String((payload as { detail?: unknown }).detail ?? "")
    : "";
  if (response.status === 401) return new Error("La sesión terminó. Inicia sesión otra vez.");
  if (response.status === 403) return new Error(detail || "No tienes permiso para esta operación.");
  if (response.status === 409) return new Error(detail || "El registro cambió. Actualiza la página e inténtalo otra vez.");
  if (response.status === 429) return new Error("Se alcanzó el límite de solicitudes. Espera un momento.");
  return new Error(detail || (response.status >= 500 ? "El servicio tuvo un problema." : "No se pudo completar la operación."));
}

export async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await apiFetch(path, {
    ...init,
    headers,
  });
  if (!response.ok) throw await parseApiError(response);
  return response.json() as Promise<T>;
}

export interface CurrentSession {
  user: {
    id: string;
    email: string;
    display_name: string;
    roles: string[];
    permissions: string[];
  };
  csrf_token: string;
  mode: "demo" | "production";
}

export async function getSession(): Promise<CurrentSession> {
  const response = await apiFetch("/auth/me");
  if (!response.ok) throw await parseApiError(response);
  const session = await response.json() as CurrentSession;
  setCsrfToken(session.csrf_token);
  return session;
}

export async function getPublicConfig(): Promise<{ mode: "demo" | "production"; demo_enabled: boolean }> {
  const response = await apiFetch("/public-config");
  if (!response.ok) throw await parseApiError(response);
  return response.json();
}

export async function logoutSession(): Promise<void> {
  await jsonRequest<{ ok: boolean }>("/auth/logout", { method: "POST", body: "{}" });
  setCsrfToken("");
}
