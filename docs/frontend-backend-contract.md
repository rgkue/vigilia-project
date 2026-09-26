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

La interfaz de producción usa `/api` por defecto; en Vercel, `api/index.py` monta allí la API FastAPI del repositorio. En desarrollo, Vite conserva su proxy local. Si el backend se despliega aparte, `VITE_API_BASE_URL` permite apuntar al servicio externo. Con la API disponible, la cabecera consulta `GET /health` y **Actividad reciente** lee `GET /ingresos?limite=10`.

Las instalaciones públicas de evaluación son `https://vigilia-reto4-demo.vercel.app` (modo demo) y `https://vigilia-reto4.vercel.app` (producción de muestra). `GET /public-config` devuelve el modo y ambas direcciones (`demo_url`, `production_url`), que usa el selector de modo al abrir la aplicación. El despliegue se describe en [`entrega-jurado.md`](entrega-jurado.md).

## Respuesta

La API devuelve `evento_id`, `veredicto`, `nivel_alerta`, `poliza`, `preexistencias`, `mensaje_admisiones`, `mensaje_gestor` y `notificaciones`. Los valores posibles de `veredicto` son `VALIDA`, `VALIDA_CON_ALERTAS`, `NO_VALIDA`, `NO_ENCONTRADO` y `PENDIENTE` (una fuente de producción falló o no está configurada); los niveles son `BAJO`, `MEDIO` y `ALTO`. Tras una revisión humana que cambia el resultado, `actualizaciones` registra el cambio y los avisos reenviados.

Las notificaciones tienen un `destino`, un `canal` y un `estado`. El frontend muestra por separado el canal y el resultado. `backend/app/notifier.py` inicia ambos envíos en paralelo con `asyncio.gather`. En demo envía a Slack si `SLACK_ENABLED=true` y hay webhooks configurados; sin ellos devuelve `canal: "log"` y `estado: "SIMULADA"`, nunca `ENVIADA`. En producción envía a las integraciones `admissions` y `case_manager` y devuelve `ENVIADA`, `ERROR` o `NO_CONFIGURADA`.

El backend local prioriza Kev (VIGILIA_AI_PROVIDER=kev) y también integra el proveedor Groq de origin/main (VIGILIA_AI_PROVIDER=groq). No cambia de proveedor automáticamente. Las salidas de Jev, Kev y Groq se normalizan en la interfaz a una clasificación interna con condición, relación, probabilidad opcional, explicación, origen y marca de revisión humana. El contrato FastAPI conserva PreexistenciaRelacionada.relacion limitado a DIRECTA, POSIBLE y NINGUNA; PENDIENTE es un estado de interfaz derivado del prefijo Revisión humana pendiente:. Las respuestas inválidas y el respaldo de reglas opcional también quedan pendientes. Ninguna sugerencia se convierte en una decisión clínica ni administrativa.

## Configuración y manejo de claves

Crear `.env.local` desde `.env.example`. Para el backend local basta dejar `VITE_API_BASE_URL` vacío: Vite reenvía sus rutas API a FastAPI. En producción, la API se monta en `/api`; para un backend en otro dominio, define `VITE_API_BASE_URL` durante la compilación. `VITE_INGRESO_PATH` puede cambiar la ruta si el backend la mueve.

Para la demo local, React escucha solo en `127.0.0.1:5173` y FastAPI limita CORS a ese origen por defecto. En otro despliegue, configura `VIGILIA_CORS_ORIGINS` con una lista explícita de orígenes; no uses `*` con un backend que guarda eventos.

En demo, el webhook exige `X-Vigilia-Key` a los sistemas externos cuando el servidor tiene `VIGILIA_KEY`. El simulador del navegador no usa esa clave: se identifica con la sesión iniciada y su token CSRF, y necesita el permiso `ingress.submit`. No se copia `VIGILIA_KEY`, Slack ni ninguna clave de IA a variables `VITE_*`, porque quedan en el JavaScript público.

Si el servicio responde `429`, la interfaz pide esperar un minuto antes de reintentar.

## Alcance de la demo

- El simulador solo existe en modo demo. En desarrollo sin backend, los seis escenarios se simulan en el navegador; con backend, cada escenario se envía al webhook demo.
- Con URL configurada, solo se envía un evento cuando alguien pulsa el botón. No hay envío ni reintento automático.
- El backend guarda los eventos procesados. Envía a Slack si `SLACK_ENABLED=true` y hay webhooks configurados; si no, el aviso queda como `SIMULADA` (`canal: "log"`).
- Usar solo los datos sintéticos de los fixtures. El resultado es una señal administrativa: no hace triage clínico ni decide si una persona recibe atención.
