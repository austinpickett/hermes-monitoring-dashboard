// Minimal stand-in for `@hermes/plugin-sdk`: just the surface plugin.js imports. host.request goes
// to harness/server.py, which answers system.metrics from the real sampler on this machine.
import { useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'
export const STATUSBAR_AREAS = { left: 'statusbar.left', right: 'statusbar.right' }

const atom = value => {
  const subs = new Set()
  return { get: () => value, set: v => ((value = v), subs.forEach(s => s())), listen: s => (subs.add(s), () => subs.delete(s)) }
}

export const useValue = a => useSyncExternalStore(a.listen, a.get)

export const host = {
  state: { model: atom('claude-opus-5.5') },
  navigate: path => console.log('[harness] navigate', path),
  async request(method, params = {}) {
    const r = await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, params }) })
    const body = await r.json()
    if (body.error) throw new Error(body.error)
    return body.result
  }
}

export function Button({ children, variant, size, ...rest }) {
  return jsx('button', {
    ...rest,
    style: {
      font: 'inherit',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 4,
      border: '1px solid var(--ui-stroke-secondary)',
      background: variant === 'secondary' ? 'var(--ui-control-active-background)' : 'transparent',
      color: 'var(--ui-text-secondary)',
      cursor: 'pointer'
    },
    children
  })
}

export const GlyphSpinner = () => jsx('span', { children: '⠋' })
