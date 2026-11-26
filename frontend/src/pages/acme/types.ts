// Types and small helpers shared by the certificate page and its dialogs.
// They mirror the JSON produced by internal/modules/acme.

export type KeyType = 'ec256' | 'ec384' | 'rsa2048' | 'rsa4096'
export type Challenge = 'http' | 'dns' | 'tls'

export interface KeyOption {
  value: string
  label: string
}

export const KEY_OPTIONS: KeyOption[] = [
  { value: 'ec256', label: 'ECDSA P-256（默认）' },
  { value: 'ec384', label: 'ECDSA P-384' },
  { value: 'rsa2048', label: 'RSA 2048' },
  { value: 'rsa4096', label: 'RSA 4096' },
]

export const CHALLENGE_OPTIONS: { value: Challenge; label: string }[] = [
  { value: 'http', label: 'HTTP-01（需要 80 端口可访问）' },
  { value: 'dns', label: 'DNS-01（泛域名必须使用）' },
  { value: 'tls', label: 'TLS-ALPN-01（需要 443 端口）' },
]

const CHALLENGE_LABEL: Record<Challenge, string> = {
  http: 'HTTP-01',
  dns: 'DNS-01',
  tls: 'TLS-ALPN-01',
}

export interface ProviderField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
}

export interface Provider {
  id: string
  title: string
  fields: ProviderField[]
  authNote?: string
}

export interface AcmeJob {
  id: string
  name: string
  enable: boolean
  domains: string[]
  domainsJoined?: string
  keyType?: string
  challenge?: string
  dnsProvider?: string
  dnsCreds?: Record<string, string>
  dnsResolvers?: string[]
  renewDays?: number
  remark?: string
  createdAt?: string
  hasCreds?: boolean
}

export interface AcmeJobPayload {
  name: string
  enable: boolean
  domains: string[]
  keyType: KeyType
  challenge: Challenge
  dnsProvider: string
  dnsCreds: Record<string, string>
  dnsResolvers: string[]
  renewDays: number
  remark: string
}

export interface Certificate {
  id: string
  domains: string[]
  issuer: string
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

export interface AcmeConfig {
  email: string
  keyType: string
  staging?: boolean
  directory?: string
  keyTypes?: { id: string; title: string }[]
}

export interface AccountPayload {
  email: string
  keyType: KeyType
  staging: boolean
}

export interface UploadPayload {
  name: string
  domains: string[]
  cert: string
  certificate: string
  key: string
  privateKey: string
  chain?: string
}

export interface AcmeStatusStats {
  jobs?: number
  enabledJobs?: number
  certificates?: number
  domains?: number
  validCertificates?: number
  nextExpiry?: string
  nextExpiryId?: string
  nextExpiryDays?: number
  lastError?: string | null
  challenge?: string
}

export interface AcmeModuleStatus {
  name?: string
  title?: string
  running?: boolean
  detail?: string
  error?: string
  since?: string
  stats?: AcmeStatusStats
}

export interface AcmeStatusResponse {
  status?: AcmeModuleStatus
  challenges?: { id: string; wire: string; title: string }[]
}

export function normalizeKeyType(value: unknown): KeyType {
  const key = String(value || '').trim().toLowerCase()
  return KEY_OPTIONS.some((item) => item.value === key) ? (key as KeyType) : 'ec256'
}

export function normalizeChallenge(value: unknown): Challenge {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'dns' || raw === 'dns-01') return 'dns'
  if (raw === 'tls' || raw === 'tls-alpn-01') return 'tls'
  return 'http'
}

export function keyLabel(value: unknown): string {
  const key = normalizeKeyType(value)
  return KEY_OPTIONS.find((item) => item.value === key)?.label || String(value || key)
}

export function challengeLabel(value: unknown): string {
  return CHALLENGE_LABEL[normalizeChallenge(value)]
}

export function challengeColor(value: unknown): string {
  const challenge = normalizeChallenge(value)
  if (challenge === 'dns') return 'purple'
  if (challenge === 'tls') return 'cyan'
  return 'blue'
}

export function sourceLabel(source?: string): string {
  if (!source) return '-'
  if (source === 'upload') return '上传'
  if (source === 'acme') return 'ACME'
  return source
}

export function certDomains(record: Certificate): string {
  return Array.isArray(record.domains) && record.domains.length ? record.domains.join(', ') : '-'
}

export function certDaysLeft(record: Certificate): number {
  const value = Number(record.daysLeft)
  return Number.isFinite(value) ? value : 0
}

export function certState(record: Certificate): { color: string; label: string } {
  const days = certDaysLeft(record)
  if (record.expired) return { color: 'red', label: '已过期' }
  if (days <= 0) return { color: 'orange', label: '即将过期' }
  if (days <= 15) return { color: 'orange', label: '即将到期' }
  if (days <= 30) return { color: 'gold', label: '30 天内到期' }
  return { color: 'green', label: '有效' }
}

export function certDaysText(record: Certificate): string {
  if (record.expired) return '已过期'
  const days = certDaysLeft(record)
  if (days <= 0) return '不足 1 天'
  return `${days} 天`
}

export function baseDomain(value: string): string {
  return value.startsWith('*.') ? value.slice(2) : value
}

export function jobLabel(job: AcmeJob | null | undefined): string {
  if (!job) return ''
  return job.name || job.domainsJoined || (job.domains || []).join(', ') || job.id
}

export function normalizeProviders(list: unknown): Provider[] {
  let raw: unknown = list
  if (!Array.isArray(raw)) {
    const container = (raw || {}) as Record<string, unknown>
    raw = Array.isArray(container.items) ? container.items : []
  }
  return (raw as unknown[])
    .map((entry) => {
      const item = (entry || {}) as Record<string, unknown>
      return {
        id: String(item.id || ''),
        title: String(item.title || item.id || ''),
        fields: (Array.isArray(item.fields) ? item.fields : []).map((rawField) => {
          const field = (rawField || {}) as Record<string, unknown>
          return {
            key: String(field.key || ''),
            label: String(field.label || field.key || ''),
            secret: !!field.secret,
            required: !!field.required,
            placeholder: String(field.placeholder || ''),
            help: String(field.help || ''),
          }
        }),
        authNote: String(item.authNote || ''),
      }
    })
    .filter((item) => item.id)
}

export function parseKeyOptions(list?: { id: string; title: string }[]): KeyOption[] {
  const options = (Array.isArray(list) ? list : [])
    .map((item) => ({ value: String(item.id || ''), label: String(item.title || item.id || '') }))
    .filter((item) => item.value)
  return options.length ? options : KEY_OPTIONS
}

/** Finds the stored certificate that belongs to a job. */
export function matchCertForJob(job: AcmeJob, certs: Certificate[]): Certificate | undefined {
  const byID = certs.find((cert) => cert.jobId === job.id)
  if (byID) return byID
  const wanted = (job.domains || []).map(baseDomain).filter(Boolean)
  if (!wanted.length) return undefined
  return certs.find((cert) => {
    const names = (cert.domains || []).map(baseDomain)
    return wanted.every((name) => names.includes(name))
  })
}

export function jobRenewState(job: AcmeJob, cert?: Certificate): { color: string; label: string } {
  if (!job.enable) return { color: 'default', label: '已停用' }
  if (!cert) return { color: 'orange', label: '尚未签发' }
  const days = certDaysLeft(cert)
  const windowDays = Number(job.renewDays) || 30
  if (cert.expired || days <= 0) return { color: 'red', label: '已过期' }
  if (days <= windowDays) return { color: 'orange', label: '待续期' }
  return { color: 'green', label: '正常' }
}
