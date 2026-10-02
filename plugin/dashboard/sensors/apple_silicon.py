"""Apple Silicon SoC telemetry without sudo: IOReport residency/energy, HID thermals, DVFS tables.

``powermetrics`` needs root; the same counters are readable unprivileged through the private
``libIOReport`` (CPU/GPU performance-state residency and the Energy Model) plus the HID
temperature services and the ``pmgr`` voltage-state tables in the IORegistry. Every sample is a
delta against the previous one; construction primes the counters.
"""

from __future__ import annotations

import ctypes as C
import ctypes.util
import re
import struct
import sys
import time
from dataclasses import dataclass, field

_UTF8 = 0x08000100
_CF_NUMBER_SINT32 = 3
_CF_NUMBER_SINT64 = 4
_HID_TEMPERATURE_EVENT = 15
_HID_TEMPERATURE_FIELD = _HID_TEMPERATURE_EVENT << 16
_IDLE_STATES = frozenset({"IDLE", "OFF", "DOWN"})
_ENERGY_UNIT_JOULES = {"mJ": 1e-3, "uJ": 1e-6, "nJ": 1e-9}
# Energy Model channel-name prefix → power bucket (ANE/DRAM have several channels each).
_POWER_BUCKETS = (("CPU Energy", "cpu"), ("GPU Energy", "gpu"), ("ANE", "ane"), ("DRAM", "dram"))
# pmgr voltage-state tables by DVFS domain: E-cluster, P-cluster, GPU.
_DVFS_KEYS = {"E": "voltage-states1-sram", "P": "voltage-states5-sram", "GPU": "voltage-states9"}
_IOREPORT_GROUPS = (
    ("Energy Model", None),
    ("CPU Stats", "CPU Complex Performance States"),
    ("CPU Stats", "CPU Core Performance States"),
    ("GPU Stats", "GPU Performance States"),
)


@dataclass(frozen=True)
class Domain:
    """One DVFS domain (a CPU cluster, a CPU core, or the GPU) over the sample window."""

    name: str
    kind: str  # "E" | "P" | "GPU"
    active: float  # 0..1 share of the window spent outside idle states
    freq_mhz: float | None  # residency-weighted frequency while active


@dataclass(frozen=True)
class SocReading:
    interval_s: float
    clusters: list[Domain] = field(default_factory=list)
    cores: list[Domain] = field(default_factory=list)
    gpu: Domain | None = None
    power_w: dict[str, float] = field(default_factory=dict)  # cpu / gpu / ane / dram
    temps_c: dict[str, float] = field(default_factory=dict)  # sensor name → °C


def residency_summary(states: list[tuple[str, int]], freqs_mhz: list[float]) -> tuple[float, float | None]:
    """Active share and residency-weighted MHz; active states map onto the table in order."""
    total = sum(r for _, r in states)
    if total <= 0:
        return 0.0, None
    active = [r for name, r in states if name not in _IDLE_STATES]
    busy = sum(active)
    if busy <= 0 or not freqs_mhz:
        return busy / total, None
    weighted = sum(r * freqs_mhz[min(i, len(freqs_mhz) - 1)] for i, r in enumerate(active))
    return busy / total, weighted / busy


def dvfs_table_mhz(raw: bytes) -> list[float]:
    """Decode a pmgr voltage-state blob (``<freq, voltage>`` u32 pairs) to MHz, dropping 0 Hz rows.

    M1–M3 store Hz, M4 stores kHz; the magnitude tells them apart (no SoC exceeds 10 GHz).
    """
    freqs = [f for f, _ in struct.iter_unpack("<II", raw[: len(raw) - len(raw) % 8]) if f]
    scale = 1e6 if freqs and max(freqs) > 10_000_000 else 1e3
    return [f / scale for f in freqs]


def energy_watts(value: int, unit: str, interval_s: float) -> float | None:
    joules = _ENERGY_UNIT_JOULES.get(unit)
    if joules is None or interval_s <= 0:
        return None
    return value * joules / interval_s


def _power_bucket(channel: str) -> str | None:
    return next((bucket for prefix, bucket in _POWER_BUCKETS if channel.startswith(prefix)), None)


class _Frameworks:
    """ctypes bindings for CoreFoundation, IOKit and libIOReport (signatures declared once)."""

    def __init__(self) -> None:
        vp = C.c_void_p
        self.cf = cf = C.CDLL(ctypes.util.find_library("CoreFoundation"))
        self.iokit = io = C.CDLL(ctypes.util.find_library("IOKit"))
        self.ior = ior = C.CDLL("/usr/lib/libIOReport.dylib")
        sigs = {
            cf: {
                "CFStringCreateWithCString": (vp, [vp, C.c_char_p, C.c_uint32]),
                "CFStringGetCString": (C.c_bool, [vp, C.c_char_p, C.c_long, C.c_uint32]),
                "CFNumberCreate": (vp, [vp, C.c_int, vp]),
                "CFNumberGetValue": (C.c_bool, [vp, C.c_int, vp]),
                "CFDictionaryCreate": (vp, [vp, C.POINTER(vp), C.POINTER(vp), C.c_long, vp, vp]),
                "CFDictionaryGetValue": (vp, [vp, vp]),
                "CFArrayGetCount": (C.c_long, [vp]),
                "CFArrayGetValueAtIndex": (vp, [vp, C.c_long]),
                "CFDataGetLength": (C.c_long, [vp]),
                "CFDataGetBytePtr": (vp, [vp]),
                "CFRelease": (None, [vp]),
                "CFRetain": (vp, [vp]),
            },
            io: {
                "IOHIDEventSystemClientCreate": (vp, [vp]),
                "IOHIDEventSystemClientSetMatching": (C.c_int, [vp, vp]),
                "IOHIDEventSystemClientCopyServices": (vp, [vp]),
                "IOHIDServiceClientCopyProperty": (vp, [vp, vp]),
                "IOHIDServiceClientCopyEvent": (vp, [vp, C.c_int64, C.c_int32, C.c_int64]),
                "IOHIDEventGetFloatValue": (C.c_double, [vp, C.c_int32]),
                "IOServiceMatching": (vp, [C.c_char_p]),
                "IOServiceGetMatchingServices": (C.c_int, [C.c_uint32, vp, C.POINTER(C.c_uint32)]),
                "IOIteratorNext": (C.c_uint32, [C.c_uint32]),
                "IORegistryEntryGetName": (C.c_int, [C.c_uint32, C.c_char_p]),
                "IORegistryEntryCreateCFProperty": (vp, [C.c_uint32, vp, vp, C.c_uint32]),
                "IOObjectRelease": (C.c_int, [C.c_uint32]),
            },
            ior: {
                "IOReportCopyChannelsInGroup": (vp, [vp, vp, C.c_uint64, C.c_uint64, C.c_uint64]),
                "IOReportMergeChannels": (None, [vp, vp, vp]),
                "IOReportCreateSubscription": (vp, [vp, vp, C.POINTER(vp), C.c_uint64, vp]),
                "IOReportCreateSamples": (vp, [vp, vp, vp]),
                "IOReportCreateSamplesDelta": (vp, [vp, vp, vp]),
                "IOReportChannelGetGroup": (vp, [vp]),
                "IOReportChannelGetSubGroup": (vp, [vp]),
                "IOReportChannelGetChannelName": (vp, [vp]),
                "IOReportChannelGetUnitLabel": (vp, [vp]),
                "IOReportSimpleGetIntegerValue": (C.c_int64, [vp, C.c_int32]),
                "IOReportStateGetCount": (C.c_int32, [vp]),
                "IOReportStateGetNameForIndex": (vp, [vp, C.c_int32]),
                "IOReportStateGetResidency": (C.c_int64, [vp, C.c_int32]),
            },
        }
        for lib, table in sigs.items():
            for name, (restype, argtypes) in table.items():
                fn = getattr(lib, name)
                fn.restype, fn.argtypes = restype, argtypes
        self._strings: dict[str, int] = {}

    def close(self) -> None:
        for ref in self._strings.values():
            self.cf.CFRelease(ref)
        self._strings.clear()

    def cfstr(self, text: str) -> int:
        """Interned CFString, owned until the sampler closes."""
        ref = self._strings.get(text)
        if ref is None:
            ref = self.cf.CFStringCreateWithCString(None, text.encode(), _UTF8)
            if not ref:
                raise OSError("CFString allocation failed")
            self._strings[text] = ref
        return ref

    def pystr(self, ref: int | None) -> str:
        if not ref:
            return ""
        buf = C.create_string_buffer(256)
        return buf.value.decode() if self.cf.CFStringGetCString(ref, buf, 256, _UTF8) else ""

    def cfint32(self, value: int) -> int:
        box = C.c_int32(value)
        return self.cf.CFNumberCreate(None, _CF_NUMBER_SINT32, C.byref(box))

    def registry_entries(self, service_class: bytes):
        """Yield ``(name, entry)`` for each IORegistry entry matching the class; entries are released after use."""
        it = C.c_uint32()
        if self.iokit.IOServiceGetMatchingServices(0, self.iokit.IOServiceMatching(service_class), C.byref(it)) != 0:
            return
        try:
            while entry := self.iokit.IOIteratorNext(it):
                name = C.create_string_buffer(128)
                self.iokit.IORegistryEntryGetName(entry, name)
                try:
                    yield name.value.decode(errors="replace"), entry
                finally:
                    self.iokit.IOObjectRelease(entry)
        finally:
            self.iokit.IOObjectRelease(it.value)

    def registry_property(self, entry: int, key: str) -> int | None:
        return self.iokit.IORegistryEntryCreateCFProperty(entry, self.cfstr(key), None, 0) or None


class SocSampler:
    """Holds the IOReport subscription + HID client; :meth:`sample` answers the delta since the last call."""

    def __init__(self) -> None:
        self._fw = fw = _Frameworks()
        self._channels = self._subscription = self._hid = self._last = None
        self._thermal: list[tuple[str, int]] = []
        try:
            self._dvfs = self._read_dvfs_tables()
            self.gpu_cores = self._read_gpu_cores()
            for group, subgroup in _IOREPORT_GROUPS:
                found = fw.ior.IOReportCopyChannelsInGroup(
                    fw.cfstr(group), fw.cfstr(subgroup) if subgroup else None, 0, 0, 0)
                if not found:
                    continue
                if self._channels is None:
                    self._channels = found
                else:
                    try:
                        fw.ior.IOReportMergeChannels(self._channels, found, None)
                    finally:
                        fw.cf.CFRelease(found)
            if not self._channels:
                raise OSError("IOReport exposes no SoC channels")
            sub_dict = C.c_void_p()
            try:
                self._subscription = fw.ior.IOReportCreateSubscription(
                    None, self._channels, C.byref(sub_dict), 0, None)
            finally:
                # The out parameter is an owned dictionary of the channels actually
                # subscribed, not the desired channel list passed into the call.
                fw.cf.CFRelease(self._channels)
                self._channels = sub_dict.value
            if not self._subscription or not self._channels:
                raise OSError("IOReport subscription refused")
            self._open_thermal_services()
            self._last = fw.ior.IOReportCreateSamples(self._subscription, self._channels, None)
            if not self._last:
                raise OSError("IOReport initial sample unavailable")
            self._last_t = time.monotonic()
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Release native ownership, including partially initialized samplers; safe to repeat."""
        fw = self._fw
        for _, svc in self._thermal:
            fw.cf.CFRelease(svc)
        self._thermal.clear()
        # IOReportSubscription is a CF runtime type (CFGetTypeID's description is
        # "IOReportSubscription"); it uses CFRelease, not IOObjectRelease/free.
        for attr in ("_last", "_hid", "_subscription", "_channels"):
            ref = getattr(self, attr)
            if ref:
                setattr(self, attr, None)
                fw.cf.CFRelease(ref)
        fw.close()

    def _read_dvfs_tables(self) -> dict[str, list[float]]:
        fw = self._fw
        tables: dict[str, list[float]] = {}
        for name, entry in fw.registry_entries(b"AppleARMIODevice"):
            if name != "pmgr":
                continue
            for kind, key in _DVFS_KEYS.items():
                data = fw.registry_property(entry, key)
                if data:
                    try:
                        raw = C.string_at(fw.cf.CFDataGetBytePtr(data), fw.cf.CFDataGetLength(data))
                    finally:
                        fw.cf.CFRelease(data)
                    tables[kind] = dvfs_table_mhz(raw)
        return tables

    def _read_gpu_cores(self) -> int | None:
        fw = self._fw
        for _name, entry in fw.registry_entries(b"AGXAccelerator"):
            num = fw.registry_property(entry, "gpu-core-count")
            if num:
                value = C.c_int64()
                try:
                    ok = fw.cf.CFNumberGetValue(num, _CF_NUMBER_SINT64, C.byref(value))
                finally:
                    fw.cf.CFRelease(num)
                if ok:
                    return int(value.value)
        return None

    def _open_thermal_services(self) -> None:
        """Retain every HID temperature service once with its product name (the set is fixed per boot)."""
        fw = self._fw
        cf_type_key = C.c_void_p.in_dll(fw.cf, "kCFTypeDictionaryKeyCallBacks")
        cf_type_val = C.c_void_p.in_dll(fw.cf, "kCFTypeDictionaryValueCallBacks")
        keys = (C.c_void_p * 2)(fw.cfstr("PrimaryUsagePage"), fw.cfstr("PrimaryUsage"))
        vals = []
        try:
            for value in (0xFF00, 5):  # AppleVendor / TemperatureSensor
                ref = fw.cfint32(value)
                if not ref:
                    raise OSError("HID matching number allocation failed")
                vals.append(ref)
            match = fw.cf.CFDictionaryCreate(
                None, keys, (C.c_void_p * 2)(*vals), 2, C.addressof(cf_type_key), C.addressof(cf_type_val))
        finally:
            for ref in vals:
                fw.cf.CFRelease(ref)
        if not match:
            raise OSError("HID matching dictionary allocation failed")
        try:
            self._hid = fw.iokit.IOHIDEventSystemClientCreate(None)
            if not self._hid:
                return
            fw.iokit.IOHIDEventSystemClientSetMatching(self._hid, match)
        finally:
            fw.cf.CFRelease(match)
        services = fw.iokit.IOHIDEventSystemClientCopyServices(self._hid)
        if not services:
            return
        try:
            for i in range(fw.cf.CFArrayGetCount(services)):
                svc = fw.cf.CFArrayGetValueAtIndex(services, i)
                prop = fw.iokit.IOHIDServiceClientCopyProperty(svc, fw.cfstr("Product"))
                try:
                    name = fw.pystr(prop)
                finally:
                    if prop:
                        fw.cf.CFRelease(prop)
                if name:
                    # Record ownership immediately so partial setup is also closable.
                    self._thermal.append((name, fw.cf.CFRetain(svc)))
        finally:
            fw.cf.CFRelease(services)

    def _read_temps(self) -> dict[str, float]:
        """Mean °C per sensor name (the PMU exposes most sensors once per die/instance)."""
        fw = self._fw
        readings: dict[str, list[float]] = {}
        for name, svc in self._thermal:
            event = fw.iokit.IOHIDServiceClientCopyEvent(svc, _HID_TEMPERATURE_EVENT, 0, 0)
            if not event:
                continue
            try:
                celsius = fw.iokit.IOHIDEventGetFloatValue(event, _HID_TEMPERATURE_FIELD)
            finally:
                fw.cf.CFRelease(event)
            if 0 < celsius < 150:  # unpowered sensors report 0 or sentinel values
                readings.setdefault(name, []).append(celsius)
        return {name: sum(v) / len(v) for name, v in sorted(readings.items())}

    def _states(self, channel: int) -> list[tuple[str, int]]:
        ior = self._fw.ior
        return [(self._fw.pystr(ior.IOReportStateGetNameForIndex(channel, k)), ior.IOReportStateGetResidency(channel, k))
                for k in range(ior.IOReportStateGetCount(channel))]

    def sample(self) -> SocReading:
        if not self._subscription:
            raise OSError("SoC sampler is closed")
        fw = self._fw
        now_sample = fw.ior.IOReportCreateSamples(self._subscription, self._channels, None)
        now = time.monotonic()
        if not now_sample:
            # Keep the previous sample AND timestamp: the next read spans this gap.
            raise OSError("IOReport sample unavailable")
        interval = now - self._last_t
        delta = fw.ior.IOReportCreateSamplesDelta(self._last, now_sample, None)
        fw.cf.CFRelease(self._last)
        self._last, self._last_t = now_sample, now
        if not delta:
            # The new sample is valid; re-prime rather than reusing an incompatible pair.
            raise OSError("IOReport sample delta unavailable")
        clusters: list[Domain] = []
        cores: list[Domain] = []
        gpu: Domain | None = None
        power: dict[str, float] = {}
        try:
            channels = fw.cf.CFDictionaryGetValue(delta, fw.cfstr("IOReportChannels"))
            for i in range(fw.cf.CFArrayGetCount(channels) if channels else 0):
                ch = fw.cf.CFArrayGetValueAtIndex(channels, i)
                group = fw.pystr(fw.ior.IOReportChannelGetGroup(ch))
                name = fw.pystr(fw.ior.IOReportChannelGetChannelName(ch))
                # Ultra chips repeat channel names per die. Classify the suffix,
                # but retain the full name as the domain identity.
                local_name = re.sub(r"^DIE_[0-9]+_", "", name)
                if group == "Energy Model":
                    bucket = _power_bucket(local_name)
                    if bucket:
                        unit = fw.pystr(fw.ior.IOReportChannelGetUnitLabel(ch))
                        watts = energy_watts(fw.ior.IOReportSimpleGetIntegerValue(ch, 0), unit, interval)
                        if watts is not None:
                            power[bucket] = power.get(bucket, 0.0) + watts
                    continue
                subgroup = fw.pystr(fw.ior.IOReportChannelGetSubGroup(ch))
                if group == "GPU Stats" and name == "GPUPH":
                    active, freq = residency_summary(self._states(ch), self._dvfs.get("GPU", []))
                    gpu = Domain(name, "GPU", active, freq)
                elif group == "CPU Stats" and local_name.startswith(("ECPU", "PCPU")):
                    kind = local_name[0]
                    active, freq = residency_summary(self._states(ch), self._dvfs.get(kind, []))
                    target = clusters if subgroup == "CPU Complex Performance States" else cores
                    target.append(Domain(name, kind, active, freq))
        finally:
            fw.cf.CFRelease(delta)
        return SocReading(interval_s=interval, clusters=clusters, cores=cores, gpu=gpu,
                          power_w=power, temps_c=self._read_temps())


def open_sampler() -> SocSampler | None:
    """A primed sampler on Apple Silicon macOS, else ``None`` (Intel Macs, other OSes, missing frameworks)."""
    if sys.platform != "darwin":
        return None
    try:
        return SocSampler()
    except (OSError, AttributeError, ValueError):
        return None
