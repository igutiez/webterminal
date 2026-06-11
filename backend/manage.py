"""Mini-CLI de administración de WebTerminal (usuarios del login web).

Uso (con el venv de la instalación):
  python manage.py create-user correo@ejemplo.com            # pide la contraseña
  python manage.py create-user correo@ejemplo.com --password X
  python manage.py set-password correo@ejemplo.com
  python manage.py list-users

La identidad SSH NO se toca aquí: es la del usuario del sistema y se introduce
al abrir la terminal. Esto solo gestiona la puerta de entrada web.
"""
import argparse
import getpass
import sys

import db

MIN_PW_LEN = 8


def _ask_password() -> str:
    pw = getpass.getpass("Contraseña: ")
    pw2 = getpass.getpass("Repítela:    ")
    if pw != pw2:
        sys.exit("Las contraseñas no coinciden.")
    return pw


def _check_pw(pw: str) -> str:
    if len(pw) < MIN_PW_LEN:
        sys.exit(f"La contraseña debe tener al menos {MIN_PW_LEN} caracteres.")
    return pw


def main() -> None:
    p = argparse.ArgumentParser(description="Gestión de usuarios web de WebTerminal")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create-user", help="Crea (o actualiza) un usuario web")
    c.add_argument("email")
    c.add_argument("--password", help="Si se omite, se pide de forma interactiva")

    s = sub.add_parser("set-password", help="Cambia la contraseña de un usuario")
    s.add_argument("email")
    s.add_argument("--password")

    sub.add_parser("list-users", help="Lista los emails registrados")

    args = p.parse_args()
    db.init_db()

    if args.cmd == "list-users":
        emails = db.list_emails()
        print("\n".join(emails) if emails else "(sin usuarios)")
        return

    email = args.email.strip().lower()
    if "@" not in email:
        sys.exit("Email no válido.")
    pw = _check_pw(args.password or _ask_password())

    if args.cmd == "create-user":
        db.create_or_update_user(email, pw)
        print(f"Usuario '{email}' listo.")
    elif args.cmd == "set-password":
        if not db.get_user(email):
            sys.exit(f"No existe el usuario '{email}'.")
        db.set_password(email, pw)
        print(f"Contraseña de '{email}' actualizada.")


if __name__ == "__main__":
    main()
