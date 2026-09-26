"""Reglas EXACTAS (sin IA): vigencia, pago, carencia y decisión final."""
from datetime import date

from .schemas import EstadoIntegracion, PolizaInfo, PreexistenciaRelacionada

ERRORES_FUENTE = {"not_configured", "unavailable", "invalid_response"}


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


def pendiente(item: PreexistenciaRelacionada) -> bool:
    """Una sugerencia sigue pendiente hasta que una persona la revisa."""
    return not item.revisada and "pendiente" in item.justificacion.casefold()


def decidir(poliza: PolizaInfo | None, rel: list[PreexistenciaRelacionada]) -> tuple[str, str]:
    """Devuelve (veredicto, nivel_alerta), sin ocultar análisis pendientes."""
    if poliza is None:
        return "NO_ENCONTRADO", "MEDIO"
    if not poliza.vigente:
        return "NO_VALIDA", "ALTO"

    pending_review = any(pendiente(item) for item in rel)
    confirmed_direct = any(item.relacion == "DIRECTA" and not pendiente(item) for item in rel)

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


def decidir_con_fuentes(poliza: PolizaInfo | None, rel: list[PreexistenciaRelacionada],
                        fuentes: list[EstadoIntegracion], modo: str) -> tuple[str, str]:
    """Resultado general del ingreso; se usa al recibirlo y otra vez tras cada revisión humana."""
    if modo == "production":
        if any(item.estado in ERRORES_FUENTE for item in fuentes):
            return "PENDIENTE", "MEDIO"
        if any(item.tipo == "coverage" and item.estado == "not_found" for item in fuentes):
            return "NO_ENCONTRADO", "MEDIO"
    return decidir(poliza, rel)
