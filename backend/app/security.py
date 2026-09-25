"""Human sessions, OIDC sign-in, application permissions, and webhook credentials."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from . import db

PERMISSION_CATALOG: dict[str, str] = {
    "users.manage": "Crear, editar y desactivar usuarios",
    "integrations.manage": "Configurar y probar integraciones",
    "ingress.submit": "Registrar ingresos manualmente",
    "ingress.read": "Consultar ingresos y sus detalles",
    "classification.review": "Resolver sugerencias que requieren revisión",
    "audit.read": "Consultar el registro de auditoría",
}
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "administrador": set(PERMISSION_CATALOG),
    "operador": {"ingress.submit", "ingress.read"},
    "revisor": {"ingress.read", "classification.review"},
    "auditor": {"audit.read"},
}


def oidc_issuer() -> str:
    return (os.getenv("OIDC_ISSUER") or "").strip().rstrip("/")


def oidc_enabled() -> bool:
    return all(
        (os.getenv(name) or "").strip()
        for name in ("OIDC_DISCOVERY_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ISSUER")
    )


def validate_production_security() -> None:
    session_secret = (os.getenv("VIGILIA_SESSION_SECRET") or "").strip()
    if len(session_secret) < 32:
        raise RuntimeError("Producción requiere VIGILIA_SESSION_SECRET con al menos 32 caracteres aleatorios.")
    if not oidc_enabled():
        raise RuntimeError("Producción requiere OIDC_DISCOVERY_URL, OIDC_ISSUER y credenciales OIDC.")
    bootstrap_email = (os.getenv("VIGILIA_BOOTSTRAP_ADMIN_EMAIL") or "").strip()
    if "@" not in bootstrap_email or bootstrap_email.startswith("@") or bootstrap_email.endswith("@"):
        raise RuntimeError("Producción requiere VIGILIA_BOOTSTRAP_ADMIN_EMAIL para aprovisionar la cuenta administradora inicial.")
    same_site = (os.getenv("VIGILIA_SESSION_SAME_SITE") or "lax").strip().casefold()
    if same_site not in {"lax", "none"}:
        raise RuntimeError("VIGILIA_SESSION_SAME_SITE debe ser 'lax' o 'none'.")
    frontend_origin = (os.getenv("OIDC_FRONTEND_ORIGIN") or "").strip()
    if frontend_origin:
        origin = urlsplit(frontend_origin)
        if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path not in {"", "/"} or origin.query or origin.fragment:
            raise RuntimeError("OIDC_FRONTEND_ORIGIN debe ser un origen HTTPS sin ruta, credenciales ni parámetros.")
    encryption_key = (os.getenv("VIGILIA_SECRET_ENCRYPTION_KEY") or "").strip()
    if not encryption_key:
        raise RuntimeError("Producción requiere VIGILIA_SECRET_ENCRYPTION_KEY para secretos de integraciones.")
    try:
        from cryptography.fernet import Fernet
        Fernet(encryption_key.encode())
    except (ImportError, ValueError, TypeError) as exc:
        raise RuntimeError("VIGILIA_SECRET_ENCRYPTION_KEY debe ser una clave Fernet válida.") from exc


def register_oidc(oauth: Any) -> None:
    if not oidc_enabled():
        return
    oauth.register(
        name="vigilia_oidc",
        client_id=os.getenv("OIDC_CLIENT_ID"),
        client_secret=os.getenv("OIDC_CLIENT_SECRET"),
        server_metadata_url=os.getenv("OIDC_DISCOVERY_URL"),
        client_kwargs={"scope": "openid email profile"},
    )


def permissions_for(roles: list[str], overrides: list[str]) -> list[str]:
    # The selected permission list is authoritative; roles are editable bundles, not hidden grants.
    return sorted({permission for permission in overrides if permission in PERMISSION_CATALOG})


def _row_profile(row: Any) -> dict[str, Any]:
    import json

    if row is None:
        raise HTTPException(status_code=401, detail="Inicia sesión para continuar.")
    return {
        "id": row["id"],
        "issuer": row["issuer"],
        "subject": row["subject"],
        "email": row["email"],
        "display_name": row["display_name"],
        "active": bool(row["active"]),
        "roles": json.loads(row["roles_json"] or "[]"),
        "permissions": json.loads(row["permissions_json"] or "[]"),
    }


def current_profile(request: Request) -> dict[str, Any]:
    from .db import database_mode

    if database_mode() == "demo":
        return {
            "id": "demo-admin",
            "issuer": "demo",
            "subject": "demo-admin",
            "email": "demo@vigilia.local",
            "display_name": "Administrador de demostración",
            "active": True,
            "roles": ["administrador"],
            "permissions": sorted(PERMISSION_CATALOG),
        }
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Inicia sesión para continuar.")
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
    profile = _row_profile(row)
    if not profile["active"]:
        request.session.clear()
        raise HTTPException(status_code=401, detail="El acceso de esta cuenta está desactivado.")
    return profile


def require_permission(request: Request, permission: str) -> dict[str, Any]:
    profile = current_profile(request)
    if permission not in profile["permissions"]:
        raise HTTPException(status_code=403, detail="No tienes permiso para esta operación.")
    return profile


def require_csrf(request: Request, supplied: str | None) -> None:
    from .db import database_mode

    if database_mode() == "demo":
        return
    expected = request.session.get("csrf_token")
    if not expected or not supplied or not hmac.compare_digest(str(expected), supplied):
        raise HTTPException(status_code=403, detail="La sesión de seguridad caducó. Recarga la página.")


def create_csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        request.session["csrf_token"] = token
    return token


def resolve_oidc_profile(claims: dict[str, Any]) -> dict[str, Any]:
    from datetime import datetime, timezone
    import json
    import uuid

    issuer = str(claims.get("iss") or oidc_issuer()).rstrip("/")
    subject = str(claims.get("sub") or "").strip()
    email = str(claims.get("email") or "").strip().casefold()
    email_verified = claims.get("email_verified") is True
    display_name = str(claims.get("name") or claims.get("preferred_username") or email).strip()[:160]
    if not subject or not email or not email_verified or issuer != oidc_issuer():
        raise HTTPException(status_code=403, detail="El proveedor de identidad no entregó una identidad verificada.")

    with db.conexion() as connection:
        row = connection.execute(
            "SELECT * FROM user_profiles WHERE issuer = ? AND (subject = ? OR lower(email) = ?)",
            (issuer, subject, email),
        ).fetchone()
        if row is None:
            bootstrap_email = (os.getenv("VIGILIA_BOOTSTRAP_ADMIN_EMAIL") or "").strip().casefold()
            existing_admin = connection.execute(
                "SELECT 1 FROM user_profiles WHERE active = TRUE AND roles_json LIKE ? LIMIT 1",
                ('%"administrador"%',),
            ).fetchone()
            if email != bootstrap_email or existing_admin:
                raise HTTPException(status_code=403, detail="Tu cuenta aún no tiene acceso a Vigilia.")
            now = datetime.now(timezone.utc)
            user_id = str(uuid.uuid4())
            roles = ["administrador"]
            permissions = sorted(PERMISSION_CATALOG)
            connection.execute(
                "INSERT INTO user_profiles "
                "(id, issuer, subject, email, display_name, active, roles_json, permissions_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?)",
                (user_id, issuer, subject, email, display_name, json.dumps(roles), json.dumps(permissions), now, now),
            )
            row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (user_id,)).fetchone()
        elif row["subject"] and row["subject"] != subject:
            raise HTTPException(status_code=403, detail="La identidad OIDC no coincide con el perfil autorizado.")
        elif not row["subject"]:
            now = datetime.now(timezone.utc)
            connection.execute(
                "UPDATE user_profiles SET subject = ?, display_name = ?, updated_at = ? WHERE id = ?",
                (subject, display_name, now, row["id"]),
            )
            row = connection.execute("SELECT * FROM user_profiles WHERE id = ?", (row["id"],)).fetchone()
    profile = _row_profile(row)
    if not profile["active"]:
        raise HTTPException(status_code=403, detail="El acceso de esta cuenta está desactivado.")
    return profile


def new_integration_credential() -> tuple[str, str]:
    token = "vig_" + secrets.token_urlsafe(36)
    return token, hashlib.sha256(token.encode()).hexdigest()


def verify_integration_credential(integration_id: str | None, authorization: str | None) -> dict[str, Any]:
    if not integration_id or not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Credencial de integración requerida.")
    token = authorization.removeprefix("Bearer ").strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    with db.conexion() as connection:
        row = connection.execute(
            "SELECT c.id, c.integration_id, c.secret_hash, i.kind, i.enabled FROM api_credentials c "
            "JOIN integration_configs i ON i.id = c.integration_id "
            "WHERE c.integration_id = ? AND c.active = TRUE",
            (integration_id,),
        ).fetchall()
    for candidate in row:
        if hmac.compare_digest(candidate["secret_hash"], digest):
            if not candidate["enabled"] or candidate["kind"] != "ingress":
                break
            return dict(candidate)
    raise HTTPException(status_code=401, detail="Credencial de integración inválida o revocada.")
