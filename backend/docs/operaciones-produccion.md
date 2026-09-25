# Operación en producción

Cada cliente usa una instalación aislada en su infraestructura. La instancia no es multiempresa. Antes de procesar datos reales, el cliente debe autorizar la fuente y el destino, facilitar la documentación técnica, aprobar el tratamiento y habilitar una red protegida.

## Arranque e identidad

1. Configura PostgreSQL con cifrado en tránsito y en reposo, controles de red y una identidad de servicio con los permisos mínimos.
2. Entrega las variables del backend desde el gestor de secretos. `VIGILIA_MODE` por defecto es `production`; PostgreSQL, OIDC, el correo de aprovisionamiento inicial, la clave de sesión y la clave de cifrado son obligatorios.
3. Registra `/auth/callback` como retorno OIDC y configura el frontend para usar el mismo origen o define el origen web, CORS y `VIGILIA_SESSION_SAME_SITE` según el despliegue.
4. El primer inicio de sesión solo crea el perfil administrador si el correo verificado coincide con `VIGILIA_BOOTSTRAP_ADMIN_EMAIL`. El administrador puede autorizar identidades existentes en el IdP, asignar roles y permisos del catálogo y desactivar perfiles. No se almacenan contraseñas del IdP.
5. Comprueba que un perfil sin acceso, una sesión vencida y permisos insuficientes son rechazados por el backend.

El backend aplica migraciones PostgreSQL versionadas al iniciar. Las migraciones se ejecutan en orden y se registran en `schema_migrations`. Haz respaldo antes de cada actualización; no hay migraciones de reversa automáticas.

## Configurar conectores

El panel guarda endpoints HTTPS, credenciales cifradas y mapeos declarativos. Los mapeos son rutas JSON simples (por ejemplo, `policy.number`); no admiten código, expresiones ni cambios de reglas.

| Tipo | Contrato esperado |
|---|---|
| Ingreso del hospital | `evento_id`, `cedula`, `hospital`, `motivo_ingreso`, `fecha_ingreso` y `triage` opcional. El mapeo de cada campo apunta a la propiedad de la carga JSON del hospital. |
| Cobertura | `numero`, `plan`, `vigente_desde`, `vigente_hasta`, `estado_pago` y `carencia_dias`. Fechas `YYYY-MM-DD`, `carencia_dias` entero no negativo y `estado_pago` canónico `AL_DIA` o `MOROSO`. Valores externos distintos necesitan normalización en el sistema de origen antes de habilitar el conector. |
| Antecedentes | Una lista de hasta 50 elementos (`items`), cada uno con `condition` y fecha opcional (`date`). |
| Admisiones y gestor de casos | Reciben un POST JSON mínimo con `event_id`, `verdict`, `alert_level`, `review_pending` y un aviso que solo contiene la referencia y el estado administrativo. El detalle se consulta dentro de Vigilia con permisos. |

La prueba del conector comprueba el endpoint usando el método y parámetro de consulta configurados con el identificador sintético `VIGILIA_TEST`; coordina ese comportamiento con el propietario del sistema externo. La prueba de conectividad no sustituye la validación de un mapeo contra sandbox.

Una respuesta HTTP 200 con JSON válido que declara ausencia (`null` para cobertura, o una lista vacía en la ruta mapeada de antecedentes) se interpreta como consulta atendida sin registros. Una respuesta HTTP 404 se clasifica como endpoint inaccesible, porque por sí sola no distingue entre ruta rota y persona ausente. Respuestas inválidas, no configuradas y caídas quedan como estados separados; si una consulta necesaria falla, Vigilia informa `PENDIENTE` y nunca simula datos.

### Credencial del webhook de ingreso

Para la integración de ingreso, crea una credencial desde Vigilia, guarda el token cuando se muestra una sola vez y entrega al sistema del hospital:

- `POST /webhook/ingreso`
- Encabezado `X-Vigilia-Integration: <id de la integración>`
- Encabezado `Authorization: Bearer <token>`
- Contrato de datos acordado y el mapeo guardado para esa integración

Rotar la credencial revoca inmediatamente la anterior. También se puede revocar cada token desde la administración. La tabla conserva su identificador y marcas de creación/revocación, pero solo se guarda el hash del secreto. En recepción, el mismo `evento_id` y la misma carga devuelven la respuesta guardada; una carga distinta con ese identificador recibe conflicto. Las notificaciones incluyen la referencia del evento para deduplicación en el destinatario. Una notificación fallida no se reenvía al repetir el evento; la remediación requiere el procedimiento operativo autorizado del cliente.

## IA y revisión

En producción usa `VIGILIA_AI_PROVIDER=none` y `VIGILIA_AI_APPROVED=false` hasta que el cliente apruebe proveedor, propósito, retención, transferencia internacional, contrato y campos transmitidos. Kev, Jev y Groq reciben solo el motivo de ingreso y las condiciones que se comparan; Vigilia no transmite la cédula, el hospital ni el nombre. Revisa la necesidad de cada campo con asesoría del cliente y legal.

Cuando haya una sugerencia, la alerta se envía inmediatamente y marca si la clasificación sigue pendiente. La persona con `classification.review` puede confirmar, corregir o descartar la sugerencia, justificar la resolución y dejarla auditada con su identidad y hora. La revisión no altera los avisos ya enviados, no decide cobertura o atención y no bloquea el ingreso urgente.

La Ley 81 panameña contempla varias bases de licitud; el consentimiento no debe presentarse como requisito universal. Si se usa como base para datos de salud, debe cumplir las condiciones legales aplicables, incluidas las de previo, expreso e irrefutable. La base concreta, los avisos de privacidad y las transferencias se revisan para el cliente y el piloto con asesoría legal ([Ley 81 de 2019](https://antai.gob.pa/wp-content/uploads/2019/09/Ley-81-de-2019-Proteccion-de-Datos-Personales.pdf), [Decreto Ejecutivo 285 de 2021](https://antai.gob.pa/wp-content/uploads/2021/05/Reglamentacio%CC%81n-de-Ley-81-de-Proteccio%CC%81n-de-Datos-Personales.pdf)).

## Respaldo y restauración

Los respaldos contienen identificadores y datos del evento; protégelos con el mismo nivel que la base productiva. Usa almacenamiento cifrado, acceso restringido, retención definida por el cliente y una copia fuera del entorno primario. Respalda por separado el material de recuperación del gestor de secretos, especialmente `VIGILIA_SECRET_ENCRYPTION_KEY`; sin esa clave, las credenciales de conectores restauradas no se pueden descifrar.

Ejemplo con herramientas PostgreSQL. `RESTORE_DATABASE_URL` debe apuntar a una base de restauración aislada y desechable, nunca a producción:

```powershell
$env:BACKUP_FILE = "D:\backups\vigilia-2026-09-25.dump"
pg_dump --format=custom --file $env:BACKUP_FILE $env:DATABASE_URL

$env:RESTORE_DATABASE_URL = "postgresql://vigilia_restore:...@db-restore/vigilia_restore"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname $env:RESTORE_DATABASE_URL $env:BACKUP_FILE
```

En cada piloto, TI debe acordar RPO/RTO, programar respaldos y hacer un simulacro de restauración en la base aislada. Confirma que las tablas, eventos, auditoría, perfiles, configuraciones y referencias de revisión están presentes; luego confirma que el secreto cifrado puede descifrarse usando la clave recuperada. Registra fecha, responsable, duración y resultado del simulacro. Este procedimiento documenta el ensayo; la restauración debe ejecutarse en el entorno protegido del cliente antes de producción.

## Piloto

Usa sandbox o datos anonimizados hasta disponer de autorización de la fuente, documentación, permisos, entorno protegido y aprobación del cliente. Despliega la app dentro de la infraestructura del cliente. El empaquetado y la primera integración real se acuerdan con su equipo de TI; no se asume Docker, Kubernetes ni un proveedor cloud particular.
