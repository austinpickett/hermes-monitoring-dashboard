# hermes-telemetry

A Hermes desktop plugin: a realtime telemetry page for the machine and the agent fleet. It opens from
the sidebar (**Telemetry**) and adds a statusbar chip showing tok/s and SoC °C.

- **Silicon:** a die map of CPU clusters and cores, the GPU array, ANE and DRAM, heat-mapped from
  idle to hot.
- **Thermal, power, memory, net and disk IO.**
- **Fleet:** a radar of live sessions and subagents, a tok/s stream, and gateway events.

Data is real or null; unreadable sensors show `—`. **SIM** is an explicitly labelled synthetic fleet
for demos, and it never fakes hardware.

## Requirements

Hardware panels read the `system.metrics` gateway RPC. That RPC comes from the hermes-agent branch
`austin/feat/system-metrics` until it lands. Without it the page shows "no hardware link", and the
fleet and token panels still work. The Apple Silicon sensors (IOReport + HID, no sudo) are verified
on an M1 Max.

## Install

```sh
ln -s "$PWD/plugin" ~/.hermes/desktop-plugins/hermes-telemetry
```

Reload the desktop app (⌘R).

## Develop

The browser harness renders `plugin/plugin.js` against real `read_system_metrics()` frames, with no
Electron:

```sh
scripts/build-vendor.sh    # React bundle for the harness, from a hermes-agent checkout
HERMES_AGENT_DIR=~/projects/nous/hermes-agent-system-metrics \
  ~/projects/nous/hermes-agent-system-metrics/.venv/bin/python harness/server.py
open "http://127.0.0.1:5188/harness/?sim"
```

`scripts/cdp.mjs` takes screenshots or evaluates JS over CDP:
`CDP_PORT=9333 node scripts/cdp.mjs shot out.png`, or `node scripts/cdp.mjs eval "<js>"`.
