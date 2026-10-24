"""Validated, shell-safe remote operations. Every value that reaches a command line is either a
whitelisted literal, a validated int, or passed through shlex.quote."""
from __future__ import annotations

import json
import logging
import re
import shlex
import time

from runner import CommandResult, Runner

LOG = logging.getLogger(__name__)
AUDIT = logging.getLogger("audit")

ALLOWED_SIGNALS = {"TERM", "KILL", "STOP", "CONT", "HUP"}
SERVICE_ACTIONS = {"start", "stop", "restart", "reload", "enable", "disable"}
UNIT_NAME_RE = re.compile(r"^[A-Za-z0-9@._:\\-]{1,200}\.service$")
SS_PROCESS_RE = re.compile(r'\("([^"]+)",pid=(\d+)')
LOG_LINES_RANGE = (20, 3000)
EXEC_TIMEOUT_RANGE = (1, 300)
MAX_COMMAND_CHARS = 4000
GREP_MAX_CHARS = 200
PROTECTED_PID_MAX = 1          # never signal init
ACTION_TIMEOUT_SEC = 60
QUERY_TIMEOUT_SEC = 20


class ValidationError(ValueError):
    """Bad input from the browser; maps to HTTP 400."""


def _int_in_range(raw: object, low: int, high: int, field: str) -> int:
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{field} phải là số nguyên") from exc
    if not low <= value <= high:
        raise ValidationError(f"{field} phải nằm trong {low}..{high}")
    return value


def _unit_name(raw: object) -> str:
    if not isinstance(raw, str) or not UNIT_NAME_RE.match(raw):
        raise ValidationError("Tên dịch vụ không hợp lệ (cần dạng tên.service)")
    return raw


def _result_payload(result: CommandResult) -> dict:
    return {"ok": result.exit_code == 0, "exit_code": result.exit_code, "stdout": result.stdout,
            "stderr": result.stderr, "truncated": result.truncated}


class RemoteOps:
    def __init__(self, link: Runner) -> None:
        self._link = link

    def signal_process(self, body: dict) -> dict:
        pid = _int_in_range(body.get("pid"), PROTECTED_PID_MAX + 1, 2**22, "pid")
        start = _int_in_range(body.get("start"), 0, 2**62, "start")
        signal_name = body.get("signal")
        if signal_name not in ALLOWED_SIGNALS:
            raise ValidationError(f"Tín hiệu phải là một trong {sorted(ALLOWED_SIGNALS)}")
        # Re-check start time on the server so a recycled PID is never hit.
        command = (
            f"st=$(sed 's/.*) //' /proc/{pid}/stat 2>/dev/null | cut -d' ' -f20); "
            f"[ \"$st\" = \"{start}\" ] || {{ echo 'Tiến trình đã thoát hoặc PID đã bị tái sử dụng' >&2; exit 3; }}; "
            f"sudo -n kill -s {signal_name} {pid}"
        )
        AUDIT.info("signal %s pid=%s start=%s", signal_name, pid, start)
        return _result_payload(self._link.run(command, timeout_sec=ACTION_TIMEOUT_SEC))

    def list_services(self) -> dict:
        units = self._link.run("systemctl list-units --type=service --all -o json --no-pager",
                               timeout_sec=QUERY_TIMEOUT_SEC)
        files = self._link.run("systemctl list-unit-files --type=service -o json --no-pager",
                               timeout_sec=QUERY_TIMEOUT_SEC)
        if units.exit_code != 0:
            raise RuntimeError(f"systemctl list-units lỗi: {units.stderr.strip()}")
        enabled_state = {}
        if files.exit_code == 0:
            enabled_state = {row["unit_file"]: row["state"] for row in json.loads(files.stdout or "[]")}
        services = {row["unit"]: {"unit": row["unit"], "load": row["load"], "active": row["active"],
                                  "sub": row["sub"], "description": row["description"],
                                  "enabled": enabled_state.get(row["unit"], "")}
                    for row in json.loads(units.stdout or "[]")}
        for unit_file, state in enabled_state.items():
            if unit_file not in services and "@." not in unit_file:
                services[unit_file] = {"unit": unit_file, "load": "not-loaded", "active": "inactive",
                                       "sub": "dead", "description": "", "enabled": state}
        return {"services": sorted(services.values(), key=lambda row: row["unit"])}

    def service_action(self, body: dict) -> dict:
        unit = _unit_name(body.get("unit"))
        action = body.get("action")
        if action not in SERVICE_ACTIONS:
            raise ValidationError(f"Thao tác phải là một trong {sorted(SERVICE_ACTIONS)}")
        AUDIT.info("systemctl %s %s", action, unit)
        command = f"sudo -n systemctl {action} -- {shlex.quote(unit)}"
        return _result_payload(self._link.run(command, timeout_sec=ACTION_TIMEOUT_SEC))

    def service_logs(self, query: dict) -> dict:
        unit = _unit_name(query.get("unit"))
        lines = _int_in_range(query.get("lines", 200), *LOG_LINES_RANGE, "lines")
        command = f"sudo -n journalctl -u {shlex.quote(unit)} -n {lines} --no-pager -o short-iso"
        return _result_payload(self._link.run(command, timeout_sec=QUERY_TIMEOUT_SEC))

    def journal(self, query: dict) -> dict:
        lines = _int_in_range(query.get("lines", 300), *LOG_LINES_RANGE, "lines")
        priority = _int_in_range(query.get("priority", 6), 0, 7, "priority")
        command = f"sudo -n journalctl -n {lines} -p {priority} --no-pager -o short-iso"
        grep = str(query.get("grep", "")).strip()
        if len(grep) > GREP_MAX_CHARS:
            raise ValidationError(f"Chuỗi lọc tối đa {GREP_MAX_CHARS} ký tự")
        if grep:
            command += f" -g {shlex.quote(grep)} --case-sensitive=false"
        return _result_payload(self._link.run(command, timeout_sec=QUERY_TIMEOUT_SEC))

    def listening_ports(self) -> dict:
        result = self._link.run("sudo -n ss -tulpnH", timeout_sec=QUERY_TIMEOUT_SEC)
        if result.exit_code != 0:
            raise RuntimeError(f"ss lỗi: {result.stderr.strip()}")
        return {"ports": [_parse_ss_line(line) for line in result.stdout.splitlines() if line.strip()]}

    def exec_command(self, body: dict) -> dict:
        command = body.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValidationError("Lệnh trống")
        if len(command) > MAX_COMMAND_CHARS:
            raise ValidationError(f"Lệnh tối đa {MAX_COMMAND_CHARS} ký tự")
        timeout_sec = _int_in_range(body.get("timeout_sec", 30), *EXEC_TIMEOUT_RANGE, "timeout_sec")
        AUDIT.info("exec (%ss): %s", timeout_sec, command)
        started = time.monotonic()
        result = self._link.run(f"bash -lc {shlex.quote(command)}", timeout_sec=timeout_sec)
        payload = _result_payload(result)
        payload["duration_ms"] = round((time.monotonic() - started) * 1000)
        return payload


def _split_host_port(address: str) -> tuple[str, str]:
    host, _, port = address.rpartition(":")
    return host.strip("[]") or "*", port


def _parse_ss_line(line: str) -> dict:
    parts = line.split(None, 6)
    proto, state, local = parts[0], parts[1], parts[4]
    host, port = _split_host_port(local)
    pids_by_name: dict[str, set[int]] = {}
    for name, pid in SS_PROCESS_RE.findall(parts[6]) if len(parts) > 6 else []:
        pids_by_name.setdefault(name, set()).add(int(pid))
    return {"proto": proto, "state": state, "address": host, "port": port,
            "processes": [{"name": name, "pids": sorted(pids)} for name, pids in sorted(pids_by_name.items())]}
