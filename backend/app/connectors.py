"""Client-configured REST connectors and strict field mapping into Vigilia contracts."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import db, security
from .audit import record
from .secret_store import decrypt, encrypt

router = APIRouter(prefix="/admin/integrations", tags=["integrations"])
SUPPORTED_KINDS = {"ingress", "coverage", "history", "admissions", "case_manager"}
CANONICAL_FIELDS = {
    "ingress": {"evento_id", "cedula", "hospital", "motivo_ingreso", "triage", "fecha_ingreso"},
    "coverage": {"cedula", "numero", "plan", "vigente_desde", "vigente_hasta", "estado_pago", "carencia_dias"},
    "history": {"items", "condition", "date"},
    "admissions": set(),
    "case_manager": set(),
}


class IntegrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    name: str = Field(min_length=1, max_length=100)
    endpoint_url: str = Field(min_length=1, max_length=500)
    method: str = "GET"
    lookup_parameter: str = Field(default="cedula", min_length=1, max_length=80)
    field_map: dict[str, str] = Field(default_factory=dict)
    enabled: bool = False
    secret: str | None = Field(default=None, max_length=4096)

    @field_validator("kind")
    @classmethod
    def valid_kind(cls, value: str) -> str:
        if value not in SUPPORTED_KINDS:
            raise ValueError("Tipo de integración no compatible.")
        return value

    @field_validator("method")
    @classmethod
    def valid_method(cls, value: str) -> str:
        normalized = value.upper()
        if normalized not in {"GET", "POST"}:
            raise ValueError("Solo se permite GET o POST.")
        return normalized

    @field_validator("endpoint_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("Configura una URL HTTPS sin credenciales, parámetros ni fragmento.")
        return value.rstrip("/")

    @field_validator("field_map")
    @classmethod
    def valid_mapping(cls, value: dict[str, str]) -> dict[str, str]:
        for target, source in value.items():
            if target in {"__proto__", "constructor", "prototype"} or not isinstance(source, str):
                raise ValueError("El mapeo contiene una ruta inválida.")
            path = source.removeprefix("$.")
            if not path or any(part in {"__proto__", "constructor", "prototype"} for part in path.split(".")):
                raise ValueError("El mapeo debe usar rutas JSON seguras.")
        return value


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relation: str
    reason: str = Field(min_length=3, max_length=1000)

    @field_validator("relation")
    @classmethod
    def valid_relation(cls, value: str) -> str:
        if value not in {"DIRECTA", "POSIBLE", "NINGUNA"}:
            raise ValueError("La resolución debe ser DIRECTA, POSIBLE o NINGUNA.")
        return value


def _mapping_is_valid(kind: str, mapping: dict[str, str]) -> None:
    if set(mapping) - CANONICAL_FIELDS[kind]:
        raise HTTPException(status_code=422, detail="El mapeo contiene campos que Vigilia no reconoce.")
    if kind == "ingress":
        required = {"evento_id", "cedula", "hospital", "motivo_ingreso", "fecha_ingreso"}
        if not required.issubset(mapping):
            raise HTTPException(status_code=422, detail="El mapeo del ingreso debe incluir todos los campos obligatorios.")
    if kind == "coverage" and not {"numero", "plan", "vigente_desde", "vigente_hasta", "estado_pago", "carencia_dias"}.issubset(mapping):
        raise HTTPException(status_code=422, detail="El mapeo de cobertura requiere número, plan, fechas, estado de pago y días de carencia.")
    if kind == "history" and not {"items", "condition"}.issubset(mapping):
        raise HTTPException(status_code=422, detail="El mapeo de antecedentes requiere la lista y el campo condición.")


def _safe_config(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "endpoint_url": row["endpoint_url"],
        "method": row["method"],
        "lookup_parameter": row["lookup_parameter"],
        "field_map": json.loads(row["field_map_json"] or "{}"),
        "enabled": bool(row["enabled"]),
        "has_secret": bool(row["encrypted_secret"]),
        "status": row["status"],
        "last_checked_at": row["last_checked_at"],
        "last_error": row["last_error"],
        "updated_at": row["updated_at"],
    }


def get_integration(kind: str) -> dict[str, Any] | None:
    with db.conexion() as connection:
        row = connection.execute(
            "SELECT * FROM integration_configs WHERE kind = ? AND enabled = TRUE ORDER BY updated_at DESC LIMIT 1",
            (kind,),
        ).fetchone()
    return dict(row) if row else None


def integration_statuses() -> list[dict[str, Any]]:
    with db.conexion() as connection:
        rows = connection.execute(
            "SELECT id, kind, name, enabled, status, last_checked_at, last_error "
            "FROM integration_configs ORDER BY kind, name"
        ).fetchall()
    by_kind = {kind: {"kind": kind, "status": "not_configured", "last_checked_at": None, "last_error": None} for kind in SUPPORTED_KINDS}
    for row in rows:
        current = by_kind[row["kind"]]
        if row["enabled"]:
            current.update(status=row["status"], last_checked_at=row["last_checked_at"], last_error=row["last_error"])
    return list(by_kind.values())


def _secret_headers(config: dict[str, Any]) -> dict[str, str]:
    secret = decrypt(config.get("encrypted_secret"))
    return {"Authorization": f"Bearer {secret}"} if secret else {}


def set_integration_status(kind: str, status: str, error: str | None = None) -> None:
    """Persist a safe status category without storing remote response bodies."""
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        connection.execute(
            "UPDATE integration_configs SET status = ?, last_checked_at = ?, last_error = ? "
            "WHERE kind = ? AND enabled = TRUE",
            (status, now, error, kind),
        )


def extract_path(data: Any, path: str) -> Any:
    current = data
    parts = path.removeprefix("$").lstrip(".").split(".") if path else []
    for part in parts:
        if part == "*":
            return current if isinstance(current, list) else None
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if index < len(current) else None
        else:
            return None
    return current


def map_ingress(payload: dict[str, Any], config: dict[str, Any]):
    from .schemas import EventoIngreso

    mapping = json.loads(config["field_map_json"] or "{}")
    normalized = {target: extract_path(payload, source) for target, source in mapping.items()}
    return EventoIngreso.model_validate(normalized)


async def lookup(kind: str, value: str) -> tuple[Any, str]:
    config = get_integration(kind)
    if not config:
        return None, "not_configured"
    url = config["endpoint_url"]
    parameters = {config["lookup_parameter"]: value}
    try:
        kwargs = {"headers": _secret_headers(config)}
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            if config["method"] == "POST":
                response = await client.post(url, json=parameters, **kwargs)
            else:
                response = await client.get(url, params=parameters, **kwargs)
        if response.status_code == 404:
            # A 404 can mean a broken endpoint. Record absence only from a valid
            # endpoint response (for example JSON null), never from HTTP routing.
            set_integration_status(kind, "unavailable", "El endpoint respondió HTTP 404.")
            return None, "unavailable"
        response.raise_for_status()
        if len(response.content) > 1_000_000:
            set_integration_status(kind, "invalid_response", "La respuesta supera el tamaño permitido.")
            return None, "invalid_response"
        try:
            payload = response.json()
        except ValueError:
            set_integration_status(kind, "invalid_response", "La fuente no devolvió JSON válido.")
            return None, "invalid_response"
        set_integration_status(kind, "connected")
        return payload, "connected"
    except httpx.HTTPStatusError:
        set_integration_status(kind, "unavailable", "La fuente no pudo completar la consulta.")
        return None, "unavailable"
    except (httpx.HTTPError, RuntimeError):
        set_integration_status(kind, "unavailable", "No se pudo conectar con la fuente.")
        return None, "unavailable"


def map_coverage(payload: Any, config: dict[str, Any]) -> dict[str, Any] | None:
    if payload is None:
        return None
    mapping = json.loads(config["field_map_json"] or "{}")
    normalized = {target: extract_path(payload, source) for target, source in mapping.items()}
    if not normalized or any(value is None for value in normalized.values()):
        raise ValueError("La respuesta de cobertura no coincide con el mapeo configurado.")
    from datetime import date

    if not isinstance(normalized.get("numero"), str) or not normalized["numero"].strip() or not isinstance(normalized.get("plan"), str) or not normalized["plan"].strip():
        raise ValueError("La respuesta de cobertura contiene campos de texto inválidos.")
    if normalized.get("estado_pago") not in {"AL_DIA", "MOROSO"}:
        raise ValueError("El estado de pago no usa el contrato canónico de Vigilia.")
    dates = []
    for key in ("vigente_desde", "vigente_hasta"):
        if not isinstance(normalized.get(key), str):
            raise ValueError("Las fechas de vigencia deben usar texto ISO.")
        dates.append(date.fromisoformat(normalized[key]))
    if dates[0] > dates[1]:
        raise ValueError("El rango de vigencia de la póliza está invertido.")
    waiting_days = normalized.get("carencia_dias")
    if isinstance(waiting_days, bool) or not isinstance(waiting_days, int) or waiting_days < 0:
        raise ValueError("Los días de carencia deben ser un entero no negativo.")
    return normalized


def map_history(payload: Any, config: dict[str, Any]) -> list[dict[str, Any]]:
    if payload is None:
        return []
    mapping = json.loads(config["field_map_json"] or "{}")
    entries = extract_path(payload, mapping["items"])
    if not isinstance(entries, list):
        raise ValueError("La respuesta de antecedentes no contiene la lista configurada.")
    if len(entries) > 50:
        raise ValueError("La respuesta supera el máximo de 50 antecedentes por consulta.")
    results = []
    for entry in entries:
        condition = extract_path(entry, mapping["condition"])
        if not isinstance(condition, str) or not condition.strip():
            raise ValueError("Un antecedente no contiene el campo condición configurado.")
        results.append({"condicion": condition[:200], "fecha_diagnostico": extract_path(entry, mapping.get("date", ""))})
    return results


def public_status() -> dict[str, Any]:
    from .db import database_mode

    return {"mode": database_mode(), "api": "connected", "integrations": integration_statuses()}


@router.get("")
def list_integrations(request: Request):
    actor = security.require_permission(request, "integrations.manage")
    with db.conexion() as connection:
        rows = connection.execute("SELECT * FROM integration_configs ORDER BY kind, name").fetchall()
    record(actor["id"], "integration.list", "integration", None, {"count": len(rows)})
    return [_safe_config(row) for row in rows]


@router.get("/status")
def list_integration_statuses(request: Request):
    actor = security.require_permission(request, "integrations.manage")
    record(actor["id"], "integration.status.read", "integration", None)
    return integration_statuses()


@router.post("")
def create_integration(body: IntegrationInput, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    _mapping_is_valid(body.kind, body.field_map)
    import uuid

    config_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    encrypted = encrypt(body.secret or "")
    with db.conexion() as connection:
        connection.execute(
            "INSERT INTO integration_configs "
            "(id, kind, name, endpoint_url, method, lookup_parameter, field_map_json, enabled, encrypted_secret, status, updated_at, updated_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (config_id, body.kind, body.name.strip(), body.endpoint_url, body.method, body.lookup_parameter,
             json.dumps(body.field_map, sort_keys=True), body.enabled, encrypted or None,
             "pending" if body.enabled else "not_configured", now, actor["id"]),
        )
    record(actor["id"], "integration.create", "integration", config_id, {"kind": body.kind})
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM integration_configs WHERE id = ?", (config_id,)).fetchone()
    return _safe_config(row)


@router.put("/{integration_id}")
def update_integration(integration_id: str, body: IntegrationInput, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    _mapping_is_valid(body.kind, body.field_map)
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        existing = connection.execute("SELECT * FROM integration_configs WHERE id = ?", (integration_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="No se encontró la integración.")
        encrypted = encrypt(body.secret) if body.secret else existing["encrypted_secret"]
        connection.execute(
            "UPDATE integration_configs SET kind = ?, name = ?, endpoint_url = ?, method = ?, lookup_parameter = ?, "
            "field_map_json = ?, enabled = ?, encrypted_secret = ?, status = ?, last_error = NULL, updated_at = ?, updated_by = ? "
            "WHERE id = ?",
            (body.kind, body.name.strip(), body.endpoint_url, body.method, body.lookup_parameter,
             json.dumps(body.field_map, sort_keys=True), body.enabled, encrypted,
             "pending" if body.enabled else "not_configured", now, actor["id"], integration_id),
        )
    record(actor["id"], "integration.update", "integration", integration_id, {"kind": body.kind})
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM integration_configs WHERE id = ?", (integration_id,)).fetchone()
    return _safe_config(row)


@router.delete("/{integration_id}")
def disable_integration(integration_id: str, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    with db.conexion() as connection:
        cursor = connection.execute(
            "UPDATE integration_configs SET enabled = FALSE, status = 'not_configured', updated_at = ?, updated_by = ? WHERE id = ?",
            (datetime.now(timezone.utc), actor["id"], integration_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="No se encontró la integración.")
    record(actor["id"], "integration.disable", "integration", integration_id)
    return {"ok": True}


@router.post("/{integration_id}/test")
async def test_integration(integration_id: str, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    with db.conexion() as connection:
        config = connection.execute("SELECT * FROM integration_configs WHERE id = ?", (integration_id,)).fetchone()
    if not config:
        raise HTTPException(status_code=404, detail="No se encontró la integración.")
    status, message = "connected", None
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            headers = _secret_headers(dict(config))
            if config["method"] == "POST":
                response = await client.post(config["endpoint_url"], json={config["lookup_parameter"]: "VIGILIA_TEST"}, headers=headers)
            else:
                response = await client.get(config["endpoint_url"], params={config["lookup_parameter"]: "VIGILIA_TEST"}, headers=headers)
        if response.status_code >= 400:
            status, message = "unavailable", f"El sistema respondió HTTP {response.status_code}."
    except (httpx.HTTPError, RuntimeError) as exc:
        status, message = "unavailable", f"No se pudo conectar ({type(exc).__name__})."
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        connection.execute(
            "UPDATE integration_configs SET status = ?, last_checked_at = ?, last_error = ? WHERE id = ?",
            (status, now, message, integration_id),
        )
    record(actor["id"], "integration.test", "integration", integration_id, {"status": status})
    return {"status": status, "last_checked_at": now, "message": message}


@router.post("/{integration_id}/credentials")
def issue_credential(integration_id: str, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    config = get_integration_by_id(integration_id)
    if not config:
        raise HTTPException(status_code=404, detail="No se encontró la integración.")
    if config["kind"] != "ingress":
        raise HTTPException(status_code=400, detail="Las credenciales de entrada solo aplican a integraciones de ingreso.")
    token, digest = security.new_integration_credential()
    now = datetime.now(timezone.utc)
    credential_id = __import__("uuid").uuid4().hex
    with db.conexion() as connection:
        connection.execute(
            "UPDATE api_credentials SET active = FALSE, revoked_at = ? WHERE integration_id = ? AND active = TRUE",
            (now, integration_id),
        )
        connection.execute(
            "INSERT INTO api_credentials (id, integration_id, secret_hash, active, created_at) VALUES (?, ?, ?, TRUE, ?)",
            (credential_id, integration_id, digest, now),
        )
    record(actor["id"], "integration.credential.issue", "integration", integration_id)
    return {"id": credential_id, "token": token, "shown_once": True}


@router.get("/{integration_id}/credentials")
def list_credentials(integration_id: str, request: Request):
    actor = security.require_permission(request, "integrations.manage")
    if not get_integration_by_id(integration_id):
        raise HTTPException(status_code=404, detail="No se encontró la integración.")
    with db.conexion() as connection:
        rows = connection.execute(
            "SELECT id, active, created_at, revoked_at FROM api_credentials "
            "WHERE integration_id = ? ORDER BY created_at DESC LIMIT 20",
            (integration_id,),
        ).fetchall()
    record(actor["id"], "integration.credential.list", "integration", integration_id, {"count": len(rows)})
    return [dict(row) for row in rows]


@router.delete("/{integration_id}/credentials/{credential_id}")
def revoke_credential(integration_id: str, credential_id: str, request: Request,
                      x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "integrations.manage")
    security.require_csrf(request, x_csrf_token)
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        cursor = connection.execute(
            "UPDATE api_credentials SET active = FALSE, revoked_at = ? WHERE id = ? AND integration_id = ? AND active = TRUE",
            (now, credential_id, integration_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="No se encontró una credencial activa.")
    record(actor["id"], "integration.credential.revoke", "integration", integration_id)
    return {"ok": True}


def get_integration_by_id(integration_id: str) -> dict[str, Any] | None:
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM integration_configs WHERE id = ?", (integration_id,)).fetchone()
    return dict(row) if row else None


def review_classification(event_id: str, index: int, body: ReviewInput, request: Request, x_csrf_token: str | None) -> dict[str, Any]:
    actor = security.require_permission(request, "classification.review")
    security.require_csrf(request, x_csrf_token)
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        event = connection.execute("SELECT respuesta_json FROM ingresos WHERE evento_id = ?", (event_id,)).fetchone()
        if not event or not event["respuesta_json"]:
            raise HTTPException(status_code=404, detail="No se encontró el ingreso.")
        result = json.loads(event["respuesta_json"])
        classifications = result.get("preexistencias", [])
        if index < 0 or index >= len(classifications):
            raise HTTPException(status_code=404, detail="No se encontró la clasificación.")
        existing_review = connection.execute(
            "SELECT original_relation FROM review_actions WHERE event_id = ? AND classification_index = ?",
            (event_id, index),
        ).fetchone()
        existing_suggestion = classifications[index].get("relacion_sugerida")
        raw_original = (existing_review["original_relation"] if existing_review else None) or existing_suggestion
        original = raw_original or ("PENDIENTE" if "pendiente" in classifications[index].get("justificacion", "").casefold() else classifications[index].get("relacion", "POSIBLE"))
        connection.execute(
            "INSERT INTO review_actions (id, event_id, classification_index, original_relation, reviewed_relation, reason, reviewer_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, classification_index) DO UPDATE SET "
            "reviewed_relation = excluded.reviewed_relation, "
            "reason = excluded.reason, reviewer_id = excluded.reviewer_id, created_at = excluded.created_at",
            (str(__import__("uuid").uuid4()), event_id, index, original, body.relation, body.reason.strip(), actor["id"], now),
        )
        classifications[index]["relacion_sugerida"] = original if original in {"DIRECTA", "POSIBLE", "NINGUNA"} else None
        classifications[index]["relacion"] = body.relation
        classifications[index]["justificacion"] = f"Revisión humana: {body.reason.strip()}"
        classifications[index]["revisada"] = True
        classifications[index]["motivo_revision"] = body.reason.strip()
        classifications[index]["revisor_id"] = actor["id"]
        classifications[index]["revisada_en"] = now
        connection.execute(
            "UPDATE ingresos SET respuesta_json = ? WHERE evento_id = ?",
            (json.dumps(result, ensure_ascii=False), event_id),
        )
    record(actor["id"], "classification.review", "ingress", event_id,
           {"index": index, "suggested_relation": original, "reviewed_relation": body.relation})
    return {"event_id": event_id, "classification_index": index, "suggested_relation": original if original in {"DIRECTA", "POSIBLE", "NINGUNA"} else None,
            "reviewed_relation": body.relation, "reason": body.reason.strip(), "reviewer_id": actor["id"], "reviewed_at": now}
