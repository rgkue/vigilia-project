import { useCallback, useEffect, useRef, useState } from "react";
import { AdminPanel, ADMIN_BASE, ADMIN_LEGACY_PATHS, ADMIN_TAB_PATHS, type AdminTab } from "./components/AdminPanel";
import { AuthGate } from "./components/AuthGate";
import { QRCard } from "./components/AuthQR";
import { CardNav, type NavGroup } from "./components/CardNav";
import { Sheet } from "./components/Dialogs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { IngressDetailSheet } from "./components/IngressDetailSheet";
import { PasswordChangeForm, PasswordChangeGate } from "./components/PasswordChange";
import { useToast } from "./components/Toast";
import { demoCases, makeDemoEvent } from "./data/demoCases";
import { getOperationalIntegrationStatuses, reviewClassification, type IntegrationStatus } from "./lib/adminApi";
import { BackendConnectionError, checkBackendHealth, isBackendConfigured, loadIngressEntry, loadIngressList, processDemoIngress, processIngress } from "./lib/agentApi";
import { getPublicConfig, getSession, logoutSession, SESSION_EXPIRED_EVENT, type CurrentSession } from "./lib/clientApi";
import { evaluateJevCase, loadJevStatus } from "./lib/jevApi";
import { rolesLabel } from "./lib/labels";
import { ActivityPage } from "./pages/ActivityPage";
import { AISettingsPage } from "./pages/AISettingsPage";
import { IntakePage, type LiveIngressDraft } from "./pages/IntakePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SimulatorPage, type JevStatus } from "./pages/SimulatorPage";
import type { AgentResponse, IngressEvent, JevEvaluation, JevRelation } from "./types";

type BackendStatus = "local" | "checking" | "online" | "offline";
type SectionId = "login" | "overview" | "intake" | "activity" | "simulator" | "admin" | "settings" | "notFound";
type Route = { section: SectionId; adminTab?: AdminTab };

const ROUTE_BY_SECTION: Record<Exclude<SectionId, "notFound" | "admin">, string> = {
  login: "/acceso",
  overview: "/resumen",
  intake: "/ingreso",
  activity: "/actividad",
  simulator: "/simulador",
  settings: "/configuracion",
};

const SECTION_BY_ROUTE: Record<string, SectionId> = {
  "/": "overview",
  "/acceso": "login",
  "/resumen": "overview",
  "/ingreso": "intake",
  "/actividad": "activity",
  "/simulador": "simulator",
  "/configuracion": "settings",
};

const PAGE_TITLE: Record<SectionId, string> = {
  login: "Iniciar sesión",
  overview: "Resumen",
  intake: "Registrar ingreso",
  activity: "Actividad",
  simulator: "Simulador",
  admin: "Administración",
  settings: "Configuración de IA",
  notFound: "Página no encontrada",
};

const ADMIN_PERMISSION: Record<AdminTab, string> = {
  people: "users.manage",
  integrations: "integrations.manage",
  audit: "audit.read",
};

function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === ADMIN_BASE || path === "/admin") return { section: "admin" };
  if (path.startsWith(`${ADMIN_BASE}/`)) {
    const slug = path.slice(ADMIN_BASE.length + 1);
    const tab = (Object.entries(ADMIN_TAB_PATHS) as [AdminTab, string][]).find(([, candidate]) => candidate === slug)?.[0] ?? ADMIN_LEGACY_PATHS[slug];
    return tab ? { section: "admin", adminTab: tab } : { section: "notFound" };
  }
  return { section: SECTION_BY_ROUTE[path] ?? "notFound" };
}

const liveIngressEnabled = import.meta.env.VITE_LIVE_INGRESS_ENABLED === "true";

function App() {
  const toast = useToast();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [serverMode, setServerMode] = useState<"demo" | "production" | null>(isBackendConfigured ? null : "demo");
  const [session, setSession] = useState<CurrentSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(isBackendConfigured);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [operationalStatuses, setOperationalStatuses] = useState<IntegrationStatus[]>([]);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(isBackendConfigured ? "checking" : "local");
  const [refreshKey, setRefreshKey] = useState(0);
  const [hospitals, setHospitals] = useState<string[]>([]);
  const [liveResult, setLiveResult] = useState<AgentResponse | null>(null);
  const [livePending, setLivePending] = useState(false);
  const [liveError, setLiveError] = useState("");
  const [selectedId, setSelectedId] = useState(demoCases[0]?.id ?? "");
  const [demoResult, setDemoResult] = useState<AgentResponse | null>(null);
  const [demoPending, setDemoPending] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [jevStatus, setJevStatus] = useState<JevStatus>("checking");
  const [jevEvaluation, setJevEvaluation] = useState<JevEvaluation | null>(null);
  const [jevPending, setJevPending] = useState(false);
  const [jevError, setJevError] = useState("");
  const [selectedActivity, setSelectedActivity] = useState<AgentResponse | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState("");
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const activityReturnFocusRef = useRef<HTMLElement | null>(null);
  const jevRequestControllerRef = useRef<AbortController | null>(null);
  const jevRequestIdRef = useRef(0);
  const sessionRef = useRef<CurrentSession | null>(null);
  sessionRef.current = session;

  const activeSection = route.section;
  const selectedCase = demoCases.find((item) => item.id === selectedId) ?? null;
  const permissions = session?.user.permissions ?? [];
  const allowedAdminTabs = (Object.keys(ADMIN_PERMISSION) as AdminTab[]).filter((tab) => permissions.includes(ADMIN_PERMISSION[tab]));
  const canOpenAdmin = allowedAdminTabs.length > 0;
  const canConfigureAI = Boolean(session);
  const canReview = permissions.includes("classification.review");
  const canReadIngress = isBackendConfigured && permissions.includes("ingress.read");
  const canSubmitIngress = permissions.includes("ingress.submit");
  const canManageIntegrations = permissions.includes("integrations.manage");
  const simulatorAvailable = serverMode !== "production";

  const clearSessionState = useCallback(() => {
    setSession(null);
    setOperationalStatuses([]);
    setSelectedActivity(null);
    setLiveResult(null);
    setDemoResult(null);
    setJevEvaluation(null);
    setBadgeOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isBackendConfigured) {
      setServerMode("demo");
      setSessionLoading(false);
      return;
    }
    (async () => {
      try {
        const config = await getPublicConfig();
        if (cancelled) return;
        setServerMode(config.mode);
        try {
          const nextSession = await getSession();
          if (!cancelled) setSession(nextSession);
        } catch {
          if (!cancelled) setSession(null);
        }
      } catch {
        if (!cancelled) {
          setServerMode(import.meta.env.DEV ? "demo" : "production");
          setAuthError("No se pudo conectar con Vigilia. Comprueba el servicio antes de continuar.");
        }
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Any 401 from the API while signed in returns to the access screen.
  useEffect(() => {
    function expire() {
      if (!sessionRef.current) return;
      clearSessionState();
      setAuthNotice("Tu sesión terminó. Inicia sesión otra vez para continuar.");
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, [clearSessionState]);

  const resolveRoute = useCallback((next: Route): Route => {
    if (next.section === "login") return isBackendConfigured && !session ? next : { section: "overview" };
    if (isBackendConfigured && !sessionLoading && !session) return { section: "login" };
    if (next.section === "simulator" && serverMode === "production") return { section: "overview" };
    if (next.section === "admin" && !sessionLoading) {
      if (!canOpenAdmin) return { section: "overview" };
      if (!next.adminTab || !allowedAdminTabs.includes(next.adminTab)) return { section: "admin", adminTab: allowedAdminTabs[0] };
    }
    return next;
  }, [isBackendConfigured, session, serverMode, sessionLoading, canOpenAdmin, allowedAdminTabs.join("|")]);

  const pathFor = (next: Route) => next.section === "admin"
    ? `${ADMIN_BASE}/${ADMIN_TAB_PATHS[next.adminTab ?? allowedAdminTabs[0] ?? "people"]}`
    : next.section === "notFound" ? window.location.pathname : ROUTE_BY_SECTION[next.section];

  useEffect(() => {
    const syncRoute = () => {
      const next = resolveRoute(parseRoute(window.location.pathname));
      const effectivePath = pathFor(next);
      if (next.section !== "notFound" && window.location.pathname !== effectivePath) {
        window.history.replaceState(null, "", effectivePath + (next.section === "activity" ? window.location.search : ""));
      }
      setRoute(next);
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    syncRoute();
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, [resolveRoute]);

  useEffect(() => {
    document.title = PAGE_TITLE[activeSection] + " · Vigilia";
  }, [activeSection]);

  useEffect(() => {
    setSelectedActivity(null);
  }, [activeSection]);

  useEffect(() => {
    if (!highlightedEventId) return;
    const timeout = window.setTimeout(() => setHighlightedEventId(""), 1900);
    return () => window.clearTimeout(timeout);
  }, [highlightedEventId]);

  useEffect(() => {
    if (activeSection !== "simulator") return;
    let cancelled = false;
    const controller = new AbortController();
    setJevStatus("checking");
    loadJevStatus(controller.signal)
      .then((status) => { if (!cancelled) setJevStatus(status.configured ? "configured" : "missing"); })
      .catch(() => { if (!cancelled && !controller.signal.aborted) setJevStatus("unavailable"); });
    return () => { cancelled = true; controller.abort(); };
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === "simulator") return;
    jevRequestIdRef.current += 1;
    jevRequestControllerRef.current?.abort();
    jevRequestControllerRef.current = null;
    setJevPending(false);
  }, [activeSection]);

  useEffect(() => () => jevRequestControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!isBackendConfigured || sessionLoading || !session) return;
    let cancelled = false;
    Promise.allSettled([
      checkBackendHealth(),
      canReadIngress ? getOperationalIntegrationStatuses() : Promise.resolve([] as IntegrationStatus[]),
    ]).then(([healthResult, integrationResult]) => {
      if (cancelled) return;
      setBackendStatus(healthResult.status === "fulfilled" && healthResult.value ? "online" : "offline");
      if (integrationResult.status === "fulfilled") setOperationalStatuses(integrationResult.value);
    });
    return () => { cancelled = true; };
  }, [sessionLoading, session, canReadIngress, refreshKey]);

  // Recent centers feed the intake autocomplete.
  useEffect(() => {
    if (activeSection !== "intake" || !canReadIngress) return;
    let cancelled = false;
    loadIngressList({}, 1, 60).then((page) => {
      if (cancelled) return;
      setHospitals([...new Set(page.items.map((item) => item.hospital?.trim()).filter((name): name is string => Boolean(name)))].slice(0, 20));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeSection, canReadIngress]);

  const handleConnection = useCallback((online: boolean) => setBackendStatus(online ? "online" : "offline"), []);

  function navigateToPath(target: string) {
    const [pathname, search = ""] = target.split("?");
    const next = resolveRoute(parseRoute(pathname));
    const effectivePath = next.section === "notFound" ? pathname : pathFor(next);
    const url = effectivePath + (next.section === "activity" && search ? `?${search}` : "");
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
    setRoute(next);
    if (next.section === "activity") setRefreshKey((key) => key + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function replaceRoute(next: Route) {
    window.history.replaceState(null, "", pathFor(next));
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectAdminTab(tab: AdminTab) {
    navigateToPath(`${ADMIN_BASE}/${ADMIN_TAB_PATHS[tab]}`);
  }

  async function resolveClassification(eventId: string, index: number, relation: Exclude<JevRelation, "PENDIENTE">, reason: string) {
    await reviewClassification(eventId, index, relation, reason);
    toast.success("Revisión guardada y registrada en la auditoría.");
    const updated = await loadIngressEntry(eventId).catch(() => null);
    if (updated) setSelectedActivity(updated);
    setRefreshKey((key) => key + 1);
  }

  async function signOut() {
    setLogoutPending(true);
    try {
      await logoutSession();
      clearSessionState();
      replaceRoute({ section: "login" });
      setAuthError("");
    } catch (logoutError) {
      toast.error(logoutError instanceof Error ? logoutError.message : "No se pudo cerrar la sesión.");
    } finally {
      setLogoutPending(false);
    }
  }

  function selectDemoCase(id: string) {
    jevRequestIdRef.current += 1;
    jevRequestControllerRef.current?.abort();
    jevRequestControllerRef.current = null;
    setJevPending(false);
    setSelectedId(id);
    setDemoResult(null);
    setDemoError("");
    setJevEvaluation(null);
    setJevError("");
  }

  async function runJevEvaluation() {
    if (!selectedCase || selectedCase.preexistingConditions.length === 0 || jevPending) return;
    const requestId = ++jevRequestIdRef.current;
    const controller = new AbortController();
    jevRequestControllerRef.current = controller;
    setJevPending(true);
    setJevError("");
    setJevEvaluation(null);
    try {
      const result = await evaluateJevCase(selectedCase.id, controller.signal);
      if (requestId === jevRequestIdRef.current) setJevEvaluation(result);
    } catch (evaluationError) {
      if (controller.signal.aborted || requestId !== jevRequestIdRef.current) return;
      const message = evaluationError instanceof Error ? evaluationError.message : "No se pudo completar la evaluación.";
      setJevError(message);
    } finally {
      if (requestId === jevRequestIdRef.current) {
        setJevPending(false);
        jevRequestControllerRef.current = null;
      }
    }
  }

  async function runDemoScenario() {
    if (!selectedCase || demoPending) return;
    setDemoPending(true);
    setDemoError("");
    setDemoResult(null);
    try {
      const response = await processDemoIngress(makeDemoEvent(selectedCase), selectedCase);
      setDemoResult(response);
    } catch (submitError) {
      setDemoError(submitError instanceof Error ? submitError.message : "No se pudo ejecutar el escenario.");
    } finally {
      setDemoPending(false);
    }
  }

  async function submitLiveIngress(draft: LiveIngressDraft): Promise<AgentResponse | null> {
    if (!isBackendConfigured || backendStatus !== "online" || !liveIngressEnabled || !canSubmitIngress || livePending) return null;
    setLivePending(true);
    setLiveError("");
    setLiveResult(null);
    const generatedId = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
    const event: IngressEvent = {
      evento_id: "ING-" + generatedId.replace(/-/g, "").slice(0, 32).toUpperCase(),
      cedula: draft.cedula,
      hospital: draft.hospital,
      motivo_ingreso: draft.motivo_ingreso,
      ...(draft.triage === undefined ? {} : { triage: draft.triage }),
      fecha_ingreso: new Date(draft.fecha_ingreso).toISOString(),
    };
    try {
      const response = await processIngress(event);
      const enriched = { ...response, hospital: draft.hospital, reason: draft.motivo_ingreso };
      setBackendStatus("online");
      setLiveResult(enriched);
      setHighlightedEventId(response.event_id);
      setRefreshKey((key) => key + 1);
      toast.success(`Ingreso registrado · referencia ${response.event_id}`);
      return enriched;
    } catch (submitError) {
      if (submitError instanceof BackendConnectionError) setBackendStatus("offline");
      setLiveError(submitError instanceof Error ? submitError.message : "No se pudo registrar el ingreso.");
      return null;
    } finally {
      setLivePending(false);
    }
  }

  function selectHistoryEntry(entry: AgentResponse, trigger: HTMLButtonElement) {
    activityReturnFocusRef.current = trigger;
    setSelectedActivity(entry);
  }

  const reviewerName = (id: string | null | undefined) => !id ? "Revisor" : id === session?.user.id ? "Revisado por ti" : "Revisor autorizado";

  const modeLabel = backendStatus === "local"
    ? "Conexión no configurada"
    : backendStatus === "checking"
      ? "Comprobando servicio"
      : backendStatus === "online" ? "Servicio conectado" : "Servicio no disponible";
  const modeClass = backendStatus === "online" ? "configured" : backendStatus;
  const canSubmitLive = isBackendConfigured && backendStatus === "online" && liveIngressEnabled && canSubmitIngress;
  const liveStatusMessage = !isBackendConfigured
    ? "La conexión con el servicio aún no está configurada."
    : backendStatus === "checking"
      ? "Comprobando la conexión segura con el servicio…"
      : backendStatus === "offline"
        ? "No se pudo conectar con el servicio. Vuelve a intentarlo más tarde."
        : !liveIngressEnabled
          ? "El registro no está habilitado en esta instalación."
          : !canSubmitIngress
            ? "Tu perfil no tiene permiso para registrar ingresos manualmente."
            : "Servicio conectado. Revisa la información antes de enviarla.";

  if (session?.user.must_change_password) {
    return <PasswordChangeGate session={session} signingOut={logoutPending} onSignOut={() => void signOut()}
      onSession={(next) => { setSession(next); toast.success("Contraseña guardada. Ya puedes usar Vigilia."); replaceRoute({ section: "overview" }); }} />;
  }

  if (sessionLoading || (isBackendConfigured && !session)) {
    return <AuthGate loading={sessionLoading} error={authError} notice={authNotice} onSession={(next) => { setSession(next); setServerMode(next.mode); setAuthError(""); setAuthNotice(""); replaceRoute({ section: "overview" }); }} />;
  }

  const adminTab = route.adminTab ?? allowedAdminTabs[0];
  const navGroups: NavGroup[] = [
    {
      label: "Operación",
      links: [
        { label: "Resumen", href: "/resumen", active: activeSection === "overview" },
        ...(canSubmitIngress ? [{ label: "Registrar ingreso", href: "/ingreso", active: activeSection === "intake" }] : []),
        { label: "Actividad", href: "/actividad", active: activeSection === "activity" },
      ],
    },
    {
      label: "Herramientas",
      links: [
        ...(simulatorAvailable ? [{ label: "Simulador", href: "/simulador", active: activeSection === "simulator", badge: "Pruebas" }] : []),
        ...(canConfigureAI ? [{ label: "Configuración de IA", href: "/configuracion", active: activeSection === "settings" }] : []),
      ],
    },
    ...(canOpenAdmin ? [{
      label: "Administración",
      links: allowedAdminTabs.map((tab) => ({
        label: tab === "people" ? "Personas" : tab === "integrations" ? "Integraciones" : "Auditoría",
        href: `${ADMIN_BASE}/${ADMIN_TAB_PATHS[tab]}`,
        active: activeSection === "admin" && adminTab === tab,
      })),
    }] : []),
  ].filter((group) => group.links.length > 0);

  return (
    <div className="appFrame clientAppFrame">
      <a className="skipLink" href="#main">Saltar al contenido</a>
      <div className="ambient ambientOne" aria-hidden="true" />
      <div className="ambient ambientTwo" aria-hidden="true" />
      <div className="mobileCardNav">
        <CardNav
          groups={navGroups}
          sectionLabel={PAGE_TITLE[activeSection]}
          status={modeLabel}
          statusTone={modeClass}
          showIntakeCta={canSubmitIngress && activeSection !== "intake"}
          intakeActive={activeSection === "intake"}
          account={session ? {
            name: session.user.display_name,
            roleLabel: rolesLabel(session.user.roles),
            identifier: session.user.employee_id ?? session.user.email,
            logoutPending,
            onBadge: () => setBadgeOpen(true),
            onChangePassword: session.user.auth_method === "password" ? () => setPasswordOpen(true) : undefined,
            onSignOut: () => void signOut(),
          } : undefined}
          onNavigate={navigateToPath}
        />
      </div>

      <main id="main" className="mainArea clientMainArea">
        <ErrorBoundary resetKey={activeSection}>
          <div key={activeSection} className={`routeView routeView-${activeSection}`}>
            {activeSection === "overview" && (
              <OverviewPage
                displayName={session?.user.display_name ?? "equipo"}
                canReadIngress={canReadIngress}
                canSubmitIngress={canSubmitIngress}
                canReview={canReview}
                canManageIntegrations={canManageIntegrations}
                backendStatus={backendStatus}
                statuses={operationalStatuses}
                refreshKey={refreshKey}
                activeEventId={selectedActivity?.event_id ?? ""}
                highlightedEventId={highlightedEventId}
                onSelect={selectHistoryEntry}
                onNavigate={navigateToPath}
                onConnection={handleConnection}
              />
            )}
            {activeSection === "intake" && (
              <IntakePage available={canSubmitLive} statusMessage={liveStatusMessage} result={liveResult} pending={livePending} error={liveError} hospitals={hospitals} onSubmit={submitLiveIngress} />
            )}
            {activeSection === "activity" && (
              <ActivityPage canRead={canReadIngress} refreshKey={refreshKey} activeEventId={selectedActivity?.event_id ?? ""} highlightedEventId={highlightedEventId} onSelect={selectHistoryEntry} onConnection={handleConnection} />
            )}
            {activeSection === "simulator" && (
              simulatorAvailable && <SimulatorPage selectedCase={selectedCase} result={demoResult} pending={demoPending} error={demoError} jevStatus={jevStatus} jevEvaluation={jevEvaluation} jevPending={jevPending} jevError={jevError} onSelect={selectDemoCase} onSubmit={runDemoScenario} onEvaluate={runJevEvaluation} />
            )}
            {activeSection === "settings" && (
              <AISettingsPage canConfigureAI={canConfigureAI} userId={session?.user.id} backendStatus={backendStatus} sessionLoading={sessionLoading} hasSession={Boolean(session)} />
            )}
            {activeSection === "admin" && canOpenAdmin && adminTab && <AdminPanel permissions={permissions} tab={adminTab} onTabChange={selectAdminTab} backendOnline={backendStatus === "online"} />}
            {activeSection === "notFound" && <NotFoundPage onHome={() => navigateToPath("/resumen")} />}
          </div>
        </ErrorBoundary>

        {selectedActivity && <IngressDetailSheet entry={selectedActivity} onClose={() => setSelectedActivity(null)} returnFocusRef={activityReturnFocusRef} canReview={canReview} reviewerName={reviewerName} onReview={resolveClassification} />}

        {badgeOpen && session && <Sheet eyebrow="MI ACCESO" title="Mi gafete QR" subtitle={session.user.display_name} closeLabel="Cerrar gafete" onClose={() => setBadgeOpen(false)}>
          <div className="badgeSheet">
            <p>Guarda este QR para tu próximo acceso. {session.user.auth_method === "totp" ? "El código de tu app autenticadora sigue siendo obligatorio." : session.user.auth_method === "password" ? "Tu contraseña y el código de tu app autenticadora siguen siendo obligatorios." : "Después de escanearlo debes completar el acceso corporativo."}</p>
            <QRCard value={session.user.employee_id ? `vigilia:employee:${session.user.employee_id}` : `vigilia:admin:${session.user.id}`} label={`Gafete de ${session.user.display_name}`} download />
          </div>
        </Sheet>}

        {passwordOpen && session?.user.auth_method === "password" && <Sheet eyebrow="MI ACCESO" title="Cambiar contraseña" subtitle={session.user.display_name} closeLabel="Cerrar" onClose={() => setPasswordOpen(false)}>
          <div className="badgeSheet">
            <PasswordChangeForm accountId={session.user.employee_id ?? ""} onDone={(next) => { setSession(next); setPasswordOpen(false); toast.success("Contraseña cambiada. Tus otras sesiones se cerraron."); }} />
          </div>
        </Sheet>}

        <footer className="pageFooter clientFooter">
          <span className="footerBrand">Vigilia</span>
          <span>Coordinación administrativa de ingresos</span>
          <span className={`footerEnv ${serverMode === "production" ? "prod" : "demo"}`}>{serverMode === "production" ? "Producción" : "Demo · datos ficticios"}</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
