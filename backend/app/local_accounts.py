"""Local Vigilia accounts: password hashing, policy and brute-force lockout.

Passwords protect accounts with administrative permissions. They are always combined with the
account's TOTP code, and they are only checked after that code is valid.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

from fastapi import HTTPException

from . import db

SCRYPT_R = 8
SCRYPT_P = 1
LOCK_WINDOW_SECONDS = 15 * 60
MAX_PASSWORD_FAILURES = 5
PASSWORD_MIN = 12
PASSWORD_MAX = 128
TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
COMMON_PASSWORDS = {"contraseña123", "contrasena123", "password1234", "vigilia12345", "123456789012", "qwertyuiop12"}


def _scrypt_log_n() -> int:
    # 2^17 follows OWASP guidance for scrypt; tests may lower it through the environment.
    return max(12, min(int(os.getenv("VIGILIA_SCRYPT_LOG_N", "17")), 20))


def _derive(password: str, salt: bytes, log_n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** log_n, r=r, p=p, maxmem=2 ** 29, dklen=32)


def hash_password(password: str) -> str:
    log_n = _scrypt_log_n()
    salt = secrets.token_bytes(16)
    digest = _derive(password, salt, log_n, SCRYPT_R, SCRYPT_P)
    encode = lambda value: base64.b64encode(value).decode()
    return f"scrypt${log_n}${SCRYPT_R}${SCRYPT_P}${encode(salt)}${encode(digest)}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        scheme, log_n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = _derive(password, base64.b64decode(salt), int(log_n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def validate_new_password(password: str, account_id: str) -> None:
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        raise HTTPException(422, f"La contraseña debe tener entre {PASSWORD_MIN} y {PASSWORD_MAX} caracteres.")
    if password != password.strip():
        raise HTTPException(422, "La contraseña no puede empezar ni terminar con espacios.")
    lowered = password.casefold()
    if account_id and account_id.casefold() in lowered:
        raise HTTPException(422, "La contraseña no puede contener tu ID de acceso.")
    if len(set(password)) < 4 or lowered in COMMON_PASSWORDS:
        raise HTTPException(422, "Elige una contraseña menos predecible.")


def generate_temporary_password() -> str:
    raw = "".join(secrets.choice(TEMP_ALPHABET) for _ in range(16))
    return "-".join(raw[index:index + 4] for index in range(0, 16, 4))


def _bucket(user_id: str) -> str:
    return hashlib.sha256(f"password-failure:{user_id}".encode()).hexdigest()


def ensure_not_locked(user_id: str) -> None:
    now = int(time.time())
    with db.conexion() as connection:
        row = connection.execute("SELECT window_start, attempts FROM auth_attempts WHERE bucket=?", (_bucket(user_id),)).fetchone()
    if row and row["window_start"] > now - LOCK_WINDOW_SECONDS and row["attempts"] >= MAX_PASSWORD_FAILURES:
        retry = LOCK_WINDOW_SECONDS - (now - row["window_start"])
        raise HTTPException(429, "Demasiados intentos con contraseña incorrecta. Espera 15 minutos o pide a un administrador que la restablezca.",
                            headers={"Retry-After": str(max(retry, 60))})


def register_failure(user_id: str) -> None:
    now = int(time.time())
    with db.conexion() as connection:
        connection.execute(
            "INSERT INTO auth_attempts (bucket,window_start,attempts) VALUES (?,?,1) "
            "ON CONFLICT(bucket) DO UPDATE SET "
            "attempts=CASE WHEN auth_attempts.window_start<=? THEN 1 ELSE auth_attempts.attempts+1 END, "
            "window_start=CASE WHEN auth_attempts.window_start<=? THEN ? ELSE auth_attempts.window_start END",
            (_bucket(user_id), now, now - LOCK_WINDOW_SECONDS, now - LOCK_WINDOW_SECONDS, now),
        )


def clear_failures(user_id: str) -> None:
    with db.conexion() as connection:
        connection.execute("DELETE FROM auth_attempts WHERE bucket=?", (_bucket(user_id),))
