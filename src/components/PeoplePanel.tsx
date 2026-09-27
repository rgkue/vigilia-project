import { useEffect, useMemo, useState, type FormEvent } from "react";
import { QRCard } from "./AuthQR";
import { CopyButton } from "./CopyButton";
import { Sheet, useConfirm } from "./Dialogs";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import {
  createLocalAccount,
  deactivateUser,
  getLocalAccounts,
  getPermissions,
  getUsers,
  issueLocalTotp,
  issueTemporaryPassword,
  saveUser,
  updateLocalAccount,
  type LocalAccount,
  type PermissionCatalog,
  type UserProfile,
} from "../lib/adminApi";
import { jsonRequest } from "../lib/clientApi";
import { ROLE_LABELS } from "../lib/labels";

type AccessKind = "local" | "corporate";
type Selection = { kind: AccessKind; id: string | null };
type Person =
  | { kind: "local"; id: string; name: string; detail: string; active: boolean; roles: string[]; account: LocalAccount }
  | { kind: "corporate"; id: string; name: string; detail: string; active: boolean; roles: string[]; user: UserProfile };
type Draft = { name: string; accountId: string; email: string; roles: string[]; permissions: string[] };

const BASIC_PERMISSIONS = new Set(["ingress.read", "ingress.submit"]);
const EMPTY_CATALOG: PermissionCatalog = { roles: {}, permissions: {} };
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,40}$/;

const needsPassword = (permissions: string[]) => permissions.some((permission) => !BASIC_PERMISSIONS.has(permission));

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la operación.";
}

function blankDraft(kind: AccessKind, catalog: PermissionCatalog): Draft {
  const roles = kind === "local" ? ["recepcionista"] : ["operador"];
  const permissions = [...new Set(roles.flatMap((role) => catalog.roles[role] ?? []))];
  return { name: "", accountId: "", email: "", roles, permissions: permissions.length ? permissions : ["ingress.read", "ingress.submit"] };
}

/** Directorio único de personas: cuentas de Vigilia (ID + código, y contraseña si administran) y cuentas corporativas (OIDC). */
export function PeoplePanel() {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog>(EMPTY_CATALOG);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "local", id: null });
  const [draft, setDraft] = useState<Draft>(blankDraft("local", EMPTY_CATALOG));
  const [idError, setIdError] = useState("");
  const [saving, setSaving] = useState(false);
  const [enrollment, setEnrollment] = useState<{ name: string; accountId: string; uri: string; secret: string } | null>(null);
  const [temporary, setTemporary] = useState<{ name: string; accountId: string; password: string } | null>(null);

  async function refresh() {
    const [nextAccounts, nextUsers, nextCatalog, options] = await Promise.all([
      getLocalAccounts(),
      getUsers(),
      getPermissions(),
      jsonRequest<{ oidc_enabled?: boolean }>("/auth/options", { cache: "no-store" }).catch(() => ({ oidc_enabled: false })),
    ]);
    setAccounts(nextAccounts);
    setUsers(nextUsers);
    setCatalog(nextCatalog);
    setOidcEnabled(Boolean(options.oidc_enabled));
    return { nextAccounts, nextUsers, nextCatalog };
  }

  useEffect(() => {
    refresh()
      .then(({ nextCatalog }) => { setDraft(blankDraft("local", nextCatalog)); setLoadError(""); })
      .catch((reason: unknown) => setLoadError(errorText(reason)))
      .finally(() => setLoading(false));
  }, []);

  const people = useMemo<Person[]>(() => [
    ...accounts.map((account): Person => ({ kind: "local", id: account.id, name: account.display_name, detail: account.employee_id, active: account.active, roles: account.roles, account })),
    ...users.map((user): Person => ({ kind: "corporate", id: user.id, name: user.display_name, detail: user.email, active: user.active, roles: user.roles, user })),
  ].sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, "es")), [accounts, users]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? people.filter((person) => `${person.name} ${person.detail} ${person.roles.map((role) => ROLE_LABELS[role] ?? role).join(" ")}`.toLowerCase().includes(term)) : people;
  }, [people, query]);

  const selectedAccount = selection.kind === "local" && selection.id ? accounts.find((account) => account.id === selection.id) ?? null : null;
  const selectedUser = selection.kind === "corporate" && selection.id ? users.find((user) => user.id === selection.id) ?? null : null;
  const isNew = selection.id === null;

  function select(person: Person) {
    setSelection({ kind: person.kind, id: person.id });
    setIdError("");
    setDraft(person.kind === "local"
      ? { name: person.account.display_name, accountId: person.account.employee_id, email: "", roles: [...person.account.roles], permissions: [...person.account.permissions] }
      : { name: person.user.display_name, accountId: "", email: person.user.email, roles: [...person.user.roles], permissions: [...person.user.permissions] });
  }

  function startNew(kind: AccessKind) {
    setSelection({ kind, id: null });
    setIdError("");
    setDraft(blankDraft(kind, catalog));
  }

  function toggleRole(role: string, checked: boolean) {
    setDraft((current) => {
      const oldBundle = new Set(current.roles.flatMap((item) => catalog.roles[item] ?? []));
      const roles = checked ? [...current.roles, role] : current.roles.filter((item) => item !== role);
      const newBundle = new Set(roles.flatMap((item) => catalog.roles[item] ?? []));
      const manual = current.permissions.filter((permission) => !oldBundle.has(permission));
      return { ...current, roles, permissions: [...new Set([...newBundle, ...manual])] };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (selection.kind === "local" && isNew && !ACCOUNT_ID.test(draft.accountId.trim())) {
      setIdError("Usa hasta 40 letras, números o guiones, sin espacios.");
      document.getElementById("person-account-id")?.focus();
      return;
    }
    setSaving(true);
    try {
      if (selection.kind === "local") {
        const body = { display_name: draft.name.trim(), roles: draft.roles, permissions: draft.permissions };
        if (selectedAccount) {
          await updateLocalAccount(selectedAccount.id, { ...body, active: selectedAccount.active });
          toast.success("Cuenta actualizada. Si cambiaron sus permisos, deberá volver a iniciar sesión.");
          await refresh();
        } else {
          const created = await createLocalAccount({ ...body, employee_id: draft.accountId.trim() });
          const { nextAccounts } = await refresh();
          const fresh = nextAccounts.find((account) => account.id === created.id) ?? created;
          select({ kind: "local", id: fresh.id, name: fresh.display_name, detail: fresh.employee_id, active: fresh.active, roles: fresh.roles, account: fresh });
          toast.success(fresh.requires_password
            ? "Cuenta creada. Configura su autenticador y genera una contraseña temporal para habilitar el acceso."
            : "Cuenta creada. Configura su autenticador para habilitar el acceso.");
        }
      } else {
        const saved = await saveUser({ ...(selectedUser ? { id: selectedUser.id } : {}), email: draft.email, display_name: draft.name, roles: draft.roles, permissions: draft.permissions });
        const { nextUsers } = await refresh();
        const fresh = nextUsers.find((user) => user.id === saved.id) ?? saved;
        select({ kind: "corporate", id: fresh.id, name: fresh.display_name, detail: fresh.email, active: fresh.active, roles: fresh.roles, user: fresh });
        toast.success(selectedUser ? "Perfil actualizado." : "Perfil creado. La persona podrá entrar cuando su cuenta exista en el proveedor de identidad.");
      }
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setSaving(true);
    try { await action(); await refresh(); }
    catch (error) { toast.error(errorText(error)); }
    finally { setSaving(false); }
  }

  function askConfigureTotp(account: LocalAccount) {
    const configure = () => run(async () => {
      const result = await issueLocalTotp(account.id);
      setEnrollment({ ...result, name: account.display_name, accountId: account.employee_id });
    });
    if (!account.totp_configured) { void configure(); return; }
    confirm({
      title: "Reemplazar autenticador",
      body: <p>Se revocan los códigos y las sesiones actuales de <strong>{account.display_name}</strong>. Hazlo solo después de verificar su identidad y entrega la nueva configuración en persona.</p>,
      confirmLabel: "Reemplazar autenticador",
    }, configure);
  }

  function askTemporaryPassword(account: LocalAccount) {
    const issue = () => run(async () => {
      const result = await issueTemporaryPassword(account.id);
      setTemporary({ name: account.display_name, accountId: account.employee_id, password: result.temporary_password });
    });
    if (!account.password_set) { void issue(); return; }
    confirm({
      title: "Restablecer contraseña",
      body: <p>La contraseña actual de <strong>{account.display_name}</strong> deja de funcionar y se cierran sus sesiones. Tendrá que crear una nueva en su próximo acceso.</p>,
      confirmLabel: "Generar contraseña temporal",
    }, issue);
  }

  function askToggleLocal(account: LocalAccount) {
    const toggle = () => run(async () => {
      await updateLocalAccount(account.id, { display_name: account.display_name, active: !account.active });
      toast.success(account.active ? "Cuenta desactivada. Sus sesiones ya no permiten acceso." : "Cuenta reactivada. Deberá iniciar sesión de nuevo.");
    });
    if (!account.active) { void toggle(); return; }
    confirm({
      title: `Desactivar a ${account.display_name}`,
      body: <p>Se cerrarán sus sesiones abiertas y no podrá entrar con su gafete, su contraseña ni su código. El historial y la auditoría se conservan.</p>,
      confirmLabel: "Desactivar cuenta",
    }, toggle);
  }

  function askDeactivateCorporate(user: UserProfile) {
    confirm({
      title: `Desactivar a ${user.display_name}`,
      body: <p>La persona perderá el acceso a Vigilia en su próxima solicitud. Su historial y la auditoría se conservan; podrás volver a darle acceso editando su perfil.</p>,
      confirmLabel: "Desactivar acceso",
    }, () => run(async () => {
      await deactivateUser(user.id);
      toast.success(`Acceso desactivado para ${user.display_name}.`);
    }));
  }

  const draftNeedsPassword = selection.kind === "local" && needsPassword(draft.permissions);
  const canCreateCorporate = oidcEnabled;
  const title = isNew ? (selection.kind === "local" ? "Nueva cuenta de Vigilia" : "Nueva cuenta corporativa") : draft.name || "Persona";

  return (
    <section className="adminWorkspace peopleWorkspace">
      {dialog}
      <div className="adminCollection glassPanel">
        <div className="adminSectionHead">
          <div><span className="eyebrow">ACCESO</span><h2>Personas</h2></div>
          <button className="secondaryButton" type="button" onClick={() => startNew("local")}>Añadir persona</button>
        </div>
        <p className="adminHelp">Las cuentas de Vigilia entran con su gafete o ID y el código de su app autenticadora; las que administran también usan contraseña.{canCreateCorporate ? " Las cuentas corporativas entran con el proveedor de identidad de tu organización." : ""}</p>
        <label className="toolbarSearch adminSearch"><Icon name="search" size={15} /><span className="srOnly">Buscar personas</span><input autoComplete="off" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, ID, correo o rol" /></label>
        {loadError && <p className="adminNotice error" role="alert">{loadError}</p>}
        <div className="adminList">
          {visible.map((person) => (
            <article className={`adminListItem${selection.kind === person.kind && selection.id === person.id ? " selected" : ""}`} key={`${person.kind}-${person.id}`}>
              <button type="button" className="adminItemMain" onClick={() => select(person)}>
                <span className="adminAvatar">{person.name.slice(0, 1).toUpperCase() || "·"}</span>
                <span><strong>{person.name}</strong><small>{person.detail}</small></span>
              </button>
              <span className="roleChips">
                <span className="roleChip muted">{person.kind === "local" ? "Cuenta de Vigilia" : person.id === "demo-admin" ? "Demo" : "Corporativa"}</span>
                {person.roles.map((role) => <span className="roleChip" key={role}>{ROLE_LABELS[role] ?? role}</span>)}
                {person.kind === "local" && person.active && !person.account.totp_configured && <span className="roleChip warn">Autenticador pendiente</span>}
                {person.kind === "local" && person.active && person.account.requires_password && !person.account.password_set && <span className="roleChip warn">Contraseña pendiente</span>}
              </span>
              <span className={`adminAccountState${person.active ? " active" : ""}`}>{person.active ? "Activa" : "Desactivada"}</span>
            </article>
          ))}
          {loading && <p className="adminEmpty" role="status">Cargando personas…</p>}
          {!loading && people.length === 0 && <p className="adminEmpty">Todavía no hay personas registradas.</p>}
          {!loading && people.length > 0 && visible.length === 0 && <p className="adminEmpty">Nadie coincide con “{query}”.</p>}
        </div>
      </div>

      <form className="adminEditor glassPanel" onSubmit={(event) => void save(event)}>
        <div className="adminSectionHead">
          <div><span className="eyebrow">{selection.kind === "local" ? "CUENTA DE VIGILIA" : "CUENTA CORPORATIVA"}</span><h2>{title}</h2></div>
          {!isNew && <span className={`adminAccountState${(selectedAccount ?? selectedUser)?.active ? " active" : ""}`}>{(selectedAccount ?? selectedUser)?.active ? "Activa" : "Desactivada"}</span>}
        </div>

        {isNew && canCreateCorporate && <div className="accessKindSwitch" role="group" aria-label="Tipo de cuenta">
          <button type="button" aria-pressed={selection.kind === "local"} onClick={() => startNew("local")}>Cuenta de Vigilia</button>
          <button type="button" aria-pressed={selection.kind === "corporate"} onClick={() => startNew("corporate")}>Cuenta corporativa</button>
        </div>}

        {selection.kind === "local" && (isNew
          ? <label className="adminField"><span>ID de acceso o cédula</span><input autoComplete="off" id="person-account-id" required maxLength={40} aria-invalid={Boolean(idError)} aria-describedby={idError ? "person-account-id-error" : undefined} value={draft.accountId} onChange={(event) => { setDraft({ ...draft, accountId: event.target.value }); setIdError(""); }} placeholder="EMP-REC-002" />{idError && <span id="person-account-id-error" className="fieldError" role="alert">{idError}</span>}</label>
          : <div className="adminField"><span>ID de acceso</span><div className="readonlyValue"><code>{draft.accountId}</code><CopyButton value={draft.accountId} label="Copiar ID" compact /></div><small>El ID no se puede cambiar una vez creado.</small></div>)}
        {selection.kind === "corporate" && <label className="adminField"><span>Correo del proveedor de identidad</span><input autoComplete="off" required type="email" maxLength={254} value={draft.email} disabled={Boolean(selectedUser?.identity_linked)} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>}
        <label className="adminField"><span>Nombre completo</span><input autoComplete="off" required maxLength={160} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>

        <fieldset className="adminChoices"><legend>Roles</legend>{Object.keys(catalog.roles).map((role) => <label key={role}><input type="checkbox" checked={draft.roles.includes(role)} onChange={(event) => toggleRole(role, event.target.checked)} /><span><strong>{ROLE_LABELS[role] ?? role}</strong><small>{role === "recepcionista" ? "Registrar y consultar ingresos. Entra solo con gafete o ID y código." : role === "configurador_ia" ? "Gestionar proveedores y modelos de IA sin acceso al resto de la administración." : "Al seleccionar, propone los permisos predeterminados del rol."}</small></span></label>)}</fieldset>
        <fieldset className="adminChoices"><legend>Permisos asignados</legend>{Object.entries(catalog.permissions).map(([permission, label]) => <label key={permission} title={permission}><input type="checkbox" checked={draft.permissions.includes(permission)} onChange={(event) => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, permission] : draft.permissions.filter((item) => item !== permission) })} /><span><strong>{label}</strong></span></label>)}</fieldset>
        {draftNeedsPassword && <p className="adminNotice">Con estos permisos, la cuenta entrará con ID, contraseña y código de su app autenticadora.</p>}

        <div className="adminFormActions">
          <button className="primaryButton" type="submit" disabled={saving || !draft.name.trim() || (selection.kind === "corporate" && !draft.email.trim())}>{saving ? "Guardando…" : isNew ? "Crear cuenta" : "Guardar cambios"}</button>
          {!isNew && <button className="secondaryButton" type="button" onClick={() => startNew("local")} disabled={saving}>Cancelar</button>}
        </div>

        {selectedAccount && <>
          <section className="editorSection">
            <span className="eyebrow">AUTENTICADOR</span>
            <p className="adminHelp">{selectedAccount.totp_configured ? "Configurado. Reemplazarlo revoca los códigos y sesiones anteriores." : "Pendiente. La persona no podrá entrar hasta configurar su app autenticadora."}</p>
            <button className="secondaryButton" type="button" disabled={saving || !selectedAccount.active} onClick={() => askConfigureTotp(selectedAccount)}><Icon name="key" size={15} />{selectedAccount.totp_configured ? "Reemplazar autenticador" : "Configurar autenticador"}</button>
          </section>
          {selectedAccount.requires_password && <section className="editorSection">
            <span className="eyebrow">CONTRASEÑA</span>
            <p className="adminHelp">{!selectedAccount.password_set ? "Pendiente. Genera una contraseña temporal y entrégala en persona." : selectedAccount.must_change_password ? "Temporal: la persona debe cambiarla en su próximo acceso." : "Asignada por la persona. Si la olvida, genera una temporal nueva."}</p>
            <button className="secondaryButton" type="button" disabled={saving || !selectedAccount.active} onClick={() => askTemporaryPassword(selectedAccount)}>{selectedAccount.password_set ? "Restablecer contraseña" : "Generar contraseña temporal"}</button>
          </section>}
          <section className="editorSection">
            <span className="eyebrow">GAFETE</span>
            <p className="adminHelp">El gafete solo identifica a la persona; siempre se pide además el código{selectedAccount.requires_password ? " y la contraseña" : ""}. Puedes imprimirlo.</p>
            <QRCard value={selectedAccount.badge} label={`Gafete · ${selectedAccount.employee_id}`} download />
          </section>
          <section className="editorSection">
            <span className="eyebrow">ESTADO DEL ACCESO</span>
            <button className="secondaryButton" type="button" disabled={saving} onClick={() => askToggleLocal(selectedAccount)}>{selectedAccount.active ? "Desactivar cuenta" : "Reactivar cuenta"}</button>
          </section>
        </>}

        {selectedUser && <>
          {selectedUser.active && <section className="editorSection">
            <span className="eyebrow">ACCESO CON QR CORPORATIVO</span>
            <p className="adminHelp">Este QR identifica el perfil antes del inicio de sesión corporativo. No reemplaza la contraseña ni el segundo factor del proveedor de identidad.</p>
            <QRCard value={`vigilia:admin:${selectedUser.id}`} label={`Acceso corporativo · ${selectedUser.display_name}`} download />
          </section>}
          {selectedUser.active && selectedUser.id !== "demo-admin" && <section className="editorSection">
            <span className="eyebrow">ESTADO DEL ACCESO</span>
            <button className="secondaryButton" type="button" disabled={saving} onClick={() => askDeactivateCorporate(selectedUser)}>Desactivar acceso</button>
          </section>}
        </>}
      </form>

      {enrollment && <Sheet eyebrow="CONFIGURACIÓN PRIVADA · SE MUESTRA UNA SOLA VEZ" title={`Autenticador de ${enrollment.name}`} subtitle={enrollment.accountId} closeLabel="Cerrar configuración privada" onClose={() => setEnrollment(null)}>
        <div className="enrollmentSheet">
          <div className="adminNotice error" role="note">Entrégala en persona. No la envíes por correo ni la imprimas en el gafete. Al cerrar, no se podrá volver a consultar.</div>
          <p>La persona debe escanear este QR con su app autenticadora (Google Authenticator, Microsoft Authenticator u otra compatible con TOTP).</p>
          <QRCard value={enrollment.uri} label="QR privado para configurar el autenticador" />
          <div className="adminField"><span>Clave para configuración manual</span><div className="readonlyValue"><code>{enrollment.secret}</code><CopyButton value={enrollment.secret} label="Copiar clave" /></div></div>
          <button className="primaryButton" type="button" onClick={() => setEnrollment(null)}>Ya lo configuró · ocultar</button>
        </div>
      </Sheet>}

      {temporary && <Sheet eyebrow="CONTRASEÑA TEMPORAL · SE MUESTRA UNA SOLA VEZ" title={`Contraseña de ${temporary.name}`} subtitle={temporary.accountId} closeLabel="Cerrar contraseña temporal" onClose={() => setTemporary(null)}>
        <div className="enrollmentSheet">
          <div className="adminNotice error" role="note">Entrégala en persona. Vigilia pedirá cambiarla en el primer acceso. Al cerrar, no se podrá volver a consultar.</div>
          <div className="adminField"><span>Contraseña temporal</span><div className="readonlyValue"><code className="temporaryPassword">{temporary.password}</code><CopyButton value={temporary.password} label="Copiar" /></div></div>
          <button className="primaryButton" type="button" onClick={() => setTemporary(null)}>Ya la entregué · ocultar</button>
        </div>
      </Sheet>}
    </section>
  );
}
