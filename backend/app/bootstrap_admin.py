"""Create the first local administrator of an installation.

Usage (from backend/, with the same environment as the server):

    python -m app.bootstrap_admin --id ADMIN-01 --name "Nombre Apellido"

Prints, once, the temporary password and the authenticator setup. The password must be changed
on first sign-in. Refuses to run while any active account can already administer people.
"""
from __future__ import annotations

import argparse
import re
import sys

from dotenv import load_dotenv


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    from fastapi import HTTPException

    from . import db, employees, local_accounts, security
    from .audit import record

    parser = argparse.ArgumentParser(description="Crea el primer administrador local de Vigilia.")
    parser.add_argument("--id", default="ADMIN-01", help="ID de acceso (letras, números y guiones).")
    parser.add_argument("--name", required=True, help="Nombre completo para mostrar.")
    args = parser.parse_args(argv)

    account_id = args.id.strip().upper()
    name = args.name.strip()
    if not re.fullmatch(r"[A-Z0-9-]{1,40}", account_id):
        print("El ID solo admite hasta 40 letras, números o guiones.", file=sys.stderr)
        return 2
    if not name or len(name) > 160:
        print("Indica un nombre de hasta 160 caracteres.", file=sys.stderr)
        return 2

    try:
        db.init_db()
        secret = employees.new_totp_secret()
        encrypted = employees.cipher().encrypt(secret.encode()).decode()
    except (RuntimeError, HTTPException) as exc:
        print(f"No se pudo preparar la base de datos: {getattr(exc, 'detail', exc)}", file=sys.stderr)
        return 1
    temporary = local_accounts.generate_temporary_password()
    password_hash = local_accounts.hash_password(temporary)

    with db.conexion() as connection:
        managers = connection.execute(
            "SELECT id, permissions_json FROM user_profiles WHERE active = TRUE AND issuer != 'demo'"
        ).fetchall()
        if any("users.manage" in (row["permissions_json"] or "") for row in managers):
            print("Ya existe una cuenta activa que administra personas. Crea las siguientes desde Administración → Personas.",
                  file=sys.stderr)
            return 3
        if connection.execute("SELECT 1 FROM employees WHERE employee_id = ?", (account_id,)).fetchone():
            print(f"El ID {account_id} ya está registrado.", file=sys.stderr)
            return 3
        user_id = employees.insert_employee(connection, account_id, name, None, ["administrador"], sorted(security.PERMISSION_CATALOG))
        connection.execute(
            "UPDATE employees SET encrypted_totp_secret=?, password_hash=?, must_change_password=TRUE, credential_version=1 WHERE user_id=?",
            (encrypted, password_hash, user_id),
        )
    record(None, "bootstrap.local_admin", "user", user_id)

    uri = employees.enrollment_uri(account_id, secret)
    print(f"""
Administrador creado: {name} ({account_id})

1. En la app autenticadora (Google Authenticator, Microsoft Authenticator u otra con TOTP),
   añade una cuenta con esta clave:  {secret}
   o importa este enlace:            {uri}
2. Entra en Vigilia con el ID {account_id}, el código de la app y esta contraseña temporal:
                                     {temporary}
3. Vigilia te pedirá cambiarla antes de continuar.

Esta información no se vuelve a mostrar. Guárdala solo hasta completar el primer acceso.
""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
