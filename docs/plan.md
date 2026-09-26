# Plan de producto de Vigilia

## Objetivo

Preparar Vigilia como una aplicación web configurable que se instala por separado dentro de la infraestructura de cada cliente. Mantener reglas administrativas comunes y adaptar conexiones mediante mapeos declarativos. La aplicación no decide atención clínica ni debe demorarla.

## Implementado en el repositorio

- **Demo y producción separados.** Producción es el modo por defecto, exige PostgreSQL y no carga datos ficticios. Los fixtures y el simulador local se limitan al modo demo/desarrollo. Un ingreso real no usa fallback simulado.
- **Persistencia.** Se añadió adaptador PostgreSQL, migración inicial versionada y actualización compatible del esquema SQLite de demo. Hay procedimiento de respaldo y restauración en [`backend/docs/operaciones-produccion.md`](../backend/docs/operaciones-produccion.md); falta ensayarlo en la base protegida del cliente.
- **Acceso humano.** Cuentas de Vigilia con ID o gafete y TOTP; las administrativas usan además contraseña. OIDC es opcional para organizaciones con IdP. Catálogo fijo de permisos, desactivación de cuentas y auditoría.
- **Acceso de sistemas.** Credenciales individuales para el webhook de ingreso; almacenamiento solo de hashes, rotación y revocación. Los secretos de conectores salientes se cifran con una clave Fernet del entorno.
- **Conectores.** Panel administrativo para ingreso, cobertura, antecedentes y destinos de aviso. Los mapeos son rutas JSON a contratos canónicos; se distinguen fuentes sin configurar, caídas, respuestas inválidas y respuestas válidas sin registro.
- **Revisión humana.** Las sugerencias quedan pendientes, las alertas se emiten sin esperar la revisión y la resolución conserva sugerencia original, resultado, motivo, revisor y fecha. Si la resolución cambia el resultado general, Vigilia recalcula veredicto y nivel y envía un aviso de actualización a ambos destinos.
- **Datos minimizados.** Los avisos solo incluyen la referencia y el estado administrativo; el detalle se consulta dentro de Vigilia. Las llamadas opcionales a Kev, Jev y Groq están desactivadas por defecto y requieren aprobación explícita en producción.
- **Documentación.** Se actualizaron los contratos, variables de instalación y guía del piloto, privacidad, copias y restauración.

## Validación realizada

- La CI ejecuta la suite de pytest del backend y la compilación del frontend (`.github/workflows/verify.yml`).
- Las instalaciones de evaluación en Vercel usan PostgreSQL (Neon), IA real y avisos a Slack; la verificación de extremo a extremo está en [`entrega-jurado.md`](entrega-jurado.md).
- No se conectó a sistemas reales de un hospital o una aseguradora: en producción de muestra están simulados.

## Pendiente para el piloto de un cliente

1. Elegir cliente y sistema de ingreso con autorización, documentación técnica, sandbox y mapeo validado.
2. Desplegar PostgreSQL, secretos, dominio/proxy y el frontend en la infraestructura del cliente; conectar el IdP OIDC si la organización lo usa.
3. Completar un simulacro de respaldo/restauración y acordar RPO/RTO.
4. Probar credenciales, permisos, respuestas nulas, errores de endpoint, duplicados y avisos con datos sintéticos o anonimizados.
5. Revisar finalidad, base de licitud, avisos de privacidad, transferencia y retención con el cliente y asesoría legal. El consentimiento no se presume como base universal; si se usa para datos de salud, aplicar los requisitos de la Ley 81 de 2019 y el Decreto Ejecutivo 285 de 2021.
6. Mantener la IA externa apagada hasta que el cliente apruebe proveedor, tratamiento, retención y transferencia. No usar datos reales con Jev hasta confirmar la ruta ZDR de la cuenta; el registro técnico está en [`docs/jev-ai-sdk-experiment.md`](jev-ai-sdk-experiment.md).
7. Acordar con TI el empaquetado y el despliegue. El repositorio no presupone Docker, Kubernetes ni proveedor cloud.

## Decisiones de producto

- Una instalación aislada por cliente; no hay multiempresa en una misma base.
- Aplicación web y PostgreSQL; cuentas de Vigilia con TOTP (OIDC opcional) y perfiles/roles gestionados en Vigilia.
- Permisos de catálogo cerrado; las cuentas desactivadas conservan auditoría.
- Revisión humana dentro de Vigilia. Las reglas exactas conservan la decisión sobre cobertura; la IA solo produce sugerencias.
- La primera integración real y el método de empaquetado se definen con el cliente del piloto.

## Contratos

El brief original del reto 4 sigue cubierto por el webhook, la consulta administrativa, los dos destinatarios de aviso y la auditoría. Las interfaces y estados actuales se describen en [`backend/docs/contratos.md`](../backend/docs/contratos.md); la operación se describe en [`backend/docs/operaciones-produccion.md`](../backend/docs/operaciones-produccion.md).
