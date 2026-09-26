<#
.SYNOPSIS
  Envía ingresos ficticios al webhook de Vigilia y resume la respuesta (póliza, antecedentes, IA y avisos).

.DESCRIPTION
  Modo demo: contrato canónico de Vigilia y cabecera X-Vigilia-Key.
  Modo producción: formato del HIS del hospital (se traduce con el mapeo de la integración),
  cabecera X-Vigilia-Integration y token Bearer de la integración.
  Todos los datos son ficticios.

.EXAMPLE
  ./scripts/demo-webhook.ps1 -Url https://vigilia-demo.vercel.app -Clave vigilia-jurado-2026

.EXAMPLE
  ./scripts/demo-webhook.ps1 -Url https://vigilia-app.vercel.app -Modo produccion -Token vig_xxx -Escenario asma
#>
param(
  [Parameter(Mandatory = $true)] [string] $Url,
  [ValidateSet("demo", "produccion")] [string] $Modo = "demo",
  [string] $Clave = "",
  [string] $Token = "",
  [string] $Integracion = "sim-ingreso-his",
  [ValidateSet("todos", "asma", "toracico", "vencida", "sin-relacion", "no-encontrado")] [string] $Escenario = "todos",
  # En Vercel la API vive bajo /api; con uvicorn local usa -RutaApi "".
  [string] $RutaApi = "/api"
)

$ErrorActionPreference = "Stop"
$escenarios = [ordered]@{
  "asma"          = @{ cedula = "8-100-100"; motivo = "Crisis asmática con dificultad para respirar"; esperado = "IA sugiere relación directa con asma; queda en revisión hasta que una persona la confirme" }
  "toracico"      = @{ cedula = "8-400-400"; motivo = "Dolor torácico opresivo irradiado al brazo izquierdo"; esperado = "IA sugiere relaciones con hipertensión y diabetes para revisión" }
  "vencida"       = @{ cedula = "8-200-200"; motivo = "Fractura de muñeca por caída"; esperado = "Póliza vencida: prioridad administrativa" }
  "sin-relacion"  = @{ cedula = "8-100-100"; motivo = "Esguince de tobillo jugando fútbol"; esperado = "IA no ve relación con el asma; tras confirmarlo queda como aviso administrativo" }
  "no-encontrado" = @{ cedula = "9-999-999"; motivo = "Dolor abdominal agudo"; esperado = "Asegurado no encontrado en la aseguradora" }
}
$seleccion = if ($Escenario -eq "todos") { $escenarios.Keys } else { @($Escenario) }
$endpoint = $Url.TrimEnd("/") + $RutaApi + "/webhook/ingreso"
$headers = @{}
if ($Modo -eq "demo") {
  if ($Clave) { $headers["X-Vigilia-Key"] = $Clave }
} else {
  if (-not $Token) { throw "El modo producción necesita -Token (credencial de la integración de ingreso)." }
  $headers["X-Vigilia-Integration"] = $Integracion
  $headers["Authorization"] = "Bearer $Token"
}

$sello = Get-Date -Format "yyyyMMddHHmmss"
$n = 0
foreach ($nombre in $seleccion) {
  $n++
  $caso = $escenarios[$nombre]
  $eventoId = "EVT-$sello-$n"
  $fecha = (Get-Date).ToString("o")
  if ($Modo -eq "demo") {
    $cuerpo = @{ evento_id = $eventoId; cedula = $caso.cedula; hospital = "Hospital Demo · Emergencias"; motivo_ingreso = $caso.motivo; triage = 2; fecha_ingreso = $fecha }
  } else {
    $cuerpo = @{ evento = @{ id = $eventoId; fecha = $fecha }; paciente = @{ cedula = $caso.cedula }; hospital = @{ nombre = "Hospital Demo · Emergencias" }; atencion = @{ motivo = $caso.motivo; triage = 2 } }
  }
  Write-Host ""
  Write-Host "=== $nombre · $eventoId ===" -ForegroundColor Cyan
  Write-Host "Esperado: $($caso.esperado)"
  try {
    $json = $cuerpo | ConvertTo-Json -Depth 5
    $r = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
  } catch {
    $detalle = $_.ErrorDetails.Message
    Write-Host "Error: $($_.Exception.Message) $detalle" -ForegroundColor Red
    continue
  }
  $poliza = if ($r.poliza) { "$($r.poliza.numero) · vigente=$($r.poliza.vigente) · pago al día=$($r.poliza.al_dia_pago) · carencia=$($r.poliza.en_carencia)" } else { "sin póliza" }
  Write-Host "Resultado: $($r.veredicto) · nivel $($r.nivel_alerta)"
  Write-Host "Póliza:    $poliza"
  foreach ($p in $r.preexistencias) {
    Write-Host ("Antecedente: {0} → {1}" -f $p.condicion, $p.relacion)
    Write-Host ("  {0}" -f $p.justificacion) -ForegroundColor DarkGray
  }
  foreach ($a in $r.notificaciones) {
    Write-Host ("Aviso {0}: {1} ({2})" -f $a.destino, $a.estado, $a.canal)
  }
}
Write-Host ""
Write-Host "Revisa la pantalla Actividad de Vigilia y los canales de Slack de admisiones y gestor de casos."
