import { useEffect, useState } from "react";
import "../ai-settings.css";
import { AIAssignments } from "./AIAssignments";
import { Select } from "./Pickers";
import { AISubscriptionConnection } from "./AISubscriptionConnection";
import { getAISettings, getAIModels, saveAIProvider, testAIProvider, selectAIProvider, type AIProviderTestCase, type AISettings } from "../lib/aiProviderApi";

const NOTES: Record<string, string> = {
  groq: "Conecta tu cuenta de Groq para usar sus modelos de clasificación. Los límites dependen de tu cuenta.",
  anthropic: "Usa una clave de Anthropic Console. La suscripción de Claude y el acceso a la API tienen facturación separada.",
  openai: "Conecta ChatGPT / Codex por suscripción mediante el conector privado, o usa una clave de OpenAI Platform con su cuota independiente.",
  ollama: "Ollama Cloud muestra su catálogo público. Ver un modelo en la lista no confirma que tu clave funcione ni que tu plan lo incluya; compruébalo con los casos ficticios. El modo local consulta los modelos instalados en el servidor de Vigilia.",
  zen: "Usa tu clave de OpenCode Zen. Puedes seleccionar Jev o un modelo compatible con Chat Completions. Consulta el precio y la disponibilidad en tu cuenta.",
  xai: "Conecta SuperGrok por suscripción mediante el conector privado, o usa una clave de la consola de xAI.",
};
const STATUS: Record<string, string> = { untested: "Pendiente de prueba", verified: "Conexión comprobada", failed: "Revisar conexión" };
const MODE: Record<string, string> = { oauth: "Suscripción · OAuth", api_key: "Clave de API", cloud: "Ollama Cloud · clave de API", local: "Ollama en el servidor" };
const PROVIDER_PREFERENCE = "vigilia.ai.settings.provider";

function rememberedProvider() {
  try { return sessionStorage.getItem(PROVIDER_PREFERENCE) ?? ""; } catch { return ""; }
}

export function AIProviderSettings() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [provider, setProvider] = useState(rememberedProvider);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("api_key");
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [testCases, setTestCases] = useState<AIProviderTestCase[]>([]);
  const config = settings?.configs.find((item) => item.provider === provider);
  const definition = settings?.providers.find((item) => item.id === provider);
  const dirty = Boolean(secret || model !== (config?.model ?? "") || mode !== (config?.auth_mode ?? definition?.auth_modes[0]));

  async function refresh() { setSettings(await getAISettings()); }
  useEffect(() => { let active = true; getAISettings().then((value) => { if (active) setSettings(value); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "No se pudo cargar la configuración."); }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!settings) return;
    if (!settings.providers.some((item) => item.id === provider)) {
      const preferred = settings.selected !== "none" ? settings.selected
        : settings.configs.find((item) => item.has_secret && item.model)?.provider
          ?? settings.configs[0]?.provider ?? settings.providers[0]?.id ?? "";
      setProvider(preferred);
      return;
    }
    try { sessionStorage.setItem(PROVIDER_PREFERENCE, provider); } catch { /* Storage is optional. */ }
  }, [settings, provider]);
  useEffect(() => {
    setModel(config?.model ?? ""); setMode(config?.auth_mode ?? definition?.auth_modes[0] ?? "api_key");
    setSecret(""); setModels([]); setCustomModel(false);
  }, [provider, config?.revision, definition?.id]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "No se pudo completar la operación."); }
    finally { setBusy(false); }
  }
  async function discoverModels() {
    await run(async () => {
      if (!config || dirty) {
        await saveAIProvider(provider, {
          model, auth_mode: mode, ...(secret ? { secret } : {}), clear_secret: false,
          revision: config?.revision ?? null,
        });
        setSecret("");
        await refresh();
      }
      const result = await getAIModels(provider);
      setModels(result.models);
      setCustomModel(Boolean(model && !result.models.includes(model)));
      setMessage(result.models.length
        ? `${result.models.length} modelos disponibles. Elige uno del catálogo o usa un identificador personalizado.`
        : "El proveedor no devolvió modelos. Puedes introducir un identificador disponible en tu cuenta.");
    });
  }
  return <section className="aiSettings" aria-label="Clasificación automática" aria-busy={busy}>
    {error && <p className="adminNotice error" role="alert">{error}</p>}
    {message && <p className="adminNotice" role="status">{message}</p>}
    {!settings ? <div className="adminEmpty">{error ? <button className="secondaryButton" onClick={() => void run(refresh)}>Volver a cargar</button> : "Cargando proveedores…"}</div> : <>
      {!settings.production_allowed && <p className="adminNotice"><strong>La IA aún no está habilitada para datos reales en esta instalación.</strong> El permiso que se asigna a una cuenta para editar su proveedor personal es distinto de la aprobación global para producción. El administrador técnico debe aprobar el uso y habilitar la clasificación en producción con <code>VIGILIA_AI_APPROVED=true</code>. Mientras tanto, puedes guardar conexiones y probar solo con datos ficticios.</p>}
      <AIAssignments canManage={settings.can_manage_integrations} />
      <div className="aiWorkspace">
        <nav className="aiProviders" aria-label="Proveedores de inteligencia artificial">
          {settings.providers.map((item) => {
            const saved = settings.configs.find((entry) => entry.provider === item.id);
            return <button type="button" key={item.id} disabled={busy} aria-pressed={provider === item.id} className={`aiProvider glassPanel${provider === item.id ? " selected" : ""}`} onClick={() => { setProvider(item.id); setError(""); setMessage(""); }}>
              <strong>{item.name}</strong><span>{settings.selected === item.id ? "Seleccionado · " : ""}{saved ? STATUS[saved.status] : "Sin configurar"}</span>
            </button>;
          })}
        </nav>
        <form className="adminEditor glassPanel aiEditor" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await saveAIProvider(provider, { model, auth_mode: mode, ...(secret ? { secret } : {}), clear_secret: false, revision: config?.revision ?? null });
          setSecret(""); await refresh();
          if (mode === "oauth") {
            setModels([]); setMessage("Conexión guardada. Autoriza la suscripción para consultar los modelos.");
            return;
          }
          try {
            const result = await getAIModels(provider);
            setModels(result.models); setCustomModel(Boolean(model && !result.models.includes(model)));
            setMessage(result.models.length
              ? `Conexión guardada. Encontré ${result.models.length} modelos; selecciona uno del catálogo o escribe uno personalizado.`
              : "Conexión guardada. El proveedor no devolvió modelos; puedes escribir un identificador disponible en tu cuenta.");
          } catch (err) {
            setModels([]);
            setMessage(`Conexión guardada, pero no pude cargar el catálogo. ${err instanceof Error ? err.message : "Revisa la clave y vuelve a consultar los modelos."}`);
          }
        }); }}>
          <div className="adminSectionHead"><div><span className="eyebrow">PROVEEDOR Y MODELO</span><h2>{definition?.name}</h2></div></div>
          <p className="adminHelp">{NOTES[provider]}</p>
          <fieldset className="aiFields" disabled={busy}>
            <label className="adminField"><span>Método de conexión</span><Select value={mode} onChange={(next) => { setMode(next); setSecret(""); setModels([]); }} options={(definition?.auth_modes ?? []).map((value) => ({ value, label: MODE[value] ?? value }))} /></label>
            {mode !== "local" && mode !== "oauth" && <>
              <label className="adminField aiSecretField"><span>Clave de API · {definition?.name}</span><span className="aiSecretControl"><input type="password" autoComplete="new-password" maxLength={4096} value={config?.has_secret ? "••••••••••••••••••••" : secret} disabled={Boolean(config?.has_secret)} onChange={(event) => setSecret(event.target.value)} placeholder="Introduce la clave de tu proveedor" aria-describedby="ai-secret-help" />{config?.has_secret && <span className="aiSecretSaved" role="status">Guardada</span>}</span></label>
              {provider === "ollama" && mode === "cloud" && <p className="adminHelp">Pega el valor secreto completo entregado al crear la API key en Ollama. El identificador visible debajo del nombre de la clave no permite iniciar consultas.</p>}
              <p className="adminHelp" id="ai-secret-help">{config?.has_secret ? "La clave está guardada y el campo está bloqueado. Para introducir otra, usa el botón Eliminar clave." : "La clave se cifra en el servidor y no se vuelve a mostrar. Solo se utiliza para las clasificaciones autorizadas por ti."}</p>
            </>}
            <>{mode === "oauth" && <AISubscriptionConnection key={provider} provider={provider} revision={config?.revision} disabled={busy || dirty || config?.auth_mode !== "oauth"} onRefresh={refresh} />}</>
            <div className="adminField"><span>Modelo</span>{models.length > 0 && !customModel
              ? <Select aria-label="Modelo" value={model} onChange={(next) => {
                  if (next === "__custom__") { setCustomModel(true); setModel(""); }
                  else setModel(next);
                }} options={[{ value: "", label: "Selecciona un modelo" }, ...models.map((id) => ({ value: id, label: id })), { value: "__custom__", label: "Escribir un modelo personalizado…" }]} />
              : <input autoComplete="off" value={model} maxLength={150} placeholder="Escribe el identificador del modelo" onChange={(event) => setModel(event.target.value)} />}
              {customModel && models.length > 0 && <button className="adminTextButton" type="button" onClick={() => { setCustomModel(false); setModel(""); }}>Elegir del catálogo</button>}
            </div>
            <button className="secondaryButton" type="button" disabled={busy || (mode !== "local" && mode !== "oauth" && !secret && !config?.has_secret) || (mode === "oauth" && (!config || config.auth_mode !== "oauth"))} onClick={() => void discoverModels()}>Consultar modelos</button>
            <p className="adminHelp">Al guardar o consultar, Vigilia obtiene el catálogo del proveedor y muestra los modelos en la lista. También puedes escribir un identificador personalizado. Cada modelo debe superar una prueba con tu conexión antes de activarse.</p>
          <div className="adminFormActions">
              <button className="primaryButton" type="submit">Guardar conexión</button>
              <button className="secondaryButton" type="button" disabled={!config || dirty || !model} onClick={() => void run(async () => { setTestCases([]); const result = await testAIProvider(provider, config!.revision); setTestCases(result.cases ?? []); await refresh(); if (result.ok) setMessage(result.message); else setError(result.message); })}>Probar 3 casos ficticios</button>
              <button className="secondaryButton" type="button" title={!settings.production_allowed ? "El administrador técnico debe habilitar la clasificación en producción para esta instalación." : undefined} disabled={!config || dirty || config.status !== "verified" || settings.selected === provider || !settings.production_allowed} onClick={() => void run(async () => { await selectAIProvider(provider, config!.revision); await refresh(); setMessage("Proveedor activado para tus clasificaciones."); })}>Activar clasificación</button>
              <button className="secondaryButton" type="button" disabled={!config?.has_secret} onClick={() => void run(async () => {
                if (!config) return;
                await saveAIProvider(provider, { model: config.model, auth_mode: config.auth_mode, clear_secret: true, revision: config.revision });
                setSecret(""); setTestCases([]); await refresh();
                setMessage("Clave eliminada de Vigilia. Ya puedes introducir una nueva.");
              })}>Eliminar clave</button>
            </div>
          {testCases.length > 0 && <section className="aiTestResults" aria-live="polite" aria-label="Resultados de casos ficticios">
            <h3>Resultados de la prueba</h3>
            <p>Salida real del modelo para ejemplos inventados. La conexión se verifica si las respuestas tienen un formato válido; la coincidencia con la etiqueta de referencia es orientativa, porque estos casos sirvieron para ajustar las instrucciones.</p>
            <div className="aiTestCaseList">{testCases.map((testCase) => <article className="aiTestCase" key={testCase.id}>
              <header><strong>{testCase.label}</strong><span className={testCase.valid ? "aiTestValid" : "aiTestInvalid"}>{testCase.valid ? "Respuesta válida" : "Sin respuesta válida"}</span></header>
              <p><b>Ingreso:</b> {testCase.motive}</p>
              <p><b>Condición:</b> {testCase.condition}</p>
              <p><b>Referencia:</b> {testCase.expected} · <b>Modelo:</b> {testCase.actual}{testCase.valid && testCase.match !== undefined ? ` · ${testCase.match ? "Coincide" : "No coincide"}` : ""}</p>
              <p><b>{testCase.valid ? "Justificación del modelo" : "Detalle del fallo"}:</b> {testCase.justification}</p>
            </article>)}</div>
          </section>}
          </fieldset>
          <details className="aiAuthHelp"><summary>Suscripciones y métodos de conexión</summary><p>ChatGPT / Codex y SuperGrok se conectan por suscripción mediante el conector privado OpenCode. Vigilia no ofrece el inicio de sesión por suscripción de Claude: para usar modelos de Anthropic, configura una clave de API de Anthropic Console, con facturación independiente de Claude Pro o Max. Ollama Cloud usa una clave de API; la conexión con Ollama local solo está disponible si el administrador de esta instalación la habilitó.</p></details>
        </form>
      </div>
    </>}
  </section>;
}
