"""Mounted by Hermes at /api/plugins/hermes-monitoring-dashboard.

The dashboard loader executes this file under a unique top-level module name.
Make that module a package so sibling imports remain local to this plugin,
without adding directories to sys.path or relying on Hermes core metrics.
"""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter
from starlette.concurrency import run_in_threadpool

if not __package__:
    __package__ = __name__
    __path__ = [str(Path(__file__).resolve().parent)]
    if __spec__ is not None:
        __spec__.submodule_search_locations = __path__

from . import system_metrics


@asynccontextmanager
async def lifespan(app):
    try:
        yield
    finally:
        await run_in_threadpool(system_metrics.reset)


router = APIRouter(lifespan=lifespan)


@router.get("/metrics")
def metrics() -> dict:
    """Sync routes run in FastAPI's worker pool, never on the gateway event loop."""
    try:
        return {"available": True, **system_metrics.read_system_metrics()}
    except Exception:
        return {"available": False}
