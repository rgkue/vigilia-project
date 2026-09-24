# Contrato de Vigilia

Fuente de verdad: `app/schemas.py`. Cualquier cambio se acuerda entre Isaac y Rubén.

## Entrada: `POST /webhook/ingreso`
```json
{
  "evento_id": "ING-0001",
  "cedula": "8-400-400",
  "hospital": "Hospital Punta Pacífica",
  "motivo_ingreso": "Dolor torácico opresivo",
  "triage": 2,
  "fecha_ingreso": "2026-09-24T14:32:00-05:00"
}
```

## Salida
`veredicto`: `VALIDA` | `VALIDA_CON_ALERTAS` | `NO_VALIDA` | `NO_ENCONTRADO`
`nivel_alerta`: `BAJO` | `MEDIO` | `ALTO`
Además: `poliza`, `preexistencias` (con `relacion` DIRECTA/POSIBLE/NINGUNA y justificación), `mensaje_admisiones`, `mensaje_gestor` y `notificaciones` (una por destino).

## Reparto de responsabilidades
- **Código exacto** (`rules.py`): vigencia, pago, carencia y decisión final.
- **IA** (`agent.py`): relación entre el motivo de ingreso y las preexistencias, y redacción de los dos mensajes.

## Casos de prueba (cédulas del seed)
| Cédula | Situación | Veredicto |
|---|---|---|
| 8-100-100 | Todo en orden | VALIDA |
| 8-200-200 | Póliza vencida | NO_VALIDA |
| 8-300-300 | En período de carencia | VALIDA_CON_ALERTAS |
| 8-400-400 | Hipertensión y diabetes (con motivo cardíaco: relación DIRECTA/POSIBLE, requiere el agente) | VALIDA_CON_ALERTAS |
| 8-500-500 | Pago atrasado | VALIDA_CON_ALERTAS |
| 9-999-999 | No existe | NO_ENCONTRADO |

> La validación es administrativa: el paciente se atiende siempre.
