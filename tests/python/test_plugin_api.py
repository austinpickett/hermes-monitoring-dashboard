"""The real dashboard loader imports a file, not an installed Python package."""
import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2] / "plugin"


def load_api(name="hermes_dashboard_plugin_hermes-monitoring-dashboard"):
    path = ROOT / "dashboard" / "plugin_api.py"
    assert path.is_file(), "the standalone plugin must ship its API entry point"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_file_loader_serves_live_metrics_without_core_metrics():
    api = load_api()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/hermes-monitoring-dashboard")
    with TestClient(app) as client:
        response = client.get("/api/plugins/hermes-monitoring-dashboard/metrics")
        assert response.status_code == 200
        frame = response.json()
        assert frame["available"] is True
        assert frame["memory"]["total"] > 0
        assert frame["cpu"]["count_logical"] > 0
        assert frame["process"]["rss"] > 0
    assert api.system_metrics._sampler is None
    assert "agent.system_metrics" not in sys.modules
    assert "hermes_platform.sensors" not in sys.modules


def test_import_is_lazy_and_does_not_change_global_import_paths(monkeypatch):
    import ctypes

    def forbidden(*args, **kwargs):
        raise AssertionError("native libraries must not load at API import")

    monkeypatch.setattr(ctypes, "CDLL", forbidden)
    before = list(sys.path)
    api = load_api("hermes_dashboard_plugin_import_probe")
    assert api.system_metrics._sampler is None
    assert sys.path == before
    assert api.system_metrics.__name__.startswith(api.__name__ + ".")


def test_route_runs_native_sampling_off_loop_and_disposes_once(monkeypatch):
    import asyncio
    import threading
    from types import SimpleNamespace

    api = load_api("hermes_dashboard_plugin_thread_probe")
    calls = []
    closed = []

    def sample():
        # Raises if the sync sampler accidentally runs on an asyncio loop.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise AssertionError("sampling blocked the ASGI event loop")
        calls.append(threading.get_ident())
        return {"ts": 123.0}

    monkeypatch.setattr(api.system_metrics, "_Sampler", lambda: SimpleNamespace(
        read=sample, close=lambda: closed.append(True)))
    app = FastAPI()
    app.include_router(api.router)

    @app.get("/loop-thread")
    async def loop_thread():
        return threading.get_ident()

    with TestClient(app) as client:
        loop_id = client.get("/loop-thread").json()
        first = client.get("/metrics").json()
        assert first == {"available": True, "ts": 123.0}
        assert client.get("/metrics").json() == first
        assert len(calls) == 1
        assert calls[0] != loop_id
        assert not closed
    api.system_metrics.reset()
    assert closed == [True]
    assert api.system_metrics._cache is None


def test_unavailable_sampler_is_reported_without_breaking_api(monkeypatch):
    api = load_api("hermes_dashboard_plugin_failure_probe")

    def unavailable():
        raise ImportError("psutil not installed")

    monkeypatch.setattr(api.system_metrics, "_Sampler", unavailable)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        response = client.get("/metrics")
        assert response.status_code == 200
        assert response.json() == {"available": False}
        assert api.system_metrics._sampler is None
