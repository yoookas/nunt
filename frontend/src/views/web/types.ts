// Types shared by the Web service page and its dialogs. They mirror the Go
// API in internal/modules/web and internal/model so the page can stay typed
// without reaching for `any` on every response.
import { fmtTime } from '../../format'
import type { SelectOption } from '../../ui'

export type RouteType = 'proxy' | 'redirect' | 'static'
export type TLSMode = 'off' | 'auto' | 'custom'
export type AccessMode = 'off' | 'allow' | 'deny'
export type UAMode = 'off' | 'allow' | 'deny'

export interface WebTLS {
  mode: TLSMode
  certId?: string
  hsts?: boolean
}

export interface WebListener {
  id: string
  name: string
  listen: string[]
  tls: WebTLS
  remark?: string
  createdAt?: string
  updatedAt?: string
}

export interface WebListenerView extends WebListener {
  routeCount?: number
}

export interface AccessFilter {
  mode: AccessMode
  ips?: string[]
  countries?: string[]
  provinces?: string[]
  uaMode?: UAMode
  uas?: string[]
}

export interface BasicAuthUser {
  username: string
  password: string
}

export interface BasicAuth {
  enable: boolean
  users?: BasicAuthUser[]
}

export interface ProxyTarget {
  targets: string[]
  balance?: string
  hostHeader?: string
  headers?: Record<string, string>
  respHeaders?: Record<string, string>
  pathPrefix?: string
  pathReplace?: string
  timeoutSec?: number
  insecureTls?: boolean
  disableCompression?: boolean
  h2c?: boolean
  rateLimitPerSec?: number
  maxBodyBytes?: number
}

export interface RedirectTarget {
  to: string
  status: number
  keepPath: boolean
}

export interface StaticTarget {
  mountId?: string
  root?: string
  index?: string[]
  listing?: boolean
  spa?: boolean
  cacheSeconds?: number
}

export interface WebRule {
  id: string
  name: string
  enable: boolean
  type: RouteType
  listenerId: string
  domains?: string[]
  path: string
  priority: number
  waf: boolean
  access: AccessFilter
  basicAuth?: BasicAuth | null
  proxy?: ProxyTarget | null
  redirect?: RedirectTarget | null
  static?: StaticTarget | null
  remark?: string
  createdAt?: string
  updatedAt?: string
  // Runtime decoration returned by GET /api/v1/web/rules.
  active?: boolean
  upstreams?: string[]
  requests?: number
  configError?: string
}

export interface Certificate {
  id: string
  domains: string[]
  issuer?: string
  notBefore?: string
  notAfter: string
  source?: string
  jobId?: string
  remark?: string
  autoRenew?: boolean
  updatedAt?: string
  keyType?: string
  daysLeft?: number
  expired?: boolean
}

export interface Mount {
  id: string
  name: string
  enable?: boolean
  type?: string
  root?: string
  url?: string
  readOnly?: boolean
  remark?: string
}

export interface AccessEntry {
  time: string
  ruleId?: string
  rule?: string
  method?: string
  path?: string
  status?: number
  duration?: string
  durationMs?: number
  clientIp?: string
  userAgent?: string
  upstream?: string
  listen?: string
  bytes?: number
}

export interface ListResponse<T> {
  items: T[]
}

/* ------------------------------------------------------------------ 选项 */

export const TYPE_OPTIONS: SelectOption[] = [
  { value: 'proxy', label: '反向代理' },
  { value: 'redirect', label: '重定向' },
  { value: 'static', label: '静态托管' },
]

export const TYPE_LABEL: Record<string, string> = {
  proxy: '反向代理',
  redirect: '重定向',
  static: '静态托管',
}

export const TLS_OPTIONS: SelectOption[] = [
  { value: 'off', label: '关闭（纯 HTTP）' },
  { value: 'auto', label: '自动证书（ACME）' },
  { value: 'custom', label: '指定证书' },
]

export const TLS_LABEL: Record<string, string> = {
  off: '关闭',
  auto: '自动证书',
  custom: '指定证书',
}

export const ACCESS_OPTIONS: SelectOption[] = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许以下列表）' },
  { value: 'deny', label: '黑名单（拒绝以下列表）' },
]

export const BALANCE_OPTIONS: SelectOption[] = [
  { value: 'roundrobin', label: '轮询' },
  { value: 'random', label: '随机' },
  { value: 'iphash', label: 'IP 哈希' },
]

const BALANCE_LABEL: Record<string, string> = {
  roundrobin: '轮询',
  random: '随机',
  iphash: 'IP 哈希',
  round_robin: '轮询',
  ip_hash: 'IP 哈希',
  least_conn: '最少连接',
}

const BALANCE_ALIASES: Record<string, string> = {
  round_robin: 'roundrobin',
  ip_hash: 'iphash',
  least_conn: 'roundrobin',
}

export const REDIRECT_STATUS_OPTIONS: SelectOption[] = [
  { value: '301', label: '301 永久重定向' },
  { value: '302', label: '302 临时重定向' },
  { value: '307', label: '307 保持方法' },
  { value: '308', label: '308 永久且保持方法' },
]

/* ------------------------------------------------------------------ 工具 */

export function normalizeTLSMode(value: unknown): TLSMode {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === 'auto' || mode === 'custom') return mode
  return 'off'
}

export function normalizeAccessMode(value: unknown): AccessMode {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === 'allow' || mode === 'deny') return mode
  return 'off'
}

export function balanceValue(value: unknown): string {
  const key = String(value ?? '').trim()
  if (BALANCE_OPTIONS.some((item) => item.value === key)) return key
  return BALANCE_ALIASES[key] || 'roundrobin'
}

export function balanceLabel(value: unknown): string {
  const key = String(value ?? '').trim()
  return BALANCE_LABEL[key] || key || '轮询'
}

export function tlsModeOf(listener: WebListener | null | undefined): TLSMode {
  return normalizeTLSMode(listener?.tls?.mode)
}

export function ruleTypeLabel(type: unknown): string {
  const key = String(type ?? '')
  return TYPE_LABEL[key] || key || '-'
}

export function ruleTypeColor(type: unknown): 'primary' | 'warning' | 'success' | 'default' {
  if (type === 'proxy') return 'primary'
  if (type === 'redirect') return 'warning'
  if (type === 'static') return 'success'
  return 'default'
}

export function tlsColor(mode: TLSMode): 'primary' | 'success' | 'default' {
  if (mode === 'auto') return 'success'
  if (mode === 'custom') return 'primary'
  return 'default'
}

export function targetText(rule: WebRule): string {
  if (rule.type === 'proxy') {
    const targets = Array.isArray(rule.proxy?.targets) ? rule.proxy?.targets ?? [] : []
    if (!targets.length) return '-'
    const extra =
      targets.length > 1
        ? `（${balanceLabel(rule.proxy?.balance)}，共 ${targets.length} 个）`
        : ''
    return `${targets[0]}${extra}`
  }
  if (rule.type === 'redirect') {
    const redirect = rule.redirect
    return `${redirect?.to || '-'} [${redirect?.status || 302}]`
  }
  if (rule.type === 'static') {
    const stat = rule.static
    return stat?.mountId ? `挂载: ${stat.mountId}` : stat?.root || '-'
  }
  return '-'
}

export function certOf(certId: string | undefined, certificates: Certificate[]): Certificate | null {
  if (!certId) return null
  return certificates.find((cert) => cert.id === certId) || null
}

export function certDomainsText(certId: string | undefined, certificates: Certificate[]): string {
  if (!certId) return '未选择证书'
  const cert = certOf(certId, certificates)
  if (!cert) return `证书 ${certId}（未找到）`
  const domains = Array.isArray(cert.domains) ? cert.domains : []
  return domains.length ? domains.join(', ') : cert.id
}

export function certTooltip(certId: string | undefined, certificates: Certificate[]): string {
  const cert = certOf(certId, certificates)
  if (!cert) return certId ? `证书 ${certId} 不在证书列表中` : '没有选择证书'
  const parts = [`到期 ${fmtTime(cert.notAfter)}`]
  if (cert.issuer) parts.push(`签发者 ${cert.issuer}`)
  if (cert.expired) parts.push('已过期')
  return parts.join(' · ')
}

export function certOptions(certificates: Certificate[]): SelectOption[] {
  return certificates.map((cert) => {
    const domains = (Array.isArray(cert.domains) ? cert.domains : []).join(', ') || cert.id
    return {
      value: cert.id,
      label: `${domains}${cert.expired ? '（已过期）' : ''} · 到期 ${fmtTime(cert.notAfter)}`,
    }
  })
}

export function listenerOptions(listeners: WebListenerView[]): SelectOption[] {
  return listeners.map((listener) => ({
    value: listener.id,
    label: `${listener.name || listener.id}（${(Array.isArray(listener.listen) ? listener.listen : []).join(', ')}）`,
  }))
}

export function listenerName(listeners: WebListenerView[], listenerId: string): string {
  const listener = listeners.find((item) => item.id === listenerId)
  return listener ? listener.name || listener.id : listenerId || '未绑定'
}

export function kvToText(map: Record<string, string> | undefined): string {
  return Object.entries(map || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

export function textToKV(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).trim()
  }
  return out
}
