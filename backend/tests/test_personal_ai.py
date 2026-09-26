"""Two authenticated browser sessions must never share provider secrets or consent."""
import asyncio
import base64
import json
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from starlette.middleware.sessions import SessionMiddleware

from app import ai_assignments as grants, ai_providers as ai, ai_subscriptions as oauth, db, security
from test_ai_providers import client as base_client, completion, save

real_profile = security.current_profile
real_csrf = security.require_csrf


@pytest.fixture
def accounts(base_client, monkeypatch):
    monkeypatch.setattr(security, "current_profile", real_profile)
    monkeypatch.setattr(security, "require_csrf", real_csrf)
    monkeypatch.setenv("VIGILIA_MODE", "production")
    with db.conexion() as conn:
        conn.execute("UPDATE user_profiles SET permissions_json='[\"integrations.manage\"]' WHERE id='test-admin'")
        conn.execute("INSERT INTO integration_configs (id,kind,name,enabled,updated_at) VALUES ('hospital','ingress','Hospital ficticio',TRUE,CURRENT_TIMESTAMP)")
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="fixture-session-key")
    for router in (ai.router, oauth.router, grants.router):
        app.include_router(router)
    with TestClient(app) as alice, TestClient(app) as bob:
        for client, user in ((alice, "test-admin"), (bob, "another-admin")):
            raw = base64.b64encode(json.dumps({"user_id": user, "csrf_token": "fixture-csrf"}).encode())
            client.cookies.set("session", TimestampSigner("fixture-session-key").sign(raw).decode())
            client.headers["x-csrf-token"] = "fixture-csrf"
        yield alice, bob


def test_keys_models_selection_and_probes_are_personal(accounts, monkeypatch):
    alice, bob = accounts
    first = save(alice, secret="alice-fictitious-key", model="alice-model")
    assert bob.get("/me/ai").json()["configs"] == []
    assert bob.put("/me/ai/providers/groq", json={"auth_mode": "api_key", "revision": first["revision"]}).status_code == 409
    second = save(bob, secret="bob-fictitious-key", model="bob-model")
    mock = AsyncMock(return_value=completion())
    monkeypatch.setattr(ai, "_request", mock)
    assert bob.post("/me/ai/providers/groq/test", json={"revision": first["revision"]}).status_code == 409
    assert alice.post("/me/ai/providers/groq/test", json={"revision": first["revision"]}).json()["ok"]
    assert mock.call_args.args[0]["user_id"] == "test-admin"
    alice.put("/me/ai/selection", json={"provider": "groq", "revision": first["revision"]})
    assert bob.get("/me/ai").json()["selected"] == "none"
    assert bob.get("/me/ai").json()["configs"][0]["model"] == "bob-model"
    assert ai.decrypt(ai._row("groq", "another-admin")["encrypted_secret"]) == "bob-fictitious-key"
    assert bob.post("/me/ai/providers/groq/test", json={"revision": second["revision"]}).json()["ok"]
    assert mock.call_args.args[0]["user_id"] == "another-admin"
    assert "fictitious-key" not in alice.get("/me/ai").text + bob.get("/me/ai").text
    assert alice.get("/admin/ai").status_code == 404
    assert bob.get("/admin/ai/assignments").status_code == 403
    bob.headers.pop("x-csrf-token")
    assert bob.put("/me/ai/selection", json={"provider": "none"}).status_code == 403


def test_consent_is_owner_only_and_admin_withdrawal_cannot_be_undone(accounts, monkeypatch):
    alice, bob = accounts
    config = save(bob)
    monkeypatch.setattr(ai, "_request", AsyncMock(return_value=completion()))
    bob.post("/me/ai/providers/groq/test", json={"revision": config["revision"]})
    bob.put("/me/ai/selection", json={"provider": "groq", "revision": config["revision"]})
    nomination = alice.put("/admin/ai/assignments/hospital", json={"user_id": "another-admin"}).json()
    assert grants.integration_owner("hospital") is None
    consent = {"accept": True, "revision": nomination["revision"]}
    assert alice.put("/me/ai/assignments/hospital", json=consent).status_code == 409
    accepted = bob.put("/me/ai/assignments/hospital", json=consent)
    assert accepted.status_code == 200
    assert grants.integration_owner("hospital") == "another-admin"
    # Stale administrative write cannot overwrite a consent change.
    assert alice.put("/admin/ai/assignments/hospital", json={"user_id": None, "revision": nomination["revision"]}).status_code == 409
    withdrawn = alice.put("/admin/ai/assignments/hospital", json={"user_id": None, "revision": accepted.json()["revision"]}).json()
    assert grants.integration_owner("hospital") is None
    assert bob.put("/me/ai/assignments/hospital", json={"accept": True, "revision": withdrawn["revision"]}).status_code == 409


def test_dispatch_uses_explicit_owner_and_never_legacy_shared_account(accounts, monkeypatch):
    alice, bob = accounts
    first = save(alice)
    mock = AsyncMock(return_value=completion())
    monkeypatch.setattr(ai, "_request", mock)
    alice.post("/me/ai/providers/groq/test", json={"revision": first["revision"]})
    alice.put("/me/ai/selection", json={"provider": "groq", "revision": first["revision"]})
    mock.reset_mock()
    asyncio.run(ai.configured_classification("fixture", ["Fractura de radio izquierdo"], None))
    asyncio.run(ai.configured_classification("fixture", ["Fractura de radio izquierdo"], "another-admin"))
    mock.assert_not_called()
    asyncio.run(ai.configured_classification("fixture", ["Fractura de radio izquierdo"], "test-admin", "fixture-event"))
    assert mock.call_args.args[0]["user_id"] == "test-admin"
    with db.conexion() as conn:
        event = conn.execute("SELECT * FROM audit_events WHERE action='ai.classify'").fetchone()
        assert event["actor_id"] == "test-admin" and first["revision"] in event["details_json"]
        conn.execute("UPDATE user_profiles SET active=FALSE WHERE id='test-admin'")
    mock.reset_mock()
    asyncio.run(ai.configured_classification("fixture", ["fixture"], "test-admin"))
    mock.assert_not_called()


def test_parallel_personal_logins_and_late_callback_cannot_reconnect(accounts, monkeypatch):
    alice, bob = accounts
    monkeypatch.setenv("VIGILIA_OPENCODE_URL", "http://127.0.0.1:4096")
    monkeypatch.setenv("VIGILIA_OPENCODE_PASSWORD", "fictitious")
    async def bridge(method, path, body=None, **kwargs):
        if path == "/provider/auth": return {"openai": [{"type": "oauth", "label": "headless"}]}
        if path.endswith("/authorize"): return {"url": "https://auth.openai.com/device", "method": "code", "instructions": "fixture"}
        if path == "/provider": return {"connected": ["openai"]}
        return True
    mock = AsyncMock(side_effect=bridge)
    monkeypatch.setattr(oauth, "bridge", mock)
    flows = []
    for client in (alice, bob):
        config = save(client, "openai", auth_mode="oauth", secret=None)
        response = client.post("/me/ai/subscriptions/openai/login", json={"revision": config["revision"]})
        assert response.status_code == 200
        flows.append(response.json()["flow_id"])
    scopes = {call.kwargs["account"] for call in mock.call_args_list}
    assert len(scopes) == 2
    assert alice.post("/me/ai/subscriptions/openai/complete", json={"flow_id": flows[1], "code": "fixture"}).status_code == 409
    alice.delete("/me/ai/subscriptions/openai")
    assert oauth.connection("openai", "another-admin")["status"] == "pending"
    asyncio.run(oauth.complete("openai", flows[0], 0, "test-admin"))
    assert oauth.connection("openai", "test-admin")["status"] == "disconnected"
    assert oauth.scope("test-admin", "openai", flows[0]) != oauth.scope("test-admin", "openai", "replacement")


def test_legacy_migration_preserves_but_never_exposes_shared_credentials(accounts):
    alice, bob = accounts
    with db.conexion() as conn:
        conn.execute("INSERT INTO ai_provider_configs VALUES ('groq','old-model','api_key',?,'old','verified','today')", (ai.encrypt("legacy-fictitious-key"),))
        conn.execute("INSERT INTO ai_selection VALUES (1,'groq')")
    for client in (alice, bob):
        state = client.get("/me/ai").json()
        assert state["configs"] == [] and state["selected"] == "none"


def test_shared_ollama_requires_operator_opt_in(accounts, monkeypatch):
    alice, _ = accounts
    monkeypatch.setenv("VIGILIA_ALLOW_SHARED_OLLAMA", "false")
    provider = next(p for p in alice.get("/me/ai").json()["providers"] if p["id"] == "ollama")
    assert provider["auth_modes"] == ["cloud"]
    assert alice.put("/me/ai/providers/ollama", json={"model": "fixture", "auth_mode": "local"}).status_code == 422
