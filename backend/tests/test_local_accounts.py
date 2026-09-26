"""Local accounts without OIDC: password + TOTP for administrative roles, reception unchanged."""
import re
import time

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import bootstrap_admin, db, employees, security
from app.main import app
from auth_helpers import authenticate_demo


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "local-accounts.db"))
    monkeypatch.setenv("VIGILIA_SEED_DEMO", "true")
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    with TestClient(app) as instance:
        authenticate_demo(instance)
        yield instance


def fresh_browser():
    browser = TestClient(app)
    browser.__enter__()
    browser.headers["x-csrf-token"] = browser.get("/auth/options").json()["csrf_token"]
    return browser


def code_for(secret, offset=0):
    return employees.totp(secret, int(time.time() // 30) + offset)


def login(browser, account_id, secret, password=None, offset=0):
    body = {"employee_id": account_id, "code": code_for(secret, offset)}
    if password is not None:
        body["password"] = password
    return browser.post("/auth/employee/login", json=body)


def create_admin(client, account_id="ADM-LOCAL", roles=("administrador",)):
    created = client.post("/admin/employees", json={"employee_id": account_id, "display_name": "Administración local", "roles": list(roles)})
    assert created.status_code == 201, created.text
    account = created.json()
    secret = client.post(f"/admin/employees/{account['id']}/totp", json={}).json()["secret"]
    temporary = client.post(f"/admin/employees/{account['id']}/password", json={})
    assert temporary.status_code == 200, temporary.text
    assert temporary.headers["cache-control"] == "no-store"
    return account, secret, temporary.json()["temporary_password"]


def test_admin_account_needs_password_only_after_valid_code(client):
    account, secret, temporary = create_admin(client)
    assert account["requires_password"] and set(account["permissions"]) == set(security.PERMISSION_CATALOG)
    browser = fresh_browser()
    try:
        # Sin código válido no se revela que la cuenta necesita contraseña.
        assert browser.post("/auth/employee/login", json={"employee_id": "ADM-LOCAL", "code": "000000"}).status_code == 401
        assert login(browser, "ADM-LOCAL", secret).status_code == 428
        assert login(browser, "ADM-LOCAL", secret, "incorrecta-123").status_code == 401
        # El 428 y el fallo de contraseña no consumen el código: sigue valiendo con la contraseña correcta.
        response = login(browser, "ADM-LOCAL", secret, temporary)
        assert response.status_code == 200, response.text
        user = response.json()["user"]
        assert user["auth_method"] == "password" and user["must_change_password"] is True
        browser.headers["x-csrf-token"] = response.json()["csrf_token"]

        blocked = browser.get("/ingresos/listado")
        assert blocked.status_code == 403 and blocked.json()["detail"] == security.PASSWORD_CHANGE_REQUIRED
        assert browser.get("/auth/me").status_code == 200

        assert browser.post("/auth/password", json={"current_password": temporary, "new_password": "corta"}).status_code == 422
        assert browser.post("/auth/password", json={"current_password": temporary, "new_password": "adm-local-2026-x"}).status_code == 422
        assert browser.post("/auth/password", json={"current_password": "mala", "new_password": "Una frase larga y segura"}).status_code == 403
        changed = browser.post("/auth/password", json={"current_password": temporary, "new_password": "Una frase larga y segura"})
        assert changed.status_code == 200, changed.text
        assert changed.json()["user"]["must_change_password"] is False
        assert browser.get("/ingresos/listado").status_code == 200
        with db.conexion() as connection:
            stored = connection.execute("SELECT password_hash FROM employees WHERE employee_id='ADM-LOCAL'").fetchone()["password_hash"]
            audit = str(connection.execute("SELECT * FROM audit_events").fetchall())
        assert stored.startswith("scrypt$") and temporary not in stored and temporary not in audit
    finally:
        browser.__exit__(None, None, None)


def test_reception_login_unchanged_and_upgrade_requires_password(client):
    demo = next(item for item in client.get("/admin/employees").json() if item["employee_id"] == employees.DEMO_EMPLOYEE_ID)
    assert not demo["requires_password"]
    browser = fresh_browser()
    try:
        response = login(browser, employees.DEMO_EMPLOYEE_ID, employees.DEMO_TOTP_SECRET)
        assert response.status_code == 200 and response.json()["user"]["auth_method"] == "totp"
        assert client.post(f"/admin/employees/{demo['id']}/password", json={}).status_code == 409
        upgraded = client.put(f"/admin/employees/{demo['id']}", json={"display_name": demo["display_name"], "active": True, "roles": ["revisor"]})
        assert upgraded.status_code == 200 and upgraded.json()["requires_password"]
        # Cambiar permisos cierra la sesión abierta; ahora la cuenta necesita contraseña.
        assert browser.get("/auth/me").status_code == 401
        browser.headers["x-csrf-token"] = browser.get("/auth/options").json()["csrf_token"]
        assert login(browser, employees.DEMO_EMPLOYEE_ID, employees.DEMO_TOTP_SECRET, offset=1).status_code == 428
    finally:
        browser.__exit__(None, None, None)


def test_password_lockout_after_repeated_failures(client):
    _, secret, temporary = create_admin(client, "ADM-LOCK")
    browser = fresh_browser()
    try:
        for _ in range(5):
            assert login(browser, "ADM-LOCK", secret, "incorrecta-123").status_code == 401
        locked = login(browser, "ADM-LOCK", secret, temporary)
        assert locked.status_code == 429 and "15 minutos" in locked.json()["detail"]
        # Restablecer la contraseña desde administración levanta el bloqueo.
        account = next(item for item in client.get("/admin/employees").json() if item["employee_id"] == "ADM-LOCK")
        temporary = client.post(f"/admin/employees/{account['id']}/password", json={}).json()["temporary_password"]
        assert login(browser, "ADM-LOCK", secret, temporary).status_code == 200
    finally:
        browser.__exit__(None, None, None)


def test_last_people_manager_cannot_lose_access(client):
    account, secret, temporary = create_admin(client, "ADM-LAST")
    browser = fresh_browser()
    try:
        session = login(browser, "ADM-LAST", secret, temporary).json()
        browser.headers["x-csrf-token"] = session["csrf_token"]
        browser.headers["x-csrf-token"] = browser.post("/auth/password", json={"current_password": temporary, "new_password": "Otra frase bastante larga"}).json()["csrf_token"]
        with db.conexion() as connection:
            connection.execute("UPDATE user_profiles SET active = FALSE WHERE id = 'demo-admin'")
        demoted = browser.put(f"/admin/employees/{account['id']}", json={"display_name": "Administración local", "active": True, "roles": ["revisor"]})
        assert demoted.status_code == 409
        assert browser.put(f"/admin/employees/{account['id']}", json={"display_name": "Administración local", "active": False}).status_code == 409
        assert browser.post(f"/admin/employees/{account['id']}/password", json={}).status_code == 409
    finally:
        browser.__exit__(None, None, None)


def test_production_security_without_oidc(monkeypatch):
    monkeypatch.setenv("VIGILIA_SESSION_SECRET", "s" * 40)
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    for name in (*security.OIDC_VARIABLES, "VIGILIA_BOOTSTRAP_ADMIN_EMAIL", "OIDC_FRONTEND_ORIGIN"):
        monkeypatch.delenv(name, raising=False)
    security.validate_production_security()  # cuentas locales: OIDC no es obligatorio
    monkeypatch.setenv("OIDC_ISSUER", "https://idp.test")
    with pytest.raises(RuntimeError, match="incompleta"):
        security.validate_production_security()
    monkeypatch.delenv("OIDC_ISSUER")
    monkeypatch.setenv("VIGILIA_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test")
    with pytest.raises(RuntimeError, match="bootstrap_admin"):
        security.validate_production_security()


def test_bootstrap_command_creates_first_admin_once(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "bootstrap.db"))
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    assert bootstrap_admin.main(["--id", "admin-01", "--name", "Ana Pérez"]) == 0
    output = capsys.readouterr().out
    secret = re.search(r"con esta clave:\s+(\S+)", output).group(1)
    temporary = re.search(r"contraseña temporal:\s+(\S+)", output).group(1)
    assert bootstrap_admin.main(["--id", "ADMIN-02", "--name", "Otra"]) == 3
    with TestClient(app) as browser:
        browser.headers["x-csrf-token"] = browser.get("/auth/options").json()["csrf_token"]
        response = login(browser, "ADMIN-01", secret, temporary)
        assert response.status_code == 200, response.text
        assert response.json()["user"]["must_change_password"] is True
        assert "users.manage" in response.json()["user"]["permissions"]


def test_options_report_oidc_availability(client):
    assert client.get("/auth/options").json()["oidc_enabled"] is False
