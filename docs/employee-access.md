# Acceso del personal

Las cuentas de Vigilia entran con un gafete QR (o su ID/cédula) y el código de su
app autenticadora. Recepción (`ingress.read` e `ingress.submit`) no usa contraseña.
Cualquier cuenta con otros permisos (administración, revisión, auditoría, IA)
usa además una contraseña: el servidor solo la pide (HTTP 428) después de un
código válido, así no se puede averiguar qué IDs son administrativos. Tras 5
contraseñas incorrectas la cuenta se bloquea 15 minutos. OIDC es opcional. La cédula debe registrarse exactamente con el mismo formato;
los identificadores alfanuméricos se normalizan a mayúsculas.

El QR del gafete contiene solo `vigilia:employee:<ID>` y puede imprimirse.
El **QR privado de configuración TOTP** contiene un secreto y se escanea en la
app autenticadora durante el alta. Son dos QR distintos: no imprimas el QR
privado en el gafete. Los códigos TOTP tienen seis dígitos, cambian cada 30
segundos y se aceptan una sola vez; se tolera un intervalo de desfase del reloj.
El QR de identificación no es un segundo factor ni prueba posesión física del
gafete; el TOTP es el autenticador. TOTP no protege frente a phishing.

## Prueba local

1. Inicia FastAPI con `VIGILIA_MODE=demo` y `VIGILIA_SEED_DEMO=true`, y conecta
   el frontend al backend mediante `VITE_API_BASE_URL`.
2. En la pantalla de acceso, abre **Credenciales sintéticas de demostración**.
3. Escanea el QR de configuración de prueba desde una app compatible con TOTP.
4. Introduce **EMP-REC-001** (Recepción de prueba)
   o escanea su gafete, y escribe el código actual de la app.
5. Para administrar, cierra sesión, abre las credenciales demo, pulsa
   **Usar QR del administrador demo** y luego **Simular inicio corporativo (demo)**.

La semilla pública del autenticador de prueba es `JBSWY3DPEHPK3PXP`. Solo se
aprovisiona en demo con fixtures habilitados. Si reemplazas ese autenticador en
el panel, usa la nueva configuración; el QR público de prueba ya no servirá.
La precarga es idempotente y no reactiva empleados desactivados ni sobrescribe
autenticadores. En producción no se muestran ni se precargan credenciales demo.
Las APIs humanas ahora requieren una sesión también en demo.

## Alta y recuperación

En **Administración → Personas**, registra el ID/cédula y nombre, descarga el
gafete y pulsa **Configurar autenticador**. Entrega la configuración en persona:
se muestra una vez y no se puede recuperar mediante las APIs de consulta.
El empleado puede probar inmediatamente el acceso con su app.

**Reemplazar autenticador** genera otro secreto, invalida el anterior y revoca
las sesiones existentes. Utilízalo después de verificar la identidad de quien
perdió el dispositivo. Desactivar un empleado también invalida sus sesiones;
reactivarlo no recupera las sesiones antiguas. El ID es inmutable; el nombre y
estado se editan desde el directorio.

Para cuentas administrativas, **Generar contraseña temporal** la muestra una sola
vez; Vigilia obliga a cambiarla en el primer acceso y, mientras tanto, solo
permite cambiarla o salir. Restablecerla cierra las sesiones de la cuenta.
Cambiar los permisos de una cuenta también cierra sus sesiones.
El primer administrador sin OIDC se crea con `python -m app.bootstrap_admin`.

Los secretos se cifran con `VIGILIA_SECRET_ENCRYPTION_KEY`. En SQLite demo, si
no se configuró esa variable, se genera una clave privada junto a la base, con
extensión `.employee-auth.key`, excluida de Git. Conserva la clave junto a los
respaldos de esa base. Para demo PostgreSQL y producción debe configurarse la
clave Fernet explícitamente. No cambies la clave sin migrar los secretos.

## Administración con QR y OIDC

El QR corporativo contiene `vigilia:admin:<ID interno del perfil>`. Escanearlo
prepara un intento de acceso de cinco minutos, ligado al estado OIDC. El
callback exige que la cuenta verificada corresponda al perfil del QR.
También se aplica a otros perfiles corporativos administrados desde Usuarios.

El correo `VIGILIA_BOOTSTRAP_ADMIN_EMAIL` puede completar una primera entrada
con OIDC sin QR. Esta excepción se consume una sola vez en la base. En una
instalación existente ese mismo correo puede usarla para obtener su gafete.
Al entrar, abre **Mi gafete QR** y descárgalo antes de cerrar sesión.
Los siguientes accesos exigen QR y OIDC. En Usuarios y permisos, una persona
con `users.manage` puede descargar el QR de los demás perfiles corporativos.
Un QR copiado por sí solo no permite acceder sin la identidad OIDC correcta.

Si el último administrador pierde su gafete, TI puede recuperar su ID interno
desde `user_profiles` y generar localmente el QR `vigilia:admin:<id>`; la cuenta
OIDC sigue siendo obligatoria. No se necesita reabrir la excepción inicial.
Sin OIDC, las cuentas administrativas son cuentas de Vigilia con contraseña y TOTP.
La simulación corporativa solo existe en demo.

## Operación y contratos

- `GET /auth/options`: obtiene CSRF previo al acceso y opciones de la instalación.
- `POST /auth/employee/login`: `{employee_id, code, password?}`; 428 si la cuenta
  necesita contraseña; devuelve sesión con `user.auth_method=totp|password`,
  `must_change_password`, `employee_id`, roles, permisos y nuevo CSRF.
- `POST /auth/admin/qr/start`: `{qr}`; prepara OIDC y devuelve nuevo CSRF.
- `GET /auth/login` y `/auth/callback`: completan el flujo corporativo.
- `GET /auth/badge`: gafete del perfil autenticado.
- `GET/POST /admin/employees`: consultar/crear empleados, con `users.manage`.
- `PUT /admin/employees/{id}`: `{display_name, active, roles?, permissions?}`.
- `POST /admin/employees/{id}/password`: contraseña temporal, una vez, `no-store`.
- `POST /auth/password`: `{current_password, new_password}` (mínimo 12 caracteres).
- `POST /admin/employees/{id}/totp`: reemplaza el secreto y devuelve
  `{uri, secret}` una vez, con respuesta `no-store`.
- `POST /auth/demo-admin`: simulación explícita, exclusivamente en demo y tras QR.

Toda mutación requiere `X-CSRF-Token`. Las respuestas de acceso y directorio
usan `Cache-Control: no-store`. No se guardan códigos o secretos en auditoría.
Los intentos tienen límites persistentes: 10 por cuenta y 30 por IP cada minuto.
Configura correctamente la confianza del proxy para que `request.client.host`
represente al cliente y no a una IP falsificada. Usa HTTPS en producción;
los navegadores requieren HTTPS o localhost para acceder a la cámara. Se admite
cargar una imagen del QR cuando no hay cámara, y escribir el ID para empleados.

Las migraciones `005_employee_auth.sql` y `006_local_accounts.sql` añaden el directorio, versiones de credencial,
control de reutilización, límites de intentos y estado del primer administrador.
Se aplica al iniciar, tanto en PostgreSQL como en SQLite demo. Los perfiles de
empleados usan una identidad interna separada de las identidades OIDC.

Pruebas: `cd backend; .venv/Scripts/python.exe -m pytest -q` y `pnpm run build`.
