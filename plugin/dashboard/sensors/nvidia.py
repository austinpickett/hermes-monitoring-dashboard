"""NVIDIA GPU telemetry without a daemon: NVML through ``ctypes``.

NVML ships inside the display driver (``System32\\nvml.dll`` on Windows, ``libnvidia-ml.so.1``
on Linux); loading it needs no install, no elevated privileges, and no environment-variable
input. A value NVML cannot report for a device (older drivers, NPU-class devices without
graphics engines, permission-restricted contexts) reads back ``None`` — never invented.
"""

from __future__ import annotations

import ctypes as C
import sys

_NVML_CLOCK_SM = 1
_NVML_TEMPERATURE_GPU = 0


class GpuReading:
    """One live GPU reading; ``None`` members are values NVML did not report."""

    __slots__ = ("name", "active", "freq_mhz", "cores", "power_w", "power_limit_w",
                 "temp_c", "mem_total", "mem_used")

    def __init__(self, name, active, freq_mhz, cores, power_w, power_limit_w, temp_c, mem_total, mem_used):
        self.name = name
        self.active = active              # 0..1 utilization share
        self.freq_mhz = freq_mhz
        self.cores = cores
        self.power_w = power_w
        self.power_limit_w = power_limit_w
        self.temp_c = temp_c
        self.mem_total = mem_total
        self.mem_used = mem_used


def nvml_library_path() -> str | None:
    """The driver's NVML entry point by OS convention. No PATH search, no env input."""
    if sys.platform == "win32":
        return r"C:\Windows\System32\nvml.dll"
    if sys.platform.startswith("linux"):
        return "libnvidia-ml.so.1"
    return None


class NvmlSampler:
    """Holds the NVML session; :meth:`sample` answers one reading per device."""

    def __init__(self, lib):
        self._lib = lib
        self._devices: list[tuple[int, str]] = []
        count = C.c_uint(0)
        if lib.nvmlDeviceGetCount_v2(C.byref(count)) != 0:
            raise OSError("NVML device enumeration failed")
        handle = C.c_void_p()
        name_buf = C.create_string_buffer(96)
        for i in range(count.value):
            if lib.nvmlDeviceGetHandleByIndex_v2(i, C.byref(handle)) != 0:
                continue
            name = name_buf.value.decode(errors="replace") if lib.nvmlDeviceGetName(handle, name_buf, 96) == 0 else ""
            self._devices.append((handle.value, name))

    def close(self) -> None:
        """Release this sampler's NVML initialization exactly once."""
        lib, self._lib = self._lib, None
        self._devices.clear()
        if lib is not None:
            lib.nvmlShutdown()

    def _mw_to_w(self, dev_p, fn) -> float | None:
        val = C.c_uint(0)
        return val.value / 1000.0 if fn(dev_p, C.byref(val)) == 0 else None

    def sample(self) -> list[GpuReading]:
        lib = self._lib
        if lib is None:
            return []
        out: list[GpuReading] = []
        for dev, name in self._devices:
            dev_p = C.c_void_p(dev)
            active = None
            util = (C.c_uint * 2)()  # nvmlUtilization_t: gpu, memory
            if lib.nvmlDeviceGetUtilizationRates(dev_p, C.byref(util)) == 0 and util[0] <= 100:
                active = util[0] / 100.0
            freq = None
            clk = C.c_uint(0)
            if lib.nvmlDeviceGetClockInfo(dev_p, _NVML_CLOCK_SM, C.byref(clk)) == 0 and clk.value:
                freq = float(clk.value)
            power_w = self._mw_to_w(dev_p, lib.nvmlDeviceGetPowerUsage)
            limit_w = self._mw_to_w(dev_p, lib.nvmlDeviceGetPowerManagementLimit)
            temp = None
            t = C.c_uint(0)
            if lib.nvmlDeviceGetTemperature(dev_p, _NVML_TEMPERATURE_GPU, C.byref(t)) == 0 and t.value:
                temp = float(t.value)
            cores = None
            c = C.c_uint(0)
            core_query = getattr(lib, "nvmlDeviceGetNumGpuCores", None)
            if core_query is not None and core_query(dev_p, C.byref(c)) == 0 and c.value:
                cores = c.value
            mem_total = mem_used = None
            mem = (C.c_ulonglong * 3)()  # nvmlMemory_t: total, free, used
            if lib.nvmlDeviceGetMemoryInfo(dev_p, C.byref(mem)) == 0:
                mem_total, mem_used = mem[0], mem[2]
            out.append(GpuReading(name, active, freq, cores, power_w, limit_w, temp, mem_total, mem_used))
        return out


def open_sampler() -> NvmlSampler | None:
    """A live NVML sampler, else ``None``. Never raises."""
    path = nvml_library_path()
    if path is None:
        return None
    lib = None
    initialized = False
    try:
        lib = C.CDLL(path)
        for fname, argtypes in (
            ("nvmlInit_v2", []),
            ("nvmlShutdown", []),
            ("nvmlDeviceGetCount_v2", [C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetHandleByIndex_v2", [C.c_uint, C.POINTER(C.c_void_p)]),
            ("nvmlDeviceGetName", [C.c_void_p, C.c_char_p, C.c_uint]),
            ("nvmlDeviceGetUtilizationRates", [C.c_void_p, C.c_void_p]),
            ("nvmlDeviceGetTemperature", [C.c_void_p, C.c_uint, C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetPowerUsage", [C.c_void_p, C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetPowerManagementLimit", [C.c_void_p, C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetClockInfo", [C.c_void_p, C.c_uint, C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetNumGpuCores", [C.c_void_p, C.POINTER(C.c_uint)]),
            ("nvmlDeviceGetMemoryInfo", [C.c_void_p, C.c_void_p]),
        ):
            fn = getattr(lib, fname, None)
            if fn is None:
                if fname == "nvmlDeviceGetNumGpuCores":  # added in newer NVML drivers
                    continue
                return None
            fn.restype = C.c_uint
            fn.argtypes = argtypes
        if lib.nvmlInit_v2() != 0:
            return None
        initialized = True
        sampler = NvmlSampler(lib)
        initialized = False  # ownership transfers to sampler.close()
        return sampler
    except (OSError, AttributeError):
        return None
    finally:
        if initialized and lib is not None:
            lib.nvmlShutdown()
