"""Append-only application audit trail. Details must never contain patient data or secrets."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .db import conexion


def record(actor_id: str | None, action: str, resource_type: str, resource_id: str | None, details: dict[str, Any] | None = None) -> None:
    with conexion() as connection:
        connection.execute(
            "INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()), actor_id, action, resource_type, resource_id,
                json.dumps(details or {}, sort_keys=True), datetime.now(timezone.utc),
            ),
        )


def recent(limit: int = 100) -> list[dict[str, Any]]:
    with conexion() as connection:
        rows = connection.execute(
            "SELECT id, actor_id, action, resource_type, resource_id, details_json, created_at "
            "FROM audit_events ORDER BY created_at DESC LIMIT ?",
            (max(1, min(limit, 500)),),
        ).fetchall()
    return [{**dict(row), "details": json.loads(row["details_json"] or "{}")} for row in rows]
