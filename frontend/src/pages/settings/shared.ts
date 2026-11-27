// Shared types and small helpers for the settings page. The backend returns
// plain configuration documents; these interfaces mirror the JSON shapes of
// /api/v1/system/* so every panel can stay typed without a schema package.
import { ApiError } from '../../api'

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export interface SystemForm {
  adminListen: string
  baseUrl: string
  logLevel: string
  sessionTtlHours: number
  loginMaxFail: number
  loginLockMinutes: number
  trustProxy: boolean
  trustedProxies: string[]
  sessionBindIp: boolean
  theme: string
  adminAllowIps: string[]
}

export interface ListenState {
  /** Address the process is really listening on. */
  actual: string
  /** Value stored in config.json. */
  config: string
  /** "env" or "config". */
  source: string
  env: string
  applied: boolean
  notice: string
}

export interface AdminAllowInfo {
  restricted?: boolean
  failClosed?: boolean
  entries?: number
  valid?: number
  blocked?: number
  trustProxy?: boolean
  trustedProxies?: number
}

export interface SystemInfo {
  version?: VersionInfo
  startTime?: string
  dataDir?: string
  webRules?: number
  adminListen?: string
  adminListenConfig?: string
  adminListenSource?: string
  adminListenEnv?: string
  adminListenNotice?: string
  adminAllowList?: AdminAllowInfo | null
  certs?: { count?: number; loadErrors?: number }
  modules?: Array<{ name?: string; title?: string; running?: boolean }>
}

export interface SystemSettingsResponse extends Partial<SystemForm> {
  adminListenConfig?: string
  adminListenSource?: string
  adminListenEnv?: string
  adminListenApplied?: boolean
  adminListenNotice?: string
}

export interface VersionInfo {
  name?: string
  version?: string
  commit?: string
  buildTime?: string
  goVersion?: string
  os?: string
  arch?: string
}

export interface SystemStats {
  uptimeSec?: number
  startTime?: string
  heapBytes?: number
  goroutines?: number
  numCpu?: number
}

export interface LogForm {
  persist: boolean
  keepDays: number
  maxFileMb: number
  appMaxFileMb: number
  appKeepFiles: number
}

export interface LogFileRow {
  name: string
  size: number
  modTime: string
}

export interface BackupForm {
  enabled: boolean
  intervalHours: number
  keep: number
  dir: string
}

export interface BackupFile {
  name: string
  size: number
  modTime: string
}

export interface SessionRow {
  id?: string
  ip?: string
  userAgent?: string
  createdAt?: string
  expiresAt?: string
  current?: boolean
}

/* -------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------- */

export const EMPTY_SYSTEM: SystemForm = {
  adminListen: '',
  baseUrl: '',
  logLevel: 'info',
  sessionTtlHours: 12,
  loginMaxFail: 5,
  loginLockMinutes: 10,
  trustProxy: false,
  trustedProxies: [],
  sessionBindIp: false,
  theme: 'system',
  adminAllowIps: [],
}

export const EMPTY_LISTEN: ListenState = {
  actual: '',
  config: '',
  source: 'config',
  env: '',
  applied: true,
  notice: '',
}

export const EMPTY_LOG: LogForm = {
  persist: true,
  keepDays: 7,
  maxFileMb: 64,
  appMaxFileMb: 8,
  appKeepFiles: 3,
}

export const EMPTY_BACKUP: BackupForm = {
  enabled: false,
  intervalHours: 24,
  keep: 7,
  dir: '',
}

export const LOG_LEVELS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

export const THEMES = [
  { value: 'system', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
]

/* -------------------------------------------------------------------------
 * Normalisation
 * ---------------------------------------------------------------------- */

/** Accepts an array or a comma/space separated string and returns a clean list. */
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Most list endpoints return a bare array, but tolerate `{ items: [] }`. */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  const items = (value as { items?: unknown } | null | undefined)?.items
  return Array.isArray(items) ? (items as T[]) : []
}

/** Best effort URL of the admin console on a given listen address. */
export function adminListenURL(addr: string): string {
  const match = /:([0-9]+)\s*$/.exec(String(addr || '').trim())
  if (!match) return ''
  const location = window.location
  return `${location.protocol}//${location.hostname || 'localhost'}:${match[1]}/`
}

/* -------------------------------------------------------------------------
 * Downloads
 * ---------------------------------------------------------------------- */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadText(
  filename: string,
  content: string,
  mime = 'application/json;charset=utf-8',
): void {
  downloadBlob(new Blob([content], { type: mime }), filename)
}

function filenameFromDisposition(header: string, fallback: string): string {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim())
    } catch {
      return utf8[1].trim()
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  if (plain?.[1]) return plain[1].trim()
  return fallback
}

/**
 * Downloads an authenticated binary (backup archive or log file). A plain
 * <a href> also carries the session cookie, but it cannot report an error, so
 * the file is fetched explicitly and turned into a blob once the server
 * answered 2xx.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: '*/*' },
    })
  } catch {
    throw new ApiError('无法连接服务器，请检查网络或服务状态', 'network', 0)
  }

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`
    try {
      const data = await response.json()
      message = data?.error?.message || message
    } catch {
      /* not JSON: keep the status text */
    }
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('nunt:unauthorized'))
    }
    throw new ApiError(message, '', response.status)
  }

  const blob = await response.blob()
  const filename = filenameFromDisposition(
    response.headers.get('Content-Disposition') || '',
    fallbackName,
  )
  downloadBlob(blob, filename)
}

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

const IPV4 =
  '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}'
const IPV6 = '(?=[0-9a-fA-F:.]*:)[0-9a-fA-F:.]+'
/** IPv4/IPv6 with an optional CIDR suffix. The server is authoritative. */
export const ADDRESS_PATTERN = new RegExp(`^(?:${IPV4}(?:/(?:3[0-2]|[12]?\\d))?|${IPV6}(?:/(?:12[0-8]|1[01]\\d|[1-9]?\\d))?)$`)

/** `:8080`, `127.0.0.1:8080`, `[::1]:8080` or a hostname with a port. */
export const LISTEN_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)?:\d{1,5}$/

export function isValidListen(value: string): boolean {
  const text = String(value || '').trim()
  if (text === '') return true
  if (!LISTEN_PATTERN.test(text)) return false
  const port = Number(text.slice(text.lastIndexOf(':') + 1))
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function isValidBaseURL(value: string): boolean {
  const text = String(value || '').trim()
  if (!text) return true
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isValidAbsoluteDir(value: string): boolean {
  const text = String(value || '').trim()
  if (!text) return true
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text)
}
