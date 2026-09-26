"""Notificaciones simultáneas; sin webhooks configurados se simulan en el log."""
import asyncio
import logging
import os

import httpx

from .connectors import get_integration, _secret_headers
from .db import database_mode, conexion
from .schemas import Notificacion

logger = logging.getLogger(__name__)
VARIABLES = {"admisiones": "SLACK_WEBHOOK_ADMISIONES", "gestor_casos": "SLACK_WEBHOOK_GESTOR"}


async def _enviar(destino: str, texto: str, event_id: str | None = None, verdict: str | None = None,
                  level: str | None = None, review_pending: bool = False) -> Notificacion:
    if database_mode() == "production":
        kind = "admissions" if destino == "admisiones" else "case_manager"
        config = get_integration(kind)
        if not config:
            return Notificacion(destino=destino, canal="sin configurar", estado="NO_CONFIGURADA")
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                response = await client.post(
                    config["endpoint_url"],
                    json={"event_id": event_id, "verdict": verdict, "alert_level": level,
                          "review_pending": review_pending, "message": texto},
                    headers=_secret_headers(config),
                )
                response.raise_for_status()
            with conexion() as connection:
                connection.execute(
                    "UPDATE integration_configs SET status = 'connected', last_checked_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?",
                    (config["id"],),
                )
            return Notificacion(destino=destino, canal=kind, estado="ENVIADA")
        except (httpx.HTTPError, RuntimeError) as exc:
            with conexion() as connection:
                connection.execute(
                    "UPDATE integration_configs SET status = 'unavailable', last_checked_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
                    (type(exc).__name__, config["id"]),
                )
            logger.warning("No se pudo enviar el aviso a %s (%s).", destino, type(exc).__name__)
            return Notificacion(destino=destino, canal=kind, estado="ERROR")

    url = os.getenv(VARIABLES[destino])
    enabled = os.getenv("SLACK_ENABLED", "false").strip().lower() == "true"
    if not enabled or not url:
        logger.info("Notificación simulada para %s.", destino)
        return Notificacion(destino=destino, canal="log", estado="ENVIADA")
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            (await client.post(url, json={"text": texto})).raise_for_status()
        return Notificacion(destino=destino, canal="slack", estado="ENVIADA")
    except httpx.HTTPError as exc:
        logger.warning("No se pudo enviar el aviso a %s (%s).", destino, type(exc).__name__)
        return Notificacion(destino=destino, canal="slack", estado="ERROR")


async def notificar_en_paralelo(msg_admisiones: str, msg_gestor: str, *, event_id: str | None = None,
                                verdict: str | None = None, level: str | None = None,
                                review_pending: bool = False) -> list[Notificacion]:
    return list(
        await asyncio.gather(
            _enviar("admisiones", msg_admisiones, event_id, verdict, level, review_pending),
            _enviar("gestor_casos", msg_gestor, event_id, verdict, level, review_pending),
        )
    )
