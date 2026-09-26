"""Listado filtrado y resumen operativo usados por la interfaz."""
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import db, employees, main
from app.main import app
from auth_helpers import authenticate_demo


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "ingress-queries.db"))
    monkeypatch.setenv("VIGILIA_SEED_DEMO", "true")
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    with TestClient(app) as instance:
        authenticate_demo(instance)
        main._hits.clear()
        yield instance


def submit(client, event_id, cedula="8-100-100", hospital="Hospital Santo Tomás", reason="Fractura de muñeca por caída"):
    response = client.post("/webhook/ingreso", json={
        "evento_id": event_id,
        "cedula": cedula,
        "hospital": hospital,
        "motivo_ingreso": reason,
        "fecha_ingreso": datetime.now().astimezone().isoformat(),
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_listing_requires_session_and_permission(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "anonymous.db"))
    with TestClient(app) as anonymous:
        assert anonymous.get("/ingresos/listado").status_code == 401
        assert anonymous.get("/ingresos/resumen").status_code == 401


def test_listing_paginates_filters_and_masks_identity(client):
    submit(client, "OPS-1", cedula="8-100-100", hospital="Hospital Santo Tomás")
    submit(client, "OPS-2", cedula="8-200-200", hospital="Clínica del Pacífico", reason="Dolor torácico")
    submit(client, "OPS-3", cedula="9-999-999", hospital="Hospital Santo Tomás", reason="Dolor torácico")
    submit(client, "ING-DEMO-1", cedula="8-100-100")
    with db.conexion() as connection:  # mismo segundo de creación: se fija un orden explícito
        for minutes, event_id in ((3, "OPS-1"), (2, "OPS-2"), (1, "OPS-3")):
            moment = datetime.now(timezone.utc) - timedelta(minutes=minutes)
            connection.execute("UPDATE ingresos SET creado_en = ? WHERE evento_id = ?", (db.timestamp_param(moment), event_id))

    body = client.get("/ingresos/listado?limite=2").json()
    assert body["total"] == 3  # los escenarios del simulador quedan fuera
    assert body["pagina"] == 1 and len(body["items"]) == 2
    second = client.get("/ingresos/listado?limite=2&pagina=2").json()
    assert [item["evento_id"] for item in second["items"]] == ["OPS-1"]

    item = second["items"][0]
    assert item["hospital"] == "Hospital Santo Tomás"
    assert item["motivo"] == "Fractura de muñeca por caída"
    assert item["cedula_mascara"] == "•••-100"
    assert "cedula" not in item
    assert datetime.fromisoformat(item["creado_en"]).tzinfo is not None

    assert client.get("/ingresos/listado?incluir_pruebas=true").json()["total"] == 4
    assert {i["evento_id"] for i in client.get("/ingresos/listado?q=pac%C3%ADfico").json()["items"]} == {"OPS-2"}
    assert {i["evento_id"] for i in client.get("/ingresos/listado?q=9-999-999").json()["items"]} == {"OPS-3"}
    assert client.get("/ingresos/listado?q=100%25").json()["total"] == 0  # comodines escapados
    assert {i["evento_id"] for i in client.get("/ingresos/listado?veredicto=NO_ENCONTRADO").json()["items"]} == {"OPS-3"}
    assert client.get("/ingresos/listado?veredicto=INVENTADO").status_code == 422

    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert client.get("/ingresos/listado", params={"desde": future}).json()["total"] == 0
    assert client.get("/ingresos/listado", params={"hasta": future}).json()["total"] == 3


def test_pending_review_filter_and_summary(client):
    first = submit(client, "REV-1", cedula="8-100-100")
    submit(client, "REV-2", cedula="9-999-999", reason="Dolor torácico")
    assert first["preexistencias"], "el caso 8-100-100 trae antecedentes para revisar"

    pending = client.get("/ingresos/listado?revision_pendiente=true").json()
    assert [item["evento_id"] for item in pending["items"]] == ["REV-1"]
    assert pending["items"][0]["revision_pendiente"] is True

    summary = client.get("/ingresos/resumen").json()
    assert summary["hoy"]["total"] == 2
    assert summary["ultimas_24h"] == 2
    assert summary["hoy"]["por_veredicto"]["NO_ENCONTRADO"] == 1
    assert summary["revision_pendiente"] == 1
    assert summary["avisos_hoy"]["internos"] == 4  # dos avisos por ingreso por el canal interno de demo

    for index, _ in enumerate(first["preexistencias"]):
        response = client.post(f"/ingresos/REV-1/clasificaciones/{index}/revision",
                               json={"relation": "NINGUNA", "reason": "Revisado con el expediente"})
        assert response.status_code == 200, response.text
    assert client.get("/ingresos/resumen").json()["revision_pendiente"] == 0
    assert client.get("/ingresos/listado?revision_pendiente=true").json()["total"] == 0

    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert client.get("/ingresos/resumen", params={"inicio_dia": tomorrow}).json()["hoy"]["total"] == 0


def test_receptionist_can_read_listing_but_not_audit(client):
    submit(client, "REC-1")
    client.post("/auth/logout", json={})
    options = client.get("/auth/options").json()
    client.headers["x-csrf-token"] = options["csrf_token"]
    code = employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30))
    login = client.post("/auth/employee/login", json={"employee_id": "EMP-REC-001", "code": code})
    assert login.status_code == 200, login.text
    assert client.get("/ingresos/listado").json()["total"] == 1
    assert client.get("/ingresos/resumen").status_code == 200
    assert client.get("/admin/audit").status_code == 403


def test_audit_supports_offset_and_action_prefix(client):
    submit(client, "AUD-1")
    first_page = client.get("/admin/audit?limit=1").json()
    assert len(first_page) == 1
    receive = client.get("/admin/audit?accion=ingress.receive").json()
    assert receive and all(item["action"] == "ingress.receive" for item in receive)
    assert client.get("/admin/audit?accion=a_b%25").json() == []


def test_messages_use_readable_labels(client):
    data = submit(client, "MSG-1", cedula="9-999-999", reason="Dolor torácico")
    combined = data["mensaje_admisiones"] + data["mensaje_gestor"]
    assert "NO_ENCONTRADO" not in combined and "[MEDIO]" not in combined
    assert "No encontrado" in combined and "Revisión administrativa" in combined
    with db.conexion() as connection:
        stored = connection.execute("SELECT respuesta_json FROM ingresos WHERE evento_id = 'MSG-1'").fetchone()
    assert json.loads(stored["respuesta_json"])["mensaje_admisiones"] == data["mensaje_admisiones"]
