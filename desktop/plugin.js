// Hermes Personal Dashboard — realtime host + fleet instrument panel.
// Hardware comes from this plugin's scoped REST backend; fleet/tokens from gateway events and
// session RPCs. Nothing here is invented: a sensor the host can't read renders as "—", and the
// SIM switch (clearly badged) is the only source of synthetic data.
import {
  Button,
  GlyphSpinner,
  host,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-monitoring-dashboard'
const ROUTE = '/monitoring'
const HISTORY = 150 // samples kept per trace (~2.5 min at 1 Hz)

// ── store ──────────────────────────────────────────────────────────────────────────────────────

const ring = () => []
const push = (arr, v) => {
  arr.push(v)
  if (arr.length > HISTORY) arr.shift()
}

const S = {
  version: 0,
  link: 'pending', // pending | ok | missing | error
  frame: null,
  hist: { cpu: ring(), gpu: ring(), tok: ring(), watts: ring(), rx: ring(), tx: ring(), rd: ring(), wr: ring(), die: ring() },
  sessions: [],
  subagents: {}, // session id -> SubagentSnapshot[]
  activity: {}, // session id -> last event ms
  streaming: {}, // session id -> last delta ms
  usage: null, // latest Usage payload
  log: [], // {t, sid, kind, text, sim}
  toolStarts: {}, // tool_id -> {t, name}
  tokBucket: 0,
  tokRate: 0,
  toolsPerMin: [], // timestamps
  sim: false,
  simSessions: [],
  // Build flow: the page opens as an empty frame; Hermes composes it panel-by-panel with
  // file tools, guided by the plugin's shipped skill. A step goes 'building' the moment its
  // tool call starts and 'built' when it completes. Reset returns to the empty frame.
  config: null, // last valid declarative config; null selects legacy markers
  configError: null,
  built: [], // ordered ids of built steps
  building: null, // id of the step whose tool call is running
  builtAt: 0,
  buildDir: null // absolute dir the model writes into, learned from tool.complete
}

// Build steps in presentation order — one file = one visual widget on screen. Each names
// the file the skill tells the model to write and which top-level KPIs unlock with it.
// The dashboard reacts to each tool call as it starts — "the parts are all there already".
const BUILD_STEPS = [
  { id: 'throughput', file: 'panel-throughput.html', unlocks: ['tok'] },
  { id: 'silicon', file: 'panel-silicon.html', unlocks: ['cpu', 'gpu', 'die'] },
  { id: 'thermal', file: 'panel-thermal.html', unlocks: [] },
  { id: 'fleet', file: 'panel-fleet.html', unlocks: ['agents'] },
  { id: 'wire', file: 'panel-wire.html', unlocks: ['tools'] },
  { id: 'memory', file: 'panel-memory.html', unlocks: ['mem'] },
  { id: 'net', file: 'panel-net.html', unlocks: [] },
  { id: 'disk', file: 'panel-disk.html', unlocks: [] },
  { id: 'power', file: 'panel-power.html', unlocks: ['soc'] }
]
// The chrome step: the demo's first beat is "create a blank dashboard page" — that write
// brings the plugin into existence (sidebar row + statusbar chip). Registering UI is live
// (contrib registry), so the plugin can contribute its chrome the moment that write lands.
const CHROME_STEP = { id: 'chrome', file: 'page.html' }
const ALL_STEPS = [CHROME_STEP, ...BUILD_STEPS]
const BUILD_DIR_HINT = 'monitoring-dashboard'
// Reset trashes files in the build dir, so only a folder named exactly monitoring-dashboard qualifies.
const isBuildDir = dir => typeof dir === 'string' && /(^|[\\/])monitoring-dashboard$/.test(dir)
const DISK_SYNC_MS = 2000
const stepFor = name => BUILD_STEPS.find(s => s.id === name)
const dirOf = p => String(p).replace(/[\\/][^\\/]*$/, '')
const desktopFs = () => (typeof window !== 'undefined' ? window.hermesDesktop : null)

function markStepBuilt(id) {
  if (!S.built.includes(id)) {
    S.built.push(id)
    S.builtAt = Date.now()
  }
  if (S.building === id) S.building = null
  if (id === 'chrome') registerChrome({ reveal: true })
  emit()
}

// The files on disk are the source of truth for what's built, so the dashboard survives a
// plugin reload or app restart mid-demo. Tool events still drive the instant reveal; this
// reconciles. The build dir is learned from the model's own write (tool.complete carries the
// resolved path), so nothing about the machine is hardcoded.
let diskSyncInFlight = false
let diskGeneration = 0

async function syncBuildFromDisk() {
  const fs = desktopFs()
  if (!S.buildDir || !fs?.readDir || diskSyncInFlight) return
  diskSyncInFlight = true
  const ctx = _ctx
  const dir = S.buildDir
  const generation = diskGeneration
  const current = () => ctx === _ctx && dir === S.buildDir && generation === diskGeneration
  try {
    const r = await fs.readDir(dir)
    if (!current()) return
    if (r?.error && r.error !== 'ENOENT') throw new Error(r.error)
    const names = (r?.entries ?? []).filter(e => !e.isDirectory).map(e => e.name)
    if (names.includes(CONFIG_FILE)) {
      try {
        if (!fs.readFileText) throw new Error('This desktop cannot read dashboard.json; update Hermes.')
        const text = await fs.readFileText(`${dir}/${CONFIG_FILE}`)
        if (!current()) return
        if (text?.truncated || text?.binary) throw new Error('Configuration must be complete, non-binary JSON text')
        S.config = parseDashboardConfig(typeof text === 'string' ? text : text?.text)
        S.configError = null
      } catch (err) {
        if (!current()) return
        S.configError = `dashboard.json: ${err?.message ?? err}. ${S.config ? 'Showing the last valid configuration.' : 'Showing legacy panels until the configuration is fixed.'}`
      }
    } else {
      S.config = null
      S.configError = null
    }
    S.built = ALL_STEPS.filter(s => names.includes(s.file)).map(s => s.id)
    if (S.config || S.configError || S.built.includes('chrome')) registerChrome({ reveal: false })
    else unregisterChrome()
    emit()
  } catch (err) {
    if (!current()) return
    // A failed listing is not evidence that files were deleted.
    S.configError = `Cannot read dashboard folder: ${err?.message ?? err}. Keeping the last dashboard.`
    emit()
  } finally {
    diskSyncInFlight = false
  }
}

async function resetBuild() {
  if (diskSyncInFlight) return
  await syncBuildFromDisk()
  // A config is user data, not a disposable demo. Never trash it via demo Reset.
  if (S.config || S.configError) {
    host.notify({ kind: 'info', message: 'To clear configured widgets, edit dashboard.json to set widgets to []. Your files have not been removed.' })
    return
  }
  diskGeneration++
  const fs = desktopFs()
  if (S.buildDir && fs?.trashPath) {
    // Only the marker files the last listing found, never the folder itself or anything else in it.
    for (const step of ALL_STEPS.filter(s => S.built.includes(s.id))) {
      try {
        await fs.trashPath(`${S.buildDir}/${step.file}`)
      } catch (err) {
        host.notify({ kind: 'error', message: `Personal Dashboard reset: couldn't remove ${S.buildDir}/${step.file} (${err?.message ?? err})` })
        return
      }
    }
  }
  S.built = []
  S.building = null
  unregisterChrome()
  closeWorkspace()
  emit()
}

// A tool call counts for a step when it writes/patches the step's asset under the build dir.
function buildStepFromTool(name, args) {
  if (name !== 'write_file' && name !== 'patch') return null
  const path = String(args?.path ?? '')
  if (!path.includes(BUILD_DIR_HINT)) return null
  const file = path.split(/[\\/]/).pop() || path
  if (file === CONFIG_FILE) return { id: 'config', file: CONFIG_FILE }
  if (file === CHROME_STEP.file) return CHROME_STEP
  return BUILD_STEPS.find(s => file === s.file) || null
}

const listeners = new Set()
const emit = () => {
  S.version++
  for (const l of listeners) l()
}
const subscribe = l => (listeners.add(l), () => listeners.delete(l))
const useStore = () => useSyncExternalStore(subscribe, () => S.version)

const logLine = (kind, text, sid, sim = false) => {
  S.log.unshift({ t: Date.now(), kind, text, sid, sim })
  if (S.log.length > 160) S.log.length = 160
}

// ── feeds ──────────────────────────────────────────────────────────────────────────────────────

let consumers = 0
let pageOpen = 0
let timers = []
let lastPoll = 0
let feedGeneration = 0
let metricsInFlight = false
let fleetInFlight = false

function resetHardware() {
  feedGeneration++
  lastPoll = 0
  S.frame = null
  S.link = 'pending'
  for (const key of Object.keys(S.hist)) S.hist[key] = ring()
  S.sessions = []
  S.subagents = {}
  S.activity = {}
  S.streaming = {}
  S.usage = null
  S.log = []
  S.toolStarts = {}
  S.tokBucket = 0
  S.tokRate = 0
  S.toolsPerMin = []
  emit()
  schedule()
}

// Missing sections are independent sensor failures, not a failed host. Keep
// numeric nulls intact: unsupported counters must not look like idle hardware.
function normalizeFrame(f) {
  return {
    ...f,
    cpu: { ...f.cpu, cores: f.cpu?.cores ?? [], clusters: f.cpu?.clusters ?? [], per_core: f.cpu?.per_core ?? [] },
    gpus: f.gpus ?? [],
    power_w: f.power_w ?? {},
    net: f.net ?? {},
    disk: { ...f.disk, volumes: f.disk?.volumes ?? [] },
    temps: (f.temps ?? []).filter(t => Number.isFinite(t?.celsius)),
    die: dieStats(f.temps)
  }
}

async function pollMetrics() {
  if (!_ctx || metricsInFlight) return
  metricsInFlight = true
  const generation = feedGeneration
  const ctx = _ctx
  const current = () => ctx === _ctx && generation === feedGeneration
  lastPoll = Date.now()
  try {
    const result = await ctx.rest('/metrics', { timeoutMs: 10000 })
    if (!current()) return
    if (!result || result.available === false) throw new Error('Metrics unavailable')
    const f = normalizeFrame(result)
    S.link = 'ok'
    S.frame = f
    if (f.interval_s) {
      const h = S.hist
      push(h.cpu, f.cpu.percent ?? null)
      push(h.gpu, f.gpus[0]?.active != null ? f.gpus[0].active * 100 : null)
      push(h.watts, sumPower(f.power_w))
      push(h.rx, f.net.rx_bps ?? null)
      push(h.tx, f.net.tx_bps ?? null)
      push(h.rd, f.disk.read_bps ?? null)
      push(h.wr, f.disk.write_bps ?? null)
      push(h.die, f.die.max)
    }
  } catch (err) {
    if (!current()) return
    S.link = /404|not found/i.test(String(err?.message ?? err)) ? 'missing' : 'error'
    S.frame = null
    for (const key of Object.keys(S.hist)) if (key !== 'tok') push(S.hist[key], null)
  } finally {
    metricsInFlight = false
    // A switch invalidates the response, but must not start a second sampler
    // request until the old one settles. Disposal never restarts polling.
    if (_ctx && consumers && !current()) void pollMetrics()
  }
  if (current()) emit()
}

async function pollFleet() {
  if (!_ctx || fleetInFlight) return
  fleetInFlight = true
  const generation = feedGeneration
  const ctx = _ctx
  const current = () => ctx === _ctx && generation === feedGeneration
  try {
    const { sessions } = await host.request('session.active_list', {})
    if (!current()) return
    const busy = (sessions ?? []).filter(s => s.status !== 'idle').slice(0, 6)
    const next = {}
    await Promise.all(
      busy.map(async s => {
        try {
          next[s.id] = (await host.request('subagent.list', { session_id: s.id })).subagents ?? []
        } catch {
          next[s.id] = []
        }
      })
    )
    if (!current()) return
    S.sessions = sessions ?? []
    S.subagents = next
  } catch {
    // Gateway not up yet; the radar shows an empty scope until it is.
  } finally {
    fleetInFlight = false
    if (_ctx && pageOpen && !current()) void pollFleet()
  }
  if (current()) emit()
}

// One tick per second folds the streamed-character bucket into a smoothed tok/s estimate.
function tickTokens() {
  const est = S.tokBucket / 4 // ≈ chars per token for English/code
  S.tokBucket = 0
  S.tokRate = S.tokRate * 0.55 + est * 0.45
  if (S.tokRate < 0.05) S.tokRate = 0
  push(S.hist.tok, S.tokRate)
  const cutoff = Date.now() - 60_000
  S.toolsPerMin = S.toolsPerMin.filter(t => t > cutoff)
  if (S.sim) simTick()
  emit()
}

function schedule() {
  for (const t of timers) clearInterval(t)
  timers = []
  if (!consumers || !_ctx) return
  const fast = pageOpen > 0
  timers.push(setInterval(pollMetrics, fast ? 1000 : 3000))
  timers.push(setInterval(tickTokens, 1000))
  if (fast) timers.push(setInterval(pollFleet, 2500))
  // Rates are deltas since the previous read, so a back-to-back read (chip mounts, then the page)
  // would cover a few ms and report ~0% CPU. Only poll now if the last read is stale.
  if (Date.now() - lastPoll > 800) pollMetrics()
  if (fast) pollFleet()
}

function useFeed(isPage) {
  useEffect(() => {
    consumers++
    if (isPage) pageOpen++
    schedule()
    return () => {
      consumers--
      if (isPage) pageOpen--
      schedule()
    }
  }, [isPage])
}

function onGatewayEvent(ev) {
  if (ev.replayed) return // reconnect replays aren't fresh work; they'd spike tok/s
  const p = ev.payload ?? {}
  const sid = ev.session_id ?? ''
  const now = Date.now()
  if (sid) S.activity[sid] = now
  switch (ev.type) {
    case 'message.delta':
    case 'reasoning.delta':
    case 'thinking.delta':
      if (typeof p.text === 'string') S.tokBucket += p.text.length
      if (sid) S.streaming[sid] = now
      break
    case 'message.start':
      logLine('turn', 'turn open', sid)
      break
    case 'message.complete':
    case 'session.usage':
      if (p.usage) S.usage = p.usage
      if (ev.type === 'message.complete') logLine('turn', `turn close${p.usage?.output ? ` · ${fmtInt(p.usage.output)} out` : ''}`, sid)
      break
    case 'tool.start': {
      const name = p.name ?? 'tool'
      S.toolStarts[p.tool_id] = { t: now, name }
      S.toolsPerMin.push(now)
      logLine('tool', `${name}${p.context ? `  ${String(p.context).slice(0, 72)}` : ''}`, sid)
      const step = buildStepFromTool(name, p.args)
      if (step && !S.built.includes(step.id)) {
        S.building = step.id
        emit()
      }
      break
    }
    case 'tool.complete': {
      const st = S.toolStarts[p.tool_id]
      delete S.toolStarts[p.tool_id]
      const dur = p.duration_s ?? (st ? (now - st.t) / 1000 : null)
      logLine(p.error ? 'err' : 'done', `${p.name ?? st?.name ?? 'tool'}${dur != null ? `  ${dur.toFixed(2)}s` : ''}`, sid)
      const step = buildStepFromTool(p.name ?? st?.name, p.args)
      if (step) {
        const resolved = p.result?.resolved_path
        if (isBuildDir(dirOf(resolved))) {
          S.buildDir = dirOf(resolved)
          _ctx?.storage.set('buildDir', S.buildDir)
        }
        if (p.error || p.result?.error) {
          if (S.building === step.id) S.building = null
          emit()
        } else if (step.id === 'config') {
          S.building = null
          void syncBuildFromDisk().then(() => { if (_ctx && S.config) registerChrome({ reveal: true }) })
        } else markStepBuilt(step.id)
      }
      break
    }
    case 'error':
      logLine('err', String(p.message ?? 'error').slice(0, 80), sid)
      break
    default:
      return
  }
}

// ── SIM (explicit, badged) ───────────────────────────────────────────────────────────────────────

const SIM_GOALS = ['index repo', 'bisect flaky test', 'draft migration', 'profile hot path', 'audit deps', 'summarize thread', 'trace IPC', 'fuzz parser']
const SIM_TOOLS = ['terminal', 'read_file', 'search_files', 'patch', 'web_extract', 'browser_navigate', 'execute_code']

function simTick() {
  const now = Date.now()
  if (!S.simSessions.length) {
    S.simSessions = Array.from({ length: 7 }, (_, i) => ({
      id: `sim-${i}-${Math.random().toString(36).slice(2, 7)}`,
      title: SIM_GOALS[i],
      status: i < 3 ? 'working' : 'idle',
      last_active: now / 1000 - (i < 3 ? 0 : 20 * Math.pow(120, Math.random())), // idle ages ~20 s … 40 min
      model: 'sim',
      subs: Math.floor(Math.random() * 4)
    }))
  }
  for (const s of S.simSessions) {
    // Duty cycle like a real fleet: bursts of work, long idles (so ages spread across the rings).
    if (Math.random() < (s.status === 'idle' ? 0.012 : 0.07)) s.status = s.status === 'idle' ? 'working' : 'idle'
    if (s.status !== 'idle') {
      s.last_active = now / 1000
      S.activity[s.id] = now
      if (Math.random() < 0.7) {
        S.streaming[s.id] = now
        S.tokBucket += 40 + Math.random() * 220
      }
      if (Math.random() < 0.18) {
        const tool = SIM_TOOLS[Math.floor(Math.random() * SIM_TOOLS.length)]
        S.toolsPerMin.push(now)
        logLine(Math.random() < 0.5 ? 'tool' : 'done', `${tool}${Math.random() < 0.5 ? `  ${(Math.random() * 3).toFixed(2)}s` : ''}`, s.id, true)
      }
      if (Math.random() < 0.03) s.subs = Math.min(5, s.subs + 1)
    } else if (Math.random() < 0.05) s.subs = Math.max(0, s.subs - 1)
  }
}

function setSim(on) {
  S.sim = on
  if (!on) {
    for (const s of S.simSessions) {
      delete S.activity[s.id]
      delete S.streaming[s.id]
    }
    S.simSessions = []
    S.log = S.log.filter(l => !l.sim)
  }
  emit()
}

// ── formatting ─────────────────────────────────────────────────────────────────────────────────

const DASH = '—'
const fmtInt = n => (n == null ? DASH : Math.round(n).toLocaleString('en-US'))
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? DASH : n.toFixed(d))
const pad = (s, n) => String(s).padStart(n, ' ')
function fmtBytes(n, d = 1) {
  if (n == null) return DASH
  const u = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++
  return `${n.toFixed(i ? d : 0)}${u[i]}`
}
const fmtRate = n => (n == null ? DASH : `${fmtBytes(n)}/s`)
function fmtDur(s) {
  if (s == null) return DASH
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`
}
const POWER_KEYS = ['cpu', 'gpu', 'ane', 'dram']
const SOC_PEAK_W = 60 // heat-ramp ceiling for package power; Apple Silicon Max parts peak near here
const sumPower = p => {
  const values = POWER_KEYS.map(k => p?.[k]).filter(Number.isFinite)
  return values.length ? values.reduce((a, v) => a + v, 0) : null
}
// SoC die sensors on Apple Silicon are the PMU `tdie*` probes; elsewhere every sensor counts.
function dieStats(temps = []) {
  const valid = (temps ?? []).filter(t => Number.isFinite(t?.celsius))
  const die = valid.filter(t => /tdie/i.test(t.name))
  const pool = die.length ? die : valid
  if (!pool.length) return { max: null, avg: null }
  return { max: Math.max(...pool.map(t => t.celsius)), avg: pool.reduce((a, t) => a + t.celsius, 0) / pool.length }
}
const utc = () => new Date().toISOString().slice(11, 19)
function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

// Theme ink, resolved from the live app theme (re-read on resize and every few seconds). Tokens
// are often color-mix() expressions, which canvas fillStyle won't parse, so each one goes through
// a probe element's computed `color` to get a concrete colour.
function readInk(el) {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  el.parentElement.appendChild(probe)
  const v = (n, fallback) => {
    probe.style.color = ''
    probe.style.color = `var(${n}, ${fallback})`
    return getComputedStyle(probe).color || fallback
  }
  const ink = {
    accent: v('--ui-accent', '#4a84fe'),
    fg: v('--ui-text-primary', '#e6edf3'),
    fg2: v('--ui-text-secondary', '#bbb'),
    fg3: v('--ui-text-tertiary', '#888'),
    fg4: v('--ui-text-quaternary', '#666'),
    line: v('--ui-stroke-primary', '#444'),
    line2: v('--ui-stroke-tertiary', '#333'),
    warn: v('--ui-yellow', '#c08532'),
    hot: v('--ui-red', '#e75e78'),
    orange: v('--ui-orange', '#db704b'),
    ok: v('--ui-green', '#55a583'),
    mono: getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'
  }
  probe.remove()
  ink.heat = makeRamp(ink)
  return ink
}

// ── heat ramp ─────────────────────────────────────────────────────────────────────────────────
// Activity (0…1) → colour. Idle is the base accent dimmed and desaturated so it recedes; working
// is the plain accent; busy mixes toward the theme orange; the extreme end runs to red. Mixing is
// in OKLab so blue→orange never passes through grey mud.
const HEAT_STOPS = [0, 0.15, 0.6, 0.85, 1] // accent holds to 60%; full orange is reserved for ≥85%
let rampCtx
function toRgb(css) {
  rampCtx ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
  rampCtx.clearRect(0, 0, 1, 1)
  rampCtx.fillStyle = '#000'
  rampCtx.fillStyle = css
  rampCtx.fillRect(0, 0, 1, 1)
  return [...rampCtx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
}
const lin = c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
function toLab([r, g, b]) {
  ;[r, g, b] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function fromLab([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(c => Math.round(Math.min(255, Math.max(0, gam(c)))))
}
function makeRamp(ink) {
  const accent = toLab(toRgb(ink.accent))
  const idle = [accent[0], accent[1] * 0.35, accent[2] * 0.35] // same lightness, most chroma gone
  const orange = toLab(toRgb(ink.orange))
  const red = toLab(toRgb(ink.hot))
  const stops = [
    [idle, 0.4],
    [accent, 0.6],
    [accent, 1],
    [orange, 1],
    [orange.map((x, j) => x + (red[j] - x) * 0.45), 1] // extreme leans red but stays orange-hot
  ]
  const cache = new Map()
  return t => {
    const q = Math.round(Math.min(1, Math.max(0, t ?? 0)) * 64)
    let c = cache.get(q)
    if (c) return c
    const v = q / 64
    let i = 1
    while (i < HEAT_STOPS.length - 1 && v > HEAT_STOPS[i]) i++
    const k = (v - HEAT_STOPS[i - 1]) / (HEAT_STOPS[i] - HEAT_STOPS[i - 1])
    const [a, aa] = stops[i - 1]
    const [b, ba] = stops[i]
    const [r, g, bl] = fromLab(a.map((x, j) => x + (b[j] - x) * k))
    c = `rgba(${r}, ${g}, ${bl}, ${(aa + (ba - aa) * k).toFixed(3)})`
    cache.set(q, c)
    return c
  }
}
// DOM twin of the ramp's hot end: plain text below "busy", then accent → orange → red.
function heatCss(t) {
  if (t == null || t < 0.6) return undefined
  if (t < 0.85) return `color-mix(in oklab, var(--ui-accent), var(--ui-orange) ${Math.round(((t - 0.6) / 0.25) * 100)}%)`
  return `color-mix(in oklab, var(--ui-orange), var(--ui-red) ${Math.round(((Math.min(1, t) - 0.85) / 0.15) * 45)}%)`
}
// Temperatures onto the same ramp: ≤35 °C idle, ~70 °C working, ~87 °C orange, 100 °C red.
const tempT = c => (c == null ? null : Math.min(1, Math.max(0, (c - 35) / 65)))
const HEAT_GRADIENT =
  // Same stops as the canvas ramp, starting from the idle grey.
  'linear-gradient(to right in oklab, var(--ui-text-quaternary) 0 4%, var(--ui-accent) 20% 60%, var(--ui-orange) 85%, color-mix(in oklab, var(--ui-orange), var(--ui-red) 45%))'

function HeatKey({ lo, hi }) {
  return jsxs('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
    children: [lo, jsx('span', { style: { width: 72, height: 6, background: HEAT_GRADIENT, borderRadius: 1 } }), hi]
  })
}

// Content-box width of an element, tracked live (the page picks its layout from this).
function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// ── canvas plumbing ───────────────────────────────────────────────────────────────────────────

// Sizes the canvas to its box at device pixel ratio and calls draw(ctx, w, h, ink, t).
// animate=true runs a rAF loop (radar, scopes); otherwise redraws when `deps` change.
function useCanvas(draw, deps, animate = false) {
  const ref = useRef(null)
  const drawRef = useRef(draw)
  drawRef.current = draw
  const state = useRef({ w: 0, h: 0, ink: null, inkAt: 0 })

  const paint = t => {
    const c = ref.current
    if (!c || !state.current.w) return
    const now = performance.now()
    if (!state.current.ink || now - state.current.inkAt > 3000) {
      state.current.ink = readInk(c)
      state.current.inkAt = now
    }
    const ctx = c.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, state.current.w, state.current.h)
    drawRef.current(ctx, state.current.w, state.current.h, state.current.ink, t ?? now)
  }

  useLayoutEffect(() => {
    const c = ref.current
    const box = c?.parentElement
    if (!c || !box) return
    // Observe the wrapper, never the canvas: the canvas is absolutely positioned so its bitmap
    // size can't feed back into layout (an in-flow canvas grows itself every observer tick).
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      const dpr = window.devicePixelRatio || 1
      state.current.w = width
      state.current.h = height
      state.current.ink = null
      c.width = Math.min(4096, Math.max(1, Math.round(width * dpr)))
      c.height = Math.min(4096, Math.max(1, Math.round(height * dpr)))
      paint()
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!animate) return
    let raf = 0
    const loop = t => {
      paint(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [animate])

  useEffect(() => {
    if (!animate) paint()
  }, deps)

  return ref
}

// Every canvas renders through this: a sized in-flow box with the canvas pinned inside it.
const Canvas = ({ canvasRef }) =>
  jsx('div', {
    style: { position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
    children: jsx('canvas', { ref: canvasRef, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } })
  })

// 4×4 Bayer ordered-dither halftone: cyanotype "exposure" where light = bare paper.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16)
function halftone(ctx, x, y, w, h, density, color, step = 3) {
  if (density <= 0) return
  ctx.fillStyle = color
  const r = step * 0.42
  for (let j = 0, yy = y + step / 2; yy < y + h; j++, yy += step) {
    for (let i = 0, xx = x + step / 2; xx < x + w; i++, xx += step) {
      const th = BAYER[(j % 4) * 4 + (i % 4)]
      if (density > th) {
        ctx.beginPath()
        ctx.arc(xx, yy, r * Math.min(1, 0.55 + density * 0.6), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

function reticle(ctx, x, y, w, h, color, len = 6) {
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1]
  ]) {
    ctx.moveTo(cx + 0.5 * dx, cy + len * dy)
    ctx.lineTo(cx + 0.5 * dx, cy + 0.5 * dy)
    ctx.lineTo(cx + len * dx, cy + 0.5 * dy)
  }
  ctx.stroke()
}


// ── primitives ─────────────────────────────────────────────────────────────────────────────────

const MONO = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }
const LABEL = {
  ...MONO,
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ui-text-tertiary)'
}

function Panel({ title, meta, children, style, bodyStyle, accent, widgetId }) {
  return jsxs('section', {
    'data-widget-id': widgetId,
    style: {
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
      borderTop: '1px solid var(--ui-stroke-secondary)',
      ...style
    },
    children: [
      jsxs('header', {
        style: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 0 6px', ...LABEL },
        children: [
          jsxs('span', { style: { color: accent ?? 'var(--ui-text-secondary)', overflowWrap: 'anywhere' }, children: ['//', title] }),
          meta ? jsx('span', { style: { marginLeft: 'auto', color: 'var(--ui-text-quaternary)' }, children: meta }) : null
        ]
      }),
      (Array.isArray(children) ? jsxs : jsx)('div', { style: { position: 'relative', flex: 1, minHeight: 0, ...bodyStyle }, children })
    ]
  })
}

// Every surface SIM feeds carries this tag while SIM is on, so synthetic data can't pass as live.
const SimTag = () =>
  jsx('span', {
    style: {
      ...LABEL,
      color: 'var(--ui-yellow)',
      border: '1px solid color-mix(in srgb, var(--ui-yellow) 45%, transparent)',
      borderRadius: 2,
      padding: '0 3px',
      fontSize: 9,
      lineHeight: '10px'
    },
    children: 'SIM'
  })
const simmed = text => (S.sim ? jsxs('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [jsx(SimTag, {}), text] }) : text)

function Stat({ label, value, unit, tone, big }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
    children: [
      jsx('span', { style: { ...LABEL, height: 14, display: 'flex', alignItems: 'center' }, children: label }),
      jsxs('span', {
        style: {
          ...MONO,
          fontSize: big ? 26 : 15,
          lineHeight: 1.05,
          color: tone ?? 'var(--ui-text-primary)',
          whiteSpace: 'nowrap'
        },
        children: [value, unit ? jsx('span', { style: { fontSize: big ? 12 : 10, color: 'var(--ui-text-tertiary)', marginLeft: 3 }, children: unit }) : null]
      })
    ]
  })
}

// ── SoC floorplan ─────────────────────────────────────────────────────────────────────────────

function groupCores(cores) {
  const groups = new Map()
  for (const c of cores) {
    const match = String(c.name).match(/^(DIE_\d+_)?[EP]CPU(\d)/)
    const key = match ? `${match[1] ?? ''}${c.kind}CPU${match[2]}` : `${c.kind ?? '?'}CPU`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  return [...groups.entries()]
}

// IOReport core channel `PCPU130` = P-type, cluster 1, core 3 → "P1·3".
const coreLabel = core => {
  const name = String(core.name).replace(/^DIE_\d+_/, '')
  return /^[EP]CPU\d\d/.test(name) ? `${core.kind}${name[4]}·${name[5]}` : name
}

const BAND = 14 // solid label strip at a tile's top and bottom; dots never run under text

// One functional block on the floorplan: hairline box, label bands, halftone exposure between.
function tile(ctx, ink, x, y, w, h, { name, pct, foot, density, dots, compact }) {
  const d = density ?? 0
  ctx.strokeStyle = d >= 0.8 ? ink.heat(d) : ink.line // hot blocks outline themselves
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  const bands = name != null && h >= BAND * 2 + 8
  const fy = bands ? y + BAND : y + 1
  const fh = bands ? h - BAND * 2 : h - 2
  if (bands) {
    ctx.strokeStyle = ink.line2
    ctx.beginPath()
    ctx.moveTo(x + 1, fy + 0.5)
    ctx.lineTo(x + w - 1, fy + 0.5)
    ctx.moveTo(x + 1, fy + fh - 0.5)
    ctx.lineTo(x + w - 1, fy + fh - 0.5)
    ctx.stroke()
  }
  // Colour carries the heat; dot coverage the level, with a faint floor so idle reads as a state, not a hole.
  halftone(ctx, x + 1, fy + 1, w - 2, fh - 2, Math.max(0.06, dots ?? d), ink.heat(d), 3)
  if (!bands) return
  const room = w - 8
  const nameW = ctx.measureText(name).width
  const pt = pct == null ? null : `${fmt(pct)}%`
  const ptW = pt ? ctx.measureText(pt).width : 0
  // Narrow tiles: name keeps the top band, % takes the foot (it outranks MHz), else drop the extra.
  const pctTop = pt && !compact && nameW + ptW + 6 <= room
  if (nameW <= room) {
    ctx.fillStyle = ink.fg2
    ctx.fillText(name, x + 4, y + 3)
  }
  const fy2 = y + h - BAND + 3
  if (pt && (pctTop || ptW <= room)) {
    ctx.fillStyle = d >= 0.6 ? ink.heat(d) : ink.fg
    ctx.fillText(pt, x + w - 4 - ptW, pctTop ? y + 3 : fy2)
  }
  if (foot && (pctTop || !pt) && ctx.measureText(foot).width <= room) {
    ctx.fillStyle = ink.fg3
    ctx.fillText(foot, x + 4, fy2)
  }
}

// A header line: `left` at x, the first `rights` candidate that still fits right-aligned at x+w.
function headLine(ctx, ink, x, y, w, left, rights) {
  ctx.fillStyle = ink.fg2
  ctx.fillText(left, x, y)
  const free = w - ctx.measureText(left).width - 10
  const r = rights.find(t => ctx.measureText(t).width <= free)
  if (!r) return
  ctx.fillStyle = ink.fg3
  ctx.fillText(r, x + w - ctx.measureText(r).width, y)
}

function DieMap({ frame }) {
  const ref = useCanvas(
    (ctx, w, h, ink) => {
      if (!frame) return
      const cpu = frame.cpu
      const gpu = frame.gpus[0]
      const pad = 12
      ctx.font = `10px ${ink.mono}`
      ctx.textBaseline = 'top'
      reticle(ctx, 3, 3, w - 6, h - 6, ink.fg4, 7)

      // Fallback: no per-core SoC channels (Intel/Linux) → psutil per-core load only.
      if (!cpu.cores.length) {
        const n = cpu.per_core.length
        const cw = (w - pad * 2) / Math.max(1, n)
        cpu.per_core.forEach((pct, i) =>
          tile(ctx, ink, pad + i * cw + 2, pad, cw - 4, h - pad * 2, { name: `C${i}`, pct, density: pct / 100 })
        )
        return
      }

      const groups = groupCores(cpu.cores)
      const cpuW = Math.min(w * 0.44, 380)
      const colH = h - pad * 2
      const head = 16
      const gap = 10
      const rowH = (colH - gap * (groups.length - 1)) / groups.length
      // One layout for every core: if the narrowest tile can't hold name + %, all put % in the foot.
      const cellMin = Math.min(...groups.map(([, cs]) => (cpuW - (cs.length - 1) * 4) / cs.length))
      const compact = cellMin - 8 < ctx.measureText('P0·0').width + ctx.measureText('100%').width + 6

      groups.forEach(([key, cores], gi) => {
        const y = pad + gi * (rowH + gap)
        const cl = cpu.clusters.find(c => c.name === key || c.name === key.replace(/CPU0$/, 'CPU'))
        const local = key.replace(/^DIE_\d+_/, '')
        const die = key.match(/^DIE_(\d+)_/)
        const pctT = cl ? `${fmt(cl.active == null ? null : cl.active * 100)}%` : null
        const label = `${cores[0].kind ?? '?'}-CLUSTER ${local.slice(4) || '?'}${die ? ` · DIE ${die[1]}` : ''}`
        headLine(ctx, ink, pad, y, cpuW, label, cl ? [`${fmt(cl.freq_mhz)} MHz  ${pctT}`, pctT] : [])
        const cellW = (cpuW - (cores.length - 1) * 4) / cores.length
        cores.forEach((c, i) =>
          tile(ctx, ink, pad + i * (cellW + 4), y + head, cellW, rowH - head, {
            name: coreLabel(c),
            pct: c.active == null ? null : c.active * 100,
            foot: c.freq_mhz == null ? DASH : `${fmt(c.freq_mhz)}`,
            density: c.active,
            compact
          })
        )
      })

      // GPU core array. The SoC reports one utilisation for the whole array, so every core is
      // exposed at that level — lighting "the first N cores" would imply per-core data we lack.
      const gx = pad + cpuW + 20
      const gw = w - gx - pad
      if (gpu && gw > 80) {
        const cores = gpu.cores || 8
        const cols = cores >= 16 ? 8 : 4
        const rows = Math.ceil(cores / cols)
        const railH = Math.max(BAND * 2 + 12, Math.min(52, colH * 0.24))
        const gridH = colH - head - railH - gap
        const cw = gw / cols
        const chh = gridH / rows
        const gp = `${fmt(gpu.active == null ? null : gpu.active * 100)}%`
        headLine(ctx, ink, gx, pad, gw, `GPU ${cores}C`, [
          `${fmt(gpu.freq_mhz)} MHz  ${gp}  ${fmt(gpu.power_w, 1)} W`,
          `${gp}  ${fmt(gpu.power_w, 1)} W`,
          gp
        ])
        for (let k = 0; k < cores; k++) {
          const x = gx + (k % cols) * cw
          const y = pad + head + Math.floor(k / cols) * chh
          // One shared value across 32 cells: lighter coverage keeps the array from walling out the CPU.
          tile(ctx, ink, x + 2, y + 2, cw - 4, chh - 4, { density: gpu.active, dots: (gpu.active ?? 0) * 0.6 })
        }
        // ANE + DRAM rails, exposed by power draw against a nominal ceiling.
        const ay = pad + head + gridH + gap
        const half = (gw - 8) / 2
        ;[
          ['ANE', frame.power_w.ane, 8],
          ['DRAM', frame.power_w.dram, 6]
        ].forEach(([name, watts, ceil], i) =>
          tile(ctx, ink, gx + 2 + i * (half + 4), ay, half - 2, railH, {
            name,
            foot: watts == null ? DASH : watts < 0.005 ? '0.00 W · idle' : `${watts.toFixed(2)} W`,
            density: watts == null ? 0 : Math.min(1, watts / ceil)
          })
        )
      }
    },
    [frame]
  )
  return jsx(Canvas, { canvasRef: ref })
}

// ── oscilloscope trace ────────────────────────────────────────────────────────────────────────

function niceMax(v) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p
  return 10 * p
}

function Scope({ series, max, fmtY, tone }) {
  const ref = useCanvas(
    (ctx, w, h, ink, t) => {
      const data = series.map(s => s.data)
      const top = max ?? niceMax(Math.max(1, ...data.flat().filter(Number.isFinite)) * 1.15)
      ctx.font = `10px ${ink.mono}`
      // Graticule: 4 horizontal divisions, time ticks every 10 samples.
      ctx.strokeStyle = ink.line2
      ctx.lineWidth = 1
      ctx.setLineDash([1, 3])
      for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.strokeStyle = ink.line
      ctx.beginPath()
      ctx.moveTo(0, h - 0.5)
      ctx.lineTo(w, h - 0.5)
      const W = w - 6 // right inset so the head marker isn't clipped
      const step = W / (HISTORY - 1)
      for (let i = 0; i < HISTORY; i += 10) {
        const x = Math.round(W - i * step) + 0.5
        ctx.moveTo(x, h)
        ctx.lineTo(x, h - (i % 30 === 0 ? 5 : 2))
      }
      ctx.stroke()

      series.forEach((s, si) => {
        const d = s.data
        if (d.length < 2) return
        const color = si === 0 ? (tone?.(ink) ?? ink.accent) : ink.fg3
        const x0 = W - (d.length - 1) * step
        // Each run gets its own stroke AND fill; unknown samples leave gaps.
        let run = []
        const drawRun = () => {
          if (!run.length) return
          ctx.beginPath()
          run.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
          ctx.strokeStyle = color
          ctx.lineWidth = si === 0 ? 1.25 : 1
          if (si) ctx.setLineDash([2, 2])
          ctx.stroke()
          ctx.setLineDash([])
          if (si === 0) {
            ctx.lineTo(run[run.length - 1][0], h)
            ctx.lineTo(run[0][0], h)
            ctx.closePath()
            ctx.globalAlpha = 0.07
            ctx.fillStyle = color
            ctx.fill()
            ctx.globalAlpha = 1
          }
          run = []
        }
        d.forEach((v, i) => {
          if (!Number.isFinite(v)) return drawRun()
          run.push([x0 + i * step, h - 1 - (Math.min(v, top) / top) * (h - 4)])
        })
        drawRun()
        if (si === 0 && Number.isFinite(d[d.length - 1])) {
          // Head marker with a slow phosphor pulse, only for a known sample.
          const yv = h - 1 - (Math.min(d[d.length - 1], top) / top) * (h - 4)
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(W, yv, 2 + Math.sin(t / 300) * 0.6, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      ctx.fillStyle = ink.fg4
      ctx.textBaseline = 'top'
      ctx.fillText(fmtY(top), 2, 2)
    },
    [],
    true
  )
  return jsx(Canvas, { canvasRef: ref })
}

// ── fleet radar ───────────────────────────────────────────────────────────────────────────────

const RINGS = [
  [10, '10s'],
  [60, '1m'],
  [600, '10m'],
  [3600, '1h']
]
// Log-age range: "now" is a small inner ring (not the centre point) so live sessions spread by bearing.
const NOW_R = 0.16
const ageRadius = age => NOW_R + (1 - NOW_R) * Math.min(1, Math.log1p(Math.max(0, age) / 4) / Math.log1p(3600 / 4))

function Radar() {
  const ref = useCanvas(
    (ctx, w, h, ink, t) => {
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w, h) / 2 - 14
      const now = Date.now()
      ctx.font = `10px ${ink.mono}`
      ctx.textBaseline = 'middle'

      // Range rings + bearing ticks.
      ctx.strokeStyle = ink.line2
      ctx.lineWidth = 1
      const ringLabels = []
      for (const [s, label] of RINGS) {
        const r = ageRadius(s) * R
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = ink.fg4
        ctx.fillText(label, cx + 3, cy - r + 6)
        ringLabels.push({ x: cx + 3, y: cy - r + 6, w: ctx.measureText(label).width })
      }
      ctx.strokeStyle = ink.line
      ctx.beginPath()
      for (let a = 0; a < 360; a += 5) {
        const rad = (a * Math.PI) / 180
        const l = a % 30 === 0 ? 7 : 3
        ctx.moveTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R)
        ctx.lineTo(cx + Math.cos(rad) * (R - l), cy + Math.sin(rad) * (R - l))
      }
      ctx.moveTo(cx - R, cy)
      ctx.lineTo(cx + R, cy)
      ctx.moveTo(cx, cy - R)
      ctx.lineTo(cx, cy + R)
      ctx.globalAlpha = 0.5
      ctx.stroke()
      ctx.globalAlpha = 1

      // Contacts.
      const contacts = [
        ...S.sessions.map(s => ({ ...s, sim: false, subs: (S.subagents[s.id] ?? []).length })),
        ...S.simSessions.map(s => ({ ...s, sim: true }))
      ]

      // Sweep only while there's something to track; an empty scope stays still and says so.
      if (!contacts.length) {
        const msg = 'no live sessions'
        const mw = ctx.measureText(msg).width
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillRect(cx - mw / 2 - 3, cy + 10, mw + 6, 12)
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = ink.fg3
        ctx.textAlign = 'center'
        ctx.fillText(msg, cx, cy + 16)
        ctx.textAlign = 'left'
      }
      const sweep = ((t / 4000) % 1) * Math.PI * 2
      if (contacts.length) {
        // 4 s per revolution, with a fading wedge behind the beam.
        for (let i = 0; i < 24; i++) {
          const a0 = sweep - (i + 1) * 0.035
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.arc(cx, cy, R, a0, a0 + 0.036)
          ctx.closePath()
          ctx.globalAlpha = 0.16 * (1 - i / 24)
          ctx.fillStyle = ink.accent
          ctx.fill()
        }
        ctx.globalAlpha = 1
        ctx.strokeStyle = ink.accent
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R)
        ctx.stroke()
      }

      const labels = []
      for (const s of contacts) {
        const bearing = hash(s.id) * Math.PI * 2
        const r = ageRadius(now / 1000 - (s.last_active ?? now / 1000)) * R
        const x = cx + Math.cos(bearing) * r
        const y = cy + Math.sin(bearing) * r
        const since = (((sweep - bearing) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const glow = 0.35 + 0.65 * Math.exp(-since / 1.6)
        const live = now - (S.streaming[s.id] ?? 0) < 2500
        const busy = s.status !== 'idle'
        const color = busy ? ink.accent : ink.fg3
        ctx.globalAlpha = glow
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.beginPath()
        if (s.sim) {
          ctx.lineWidth = 1
          ctx.rect(x - 3, y - 3, 6, 6)
          ctx.stroke()
        } else {
          ctx.arc(x, y, busy ? 3.5 : 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
        if (live) {
          const k = (t % 1200) / 1200
          ctx.globalAlpha = (1 - k) * 0.8
          ctx.beginPath()
          ctx.arc(x, y, 4 + k * 12, 0, Math.PI * 2)
          ctx.stroke()
        }
        // Subagents: satellites on a tight orbit.
        for (let k = 0; k < (s.subs ?? 0); k++) {
          const a = t / 1400 + (k * Math.PI * 2) / s.subs
          ctx.globalAlpha = glow * 0.9
          ctx.beginPath()
          ctx.arc(x + Math.cos(a) * 9, y + Math.sin(a) * 9, 1.4, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
        labels.push({ text: (s.title || s.preview || s.id).slice(0, 18).toUpperCase(), x: x + 8, y, busy, alpha: Math.max(0.55, glow) })
      }

      // Own ship.
      ctx.strokeStyle = ink.fg2
      ctx.beginPath()
      ctx.moveTo(cx - 5, cy)
      ctx.lineTo(cx + 5, cy)
      ctx.moveTo(cx, cy - 5)
      ctx.lineTo(cx, cy + 5)
      ctx.stroke()

      // Labels last, top to bottom, each nudged clear of the ones already placed.
      const placed = [...ringLabels]
      for (const l of labels.sort((a, b) => a.y - b.y)) {
        const lw = ctx.measureText(l.text).width
        let y = l.y
        while (placed.some(p => l.x < p.x + p.w + 4 && p.x < l.x + lw + 4 && Math.abs(p.y - y) < 11)) y += 11
        placed.push({ x: l.x, y, w: lw })
        if (Math.abs(y - l.y) > 2) {
          ctx.strokeStyle = ink.line
          ctx.beginPath()
          ctx.moveTo(l.x - 4, l.y)
          ctx.lineTo(l.x - 2, y)
          ctx.stroke()
        }
        // Knock the scope out behind the text so rings and axes never run through a label.
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillRect(l.x - 2, y - 6, lw + 4, 12)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = l.alpha
        ctx.fillStyle = l.busy ? ink.fg : ink.fg3
        ctx.fillText(l.text, l.x, y)
      }
      ctx.globalAlpha = 1

    },
    [],
    true
  )
  return jsx(Canvas, { canvasRef: ref })
}

// ── thermal columns ───────────────────────────────────────────────────────────────────────────

function Thermals({ frame }) {
  const ref = useCanvas(
    (ctx, w, h, ink) => {
      const sensors = frame?.temps ?? []
      if (!sensors.length) return
      const lo = 20
      const hi = 105
      const n = sensors.length
      const gap = 2
      const x0 = 30
      const cw = (w - x0 - 4 - gap * (n - 1)) / n
      const baseY = h - 4
      ctx.font = `10px ${ink.mono}`
      // Scale — starts at 20°, and the ticks say so.
      ctx.fillStyle = ink.fg4
      ctx.textBaseline = 'middle'
      for (const c of [20, 40, 60, 80, 100]) {
        const y = baseY - ((c - lo) / (hi - lo)) * (baseY - 4)
        ctx.fillText(`${c}°`, 0, c > lo ? y : y - 6)
        ctx.strokeStyle = ink.line2
        ctx.setLineDash([1, 3])
        ctx.beginPath()
        ctx.moveTo(x0 - 4, Math.round(y) + 0.5)
        ctx.lineTo(w, Math.round(y) + 0.5)
        ctx.stroke()
        ctx.setLineDash([])
      }
      sensors.forEach((s, i) => {
        const x = x0 + i * (cw + gap)
        const v = Math.max(lo, Math.min(hi, s.celsius))
        const top = baseY - ((v - lo) / (hi - lo)) * (baseY - 4)
        ctx.fillStyle = ink.heat(tempT(s.celsius))
        ctx.globalAlpha = 0.9
        ctx.fillRect(x, top, cw, baseY - top)
        ctx.globalAlpha = 1
        ctx.fillStyle = ink.fg
        ctx.fillRect(x, top - 1, cw, 1)
      })
      ctx.strokeStyle = ink.line
      ctx.beginPath()
      ctx.moveTo(x0 - 4, baseY + 0.5)
      ctx.lineTo(w, baseY + 0.5)
      ctx.stroke()
    },
    [frame]
  )
  const sensors = frame?.temps ?? []
  const hottest = [...sensors].sort((a, b) => b.celsius - a.celsius).slice(0, 6)
  return jsxs('div', {
    style: { display: 'grid', gridTemplateRows: '1fr auto', height: '100%', gap: 8 },
    children: [
      jsx('div', { style: { minHeight: 0 }, children: jsx(Canvas, { canvasRef: ref }) }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 32, rowGap: 3, ...MONO, fontSize: 10.5 },
        children: hottest.map(s =>
          jsxs(
            'div',
            {
              style: { display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 },
              children: [
                jsx('span', { style: { color: 'var(--ui-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: s.name }),
                jsx('span', { style: { color: s.celsius >= 95 ? 'var(--ui-red)' : s.celsius >= 80 ? 'var(--ui-yellow)' : 'var(--ui-text-primary)' }, children: `${s.celsius.toFixed(1)}°` })
              ]
            },
            s.name
          )
        )
      })
    ]
  })
}

// ── bars ──────────────────────────────────────────────────────────────────────────────────────

function Meter({ label, used, total, detail, tone }) {
  const pct = total > 0 && Number.isFinite(used) ? Math.min(1, used / total) : 0
  return jsxs('div', {
    style: { display: 'grid', gap: 4 },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 10.5 },
        children: [
          jsx('span', { style: { color: 'var(--ui-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: label }),
          jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: detail })
        ]
      }),
      jsx('div', {
        style: {
          height: 6,
          background: `repeating-linear-gradient(90deg, var(--ui-stroke-tertiary) 0 1px, transparent 1px 4px)`,
          position: 'relative'
        },
        children: jsx('div', {
          style: {
            position: 'absolute',
            inset: 0,
            width: `${pct * 100}%`,
            // The heat ramp spans the whole track, so the fill's leading edge shows where on the range it sits.
            background: tone ?? HEAT_GRADIENT,
            backgroundSize: pct ? `${100 / pct}% 100%` : undefined,
            maskImage: 'repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 4px)'
          }
        })
      })
    ]
  })
}

// ── event log ─────────────────────────────────────────────────────────────────────────────────

const KIND = { tool: '›', done: '✓', err: '×', turn: '·', sub: '+' }

function EventLog() {
  useStore()
  const rows = S.log.slice(0, 60)
  if (!rows.length)
    return jsx('div', { style: { ...MONO, fontSize: 10.5, color: 'var(--ui-text-quaternary)' }, children: 'no activity yet' })
  return jsx('div', {
    style: {
      ...MONO,
      fontSize: 10.5,
      lineHeight: '15px',
      overflow: 'hidden',
      height: '100%',
      maskImage: 'linear-gradient(to bottom, #000 80%, transparent)' // no half-cut last row
    },
    children: rows.map((r, i) =>
      jsxs(
        'div',
        {
          style: { display: 'flex', gap: 8, whiteSpace: 'nowrap', opacity: Math.max(0.35, 1 - i * 0.025) },
          children: [
            jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: new Date(r.t).toISOString().slice(11, 19) }),
            jsx('span', { style: { color: 'var(--ui-text-tertiary)', width: 34 }, children: r.sim ? 'SIM' : (r.sid || '').slice(0, 4) || '····' }),
            jsx('span', { style: { color: r.kind === 'err' ? 'var(--ui-red)' : r.kind === 'done' ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)', width: 8 }, children: KIND[r.kind] }),
            jsx('span', { style: { color: 'var(--ui-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }, children: r.text })
          ]
        },
        `${r.t}-${i}`
      )
    )
  })
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────

function useClock() {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
}

function LinkState() {
  const map = {
    pending: ['LINK', 'var(--ui-text-tertiary)'],
    ok: ['LINK OK', 'var(--ui-green)'],
    missing: ['NO HW LINK', 'var(--ui-yellow)'],
    error: ['LINK ERR', 'var(--ui-red)']
  }
  const [label, color] = map[S.link]
  return jsxs('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, ...LABEL, color },
    children: [S.link === 'pending' ? jsx(GlyphSpinner, { ariaLabel: 'Connecting' }) : null, label]
  })
}

function Header({ f }) {
  const h = f?.host
  const cpu = f?.cpu
  const gpu = f?.gpus[0]
  const e = cpu?.cores.filter(c => c.kind === 'E').length
  const p = cpu?.cores.filter(c => c.kind === 'P').length
  const spec = h
    ? [
        h.cpu_model,
        h.arch?.toUpperCase(),
        cpu.cores.length ? `${fmtInt(cpu.count_logical)}C ${e}E+${p}P` : `${fmtInt(cpu.count_logical)}C`,
        gpu?.cores ? `${gpu.cores}C GPU` : null,
        fmtBytes(f.memory?.total, 0),
        `UP ${fmtDur(h.uptime_s)}`
      ]
        .filter(Boolean)
        .join('  ·  ')
    : ''
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', paddingBottom: 10 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 },
        children: [
          jsx('span', { style: { ...MONO, fontSize: 13, letterSpacing: '0.14em', color: 'var(--ui-text-primary)' }, children: S.config?.title ?? 'PERSONAL DASHBOARD' }),
          jsx('span', { style: { ...LABEL, color: 'var(--ui-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: spec })
        ]
      }),
      jsxs('div', {
        style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 },
        children: [
          S.sim ? simmed(jsx('span', { style: { ...LABEL, color: 'var(--ui-yellow)' }, children: 'synthetic sessions · hardware live' })) : null,
          jsx(LinkState, {}),
          jsx('span', { style: { ...MONO, fontSize: 11, color: 'var(--ui-text-secondary)' }, children: `${utc()}Z` }),
          jsx(Button, {
            size: 'xs',
            variant: S.sim ? 'secondary' : 'ghost',
            'aria-pressed': S.sim,
            onClick: () => setSim(!S.sim),
            children: S.sim ? 'SIM on' : 'SIM off'
          }),
          !S.config && !S.configError && (S.built.length || S.building)
            ? jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                title: 'Return the page to the empty frame for the next take',
                onClick: () => resetBuild(),
                children: 'Reset'
              })
            : null
        ]
      })
    ]
  })
}

// Declarative widget contract. Extend this registry with trusted renderers, never code from JSON.
const CONFIG_FILE = 'dashboard.json'
const ACCENTS = { default: 'var(--ui-accent)', green: 'var(--ui-green)', yellow: 'var(--ui-yellow)', red: 'var(--ui-red)' }
const widgetNote = text => jsx('div', { style: { ...MONO, fontSize: 11, color: 'var(--ui-text-tertiary)', lineHeight: 1.6 }, children: text })
const widgetValue = text => jsx('div', { style: { ...MONO, fontSize: 30, color: 'var(--ui-accent)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }, children: text })
const WIDGET_TYPES = new Map([
  ...BUILD_STEPS.map(s => [s.id === 'wire' ? 'feed' : s.id, { metric: s.id, title: s.id === 'wire' ? 'Feed' : s.id === 'fleet' ? 'Sessions' : s.id }]),
  ['text', { title: 'Note', render: w => w.text ? widgetValue(w.text) : widgetNote('No text yet. Ask Hermes to edit this widget.') }],
  ['clock', { title: 'Local time', render: (_w, { now }) => jsxs('div', { children: [widgetValue(now.toLocaleTimeString()), widgetNote(`${now.toLocaleDateString(undefined, { dateStyle: 'full' })} · local time`)] }) }],
  ['date', { title: 'Local date', render: (_w, { now }) => jsxs('div', { children: [widgetValue(now.toLocaleDateString(undefined, { dateStyle: 'long' })), widgetNote('Local calendar date')] }) }],
  ['uptime', { title: 'Backend uptime', render: (_w, { f }) => jsxs('div', { children: [widgetValue(fmtDur(Number.isFinite(f?.host?.uptime_s) ? f.host.uptime_s : null)), widgetNote('Backend host uptime · not local clock time'), !Number.isFinite(f?.host?.uptime_s) ? widgetNote('Uptime unavailable from the backend.') : null] }) }],
  ['calendar', { title: 'Month calendar', render: (_w, { now }) => jsx(MonthCalendar, { now }) }]
])

function parseDashboardConfig(text) {
  if (typeof text !== 'string' || text.length > 262144) throw new Error('Expected a JSON text file up to 262144 characters')
  const config = JSON.parse(text)
  if (!config || config.version !== 1 || !Array.isArray(config.widgets)) throw new Error('Expected version: 1 and a widgets array')
  if (config.widgets.length > 64) throw new Error('At most 64 widgets are supported')
  if (config.title !== undefined && (typeof config.title !== 'string' || config.title.length > 120)) throw new Error('Dashboard title must be text up to 120 characters')
  const ids = new Set()
  for (const w of config.widgets) {
    if (!w || typeof w !== 'object' || !/^[a-zA-Z0-9_-]{1,64}$/.test(w.id ?? '') || typeof w.id !== 'string' || ids.has(w.id)) throw new Error('Widgets need unique IDs (letters, digits, _ or -, up to 64 characters)')
    ids.add(w.id)
    if (typeof w.type !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(w.type)) throw new Error(`Widget ${w.id}: type must be a short identifier`)
    if (w.title !== undefined && (typeof w.title !== 'string' || w.title.length > 120)) throw new Error(`Widget ${w.id}: title must be text up to 120 characters`)
    if (w.text !== undefined && (typeof w.text !== 'string' || w.text.length > 10000)) throw new Error(`Widget ${w.id}: text must be text up to 10000 characters`)
    if (w.accent !== undefined && !(typeof w.accent === 'string' && (Object.hasOwn(ACCENTS, w.accent) || /^#[0-9a-f]{6}$/i.test(w.accent)))) throw new Error(`Widget ${w.id}: accent must be default, green, yellow, red, or #RRGGBB`)
    if (w.order !== undefined && !Number.isFinite(w.order)) throw new Error(`Widget ${w.id}: order must be a finite number`)
    if (w.width !== undefined && ![3, 4, 6, 8, 12].includes(w.width)) throw new Error(`Widget ${w.id}: width must be 3, 4, 6, 8, or 12`)
  }
  return config // retain unrelated settings/fields, including future widget types
}

function orderedWidgets(config) {
  return config.widgets.map((widget, index) => ({ widget, index }))
    .sort((a, b) => (a.widget.order ?? a.index) - (b.widget.order ?? b.index) || a.index - b.index)
    .map(item => item.widget)
}

function monthDays(now) {
  const year = now.getFullYear(), month = now.getMonth()
  const first = new Date(year, month, 1).getDay()
  const count = new Date(year, month + 1, 0).getDate()
  return Array.from({ length: Math.ceil((first + count) / 7) * 7 }, (_, i) => i >= first && i < first + count ? i - first + 1 : null)
}

function MonthCalendar({ now }) {
  return jsxs('div', { style: { ...MONO, maxWidth: 400, margin: '0 auto', width: '100%' }, children: [
    jsx('div', { style: { fontSize: 15, padding: '6px 0 12px', color: 'var(--ui-text-secondary)' }, children: now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
    jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', gap: 3, fontSize: 12 }, children: [
      ...['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => jsx('span', { style: { ...LABEL, paddingBottom: 6 }, children: day }, day)),
      ...monthDays(now).map((day, i) => jsx('span', {
        'aria-current': day === now.getDate() ? 'date' : undefined,
        style: { padding: '5px 0', color: day === now.getDate() ? 'var(--ui-accent)' : 'var(--ui-text-secondary)', background: day === now.getDate() ? 'var(--ui-control-active-background)' : undefined },
        children: day
      }, i))
    ] }),
    widgetNote('Local date · today highlighted · no connected events')
  ] })
}

function ConfiguredWidgets({ config, mode, f, model }) {
  const now = new Date()
  const metrics = metricPanels({ f, model, span: () => ({}) })
  if (!config.widgets.length) return widgetNote('No widgets yet. Ask Hermes to add text, a clock, a calendar, backend uptime, or a monitoring panel to dashboard.json.')
  return jsx('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: 'minmax(260px, auto)', gap: '16px 20px' },
    children: orderedWidgets(config).map(w => {
      const definition = WIDGET_TYPES.get(w.type)
      const metric = definition?.metric ? metrics[definition.metric]() : null
      const accent = w.accent ? (ACCENTS[w.accent] ?? w.accent) : 'var(--ui-accent)'
      return jsx(Panel, {
        ...metric?.props,
        title: w.title ?? definition?.title ?? w.type,
        meta: metric?.props.meta ?? (w.type === 'uptime' ? 'backend host' : ['clock', 'date', 'calendar'].includes(w.type) ? 'local device' : null),
        style: { gridColumn: `span ${mode === 'narrow' ? 12 : mode === 'mid' ? Math.max(6, w.width ?? 4) : w.width ?? 4}`, ...(w.accent && w.accent !== 'default' ? { '--ui-accent': accent } : {}) },
        accent: w.accent ? accent : undefined,
        widgetId: w.id,
        children: metric?.props.children ?? (definition?.render ? definition.render(w, { f, now }) : widgetNote(`Unsupported widget type “${w.type}”. Its configuration is preserved. Custom JavaScript is not enabled.`))
      }, w.id)
    })
  })
}

function metricPanels({ f, model, span }) {
  const u = S.usage
  const watts = f ? sumPower(f.power_w) : null
  const mem = f?.memory
  const vol = f?.disk.volumes[0]
  return {
    silicon: () => jsx(Panel, {
      title: S.building === 'silicon' ? 'silicon · composing…' : 'silicon',
      meta: f ? jsxs('span', { style: { display: 'inline-flex', gap: 14 }, children: [f.cpu.cores.length ? 'ioreport · dvfs · 1 hz' : 'psutil · 1 hz', jsx(HeatKey, { lo: 'idle', hi: '100%' })] }) : null,
      style: span(8, 12),
      children: jsx(DieMap, { frame: f })
    }),
    thermal: () => jsx(Panel, {
      title: 'thermal',
      meta: f ? jsxs('span', { style: { display: 'inline-flex', gap: 14 }, children: [`${f.temps.length} sensors · avg ${fmt(f.die.avg, 1)}°`, jsx(HeatKey, { lo: '35°', hi: '100°' })] }) : null,
      style: span(4, 6),
      children: jsx(Thermals, { frame: f })
    }),
    fleet: () => jsx(Panel, {
      title: 'Sessions',
      meta: simmed(`${S.sessions.length + S.simSessions.length} contacts`),
      style: span(4, 6),
      children: jsx(Radar, {})
    }),
    throughput: () => jsxs(Panel, {
      title: S.building === 'throughput' ? 'throughput · composing…' : 'throughput',
      meta: simmed(model ? String(model).toLowerCase() : null),
      style: span(4, 6),
      bodyStyle: { display: 'grid', gridTemplateRows: '1fr 1fr auto', gap: 10 },
      children: [
        jsxs('div', { style: SCOPE_BOX, children: [scopeLabel('≈tok/s stream'), jsx(Scope, { series: [{ data: S.hist.tok }], fmtY: v => fmt(v) })] }),
        jsxs('div', { style: SCOPE_BOX, children: [scopeLabel('cpu % ─  gpu % ┄'), jsx(Scope, { series: [{ data: S.hist.cpu }, { data: S.hist.gpu }], max: 100, fmtY: v => `${v}%` })] }),
        // Session usage appears once a real session reports it; SIM never fakes usage.
        u
          ? jsxs('div', {
              style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
              children: [
                jsx(Stat, { label: 'context', value: fmt(u.context_percent), unit: '%' }),
                jsx(Stat, { label: 'cache hit', value: fmt(u.cache_hit_pct), unit: '%' }),
                jsx(Stat, { label: 'avg tps', value: fmt(u.avg_tps, 1) }),
                jsx(Stat, { label: 'out tok', value: u.output != null ? fmtInt(u.output) : DASH })
              ]
            })
          : jsx('div', { style: { ...LABEL, color: 'var(--ui-text-quaternary)' }, children: 'session usage · awaiting a live turn' })
      ]
    }),
    wire: () => jsx(Panel, { title: 'feed', meta: simmed('Hermes activity'), style: span(4, 6), children: jsx(EventLog, {}) }),
    power: () => jsxs(Panel, {
      title: S.building === 'power' ? 'power · composing…' : 'power',
      meta: watts != null ? `soc ${fmt(watts, 2)}W` : null,
      style: span(3, 6),
      bodyStyle: { display: 'grid', gridTemplateRows: '1fr auto', gap: 8 },
      children: [
        jsx('div', { style: { minHeight: 0 }, children: jsx(Scope, { series: [{ data: S.hist.watts }], fmtY: v => `${v}W` }) }),
        jsx('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 },
          children: POWER_KEYS.map(k => jsx(Stat, { label: k, value: fmt(f?.power_w[k], 2), unit: 'W' }, k))
        })
      ]
    }),
    memory: () => jsxs(Panel, {
      title: S.building === 'memory' ? 'memory · composing…' : 'memory',
      meta: mem ? fmtBytes(mem.total, 0) : null,
      style: span(3, 6),
      bodyStyle: { display: 'grid', alignContent: 'start', gap: 12 },
      children: [
        jsx(Meter, { label: 'ram', used: mem?.used, total: mem?.total, detail: mem ? `${fmtBytes(mem.used)} / ${fmtBytes(mem.total, 0)}` : DASH }),
        jsx(Meter, { label: 'swap', used: mem?.swap_used, total: mem?.swap_total, detail: mem ? `${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total, 0)}` : DASH }),
        vol ? jsx(Meter, { label: `disk ${vol.mount}`, used: vol.used, total: vol.total, detail: `${fmtBytes(vol.used, 0)} / ${fmtBytes(vol.total, 0)}` }) : null,
        f
          ? jsxs('div', {
              style: { ...MONO, fontSize: 10.5, color: 'var(--ui-text-tertiary)', display: 'flex', justifyContent: 'space-between' },
              children: [
                jsx('span', { children: `hermes pid ${f.process?.pid ?? DASH}` }),
                jsx('span', { children: `${fmtBytes(f.process?.rss)} · ${fmt(f.process?.cpu_percent)}% · ${f.process?.threads ?? DASH}thr` })
              ]
            })
          : null
      ]
    }),
    net: () => jsx(Panel, {
      title: 'net',
      meta: f ? `↓${fmtRate(f.net.rx_bps)}  ↑${fmtRate(f.net.tx_bps)}` : null,
      style: span(3, 6),
      children: jsx(Scope, { series: [{ data: S.hist.rx }, { data: S.hist.tx }], fmtY: v => `${fmtBytes(v, 0)}/s` })
    }),
    disk: () => jsx(Panel, {
      title: 'disk io',
      meta: f ? `r ${fmtRate(f.disk.read_bps)}  w ${fmtRate(f.disk.write_bps)}` : null,
      style: span(3, 6),
      children: jsx(Scope, { series: [{ data: S.hist.rd }, { data: S.hist.wr }], fmtY: v => `${fmtBytes(v, 0)}/s` })
    }),
  }
}

function MonitoringPage() {
  useFeed(true)
  useStore()
  useClock()
  const model = useValue(host.state.model)
  const f = S.frame
  const hardware = S.link === 'ok' && f
  const busy = S.sessions.filter(s => s.status !== 'idle').length + S.simSessions.filter(s => s.status !== 'idle').length
  const subs = Object.values(S.subagents).reduce((a, l) => a + l.length, 0) + S.simSessions.reduce((a, s) => a + s.subs, 0)
  const watts = f ? sumPower(f.power_w) : null
  const mem = f?.memory
  const [pageRef, width] = useWidth()
  // wide fills one screen; mid pairs panels; narrow (a side pane) stacks them. Both of those scroll.
  const mode = width >= 1100 ? 'wide' : width >= 700 ? 'mid' : 'narrow'
  const span = (wide, mid) => ({ gridColumn: `span ${mode === 'wide' ? wide : mode === 'mid' ? mid : 12}` })
  // Build flow: a panel is visible once its step is built (or building — the dashboard reacts to
  // each tool call as it starts). Steps unlock their KPIs too. The chrome step (page.html) only
  // brings the plugin into existence; the frame stays empty until the first panel starts.
  const has = step => S.built.includes(step) || S.building === step
  const allPanelsBuilt = BUILD_STEPS.every(s => S.built.includes(s.id))
  const kpiOn = keys => allPanelsBuilt || keys.some(k => S.built.includes(k) || S.building === k)
  const empty = !BUILD_STEPS.some(s => S.built.includes(s.id) || S.building === s.id)

  return jsxs('div', {
    ref: pageRef,
    style: { height: '100%', overflow: 'auto', padding: '14px 18px 18px', color: 'var(--ui-text-primary)', display: 'flex', flexDirection: 'column' },
    children: [
      jsx(Header, { f }),
      S.configError ? jsx('div', { role: 'alert', style: { ...MONO, color: 'var(--ui-yellow)', fontSize: 12, padding: '8px 0 16px' }, children: S.configError }) : null,
      S.config ? jsxs('div', { children: [
        jsx('div', { style: { ...LABEL, marginBottom: 14 }, children: 'dashboard.json · ask Hermes to edit titles, colors, content, or order' }),
        jsx(ConfiguredWidgets, { config: S.config, mode, f, model })
      ] }) : empty
        ? jsx(EmptyFrame, {})
        : jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
          // KPIs, then silicon / fleet / io rows that share the viewport, scrolling only below the minimums.
          ...(mode === 'wide'
            ? { gridTemplateRows: 'auto minmax(240px, 1fr) minmax(260px, 1.1fr) minmax(150px, 0.6fr)', flex: 1, minHeight: 0 }
            : { gridTemplateRows: 'auto', gridAutoRows: 'minmax(260px, auto)' }),
          columnGap: 20,
          rowGap: 16
        },
        children: [
          // Row 1: headline numbers — each unlocks with its build step.
          jsxs('div', {
            style: { gridColumn: 'span 12', display: 'grid', gridTemplateColumns: `repeat(${mode === 'wide' ? 8 : 4}, minmax(0, 1fr))`, gap: 16, borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: 10 },
            children: [
              kpiOn(['tok']) ? jsx(Stat, { big: true, label: simmed('≈tok/s'), value: fmt(S.tokRate, S.tokRate < 10 ? 1 : 0) }) : null,
              kpiOn(['cpu']) ? jsx(Stat, { big: true, label: 'cpu', value: fmt(f?.cpu.percent), unit: '%', tone: heatCss(f && f.cpu.percent / 100) }) : null,
              kpiOn(['gpu']) ? jsx(Stat, { big: true, label: 'gpu', value: fmt(f?.gpus[0]?.active == null ? null : f.gpus[0].active * 100), unit: '%', tone: heatCss(f?.gpus[0]?.active) }) : null,
              kpiOn(['soc']) ? jsx(Stat, { big: true, label: 'soc power', value: fmt(watts, 1), unit: 'W', tone: heatCss(watts == null ? null : watts / SOC_PEAK_W) }) : null,
              kpiOn(['die']) ? jsx(Stat, { big: true, label: 'die max', value: fmt(f?.die.max, 1), unit: '°C', tone: heatCss(tempT(f?.die.max)) }) : null,
              kpiOn(['mem']) ? jsx(Stat, { big: true, label: 'mem', value: fmt(mem?.percent), unit: '%', tone: heatCss(mem && mem.percent / 100) }) : null,
              kpiOn(['agents']) ? jsx(Stat, { big: true, label: simmed('agents'), value: String(busy), unit: subs ? `+${subs} sub` : undefined }) : null,
              kpiOn(['tools']) ? jsx(Stat, { big: true, label: simmed('tools/min'), value: String(S.toolsPerMin.length) }) : null
            ]
          }, 'kpis'),

          ...['silicon', 'thermal', 'fleet', 'throughput', 'wire', 'power', 'memory', 'net', 'disk'].filter(has).map(id => {
            const panel = metricPanels({ f, model, span })[id]()
            return jsx(Panel, { ...panel.props }, id)
          })
        ]
      })
    ]
  })
}

// The pre-build page: an honest empty frame waiting for Hermes to compose it, with the
// build order the shipped skill directs and a way back once built.
function EmptyFrame() {
  return jsxs('div', {
    style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, borderTop: '1px solid var(--ui-stroke-secondary)', marginTop: 8 },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 10, alignItems: 'center' }, children: [
        jsx(GlyphSpinner, { ariaLabel: 'Composing' }),
        jsx('span', { style: { ...MONO, fontSize: 12, color: 'var(--ui-text-secondary)' }, children: 'the parts are all there already — waiting for Hermes to assemble them' })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 640 }, children:
        BUILD_STEPS.map((s, i) =>
          jsx('span', {
            style: { ...MONO, fontSize: 10.5, color: 'var(--ui-text-quaternary)', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 2, padding: '2px 8px' },
            children: `${i + 1} ${s.id === 'fleet' ? 'Sessions' : s.id === 'wire' ? 'Feed' : s.id}`
          }, s.id)
        )
      }),
      jsx('span', { style: { ...LABEL, color: 'var(--ui-text-quaternary)' }, children: 'ask Hermes to compose the monitoring dashboard · reset from ⌘K' })
    ]
  })
}

// Legend strip above the plot, so no trace ever runs through it.
const SCOPE_BOX = { display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 2, minHeight: 0 }
const scopeLabel = text => jsx('span', { style: { ...LABEL, justifySelf: 'end', color: 'var(--ui-text-quaternary)' }, children: text })

// ── statusbar chip ────────────────────────────────────────────────────────────────────────────

function Chip() {
  useFeed(false)
  useStore()
  const f = S.frame
  const temp = f?.die.max
  return jsxs('button', {
    type: 'button',
    onClick: () => host.navigate(ROUTE),
    title: 'Open Personal Dashboard',
    style: { ...MONO, fontSize: 11, display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--ui-text-secondary)', background: 'none', border: 0, padding: '0 4px', cursor: 'pointer' },
    children: [
      jsx('span', { children: simmed(`${fmt(S.tokRate, S.tokRate < 10 ? 1 : 0)} tok/s`) }),
      temp != null
        ? jsx('span', { style: { color: temp >= 95 ? 'var(--ui-red)' : temp >= 80 ? 'var(--ui-yellow)' : 'var(--ui-text-tertiary)' }, children: `${temp.toFixed(0)}°C` })
        : null
    ]
  })
}

// ── registration ──────────────────────────────────────────────────────────────────────────────

// Chrome (sidebar nav + statusbar chip) registers only when the model writes page.html, so the
// plugin is invisible until the demo directs it into existence. Reset undoes it so the next
// take starts clean. The route + palette commands stay always-on.
let _chromeDispose = null
let _ctx = null
let _closeWorkspace = null

// The reveal opens the page as a tile docked beside the chat (the handoff's side-by-side
// layout) rather than replacing it; older desktops without openWorkspace fall back to the route.
function openWorkspace() {
  if (typeof host.openWorkspace === 'function') {
    _closeWorkspace = host.openWorkspace(ID, {
      title: 'Personal Dashboard',
      dock: { pane: 'workspace', pos: 'right' },
      minWidth: '30rem',
      render: () => jsx(MonitoringPage, {}),
      onClose: () => {
        _closeWorkspace = null
      }
    })
  } else {
    host.navigate(ROUTE)
  }
}

function closeWorkspace() {
  const close = _closeWorkspace
  _closeWorkspace = null
  if (close) close()
}

function registerChrome({ reveal } = {}) {
  if (!_ctx) return
  if (!_chromeDispose) {
    _chromeDispose = _ctx.registerMany([
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 5, render: () => jsx(Chip, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 60, data: { codicon: 'pulse', label: 'Personal Dashboard', path: ROUTE } }
    ])
  }
  // The reveal: the blank frame opens itself ON the command — nothing is pre-opened.
  if (reveal) openWorkspace()
}

function unregisterChrome() {
  if (_chromeDispose) {
    _chromeDispose()
    _chromeDispose = null
  }
}

export default {
  id: ID,
  name: 'Personal Dashboard',
  register(ctx) {
    _ctx = ctx
    resetHardware()
    const stopScope = [host.state.profile, host.state.connectionId, host.state.gateway]
      .map(atom => atom.listen(resetHardware))
    // Chrome starts HIDDEN. Disk sync restores it (and every built panel) if a build already
    // exists — a reload mid-demo keeps the dashboard as the model left it.
    const storedDir = ctx.storage.get('buildDir', null)
    S.buildDir = isBuildDir(storedDir) ? storedDir : '~/monitoring-dashboard'
    void syncBuildFromDisk()
    const stopSync = ctx.setInterval(() => void syncBuildFromDisk(), DISK_SYNC_MS)
    ctx.onDispose(() => {
      _ctx = null
      diskGeneration++
      feedGeneration++
      for (const stop of stopScope) stop()
      for (const timer of timers) clearInterval(timer)
      timers = []
      stopSync()
      unregisterChrome()
      closeWorkspace()
    })
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(MonitoringPage, {}) },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: 'Open Personal Dashboard',
          keywords: ['monitoring', 'telemetry', 'metrics', 'cpu', 'gpu', 'temperature', 'dashboard', 'fleet'],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: 'reset',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.reset`,
          label: 'Reset Personal Dashboard',
          keywords: ['monitoring', 'telemetry', 'reset', 'compose', 'empty', 'demo'],
          run: () => {
            void resetBuild()
          }
        }
      }
    ])
    ctx.onEvent('*', onGatewayEvent)
  }
}
