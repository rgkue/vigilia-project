import { ResultPanel } from "../components/ResultPanel";
import { Icon } from "../components/Icon";
import { demoCases } from "../data/demoCases";
import { jevRelationLabel } from "../lib/labels";
import type { AgentResponse, DemoCase, JevEvaluation } from "../types";

export type JevStatus = "checking" | "configured" | "missing" | "unavailable";

function CaseOption({
  demoCase,
  selected,
  onSelect,
  index,
}: {
  demoCase: DemoCase;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <label className={`caseOption${selected ? " selected" : ""}`}>
      <input type="radio" name="demo-case" checked={selected} onChange={onSelect} />
      <span className="caseNumber">{String(index + 1).padStart(2, "0")}</span>
      <span className="caseCopy">
        <strong>{demoCase.label}</strong>
        <small>{demoCase.caption}</small>
      </span>
      <span className="radioMark" aria-hidden="true"><span /></span>
    </label>
  );
}

function JevExperiment({
  availability,
  enabled,
  evaluation,
  pending,
  error,
  onEvaluate,
}: {
  availability: JevStatus;
  enabled: boolean;
  evaluation: JevEvaluation | null;
  pending: boolean;
  error: string;
  onEvaluate: () => void;
}) {
  const availabilityMessage = availability === "configured"
    ? "Credencial privada detectada. El primer caso sintético confirmará el acceso al modelo."
    : availability === "missing"
      ? "Agrega AI_GATEWAY_API_KEY a .env.local y reinicia pnpm dev; en Vercel también se admite OIDC. El archivo está ignorado por Git."
      : availability === "unavailable"
        ? "La ruta de prueba está disponible en pnpm dev o Vercel; Vite Preview no ejecuta funciones API."
        : "Comprobando el entorno privado de Jev…";

  return (
    <section className="jevExperiment" aria-live="polite" aria-busy={pending}>
      <div className="jevExperimentHead">
        <div>
          <span className="eyebrow">EXPERIMENTO · DATOS SINTÉTICOS</span>
          <h3>Probar clasificación Jev</h3>
          <p>{availabilityMessage}</p>
        </div>
        <span className={`jevState ${availability}`}><i />{availability === "configured" ? "Credencial lista" : availability === "missing" ? "Falta la clave" : availability === "unavailable" ? "Ruta no disponible" : "Comprobando"}</span>
      </div>
      <div className="jevExperimentAction">
        <span>{enabled ? "Solo se envía el identificador de este caso de prueba; el servidor toma sus datos ficticios." : "Este escenario no tiene antecedentes sintéticos para comparar."}</span>
        <button className="secondaryButton" type="button" onClick={onEvaluate} disabled={!enabled || availability !== "configured" || pending}>
          {pending ? <><span className="buttonSpinner" />Consultando…</> : <>Evaluar con Jev <Icon name="spark" size={15} /></>}
        </button>
      </div>
      {error && <p className="jevError" role="alert">{error}</p>}
      {evaluation && (
        <div className="jevSuggestions">
          {evaluation.suggestions.map((suggestion) => (
            <div className="jevSuggestion" key={suggestion.condition}>
              <strong>{suggestion.condition}</strong>
              <span>{jevRelationLabel(suggestion.relation)}</span>
              <small>{suggestion.probability === null ? "Sin probabilidad válida" : `Probabilidad asignada: ${Math.round(suggestion.probability * 100)}%`}</small>
            </div>
          ))}
          <p className="jevDisclaimer">{evaluation.note} La probabilidad del modelo no es una tasa de acierto.</p>
          <details className="jevRoutingAudit">
            <summary>{evaluation.routingAudit?.noTrainingRequested ? "Filtro No Training indicado por AI Gateway" : "Ruta de privacidad no verificada"}</summary>
            {evaluation.routingAudit?.finalProvider && <span>Proveedor: {evaluation.routingAudit.finalProvider}</span>}
            {evaluation.routingAudit?.planningReasoning && <p>{evaluation.routingAudit.planningReasoning}</p>}
            {!evaluation.routingAudit?.planningReasoning && <p>La respuesta no incluyó metadatos de enrutamiento suficientes para confirmar la política.</p>}
          </details>
        </div>
      )}
    </section>
  );
}

export function SimulatorPage({
  selectedCase,
  result,
  pending,
  error,
  jevStatus,
  jevEvaluation,
  jevPending,
  jevError,
  onSelect,
  onSubmit,
  onEvaluate,
}: {
  selectedCase: DemoCase | null;
  result: AgentResponse | null;
  pending: boolean;
  error: string;
  jevStatus: JevStatus;
  jevEvaluation: JevEvaluation | null;
  jevPending: boolean;
  jevError: string;
  onSelect: (id: string) => void;
  onSubmit: () => void;
  onEvaluate: () => void;
}) {
  return (
    <div className="pageStack simulatorPage">
      <header className="pageIntro">
        <span className="eyebrow">ÁREA DE PRUEBAS · HACKIATHON · RETO 04</span>
        <h1>Simulador</h1>
        <p>Recorre casos sintéticos y compara integraciones experimentales en un espacio separado del flujo operativo.</p>
      </header>
      <aside className="simulatorSafety" role="note"><Icon name="shield" size={18} /><div><strong>Usa únicamente datos ficticios</strong><p>No introduzcas información de pacientes. Los resultados no son clínicos, no determinan cobertura y requieren revisión humana.</p></div></aside>
      <div className="simulatorLayout">
        <section className="glassPanel simulatorCases">
          <div className="formPanelHeading"><div><span className="eyebrow">ESCENARIOS</span><h2>Selecciona un caso de prueba</h2></div><span className="simulatorTag">DATOS SINTÉTICOS</span></div>
          <p className="panelIntro">Cada escenario contiene una referencia ficticia y un resultado esperado para probar el flujo.</p>
          <fieldset className="caseFieldset" disabled={pending}><legend className="srOnly">Escenario de prueba</legend>{demoCases.map((demoCase, index) => <CaseOption key={demoCase.id} demoCase={demoCase} selected={selectedCase?.id === demoCase.id} onSelect={() => onSelect(demoCase.id)} index={index} />)}</fieldset>
          {selectedCase && <div className="eventPreview" key={selectedCase.id} aria-live="polite"><div className="previewHead"><span className="eyebrow">REFERENCIA FICTICIA</span><span className="previewId">{selectedCase.id}</span></div><div className="previewGrid"><div><span>Centro de atención</span><strong>{selectedCase.hospitalName}</strong></div><div><span>Identificación</span><strong>{selectedCase.insuredId}</strong></div><div className="previewWide"><span>Motivo</span><strong>{selectedCase.reason}</strong></div>{selectedCase.preexistingConditions.length > 0 && <div className="previewWide"><span>Antecedentes ficticios</span><strong>{selectedCase.preexistingConditions.join(" · ")}</strong></div>}</div></div>}
          <JevExperiment availability={jevStatus} enabled={Boolean(selectedCase?.preexistingConditions.length)} evaluation={jevEvaluation} pending={jevPending} error={jevError} onEvaluate={onEvaluate} />
          {error && <div className="errorBanner" role="alert"><span className="errorMark">!</span><div><strong>No se pudo ejecutar el escenario</strong><p>{error}</p><small>El evento no se reenvió automáticamente.</small></div></div>}
          <div className="simulatorAction"><p>El caso se envía al backend cuando está configurado; de lo contrario, se procesa solo en este navegador.</p><button className="primaryButton" type="button" onClick={onSubmit} disabled={!selectedCase || pending}>{pending ? <><span className="buttonSpinner" />Procesando…</> : <>Ejecutar escenario <Icon name="arrow" size={16} /></>}</button></div>
        </section>
        <div className="simulatorResult"><ResultPanel result={result} pending={pending} simulator emptyDescription="Selecciona un escenario para ver la respuesta y el estado de sus avisos." /></div>
      </div>
      <section className="simulatorLimits">
        <div className="limitsIntro"><span className="eyebrow">ESTADO DE VALIDACIÓN</span><h2>Integraciones aún no aprobadas para datos reales</h2><p>Esta aplicación conserva el contexto técnico y los límites que deben revisarse antes de activar un flujo real.</p></div>
        <div className="limitGrid">
          <article><span>01 · Persistencia</span><h3>Registros de muestra</h3><p>La demo carga en su base de datos asegurados, pólizas y antecedentes ficticios. No es una base de clientes: en producción esos datos llegan desde las integraciones de la aseguradora.</p></article>
          <article><span>02 · Acceso</span><h3>Permisos del servicio</h3><p>La clave opcional del backend no reemplaza autenticación de usuarios, roles, auditoría y autorización comprobada desde el servidor.</p></article>
          <article><span>03 · IA y avisos</span><h3>Revisión humana</h3><p>El modelo de IA solo sugiere relaciones; una persona las confirma y el resultado se recalcula. Un aviso marcado como simulado no salió del servidor.</p></article>
        </div>
        <p className="featureGateNote"><code>VITE_LIVE_INGRESS_ENABLED</code> solo controla la interfaz; no protege la API. El backend debe aplicar sus propias reglas antes de tratar datos reales.</p>
      </section>
    </div>
  );
}
