import json
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader

from . import agent, rules
from .db import conexion, init_db
from .notifier import notificar_en_paralelo
from .schemas import EventoIngreso, RespuestaIngreso

VENTANA_SEG = 60
MAX_POR_VENTANA = 20
_hits: dict[str, deque] = defaultdict(deque)
_clave = APIKeyHeader(name="X-Vigilia-Key", auto_error=False, description="Opcional: solo si el servidor la exige")


def limitar(request: Request) -> None:
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "?"
    )
    ahora = time.monotonic()
    if len(_hits) > 10_000:
        _hits.clear()
    hits = _hits[ip]
    while hits and ahora - hits[0] > VENTANA_SEG:
        hits.popleft()
    if len(hits) >= MAX_POR_VENTANA:
        raise HTTPException(status_code=429, detail="Demasiadas solicitudes, espera un minuto")
    hits.append(ahora)


def exigir_clave(key: str | None = Security(_clave)) -> None:
    expected = os.getenv("VIGILIA_KEY", "")
    if not expected:
        return
    if not key or not secrets.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Clave inválida")


PROTEGIDO = [Depends(limitar), Depends(exigir_clave)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Vigilia", description="Alerta temprana de ingresos a emergencias", lifespan=lifespan)
allowed_origins = [
    origin.strip()
    for origin in os.getenv("VIGILIA_CORS_ORIGINS", "http://127.0.0.1:5173").split(",")
    if origin.strip()
]
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/webhook/ingreso", response_model=RespuestaIngreso, dependencies=PROTEGIDO)
async def ingreso(ev: EventoIngreso):
    with conexion() as connection:
        asegurado = connection.execute("SELECT * FROM asegurados WHERE cedula = ?", (ev.cedula,)).fetchone()
        poliza_row = connection.execute(
            "SELECT * FROM polizas WHERE cedula = ? ORDER BY vigente_hasta DESC LIMIT 1",
            (ev.cedula,),
        ).fetchone()
        preexistencias = [
            dict(row)
            for row in connection.execute("SELECT * FROM preexistencias WHERE cedula = ?", (ev.cedula,))
        ]

    poliza = rules.evaluar_poliza(poliza_row, ev.fecha_ingreso.date()) if (asegurado and poliza_row) else None
    relaciones = await agent.relacionar_preexistencias(ev, preexistencias) if poliza else []
    veredicto, nivel = rules.decidir(poliza, relaciones)
    mensajes = await agent.redactar_mensajes(
        ev,
        asegurado["nombre"] if asegurado else None,
        poliza,
        veredicto,
        nivel,
        relaciones,
    )
    notificaciones = await notificar_en_paralelo(mensajes.admisiones, mensajes.gestor)

    respuesta = RespuestaIngreso(
        evento_id=ev.evento_id,
        veredicto=veredicto,
        nivel_alerta=nivel,
        poliza=poliza,
        preexistencias=relaciones,
        mensaje_admisiones=mensajes.admisiones,
        mensaje_gestor=mensajes.gestor,
        notificaciones=notificaciones,
    )
    with conexion() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO ingresos "
            "(evento_id, cedula, hospital, motivo, veredicto, nivel_alerta, respuesta_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                ev.evento_id,
                ev.cedula,
                ev.hospital,
                ev.motivo_ingreso,
                veredicto,
                nivel,
                respuesta.model_dump_json(),
            ),
        )
        for notification, message in zip(notificaciones, (mensajes.admisiones, mensajes.gestor)):
            connection.execute(
                "INSERT INTO notificaciones (evento_id, destino, canal, estado, mensaje) VALUES (?, ?, ?, ?, ?)",
                (ev.evento_id, notification.destino, notification.canal, notification.estado, message),
            )
    return respuesta


@app.get("/ingresos", dependencies=PROTEGIDO)
def ultimos_ingresos(limite: int = 20):
    limite = max(1, min(limite, 100))
    with conexion() as connection:
        rows = connection.execute(
            "SELECT respuesta_json, creado_en FROM ingresos ORDER BY creado_en DESC LIMIT ?",
            (limite,),
        ).fetchall()
    return [{"creado_en": row["creado_en"], **json.loads(row["respuesta_json"])} for row in rows]
