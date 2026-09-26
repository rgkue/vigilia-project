"""OIDC authorization-code flow backed by an HttpOnly signed session cookie."""
from __future__ import annotations

import os
import secrets
import time
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from . import security, access
from .audit import record
from .db import database_mode

router = APIRouter(prefix="/auth", tags=["authentication"])
oauth = None

try:
    from authlib.integrations.starlette_client import OAuth

    oauth = OAuth()
    security.register_oidc(oauth)
except ImportError:  # pragma: no cover - surfaced as a clear 503 by auth routes
    oauth = None


@router.get("/login", name="oidc_login")
async def login(request: Request):
    if database_mode() == "demo":
        raise HTTPException(400, "Usa el acceso administrativo simulado de la demo.")
    if oauth is None or not security.oidc_enabled():
        raise HTTPException(status_code=503, detail="El inicio de sesión OIDC no está configurado.")
    client = oauth.create_client("vigilia_oidc")
    if client is None:
        raise HTTPException(status_code=503, detail="El proveedor OIDC no está disponible.")
    callback = os.getenv("OIDC_REDIRECT_URL") or str(request.url_for("oidc_callback"))
    intent = request.session.pop("qr_intent", {})
    if not intent or intent.get("expires", 0) < time.time():
        if not access.bootstrap_available():
            raise HTTPException(403, "Escanea tu QR para iniciar sesión.")
        intent = {"expires": int(time.time()) + 300}
    response = await client.authorize_redirect(request, callback)
    state = parse_qs(urlsplit(response.headers["location"]).query).get("state", [None])[0]
    if not state:
        raise HTTPException(503, "No se pudo iniciar el acceso corporativo.")
    request.session["oidc_qr_flow"] = {**intent, "state": state}
    return response


@router.get("/callback", name="oidc_callback")
async def callback(request: Request):
    if oauth is None:
        raise HTTPException(status_code=503, detail="El inicio de sesión OIDC no está configurado.")
    client = oauth.create_client("vigilia_oidc")
    intent = request.session.pop("oidc_qr_flow", {})
    if not intent.get("state") or not secrets.compare_digest(str(intent["state"]), request.query_params.get("state", "")):
        raise HTTPException(401, "El acceso caducó. Escanea tu QR de nuevo.")
    try:
        token = await client.authorize_access_token(request)
        claims = token.get("userinfo") or {}
        access.complete_oidc(request, dict(claims), intent)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="No se pudo validar el inicio de sesión.") from exc
    frontend_origin = (os.getenv("OIDC_FRONTEND_ORIGIN") or "").strip().rstrip("/")
    return RedirectResponse(url=f"{frontend_origin}/resumen" if frontend_origin else "/resumen", status_code=303)


@router.get("/me")
def me(request: Request):
    profile = security.current_profile(request, allow_pending_password=True)
    csrf = security.create_csrf_token(request)
    return {"user": profile, "csrf_token": csrf, "mode": database_mode()}


@router.post("/logout")
def logout(request: Request, x_csrf_token: str | None = None):
    security.require_csrf(request, request.headers.get("x-csrf-token") or x_csrf_token)
    try:
        profile = security.current_profile(request, allow_pending_password=True)
    except HTTPException as exc:
        if exc.status_code != 401:
            raise
    else:
        record(profile["id"], "auth.logout", "user", profile["id"])
    request.session.clear()
    return {"ok": True}
