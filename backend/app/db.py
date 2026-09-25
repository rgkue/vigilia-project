"""Database access for demo SQLite and production PostgreSQL."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class CompatRow(dict):
    """Mapping row that also preserves sqlite's ``row[0]`` access pattern."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


class CursorAdapter:
    def __init__(self, cursor: Any):
        self._cursor = cursor

    def fetchone(self):
        row = self._cursor.fetchone()
        return CompatRow(row) if row is not None and not isinstance(row, CompatRow) else row

    def fetchall(self):
        return [CompatRow(row) if not isinstance(row, CompatRow) else row for row in self._cursor.fetchall()]

    def __iter__(self):
        for row in self._cursor:
            yield CompatRow(row) if not isinstance(row, CompatRow) else row

    @property
    def rowcount(self):
        return self._cursor.rowcount


class ConnectionAdapter:
    def __init__(self, connection: Any, postgres: bool):
        self._connection = connection
        self._postgres = postgres

    def _sql(self, statement: str) -> str:
        return statement.replace("?", "%s") if self._postgres else statement

    def execute(self, statement: str, parameters: Any = ()) -> CursorAdapter:
        return CursorAdapter(self._connection.execute(self._sql(statement), parameters))

    def executemany(self, statement: str, parameters: Any) -> CursorAdapter:
        return CursorAdapter(self._connection.executemany(self._sql(statement), parameters))

    def executescript(self, script: str) -> None:
        if self._postgres:
            for statement in script.split(";"):
                if statement.strip():
                    self.execute(statement)
        else:
            self._connection.executescript(script)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()


SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS asegurados (cedula TEXT PRIMARY KEY, nombre TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS polizas (
  numero TEXT PRIMARY KEY, cedula TEXT NOT NULL, plan TEXT, vigente_desde TEXT, vigente_hasta TEXT,
  estado_pago TEXT, carencia_dias INTEGER);
CREATE TABLE IF NOT EXISTS preexistencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cedula TEXT NOT NULL, condicion TEXT, fecha_diagnostico TEXT);
CREATE TABLE IF NOT EXISTS ingresos (
  evento_id TEXT PRIMARY KEY, cedula TEXT, hospital TEXT, motivo TEXT, veredicto TEXT,
  nivel_alerta TEXT, respuesta_json TEXT, creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT, estado TEXT NOT NULL DEFAULT 'COMPLETADO');
CREATE TABLE IF NOT EXISTS notificaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evento_id TEXT, destino TEXT, canal TEXT, estado TEXT,
  mensaje TEXT, creado_en TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(evento_id, destino));
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT, email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  roles_json TEXT NOT NULL DEFAULT '[]', permissions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT,
  UNIQUE(issuer, email));
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_subject_idx ON user_profiles(issuer, subject) WHERE subject IS NOT NULL;
CREATE TABLE IF NOT EXISTS integration_configs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, endpoint_url TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'GET', lookup_parameter TEXT NOT NULL DEFAULT 'cedula',
  field_map_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
  encrypted_secret TEXT, status TEXT NOT NULL DEFAULT 'not_configured', last_checked_at TEXT,
  last_error TEXT, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, secret_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, revoked_at TEXT,
  FOREIGN KEY(integration_id) REFERENCES integration_configs(id));
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL,
  resource_id TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_actions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, classification_index INTEGER NOT NULL,
  original_relation TEXT NOT NULL, reviewed_relation TEXT NOT NULL, reason TEXT NOT NULL,
  reviewer_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(event_id, classification_index));
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
"""


def _postgres_url() -> str:
    return (os.getenv("DATABASE_URL") or "").strip()


def _is_postgres() -> bool:
    return _postgres_url().startswith(("postgresql://", "postgres://"))


def database_mode() -> str:
    return (os.getenv("VIGILIA_MODE") or "production").strip().casefold()


def _sqlite_path() -> str:
    return os.getenv("VIGILIA_DB") or "vigilia.db"


@contextmanager
def conexion() -> Iterator[ConnectionAdapter]:
    postgres = _is_postgres()
    if postgres:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - depends on production extra
            raise RuntimeError("Instala psycopg[binary] para usar PostgreSQL.") from exc
        raw = psycopg.connect(_postgres_url(), row_factory=dict_row)
    else:
        raw = sqlite3.connect(_sqlite_path(), timeout=15)
        raw.row_factory = sqlite3.Row
        raw.execute("PRAGMA foreign_keys = ON")
        raw.execute("PRAGMA busy_timeout = 15000")
    connection = ConnectionAdapter(raw, postgres)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        raw.close()


def _apply_postgres_migrations(connection: ConnectionAdapter) -> None:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations "
        "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    migration_dir = Path(__file__).resolve().parent.parent / "migrations"
    files = sorted(migration_dir.glob("*.sql"))
    for migration in files:
        version = migration.stem
        if connection.execute("SELECT 1 FROM schema_migrations WHERE version = ?", (version,)).fetchone():
            continue
        for statement in migration.read_text(encoding="utf-8").split(";"):
            if statement.strip():
                connection.execute(statement)
        connection.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))


def _ensure_sqlite_columns(connection: ConnectionAdapter) -> None:
    existing = {row["name"] for row in connection.execute("PRAGMA table_info(ingresos)").fetchall()}
    for name, definition in (
        ("payload_hash", "TEXT"),
        ("estado", "TEXT NOT NULL DEFAULT 'COMPLETADO'"),
    ):
        if name not in existing:
            connection.execute(f"ALTER TABLE ingresos ADD COLUMN {name} {definition}")
    notification_cols = {row["name"] for row in connection.execute("PRAGMA table_info(notificaciones)").fetchall()}
    if "creado_en" not in notification_cols:
        connection.execute("ALTER TABLE notificaciones ADD COLUMN creado_en TEXT DEFAULT CURRENT_TIMESTAMP")
    connection.execute(
        "DELETE FROM notificaciones WHERE id NOT IN "
        "(SELECT MAX(id) FROM notificaciones GROUP BY evento_id, destino)"
    )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_evento_destino_idx "
        "ON notificaciones(evento_id, destino)"
    )


def init_db() -> None:
    mode = database_mode()
    if mode not in {"demo", "production"}:
        raise RuntimeError("VIGILIA_MODE debe ser 'demo' o 'production'.")
    if mode == "production" and not _is_postgres():
        raise RuntimeError("Producción requiere DATABASE_URL con PostgreSQL; SQLite solo se permite en modo demo.")

    with conexion() as connection:
        if _is_postgres():
            _apply_postgres_migrations(connection)
        else:
            connection.executescript(SQLITE_SCHEMA)
            _ensure_sqlite_columns(connection)
        if mode == "demo" and os.getenv("VIGILIA_SEED_DEMO", "true").strip().casefold() == "true":
            if connection.execute("SELECT COUNT(*) FROM asegurados").fetchone()[0] == 0:
                from .seed import cargar_seed

                cargar_seed(connection)
        if mode == "demo":
            connection.execute(
                "INSERT INTO user_profiles (id, issuer, subject, email, display_name, active, roles_json, permissions_json, created_at, updated_at) "
                "VALUES ('demo-admin', 'demo', 'demo-admin', 'demo@vigilia.local', 'Administrador de demostración', TRUE, '[\"administrador\"]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) "
                "ON CONFLICT(id) DO NOTHING",
                ('["users.manage","integrations.manage","ingress.submit","ingress.read","classification.review","audit.read"]',),
            )
