"""OIDC authorization-code flow backed by an HttpOnly signed session cookie."""
from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from . import security
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
        return RedirectResponse(url="/resumen", status_code=303)
    if oauth is None or not security.oidc_enabled():
        raise HTTPException(status_code=503, detail="El inicio de sesión OIDC no está configurado.")
    client = oauth.create_client("vigilia_oidc")
    if client is None:
        raise HTTPException(status_code=503, detail="El proveedor OIDC no está disponible.")
    callback = os.getenv("OIDC_REDIRECT_URL") or str(request.url_for("oidc_callback"))
    return await client.authorize_redirect(request, callback)


@router.get("/callback", name="oidc_callback")
async def callback(request: Request):
    if oauth is None:
        raise HTTPException(status_code=503, detail="El inicio de sesión OIDC no está configurado.")
    client = oauth.create_client("vigilia_oidc")
    try:
        token = await client.authorize_access_token(request)
        claims = token.get("userinfo") or {}
        profile = security.resolve_oidc_profile(dict(claims))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="No se pudo validar el inicio de sesión.") from exc
    request.session.clear()
    request.session["user_id"] = profile["id"]
    request.session["csrf_token"] = secrets.token_urlsafe(32)
    record(profile["id"], "auth.login", "user", profile["id"])
    frontend_origin = (os.getenv("OIDC_FRONTEND_ORIGIN") or "").strip().rstrip("/")
    return RedirectResponse(url=f"{frontend_origin}/resumen" if frontend_origin else "/resumen", status_code=303)


@router.get("/me")
def me(request: Request):
    profile = security.current_profile(request)
    csrf = security.create_csrf_token(request)
    return {"user": profile, "csrf_token": csrf, "mode": database_mode()}


@router.post("/logout")
def logout(request: Request, x_csrf_token: str | None = None):
    profile = security.current_profile(request)
    security.require_csrf(request, request.headers.get("x-csrf-token") or x_csrf_token)
    record(profile["id"], "auth.logout", "user", profile["id"])
    request.session.clear()
    return {"ok": True}
