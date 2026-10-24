"""Turns consecutive raw probe snapshots into rates/percentages, and samples them on a background thread."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque

from runner import CommandTimeout, Runner, RunnerError

LOG = logging.getLogger(__name__)

HISTORY_POINTS = 180          # 6 minutes at the default 2s interval
IDLE_AFTER_SEC = 30           # stop polling the server when no browser tab has asked for data
PROBE_TIMEOUT_SEC = 10
CPU_IDLE_COLUMNS = (3, 4)     # idle, iowait in /proc/stat


def _busy_percent(prev_row: list[int], cur_row: list[int]) -> float:
    total_delta = sum(cur_row) - sum(prev_row)
    if total_delta <= 0:
        return 0.0
    idle_delta = sum(cur_row[i] - prev_row[i] for i in CPU_IDLE_COLUMNS)
    return max(0.0, min(100.0, (total_delta - idle_delta) / total_delta * 100))


def _cpu_percents(prev: dict | None, cur: dict) -> list[float]:
    if prev is None or len(prev["cpu"]) != len(cur["cpu"]):
        return [0.0] * len(cur["cpu"])
    return [round(_busy_percent(p, c), 1) for p, c in zip(prev["cpu"], cur["cpu"])]


def _rates(prev_counters: dict | None, cur_counters: dict, elapsed_sec: float) -> dict[str, list[float]]:
    """Per-device [in, out] bytes/sec. Counter resets (reboot, iface re-create) clamp to 0."""
    rates: dict[str, list[float]] = {}
    for name, (cur_in, cur_out) in cur_counters.items():
        prev_pair = (prev_counters or {}).get(name)
        if prev_pair is None or elapsed_sec <= 0:
            rates[name] = [0.0, 0.0]
            continue
        rates[name] = [max(0.0, (cur_in - prev_pair[0]) / elapsed_sec),
                       max(0.0, (cur_out - prev_pair[1]) / elapsed_sec)]
    return rates


def _sum_rates(rates: dict[str, list[float]]) -> list[float]:
    return [sum(pair[0] for pair in rates.values()), sum(pair[1] for pair in rates.values())]


def _process_rows(prev: dict | None, cur: dict) -> list[dict]:
    # Keyed by (pid, start) so a recycled PID never inherits another process's tick count.
    prev_ticks = {(row[0], row[9]): row[6] for row in prev["procs"]} if prev else {}
    cpu_jiffies = sum(cur["cpu"][0]) - sum(prev["cpu"][0]) if prev else 0
    clk_tck, page_size, users = cur["clk_tck"], cur["page_size"], cur["users"]
    rows = []
    for pid, ppid, uid, state, comm, cmd, ticks, rss_pages, threads, start in cur["procs"]:
        prior = prev_ticks.get((pid, start))
        cpu = (ticks - prior) / cpu_jiffies * 100 if prior is not None and cpu_jiffies > 0 else 0.0
        rows.append({
            "pid": pid, "ppid": ppid, "user": users.get(str(uid), str(uid)), "state": state,
            "name": comm, "cmd": cmd or f"[{comm}]", "cpu": round(max(cpu, 0.0), 1),
            "rss": rss_pages * page_size, "threads": threads, "start": start,
            "age_sec": max(0, int(cur["uptime"] - start / clk_tck)),
        })
    return rows


def _memory(mem: dict) -> dict:
    total, available = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    cache = mem.get("Buffers", 0) + mem.get("Cached", 0) + mem.get("SReclaimable", 0)
    swap_total, swap_free = mem.get("SwapTotal", 0), mem.get("SwapFree", 0)
    return {"total": total, "used": total - available, "available": available, "cache": cache,
            "swap_total": swap_total, "swap_used": swap_total - swap_free}


class MetricsProcessor:
    def __init__(self) -> None:
        self._prev: dict | None = None
        self._history: deque[dict] = deque(maxlen=HISTORY_POINTS)

    def ingest(self, raw: dict) -> dict:
        prev, self._prev = self._prev, raw
        elapsed = raw["ts"] - prev["ts"] if prev else 0.0
        cpu = _cpu_percents(prev, raw)
        net = _rates(prev["net"] if prev else None, raw["net"], elapsed)
        disk_io = _rates(prev["diskio"] if prev else None, raw["diskio"], elapsed)
        memory = _memory(raw["mem"])
        net_total, disk_total = _sum_rates(net), _sum_rates(disk_io)
        if prev is not None:
            self._history.append({
                "t": round(raw["ts"], 1), "cpu": cpu[0],
                "mem": round(memory["used"] / memory["total"] * 100, 1) if memory["total"] else 0,
                "rx": round(net_total[0]), "tx": round(net_total[1]),
                "rd": round(disk_total[0]), "wr": round(disk_total[1]),
            })
        return {
            "host": {"hostname": raw["hostname"], "os": raw["os"], "kernel": raw["kernel"],
                     "cores": len(raw["cpu"]) - 1, "boot_time": raw["boot_time"]},
            "uptime_sec": raw["uptime"], "loadavg": raw["loadavg"],
            "cpu": {"total": cpu[0], "cores": cpu[1:]},
            "mem": memory, "net": {"total": net_total, "ifaces": net},
            "disk_io": {"total": disk_total, "devices": disk_io}, "disks": raw["disks"],
            "procs": _process_rows(prev, raw), "history": list(self._history),
            "history_capacity": HISTORY_POINTS,
            "sampled_at": raw["ts"],
        }


class Sampler:
    """Polls the probe every `interval_sec` while a browser is watching and wakes every waiting stream after each
    attempt; keeps the last good state on errors."""

    def __init__(self, link: Runner, probe_source: str, interval_sec: float) -> None:
        self._link = link
        self._probe_source = probe_source
        self._interval_sec = interval_sec
        self._processor = MetricsProcessor()
        self._state: dict | None = None
        self._error: str | None = None
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._version = 0             # bumped after every sample attempt, good or failed
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._last_viewer_at = time.monotonic()
        self._thread = threading.Thread(target=self._loop, name="sampler", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=PROBE_TIMEOUT_SEC + 1)

    def wait_for_update(self, seen_version: int, timeout_sec: float) -> tuple[int, dict]:
        """Blocks until a sample newer than `seen_version` lands or `timeout_sec` passes, then returns
        (version, snapshot). Calling it keeps the sampler awake, so a stream must call it at least every IDLE_AFTER_SEC."""
        self._last_viewer_at = time.monotonic()
        self._wake.set()
        with self._changed:
            self._changed.wait_for(lambda: self._version != seen_version, timeout=timeout_sec)
            return self._version, self._snapshot()

    def _snapshot(self) -> dict:
        status = "error" if self._error else ("ok" if self._state else "connecting")
        # Age is measured on this host's clock so the browser never compares two machines' clocks.
        age_sec = round(time.time() - self._state["received_at"], 1) if self._state else None
        return {"status": status, "error": self._error, "link": self._link.label,
                "interval_sec": self._interval_sec, "age_sec": age_sec, "state": self._state}

    def _loop(self) -> None:
        while not self._stop.is_set():
            if time.monotonic() - self._last_viewer_at > IDLE_AFTER_SEC:
                self._wake.clear()
                self._wake.wait()
                continue
            self._sample_once()
            self._stop.wait(self._interval_sec)

    def _sample_once(self) -> None:
        try:
            result = self._link.run("python3 -", stdin_data=self._probe_source, timeout_sec=PROBE_TIMEOUT_SEC)
            if result.exit_code != 0:
                raise RunnerError(f"probe thoát mã {result.exit_code}: {result.stderr.strip()[-300:]}")
            state = self._processor.ingest(json.loads(result.stdout))
            # Staleness is judged against this machine's clock; the server's clock may drift.
            state["received_at"] = time.time()
        except (RunnerError, CommandTimeout, json.JSONDecodeError, KeyError) as exc:
            LOG.warning("Sample failed: %s", exc)
            self._publish(self._state, str(exc))
            return
        self._publish(state, None)

    def _publish(self, state: dict | None, error: str | None) -> None:
        with self._changed:
            self._state, self._error = state, error
            self._version += 1
            self._changed.notify_all()
