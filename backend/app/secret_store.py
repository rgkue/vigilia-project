"""Encrypt integration credentials with a key supplied by the client's runtime."""
from __future__ import annotations

import os
from pathlib import Path


def _fernet():
    from cryptography.fernet import Fernet

    key = (os.getenv("VIGILIA_SECRET_ENCRYPTION_KEY") or "").strip()
    if not key and (os.getenv("VIGILIA_MODE") or "production").strip().casefold() == "demo":
        # Reuse the persistent key of the local AI preview environment when its launcher
        # has not exported it (for example when the backend is started directly in demo mode).
        key_path = Path(__file__).resolve().parents[1] / ".local-dev" / "ai-settings" / "encryption.key"
        try:
            key = key_path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            pass
    if not key:
        raise RuntimeError("VIGILIA_SECRET_ENCRYPTION_KEY no está configurada.")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("VIGILIA_SECRET_ENCRYPTION_KEY debe ser una clave Fernet válida.") from exc


def encrypt(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str | None) -> str:
    if not value:
        return ""
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken as exc:
        raise RuntimeError("No se pudo descifrar una credencial de integración.") from exc
