// Types and helpers for the WAF page. They mirror internal/modules/waf.

export type WafMode = 'detect' | 'block'

export interface WafConfig {
  enable: boolean
  mode: string
  logOnly: boolean
  useCrs: boolean
  paranoiaLevel: number
  executingLevel: number
  inboundThreshold: number
  outboundThreshold: number
  bodyLimitKb: number
  adminProtect: boolean
  disabledRules: string[]
  extraRules: string
  ruleFiles?: string[]
}

export interface WafForm {
  enable: boolean
  mode: WafMode
  logOnly: boolean
  useCrs: boolean
  paranoiaLevel: number
  executingLevel: number
  inboundThreshold: number
  outboundThreshold: number
  bodyLimitKb: number
  adminProtect: boolean
  disabledRules: string[]
  extraRules: string
}

export interface WafEngine {
  enabled: boolean
  detail?: string
  error?: string
  mode?: string
  logOnly?: boolean
  useCrs?: boolean
  crsVersion?: string
  crsFallback?: boolean
  rules?: number
  ruleFiles?: number
  builtAt?: string
}

export interface WafStats {
  enabled?: boolean
  mode?: string
  logOnly?: boolean
  useCrs?: boolean
  paranoiaLevel?: number
  executingLevel?: number
  inboundThreshold?: number
  outboundThreshold?: number
  bodyLimitKb?: number
  adminProtect?: boolean
  requests?: number
  blocked?: number
  detected?: number
  passed?: number
  errors?: number
  tests?: number
  events?: number
  rules?: number
  ruleFiles?: number
  detail?: string
  crsFallback?: boolean
  builtAt?: string
  crsVersion?: string
  buildError?: string
}

export interface WafConfigResponse {
  config?: WafConfig
  engine?: WafEngine
  stats?: WafStats
}

export interface WafRuleFile {
  file: string
  name?: string
  group?: string
  title?: string
  titleEn?: string
  tag?: string
  rules: number
  minId?: number
  maxId?: number
  disableRange?: string
  required?: boolean
  builtin?: boolean
  enabled?: boolean
  reason?: string
}

export interface WafRulesResponse {
  items?: WafRuleFile[]
  crsVersion?: string
  useCrs?: boolean
  mode?: string
  disabledRules?: string[]
}

export interface WafMatchedRule {
  id: number
  message?: string
  data?: string
  severity?: string
  phase?: number
  file?: string
  line?: number
  tags?: string[]
  log?: boolean
}

export interface WafTestResult {
  blocked: boolean
  enforced: boolean
  mode?: string
  logOnly?: boolean
  action?: string
  status?: number
  ruleId?: number
  message?: string
  matched?: WafMatchedRule[]
  txId?: string
  durationMs?: number
  error?: string
}

export interface WafLog {
  time: string
  ruleId?: number
  message?: string
  clientIp?: string
  method?: string
  host?: string
  uri?: string
  rule?: string
  action: string
  status?: number
  severity?: string
  tags?: string[]
  ruleIds?: number[]
  txId?: string
  requestId?: string
  proto?: string
  tls?: string
}

export interface WafLogsResponse {
  items?: WafLog[]
  count?: number
  total?: number
}

export const MODE_OPTIONS: { value: WafMode; label: string }[] = [
  { value: 'detect', label: '检测模式' },
  { value: 'block', label: '拦截模式' },
]

export const LEVEL_OPTIONS = [1, 2, 3, 4].map((value) => ({ value, label: `PL${value}` }))

export const TEST_METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
  (value) => ({ value, label: value }),
)

export const GROUP_LABEL: Record<string, string> = {
  request: '请求',
  response: '响应',
  setup: '初始化',
}

export const EMPTY_WAF_FORM: WafForm = {
  enable: false,
  mode: 'detect',
  logOnly: false,
  useCrs: true,
  paranoiaLevel: 1,
  executingLevel: 1,
  inboundThreshold: 5,
  outboundThreshold: 4,
  bodyLimitKb: 128,
  adminProtect: true,
  disabledRules: [],
  extraRules: '',
}

export function clampLevel(value: unknown, fallback = 1): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(4, Math.max(1, Math.floor(number)))
}

export function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.floor(number)
}

export function nonNegativeInt(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

export function toWafForm(config?: Partial<WafConfig> | null): WafForm {
  const source = config || {}
  const paranoia = clampLevel(source.paranoiaLevel, 1)
  return {
    enable: !!source.enable,
    mode: source.mode === 'detect' ? 'detect' : 'block',
    logOnly: !!source.logOnly,
    useCrs: source.useCrs !== false,
    paranoiaLevel: paranoia,
    executingLevel: clampLevel(source.executingLevel, paranoia),
    inboundThreshold: positiveInt(source.inboundThreshold, 5),
    outboundThreshold: positiveInt(source.outboundThreshold, 4),
    bodyLimitKb: nonNegativeInt(source.bodyLimitKb),
    adminProtect: source.adminProtect !== false,
    disabledRules: Array.isArray(source.disabledRules) ? source.disabledRules.map(String) : [],
    extraRules: source.extraRules || '',
  }
}

export function normalizeDisabledRules(items: string[] | undefined): string[] {
  const out: string[] = []
  for (const entry of items || []) {
    const value = String(entry || '').trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

export function ruleRange(record: WafRuleFile): string {
  const min = Number(record.minId)
  const max = Number(record.maxId)
  return min > 0 && max > 0 ? `${min}-${max}` : ''
}

/** Parses a rule id or an inclusive "start-end" range. */
export function parseRange(value: unknown): [number, number] | null {
  const text = String(value || '').trim()
  if (!/^\d{1,9}(?:-\d{1,9})?$/.test(text)) return null
  const parts = text.split('-')
  const start = Number(parts[0])
  const end = parts.length === 2 ? Number(parts[1]) : start
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null
  return [start, end]
}

export function isRuleDisabled(disabledRules: string[], record: WafRuleFile): boolean {
  const target = parseRange(record.disableRange || ruleRange(record))
  if (!target) return false
  return disabledRules.some((entry) => {
    const range = parseRange(entry)
    return !!range && range[0] <= target[0] && range[1] >= target[1]
  })
}

export function ruleDisabledByServer(record: WafRuleFile): boolean {
  if (record.enabled !== false) return false
  const reason = String(record.reason || '')
  return !!reason && reason !== 'crs disabled' && reason !== 'disabled by rule id range'
}

export function actionLabel(action: string): string {
  if (action === 'deny') return '拦截'
  if (action === 'detect') return '检测'
  return action || '-'
}

export function actionColor(action: string): string {
  if (action === 'deny') return 'red'
  if (action === 'detect') return 'orange'
  return 'default'
}

export function ruleIdsOf(record: WafLog): number[] {
  const ids: number[] = []
  if (Array.isArray(record.ruleIds)) ids.push(...record.ruleIds)
  if (record.ruleId && !ids.includes(record.ruleId)) ids.push(record.ruleId)
  return ids.filter((item) => item !== undefined && item !== null)
}
