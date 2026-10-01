"""Live host telemetry for dashboards: CPU/memory/disk/network via ``psutil``, plugin-owned native SoC/GPU sensors.

Rates (bytes/s, CPU %) are deltas against the previous read, so one process-wide sampler owns the
counters. Pollers share it through a short TTL cache: two dashboards polling at 1 Hz see the same
window instead of halving each other's. Every section degrades to empty/``None`` independently;
:func:`read_system_metrics` always answers.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from . import host_facts as facts
from .sensors import apple_silicon, nvidia

_log = logging.getLogger(__name__)
_CACHE_TTL_SECONDS = 1.0
_MAX_VOLUMES = 8
_MIN_VOLUME_BYTES = 1 << 30  # skips macOS xART/iSCPreboot/Hardware helper containers
_lock = threading.Lock()
_sampler: _Sampler | None = None
_cache: tuple[float, dict[str, Any]] | None = None


def _optional(read, *args, **kwargs):
    """An unavailable provider must not suppress unrelated telemetry."""
    try:
        return read(*args, **kwargs)
    except Exception:
        _log.debug("Telemetry read failed: %s", read, exc_info=True)
        return None


def _rate(now: float, prev: float | None, dt: float) -> float | None:
    if prev is None or dt <= 0 or now < prev:  # counter reset (interface bounce, wrap)
        return None
    return (now - prev) / dt


def _cpu_percent(previous, current) -> float:
    # Match psutil's per-field reset handling. Linux guest time is already in
    # user/nice, while iowait is idle time not included in the idle field.
    delta = {field: max(0.0, getattr(current, field) - getattr(previous, field))
             for field in current._fields}
    total = sum(delta.values()) - delta.get("guest", 0) - delta.get("guest_nice", 0)
    busy = total - delta["idle"] - delta.get("iowait", 0)
    return round(max(0.0, min(100.0, 100 * busy / total)), 1) if total > 0 else 0.0


def _domain(d: apple_silicon.Domain) -> dict[str, Any]:
    return {"name": d.name, "kind": d.kind, "active": round(d.active, 4),
            "freq_mhz": None if d.freq_mhz is None else round(d.freq_mhz, 1)}


def _volumes(psutil) -> list[dict[str, Any]]:
    """One row per filesystem. APFS volumes in a container share free space, so ``(total, free)``
    collapses the container's mounts to its first (shortest) mount and container-level usage."""
    rows: dict[tuple[int, int], dict[str, Any]] = {}
    for part in sorted(psutil.disk_partitions(all=False), key=lambda p: len(p.mountpoint)):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except OSError:
            continue
        if usage.total < _MIN_VOLUME_BYTES or (usage.total, usage.free) in rows:
            continue
        used = usage.total - usage.free
        rows[(usage.total, usage.free)] = {"mount": part.mountpoint, "fstype": part.fstype, "total": usage.total,
                                           "used": used, "percent": round(100 * used / usage.total, 1)}
    return sorted(rows.values(), key=lambda r: r["total"], reverse=True)[:_MAX_VOLUMES]


def _linux_temps(psutil) -> list[dict[str, Any]]:
    read = getattr(psutil, "sensors_temperatures", None)
    if read is None:
        return []
    try:
        chips = read() or {}
    except (OSError, RuntimeError):
        return []
    return [{"name": f"{chip}/{t.label or i}", "celsius": round(t.current, 1)}
            for chip, temps in sorted(chips.items()) for i, t in enumerate(temps) if t.current]


class _Sampler:
    def __init__(self) -> None:
        import psutil

        self._psutil = psutil
        self._proc = None
        self._soc = self._nvml = None
        try:
            self._soc = _optional(apple_silicon.open_sampler)
            self._nvml = _optional(nvidia.open_sampler)
        except BaseException:
            self.close()
            raise
        self._prev_t: float | None = None
        self._prev_cpu = None
        self._prev_disk = None
        self._prev_net = None

    def close(self) -> None:
        soc, nvml = self._soc, self._nvml
        self._soc = self._nvml = None
        for sampler in (soc, nvml):
            if sampler is not None:
                _optional(sampler.close)

    def _read_cpu(self) -> dict[str, Any]:
        ps = self._psutil
        current = ps.cpu_times(percpu=True)
        previous = self._prev_cpu
        per_core = ([_cpu_percent(prev, cur) for prev, cur in zip(previous, current)]
                    if previous is not None and len(previous) == len(current) else [0.0] * len(current))
        self._prev_cpu = current
        load = _optional(os.getloadavg) if hasattr(os, "getloadavg") else None
        return {"percent": round(sum(per_core) / len(per_core), 1) if per_core else 0.0,
                "per_core": per_core, "count_logical": _optional(ps.cpu_count, logical=True),
                "count_physical": _optional(ps.cpu_count, logical=False),
                "load_avg": list(load) if load else None, "clusters": [], "cores": []}

    def _read_memory(self) -> dict[str, Any]:
        vm, swap = self._psutil.virtual_memory(), self._psutil.swap_memory()
        return {"total": vm.total, "used": vm.used, "available": vm.available, "percent": vm.percent,
                "swap_total": swap.total, "swap_used": swap.used}

    def _read_process(self) -> dict[str, Any]:
        if self._proc is None:
            self._proc = self._psutil.Process(os.getpid())
        with self._proc.oneshot():
            return {"pid": self._proc.pid, "rss": self._proc.memory_info().rss,
                    "cpu_percent": self._proc.cpu_percent(), "threads": self._proc.num_threads()}

    def _read_host(self) -> dict[str, Any]:
        boot = self._psutil.boot_time()
        return {"os": facts.os_family(), "arch": facts.native_arch(), "cpu_model": facts.cpu_model(),
                "boot_time": boot, "uptime_s": max(0.0, time.time() - boot)}

    def read(self) -> dict[str, Any]:
        ps = self._psutil
        now = time.monotonic()
        dt = 0.0 if self._prev_t is None else now - self._prev_t
        self._prev_t = now
        cpu = _optional(self._read_cpu)
        memory = _optional(self._read_memory)
        process = _optional(self._read_process)

        # Each counter owns its timestamp. A failed read leaves both intact so
        # recovery divides by the entire gap, not just the last frame interval.
        disk = _optional(ps.disk_io_counters)
        disk_rates: dict[str, Any] = {"read_bps": None, "write_bps": None}
        if disk is not None:
            current = (disk.read_bytes, disk.write_bytes)
            if self._prev_disk is not None:
                then, previous = self._prev_disk
                disk_rates = {"read_bps": _rate(current[0], previous[0], now - then),
                              "write_bps": _rate(current[1], previous[1], now - then)}
            self._prev_disk = (now, current)
        disk_rates["volumes"] = _optional(_volumes, ps) or []

        net = _optional(ps.net_io_counters)
        network: dict[str, Any] = {"rx_bps": None, "tx_bps": None, "rx_total": None, "tx_total": None}
        if net is not None:
            current = (net.bytes_recv, net.bytes_sent)
            network.update(rx_total=current[0], tx_total=current[1])
            if self._prev_net is not None:
                then, previous = self._prev_net
                network.update(rx_bps=_rate(current[0], previous[0], now - then),
                               tx_bps=_rate(current[1], previous[1], now - then))
            self._prev_net = (now, current)

        # The native sampler primes at construction; suppress a millisecond window.
        soc = _optional(self._soc.sample) if self._soc and dt else None
        gpus: list[dict[str, Any]] = []
        power = {k: round(v, 3) for k, v in soc.power_w.items()} if soc else {}
        temps = [{"name": k, "celsius": round(v, 1)} for k, v in soc.temps_c.items()] if soc else []
        # CPU/board sensors remain useful even when NVML supplies GPU thermals.
        temps.extend(_optional(_linux_temps, ps) or [])
        if self._nvml:
            for i, gpu in enumerate(_optional(self._nvml.sample) or []):
                gpus.append({
                    "name": gpu.name or f"NVIDIA GPU {i}", "kind": "GPU",
                    "active": round(gpu.active, 4) if gpu.active is not None else None,
                    "freq_mhz": gpu.freq_mhz, "cores": gpu.cores,
                    "power_w": gpu.power_w, "temp_c": gpu.temp_c,
                    "mem_total": gpu.mem_total, "mem_used": gpu.mem_used,
                })
                if gpu.power_w is not None:
                    power["gpu"] = round(power.get("gpu", 0.0) + gpu.power_w, 3)
                if gpu.temp_c is not None:
                    temps.append({"name": f"gpu{i} {gpu.name or 'GPU'}".strip(), "celsius": round(gpu.temp_c, 1)})
        if soc:
            if cpu is not None:
                cpu.update(clusters=[_domain(d) for d in soc.clusters], cores=[_domain(d) for d in soc.cores])
            if soc.gpu and self._soc:
                gpus.append({**_domain(soc.gpu), "name": "Apple GPU", "cores": self._soc.gpu_cores,
                             "power_w": soc.power_w.get("gpu")})
        return {"ts": time.time(), "interval_s": round(dt, 3) if dt else None,
                "host": _optional(self._read_host), "cpu": cpu, "gpus": gpus, "memory": memory,
                "power_w": power, "temps": temps, "disk": disk_rates, "net": network, "process": process}


def read_system_metrics(use_cache: bool = True) -> dict[str, Any]:
    """One telemetry frame; readings younger than the TTL are shared between callers."""
    global _sampler, _cache
    with _lock:
        if use_cache and _cache is not None and time.monotonic() - _cache[0] < _CACHE_TTL_SECONDS:
            return _cache[1]
        if _sampler is None:
            _sampler = _Sampler()
        frame = _sampler.read()
        _cache = (time.monotonic(), frame)
        return frame


def reset() -> None:
    """Close native resources and drop the sampler/cache; safe to repeat at shutdown."""
    global _sampler, _cache
    with _lock:
        sampler = _sampler
        _sampler, _cache = None, None
        if sampler is not None:
            sampler.close()
