// Types and helpers for the dynamic DNS page. The shapes mirror the Go API in
// internal/modules/ddns and internal/dnsprov so the page stays typed.
import { splitLines } from '../../format'

export interface SelectOption {
  value: string
  label: string
}

export const RECORD_TYPE_OPTIONS: SelectOption[] = [
  { value: 'A', label: 'A（IPv4）' },
  { value: 'AAAA', label: 'AAAA（IPv6）' },
  { value: 'A_AND_AAAA', label: 'A + AAAA（同时更新）' },
]

export const IP_MODE_OPTIONS: SelectOption[] = [
  { value: 'interface', label: '网卡地址' },
  { value: 'url', label: 'URL 获取' },
  { value: 'static', label: '静态地址' },
]

export const IP_MODE_LABEL: Record<string, string> = {
  interface: '网卡地址',
  url: 'URL 获取',
  static: '静态地址',
}

/** What the backend echoes back for a stored secret. */
export const MASK = '********'

export interface ProviderField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
}

/** GET /api/v1/ddns/providers returns one of these per provider. */
export interface ProviderMeta {
  id: string
  title: string
  fields?: ProviderField[]
  authNote?: string
}

export interface DdnsGetIP {
  enable?: boolean
  mode?: string
  value?: string
  iface?: string
  regex?: string
}

/** Legacy custom-callback payload; preserved untouched by this page. */
export interface DdnsCallback {
  enable?: boolean
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  basicUser?: string
  basicPass?: string
  contentType?: string
  successCode?: number[]
}

export interface DdnsRule {
  id: string
  name?: string
  enable?: boolean
  provider: string
  /** Secrets arrive masked as ********. */
  creds?: Record<string, string>
  domain?: string
  subDomains?: string[]
  recordType?: string
  ttl?: number
  ipv4?: DdnsGetIP
  ipv6?: DdnsGetIP
  intervalSec?: number
  cron?: string
  callback?: DdnsCallback | null
  remark?: string
}

export interface DdnsRecord {
  time?: string
  ok?: boolean
  message?: string
}

export interface DdnsStatus {
  id: string
  name?: string
  enable?: boolean
  ipv4?: string
  ipv6?: string
  lastRun?: string
  lastSuccess?: string
  lastError?: string
  success?: number
  failures?: number
  records?: DdnsRecord[]
}

/* ------------------------------------------------------------------ 表单 */

export interface GetIPFormValues {
  enable: boolean
  mode: string
  value: string
  iface: string
  regex: string
}

export interface DdnsFormValues {
  name: string
  enable: boolean
  provider: string
  domain: string
  subDomainsText: string
  recordType: string
  creds: Record<string, string>
  ipv4: GetIPFormValues
  ipv6: GetIPFormValues
  ttl: number
  intervalSec: number
  cron: string
  remark: string
}

export function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function isMasked(value: unknown): boolean {
  const text = value == null ? '' : String(value).trim()
  return !text || text.includes(MASK)
}

export function fillCreds(
  fields: ProviderField[],
  seed?: Record<string, string> | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    out[field.key] = seed && seed[field.key] != null ? String(seed[field.key]) : ''
  }
  return out
}

export function emptyGetIP(enable: boolean): GetIPFormValues {
  return { enable, mode: 'url', value: '', iface: '', regex: '' }
}

export function getIPFormValues(value?: DdnsGetIP | null, enableDefault = false): GetIPFormValues {
  const source = value || {}
  return {
    enable: source.enable !== undefined ? Boolean(source.enable) : enableDefault,
    mode: IP_MODE_LABEL[source.mode || ''] ? source.mode || 'url' : 'url',
    value: source.value || '',
    iface: source.iface || '',
    regex: source.regex || '',
  }
}

export function ddnsFormValues(
  rule: DdnsRule | null,
  provider: string,
  fields: ProviderField[],
): DdnsFormValues {
  const subs = Array.isArray(rule?.subDomains) ? rule?.subDomains ?? [] : []
  return {
    name: rule?.name || '',
    enable: rule ? rule.enable !== false : true,
    provider: rule?.provider || provider || '',
    domain: rule?.domain || '',
    subDomainsText: subs.length ? subs.join('\n') : '@',
    recordType: rule?.recordType || 'A',
    creds: fillCreds(fields, rule?.creds),
    ipv4: getIPFormValues(rule?.ipv4, true),
    ipv6: getIPFormValues(rule?.ipv6, false),
    ttl: num(rule?.ttl) || 600,
    intervalSec: num(rule?.intervalSec) || 300,
    cron: rule?.cron || '',
    remark: rule?.remark || '',
  }
}

export function buildGetIP(group: GetIPFormValues): Record<string, unknown> {
  const mode = IP_MODE_LABEL[group.mode] ? group.mode : 'url'
  return {
    enable: Boolean(group.enable),
    mode,
    value: mode === 'interface' ? '' : String(group.value || '').trim(),
    iface: mode === 'interface' ? String(group.iface || '').trim() : '',
    regex: mode === 'url' ? String(group.regex || '').trim() : '',
  }
}

/**
 * buildDdnsPayload mirrors the payload of the previous UI. Only the fields of
 * the selected provider are sent: switching providers in the dialog leaves the
 * old provider's drafts in the form store, and those must not be persisted.
 * The legacy callback is carried over untouched.
 */
export function buildDdnsPayload(
  values: DdnsFormValues,
  options: {
    fields: ProviderField[]
    originalCreds?: Record<string, string> | null
    originalCallback?: DdnsCallback | null
    providerIsOriginal: boolean
  },
): Record<string, unknown> {
  const creds: Record<string, string> = {}
  if (options.fields.length) {
    for (const field of options.fields) {
      const value = values.creds ? values.creds[field.key] : ''
      creds[field.key] = value == null ? '' : String(value)
    }
  } else if (options.providerIsOriginal) {
    for (const [key, value] of Object.entries(options.originalCreds || {})) {
      creds[key] = String(value)
    }
  }
  const recordType = RECORD_TYPE_OPTIONS.some((item) => item.value === values.recordType)
    ? values.recordType
    : 'A'
  return {
    name: String(values.name || '').trim(),
    enable: values.enable !== false,
    provider: values.provider,
    creds,
    domain: String(values.domain || '').trim(),
    subDomains: splitLines(values.subDomainsText || ''),
    recordType,
    ttl: num(values.ttl),
    intervalSec: num(values.intervalSec),
    cron: String(values.cron || '').trim(),
    ipv4: buildGetIP(values.ipv4),
    ipv6: buildGetIP(values.ipv6),
    callback: options.originalCallback ?? null,
    remark: String(values.remark || '').trim(),
  }
}

/* ------------------------------------------------------------------ 校验 */

const IPV4_PART = /^\d{1,3}$/

export function staticIPError(family: 'ipv4' | 'ipv6', value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return family === 'ipv4' ? '请填写 IPv4 静态地址' : '请填写 IPv6 静态地址'
  if (family === 'ipv4') {
    const parts = text.split('.')
    if (parts.length !== 4) return 'IPv4 地址格式无效，例如 1.2.3.4'
    for (const part of parts) {
      if (!IPV4_PART.test(part) || Number(part) > 255) return 'IPv4 地址格式无效，例如 1.2.3.4'
    }
    return null
  }
  if (!text.includes(':') || text.includes(':::') || !/^[0-9a-fA-F:.]+$/.test(text)) {
    return 'IPv6 地址格式无效，例如 2001:db8::1'
  }
  if (text.split(':').length > 9) return 'IPv6 地址格式无效，例如 2001:db8::1'
  return null
}

export function cronError(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (text.startsWith('@')) return null
  if (text.split(/\s+/).length !== 5) return 'cron 需要 5 段，例如 */5 * * * *'
  return null
}

/* ------------------------------------------------------------------ 展示 */

export function providerTitle(providers: ProviderMeta[], id: string): string {
  const meta = providers.find((item) => item.id === id)
  return meta?.title || id || '-'
}

export function ipModeText(group?: DdnsGetIP | null): string {
  if (!group?.enable) return '关闭'
  return IP_MODE_LABEL[group.mode || ''] || group.mode || 'URL 获取'
}

export function scheduleText(rule: DdnsRule): string {
  const cron = String(rule.cron || '').trim()
  if (cron) return `cron ${cron}`
  return `每 ${num(rule.intervalSec) || 300} 秒`
}

export function statusMessage(row: DdnsStatus): string {
  if (row.lastError) return row.lastError
  const records = row.records || []
  if (!records.length) return '-'
  return records[records.length - 1].message || '-'
}
