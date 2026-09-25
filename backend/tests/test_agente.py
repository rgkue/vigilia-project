"""Pruebas heredadas del backend remoto, adaptadas al contrato local pendiente."""
import asyncio
import json
import os
import unittest
from unittest.mock import patch

from app import agent
from app.schemas import EventoIngreso

PREEXISTENCIAS = [
    {"condicion": "Hipertensión arterial"},
    {"condicion": "Diabetes mellitus tipo 2"},
]


def ev(motivo):
    return EventoIngreso(
        evento_id="AGENT-TEST",
        cedula="8-400-400",
        hospital="Hospital ficticio",
        motivo_ingreso=motivo,
        fecha_ingreso="2026-09-24T10:00:00-05:00",
    )


def correr(motivo, preexistencias=PREEXISTENCIAS):
    return asyncio.run(agent.relacionar_preexistencias(ev(motivo), preexistencias))


class AgentCompatibilityTests(unittest.TestCase):
    def test_respaldo_de_reglas_es_solo_una_pista_pendiente(self):
        with patch.dict(os.environ, {
            "VIGILIA_AI_PROVIDER": "groq",
            "GROQ_API_KEY": "",
            "VIGILIA_RULES_FALLBACK": "true",
        }, clear=False):
            results = correr("Dolor torácico opresivo")
        self.assertTrue(all(item.relacion == "NINGUNA" for item in results))
        self.assertTrue(all(item.justificacion.startswith("Revisión humana pendiente:") for item in results))
        self.assertIn("posible", results[0].justificacion.casefold())

    def test_respaldo_sin_coincidencia_no_afirma_resultado_negativo(self):
        with patch.dict(os.environ, {
            "VIGILIA_AI_PROVIDER": "groq",
            "GROQ_API_KEY": "",
            "VIGILIA_RULES_FALLBACK": "true",
        }, clear=False):
            results = correr("Fractura de muñeca")
        self.assertTrue(all(item.relacion == "NINGUNA" for item in results))
        self.assertTrue(all("no se concluye" in item.justificacion.casefold() for item in results))

    def test_no_antecedentes_devuelve_lista_vacia(self):
        self.assertEqual(correr("Dolor torácico", preexistencias=[]), [])

    def test_mensajes_escapan_menciones_y_enlaces(self):
        event = ev("<!channel> <https://unsafe.example|abrir>")
        messages = asyncio.run(agent.redactar_mensajes(event, "Ana", None, "NO_ENCONTRADO", "MEDIO", []))
        content = messages.admisiones + messages.gestor
        self.assertNotIn("<!channel>", content)
        self.assertNotIn("<https://", content)
        self.assertIn("&lt;!channel&gt;", content)


if __name__ == "__main__":
    unittest.main()
