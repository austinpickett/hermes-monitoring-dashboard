"""Explicit synthetic edge cases, never substituted for live telemetry."""


def metrics_fixture(name):
    if name == "partial":
        return {"available": True, "interval_s": 1, "memory": {"total": 17179869184}}
    if name not in {"null", "ultra"}:
        return None
    frame = {
        "available": True,
        "interval_s": 1,
        "host": {"cpu_model": "FIXTURE Apple Ultra", "arch": "arm64", "uptime_s": 3600},
        "cpu": {"percent": 12, "count_logical": 8, "cores": [], "clusters": []},
        "memory": None,
        "process": None,
        "gpus": [{"name": "fixture GPU", "cores": 16, "active": None}],
        "power_w": {"cpu": None, "gpu": None, "ane": None, "dram": None},
        "net": {"rx_bps": None, "tx_bps": None},
        "disk": {"read_bps": None, "write_bps": None, "volumes": None},
        "temps": [{"name": "unavailable", "celsius": None}],
    }
    if name == "ultra":
        for die in range(2):
            for kind in ["E", "P"]:
                frame["cpu"]["clusters"].append({
                    "name": f"DIE_{die}_{kind}CPU", "kind": kind,
                    "active": .25, "freq_mhz": 1800,
                })
                for core in range(2):
                    frame["cpu"]["cores"].append({
                        "name": f"DIE_{die}_{kind}CPU0{core}0", "kind": kind,
                        "active": .25, "freq_mhz": 1800,
                    })
    return frame
