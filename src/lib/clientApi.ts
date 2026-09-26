const rawConfiguredApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
const configuredApiBase = rawConfiguredApiBase?.replace(/\/+$/, "") ?? "";
const productionApiBase = import.meta.env.PROD ? "/api" : "";
// Keep local development cookies and requests on the browser's origin through Vite.
const localProxy = import.meta.env.DEV && (!configuredApiBase || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configuredApiBase));
const apiBase = localProxy ? "" : rawConfiguredApiBase === "/" ? "" : configuredApiBase || productionApiBase;
let csrfToken = "";

export const SESSION_EXPIRED_EVENT = "vigilia:session-expired";

export const apiConfigured = localProxy || Boolean(apiBase) || !import.meta.env.DEV;
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
  try {
    return await fetch(apiUrl(path), { ...init, headers, credentials: "include" });
  } catch (error) {
    if (error instanceof TypeError) throw new Error("No se pudo conectar con Vigilia. Revisa tu conexión y vuelve a intentarlo.");
    throw error;
  }
}

export async function parseApiError(response: Response): Promise<Error> {
  const payload: unknown = await response.json().catch(() => ({}));
  const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
    ? payload.detail
    : "";
  if (response.status === 401) {
    // App vuelve a la pantalla de acceso si había una sesión abierta.
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    return new Error("La sesión terminó. Inicia sesión otra vez.");
  }
  if (response.status === 403) return new Error(detail || "No tienes permiso para esta operación.");
  if (response.status === 409) return new Error(detail || "El registro cambió. Actualiza la página e inténtalo otra vez.");
  if (response.status === 429) return new Error(detail || "Se alcanzó el límite de solicitudes. Espera un momento.");
  // Los 422 del contrato genérico no explican nada; los de reglas propias (p. ej. contraseñas) sí.
  if (response.status === 422) return new Error(detail && detail !== "La solicitud no cumple el contrato configurado." ? detail : "Hay datos incompletos o con un formato incorrecto. Revisa los campos e inténtalo de nuevo.");
  // FastAPI responde "Not Found" cuando la ruta no existe o la función API no se desplegó.
  if (response.status === 404 && (!detail || detail === "Not Found")) return new Error("La API desplegada no encontró esta ruta. Confirma que el backend de Vigilia esté desplegado y actualizado.");
  if (response.status === 503 && detail) return new Error(detail);
  if ([502, 503, 504].includes(response.status)) return new Error("Vigilia no está disponible en este momento. Espera unos segundos y vuelve a intentarlo.");
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
    auth_method: "oidc" | "totp" | "password" | "demo";
    employee_id?: string;
    id: string;
    email: string;
    display_name: string;
    roles: string[];
    permissions: string[];
    /** Contraseña temporal pendiente de cambio: la app solo permite cambiarla o salir. */
    must_change_password?: boolean;
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

export async function changePassword(currentPassword: string, newPassword: string): Promise<CurrentSession> {
  const session = await jsonRequest<CurrentSession>("/auth/password", {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  setCsrfToken(session.csrf_token);
  return session;
}
