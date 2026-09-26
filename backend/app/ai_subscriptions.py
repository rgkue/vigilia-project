"""Personal OAuth connections. Each generation has an isolated OpenCode account store."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import time
import uuid
from urllib.parse import urlsplit, quote

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from . import db, security
from .audit import record
from .secret_store import decrypt, encrypt

router = APIRouter(prefix="/me/ai/subscriptions", tags=["Personal AI subscriptions"])
PROVIDERS = {"openai", "xai"}
ALLOWED_LOGIN_HOSTS = {"openai": {"auth.openai.com", "chatgpt.com"}, "xai": {"accounts.x.ai", "auth.x.ai", "grok.com"}}
tasks: dict[str, asyncio.Task] = {}


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str


class CallbackInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flow_id: str = Field(max_length=100)
    code: SecretStr | None = None


def configured() -> bool:
    return bool(os.getenv("VIGILIA_OPENCODE_URL") and os.getenv("VIGILIA_OPENCODE_PASSWORD"))


def scope(user_id: str, provider: str, flow_id: str) -> str:
    return hashlib.sha256(json.dumps([user_id, provider, flow_id]).encode()).hexdigest()


async def bridge(method: str, path: str, body=None, timeout: float = 25, *, account: str):
    base = os.getenv("VIGILIA_OPENCODE_URL", "").rstrip("/")
    password = os.getenv("VIGILIA_OPENCODE_PASSWORD", "")
    parts = urlsplit(base)
    if (not re.fullmatch(r"[a-f0-9]{64}", account) or not password or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment or parts.path not in {"", "/"}
            or (parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in {"127.0.0.1", "localhost", "::1"}))):
        raise ValueError("Configura el conector privado de suscripciones en el servidor.")
    async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False,
                                auth=httpx.BasicAuth("opencode", password)) as client:
        async with client.stream(method, base + "/accounts/" + account + path, json=body) as response:
            response.raise_for_status()
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > 4_000_000:
                    raise ValueError("Respuesta demasiado grande.")
            return json.loads(raw) if raw else None


def connection(provider: str, user_id: str):
    with db.conexion() as conn:
        return conn.execute("SELECT * FROM user_ai_oauth WHERE provider=? AND user_id=?", (provider, user_id)).fetchone()


def authorize(request: Request, provider: str, write=False):
    actor = security.current_profile(request)
    if write:
        security.require_csrf(request, request.headers.get("x-csrf-token"))
        from .provisioning import ensure_personal_ai_editable  # import local: evita un ciclo
        ensure_personal_ai_editable(actor["id"])
    if provider not in PROVIDERS:
        raise HTTPException(422, "Este proveedor no ofrece una suscripción compatible con el conector.")
    return actor


def invalidate(conn, provider: str, user_id: str):
    conn.execute("UPDATE user_ai_configs SET status='untested', revision=? WHERE provider=? AND user_id=? AND auth_mode='oauth'",
                 (str(uuid.uuid4()), provider, user_id))


def valid_authorization(provider: str, auth) -> dict:
    if not isinstance(auth, dict) or auth.get("method") not in {"auto", "code"}:
        raise ValueError("Flujo incompatible.")
    url = auth.get("url", "")
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.hostname not in ALLOWED_LOGIN_HOSTS[provider]
            or parts.username or parts.password or parts.port not in {None, 443}):
        raise ValueError("Destino de autorización inválido.")
    return {"url": url, "method": auth["method"], "instructions": str(auth.get("instructions", ""))[:2000]}


def _safe_status(row) -> str:
    if not row:
        return "disconnected"
    if row["status"] in {"starting", "pending", "completing"} and row["expires_at"] <= time.time():
        return "expired"
    return row["status"]


async def retire(provider: str, user_id: str, flow_id: str) -> bool:
    task = tasks.pop(flow_id, None)
    if task and task is not asyncio.current_task():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    try:
        await bridge("DELETE", "", account=scope(user_id, provider, flow_id))
        return True
    except (httpx.HTTPError, RuntimeError, ValueError):
        return False


@router.get("/{provider}")
def status(provider: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    actor = authorize(request, provider)
    row = connection(provider, actor["id"])
    result = {"status": _safe_status(row), "available": configured(), "flow_id": None, "authorization": None}
    if row and result["status"] in {"pending", "completing"}:
        result["flow_id"] = row["flow_id"]
        try:
            result["authorization"] = json.loads(decrypt(row["encrypted_authorization"]))
        except (RuntimeError, ValueError):
            result["status"] = "failed"
    return result


async def complete(provider: str, flow_id: str, method_index: int, actor_id: str, code: str | None = None):
    ok = False
    account = scope(actor_id, provider, flow_id)
    try:
        result = await bridge("POST", f"/provider/{provider}/oauth/callback",
                              {"method": method_index, **({"code": code} if code else {})}, timeout=540, account=account)
        listing = await bridge("GET", "/provider", account=account)
        ok = result is True and provider in listing.get("connected", [])
    except (httpx.HTTPError, ValueError, RuntimeError, TypeError, AttributeError):
        pass
    finally:
        with db.conexion() as conn:
            changed = conn.execute("UPDATE user_ai_oauth SET status=?, encrypted_authorization=NULL "
                                   "WHERE provider=? AND user_id=? AND flow_id=? AND status='completing' AND expires_at>?",
                                   ("connected" if ok else "failed", provider, actor_id, flow_id, time.time()))
        if changed.rowcount:
            record(actor_id, "ai.oauth.completed", "ai_provider", provider, {"success": ok})
    if not ok or not changed.rowcount:
        await retire(provider, actor_id, flow_id)


def _schedule(provider, flow_id, method_index, actor_id, code=None):
    task = asyncio.create_task(complete(provider, flow_id, method_index, actor_id, code))
    tasks[flow_id] = task
    def finished(result):
        tasks.pop(flow_id, None)
        if not result.cancelled():
            result.exception()
    task.add_done_callback(finished)


@router.post("/{provider}/login")
async def login(provider: str, body: LoginInput, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    actor = authorize(request, provider, True)
    user_id = actor["id"]
    if not configured():
        raise HTTPException(503, "El conector de suscripciones no está disponible.")
    try:
        encrypt("probe")
    except RuntimeError:
        raise HTTPException(503, "El cifrado de credenciales no está configurado.") from None
    now, flow_id = time.time(), secrets.token_urlsafe(32)
    old = connection(provider, user_id)
    with db.conexion() as conn:
        config = conn.execute("SELECT * FROM user_ai_configs WHERE provider=? AND user_id=?", (provider, user_id)).fetchone()
        if not config or config["auth_mode"] != "oauth" or config["revision"] != body.revision:
            raise HTTPException(409, "Guarda la conexión por suscripción y actualiza antes de conectar.")
        lease = conn.execute("INSERT INTO user_ai_oauth (user_id,provider,flow_id,actor_id,status,expires_at,method_index) "
                             "VALUES (?,?,?,?,'starting',?,0) ON CONFLICT(user_id,provider) DO UPDATE SET flow_id=excluded.flow_id, "
                             "actor_id=excluded.actor_id,status='starting',expires_at=excluded.expires_at,method_index=0, "
                             "encrypted_authorization=NULL WHERE user_ai_oauth.expires_at<? OR user_ai_oauth.status IN ('connected','failed','disconnected')",
                             (user_id, provider, flow_id, user_id, now + 600, now))
        if lease.rowcount != 1:
            raise HTTPException(409, "Ya tienes una autorización en curso. Complétala o cancélala.")
        invalidate(conn, provider, user_id)
    if old:
        await retire(provider, user_id, old["flow_id"])
    account = scope(user_id, provider, flow_id)
    try:
        methods = (await bridge("GET", "/provider/auth", account=account)).get(provider, [])
        choices = [(i, method) for i, method in enumerate(methods) if method.get("type") == "oauth"]
        if provider == "openai":
            choices = [(i, method) for i, method in choices if "headless" in method.get("label", "").lower()]
        index = choices[0][0]
        auth = valid_authorization(provider, await bridge("POST", f"/provider/{provider}/oauth/authorize", {"method": index}, account=account))
        with db.conexion() as conn:
            updated = conn.execute("UPDATE user_ai_oauth SET status=?,encrypted_authorization=?,method_index=? "
                                   "WHERE provider=? AND user_id=? AND flow_id=? AND status='starting'",
                                   ("completing" if auth["method"] == "auto" else "pending", encrypt(json.dumps(auth)), index, provider, user_id, flow_id))
        if updated.rowcount != 1:
            raise ValueError("Conexión cancelada.")
        if auth["method"] == "auto":
            _schedule(provider, flow_id, index, user_id)
        record(user_id, "ai.oauth.started", "ai_provider", provider)
        return {"flow_id": flow_id, "authorization": auth, "status": "completing" if auth["method"] == "auto" else "pending"}
    except (httpx.HTTPError, RuntimeError, ValueError, IndexError, TypeError, AttributeError):
        with db.conexion() as conn:
            conn.execute("UPDATE user_ai_oauth SET status='failed',encrypted_authorization=NULL WHERE user_id=? AND provider=? AND flow_id=?", (user_id, provider, flow_id))
        await retire(provider, user_id, flow_id)
        raise HTTPException(503, "No se pudo iniciar la autorización con el proveedor.") from None


@router.post("/{provider}/complete")
async def callback(provider: str, body: CallbackInput, request: Request):
    actor = authorize(request, provider, True)
    row = connection(provider, actor["id"])
    if not row or row["flow_id"] != body.flow_id or _safe_status(row) != "pending":
        raise HTTPException(409, "Esta autorización no pertenece a tu sesión o ya caducó.")
    code = body.code.get_secret_value().strip() if body.code else ""
    if not code or len(code) > 4096:
        raise HTTPException(422, "Introduce el código de autorización del proveedor.")
    with db.conexion() as conn:
        updated = conn.execute("UPDATE user_ai_oauth SET status='completing' WHERE user_id=? AND provider=? AND flow_id=? AND status='pending'",
                               (actor["id"], provider, body.flow_id))
    if updated.rowcount != 1:
        raise HTTPException(409, "La autorización ya se está procesando.")
    _schedule(provider, body.flow_id, row["method_index"], actor["id"], code)
    return {"status": "completing"}


@router.delete("/{provider}")
async def disconnect(provider: str, request: Request):
    actor = authorize(request, provider, True)
    row = connection(provider, actor["id"])
    with db.conexion() as conn:
        if row:
            conn.execute("UPDATE user_ai_oauth SET status='disconnected',encrypted_authorization=NULL WHERE user_id=? AND provider=? AND flow_id=?",
                         (actor["id"], provider, row["flow_id"]))
        invalidate(conn, provider, actor["id"])
    removed = await retire(provider, actor["id"], row["flow_id"]) if row else True
    record(actor["id"], "ai.oauth.disconnected", "ai_provider", provider, {"remote_removed": removed})
    return {"status": "disconnected", "remote_removed": removed}


async def models(provider: str, user_id: str) -> list[str]:
    row = connection(provider, user_id)
    if not row or row["status"] != "connected":
        raise ValueError("Conecta tu suscripción.")
    listing = await bridge("GET", "/provider", account=scope(user_id, provider, row["flow_id"]))
    if provider not in listing.get("connected", []):
        with db.conexion() as conn:
            changed = conn.execute("UPDATE user_ai_oauth SET status='expired' WHERE user_id=? AND provider=? AND flow_id=? AND status='connected'",
                                   (user_id, provider, row["flow_id"]))
            if changed.rowcount:
                invalidate(conn, provider, user_id)
        raise ValueError("La sesión del proveedor ha caducado.")
    item = next((entry for entry in listing.get("all", []) if entry.get("id") == provider), {})
    return sorted(key for key in item.get("models", {}) if re.fullmatch(r"[a-zA-Z0-9._:/-]{1,150}", key))


async def classify(config: dict, prompt: str) -> str:
    from .agent import GROQ_SYSTEM_PROMPT
    user_id, provider = config["user_id"], config["provider"]
    row = connection(provider, user_id)
    if config["model"] not in await models(provider, user_id):
        raise ValueError("El modelo no está disponible en la suscripción.")
    current = connection(provider, user_id)
    if not current or current["status"] != "connected" or current["flow_id"] != row["flow_id"]:
        raise ValueError("La conexión cambió.")
    account = scope(user_id, provider, row["flow_id"])
    session = await bridge("POST", "/session", {"title": "Clasificación administrativa", "permission": [{"permission": "*", "pattern": "*", "action": "deny"}]}, account=account)
    sid = quote(session["id"], safe="")
    try:
        result = await bridge("POST", f"/session/{sid}/message", {
            "model": {"providerID": provider, "modelID": config["model"]},
            "agent": "vigilia-classifier", "system": GROQ_SYSTEM_PROMPT,
            "tools": {"*": False}, "parts": [{"type": "text", "text": prompt}],
        }, timeout=60, account=account)
        if result.get("info", {}).get("error") or result.get("info", {}).get("finish") not in {"stop", "end_turn"}:
            raise ValueError("El modelo no completó la clasificación.")
        return "".join(part.get("text", "") for part in result.get("parts", []) if part.get("type") == "text")
    finally:
        try:
            await bridge("POST", f"/session/{sid}/abort", account=account)
        finally:
            await bridge("DELETE", f"/session/{sid}", account=account)
