"""Login for the internet-facing deployment: scrypt password + TOTP (RFC 6238), bearer sessions,
and brute-force lockout. Stdlib only so the server needs no pip installs."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
SCRYPT_KEY_BYTES = 32
TOTP_STEP_SEC = 30
TOTP_DIGITS = 6
TOTP_DRIFT_STEPS = 1               # accept the previous/next 30s window for clock skew
SESSION_TTL_SEC = 8 * 3600
MAX_SESSIONS = 20
FAILURE_WINDOW_SEC = 15 * 60
MAX_FAILURES_PER_CLIENT = 5
MAX_FAILURES_GLOBAL = 20           # caps distributed guessing across many IPs
LOCKOUT_SEC = 15 * 60


class AuthConfigError(RuntimeError):
    """Secrets file missing or malformed."""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_KEY_BYTES)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = encoded.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p),
                                   dklen=len(digest_hex) // 2)
    except ValueError:
        return False
    return hmac.compare_digest(candidate.hex(), digest_hex)


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp_code(secret_b32: str, counter: int) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**TOTP_DIGITS).zfill(TOTP_DIGITS)


def match_totp(secret_b32: str, code: str, now: float) -> int | None:
    """Returns the matched time-step counter, or None."""
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return None
    current = int(now // TOTP_STEP_SEC)
    for counter in range(current - TOTP_DRIFT_STEPS, current + TOTP_DRIFT_STEPS + 1):
        if hmac.compare_digest(_totp_code(secret_b32, counter), code):
            return counter
    return None


@dataclass(frozen=True)
class AuthSecrets:
    password_hash: str
    totp_secret: str

    @classmethod
    def load(cls, path: Path) -> AuthSecrets:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return cls(password_hash=raw["password_hash"], totp_secret=raw["totp_secret"])
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            raise AuthConfigError(f"Không đọc được file bí mật {path}: {exc}") from exc


class LoginGate:
    """Verifies credentials, issues bearer sessions, and locks out repeated failures."""

    def __init__(self, auth_secrets: AuthSecrets) -> None:
        self._secrets = auth_secrets
        self._sessions: dict[str, float] = {}          # sha256(token) -> expiry epoch
        self._failures: dict[str, list[float]] = {}    # client -> failure timestamps
        self._locked_until: dict[str, float] = {}
        self._last_totp_counter = -1                   # rejects replay of an already-used code
        self._lock = threading.Lock()

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def lockout_remaining(self, client: str, now: float) -> int:
        with self._lock:
            return max(int(self._locked_until.get(client, 0) - now), int(self._locked_until.get("*", 0) - now), 0)

    def _record_failure(self, client: str, now: float) -> None:
        for key, limit in ((client, MAX_FAILURES_PER_CLIENT), ("*", MAX_FAILURES_GLOBAL)):
            recent = [t for t in self._failures.get(key, []) if now - t < FAILURE_WINDOW_SEC] + [now]
            self._failures[key] = recent
            if len(recent) >= limit:
                self._locked_until[key] = now + LOCKOUT_SEC
                self._failures[key] = []

    def login(self, client: str, password: str, otp: str) -> tuple[str, float] | None:
        now = time.time()
        password_ok = verify_password(password, self._secrets.password_hash)  # always run: constant-ish timing
        counter = match_totp(self._secrets.totp_secret, otp.strip(), now)
        with self._lock:
            if not password_ok or counter is None or counter <= self._last_totp_counter:
                self._record_failure(client, now)
                return None
            self._last_totp_counter = counter
            self._failures.pop(client, None)
            self._prune(now)
            token = secrets.token_urlsafe(32)
            expires_at = now + SESSION_TTL_SEC
            self._sessions[self._digest(token)] = expires_at
            return token, expires_at

    def _prune(self, now: float) -> None:
        for digest in [d for d, expiry in self._sessions.items() if expiry <= now]:
            del self._sessions[digest]
        while len(self._sessions) >= MAX_SESSIONS:
            del self._sessions[min(self._sessions, key=self._sessions.__getitem__)]

    def session_valid(self, token: str) -> bool:
        if not token:
            return False
        with self._lock:
            expiry = self._sessions.get(self._digest(token))
            return expiry is not None and expiry > time.time()

    def logout(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(self._digest(token), None)
