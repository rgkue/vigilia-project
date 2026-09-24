import json
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader

from . import agent, rules
from .db import conexion, init_db
from .notifier import notificar_en_paralelo
from .schemas import EventoIngreso, RespuestaIngreso

# --- Protección del webhook -------------------------------------------------
# 1) Límite de solicitudes por IP (evita spam a Slack y abuso del cupo del modelo).
# 2) Clave OPCIONAL: solo se exige si existe la variable VIGILIA_KEY.
VENTANA_SEG = 60
MAX_POR_VENTANA = 20
_hits: dict[str, deque] = defaultdict(deque)
_clave = APIKeyHeader(name="X-Vigilia-Key", auto_error=False, description="Opcional: solo si el servidor la exige")


def limitar(request: Request) -> None:
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "?")
    ahora = time.monotonic()
    if len(_hits) > 10_000:
        _hits.clear()
    q = _hits[ip]
    while q and ahora - q[0] > VENTANA_SEG:
        q.popleft()
    if len(q) >= MAX_POR_VENTANA:
        raise HTTPException(status_code=429, detail="Demasiadas solicitudes, espera un minuto")
    q.append(ahora)


def exigir_clave(k: str | None = Security(_clave)) -> None:
    esperada = os.getenv("VIGILIA_KEY", "")
    if not esperada:
        return  # sin clave configurada: acceso abierto (modo demostración)
    if not k or not secrets.compare_digest(k.encode(), esperada.encode()):
        raise HTTPException(status_code=401, detail="Clave inválida")


PROTEGIDO = [Depends(limitar), Depends(exigir_clave)]


# --- Aplicación -------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Vigilia", description="Alerta temprana de ingresos a emergencias", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/webhook/ingreso", response_model=RespuestaIngreso, dependencies=PROTEGIDO)
async def ingreso(ev: EventoIngreso):
    with conexion() as c:
        aseg = c.execute("SELECT * FROM asegurados WHERE cedula = ?", (ev.cedula,)).fetchone()
        pol = c.execute("SELECT * FROM polizas WHERE cedula = ? ORDER BY vigente_hasta DESC LIMIT 1", (ev.cedula,)).fetchone()
        pre = [dict(r) for r in c.execute("SELECT * FROM preexistencias WHERE cedula = ?", (ev.cedula,))]

    poliza = rules.evaluar_poliza(pol, ev.fecha_ingreso.date()) if (aseg and pol) else None
    rel = await agent.relacionar_preexistencias(ev, pre) if poliza else []
    veredicto, nivel = rules.decidir(poliza, rel)
    msgs = await agent.redactar_mensajes(ev, aseg["nombre"] if aseg else None, poliza, veredicto, nivel, rel)
    notifs = await notificar_en_paralelo(msgs.admisiones, msgs.gestor)

    resp = RespuestaIngreso(evento_id=ev.evento_id, veredicto=veredicto, nivel_alerta=nivel, poliza=poliza,
                            preexistencias=rel, mensaje_admisiones=msgs.admisiones,
                            mensaje_gestor=msgs.gestor, notificaciones=notifs)
    with conexion() as c:
        c.execute("INSERT OR REPLACE INTO ingresos (evento_id, cedula, hospital, motivo, veredicto, nivel_alerta, respuesta_json) VALUES (?,?,?,?,?,?,?)",
                  (ev.evento_id, ev.cedula, ev.hospital, ev.motivo_ingreso, veredicto, nivel, resp.model_dump_json()))
        for n, m in zip(notifs, (msgs.admisiones, msgs.gestor)):
            c.execute("INSERT INTO notificaciones (evento_id, destino, canal, estado, mensaje) VALUES (?,?,?,?,?)",
                      (ev.evento_id, n.destino, n.canal, n.estado, m))
    return resp


@app.get("/ingresos", dependencies=PROTEGIDO)
def ultimos_ingresos(limite: int = 20):
    limite = max(1, min(limite, 100))
    with conexion() as c:
        rows = c.execute("SELECT respuesta_json, creado_en FROM ingresos ORDER BY creado_en DESC LIMIT ?", (limite,)).fetchall()
    return [{"creado_en": r["creado_en"], **json.loads(r["respuesta_json"])} for r in rows]
