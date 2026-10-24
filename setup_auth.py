"""Creates or rotates the login secrets for the internet-facing panel. Run ON THE SERVER:

    python3 setup_auth.py ~/.config/oracle-panel/secrets.json            # prompt for a password
    python3 setup_auth.py ~/.config/oracle-panel/secrets.json --generate # random password, printed once
    python3 setup_auth.py ... --keep-totp                                # change password, keep 2FA app entry

Restart the service afterwards: sudo systemctl restart oracle-panel
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import socket
import sys
from pathlib import Path
from urllib.parse import quote

from auth import AuthConfigError, AuthSecrets, hash_password, new_totp_secret

MIN_PASSWORD_CHARS = 12
GENERATED_PASSWORD_BYTES = 15
ISSUER = "OraclePanel"


def prompt_password() -> str:
    first = getpass.getpass(f"Mật khẩu mới (tối thiểu {MIN_PASSWORD_CHARS} ký tự): ")
    if len(first) < MIN_PASSWORD_CHARS:
        raise SystemExit("Mật khẩu quá ngắn")
    if getpass.getpass("Nhập lại: ") != first:
        raise SystemExit("Hai lần nhập không khớp")
    return first


def write_private_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    descriptor = os.open(temp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(temp_path, path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Tạo mật khẩu + 2FA cho Oracle Panel")
    parser.add_argument("secrets_path", type=Path)
    parser.add_argument("--generate", action="store_true", help="sinh mật khẩu ngẫu nhiên thay vì hỏi")
    parser.add_argument("--keep-totp", action="store_true", help="giữ mã 2FA hiện có")
    args = parser.parse_args()

    totp_secret = new_totp_secret()
    if args.keep_totp:
        try:
            totp_secret = AuthSecrets.load(args.secrets_path).totp_secret
        except AuthConfigError as exc:
            raise SystemExit(f"--keep-totp cần file bí mật cũ: {exc}") from exc
    password = secrets.token_urlsafe(GENERATED_PASSWORD_BYTES) if args.generate else prompt_password()
    write_private_json(args.secrets_path, {"password_hash": hash_password(password), "totp_secret": totp_secret})

    account = quote(f"{getpass.getuser()}@{socket.gethostname()}")
    print(f"Đã ghi {args.secrets_path} (quyền 600).")
    if args.generate:
        print(f"Mật khẩu: {password}")
    if not args.keep_totp:
        print(f"Khoá 2FA (nhập tay vào Google Authenticator): {totp_secret}")
        print(f"otpauth://totp/{ISSUER}:{account}?secret={totp_secret}&issuer={ISSUER}&digits=6&period=30")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
