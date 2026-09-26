"""Provider configuration security, dispatch and automatic classification (no live requests)."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
import httpx
from cryptography.fernet import Fernet
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import ai_providers as ai, agent, db, security


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VIGILIA_DB", str(tmp_path / "ai.db"))
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("VIGILIA_MODE", "demo")
    monkeypatch.setenv("VIGILIA_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    db.init_db()
    with db.conexion() as conn:
        for user_id in ("test-admin", "another-admin"):
            conn.execute("INSERT INTO user_profiles (id,issuer,email,display_name,active,created_at,updated_at) VALUES (?,'test',?,?,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", (user_id, user_id + "@example.test", user_id))
    monkeypatch.setattr(security, "current_profile", lambda *args: {"id": "test-admin"})
    monkeypatch.setattr(security, "require_csrf", lambda *args: None)
    monkeypatch.setenv("VIGILIA_ALLOW_SHARED_OLLAMA", "true")
    app = FastAPI()
    app.include_router(ai.router)
    with TestClient(app) as instance:
        yield instance


def save(client, provider="groq", **kwargs):
    response = client.put(f"/me/ai/providers/{provider}", json={
        "model": "test-model", "auth_mode": "api_key", "secret": "fixture-secret", **kwargs,
    })
    assert response.status_code == 200, response.text
    return response.json()


def completion(condition="Fractura de radio izquierdo", relation="DIRECTA"):
    content = json.dumps({"preexistencias": [{"condicion": condition, "relacion": relation, "justificacion": "Relación observada entre los textos"}]})
    return {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}


async def synthetic_response(*args):
    body = args[3]
    prompt = body.get("input")
    if prompt is None:
        prompt = next((message.get("content") for message in body.get("messages", []) if message.get("role") == "user"), "{}")
    data = json.loads(prompt) if isinstance(prompt, str) else {}
    condition = (data.get("preexistencias") or ["Fractura de radio izquierdo"])[0]
    relation = {"Osteoporosis": "POSIBLE", "Hipotiroidismo": "NINGUNA"}.get(condition, "DIRECTA")
    content = completion(condition, relation)["choices"][0]["message"]["content"]
    provider = args[0]["provider"]
    if provider == "anthropic":
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": content}]}
    if provider == "openai":
        return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": content}]}]}
    if provider == "ollama":
        return {"done": True, "message": {"content": content}}
    return {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}


def test_encryption_redaction_rotation_and_stale_writes(client):
    config = save(client)
    assert config["has_secret"] and "fixture-secret" not in client.get("/me/ai").text
    row = ai._row("groq", "test-admin")
    assert "fixture-secret" not in row["encrypted_secret"]
    assert ai.decrypt(row["encrypted_secret"]) == "fixture-secret"
    stale = client.put("/me/ai/providers/groq", json={"model": "new", "auth_mode": "api_key"})
    assert stale.status_code == 409
    config = save(client, revision=config["revision"], secret=None)
    assert config["has_secret"]
    config = save(client, revision=config["revision"], secret=None, clear_secret=True)
    assert not config["has_secret"]
    with db.conexion() as connection:
        assert "fixture-secret" not in str(connection.execute("SELECT * FROM audit_events").fetchall())


def test_requires_verified_model_and_retests_after_edit(client, monkeypatch):
    config = save(client)
    selection = {"provider": "groq", "revision": config["revision"]}
    assert client.put("/me/ai/selection", json=selection).status_code == 409
    mock = AsyncMock(side_effect=synthetic_response)
    monkeypatch.setattr(ai, "_request", mock)
    result = client.post("/me/ai/providers/groq/test", json={"revision": config["revision"]}).json()
    assert result["ok"] and len(result["cases"]) == 3
    assert [case["actual"] for case in result["cases"]] == ["DIRECTA", "POSIBLE", "NINGUNA"]
    assert client.put("/me/ai/selection", json=selection).status_code == 200
    result = asyncio.run(ai.configured_classification("fractura", ["Fractura de radio izquierdo"], "test-admin"))
    assert result[0].relacion == "DIRECTA"
    config = save(client, revision=config["revision"], model="different-model")
    mock.reset_mock()
    result = asyncio.run(ai.configured_classification("fractura", ["Fractura de radio izquierdo"], "test-admin"))
    assert result[0].justificacion.startswith("Revisión humana pendiente:")
    mock.assert_not_called()


@pytest.mark.parametrize("provider,mode,path", [("groq", "api_key", "/chat/completions"), ("xai", "api_key", "/chat/completions"), ("zen", "api_key", "/chat/completions"), ("anthropic", "api_key", "/messages"), ("openai", "api_key", "/responses"), ("ollama", "local", "/api/chat"), ("ollama", "cloud", "/api/chat")])
def test_adapters_use_correct_protocol_and_preserve_review(client, monkeypatch, provider, mode, path):
    config = save(client, provider, auth_mode=mode)
    text = completion()["choices"][0]["message"]["content"]
    payload = completion()
    if provider == "anthropic": payload = {"stop_reason": "end_turn", "content": [{"type": "text", "text": text}]}
    if provider == "openai": payload = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}
    if provider == "ollama": payload = {"done": True, "message": {"content": text}}
    mock = AsyncMock(side_effect=synthetic_response)
    monkeypatch.setattr(ai, "_request", mock)
    response = client.post(f"/me/ai/providers/{provider}/test", json={"revision": config["revision"]})
    assert response.json()["ok"]
    assert mock.await_count == 3
    assert all(call.args[2] == path for call in mock.call_args_list)
    for call in mock.call_args_list:
        body = call.args[3]
        assert "cedula" not in json.dumps(body) and "hospital" not in json.dumps(body)


def test_models_sanitize_ids_and_errors(client, monkeypatch):
    save(client)
    monkeypatch.setattr(ai, "_request", AsyncMock(return_value={"data": [{"id": "model-a"}, {"id": None}, {"id": "bad\nmodel"}]}))
    assert client.get("/me/ai/providers/groq/models").json() == {"models": ["model-a"]}
    monkeypatch.setattr(ai, "_request", AsyncMock(side_effect=ValueError("fixture-secret")))
    result = client.get("/me/ai/providers/groq/models")
    assert result.status_code == 422 and "fixture-secret" not in result.text


def test_ollama_public_key_id_cannot_replace_saved_credential(client):
    config = save(client, "ollama", auth_mode="cloud")
    public_id = "a" * 32
    response = client.put("/me/ai/providers/ollama", json={
        "model": "test-model", "auth_mode": "cloud", "secret": public_id, "revision": config["revision"],
    })
    assert response.status_code == 422
    assert "identificador público" in response.json()["detail"]
    assert public_id not in response.text
    assert ai.decrypt(ai._row("ollama", "test-admin")["encrypted_secret"]) == "fixture-secret"
    legacy = {"provider": "ollama", "auth_mode": "cloud", "encrypted_secret": ai.encrypt(public_id)}
    with pytest.raises(ai.CredentialConfigurationError):
        ai._headers(legacy)


def test_ollama_public_catalog_does_not_send_or_validate_credentials(monkeypatch):
    real_client = httpx.AsyncClient
    def respond(request):
        assert str(request.url) == "https://ollama.com/api/tags"
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"models": [{"name": "test-model"}]})
    monkeypatch.setattr(ai.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs))
    config = {"provider": "ollama", "auth_mode": "cloud", "encrypted_secret": "not-a-credential"}
    result = asyncio.run(ai._request(config, "GET", "/api/tags"))
    assert result["models"] == [{"name": "test-model"}]


@pytest.mark.parametrize("failure,status,detail", [
    (httpx.ConnectError("fixture-secret"), 503, "permisos de red"),
    (httpx.ReadTimeout("fixture-secret"), 504, "tardó demasiado"),
    (RuntimeError("fixture-secret"), 503, "cifrada"),
])
def test_models_distinguish_network_timeout_and_encryption(client, monkeypatch, failure, status, detail):
    save(client)
    monkeypatch.setattr(ai, "_request", AsyncMock(side_effect=failure))
    response = client.get("/me/ai/providers/groq/models")
    assert response.status_code == status
    assert detail in response.json()["detail"]
    assert "fixture-secret" not in response.text


def test_permissions_csrf_and_unsupported_auth(client, monkeypatch):
    assert client.put("/me/ai/providers/anthropic", json={"model": "test", "auth_mode": "oauth"}).status_code == 422
    def forbidden(*args): raise HTTPException(403, "Forbidden")
    monkeypatch.setattr(security, "require_csrf", forbidden)
    assert client.put("/me/ai/selection", json={"provider": "none"}).status_code == 403
    monkeypatch.setattr(security, "current_profile", forbidden)
    assert client.get("/me/ai").status_code == 403


def test_production_gate_prevents_call_and_legacy_mode_is_preserved(client, monkeypatch):
    assert "pendiente" in asyncio.run(ai.configured_classification("fixture", ["fixture"], None))[0].justificacion
    mock = AsyncMock()
    monkeypatch.setattr(ai, "configured_classification", mock)
    monkeypatch.setenv("VIGILIA_MODE", "production")
    monkeypatch.setenv("VIGILIA_AI_APPROVED", "false")
    from app.schemas import EventoIngreso
    event = EventoIngreso(evento_id="TEST-1", cedula="8-400-400", hospital="Ficticio", motivo_ingreso="fractura", fecha_ingreso="2026-09-25T00:00:00Z")
    result = asyncio.run(agent.relacionar_preexistencias(event, [{"condicion": "fractura"}]))
    assert result[0].justificacion.startswith("Revisión humana pendiente:")
    mock.assert_not_called()


def test_invalid_output_fails_closed_without_fallback(client, monkeypatch):
    config = save(client)
    with db.conexion() as connection:
        connection.execute("UPDATE user_ai_configs SET status='verified' WHERE provider='groq'")
    client.put("/me/ai/selection", json={"provider": "groq", "revision": config["revision"]})
    mock = AsyncMock(return_value={"choices": [{"finish_reason": "length", "message": {"content": "{}"}}]})
    monkeypatch.setattr(ai, "_request", mock)
    result = asyncio.run(ai.configured_classification("fractura", ["Fractura de radio izquierdo"], "test-admin"))
    assert result[0].justificacion.startswith("Revisión humana pendiente:")
    assert mock.await_count == 1


def test_selected_provider_is_used_by_ingress_classifier(client, monkeypatch):
    from app.schemas import EventoIngreso
    config = save(client, "xai")
    monkeypatch.setattr(ai, "_request", AsyncMock(side_effect=synthetic_response))
    client.post("/me/ai/providers/xai/test", json={"revision": config["revision"]})
    client.put("/me/ai/selection", json={"provider": "xai", "revision": config["revision"]})
    event = EventoIngreso(evento_id="TEST-ROUTE", cedula="8-400-400", hospital="Ficticio", motivo_ingreso="fractura", fecha_ingreso="2026-09-25T00:00:00Z")
    result = asyncio.run(agent.relacionar_preexistencias(event, [{"condicion": "Fractura de radio izquierdo"}], ai_user_id="test-admin", personal=True))
    assert result[0].relacion == "DIRECTA" and result[0].justificacion.startswith("Grok · xAI sugiere")


def test_stale_successful_probe_cannot_validate_new_credentials(client, monkeypatch):
    config = save(client)
    async def replace_during_probe(*args):
        with db.conexion() as connection:
            connection.execute("UPDATE user_ai_configs SET revision='new-revision', status='untested' WHERE provider='groq'")
        return completion()
    monkeypatch.setattr(ai, "_request", replace_during_probe)
    result = client.post("/me/ai/providers/groq/test", json={"revision": config["revision"]})
    assert result.status_code == 409
    assert ai._row("groq", "test-admin")["status"] == "untested"
