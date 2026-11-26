import { fmtBytes, fmtTime } from '../../format'

/* -------------------------------------------------------------------------
 * Access log wire types (internal/api/logs.go + internal/logstore)
 * ---------------------------------------------------------------------- */

export interface AccessEntry {
  time: string
  source: string
  ruleId?: string
  rule?: string
  listen?: string
  host?: string
  method?: string
  path?: string
  status?: number
  clientIp?: string
  userAgent?: string
  upstream?: string
  upstreamStatus?: number
  attempts?: number
  durationMs?: number
  bytes?: number
  bytesIn?: number
  bytesOut?: number
  protocol?: string
  proto?: string
  tls?: string
  requestId?: string
  result?: string
  reason?: string
  error?: string
  wafAction?: string
  wafRuleId?: number
  message?: string
  country?: string
  province?: string
  city?: string
}

export interface AccessRow extends AccessEntry {
  /** Client-side key so a row can be appended more than once safely. */
  key: string
}

export interface AccessPage {
  items: AccessEntry[]
  nextCursor?: string
  hasMore: boolean
  scanned?: number
}

export interface StatCount {
  name: string
  count: number
}

export interface AccessStats {
  total: number
  bytes: number
  avgDurationMs: number
  bySource?: Record<string, number>
  byStatus?: Record<string, number>
  topIps?: StatCount[]
  topPaths?: StatCount[]
  topRules?: StatCount[]
  scanned?: number
  complete?: boolean
  files?: number
}

export interface AccessMeta {
  dir?: string
  persist?: boolean
  keepDays?: number
  maxFileMb?: number
  queued?: number
  written?: number
  dropped?: number
  totalBytes?: number
  files?: { name: string; size: number; day?: string; modTime?: string }[]
  lastError?: string
}

export type RangeKey = '1h' | '6h' | '24h' | '7d' | 'all'

const RANGE_SPAN: Record<string, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
}

/** RFC3339 start of the requested range; empty means "keep days". */
export function rangeStart(range: RangeKey): string {
  const span = RANGE_SPAN[range]
  return span ? new Date(Date.now() - span).toISOString() : ''
}

export function geoText(entry: AccessEntry): string {
  return [entry.country, entry.province, entry.city].filter(Boolean).join(' · ')
}

export function bytesText(entry: AccessEntry): string {
  const total = entry.bytes || (entry.bytesIn || 0) + (entry.bytesOut || 0)
  return total > 0 ? fmtBytes(total) : '-'
}

export function durationText(ms?: number): string {
  if (!ms || ms <= 0) return '-'
  if (ms >= 10_000) return `${Math.round(ms / 1000)} s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${ms} ms`
}

export function shortTime(value?: string | null): string {
  const full = fmtTime(value)
  if (full === '-') return full
  return full.slice(11)
}

export function fullTime(value?: string | null): string {
  return fmtTime(value)
}

/* -------------------------------------------------------------------------
 * Run log (SSE) wire types
 * ---------------------------------------------------------------------- */

export interface RawLog {
  time: string | null
  level: string
  msg: string
  attrs: Record<string, unknown> | null
}

export interface LogEntry extends RawLog {
  /** Monotonic key, never reused after clear. */
  key: number
}

export const MAX_LOG_ENTRIES = 1000

export const LEVEL_RANK: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  warning: 30,
  error: 40,
  fatal: 50,
}

export const LEVEL_OPTIONS = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug 及以上' },
  { value: 'info', label: 'info 及以上' },
  { value: 'warn', label: 'warn 及以上' },
  { value: 'error', label: 'error 及以上' },
]

/** Accepts the logging.Entry object, a bare string, or anything else. */
export function normalizeLog(input: unknown): RawLog | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return { time: null, level: 'info', msg: input, attrs: null }
  if (typeof input !== 'object') return { time: null, level: 'info', msg: String(input), attrs: null }

  const entry = input as Record<string, unknown>
  const rawTime = entry.time ?? entry.timestamp ?? null
  const attrs =
    entry.attrs && typeof entry.attrs === 'object' && !Array.isArray(entry.attrs)
      ? (entry.attrs as Record<string, unknown>)
      : null

  return {
    time: rawTime === null || rawTime === undefined || rawTime === '' ? null : String(rawTime),
    level: String(entry.level ?? entry.lvl ?? 'info').toLowerCase(),
    msg: String(entry.msg ?? entry.message ?? ''),
    attrs,
  }
}

/** Fingerprint used to drop the backlog the server replays on reconnect. */
export function logSignature(item: RawLog): string {
  let attrs = ''
  if (item.attrs) {
    try {
      attrs = JSON.stringify(item.attrs)
    } catch {
      attrs = ''
    }
  }
  return `${item.time || ''}|${item.level}|${item.msg}|${attrs}`
}

export function componentOf(attrs: Record<string, unknown> | null): string {
  if (!attrs) return ''
  const value = attrs.component
  return value === null || value === undefined ? '' : String(value)
}

function stringifyAttr(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** All attributes except `component` (that one has its own column). */
export function attrEntries(attrs: Record<string, unknown> | null): [string, string][] {
  if (!attrs) return []
  const out: [string, string][] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'component') continue
    out.push([key, stringifyAttr(value)])
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

/** One line of `key=value` pairs, used for the keyword match and the row title. */
export function attrsText(attrs: Record<string, unknown> | null): string {
  const entries = attrEntries(attrs)
  return entries.length ? `  ${entries.map(([key, value]) => `${key}=${value}`).join('  ')}` : ''
}

/** A lowercased haystack for the keyword filter. */
export function logHaystack(item: RawLog): string {
  return `${item.msg} ${componentOf(item.attrs)} ${attrsText(item.attrs)}`.toLowerCase()
}
