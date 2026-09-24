import os
import tempfile

# Entorno de pruebas: nunca escribir en Slack ni llamar al modelo real.
os.environ["VIGILIA_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
for k in ("VIGILIA_KEY", "SLACK_WEBHOOK_ADMISIONES", "SLACK_WEBHOOK_GESTOR", "GROQ_API_KEY"):
    os.environ[k] = ""
