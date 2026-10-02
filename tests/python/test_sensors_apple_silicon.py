"""Apple Silicon sensor decoding (pure) and a live read on the macOS lane."""

from __future__ import annotations

import platform
import struct
import subprocess
import sys
import time
import textwrap
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from dashboard.sensors.apple_silicon import (
    dvfs_table_mhz,
    energy_watts,
    open_sampler,
    residency_summary,
)


def test_residency_excludes_idle_and_weights_frequency_by_time():
    table = [600.0, 1200.0, 2400.0]
    active, freq = residency_summary([("IDLE", 50), ("V0P2", 25), ("V1P1", 0), ("V2P0", 25)], table)
    assert active == pytest.approx(0.5)
    # Half the busy time at the lowest step, half at the highest.
    assert freq == pytest.approx((table[0] + table[2]) / 2)


def test_residency_with_more_states_than_table_rows_clamps_to_the_top_step():
    _, freq = residency_summary([("OFF", 0), ("P1", 0), ("P2", 10)], [400.0])
    assert freq == 400.0


def test_fully_idle_or_empty_windows_report_no_frequency():
    assert residency_summary([("IDLE", 100)], [600.0]) == (0.0, None)
    assert residency_summary([], [600.0]) == (0.0, None)


def test_dvfs_tables_decode_hz_and_khz_encodings_to_the_same_mhz():
    freqs_mhz = [600, 1332, 3228]
    as_hz = b"".join(struct.pack("<II", f * 1_000_000, 800) for f in [0, *freqs_mhz])
    as_khz = b"".join(struct.pack("<II", f * 1_000, 800) for f in freqs_mhz)
    assert dvfs_table_mhz(as_hz) == dvfs_table_mhz(as_khz) == [float(f) for f in freqs_mhz]


def test_energy_counters_convert_to_watts_over_the_window():
    assert energy_watts(2_000, "mJ", 2.0) == pytest.approx(1.0)
    assert energy_watts(5_000_000_000, "nJ", 1.0) == pytest.approx(5.0)
    assert energy_watts(1, "furlongs", 1.0) is None
    assert energy_watts(1, "mJ", 0.0) is None


@pytest.mark.parametrize("failure", ["sample", "delta"])
def test_failed_read_can_recover_without_using_null_or_losing_its_window(monkeypatch, failure):
    from dashboard.sensors import apple_silicon as apple

    sampler = apple.SocSampler.__new__(apple.SocSampler)
    released = []
    delta_inputs = []

    def delta(previous, current, _):
        assert previous and current, "NULL sample passed to native delta API"
        delta_inputs.append((previous, current))
        return None if failure == "delta" and len(delta_inputs) == 1 else "delta"

    def channels(ref, _):
        assert ref, "NULL delta passed to CoreFoundation"
        return None

    sampler._fw = SimpleNamespace(
        ior=SimpleNamespace(
            IOReportCreateSamples=Mock(side_effect=[None if failure == "sample" else "new", "recovered"]),
            IOReportCreateSamplesDelta=delta,
        ),
        cf=SimpleNamespace(CFRelease=released.append, CFDictionaryGetValue=channels),
        cfstr=lambda s: s,
    )
    sampler._subscription, sampler._channels = "subscription", "channels"
    sampler._last, sampler._last_t = "old", 10.0
    sampler._thermal = []
    monkeypatch.setattr(apple.time, "monotonic", Mock(side_effect=[12.0, 15.0]))

    with pytest.raises(OSError):
        sampler.sample()
    reading = sampler.sample()
    if failure == "sample":
        assert delta_inputs == [("old", "recovered")]
        assert reading.interval_s == 5.0
        assert released == ["old", "delta"]
    else:
        assert delta_inputs == [("old", "new"), ("new", "recovered")]
        assert reading.interval_s == 3.0
        assert released == ["old", "new", "delta"]
    assert sampler._last == "recovered"


def test_die_prefixes_classify_domains_and_sum_energy_without_erasing_identity(monkeypatch):
    from dashboard.sensors import apple_silicon as apple

    channel_rows = []
    for prefix in ("", "DIE_0_", "DIE_1_"):
        for kind in ("E", "P"):
            for subgroup in ("CPU Complex Performance States", "CPU Core Performance States"):
                channel_rows.append(dict(group="CPU Stats", subgroup=subgroup, name=prefix + kind + "CPU0"))
        for name in ("CPU Energy", "GPU Energy", "ANE0", "DRAM0"):
            channel_rows.append(dict(group="Energy Model", name=prefix + name))
    sampler = apple.SocSampler.__new__(apple.SocSampler)
    sampler._fw = SimpleNamespace(
        ior=SimpleNamespace(
            IOReportCreateSamples=lambda *a: "sample",
            IOReportCreateSamplesDelta=lambda *a: "delta",
            IOReportChannelGetGroup=lambda ch: ch["group"],
            IOReportChannelGetSubGroup=lambda ch: ch["subgroup"],
            IOReportChannelGetChannelName=lambda ch: ch["name"],
            IOReportChannelGetUnitLabel=lambda ch: "mJ",
            IOReportSimpleGetIntegerValue=lambda *a: 2000,
        ),
        cf=SimpleNamespace(
            CFRelease=lambda ref: None,
            CFDictionaryGetValue=lambda *a: channel_rows,
            CFArrayGetCount=len,
            CFArrayGetValueAtIndex=lambda rows, i: rows[i],
        ),
        cfstr=lambda s: s, pystr=lambda s: s,
    )
    sampler._subscription, sampler._channels = "subscription", "channels"
    sampler._last, sampler._last_t = "old", 10.0
    sampler._thermal = []
    sampler._dvfs = {"E": [600.0], "P": [1200.0]}
    sampler._states = lambda ch: [("IDLE", 50), ("P0", 50)]
    monkeypatch.setattr(apple.time, "monotonic", lambda: 12.0)

    reading = sampler.sample()
    for domains in (reading.clusters, reading.cores):
        assert {d.name for d in domains} == {
            prefix + kind + "CPU0" for prefix in ("", "DIE_0_", "DIE_1_") for kind in ("E", "P")
        }
        for domain in domains:
            assert domain.active == 0.5
            assert domain.freq_mhz == sampler._dvfs[domain.kind][0]
    assert reading.power_w == {bucket: 3.0 for bucket in ("cpu", "gpu", "ane", "dram")}


def _inside_macos_vm() -> bool:
    """Virtualized macOS guests (GitHub's macos-latest runners) get no IOReport SoC channels or pmgr DVFS tables."""
    if sys.platform != "darwin":
        return False
    try:
        out = subprocess.run(["sysctl", "-n", "kern.hv_vmm_present"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return out.stdout.strip() == "1"


@pytest.mark.skipif(sys.platform != "darwin", reason="native macOS sensors")
@pytest.mark.skipif(platform.machine() != "arm64", reason="IOReport SoC channels exist on Apple Silicon only")
@pytest.mark.skipif(_inside_macos_vm(), reason="SoC sensors are not exposed to virtualized macOS guests")
@pytest.mark.parametrize("stage", ["subscription", "initial", "thermal", "dvfs", "sample", "delta", "event", "success"])
def test_native_faults_and_cleanup_in_isolated_process(stage):
    # A missed NULL check can kill Python, not raise. Never expose the runner
    # (or leave a core dump) when probing this private native API.
    probe = textwrap.dedent('''
        import ctypes as C
        import resource
        import sys
        import time
        from collections import Counter
        from dashboard.sensors import apple_silicon as apple

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        stage = sys.argv[1]
        fw = apple._Frameworks()
        owned = Counter()
        release = fw.cf.CFRelease
        def tracked_release(ref):
            assert ref, "CFRelease(NULL)"
            assert owned[ref] > 0, ("unowned/double release", ref)
            owned[ref] -= 1
            release(ref)
        fw.cf.CFRelease = tracked_release
        def track(lib, name):
            original = getattr(lib, name)
            def call(*args):
                ref = original(*args)
                if ref:
                    owned[ref] += 1
                return ref
            setattr(lib, name, call)
        for name in ("CFStringCreateWithCString", "CFNumberCreate", "CFDictionaryCreate",
                     "CFRetain"):
            track(fw.cf, name)
        for name in ("IOReportCopyChannelsInGroup", "IOReportCreateSamples", "IOReportCreateSamplesDelta"):
            track(fw.ior, name)
        for name in ("IOHIDEventSystemClientCreate", "IOHIDEventSystemClientCopyServices",
                     "IOHIDServiceClientCopyProperty", "IOHIDServiceClientCopyEvent",
                     "IORegistryEntryCreateCFProperty"):
            track(fw.iokit, name)
        subscribe = fw.ior.IOReportCreateSubscription
        def subscription(*args):
            ref = subscribe(*args)
            if ref:
                owned[ref] += 1
            channels = C.cast(args[2], C.POINTER(C.c_void_p))[0]
            if channels:
                owned[channels] += 1
            if stage == "subscription":
                if ref:
                    tracked_release(ref)
                return None
            return ref
        fw.ior.IOReportCreateSubscription = subscription
        def unavailable(*args):
            raise OSError("native read interrupted")
        if stage == "dvfs":
            fw.cf.CFDataGetBytePtr = unavailable
        if stage == "initial":
            fw.ior.IOReportCreateSamples = lambda *args: None
        if stage == "thermal":
            copy_property = fw.iokit.IOHIDServiceClientCopyProperty
            calls = 0
            def fail_during_thermal(*args):
                global calls
                calls += 1
                if calls == 2:
                    raise OSError("thermal setup interrupted")
                return copy_property(*args)
            fw.iokit.IOHIDServiceClientCopyProperty = fail_during_thermal
        apple._Frameworks = lambda: fw
        sampler = apple.open_sampler()
        if stage in ("initial", "subscription", "thermal", "dvfs"):
            assert sampler is None, "failed initialization must not publish a sampler"
        else:
            assert sampler is not None
            if stage in ("sample", "delta"):
                name = "IOReportCreateSamples" if stage == "sample" else "IOReportCreateSamplesDelta"
                original = getattr(fw.ior, name)
                setattr(fw.ior, name, lambda *args: None)
                try:
                    sampler.sample()
                except OSError:
                    pass
                else:
                    raise AssertionError("NULL result must raise OSError")
                setattr(fw.ior, name, original)
            if stage == "event":
                original = fw.iokit.IOHIDEventGetFloatValue
                fw.iokit.IOHIDEventGetFloatValue = unavailable
                try:
                    sampler.sample()
                except OSError:
                    pass
                else:
                    raise AssertionError("event read must fail")
                fw.iokit.IOHIDEventGetFloatValue = original
            time.sleep(0.05)
            reading = sampler.sample()
            assert reading.clusters and reading.cores and reading.power_w
            sampler.close()
            sampler.close()
            try:
                sampler.sample()
            except OSError:
                pass
            else:
                raise AssertionError("closed sampler must not enter native code")
        assert not +owned, ("native references leaked", +owned)
        print(stage, "recovered/closed without native leaks")
    ''')
    result = subprocess.run(
        [sys.executable, "-c", probe, stage],
        cwd=Path(__file__).resolve().parents[2] / "plugin", capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="native macOS sensors")
@pytest.mark.skipif(platform.machine() != "arm64", reason="IOReport SoC channels exist on Apple Silicon only")
@pytest.mark.skipif(_inside_macos_vm(), reason="SoC sensors are not exposed to virtualized macOS guests")
def test_live_sample_stays_within_the_hardware_envelope():
    sampler = open_sampler()
    assert sampler is not None
    try:
        time.sleep(0.25)
        reading = sampler.sample()

        assert reading.interval_s > 0
        assert reading.clusters and reading.cores and reading.gpu is not None
        for domain in [*reading.clusters, *reading.cores, reading.gpu]:
            assert 0.0 <= domain.active <= 1.0
            table = sampler._dvfs[domain.kind]
            if domain.freq_mhz is not None:
                assert min(table) - 1 <= domain.freq_mhz <= max(table) + 1
        assert {"cpu", "gpu"} <= reading.power_w.keys()
        assert all(w >= 0 for w in reading.power_w.values())
        assert reading.temps_c and all(0 < c < 150 for c in reading.temps_c.values())
    finally:
        sampler.close()
