"""Host labels describe the real runner; OS branches are never impersonated."""
import platform
import sys

from dashboard import host_facts


def test_host_facts_describe_the_current_host():
    assert host_facts.os_family() == sys.platform
    assert host_facts.native_arch()
    assert isinstance(host_facts.cpu_model(), str)
    if platform.machine().lower() in ("arm64", "aarch64"):
        assert host_facts.native_arch() == "arm64"


def test_sysctl_failure_does_not_escape(monkeypatch):
    def unavailable(*args, **kwargs):
        raise OSError("sysctl unavailable")

    monkeypatch.setattr(host_facts.subprocess, "run", unavailable)
    assert host_facts._sysctl("machdep.cpu.brand_string") == ""
