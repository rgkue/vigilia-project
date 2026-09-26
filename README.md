# Vigilia

Vigilia coordina ingresos hospitalarios con consultas administrativas de cobertura y antecedentes autorizados. Es una instalación aislada por cliente: los datos, conexiones y usuarios se mantienen dentro de la infraestructura del cliente.

La salida de Vigilia es administrativa; no decide atención clínica ni debe retrasarla. En producción la IA externa está desactivada hasta que el cliente apruebe proveedor, finalidad, retención, transferencia y campos transmitidos. Si una fuente falta o falla, el resultado queda pendiente y no se presenta como “sin registro”.

## Arquitectura

- **Frontend:** React, TypeScript y Vite.
- **Backend:** FastAPI con contratos Pydantic.
- **Datos:** SQLite solo en demo; PostgreSQL y migraciones versionadas en producción.
- **Acceso humano:** cuentas de Vigilia con ID/gafete y TOTP personal; las que tienen permisos administrativos usan además contraseña. OIDC es opcional para organizaciones con proveedor de identidad. Roles y permisos se verifican en el servidor.
- **Acceso de sistemas:** credenciales de webhook independientes por integración, revocables y rotables.
- **Conectores:** REST/HTTPS con mapeos declarativos a los contratos canónicos de Vigilia.
- **Auditoría:** cambios de acceso, integración, ingreso y revisión humana sin secretos ni texto clínico en el registro técnico.

## Demo local

Requiere Node.js 20+ y Python 3.11+.

```powershell
Copy-Item .env.example .env.local
Copy-Item backend/.env.example backend/.env
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:VIGILIA_MODE = "demo"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

En otra terminal, desde la raíz:

```powershell
npm install
npm run dev
```

La demo utiliza fixtures únicamente si `VIGILIA_MODE=demo` y `VIGILIA_SEED_DEMO=true`. Si se quiere una demo vacía, define `VIGILIA_SEED_DEMO=false`. El simulador local solo corre en desarrollo; un ingreso real siempre llama al backend y nunca se reemplaza por un caso ficticio.

El acceso demo ahora requiere elegir una sesión. El empleado **EMP-REC-001**
(Recepción de prueba) se incluye con fixtures: abre las credenciales sintéticas
en la pantalla de acceso y configura su TOTP en tu app autenticadora.
La misma pantalla ofrece el QR y acceso administrativo simulado.
Consulta [acceso del personal y recuperación](docs/employee-access.md).

## Producción

La aplicación sirve en modo producción por defecto y se niega a iniciar si falta PostgreSQL o alguna configuración de seguridad obligatoria. Revisa [`backend/.env.example`](backend/.env.example) y configura los secretos en el gestor de secretos de la infraestructura del cliente, no en Git ni en variables `VITE_*`.

Variables principales:

| Variable | Uso |
|---|---|
| `VIGILIA_MODE=production` | Desactiva fixtures y requiere PostgreSQL. |
| `DATABASE_URL` | Conexión PostgreSQL. Las migraciones pendientes se aplican al iniciar. |
| `OIDC_DISCOVERY_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Opcional. Inicio de sesión corporativo OIDC: define las cuatro o ninguna. En Vercel, registra `/api/auth/callback` como URL de retorno o configura `OIDC_REDIRECT_URL`. |
| `VIGILIA_BOOTSTRAP_ADMIN_EMAIL` | Solo con OIDC. Correo verificado que aprovisiona el primer perfil administrador corporativo. |
| `VIGILIA_SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres para firmar sesiones. |
| `VIGILIA_SECRET_ENCRYPTION_KEY` | Clave Fernet para cifrar secretos de conectores almacenados en PostgreSQL. Conserva una copia recuperable en el gestor de secretos. |
| `VIGILIA_CORS_ORIGINS` | Lista separada por comas de los orígenes web autorizados. |
| `OIDC_FRONTEND_ORIGIN` | Origen al que vuelve el usuario después de OIDC. También se permite por CORS. |
| `VIGILIA_SESSION_SAME_SITE` | `lax` para el mismo sitio; `none` si frontend y API son de sitios distintos. `none` usa cookie Secure. |
| `VIGILIA_AI_PROVIDER=none` | Mantiene desactivada la IA externa. Usa `kev`, `jev` o `groq` solo tras aprobación documentada. |
| `VIGILIA_AI_APPROVED=false` | El backend ignora un proveedor externo en producción mientras siga en `false`. |

Para servir frontend y API en dominios distintos, define `VITE_API_BASE_URL` con la URL del backend durante la compilación, agrega el origen del frontend a `VIGILIA_CORS_ORIGINS` y configura `VIGILIA_SESSION_SAME_SITE=none`. En una instalación con API bajo `/api`, el frontend de producción usa esa ruta por defecto; para un proxy de mismo origen en `/`, define `VITE_API_BASE_URL=/`.

### Despliegue en Vercel

Vercel puede servir la interfaz Vite y el backend FastAPI desde este repositorio. Mantén **Root Directory** en la raíz del repositorio: `api/index.py` publica FastAPI bajo `/api`, y la interfaz de producción usa esa ruta automáticamente. `VITE_API_BASE_URL` solo hace falta si el backend vive en otro dominio; en ese caso configúrala en las variables de entorno de Vercel.

Configura las variables de producción del backend en Vercel antes de iniciar sesión:

- `VIGILIA_MODE=production`
- `DATABASE_URL` con una base PostgreSQL persistente y accesible desde las funciones de Vercel. SQLite no sirve como almacenamiento persistente en funciones serverless.
- `VIGILIA_SESSION_SECRET` con al menos 32 caracteres aleatorios.
- `VIGILIA_SECRET_ENCRYPTION_KEY` con una clave Fernet válida.

Si usas OIDC, registra `https://<dominio-de-vercel>/api/auth/callback` en el proveedor, configura `OIDC_REDIRECT_URL` con esa URL y `OIDC_FRONTEND_ORIGIN` con `https://<dominio-de-vercel>`. Si la API está en otro dominio, también configura CORS y `VIGILIA_SESSION_SAME_SITE=none` como se indica arriba.

El formulario humano de ingresos está desactivado en la UI hasta que el despliegue defina `VITE_LIVE_INGRESS_ENABLED=true`; además, el backend exige el permiso `ingress.submit`. El webhook de sistemas no depende de esa opción.

**Primer administrador sin OIDC.** Desde `backend/`, con las mismas variables que el servidor:

```powershell
python -m app.bootstrap_admin --id ADMIN-01 --name "Nombre Apellido"
```

El comando muestra una sola vez la clave del autenticador y una contraseña temporal. Vigilia pide cambiarla en el primer acceso. Se niega a ejecutarse si ya existe una cuenta activa que administra personas. Después, las demás cuentas se crean en **Administración → Personas**.

**Con OIDC.** El administrador inicial se autentica con OIDC y el correo verificado exacto de `VIGILIA_BOOTSTRAP_ADMIN_EMAIL`. Las cuentas corporativas y las cuentas de Vigilia pueden convivir en el mismo directorio.

Consulta [contratos e integraciones](backend/docs/contratos.md) y [operación, respaldo y restauración](backend/docs/operaciones-produccion.md) antes de configurar un piloto.

## Permisos

El catálogo es fijo y el backend lo valida en cada operación:

| Permiso | Capacidad |
|---|---|
| `users.manage` | Usuarios, roles y permisos |
| `integrations.manage` | Conectores, credenciales y pruebas |
| `ingress.submit` | Registrar un ingreso desde Vigilia |
| `ingress.read` | Consultar actividad y detalle |
| `classification.review` | Resolver sugerencias pendientes |
| `audit.read` | Consultar auditoría |

Los roles son grupos iniciales de permisos; las asignaciones efectivas se guardan expresamente. Desactivar una persona bloquea nuevos accesos y conserva auditoría.

## Estructura

La selección de proveedores, modelos y credenciales se administra en **Administración →
Inteligencia artificial**. Consulta la [guía de configuración de IA](docs/ai-provider-settings.md)
para configurar el servidor, activar la clasificación y conocer el alcance de las conexiones.

```text
backend/
  app/                 FastAPI, conectores, OIDC y reglas
  migrations/          Migraciones PostgreSQL
  docs/                Contratos y operación
src/
  components/          Interfaz y panel administrativo
  lib/                 Clientes de API
```
