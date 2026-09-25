"""Reglas EXACTAS (sin IA): vigencia, pago, carencia y decisión final."""
from datetime import date

from .schemas import PolizaInfo, PreexistenciaRelacionada


def evaluar_poliza(p, fecha: date) -> PolizaInfo:
    desde = date.fromisoformat(p["vigente_desde"])
    hasta = date.fromisoformat(p["vigente_hasta"])
    return PolizaInfo(
        numero=p["numero"],
        plan=p["plan"],
        vigente=desde <= fecha <= hasta,
        al_dia_pago=p["estado_pago"] == "AL_DIA",
        en_carencia=(fecha - desde).days < p["carencia_dias"],
    )


def decidir(poliza: PolizaInfo | None, rel: list[PreexistenciaRelacionada]) -> tuple[str, str]:
    """Devuelve (veredicto, nivel_alerta), sin ocultar análisis pendientes."""
    if poliza is None:
        return "NO_ENCONTRADO", "MEDIO"
    if not poliza.vigente:
        return "NO_VALIDA", "ALTO"

    pending_review = any("pendiente" in item.justificacion.casefold() for item in rel)
    confirmed_direct = any(
        item.relacion == "DIRECTA" and "pendiente" not in item.justificacion.casefold()
        for item in rel
    )

    # Los modelos y las reglas de respaldo solo sugieren; una sugerencia marcada
    # como pendiente no puede elevar por sí sola el caso a prioridad alta.
    if pending_review:
        nivel = "MEDIO"
    elif confirmed_direct:
        nivel = "ALTO"
    elif poliza.en_carencia or not poliza.al_dia_pago or any(item.relacion == "POSIBLE" for item in rel):
        nivel = "MEDIO"
    else:
        nivel = "BAJO"
    return ("VALIDA" if nivel == "BAJO" else "VALIDA_CON_ALERTAS"), nivel
