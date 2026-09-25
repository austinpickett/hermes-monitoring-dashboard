// Tiny CDP helper: `node cdp.mjs shot out.png` | `node cdp.mjs eval "<js>"`.
// CDP_PORT picks the browser; CDP_URL is the target-URL prefix (desktop renderer by default).
const port = Number(process.env.CDP_PORT || 9333)
const prefix = process.env.CDP_URL || 'http://127.0.0.1:5174'
const [cmd, arg] = process.argv.slice(2)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith(prefix))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = ++id
    const on = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== my) return
      ws.removeEventListener('message', on)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
if (cmd === 'shot') {
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  const fs = await import('node:fs')
  fs.writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('wrote', arg)
} else {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result.value ?? r.exceptionDetails ?? r.result, null, 1))
}
ws.close()
