"""FastAPI application for a client-isolated Vigilia installation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

from . import admin, agent, ai_assignments, ai_providers, ai_subscriptions, auth, connectors, provisioning, rules, security, simulated
from .audit import record
from . import access, employees, ingress_queries
from .db import conexion, database_mode, init_db, timestamp_param
from .notifier import notificar_en_paralelo
from .schemas import ActualizacionRevision, EstadoIntegracion, EventoIngreso, PolizaInfo, RespuestaIngreso

logger = logging.getLogger(__name__)
VENTANA_SEG = 60
MAX_POR_VENTANA = 20
# Un evento que quedó "PROCESANDO" más tiempo que esto (p. ej. por un corte) puede reintentarse.
PROCESANDO_MAXIMO = timedelta(seconds=int(os.getenv("VIGILIA_STALE_SECONDS", "120")))
_hits: dict[str, deque] = defaultdict(deque)
_ready = False
_ready_lock = threading.Lock()


def _startup() -> None:
    """Migraciones y aprovisionamiento, una vez por proceso (también en plataformas sin lifespan)."""
    global _ready
    with _ready_lock:
        if _ready:
            return
        if database_mode() == "production":
            security.validate_production_security()
        init_db()
        try:
            provisioning.apply()
        except Exception:  # noqa: BLE001 - la instalación sigue disponible aunque falle la preparación de evaluación
            logger.exception("No se pudo aplicar el aprovisionamiento de evaluación; revisa sus variables de entorno.")
        _ready = True


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
    global _ready
    _ready = False  # Cada ciclo de vida (p. ej. cada TestClient) vuelve a preparar su base de datos.
    _startup()
    try:
        yield
    finally:
        pending = list(ai_subscriptions.tasks.values())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


app = FastAPI(title="Vigilia", description="Coordinación administrativa de ingresos a emergencias", lifespan=lifespan)


@app.middleware("http")
async def ensure_initialized(request: Request, call_next):
    if not _ready:
        await asyncio.to_thread(_startup)
    return await call_next(request)


@app.middleware("http")
async def private_auth_responses(request: Request, call_next):
    response = await call_next(request)
    path = str(request.scope.get("path") or request.url.path)
    if path.startswith("/api/"):
        path = path[4:]
    if path.startswith(("/auth/", "/admin/employees")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def safe_validation_error(_: Request, __: RequestValidationError):
    # Pydantic's default validation response may echo submitted values, including secrets.
    return JSONResponse(status_code=422, content={"detail": "La solicitud no cumple el contrato configurado."})


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
@app.middleware("http")
async def personal_ai_cache_policy(request: Request, call_next):
    response = await call_next(request)
    path = str(request.scope.get("path") or request.url.path)
    if path.startswith("/api/"):
        path = path[4:]
    if path.startswith(("/me/ai", "/admin/ai")):
        response.headers["Cache-Control"] = "no-store"
    return response


app.include_router(auth.router)
app.include_router(access.router)
app.include_router(employees.router)
app.include_router(admin.router)
app.include_router(connectors.router)
app.include_router(ai_providers.router)
app.include_router(ai_assignments.router)
app.include_router(ai_subscriptions.router)
app.include_router(ingress_queries.router)
app.include_router(simulated.router)


@app.get("/health")
def health():
    return {"ok": True, "mode": database_mode()}


def _public_url(variable: str) -> str | None:
    value = (os.getenv(variable) or "").strip().rstrip("/")
    parts = urlsplit(value)
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        return None
    return value


@app.get("/public-config")
def public_config():
    mode = database_mode()
    # Direcciones públicas de las dos instalaciones de evaluación, para el selector de modo.
    return {"mode": mode, "demo_enabled": mode == "demo",
            "demo_url": _public_url("VIGILIA_DEMO_URL"), "production_url": _public_url("VIGILIA_PRODUCTION_URL")}


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


def _stale_before() -> object:
    return timestamp_param(datetime.now(timezone.utc) - PROCESANDO_MAXIMO)


def _stored_response(event_id: str, payload_hash: str) -> dict | None:
    """Respuesta ya completada del mismo evento, o None si puede procesarse (nuevo o reintento)."""
    with conexion() as connection:
        existing = connection.execute(
            "SELECT payload_hash, respuesta_json, estado, "
            "(estado = 'PROCESANDO' AND creado_en < ?) AS abandonado FROM ingresos WHERE evento_id = ?",
            (_stale_before(), event_id),
        ).fetchone()
    if not existing:
        return None
    if existing["payload_hash"] != payload_hash:
        raise HTTPException(status_code=409, detail="El identificador del evento ya se usó con otros datos.")
    if existing["estado"] == "COMPLETADO" and existing["respuesta_json"]:
        return json.loads(existing["respuesta_json"])
    if existing["estado"] == "ERROR" or existing["abandonado"]:
        return None  # Reintento: el mismo evento falló o quedó interrumpido.
    raise HTTPException(status_code=409, detail="Este evento ya está en proceso. Espera unos segundos y consulta la actividad.")


def _reserve_event(event: EventoIngreso, payload_hash: str) -> bool:
    with conexion() as connection:
        # Solo reserva un evento nuevo, o reintenta uno idéntico que falló o quedó interrumpido.
        cursor = connection.execute(
            "INSERT INTO ingresos (evento_id, cedula, hospital, motivo, payload_hash, estado) "
            "VALUES (?, ?, ?, ?, ?, 'PROCESANDO') ON CONFLICT(evento_id) DO UPDATE SET "
            "estado = 'PROCESANDO', creado_en = CURRENT_TIMESTAMP "
            "WHERE ingresos.payload_hash = excluded.payload_hash "
            "AND (ingresos.estado = 'ERROR' OR (ingresos.estado = 'PROCESANDO' AND ingresos.creado_en < ?))",
            (event.evento_id, event.cedula, event.hospital, event.motivo_ingreso, payload_hash, _stale_before()),
        )
        return cursor.rowcount == 1


async def _submit_event(event: EventoIngreso, actor_id: str, ai_user_id: str | None = None, integration_id: str | None = None) -> RespuestaIngreso:
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
        response = await _process_event(event, ai_user_id, integration_id)
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
                if not conditions:
                    history_state = "not_found"
            except (ValueError, KeyError, TypeError):
                history_state = "invalid_response"
                connectors.set_integration_status("history", history_state, "La respuesta no coincide con el mapeo de antecedentes.")
        statuses.append(_source("history", history_state, True))
    else:
        statuses.append(_source("history", "not_configured", False))
    return policy_result, conditions, statuses, policy_state, history_state


async def _process_event(event: EventoIngreso, ai_user_id: str | None = None, integration_id: str | None = None) -> RespuestaIngreso:
    if database_mode() == "demo":
        policy, conditions = _demo_records(event)
        sources = [_source("coverage", "connected", True), _source("history", "connected", True)]
        policy_state = "connected" if policy else "not_found"
        history_state = "connected"
    else:
        policy, conditions, sources, policy_state, history_state = await _production_records(event)

    if integration_id:
        ai_user_id = ai_assignments.integration_owner(integration_id)
    relations = await agent.relacionar_preexistencias(event, conditions, ai_user_id=ai_user_id, personal=True) if conditions else []
    for relation in relations:
        # Conserva la etiqueta que propuso el modelo; los fallos no proponen ninguna.
        if relation.relacion_sugerida is None and not relation.justificacion.startswith("Revisión humana pendiente:"):
            relation.relacion_sugerida = relation.relacion

    verdict, level = rules.decidir_con_fuentes(policy, relations, sources, database_mode())

    messages = await agent.redactar_mensajes(event, None, policy, verdict, level, relations)
    review_pending = any(rules.pendiente(item) for item in relations)
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
        actor_id = _demo_caller(request)
        try:
            event = EventoIngreso.model_validate(payload)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="El ingreso no cumple el contrato de Vigilia.") from exc
        # En demo no hay integraciones: la cuenta dueña de la IA de demostración clasifica el ingreso.
        return await _submit_event(event, actor_id, ai_user_id=provisioning.demo_ai_owner())

    return await _submit_event(event, integration["id"], integration_id=integration["integration_id"])


def _demo_caller(request: Request) -> str:
    """El simulador llega con la sesión del navegador; los sistemas externos, con X-Vigilia-Key."""
    if request.session.get("user_id") and request.headers.get("x-csrf-token"):
        try:
            profile = security.require_permission(request, "ingress.submit")
            security.require_csrf(request, request.headers.get("x-csrf-token"))
            return profile["id"]
        except HTTPException:
            pass
    _demo_key(request)
    return "demo"


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
    return await _submit_event(event, profile["id"], ai_user_id=profile["id"])


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
async def review_classification(event_id: str, classification_index: int, body: connectors.ReviewInput,
                                request: Request, x_csrf_token: str | None = None):
    result = connectors.review_classification(event_id, classification_index, body, request,
                                              request.headers.get("x-csrf-token") or x_csrf_token)
    update = await _refresh_after_review(event_id, result["reviewer_id"])
    stored = _stored_outcome(event_id)
    return {**result, **stored, "resultado_actualizado": update is not None}


def _stored_outcome(event_id: str) -> dict:
    with conexion() as connection:
        row = connection.execute("SELECT veredicto, nivel_alerta FROM ingresos WHERE evento_id = ?", (event_id,)).fetchone()
    return {"veredicto": row["veredicto"], "nivel_alerta": row["nivel_alerta"]} if row else {}


async def _refresh_after_review(event_id: str, reviewer_id: str) -> ActualizacionRevision | None:
    """Recalcula el resultado con la clasificación revisada y, si cambió, avisa de nuevo a ambos destinos."""
    with conexion() as connection:
        row = connection.execute(
            "SELECT respuesta_json, cedula, hospital, motivo FROM ingresos WHERE evento_id = ?", (event_id,)
        ).fetchone()
    if not row or not row["respuesta_json"]:
        return None
    response = RespuestaIngreso.model_validate(json.loads(row["respuesta_json"]))
    verdict, level = rules.decidir_con_fuentes(response.poliza, response.preexistencias, response.fuentes, database_mode())
    if (verdict, level) == (response.veredicto, response.nivel_alerta):
        return None

    event = EventoIngreso(evento_id=event_id, cedula=row["cedula"] or "", hospital=row["hospital"] or "",
                          motivo_ingreso=row["motivo"] or "sin motivo", fecha_ingreso=datetime.now(timezone.utc))
    messages = await agent.redactar_mensajes(event, None, response.poliza, verdict, level, response.preexistencias)
    prefix = "Actualización tras revisión humana: "
    notifications = await notificar_en_paralelo(
        prefix + messages.admisiones,
        prefix + messages.gestor,
        event_id=event_id,
        verdict=verdict,
        level=level,
        review_pending=any(rules.pendiente(item) for item in response.preexistencias),
    )
    update = ActualizacionRevision(
        en=datetime.now(timezone.utc), revisor_id=reviewer_id,
        veredicto_anterior=response.veredicto, nivel_anterior=response.nivel_alerta,
        veredicto=verdict, nivel_alerta=level,
        mensaje_admisiones=prefix + messages.admisiones, mensaje_gestor=prefix + messages.gestor,
        notificaciones=notifications,
    )
    with conexion() as connection:
        # Relee dentro de la transacción para no pisar una revisión concurrente de otro antecedente.
        current = connection.execute("SELECT respuesta_json FROM ingresos WHERE evento_id = ?", (event_id,)).fetchone()
        stored = json.loads(current["respuesta_json"])
        stored.update(veredicto=verdict, nivel_alerta=level)
        stored["actualizaciones"] = [*stored.get("actualizaciones", []), json.loads(update.model_dump_json())]
        connection.execute(
            "UPDATE ingresos SET veredicto = ?, nivel_alerta = ?, respuesta_json = ? WHERE evento_id = ?",
            (verdict, level, json.dumps(stored, ensure_ascii=False), event_id),
        )
    record(reviewer_id, "ingress.outcome.update", "ingress", event_id, {
        "previous_verdict": response.veredicto, "previous_level": response.nivel_alerta,
        "verdict": verdict, "level": level,
        "notifications": [item.estado for item in notifications],
    })
    return update
