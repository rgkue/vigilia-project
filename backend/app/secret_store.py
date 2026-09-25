"""Encrypt integration credentials with a key supplied by the client's runtime."""
from __future__ import annotations

import os


def _fernet():
    from cryptography.fernet import Fernet

    key = (os.getenv("VIGILIA_SECRET_ENCRYPTION_KEY") or "").strip()
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
