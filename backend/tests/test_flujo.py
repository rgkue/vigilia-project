import os
import tempfile

os.environ["VIGILIA_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
for k in ("VIGILIA_KEY", "SLACK_WEBHOOK_ADMISIONES", "SLACK_WEBHOOK_GESTOR", "GROQ_API_KEY"):
    os.environ[k] = ""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app

CASOS = [  # cédula, veredicto esperado
    ("8-100-100", "VALIDA"), ("8-200-200", "NO_VALIDA"), ("8-300-300", "VALIDA_CON_ALERTAS"),
    ("8-500-500", "VALIDA_CON_ALERTAS"), ("9-999-999", "NO_ENCONTRADO"),
]


def evento(i, cedula, motivo="Dolor torácico"):
    return {"evento_id": f"T-{i}", "cedula": cedula, "hospital": "H",
            "motivo_ingreso": motivo, "fecha_ingreso": "2026-09-24T10:00:00-05:00"}


@pytest.fixture(autouse=True)
def limpiar_limite():
    main._hits.clear()


def test_casos():
    with TestClient(app) as c:
        for i, (ced, esperado) in enumerate(CASOS):
            r = c.post("/webhook/ingreso", json=evento(i, ced))
            assert r.status_code == 200, r.text
            assert r.json()["veredicto"] == esperado, (ced, r.json())
            assert {n["estado"] for n in r.json()["notificaciones"]} == {"ENVIADA"}
        assert len(c.get("/ingresos").json()) == len(CASOS)


def test_clave_opcional(monkeypatch):
    with TestClient(app) as c:
        assert c.post("/webhook/ingreso", json=evento(1, "8-100-100")).status_code == 200  # abierto
        monkeypatch.setenv("VIGILIA_KEY", "secreta")
        assert c.post("/webhook/ingreso", json=evento(2, "8-100-100")).status_code == 401
        h = {"X-Vigilia-Key": "secreta"}
        assert c.post("/webhook/ingreso", json=evento(3, "8-100-100"), headers=h).status_code == 200


def test_limite_de_solicitudes():
    with TestClient(app) as c:
        codigos = [c.post("/webhook/ingreso", json=evento(i, "8-100-100")).status_code
                   for i in range(main.MAX_POR_VENTANA + 1)]
        assert codigos[:-1] == [200] * main.MAX_POR_VENTANA and codigos[-1] == 429


def test_entrada_invalida():
    with TestClient(app) as c:
        assert c.post("/webhook/ingreso", json=evento(1, "8-100-100", motivo="x" * 400)).status_code == 422
