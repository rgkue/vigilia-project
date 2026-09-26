"""Consultas de lectura para la interfaz: listado filtrado y resumen operativo de ingresos."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from . import security
from .audit import record
from .db import conexion, database_mode, timestamp_iso, timestamp_param

router = APIRouter(prefix="/ingresos", tags=["ingresos"])

# Los escenarios del simulador usan este prefijo; no forman parte de la operación.
SYNTHETIC_PREFIX = "ING-DEMO-"
VERDICTS = {"VALIDA", "VALIDA_CON_ALERTAS", "NO_VALIDA", "NO_ENCONTRADO", "PENDIENTE"}
LEVELS = {"BAJO", "MEDIO", "ALTO"}
REVIEW_WINDOW_DAYS = 30


def _parse_moment(value: str | None, field: str) -> datetime | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"El parámetro {field} debe ser una fecha ISO 8601.") from exc
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _mask_id(value: str | None) -> str | None:
    if not value:
        return None
    visible = value[-4:] if len(value) > 4 else ""
    return f"•••{visible}" if visible else "••••"


def _review_pending(response: dict[str, Any]) -> bool:
    return any(not item.get("revisada") for item in response.get("preexistencias") or [])


def _like(term: str) -> str:
    escaped = term.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _base_filters(*, include_tests: bool, since: datetime | None = None, until: datetime | None = None) -> tuple[list[str], list[Any]]:
    clauses = ["estado = 'COMPLETADO'", "respuesta_json IS NOT NULL"]
    parameters: list[Any] = []
    if not include_tests:
        clauses.append("evento_id NOT LIKE ?")
        parameters.append(f"{SYNTHETIC_PREFIX}%")
    if since:
        clauses.append("creado_en >= ?")
        parameters.append(timestamp_param(since))
    if until:
        clauses.append("creado_en < ?")
        parameters.append(timestamp_param(until))
    return clauses, parameters


def _item(row: dict[str, Any]) -> dict[str, Any]:
    response = json.loads(row["respuesta_json"])
    return {
        **response,
        "creado_en": timestamp_iso(row["creado_en"]),
        "hospital": row["hospital"],
        "motivo": row["motivo"],
        "cedula_mascara": _mask_id(row["cedula"]),
        "revision_pendiente": _review_pending(response),
    }


@router.get("/listado")
def list_ingresses(
    request: Request,
    limite: int = 25,
    pagina: int = 1,
    q: str | None = None,
    veredicto: str | None = None,
    nivel: str | None = None,
    desde: str | None = None,
    hasta: str | None = None,
    revision_pendiente: bool = False,
    incluir_pruebas: bool = False,
):
    profile = security.require_permission(request, "ingress.read")
    limite = max(1, min(limite, 100))
    pagina = max(1, pagina)
    verdicts = [item for item in (veredicto or "").split(",") if item]
    levels = [item for item in (nivel or "").split(",") if item]
    if any(item not in VERDICTS for item in verdicts) or any(item not in LEVELS for item in levels):
        raise HTTPException(status_code=422, detail="Filtro de veredicto o nivel no reconocido.")

    clauses, parameters = _base_filters(
        include_tests=incluir_pruebas,
        since=_parse_moment(desde, "desde"),
        until=_parse_moment(hasta, "hasta"),
    )
    if verdicts:
        clauses.append(f"veredicto IN ({', '.join('?' for _ in verdicts)})")
        parameters.extend(verdicts)
    if levels:
        clauses.append(f"nivel_alerta IN ({', '.join('?' for _ in levels)})")
        parameters.extend(levels)
    term = (q or "").strip()[:80]
    if term:
        clauses.append(
            "(LOWER(evento_id) LIKE ? ESCAPE '\\' OR LOWER(hospital) LIKE ? ESCAPE '\\' "
            "OR LOWER(motivo) LIKE ? ESCAPE '\\' OR cedula = ?)"
        )
        pattern = _like(term)
        parameters.extend([pattern, pattern, pattern, term])

    where = " AND ".join(clauses)
    columns = "evento_id, cedula, hospital, motivo, respuesta_json, creado_en"
    offset = (pagina - 1) * limite
    with conexion() as connection:
        if revision_pendiente:
            # El estado de revisión vive en el JSON de respuesta; se filtra tras la consulta.
            rows = connection.execute(
                f"SELECT {columns} FROM ingresos WHERE {where} ORDER BY creado_en DESC, evento_id DESC", tuple(parameters)
            ).fetchall()
            items = [item for item in (_item(row) for row in rows) if item["revision_pendiente"]]
            total = len(items)
            items = items[offset:offset + limite]
        else:
            total = connection.execute(f"SELECT COUNT(*) AS total FROM ingresos WHERE {where}", tuple(parameters)).fetchone()["total"]
            rows = connection.execute(
                f"SELECT {columns} FROM ingresos WHERE {where} ORDER BY creado_en DESC, evento_id DESC LIMIT ? OFFSET ?",
                (*parameters, limite, offset),
            ).fetchall()
            items = [_item(row) for row in rows]

    if database_mode() == "production":
        record(profile["id"], "ingress.history.read", "ingress", None, {"limit": limite, "page": pagina, "filtered": bool(term or verdicts or levels or desde or hasta or revision_pendiente)})
    return {"items": items, "total": int(total), "pagina": pagina, "limite": limite}


@router.get("/resumen")
def summary(request: Request, inicio_dia: str | None = None, incluir_pruebas: bool = False):
    profile = security.require_permission(request, "ingress.read")
    now = datetime.now(timezone.utc)
    day_start = _parse_moment(inicio_dia, "inicio_dia") or now.replace(hour=0, minute=0, second=0, microsecond=0)
    last_day = now - timedelta(hours=24)
    review_since = now - timedelta(days=REVIEW_WINDOW_DAYS)
    earliest = min(day_start, last_day, review_since)

    clauses, parameters = _base_filters(include_tests=incluir_pruebas, since=earliest)
    with conexion() as connection:
        rows = connection.execute(
            f"SELECT veredicto, nivel_alerta, respuesta_json, creado_en FROM ingresos WHERE {' AND '.join(clauses)}",
            tuple(parameters),
        ).fetchall()
        notification_filters = ["n.creado_en >= ?"]
        notification_parameters: list[Any] = [timestamp_param(day_start)]
        if not incluir_pruebas:
            notification_filters.append("n.evento_id NOT LIKE ?")
            notification_parameters.append(f"{SYNTHETIC_PREFIX}%")
        notifications = connection.execute(
            "SELECT n.estado, n.canal, COUNT(*) AS total FROM notificaciones n "
            f"WHERE {' AND '.join(notification_filters)} GROUP BY n.estado, n.canal",
            tuple(notification_parameters),
        ).fetchall()

    today = {"total": 0, "por_veredicto": {key: 0 for key in sorted(VERDICTS)}, "por_nivel": {key: 0 for key in sorted(LEVELS)}}
    last_24h = 0
    pending_review = 0
    for row in rows:
        created = datetime.fromisoformat(timestamp_iso(row["creado_en"]))
        if created >= day_start:
            today["total"] += 1
            if row["veredicto"] in today["por_veredicto"]:
                today["por_veredicto"][row["veredicto"]] += 1
            if row["nivel_alerta"] in today["por_nivel"]:
                today["por_nivel"][row["nivel_alerta"]] += 1
        if created >= last_day:
            last_24h += 1
        if created >= review_since and _review_pending(json.loads(row["respuesta_json"])):
            pending_review += 1

    delivery = {"enviados": 0, "internos": 0, "fallidos": 0, "sin_configurar": 0}
    for row in notifications:
        total = int(row["total"])
        if row["estado"] == "ERROR":
            delivery["fallidos"] += total
        elif row["estado"] == "NO_CONFIGURADA":
            delivery["sin_configurar"] += total
        elif row["estado"] == "SIMULADA" or (row["estado"] == "ENVIADA" and str(row["canal"]).casefold() == "log"):
            # SIMULADA (y el formato anterior ENVIADA/log): el aviso no salió del servidor.
            delivery["internos"] += total
        elif row["estado"] == "ENVIADA":
            delivery["enviados"] += total

    if database_mode() == "production":
        record(profile["id"], "ingress.summary.read", "ingress", None, {})
    return {
        "generado_en": now.isoformat(),
        "inicio_dia": day_start.isoformat(),
        "hoy": today,
        "ultimas_24h": last_24h,
        "revision_pendiente": pending_review,
        "ventana_revision_dias": REVIEW_WINDOW_DAYS,
        "avisos_hoy": delivery,
    }
