"""Command runners. `LocalRunner` executes on this machine (panel deployed on the server itself);
`ssh_link.SshLink` executes on a remote host. Both expose the same `run()` / `label` / `close()`."""
from __future__ import annotations

import getpass
import socket
import subprocess
from dataclasses import dataclass
from typing import Protocol

MAX_CAPTURE_BYTES = 512 * 1024


class RunnerError(RuntimeError):
    """The command could not be started or the transport failed. A non-zero exit code is not a RunnerError."""


class CommandTimeout(RuntimeError):
    """The command outlived its deadline and was killed."""


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool


class Runner(Protocol):
    @property
    def label(self) -> str: ...

    def run(self, command: str, *, stdin_data: str | None = None, timeout_sec: float = 15.0) -> CommandResult: ...

    def close(self) -> None: ...


def decode_capped(raw: bytes) -> tuple[str, bool]:
    return raw[:MAX_CAPTURE_BYTES].decode("utf-8", errors="replace"), len(raw) > MAX_CAPTURE_BYTES


class LocalRunner:
    def __init__(self) -> None:
        self.label = f"{getpass.getuser()}@{socket.gethostname()}"

    def run(self, command: str, *, stdin_data: str | None = None, timeout_sec: float = 15.0) -> CommandResult:
        try:
            completed = subprocess.run(
                ["bash", "-c", command],
                input=(stdin_data or "").encode("utf-8"),
                capture_output=True,
                timeout=timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CommandTimeout(f"Lệnh chạy quá {timeout_sec:.0f}s, đã bị dừng") from exc
        except OSError as exc:
            raise RunnerError(f"Không chạy được lệnh: {exc}") from exc
        stdout, stdout_cut = decode_capped(completed.stdout)
        stderr, stderr_cut = decode_capped(completed.stderr)
        return CommandResult(completed.returncode, stdout, stderr, stdout_cut or stderr_cut)

    def close(self) -> None:
        """Nothing to release; present for interface parity with SshLink."""
