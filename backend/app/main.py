"""FastAPI application for a client-isolated Vigilia installation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from . import admin, agent, auth, connectors, rules, security
from .audit import record
from .db import conexion, database_mode, init_db
from .notifier import notificar_en_paralelo
from .schemas import EstadoIntegracion, EventoIngreso, PolizaInfo, RespuestaIngreso

VENTANA_SEG = 60
MAX_POR_VENTANA = 20
_hits: dict[str, deque] = defaultdict(deque)


def limitar(request: Request, identity: str | None = None) -> None:
    key = identity or (request.client.host if request.client else "unknown")
    ahora = time.monotonic()
    if len(_hits) > 10_000:
        _hits.clear()
    hits = _hits[key]
    while hits and ahora - hits[0] > VENTANA_SEG:
        hits.popleft()
    if len(hits) >= MAX_POR_VENTANA:
        raise HTTPException(status_code=429, detail="Demasiadas solicitudes, espera un minuto")
    hits.append(ahora)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if database_mode() == "production":
        security.validate_production_security()
    init_db()
    yield


app = FastAPI(title="Vigilia", description="Coordinación administrativa de ingresos a emergencias", lifespan=lifespan)
origins = [
    value.strip()
    for value in (os.getenv("VIGILIA_CORS_ORIGINS") or "http://127.0.0.1:5173").split(",")
    if value.strip()
]
frontend_origin = (os.getenv("OIDC_FRONTEND_ORIGIN") or "").strip().rstrip("/")
if frontend_origin and frontend_origin not in origins:
    origins.append(frontend_origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-CSRF-Token", "X-Vigilia-Integration", "X-Vigilia-Key"],
)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("VIGILIA_SESSION_SECRET") or "vigilia-demo-session-secret-not-for-production",
    session_cookie="vigilia_session",
    max_age=3600,
    same_site=(os.getenv("VIGILIA_SESSION_SAME_SITE") or "lax").strip().casefold(),
    https_only=database_mode() == "production",
)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(connectors.router)


@app.get("/health")
def health():
    return {"ok": True, "mode": database_mode()}


@app.get("/public-config")
def public_config():
    mode = database_mode()
    return {"mode": mode, "demo_enabled": mode == "demo"}


@app.get("/integrations/status")
def integration_status(request: Request):
    security.require_permission(request, "ingress.read")
    return connectors.integration_statuses()


def _demo_key(request: Request) -> None:
    expected = (os.getenv("VIGILIA_KEY") or "").strip()
    if not expected:
        return
    supplied = request.headers.get("x-vigilia-key", "")
    if not supplied or not secrets.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Clave de demo inválida.")


def _source(kind: str, status: str, consulted: bool) -> EstadoIntegracion:
    safe_status = status if status in {"not_configured", "connected", "unavailable", "invalid_response", "not_found"} else "unavailable"
    return EstadoIntegracion(tipo=kind, estado=safe_status, consultada=consulted)


def _event_hash(event: EventoIngreso) -> str:
    payload = json.dumps(event.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _stored_response(event_id: str, payload_hash: str) -> dict | None:
    with conexion() as connection:
        existing = connection.execute(
            "SELECT payload_hash, respuesta_json, estado FROM ingresos WHERE evento_id = ?",
            (event_id,),
        ).fetchone()
    if not existing:
        return None
    if existing["payload_hash"] != payload_hash:
        raise HTTPException(status_code=409, detail="El identificador del evento ya se usó con otros datos.")
    if existing["estado"] != "COMPLETADO" or not existing["respuesta_json"]:
        raise HTTPException(status_code=409, detail="Este evento ya está en proceso o requiere revisión operativa.")
    return json.loads(existing["respuesta_json"])


def _reserve_event(event: EventoIngreso, payload_hash: str) -> bool:
    with conexion() as connection:
        cursor = connection.execute(
            "INSERT INTO ingresos (evento_id, cedula, hospital, motivo, payload_hash, estado) "
            "VALUES (?, ?, ?, ?, ?, 'PROCESANDO') ON CONFLICT(evento_id) DO NOTHING",
            (event.evento_id, event.cedula, event.hospital, event.motivo_ingreso, payload_hash),
        )
        return cursor.rowcount == 1


async def _submit_event(event: EventoIngreso, actor_id: str) -> RespuestaIngreso:
    payload_hash = _event_hash(event)
    cached = _stored_response(event.evento_id, payload_hash)
    if cached is not None:
        return RespuestaIngreso.model_validate(cached)
    if not _reserve_event(event, payload_hash):
        cached = _stored_response(event.evento_id, payload_hash)
        if cached is not None:
            return RespuestaIngreso.model_validate(cached)
        raise HTTPException(status_code=409, detail="El evento ya fue recibido y sigue en proceso.")

    try:
        response = await _process_event(event)
    except Exception:
        with conexion() as connection:
            connection.execute("UPDATE ingresos SET estado = 'ERROR' WHERE evento_id = ?", (event.evento_id,))
        raise

    response_json = response.model_dump_json()
    with conexion() as connection:
        connection.execute(
            "UPDATE ingresos SET veredicto = ?, nivel_alerta = ?, respuesta_json = ?, estado = 'COMPLETADO' WHERE evento_id = ?",
            (response.veredicto, response.nivel_alerta, response_json, event.evento_id),
        )
        for notification, message in zip(response.notificaciones, (response.mensaje_admisiones, response.mensaje_gestor)):
            connection.execute(
                "INSERT INTO notificaciones (evento_id, destino, canal, estado, mensaje) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(evento_id, destino) DO NOTHING",
                (event.evento_id, notification.destino, notification.canal, notification.estado, message),
            )
    record(actor_id, "ingress.receive", "ingress", event.evento_id,
           {"verdict": response.veredicto, "level": response.nivel_alerta})
    return response


def _demo_records(event: EventoIngreso) -> tuple[PolizaInfo | None, list[dict]]:
    with conexion() as connection:
        asegurado = connection.execute("SELECT * FROM asegurados WHERE cedula = ?", (event.cedula,)).fetchone()
        policy = connection.execute(
            "SELECT * FROM polizas WHERE cedula = ? ORDER BY vigente_hasta DESC LIMIT 1", (event.cedula,)
        ).fetchone()
        conditions = [dict(row) for row in connection.execute(
            "SELECT * FROM preexistencias WHERE cedula = ?", (event.cedula,)
        )]
    policy_result = rules.evaluar_poliza(policy, event.fecha_ingreso.date()) if (asegurado and policy) else None
    return policy_result, conditions


async def _production_records(event: EventoIngreso):
    coverage_config = connectors.get_integration("coverage")
    history_config = connectors.get_integration("history")
    statuses: list[EstadoIntegracion] = []
    policy_result: PolizaInfo | None = None
    conditions: list[dict] = []
    policy_state = "not_configured"
    history_state = "not_configured"

    coverage_task = connectors.lookup("coverage", event.cedula) if coverage_config else asyncio.sleep(0, result=(None, "not_configured"))
    history_task = connectors.lookup("history", event.cedula) if history_config else asyncio.sleep(0, result=(None, "not_configured"))
    (coverage_payload, policy_state), (history_payload, history_state) = await asyncio.gather(coverage_task, history_task)

    if coverage_config:
        if policy_state == "connected":
            try:
                normalized = connectors.map_coverage(coverage_payload, coverage_config)
                if normalized is None:
                    policy_state = "not_found"
                else:
                    policy_result = rules.evaluar_poliza(normalized, event.fecha_ingreso.date())
            except (ValueError, KeyError, TypeError):
                policy_state = "invalid_response"
                connectors.set_integration_status("coverage", policy_state, "La respuesta no coincide con el mapeo de cobertura.")
        statuses.append(_source("coverage", policy_state, True))
    else:
        statuses.append(_source("coverage", "not_configured", False))

    if history_config:
        if history_state == "connected":
            try:
                conditions = connectors.map_history(history_payload, history_config)
            except (ValueError, KeyError, TypeError):
                history_state = "invalid_response"
                connectors.set_integration_status("history", history_state, "La respuesta no coincide con el mapeo de antecedentes.")
        statuses.append(_source("history", history_state, True))
    else:
        statuses.append(_source("history", "not_configured", False))
    return policy_result, conditions, statuses, policy_state, history_state


async def _process_event(event: EventoIngreso) -> RespuestaIngreso:
    if database_mode() == "demo":
        policy, conditions = _demo_records(event)
        sources = [_source("coverage", "connected", True), _source("history", "connected", True)]
        policy_state = "connected" if policy else "not_found"
        history_state = "connected"
    else:
        policy, conditions, sources, policy_state, history_state = await _production_records(event)

    relations = await agent.relacionar_preexistencias(event, conditions) if conditions else []
    for relation in relations:
        if relation.relacion_sugerida is None and "pendiente" not in relation.justificacion.casefold():
            relation.relacion_sugerida = relation.relacion

    source_error = any(
        item.estado in {"not_configured", "unavailable", "invalid_response"}
        for item in sources
    )
    if database_mode() == "production" and source_error:
        verdict, level = "PENDIENTE", "MEDIO"
    elif database_mode() == "production" and policy_state == "not_found":
        verdict, level = "NO_ENCONTRADO", "MEDIO"
    else:
        verdict, level = rules.decidir(policy, relations)

    messages = await agent.redactar_mensajes(event, None, policy, verdict, level, relations)
    review_pending = any("pendiente" in item.justificacion.casefold() for item in relations)
    notifications = await notificar_en_paralelo(
        messages.admisiones,
        messages.gestor,
        event_id=event.evento_id,
        verdict=verdict,
        level=level,
        review_pending=review_pending,
    )
    return RespuestaIngreso(
        evento_id=event.evento_id,
        veredicto=verdict,
        nivel_alerta=level,
        poliza=policy,
        preexistencias=relations,
        mensaje_admisiones=messages.admisiones,
        mensaje_gestor=messages.gestor,
        notificaciones=notifications,
        fuentes=sources,
    )


@app.post("/webhook/ingreso", response_model=RespuestaIngreso)
async def ingreso(request: Request):
    limitar(request)
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("El ingreso debe ser un objeto JSON.")
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="El cuerpo del ingreso no contiene JSON válido.") from exc

    integration = None
    if database_mode() == "production":
        integration_id = request.headers.get("x-vigilia-integration")
        integration = security.verify_integration_credential(integration_id, request.headers.get("authorization"))
        config = connectors.get_integration_by_id(integration_id or "")
        if not config:
            raise HTTPException(status_code=401, detail="No se encontró la integración de ingreso.")
        try:
            event = connectors.map_ingress(payload, config)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="El evento no coincide con el mapeo de ingreso configurado.") from exc
    else:
        _demo_key(request)
        try:
            event = EventoIngreso.model_validate(payload)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="El ingreso no cumple el contrato de Vigilia.") from exc

    return await _submit_event(event, integration["id"] if integration else "demo")


@app.post("/ingresos", response_model=RespuestaIngreso)
async def ingreso_manual(request: Request):
    limitar(request)
    profile = security.require_permission(request, "ingress.submit")
    security.require_csrf(request, request.headers.get("x-csrf-token"))
    try:
        payload = await request.json()
        event = EventoIngreso.model_validate(payload)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="El ingreso no cumple el contrato de Vigilia.") from exc
    return await _submit_event(event, profile["id"])


@app.get("/ingresos")
def ultimos_ingresos(request: Request, limite: int = 20):
    profile = security.require_permission(request, "ingress.read")
    limite = max(1, min(limite, 100))
    with conexion() as connection:
        rows = connection.execute(
            "SELECT respuesta_json, creado_en FROM ingresos WHERE estado = 'COMPLETADO' "
            "ORDER BY creado_en DESC LIMIT ?",
            (limite,),
        ).fetchall()
    if database_mode() == "production":
        record(profile["id"], "ingress.history.read", "ingress", None, {"limit": limite})
    return [{"creado_en": row["creado_en"], **json.loads(row["respuesta_json"])} for row in rows if row["respuesta_json"]]


@app.post("/ingresos/{event_id}/clasificaciones/{classification_index}/revision")
def review_classification(event_id: str, classification_index: int, body: connectors.ReviewInput,
                          request: Request, x_csrf_token: str | None = None):
    return connectors.review_classification(event_id, classification_index, body, request,
                                            request.headers.get("x-csrf-token") or x_csrf_token)
