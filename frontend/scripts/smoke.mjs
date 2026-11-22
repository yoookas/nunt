// Runtime smoke for the built admin interface.
//
// It loads the real bundle (internal/webui/assets) inside jsdom, mocks the
// admin API, then visits every route. The goal is to catch crashes in render,
// effects and the router guards: a compile error is already caught by the
// build, a runtime one only shows up when the page mounts.
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const ASSETS = new URL('../../internal/webui/assets/static/', import.meta.url)

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom

globalThis.window = window
for (const key of Object.getOwnPropertyNames(window)) {
  if (globalThis[key] !== undefined) continue
  const value = window[key]
  if (typeof value !== 'function') continue
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  } catch {
    // Non configurable Node globals stay as they are.
  }
}
for (const key of [
  'document', 'navigator', 'location', 'history', 'CustomEvent', 'Event', 'MouseEvent',
  'KeyboardEvent', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'NodeList',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
  'DOMParser', 'File', 'FormData', 'Blob', 'URL', 'URLSearchParams', 'CSS', 'DOMRect',
  'localStorage', 'sessionStorage', 'screen', 'devicePixelRatio', 'XMLHttpRequest',
  'Image', 'WebSocket',
]) {
  try {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true })
  } catch {
    // ignore
  }
}

window.matchMedia = globalThis.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false },
})
window.ResizeObserver = globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.IntersectionObserver = globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.scrollTo = () => {}
window.Element.prototype.scrollTo = function () {}
window.Element.prototype.scrollIntoView = function () {}
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, toJSON() {} }
}
window.EventSource = globalThis.EventSource = class {
  constructor(url) { this.url = url; this.readyState = 1 }
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
window.requestIdleCallback = globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: false }), 0)

const errors = []
window.addEventListener('error', (event) => errors.push(String(event.error?.stack || event.message)))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.stack || event.reason)))

function fixture(path) {
  if (path === '/api/v1/auth/session') {
    return { username: 'admin', csrf: 'csrf-token', mustChangePassword: false, kind: 'session' }
  }
  if (path === '/api/v1/system/info') {
    return {
      version: { version: 'test' }, webRules: 0, modules: [],
      certs: { count: 0, loadErrors: 0 }, adminListen: ':3113',
      adminAllowList: { restricted: false, entries: [] },
    }
  }
  if (path === '/api/v1/system/stats') {
    return {
      hostname: 'test', os: 'linux', arch: 'amd64', numCpu: 4, goroutines: 1,
      heapBytes: 1024, sysBytes: 2048, startTime: new Date().toISOString(), uptimeSec: 10,
    }
  }
  if (path === '/api/v1/system/settings') return {}
  if (path === '/api/v1/system/logs' || path === '/api/v1/web/logs' || path === '/api/v1/forward/logs') return { entries: [] }
  if (path === '/api/v1/ddns/providers') return []
  if (path === '/api/v1/modules') return []
  if (path === '/api/v1/storage/mounts') return []
  if (path === '/api/v1/acme/certificates') return { items: [] }
  if (path === '/api/v1/web/listeners') return { items: [] }
  if (path.endsWith('/items') || path.endsWith('/rules') || path.endsWith('/jobs') || path.endsWith('/mounts') || path.endsWith('/webhooks') || path.endsWith('/users') || path.endsWith('/tokens') || path.endsWith('/sessions') || path.endsWith('/shares')) {
    return { items: [] }
  }
  return {}
}

globalThis.fetch = window.fetch = async (input) => {
  const url = new URL(String(input), 'http://localhost/')
  const body = fixture(url.pathname)
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

const entry = readdirSync(ASSETS).filter((name) => /^index-.*\.js$/.test(name)).sort().pop()
if (!entry) throw new Error('no built entry found; run "npm run build" first')

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err?.message || err)
  console.error(String(err?.stack || '').split('\n').slice(0, 8).join('\n'))
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err?.message || err)
  process.exit(1)
})

try {
  await import(pathToFileURL(new URL(entry, ASSETS).pathname).href)
} catch (err) {
  console.error('IMPORT FAILED:', err?.message || err)
  console.error(String(err?.stack || '').split('\n').slice(0, 8).join('\n'))
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const originalConsoleError = console.error
console.error = (...args) => {
  errors.push(args.map((value) => (value instanceof Error ? value.stack || value.message : String(value))).join(' '))
}

await sleep(500)

const routes = [
  ['/', '概览'],
  ['/web', 'Web 服务'],
  ['/forward', '端口转发'],
  ['/ddns', '动态域名'],
  ['/acme', '证书'],
  ['/waf', 'WAF'],
  ['/storage', '存储'],
  ['/logs', '日志'],
  ['/settings', '设置'],
]
const failures = []
for (const [route, title] of routes) {
  const before = errors.length
  window.location.hash = `#${route}`
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
  window.dispatchEvent(new window.PopStateEvent('popstate'))
  // Pages are lazy loaded: wait until the route chunk mounted.
  let heading = ''
  for (let i = 0; i < 40; i += 1) {
    await sleep(100)
    heading = window.document.querySelector('.page-title')?.textContent || ''
    if (heading.includes(title)) break
  }
  if (!heading.includes(title)) failures.push(`${route}: heading is "${heading}", want "${title}"`)
  const fresh = errors.splice(before)
  if (fresh.length) failures.push(`${route}: ${fresh.join(' | ')}`)
}

await sleep(100)
if (errors.length) failures.push(`late errors: ${errors.join(' | ')}`)

console.error = originalConsoleError
if (failures.length) {
  console.error('frontend smoke failed:')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log(`frontend smoke ok: ${routes.length} routes mounted without a crash`)
