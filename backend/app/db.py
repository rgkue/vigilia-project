import os
import sqlite3
from contextlib import contextmanager

from .seed import cargar_seed

DB_PATH = os.getenv("VIGILIA_DB", "vigilia.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS asegurados (cedula TEXT PRIMARY KEY, nombre TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS polizas (
  numero TEXT PRIMARY KEY, cedula TEXT NOT NULL, plan TEXT, vigente_desde TEXT, vigente_hasta TEXT,
  estado_pago TEXT, carencia_dias INTEGER);
CREATE TABLE IF NOT EXISTS preexistencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cedula TEXT NOT NULL, condicion TEXT, fecha_diagnostico TEXT);
CREATE TABLE IF NOT EXISTS ingresos (
  evento_id TEXT PRIMARY KEY, cedula TEXT, hospital TEXT, motivo TEXT, veredicto TEXT,
  nivel_alerta TEXT, respuesta_json TEXT, creado_en TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notificaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evento_id TEXT, destino TEXT, canal TEXT, estado TEXT,
  mensaje TEXT, creado_en TEXT DEFAULT CURRENT_TIMESTAMP);
"""


@contextmanager
def conexion():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with conexion() as c:
        c.executescript(SCHEMA)
        if c.execute("SELECT COUNT(*) FROM asegurados").fetchone()[0] == 0:
            cargar_seed(c)
