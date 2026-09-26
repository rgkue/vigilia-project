#!/usr/bin/env sh
# Envía ingresos ficticios al webhook de Vigilia. Requiere curl; jq es opcional (resume la respuesta).
#
#   Modo demo:        ./scripts/demo-webhook.sh https://vigilia-demo.vercel.app vigilia-jurado-2026
#   Modo producción:  MODO=produccion TOKEN=vig_xxx ./scripts/demo-webhook.sh https://vigilia-app.vercel.app
#
# Variables opcionales: ESCENARIO (asma|toracico|vencida|sin-relacion|no-encontrado|todos),
# RUTA_API (por defecto /api; vacía para uvicorn local), INTEGRACION (por defecto sim-ingreso-his).
set -eu

URL="${1:?Uso: demo-webhook.sh <url> [clave-demo]}"
CLAVE="${2:-}"
MODO="${MODO:-demo}"
ESCENARIO="${ESCENARIO:-todos}"
RUTA_API="${RUTA_API-/api}"
INTEGRACION="${INTEGRACION:-sim-ingreso-his}"
ENDPOINT="${URL%/}${RUTA_API}/webhook/ingreso"
SELLO="$(date +%Y%m%d%H%M%S)"
FECHA="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

caso() {
  case "$1" in
    asma) echo "8-100-100|Crisis asmática con dificultad para respirar" ;;
    toracico) echo "8-400-400|Dolor torácico opresivo irradiado al brazo izquierdo" ;;
    vencida) echo "8-200-200|Fractura de muñeca por caída" ;;
    sin-relacion) echo "8-100-100|Esguince de tobillo jugando fútbol" ;;
    no-encontrado) echo "9-999-999|Dolor abdominal agudo" ;;
    *) echo "Escenario desconocido: $1" >&2; exit 2 ;;
  esac
}

if [ "$ESCENARIO" = "todos" ]; then LISTA="asma toracico vencida sin-relacion no-encontrado"; else LISTA="$ESCENARIO"; fi

N=0
for NOMBRE in $LISTA; do
  N=$((N + 1))
  DATOS="$(caso "$NOMBRE")"
  CEDULA="${DATOS%%|*}"
  MOTIVO="${DATOS#*|}"
  EVENTO="EVT-$SELLO-$N"
  if [ "$MODO" = "demo" ]; then
    CUERPO="{\"evento_id\":\"$EVENTO\",\"cedula\":\"$CEDULA\",\"hospital\":\"Hospital Demo · Emergencias\",\"motivo_ingreso\":\"$MOTIVO\",\"triage\":2,\"fecha_ingreso\":\"$FECHA\"}"
    set -- -H "X-Vigilia-Key: $CLAVE"
  else
    : "${TOKEN:?El modo producción necesita TOKEN=vig_...}"
    CUERPO="{\"evento\":{\"id\":\"$EVENTO\",\"fecha\":\"$FECHA\"},\"paciente\":{\"cedula\":\"$CEDULA\"},\"hospital\":{\"nombre\":\"Hospital Demo · Emergencias\"},\"atencion\":{\"motivo\":\"$MOTIVO\",\"triage\":2}}"
    set -- -H "X-Vigilia-Integration: $INTEGRACION" -H "Authorization: Bearer $TOKEN"
  fi
  printf '\n=== %s · %s ===\n' "$NOMBRE" "$EVENTO"
  # El cuerpo va por stdin para conservar el UTF-8 (en Windows, los argumentos pueden cambiar de codificación).
  RESPUESTA="$(printf '%s' "$CUERPO" | curl -sS -X POST "$ENDPOINT" -H "Content-Type: application/json; charset=utf-8" "$@" --data-binary @-)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$RESPUESTA" | jq -r '
      if .veredicto then
        "Resultado: \(.veredicto) · nivel \(.nivel_alerta)",
        "Póliza: \(if .poliza then "\(.poliza.numero) · vigente=\(.poliza.vigente)" else "sin póliza" end)",
        (.preexistencias[] | "Antecedente: \(.condicion) → \(.relacion)"),
        (.notificaciones[] | "Aviso \(.destino): \(.estado) (\(.canal))")
      else "Error: \(.detail // .)" end'
  else
    printf '%s\n' "$RESPUESTA"
  fi
done
printf '\nRevisa Actividad en Vigilia y los canales de Slack de admisiones y gestor de casos.\n'
