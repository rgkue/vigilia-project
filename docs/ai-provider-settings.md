# Proveedores personales de IA

Cada persona autenticada administra sus conexiones en **Configuración de IA**. No necesita
ser administradora ni tener `ai.configure`. Las claves de API, autorizaciones OAuth, modelos,
pruebas y proveedor activo pertenecen al perfil de usuario de Vigilia.

El permiso personal de configuración y la aprobación de instalación son independientes.
En producción, la clasificación con datos reales sigue bloqueada hasta que el operador apruebe
el uso y configure `VIGILIA_AI_APPROVED=true`; dar a una cuenta permiso de edición no cambia ese control.

## Conectar y activar

1. Elige el proveedor y guarda el método de conexión.
2. Para API, introduce tu clave en la pantalla. Se almacena cifrada y no vuelve al navegador.
   Para ChatGPT / Codex o SuperGrok, elige **Suscripción · OAuth**, guarda y pulsa **Conectar**.
3. Abre la página oficial de autorización. La contraseña se introduce únicamente allí.
4. Consulta modelos, selecciona uno y guarda los cambios.
5. Ejecuta **Probar con datos ficticios** y después **Activar clasificación**.

La prueba hace una llamada real usando solo un caso sintético y puede consumir cuota.
Confirma compatibilidad básica; no mide precisión clínica ni disponibilidad permanente.
Una modificación invalida la prueba anterior. Si faltan credenciales, falla el proveedor,
se desactiva la cuenta o caduca la conexión, la clasificación queda pendiente. No se utiliza
la conexión de otra persona como alternativa.

## Quién autoriza cada ingreso

- **Formulario manual:** la identidad de la sesión que registra el ingreso.
- **Webhook hospitalario:** la cuenta asignada a esa integración, después de aceptar su uso.
- **Webhook sin cuenta autorizada:** se procesa el ingreso y la IA queda pendiente.

Una persona con `integrations.manage` propone un responsable desde **Configuración de IA →
Ingresos automáticos → Asignar responsables de integraciones**. La propuesta queda pendiente.
Su destinatario recibe la asignación en su propia configuración y puede autorizarla o rechazarla.
Para aceptar debe tener un proveedor probado y activo. La autorización permite usar su
proveedor activo en segundo plano, incluso con el navegador cerrado, y consume su cuota.

El dueño puede revocar la autorización. Administración puede retirarla; en ese caso hace
falta una propuesta nueva antes de volver a autorizar. Una revocación detiene nuevos envíos;
no puede retirar datos ya enviados al proveedor. Los cambios de proveedor personal también
se aplican a las integraciones que esa persona haya autorizado.

## Métodos disponibles

| Proveedor | Métodos |
| --- | --- |
| Groq | Clave de API |
| Claude / Anthropic | Clave de API de Anthropic Console |
| OpenAI | API Responses o suscripción ChatGPT / Codex vía OpenCode |
| xAI / Grok | Clave de API o suscripción SuperGrok vía OpenCode |
| Ollama | Clave cloud personal; servicio local gestionado por el operador |
| OpenCode Zen | Clave personal de Zen |

Claude se conecta por la API de Anthropic Console, con facturación independiente de Claude
Pro/Max. Vigilia no implementa el inicio de sesión por suscripción de Claude en este flujo;
esto describe el alcance de Vigilia, no una restricción general de Anthropic. Ollama local
apunta al daemon del servidor; no accede al Ollama instalado en la computadora de quien abre el navegador.
El operador debe habilitar expresamente ese recurso compartido con `VIGILIA_ALLOW_SHARED_OLLAMA=true`.
Para consumir cuota cloud personal de Ollama, usa el método cloud y tu propia clave.

## Arquitectura y despliegue

- `/me/ai`, `/me/ai/providers/*`, `/me/ai/selection` y `/me/ai/subscriptions/*` obtienen la
  identidad de la sesión. El cliente no elige el `user_id` para estas operaciones.
- `/me/ai/assignments/*` registra consentimiento propio. `/admin/ai/assignments/*` requiere
  `integrations.manage` y permite proponer o retirar responsables, sin exponer secretos.
- La migración `004_personal_ai.sql` crea tablas personales con clave `(user_id, provider)`,
  selección por usuario y asignaciones con revisión. SQLite demo recibe el esquema equivalente.
- `VIGILIA_SECRET_ENCRYPTION_KEY` cifra las claves de API y datos temporales de autorización.
  Guarda la clave maestra en el gestor de secretos y conserva un respaldo protegido.
- La aprobación `VIGILIA_AI_APPROVED=true` sigue siendo necesaria para clasificar en producción.
- Cada clasificación registra la identidad responsable, evento, proveedor, modelo y revisión;
  nunca registra claves, tokens ni el texto clínico en esos eventos de auditoría.

### Conector OAuth personal

Requiere Node.js 22 y un proceso persistente, fuera de funciones serverless. Ejecuta `npm ci`
y `npm start` en `services/ai-subscriptions`. Configura:

- `VIGILIA_OPENCODE_PASSWORD`: contraseña privada entre FastAPI y el conector.
- `VIGILIA_OPENCODE_PORT`: puerto del conector, por defecto `4096`.
- `VIGILIA_SUBSCRIPTIONS_DATA_DIR`: directorio absoluto persistente fuera del repositorio.
- `VIGILIA_SUBSCRIPTIONS_MAX_WORKERS`: máximo de procesos OpenCode simultáneos, por defecto `12`.
- En FastAPI: `VIGILIA_OPENCODE_URL=http://127.0.0.1:4096` y la misma contraseña privada.

El conector escucha solo en loopback, exige autenticación y permite únicamente las operaciones
necesarias. Si se separan hosts, utiliza un acceso privado con HTTPS. No publiques su puerto.
`GET /health` autenticado devuelve el protocolo `personal-v1`.

Cada combinación de dueño, proveedor y generación de autorización obtiene un proceso OpenCode
con directorios HOME, XDG, configuración, caché y datos propios. El espacio se identifica mediante
un hash opaco. No hereda claves del backend ni configuraciones del perfil del operador. OpenCode
guarda y renueva los tokens; la base de Vigilia guarda el estado y el identificador de generación.

Los archivos de credenciales de OpenCode requieren un volumen cifrado y permisos exclusivos
para la cuenta del servicio. En Windows configura ACL del directorio raíz; los modos POSIX de
Node no sustituyen una ACL. Protege también sus respaldos. No compartas estos volúmenes entre
instalaciones ni los incluyas en Git.

Al desconectar se invalida primero el acceso en Vigilia, se termina el proceso de esa generación
y se elimina su directorio. Una marca persistente impide reutilizar generaciones revocadas.
Si el conector no responde, la interfaz informa que la limpieza está pendiente: vuelve a pulsar
**Desconectar** cuando esté disponible. La revocación en Vigilia no sustituye la revocación del
consentimiento en la cuenta del proveedor.

Cada inferencia usa una sesión temporal, sin herramientas, que se aborta y elimina al terminar.
Los procesos inactivos se detienen tras quince minutos; las conexiones válidas conservan su
almacén para reinicios. El límite de procesos provoca un error controlado si todos están ocupados.
Usa un supervisor persistente y un único conector por volumen. En Windows, para detenerlo
limpiamente, el supervisor debe invocar `POST /shutdown` con la autenticación privada antes de
terminar el proceso padre. En Unix también responde a SIGTERM/SIGINT.

Una autorización pendiente caduca a los diez minutos. Si FastAPI se reinicia en medio del login,
vuelve a iniciarlo o cancélalo. Una nueva autorización usa un espacio diferente y no puede ser
reemplazada por el callback de una anterior.

### Actualización desde conexiones compartidas

Despliega backend y conector juntos. Las tablas `ai_provider_configs`, `ai_selection` y
`ai_oauth_connections` se conservan como datos heredados, pero las rutas nuevas no las consultan.
No se copian credenciales ni se atribuyen automáticamente a una persona. Cada usuario debe
conectar, probar y activar su cuenta nuevamente. Los webhooks necesitan una asignación aceptada.

El conector usa `personal-v1` y no carga el antiguo almacén global. Retira y revoca las sesiones
compartidas antiguas mediante el procedimiento operativo del despliegue. No vuelvas al conector
anterior con las rutas nuevas. Los providers por variables de entorno siguen disponibles para
herramientas internas de simulación; las solicitudes HTTP de ingresos no recurren a ellos.

## Verificación

- `pnpm run build` comprueba TypeScript y la aplicación.
- Desde `backend`: `.venv/Scripts/python.exe -m pytest -p no:cacheprovider` en Windows, o el
  intérprete equivalente del entorno en Linux.
- Desde la raíz: `node --test services/ai-subscriptions/test-isolation.mjs` prueba procesos reales
  de OpenCode con directorios temporales y claves ficticias. No ejecuta inferencia ni login.

Las pruebas cubren dos sesiones autenticadas, secretos separados, cambios obsoletos,
consentimiento, revocaciones, callbacks tardíos y exclusión de credenciales heredadas.
Antes de desplegar, aplica la migración en PostgreSQL de staging y completa una autorización
real desde tu cuenta. Las pruebas locales no validan disponibilidad ni cuota de una suscripción.
