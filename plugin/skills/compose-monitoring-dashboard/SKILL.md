---
name: compose-monitoring-dashboard
description: "Use when asked to create a blank dashboard page, add a widget or panel to the dashboard, or build a complete dashboard. Composes the Monitoring dashboard live with write_file."
version: 3.0.0
license: MIT
---

# Compose the monitoring dashboard

The Monitoring dashboard plugin ships **installed but invisible**. It comes into existence
on stage, live, one command at a time: every `write_file` call you make against its asset
files makes the matching piece appear on screen the moment the call starts. The parts are
all there already — you are only putting them in place.

"Dashboard", "widget" and "panel" in a request always mean THIS dashboard. Act immediately:
do not ask which dashboard or what kind of widget, do not list directories, do not read
files first. The only tool you need is `write_file`.

## Where the files go

Always write to the absolute directory `~/monitoring-dashboard/` (the file tool expands `~`
and creates the directory). Never use a workspace-relative path.

## The commands (in demo order)

**1. "Create a blank dashboard page"** → one `write_file` call:

- `~/monitoring-dashboard/page.html` — the reveal: the Monitoring entry appears in the
  sidebar, the status chip lands in the status bar, and the blank dashboard opens beside
  the chat. It stays an empty frame until widgets arrive.

Any request to create/make/build "a dashboard" or "a dashboard page" that does NOT say
"complete", "full" or "entire" is this command: write `page.html` only, no panels.

**2. "Add a widget" / "add another widget" / "add a panel"** → exactly ONE `write_file`
call, for the next widget in this order that you have not written since the last "create a
blank dashboard page" in this conversation. One file = one widget on screen:

1. `~/monitoring-dashboard/panel-throughput.html` — tok/s stream (plus cpu/gpu history).
2. `~/monitoring-dashboard/panel-silicon.html` — die map: CPU cores, GPU array, rails.
3. `~/monitoring-dashboard/panel-thermal.html` — thermal sensors.
4. `~/monitoring-dashboard/panel-fleet.html` — fleet radar (live agents).
5. `~/monitoring-dashboard/panel-wire.html` — gateway event wire (live tool calls).
6. `~/monitoring-dashboard/panel-memory.html` — RAM/swap/disk meters.
7. `~/monitoring-dashboard/panel-net.html` — network rx/tx.
8. `~/monitoring-dashboard/panel-disk.html` — disk IO.
9. `~/monitoring-dashboard/panel-power.html` — power draw and per-rail watts.

If the user names a specific widget ("add the power widget"), write that one instead.

**3. "Create a complete dashboard"** (or "full" / "entire") → write ALL nine panel files
above, in order, one `write_file` call each, all in this same turn. Do not stop, pause or
reply between files, and do not end the turn until `panel-power.html` is written — the
user sees the dashboard fill in as you go. Do not skip any and do not check what exists —
rewriting a file that is already in place is harmless and keeps the dashboard in sync. If
`page.html` has not been written in this conversation yet, write it first.

## Rules

- File contents do not matter — only the paths do. Each file is a single one-line HTML
  comment naming the widget, e.g. `<!-- monitoring widget: power -->`.
- One file per `write_file` call; never batch.
- Reply with one short sentence naming what appeared, only after the command's LAST file
  (for "complete", after `panel-power.html`). No lists, no progress notes in between.
- **Reset** is the user's job: ⌘K → "Reset Monitoring Dashboard" (or the Reset button in
  the page header) removes the files and hides the dashboard for the next take.

Never fake sensor values: unreadable hardware shows `—` by design. Do not edit the plugin
source; only the asset files above drive the build.
