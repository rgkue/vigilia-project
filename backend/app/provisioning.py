"""Aprovisionamiento declarativo de las instalaciones de evaluación (demo y producción de muestra).

Todo se activa con variables de entorno del despliegue y es idempotente: en cada arranque se
restablece el estado previsto (cuentas del jurado, integraciones simuladas, IA compartida) por si
alguien lo cambió durante la evaluación. Una instalación hospitalaria real no define estas variables.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from . import db, employees, local_accounts, security, simulated
from .connectors import JURY_CREDENTIAL_ID
from .audit import record
from .secret_store import decrypt, encrypt

logger = logging.getLogger(__name__)
SYSTEM_ACTOR = "system:provisioning"
MANAGED_INTEGRATIONS = {"sim-ingreso-his", "sim-cobertura", "sim-antecedentes", "sim-avisos-admisiones", "sim-avisos-gestor"}
DEFAULT_SHARED_MODEL = {"ollama": "gpt-oss:20b"}
PROTECTED_MESSAGE = "Esta cuenta de evaluación del jurado usa credenciales fijas. Crea otra persona para probar esta función."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decrypts_to(value: str | None, expected: str) -> bool:
    try:
        return bool(value) and hmac.compare_digest(decrypt(value), expected)
    except RuntimeError:
        return False


# --- IA compartida -----------------------------------------------------------------------------

def shared_ai_settings() -> dict[str, str] | None:
    """Proveedor de IA del equipo, cargado por el operador en el entorno (nunca en el repositorio)."""
    key = (os.getenv("VIGILIA_SHARED_AI_KEY") or "").strip()
    if not key:
        return None
    from .ai_providers import CATALOG

    provider = (os.getenv("VIGILIA_SHARED_AI_PROVIDER") or "ollama").strip().casefold()
    if provider not in CATALOG:
        logger.error("VIGILIA_SHARED_AI_PROVIDER no es un proveedor conocido; se omite la IA compartida.")
        return None
    model = (os.getenv("VIGILIA_SHARED_AI_MODEL") or DEFAULT_SHARED_MODEL.get(provider, "")).strip()
    if not re.fullmatch(r"[a-zA-Z0-9._:/-]{1,150}", model):
        logger.error("VIGILIA_SHARED_AI_MODEL no es un identificador de modelo válido; se omite la IA compartida.")
        return None
    return {"provider": provider, "model": model, "auth_mode": "cloud" if provider == "ollama" else "api_key", "key": key}


def provision_shared_ai(user_ids: list[str]) -> None:
    """Deja la conexión compartida guardada, verificada y activa en las cuentas indicadas."""
    settings = shared_ai_settings()
    if not settings:
        return
    provider = settings["provider"]
    changed: list[str] = []
    with db.conexion() as connection:
        for user_id in dict.fromkeys(user_ids):
            if not connection.execute("SELECT 1 FROM user_profiles WHERE id=? AND active=TRUE", (user_id,)).fetchone():
                continue
            row = connection.execute("SELECT * FROM user_ai_configs WHERE user_id=? AND provider=?", (user_id, provider)).fetchone()
            current = (row is not None and row["model"] == settings["model"] and row["auth_mode"] == settings["auth_mode"]
                       and row["status"] == "verified" and _decrypts_to(row["encrypted_secret"], settings["key"]))
            if not current:
                values = (settings["model"], settings["auth_mode"], encrypt(settings["key"]), str(uuid.uuid4()), _now())
                if row:
                    connection.execute(
                        "UPDATE user_ai_configs SET model=?, auth_mode=?, encrypted_secret=?, revision=?, status='verified', updated_at=? "
                        "WHERE user_id=? AND provider=?", (*values, user_id, provider))
                else:
                    connection.execute(
                        "INSERT INTO user_ai_configs (model, auth_mode, encrypted_secret, revision, status, updated_at, user_id, provider) "
                        "VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)", (*values, user_id, provider))
                changed.append(user_id)
            selected = connection.execute(
                "SELECT s.provider, c.status FROM user_ai_selection s LEFT JOIN user_ai_configs c "
                "ON c.user_id=s.user_id AND c.provider=s.provider WHERE s.user_id=?", (user_id,)).fetchone()
            # Respeta otra conexión propia que funcione; recupera la compartida si no hay ninguna válida.
            if not selected or selected["provider"] == "none" or selected["status"] != "verified":
                connection.execute(
                    "INSERT INTO user_ai_selection (user_id, provider) VALUES (?, ?) "
                    "ON CONFLICT (user_id) DO UPDATE SET provider=excluded.provider", (user_id, provider))
    for user_id in changed:
        record(SYSTEM_ACTOR, "ai.provision", "ai_provider", provider, {"user_id": user_id, "model": settings["model"]})


def demo_ai_owner() -> str:
    """Cuenta cuya conexión de IA clasifica los ingresos del webhook en modo demo."""
    return (os.getenv("VIGILIA_DEMO_AI_OWNER") or "demo-admin").strip()


# --- Cuentas del jurado (modo producción) ------------------------------------------------------

def _totp_secret(value: str | None) -> str | None:
    secret = re.sub(r"\s+", "", value or "").upper().rstrip("=")
    if len(secret) < 16:
        return None
    try:
        base64.b32decode(secret + "=" * (-len(secret) % 8))
    except (ValueError, TypeError):
        return None
    return secret


def _account_id(variable: str, default: str) -> str:
    value = (os.getenv(variable) or default).strip().upper()
    return value if re.fullmatch(r"[A-Z0-9-]{1,40}", value) else default


def jury_accounts() -> list[dict[str, Any]]:
    accounts = []
    admin_totp = _totp_secret(os.getenv("VIGILIA_JURY_ADMIN_TOTP"))
    admin_password = os.getenv("VIGILIA_JURY_ADMIN_PASSWORD") or ""
    if admin_totp and admin_password:
        account_id = _account_id("VIGILIA_JURY_ADMIN_ID", "JURADO-ADMIN")
        try:
            local_accounts.validate_new_password(admin_password, account_id)
        except HTTPException as exc:
            logger.error("VIGILIA_JURY_ADMIN_PASSWORD no cumple la política de contraseñas: %s", exc.detail)
        else:
            accounts.append({"role": "admin", "id": account_id, "name": "Jurado · Administración", "roles": ["administrador"],
                             "permissions": sorted(security.PERMISSION_CATALOG), "password": admin_password, "totp": admin_totp})
    employee_totp = _totp_secret(os.getenv("VIGILIA_JURY_EMPLOYEE_TOTP"))
    if employee_totp:
        accounts.append({"role": "employee", "id": _account_id("VIGILIA_JURY_EMPLOYEE_ID", "JURADO-RECEPCION"),
                         "name": "Jurado · Recepción", "roles": list(employees.RECEPTION_ROLES),
                         "permissions": list(employees.RECEPTION_PERMISSIONS), "password": None, "totp": employee_totp})
    return accounts


def _fingerprint(account: dict[str, Any]) -> str:
    key = (os.getenv("VIGILIA_SESSION_SECRET") or "vigilia-provisioning").encode()
    material = json.dumps([account["id"], account["password"] or "", account["totp"]])
    return hmac.new(key, material.encode(), hashlib.sha256).hexdigest()


def _ensure_jury_account(connection, account: dict[str, Any]) -> tuple[str, bool]:
    """Devuelve (user_id, cambió). Solo invalida sesiones abiertas si hubo que restablecer algo."""
    marker_name = "jury:" + account["id"]
    marker_row = connection.execute("SELECT value FROM auth_settings WHERE name=?", (marker_name,)).fetchone()
    marker = json.loads(marker_row["value"]) if marker_row else {}
    fingerprint = _fingerprint(account)
    row = connection.execute(
        "SELECT e.*, p.display_name, p.active, p.roles_json, p.permissions_json FROM employees e "
        "JOIN user_profiles p ON p.id=e.user_id WHERE e.employee_id=?", (account["id"],)).fetchone()
    user_id = row["user_id"] if row else employees.insert_employee(
        connection, account["id"], account["name"], SYSTEM_ACTOR, account["roles"], account["permissions"])

    password_hash = None
    if account["password"]:
        reuse = marker.get("fingerprint") == fingerprint and marker.get("password_hash")
        password_hash = marker["password_hash"] if reuse else local_accounts.hash_password(account["password"])

    try:
        totp_matches = bool(row) and employees.cipher().decrypt(row["encrypted_totp_secret"].encode()).decode() == account["totp"]
    except Exception:  # noqa: BLE001 - cualquier secreto ilegible se reemplaza
        totp_matches = False
    profile_matches = bool(row) and (bool(row["active"]) and row["display_name"] == account["name"]
                                     and json.loads(row["roles_json"] or "[]") == account["roles"]
                                     and sorted(json.loads(row["permissions_json"] or "[]")) == sorted(account["permissions"]))
    password_matches = bool(row) and row["password_hash"] == password_hash and not row["must_change_password"]

    changed = not (row and totp_matches and profile_matches and password_matches)
    if changed:
        connection.execute(
            "UPDATE user_profiles SET display_name=?, active=TRUE, roles_json=?, permissions_json=?, updated_at=? WHERE id=?",
            (account["name"], json.dumps(account["roles"]), json.dumps(sorted(account["permissions"])), _now(), user_id))
        connection.execute(
            "UPDATE employees SET encrypted_totp_secret=?, password_hash=?, must_change_password=FALSE, "
            "credential_version=credential_version+1, last_totp_step=? WHERE user_id=?",
            (employees.cipher().encrypt(account["totp"].encode()).decode(), password_hash,
             row["last_totp_step"] if row and totp_matches else -1, user_id))
    value = json.dumps({"fingerprint": fingerprint, "password_hash": password_hash})
    connection.execute("INSERT INTO auth_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                       (marker_name, value))
    return user_id, changed


def ensure_jury_accounts() -> dict[str, str]:
    """Crea o restablece las cuentas del jurado; devuelve {"admin"|"employee": user_id}."""
    accounts = jury_accounts()
    if not accounts or db.database_mode() != "production":
        return {}
    result: dict[str, str] = {}
    restored: list[str] = []
    with db.conexion() as connection:
        for account in accounts:
            user_id, changed = _ensure_jury_account(connection, account)
            result[account["role"]] = user_id
            if changed:
                restored.append(user_id)
    for user_id in restored:  # La auditoría usa su propia conexión: fuera de la transacción.
        record(SYSTEM_ACTOR, "employee.provision", "employee", user_id)
    return result


def is_protected_account(user_id: str) -> bool:
    configured = {account["id"] for account in jury_accounts()}
    if not configured:
        return False
    with db.conexion() as connection:
        row = connection.execute("SELECT employee_id FROM employees WHERE user_id=?", (user_id,)).fetchone()
    return bool(row) and row["employee_id"] in configured


def ensure_mutable_account(user_id: str) -> None:
    if is_protected_account(user_id):
        raise HTTPException(409, PROTECTED_MESSAGE)


# --- Integraciones con los sistemas simulados (modo producción) ----------------------------------

def ensure_mutable_integration(integration_id: str) -> None:
    if simulated.enabled() and integration_id in MANAGED_INTEGRATIONS:
        raise HTTPException(409, "Esta integración de demostración la administra el despliegue. "
                                 "Puedes probarla o crear otra integración propia.")


def jury_ingress_token() -> str | None:
    token = (os.getenv("VIGILIA_JURY_INGRESS_TOKEN") or "").strip()
    return token if token.startswith("vig_") and len(token) >= 24 else None


def ensure_simulated_integrations(owner_id: str | None) -> None:
    if not simulated.enabled() or db.database_mode() != "production":
        return
    specs = simulated.integration_specs()
    if not specs:
        logger.error("VIGILIA_SIMULATED_SYSTEMS=true, pero no hay una URL HTTPS pública "
                     "(VIGILIA_SIMULATED_BASE_URL o VERCEL_PROJECT_PRODUCTION_URL).")
        return
    secret = simulated.shared_secret()
    now = datetime.now(timezone.utc)
    with db.conexion() as connection:
        for spec in specs:
            field_map = json.dumps(spec["field_map"], sort_keys=True)
            row = connection.execute("SELECT * FROM integration_configs WHERE id=?", (spec["id"],)).fetchone()
            needs_secret = spec["kind"] != "ingress"
            current = row is not None and (row["kind"], row["name"], row["endpoint_url"], row["method"], row["lookup_parameter"],
                                           row["field_map_json"], bool(row["enabled"])) == (
                spec["kind"], spec["name"], spec["endpoint_url"], spec["method"], spec["lookup_parameter"], field_map, True
            ) and (not needs_secret or _decrypts_to(row["encrypted_secret"], secret))
            if current:
                continue
            values = (spec["kind"], spec["name"], spec["endpoint_url"], spec["method"], spec["lookup_parameter"], field_map,
                      encrypt(secret) if needs_secret else None, now, SYSTEM_ACTOR, spec["id"])
            if row:
                connection.execute(
                    "UPDATE integration_configs SET kind=?, name=?, endpoint_url=?, method=?, lookup_parameter=?, field_map_json=?, "
                    "enabled=TRUE, encrypted_secret=?, status='pending', last_error=NULL, updated_at=?, updated_by=? WHERE id=?", values)
            else:
                connection.execute(
                    "INSERT INTO integration_configs (kind, name, endpoint_url, method, lookup_parameter, field_map_json, enabled, "
                    "encrypted_secret, status, updated_at, updated_by, id) VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, 'pending', ?, ?, ?)", values)

        token = jury_ingress_token()
        if token:
            digest = hashlib.sha256(token.encode()).hexdigest()
            connection.execute(
                "INSERT INTO api_credentials (id, integration_id, secret_hash, active, created_at) VALUES (?, 'sim-ingreso-his', ?, TRUE, ?) "
                "ON CONFLICT(id) DO UPDATE SET secret_hash=excluded.secret_hash, active=TRUE, revoked_at=NULL",
                (JURY_CREDENTIAL_ID, digest, now))

        if owner_id:
            assignment = connection.execute(
                "SELECT user_id, status FROM ai_integration_assignments WHERE integration_id='sim-ingreso-his'").fetchone()
            if not assignment or assignment["user_id"] != owner_id or assignment["status"] != "accepted":
                connection.execute(
                    "INSERT INTO ai_integration_assignments (integration_id, user_id, status, revision, proposed_by, updated_at) "
                    "VALUES ('sim-ingreso-his', ?, 'accepted', ?, ?, ?) ON CONFLICT(integration_id) DO UPDATE SET "
                    "user_id=excluded.user_id, status='accepted', revision=excluded.revision, proposed_by=excluded.proposed_by, "
                    "updated_at=excluded.updated_at",
                    (owner_id, str(uuid.uuid4()), SYSTEM_ACTOR, _now()))


def retire_demo_fixture() -> None:
    """En producción, la cuenta de prueba con TOTP público (p. ej. de una base usada antes en demo) no entra."""
    with db.conexion() as connection:
        row = connection.execute(
            "SELECT e.user_id, e.encrypted_totp_secret, p.active FROM employees e JOIN user_profiles p ON p.id=e.user_id "
            "WHERE e.employee_id=?", (employees.DEMO_EMPLOYEE_ID,)).fetchone()
        if not row or not row["active"]:
            return
        try:
            public = employees.cipher().decrypt(row["encrypted_totp_secret"].encode()).decode() == employees.DEMO_TOTP_SECRET
        except Exception:  # noqa: BLE001 - un secreto ilegible tampoco debe dar acceso
            public = True
        if not public:
            return  # Un empleado real que casualmente usa ese ID conserva su cuenta.
        connection.execute("UPDATE user_profiles SET active=FALSE, updated_at=? WHERE id=?", (_now(), row["user_id"]))
        connection.execute("UPDATE employees SET credential_version=credential_version+1 WHERE user_id=?", (row["user_id"],))
    record(SYSTEM_ACTOR, "employee.demo_fixture.disable", "employee", row["user_id"])


# --- Modo Demo dentro de la instalación de producción -----------------------------------------------

def ensure_demo_access_account() -> str | None:
    """Perfil sin credenciales del modo Demo (VIGILIA_DEMO_ACCESS=true); se restablece en cada arranque."""
    if not security.demo_access_enabled():
        return None
    desired = ("demo-access", "Evaluador de demostración", True,
               json.dumps(security.DEMO_ACCESS_ROLES), json.dumps(security.DEMO_ACCESS_PERMISSIONS))
    with db.conexion() as connection:
        row = connection.execute("SELECT * FROM user_profiles WHERE id=?", (security.DEMO_ACCESS_ID,)).fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO user_profiles (id, issuer, subject, email, display_name, active, roles_json, permissions_json, "
                "created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?)",
                (security.DEMO_ACCESS_ID, desired[0], security.DEMO_ACCESS_ID, security.DEMO_ACCESS_ID + "@demo.vigilia.invalid",
                 desired[1], desired[3], desired[4], _now(), _now(), SYSTEM_ACTOR))
        elif (row["issuer"], row["display_name"], bool(row["active"]), row["roles_json"], row["permissions_json"]) != desired:
            connection.execute(
                "UPDATE user_profiles SET issuer=?, display_name=?, active=TRUE, roles_json=?, permissions_json=?, updated_at=? WHERE id=?",
                (desired[0], desired[1], desired[3], desired[4], _now(), security.DEMO_ACCESS_ID))
    return security.DEMO_ACCESS_ID


def managed_ai_accounts() -> set[str]:
    """Cuentas cuya IA administra el despliegue con la clave compartida (no se editan desde la interfaz)."""
    if not shared_ai_settings():
        return set()
    if db.database_mode() == "demo":
        employee_ids = [employees.DEMO_EMPLOYEE_ID]
        accounts = {demo_ai_owner()}
    else:
        employee_ids = [account["id"] for account in jury_accounts()]
        accounts = {security.DEMO_ACCESS_ID} if security.demo_access_enabled() else set()
    if employee_ids:
        marks = ",".join("?" for _ in employee_ids)
        with db.conexion() as connection:
            rows = connection.execute(f"SELECT user_id FROM employees WHERE employee_id IN ({marks})", tuple(employee_ids)).fetchall()
        accounts.update(row["user_id"] for row in rows)
    return accounts


def ensure_personal_ai_editable(user_id: str) -> None:
    if user_id in managed_ai_accounts():
        raise HTTPException(409, "La IA de esta cuenta de evaluación la administra el despliegue con la clave del equipo. "
                                 "Puedes probarla con los casos ficticios, pero no cambiarla.")


# --- Punto de entrada ------------------------------------------------------------------------------

def apply() -> None:
    """Se ejecuta tras ``init_db`` en cada arranque. Sin variables de evaluación no hace nada."""
    if db.database_mode() == "demo":
        with db.conexion() as connection:
            demo_employee = connection.execute(
                "SELECT user_id FROM employees WHERE employee_id=?", (employees.DEMO_EMPLOYEE_ID,)).fetchone()
        provision_shared_ai([demo_ai_owner(), *([demo_employee["user_id"]] if demo_employee else [])])
        return
    retire_demo_fixture()
    accounts = ensure_jury_accounts()
    demo_account = ensure_demo_access_account()
    ensure_simulated_integrations(accounts.get("admin"))
    provision_shared_ai([*accounts.values(), *([demo_account] if demo_account else [])])
