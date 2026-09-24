"""Notificaciones simultáneas a Slack. Sin variable de entorno => modo simulado (log)."""
import asyncio
import os

import httpx

from .schemas import Notificacion

VARIABLES = {"admisiones": "SLACK_WEBHOOK_ADMISIONES", "gestor_casos": "SLACK_WEBHOOK_GESTOR"}


async def _enviar(destino: str, texto: str) -> Notificacion:
    url = os.getenv(VARIABLES[destino])
    if not url:
        print(f"[SIMULADO -> {destino}] {texto}")
        return Notificacion(destino=destino, canal="log", estado="ENVIADA")
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            (await c.post(url, json={"text": texto})).raise_for_status()
        return Notificacion(destino=destino, canal="slack", estado="ENVIADA")
    except Exception as e:
        print(f"[ERROR Slack {destino}] {e}")
        return Notificacion(destino=destino, canal="slack", estado="ERROR")


async def notificar_en_paralelo(msg_admisiones: str, msg_gestor: str) -> list[Notificacion]:
    return list(await asyncio.gather(_enviar("admisiones", msg_admisiones), _enviar("gestor_casos", msg_gestor)))
