"""Flujos de la entrega: IA compartida en demo, revisión que recalcula, reintentos e
instalación de producción de muestra (cuentas del jurado y sistemas externos simulados)."""
import json
import time
from datetime import datetime

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import agent, ai_providers, db, employees, main, provisioning, simulated
from app.main import app
from auth_helpers import authenticate_demo

JURY_ADMIN_TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
JURY_EMPLOYEE_TOTP = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU"
JURY_PASSWORD = "Evaluacion-Jurado-2026"
JURY_TOKEN = "vig_" + "t" * 40
RELATIONS = {"Asma leve": "DIRECTA", "Hipertensión arterial": "POSIBLE", "Diabetes mellitus tipo 2": "NINGUNA"}


async def fake_classify(config, motive, conditions):
    """Doble del proveedor: devuelve el formato real del modelo para cada antecedente."""
    content = json.dumps({"preexistencias": [
        {"condicion": condition, "relacion": RELATIONS.get(condition, "NINGUNA"), "justificacion": "Relación observada entre los textos"}
        for condition in conditions
    ]})
    return agent._normalize_groq({"choices": [{"message": {"content": content}}]}, conditions, provider_name="Ollama")


def ingress(event_id, cedula="8-100-100", reason="Crisis asmática con dificultad respiratoria"):
    return {"evento_id": event_id, "cedula": cedula, "hospital": "Hospital de prueba", "motivo_ingreso": reason,
            "fecha_ingreso": datetime.now().astimezone().isoformat()}


@pytest.fixture
def demo(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "entrega-demo.db"))
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("VIGILIA_SHARED_AI_KEY", "clave-ficticia-del-equipo")
    monkeypatch.setattr(ai_providers, "classify", fake_classify)
    with TestClient(app) as client:
        authenticate_demo(client)
        main._hits.clear()
        yield client


def test_demo_webhook_uses_shared_ai_and_reports_simulated_notices(demo):
    with db.conexion() as connection:
        config = connection.execute("SELECT * FROM user_ai_configs WHERE user_id='demo-admin'").fetchone()
        selected = connection.execute("SELECT provider FROM user_ai_selection WHERE user_id='demo-admin'").fetchone()
    assert config["provider"] == "ollama" and config["status"] == "verified" and config["model"] == "gpt-oss:20b"
    assert "clave-ficticia" not in config["encrypted_secret"] and selected["provider"] == "ollama"

    # Un sistema externo (sin sesión) envía el ingreso con la clave opcional de demo.
    with TestClient(app) as external:
        data = external.post("/webhook/ingreso", json=ingress("DEMO-IA-1")).json()
    relation = data["preexistencias"][0]
    assert relation["relacion"] == "DIRECTA" and relation["relacion_sugerida"] == "DIRECTA"
    assert relation["justificacion"].startswith("Ollama sugiere directa")
    # La IA solo sugiere: hasta la revisión humana el caso queda en revisión administrativa.
    assert (data["veredicto"], data["nivel_alerta"]) == ("VALIDA_CON_ALERTAS", "MEDIO")
    assert {item["estado"] for item in data["notificaciones"]} == {"SIMULADA"}


def test_review_recalculates_outcome_and_notifies_again(demo):
    demo.post("/webhook/ingreso", json=ingress("DEMO-REV-1"))
    review = demo.post("/ingresos/DEMO-REV-1/clasificaciones/0/revision",
                       json={"relation": "DIRECTA", "reason": "Confirmada con el expediente del asegurado."})
    assert review.status_code == 200, review.text
    body = review.json()
    assert body["resultado_actualizado"] and (body["veredicto"], body["nivel_alerta"]) == ("VALIDA_CON_ALERTAS", "ALTO")

    entry = demo.get("/ingresos/listado?q=DEMO-REV-1").json()["items"][0]
    assert entry["nivel_alerta"] == "ALTO" and entry["revision_pendiente"] is False
    update = entry["actualizaciones"][0]
    assert (update["nivel_anterior"], update["nivel_alerta"]) == ("MEDIO", "ALTO")
    assert update["mensaje_admisiones"].startswith("Actualización tras revisión humana")
    assert {item["destino"] for item in update["notificaciones"]} == {"admisiones", "gestor_casos"}

    # Una revisión que no cambia el resultado no vuelve a avisar.
    again = demo.post("/ingresos/DEMO-REV-1/clasificaciones/0/revision",
                      json={"relation": "DIRECTA", "reason": "Segunda confirmación del mismo antecedente."}).json()
    assert again["resultado_actualizado"] is False
    assert len(demo.get("/ingresos/listado?q=DEMO-REV-1").json()["items"][0]["actualizaciones"]) == 1


def test_failed_event_can_be_retried_with_the_same_data(demo, monkeypatch):
    calls = {"count": 0}
    original = main._process_event

    async def flaky(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("fallo transitorio de prueba")
        return await original(*args, **kwargs)

    monkeypatch.setattr(main, "_process_event", flaky)
    event = ingress("DEMO-RETRY-1")
    with TestClient(app, raise_server_exceptions=False) as external:
        assert external.post("/webhook/ingreso", json=event).status_code == 500
        retried = external.post("/webhook/ingreso", json=event)
        assert retried.status_code == 200, retried.text
        # Mismo identificador con otros datos sigue rechazado.
        assert external.post("/webhook/ingreso", json={**event, "motivo_ingreso": "Otro motivo distinto"}).status_code == 409


def test_stale_processing_event_is_recovered(demo):
    event = ingress("DEMO-STALE-1")
    assert main._reserve_event(main.EventoIngreso.model_validate(event), main._event_hash(main.EventoIngreso.model_validate(event)))
    with TestClient(app) as external:
        assert external.post("/webhook/ingreso", json=event).status_code == 409  # sigue en proceso
        with db.conexion() as connection:
            connection.execute("UPDATE ingresos SET creado_en = '2000-01-01 00:00:00' WHERE evento_id = 'DEMO-STALE-1'")
        assert external.post("/webhook/ingreso", json=event).status_code == 200


# --- Instalación de producción de muestra ---------------------------------------------------------

@pytest.fixture
def production(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")  # SQLite solo se prepara en demo; luego se cambia el modo.
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "entrega-produccion.db"))
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(ai_providers, "classify", fake_classify)
    with TestClient(app) as client:
        monkeypatch.setenv("VIGILIA_MODE", "production")
        for name, value in {
            "VIGILIA_AI_APPROVED": "true", "VIGILIA_SHARED_AI_KEY": "clave-ficticia-del-equipo",
            "VIGILIA_JURY_ADMIN_TOTP": JURY_ADMIN_TOTP, "VIGILIA_JURY_ADMIN_PASSWORD": JURY_PASSWORD,
            "VIGILIA_JURY_EMPLOYEE_TOTP": JURY_EMPLOYEE_TOTP, "VIGILIA_JURY_INGRESS_TOKEN": JURY_TOKEN,
            "VIGILIA_SIMULATED_SYSTEMS": "true", "VIGILIA_SIMULATED_BASE_URL": "https://vigilia.test/simulado",
        }.items():
            monkeypatch.setenv(name, value)
        # Las llamadas salientes a los sistemas simulados se atienden en memoria.
        systems = FastAPI()
        systems.include_router(simulated.router)
        transport = httpx.ASGITransport(app=systems)
        original = httpx.AsyncClient
        monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: original(*args, **{**kwargs, "transport": transport}))
        provisioning.apply()
        main._hits.clear()
        with db.conexion() as connection:
            connection.execute("DELETE FROM auth_attempts")
        yield client


def login(client, employee_id, secret, password=None):
    client.cookies.clear()
    options = client.get("/auth/options").json()
    client.headers["x-csrf-token"] = options["csrf_token"]
    code = employees.totp(secret, int(time.time() // 30))
    response = client.post("/auth/employee/login", json={"employee_id": employee_id, "code": code,
                                                          **({"password": password} if password else {})})
    assert response.status_code == 200, response.text
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    return response.json()


def his_event(event_id, cedula="8-100-100", reason="Crisis asmática con dificultad respiratoria"):
    return {"evento": {"id": event_id, "fecha": datetime.now().astimezone().isoformat()}, "paciente": {"cedula": cedula},
            "hospital": {"nombre": "Hospital de prueba"}, "atencion": {"motivo": reason, "triage": 2}}


def jury_headers():
    return {"X-Vigilia-Integration": "sim-ingreso-his", "Authorization": f"Bearer {JURY_TOKEN}"}


def test_production_flow_uses_simulated_insurer_and_jury_accounts(production):
    response = production.post("/webhook/ingreso", json=his_event("PROD-1"), headers=jury_headers())
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["poliza"]["numero"] == "POL-1001" and data["poliza"]["vigente"] is True
    assert {(item["tipo"], item["estado"]) for item in data["fuentes"]} == {("coverage", "connected"), ("history", "connected")}
    assert data["preexistencias"][0]["relacion_sugerida"] == "DIRECTA"
    assert [(item["canal"], item["estado"]) for item in data["notificaciones"]] == [("admissions", "ENVIADA"), ("case_manager", "ENVIADA")]

    missing = production.post("/webhook/ingreso", json=his_event("PROD-2", cedula="9-999-999"), headers=jury_headers()).json()
    assert (missing["veredicto"], missing["nivel_alerta"]) == ("NO_ENCONTRADO", "MEDIO")
    assert production.post("/webhook/ingreso", json=his_event("PROD-3"),
                           headers={**jury_headers(), "Authorization": "Bearer vig_incorrecto"}).status_code == 401

    admin = login(production, "JURADO-ADMIN", JURY_ADMIN_TOTP, JURY_PASSWORD)
    assert admin["user"]["must_change_password"] is False and "users.manage" in admin["user"]["permissions"]
    review = production.post("/ingresos/PROD-1/clasificaciones/0/revision",
                             json={"relation": "DIRECTA", "reason": "Confirmada por el gestor de casos."}).json()
    assert review["nivel_alerta"] == "ALTO" and review["resultado_actualizado"]

    reception = login(production, "JURADO-RECEPCION", JURY_EMPLOYEE_TOTP)
    assert set(reception["user"]["permissions"]) == {"ingress.read", "ingress.submit"}


def test_jury_resources_are_protected_and_self_healing(production):
    login(production, "JURADO-ADMIN", JURY_ADMIN_TOTP, JURY_PASSWORD)
    with db.conexion() as connection:
        rows = connection.execute("SELECT user_id, employee_id, credential_version FROM employees").fetchall()
    ids = {row["employee_id"]: row["user_id"] for row in rows}
    versions = {row["employee_id"]: row["credential_version"] for row in rows}

    assert production.post("/auth/password", json={"current_password": JURY_PASSWORD, "new_password": "Otra-Clave-Distinta-99"}).status_code == 409
    assert production.post(f"/admin/employees/{ids['JURADO-RECEPCION']}/totp").status_code == 409
    assert production.put("/admin/integrations/sim-cobertura", json={
        "kind": "coverage", "name": "x", "endpoint_url": "https://otro.test/api", "field_map": {}}).status_code == 409
    assert production.delete("/admin/integrations/sim-cobertura").status_code == 409
    issued = production.post("/admin/integrations/sim-ingreso-his/credentials")
    assert issued.status_code == 200
    assert production.delete("/admin/integrations/sim-ingreso-his/credentials/sim-ingreso-jurado").status_code == 409
    # Emitir otra credencial no revoca la del jurado.
    assert production.post("/webhook/ingreso", json=his_event("PROD-TOKEN"), headers=jury_headers()).status_code == 200

    # Un nuevo arranque no cierra sesiones si nada cambió, pero restaura lo alterado.
    provisioning.apply()
    with db.conexion() as connection:
        assert {row["employee_id"]: row["credential_version"] for row in connection.execute(
            "SELECT employee_id, credential_version FROM employees").fetchall()} == versions
        connection.execute("UPDATE employees SET password_hash='x', must_change_password=TRUE WHERE user_id=?", (ids["JURADO-ADMIN"],))
        connection.execute("UPDATE user_profiles SET active=FALSE WHERE id=?", (ids["JURADO-RECEPCION"],))
        connection.execute("UPDATE integration_configs SET enabled=FALSE WHERE id='sim-cobertura'")
    provisioning.apply()
    with db.conexion() as connection:
        admin_row = connection.execute("SELECT password_hash, must_change_password FROM employees WHERE user_id=?", (ids["JURADO-ADMIN"],)).fetchone()
        assert admin_row["password_hash"] != "x" and not admin_row["must_change_password"]
        assert connection.execute("SELECT active FROM user_profiles WHERE id=?", (ids["JURADO-RECEPCION"],)).fetchone()["active"]
        assert connection.execute("SELECT enabled FROM integration_configs WHERE id='sim-cobertura'").fetchone()["enabled"]


def test_public_demo_fixture_cannot_sign_in_to_production(production):
    # La base de esta prueba se preparó primero en demo, como una base reutilizada: el fixture existe.
    with db.conexion() as connection:
        fixture = connection.execute(
            "SELECT p.active FROM employees e JOIN user_profiles p ON p.id=e.user_id WHERE e.employee_id='EMP-REC-001'").fetchone()
    assert fixture is not None and not fixture["active"]
    production.cookies.clear()
    production.headers["x-csrf-token"] = production.get("/auth/options").json()["csrf_token"]
    code = employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30))
    assert production.post("/auth/employee/login", json={"employee_id": "EMP-REC-001", "code": code}).status_code == 401


def test_simulated_systems_require_their_credential(production, monkeypatch):
    systems = FastAPI()
    systems.include_router(simulated.router)
    with TestClient(systems) as client:
        assert client.get("/simulado/aseguradora/cobertura?cedula=8-100-100").status_code == 401
        headers = {"Authorization": "Bearer " + simulated.shared_secret()}
        policy = client.get("/simulado/aseguradora/cobertura?cedula=8-100-100", headers=headers).json()
        assert policy["poliza"]["numero"] == "POL-1001"
        assert client.get("/simulado/aseguradora/cobertura?cedula=9-999-999", headers=headers).json() is None
        assert client.post("/simulado/avisos/admisiones", json={"cedula": "VIGILIA_TEST"}, headers=headers).json()["prueba"]
        monkeypatch.setenv("VIGILIA_SIMULATED_SYSTEMS", "false")
        assert client.get("/simulado/aseguradora/antecedentes?cedula=8-100-100", headers=headers).status_code == 404
