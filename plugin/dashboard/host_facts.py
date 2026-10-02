"""Small stdlib host labels; no dependency on Hermes' private modules."""
from functools import cache
import os
import platform
from pathlib import Path
import subprocess
import sys


def os_family() -> str:
    return sys.platform


def _sysctl(key: str) -> str:
    try:
        result = subprocess.run(["/usr/sbin/sysctl", "-n", key], capture_output=True,
                                text=True, timeout=2, check=False)
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


@cache
def native_arch() -> str:
    arch = platform.machine().lower()
    if sys.platform == "darwin" and _sysctl("hw.optional.arm64") == "1":
        return "arm64"  # includes Python running through Rosetta
    if sys.platform == "win32":
        arch = (os.environ.get("PROCESSOR_ARCHITEW6432") or arch).lower()
    return {"aarch64": "arm64", "amd64": "x86_64", "i386": "x86", "i686": "x86"}.get(arch, arch)


@cache
def cpu_model() -> str:
    if sys.platform == "darwin":
        return _sysctl("machdep.cpu.brand_string") or platform.processor()
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                key, sep, value = line.partition(":")
                if sep and key.strip() in ("model name", "Hardware"):
                    return value.strip()
        except OSError:
            pass
    return platform.processor()
