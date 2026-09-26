"""Expose Vigilia's FastAPI app through Vercel's /api function route."""
from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

from backend.app.main import app as vigilia_app


class VercelApiPrefixMiddleware:
    """Translate Vercel's /api/* function path to Vigilia's existing routes."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        normalized = dict(scope)
        path = str(scope.get("path", "/"))
        raw_path = scope.get("raw_path")
        if not isinstance(raw_path, bytes):
            raw_path = path.encode("utf-8")
        if path == "/api":
            normalized["path"] = "/"
            normalized["raw_path"] = b"/"
        elif path.startswith("/api/"):
            normalized["path"] = path[4:]
            normalized["raw_path"] = raw_path[4:] if raw_path.startswith(b"/api/") else normalized["path"].encode("utf-8")

        # Keep generated callback URLs under /api while route matching sees the original paths.
        normalized["root_path"] = "/api"
        await self.app(normalized, receive, send)


vigilia_app.add_middleware(VercelApiPrefixMiddleware)
app = vigilia_app
