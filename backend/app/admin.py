"""Administrative user profiles and audit endpoints."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import db, security
from .audit import recent, record

router = APIRouter(prefix="/admin", tags=["administration"])
VALID_ROLES = set(security.ROLE_PERMISSIONS)


class UserInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=254)
    display_name: str = Field(min_length=1, max_length=160)
    roles: list[str] = Field(default_factory=list, max_length=4)
    permissions: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        value = value.strip().casefold()
        if "@" not in value or value.startswith("@") or value.endswith("@"):
            raise ValueError("Ingresa un correo válido del directorio del cliente.")
        return value

    @field_validator("roles")
    @classmethod
    def valid_roles(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value) or set(value) - VALID_ROLES:
            raise ValueError("Selecciona roles del catálogo de Vigilia.")
        return value

    @field_validator("permissions")
    @classmethod
    def valid_permissions(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value) or set(value) - set(security.PERMISSION_CATALOG):
            raise ValueError("Selecciona permisos del catálogo de Vigilia.")
        return value


def _user_json(row) -> dict:
    roles = json.loads(row["roles_json"] or "[]")
    overrides = json.loads(row["permissions_json"] or "[]")
    return {
        "id": row["id"], "email": row["email"], "display_name": row["display_name"],
        "active": bool(row["active"]), "roles": roles, "permissions": overrides,
        "effective_permissions": security.permissions_for(roles, overrides),
        "identity_linked": bool(row["subject"]), "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def _active_user_managers(connection) -> int:
    rows = connection.execute("SELECT permissions_json FROM user_profiles WHERE active = TRUE").fetchall()
    return sum("users.manage" in json.loads(row["permissions_json"] or "[]") for row in rows)


@router.get("/users")
def list_users(request: Request):
    actor = security.require_permission(request, "users.manage")
    with db.conexion() as connection:
        rows = connection.execute(
            "SELECT * FROM user_profiles ORDER BY active DESC, lower(display_name), lower(email)"
        ).fetchall()
    if actor["issuer"] == "demo":
        record(actor["id"], "user.list", "user", None)
        return [{"id": "demo-admin", "email": "demo@vigilia.local", "display_name": "Administrador de demostración",
                 "active": True, "roles": ["administrador"], "permissions": [],
                 "effective_permissions": sorted(security.PERMISSION_CATALOG), "identity_linked": True,
                 "created_at": "", "updated_at": ""}]
    record(actor["id"], "user.list", "user", None, {"count": len(rows)})
    return [_user_json(row) for row in rows]


@router.post("/users")
def create_user(body: UserInput, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "users.manage")
    security.require_csrf(request, x_csrf_token)
    if not security.oidc_issuer():
        raise HTTPException(status_code=503, detail="Configura OIDC antes de crear perfiles de usuario.")
    now = datetime.now(timezone.utc)
    user_id = str(uuid.uuid4())
    permissions = security.permissions_for(body.roles, body.permissions)
    try:
        with db.conexion() as connection:
            connection.execute(
                "INSERT INTO user_profiles (id, issuer, subject, email, display_name, active, roles_json, permissions_json, created_at, updated_at, created_by) "
                "VALUES (?, ?, NULL, ?, ?, TRUE, ?, ?, ?, ?, ?)",
                (user_id, security.oidc_issuer(), body.email, body.display_name.strip(), json.dumps(body.roles),
                 json.dumps(permissions), now, now, actor["id"]),
            )
    except Exception as exc:
        if "unique" in str(exc).casefold() or "duplicate" in str(exc).casefold():
            raise HTTPException(status_code=409, detail="Ya existe un perfil para ese correo.") from exc
        raise
    record(actor["id"], "user.create", "user", user_id, {"roles": body.roles, "permissions": permissions})
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
    return _user_json(row)


@router.put("/users/{user_id}")
def update_user(user_id: str, body: UserInput, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "users.manage")
    security.require_csrf(request, x_csrf_token)
    now = datetime.now(timezone.utc)
    permissions = security.permissions_for(body.roles, body.permissions)
    with db.conexion() as connection:
        existing = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="No se encontró el perfil.")
        if body.email != existing["email"] and existing["subject"]:
            raise HTTPException(status_code=409, detail="No se puede cambiar el correo de una identidad OIDC vinculada.")
        connection.execute(
            "UPDATE user_profiles SET email = ?, display_name = ?, roles_json = ?, permissions_json = ?, updated_at = ? WHERE id = ?",
            (body.email, body.display_name.strip(), json.dumps(body.roles), json.dumps(permissions), now, user_id),
        )
        if _active_user_managers(connection) == 0:
            connection.rollback()
            raise HTTPException(status_code=409, detail="Debe quedar al menos una persona activa con permiso para administrar usuarios.")
        row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
    record(actor["id"], "user.update", "user", user_id, {"roles": body.roles, "permissions": permissions})
    return _user_json(row)


@router.delete("/users/{user_id}")
def deactivate_user(user_id: str, request: Request, x_csrf_token: str | None = Header(default=None)):
    actor = security.require_permission(request, "users.manage")
    security.require_csrf(request, x_csrf_token)
    if user_id == actor["id"]:
        raise HTTPException(status_code=409, detail="No puedes desactivar tu propia cuenta.")
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No se encontró el perfil.")
        connection.execute("UPDATE user_profiles SET active = FALSE, updated_at = ? WHERE id = ?", (now, user_id))
        if _active_user_managers(connection) == 0:
            connection.rollback()
            raise HTTPException(status_code=409, detail="Debe quedar al menos una persona activa con permiso para administrar usuarios.")
    record(actor["id"], "user.deactivate", "user", user_id)
    return {"ok": True, "active": False}


@router.get("/permissions")
def list_permissions(request: Request):
    actor = security.require_permission(request, "users.manage")
    record(actor["id"], "permissions.catalog.read", "permission_catalog", None)
    return {"roles": {key: sorted(value) for key, value in security.ROLE_PERMISSIONS.items()},
            "permissions": security.PERMISSION_CATALOG}


@router.get("/audit")
def list_audit(request: Request, limit: int = 100):
    actor = security.require_permission(request, "audit.read")
    record(actor["id"], "audit.read", "audit", None, {"limit": max(1, min(limit, 500))})
    return recent(limit)
