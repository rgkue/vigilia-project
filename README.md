# Vigilia · Alerta temprana de ingresos a emergencias

**hackIAthon 2026 · Reto 4: Sistema de Alerta Temprana de Ingresos a Emergencias.**

Prototipo funcional de alerta temprana administrativa, con IA real, revisión humana y conectores configurables. Cuando un asegurado ingresa a emergencias, el hospital envía el evento a un webhook. Vigilia verifica la póliza y los antecedentes, sugiere con IA qué antecedentes podrían relacionarse con el motivo de ingreso y avisa al mismo tiempo a **admisiones del hospital** y al **gestor de casos de la aseguradora**.

La salida es administrativa: no decide atención clínica ni debe retrasarla.

**Equipo:** Isaac Muñoz y Rubén Pino.

## Para el jurado

| | |
|---|---|
| Aplicación (al abrirla eliges **Demo** o **Producción**) | **https://vigilia-health.vercel.app** |
| Documentación en vivo (este README y las guías, sin abrir GitHub) | https://vigilia-project-pi.vercel.app |
| Repositorio | https://github.com/rgkue/vigilia-project |

Los dos modos viven en la misma instalación y usan los mismos datos ficticios. No hace falta instalar nada ni pedirnos claves de IA.

### Recorrido de 5 minutos (modo Demo)

1. **Abre la aplicación.** En el selector, elige **Demo** y pulsa **Entrar modo Demo**. Entras al instante, sin usuario ni contraseña.
2. **Envía un ingreso al webhook**, como lo haría el sistema del hospital. Desde una terminal, en la raíz del repositorio:

   ```powershell
   Invoke-RestMethod -Method Post -Uri "https://vigilia-health.vercel.app/api/webhook/ingreso" -ContentType "application/json; charset=utf-8" -Headers @{ "X-Vigilia-Key" = "vigilia-jurado-2026" } -InFile scripts/ejemplo-ingreso.json
   ```

   ```bash
   curl -X POST https://vigilia-health.vercel.app/api/webhook/ingreso -H "Content-Type: application/json" -H "X-Vigilia-Key: vigilia-jurado-2026" --data-binary @scripts/ejemplo-ingreso.json
   ```

   Para registrar otro ingreso, cambia `evento_id` en el archivo. Repetir el mismo evento devuelve la respuesta guardada sin avisar dos veces. El script [`scripts/demo-webhook.ps1`](scripts/demo-webhook.ps1) (o [`demo-webhook.sh`](scripts/demo-webhook.sh)) envía cinco escenarios de una vez:

   ```powershell
   ./scripts/demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Clave vigilia-jurado-2026
   ```

   Sin terminal, lo mismo se prueba desde **Registrar ingreso** o desde el **Simulador**.

3. **Mira el resultado.**
   - La respuesta del webhook trae la póliza, cada antecedente con la sugerencia de la IA y el estado de los **dos avisos** (`ENVIADA` por `slack`).
   - En **Actividad** aparece el ingreso con su detalle.
   - Los avisos llegan a dos canales de Slack (`#vigilia-admisiones` y `#vigilia-gestor`). Las capturas están en [`docs/evidencia/`](docs/evidencia/).
4. **Revisión humana.** Abre el ingreso en Actividad y confirma o corrige la sugerencia de la IA.
   - Vigilia recalcula el nivel; por ejemplo, de *Revisión administrativa* a *Prioridad administrativa*.
   - Envía un **aviso de actualización** a los dos destinos.
5. **Opcional:** el **Simulador** recorre seis escenarios desde la interfaz.

### Modo Producción

En la misma aplicación, pulsa **Cambiar modo** en el pie de página y elige **Producción**. Muestra cómo lo usaría un hospital o una aseguradora que adopte Vigilia:
- cuentas de personal con ID, código TOTP y contraseña, y permisos por rol;
- administración de personas e integraciones con los sistemas de la aseguradora, con mapeo de campos;
- tokens por integración y auditoría.

La aseguradora y los receptores de avisos están **simulados** dentro de la misma instalación. Las credenciales de evaluación (administrador y recepción) se envían en el correo de entrega.

## Qué pide el reto y dónde está

| Requisito del reto | Implementación |
|---|---|
| Webhook que recibe el ingreso a emergencias | `POST /api/webhook/ingreso`: contrato canónico en demo y mapeo configurable del formato del hospital en producción ([`backend/app/main.py`](backend/app/main.py)). |
| Verificar que la póliza es válida | Reglas exactas de vigencia, pago y carencia, sin IA ([`backend/app/rules.py`](backend/app/rules.py)). |
| Consultar antecedentes de preexistencias | Datos ficticios en demo; conectores REST con mapeo declarativo en producción ([`backend/app/connectors.py`](backend/app/connectors.py)). |
| Agente con IA | Un modelo real (Ollama Cloud · `gpt-oss:20b`) sugiere si cada antecedente se relaciona con el motivo. Solo sugiere: una persona confirma y el resultado se recalcula. |
| Notificar simultáneamente a admisiones y al gestor | Dos envíos concurrentes; cada uno informa si se envió, falló o quedó simulado ([`backend/app/notifier.py`](backend/app/notifier.py)). |
| Enlace público y repositorio | Ver la tabla del inicio. |

## Qué es real y qué es ficticio

| Parte | En esta entrega |
|---|---|
| Webhook, reglas de póliza, persistencia (PostgreSQL en Neon), auditoría | **Real** |
| Clasificación con IA | **Real**: Ollama Cloud con la clave del equipo configurada en el servidor |
| Avisos a admisiones y gestor de casos | **Reales**, a dos canales de Slack. Sin canal configurado se marcan `SIMULADA`, nunca `ENVIADA`. |
| Asegurados, pólizas y antecedentes | **Ficticios** (ver la lista abajo) |
| Sistemas de la aseguradora (pólizas, antecedentes y receptores de avisos) | **Simulados** dentro de la misma instalación, con su propio formato JSON y credencial; los usan los dos modos |

Asegurados ficticios:

| Cédula | Situación |
|---|---|
| `8-100-100` | Asma leve |
| `8-200-200` | Póliza vencida |
| `8-300-300` | En período de carencia |
| `8-400-400` | Hipertensión y diabetes |
| `8-500-500` | Pago atrasado |
| `9-999-999` | No existe |

## Arquitectura

```text
Hospital (HIS) ──webhook──▶ Vigilia (FastAPI en Vercel)
                              ├─ Póliza y antecedentes: datos demo / API de la aseguradora (mapeo declarativo)
                              ├─ Reglas exactas: vigencia, pago, carencia
                              ├─ IA: sugiere relación antecedente ↔ motivo (queda pendiente de revisión humana)
                              ├─ Avisos simultáneos ──▶ Admisiones del hospital
                              │                    └──▶ Gestor de casos de la aseguradora
                              └─ PostgreSQL: ingresos, avisos, revisiones y auditoría
Personal ──▶ Interfaz React: Actividad, revisión humana, administración, configuración de IA
```

- **Frontend:** React 19, TypeScript y Vite.
- **Backend:** FastAPI con contratos Pydantic.
- **Datos:** PostgreSQL con migraciones versionadas. SQLite solo para desarrollo local.
- **Acceso humano:** cuentas de Vigilia con ID o gafete y TOTP personal. Las cuentas administrativas usan además contraseña. OIDC es opcional. Los permisos se verifican en el servidor.
- **Acceso de sistemas:** credencial independiente por integración, revocable y rotable. El modo Demo acepta además la clave pública `X-Vigilia-Key`.
- **Modo Demo dentro de producción:** una cuenta sin credenciales (`VIGILIA_DEMO_ACCESS=true`) con permisos de operación: registrar ingresos, ver la actividad, revisar sugerencias y consultar la auditoría. La administración queda para el modo Producción.
- **Idempotencia y reintentos:** un evento repetido devuelve la respuesta guardada. Un evento que falló o quedó interrumpido puede reenviarse con los mismos datos.

## Limitaciones conocidas

Es un prototipo de hackatón, no un producto hospitalario certificado. Antes de operar con datos reales faltaría:

- Integración y pruebas con el HIS y la aseguradora reales, con sus contratos y un sandbox.
- **Avisos:** reintento automático y cola de avisos fallidos. Hoy el aviso fallido queda registrado como `ERROR` y el evento puede reenviarse.
- **Carga y latencia:** medir el ingreso completo y el comportamiento concurrente. El límite de uso actual es en memoria, por instancia.
- **Calidad de la IA:** evaluar la clasificación con más casos, revisados por el equipo clínico-administrativo. Los tres casos de la prueba de conexión sirvieron para ajustar las instrucciones y no miden precisión.
- **Respaldo:** ensayar respaldo y restauración de PostgreSQL con RPO y RTO acordados.
- **Privacidad:** revisión de finalidad, retención y transferencia con el cliente (Ley 81 de 2019).

## Desarrollo local

Requiere Node.js 20+ y Python 3.11+.

```powershell
Copy-Item .env.example .env.local
Copy-Item backend/.env.example backend/.env
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
$env:VIGILIA_MODE = "demo"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

En otra terminal, desde la raíz:

```powershell
npm install
npm run dev
```

Pruebas: `cd backend; python -m pytest -q` y `npm run build`. La CI ([`.github/workflows/verify.yml`](.github/workflows/verify.yml)) ejecuta ambas.

En modo demo se cargan datos ficticios (`VIGILIA_SEED_DEMO=true` por defecto). La pantalla de acceso ofrece:
- el administrador demo, con QR y acceso simulado;
- el empleado **EMP-REC-001**, cuyo TOTP de prueba se añade a una app autenticadora.

Consulta [acceso del personal](docs/employee-access.md).

## Despliegue

La guía de la instalación de evaluación en Vercel está en [`docs/entrega-jurado.md`](docs/entrega-jurado.md). Incluye variables, verificación y la página de documentación en vivo (`panel/`).

El script [`scripts/credenciales-jurado.mjs`](scripts/credenciales-jurado.mjs) genera las credenciales y los bloques de variables en una carpeta que no se sube a git.

La aplicación arranca en modo **producción** por defecto (seguro por defecto) y se niega a iniciar si falta PostgreSQL o alguna configuración de seguridad obligatoria. Revisa [`backend/.env.example`](backend/.env.example).

| Variable | Uso |
|---|---|
| `VIGILIA_MODE` | `production` (por defecto) o `demo` (instalación solo de demostración, útil en desarrollo local). |
| `VIGILIA_DEMO_ACCESS` | Producción: `true` habilita el modo Demo dentro de la misma instalación (cuenta sin credenciales). |
| `DATABASE_URL` | PostgreSQL. Las migraciones pendientes se aplican al iniciar. |
| `VIGILIA_SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres para firmar sesiones. |
| `VIGILIA_SECRET_ENCRYPTION_KEY` | Clave Fernet para cifrar credenciales guardadas. No la cambies después de guardar secretos. |
| `VIGILIA_KEY` | Clave `X-Vigilia-Key` del webhook de demostración (modo demo, o producción con `VIGILIA_DEMO_ACCESS=true`). La interfaz usa la sesión. |
| `VIGILIA_AI_APPROVED` | Producción: `true` habilita la clasificación con IA tras la aprobación del cliente. |
| `VIGILIA_SHARED_AI_KEY`, `VIGILIA_SHARED_AI_PROVIDER`, `VIGILIA_SHARED_AI_MODEL` | IA compartida del equipo para las cuentas de evaluación (modo Demo y cuentas del jurado). Por defecto `ollama` y `gpt-oss:20b`. Esas cuentas no pueden cambiarla desde la interfaz. |
| `VIGILIA_DEMO_AI_OWNER` | Cuenta cuya IA clasifica el webhook demo (por defecto `demo-admin`). |
| `SLACK_ENABLED`, `SLACK_WEBHOOK_ADMISIONES`, `SLACK_WEBHOOK_GESTOR` | Canales de aviso. En demo los usa el notificador; en producción los usan los receptores simulados. |
| `VIGILIA_SIMULATED_SYSTEMS`, `VIGILIA_SIMULATED_BASE_URL` | Producción de muestra: aseguradora y receptores simulados, conectados como integraciones. |
| `VIGILIA_JURY_ADMIN_PASSWORD`, `VIGILIA_JURY_ADMIN_TOTP`, `VIGILIA_JURY_EMPLOYEE_TOTP`, `VIGILIA_JURY_INGRESS_TOKEN` | Producción de muestra: cuentas y token fijos del jurado. Se restablecen en cada arranque y no se pueden modificar desde la interfaz. |
| `VIGILIA_DEMO_URL`, `VIGILIA_PRODUCTION_URL` | Opcional: solo si Demo y Producción se despliegan en instalaciones separadas. |
| `VITE_LIVE_INGRESS_ENABLED` | `true` habilita el formulario de ingreso manual en la interfaz. |
| `OIDC_*`, `VIGILIA_BOOTSTRAP_ADMIN_EMAIL` | Opcional: inicio de sesión corporativo OIDC. Define las cuatro variables `OIDC_*` o ninguna. |
| `VIGILIA_CORS_ORIGINS`, `VIGILIA_SESSION_SAME_SITE` | Solo si frontend y API están en dominios distintos. |

**Primer administrador de una instalación real (sin OIDC).** Desde `backend/`, con las mismas variables que el servidor:

```powershell
python -m app.bootstrap_admin --id ADMIN-01 --name "Nombre Apellido"
```

El comando muestra una sola vez la clave del autenticador y una contraseña temporal, que Vigilia pide cambiar en el primer acceso. Las demás cuentas se crean en **Administración → Personas**.

Consulta [contratos e integraciones](backend/docs/contratos.md) y [operación, respaldo y restauración](backend/docs/operaciones-produccion.md) antes de configurar un piloto.

## Permisos

| Permiso | Capacidad |
|---|---|
| `users.manage` | Usuarios, roles y permisos |
| `integrations.manage` | Conectores, credenciales y pruebas |
| `ingress.submit` | Registrar un ingreso desde Vigilia |
| `ingress.read` | Consultar actividad y detalle |
| `classification.review` | Resolver sugerencias de la IA |
| `audit.read` | Consultar auditoría |

## Estructura

Cada persona configura su proveedor, modelo y clave de IA en **Configuración de IA**, su página personal. No hace falta ser administrador. Consulta la [guía de configuración de IA](docs/ai-provider-settings.md).

```text
backend/
  app/            FastAPI: webhook, reglas, conectores, avisos, IA, cuentas y auditoría
    simulated.py  Aseguradora y receptores simulados (solo producción de muestra)
    provisioning.py  Cuentas del jurado, integraciones simuladas e IA compartida
  migrations/     Migraciones PostgreSQL
  tests/          Pruebas (pytest)
src/              Interfaz React (selector de modo, acceso, actividad, administración)
panel/            Documentación en vivo: lee este README y docs/ desde GitHub (vigilia-project-pi.vercel.app)
scripts/          Demostración del webhook y generador de credenciales del jurado
docs/             Entrega, guion de demostración y guías
```
