"""Notificaciones simultáneas; sin webhooks configurados se simulan en el log."""
import asyncio
import logging
import os

import httpx

from .schemas import Notificacion

logger = logging.getLogger(__name__)
VARIABLES = {"admisiones": "SLACK_WEBHOOK_ADMISIONES", "gestor_casos": "SLACK_WEBHOOK_GESTOR"}


async def _enviar(destino: str, texto: str) -> Notificacion:
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


async def notificar_en_paralelo(msg_admisiones: str, msg_gestor: str) -> list[Notificacion]:
    return list(
        await asyncio.gather(
            _enviar("admisiones", msg_admisiones),
            _enviar("gestor_casos", msg_gestor),
        )
    )
