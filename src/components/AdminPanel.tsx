import { useEffect, useState, type FormEvent } from "react";
import { PeoplePanel } from "./PeoplePanel";
import { CopyButton } from "./CopyButton";
import { useConfirm } from "./Dialogs";
import { Icon } from "./Icon";
import { Select } from "./Pickers";
import { useToast } from "./Toast";
import {
  disableIntegration,
  getAudit,
  getCredentials,
  getIntegrationStatuses,
  getIntegrations,
  getUsers,
  issueCredential,
  revokeCredential,
  saveIntegration,
  testIntegration,
  type AuditEntry,
  type IntegrationConfig,
  type IntegrationCredential,
  type IntegrationStatus,
} from "../lib/adminApi";
import { getLocalAccounts } from "../lib/adminApi";
import { AUDIT_ACTION_GROUPS, auditActionLabel, formatDate } from "../lib/labels";

export type AdminTab = "people" | "integrations" | "audit";
/** Rutas de la interfaz; /admin/* pertenece a la API y no se usa para páginas. */
export const ADMIN_BASE = "/administracion";
export const ADMIN_TAB_PATHS: Record<AdminTab, string> = { people: "personas", integrations: "integraciones", audit: "auditoria" };
/** Direcciones anteriores que siguen llevando a Personas. */
export const ADMIN_LEGACY_PATHS: Record<string, AdminTab> = { usuarios: "people", empleados: "people" };
const TAB_LABELS: Record<AdminTab, string> = { people: "Personas", integrations: "Integraciones", audit: "Auditoría" };

type IntegrationKind = IntegrationConfig["kind"];
type IntegrationDraft = Pick<IntegrationConfig, "kind" | "name" | "endpoint_url" | "method" | "lookup_parameter" | "field_map" | "enabled"> & { secret: string; has_secret: boolean };
type MappingRow = { key: string; path: string };

const KIND_LABELS: Record<IntegrationKind, string> = {
  ingress: "Ingreso del hospital",
  coverage: "Cobertura y póliza",
  history: "Antecedentes autorizados",
  admissions: "Avisos a admisiones",
  case_manager: "Avisos al gestor de casos",
};
const KINDS = Object.keys(KIND_LABELS) as IntegrationKind[];
const AUDIT_PAGE = 50;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la operación.";
}

function statusLabel(status: string) {
  switch (status) {
    case "connected": return "Conectada";
    case "unavailable": return "Sin respuesta";
    case "invalid_response": return "Respuesta inválida";
    case "not_found": return "Sin registro";
    case "pending": return "Sin probar";
    default: return "Sin configurar";
  }
}

function formatTime(value?: string | null) {
  return value ? formatDate(value) : "Aún no se ha probado";
}

function blankIntegration(kind: IntegrationKind = "coverage"): IntegrationDraft {
  const field_map: Record<string, string> = kind === "ingress"
    ? { evento_id: "id", cedula: "patient.id", hospital: "hospital.name", motivo_ingreso: "reason", fecha_ingreso: "created_at" }
    : kind === "coverage"
      ? { numero: "policy.number", plan: "policy.plan", vigente_desde: "policy.start_date", vigente_hasta: "policy.end_date", estado_pago: "policy.payment_status", carencia_dias: "policy.waiting_days" }
      : kind === "history"
        ? { items: "conditions", condition: "name", date: "diagnosed_at" }
        : {};
  return { kind, name: KIND_LABELS[kind], endpoint_url: "", method: kind === "ingress" ? "POST" : "GET", lookup_parameter: "cedula", field_map, enabled: false, secret: "", has_secret: false };
}

const rowsFromMap = (map: Record<string, string>): MappingRow[] => Object.entries(map).map(([key, path]) => ({ key, path }));

function mapFromRows(rows: MappingRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.path.trim()) continue;
    if (!key || !row.path.trim()) throw new Error("Cada fila del mapeo necesita un campo de Vigilia y una ruta del sistema.");
    if (key in result) throw new Error(`El campo “${key}” aparece dos veces en el mapeo.`);
    result[key] = row.path.trim();
  }
  return result;
}

function parseMappingJson(text: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("El mapeo debe ser un objeto JSON válido."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error("El mapeo JSON debe ser un objeto con valores de texto.");
  }
  return value as Record<string, string>;
}

export function AdminPanel({ permissions, tab, onTabChange, backendOnline }: { permissions: string[]; tab: AdminTab; onTabChange: (tab: AdminTab) => void; backendOnline: boolean }) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const canUsers = permissions.includes("users.manage");
  const canIntegrations = permissions.includes("integrations.manage");
  const canAudit = permissions.includes("audit.read");
  const availableTabs: AdminTab[] = [
    ...(canUsers ? ["people" as const] : []),
    ...(canIntegrations ? ["integrations" as const] : []),
    ...(canAudit ? ["audit" as const] : []),
  ];
  // Solo para mostrar nombres en la auditoría; el directorio vive en PeoplePanel.
  const [peopleNames, setPeopleNames] = useState<Map<string, string>>(new Map());
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [credentials, setCredentials] = useState<Record<string, IntegrationCredential[]>>({});
  const [statuses, setStatuses] = useState<IntegrationStatus[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditAction, setAuditAction] = useState("");
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [integrationForm, setIntegrationForm] = useState<IntegrationDraft>(blankIntegration());
  const [selectedIntegration, setSelectedIntegration] = useState<string | null>(null);
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(rowsFromMap(blankIntegration().field_map));
  const [mappingJson, setMappingJson] = useState<string | null>(null);
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setLoadError("");
    try {
      const requests: Promise<void>[] = [];
      if (canUsers) requests.push(Promise.all([getUsers(), getLocalAccounts()]).then(([nextUsers, nextAccounts]) => {
        setPeopleNames(new Map([...nextUsers.map((user) => [user.id, user.display_name] as const), ...nextAccounts.map((account) => [account.id, account.display_name] as const)]));
      }));
      if (canIntegrations) requests.push(Promise.all([getIntegrations(), getIntegrationStatuses()]).then(async ([nextIntegrations, nextStatuses]) => {
        setIntegrations(nextIntegrations);
        setStatuses(nextStatuses);
        const ingress = nextIntegrations.filter((item) => item.kind === "ingress");
        const nextCredentials = await Promise.all(ingress.map(async (item) => [item.id, await getCredentials(item.id)] as const));
        setCredentials(Object.fromEntries(nextCredentials));
      }));
      await Promise.all(requests);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadAudit(append: boolean) {
    if (!canAudit) return;
    setAuditLoading(true);
    try {
      const page = await getAudit({ limit: AUDIT_PAGE, offset: append ? audit.length : 0, action: auditAction });
      setAudit((current) => append ? [...current, ...page] : page);
      setAuditHasMore(page.length === AUDIT_PAGE);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [permissions.join("|")]);
  useEffect(() => { if (tab === "audit") void loadAudit(false); }, [tab, auditAction]);

  // ---------- Integraciones ----------
  function loadMapping(map: Record<string, string>) {
    setMappingRows(rowsFromMap(map));
    setMappingJson(null);
  }

  function editIntegration(config: IntegrationConfig) {
    setSelectedIntegration(config.id);
    setIntegrationForm({ ...config, secret: "" });
    loadMapping(config.field_map);
    setOneTimeToken("");
  }

  function newIntegration(kind: IntegrationKind = "coverage") {
    setSelectedIntegration(null);
    const next = blankIntegration(kind);
    setIntegrationForm(next);
    loadMapping(next.field_map);
    setOneTimeToken("");
  }

  function toggleJsonEditor() {
    try {
      if (mappingJson === null) {
        setMappingJson(JSON.stringify(mapFromRows(mappingRows), null, 2));
      } else {
        setMappingRows(rowsFromMap(parseMappingJson(mappingJson)));
        setMappingJson(null);
      }
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function submitIntegration(event: FormEvent) {
    event.preventDefault();
    let field_map: Record<string, string>;
    try {
      field_map = mappingJson === null ? mapFromRows(mappingRows) : parseMappingJson(mappingJson);
    } catch (error) {
      toast.error(errorText(error));
      return;
    }
    setSaving(true);
    try {
      const saved = await saveIntegration({ ...integrationForm, field_map, ...(selectedIntegration ? { id: selectedIntegration } : {}) });
      setSelectedIntegration(saved.id);
      setIntegrationForm((current) => ({ ...current, secret: "", has_secret: saved.has_secret }));
      toast.success("Integración guardada. Prueba la conexión antes de habilitar el flujo.");
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function runTest(id: string) {
    setRowBusy(id);
    try {
      const result = await testIntegration(id);
      const text = result.message || `Conexión: ${statusLabel(result.status).toLowerCase()}.`;
      if (result.status === "connected") toast.success(text);
      else toast.error(text);
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setRowBusy(null);
    }
  }

  function askRotateCredential(id: string) {
    confirm({
      title: "Emitir una credencial nueva",
      body: <p>La credencial de ingreso actual <strong>deja de funcionar al instante</strong>. El sistema del hospital rechazará eventos hasta que configures la nueva, que se muestra una sola vez.</p>,
      confirmLabel: "Rotar credencial",
    }, async () => {
      setRowBusy(id);
      setOneTimeToken("");
      try {
        const result = await issueCredential(id);
        setOneTimeToken(result.token);
        toast.success("Credencial emitida. Cópiala ahora: solo se muestra una vez.");
        await refresh();
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        setRowBusy(null);
      }
    });
  }

  function askRevokeCredential(integrationId: string, credentialId: string) {
    confirm({
      title: "Revocar credencial de ingreso",
      body: <p>Los eventos nuevos que usen esta credencial serán rechazados de inmediato. Esta acción no se puede deshacer.</p>,
      confirmLabel: "Revocar credencial",
    }, async () => {
      setRowBusy(credentialId);
      try {
        await revokeCredential(integrationId, credentialId);
        setOneTimeToken("");
        toast.success("Credencial revocada.");
        await refresh();
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        setRowBusy(null);
      }
    });
  }

  function askDisableIntegration(item: IntegrationConfig) {
    confirm({
      title: `Desactivar “${item.name}”`,
      body: <p>Vigilia dejará de usar esta conexión y sus credenciales de entrada ya no autorizarán eventos. Podrás volver a habilitarla desde el editor.</p>,
      confirmLabel: "Desactivar integración",
    }, async () => {
      setRowBusy(item.id);
      try {
        await disableIntegration(item.id);
        toast.success("Integración desactivada.");
        await refresh();
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        setRowBusy(null);
      }
    });
  }

  const statusFor = (kind: string) => statuses.find((item) => item.kind === kind);
  const userNames = peopleNames;

  return (
    <div className="clientPageStack adminPage">
      {dialog}
      <header className="pageIntro clientPageIntro">
        <span className="eyebrow">CONFIGURACIÓN DEL CLIENTE</span>
        <h1>Administración</h1>
        <p>Controla quién puede usar Vigilia y qué sistemas están conectados en esta instalación.</p>
      </header>

      {canIntegrations && <section className="adminStatusRail" aria-label="Estado de las integraciones">
        <article><span className="eyebrow">VIGILIA</span><strong className={`connectorStatus ${backendOnline ? "connected" : "unavailable"}`}>{backendOnline ? "API activa" : "Sin respuesta"}</strong><small>Servicio de esta instalación</small></article>
        {KINDS.map((kind) => {
          const status = statusFor(kind);
          return <article key={kind}><span className="eyebrow">{KIND_LABELS[kind]}</span><strong className={`connectorStatus ${status?.status ?? "not_configured"}`}>{statusLabel(status?.status ?? "not_configured")}</strong><small>{formatTime(status?.last_checked_at)}</small></article>;
        })}
      </section>}

      <nav className="adminTabs" aria-label="Secciones de administración">
        {availableTabs.map((item) => (
          <a key={item} href={`${ADMIN_BASE}/${ADMIN_TAB_PATHS[item]}`} className={tab === item ? "active" : ""} aria-current={tab === item ? "page" : undefined} onClick={(event) => { event.preventDefault(); onTabChange(item); }}>
            {TAB_LABELS[item]}
          </a>
        ))}
        <button className="adminRefresh" type="button" onClick={() => void (tab === "audit" ? loadAudit(false) : refresh())} disabled={loading || saving}><Icon name="refresh" size={13} />Actualizar</button>
      </nav>

      {loadError && <div className="adminNotice error" role="alert">{loadError}</div>}
      {loading && tab !== "people" && tab !== "audit" ? <div className="adminEmpty" role="status">Cargando configuración…</div> : (
        <>
          {tab === "people" && canUsers && <PeoplePanel />}

          {tab === "integrations" && canIntegrations && (
            <section className="adminWorkspace integrationWorkspace">
              <div className="adminCollection glassPanel">
                <div className="adminSectionHead"><div><span className="eyebrow">SISTEMAS DEL CLIENTE</span><h2>Conexiones configuradas</h2></div></div>
                <p className="adminHelp">Prueba cada endpoint antes de habilitarlo. Los secretos se guardan cifrados en el backend y nunca vuelven al navegador.</p>
                <div className="adminList">
                  {integrations.map((item) => (
                    <article className={`adminListItem${selectedIntegration === item.id ? " selected" : ""}`} key={item.id} aria-busy={rowBusy === item.id}>
                      <button type="button" className="adminItemMain" onClick={() => editIntegration(item)}>
                        <span className="connectorGlyph">{item.kind === "coverage" ? "P" : item.kind === "history" ? "H" : item.kind === "ingress" ? "I" : "↗"}</span>
                        <span><strong>{item.name}</strong><small>{KIND_LABELS[item.kind]} · {item.endpoint_url}</small></span>
                      </button>
                      <span className={`adminAccountState${item.enabled ? " active" : ""}`}>{item.enabled ? statusLabel(item.status) : "Desactivada"}</span>
                      <div className="adminRowActions">
                        <button type="button" className="adminTextButton" onClick={() => void runTest(item.id)} disabled={rowBusy === item.id}>{rowBusy === item.id ? "Probando…" : "Probar"}</button>
                        {item.enabled && <button type="button" className="adminTextButton" onClick={() => askDisableIntegration(item)} disabled={rowBusy === item.id}>Desactivar</button>}
                      </div>
                    </article>
                  ))}
                  {integrations.length === 0 && <p className="adminEmpty">Aún no hay conexiones. Añade una fuente para comenzar.</p>}
                </div>
                <div className="adminKindButtons">{KINDS.map((kind) => <button key={kind} type="button" className="secondaryButton" onClick={() => newIntegration(kind)}>+ {KIND_LABELS[kind]}</button>)}</div>
              </div>
              <form className="adminEditor glassPanel" onSubmit={submitIntegration}>
                <div className="adminSectionHead"><div><span className="eyebrow">CONECTOR REST</span><h2>{selectedIntegration ? "Editar conexión" : "Configurar conexión"}</h2></div></div>
                <label className="adminField"><span>Tipo de sistema</span><Select value={integrationForm.kind} onChange={(value) => { const kind = value as IntegrationKind; const base = blankIntegration(kind); setIntegrationForm({ ...integrationForm, ...base }); loadMapping(base.field_map); }} options={KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))} /></label>
                <label className="adminField"><span>Nombre</span><input autoComplete="off" required maxLength={100} value={integrationForm.name} onChange={(event) => setIntegrationForm({ ...integrationForm, name: event.target.value })} /></label>
                <label className="adminField"><span>Endpoint HTTPS</span><input autoComplete="off" required type="url" placeholder="https://sistema.cliente.pa/api/…" value={integrationForm.endpoint_url} onChange={(event) => setIntegrationForm({ ...integrationForm, endpoint_url: event.target.value })} /></label>
                {integrationForm.kind === "ingress" && <p className="adminHelp">Vigilia recibe eventos en <code>/webhook/ingreso</code>. Este endpoint identifica al sistema emisor y no se invoca desde Vigilia.</p>}
                <div className="adminFieldGrid"><label className="adminField"><span>Método</span><Select value={integrationForm.method} onChange={(method) => setIntegrationForm({ ...integrationForm, method: method as "GET" | "POST" })} options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }]} /></label><label className="adminField"><span>Campo de consulta</span><input autoComplete="off" value={integrationForm.lookup_parameter} onChange={(event) => setIntegrationForm({ ...integrationForm, lookup_parameter: event.target.value })} /></label></div>
                <label className="adminField"><span>Token de acceso <small>{integrationForm.has_secret ? "· guardado; vacío conserva el actual" : "· opcional"}</small></span><input type="password" autoComplete="new-password" maxLength={4096} value={integrationForm.secret} onChange={(event) => setIntegrationForm({ ...integrationForm, secret: event.target.value })} placeholder={integrationForm.has_secret ? "Credencial guardada" : "Pega el token del sistema"} /></label>

                <fieldset className="mappingFieldset">
                  <legend>Mapeo de campos</legend>
                  <p className="adminHelp">Relaciona cada campo de Vigilia con la ruta del dato en la respuesta del sistema (por ejemplo <code>policy.number</code>).</p>
                  {mappingJson === null ? <>
                    <div className="mappingRows">
                      {mappingRows.length > 0 && <div className="mappingHead" aria-hidden="true"><span>Campo de Vigilia</span><span>Ruta en el sistema</span></div>}
                      {mappingRows.map((row, index) => (
                        <div className="mappingRow" key={index}>
                          <input autoComplete="off" aria-label={`Campo de Vigilia ${index + 1}`} value={row.key} onChange={(event) => setMappingRows((rows) => rows.map((item, position) => position === index ? { ...item, key: event.target.value } : item))} />
                          <input autoComplete="off" aria-label={`Ruta en el sistema ${index + 1}`} value={row.path} onChange={(event) => setMappingRows((rows) => rows.map((item, position) => position === index ? { ...item, path: event.target.value } : item))} />
                          <button type="button" className="adminTextButton" aria-label={`Quitar fila ${index + 1}`} onClick={() => setMappingRows((rows) => rows.filter((_, position) => position !== index))}><Icon name="close" size={14} /></button>
                        </div>
                      ))}
                      {mappingRows.length === 0 && <p className="adminEmpty">Este tipo de sistema no requiere mapeo.</p>}
                    </div>
                    <div className="adminFormActions"><button type="button" className="secondaryButton" onClick={() => setMappingRows((rows) => [...rows, { key: "", path: "" }])}>Añadir campo</button><button type="button" className="adminTextButton" onClick={toggleJsonEditor}>Editar JSON (avanzado)</button></div>
                  </> : <>
                    <label className="adminField"><span>Mapeo JSON</span><textarea className="mappingEditor" spellCheck={false} rows={8} value={mappingJson} onChange={(event) => setMappingJson(event.target.value)} /></label>
                    <div className="adminFormActions"><button type="button" className="adminTextButton" onClick={toggleJsonEditor}>Volver al editor por filas</button></div>
                  </>}
                </fieldset>

                <label className="adminToggle"><input type="checkbox" checked={integrationForm.enabled} onChange={(event) => setIntegrationForm({ ...integrationForm, enabled: event.target.checked })} /><span><strong>Habilitar esta integración</strong><small>Una conexión habilitada puede procesar datos del flujo.</small></span></label>
                <div className="adminFormActions">
                  <button className="primaryButton" type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar conexión"}</button>
                  {selectedIntegration && integrationForm.kind === "ingress" && <button className="secondaryButton" type="button" onClick={() => askRotateCredential(selectedIntegration)} disabled={rowBusy === selectedIntegration}>Rotar credencial de ingreso</button>}
                  {selectedIntegration && <button className="secondaryButton" type="button" onClick={() => newIntegration()} disabled={saving}>Nueva conexión</button>}
                </div>
                {selectedIntegration && integrationForm.kind === "ingress" && <div className="credentialList">
                  <span className="eyebrow">CREDENCIALES DEL WEBHOOK</span>
                  <div className="credentialRow"><code>{selectedIntegration}</code><span>ID para el encabezado X-Vigilia-Integration</span><CopyButton value={selectedIntegration} label="Copiar ID" compact /></div>
                  {(credentials[selectedIntegration] ?? []).map((credential) => <div className="credentialRow" key={credential.id}>
                    <code>{credential.id.slice(0, 10)}…</code><span>{credential.active ? `Activa · emitida ${formatDate(credential.created_at)}` : `Revocada · ${formatDate(credential.revoked_at)}`}</span>
                    {credential.active && <button type="button" className="adminTextButton" onClick={() => askRevokeCredential(selectedIntegration, credential.id)} disabled={rowBusy === credential.id}>{rowBusy === credential.id ? "Revocando…" : "Revocar"}</button>}
                  </div>)}
                  {(credentials[selectedIntegration] ?? []).filter((item) => item.active).length === 0 && <small>No hay credenciales activas.</small>}
                </div>}
                {oneTimeToken && <div className="oneTimeToken" role="status">
                  <span>Credencial de ingreso · se muestra una sola vez</span>
                  <code>{oneTimeToken}</code>
                  <div className="adminFormActions"><CopyButton value={oneTimeToken} label="Copiar credencial" /><button type="button" className="adminTextButton" onClick={() => setOneTimeToken("")}>Ya la guardé, ocultar</button></div>
                </div>}
              </form>
            </section>
          )}

          {tab === "audit" && canAudit && (
            <section className="adminCollection glassPanel auditCollection">
              <div className="adminSectionHead"><div><span className="eyebrow">TRAZABILIDAD</span><h2>Actividad administrativa</h2></div>
                <label className="toolbarSelect"><span className="srOnly">Tipo de acción</span><Select value={auditAction} onChange={setAuditAction} options={AUDIT_ACTION_GROUPS} /></label>
              </div>
              <p className="adminHelp">El registro conserva quién cambió accesos y conexiones y quién resolvió una revisión. No incluye credenciales ni texto clínico.</p>
              <div className="auditTableWrap"><table className="auditTable"><thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Recurso</th></tr></thead><tbody>{audit.map((entry) => <tr key={entry.id}>
                <td>{formatDate(entry.created_at)}</td>
                <td title={entry.actor_id ?? undefined}>{entry.actor_id ? userNames.get(entry.actor_id) ?? <code>{entry.actor_id.length > 14 ? `${entry.actor_id.slice(0, 12)}…` : entry.actor_id}</code> : "Sistema"}</td>
                <td title={entry.action}>{auditActionLabel(entry.action)}</td>
                <td>{entry.resource_type}{entry.resource_id ? <> · <code>{entry.resource_id.length > 18 ? `${entry.resource_id.slice(0, 16)}…` : entry.resource_id}</code></> : ""}</td>
              </tr>)}</tbody></table>
                {audit.length === 0 && <p className="adminEmpty">{auditLoading ? "Cargando auditoría…" : "No hay acciones registradas con este filtro."}</p>}
              </div>
              {auditHasMore && <div className="activityMore"><span>Mostrando {audit.length} acciones</span><button className="secondaryButton" type="button" onClick={() => void loadAudit(true)} disabled={auditLoading}>{auditLoading ? "Cargando…" : "Cargar más"}</button></div>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
