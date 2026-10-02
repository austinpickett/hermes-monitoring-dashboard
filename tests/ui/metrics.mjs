// Focused runtime checks; no bundler or private desktop imports.
// Run: node --test tests/ui/metrics.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../plugin/desktop/plugin.js', import.meta.url), 'utf8')
function load() {
  const pending = []
  const dispose = []
  const draws = []
  const atom = () => {
    const listeners = new Set()
    return { listen: fn => (listeners.add(fn), () => listeners.delete(fn)), set: () => listeners.forEach(fn => fn()) }
  }
  const state = { profile: atom(), connectionId: atom(), gateway: atom() }
  const sandbox = {
    Date, console, Button: 'button', setInterval: () => 1, clearInterval: () => {},
    host: { state, request: async method => {
      assert.notEqual(method, 'system.metrics')
      return { sessions: [], subagents: [] }
    } },
    ROUTES_AREA: 'routes', PALETTE_AREA: 'palette', SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'bar' },
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
    useSyncExternalStore: () => {},
  }
  const code = source.replace(/import\s+[\s\S]*?from ['"][^'"]+['"]\n/g, '')
    .replace('export default {', 'globalThis.plugin = {')
  vm.runInNewContext(code + `
    useCanvas = draw => { draws.push(draw); return null }
    globalThis.api = { S, normalizeFrame, sumPower, groupCores, coreLabel, Scope, DieMap, Header, pollMetrics,
      mount: () => { consumers = 1 }, unmount: () => { consumers = 0 } }
  `, Object.assign(sandbox, { draws }))
  const ctx = {
    rest: path => {
      assert.equal(path, '/metrics')
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    registerMany: () => () => {}, storage: { get: () => null },
    setInterval: () => () => {}, onDispose: fn => dispose.push(fn), onEvent: () => {},
  }
  sandbox.plugin.register(ctx)
  return { ...sandbox.api, state, pending, dispose: () => dispose.forEach(fn => fn()), draws }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const frame = percent => ({ available: true, interval_s: 1, cpu: { percent } })

test('partial frames preserve null GPU, power and rate gaps', async () => {
  const app = load()
  const done = app.pollMetrics()
  app.pending.shift().resolve({ ...frame(12), gpus: [{ active: null }], power_w: { cpu: null }, temps: null, process: null, memory: null })
  await done
  assert.equal(app.S.link, 'ok')
  assert.equal(app.S.hist.cpu[0], 12)
  for (const key of ['gpu', 'watts', 'rx', 'tx', 'rd', 'wr', 'die']) assert.equal(app.S.hist[key][0], null, key)
  assert.equal(app.sumPower({ cpu: 0, gpu: null }), 0)
  assert.equal(app.normalizeFrame({}).cpu.cores.length, 0)
  app.dispose()
})

test('profile and connection switches clear history and ignore stale in-flight results', async () => {
  for (const scope of ['profile', 'connectionId', 'gateway']) {
    const app = load()
    app.mount()
    const first = app.pollMetrics()
    await app.pollMetrics()
    assert.equal(app.pending.length, 1, 'no overlapping polls')
    app.S.frame = frame(1)
    app.S.hist.cpu.push(1)
    app.state[scope].set()
    assert.equal(app.S.frame, null)
    assert.equal(app.S.hist.cpu.length, 0)
    assert.equal(app.pending.length, 1)
    app.pending.shift().resolve(frame(99))
    await first
    assert.equal(app.S.frame, null, 'stale host must not flash')
    assert.equal(app.pending.length, 1, 'replacement poll after old request settles')
    app.pending.shift().resolve(frame(7))
    await settle()
    assert.equal(app.S.frame.cpu.percent, 7)
    assert.deepEqual(Array.from(app.S.hist.cpu), [7])
    app.dispose()
  }
})

test('missing backend and unavailable frames clear old hardware without a core fallback', async () => {
  const app = load()
  app.S.frame = frame(1)
  const missing = app.pollMetrics()
  app.pending.shift().reject(new Error('404: not found'))
  await missing
  assert.equal(app.S.link, 'missing')
  assert.equal(app.S.frame, null)
  assert.equal(app.S.hist.cpu[0], null)
  const unavailable = app.pollMetrics()
  app.pending.shift().resolve({ available: false })
  await unavailable
  assert.equal(app.S.link, 'error')
  assert.equal(app.S.frame, null)
  app.dispose()
})

test('disposal blocks a late response and stops scope listeners', async () => {
  const app = load()
  app.mount()
  const done = app.pollMetrics()
  app.dispose()
  const version = app.S.version
  app.pending.shift().resolve(frame(99))
  await done
  app.state.profile.set()
  assert.equal(app.S.frame, null)
  assert.equal(app.S.version, version)
  assert.equal(app.pending.length, 0)
})

test('Ultra core grouping preserves die identity and uses kind for labels', () => {
  const app = load()
  const cores = [0, 1].flatMap(die => ['E', 'P'].map(kind => ({ name: `DIE_${die}_${kind}CPU000`, kind })))
  const groups = app.groupCores(cores)
  assert.equal(groups.length, 4)
  assert.deepEqual(Array.from(groups, ([name]) => name), ['DIE_0_ECPU0', 'DIE_0_PCPU0', 'DIE_1_ECPU0', 'DIE_1_PCPU0'])
  assert.equal(app.coreLabel(cores[0]), 'E0·0')
  assert.equal(app.coreLabel(cores[1]), 'P0·0')
  const header = JSON.stringify(app.Header({ f: app.normalizeFrame({ host: {}, cpu: { cores, count_logical: 4 }, memory: null }) }))
  assert.match(header, /4C 2E\+2P/)
  app.dispose()
})

test('scope gaps split paths and omit the latest marker when unknown', () => {
  const app = load()
  app.Scope({ series: [{ data: [10, 20, null, 40, 50, null] }], max: 100, fmtY: String })
  const paths = []
  let path = []
  let arcs = 0
  const ctx = {
    beginPath: () => { path = [] }, moveTo: (x, y) => path.push(['M', x, y]), lineTo: (x, y) => path.push(['L', x, y]),
    stroke: () => paths.push(path.slice()), closePath: () => {}, fill: () => {}, fillText: () => {}, setLineDash: () => {}, arc: () => arcs++,
  }
  app.draws[0](ctx, 150, 100, { line2: 'gray', line: 'gray', accent: 'blue', fg3: 'gray', fg4: 'gray', mono: 'mono' }, 0)
  const traces = paths.filter(p => p.length === 2 && p[0][2] !== p[1][2])
  assert.equal(traces.length, 2)
  assert.equal(arcs, 0)
  app.dispose()
})
