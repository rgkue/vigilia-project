"""OAuth lifecycle and inference tests with fictitious authorizations only."""
import asyncio
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import ai_providers as ai, ai_subscriptions as oauth, db, security
from test_ai_providers import client as base_client, save, completion


@pytest.fixture
def client(base_client, monkeypatch):
    monkeypatch.setenv("VIGILIA_OPENCODE_URL", "http://127.0.0.1:4096")
    monkeypatch.setenv("VIGILIA_OPENCODE_PASSWORD", "fixture-private-password")
    app = FastAPI()
    app.include_router(ai.router)
    app.include_router(oauth.router)
    with TestClient(app) as instance:
        yield instance


def setup(client, monkeypatch):
    config = save(client, "openai", auth_mode="oauth", secret=None)
    bridge = AsyncMock(side_effect=[
        {"openai": [{"type": "oauth", "label": "browser"}, {"type": "oauth", "label": "headless"}]},
        {"url": "https://auth.openai.com/codex/device", "method": "code", "instructions": "fixture-instructions"},
    ])
    monkeypatch.setattr(oauth, "bridge", bridge)
    response = client.post("/me/ai/subscriptions/openai/login", json={"revision": config["revision"]})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert bridge.call_args_list[-1].args[2] == {"method": 1}
    return response.json()


def test_owner_encryption_revision_and_cancel(client, monkeypatch):
    flow = setup(client, monkeypatch)
    row = oauth.connection("openai", "test-admin")
    assert "fixture-instructions" not in row["encrypted_authorization"]
    response = client.get("/me/ai/subscriptions/openai")
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["authorization"] == flow["authorization"]
    monkeypatch.setattr(security, "current_profile", lambda *args: {"id": "another-admin"})
    assert client.get("/me/ai/subscriptions/openai").json()["authorization"] is None
    assert client.post("/me/ai/subscriptions/openai/complete", json={"flow_id": flow["flow_id"], "code": "fixture-code"}).status_code == 409
    monkeypatch.setattr(oauth, "bridge", AsyncMock(side_effect=ValueError("offline")))
    result = client.delete("/me/ai/subscriptions/openai")
    assert result.json() == {"status": "disconnected", "remote_removed": True}
    assert oauth.connection("openai", "test-admin")["encrypted_authorization"] is not None
    monkeypatch.setattr(oauth, "bridge", AsyncMock(side_effect=[True, {"connected": ["openai"]}]))
    assert oauth.connection("openai", "test-admin")["status"] == "pending"
    monkeypatch.setattr(security, "current_profile", lambda *args: {"id": "test-admin"})
    monkeypatch.setattr(oauth, "bridge", AsyncMock(return_value=True))
    assert client.delete("/me/ai/subscriptions/openai").json()["remote_removed"]
    assert oauth.connection("openai", "test-admin")["status"] == "disconnected"


def test_complete_expiry_and_stale_revision(client, monkeypatch):
    flow = setup(client, monkeypatch)
    scheduled = []
    monkeypatch.setattr(oauth, "_schedule", lambda *args: scheduled.append(args))
    response = client.post("/me/ai/subscriptions/openai/complete", json={"flow_id": flow["flow_id"], "code": "fixture-code"})
    assert response.status_code == 200
    assert client.post("/me/ai/subscriptions/openai/complete", json={"flow_id": flow["flow_id"], "code": "fixture-code"}).status_code == 409
    monkeypatch.setattr(oauth, "bridge", AsyncMock(side_effect=[True, {"connected": ["openai"]}]))
    asyncio.run(oauth.complete(*scheduled[0]))
    assert oauth.connection("openai", "test-admin")["status"] == "connected"
    assert oauth.connection("openai", "test-admin")["encrypted_authorization"] is None
    assert ai._row("openai", "test-admin")["status"] == "untested"
    with db.conexion() as conn:
        conn.execute("UPDATE user_ai_oauth SET status='pending',expires_at=?", (time.time() - 1,))
    assert client.get("/me/ai/subscriptions/openai").json()["status"] == "expired"
    assert client.post("/me/ai/subscriptions/openai/complete", json={"flow_id": flow["flow_id"], "code": "fixture-code"}).status_code == 409


@pytest.mark.parametrize("url", ["http://auth.openai.com/device", "https://evil.example", "https://auth.openai.com.evil.example", "https://user@auth.openai.com/device"])
def test_rejects_untrusted_authorization_destinations(url):
    with pytest.raises(ValueError):
        oauth.valid_authorization("openai", {"url": url, "method": "auto"})


def test_permissions_and_csrf(client, monkeypatch):
    def reject(*args):
        raise HTTPException(403, "forbidden")
    monkeypatch.setattr(security, "require_csrf", reject)
    assert client.delete("/me/ai/subscriptions/openai").status_code == 403
    monkeypatch.setattr(security, "current_profile", reject)
    assert client.get("/me/ai/subscriptions/openai").status_code == 403


@pytest.mark.parametrize("fails", [False, True])
def test_inference_has_no_tools_and_cleans_session(client, monkeypatch, fails):
    config = save(client, "openai", auth_mode="oauth", secret=None)
    with db.conexion() as conn:
        conn.execute("INSERT INTO user_ai_oauth (user_id,provider,flow_id,actor_id,status,expires_at) VALUES ('test-admin','openai','fixture-flow','test-admin','connected',0)")
    monkeypatch.setattr(oauth, "models", AsyncMock(return_value=["test-model"]))
    text = completion()["choices"][0]["message"]["content"]
    mock = AsyncMock(side_effect=[{"id": "fixture-session"}, ValueError("offline") if fails else {"info": {"finish": "stop"}, "parts": [{"type": "text", "text": text}]}, True, True])
    monkeypatch.setattr(oauth, "bridge", mock)
    result = client.post("/me/ai/providers/openai/test", json={"revision": config["revision"]})
    assert result.json()["ok"] is not fails
    assert mock.call_args_list[0].args[2]["permission"][0]["action"] == "deny"
    assert mock.call_args_list[1].args[2]["tools"] == {"*": False}
    assert mock.call_args_list[-2].args[:2] == ("POST", "/session/fixture-session/abort")
    assert mock.call_args_list[-1].args[:2] == ("DELETE", "/session/fixture-session")


def test_disconnected_subscription_fails_closed(client):
    with pytest.raises(ValueError):
        asyncio.run(oauth.models("openai", "test-admin"))


def test_no_overlapping_logins(client, monkeypatch):
    setup(client, monkeypatch)
    mock = AsyncMock(return_value={"openai": [{"type": "oauth", "label": "headless"}]})
    monkeypatch.setattr(oauth, "bridge", mock)
    result = client.post("/me/ai/subscriptions/openai/login", json={"revision": ai._row("openai", "test-admin")["revision"]})
    assert result.status_code == 409
    assert mock.call_count == 0


@pytest.mark.parametrize("provider,url", [("xai", "https://auth.x.ai/device"), ("openai", "https://auth.openai.com/codex/device")])
def test_device_flow_schedules_completion(client, monkeypatch, provider, url):
    config = save(client, provider, auth_mode="oauth", secret=None)
    monkeypatch.setattr(oauth, "bridge", AsyncMock(side_effect=[
        {provider: [{"type": "oauth", "label": "headless"}]},
        {"url": url, "method": "auto", "instructions": "fixture-device-code"},
    ]))
    scheduled = []
    monkeypatch.setattr(oauth, "_schedule", lambda *args: scheduled.append(args))
    result = client.post(f"/me/ai/subscriptions/{provider}/login", json={"revision": config["revision"]})
    assert result.status_code == 200
    assert result.json()["status"] == "completing"
    assert len(scheduled) == 1 and scheduled[0][0] == provider
    assert "fixture-device-code" not in oauth.connection(provider, "test-admin")["encrypted_authorization"]
