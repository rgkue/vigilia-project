"""Datos de prueba. Las fechas son relativas a hoy para que la demo funcione siempre."""
from datetime import date, timedelta


def _d(dias: int) -> str:
    return (date.today() + timedelta(days=dias)).isoformat()


ASEGURADOS = [
    ("8-100-100", "Ana Pérez"),        # caso 1: todo en orden
    ("8-200-200", "Carlos Gómez"),     # caso 2: póliza vencida
    ("8-300-300", "Lucía Ríos"),       # caso 3: en período de carencia
    ("8-400-400", "Miguel Torres"),    # caso 4: preexistencias relacionadas
    ("8-500-500", "Sofía Vega"),       # caso 5: pago atrasado
]
# numero, cedula, plan, vigente_desde, vigente_hasta, estado_pago, carencia_dias
POLIZAS = [
    ("POL-1001", "8-100-100", "Plan Integral", _d(-400), _d(300), "AL_DIA", 30),
    ("POL-1002", "8-200-200", "Plan Básico", _d(-500), _d(-15), "AL_DIA", 30),
    ("POL-1003", "8-300-300", "Plan Integral", _d(-10), _d(355), "AL_DIA", 30),
    ("POL-1004", "8-400-400", "Plan Premium", _d(-900), _d(200), "AL_DIA", 30),
    ("POL-1005", "8-500-500", "Plan Básico", _d(-300), _d(60), "MOROSO", 30),
]
# cedula, condicion, fecha_diagnostico
PREEXISTENCIAS = [
    ("8-100-100", "Asma leve", "2019-05-01"),
    ("8-400-400", "Hipertensión arterial", "2018-03-12"),
    ("8-400-400", "Diabetes mellitus tipo 2", "2020-08-30"),
]


def cargar_seed(c) -> None:
    c.executemany("INSERT INTO asegurados VALUES (?, ?)", ASEGURADOS)
    c.executemany("INSERT INTO polizas VALUES (?, ?, ?, ?, ?, ?, ?)", POLIZAS)
    c.executemany("INSERT INTO preexistencias (cedula, condicion, fecha_diagnostico) VALUES (?, ?, ?)", PREEXISTENCIAS)
