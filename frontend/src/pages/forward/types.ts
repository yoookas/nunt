import { emptyAccess, normalizeAccess, type Access } from '../../access'
// Types and small helpers for the port forwarding page. The shapes mirror the
// Go API in internal/modules/forward and internal/model so the page can stay
// typed without reaching for `any` on every response.

export interface SelectOption {
  value: string
  label: string
}

export const PROTOCOL_OPTIONS: SelectOption[] = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'both', label: 'TCP + UDP' },
]

export const PROTOCOL_LABEL: Record<string, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  both: 'TCP + UDP',
}

export const ACCESS_OPTIONS: SelectOption[] = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许列表中的来源）' },
  { value: 'deny', label: '黑名单（拒绝列表中的来源）' },
]

/** A rule as returned by GET /api/v1/forward/rules (config + live counters). */
export interface ForwardRule {
  id: string
  name?: string
  enable?: boolean
  /** Switched off automatically because the listen port is taken. */
  disabled?: boolean
  protocol?: string
  srcAddr?: string
  dstAddr?: string
  timeoutSec?: number
  maxConns?: number
  maxConnsPerIP?: number
  access?: Access
  remark?: string
  activeConns?: number
  totalConns?: number
  upBytes?: number
  downBytes?: number
  listening?: boolean
  /** The configured caps after the backend filled in its defaults. */
  connLimit?: number
  connLimitPerIp?: number
  rejectedRuleLimit?: number
  rejectedIpLimit?: number
}

/** One line of the in-memory access log buffer. */
export interface ForwardLog {
  key?: string
  time?: string
  ruleId?: string
  rule?: string
  protocol?: string
  client?: string
  target?: string
  result?: string
  /** Connection lifetime in nanoseconds. */
  duration?: number
  bytesIn?: number
  bytesOut?: number
  packets?: number
}

export interface ForwardLogsResponse {
  items?: ForwardLog[]
  total?: number
  enabled?: boolean
}

/* ------------------------------------------------------------------ 表单 */

export interface RuleFormValues {
  name: string
  protocol: string
  srcAddr: string
  dstAddr: string
  timeoutSec: number
  maxConns: number
  maxConnsPerIP: number
  access: Access
  remark: string
}

export function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function emptyRuleForm(): RuleFormValues {
  return {
    name: '',
    protocol: 'tcp',
    srcAddr: '',
    dstAddr: '',
    timeoutSec: 0,
    maxConns: 0,
    maxConnsPerIP: 0,
    access: emptyAccess(),
    remark: '',
  }
}

export function ruleFormValues(rule?: ForwardRule | null): RuleFormValues {
  if (!rule) return emptyRuleForm()
  const access = rule.access || {}
  return {
    name: rule.name || '',
    protocol: PROTOCOL_LABEL[rule.protocol || ''] ? rule.protocol || 'tcp' : 'tcp',
    srcAddr: rule.srcAddr || '',
    dstAddr: rule.dstAddr || '',
    timeoutSec: num(rule.timeoutSec),
    maxConns: num(rule.maxConns),
    maxConnsPerIP: num(rule.maxConnsPerIP),
    access: normalizeAccess(access),
    remark: rule.remark || '',
  }
}

/**
 * buildRulePayload mirrors the payload of the previous UI. The geo list is
 * dropped when the filter is off: the backend rejects a geo list without an
 * allow/deny mode, and a hidden list must not block a save. The User-Agent
 * filter is carried over untouched: the forwarder does not evaluate it, and
 * dropping it here would silently erase a value written by an older build.
 */
export function buildRulePayload(
  values: RuleFormValues,
  options: { enable: boolean },
): Record<string, unknown> {
  const protocol = PROTOCOL_LABEL[values.protocol || ''] ? values.protocol : 'tcp'
  return {
    name: String(values.name ?? '').trim(),
    enable: options.enable !== false,
    protocol,
    srcAddr: String(values.srcAddr ?? '').trim(),
    dstAddr: String(values.dstAddr ?? '').trim(),
    timeoutSec: num(values.timeoutSec),
    maxConns: num(values.maxConns),
    maxConnsPerIP: num(values.maxConnsPerIP),
    access: normalizeAccess(values.access),
    remark: String(values.remark ?? '').trim(),
  }
}

/* ------------------------------------------------------------------ 展示 */

/** Nanoseconds (Go time.Duration) to a compact human readable string. */
export function durationText(value: unknown): string {
  const ns = Number(value)
  if (!Number.isFinite(ns) || ns <= 0) return '-'
  const ms = ns / 1e6
  if (ms < 1) return `${Math.max(1, Math.round(ns / 1e3))} µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`
  const min = Math.floor(sec / 60)
  const rest = Math.round(sec % 60)
  if (min < 60) return `${min} 分 ${rest} 秒`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

export function protocolColor(protocol: unknown): string {
  if (protocol === 'udp') return 'gold'
  if (protocol === 'both') return 'green'
  return 'blue'
}

export function logResultColor(result: unknown): string {
  const text = String(result || '')
  if (text === 'closed') return 'green'
  if (text.startsWith('rejected')) return 'gold'
  if (text.startsWith('denied') || text.startsWith('failed')) return 'red'
  return 'default'
}

/**
 * listenError validates the minimal shape the backend requires: host:port with
 * a numeric port. It stays permissive about the host so `:3389`, `0.0.0.0:80`
 * and `[::1]:443` all pass.
 */
export function listenError(value: unknown, label: string): string | null {
  const text = String(value ?? '').trim()
  if (!text) return `请填写${label}`
  if (!text.includes(':')) return `${label}必须包含端口，例如 :3389`
  const index = text.lastIndexOf(':')
  const port = text.slice(index + 1)
  if (!/^\d+$/.test(port)) return `${label}的端口必须是数字`
  const number = Number(port)
  if (number < 1 || number > 65535) return `${label}的端口必须在 1-65535 之间`
  return null
}
