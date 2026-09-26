"""Authentication boundaries, RFC vector, replay resistance and administrative recovery."""
import base64
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, Mock

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from starlette.responses import RedirectResponse

from app import access, auth, db, employees, security
from app.main import app
from auth_helpers import authenticate_demo


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "employee-auth.db"))
    monkeypatch.setenv("VIGILIA_SEED_DEMO", "true")
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    with TestClient(app) as instance:
        prepare(instance)
        yield instance


def prepare(client):
    result = client.get("/auth/options")
    assert result.status_code == 200
    client.headers["x-csrf-token"] = result.json()["csrf_token"]
    return result.json()


def login(client, code=None, employee_id="EMP-REC-001"):
    return client.post("/auth/employee/login", json={"employee_id": employee_id,
        "code": code if code is not None else employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30))})


def test_rfc6238_reference_vector():
    secret = base64.b32encode(b"12345678901234567890").decode()
    assert employees.totp(secret, 59 // 30) == "287082"  # RFC eight-digit vector truncated to six.
    assert employees.matching_step(secret, "287082", 59) == 1
    assert employees.matching_step(secret, "287082", 150) is None


def test_employee_session_permissions_csrf_and_logout(client):
    assert client.get("/auth/me").status_code == 401
    assert client.get("/admin/employees").status_code == 401
    response = login(client)
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["auth_method"] == "totp" and user["employee_id"] == "EMP-REC-001"
    assert user["roles"] == ["recepcionista"]
    assert set(user["permissions"]) == {"ingress.read", "ingress.submit"}
    assert client.get("/admin/employees").status_code == 403
    assert client.get("/admin/users").status_code == 403
    assert client.get("/ingresos").status_code == 200
    assert client.post("/auth/logout", json={}).status_code == 403  # previous pre-auth CSRF invalidated
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    assert client.post("/auth/logout", json={}).status_code == 200
    assert client.get("/auth/me").status_code == 401


def test_bad_codes_unknown_id_and_replay(client):
    assert login(client, employee_id="UNKNOWN").status_code == 401
    old = employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30) - 5)
    assert login(client, code=old).status_code == 401
    current = employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30))
    assert login(client, code=current).status_code == 200
    prepare(client)
    assert login(client, code=current).status_code == 401
    assert client.post("/auth/employee/login", json={"employee_id": "EMP-REC-001", "code": current, "role": "administrador"}).status_code == 422


def test_same_code_concurrent_requests_only_one_session(client):
    cookies = dict(client.cookies)
    csrf = client.headers["x-csrf-token"]
    code = employees.totp(employees.DEMO_TOTP_SECRET, int(time.time() // 30))
    def attempt(_):
        with TestClient(app) as browser:
            browser.cookies.update(cookies)
            browser.headers["x-csrf-token"] = csrf
            return login(browser, code=code).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == [200, 401]


def test_login_limits_persist_in_database(client):
    for _ in range(10):
        assert login(client, code="000000", employee_id="MISSING").status_code == 401
    assert login(client, code="000000", employee_id="MISSING").status_code == 429
    client.cookies.clear()
    prepare(client)
    assert login(client, code="000000", employee_id="MISSING").status_code == 429


def test_csrf_required_before_login(client):
    client.headers.pop("x-csrf-token")
    assert login(client).status_code == 403
    assert client.post("/auth/admin/qr/start", json={"qr": "vigilia:admin:demo-admin"}).status_code == 403


def test_revoked_employee_can_still_close_session(client):
    response = login(client)
    user_id = response.json()["user"]["id"]
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    with db.conexion() as connection:
        connection.execute("UPDATE employees SET credential_version=credential_version+1 WHERE user_id=?", (user_id,))
    assert client.post("/auth/logout", json={}).status_code == 200
    assert client.get("/auth/me").status_code == 401


def test_directory_enrollment_disable_and_reset_revokes_sessions(client):
    authenticate_demo(client)
    response = client.post("/admin/employees", json={"employee_id": "emp-new", "display_name": "Empleado ficticio"})
    assert response.status_code == 201, response.text
    employee = response.json()
    assert employee["employee_id"] == "EMP-NEW" and not employee["totp_configured"]
    uid = employee["id"]
    assert client.post("/admin/employees", json={"employee_id": "EMP-NEW", "display_name": "Duplicado"}).status_code == 409
    enrollment = client.post(f"/admin/employees/{uid}/totp", json={})
    assert enrollment.status_code == 200 and enrollment.headers["cache-control"] == "no-store"
    secret = enrollment.json()["secret"]
    with db.conexion() as connection:
        encrypted = connection.execute("SELECT encrypted_totp_secret FROM employees WHERE user_id=?", (uid,)).fetchone()[0]
        assert secret not in encrypted
    with TestClient(app) as employee_client:
        prepare(employee_client)
        code = employees.totp(secret, int(time.time() // 30))
        assert login(employee_client, code, "EMP-NEW").status_code == 200
        assert client.put(f"/admin/employees/{uid}", json={"display_name": "Nombre corregido", "active": False}).status_code == 200
        assert employee_client.get("/auth/me").status_code == 401
        prepare(employee_client)
        assert login(employee_client, code, "EMP-NEW").status_code == 401
        assert client.put(f"/admin/employees/{uid}", json={"display_name": "Nombre corregido", "active": True}).status_code == 200
        enrollment = client.post(f"/admin/employees/{uid}/totp", json={}).json()
        code = employees.totp(enrollment["secret"], int(time.time() // 30))
        assert login(employee_client, code, "EMP-NEW").status_code == 200
        assert client.post(f"/admin/employees/{uid}/totp", json={}).status_code == 200
        assert employee_client.get("/auth/me").status_code == 401
    listing = client.get("/admin/employees").json()
    assert all("secret" not in field for entry in listing for field in entry)
    with db.conexion() as connection:
        assert secret not in str(connection.execute("SELECT * FROM audit_events").fetchall())


def production_oidc(monkeypatch):
    monkeypatch.setenv("VIGILIA_MODE", "production")
    for key, value in {"OIDC_ISSUER": "https://idp.test", "OIDC_DISCOVERY_URL": "https://idp.test/discovery",
                       "OIDC_CLIENT_ID": "fixture", "OIDC_CLIENT_SECRET": "fixture",
                       "VIGILIA_BOOTSTRAP_ADMIN_EMAIL": "admin@example.test"}.items():
        monkeypatch.setenv(key, value)
    claims = {"iss": "https://idp.test", "sub": "admin-sub", "email": "admin@example.test", "email_verified": True}
    oidc = Mock()
    oidc.authorize_redirect = AsyncMock(return_value=RedirectResponse("https://idp.test/login?state=fixture-state"))
    oidc.authorize_access_token = AsyncMock(return_value={"userinfo": claims})
    monkeypatch.setattr(auth, "oauth", Mock(create_client=Mock(return_value=oidc)))
    return oidc, claims


def test_oidc_bootstrap_once_then_qr_and_identity_binding(client, monkeypatch):
    oidc, claims = production_oidc(monkeypatch)
    assert client.get("/auth/options").json()["bootstrap_allowed"]
    assert client.get("/auth/login", follow_redirects=False).status_code == 307
    response = client.get("/auth/callback?state=fixture-state", follow_redirects=False)
    assert response.status_code == 303, response.text
    profile = client.get("/auth/me").json()["user"]
    badge = client.get("/auth/badge").json()["badge"]
    assert profile["auth_method"] == "oidc"
    assert not client.get("/auth/options").json()["bootstrap_allowed"]
    assert client.get("/auth/login", follow_redirects=False).status_code == 403
    prepare(client)
    assert client.post("/auth/admin/qr/start", json={"qr": badge}).status_code == 200
    assert client.get("/auth/login", follow_redirects=False).status_code == 307
    oidc.authorize_access_token.return_value = {"userinfo": {**claims, "email": "someone@example.test"}}
    assert client.get("/auth/callback?state=fixture-state").status_code == 403
    assert client.get("/auth/me").status_code == 401
    prepare(client)
    client.post("/auth/admin/qr/start", json={"qr": badge})
    client.get("/auth/login", follow_redirects=False)
    oidc.authorize_access_token.return_value = {"userinfo": claims}
    assert client.get("/auth/callback?state=fixture-state", follow_redirects=False).status_code == 303
    assert client.get("/auth/me").json()["user"]["id"] == profile["id"]


def test_oidc_state_and_expiration_enforced(client, monkeypatch):
    production_oidc(monkeypatch)
    assert client.get("/auth/callback?state=forged").status_code == 401
    client.get("/auth/login", follow_redirects=False)
    now = time.time()
    monkeypatch.setattr(access.time, "time", lambda: now + 301)
    assert client.get("/auth/callback?state=fixture-state").status_code == 401


def test_demo_credentials_never_exposed_or_seeded_in_production(client, monkeypatch):
    with db.conexion() as connection:
        connection.execute("DELETE FROM employees")
    monkeypatch.setenv("VIGILIA_MODE", "production")
    with db.conexion() as connection:
        employees.seed_demo(connection)
        assert connection.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 0
    options = client.get("/auth/options").json()
    assert options["demo_employee"] is None and options["demo_admin_badge"] is None
    assert client.post("/auth/demo-admin", json={}).status_code == 404
    assert client.post("/auth/admin/qr/start", json={"qr": "vigilia:admin:demo-admin"}).status_code == 401


def test_demo_seed_idempotent_and_can_be_disabled(client, monkeypatch):
    db.init_db()
    with db.conexion() as connection:
        assert connection.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 1
        connection.execute("DELETE FROM employees")
    monkeypatch.setenv("VIGILIA_SEED_DEMO", "false")
    db.init_db()
    assert client.get("/auth/options").json()["demo_employee"] is None
    with db.conexion() as connection:
        assert connection.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 0
