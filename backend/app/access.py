"""Pre-authentication, persisted throttling, local account login and QR/OIDC binding."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from . import db, employees, local_accounts, security
from .audit import record

router = APIRouter(prefix="/auth", tags=["authentication"])


class EmployeeLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    employee_id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9-]+$")
    code: str = Field(pattern=r"^[0-9]{6}$")
    # Solo las cuentas con permisos administrativos la necesitan; Recepción entra con ID + código.
    password: str | None = Field(default=None, min_length=1, max_length=local_accounts.PASSWORD_MAX)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=local_accounts.PASSWORD_MAX)
    new_password: str = Field(min_length=1, max_length=local_accounts.PASSWORD_MAX)


class QRInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    qr: str = Field(min_length=1, max_length=200)


def throttle(request: Request, account: str = ""):
    now = int(time.time())
    ip = request.client.host if request.client else "unknown"
    limits = [("ip:" + ip, 30)]
    if account:
        limits.append(("account:" + account, 10))
    blocked = False
    with db.conexion() as connection:
        connection.execute("DELETE FROM auth_attempts WHERE window_start < ?", (now - 3600,))
        for identity, limit in limits:
            bucket = hashlib.sha256(identity.encode()).hexdigest()
            row = connection.execute(
                "INSERT INTO auth_attempts (bucket,window_start,attempts) VALUES (?,?,1) "
                "ON CONFLICT(bucket) DO UPDATE SET "
                "attempts=CASE WHEN auth_attempts.window_start<=? THEN 1 ELSE auth_attempts.attempts+1 END, "
                "window_start=CASE WHEN auth_attempts.window_start<=? THEN ? ELSE auth_attempts.window_start END RETURNING attempts",
                (bucket, now, now - 60, now - 60, now),
            ).fetchone()
            blocked = blocked or row["attempts"] > limit
    if blocked:
        raise HTTPException(429, "Demasiados intentos. Espera un minuto.", headers={"Retry-After": "60"})


def bootstrap_available() -> bool:
    if not security.oidc_enabled() or not (os.getenv("VIGILIA_BOOTSTRAP_ADMIN_EMAIL") or "").strip():
        return False
    with db.conexion() as connection:
        return connection.execute("SELECT 1 FROM auth_settings WHERE name='bootstrap_consumed'").fetchone() is None


def session_response(request: Request):
    return {"user": security.current_profile(request, allow_pending_password=True),
            "csrf_token": security.create_csrf_token(request), "mode": db.database_mode()}


@router.get("/options")
def options(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    demo = db.database_mode() == "demo"
    fixture = demo and os.getenv("VIGILIA_SEED_DEMO", "true").lower() == "true"
    return {"csrf_token": security.create_csrf_token(request), "mode": db.database_mode(),
            "bootstrap_allowed": bootstrap_available(), "oidc_enabled": security.oidc_enabled(),
            "demo_admin_badge": "vigilia:admin:demo-admin" if demo else None,
            "demo_employee": {"employee_id": employees.DEMO_EMPLOYEE_ID,
                              "badge": "vigilia:employee:" + employees.DEMO_EMPLOYEE_ID,
                              "uri": employees.enrollment_uri(employees.DEMO_EMPLOYEE_ID, employees.DEMO_TOTP_SECRET)} if fixture else None}


@router.post("/employee/login")
def employee_login(body: EmployeeLogin, request: Request, response: Response):
    security.require_csrf(request, request.headers.get("x-csrf-token"))
    employee_id = body.employee_id.upper()
    throttle(request, employee_id)
    with db.conexion() as connection:
        row = connection.execute(
            "SELECT e.*, p.active, p.permissions_json FROM employees e JOIN user_profiles p ON p.id=e.user_id WHERE e.employee_id=?",
            (employee_id,),
        ).fetchone()
    accepted = False
    needs_password = False
    if row and row["active"] and row["encrypted_totp_secret"]:
        secret = employees.cipher().decrypt(row["encrypted_totp_secret"].encode()).decode()
        step = employees.matching_step(secret, body.code)
        needs_password = security.requires_password(json.loads(row["permissions_json"] or "[]"))
        if step is not None and needs_password:
            # La contraseña solo se evalúa tras un código válido: sin el autenticador no se puede
            # averiguar que la cuenta es administrativa ni probar contraseñas.
            local_accounts.ensure_not_locked(row["user_id"])
            if body.password is None:
                raise HTTPException(428, "Esta cuenta requiere contraseña. Escríbela y vuelve a entrar con un código vigente.")
            if not local_accounts.verify_password(body.password, row["password_hash"]):
                local_accounts.register_failure(row["user_id"])
                step = None
        if step is not None:
            with db.conexion() as connection:
                # Atomic compare-and-update protects against concurrent reuse and reset races.
                updated = connection.execute(
                    "UPDATE employees SET last_totp_step=? WHERE user_id=? AND last_totp_step<? AND credential_version=? "
                    "AND EXISTS (SELECT 1 FROM user_profiles WHERE id=? AND active=TRUE)",
                    (step, row["user_id"], step, row["credential_version"], row["user_id"]),
                )
                accepted = updated.rowcount == 1
    if not accepted:
        record(None, "auth.employee.denied", "authentication", None)
        raise HTTPException(401, "No se pudo validar el identificador, la contraseña o el código. Revisa los datos o espera un código nuevo.")
    if needs_password:
        local_accounts.clear_failures(row["user_id"])
    request.session.clear()
    request.session.update(user_id=row["user_id"], auth_method="password" if needs_password else "totp",
                           credential_version=row["credential_version"])
    response.headers["Cache-Control"] = "no-store"
    record(row["user_id"], "auth.local.login" if needs_password else "auth.employee.login", "user", row["user_id"])
    return session_response(request)


@router.post("/password")
def change_password(body: PasswordChange, request: Request, response: Response):
    security.require_csrf(request, request.headers.get("x-csrf-token"))
    profile = security.current_profile(request, allow_pending_password=True)
    if profile["issuer"] != "employee" or profile["auth_method"] != "password":
        raise HTTPException(409, "Tu cuenta no usa contraseña de Vigilia.")
    throttle(request, profile["id"])
    local_accounts.ensure_not_locked(profile["id"])
    with db.conexion() as connection:
        row = connection.execute("SELECT password_hash, employee_id FROM employees WHERE user_id=?", (profile["id"],)).fetchone()
    if not local_accounts.verify_password(body.current_password, row["password_hash"]):
        local_accounts.register_failure(profile["id"])
        raise HTTPException(403, "La contraseña actual no es correcta.")
    if body.new_password == body.current_password:
        raise HTTPException(422, "La nueva contraseña debe ser distinta de la actual.")
    local_accounts.validate_new_password(body.new_password, row["employee_id"])
    new_hash = local_accounts.hash_password(body.new_password)
    with db.conexion() as connection:
        # Cambiar la contraseña cierra las demás sesiones; esta continúa con la nueva versión.
        connection.execute(
            "UPDATE employees SET password_hash=?, must_change_password=FALSE, password_changed_at=?, "
            "credential_version=credential_version+1 WHERE user_id=?",
            (new_hash, db.timestamp_param(datetime.now(timezone.utc)), profile["id"]),
        )
        version = connection.execute("SELECT credential_version FROM employees WHERE user_id=?", (profile["id"],)).fetchone()["credential_version"]
    local_accounts.clear_failures(profile["id"])
    request.session["credential_version"] = version
    response.headers["Cache-Control"] = "no-store"
    record(profile["id"], "auth.password.change", "user", profile["id"])
    return session_response(request)


@router.post("/admin/qr/start")
def admin_qr(body: QRInput, request: Request):
    security.require_csrf(request, request.headers.get("x-csrf-token"))
    throttle(request)
    prefix = "vigilia:admin:"
    user_id = body.qr[len(prefix):] if body.qr.startswith(prefix) else ""
    with db.conexion() as connection:
        row = connection.execute("SELECT id,issuer FROM user_profiles WHERE id=? AND active=TRUE", (user_id,)).fetchone()
    if not row or row["issuer"] == "employee" or (db.database_mode() != "demo" and row["issuer"] == "demo"):
        raise HTTPException(401, "No se pudo validar el QR de acceso corporativo.")
    request.session.clear()
    request.session["qr_intent"] = {"id": user_id, "expires": int(time.time()) + 300}
    return {"csrf_token": security.create_csrf_token(request), "login_path": "/auth/login"}


@router.post("/demo-admin")
def demo_admin(request: Request, response: Response):
    if db.database_mode() != "demo":
        raise HTTPException(404, "No encontrado.")
    security.require_csrf(request, request.headers.get("x-csrf-token"))
    intent = request.session.pop("qr_intent", {})
    if intent.get("id") != "demo-admin" or intent.get("expires", 0) < time.time():
        raise HTTPException(401, "Escanea el QR del administrador de demo.")
    request.session.clear()
    request.session.update(user_id="demo-admin", auth_method="demo")
    response.headers["Cache-Control"] = "no-store"
    record("demo-admin", "auth.demo.login", "user", "demo-admin")
    return session_response(request)


@router.get("/badge")
def own_badge(request: Request, response: Response):
    profile = security.current_profile(request, allow_pending_password=True)
    response.headers["Cache-Control"] = "no-store"
    prefix = "employee" if profile["auth_method"] in {"totp", "password"} else "admin"
    return {"badge": f"vigilia:{prefix}:" + (profile.get("employee_id") or profile["id"])}


def complete_oidc(request: Request, claims: dict, intent: dict):
    if not intent or intent.get("expires", 0) < time.time():
        raise HTTPException(401, "El acceso caducó. Escanea tu QR de nuevo.")
    if intent.get("id"):
        with db.conexion() as connection:
            expected = connection.execute("SELECT * FROM user_profiles WHERE id=? AND active=TRUE", (intent["id"],)).fetchone()
        if (not expected or expected["issuer"] != security.oidc_issuer()
                or str(claims.get("email", "")).strip().casefold() != expected["email"].lower()
                or (expected["subject"] and claims.get("sub") != expected["subject"])):
            raise HTTPException(403, "La cuenta corporativa no corresponde al QR escaneado.")
    else:
        bootstrap_email = (os.getenv("VIGILIA_BOOTSTRAP_ADMIN_EMAIL") or "").strip().lower()
        if not bootstrap_email or str(claims.get("email", "")).strip().lower() != bootstrap_email or not bootstrap_available():
            raise HTTPException(403, "Escanea tu QR para iniciar sesión.")
    profile = security.resolve_oidc_profile(claims)
    if intent.get("id") and profile["id"] != intent["id"]:
        raise HTTPException(403, "La cuenta corporativa no corresponde al QR escaneado.")
    if not intent.get("id"):
        if "users.manage" not in profile["permissions"]:
            raise HTTPException(403, "La configuración inicial requiere un administrador.")
        with db.conexion() as connection:
            updated = connection.execute("INSERT INTO auth_settings (name,value) VALUES ('bootstrap_consumed',?) ON CONFLICT(name) DO NOTHING", (profile["id"],))
            if updated.rowcount != 1:
                raise HTTPException(403, "La configuración inicial ya se completó. Escanea tu QR.")
    request.session.clear()
    request.session.update(user_id=profile["id"], auth_method="oidc", csrf_token=secrets.token_urlsafe(32))
    record(profile["id"], "auth.login", "user", profile["id"])
    return profile
