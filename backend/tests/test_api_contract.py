"""Pruebas de contrato local: FastAPI, CORS, autenticación y límite de uso."""
from datetime import datetime
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

TEST_DIRECTORY = tempfile.TemporaryDirectory(prefix="vigilia-api-tests-")
os.environ["VIGILIA_MODE"] = "demo"
os.environ["VIGILIA_DB"] = str(Path(TEST_DIRECTORY.name) / "vigilia-tests.db")
os.environ["VIGILIA_KEY"] = ""
os.environ["VIGILIA_AI_PROVIDER"] = "kev"
os.environ["VIGILIA_RULES_FALLBACK"] = "false"
os.environ["KEV_API_URL"] = ""
os.environ["KEV_API_KEY"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ["SLACK_ENABLED"] = "false"
os.environ["SLACK_WEBHOOK_ADMISIONES"] = ""
os.environ["SLACK_WEBHOOK_GESTOR"] = ""
os.environ["VIGILIA_CORS_ORIGINS"] = "http://127.0.0.1:5173"

from fastapi.testclient import TestClient

from app import db, main
from app.main import app


def event(event_id="API-TEST", insured="8-100-100", reason="Fractura de muñeca"):
    return {
        "evento_id": event_id,
        "cedula": insured,
        "hospital": "Hospital de prueba",
        "motivo_ingreso": reason,
        "fecha_ingreso": datetime.now().astimezone().isoformat(),
    }


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.client.__enter__()
        main._hits.clear()
        with db.conexion() as connection:
            connection.execute("DELETE FROM notificaciones")
            connection.execute("DELETE FROM ingresos")

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def test_six_demo_cases_keep_public_schema_and_pending_review(self):
        cases = [
            ("8-100-100", "Fractura de muñeca", "VALIDA_CON_ALERTAS"),
            ("8-200-200", "Dolor torácico", "NO_VALIDA"),
            ("8-300-300", "Dolor torácico", "VALIDA_CON_ALERTAS"),
            ("8-400-400", "Dolor torácico", "VALIDA_CON_ALERTAS"),
            ("8-500-500", "Fractura de muñeca", "VALIDA_CON_ALERTAS"),
            ("9-999-999", "Dolor torácico", "NO_ENCONTRADO"),
        ]
        for index, (insured, reason, expected) in enumerate(cases):
            response = self.client.post("/webhook/ingreso", json=event(f"API-{index}", insured, reason))
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["veredicto"], expected)
            self.assertEqual(len(data["notificaciones"]), 2)
            self.assertEqual({notice["canal"] for notice in data["notificaciones"]}, {"log"})
            for relation in data["preexistencias"]:
                self.assertIn(relation["relacion"], {"DIRECTA", "POSIBLE", "NINGUNA"})
            if insured in {"8-100-100", "8-400-400"}:
                self.assertTrue(all(
                    "Revisión humana pendiente:" in item["justificacion"]
                    for item in data["preexistencias"]
                ))

        history = self.client.get("/ingresos?limite=10")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()), len(cases))

    def test_invalid_input_is_rejected(self):
        response = self.client.post("/webhook/ingreso", json=event(reason="x" * 400))
        self.assertEqual(response.status_code, 422)

    def test_optional_api_key_behavior_is_preserved(self):
        with patch.dict(os.environ, {"VIGILIA_KEY": "unit-test-key"}, clear=False):
            self.assertEqual(self.client.post("/webhook/ingreso", json=event()).status_code, 401)
            response = self.client.post(
                "/webhook/ingreso",
                json=event("AUTH-OK"),
                headers={"X-Vigilia-Key": "unit-test-key"},
            )
        self.assertEqual(response.status_code, 200)

    def test_rate_limit_still_caps_requests_at_twenty_per_minute(self):
        responses = [
            self.client.post("/webhook/ingreso", json=event(f"LIMIT-{index}"))
            for index in range(main.MAX_POR_VENTANA + 1)
        ]
        self.assertEqual([response.status_code for response in responses[:-1]], [200] * 20)
        self.assertEqual(responses[-1].status_code, 429)

    def test_cors_allows_only_configured_local_frontend(self):
        preflight = self.client.options(
            "/webhook/ingreso",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(preflight.status_code, 200)
        self.assertEqual(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173")

        untrusted = self.client.options(
            "/webhook/ingreso",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertNotEqual(untrusted.headers.get("access-control-allow-origin"), "https://untrusted.example")


if __name__ == "__main__":
    unittest.main()
