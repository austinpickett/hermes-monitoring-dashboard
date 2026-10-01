"""NVIDIA sensor binding (pure) and a live read on a Windows/Linux host with NVML."""

from __future__ import annotations

import ctypes as C
import sys
import time
from types import SimpleNamespace

import pytest

from dashboard.sensors import nvidia
from dashboard.sensors.nvidia import open_sampler


def test_library_path_follows_the_os_convention_and_takes_no_env_input():
    if sys.platform == "win32":
        assert nvidia.nvml_library_path() == r"C:\Windows\System32\nvml.dll"
    elif sys.platform.startswith("linux"):
        assert nvidia.nvml_library_path() == "libnvidia-ml.so.1"
    else:
        assert nvidia.nvml_library_path() is None  # macOS: no NVML, nothing invented


def test_open_sampler_never_raises_off_nvidia_hosts(monkeypatch):
    monkeypatch.setattr(nvidia, "nvml_library_path", lambda: None)
    assert open_sampler() is None
    monkeypatch.setattr(nvidia, "nvml_library_path", lambda: r"C:\does\not\exist.dll")
    assert open_sampler() is None


def test_unreadable_values_read_back_none_not_zero():
    reading = nvidia.GpuReading(name="x", active=None, freq_mhz=None, cores=None, power_w=None,
                                power_limit_w=None, temp_c=None, mem_total=None, mem_used=None)
    assert reading.active is None and reading.freq_mhz is None and reading.cores is None
    assert reading.power_w is None and reading.temp_c is None


@pytest.fixture
def nvml_lib(monkeypatch):
    """A driver ABI double; library discovery is injected, not the host OS."""
    def uint_result(value):
        def call(*args):
            C.cast(args[-1], C.POINTER(C.c_uint))[0] = value
            return 0
        return call

    def device(index, out):
        C.cast(out, C.POINTER(C.c_void_p))[0] = index + 1
        return 0

    def name(device, out, size):
        out.value = b"Test GPU"
        return 0

    def memory(device, out):
        values = C.cast(out, C.POINTER(C.c_ulonglong))
        values[0], values[1], values[2] = 8192, 6144, 2048
        return 0

    lib = SimpleNamespace(
        nvmlInit_v2=lambda: 0,
        nvmlShutdown=lambda: 0,
        nvmlDeviceGetCount_v2=uint_result(1),
        nvmlDeviceGetHandleByIndex_v2=device,
        nvmlDeviceGetName=name,
        nvmlDeviceGetUtilizationRates=uint_result(25),
        nvmlDeviceGetClockInfo=uint_result(1500),
        nvmlDeviceGetTemperature=uint_result(55),
        nvmlDeviceGetPowerUsage=uint_result(75000),
        nvmlDeviceGetPowerManagementLimit=uint_result(250000),
        nvmlDeviceGetNumGpuCores=uint_result(4096),
        nvmlDeviceGetMemoryInfo=memory,
    )
    load_library = nvidia.C.CDLL
    monkeypatch.setattr(nvidia, "nvml_library_path", lambda: "test-nvml")
    monkeypatch.setattr(nvidia.C, "CDLL", lambda path, *args, **kwargs:
                        lib if path == "test-nvml" else load_library(path, *args, **kwargs))
    return lib


def test_missing_optional_core_query_preserves_other_gpu_readings(nvml_lib):
    del nvml_lib.nvmlDeviceGetNumGpuCores
    sampler = open_sampler()
    assert sampler is not None
    try:
        gpu, = sampler.sample()
        assert gpu.cores is None
        assert gpu.name == "Test GPU"
        assert gpu.active == 0.25
        assert gpu.power_w == 75.0
        assert gpu.mem_used == 2048
    finally:
        sampler.close()


def test_frequency_uses_sm_clock_not_graphics_clock(nvml_lib):
    def clock(device, domain, out):
        # NVML_CLOCK_GRAPHICS=0 and NVML_CLOCK_SM=1 can report different rates.
        C.cast(out, C.POINTER(C.c_uint))[0] = {0: 1200, 1: 1500}[domain]
        return 0

    nvml_lib.nvmlDeviceGetClockInfo = clock
    sampler = open_sampler()
    assert sampler is not None
    try:
        gpu, = sampler.sample()
        assert gpu.freq_mhz == 1500.0
    finally:
        sampler.close()


@pytest.mark.parametrize("failure", [None, "missing_query", "init", "enumeration"])
def test_sampler_releases_exactly_the_initialization_it_owns(nvml_lib, failure):
    calls = []

    def initialize():
        calls.append("init")
        return 1 if failure == "init" else 0

    def shutdown():
        calls.append("shutdown")
        return 0

    nvml_lib.nvmlInit_v2 = initialize
    nvml_lib.nvmlShutdown = shutdown
    if failure == "missing_query":
        del nvml_lib.nvmlDeviceGetMemoryInfo
    elif failure == "enumeration":
        nvml_lib.nvmlDeviceGetCount_v2 = lambda out: 1

    sampler = open_sampler()
    if failure is None:
        assert sampler is not None
        assert calls == ["init"]
        sampler.close()
        sampler.close()
        assert sampler.sample() == []
        assert calls == ["init", "shutdown"]
    else:
        assert sampler is None
        if failure == "init":
            assert calls == ["init"]
        elif failure == "enumeration":
            assert calls == ["init", "shutdown"]
        else:
            assert calls == []  # bind required symbols before acquiring a session


def test_unsupported_utilization_survives_metrics_api_serialization(nvml_lib):
    from dashboard import system_metrics, plugin_api
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    nvml_lib.nvmlDeviceGetUtilizationRates = lambda *args: 3  # NVML_ERROR_NOT_SUPPORTED
    system_metrics.reset()
    app = FastAPI()
    app.include_router(plugin_api.router)
    with TestClient(app) as client:
        response = client.get("/metrics")
        assert response.status_code == 200
        frame = response.json()
        assert frame["available"] is True
        gpu, = [gpu for gpu in frame["gpus"] if gpu["name"] == "Test GPU"]
        assert gpu["active"] is None
        assert gpu["mem_used"] == 2048
        assert frame["cpu"]["count_logical"] > 0
    assert system_metrics._sampler is None


@pytest.mark.skipif(sys.platform != "win32" and not sys.platform.startswith("linux"), reason="NVML is available on Windows/Linux")
def test_live_sample_stays_within_the_hardware_envelope():
    sampler = open_sampler()
    if sampler is None:  # a host may have no NVIDIA driver; the null path is the contract
        pytest.skip("no NVML on this host")
    try:
        time.sleep(0.2)
        gpus = sampler.sample()
    finally:
        sampler.close()
    assert gpus, "NVML initialized but reports no devices"
    for gpu in gpus:
        if gpu.active is not None:
            assert 0.0 <= gpu.active <= 1.0
        if gpu.temp_c is not None:
            assert 0 < gpu.temp_c < 150
        if gpu.power_w is not None:
            assert gpu.power_w >= 0
        if gpu.mem_total is not None and gpu.mem_used is not None:
            assert gpu.mem_used <= gpu.mem_total
