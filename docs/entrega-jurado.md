# Entrega al jurado: guía del equipo

El reto 4 pide un **enlace público del agente funcional** y el **enlace al repositorio**, enviados a hackiathon@viamatica.com. Esta guía deja la instalación de evaluación lista y verificada.

| Qué | Dónde |
|---|---|
| Aplicación: Demo y Producción en la misma instalación | `https://vigilia-health.vercel.app` (proyecto de Vercel `vigilia-app`, base Neon ya conectada) |
| Documentación en vivo | `https://vigilia-project-pi.vercel.app` (proyecto de Vercel `vigilia-project`, directorio raíz `panel/`) |
| Repositorio | `https://github.com/rgkue/vigilia-project` (público) |

La aplicación corre en modo **producción** con el **modo Demo dentro** (`VIGILIA_DEMO_ACCESS=true`):
- **Demo:** entra sin credenciales con una cuenta de operación, que no administra personas ni integraciones.
- **Producción:** entra con las cuentas del jurado (TOTP y contraseña).

Los dos modos comparten las fuentes: la aseguradora simulada, la IA real y los avisos a Slack.

## 1. Generar credenciales y variables

Desde la raíz del repositorio:

```powershell
node scripts/credenciales-jurado.mjs --url https://vigilia-health.vercel.app
```

Si ya generaste credenciales antes y aún no las enviaste al jurado, añade `--forzar` para reemplazarlas. El comando crea `entrega-privada/`, una carpeta excluida de git:

| Archivo | Qué es |
|---|---|
| `vercel.env` | Variables del proyecto de Vercel |
| `credenciales-jurado.md` | Texto para el correo al jurado |
| `qr-jurado-admin.png`, `qr-jurado-recepcion.png` | QR para la app autenticadora |

En `vercel.env`, reemplaza los valores `PEGA_AQUI_…`:
- la clave de Ollama Cloud;
- las dos URLs de los webhooks de Slack.

## 2. Variables del proyecto `vigilia-app`

1. **Settings → Environment Variables → Add:** pega el contenido de `vercel.env` y elige el entorno **Production**.
   - Si una variable ya existe (por ejemplo `VIGILIA_MODE` o `VIGILIA_KEY`), edítala en lugar de duplicarla.
   - Conserva `DATABASE_URL`, `VIGILIA_SESSION_SECRET` y `VIGILIA_SECRET_ENCRYPTION_KEY`.
   - Puedes borrar `API_BASE_URL`, `VIGILIA_DEMO_URL` y `VIGILIA_PRODUCTION_URL`, que esta configuración no usa.
2. **Settings → Domains:** `vigilia-health.vercel.app` debe estar asignado a **Production**.
3. **Settings → Deployment Protection:** abre `https://vigilia-health.vercel.app` en una ventana privada. Si pide iniciar sesión en Vercel, desactiva *Vercel Authentication*. El jurado y las integraciones simuladas llaman a ese dominio.

## 3. Documentación en vivo (`vigilia-project`)

El proyecto de Vercel `vigilia-project` publica la carpeta `panel/`.
- Es una página estática que lee el README y las guías de `docs/` desde GitHub (rama `main`) en cada visita, así que siempre coincide con el repositorio.
- No necesita variables. Cada fusión en `main` la vuelve a desplegar.

## 4. Fusionar y desplegar

Fusiona el PR en `main`. Los proyectos despliegan solos.

Si cambiaste variables después del último despliegue, haz **Redeploy** en `vigilia-app`. Las variables `VITE_*` se leen al compilar y las del servidor, al arrancar.

## 5. Verificación final

Hazla en una ventana privada, sin nada local:

- [ ] `https://vigilia-health.vercel.app/api/public-config` responde `"mode": "production"` y `"demo_access": true`.
- [ ] Al abrir la aplicación aparece el selector de modo.
- [ ] **Demo:**
  - [ ] **Entrar modo Demo** entra sin credenciales y muestra "Demo · datos ficticios" en el pie.
  - [ ] En **Configuración de IA**, Ollama aparece verificada y activa.
- [ ] Ejecuta:

  ```powershell
  ./scripts/demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Clave vigilia-jurado-2026
  ```

  - [ ] Salen cinco resultados, con fuentes `connected` y sugerencias "Ollama sugiere…".
  - [ ] Los avisos salen como `ENVIADA`.
  - [ ] Llegan mensajes `Demo · …` a los dos canales de Slack.
- [ ] En Actividad, al abrir el ingreso de asma y confirmar DIRECTA:
  - [ ] el nivel pasa a *Prioridad administrativa*;
  - [ ] llega `Demo · Actualización tras revisión humana…` a ambos canales.
- [ ] **Producción:**
  - [ ] Con **Cambiar modo → Producción**, entra `JURADO-ADMIN` con código y contraseña.
  - [ ] **Administración → Integraciones** muestra las cinco integraciones simuladas, y **Probar** responde conectado.
- [ ] Ejecuta:

  ```powershell
  ./scripts/demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Modo produccion -Token <VIGILIA_JURY_INGRESS_TOKEN>
  ```

  - [ ] Los avisos salen como `ENVIADA`.
  - [ ] Llegan mensajes `Producción · …` a Slack.
- [ ] `JURADO-RECEPCION` entra solo con el código y puede registrar un ingreso.
- [ ] `https://vigilia-project-pi.vercel.app` muestra el README actualizado.
- [ ] `https://github.com/rgkue/vigilia-project` abre sin sesión, y la CI y los despliegues del último commit están en verde.
- [ ] Guarda capturas en [`docs/evidencia/`](evidencia/):
  - los dos canales de Slack;
  - Actividad;
  - el detalle con la actualización tras la revisión.

## 6. Correo al jurado

**Para:** hackiathon@viamatica.com
**Asunto:** hackIAthon 2026 · Reto 4 · Vigilia: alerta temprana de ingresos a emergencias

> Reto elegido: 4, Sistema de Alerta Temprana de Ingresos a Emergencias.
>
> Enlace del agente funcional: https://vigilia-health.vercel.app (al abrirlo se elige modo Demo o Producción).
> Repositorio: https://github.com/rgkue/vigilia-project
> Documentación en vivo: https://vigilia-project-pi.vercel.app
>
> En modo Demo se entra sin credenciales. El README explica cómo evaluarlo en cinco minutos: el webhook con su clave de demostración y qué partes son reales y cuáles ficticias.
> Para el modo Producción adjuntamos las credenciales de evaluación y los QR de TOTP.
>
> [pega aquí el contenido de entrega-privada/credenciales-jurado.md]

Adjunta `qr-jurado-admin.png` y `qr-jurado-recepcion.png`. Si quieres que el jurado vea Slack en vivo, añade un enlace de invitación al workspace.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| En el selector, Demo aparece como no habilitado | Falta `VIGILIA_DEMO_ACCESS=true`, o el proyecto no se redesplegó después de añadirla. |
| El webhook de demostración responde 401 | Falta `VIGILIA_KEY` en el proyecto, o la cabecera `X-Vigilia-Key` no coincide. En producción nunca queda abierto sin clave. |
| `500 FUNCTION_INVOCATION_FAILED` | Revisa *Runtime Logs*. Suelen faltar `VIGILIA_SESSION_SECRET` (32+ caracteres), una `VIGILIA_SECRET_ENCRYPTION_KEY` Fernet válida o `DATABASE_URL`. |
| La IA queda "Revisión humana pendiente: Activa un proveedor…" | Falta `VIGILIA_SHARED_AI_KEY` o `VIGILIA_AI_APPROVED=true`. Redespliega después de añadirla. |
| "El proveedor seleccionado no pudo confirmar la clasificación" | La clave o el modelo de Ollama no son válidos. Pruébalos en **Configuración de IA → Probar 3 casos ficticios**. Usa la clave secreta completa, no el identificador de 32 caracteres que Ollama muestra debajo del nombre. |
| Las fuentes salen `unavailable` o los avisos `ERROR` | El dominio de `VIGILIA_SIMULATED_BASE_URL` no es público o está protegido por *Vercel Authentication*. |
| Un código TOTP es rechazado | Cada código sirve una vez; espera al siguiente (30 s). Si varias personas usan la misma cuenta, cada una espera su código. |
| Alguien cambió una cuenta, la IA compartida o una integración del jurado | Se restablece sola en el siguiente arranque. Para forzarlo, haz **Redeploy**. |
