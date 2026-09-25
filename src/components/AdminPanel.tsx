import { useEffect, useState, type FormEvent } from "react";
import {
  deactivateUser,
  disableIntegration,
  getAudit,
  getCredentials,
  getIntegrationStatuses,
  getIntegrations,
  getPermissions,
  getUsers,
  issueCredential,
  revokeCredential,
  saveIntegration,
  saveUser,
  testIntegration,
  type AuditEntry,
  type IntegrationConfig,
  type IntegrationCredential,
  type IntegrationStatus,
  type PermissionCatalog,
  type UserProfile,
} from "../lib/adminApi";

type AdminTab = "users" | "integrations" | "audit";
type IntegrationKind = IntegrationConfig["kind"];
type IntegrationDraft = Pick<IntegrationConfig, "kind" | "name" | "endpoint_url" | "method" | "lookup_parameter" | "field_map" | "enabled"> & { secret: string; has_secret: boolean };

const KIND_LABELS: Record<IntegrationKind, string> = {
  ingress: "Ingreso del hospital",
  coverage: "Cobertura y póliza",
  history: "Antecedentes autorizados",
  admissions: "Avisos a admisiones",
  case_manager: "Avisos al gestor de casos",
};
const ROLE_LABELS: Record<string, string> = {
  administrador: "Administrador",
  operador: "Operador",
  revisor: "Revisor",
  auditor: "Auditor",
};
const EMPTY_CATALOG: PermissionCatalog = { roles: {}, permissions: {} };

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
  if (!value) return "Aún no se ha probado";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Fecha no disponible" : new Intl.DateTimeFormat("es-PA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function blankUser(): Pick<UserProfile, "email" | "display_name" | "roles" | "permissions"> {
  return { email: "", display_name: "", roles: ["operador"], permissions: ["ingress.submit", "ingress.read"] };
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

export function AdminPanel({ permissions }: { permissions: string[] }) {
  const canUsers = permissions.includes("users.manage");
  const canIntegrations = permissions.includes("integrations.manage");
  const canAudit = permissions.includes("audit.read");
  const availableTabs: AdminTab[] = [
    ...(canUsers ? ["users" as const] : []),
    ...(canIntegrations ? ["integrations" as const] : []),
    ...(canAudit ? ["audit" as const] : []),
  ];
  const [tab, setTab] = useState<AdminTab>(availableTabs[0] ?? "users");
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog>(EMPTY_CATALOG);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [credentials, setCredentials] = useState<Record<string, IntegrationCredential[]>>({});
  const [statuses, setStatuses] = useState<IntegrationStatus[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [userForm, setUserForm] = useState(blankUser());
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [integrationForm, setIntegrationForm] = useState<IntegrationDraft>(blankIntegration());
  const [selectedIntegration, setSelectedIntegration] = useState<string | null>(null);
  const [mappingText, setMappingText] = useState(JSON.stringify(blankIntegration().field_map, null, 2));
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const requests: Promise<void>[] = [];
      if (canUsers) requests.push(Promise.all([getUsers(), getPermissions()]).then(([nextUsers, nextCatalog]) => {
        setUsers(nextUsers);
        setCatalog(nextCatalog);
      }));
      if (canIntegrations) requests.push(Promise.all([getIntegrations(), getIntegrationStatuses()]).then(async ([nextIntegrations, nextStatuses]) => {
        setIntegrations(nextIntegrations);
        setStatuses(nextStatuses);
        const ingress = nextIntegrations.filter((item) => item.kind === "ingress");
        const nextCredentials = await Promise.all(ingress.map(async (item) => [item.id, await getCredentials(item.id)] as const));
        setCredentials(Object.fromEntries(nextCredentials));
      }));
      if (canAudit) requests.push(getAudit().then(setAudit));
      await Promise.all(requests);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [permissions.join("|")]);

  function editUser(user: UserProfile) {
    setSelectedUser(user.id);
    setUserForm({ email: user.email, display_name: user.display_name, roles: [...user.roles], permissions: [...user.permissions] });
    setMessage("");
  }

  function newUser() {
    setSelectedUser(null);
    setUserForm(blankUser());
    setMessage("");
  }

  function toggleRole(role: string, checked: boolean) {
    setUserForm((current) => {
      const oldBundle = new Set(current.roles.flatMap((item) => catalog.roles[item] ?? []));
      const roles = checked ? [...current.roles, role] : current.roles.filter((item) => item !== role);
      const newBundle = new Set(roles.flatMap((item) => catalog.roles[item] ?? []));
      const manual = current.permissions.filter((permission) => !oldBundle.has(permission));
      return { ...current, roles, permissions: [...new Set([...newBundle, ...manual])] };
    });
  }

  async function submitUser(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await saveUser({ ...userForm, ...(selectedUser ? { id: selectedUser } : {}) });
      setMessage(selectedUser ? "Perfil actualizado." : "Perfil creado. La persona podrá iniciar sesión cuando su cuenta exista en el IdP del cliente.");
      setSelectedUser(null);
      setUserForm(blankUser());
      await refresh();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function disableSelectedUser(user: UserProfile) {
    setWorking(true);
    setError("");
    try {
      await deactivateUser(user.id);
      setMessage(`Acceso desactivado para ${user.display_name}. La auditoría se conserva.`);
      if (selectedUser === user.id) newUser();
      await refresh();
    } catch (disableError) {
      setError(errorText(disableError));
    } finally {
      setWorking(false);
    }
  }

  function editIntegration(config: IntegrationConfig) {
    setSelectedIntegration(config.id);
    setIntegrationForm({ ...config, secret: "" });
    setMappingText(JSON.stringify(config.field_map, null, 2));
    setOneTimeToken("");
    setMessage("");
  }

  function newIntegration(kind: IntegrationKind = "coverage") {
    setSelectedIntegration(null);
    const next = blankIntegration(kind);
    setIntegrationForm(next);
    setMappingText(JSON.stringify(next.field_map, null, 2));
    setOneTimeToken("");
  }

  async function submitIntegration(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const field_map = JSON.parse(mappingText) as Record<string, string>;
      const saved = await saveIntegration({ ...integrationForm, field_map, ...(selectedIntegration ? { id: selectedIntegration } : {}) });
      setSelectedIntegration(saved.id);
      setMessage("Integración guardada. Prueba la conexión antes de habilitar el flujo.");
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof SyntaxError ? "El mapeo debe ser un objeto JSON válido." : errorText(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function runTest(id: string) {
    setWorking(true);
    setError("");
    try {
      const result = await testIntegration(id);
      setMessage(result.message || `Conexión ${statusLabel(result.status).toLowerCase()}.`);
      await refresh();
    } catch (testError) {
      setError(errorText(testError));
    } finally {
      setWorking(false);
    }
  }

  async function rotateCredential(id: string) {
    setWorking(true);
    setError("");
    setOneTimeToken("");
    try {
      const result = await issueCredential(id);
      setOneTimeToken(result.token);
      setMessage("Guarda esta credencial ahora. Solo se muestra una vez; la credencial anterior quedó revocada.");
      await refresh();
    } catch (issueError) {
      setError(errorText(issueError));
    } finally {
      setWorking(false);
    }
  }

  async function revokeIngressCredential(integrationId: string, credentialId: string) {
    setWorking(true);
    setError("");
    try {
      await revokeCredential(integrationId, credentialId);
      setOneTimeToken("");
      setMessage("Credencial revocada. Los eventos nuevos de esa integración serán rechazados.");
      await refresh();
    } catch (revokeError) {
      setError(errorText(revokeError));
    } finally {
      setWorking(false);
    }
  }

  async function turnOffIntegration(id: string) {
    setWorking(true);
    setError("");
    try {
      await disableIntegration(id);
      setMessage("Integración desactivada; las credenciales de entrada ya no autorizan eventos.");
      await refresh();
    } catch (disableError) {
      setError(errorText(disableError));
    } finally {
      setWorking(false);
    }
  }

  const statusFor = (kind: string) => statuses.find((item) => item.kind === kind);

  return (
    <div className="clientPageStack adminPage">
      <header className="pageIntro clientPageIntro">
        <span className="eyebrow">CONFIGURACIÓN DEL CLIENTE</span>
        <h1>Administración</h1>
        <p>Controla quién puede usar Vigilia y qué sistemas están conectados en esta instalación.</p>
      </header>

      {canIntegrations && <section className="adminStatusRail" aria-label="Estado de las integraciones">
        <article><span className="eyebrow">VIGILIA</span><strong>API activa</strong><small>El servicio puede responder</small></article>
        {(["ingress", "coverage", "history", "admissions", "case_manager"] as IntegrationKind[]).map((kind) => {
          const status = statusFor(kind);
          return <article key={kind}><span className="eyebrow">{KIND_LABELS[kind]}</span><strong className={`connectorStatus ${status?.status ?? "not_configured"}`}>{statusLabel(status?.status ?? "not_configured")}</strong><small>{formatTime(status?.last_checked_at)}</small></article>;
        })}
      </section>}

      <nav className="adminTabs" aria-label="Secciones de administración">
        {availableTabs.map((item) => (
          <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "users" ? "Usuarios y permisos" : item === "integrations" ? "Integraciones" : "Auditoría"}
          </button>
        ))}
        <button className="adminRefresh" type="button" onClick={() => void refresh()} disabled={loading || working}>Actualizar</button>
      </nav>

      {(error || message) && <div className={error ? "adminNotice error" : "adminNotice"} role={error ? "alert" : "status"}>{error || message}</div>}
      {loading ? <div className="adminEmpty">Cargando configuración…</div> : (
        <>
          {tab === "users" && canUsers && (
            <section className="adminWorkspace">
              <div className="adminCollection glassPanel">
                <div className="adminSectionHead"><div><span className="eyebrow">ACCESO</span><h2>Personas autorizadas</h2></div><button className="secondaryButton" type="button" onClick={newUser}>Añadir persona</button></div>
                <p className="adminHelp">La persona debe existir en el proveedor de identidad del cliente. Vigilia administra sus permisos y conserva el historial al desactivar el acceso.</p>
                <div className="adminList">
                  {users.map((user) => (
                    <article className={`adminListItem${selectedUser === user.id ? " selected" : ""}`} key={user.id}>
                      <button type="button" className="adminItemMain" onClick={() => editUser(user)}>
                        <span className="adminAvatar">{user.display_name.slice(0, 1).toUpperCase()}</span>
                        <span><strong>{user.display_name}</strong><small>{user.email} · {user.roles.map((role) => ROLE_LABELS[role] ?? role).join(", ") || "Sin rol"}</small></span>
                      </button>
                      <span className={`adminAccountState${user.active ? " active" : ""}`}>{user.active ? user.identity_linked ? "Activo" : "Pendiente de primer acceso" : "Desactivado"}</span>
                      {user.active && user.id !== "demo-admin" && <button type="button" className="adminTextButton" onClick={() => void disableSelectedUser(user)} disabled={working}>Desactivar</button>}
                    </article>
                  ))}
                  {users.length === 0 && <p className="adminEmpty">Aún no hay perfiles. Añade a la primera persona autorizada.</p>}
                </div>
              </div>
              <form className="adminEditor glassPanel" onSubmit={submitUser}>
                <div className="adminSectionHead"><div><span className="eyebrow">PERFIL DE ACCESO</span><h2>{selectedUser ? "Editar persona" : "Nueva persona"}</h2></div></div>
                <label className="adminField"><span>Correo del IdP</span><input required type="email" maxLength={254} value={userForm.email} disabled={Boolean(selectedUser && users.find((user) => user.id === selectedUser)?.identity_linked)} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} /></label>
                <label className="adminField"><span>Nombre para mostrar</span><input required maxLength={160} value={userForm.display_name} onChange={(event) => setUserForm({ ...userForm, display_name: event.target.value })} /></label>
                <fieldset className="adminChoices"><legend>Roles</legend>{Object.keys(catalog.roles).map((role) => <label key={role}><input type="checkbox" checked={userForm.roles.includes(role)} onChange={(event) => toggleRole(role, event.target.checked)} /><span><strong>{ROLE_LABELS[role] ?? role}</strong><small>Al seleccionar, propone los permisos predeterminados del rol.</small></span></label>)}</fieldset>
                <fieldset className="adminChoices"><legend>Permisos asignados</legend>{Object.entries(catalog.permissions).map(([permission, label]) => <label key={permission}><input type="checkbox" checked={userForm.permissions.includes(permission)} onChange={(event) => setUserForm({ ...userForm, permissions: event.target.checked ? [...userForm.permissions, permission] : userForm.permissions.filter((item) => item !== permission) })} /><span><strong>{label}</strong><small>{permission}</small></span></label>)}</fieldset>
                <div className="adminFormActions"><button className="primaryButton" type="submit" disabled={working}>{working ? "Guardando…" : "Guardar perfil"}</button>{selectedUser && <button className="secondaryButton" type="button" onClick={newUser}>Cancelar</button>}</div>
              </form>
            </section>
          )}

          {tab === "integrations" && canIntegrations && (
            <section className="adminWorkspace integrationWorkspace">
              <div className="adminCollection glassPanel">
                <div className="adminSectionHead"><div><span className="eyebrow">SISTEMAS DEL CLIENTE</span><h2>Conexiones configuradas</h2></div></div>
                <p className="adminHelp">Prueba cada endpoint antes de habilitarlo. Los secretos se guardan cifrados en el backend y nunca vuelven al navegador.</p>
                <div className="adminList">
                  {integrations.map((item) => (
                    <article className={`adminListItem${selectedIntegration === item.id ? " selected" : ""}`} key={item.id}>
                      <button type="button" className="adminItemMain" onClick={() => editIntegration(item)}>
                        <span className="connectorGlyph">{item.kind === "coverage" ? "P" : item.kind === "history" ? "H" : item.kind === "ingress" ? "I" : "↗"}</span>
                        <span><strong>{item.name}</strong><small>{KIND_LABELS[item.kind]} · {item.endpoint_url}</small></span>
                      </button>
                      <span className={`adminAccountState${item.enabled ? " active" : ""}`}>{statusLabel(item.status)}</span>
                      <div className="adminRowActions"><button type="button" className="adminTextButton" onClick={() => void runTest(item.id)} disabled={working}>Probar</button><button type="button" className="adminTextButton" onClick={() => void turnOffIntegration(item.id)} disabled={working}>Desactivar</button></div>
                    </article>
                  ))}
                  {integrations.length === 0 && <p className="adminEmpty">Aún no hay conexiones. Añade una fuente para comenzar.</p>}
                </div>
                <div className="adminKindButtons">{(["ingress", "coverage", "history", "admissions", "case_manager"] as IntegrationKind[]).map((kind) => <button key={kind} type="button" className="secondaryButton" onClick={() => newIntegration(kind)}>+ {KIND_LABELS[kind]}</button>)}</div>
              </div>
              <form className="adminEditor glassPanel" onSubmit={submitIntegration}>
                <div className="adminSectionHead"><div><span className="eyebrow">CONECTOR REST</span><h2>{selectedIntegration ? "Editar conexión" : "Configurar conexión"}</h2></div></div>
                <label className="adminField"><span>Tipo de sistema</span><select value={integrationForm.kind} onChange={(event) => { const kind = event.target.value as IntegrationKind; const base = blankIntegration(kind); setIntegrationForm({ ...integrationForm, ...base }); setMappingText(JSON.stringify(base.field_map, null, 2)); }}><option value="ingress">Ingreso del hospital</option><option value="coverage">Cobertura y póliza</option><option value="history">Antecedentes autorizados</option><option value="admissions">Avisos a admisiones</option><option value="case_manager">Avisos al gestor de casos</option></select></label>
                <label className="adminField"><span>Nombre</span><input required maxLength={100} value={integrationForm.name} onChange={(event) => setIntegrationForm({ ...integrationForm, name: event.target.value })} /></label>
                <label className="adminField"><span>Endpoint HTTPS</span><input required type="url" placeholder="https://sistema.cliente.pa/api/…" value={integrationForm.endpoint_url} onChange={(event) => setIntegrationForm({ ...integrationForm, endpoint_url: event.target.value })} /></label>
                {integrationForm.kind === "ingress" && <p className="adminHelp">Vigilia recibe eventos en <code>/webhook/ingreso</code>. Este endpoint identifica al sistema emisor y no se invoca desde Vigilia.</p>}
                <div className="adminFieldGrid"><label className="adminField"><span>Método</span><select value={integrationForm.method} onChange={(event) => setIntegrationForm({ ...integrationForm, method: event.target.value as "GET" | "POST" })}><option>GET</option><option>POST</option></select></label><label className="adminField"><span>Campo de consulta</span><input value={integrationForm.lookup_parameter} onChange={(event) => setIntegrationForm({ ...integrationForm, lookup_parameter: event.target.value })} /></label></div>
                <label className="adminField"><span>Token de acceso <small>{integrationForm.has_secret ? "· guardado; vacío conserva el actual" : "· opcional"}</small></span><input type="password" autoComplete="new-password" maxLength={4096} value={integrationForm.secret} onChange={(event) => setIntegrationForm({ ...integrationForm, secret: event.target.value })} placeholder={integrationForm.has_secret ? "Credencial guardada" : "Pega el token del sistema"} /></label>
                <label className="adminField"><span>Mapeo JSON de campos</span><textarea className="mappingEditor" spellCheck={false} rows={8} value={mappingText} onChange={(event) => setMappingText(event.target.value)} /></label>
                <label className="adminToggle"><input type="checkbox" checked={integrationForm.enabled} onChange={(event) => setIntegrationForm({ ...integrationForm, enabled: event.target.checked })} /><span><strong>Habilitar esta integración</strong><small>Una conexión habilitada puede procesar datos del flujo.</small></span></label>
                <div className="adminFormActions"><button className="primaryButton" type="submit" disabled={working}>{working ? "Guardando…" : "Guardar conexión"}</button>{selectedIntegration && integrationForm.kind === "ingress" && <button className="secondaryButton" type="button" onClick={() => void rotateCredential(selectedIntegration)} disabled={working}>Rotar credencial de ingreso</button>}{selectedIntegration && <button className="secondaryButton" type="button" onClick={() => newIntegration()} disabled={working}>Nueva conexión</button>}</div>
                {selectedIntegration && integrationForm.kind === "ingress" && <div className="credentialList">
                  <span className="eyebrow">CREDENCIALES DEL WEBHOOK</span>
                  <div className="credentialRow"><code>{selectedIntegration}</code><span>ID para el encabezado X-Vigilia-Integration</span></div>
                  {(credentials[selectedIntegration] ?? []).map((credential) => <div className="credentialRow" key={credential.id}>
                    <code>{credential.id.slice(0, 10)}…</code><span>{credential.active ? "Activa" : "Revocada"}</span>
                    {credential.active && <button type="button" className="adminTextButton" onClick={() => void revokeIngressCredential(selectedIntegration, credential.id)} disabled={working}>Revocar</button>}
                  </div>)}
                  {(credentials[selectedIntegration] ?? []).filter((item) => item.active).length === 0 && <small>No hay credenciales activas.</small>}
                </div>}
                {oneTimeToken && <div className="oneTimeToken"><span>Credencial de ingreso · se muestra una vez</span><code>{oneTimeToken}</code></div>}
              </form>
            </section>
          )}

          {tab === "audit" && canAudit && (
            <section className="adminCollection glassPanel auditCollection">
              <div className="adminSectionHead"><div><span className="eyebrow">TRAZABILIDAD</span><h2>Actividad administrativa</h2></div></div>
              <p className="adminHelp">El registro conserva quién cambió accesos y conexiones y quién resolvió una revisión. No incluye credenciales ni texto clínico.</p>
              <div className="auditTableWrap"><table className="auditTable"><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Recurso</th></tr></thead><tbody>{audit.map((entry) => <tr key={entry.id}><td>{formatTime(entry.created_at)}</td><td><code>{entry.actor_id ?? "sistema"}</code></td><td>{entry.action}</td><td>{entry.resource_type}{entry.resource_id ? ` · ${entry.resource_id}` : ""}</td></tr>)}</tbody></table>{audit.length === 0 && <p className="adminEmpty">Las acciones administrativas aparecerán aquí.</p>}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
