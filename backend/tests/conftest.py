"""Valores seguros para tests pytest: SQLite temporal y proveedores apagados."""
import os
import tempfile
from pathlib import Path

TEST_DIRECTORY = tempfile.TemporaryDirectory(prefix="vigilia-pytest-")
os.environ.__setitem__("VIGILIA_MODE", "demo")
os.environ.__setitem__("VIGILIA_DB", str(Path(TEST_DIRECTORY.name) / "vigilia-pytest.db"))
os.environ.__setitem__("VIGILIA_KEY", "")
os.environ.__setitem__("VIGILIA_AI_PROVIDER", "kev")
os.environ.__setitem__("VIGILIA_RULES_FALLBACK", "false")
os.environ.__setitem__("KEV_API_URL", "")
os.environ.__setitem__("KEV_API_KEY", "")
os.environ.__setitem__("GROQ_API_KEY", "")
os.environ.__setitem__("SLACK_ENABLED", "false")
os.environ.__setitem__("SLACK_WEBHOOK_ADMISIONES", "")
os.environ.__setitem__("SLACK_WEBHOOK_GESTOR", "")
# Hash de contraseñas más barato solo para tests.
os.environ.__setitem__("VIGILIA_SCRYPT_LOG_N", "12")

# Pure adapter tests exercise legacy environment settings independently of a database.
import pytest


@pytest.fixture(autouse=True)
def isolate_legacy_adapter_selection(request, monkeypatch):
    if request.module.__name__ in {"test_agent_kev", "test_agente"}:
        monkeypatch.setattr("app.ai_providers.selection", lambda: "environment")
