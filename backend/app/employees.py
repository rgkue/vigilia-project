"""Local account directory (reception and administrative roles) and RFC 6238 credentials.

Badge QR codes contain identifiers only. Accounts with administrative permissions also need a
password (see local_accounts), issued as a one-time temporary password by an administrator.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import db, local_accounts, security
from .audit import record

router = APIRouter(prefix="/admin/employees", tags=["employees"])
DEMO_EMPLOYEE_ID = "EMP-REC-001"
# Public fixture, never provisioned in production.
DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXP"
RECEPTION_ROLES = ["recepcionista"]
RECEPTION_PERMISSIONS = sorted(security.ROLE_PERMISSIONS["recepcionista"])


def cipher() -> Fernet:
    key = (os.getenv("VIGILIA_SECRET_ENCRYPTION_KEY") or "").strip()
    if key:
        return Fernet(key.encode())
    if db.database_mode() != "demo" or db._is_postgres():
        raise HTTPException(503, "Configura la clave de cifrado del servidor para habilitar autenticadores.")
    # A private local key persists across demo restarts; never use a public fixture key.
    key_path = Path(db._sqlite_path()).resolve().with_suffix(".employee-auth.key")
    try:
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(Fernet.generate_key())
    return Fernet(key_path.read_bytes())


def totp(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 15
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff
    return f"{value % 1_000_000:06d}"


def matching_step(secret: str, code: str, now: float | None = None) -> int | None:
    step = int((time.time() if now is None else now) // 30)
    for candidate in (step, step - 1, step + 1):
        if candidate >= 0 and hmac.compare_digest(totp(secret, candidate), code):
            return candidate
    return None


def enrollment_uri(employee_id: str, secret: str) -> str:
    return "otpauth://totp/" + quote("Vigilia:" + employee_id, safe="") + "?" + urlencode({
        "secret": secret, "issuer": "Vigilia", "algorithm": "SHA1", "digits": 6, "period": 30,
    })


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _valid_roles(value: list[str]) -> list[str]:
    if len(set(value)) != len(value) or set(value) - set(security.ROLE_PERMISSIONS):
        raise ValueError("Selecciona roles del catálogo de Vigilia.")
    return value


def _valid_permissions(value: list[str] | None) -> list[str] | None:
    if value is not None and (len(set(value)) != len(value) or set(value) - set(security.PERMISSION_CATALOG)):
        raise ValueError("Selecciona permisos del catálogo de Vigilia.")
    return value


def role_bundle(roles: list[str]) -> list[str]:
    return sorted({permission for role in roles for permission in security.ROLE_PERMISSIONS[role]})


class EmployeeInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    employee_id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9-]+$")
    display_name: str = Field(min_length=1, max_length=160)
    roles: list[str] = Field(default_factory=lambda: list(RECEPTION_ROLES), max_length=6)
    # Sin lista explícita se usan los permisos de los roles elegidos.
    permissions: list[str] | None = Field(default=None, max_length=32)

    @field_validator("employee_id")
    @classmethod
    def normalize_id(cls, value: str) -> str:
        return value.upper()

    @field_validator("roles")
    @classmethod
    def check_roles(cls, value: list[str]) -> list[str]:
        return _valid_roles(value)

    @field_validator("permissions")
    @classmethod
    def check_permissions(cls, value: list[str] | None) -> list[str] | None:
        return _valid_permissions(value)


class EmployeeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: str = Field(min_length=1, max_length=160)
    active: bool
    # Omitidos, se conservan los roles y permisos actuales.
    roles: list[str] | None = Field(default=None, max_length=6)
    permissions: list[str] | None = Field(default=None, max_length=32)

    @field_validator("roles")
    @classmethod
    def check_roles(cls, value: list[str] | None) -> list[str] | None:
        return value if value is None else _valid_roles(value)

    @field_validator("permissions")
    @classmethod
    def check_permissions(cls, value: list[str] | None) -> list[str] | None:
        return _valid_permissions(value)


def employee_json(row) -> dict:
    permissions = json.loads(row["permissions_json"] or "[]")
    needs_password = security.requires_password(permissions)
    return {"id": row["user_id"], "employee_id": row["employee_id"],
            "display_name": row["display_name"], "active": bool(row["active"]),
            "roles": json.loads(row["roles_json"] or "[]"), "permissions": permissions,
            "totp_configured": bool(row["encrypted_totp_secret"]),
            "requires_password": needs_password, "password_set": bool(row["password_hash"]),
            "must_change_password": bool(row["must_change_password"]),
            "badge": "vigilia:employee:" + row["employee_id"]}


def fetch_employee(connection, user_id):
    row = connection.execute(
        "SELECT e.*, p.display_name, p.active, p.roles_json, p.permissions_json "
        "FROM employees e JOIN user_profiles p ON p.id=e.user_id WHERE e.user_id=?",
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "No se encontró el empleado.")
    return row


def authorize(request: Request, write: bool = False):
    profile = security.require_permission(request, "users.manage")
    if write:
        security.require_csrf(request, request.headers.get("x-csrf-token"))
    return profile


@router.get("")
def list_employees(request: Request, response: Response):
    authorize(request)
    response.headers["Cache-Control"] = "no-store"
    with db.conexion() as connection:
        rows = connection.execute(
            "SELECT e.*, p.display_name, p.active, p.roles_json, p.permissions_json "
            "FROM employees e JOIN user_profiles p ON p.id=e.user_id ORDER BY e.employee_id"
        ).fetchall()
    return [employee_json(row) for row in rows]


def insert_employee(connection, employee_id: str, name: str, actor: str | None = None,
                    roles: list[str] | None = None, permissions: list[str] | None = None):
    roles = list(roles or RECEPTION_ROLES)
    permissions = sorted(permissions) if permissions is not None else role_bundle(roles)
    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    connection.execute(
        "INSERT INTO user_profiles (id,issuer,subject,email,display_name,active,roles_json,permissions_json,created_at,updated_at,created_by) "
        "VALUES (?, 'employee', ?, ?, ?, TRUE, ?, ?, ?, ?, ?)",
        (user_id, employee_id, user_id + "@employees.vigilia.invalid", name, json.dumps(roles), json.dumps(permissions), now, now, actor),
    )
    connection.execute("INSERT INTO employees (user_id,employee_id) VALUES (?,?)", (user_id, employee_id))
    return user_id


@router.post("", status_code=201)
def create_employee(body: EmployeeInput, request: Request):
    actor = authorize(request, True)
    try:
        with db.conexion() as connection:
            user_id = insert_employee(connection, body.employee_id, body.display_name, actor["id"], body.roles, body.permissions)
            result = employee_json(fetch_employee(connection, user_id))
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(409, "Ese identificador ya está registrado.") from exc
        raise
    record(actor["id"], "employee.create", "employee", user_id, {"roles": result["roles"], "permissions": result["permissions"]})
    return result


@router.put("/{user_id}")
def update_employee(user_id: str, body: EmployeeUpdate, request: Request):
    actor = authorize(request, True)
    from .provisioning import ensure_mutable_account  # import local: provisioning importa este módulo
    ensure_mutable_account(user_id)
    if user_id == actor["id"] and not body.active:
        raise HTTPException(409, "No puedes desactivar tu propia cuenta.")
    with db.conexion() as connection:
        existing = fetch_employee(connection, user_id)
        roles = body.roles if body.roles is not None else json.loads(existing["roles_json"] or "[]")
        if body.permissions is not None:
            permissions = sorted(body.permissions)
        elif body.roles is not None:
            permissions = role_bundle(roles)
        else:
            permissions = json.loads(existing["permissions_json"] or "[]")
        access_changed = (bool(existing["active"]) != body.active
                          or set(permissions) != set(json.loads(existing["permissions_json"] or "[]")))
        connection.execute(
            "UPDATE user_profiles SET display_name=?, active=?, roles_json=?, permissions_json=?, updated_at=? WHERE id=?",
            (body.display_name, body.active, json.dumps(roles), json.dumps(permissions), datetime.now(timezone.utc).isoformat(), user_id),
        )
        if security.active_user_managers(connection) == 0:
            connection.rollback()
            raise HTTPException(409, "Debe quedar al menos una persona activa con permiso para administrar usuarios.")
        if access_changed:
            # Activar, desactivar o cambiar permisos cierra las sesiones abiertas de la cuenta.
            connection.execute("UPDATE employees SET credential_version=credential_version+1 WHERE user_id=?", (user_id,))
        result = employee_json(fetch_employee(connection, user_id))
    record(actor["id"], "employee.update", "employee", user_id, {"active": body.active, "roles": roles, "permissions": permissions})
    return result


@router.post("/{user_id}/totp")
def issue_totp(user_id: str, request: Request, response: Response):
    actor = authorize(request, True)
    from .provisioning import ensure_mutable_account  # import local: provisioning importa este módulo
    ensure_mutable_account(user_id)
    secret = new_totp_secret()
    encrypted = cipher().encrypt(secret.encode()).decode()
    with db.conexion() as connection:
        employee = fetch_employee(connection, user_id)
        if not employee["active"]:
            raise HTTPException(409, "Activa la cuenta antes de configurar su autenticador.")
        connection.execute("UPDATE employees SET encrypted_totp_secret=?, credential_version=credential_version+1, last_totp_step=-1 WHERE user_id=?", (encrypted, user_id))
    record(actor["id"], "employee.totp.replace", "employee", user_id)
    response.headers["Cache-Control"] = "no-store"
    return {"uri": enrollment_uri(employee["employee_id"], secret), "secret": secret}


@router.post("/{user_id}/password")
def issue_temporary_password(user_id: str, request: Request, response: Response):
    actor = authorize(request, True)
    from .provisioning import ensure_mutable_account  # import local: provisioning importa este módulo
    ensure_mutable_account(user_id)
    if user_id == actor["id"]:
        raise HTTPException(409, "Cambia tu propia contraseña desde Mi cuenta.")
    temporary = local_accounts.generate_temporary_password()
    password_hash = local_accounts.hash_password(temporary)
    with db.conexion() as connection:
        employee = fetch_employee(connection, user_id)
        if not employee["active"]:
            raise HTTPException(409, "Activa la cuenta antes de asignarle una contraseña.")
        if not security.requires_password(json.loads(employee["permissions_json"] or "[]")):
            raise HTTPException(409, "Esta cuenta solo tiene permisos de Recepción y entra sin contraseña.")
        connection.execute(
            "UPDATE employees SET password_hash=?, must_change_password=TRUE, password_changed_at=?, "
            "credential_version=credential_version+1 WHERE user_id=?",
            (password_hash, db.timestamp_param(datetime.now(timezone.utc)), user_id),
        )
    local_accounts.clear_failures(user_id)
    record(actor["id"], "employee.password.reset", "employee", user_id)
    response.headers["Cache-Control"] = "no-store"
    return {"temporary_password": temporary}


def seed_demo(connection):
    if db.database_mode() != "demo" or os.getenv("VIGILIA_SEED_DEMO", "true").lower() != "true":
        return
    existing = connection.execute(
        "SELECT user_id, encrypted_totp_secret FROM employees WHERE employee_id=?", (DEMO_EMPLOYEE_ID,)
    ).fetchone()
    if existing:
        # The public demo badge is a fixture, so recover its authenticator if a local
        # database was copied without the matching demo encryption key. Real employee
        # credentials are never replaced here; their IDs are not this reserved fixture.
        try:
            secret = cipher().decrypt(existing["encrypted_totp_secret"].encode()).decode()
            totp(secret, 0)
        except (AttributeError, InvalidToken, UnicodeDecodeError, ValueError, TypeError):
            encrypted = cipher().encrypt(DEMO_TOTP_SECRET.encode()).decode()
            connection.execute(
                "UPDATE employees SET encrypted_totp_secret=?, credential_version=credential_version+1, "
                "last_totp_step=-1 WHERE user_id=?",
                (encrypted, existing["user_id"]),
            )
        return
    user_id = insert_employee(connection, DEMO_EMPLOYEE_ID, "Recepción de prueba")
    encrypted = cipher().encrypt(DEMO_TOTP_SECRET.encode()).decode()
    connection.execute("UPDATE employees SET encrypted_totp_secret=?, credential_version=1 WHERE user_id=?", (encrypted, user_id))
