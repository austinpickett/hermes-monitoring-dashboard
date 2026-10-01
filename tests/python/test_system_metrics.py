"""Behavior tests for the live telemetry frame (dashboard/system_metrics.py)."""

from __future__ import annotations

from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import types

import psutil

import pytest

from dashboard import system_metrics
from dashboard.system_metrics import _rate, _volumes, read_system_metrics


@pytest.fixture(autouse=True)
def _fresh_sampler():
    system_metrics.reset()
    yield
    system_metrics.reset()


def test_first_frame_has_no_window_and_the_next_frame_covers_the_gap():
    first = read_system_metrics(use_cache=False)
    assert first["interval_s"] is None
    assert first["disk"]["read_bps"] is None and first["net"]["rx_bps"] is None
    assert first["cpu"]["clusters"] == []  # SoC delta would span milliseconds
    assert len(first["cpu"]["per_core"]) == first["cpu"]["count_logical"]
    # NVML utilization is instantaneous, so NVIDIA hosts carry GPU rows on the first frame too;
    # every such row must be a live reading, not a placeholder.
    for gpu in first["gpus"]:
        assert gpu["active"] is None or 0 <= gpu["active"] <= 1

    time.sleep(0.3)
    second = read_system_metrics(use_cache=False)
    assert second["interval_s"] > 0
    assert second["ts"] > first["ts"]
    for rate in (second["net"]["rx_bps"], second["net"]["tx_bps"]):
        assert rate is None or rate >= 0


def test_frame_sections_agree_with_each_other():
    read_system_metrics(use_cache=False)
    frame = read_system_metrics(use_cache=False)
    cpu, mem = frame["cpu"], frame["memory"]
    assert len(cpu["per_core"]) == cpu["count_logical"]
    assert 0 <= cpu["percent"] <= 100
    assert mem["used"] <= mem["total"] and mem["available"] <= mem["total"]
    for vol in frame["disk"]["volumes"]:
        assert vol["used"] <= vol["total"]
        assert vol["percent"] == pytest.approx(100 * vol["used"] / vol["total"], abs=0.1)
    assert frame["process"]["rss"] > 0


def test_pollers_inside_the_ttl_share_one_window():
    first = read_system_metrics()
    assert read_system_metrics() is first
    assert read_system_metrics(use_cache=False) is not first


def test_cpu_windows_follow_the_sampler_across_persistent_executor_workers(monkeypatch):
    zero = psutil.cpu_times()._replace(**{field: 0 for field in psutil.cpu_times()._fields})
    current = [zero._replace(user=100, idle=100)]
    monkeypatch.setattr(psutil, "cpu_times", lambda percpu=False: list(current) if percpu else current[0])
    monkeypatch.setattr(system_metrics.apple_silicon, "open_sampler", lambda: None)
    monkeypatch.setattr(system_metrics.nvidia, "open_sampler", lambda: None)

    def sample():
        return threading.get_ident(), read_system_metrics(use_cache=False)

    # Both workers stay alive: thread IDs cannot be recycled between polls.
    with ThreadPoolExecutor(max_workers=1) as first, ThreadPoolExecutor(max_workers=1) as second:
        first_id, _ = first.submit(sample).result(timeout=10)
        current[:] = [zero._replace(user=130, idle=170)]
        second_id, frame = second.submit(sample).result(timeout=10)
        assert first_id != second_id
        assert frame["cpu"]["per_core"] == [30.0]
        current[:] = [zero._replace(user=190, idle=210)]
        returned_id, frame = first.submit(sample).result(timeout=10)
        assert returned_id == first_id
        assert frame["cpu"]["per_core"] == [60.0]


@pytest.mark.parametrize("fields, before, after, expected", [
    ("user nice system idle iowait irq softirq steal guest guest_nice",
     (0, 0, 0, 0, 0, 0, 0, 0, 0, 0), (30, 10, 10, 20, 30, 0, 0, 0, 20, 5), 50.0),
    ("user system idle", (100, 100, 100), (110, 90, 130), 25.0),
    ("user system idle", (100, 100, 100), (1, 1, 1), 0.0),
    ("user system idle", (100, 100, 100), (100, 100, 100), 0.0),
])
def test_cpu_counter_math_handles_guest_iowait_and_decreasing_fields(fields, before, after, expected):
    # Counter schemas are data, not an emulated host OS.
    counters = namedtuple("CpuTimes", fields)
    assert system_metrics._cpu_percent(counters(*before), counters(*after)) == expected


@pytest.mark.parametrize("failed", ["cpu", "memory", "disk", "net", "process", "soc", "nvml", "temps", "volumes"])
def test_section_failure_preserves_healthy_readings_and_recovery_windows(monkeypatch, failed):
    clock = [10.0]
    monkeypatch.setattr(system_metrics, "time", types.SimpleNamespace(monotonic=lambda: clock[0], time=lambda: clock[0]))
    zero = psutil.cpu_times()._replace(**{field: 0 for field in psutil.cpu_times()._fields})
    failing = [None]

    def reading(section, value):
        if failing[0] == section:
            raise OSError(f"{section} temporarily unavailable")
        return value

    monkeypatch.setattr(psutil, "cpu_times", lambda percpu=False: reading("cpu", [zero._replace(user=clock[0], idle=clock[0])]))
    monkeypatch.setattr(psutil, "disk_io_counters", lambda: reading("disk", types.SimpleNamespace(read_bytes=clock[0] * 100, write_bytes=clock[0] * 200)))
    monkeypatch.setattr(psutil, "net_io_counters", lambda: reading("net", types.SimpleNamespace(bytes_recv=clock[0] * 300, bytes_sent=clock[0] * 400)))
    memory = psutil.virtual_memory()
    monkeypatch.setattr(psutil, "virtual_memory", lambda: reading("memory", memory))
    monkeypatch.setattr(system_metrics, "_volumes", lambda ps: reading("volumes", [{"mount": "/"}]))
    monkeypatch.setattr(system_metrics, "_linux_temps", lambda ps: reading("temps", [{"name": "cpu", "celsius": 50}]))
    soc = system_metrics.apple_silicon.SocReading(interval_s=1, power_w={"cpu": 2})
    gpu = system_metrics.nvidia.GpuReading("GPU", 0.5, None, None, 3, None, 60, None, None)
    monkeypatch.setattr(system_metrics.apple_silicon, "open_sampler", lambda: types.SimpleNamespace(sample=lambda: reading("soc", soc), close=lambda: None))
    monkeypatch.setattr(system_metrics.nvidia, "open_sampler", lambda: types.SimpleNamespace(sample=lambda: reading("nvml", [gpu]), close=lambda: None))
    read_system_metrics(use_cache=False)
    assert system_metrics._sampler is not None
    proc = system_metrics._sampler._proc
    threads = proc.num_threads()
    monkeypatch.setattr(proc, "num_threads", lambda: reading("process", threads))
    clock[0] = 11.0
    failing[0] = failed
    frame = read_system_metrics(use_cache=False)
    for section in ("cpu", "memory", "process"):
        assert (frame[section] is None) == (failed == section)
    assert frame["disk"]["volumes"] == ([] if failed == "volumes" else [{"mount": "/"}])
    expected_temps = [] if failed == "temps" else [{"name": "cpu", "celsius": 50}]
    if failed != "nvml":
        expected_temps.append({"name": "gpu0 GPU", "celsius": 60})
    assert frame["temps"] == expected_temps
    assert bool(frame["gpus"]) == (failed != "nvml")
    assert ("cpu" in frame["power_w"]) == (failed != "soc")
    assert frame["disk"]["read_bps"] == (None if failed == "disk" else 100)
    assert frame["net"]["rx_bps"] == (None if failed == "net" else 300)
    # Failed sections retain their last successful baseline; successful sections
    # must not accidentally share that older interval on recovery.
    clock[0] = 13.0
    failing[0] = None
    recovered = read_system_metrics(use_cache=False)
    assert recovered["cpu"]["per_core"] == [50.0]
    assert recovered["disk"]["read_bps"] == 100
    assert recovered["net"]["rx_bps"] == 300
    assert recovered["process"]["rss"] > 0


@pytest.mark.parametrize("failure", [None, "nvml", "process", "cancel"])
def test_sampler_releases_owned_sensors_on_reset_or_interrupted_construction(monkeypatch, failure):
    closed = []
    soc = types.SimpleNamespace(sample=lambda: None, close=lambda: closed.append("soc"))
    nvml = types.SimpleNamespace(sample=lambda: [], close=lambda: closed.append("nvml"))
    monkeypatch.setattr(system_metrics.apple_silicon, "open_sampler", lambda: soc)

    def open_nvml():
        if failure == "cancel":
            raise KeyboardInterrupt()
        if failure == "nvml":
            raise OSError("driver unavailable")
        return nvml

    monkeypatch.setattr(system_metrics.nvidia, "open_sampler", open_nvml)
    if failure == "process":
        def denied(*args):
            raise psutil.AccessDenied()
        monkeypatch.setattr(psutil, "Process", denied)
    if failure == "cancel":
        with pytest.raises(KeyboardInterrupt):
            read_system_metrics(use_cache=False)
        assert system_metrics._sampler is None
    else:
        frame = read_system_metrics(use_cache=False)
        assert frame["memory"]["total"] > 0
        assert (frame["process"] is None) == (failure == "process")
    system_metrics.reset()
    system_metrics.reset()
    assert closed == (["soc"] if failure in ("nvml", "cancel") else ["soc", "nvml"])


def test_counter_reset_yields_no_rate():
    assert _rate(100, 400, 1.0) is None
    assert _rate(400, None, 1.0) is None
    assert _rate(400, 100, 0.0) is None
    assert _rate(400, 100, 2.0) == 150


def test_container_mounts_collapse_to_one_row_with_container_usage():
    gib = 1 << 30
    usage = {
        "/": types.SimpleNamespace(total=100 * gib, used=10 * gib, free=40 * gib),
        "/System/Volumes/Data": types.SimpleNamespace(total=100 * gib, used=50 * gib, free=40 * gib),
        "/Volumes/External": types.SimpleNamespace(total=500 * gib, used=5 * gib, free=495 * gib),
        "/System/Volumes/xarts": types.SimpleNamespace(total=gib // 2, used=0, free=gib // 2),
    }
    fake = types.SimpleNamespace(
        disk_partitions=lambda all=False: [types.SimpleNamespace(mountpoint=m, fstype="apfs") for m in usage],
        disk_usage=lambda m: usage[m],
    )
    rows = _volumes(fake)
    assert [r["mount"] for r in rows] == ["/Volumes/External", "/"]
    root = rows[1]
    assert root["used"] == 60 * gib  # total - shared free, not the "/" volume's own 10 GiB
    assert root["percent"] == pytest.approx(60.0)
