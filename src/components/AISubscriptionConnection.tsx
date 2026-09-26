import { useEffect, useState } from "react";
import { jsonRequest } from "../lib/clientApi";

interface State { status: string; available: boolean; flow_id: string | null; authorization: { url: string; method: string; instructions: string } | null }
const LABELS: Record<string, string> = { disconnected: "Sin conectar", starting: "Iniciando autorización", pending: "Esperando autorización", completing: "Esperando al proveedor", connected: "Suscripción conectada", expired: "Autorización caducada", failed: "No se completó la conexión" };

export function AISubscriptionConnection({ provider, revision, disabled, onRefresh }: { provider: string; revision?: string; disabled: boolean; onRefresh: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/me/ai/subscriptions/${encodeURIComponent(provider)}`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    async function poll() {
      try {
        const next = await jsonRequest<State>(path, { cache: "no-store" });
        if (!active) return;
        setState(next);
        if (previous && previous !== next.status) await onRefresh();
        previous = next.status;
      } catch (err) { if (active) setError(err instanceof Error ? err.message : "No se pudo consultar la conexión."); }
      if (active) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
    // Refresh callback only updates the parent snapshot; do not restart an authorization poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); setState(await jsonRequest<State>(path, { cache: "no-store" })); await onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "No se pudo completar la conexión."); }
    finally { setBusy(false); }
  }
  const pending = ["starting", "pending", "completing"].includes(state?.status ?? "");
  return <section className="aiSubscription" aria-label="Conexión por suscripción" aria-busy={busy}>
    <strong>{LABELS[state?.status ?? ""] ?? "Consultando conexión…"}</strong>
    <p className="adminHelp">Esta conexión pertenece a tu cuenta de Vigilia. Puedes desconectarla cuando quieras.</p>
    {state && !state.available && <p className="adminNotice">El administrador debe iniciar el conector de suscripciones. Consulta la guía de configuración del servidor.</p>}
    {error && <p className="adminNotice error" role="alert">{error}</p>}
    {state?.authorization && <div className="aiAuthorization">
      <a className="secondaryButton" href={state.authorization.url} target="_blank" rel="noopener noreferrer">Autorizar en {provider === "openai" ? "ChatGPT" : "SuperGrok"}</a>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{state.authorization.instructions}</p>
      {state.authorization.method === "code" && state.status === "pending" && <>
        <label className="adminField"><span>Código de autorización</span><input type="password" autoComplete="off" value={code} maxLength={4096} onChange={(e) => setCode(e.target.value)} /></label>
        <button type="button" className="secondaryButton" disabled={busy || !code.trim()} onClick={() => void action(async () => { await jsonRequest(path + "/complete", { method: "POST", body: JSON.stringify({ flow_id: state.flow_id, code }) }); setCode(""); })}>Completar autorización</button>
      </>}
    </div>}
    <div className="adminFormActions">
      <button type="button" className="secondaryButton" disabled={disabled || busy || !revision || !state?.available || pending || state.status === "connected"} onClick={() => void action(async () => { await jsonRequest(path + "/login", { method: "POST", body: JSON.stringify({ revision }) }); })}>Conectar {provider === "openai" ? "ChatGPT / Codex" : "SuperGrok"}</button>
      <button type="button" className="adminTextButton" disabled={busy || !state || state.status === "disconnected"} onClick={() => void action(async () => { const result = await jsonRequest<{ remote_removed: boolean }>(path, { method: "DELETE" }); setCode(""); if (!result.remote_removed) setError("Acceso desactivado en Vigilia. El conector no respondió: elimina también la sesión del proveedor cuando vuelva a estar disponible."); })}>{pending ? "Cancelar autorización" : "Desconectar"}</button>
    </div>
    {disabled && <p className="adminHelp">Guarda los cambios antes de iniciar la autorización.</p>}
  </section>;
}
