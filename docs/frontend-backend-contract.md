# Integración del frontend con Vigilia API

## Fuente de verdad

El contrato se ajustó al backend publicado en `backend/app/schemas.py` y `backend/docs/contratos.md` del repositorio BillieJSON. La interfaz mantiene un modelo visual propio y transforma las claves españolas de la API en `src/lib/agentApi.ts`.

## Solicitud

Al pulsar **Procesar ingreso**, el frontend envía `POST /webhook/ingreso` con un escenario sintético:

```json
{
  "evento_id": "ING-DEMO-MB2Z8K1",
  "cedula": "8-400-400",
  "hospital": "Hospital Punta Pacífica · Emergencias",
  "motivo_ingreso": "Dolor torácico opresivo",
  "fecha_ingreso": "2026-09-24T19:42:00.000Z"
}
```

`triage` es opcional y no se envía en los casos de muestra. Las cédulas sintéticas corresponden a los fixtures documentados por el backend: `8-100-100`, `8-200-200`, `8-300-300`, `8-400-400`, `8-500-500` y `9-999-999`.

Con la API configurada, la cabecera consulta `GET /health` para distinguir un servicio en línea de uno no disponible y la sección **Actividad reciente** lee `GET /ingresos?limite=10`. Sin URL configurada, muestra solo los resultados de la sesión actual y los identifica como locales.

GitHub registra actualmente el servicio `Production – vigilia-api` en [`https://vigilia-5k24gdyol-rgkue.vercel.app`](https://vigilia-5k24gdyol-rgkue.vercel.app). Esa es una URL observada en el despliegue, aún pendiente de verificación desde el frontend y de confirmar como dominio estable; no se configura como predeterminada.

## Respuesta

La API devuelve `evento_id`, `veredicto`, `nivel_alerta`, `poliza`, `preexistencias`, `mensaje_admisiones`, `mensaje_gestor` y `notificaciones`. Los valores posibles de `veredicto` son `VALIDA`, `VALIDA_CON_ALERTAS`, `NO_VALIDA` y `NO_ENCONTRADO`; los niveles son `BAJO`, `MEDIO` y `ALTO`.

Las notificaciones tienen un `destino`, un `canal` y un `estado`. El frontend muestra por separado el canal y el resultado. El módulo publicado `backend/app/notifier.py` inicia ambos envíos en paralelo con `asyncio.gather`; sin URL de Slack, devuelve `canal: "log"` y `estado: "ENVIADA"` para cada aviso simulado. La copia local además requiere `SLACK_ENABLED=true` y un webhook configurado para enviar a Slack; su valor predeterminado es `false`. La interfaz identifica `log` como simulación del servidor; para `canal: "slack"`, muestra `ENVIADA` o el error reportado.

El backend local prioriza Kev (VIGILIA_AI_PROVIDER=kev) y también integra el proveedor Groq de origin/main (VIGILIA_AI_PROVIDER=groq). No cambia de proveedor automáticamente. Las salidas de Jev, Kev y Groq se normalizan en la interfaz a una clasificación interna con condición, relación, probabilidad opcional, explicación, origen y marca de revisión humana. El contrato FastAPI conserva PreexistenciaRelacionada.relacion limitado a DIRECTA, POSIBLE y NINGUNA; PENDIENTE es un estado de interfaz derivado del prefijo Revisión humana pendiente:. Las respuestas inválidas y el respaldo de reglas opcional también quedan pendientes. Ninguna sugerencia se convierte en una decisión clínica ni administrativa.

## Configuración y manejo de claves

Crear `.env.local` desde `.env.example` y establecer `VITE_API_BASE_URL` con la URL del servicio FastAPI. `VITE_INGRESO_PATH` puede cambiar la ruta si el backend la mueve.

Para la demo local, React escucha solo en `127.0.0.1:5173` y FastAPI limita CORS a ese origen por defecto. En otro despliegue, configura `VIGILIA_CORS_ORIGINS` con una lista explícita de orígenes; no uses `*` con un backend que guarda eventos.

El backend acepta la clave `X-Vigilia-Key` solo cuando el servidor tiene `VIGILIA_KEY` configurada. El navegador no envía esa clave: todas las variables `VITE_*` quedan incluidas en el JavaScript público. Si el despliegue de demostración exige clave, el equipo debe habilitar una integración pública acotada o un proxy de servidor; no se debe copiar `VIGILIA_KEY`, Anthropic ni Slack al frontend.

Si el historial o el webhook responde `401`, la interfaz indica que la clave no debe exponerse en el navegador y que se necesita una ruta pública acotada o un proxy seguro. Si el servicio responde `429`, pide esperar un minuto antes de reintentar.

## Alcance de la demo

- Sin URL de API, los seis escenarios se simulan localmente; no se llama al backend ni a Slack.
- Con URL configurada, solo se envía un evento cuando alguien pulsa el botón. No hay envío ni reintento automático.
- El backend guarda los eventos procesados. El backend publicado puede enviar a Slack si existen webhooks configurados; la copia local también exige `SLACK_ENABLED=true`. `canal: "log"` indica que el aviso se simuló en el servidor.
- Usar solo los datos sintéticos de los fixtures. El resultado es una señal administrativa: no hace triage clínico ni decide si una persona recibe atención.
