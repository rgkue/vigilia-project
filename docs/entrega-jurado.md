# Entrega al jurado: guía del equipo

El reto 4 pide un **enlace público del agente funcional** y el **enlace al repositorio**, enviados a hackiathon@viamatica.com. Esta guía deja las dos instalaciones de evaluación listas y verificadas.

| Proyecto de Vercel | Modo | Dominio público | Base de datos |
|---|---|---|---|
| `vigilia-app` (ya existe) | Producción de muestra | `https://vigilia-reto4.vercel.app` | Neon, la base ya conectada |
| `vigilia-demo` (nuevo) | Demo | `https://vigilia-reto4-demo.vercel.app` | Neon, base nueva `vigilia_demo` |

Los dos proyectos despliegan el mismo repositorio y la rama `main`. Solo cambian sus variables.

> El dominio `vigilia-app.vercel.app` pertenece a otra aplicación. El dominio del equipo, `vigilia-app-rgkue.vercel.app`, pide iniciar sesión en Vercel. Por eso cada proyecto necesita un dominio `.vercel.app` propio y público.

## 1. Generar credenciales y variables

Desde la raíz del repositorio:

```powershell
node scripts/credenciales-jurado.mjs --demo-url https://vigilia-reto4-demo.vercel.app --produccion-url https://vigilia-reto4.vercel.app
```

El comando crea `entrega-privada/`, una carpeta excluida de git:

| Archivo | Qué es |
|---|---|
| `vercel-produccion.env` | Variables del proyecto `vigilia-app` |
| `vercel-demo.env` | Variables del proyecto `vigilia-demo` |
| `credenciales-jurado.md` | Texto para el correo al jurado |
| `qr-jurado-admin.png`, `qr-jurado-recepcion.png` | QR para la app autenticadora |

En los dos `.env`, reemplaza los valores `PEGA_AQUI_…`:
- la clave de Ollama Cloud;
- las dos URLs de los webhooks de Slack;
- en el de demo, la cadena de conexión de Neon (paso 3).

No vuelvas a ejecutar el comando con `--forzar` después de enviar las credenciales: generaría otras distintas.

## 2. Proyecto de producción (`vigilia-app`)

1. **Settings → Domains → Add:** añade `vigilia-reto4.vercel.app` y asígnalo a **Production**.
2. **Settings → Deployment Protection:** con *Standard Protection*, el dominio de producción queda público.
   - Abre `https://vigilia-reto4.vercel.app` en una ventana privada. Si pide iniciar sesión en Vercel, desactiva *Vercel Authentication*.
   - Esto es imprescindible: el jurado y las integraciones simuladas llaman a ese dominio.
3. **Settings → Environment Variables → Add:** pega el contenido de `vercel-produccion.env` y elige el entorno **Production**.
   - Conserva `DATABASE_URL`, `VIGILIA_SESSION_SECRET` y `VIGILIA_SECRET_ENCRYPTION_KEY`.
   - Puedes borrar `API_BASE_URL`, que ningún código usa.
   - En producción se ignoran `VIGILIA_KEY` y `VIGILIA_SEED_DEMO`.

## 3. Base de datos de la demo en Neon

1. En **Vercel → Storage**, abre la base Neon y pulsa **Open in Neon**.
2. En **Databases → New Database**, crea `vigilia_demo`, en la misma rama principal.
3. En **Connect**, elige la base `vigilia_demo` con *connection pooling* y copia la cadena `postgresql://…`.
4. Pégala en `DATABASE_URL` de `vercel-demo.env`.

No uses la misma base que producción: las cuentas y la actividad de los dos modos quedarían mezcladas.

## 4. Proyecto demo (nuevo)

1. **Vercel → Add New → Project →** importa `rgkue/vigilia-project`.
2. Configura el proyecto:
   - **Nombre:** `vigilia-demo`.
   - **Framework:** Vite, que Vercel detecta solo.
   - **Root Directory:** la raíz del repositorio.
3. Antes de desplegar, abre **Environment Variables** y pega `vercel-demo.env` completo. Después pulsa **Deploy**.
4. En **Settings → Domains**, añade `vigilia-reto4-demo.vercel.app` y asígnalo a Production. Comprueba en una ventana privada que abre sin pedir login.

## 5. Fusionar y desplegar

Fusiona el PR en `main`. Los dos proyectos despliegan solos.

Si cambiaste variables después del último despliegue, haz **Redeploy** en cada proyecto. Las variables `VITE_*` se leen al compilar y las del servidor, al arrancar.

## 6. Verificación final

Hazla en una ventana privada, sin nada local:

- [ ] `https://vigilia-reto4-demo.vercel.app/api/public-config` responde:
  - `"mode": "demo"`;
  - `demo_url` y `production_url` con los dos dominios.
- [ ] `https://vigilia-reto4.vercel.app/api/public-config` responde `"mode": "production"`.
- [ ] Al abrir la demo aparece el selector de modo. **Entrar modo Producción** lleva al otro dominio sin volver a preguntar.
- [ ] **Demo:**
  - [ ] El acceso con **Usar QR del administrador demo** funciona.
  - [ ] En **Configuración de IA**, Ollama aparece verificada y activa.
- [ ] Ejecuta:

  ```powershell
  ./scripts/demo-webhook.ps1 -Url https://vigilia-reto4-demo.vercel.app -Clave vigilia-jurado-2026
  ```

  - [ ] Salen cinco resultados, con sugerencias de "Ollama sugiere…".
  - [ ] Los avisos salen como `ENVIADA (slack)`.
  - [ ] Llegan mensajes `Demo · …` a los dos canales de Slack.
- [ ] En Actividad, al abrir el ingreso de asma y confirmar DIRECTA:
  - [ ] el nivel pasa a *Prioridad administrativa*;
  - [ ] llega `Demo · Actualización tras revisión humana…` a ambos canales.
- [ ] **Producción:**
  - [ ] Entra `JURADO-ADMIN` con código y contraseña.
  - [ ] **Administración → Integraciones** muestra las cinco integraciones simuladas, y **Probar** responde conectado.
- [ ] Ejecuta:

  ```powershell
  ./scripts/demo-webhook.ps1 -Url https://vigilia-reto4.vercel.app -Modo produccion -Token <VIGILIA_JURY_INGRESS_TOKEN>
  ```

  - [ ] Salen fuentes `connected`.
  - [ ] Los avisos salen como `ENVIADA (admissions/case_manager)`.
  - [ ] Llegan mensajes `Producción · …` a Slack.
- [ ] `JURADO-RECEPCION` entra solo con el código y puede registrar un ingreso.
- [ ] `https://github.com/rgkue/vigilia-project` abre sin sesión y la CI del último commit está en verde.
- [ ] Guarda capturas en [`docs/evidencia/`](evidencia/):
  - los dos canales de Slack;
  - Actividad;
  - el detalle con la actualización tras la revisión.

## 7. Correo al jurado

**Para:** hackiathon@viamatica.com
**Asunto:** hackIAthon 2026 · Reto 4 · Vigilia: alerta temprana de ingresos a emergencias

> Reto elegido: 4, Sistema de Alerta Temprana de Ingresos a Emergencias.
>
> Enlace del agente funcional: https://vigilia-reto4-demo.vercel.app (al abrirlo se elige modo Demo o Producción).
> Repositorio: https://github.com/rgkue/vigilia-project
>
> El README explica cómo evaluarlo en cinco minutos sin instalar nada. Incluye el webhook con su clave de demostración, el inicio de sesión sin contraseña y qué partes son reales y cuáles ficticias.
> Para el modo Producción adjuntamos las credenciales de evaluación y los QR de TOTP.
>
> [pega aquí el contenido de entrega-privada/credenciales-jurado.md]

Adjunta `qr-jurado-admin.png` y `qr-jurado-recepcion.png`. Si quieres que el jurado vea Slack en vivo, añade un enlace de invitación al workspace.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `500 FUNCTION_INVOCATION_FAILED` | Revisa *Runtime Logs*. En producción suelen faltar `VIGILIA_SESSION_SECRET` (32+ caracteres), una `VIGILIA_SECRET_ENCRYPTION_KEY` Fernet válida o `DATABASE_URL`. |
| La IA queda "Revisión humana pendiente: Activa un proveedor…" | Falta `VIGILIA_SHARED_AI_KEY`, o falta `VIGILIA_AI_APPROVED=true` en producción. Redespliega después de añadirla. |
| "El proveedor seleccionado no pudo confirmar la clasificación" | La clave o el modelo de Ollama no son válidos. Pruébalos en **Configuración de IA → Probar 3 casos ficticios**. Usa la clave secreta completa, no el identificador de 32 caracteres que Ollama muestra debajo del nombre. |
| En producción las fuentes salen `unavailable` o los avisos `ERROR` | El dominio de `VIGILIA_SIMULATED_BASE_URL` no es público o está protegido por *Vercel Authentication*. |
| Un código TOTP es rechazado | Cada código sirve una vez; espera al siguiente (30 s). Si varias personas usan la misma cuenta, cada una espera su código. |
| Alguien cambió una cuenta o integración del jurado | Se restablece sola en el siguiente arranque. Para forzarlo, haz **Redeploy**. |
