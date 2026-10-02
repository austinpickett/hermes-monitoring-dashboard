---
name: compose-monitoring-dashboard
description: "Use when asked to create a dashboard or add, edit, reorder, or remove widgets. Configure one Monitoring Dashboard with safe JSON edits."
version: 4.0.0
license: MIT
---

# Compose the Monitoring Dashboard

All widgets belong inside ONE Monitoring Dashboard. Do not create another native plugin per
widget and do not edit installed plugin code. Persistent user data lives separately in
`~/monitoring-dashboard/dashboard.json` on the **desktop device**. The plugin polls that folder
about every two seconds and restores it on restart. For a remote backend, files must still be
written on the desktop device; do not claim that a remote-only file will update the local UI.

## Safe editing workflow

1. Read `~/monitoring-dashboard/dashboard.json` before modifying it. If absent, inspect the
   existing `page.html` and `panel-*.html` markers before creating a config. Never infer existing
   state only from conversation history. Read existing files before any overwrite.
2. Parse JSON. Preserve unrelated top-level settings, widget fields, IDs, and widgets. Change
   only the requested widget(s). Prefer a targeted patch; when writing the whole file, merge
   with the just-read content. If parsing fails, diagnose it rather than replacing everything.
3. Add a unique stable `id` for each new widget. Multiple widgets of the same type are allowed.
   Keep IDs when renaming or reordering. Remove only the requested ID.
4. Write valid JSON (no comments/trailing commas). Read back the changed target and verify the
   rendered dashboard if available. Invalid edits retain the last valid layout in the current
   plugin session and display an error. They are NOT automatically repaired on disk.
5. Reply briefly with what changed. Do not claim installed/live verification from a harness.

## Configuration

```json
{
  "version": 1,
  "title": "MY DASHBOARD",
  "widgets": [
    { "id": "hello", "type": "text", "title": "Hello", "text": "Hello world ☺", "accent": "green", "order": 0 },
    { "id": "clock", "type": "clock", "title": "Local time", "order": 1 },
    { "id": "uptime", "type": "uptime", "title": "Backend uptime", "order": 2 },
    { "id": "month", "type": "calendar", "width": 6, "order": 3 }
  ]
}
```

- `version: 1`, `widgets: []` creates an honest blank dashboard. A config alone makes the
  Monitoring Dashboard navigation/chip visible; `page.html` is not required. Do not erase an existing
  dashboard when asked to create one unless the user explicitly requests clearing it.
- Supported types: `text`, `clock`, `date`, `uptime`, `calendar`, `throughput`, `silicon`,
  `thermal`, `fleet` (Sessions; legacy type ID), `feed`, `memory`, `net`, `disk`, `power`.
- `text` is plain text, including emoji/smiley; never HTML, Markdown execution, or JavaScript.
- `clock`, `date`, and `calendar` use the desktop's actual local date/time. The month calendar
  highlights today, is Sunday-first, and has **no appointments or connected calendar account**.
- `uptime` means **backend host uptime**, not current time, plugin lifetime, or process uptime.
  Unavailable backend readings show `—`; never invent data.
- Optional `title` (up to 120 characters), `accent` (`default`, `green`, `yellow`, `red`, or
  explicit `#RRGGBB`), numeric `order` (ascending; array order breaks ties), and `width`
  (3, 4, 6, 8, 12 columns; narrow panes stack). Omit order on all widgets to use array order.
  When reordering a mixed list, explicitly renumber every widget's order while preserving fields.
- IDs: unique 1–64 ASCII letters/digits/underscore/hyphen. At most 64 widgets; text up to 10000
  characters; JSON up to 262144 characters. Unknown types show a readable unsupported state;
  preserve their fields rather than deleting them.
- To clear a configured dashboard on explicit request, set `widgets` to `[]`, preserving other
  settings. Demo Reset will not delete a loaded config or a config with an error.

## Legacy marker demo (still supported)

Without dashboard.json, `page.html` reveals the blank frame and each `panel-*.html` marker
unlocks its existing built-in panel. Marker contents remain one-line HTML comments; they are
not executed. Preserve this mode for an existing marker-only demo unless customization needs
JSON. Use `write_file` one marker at a time for the staged reveal; read existing targets first.

Order: `panel-throughput.html`, `panel-silicon.html`, `panel-thermal.html`, `panel-fleet.html` (**Sessions**, legacy filename),
`panel-wire.html` (**Feed**, legacy filename), `panel-memory.html`, `panel-net.html`,
`panel-disk.html`, `panel-power.html`. A complete legacy dashboard also needs `page.html`.

To customize a marker-only dashboard, first migrate every existing panel marker into a widget
with the corresponding type (`panel-wire.html` → `feed`), then apply the requested edit. Keep
marker files untouched. A valid JSON config takes precedence; removing JSON returns to the
markers. To preserve the classic layout order during migration use silicon, thermal, fleet,
throughput, feed, power, memory, net, disk; widths 8,4,4,4,4,3,3,3,3 respectively.

## Boundaries

This is declarative configuration, not arbitrary code execution. No `eval`, custom JavaScript,
HTML injection, arbitrary backend fetch, Gmail, account connections, or permission prompts are
implemented. Explain unsupported requests honestly. Future trusted widget renderers can extend
the type registry inside this same dashboard without another plugin per widget.
