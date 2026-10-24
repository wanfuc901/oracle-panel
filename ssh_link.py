"""Persistent SSH link to the managed server, reconnecting lazily when the transport dies."""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import paramiko

from runner import MAX_CAPTURE_BYTES, CommandResult, CommandTimeout, RunnerError

LOG = logging.getLogger(__name__)

CONNECT_TIMEOUT_SEC = 10
KEEPALIVE_SEC = 20
READ_CHUNK_BYTES = 65536
POLL_SLEEP_SEC = 0.01


class SshError(RunnerError):
    """Connection or transport failure. A non-zero exit code is not an SshError."""


@dataclass(frozen=True)
class SshTarget:
    host: str
    port: int
    user: str
    key_path: Path
    known_hosts_path: Path


class _Capture:
    """Byte sink that stops storing past MAX_CAPTURE_BYTES but keeps draining the channel."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.truncated = False

    def add(self, chunk: bytes) -> None:
        room = MAX_CAPTURE_BYTES - len(self.buffer)
        if len(chunk) > room:
            self.truncated = True
        if room > 0:
            self.buffer.extend(chunk[:room])

    def text(self) -> str:
        return self.buffer.decode("utf-8", errors="replace")


def _drain(channel: paramiko.Channel, timeout_sec: float) -> CommandResult:
    deadline = time.monotonic() + timeout_sec
    stdout, stderr = _Capture(), _Capture()
    while True:
        progressed = False
        if channel.recv_ready():
            stdout.add(channel.recv(READ_CHUNK_BYTES))
            progressed = True
        if channel.recv_stderr_ready():
            stderr.add(channel.recv_stderr(READ_CHUNK_BYTES))
            progressed = True
        if progressed:
            continue
        # Transport delivers messages in order, so once exit status arrives all output is buffered.
        if channel.exit_status_ready():
            break
        if time.monotonic() > deadline:
            raise CommandTimeout(f"Lệnh chạy quá {timeout_sec:.0f}s, đã ngắt kênh")
        time.sleep(POLL_SLEEP_SEC)
    return CommandResult(
        exit_code=channel.recv_exit_status(),
        stdout=stdout.text(),
        stderr=stderr.text(),
        truncated=stdout.truncated or stderr.truncated,
    )


class SshLink:
    def __init__(self, target: SshTarget) -> None:
        self._target = target
        self._client: paramiko.SSHClient | None = None
        self._lock = threading.Lock()

    @property
    def label(self) -> str:
        return f"{self._target.user}@{self._target.host}"

    def _connect(self) -> paramiko.SSHClient:
        target = self._target
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        if target.known_hosts_path.exists():
            client.load_host_keys(str(target.known_hosts_path))
        # Trust on first use (like StrictHostKeyChecking=accept-new); a changed key still raises BadHostKeyException.
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                hostname=target.host,
                port=target.port,
                username=target.user,
                key_filename=str(target.key_path),
                timeout=CONNECT_TIMEOUT_SEC,
                banner_timeout=CONNECT_TIMEOUT_SEC,
                auth_timeout=CONNECT_TIMEOUT_SEC,
                look_for_keys=False,
                allow_agent=False,
            )
            client.save_host_keys(str(target.known_hosts_path))
        except (paramiko.SSHException, OSError) as exc:
            client.close()
            raise SshError(f"Không kết nối được {self.label}: {exc}") from exc
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(KEEPALIVE_SEC)
        LOG.info("SSH connected to %s", self.label)
        return client

    def _transport(self) -> paramiko.Transport:
        with self._lock:
            transport = self._client.get_transport() if self._client else None
            if transport is None or not transport.is_active():
                self._close_locked()
                self._client = self._connect()
                transport = self._client.get_transport()
            if transport is None:
                raise SshError("SSH transport không khả dụng sau khi kết nối")
            return transport

    def _close_locked(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def close(self) -> None:
        with self._lock:
            self._close_locked()

    def run(self, command: str, *, stdin_data: str | None = None, timeout_sec: float = 15.0) -> CommandResult:
        transport = self._transport()
        try:
            channel = transport.open_session(timeout=CONNECT_TIMEOUT_SEC)
        except (paramiko.SSHException, OSError) as exc:
            self.close()
            raise SshError(f"Mất kết nối SSH: {exc}") from exc
        try:
            channel.exec_command(command)
            if stdin_data is not None:
                channel.sendall(stdin_data.encode("utf-8"))
            channel.shutdown_write()
            return _drain(channel, timeout_sec)
        except (paramiko.SSHException, OSError) as exc:
            self.close()
            raise SshError(f"Lỗi kênh SSH: {exc}") from exc
        finally:
            channel.close()
