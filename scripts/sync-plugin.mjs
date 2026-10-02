#!/usr/bin/env node
// Stage the plugin/ package into an explicitly selected development home. Enable through Hermes;
// never overwrite the renderer's published package copy or a legacy standalone install.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const home = process.env.HERMES_HOME
if (!home) throw new Error('Set HERMES_HOME to an explicit development home before syncing.')
const id = 'hermes-monitoring-dashboard'
const dst = join(resolve(home), 'plugins', id)
const receipt = join(dst, '.monitoring-dev-source')
if (existsSync(dst)) {
  if (lstatSync(dst).isSymbolicLink() || !existsSync(receipt) || readFileSync(receipt, 'utf8').trim() !== realpathSync(src)) {
    throw new Error(`Refusing to overwrite an install not owned by this checkout: ${dst}`)
  }
}
mkdirSync(dst, { recursive: true })
for (const name of ['plugin.yaml', '__init__.py', 'dashboard', 'desktop', 'skills']) {
  cpSync(join(src, name), join(dst, name), {
    recursive: true,
    filter: path => !path.split(/[\\/]/).some(part => part === '__pycache__' || part.endsWith('.pyc'))
  })
}
writeFileSync(receipt, `${realpathSync(src)}\n`)
console.log(`Staged unified package -> ${dst}`)
console.log(`Run Hermes with this home, enable ${id}, restart the backend, then rescan desktop plugins.`)
const legacy = join(resolve(home), 'desktop-plugins', id)
if (existsSync(legacy) && !existsSync(join(legacy, '.hermes-package.json'))) {
  console.warn(`Legacy standalone desktop install left untouched: ${legacy}\nMove it aside before Rescan so Hermes can publish the unified desktop half.`)
}
