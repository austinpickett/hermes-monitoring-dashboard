# Monitoring Dashboard

![Blue cyanotype-style monitoring instrument with a circular grid and pointer](assets/hermes-cyanotype.jpg)

A Hermes plugin with a Python hardware sampler and a desktop monitoring page: CPU/GPU, thermal and
power readings, memory and I/O, live sessions and token throughput, plus prompt-configurable widgets.

The installable package is [`plugin/`](plugin/) — requirements, install steps, widget configuration
and safety notes are in [`plugin/README.md`](plugin/README.md). Everything else in this repository
(`harness/`, `scripts/`, `tests/`, `vendor/`, `examples/`) is development tooling and is not installed.

```sh
hermes plugins install austinpickett/hermes-monitoring-dashboard#plugin --enable
```

## Develop

Work in a separate checkout/worktree. Stage into an **explicit development home**, not your live home:

```sh
HERMES_HOME=/absolute/path/to/dev-home node scripts/sync-plugin.mjs
HERMES_HOME=/absolute/path/to/dev-home hermes plugins enable hermes-monitoring-dashboard
```

The sync script copies `plugin/`, refuses to overwrite installs owned elsewhere, and does not
change configuration or touch a legacy standalone desktop installation. Restart that home's backend
and rescan desktop plugins after staging Python changes.

The browser harness renders `plugin/desktop/plugin.js` with the plugin's own backend sampler, without
Electron or the core metrics branch. Use Python with FastAPI, uvicorn and psutil installed (a Hermes
test environment works):

```sh
HERMES_AGENT_DIR=/path/to/hermes-agent scripts/build-vendor.sh
python harness/server.py
open "http://127.0.0.1:5188/harness/"
```

`HERMES_AGENT_DIR` is only needed to borrow React/esbuild for the browser harness. The installed
plugin uses the desktop app's React. `?sim` enables the labelled synthetic fleet.

Preview configured widgets with `/harness/?widgets`, an empty config with `?widgets=empty`,
and an invalid config with `?widgets=invalid`. The default URL still exercises legacy markers.
These are explicit UI fixtures; hardware remains real unless `?fixture=...` is requested.
`window.harness.setConfig(objectOrText)` changes the in-memory file seam for live polling checks;
`setConfig(null)` restores marker mode. No live user config is touched.
Focused checks: `node --test tests/ui/widgets.mjs tests/ui/metrics.mjs`.

`scripts/cdp.mjs` takes screenshots or evaluates JS over CDP:
`CDP_PORT=9333 node scripts/cdp.mjs shot out.png`, or `node scripts/cdp.mjs eval "<js>"`.
