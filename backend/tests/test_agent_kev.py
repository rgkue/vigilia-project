"""Pruebas unitarias sin red para los adaptadores Kev y Groq."""
import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from app import agent
from app.schemas import EventoIngreso


PREEXISTENCIAS = [
    {"condicion": "Hipertensión arterial"},
    {"condicion": "Diabetes mellitus tipo 2"},
]


def evento() -> EventoIngreso:
    return EventoIngreso(
        evento_id="UNIT-TEST-01",
        cedula="8-400-400",
        hospital="Hospital ficticio",
        motivo_ingreso="Dolor torácico opresivo",
        fecha_ingreso="2026-09-24T10:00:00-05:00",
    )


class RespuestaFalsa:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def cliente_falso(payload=None, error=None, calls=None):
    calls = calls if calls is not None else []

    class Cliente:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, url, json, headers):
            calls.append({"url": url, "body": json, "headers": headers})
            if error:
                raise error
            return RespuestaFalsa(payload)

    return lambda **_kwargs: Cliente()


class KevAdapterTests(unittest.TestCase):
    def run_agent(self, preexistencias=PREEXISTENCIAS):
        return asyncio.run(agent.relacionar_preexistencias(evento(), preexistencias))

    def test_sin_endpoint_queda_pendiente(self):
        with patch.dict(os.environ, {
            "VIGILIA_AI_PROVIDER": "kev",
            "KEV_API_URL": "",
            "KEV_API_KEY": "",
            "VIGILIA_RULES_FALLBACK": "false",
        }, clear=False):
            results = self.run_agent()
        self.assertEqual(len(results), 2)
        self.assertTrue(all("Revisión humana pendiente:" in item.justificacion for item in results))
        self.assertTrue(all(item.relacion == "NINGUNA" for item in results))

    def test_respuesta_valida_conserva_clasificaciones_y_minimiza_datos(self):
        calls = []
        payload = {"answers": {
            "antecedente_1": {"choice": "POSIBLE", "probabilities": {"POSIBLE": 0.91}},
            "antecedente_2": {"choice": "NINGUNA", "probabilities": {"NINGUNA": 0.88}},
        }}
        environment = {
            "VIGILIA_AI_PROVIDER": "kev",
            "VIGILIA_RULES_FALLBACK": "false",
            "KEV_API_URL": "https://kev.example/v1/systemone",
            "KEV_API_KEY": "test-only-key",
            "KEV_MODEL": "kev-test",
            "KEV_MIN_PROBABILITY": "0.75",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload, calls=calls)
        ):
            results = self.run_agent()

        self.assertEqual([item.relacion for item in results], ["POSIBLE", "NINGUNA"])
        self.assertTrue(all("Revisión humana pendiente" in item.justificacion for item in results))
        sent = json.dumps(calls[0]["body"], ensure_ascii=False)
        self.assertNotIn("8-400-400", sent)
        self.assertNotIn("Hospital ficticio", sent)
        self.assertEqual(calls[0]["url"], "https://kev.example/v1/systemone")

    def test_probabilidad_baja_queda_pendiente(self):
        payload = {"answers": {
            "antecedente_1": {"choice": "POSIBLE", "probabilities": {"POSIBLE": 0.74}},
            "antecedente_2": {"choice": "NINGUNA", "probabilities": {"NINGUNA": 0.99}},
        }}
        environment = {
            "VIGILIA_AI_PROVIDER": "kev",
            "VIGILIA_RULES_FALLBACK": "false",
            "KEV_API_URL": "https://kev.example/v1/systemone",
            "KEV_API_KEY": "test-only-key",
            "KEV_MIN_PROBABILITY": "0.75",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload)
        ):
            results = self.run_agent()

        self.assertIn("no alcanzó el umbral", results[0].justificacion)
        self.assertEqual(results[0].relacion, "NINGUNA")
        self.assertEqual(results[1].relacion, "NINGUNA")
        self.assertTrue(results[1].justificacion.lower().startswith("kev sugiere ninguna"))

    def test_formato_invalido_y_error_de_red_quedan_pendientes(self):
        environment = {
            "VIGILIA_AI_PROVIDER": "kev",
            "VIGILIA_RULES_FALLBACK": "false",
            "KEV_API_URL": "https://kev.example/v1/systemone",
            "KEV_API_KEY": "test-only-key",
        }
        for payload, error in (({"unexpected": True}, None), (None, httpx.ConnectError("offline"))):
            with self.subTest(error=error), patch.dict(os.environ, environment, clear=False), patch.object(
                agent.httpx, "AsyncClient", cliente_falso(payload, error=error)
            ):
                results = self.run_agent()
            self.assertEqual(len(results), 2)
            self.assertTrue(all("Revisión humana pendiente:" in item.justificacion for item in results))


class JevAdapterTests(unittest.TestCase):
    def run_agent(self, preexistencias=PREEXISTENCIAS):
        return asyncio.run(agent.relacionar_preexistencias(evento(), preexistencias))

    @staticmethod
    def environment(**overrides):
        environment = {
            "VIGILIA_AI_PROVIDER": "jev",
            "AI_GATEWAY_API_KEY": "test-only-key",
            "KEV_MIN_PROBABILITY": "0.75",
            "JEV_TIMEOUT_SECONDS": "8",
            "VIGILIA_RULES_FALLBACK": "false",
        }
        environment.update(overrides)
        return environment

    @staticmethod
    def zdr_route_metadata(final_provider="typesafe-ai", planning_reasoning="ZDR requested: 1 attempt → 1 ZDR attempt."):
        return {
            "providerMetadata": {
                "gateway": {
                    "routing": {
                        "finalProvider": final_provider,
                        "planningReasoning": planning_reasoning,
                    }
                }
            }
        }

    def test_respuesta_valida_exige_zdr_y_minimiza_datos(self):
        calls = []
        payload = {**self.zdr_route_metadata(), "answers": {
            "antecedente_1": {"choice": "POSIBLE", "probabilities": {"POSIBLE": 0.91}},
            "antecedente_2": {"choice": "NINGUNA", "probabilities": {"NINGUNA": 0.88}},
        }}
        with patch.dict(os.environ, self.environment(), clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload, calls=calls)
        ):
            results = self.run_agent()

        self.assertEqual([item.relacion for item in results], ["POSIBLE", "NINGUNA"])
        self.assertTrue(all(item.justificacion.startswith("Jev sugiere") for item in results))
        sent = calls[0]["body"]
        self.assertEqual(calls[0]["url"], agent.JEV_URL)
        self.assertEqual(sent["model"], agent.JEV_MODEL)
        self.assertEqual(sent["providerOptions"], {
            "gateway": {"zeroDataRetention": True, "only": ["typesafe-ai"]}
        })
        self.assertEqual(sent["state"], {
            "motivo_ingreso": "Dolor torácico opresivo",
            "antecedente_1": "Hipertensión arterial",
            "antecedente_2": "Diabetes mellitus tipo 2",
        })
        self.assertNotIn("8-400-400", json.dumps(sent, ensure_ascii=False))
        self.assertNotIn("Hospital ficticio", json.dumps(sent, ensure_ascii=False))
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer test-only-key")

    def test_sin_clave_no_llama_y_queda_pendiente(self):
        calls = []
        with patch.dict(os.environ, self.environment(AI_GATEWAY_API_KEY=""), clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso({"answers": {}}, calls=calls)
        ):
            results = self.run_agent()

        self.assertEqual(calls, [])
        self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))

    def test_baja_probabilidad_queda_pendiente(self):
        payload = {**self.zdr_route_metadata(), "answers": {
            "antecedente_1": {"choice": "POSIBLE", "probabilities": {"POSIBLE": 0.74}},
            "antecedente_2": {"choice": "NINGUNA", "probabilities": {"NINGUNA": 0.99}},
        }}
        with patch.dict(os.environ, self.environment(), clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload)
        ):
            results = self.run_agent()

        self.assertEqual(results[0].relacion, "NINGUNA")
        self.assertIn("no alcanzó el umbral", results[0].justificacion)
        self.assertEqual(results[1].relacion, "NINGUNA")
        self.assertTrue(results[1].justificacion.startswith("Jev sugiere ninguna"))

    def test_falta_de_auditoria_zdr_deja_sugerencias_pendientes(self):
        answers = {
            "antecedente_1": {"choice": "POSIBLE", "probabilities": {"POSIBLE": 0.99}},
            "antecedente_2": {"choice": "NINGUNA", "probabilities": {"NINGUNA": 0.99}},
        }
        payloads = (
            {"answers": answers},
            {**self.zdr_route_metadata(planning_reasoning="No Training requested: 1 attempt."), "answers": answers},
            {**self.zdr_route_metadata(final_provider="other-provider"), "answers": answers},
        )
        for payload in payloads:
            with self.subTest(provider_metadata=payload.get("providerMetadata")), patch.dict(
                os.environ, self.environment(), clear=False
            ), patch.object(agent.httpx, "AsyncClient", cliente_falso(payload)):
                results = self.run_agent()
            self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))

    def test_respuesta_malformada_o_error_de_red_quedan_pendientes(self):
        for payload, error in (({"unexpected": True}, None), (None, httpx.ConnectError("offline"))):
            with self.subTest(error=error), patch.dict(os.environ, self.environment(), clear=False), patch.object(
                agent.httpx, "AsyncClient", cliente_falso(payload, error=error)
            ):
                results = self.run_agent()
            self.assertEqual(len(results), 2)
            self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))


class GroqAdapterTests(unittest.TestCase):
    def run_agent(self, preexistencias=PREEXISTENCIAS):
        return asyncio.run(agent.relacionar_preexistencias(evento(), preexistencias))

    @staticmethod
    def groq_payload(items):
        content = json.dumps({"preexistencias": items}, ensure_ascii=False)
        return {"choices": [{"message": {"content": content}}]}

    def groq_environment(self, **overrides):
        environment = {
            "VIGILIA_AI_PROVIDER": "groq",
            "GROQ_API_KEY": "test-only-key",
            "GROQ_MODEL": "llama-test",
            "VIGILIA_RULES_FALLBACK": "false",
            "KEV_API_URL": "",
        }
        environment.update(overrides)
        return environment

    def test_respuesta_valida_conserva_contrato_y_minimiza_datos(self):
        calls = []
        payload = self.groq_payload([
            {
                "condicion": "Hipertensión arterial",
                "relacion": "POSIBLE",
                "justificacion": "Hay una asociación posible.",
            },
            {
                "condicion": "Diabetes mellitus tipo 2",
                "relacion": "NINGUNA",
                "justificacion": "Los textos no coinciden claramente.",
            },
        ])
        with patch.dict(os.environ, self.groq_environment(), clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload, calls=calls)
        ):
            results = self.run_agent()

        self.assertEqual([item.relacion for item in results], ["POSIBLE", "NINGUNA"])
        self.assertTrue(all("Revisión humana pendiente" in item.justificacion for item in results))
        sent = json.loads(calls[0]["body"]["messages"][1]["content"])
        self.assertEqual(calls[0]["url"], agent.GROQ_URL)
        self.assertEqual(sent["preexistencias"], ["Hipertensión arterial", "Diabetes mellitus tipo 2"])
        self.assertNotIn("8-400-400", json.dumps(calls[0]["body"], ensure_ascii=False))
        self.assertNotIn("Hospital ficticio", json.dumps(calls[0]["body"], ensure_ascii=False))
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer test-only-key")

    def test_modelo_por_defecto_es_el_reemplazo_actual_de_groq(self):
        calls = []
        payload = self.groq_payload([
            {"condicion": "Hipertensión arterial", "relacion": "POSIBLE", "justificacion": "Asociación posible."},
            {"condicion": "Diabetes mellitus tipo 2", "relacion": "NINGUNA", "justificacion": "Sin coincidencia."},
        ])
        environment = self.groq_environment(GROQ_MODEL="")
        with patch.dict(os.environ, environment, clear=False), patch.object(
            agent.httpx, "AsyncClient", cliente_falso(payload, calls=calls)
        ):
            self.run_agent()
        self.assertEqual(calls[0]["body"]["model"], "openai/gpt-oss-120b")
        self.assertEqual(calls[0]["body"]["response_format"], {"type": "json_object"})

    def test_sin_clave_o_con_respuesta_malformada_queda_pendiente(self):
        cases = (
            (self.groq_environment(GROQ_API_KEY=""), None),
            (self.groq_environment(), {"choices": [{"message": {"content": "no es JSON"}}]}),
            (
                self.groq_environment(),
                self.groq_payload([{
                    "condicion": "Hipertensión arterial",
                    "relacion": "MUY GRAVE",
                    "justificacion": "valor fuera del contrato",
                }]),
            ),
        )
        for environment, payload in cases:
            with self.subTest(payload=payload), patch.dict(os.environ, environment, clear=False):
                if payload is None:
                    results = self.run_agent()
                else:
                    with patch.object(agent.httpx, "AsyncClient", cliente_falso(payload)):
                        results = self.run_agent()
            self.assertEqual(len(results), 2)
            self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))

    def test_error_groq_usa_respaldo_solo_si_se_habilita_y_sigue_pendiente(self):
        environment = self.groq_environment(
            GROQ_API_KEY="",
            VIGILIA_RULES_FALLBACK="true",
        )
        with patch.dict(os.environ, environment, clear=False):
            results = self.run_agent()

        self.assertTrue(all(item.relacion == "NINGUNA" for item in results))
        self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))
        self.assertIn("Sugerencia de respaldo local:", results[0].justificacion)
        self.assertIn("posible", results[0].justificacion.casefold())

    def test_proveedor_desconocido_no_se_convierte_en_resultado_negativo(self):
        environment = self.groq_environment(
            VIGILIA_AI_PROVIDER="grok",
            VIGILIA_RULES_FALLBACK="false",
        )
        with patch.dict(os.environ, environment, clear=False):
            results = self.run_agent()

        self.assertTrue(all(item.relacion == "NINGUNA" for item in results))
        self.assertTrue(all("Revisión humana pendiente:" in item.justificacion for item in results))


class SlackMessageTests(unittest.TestCase):
    def test_external_mentions_and_links_are_escaped(self):
        malicious_event = evento().model_copy(update={
            "motivo_ingreso": "<!channel> <https://example.test|abrir>",
        })
        messages = asyncio.run(
            agent.redactar_mensajes(
                malicious_event,
                "Paciente <@everyone>",
                None,
                "NO_ENCONTRADO",
                "MEDIO",
                [],
            )
        )
        combined = messages.admisiones + messages.gestor
        self.assertNotIn("<!channel>", combined)
        self.assertNotIn("<@everyone>", combined)
        self.assertNotIn("<https://", combined)
        self.assertIn("&lt;!channel&gt;", combined)
        self.assertIn("&lt;https://example.test|abrir&gt;", combined)


if __name__ == "__main__":
    unittest.main()
