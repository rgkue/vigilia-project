"""Pruebas de flujo procedentes del backend remoto, ajustadas a revisión pendiente."""
from datetime import datetime
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

FLOW_DIRECTORY = tempfile.TemporaryDirectory(prefix="vigilia-flow-tests-")
os.environ.__setitem__("VIGILIA_DB", str(Path(FLOW_DIRECTORY.name) / "vigilia-flow.db"))
os.environ.__setitem__("VIGILIA_KEY", "")
os.environ.__setitem__("VIGILIA_AI_PROVIDER", "kev")
os.environ.__setitem__("VIGILIA_RULES_FALLBACK", "false")
os.environ.__setitem__("KEV_API_URL", "")
os.environ.__setitem__("KEV_API_KEY", "")
os.environ.__setitem__("GROQ_API_KEY", "")
os.environ.__setitem__("SLACK_ENABLED", "false")
os.environ.__setitem__("SLACK_WEBHOOK_ADMISIONES", "")
os.environ.__setitem__("SLACK_WEBHOOK_GESTOR", "")

from fastapi.testclient import TestClient

from app import db, main
from app.main import app


CASES = [
    ("8-100-100", "Fractura de muñeca por caída", "VALIDA_CON_ALERTAS"),
    ("8-200-200", "Dolor torácico", "NO_VALIDA"),
    ("8-300-300", "Dolor torácico", "VALIDA_CON_ALERTAS"),
    ("8-400-400", "Dolor torácico opresivo", "VALIDA_CON_ALERTAS"),
    ("8-500-500", "Fractura de muñeca por caída", "VALIDA_CON_ALERTAS"),
    ("9-999-999", "Dolor torácico", "NO_ENCONTRADO"),
]


def event(index, insured, reason):
    return {
        "evento_id": f"FLOW-{index}",
        "cedula": insured,
        "hospital": "Hospital ficticio",
        "motivo_ingreso": reason,
        "fecha_ingreso": datetime.now().astimezone().isoformat(),
    }


class FlowCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.client.__enter__()
        main._hits.clear()
        with db.conexion() as connection:
            connection.execute("DELETE FROM notificaciones")
            connection.execute("DELETE FROM ingresos")

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def test_six_synthetic_cases_and_history(self):
        for index, (insured, reason, expected) in enumerate(CASES):
            response = self.client.post("/webhook/ingreso", json=event(index, insured, reason))
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["veredicto"], expected)
            self.assertEqual({item["estado"] for item in data["notificaciones"]}, {"ENVIADA"})
            self.assertEqual({item["canal"] for item in data["notificaciones"]}, {"log"})
        self.assertEqual(len(self.client.get("/ingresos").json()), len(CASES))

    def test_optional_api_key_is_still_enforced_when_configured(self):
        with patch.dict(os.environ, {"VIGILIA_KEY": "flow-test-key"}, clear=False):
            self.assertEqual(self.client.post("/webhook/ingreso", json=event(1, "8-100-100", "Fractura")).status_code, 401)
            response = self.client.post(
                "/webhook/ingreso",
                json=event(2, "8-100-100", "Fractura"),
                headers={"X-Vigilia-Key": "flow-test-key"},
            )
        self.assertEqual(response.status_code, 200)

    def test_rate_limit_still_caps_at_twenty_requests(self):
        responses = [
            self.client.post("/webhook/ingreso", json=event(index, "8-100-100", "Fractura"))
            for index in range(main.MAX_POR_VENTANA + 1)
        ]
        self.assertEqual([response.status_code for response in responses[:-1]], [200] * 20)
        self.assertEqual(responses[-1].status_code, 429)

    def test_invalid_event_is_rejected(self):
        response = self.client.post("/webhook/ingreso", json=event(1, "8-100-100", "x" * 400))
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
