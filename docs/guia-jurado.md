# Guía paso a paso para el jurado

Vigilia es **una sola instalación** con dos modos. Al abrir https://vigilia-health.vercel.app eliges uno; puedes cambiar en cualquier momento con **Cambiar modo**, en el pie de página.

| | Demo | Producción |
|---|---|---|
| Para qué | Evaluar el reto en minutos | Ver cómo lo usaría un hospital o una aseguradora |
| Cómo se entra | Sin credenciales | ID + código de app autenticadora (+ contraseña en administración) |
| Qué puedes hacer | Registrar ingresos, Simulador, revisar la IA, Actividad, Auditoría | Además: Personas, Integraciones, tokens por integración |
| Cómo llama el hospital al webhook | Cabecera pública `X-Vigilia-Key` y contrato de Vigilia | Token por integración y formato propio del hospital (con mapeo) |
| Póliza y antecedentes | Aseguradora simulada | La misma, consultada como integración HTTP |
| IA y avisos | IA real (Ollama) y avisos reales a Slack | Igual |

El flujo que pide el reto: **ingreso a emergencias → webhook → póliza y antecedentes → la IA sugiere → reglas fijan el nivel → aviso simultáneo a admisiones y al gestor de casos → revisión humana → recálculo y aviso de actualización.**

Todos los datos son ficticios:

| Cédula | Situación |
|---|---|
| `8-100-100` | Asma leve |
| `8-200-200` | Póliza vencida |
| `8-300-300` | En período de carencia |
| `8-400-400` | Hipertensión y diabetes |
| `8-500-500` | Pago atrasado |
| `9-999-999` | No existe |

## A. Modo Demo (≈ 5 minutos)

### A1. Entrar
1. Abre https://vigilia-health.vercel.app.
2. En "¿Cómo quieres conocer Vigilia?" elige **Demo** y pulsa **Entrar modo Demo**. Si ves la pantalla de acceso, usa **Entrar en modo Demo** en el recuadro "¿Solo quieres evaluar Vigilia?".
3. El pie muestra **Demo · datos ficticios**. El menú (arriba a la izquierda) tiene: *Operación* (Resumen, Registrar ingreso, Actividad), *Herramientas* (Simulador, Configuración de IA) y *Administración* (Auditoría).

### A2. El hospital envía un ingreso (webhook)
Abre una terminal en la carpeta que contiene `scripts/` (la raíz del repositorio o la carpeta del entregable).

Cinco escenarios de una vez:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Clave vigilia-jurado-2026
```

```bash
sh scripts/demo-webhook.sh https://vigilia-health.vercel.app vigilia-jurado-2026
```

Un solo ingreso:

```powershell
Invoke-RestMethod -Method Post -Uri "https://vigilia-health.vercel.app/api/webhook/ingreso" -ContentType "application/json; charset=utf-8" -Headers @{ "X-Vigilia-Key" = "vigilia-jurado-2026" } -InFile scripts/ejemplo-ingreso.json
```

```bash
curl -X POST https://vigilia-health.vercel.app/api/webhook/ingreso -H "Content-Type: application/json" -H "X-Vigilia-Key: vigilia-jurado-2026" --data-binary @scripts/ejemplo-ingreso.json
```

Qué esperar:

| Escenario | Resultado |
|---|---|
| `asma` (8-100-100) | La IA sugiere relación directa con el asma; queda en *Revisión administrativa* hasta que una persona lo confirme |
| `toracico` (8-400-400) | La IA sugiere relaciones con hipertensión y diabetes |
| `vencida` (8-200-200) | Póliza no vigente: prioridad administrativa, sin IA |
| `sin-relacion` (8-100-100) | La IA no ve relación con el asma |
| `no-encontrado` (9-999-999) | Asegurado no encontrado; no se inventan datos |

En cada respuesta: veredicto, nivel, póliza, cada antecedente con la sugerencia de la IA ("Ollama sugiere…") y los **dos avisos** (`ENVIADA` por `slack`).

> Un evento repetido (mismo `evento_id` y mismos datos) devuelve la respuesta guardada **sin volver a avisar**. Para un ingreso nuevo cambia `evento_id`; el script ya genera identificadores únicos. Mismo `evento_id` con otros datos → 409.

**Sin terminal:** **Registrar ingreso** (cédula, centro, motivo, triage opcional, fecha; marca la casilla de autorización y pulsa **Enviar ingreso**) o **Simulador** (abre desde el menú, elige uno de los seis escenarios y pulsa **Ejecutar escenario**). El bloque experimental "Probar clasificación Jev" no forma parte de la evaluación.

### A3. Actividad y revisión humana
1. Abre **Actividad**: filtros por resultado, nivel, revisión y fecha.
2. Pulsa un ingreso (p. ej. el de asma). El detalle muestra la línea de tiempo: *Ingreso recibido → Fuentes consultadas → Avisos → Revisión humana*.
3. En **Resolución de sugerencias**, elige **Confirmar relación directa**, **Marcar relación posible** o **Descartar relación**, escribe el motivo y pulsa **Guardar resolución**.
4. Vigilia recalcula el nivel (p. ej. *Revisión administrativa → Prioridad administrativa*), envía un **aviso de actualización** a los dos destinos y lo añade a la línea de tiempo como "Resultado actualizado tras revisión".

### A4. Otras pantallas
- **Resumen:** ingresos de hoy, revisiones pendientes, avisos con error y estado de las integraciones.
- **Configuración de IA:** Ollama aparece *Seleccionado · Conexión comprobada*. **Probar 3 casos ficticios** comprueba el modelo. Las cuentas de evaluación no pueden cambiar la clave compartida.
- **Administración → Auditoría:** cada acción (entrada en Demo, consultas, ingresos, revisiones), filtrable por tipo.

## B. Modo Producción (≈ 10 minutos)

Necesitas las credenciales de evaluación que el equipo envió al jurado (no están en el repositorio).

### B1. Preparar la app autenticadora
En Google Authenticator, Microsoft Authenticator, Authy u otra, añade las dos cuentas escaneando sus QR o escribiendo la clave (TOTP, 6 dígitos, 30 s). Esos QR son para la **app autenticadora**, no para la cámara del inicio de sesión.

### B2. Entrar como administración
1. Pie de página → **Cambiar modo** → **Producción** → **Entrar modo Producción**.
2. Pulsa **No tengo mi gafete · escribir mi ID**, escribe `JURADO-ADMIN` y pulsa **Continuar**.
3. Escribe el código de 6 dígitos de la app y pulsa **Verificar código**.
4. Como la cuenta tiene permisos administrativos, aparece **Contraseña**: escríbela y pulsa **Entrar**. El pie muestra **Producción**.

Cada código sirve una sola vez: si lo rechaza, espera al siguiente. Si varias personas usan la misma cuenta, cada una espera su propio código.

### B3. Qué revisar como administración
- **Administración → Integraciones:** las cinco integraciones simuladas: *HIS del hospital*, *Aseguradora · pólizas*, *Aseguradora · antecedentes*, *Admisiones del hospital (→ Slack)* y *Gestor de casos (→ Slack)*. Pulsa **Probar** en cada una.
  - Abre *HIS del hospital (simulado)* para ver el **mapeo de campos** (`evento_id ← $.evento.id`, `cedula ← $.paciente.cedula`…) y las **credenciales del webhook**.
  - **Rotar credencial de ingreso** emite un token nuevo que se muestra una sola vez; el token del jurado sigue funcionando.
  - Las integraciones del jurado no se pueden editar ni desactivar; puedes crear una propia con **+ tipo**.
- **Administración → Personas:** **Añadir persona** crea una cuenta de Vigilia; **Configurar autenticador** muestra su QR una sola vez y **Generar contraseña temporal** obliga a cambiarla en el primer acceso. Las cuentas del jurado están protegidas.
- **Administración → Auditoría:** accesos, pruebas de integraciones, rotación de credenciales y revisiones. No guarda credenciales ni texto clínico.

### B4. El hospital envía un ingreso con su propio formato
Con el token de la integración `sim-ingreso-his`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\demo-webhook.ps1 -Url https://vigilia-health.vercel.app -Modo produccion -Token <TOKEN>
```

```bash
MODO=produccion TOKEN=<TOKEN> sh scripts/demo-webhook.sh https://vigilia-health.vercel.app
```

Vigilia traduce el formato del HIS con el mapeo, consulta la aseguradora simulada por HTTP, clasifica con la IA y avisa a través de los receptores simulados (los mensajes llegan a Slack como `Producción · …`). Sin token válido responde 401. Luego revisa y resuelve el ingreso en **Actividad** como en A3.

### B5. Entrar como recepción
1. Menú → **Cuenta** → **Cerrar sesión**.
2. **No tengo mi gafete · escribir mi ID** → `JURADO-RECEPCION` → código → **Verificar código**. Entra sin contraseña: solo tiene permisos de mostrador.
3. Puede **Registrar ingreso** y ver **Actividad**, pero no ve Administración ni resuelve sugerencias de la IA: los permisos se verifican en el servidor.
4. Opcional: menú → **Cuenta** → **Mi gafete QR** descarga su gafete. En el próximo acceso, **Cargar imagen del QR** lo lee y solo pide el código.

## Solución de problemas

| Síntoma | Qué hacer |
|---|---|
| PowerShell dice que la ejecución de scripts está deshabilitada | Usa `powershell -ExecutionPolicy Bypass -File …` como en los ejemplos |
| No llegan avisos nuevos al repetir un envío | Cambia `evento_id`: el evento repetido devuelve la respuesta guardada |
| 409 "El identificador del evento ya se usó con otros datos" | Usa otro `evento_id` |
| Código TOTP rechazado | Espera al siguiente código (30 s) y comprueba la hora del teléfono |
| "Tu sesión terminó" | Vuelve a entrar; las cuentas del jurado se restablecen en cada arranque |
