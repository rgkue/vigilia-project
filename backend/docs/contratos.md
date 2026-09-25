# Contrato de Vigilia

Fuente de verdad: app/schemas.py. La integración conserva las rutas y los campos públicos del backend de BillieJSON.

## Entrada: POST /webhook/ingreso

    {
      "evento_id": "ING-0001",
      "cedula": "8-400-400",
      "hospital": "Hospital Punta Pacífica",
      "motivo_ingreso": "Dolor torácico opresivo",
      "triage": 2,
      "fecha_ingreso": "2026-09-24T14:32:00-05:00"
    }

## Salida

veredicto: VALIDA | VALIDA_CON_ALERTAS | NO_VALIDA | NO_ENCONTRADO
nivel_alerta: BAJO | MEDIO | ALTO

La respuesta también incluye poliza, preexistencias (condicion, relacion y justificacion), mensaje_admisiones, mensaje_gestor y notificaciones (destino, canal y estado).

La API conserva relacion como DIRECTA | POSIBLE | NINGUNA. Cuando una clasificación no se confirma, devuelve NINGUNA junto con el prefijo Revisión humana pendiente:; la UI convierte esa combinación en PENDIENTE. No se añade un valor nuevo al enum público.

## Responsabilidades

- rules.py verifica vigencia, pago y carencia, y determina el veredicto administrativo.
- agent.py usa Kev por defecto, Groq con `VIGILIA_AI_PROVIDER=groq`, o Jev con `VIGILIA_AI_PROVIDER=jev`. Groq usa por defecto `openai/gpt-oss-120b`. Jev usa `AI_GATEWAY_API_KEY` y exige retención cero (ZDR) en AI Gateway para el flujo de ingresos reales. La ficha pública actual de Jev no anuncia ZDR y la llamada con ZDR fue rechazada; por tanto, no se debe activar Jev para ingresos reales hasta que proveedor y ruta efectiva confirmen contractualmente y técnicamente esa protección. `disallowPromptTraining` no sustituye ZDR. El proveedor se selecciona explícitamente; no hay envío automático a un segundo servicio.
- Las sugerencias de IA o reglas requieren revisión humana. Si el proveedor falla, la relación queda pendiente; las reglas remotas pueden dar una pista opcional pero no confirman una clasificación.
- agent.py redacta los dos avisos con plantillas deterministas.
- notifier.py simula notificaciones en log salvo que Slack se active expresamente en el entorno privado.

La alerta es administrativa. La atención del paciente nunca debe retrasarse.

## Casos de muestra

| Cédula | Situación | Resultado con Kev apagado |
|---|---|---|
| 8-100-100 | Póliza vigente; asma registrada | VALIDA_CON_ALERTAS por clasificación pendiente |
| 8-200-200 | Póliza vencida | NO_VALIDA |
| 8-300-300 | Póliza en período de carencia | VALIDA_CON_ALERTAS |
| 8-400-400 | Hipertensión y diabetes | VALIDA_CON_ALERTAS por clasificación pendiente |
| 8-500-500 | Pago atrasado | VALIDA_CON_ALERTAS |
| 9-999-999 | Asegurado no registrado | NO_ENCONTRADO |

Las fechas de los fixtures son relativas a la fecha en que se inicializa SQLite.
