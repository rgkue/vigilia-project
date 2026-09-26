import { useEffect, useState } from "react";
import { jsonRequest } from "../lib/clientApi";

type Assignment = { integration_id: string; name: string; status: string; revision: string };
type Integration = { id: string; name: string; user_id: string | null; status: string | null; revision: string | null };
type Overview = { integrations: Integration[]; users: { id: string; display_name: string }[] };
const labels: Record<string, string> = { pending: "Pendiente de tu autorización", accepted: "Autorizada", revoked: "Revocada", withdrawn: "Asignación retirada" };

export function AIAssignments({ canManage }: { canManage: boolean }) {
  const [mine, setMine] = useState<Assignment[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const personal = await jsonRequest<{ assignments: Assignment[] }>("/me/ai/assignments");
    setMine(personal.assignments);
    if (canManage) {
      const value = await jsonRequest<Overview>("/admin/ai/assignments");
      setOverview(value);
      setChoices(Object.fromEntries(value.integrations.map(item => [item.id, item.user_id ?? ""])));
    }
  }
  useEffect(() => {
    let active = true;
    Promise.all([
      jsonRequest<{ assignments: Assignment[] }>("/me/ai/assignments"),
      canManage ? jsonRequest<Overview>("/admin/ai/assignments") : Promise.resolve(null),
    ]).then(([personal, management]) => {
      if (!active) return;
      setMine(personal.assignments); setOverview(management);
      if (management) setChoices(Object.fromEntries(management.integrations.map(item => [item.id, item.user_id ?? ""])));
    }).catch(err => { if (active) setError(err instanceof Error ? err.message : "No se pudieron cargar las asignaciones."); });
    return () => { active = false; };
  }, [canManage]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "No se pudo actualizar la asignación."); }
    finally { setBusy(false); }
  }
  return <section className="aiAssignments glassPanel" aria-label="Autorizaciones de ingresos automáticos" aria-busy={busy}>
    <h2>Ingresos automáticos</h2>
    <p className="adminHelp">Puedes autorizar que una integración del hospital use tu proveedor activo, incluso cuando no tengas Vigilia abierta. Consumirá la cuota de tu cuenta. Revocar detiene los nuevos envíos; las solicitudes ya enviadas pueden terminar.</p>
    {error && <p className="adminNotice error" role="alert">{error} <button className="adminTextButton" type="button" disabled={busy} onClick={() => void act(refresh)}>Actualizar</button></p>}
    {!mine.length && <p className="adminHelp">No tienes integraciones asignadas. Los ingresos que registres manualmente usarán tu proveedor personal.</p>}
    {mine.map(item => <div className="aiAssignmentRow" key={item.integration_id}>
      <div><strong>{item.name}</strong><p className="adminHelp">{labels[item.status] ?? item.status}</p></div>
      <div className="adminFormActions">
        {["pending", "revoked"].includes(item.status) && <button className="secondaryButton" disabled={busy} onClick={() => void act(() => jsonRequest(`/me/ai/assignments/${encodeURIComponent(item.integration_id)}`, { method: "PUT", body: JSON.stringify({ accept: true, revision: item.revision }) }))}>Autorizar uso de mi cuenta</button>}
        {!["revoked", "withdrawn"].includes(item.status) && <button className="adminTextButton" disabled={busy} onClick={() => void act(() => jsonRequest(`/me/ai/assignments/${encodeURIComponent(item.integration_id)}`, { method: "PUT", body: JSON.stringify({ accept: false, revision: item.revision }) }))}>{item.status === "pending" ? "Rechazar" : "Revocar autorización"}</button>}
      </div>
    </div>)}
    {canManage && <details className="aiAuthHelp"><summary>Asignar responsables de integraciones</summary>
      <p className="adminHelp">Propón una cuenta para cada integración. La persona tendrá que aceptar desde su configuración antes de que se utilice su proveedor.</p>
      {!overview?.integrations.length && <p className="adminHelp">Crea una integración de ingreso en Administración para asignarle una cuenta responsable.</p>}
      {overview?.integrations.map(item => <div className="aiAssignmentRow" key={item.id}>
        <label className="adminField"><span>{item.name} · {item.status === "accepted" ? "Autorizada" : item.status === "pending" ? "Esperando consentimiento" : "Sin autorización"}</span>
          <select disabled={busy} value={choices[item.id] ?? ""} onChange={event => setChoices(previous => ({ ...previous, [item.id]: event.target.value }))}>
            <option value="">Selecciona una persona</option>
            {overview.users.map(user => <option value={user.id} key={user.id}>{user.display_name || user.id}</option>)}
          </select>
        </label>
        <div className="adminFormActions">
          <button className="secondaryButton" disabled={busy || !choices[item.id]} onClick={() => void act(() => jsonRequest(`/admin/ai/assignments/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({ user_id: choices[item.id], revision: item.revision }) }))}>Solicitar autorización</button>
          {item.status && item.status !== "revoked" && <button className="adminTextButton" disabled={busy} onClick={() => void act(() => jsonRequest(`/admin/ai/assignments/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({ user_id: null, revision: item.revision }) }))}>Revocar asignación</button>}
        </div>
      </div>)}
    </details>}
  </section>;
}
