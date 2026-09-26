"""An integration may use a personal account only after its owner accepts a nomination."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from . import db, security
from .audit import record

router = APIRouter(tags=["AI account assignments"])


class Nomination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str | None = None
    revision: str | None = None


class Consent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accept: bool
    revision: str


def _csrf(request):
    security.require_csrf(request, request.headers.get("x-csrf-token"))


def _ensure_mutable(integration_id: str) -> None:
    from .provisioning import ensure_mutable_integration  # import local: evita un ciclo
    ensure_mutable_integration(integration_id)


def integration_owner(integration_id: str) -> str | None:
    with db.conexion() as conn:
        row = conn.execute(
            "SELECT a.user_id FROM ai_integration_assignments a JOIN user_profiles u ON u.id=a.user_id "
            "JOIN integration_configs i ON i.id=a.integration_id "
            "WHERE a.integration_id=? AND a.status='accepted' AND u.active=TRUE AND i.enabled=TRUE AND i.kind='ingress'",
            (integration_id,),
        ).fetchone()
    return row["user_id"] if row else None


@router.get("/me/ai/assignments")
def personal(request: Request):
    actor = security.current_profile(request)
    with db.conexion() as conn:
        rows = conn.execute(
            "SELECT a.integration_id, i.name, a.status, a.revision FROM ai_integration_assignments a "
            "JOIN integration_configs i ON i.id=a.integration_id WHERE a.user_id=? ORDER BY i.name", (actor["id"],)
        ).fetchall()
    return {"assignments": rows}


@router.put("/me/ai/assignments/{integration_id}")
def consent(integration_id: str, body: Consent, request: Request):
    actor = security.current_profile(request)
    _csrf(request)
    _ensure_mutable(integration_id)
    status = "accepted" if body.accept else "revoked"
    revision = str(uuid.uuid4())
    with db.conexion() as conn:
        if body.accept:
            config = conn.execute(
                "SELECT c.status FROM user_ai_configs c JOIN user_ai_selection s "
                "ON s.user_id=c.user_id AND s.provider=c.provider WHERE s.user_id=?", (actor["id"],)
            ).fetchone()
            if not config or config["status"] != "verified":
                raise HTTPException(409, "Configura, prueba y activa tu proveedor antes de autorizar una integración.")
        changed = conn.execute(
            "UPDATE ai_integration_assignments SET status=?,revision=?,updated_at=? "
            "WHERE integration_id=? AND user_id=? AND revision=? AND status IN ('pending','accepted','revoked')",
            (status, revision, datetime.now(timezone.utc).isoformat(), integration_id, actor["id"], body.revision),
        )
        if changed.rowcount != 1:
            raise HTTPException(409, "La asignación cambió o no pertenece a tu cuenta.")
    record(actor["id"], "ai.assignment." + status, "integration", integration_id)
    return {"status": status, "revision": revision}


@router.get("/admin/ai/assignments")
def assignments(request: Request):
    security.require_permission(request, "integrations.manage")
    with db.conexion() as conn:
        integrations = conn.execute(
            "SELECT i.id,i.name,a.user_id,a.status,a.revision FROM integration_configs i "
            "LEFT JOIN ai_integration_assignments a ON a.integration_id=i.id WHERE i.kind='ingress' ORDER BY i.name"
        ).fetchall()
        users = conn.execute("SELECT id,display_name FROM user_profiles WHERE active=TRUE ORDER BY display_name").fetchall()
    return {"integrations": integrations, "users": users}


@router.put("/admin/ai/assignments/{integration_id}")
def nominate(integration_id: str, body: Nomination, request: Request):
    actor = security.require_permission(request, "integrations.manage")
    _csrf(request)
    _ensure_mutable(integration_id)
    revision = str(uuid.uuid4())
    with db.conexion() as conn:
        integration = conn.execute("SELECT kind FROM integration_configs WHERE id=?", (integration_id,)).fetchone()
        if not integration or integration["kind"] != "ingress":
            raise HTTPException(404, "No se encontró la integración de ingreso.")
        old = conn.execute("SELECT * FROM ai_integration_assignments WHERE integration_id=?", (integration_id,)).fetchone()
        if (old["revision"] if old else None) != body.revision:
            raise HTTPException(409, "La asignación cambió. Actualiza antes de continuar.")
        if body.user_id is None:
            if old:
                result = conn.execute("UPDATE ai_integration_assignments SET status='withdrawn',revision=? WHERE integration_id=? AND revision=?",
                                      (revision, integration_id, body.revision))
                if result.rowcount != 1:
                    raise HTTPException(409, "La asignación cambió.")
        else:
            owner = conn.execute("SELECT active FROM user_profiles WHERE id=?", (body.user_id,)).fetchone()
            if not owner or not owner["active"]:
                raise HTTPException(422, "Selecciona una cuenta activa.")
            now = datetime.now(timezone.utc).isoformat()
            if old:
                result = conn.execute(
                    "UPDATE ai_integration_assignments SET user_id=?,status='pending',revision=?,proposed_by=?,updated_at=? "
                    "WHERE integration_id=? AND revision=?",
                    (body.user_id, revision, actor["id"], now, integration_id, body.revision),
                )
            else:
                result = conn.execute(
                    "INSERT INTO ai_integration_assignments (integration_id,user_id,status,revision,proposed_by,updated_at) "
                    "VALUES (?,?,'pending',?,?,?) ON CONFLICT(integration_id) DO NOTHING",
                    (integration_id, body.user_id, revision, actor["id"], now),
                )
            if result.rowcount != 1:
                raise HTTPException(409, "La asignación cambió.")
    record(actor["id"], "ai.assignment.nominate" if body.user_id else "ai.assignment.revoke", "integration", integration_id,
           {"owner_id": body.user_id})
    return {"revision": revision, "status": "pending" if body.user_id else "withdrawn"}
