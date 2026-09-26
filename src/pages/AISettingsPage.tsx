import { AIProviderSettings } from "../components/AIProviderSettings";
import { isBackendConfigured } from "../lib/agentApi";

/** Contenido sin cambios respecto a la versión anterior de /configuracion; solo cambia su archivo. */
export function AISettingsPage({ canConfigureAI, userId, backendStatus, sessionLoading, hasSession }: {
  canConfigureAI: boolean;
  userId?: string;
  backendStatus: string;
  sessionLoading: boolean;
  hasSession: boolean;
}) {
  if (canConfigureAI) {
    return (
      <div className="clientPageStack adminPage">
        <header className="pageIntro clientPageIntro"><span className="eyebrow">PREFERENCIAS PERSONALES</span><h1>Configuración de IA</h1><p>Conecta tus cuentas y elige el proveedor que usará tu cuota para preparar sugerencias de clasificación.</p></header>
        <AIProviderSettings key={userId} />
      </div>
    );
  }
  return (
    <div className="clientPageStack adminPage"><header className="pageIntro clientPageIntro"><span className="eyebrow">CONFIGURACIÓN DE IA</span><h1>Configura los proveedores</h1><p>{!isBackendConfigured ? "La conexión con el backend no está configurada en esta aplicación. Al conectar la API de Vigilia, podrás verificar tu sesión y tus permisos aquí." : backendStatus === "offline" ? "El backend de Vigilia no responde ahora. Cuando vuelva a estar disponible, podrás consultar el acceso a esta página." : sessionLoading ? "Estamos verificando tu sesión y el acceso a esta página." : !hasSession ? "Inicia sesión en Vigilia para consultar el acceso a esta configuración." : "Actualiza la sesión para cargar tus conexiones personales."}</p></header></div>
  );
}
