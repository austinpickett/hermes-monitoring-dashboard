"""Local visual harness using the plugin's own backend (no core sampler).

Run with Python that has FastAPI, uvicorn and psutil installed:
    python harness/server.py
Real hardware is the default; ?fixture=null|partial|ultra opts into test data.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from fixtures import metrics_fixture

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "dashboard"
# Match the plugin loader's package-style import so .metrics/.sensors imports
# resolve inside this package, never from a hermes-agent source checkout.
spec = importlib.util.spec_from_file_location(
    "monitoring_harness_backend",
    API_DIR / "plugin_api.py",
    submodule_search_locations=[str(API_DIR)],
)
assert spec is not None and spec.loader is not None
backend = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backend
spec.loader.exec_module(backend)

app = FastAPI()
PREFIX = "/api/plugins/hermes-monitoring-dashboard"


@app.middleware("http")
async def explicit_fixture(request: Request, call_next):
    scenario = request.query_params.get("fixture")
    if request.url.path == f"{PREFIX}/metrics" and scenario:
        from fastapi.responses import JSONResponse

        data = metrics_fixture(scenario)
        if data is None:
            return JSONResponse({"error": "unknown fixture"}, status_code=400)
        return JSONResponse(data)
    return await call_next(request)


app.include_router(backend.router, prefix=PREFIX)


@app.post("/rpc")
async def rpc(request: Request):
    body = await request.json()
    method = body.get("method")
    if method == "session.active_list":
        return {"result": {"sessions": []}}
    if method == "subagent.list":
        return {"result": {"subagents": [], "delegations": []}}
    # Deliberately reject system.metrics: the harness must catch regressions
    # back to a core RPC rather than silently satisfying them.
    return {"error": f"unknown method: {method}"}


app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="files")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5188"))
    print(f"harness on http://127.0.0.1:{port}/harness/", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port)
