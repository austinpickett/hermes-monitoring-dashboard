# Monitoring API

Hermes discovers `manifest.json` and imports `plugin_api.py` as
`hermes_dashboard_plugin_hermes-monitoring-dashboard`, then mounts its `router`
at `/api/plugins/hermes-monitoring-dashboard`. The desktop calls `GET /metrics`
inside that plugin namespace. The response retains the former `system.metrics`
frame shape, including `available`; it does not call that RPC.

The real loader uses `spec_from_file_location` without package search locations.
The API entry sets its own `__package__`, `__path__`, and spec search locations
before relative imports. Its sibling modules therefore resolve in its unique
plugin namespace, without changing `sys.path`. A standalone harness can instead
import `dashboard.plugin_api` normally. Use just one import style within a process
so all pollers share the same sampler and one-second cache.

The `/metrics` handler is deliberately synchronous: FastAPI dispatches blocking
psutil/native reads to its thread pool. A lock owns initialization, sampling, rate
baselines and cache across workers. Router lifespan shutdown closes the sampler
in the thread pool and clears its cache. Mount the router before app startup and
run the app's lifespan (for example `with TestClient(app)`) for cleanup. Importing
or registering this plugin does not open native resources.

Runtime requirements: Python 3.10+, psutil 5.9+, FastAPI 0.112.2+ (router lifespan
merging). `python_dependencies` declares these Python packages for Hermes; it is
not an instruction to install packages at request time. Optional native sensor
failures leave other sections available. A missing base sampler dependency yields
`{"available": false}`. Unavailable sensor values stay null or empty rather than
becoming synthetic readings.

`system_metrics.py` and `sensors/{apple_silicon,nvidia}.py` were ported from
NousResearch/hermes-agent commit `f4a90db6` (the fixed [PR #124113](https://github.com/NousResearch/hermes-agent/pull/124113) source); see `NOTICE` for attribution and license.
Native sensor implementations are preserved unchanged; sampler imports now point
to plugin-local sensors and stdlib host labels. No `agent.system_metrics`,
`hermes_platform.sensors`, gateway internals, or PR-specific core modules are
required.

The hidden `index.js` is intentionally empty: this package's visual surface is
`desktop/plugin.js`, not a web dashboard tab. API authentication, plugin enablement
and route access checks remain owned by Hermes. Install as an enabled user plugin;
project-local plugins are not permitted to auto-import backend Python.
