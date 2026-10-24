"""Oracle Panel: web UI to watch and manage a Linux server.

Two deployments, picked by config:
  * desktop  ("mode": "ssh")   – runs on your PC, reaches the server over one SSH link, UI on 127.0.0.1 only.
  * server   ("mode": "local") – runs on the server itself behind a Cloudflare tunnel; the UI is served from
                                 GitHub Pages and every API call needs a password + TOTP login ("public" block).

Run: python panel.py [--no-browser] [--config config.json]
"""
from __future__ import annotations

import argparse
import json
import logging
import secrets
import sys
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qsl, urlsplit

from auth import AuthConfigError, AuthSecrets, LoginGate
from metrics import Sampler
from remote_ops import RemoteOps, ValidationError
from runner import CommandTimeout, LocalRunner, Runner, RunnerError

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
LOG_PATH = APP_DIR / "panel.log"
KNOWN_HOSTS_PATH = APP_DIR / "known_hosts"
BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 47620
MAX_BODY_BYTES = 64 * 1024
MAX_PASSWORD_CHARS = 256
TOKEN_PLACEHOLDER = "__PANEL_TOKEN__"
CORS_MAX_AGE_SEC = "600"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}

LOG = logging.getLogger("panel")
AUDIT = logging.getLogger("audit")

Route = Callable[[dict], dict]


@dataclass
class PanelApp:
    runner: Runner
    sampler: Sampler
    get_routes: dict[str, Route]
    post_routes: dict[str, Route]
    allowed_hosts: set[str]
    allowed_origins: set[str]
    desktop_token: str | None      # set in desktop mode, injected into index.html
    login_gate: LoginGate | None   # set in public mode


def build_app(config: dict, runner: Runner, port: int) -> PanelApp:
    probe_source = (APP_DIR / "remote_probe.py").read_text(encoding="utf-8")
    sampler = Sampler(runner, probe_source, float(config.get("sample_interval_sec", 2)))
    ops = RemoteOps(runner)
    public = config.get("public")
    login_gate = None
    if public:
        try:
            login_gate = LoginGate(AuthSecrets.load(Path(public["secrets_path"]).expanduser()))
        except AuthConfigError as exc:
            raise SystemExit(f"{exc}\nChạy setup_auth.py trên server trước.") from exc
    return PanelApp(
        runner=runner,
        sampler=sampler,
        get_routes={
            "/api/live": lambda _query: sampler.latest(),
            "/api/services": lambda _query: ops.list_services(),
            "/api/service/logs": ops.service_logs,
            "/api/ports": lambda _query: ops.listening_ports(),
            "/api/journal": ops.journal,
        },
        post_routes={
            "/api/process/signal": ops.signal_process,
            "/api/service/action": ops.service_action,
            "/api/exec": ops.exec_command,
        },
        allowed_hosts={f"{BIND_HOST}:{port}", f"localhost:{port}", *(public or {}).get("allowed_hosts", [])},
        allowed_origins=set((public or {}).get("allowed_origins", [])),
        desktop_token=None if public else secrets.token_urlsafe(32),
        login_gate=login_gate,
    )


def make_handler(app: PanelApp) -> type[BaseHTTPRequestHandler]:
    class PanelHandler(BaseHTTPRequestHandler):
        server_version = "OraclePanel/1.1"

        def log_message(self, fmt: str, *args: object) -> None:
            LOG.debug("%s - %s", self.address_string(), fmt % args)

        # ---------- response helpers ----------
        def _cors_headers(self) -> None:
            origin = self.headers.get("Origin", "")
            if origin in app.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Panel-Token")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Max-Age", CORS_MAX_AGE_SEC)
            self.send_header("Vary", "Origin")

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, payload: dict) -> None:
            self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        # ---------- request guards ----------
        def _client_id(self) -> str:
            # Only cloudflared can reach 127.0.0.1, so CF-Connecting-IP is set by Cloudflare, not the caller.
            return self.headers.get("CF-Connecting-IP") or self.client_address[0]

        def _bearer_token(self) -> str:
            scheme, _, token = self.headers.get("Authorization", "").partition(" ")
            return token.strip() if scheme.lower() == "bearer" else ""

        def _authorized(self) -> bool:
            if app.login_gate is not None:
                return app.login_gate.session_valid(self._bearer_token())
            supplied = self.headers.get("X-Panel-Token", "")
            return bool(app.desktop_token) and secrets.compare_digest(supplied, app.desktop_token)

        def _host_allowed(self) -> bool:
            # Blocks DNS rebinding: a foreign site resolving to 127.0.0.1 still sends its own Host header.
            if self.headers.get("Host", "") in app.allowed_hosts:
                return True
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Host không hợp lệ"})
            return False

        # ---------- verbs ----------
        def do_OPTIONS(self) -> None:
            allowed = self.headers.get("Origin", "") in app.allowed_origins
            self._send(HTTPStatus.NO_CONTENT if allowed else HTTPStatus.FORBIDDEN, b"", "text/plain")

        def do_GET(self) -> None:
            if not self._host_allowed():
                return
            url = urlsplit(self.path)
            if url.path == "/api/health":
                self._send_json(HTTPStatus.OK, {"ok": True, "login_required": app.login_gate is not None})
            elif url.path.startswith("/api/"):
                self._dispatch(app.get_routes, url.path, dict(parse_qsl(url.query)))
            else:
                self._serve_static(url.path)

        def do_POST(self) -> None:
            if not self._host_allowed():
                return
            path = urlsplit(self.path).path
            body = self._read_json_body()
            if body is None:
                return
            if path == "/api/login":
                self._login(body)
            elif path == "/api/logout":
                if app.login_gate is not None:
                    app.login_gate.logout(self._bearer_token())
                self._send_json(HTTPStatus.OK, {"ok": True})
            else:
                self._dispatch(app.post_routes, path, body, audit=True)

        # ---------- handlers ----------
        def _login(self, body: dict) -> None:
            gate = app.login_gate
            if gate is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Bản desktop không cần đăng nhập"})
                return
            client = self._client_id()
            wait_sec = gate.lockout_remaining(client, time.time())
            if wait_sec:
                self._send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": f"Sai quá nhiều lần. Thử lại sau {wait_sec // 60 + 1} phút."})
                return
            password, otp = body.get("password"), body.get("otp")
            if not isinstance(password, str) or not isinstance(otp, str) or len(password) > MAX_PASSWORD_CHARS:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Thiếu mật khẩu hoặc mã 2FA"})
                return
            session = gate.login(client, password, otp)
            if session is None:
                AUDIT.warning("login FAILED from %s", client)
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Sai mật khẩu hoặc mã 2FA (mã chỉ dùng được một lần)"})
                return
            AUDIT.info("login ok from %s", client)
            self._send_json(HTTPStatus.OK, {"token": session[0], "expires_at": session[1]})

        def _read_json_body(self) -> dict | None:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Body trống hoặc quá lớn"})
                return None
            try:
                parsed = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Body không phải JSON"})
                return None
            if not isinstance(parsed, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Body phải là object JSON"})
                return None
            return parsed

        def _dispatch(self, routes: dict[str, Route], path: str, params: dict, audit: bool = False) -> None:
            if not self._authorized():
                status = HTTPStatus.UNAUTHORIZED if app.login_gate else HTTPStatus.FORBIDDEN
                self._send_json(status, {"error": "Cần đăng nhập lại" if app.login_gate else "Phiên hết hạn, tải lại trang"})
                return
            handler = routes.get(path)
            if handler is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Không có endpoint {path}"})
                return
            if audit:
                AUDIT.info("%s from %s", path, self._client_id())
            try:
                self._send_json(HTTPStatus.OK, handler(params))
            except ValidationError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except CommandTimeout as exc:
                self._send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": str(exc)})
            except (RunnerError, RuntimeError, json.JSONDecodeError) as exc:
                LOG.warning("%s failed: %s", path, exc)
                self._send_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})

        def _serve_static(self, path: str) -> None:
            relative = "index.html" if path in ("", "/") else path.lstrip("/")
            target = (STATIC_DIR / relative).resolve()
            content_type = CONTENT_TYPES.get(target.suffix)
            if not target.is_relative_to(STATIC_DIR) or content_type is None or not target.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Không tìm thấy"})
                return
            body = target.read_bytes()
            if target.name == "index.html" and app.desktop_token:
                body = body.replace(TOKEN_PLACEHOLDER.encode(), app.desktop_token.encode())
            self._send(HTTPStatus.OK, body, content_type)

    return PanelHandler


def load_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Không đọc được cấu hình {path}: {exc}") from exc
    if config.get("mode", "ssh") == "ssh":
        missing = {"host", "user", "key_path"} - config.keys()
        if missing:
            raise SystemExit(f"Cấu hình thiếu khóa: {', '.join(sorted(missing))}")
        if not Path(config["key_path"]).is_file():
            raise SystemExit(f"Không thấy SSH key: {config['key_path']}")
    return config


def build_runner(config: dict) -> Runner:
    if config.get("mode", "ssh") == "local":
        return LocalRunner()
    # Imported lazily so the server deployment runs on the stdlib alone (no paramiko there).
    from ssh_link import SshLink, SshTarget
    return SshLink(SshTarget(host=config["host"], port=int(config.get("port", 22)), user=config["user"],
                             key_path=Path(config["key_path"]), known_hosts_path=KNOWN_HOSTS_PATH))


def setup_logging(log_path: Path) -> None:
    # Piped/redirected stderr on Windows defaults to cp1252, which cannot encode Vietnamese messages.
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    console_handler = logging.StreamHandler(sys.stderr)
    for handler in (file_handler, console_handler):
        handler.setFormatter(formatter)
    logging.basicConfig(level=logging.INFO, handlers=[file_handler, console_handler])
    logging.getLogger("paramiko").setLevel(logging.WARNING)


def main() -> None:
    parser = argparse.ArgumentParser(description="Oracle Panel – quản lý server")
    parser.add_argument("--config", type=Path, default=APP_DIR / "config.json")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    config = load_config(args.config)
    setup_logging(Path(config.get("log_path", LOG_PATH)).expanduser())
    port = int(config.get("listen_port", DEFAULT_PORT))
    runner = build_runner(config)
    app = build_app(config, runner, port)
    try:
        server = ThreadingHTTPServer((BIND_HOST, port), make_handler(app))
    except OSError as exc:
        raise SystemExit(f"Cổng {port} đang bận ({exc}). Panel có thể đang chạy rồi: http://{BIND_HOST}:{port}") from exc
    server.daemon_threads = True
    app.sampler.start()
    url = f"http://{BIND_HOST}:{port}/"
    LOG.info("Oracle Panel %s -> %s  (%s)", runner.label, url, "public, cần đăng nhập" if app.login_gate else "desktop")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("Đang dừng...")
    finally:
        server.server_close()
        app.sampler.stop()
        runner.close()


if __name__ == "__main__":
    main()
