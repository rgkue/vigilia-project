"""Las sugerencias inciertas no deben convertirse en decisiones de cobertura."""
import unittest

from app import rules
from app.schemas import PolizaInfo, PreexistenciaRelacionada


class PendingClassificationRulesTests(unittest.TestCase):
    def setUp(self):
        self.policy = PolizaInfo(
            numero="POL-TEST",
            plan="Plan ficticio",
            vigente=True,
            al_dia_pago=True,
            en_carencia=False,
        )

    def test_directa_de_modelo_marcada_pendiente_no_eleva_a_prioridad_alta(self):
        suggestion = PreexistenciaRelacionada(
            condicion="Hipertensión",
            relacion="DIRECTA",
            justificacion="Groq sugiere directa. Revisión humana pendiente.",
        )
        self.assertEqual(rules.decidir(self.policy, [suggestion]), ("VALIDA_CON_ALERTAS", "MEDIO"))

    def test_directa_confirmada_conserva_prioridad_alta(self):
        confirmed = PreexistenciaRelacionada(
            condicion="Hipertensión",
            relacion="DIRECTA",
            justificacion="Relación confirmada por revisión humana.",
        )
        self.assertEqual(rules.decidir(self.policy, [confirmed]), ("VALIDA_CON_ALERTAS", "ALTO"))


if __name__ == "__main__":
    unittest.main()
