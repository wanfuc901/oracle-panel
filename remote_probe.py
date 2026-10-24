"""Runs ON THE SERVER via `python3 -` (stdin). Stdlib only. Prints one JSON snapshot of raw /proc counters.

Deltas (CPU %, rates) are computed locally, so this stays a dumb, cheap reader.
"""
import json
import os
import platform
import pwd
import socket
import time

PHYSICAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "f2fs", "zfs", "ntfs", "exfat"}
SKIP_BLOCK_PREFIXES = ("loop", "ram", "zram")
MAX_CMD_CHARS = 400


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def cpu_counters():
    rows = []
    for line in read_text("/proc/stat").splitlines():
        if not line.startswith("cpu"):
            break
        rows.append([int(value) for value in line.split()[1:9]])
    return rows


def boot_time():
    for line in read_text("/proc/stat").splitlines():
        if line.startswith("btime "):
            return int(line.split()[1])
    return 0


def meminfo():
    fields = {}
    for line in read_text("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        fields[key] = int(rest.split()[0]) * 1024
    return fields


def net_counters():
    counters = {}
    for line in read_text("/proc/net/dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if name == "lo":
            continue
        values = rest.split()
        counters[name] = [int(values[0]), int(values[8])]
    return counters


def disk_io_counters():
    block_devices = {name for name in os.listdir("/sys/block") if not name.startswith(SKIP_BLOCK_PREFIXES)}
    counters = {}
    for line in read_text("/proc/diskstats").splitlines():
        parts = line.split()
        if parts[2] in block_devices:
            counters[parts[2]] = [int(parts[5]) * 512, int(parts[9]) * 512]
    return counters


def disk_usage():
    seen_mounts = set()
    disks = []
    for line in read_text("/proc/mounts").splitlines():
        device, mount, fstype = line.split()[:3]
        if fstype not in PHYSICAL_FS or mount in seen_mounts:
            continue
        seen_mounts.add(mount)
        try:
            stats = os.statvfs(mount)
        except OSError:
            continue
        total = stats.f_blocks * stats.f_frsize
        used = (stats.f_blocks - stats.f_bfree) * stats.f_frsize
        disks.append({"device": device, "mount": mount, "fstype": fstype, "total": total,
                      "used": used, "avail": stats.f_bavail * stats.f_frsize})
    return disks


def read_process(pid):
    stat = read_text(f"/proc/{pid}/stat")
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
        cmdline = handle.read().replace(b"\0", b" ").decode("utf-8", errors="replace").strip()
    uid = os.stat(f"/proc/{pid}").st_uid
    open_paren, close_paren = stat.find("("), stat.rfind(")")
    comm = stat[open_paren + 1:close_paren]
    # fields[0] is stat field 3 (state); field N lives at fields[N - 3].
    fields = stat[close_paren + 2:].split()
    return [int(pid), int(fields[1]), uid, fields[0], comm, cmdline[:MAX_CMD_CHARS],
            int(fields[11]) + int(fields[12]), int(fields[21]), int(fields[17]), int(fields[19])]


def processes():
    own_pid = str(os.getpid())  # hide this probe itself from the process table
    rows = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or entry == own_pid:
            continue
        try:
            rows.append(read_process(entry))
        except (OSError, IndexError, ValueError):
            continue  # exited between listdir and read
    return rows


def user_names(rows):
    names = {}
    for uid in {row[2] for row in rows}:
        try:
            names[str(uid)] = pwd.getpwuid(uid).pw_name
        except KeyError:
            names[str(uid)] = str(uid)
    return names


def os_name():
    try:
        for line in read_text("/etc/os-release").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip('"')
    except OSError:
        pass
    return platform.system()


def main():
    procs = processes()
    snapshot = {
        "ts": time.time(),
        "hostname": socket.gethostname(),
        "os": os_name(),
        "kernel": platform.release(),
        "clk_tck": os.sysconf("SC_CLK_TCK"),
        "page_size": os.sysconf("SC_PAGE_SIZE"),
        "boot_time": boot_time(),
        "uptime": float(read_text("/proc/uptime").split()[0]),
        "loadavg": [float(value) for value in read_text("/proc/loadavg").split()[:3]],
        "cpu": cpu_counters(),
        "mem": meminfo(),
        "net": net_counters(),
        "diskio": disk_io_counters(),
        "disks": disk_usage(),
        "procs": procs,
        "users": user_names(procs),
    }
    print(json.dumps(snapshot, separators=(",", ":")))


main()
