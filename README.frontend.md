# Vigilia · Frontend

> Esta guía documenta únicamente la interfaz web de Vigilia. No es el README de la aplicación completa; para backend, arquitectura y estado global del proyecto, consulta [`README.md`](README.md).

## Alcance

La interfaz está hecha con React, TypeScript y Vite. Presenta el resumen de coordinación, el registro de ingresos y la actividad reciente, y consume el backend FastAPI mediante su API HTTP.

El frontend no contiene las claves de Kev, Groq, Slack ni otros secretos del servidor. Cualquier variable con prefijo `VITE_` queda disponible para el código del navegador y no debe guardar credenciales.

## Desarrollo local

Requiere Node.js y pnpm compatibles con las versiones del proyecto.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Vite inicia la interfaz en `http://127.0.0.1:5173`.

## Conectar con el backend

Configura las variables del frontend en `.env.local`:

| Variable | Uso |
|---|---|
| `VITE_API_BASE_URL` | URL base del servicio FastAPI. |
| `VITE_INGRESO_PATH` | Ruta del endpoint de ingreso; por defecto, `/webhook/ingreso`. |
| `VITE_LIVE_INGRESS_ENABLED` | Habilita el formulario de registro en la interfaz cuando vale `true`. No configura autenticación ni permisos del backend. |

Ejemplo para desarrollo local:

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_INGRESO_PATH=/webhook/ingreso
VITE_LIVE_INGRESS_ENABLED=false
```

Inicia el backend por separado desde [`backend/`](backend/). Consulta [`backend/docs/contratos.md`](backend/docs/contratos.md) para el contrato de la API y el [`README.md`](README.md) global para la descripción integral del proyecto.
