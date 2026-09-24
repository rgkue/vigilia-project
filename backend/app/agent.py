"""Agente de IA. ESTADO: marcador de posición (todo devuelve valores por defecto).

TODO (Claude API con tool use):
  1. relacionar_preexistencias: ¿el motivo de ingreso se relaciona con alguna preexistencia?
  2. redactar_mensajes: mensaje distinto para admisiones y para el gestor de casos.
"""
from .schemas import EventoIngreso, Mensajes, PolizaInfo, PreexistenciaRelacionada


async def relacionar_preexistencias(ev: EventoIngreso, preexistencias: list[dict]) -> list[PreexistenciaRelacionada]:
    return [
        PreexistenciaRelacionada(condicion=p["condicion"], relacion="NINGUNA",
                                 justificacion="Pendiente: análisis del agente")
        for p in preexistencias
    ]


async def redactar_mensajes(ev: EventoIngreso, nombre: str | None, poliza: PolizaInfo | None,
                            veredicto: str, nivel: str, rel: list[PreexistenciaRelacionada]) -> Mensajes:
    quien = nombre or f"cédula {ev.cedula}"
    return Mensajes(
        admisiones=f"[{nivel}] {quien} ingresó por «{ev.motivo_ingreso}» en {ev.hospital}. Veredicto: {veredicto}. "
                   "Se atiende de inmediato; la validación es solo administrativa.",
        gestor=f"[{nivel}] Ingreso {ev.evento_id}: {quien}. Veredicto: {veredicto}. "
               f"Preexistencias relacionadas: {sum(r.relacion != 'NINGUNA' for r in rel)}.",
    )
