# Guion de demostración (≈ 3 minutos)

Objetivo: mostrar el recorrido que pide el reto, de extremo a extremo y desde el enlace público:

evento hospitalario → webhook → póliza y antecedentes → IA → avisos simultáneos → registro y revisión.

## Preparación (antes de presentar)

- Ten abiertos los dos canales de Slack (`#vigilia-admisiones`, `#vigilia-gestor`) y la aplicación en modo Demo.
- Ten una terminal en la raíz del repositorio.
- Comprueba que **Configuración de IA** muestra Ollama verificada y activa.

## Guion

1. **El problema (20 s).** Cuando un asegurado entra a emergencias, admisiones y la aseguradora se enteran tarde y cada uno por su lado. Vigilia recibe el ingreso y avisa a ambos a la vez, con la póliza y los antecedentes ya revisados.
2. **Selector de modo (15 s).** Abre `https://vigilia-health.vercel.app`. Explica que la misma instalación ofrece **Demo** (se entra sin credenciales) y **Producción** (cuentas con TOTP, integraciones y auditoría, como en un hospital). Entra en Demo.
3. **El hospital envía el ingreso (40 s).** En la terminal:

   ```powershell
   ./scripts/demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Clave vigilia-jurado-2026 -Escenario asma
   ```

   Muestra la respuesta:
   - la póliza, vigente y al día;
   - el antecedente *Asma leve*, con la sugerencia real del modelo: "Ollama sugiere directa…";
   - los dos avisos `ENVIADA (slack)`.
4. **Los dos destinatarios (20 s).** Cambia a Slack: el mismo ingreso llegó a admisiones y al gestor de casos en el mismo segundo, cada uno con su mensaje.
5. **Registro y revisión humana (45 s).**
   - En **Actividad**, abre el ingreso. Explica que la IA solo sugiere: el caso queda en *Revisión administrativa* hasta que una persona lo confirma.
   - Confirma "relación directa" con un motivo. El nivel pasa a *Prioridad administrativa* y Slack recibe el **aviso de actualización**.
6. **Otros casos (20 s).** Ejecuta `-Escenario vencida` y luego `-Escenario no-encontrado`:
   - póliza vencida: prioridad inmediata, sin IA;
   - asegurado inexistente: se marca para verificar sin inventar datos.
7. **Producción (20 s, opcional).** Pulsa **Cambiar modo → Producción**, entra con `JURADO-ADMIN` y muestra:
   - **Administración → Integraciones**: aseguradora simulada con su propio formato JSON y mapeo, token por integración y auditoría.
   - el acceso con TOTP y contraseña.

Cierre: *"Prototipo funcional de alerta temprana administrativa, con IA real, revisión humana y conectores configurables."*

## Qué decir si preguntan

| Pregunta | Respuesta |
|---|---|
| ¿La IA decide la cobertura? | No. Las reglas de póliza son exactas y sin IA. La IA sugiere relaciones entre antecedente y motivo, y una persona las confirma. Hasta entonces el caso no sube a prioridad por la IA. |
| ¿Cómo saben que los avisos llegaron? | Cada aviso informa `ENVIADA`, `ERROR`, `NO_CONFIGURADA` o `SIMULADA`, y los mensajes están en Slack. Sin canal configurado nunca se muestra como enviado. |
| ¿Qué pasa si el hospital reenvía el evento? | Es idempotente: devuelve la misma respuesta sin avisar dos veces. Si el primer intento falló, se reprocesa. |
| ¿Está listo para un hospital? | Es un prototipo. Las limitaciones están en el README: integración real, reintentos de avisos, carga, evaluación clínica de la IA y privacidad. |

## Pruebas finales antes de entregar

Ver la lista de verificación de [`entrega-jurado.md`](entrega-jurado.md#6-verificación-final).

Las pruebas automáticas (`cd backend; python -m pytest -q`) cubren:
- webhook demo con IA compartida y avisos `SIMULADA`;
- revisión que recalcula y vuelve a avisar;
- reintento de eventos fallidos o interrumpidos;
- instalación de producción con aseguradora simulada;
- cuentas del jurado protegidas y que se restablecen.
