// Hermes Telemetry — realtime host + fleet instrument panel.
// Hardware comes from the `system.metrics` gateway RPC; fleet/tokens from gateway events and
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

const ID = 'hermes-telemetry'
const ROUTE = '/telemetry'
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
  simSessions: []
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

async function pollMetrics() {
  lastPoll = Date.now()
  try {
    const f = await host.request('system.metrics', {})
    // `available: false` = the backend's sampler failed; only a whole frame is trusted.
    if (!f?.available || !f.cpu || !f.memory) {
      S.link = 'error'
      emit()
      return
    }
    f.die = dieStats(f.temps)
    S.link = 'ok'
    S.frame = f
    if (f.interval_s) {
      const h = S.hist
      push(h.cpu, f.cpu.percent ?? 0)
      push(h.gpu, f.gpus[0]?.active != null ? f.gpus[0].active * 100 : 0)
      push(h.watts, sumPower(f.power_w) ?? 0)
      push(h.rx, f.net.rx_bps ?? 0)
      push(h.tx, f.net.tx_bps ?? 0)
      push(h.rd, f.disk.read_bps ?? 0)
      push(h.wr, f.disk.write_bps ?? 0)
      push(h.die, f.die.max ?? 0)
    }
  } catch (err) {
    S.link = /unknown method/i.test(String(err?.message ?? err)) ? 'missing' : 'error'
  }
  emit()
}

async function pollFleet() {
  try {
    const { sessions } = await host.request('session.active_list', {})
    S.sessions = sessions ?? []
    const busy = S.sessions.filter(s => s.status !== 'idle').slice(0, 6)
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
    S.subagents = next
  } catch {
    // Gateway not up yet; the radar shows an empty scope until it is.
  }
  emit()
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
  if (!consumers) return
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
      break
    }
    case 'tool.complete': {
      const st = S.toolStarts[p.tool_id]
      delete S.toolStarts[p.tool_id]
      const dur = p.duration_s ?? (st ? (now - st.t) / 1000 : null)
      logLine(p.error ? 'err' : 'done', `${p.name ?? st?.name ?? 'tool'}${dur != null ? `  ${dur.toFixed(2)}s` : ''}`, sid)
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
const sumPower = p => (p && Object.keys(p).length ? POWER_KEYS.reduce((a, k) => a + (p[k] ?? 0), 0) : null)
// SoC die sensors on Apple Silicon are the PMU `tdie*` probes; elsewhere every sensor counts.
function dieStats(temps = []) {
  const die = temps.filter(t => /tdie/i.test(t.name))
  const pool = die.length ? die : temps
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

function Panel({ title, meta, children, style, bodyStyle }) {
  return jsxs('section', {
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
          jsxs('span', { style: { color: 'var(--ui-text-secondary)' }, children: ['//', title] }),
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
    const key = c.name.slice(0, 5) // ECPU0 / PCPU0 / PCPU1
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  return [...groups.entries()]
}

// IOReport core channel `PCPU130` = P-type, cluster 1, core 3 → "P1·3".
const coreLabel = name => (/^[EP]CPU\d\d/.test(name) ? `${name[0]}${name[4]}·${name[5]}` : name)

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
        const cl = cpu.clusters.find(c => c.name === (key[4] === '0' ? key.slice(0, 4) : key))
        const pctT = cl ? `${fmt(cl.active * 100)}%` : null
        headLine(ctx, ink, pad, y, cpuW, `${key[0]}-CLUSTER ${key[4]}`, cl ? [`${fmt(cl.freq_mhz)} MHz  ${pctT}`, pctT] : [])
        const cellW = (cpuW - (cores.length - 1) * 4) / cores.length
        cores.forEach((c, i) =>
          tile(ctx, ink, pad + i * (cellW + 4), y + head, cellW, rowH - head, {
            name: coreLabel(c.name),
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
        const gp = `${fmt((gpu.active ?? 0) * 100)}%`
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
      const top = max ?? niceMax(Math.max(1, ...data.flat()) * 1.15)
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
        ctx.beginPath()
        d.forEach((v, i) => {
          const x = x0 + i * step
          const y = h - 1 - (Math.min(v, top) / top) * (h - 4)
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        })
        ctx.strokeStyle = color
        ctx.lineWidth = si === 0 ? 1.25 : 1
        if (si) ctx.setLineDash([2, 2])
        ctx.stroke()
        ctx.setLineDash([])
        if (si === 0) {
          ctx.lineTo(W, h)
          ctx.lineTo(x0, h)
          ctx.closePath()
          ctx.globalAlpha = 0.07
          ctx.fillStyle = color
          ctx.fill()
          ctx.globalAlpha = 1
          // Head marker with a slow phosphor pulse.
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
  const pct = total ? Math.min(1, used / total) : 0
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
    return jsx('div', { style: { ...MONO, fontSize: 10.5, color: 'var(--ui-text-quaternary)' }, children: 'no gateway traffic yet' })
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
  const e = cpu?.cores.filter(c => c.name[0] === 'E').length
  const p = cpu?.cores.filter(c => c.name[0] === 'P').length
  const spec = h
    ? [
        h.cpu_model,
        h.arch.toUpperCase(),
        cpu.cores.length ? `${cpu.count_logical}C ${e}E+${p}P` : `${cpu.count_logical}C`,
        gpu?.cores ? `${gpu.cores}C GPU` : null,
        fmtBytes(f.memory.total, 0),
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
          jsx('span', { style: { ...MONO, fontSize: 13, letterSpacing: '0.14em', color: 'var(--ui-text-primary)' }, children: 'TELEMETRY' }),
          jsx('span', { style: { ...LABEL, color: 'var(--ui-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: spec })
        ]
      }),
      jsxs('div', {
        style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 },
        children: [
          S.sim ? simmed(jsx('span', { style: { ...LABEL, color: 'var(--ui-yellow)' }, children: 'synthetic fleet · hardware live' })) : null,
          jsx(LinkState, {}),
          jsx('span', { style: { ...MONO, fontSize: 11, color: 'var(--ui-text-secondary)' }, children: `${utc()}Z` }),
          jsx(Button, {
            size: 'xs',
            variant: S.sim ? 'secondary' : 'ghost',
            'aria-pressed': S.sim,
            onClick: () => setSim(!S.sim),
            children: S.sim ? 'SIM on' : 'SIM off'
          })
        ]
      })
    ]
  })
}

function TelemetryPage() {
  useFeed(true)
  useStore()
  useClock()
  const model = useValue(host.state.model)
  const f = S.frame
  const hardware = S.link === 'ok' && f
  const u = S.usage
  const busy = S.sessions.filter(s => s.status !== 'idle').length + S.simSessions.filter(s => s.status !== 'idle').length
  const subs = Object.values(S.subagents).reduce((a, l) => a + l.length, 0) + S.simSessions.reduce((a, s) => a + s.subs, 0)
  const watts = f ? sumPower(f.power_w) : null
  const mem = f?.memory
  const vol = f?.disk.volumes[0]
  const [pageRef, width] = useWidth()
  // wide fills one screen; mid pairs panels; narrow (a side pane) stacks them. Both of those scroll.
  const mode = width >= 1100 ? 'wide' : width >= 700 ? 'mid' : 'narrow'
  const span = (wide, mid) => ({ gridColumn: `span ${mode === 'wide' ? wide : mode === 'mid' ? mid : 12}` })

  return jsxs('div', {
    ref: pageRef,
    style: { height: '100%', overflow: 'auto', padding: '14px 18px 18px', color: 'var(--ui-text-primary)', display: 'flex', flexDirection: 'column' },
    children: [
      jsx(Header, { f }),
      !hardware && S.link === 'missing'
        ? jsx('div', {
            style: { ...MONO, fontSize: 11, color: 'var(--ui-text-tertiary)', padding: '6px 0 12px' },
            children: 'This backend has no system.metrics RPC yet: hardware panels are dark, fleet + token panels are live.'
          })
        : null,
      jsxs('div', {
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
          // Row 1: headline numbers.
          jsx('div', {
            style: { gridColumn: 'span 12', display: 'grid', gridTemplateColumns: `repeat(${mode === 'wide' ? 8 : 4}, minmax(0, 1fr))`, gap: 16, borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: 10 },
            children: [
              jsx(Stat, { big: true, label: simmed('≈tok/s'), value: fmt(S.tokRate, S.tokRate < 10 ? 1 : 0) }),
              jsx(Stat, { big: true, label: 'cpu', value: fmt(f?.cpu.percent), unit: '%', tone: heatCss(f && f.cpu.percent / 100) }),
              jsx(Stat, { big: true, label: 'gpu', value: fmt(f?.gpus[0] ? f.gpus[0].active * 100 : null), unit: '%', tone: heatCss(f?.gpus[0]?.active) }),
              jsx(Stat, { big: true, label: 'soc power', value: fmt(watts, 1), unit: 'W', tone: heatCss(watts == null ? null : watts / SOC_PEAK_W) }),
              jsx(Stat, { big: true, label: 'die max', value: fmt(f?.die.max, 1), unit: '°C', tone: heatCss(tempT(f?.die.max)) }),
              jsx(Stat, { big: true, label: 'mem', value: fmt(mem?.percent), unit: '%', tone: heatCss(mem && mem.percent / 100) }),
              jsx(Stat, { big: true, label: simmed('agents'), value: String(busy), unit: subs ? `+${subs} sub` : undefined }),
              jsx(Stat, { big: true, label: simmed('tools/min'), value: String(S.toolsPerMin.length) })
            ]
          }),

          // Row 2: silicon.
          jsx(Panel, {
            title: 'silicon',
            meta: f ? jsxs('span', { style: { display: 'inline-flex', gap: 14 }, children: [f.cpu.cores.length ? 'ioreport · dvfs · 1 hz' : 'psutil · 1 hz', jsx(HeatKey, { lo: 'idle', hi: '100%' })] }) : null,
            style: span(8, 12),
            children: jsx(DieMap, { frame: f })
          }),
          jsx(Panel, {
            title: 'thermal',
            meta: f ? jsxs('span', { style: { display: 'inline-flex', gap: 14 }, children: [`${f.temps.length} sensors · avg ${fmt(f.die.avg, 1)}°`, jsx(HeatKey, { lo: '35°', hi: '100°' })] }) : null,
            style: span(4, 6),
            children: jsx(Thermals, { frame: f })
          }),

          // Row 3: fleet + scopes + log.
          jsx(Panel, {
            title: 'fleet',
            meta: simmed(`${S.sessions.length + S.simSessions.length} contacts`),
            style: span(4, 6),
            children: jsx(Radar, {})
          }),
          jsxs(Panel, {
            title: 'throughput',
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
          jsx(Panel, { title: 'wire', meta: simmed('gateway events'), style: span(4, 6), children: jsx(EventLog, {}) }),

          // Row 4: power, memory, io.
          jsxs(Panel, {
            title: 'power',
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
          jsxs(Panel, {
            title: 'memory',
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
                      jsx('span', { children: `hermes pid ${f.process.pid}` }),
                      jsx('span', { children: `${fmtBytes(f.process.rss)} · ${fmt(f.process.cpu_percent)}% · ${f.process.threads}thr` })
                    ]
                  })
                : null
            ]
          }),
          jsx(Panel, {
            title: 'net',
            meta: f ? `↓${fmtRate(f.net.rx_bps)}  ↑${fmtRate(f.net.tx_bps)}` : null,
            style: span(3, 6),
            children: jsx(Scope, { series: [{ data: S.hist.rx }, { data: S.hist.tx }], fmtY: v => `${fmtBytes(v, 0)}/s` })
          }),
          jsx(Panel, {
            title: 'disk io',
            meta: f ? `r ${fmtRate(f.disk.read_bps)}  w ${fmtRate(f.disk.write_bps)}` : null,
            style: span(3, 6),
            children: jsx(Scope, { series: [{ data: S.hist.rd }, { data: S.hist.wr }], fmtY: v => `${fmtBytes(v, 0)}/s` })
          })
        ]
      })
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
    title: 'Open telemetry',
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

export default {
  id: ID,
  register(ctx) {
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(TelemetryPage, {}) },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 5, render: () => jsx(Chip, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 60, data: { codicon: 'pulse', label: 'Telemetry', path: ROUTE } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: 'Open Telemetry',
          keywords: ['telemetry', 'metrics', 'cpu', 'gpu', 'temperature', 'dashboard', 'fleet'],
          run: () => host.navigate(ROUTE)
        }
      }
    ])
    ctx.onEvent('*', onGatewayEvent)
  }
}
