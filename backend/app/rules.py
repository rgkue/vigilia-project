"""Reglas EXACTAS (sin IA): vigencia, pago, carencia y decisión final."""
from datetime import date

from .schemas import PolizaInfo, PreexistenciaRelacionada


def evaluar_poliza(p, fecha: date) -> PolizaInfo:
    desde = date.fromisoformat(p["vigente_desde"])
    hasta = date.fromisoformat(p["vigente_hasta"])
    return PolizaInfo(
        numero=p["numero"], plan=p["plan"],
        vigente=desde <= fecha <= hasta,
        al_dia_pago=p["estado_pago"] == "AL_DIA",
        en_carencia=(fecha - desde).days < p["carencia_dias"],
    )


def decidir(poliza: PolizaInfo | None, rel: list[PreexistenciaRelacionada]) -> tuple[str, str]:
    """Devuelve (veredicto, nivel_alerta)."""
    if poliza is None:
        return "NO_ENCONTRADO", "MEDIO"
    if not poliza.vigente:
        return "NO_VALIDA", "ALTO"
    nivel = "BAJO"
    if poliza.en_carencia or not poliza.al_dia_pago or any(r.relacion == "POSIBLE" for r in rel):
        nivel = "MEDIO"
    if any(r.relacion == "DIRECTA" for r in rel):
        nivel = "ALTO"
    return ("VALIDA" if nivel == "BAJO" else "VALIDA_CON_ALERTAS"), nivel
