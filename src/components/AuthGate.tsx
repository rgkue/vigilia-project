import { useEffect, useRef, useState, type FormEvent } from "react";
import vigiliaLogo from "../assets/vigilia-card-nav-logo.svg";
import { apiFetch, apiUrl, jsonRequest, parseApiError, setCsrfToken, startDemoSession, type CurrentSession } from "../lib/clientApi";
import { QRCard, QRScanner } from "./AuthQR";
import { Icon } from "./Icon";
import "../auth.css";

interface AuthOptions {
  csrf_token: string; mode: "demo" | "production"; bootstrap_allowed: boolean; oidc_enabled?: boolean; demo_access?: boolean;
  demo_admin_badge: string | null;
  demo_employee: { employee_id: string; badge: string; uri: string } | null;
}

type AccessPath = "employee" | "admin";
// En la pantalla de acceso un 401 describe el dato rechazado, no una sesión que terminó.
const PRE_LOGIN = { sessionExpected: false };
const DEMO_EMPLOYEE_ID = "EMP-REC-001";

export function AuthGate({ loading, error: initialError, notice = "", onSession, onChangeMode }: { loading: boolean; error: string; notice?: string; onSession: (session: CurrentSession) => void; onChangeMode?: () => void }) {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [path, setPath] = useState<AccessPath>("employee");
  const [employeeId, setEmployeeId] = useState("");
  const [employeeStep, setEmployeeStep] = useState<1 | 2 | 3>(1);
  const [scannedId, setScannedId] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const employeeIdInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [fieldErrors, setFieldErrors] = useState<{ employeeId?: string; code?: string; password?: string }>({});
  // Las cuentas con permisos administrativos piden contraseña; el servidor lo indica (428) tras un código válido.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adminReady, setAdminReady] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (loading) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setConnecting(true); setError("");
    jsonRequest<AuthOptions>("/auth/options", { signal: controller.signal }, PRE_LOGIN).then((result) => {
      if (!cancelled) { setCsrfToken(result.csrf_token); setOptions(result); setError(""); }
    }).catch((reason: Error) => { if (!cancelled) setError(reason.name === "AbortError" ? "La conexión está tardando demasiado. Vuelve a intentarlo." : reason.message); })
      .finally(() => { window.clearTimeout(timeout); if (!cancelled) setConnecting(false); });
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [loading, retry]);

  useEffect(() => {
    if (manualEntry) employeeIdInput.current?.focus();
  }, [manualEntry]);

  function choosePath(next: AccessPath) {
    setPath(next); setFieldErrors({});
  }

  // El contenido del QR indica el tipo de cuenta; no hace falta que la persona lo elija antes.
  async function scan(value: string) {
    setError("");
    if (/^vigilia:employee:[A-Za-z0-9-]{1,40}$/.test(value)) {
      choosePath("employee");
      setEmployeeId(value.slice("vigilia:employee:".length)); setScannedId(true); setManualEntry(false);
      setEmployeeStep(2); setCode(""); setNeedsPassword(false); setPassword("");
      window.requestAnimationFrame(() => codeInput.current?.focus());
      return;
    }
    if (!/^vigilia:admin:/.test(value)) { setError("Este QR no es un gafete de Vigilia. El QR de configuración se escanea en tu app autenticadora, no aquí."); return; }
    if (options?.mode === "production" && (value === "vigilia:admin:demo-admin" || !options.oidc_enabled)) {
      // Sin inicio de sesión corporativo (OIDC) el QR de administración no lleva a ninguna parte:
      // el personal administrativo entra con su ID, el código de su app y su contraseña.
      choosePath("employee"); setAdminReady(false); resetEmployeeId(); setManualEntry(true);
      setError(value === "vigilia:admin:demo-admin"
        ? `Ese QR es del administrador de la demostración y no sirve en Producción. ${options.demo_access ? "Para evaluar sin credenciales usa «Entrar en modo Demo»; en Producción, escribe" : "Escribe"} tu ID, el código de tu app autenticadora y tu contraseña.`
        : "En esta instalación no se entra con QR de administración: escribe tu ID, el código de tu app autenticadora y tu contraseña.");
      return;
    }
    choosePath("admin");
    if (busy || !options) return;
    setBusy(true); setAdminReady(false);
    try {
      const result = await jsonRequest<{ csrf_token: string }>("/auth/admin/qr/start", { method: "POST", body: JSON.stringify({ qr: value }) }, PRE_LOGIN);
      setCsrfToken(result.csrf_token); setAdminReady(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo validar el QR."); }
    finally { setBusy(false); }
  }

  async function loginEmployee(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (employeeStep === 1) { continueWithEmployeeId(); return; }
    const errors = {
      employeeId: !employeeId.trim() ? (manualEntry ? "Escribe tu ID de acceso." : "Escanea tu gafete o escribe tu ID de acceso.") : !/^[A-Za-z0-9-]{1,40}$/.test(employeeId.trim()) ? "Usa hasta 40 letras, números o guiones, sin espacios." : undefined,
      code: !/^\d{6}$/.test(code) ? "Introduce los 6 dígitos de tu app autenticadora." : undefined,
      password: needsPassword && !password ? "Escribe tu contraseña." : undefined,
    };
    setFieldErrors(errors); setError("");
    const invalid = errors.employeeId ? employeeIdInput : errors.password ? passwordInput : errors.code ? codeInput : null;
    if (invalid) { invalid.current?.focus(); return; }
    setBusy(true);
    try {
      const response = await apiFetch("/auth/employee/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId.trim(), code, ...(needsPassword ? { password } : {}) }) });
      if (response.status === 428) {
        // El código sigue vigente: basta con añadir la contraseña y volver a pulsar Entrar.
        setNeedsPassword(true); setEmployeeStep(3);
        setError("");
        window.requestAnimationFrame(() => passwordInput.current?.focus());
        return;
      }
      if (!response.ok) {
        if (response.status === 401 && options?.mode === "production" && employeeId.trim().toUpperCase() === DEMO_EMPLOYEE_ID) {
          // ID público de la instalación demo: avisarlo no revela nada de las cuentas reales.
          throw new Error(`${DEMO_EMPLOYEE_ID} es la cuenta de prueba de la instalación demo y no existe en Producción. ${options.demo_access ? "Para evaluar sin credenciales usa «Entrar en modo Demo»." : "Entra con tu ID de acceso."}`);
        }
        if (response.status === 401) {
          if (needsPassword) { setEmployeeStep(2); setNeedsPassword(false); setPassword(""); }
          throw new Error(needsPassword
            ? "No se pudo validar el código o la contraseña. Introduce un código vigente y vuelve a intentarlo."
            : "No se pudo validar tu ID y código. Revisa el ID e introduce un código vigente de tu app autenticadora.");
        }
        throw await parseApiError(response, PRE_LOGIN);
      }
      const result = await response.json();
      setCsrfToken(result.csrf_token); setCode(""); setPassword(""); onSession(result as CurrentSession);
    } catch (reason) { setCode(""); setError(reason instanceof Error ? reason.message : "No se pudo iniciar sesión."); codeInput.current?.focus(); }
    finally { setBusy(false); }
  }

  async function loginDemo() {
    setBusy(true); setError("");
    try {
      const result = await jsonRequest<CurrentSession>("/auth/demo-admin", { method: "POST", body: "{}" }, PRE_LOGIN);
      setCsrfToken(result.csrf_token); onSession(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo iniciar sesión."); }
    finally { setBusy(false); }
  }

  async function loginDemoAccess() {
    setBusy(true); setError("");
    try { onSession(await startDemoSession()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo entrar en modo Demo."); }
    finally { setBusy(false); }
  }

  function resetEmployeeId() {
    setEmployeeId(""); setScannedId(false); setEmployeeStep(1); setCode(""); setFieldErrors({}); setNeedsPassword(false); setPassword(""); setError("");
  }

  function continueWithEmployeeId() {
    const normalized = employeeId.trim();
    if (!/^[A-Za-z0-9-]{1,40}$/.test(normalized)) {
      setFieldErrors((previous) => ({ ...previous, employeeId: !normalized ? "Escribe tu ID de acceso." : "Usa hasta 40 letras, números o guiones, sin espacios." }));
      employeeIdInput.current?.focus();
      return;
    }
    setEmployeeId(normalized); setEmployeeStep(2); setCode(""); setError(""); setFieldErrors({});
    window.requestAnimationFrame(() => codeInput.current?.focus());
  }

  const shownError = error || (!options ? initialError : "");
  const showIdInput = manualEntry || (!scannedId && Boolean(employeeId) && !manualEntry);

  return <main className="authGate appFrame">
    <div className="ambient ambientOne" aria-hidden="true" />
    <div className="ambient ambientTwo" aria-hidden="true" />
    <div className="authGateCard glassPanel authAccessCard">
      <div className="authBrand"><img src={vigiliaLogo} alt="Vigilia" /><span className="eyebrow">ACCESO DEL PERSONAL</span></div>
      <h1>{loading ? "Verificando acceso" : path === "admin" ? "Acceso de administración" : "Inicia tu jornada"}</h1>
      <p className="authLead">{loading ? "Comprobando si ya tienes una sesión abierta en este equipo." : path === "employee" ? "Escanea un gafete para continuar. Si eres empleado, también puedes escribir tu ID." : adminReady ? "QR de administrador identificado. Continúa con la cuenta de tu organización." : "Escanea el QR de administración para continuar."}</p>

      {loading && <div className="authLoading" role="status"><div className="emptySignal isActive" aria-hidden="true"><span /><Icon name="pulse" size={25} /></div><span>Un momento…</span></div>}
      {notice && !shownError && <p className="adminNotice authNotice" role="status">{notice}</p>}
      {shownError && <p className="adminNotice error" role="alert">{shownError}</p>}
      {!loading && !options && <button className="secondaryButton" type="button" disabled={connecting} aria-busy={connecting} onClick={() => setRetry(retry + 1)}>{connecting ? "Conectando…" : "Reintentar conexión"}</button>}

      {options && <>
        {path === "employee" ? <form className="authForm" noValidate aria-busy={busy} onSubmit={(event) => void loginEmployee(event)}>
          {employeeStep === 1 ? <section className="authStep authStepReveal" aria-labelledby="auth-step-id">
            <h2 id="auth-step-id"><span>1</span>Identificación</h2>
            {showIdInput ? <>
              <label className="adminField"><span>ID de acceso o cédula</span><input ref={employeeIdInput} aria-invalid={Boolean(fieldErrors.employeeId)} aria-describedby={fieldErrors.employeeId ? "employee-id-error" : undefined} disabled={busy} required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={40} pattern="[A-Za-z0-9-]+" value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setScannedId(false); setEmployeeStep(1); setCode(""); setNeedsPassword(false); setPassword(""); setFieldErrors((previous) => ({ ...previous, employeeId: undefined })); setError(""); }} placeholder={options.mode === "demo" ? DEMO_EMPLOYEE_ID : "Tu ID o cédula"} /></label>
              {fieldErrors.employeeId && <span id="employee-id-error" className="authFieldError" role="alert">{fieldErrors.employeeId}</span>}
              <button className="primaryButton" type="button" onClick={continueWithEmployeeId}>Continuar</button>
            </> : <QRScanner onRead={(value) => void scan(value)} cameraLabel={options.mode === "production" && !options.oidc_enabled ? "Escanear gafete" : "Escanear gafete o QR de admin"} />}
            <button type="button" className="authSwitch" onClick={() => { setManualEntry(!manualEntry); setError(""); setFieldErrors({}); if (manualEntry) resetEmployeeId(); }}>{manualEntry ? "Usar mi gafete QR" : "No tengo mi gafete · escribir mi ID"}</button>
          </section> : <section className="authStep authStepComplete" aria-labelledby="auth-step-id-done">
            <h2 id="auth-step-id-done"><span><Icon name="check" size={14} /></span>Identificación</h2>
            <div className="authChip"><Icon name="check" size={15} /><span>{scannedId ? "Gafete leído" : "ID ingresado"} · <code>{employeeId}</code></span><button type="button" className="adminTextButton" onClick={resetEmployeeId}>Cambiar</button></div>
          </section>}
          {employeeStep >= 2 && <section className="authStep authStepReveal" aria-labelledby="auth-step-code">
            <h2 id="auth-step-code"><span>{needsPassword ? <Icon name="check" size={14} /> : "2"}</span>{needsPassword ? "Código verificado" : "Código de verificación"}</h2>
            {needsPassword ? <p>Ahora confirma tu contraseña para completar el acceso.</p> : <label className="adminField"><span>Código de tu app autenticadora</span><input ref={codeInput} aria-invalid={Boolean(fieldErrors.code)} aria-describedby={fieldErrors.code ? "employee-code-error" : undefined} disabled={busy} required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => { setCode(event.target.value.replace(/\D/g, "")); setFieldErrors((previous) => ({ ...previous, code: undefined })); setError(""); }} placeholder="6 dígitos" />{fieldErrors.code && <span id="employee-code-error" className="authFieldError" role="alert">{fieldErrors.code}</span>}</label>}
          </section>}
          {needsPassword && <section className="authStep authStepReveal" aria-labelledby="auth-step-password">
            <h2 id="auth-step-password"><span>3</span>Contraseña</h2>
            <p>Tu cuenta tiene permisos administrativos y requiere contraseña además del código.</p>
            <label className="adminField"><span>Contraseña</span><input ref={passwordInput} type="password" autoComplete="current-password" maxLength={128} disabled={busy} aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? "employee-password-error" : undefined} value={password} onChange={(event) => { setPassword(event.target.value); setFieldErrors((previous) => ({ ...previous, password: undefined })); setError(""); }} />{fieldErrors.password && <span id="employee-password-error" className="authFieldError" role="alert">{fieldErrors.password}</span>}</label>
          </section>}
          {employeeStep >= 2 && <button className="primaryButton" disabled={busy} type="submit">{busy ? "Validando…" : needsPassword ? "Entrar" : "Verificar código"}</button>}
        </form> : <div className="authForm">
          <section className="authStep authStepReveal" aria-labelledby="auth-step-qr">
            <h2 id="auth-step-qr"><span>1</span>QR corporativo</h2>
            {adminReady
              ? <div className="authChip"><Icon name="check" size={15} /><span>QR identificado</span><button type="button" className="adminTextButton" onClick={() => setAdminReady(false)}>Cambiar</button></div>
              : busy ? <p className="authQRValidating" role="status">Validando el QR de administración…</p>
                : <QRScanner onRead={(value) => void scan(value)} cameraLabel="Escanear QR de administración" />}
          </section>
          {adminReady && <section className="authStep authStepReveal" aria-labelledby="auth-step-sso">
            <h2 id="auth-step-sso"><span>2</span>Acceso de administración</h2>
            <p>Continúa con la misma cuenta corporativa a la que pertenece el QR.</p>
            {options.mode === "demo"
              ? <button className="primaryButton" type="button" disabled={busy} onClick={() => void loginDemo()}>Simular inicio corporativo (demo)</button>
              : <a className="primaryButton" href={apiUrl("/auth/login")}>Continuar con la cuenta corporativa</a>}
          </section>}
          <button type="button" className="authSwitch" onClick={() => { choosePath("employee"); setAdminReady(false); setError(""); }}>Volver al acceso con ID o gafete</button>
        </div>}

        {options.bootstrap_allowed && <a className="authSwitch authBootstrap" href={apiUrl("/auth/login")}>Configurar el primer administrador</a>}

        {options.mode === "production" && options.demo_access && <section className="authDemoAccess" aria-labelledby="auth-demo-access">
          <h2 id="auth-demo-access">¿Solo quieres evaluar Vigilia?</h2>
          <p>El modo Demo entra al instante, sin credenciales, con datos ficticios.</p>
          <button className="secondaryButton" type="button" disabled={busy} onClick={() => void loginDemoAccess()}>Entrar en modo Demo</button>
        </section>}

        {options.mode === "demo" && <details className="authDemo">
          <summary><span className="card-nav-env"><i />Demo</span>Credenciales sintéticas de demostración</summary>
          <p>Estos accesos solo existen en el entorno de demostración y usan datos ficticios.</p>
          <div className="authDemoGrid">
            {options.demo_employee && <div>
              <strong>Recepción · {options.demo_employee.employee_id}</strong>
              <p>Añade esta cuenta a tu app autenticadora para obtener el código actual.</p>
              <QRCard value={options.demo_employee.uri} label="Configuración TOTP de prueba" />
              <QRCard value={options.demo_employee.badge} label="Gafete de Recepción de prueba" download />
            </div>}
            {options.demo_admin_badge && <div>
              <strong>Administración</strong>
              <p>Usa el QR del administrador demo y luego simula el inicio corporativo.</p>
              <QRCard value={options.demo_admin_badge} label="Gafete del administrador demo" download />
              <button className="secondaryButton" type="button" disabled={busy} onClick={() => void scan(options.demo_admin_badge!)}>Usar QR del administrador demo</button>
            </div>}
          </div>
        </details>}
      </>}
      <p className="authFooter"><Icon name="shield" size={14} />Acceso auditado · tus permisos se verifican en el servidor.</p>
      {onChangeMode && <button type="button" className="authSwitch" onClick={onChangeMode}>Cambiar de modo (Demo o Producción)</button>}
    </div>
  </main>;
}
