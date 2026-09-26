# Contratos de Vigilia

La fuente de verdad de los cuerpos canónicos es [`backend/app/schemas.py`](../app/schemas.py). Las instalaciones usan el mismo contrato central. Cada conector puede mapear rutas JSON del proveedor a esos campos; el panel no ejecuta código ni permite modificar las reglas.

## Ingreso de un sistema

En demo, `POST /webhook/ingreso` recibe directamente el contrato. En producción requiere una credencial individual de una integración `ingress`:

```http
POST /webhook/ingreso
Authorization: Bearer <credencial>
X-Vigilia-Integration: <id de integración>
Content-Type: application/json
```

```json
{
  "evento_id": "ING-0001",
  "cedula": "8-400-400",
  "hospital": "Hospital de ejemplo",
  "motivo_ingreso": "Dolor torácico opresivo",
  "triage": 2,
  "fecha_ingreso": "2026-09-24T14:32:00-05:00"
}
```

`evento_id`, `cedula`, `hospital`, `motivo_ingreso` y `fecha_ingreso` son obligatorios; `triage` es opcional y acepta 1 a 5. En producción el mapa de ingreso transforma las rutas de la carga del hospital a esos campos.

## Resultado

La respuesta incluye `evento_id`, `veredicto`, `nivel_alerta`, `poliza`, `preexistencias`, dos mensajes administrativos, dos estados de notificación y `fuentes`.

| Campo | Valores / significado |
|---|---|
| `veredicto` | `VALIDA`, `VALIDA_CON_ALERTAS`, `NO_VALIDA`, `NO_ENCONTRADO`, `PENDIENTE`. |
| `nivel_alerta` | `BAJO`, `MEDIO` o `ALTO`. Es prioridad administrativa, no triage clínico. |
| `preexistencias[].relacion` | `DIRECTA`, `POSIBLE` o `NINGUNA`. Si `revisada=false`, es una sugerencia o resultado pendiente; no es decisión clínica ni de cobertura. |
| `preexistencias[].relacion_sugerida` | Relación original cuando hubo sugerencia; `null` cuando no se produjo. |
| `preexistencias[].revisada` | Indica una resolución humana registrada. Incluye motivo, revisor y fecha cuando aplica. |
| `fuentes[].estado` | `not_configured`, `connected`, `unavailable`, `invalid_response` o `not_found`; `consultada` indica si Vigilia llamó a la fuente. |
| `notificaciones[].estado` | `ENVIADA`, `ERROR` o `NO_CONFIGURADA`. Los avisos muestran si la clasificación sigue pendiente. |

`NO_ENCONTRADO` solo describe una respuesta válida de la fuente sin póliza/registro. Integración no configurada, caída, respuesta malformada o mapeo inválido producen `PENDIENTE`. Un 404 HTTP se considera endpoint inaccesible, no ausencia de persona. Una respuesta válida sin registro puede expresarse como `null` para cobertura o como lista vacía en la ruta mapeada de antecedentes.

## Ingreso manual y consulta

- `POST /ingresos`: contrato canónico, sesión OIDC, CSRF y permiso `ingress.submit`. En instalaciones donde el formulario web se habilite, el evento va siempre al backend; no hay fallback a datos ficticios.
- `GET /ingresos?limite=10`: sesión OIDC y permiso `ingress.read`. Devuelve respuestas administrativas recientes sin cédula, hospital ni motivo de ingreso.
- `GET /integrations/status`: sesión y permiso `ingress.read`; estado de conectores sin secretos.
- `GET /public-config`: identifica modo demo o producción. No contiene datos de personas ni secretos.

Un evento ya completado con el mismo identificador y la misma carga devuelve la respuesta persistida. Reutilizar el ID con otra carga devuelve HTTP 409. El sistema no vuelve a emitir notificaciones por un evento duplicado.

## Resolución humana

`POST /ingresos/{evento_id}/clasificaciones/{índice}/revision` requiere sesión OIDC, CSRF y permiso `classification.review`.

```json
{
  "relation": "POSIBLE",
  "reason": "La documentación autorizada respalda una posible relación."
}
```

`relation` acepta `DIRECTA`, `POSIBLE` o `NINGUNA`; `reason` requiere entre 3 y 1000 caracteres. Vigilia conserva sugerencia original, resolución, motivo, identidad revisora y fecha en el ingreso y en `review_actions`; también escribe un evento de auditoría. Revisar no cambia los avisos ya enviados.

## Contratos de fuentes

- Cobertura mapea `numero`, `plan`, `vigente_desde`, `vigente_hasta`, `estado_pago` y `carencia_dias`. Las fechas son `YYYY-MM-DD`, los días de carencia un entero no negativo y el estado de pago canónico es `AL_DIA` o `MOROSO`. El conector rechaza otros valores como respuesta inválida.
- Antecedentes mapea `items` a una lista de hasta 50 elementos; dentro de cada elemento mapea `condition` y opcionalmente `date`.
- Los destinos `admissions` y `case_manager` reciben un POST estructurado con `event_id`, `verdict`, `alert_level`, `review_pending` y un mensaje fijo, sin datos clínicos.

El panel de integraciones, los encabezados del webhook y el proceso operativo de piloto y respaldo se describen en [`operaciones-produccion.md`](operaciones-produccion.md). Los datos seed son sintéticos y solo están disponibles en modo demo.
