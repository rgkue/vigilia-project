import asyncio
import json

import pytest

from app import agent
from app.schemas import EventoIngreso

PRE = [{"condicion": "Hipertensión arterial"}, {"condicion": "Diabetes mellitus tipo 2"}]


def ev(motivo):
    return EventoIngreso(evento_id="A-1", cedula="8-400-400", hospital="H", motivo_ingreso=motivo,
                         fecha_ingreso="2026-09-24T10:00:00-05:00")


def correr(motivo, pre=PRE):
    return asyncio.run(agent.relacionar_preexistencias(ev(motivo), pre))


def test_reglas_detectan_relacion():
    assert {r.relacion for r in correr("Dolor torácico opresivo")} == {"POSIBLE"}


def test_reglas_sin_relacion():
    assert {r.relacion for r in correr("Fractura de muñeca por caída")} == {"NINGUNA"}


def test_sin_preexistencias():
    assert correr("Dolor torácico", pre=[]) == []


class _Resp:
    def __init__(self, contenido): self.contenido = contenido
    def raise_for_status(self): pass
    def json(self): return {"choices": [{"message": {"content": self.contenido}}]}


def _falso_cliente(contenido):
    class C:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **k): return _Resp(contenido)
    return lambda **kw: C()


def test_usa_ia_cuando_responde_bien(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    respuesta = json.dumps({"preexistencias": [
        {"condicion": "Hipertensión arterial", "relacion": "DIRECTA", "justificacion": "dolor torácico e hipertensión"},
        {"condicion": "Diabetes mellitus tipo 2", "relacion": "POSIBLE", "justificacion": "riesgo cardiovascular"}]})
    monkeypatch.setattr(agent.httpx, "AsyncClient", _falso_cliente(respuesta))
    r = correr("Dolor torácico opresivo")
    assert [x.relacion for x in r] == ["DIRECTA", "POSIBLE"] and r[0].justificacion.startswith("IA:")


@pytest.mark.parametrize("basura", ["no es json", '{"preexistencias": "x"}',
                                    '{"preexistencias":[{"condicion":"Hipertensión arterial","relacion":"MUY GRAVE"}]}'])
def test_respuesta_invalida_cae_a_reglas(monkeypatch, basura):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    monkeypatch.setattr(agent.httpx, "AsyncClient", _falso_cliente(basura))
    r = correr("Dolor torácico opresivo")
    assert len(r) == 2 and all(x.justificacion.startswith("Reglas:") for x in r)


def test_slack_escapa_menciones():
    from app.schemas import PolizaInfo
    p = PolizaInfo(numero="P", plan="X", vigente=True, al_dia_pago=True, en_carencia=False)
    m = asyncio.run(agent.redactar_mensajes(ev("<!channel> urgente <https://malo.com|clic>"), "Ana", p, "VALIDA", "BAJO", []))
    assert "<!channel>" not in m.admisiones and "<https" not in m.gestor and "&lt;!channel&gt;" in m.admisiones
