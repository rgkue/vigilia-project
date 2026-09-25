"""Valores seguros para tests pytest: SQLite temporal y proveedores apagados."""
import os
import tempfile
from pathlib import Path

TEST_DIRECTORY = tempfile.TemporaryDirectory(prefix="vigilia-pytest-")
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
