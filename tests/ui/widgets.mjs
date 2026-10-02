// Focused config/file-reconciliation tests. No build or desktop installation.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
const source = await readFile(new URL('../../plugin/desktop/plugin.js', import.meta.url), 'utf8')
const config = widgets => JSON.stringify({ version: 1, widgets })
function load({ storedDir = null } = {}) {
  const files = new Map()
  const trashed = []
  let onEvent = () => {}
  const notices = []
  const contributions = []
  const disposers = []
  let readError = false, trashCount = 0
  const atom = { listen: () => () => {} }
  const sandbox = {
    Date, console, setInterval: () => 1, clearInterval() {},
    jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }),
    host: { state: { profile: atom, connectionId: atom, gateway: atom }, notify: n => notices.push(n), navigate() {}, request: async () => ({ sessions: [] }) },
    ROUTES_AREA: 'route', SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'bar' }, PALETTE_AREA: 'palette',
    window: { hermesDesktop: {
      readDir: async () => { if (readError) throw new Error('permission denied'); return { entries: [...files.keys()].map(name => ({ name, isDirectory: false })) } },
      readFileText: async path => ({ text: files.get(path.split('/').pop()), binary: false, truncated: false }),
      trashPath: async path => { trashCount++; trashed.push(path); files.delete(path.split('/').pop()) }
    } }
  }
  vm.runInNewContext(source.replace(/import\s+[\s\S]*?from ['"][^'"]+['"]\n/g, '').replace('export default {', 'globalThis.plugin = {') + '\nglobalThis.api = { S, parseDashboardConfig, orderedWidgets, monthDays, ConfiguredWidgets, metricPanels, syncBuildFromDisk, buildStepFromTool, resetBuild, WIDGET_TYPES }', sandbox)
  const ctx = {
    storage: { get: () => storedDir, set() {} }, setInterval: () => () => {},
    registerMany: cs => { contributions.push(...cs); return () => {} }, onDispose: fn => disposers.push(fn), onEvent: (_, fn) => { onEvent = fn }
  }
  sandbox.plugin.register(ctx)
  return { ...sandbox.api, files, notices, contributions, fs: sandbox.window.hermesDesktop,
    failRead: on => { readError = on }, trashCount: () => trashCount, trashed, event: ev => onEvent(ev),
    dispose: () => disposers.forEach(fn => fn()) }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('schema validates common fields, preserves unrelated data, stable ordering', () => {
  const app = load()
  const parsed = app.parseDashboardConfig(JSON.stringify({ version: 1, settings: { keep: true }, widgets: [
    { id: 'b', type: 'text', text: 'Hello ☺', order: 2, extra: 'keep' },
    { id: 'a', type: 'clock', order: 0 }, { id: 'c', type: 'date', order: 2 }
  ] }))
  assert.equal(parsed.settings.keep, true)
  assert.equal(parsed.widgets[0].extra, 'keep')
  assert.deepEqual(Array.from(app.orderedWidgets(parsed), w => w.id), ['a', 'b', 'c'])
  for (const invalid of [null, {}, { id: 'a', type: 'text', accent: 'url(evil)' }, { id: 'a', type: 'text', accent: ['green'] }, { id: 'a', type: 'text', title: 1 }, { id: 'a', type: 'text', order: '1' }, { id: 'a', type: 'text', width: 5 }]) assert.throws(() => app.parseDashboardConfig(config([invalid])))
  assert.throws(() => app.parseDashboardConfig(config([{ id: 'a', type: 'text' }, { id: 'a', type: 'clock' }])))
  assert.throws(() => app.parseDashboardConfig('{'))
  assert.throws(() => app.parseDashboardConfig('{"version":2,"widgets":[]}'))
  app.dispose()
})

test('file polling loads config alone, retains last good on errors, recovers and returns to markers', async () => {
  const app = load(); await settle()
  app.files.set('dashboard.json', config([{ id: 'hi', type: 'text', text: 'Hello' }]))
  await app.syncBuildFromDisk()
  assert.equal(app.S.config.widgets[0].text, 'Hello')
  const originalRead = app.fs.readFileText
  app.fs.readFileText = async () => ({ text: config([]), truncated: true })
  await app.syncBuildFromDisk()
  assert.equal(app.S.config.widgets[0].text, 'Hello')
  assert.match(app.S.configError, /complete, non-binary/)
  app.fs.readFileText = originalRead
  assert.ok(app.contributions.some(c => c.area === 'nav'))
  app.files.set('dashboard.json', '{broken')
  await app.syncBuildFromDisk()
  assert.equal(app.S.config.widgets[0].text, 'Hello')
  assert.match(app.S.configError, /last valid/)
  app.failRead(true); await app.syncBuildFromDisk()
  assert.match(app.S.configError, /permission denied/)
  assert.equal(app.S.config.widgets.length, 1)
  app.failRead(false); app.files.set('dashboard.json', config([])); await app.syncBuildFromDisk()
  assert.equal(app.S.config.widgets.length, 0); assert.equal(app.S.configError, null)
  await app.resetBuild(); assert.equal(app.trashCount(), 0)
  app.files.delete('dashboard.json'); app.files.set('page.html', ''); app.files.set('panel-fleet.html', ''); app.files.set('panel-wire.html', '')
  await app.syncBuildFromDisk()
  assert.equal(app.S.config, null)
  assert.deepEqual(Array.from(app.S.built), ['chrome', 'fleet', 'wire'])
  assert.equal(app.metricPanels({ f: null, model: null, span: () => ({}) }).fleet().props.title, 'Sessions')
  assert.equal(app.metricPanels({ f: null, model: null, span: () => ({}) }).wire().props.title, 'feed')
  await app.resetBuild()
  assert.deepEqual(app.trashed, ['~/monitoring-dashboard/page.html', '~/monitoring-dashboard/panel-fleet.html', '~/monitoring-dashboard/panel-wire.html'])
  app.dispose()
})

test('reset never targets a folder learned from an unrelated write or a stale stored path', async () => {
  const app = load({ storedDir: '/home/user/projects' }); await settle()
  assert.equal(app.S.buildDir, '~/monitoring-dashboard')
  assert.equal(app.buildStepFromTool('write_file', { path: '/home/user/monitoring-dashboard-site/homepage.html' }), null)
  const write = path => app.event({ type: 'tool.complete', payload: { tool_id: path, name: 'write_file', args: { path }, result: { resolved_path: path } } })
  write('/home/user/monitoring-dashboard-site/page.html')
  write('/home/user/.hermes/plugins/hermes-monitoring-dashboard/page.html')
  assert.equal(app.S.buildDir, '~/monitoring-dashboard')
  write('/home/user/monitoring-dashboard/page.html')
  assert.equal(app.S.buildDir, '/home/user/monitoring-dashboard')
  app.files.set('page.html', ''); app.files.set('notes.txt', '')
  await app.resetBuild()
  assert.deepEqual(app.trashed, ['/home/user/monitoring-dashboard/page.html'])
  assert.ok(app.files.has('notes.txt'))
  app.dispose()
})

test('invalid first config is readable, reset safe, disposal rejects late file reads', async () => {
  const app = load(); await settle()
  app.files.set('dashboard.json', '{')
  await app.syncBuildFromDisk()
  assert.equal(app.S.config, null); assert.match(app.S.configError, /legacy panels/)
  await app.resetBuild(); assert.equal(app.trashCount(), 0)
  let resolve
  app.fs.readFileText = () => new Promise(r => { resolve = r })
  const pending = app.syncBuildFromDisk(); await settle()
  app.dispose(); resolve(config([{ id: 'late', type: 'text' }])); await pending
  assert.equal(app.S.config, null)
})

test('registry renders safe text, unknown types, empty state, accents, local date and backend uptime', () => {
  const app = load()
  const parsed = app.parseDashboardConfig(config([
    { id: 'text', type: 'text', text: '<script>bad()</script> ☺', accent: '#55a583', title: 'My note' },
    { id: 'future', type: 'custom' }, { id: 'up', type: 'uptime' }, { id: 'sessions', type: 'fleet' }
  ]))
  const tree = app.ConfiguredWidgets({ config: parsed, mode: 'narrow', f: null })
  assert.equal(tree.props.children[0].props.title, 'My note')
  assert.equal(tree.props.children[0].props.style.gridColumn, 'span 12')
  assert.equal(tree.props.children[0].props.children.props.children, '<script>bad()</script> ☺')
  assert.match(JSON.stringify(tree), /Unsupported widget type/)
  assert.match(JSON.stringify(tree), /Uptime unavailable/)
  assert.equal(tree.props.children[3].props.title, 'Sessions')
  assert.match(JSON.stringify(app.ConfiguredWidgets({ config: { widgets: [] } })), /No widgets yet/)
  const now = new Date(2024, 1, 29)
  assert.equal(app.monthDays(now).filter(Boolean).length, 29)
  assert.equal(app.monthDays(now)[4], 1)
  assert.match(JSON.stringify(app.WIDGET_TYPES.get('clock').render({}, { now })), /local time/)
  assert.match(JSON.stringify(app.WIDGET_TYPES.get('uptime').render({}, { f: { host: { uptime_s: 3660 } } })), /1h 01m/)
  assert.equal(app.buildStepFromTool('write_file', { path: '/home/user/monitoring-dashboard/dashboard.json' }).id, 'config')
  assert.equal(app.buildStepFromTool('patch', { path: '/home/user/monitoring-dashboard/panel-fleet.html' }).id, 'fleet')
  app.dispose()
})
