#!/usr/bin/env node
// Sync the working-tree plugin into a Hermes home's desktop-plugins door, the same shape a
// store install produces (a real folder, not a link). Files are overwritten IN PLACE so the
// desktop's per-file watch fires and plugin.js hot-reloads; stale files are removed.
//
//   HERMES_HOME=/path/to/home node scripts/sync-plugin.mjs
//
// The shipped skill reaches the model through `skills.external_dirs` pointed at
// `desktop-plugins/hermes-telemetry/skills` (relative to HERMES_HOME) — see DEMO.md.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const dst = join(home, 'desktop-plugins', 'hermes-telemetry')

const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

mkdirSync(dst, { recursive: true })
const wanted = new Set(walk(src).map(p => relative(src, p)))
for (const rel of wanted) {
  mkdirSync(dirname(join(dst, rel)), { recursive: true })
  cpSync(join(src, rel), join(dst, rel))
}
if (existsSync(dst)) {
  for (const p of walk(dst)) {
    const rel = relative(dst, p)
    if (!wanted.has(rel) && !rel.startsWith('.hermes-package')) rmSync(p)
  }
}
console.log(`synced ${wanted.size} files -> ${dst}`)
