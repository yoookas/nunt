// Runtime smoke for the Ant Design admin bundle: mount every route in jsdom
// with a mocked API and fail on render errors.
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
  if (typeof window[key] !== 'function') continue
  try {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true })
  } catch {}
}
for (const key of ['document', 'navigator', 'location', 'history', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'NodeList', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'DOMParser', 'File', 'FormData', 'Blob', 'URL', 'URLSearchParams', 'CSS', 'DOMRect', 'localStorage', 'sessionStorage', 'screen', 'devicePixelRatio', 'XMLHttpRequest', 'Image']) {
  try {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true })
  } catch {}
}
window.matchMedia = globalThis.matchMedia = (query) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } })
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
window.IntersectionObserver = globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
window.scrollTo = () => {}
window.Element.prototype.scrollTo = function () {}
window.Element.prototype.scrollIntoView = function () {}
window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, toJSON() {} } }
window.EventSource = globalThis.EventSource = class { constructor(url) { this.url = url; this.readyState = 1 } close() {} addEventListener() {} removeEventListener() {} }
window.requestIdleCallback = globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: false }), 0)

const errors = []
window.addEventListener('error', (event) => errors.push(String(event.error?.stack || event.message)))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.stack || event.reason)))

function fixture(path) {
  if (path === '/api/v1/auth/session') return { username: 'admin', csrf: 'csrf', mustChangePassword: false }
  if (path === '/api/v1/system/info') return { version: { version: 'test' }, webRules: 0, modules: [], certs: { count: 0, loadErrors: 0 }, adminListen: ':3113', adminAllowList: { restricted: false, entries: [] } }
  if (path === '/api/v1/system/stats') return { hostname: 'test', os: 'linux', arch: 'amd64', numCpu: 4, goroutines: 1, heapBytes: 1024, sysBytes: 2048, startTime: new Date().toISOString(), uptimeSec: 10 }
  if (path === '/api/v1/system/settings') return {}
  if (path === '/api/v1/system/health') return { certs: { total: 0, expired: 0, expiring7: 0, expiring30: 0, soon: [] }, acme: {}, problems: [] }
  if (path === '/api/v1/system/ip2region') return { v4: { loaded: false }, v6: { loaded: false } }
  if (path.endsWith('/logs') || path.endsWith('/events')) return { entries: [], items: [] }
  if (path.endsWith('/rules') || path.endsWith('/jobs') || path.endsWith('/providers') || path.endsWith('/certificates') || path.endsWith('/listeners') || path.endsWith('/rules') || path.endsWith('/files')) return { items: [] }
  if (path.endsWith('/meta')) return { written: 0, dropped: 0, files: [], totalBytes: 0, keepDays: 7, maxFileMb: 64 }
  if (path.endsWith('/stats')) return { total: 0, bySource: {}, byStatus: {}, topIps: [], topPaths: [], topRules: [], files: 0 }
  return { items: [], rules: [], entries: [] }
}

globalThis.fetch = window.fetch = async (input) => {
  const url = new URL(String(input), 'http://localhost/')
  const body = fixture(url.pathname)
  return { ok: true, status: 200, statusText: 'OK', headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(body), json: async () => body }
}

const entry = readdirSync(ASSETS).filter((n) => /^index-.*\.js$/.test(n)).sort().pop()
if (!entry) throw new Error('no built entry; run npm run build first')
process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err?.message || err); process.exit(1) })
process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err?.message || err); process.exit(1) })

try {
  await import(pathToFileURL(new URL(entry, ASSETS).pathname).href)
} catch (err) {
  console.error('IMPORT FAILED:', err?.message || err)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(800)

const routes = [['/', '概览'], ['/web', 'Web 服务'], ['/forward', '端口转发'], ['/ddns', '动态域名'], ['/acme', '证书'], ['/waf', 'WAF'], ['/logs', '日志'], ['/ipdb', 'IP 地址库'], ['/settings', '设置'], ['/password', '修改密码']]
const failures = []
for (const [route, title] of routes) {
  const before = errors.length
  window.location.hash = `#${route}`
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
  let text = ''
  for (let i = 0; i < 40; i++) {
    await sleep(100)
    text = Array.from(window.document.querySelectorAll('h2, h4')).map((h) => h.textContent || '').join(' ') || window.document.body.textContent || ''
    if (text.includes(title)) break
  }
  if (!text.includes(title)) failures.push(`${route}: title "${title}" not found (${text.slice(0, 40)})`)
  await sleep(400)
  if (errors.length > before) failures.push(`${route}: ${errors[before]}`)
}
const fatal = errors.filter((e) => !/not implemented|Warning: \[antd/.test(e))
if (fatal.length) failures.push(...fatal.slice(0, 3))
if (failures.length) {
  console.error('frontend smoke failed:')
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log(`frontend smoke ok: ${routes.length} routes mounted without a crash`)

process.exit(0)
