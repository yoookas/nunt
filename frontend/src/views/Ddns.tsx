import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Switch } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtTime, splitLines } from '../format'
import { usePolling } from '../usePolling'
import {
  ConfirmModal,
  DataTable,
  FormModal,
  NumberInput,
  Page,
  LiveStatus,
  PageHeader,
  Panel,
  SelectInput,
  StatCard,
  StatusChip,
  SwitchInput,
  TextAreaInput,
  TextInput,
  ToolbarSearch,
  toast,
  type Column,
} from '../ui'

const RECORD_TYPE_OPTIONS = [
  { value: 'A', label: 'A（IPv4）' },
  { value: 'AAAA', label: 'AAAA（IPv6）' },
  { value: 'A_AND_AAAA', label: 'A + AAAA（同时更新）' },
]

const IP_MODE_OPTIONS = [
  { value: 'interface', label: '网卡地址' },
  { value: 'url', label: 'URL 获取' },
  { value: 'static', label: '静态地址' },
]

const IP_MODE_LABEL: Record<string, string> = {
  interface: '网卡地址',
  url: 'URL 获取',
  static: '静态地址',
}

type AlertStatus = 'accent' | 'danger' | 'warning' | 'success'

interface ProviderField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
}

interface ProviderMeta {
  id: string
  title: string
  fields?: ProviderField[]
  authNote?: string
}

interface GetIPConfig {
  enable?: boolean
  mode?: string
  value?: string
  iface?: string
  regex?: string
}

interface DdnsCallback {
  [key: string]: unknown
}

interface DdnsRule {
  id: string
  name: string
  enable?: boolean
  provider: string
  creds?: Record<string, string>
  domain: string
  subDomains?: string[]
  recordType?: string
  ttl?: number
  ipv4?: GetIPConfig
  ipv6?: GetIPConfig
  intervalSec?: number
  cron?: string
  callback?: DdnsCallback | null
  remark?: string
}

interface DdnsRecord {
  key?: string
  time?: string
  ok?: boolean
  message?: string
}

interface DdnsStatus {
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

interface GetIPForm extends GetIPConfig {
  enable: boolean
  mode: string
  value: string
  iface: string
  regex: string
}

interface DdnsForm {
  name: string
  enable: boolean
  provider: string
  domain: string
  subDomainsText: string
  recordType: string
  ttl: number
  intervalSec: number
  cron: string
  remark: string
  ipv4: GetIPForm
  ipv6: GetIPForm
}

interface ProviderTestPayload {
  provider: string
  creds: Record<string, string>
  domain: string
  sub: string
  type: string
  fqdn: string
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function emptyGetIP(enable: boolean): GetIPForm {
  return { enable, mode: 'url', value: '', iface: '', regex: '' }
}

function ipForm(value: GetIPConfig | undefined, enableDefault: boolean): GetIPForm {
  const source = value || {}
  return {
    enable: source.enable !== undefined ? !!source.enable : enableDefault,
    mode: source.mode || 'url',
    value: source.value || '',
    iface: source.iface || '',
    regex: source.regex || '',
  }
}

function isMasked(value: unknown): boolean {
  const text = value == null ? '' : String(value).trim()
  return !text || text.includes('********')
}

function buildGetIP(group: GetIPForm) {
  const mode = group.mode || 'url'
  return {
    enable: !!group.enable,
    mode,
    value: mode === 'interface' ? '' : String(group.value || '').trim(),
    iface: mode === 'interface' ? String(group.iface || '').trim() : '',
    regex: mode === 'url' ? String(group.regex || '').trim() : '',
  }
}

function getIPError(group: GetIPForm, label: string): string {
  if (!group.enable) return ''
  if (group.mode !== 'static') return ''
  if (!String(group.value || '').trim()) return `请填写${label}`
  return ''
}

function InlineAlert({ status, children }: { status: AlertStatus; children: ReactNode }) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

function FormField({ full, error, children }: { full?: boolean; error?: string; children: ReactNode }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      {children}
      {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
    </div>
  )
}

function GroupHead({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div className="mt-5 mb-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <div className="text-sm font-semibold">{title}</div>
      {extra}
    </div>
  )
}

function SwitchInputLocal({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Switch isSelected={value} onChange={onChange}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <span className="text-sm">{label}</span>
        </Switch.Content>
      </Switch>
    </div>
  )
}

export default function Ddns() {
  const [rules, setRules] = useState<DdnsRule[]>([])
  const [statusList, setStatusList] = useState<DdnsStatus[]>([])
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [statusError, setStatusError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [keyword, setKeyword] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [originalProvider, setOriginalProvider] = useState('')
  const [originalCreds, setOriginalCreds] = useState<Record<string, string>>({})
  const [originalCallback, setOriginalCallback] = useState<DdnsCallback | null>(null)
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [credDrafts, setCredDrafts] = useState<Record<string, Record<string, string>>>({})
  const lastProviderRef = useRef('')
  const [advanced, setAdvanced] = useState(false)
  const [form, setForm] = useState<DdnsForm>(() => ({
    name: '',
    enable: true,
    provider: '',
    domain: '',
    subDomainsText: '@',
    recordType: 'A',
    ttl: 600,
    intervalSec: 300,
    cron: '',
    remark: '',
    ipv4: emptyGetIP(true),
    ipv6: emptyGetIP(false),
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const [testPayload, setTestPayload] = useState<ProviderTestPayload | null>(null)
  const [runTarget, setRunTarget] = useState<DdnsRule | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DdnsRule | null>(null)

  const [logOpen, setLogOpen] = useState(false)
  const [logTitle, setLogTitle] = useState('')
  const [logError, setLogError] = useState('')
  const [logRecords, setLogRecords] = useState<DdnsRecord[]>([])

  const providerMeta = (id: string) => providers.find((item) => item.id === id) || null

  const providerTitle = (id: string) => providerMeta(id)?.title || id || '-'

  const currentProvider = useMemo(
    () => providers.find((item) => item.id === form.provider) || null,
    [providers, form.provider],
  )
  const currentFields = currentProvider?.fields || []

  const providerOptions = useMemo(() => {
    const list = providers.map((item) => ({ value: item.id, label: item.title || item.id }))
    if (form.provider && !list.some((item) => item.value === form.provider)) {
      list.unshift({ value: form.provider, label: form.provider })
    }
    return list
  }, [providers, form.provider])

  const statusMap = useMemo(() => {
    const map: Record<string, DdnsStatus> = {}
    for (const item of statusList) {
      if (item?.id) map[item.id] = item
    }
    return map
  }, [statusList])

  const filteredRules = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return rules
    return rules.filter((rule) =>
      [rule.name, rule.domain, rule.provider, (rule.subDomains || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [rules, keyword])

  const summary = useMemo(() => {
    let enabled = 0
    let success = 0
    let failures = 0
    for (const rule of rules) if (rule.enable) enabled += 1
    for (const item of statusList) {
      success += num(item.success)
      failures += num(item.failures)
    }
    return { enabled, success, failures }
  }, [rules, statusList])

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      const data = await api.get<ProviderMeta[] | { providers?: ProviderMeta[]; items?: ProviderMeta[] }>(
        '/api/v1/ddns/providers',
      )
      setProviders(Array.isArray(data) ? data : data?.providers || data?.items || [])
      setProvidersError(null)
    } catch (err) {
      setProvidersError(err)
      setProviders([])
      toast.danger(errorText(err))
    } finally {
      setProvidersLoading(false)
    }
  }, [])

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<DdnsRule[] | { rules?: DdnsRule[]; items?: DdnsRule[] }>('/api/v1/ddns/rules')
      setRules(Array.isArray(data) ? data : data?.rules || data?.items || [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err)
      toast.danger(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const data = await api.get<DdnsStatus[] | { rules?: DdnsStatus[] }>('/api/v1/ddns/status')
      setStatusList(Array.isArray(data) ? data : data?.rules || [])
      setStatusError(null)
    } catch (err) {
      setStatusError(err)
      setStatusList([])
      toast.danger(errorText(err))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  // Success and failure counters come from the status endpoint; poll it so the
  // cards do not stay frozen at whatever the page saw when it opened.
  const refreshStatus = async () => {
    const data = await api.get<DdnsStatus[] | { rules?: DdnsStatus[] }>('/api/v1/ddns/status')
    setStatusList(Array.isArray(data) ? data : data?.rules || [])
  }

  // Rules carry the schedule and the last result, so they are polled too.
  const refreshRules = async () => {
    const data = await api.get<DdnsRule[] | { rules?: DdnsRule[]; items?: DdnsRule[] }>('/api/v1/ddns/rules')
    setRules(Array.isArray(data) ? data : data?.rules || data?.items || [])
  }

  const live = usePolling(async () => {
    await Promise.all([refreshStatus(), refreshRules()])
  }, 10000)

  useEffect(() => {
    void loadProviders()
    void loadRules()
    void loadStatus()
  }, [loadProviders, loadRules, loadStatus])

  const patchForm = (patch: Partial<DdnsForm>) => setForm((prev) => ({ ...prev, ...patch }))

  const patchIP = (which: 'ipv4' | 'ipv6', patch: Partial<GetIPForm>) =>
    setForm((prev) => ({ ...prev, [which]: { ...prev[which], ...patch } }))

  const fillCreds = (providerId: string, seed: Record<string, string> | null | undefined) => {
    const fields = providers.find((item) => item.id === providerId)?.fields || []
    const out: Record<string, string> = {}
    for (const field of fields) {
      out[field.key] = seed && seed[field.key] != null ? String(seed[field.key]) : ''
    }
    return out
  }

  const statusOf = (rule: DdnsRule): DdnsStatus | null => (rule?.id ? statusMap[rule.id] || null : null)

  const currentIPs = (rule: DdnsRule): string[] => {
    const state = statusOf(rule)
    if (!state) return []
    return [state.ipv4, state.ipv6].filter((ip): ip is string => Boolean(ip))
  }

  const ipModeLabel = (group: GetIPConfig | undefined): string => {
    if (!group?.enable) return '关闭'
    return IP_MODE_LABEL[group.mode || ''] || group.mode || 'URL 获取'
  }

  const scheduleLabel = (rule: DdnsRule): string => {
    if (rule?.cron) return `cron: ${rule.cron}`
    return `每 ${num(rule?.intervalSec) || 300} 秒`
  }

  const lastMessage = (row: DdnsStatus): string => {
    if (row?.lastError) return row.lastError
    const records = row?.records || []
    return records.length ? records[records.length - 1].message || '-' : '-'
  }

  const canReuseMask = (key: string): boolean =>
    Boolean(editingId && form.provider === originalProvider && originalCreds[key])

  const openCreate = () => {
    if (!providers.length) {
      toast.warning('还没有获取到 DNS 提供商列表，请先刷新重试')
      return
    }
    const provider = providers[0]?.id || ''
    setEditingId('')
    setOriginalProvider('')
    setOriginalCreds({})
    setOriginalCallback(null)
    setCredDrafts({})
    lastProviderRef.current = provider
    setCreds(fillCreds(provider, {}))
    setForm({
      name: '',
      enable: true,
      provider,
      domain: '',
      subDomainsText: '@',
      recordType: 'A',
      ttl: 600,
      intervalSec: 300,
      cron: '',
      remark: '',
      ipv4: emptyGetIP(true),
      ipv6: emptyGetIP(false),
    })
    setErrors({})
    setModalOpen(true)
  }

  const openEdit = (rule: DdnsRule) => {
    const provider = rule.provider || providers[0]?.id || ''
    const original = { ...(rule.creds || {}) }
    setEditingId(String(rule.id || ''))
    setOriginalProvider(rule.provider || '')
    setOriginalCreds(original)
    setOriginalCallback(rule.callback || null)
    setCredDrafts({})
    lastProviderRef.current = provider
    setCreds(fillCreds(provider, original))
    setForm({
      name: rule.name || '',
      enable: rule.enable !== false,
      provider,
      domain: rule.domain || '',
      subDomainsText: (Array.isArray(rule.subDomains) ? rule.subDomains : []).join('\n'),
      recordType: rule.recordType || 'A',
      ttl: num(rule.ttl),
      intervalSec: num(rule.intervalSec),
      cron: rule.cron || '',
      remark: rule.remark || '',
      ipv4: ipForm(rule.ipv4, false),
      ipv6: ipForm(rule.ipv6, false),
    })
    setAdvanced(
      Number(rule.ttl || 600) !== 600 ||
        Number(rule.intervalSec || 300) !== 300 ||
        !!rule.cron ||
        !!rule.remark,
    )
    setErrors({})
    setModalOpen(true)
  }

  const onProviderChange = (next: string) => {
    const prev = lastProviderRef.current
    if (prev && prev !== next) {
      const snapshot = { ...creds }
      setCredDrafts((drafts) => ({ ...drafts, [prev]: snapshot }))
    }
    const seed =
      credDrafts[next] || (editingId && next === originalProvider ? originalCreds : {})
    lastProviderRef.current = next
    setCreds(fillCreds(next, seed))
    setForm((prevForm) => ({ ...prevForm, provider: next }))
    setErrors((prevErrors) => {
      const nextErrors = { ...prevErrors }
      delete nextErrors.provider
      return nextErrors
    })
  }

  const buildCreds = (): Record<string, string> => {
    const out: Record<string, string> = {}
    if (currentFields.length) {
      for (const field of currentFields) {
        out[field.key] = creds[field.key] == null ? '' : String(creds[field.key])
      }
    } else if (editingId && form.provider === originalProvider) {
      Object.assign(out, originalCreds)
    }
    return out
  }

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {}
    if (!form.name.trim()) nextErrors.name = '请填写规则名称'
    if (!form.provider) nextErrors.provider = '请选择 DNS 提供商'
    if (!form.domain.trim()) nextErrors.domain = '请填写主域名'
    for (const field of currentFields) {
      if (!field.required) continue
      if (isMasked(creds[field.key]) && !canReuseMask(field.key)) {
        nextErrors[`cred-${field.key}`] = `请填写${field.label}`
      }
    }
    const ipv4Problem = getIPError(form.ipv4, ' IPv4 静态地址')
    const ipv6Problem = getIPError(form.ipv6, ' IPv6 静态地址')
    if (ipv4Problem) nextErrors.ipv4Value = ipv4Problem.trim()
    if (ipv6Problem) nextErrors.ipv6Value = ipv6Problem.trim()
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      toast.warning(Object.values(nextErrors)[0])
      return false
    }
    if (form.enable && !form.ipv4.enable && !form.ipv6.enable) {
      toast.warning('请至少启用 IPv4 或 IPv6 中的一种公网地址探测')
      return false
    }
    return true
  }

  const submitRule = async () => {
    if (!validate()) return
    const payload = {
      name: form.name.trim(),
      enable: !!form.enable,
      provider: form.provider,
      creds: buildCreds(),
      domain: form.domain.trim(),
      subDomains: splitLines(form.subDomainsText),
      recordType: form.recordType || 'A',
      ttl: num(form.ttl),
      intervalSec: num(form.intervalSec),
      cron: form.cron.trim(),
      ipv4: buildGetIP(form.ipv4),
      ipv6: buildGetIP(form.ipv6),
      // The callback editor is not part of this form; keep the saved one.
      callback: originalCallback,
      remark: form.remark.trim(),
    }
    setSaving(true)
    try {
      if (editingId) {
        await api.put(`/api/v1/ddns/rules/${encodeURIComponent(editingId)}`, payload)
        toast.success('规则已保存')
      } else {
        await api.post('/api/v1/ddns/rules', payload)
        toast.success('规则已创建')
      }
      setModalOpen(false)
      await Promise.all([loadRules(), loadStatus()])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const testProvider = () => {
    if (!form.domain.trim()) {
      toast.warning('请先填写主域名')
      return
    }
    if (!form.provider) {
      toast.warning('请先选择 DNS 提供商')
      return
    }
    if (!currentFields.length) {
      toast.danger('没有获取到当前提供商的字段元数据，无法测试')
      return
    }
    const missing = currentFields
      .filter((field) => field.required && isMasked(creds[field.key]))
      .map((field) => field.label)
    if (missing.length) {
      toast.warning(
        `测试需要重新填写凭据：${missing.join('、')}。已保存的凭据以掩码回显，无法直接用于测试。`,
      )
      return
    }
    const payloadCreds: Record<string, string> = {}
    for (const field of currentFields) {
      const value = creds[field.key] == null ? '' : String(creds[field.key])
      if (value && !value.includes('********')) payloadCreds[field.key] = value
    }
    const sub = splitLines(form.subDomainsText)[0] || '@'
    const type = form.recordType === 'AAAA' ? 'AAAA' : 'A'
    const fqdn = sub === '@' ? form.domain.trim() : `${sub}.${form.domain.trim()}`
    setTestPayload({
      provider: form.provider,
      creds: payloadCreds,
      domain: form.domain.trim(),
      sub,
      type,
      fqdn,
    })
  }

  const doTest = async (payload: ProviderTestPayload) => {
    setTestPayload(null)
    setTesting(true)
    try {
      const result = await api.post<{ record?: string; provider?: string }>('/api/v1/ddns/providers/test', {
        provider: payload.provider,
        creds: payload.creds,
        domain: payload.domain,
        sub: payload.sub,
        type: payload.type,
      })
      toast.success(`凭据格式有效：${result?.provider || providerTitle(payload.provider)}（未写入任何记录）`)
    } catch (err) {
      toast.danger(`测试失败：${errorText(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const toggleRule = async (rule: DdnsRule, value: boolean) => {
    const next = typeof value === 'boolean' ? value : !rule.enable
    const id = String(rule.id || '')
    setBusyId(id)
    try {
      await api.post(`/api/v1/ddns/rules/${encodeURIComponent(id)}/toggle`, { enable: next })
      toast.success(next ? '规则已启用' : '规则已停用')
      await Promise.all([loadRules(), loadStatus()])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const doRun = async (rule: DdnsRule) => {
    if (!rule.enable) {
      toast.warning('该规则未启用，请先启用后再执行')
      return
    }
    const id = String(rule.id || '')
    setBusyId(id)
    try {
      const result = await api.post<{ ipv4?: string; ipv6?: string; ok?: boolean; message?: string }>(
        `/api/v1/ddns/rules/${encodeURIComponent(id)}/run`,
      )
      const ip = [result?.ipv4, result?.ipv6].filter(Boolean).join(' / ')
      if (result?.ok === false) {
        toast.danger(`执行失败：${result.message || '未知错误'}`)
      } else {
        toast.success(ip ? `执行成功：当前 IP ${ip}` : result?.message || '执行完成')
      }
      await Promise.all([loadRules(), loadStatus()])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const doDelete = async (rule: DdnsRule) => {
    const id = String(rule.id || '')
    try {
      await api.del(`/api/v1/ddns/rules/${encodeURIComponent(id)}`)
      toast.success('规则已删除')
      await Promise.all([loadRules(), loadStatus()])
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const openStatusLog = (row: DdnsStatus) => {
    setLogTitle(`运行日志 · ${row?.name || row?.id || ''}`)
    setLogError(row?.lastError || '')
    const records = Array.isArray(row?.records) ? [...row.records].reverse() : []
    setLogRecords(records.map((item, index) => ({ ...item, key: `${item.time || ''}-${index}` })))
    setLogOpen(true)
  }

  const openRuleLogs = (rule: DdnsRule) => {
    const state = statusOf(rule) || { id: rule.id, name: rule.name || rule.id, records: [] }
    openStatusLog(state)
  }

  const columns: Column<DdnsRule>[] = [
    {
      key: 'name',
      title: '名称',
      render: (row) => (
        <div className="min-w-32">
          <div className="font-medium break-words">{row.name || row.id}</div>
          {row.remark ? <div className="text-xs break-words text-muted">{row.remark}</div> : null}
        </div>
      ),
    },
    {
      key: 'domain',
      title: '域名 / 子域',
      render: (row) => (
        <div className="min-w-36">
          <div className="font-mono text-xs break-all">{row.domain || '-'}</div>
          {Array.isArray(row.subDomains) && row.subDomains.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.subDomains.map((sub) => (
                <StatusChip key={sub} color="default">
                  {sub}
                </StatusChip>
              ))}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'provider',
      title: '提供商',
      render: (row) => <StatusChip color="primary">{providerTitle(row.provider)}</StatusChip>,
    },
    {
      key: 'recordType',
      title: '记录类型',
      render: (row) => <StatusChip color="default">{row.recordType || 'A'}</StatusChip>,
    },
    {
      key: 'probe',
      title: 'IP 探测',
      render: (row) => (
        <div className="whitespace-nowrap text-xs text-muted">
          <div>IPv4：{ipModeLabel(row.ipv4)}</div>
          <div>IPv6：{ipModeLabel(row.ipv6)}</div>
        </div>
      ),
    },
    {
      key: 'schedule',
      title: '调度',
      render: (row) => <span className="font-mono text-xs break-all">{scheduleLabel(row)}</span>,
    },
    {
      key: 'ip',
      title: '当前 IP',
      render: (row) => {
        const ips = currentIPs(row)
        if (!ips.length) return <span className="text-xs text-muted">-</span>
        return (
          <div className="font-mono text-xs">
            {ips.map((ip) => (
              <div key={ip} className="break-all">
                {ip}
              </div>
            ))}
          </div>
        )
      },
    },
    {
      key: 'status',
      title: '启停',
      render: (row) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Switch
            aria-label={`${row.name || row.id} 启停`}
            isSelected={!!row.enable}
            isDisabled={busyId === String(row.id || '')}
            onChange={(value) => void toggleRule(row, value)}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          <span className="text-xs text-muted">{row.enable ? '启用' : '停用'}</span>
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={busyId === String(row.id || '')}
            onPress={() => setRunTarget(row)}
          >
            执行
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => openRuleLogs(row)}>
            日志
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => openEdit(row)}>
            编辑
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => setDeleteTarget(row)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  const statusColumns: Column<DdnsStatus>[] = [
    {
      key: 'name',
      title: '规则',
      render: (row) => (
        <div className="min-w-28">
          <div className="font-medium break-words">{row.name || row.id}</div>
          <div className="text-xs text-muted">{row.enable ? '启用' : '停用'}</div>
        </div>
      ),
    },
    {
      key: 'ipv4',
      title: 'IPv4',
      render: (row) => <span className="font-mono text-xs break-all">{row.ipv4 || '-'}</span>,
    },
    {
      key: 'ipv6',
      title: 'IPv6',
      render: (row) => <span className="font-mono text-xs break-all">{row.ipv6 || '-'}</span>,
    },
    {
      key: 'lastRun',
      title: '上次执行',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.lastRun)}</span>,
    },
    {
      key: 'lastSuccess',
      title: '上次成功',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.lastSuccess)}</span>,
    },
    {
      key: 'counts',
      title: '成功 / 失败',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <StatusChip color="success">成功 {num(row.success)}</StatusChip>
          <StatusChip color={num(row.failures) ? 'danger' : 'default'}>失败 {num(row.failures)}</StatusChip>
        </div>
      ),
    },
    {
      key: 'message',
      title: '最近结果',
      render: (row) => (
        <span className="block max-w-64 truncate text-xs" title={lastMessage(row)}>
          {lastMessage(row)}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <Button size="sm" variant="tertiary" onPress={() => openStatusLog(row)}>
          日志
        </Button>
      ),
    },
  ]

  const logColumns: Column<DdnsRecord>[] = [
    {
      key: 'time',
      title: '时间',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.time)}</span>,
    },
    {
      key: 'ok',
      title: '结果',
      render: (row) => (
        <StatusChip color={row.ok ? 'success' : 'danger'}>{row.ok ? '成功' : '失败'}</StatusChip>
      ),
    },
    {
      key: 'message',
      title: '内容',
      render: (row) => <span className="text-xs break-words">{row.message || '-'}</span>,
    },
  ]

  return (
    <Page>
      <PageHeader
        title="动态域名"
        sub="把域名持续指向当前公网 IP：提供商凭据、探测方式、调度与运行状态"
        actions={
          <>
            <LiveStatus status={live} />
            <Button variant="primary" isDisabled={!providers.length} onPress={openCreate}>
              新建规则
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        {providersError ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-auto sm:min-w-64 sm:flex-1">
              <InlineAlert status="danger">无法读取 DNS 提供商列表：{errorText(providersError)}</InlineAlert>
            </div>
            <Button size="sm" variant="secondary" onPress={() => void loadProviders()}>
              重试
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatCard label="DDNS 规则" value={rules.length} hint={`启用 ${summary.enabled} 条`} />
          <StatCard label="已启用" value={summary.enabled} hint="当前参与调度的规则" />
          <StatCard label="累计成功" value={summary.success} hint="来自 /api/v1/ddns/status" />
          <StatCard label="累计失败" value={summary.failures} hint="失败原因可在运行日志中查看" />
        </div>

        <Panel
          title="DDNS 规则"
          extra={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <ToolbarSearch
                label="搜索规则"
                value={keyword}
                onChange={setKeyword}
                placeholder="搜索名称 / 域名 / 提供商 / 子域名"
                className="w-full sm:w-72"
              />
              <span className="whitespace-nowrap text-xs text-muted">
                共 {rules.length} 条 · 显示 {filteredRules.length} 条
              </span>
            </div>
          }
        >

          {loadError ? (
            <div className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-auto sm:min-w-64 sm:flex-1">
                  <InlineAlert status="danger">加载 DDNS 规则失败：{errorText(loadError)}</InlineAlert>
                </div>
                <Button size="sm" variant="secondary" onPress={() => void loadRules()}>
                  重试
                </Button>
              </div>
            </div>
          ) : null}

          <DataTable
            items={filteredRules}
            columns={columns}
            rowKey={(row) => String(row.id)}
            ariaLabel="DDNS 规则"
            empty={loading ? '加载中…' : rules.length ? '没有符合筛选条件的规则' : '还没有 DDNS 规则'}
          />
        </Panel>

        <Panel
          title="运行状态"
          extra={
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">来自 /api/v1/ddns/status</span>
              <Button size="sm" variant="secondary" isDisabled={statusLoading} onPress={() => void loadStatus()}>
                {statusLoading ? '刷新中…' : '刷新状态'}
              </Button>
            </div>
          }
        >
          {statusError ? (
            <div className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-auto sm:min-w-64 sm:flex-1">
                  <InlineAlert status="danger">加载运行状态失败：{errorText(statusError)}</InlineAlert>
                </div>
                <Button size="sm" variant="secondary" onPress={() => void loadStatus()}>
                  重试
                </Button>
              </div>
            </div>
          ) : null}

          <DataTable
            items={statusList}
            columns={statusColumns}
            rowKey={(row) => String(row.id)}
            ariaLabel="DDNS 运行状态"
            empty={
              statusLoading ? '加载中…' : '暂无运行状态，规则执行一次后这里会出现当前 IP、时间与结果'
            }
          />
        </Panel>
      </div>

      <FormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? '编辑 DDNS 规则' : '新建 DDNS 规则'}
        size="xl"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={() => setModalOpen(false)}>
              取消
            </Button>
            <Button variant="primary" isDisabled={saving} onPress={() => void submitRule()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div>
          <GroupHead title="基本信息" />
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
            <FormField error={errors.name}>
              <TextInput
                label="名称"
                value={form.name}
                onChange={(value) => patchForm({ name: value })}
                placeholder="例如：家里宽带"
                required
              />
            </FormField>
            <FormField>
              <div className="pt-6">
                <SwitchInputLocal
                  label="启用"
                  value={form.enable}
                  onChange={(value) => patchForm({ enable: value })}
                />
              </div>
            </FormField>
            <FormField full error={errors.provider}>
              <SelectInput
                label="DNS 提供商"
                value={form.provider}
                onChange={onProviderChange}
                options={providerOptions}
                placeholder="选择 DNS 提供商"
                required
                disabled={providersLoading}
                hint={
                  providersError ? (
                    '无法读取提供商元数据，请点上方重试。'
                  ) : currentProvider?.authNote ? (
                    currentProvider.authNote
                  ) : (
                    '提供商和凭据字段由 /api/v1/ddns/providers 动态提供。'
                  )
                }
              />
            </FormField>
          </div>

          <GroupHead
            title="提供商凭据"
            extra={
              <Button
                size="sm"
                variant="outline"
                isDisabled={testing || !form.provider}
                onPress={testProvider}
              >
                {testing ? '校验中…' : '校验凭据'}
              </Button>
            }
          />
          {providersError ? (
            <div className="mb-3">
              <InlineAlert status="danger">无法读取提供商字段：{errorText(providersError)}</InlineAlert>
            </div>
          ) : (
            <div className="mb-3">
              <InlineAlert status="accent">
                已保存的凭据以 ******** 回显，保持掩码表示不修改；校验凭据需要重新填写凭据。只校验格式，不会写入或删除解析记录。
              </InlineAlert>
            </div>
          )}
          {currentFields.length ? (
            <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
              {currentFields.map((field) => {
                const full = field.key === 'body' || field.key === 'headers' || field.key === 'url'
                const label = field.required ? `${field.label} *` : field.label
                const value = creds[field.key] == null ? '' : String(creds[field.key])
                const onChange = (next: string) => setCreds((prev) => ({ ...prev, [field.key]: next }))
                return (
                  <FormField key={field.key} full={full} error={errors[`cred-${field.key}`]}>
                    {field.secret ? (
                      <TextInput
                        label={label}
                        type="password"
                        value={value}
                        onChange={onChange}
                        placeholder={field.placeholder || '已保存的凭据不会回显'}
                        hint={field.help}
                        required={field.required}
                      />
                    ) : field.key === 'body' || field.key === 'headers' ? (
                      <TextAreaInput
                        label={label}
                        value={value}
                        onChange={onChange}
                        placeholder={field.placeholder || ''}
                        hint={field.help}
                        rows={3}
                      />
                    ) : (
                      <TextInput
                        label={label}
                        value={value}
                        onChange={onChange}
                        placeholder={field.placeholder || ''}
                        hint={field.help}
                        required={field.required}
                      />
                    )}
                  </FormField>
                )
              })}
            </div>
          ) : (
            <InlineAlert status="warning">
              没有获取到该提供商的字段说明；保存时会保留已保存的凭据不变。
            </InlineAlert>
          )}

          <GroupHead title="解析记录" />
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
            <FormField full error={errors.domain}>
              <TextInput
                label="主域名"
                value={form.domain}
                onChange={(value) => patchForm({ domain: value })}
                placeholder="example.com"
                hint="填写根域名；子域名在下一项单独维护。"
                required
              />
            </FormField>
            <FormField full>
              <TextAreaInput
                label="子域名"
                value={form.subDomainsText}
                onChange={(value) => patchForm({ subDomainsText: value })}
                placeholder={'每行一个：\n@\nwww\n*'}
                hint="每行一个；@ 表示主域名，* 表示泛解析；留空等同于 @。"
                rows={4}
              />
            </FormField>
            <FormField>
              <SelectInput
                label="记录类型"
                value={form.recordType}
                onChange={(value) => patchForm({ recordType: value })}
                options={RECORD_TYPE_OPTIONS}
                hint="实际写入的 A / AAAA 记录由下方 IPv4 / IPv6 探测开关决定。"
              />
            </FormField>
            <FormField full>
              <SwitchInput
                label="高级选项"
                value={advanced}
                onChange={setAdvanced}
                hint="TTL、检查间隔、Cron、备注；不展开也能正常保存"
              />
            </FormField>

            {advanced ? (
              <>
            <FormField>
              <NumberInput
                label="TTL（秒）"
                value={form.ttl}
                onChange={(value) => patchForm({ ttl: value })}
                min={0}
                max={86400}
                hint="0 表示由后端补默认值（600）。"
              />
            </FormField>
            <FormField>
              <NumberInput
                label="检查间隔（秒）"
                value={form.intervalSec}
                onChange={(value) => patchForm({ intervalSec: value })}
                min={0}
                max={604800}
                hint="cron 为空时按此间隔执行，默认 300 秒。"
              />
            </FormField>
            <FormField>
              <TextInput
                label="Cron 表达式"
                value={form.cron}
                onChange={(value) => patchForm({ cron: value })}
                placeholder="*/5 * * * *"
                hint="非空时优先于检查间隔。"
              />
            </FormField>
            <FormField full>
              <TextInput
                label="备注"
                value={form.remark}
                onChange={(value) => patchForm({ remark: value })}
                placeholder="备注（可选）"
              />
            </FormField>
              </>
            ) : null}
          </div>

          <GroupHead title="公网 IP 探测" extra={<span className="text-xs text-muted">至少启用一个地址族</span>} />
          <div className="mb-3 rounded-md border border-border bg-background-secondary p-3">
            <div className="mb-2 flex items-center gap-2">
              <Switch
                isSelected={form.ipv4.enable}
                onChange={(value) => patchIP('ipv4', { enable: value })}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              <strong className="text-sm">IPv4（A 记录）</strong>
            </div>
            {form.ipv4.enable ? (
              <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                <FormField>
                  <SelectInput
                    label="探测方式"
                    value={form.ipv4.mode}
                    onChange={(value) => patchIP('ipv4', { mode: value })}
                    options={IP_MODE_OPTIONS}
                  />
                </FormField>
                {form.ipv4.mode === 'interface' ? (
                  <FormField>
                    <TextInput
                      label="网卡名称"
                      value={form.ipv4.iface}
                      onChange={(value) => patchIP('ipv4', { iface: value })}
                      placeholder="留空自动选择默认网卡"
                    />
                  </FormField>
                ) : form.ipv4.mode === 'url' ? (
                  <>
                    <FormField>
                      <TextInput
                        label="获取地址"
                        value={form.ipv4.value}
                        onChange={(value) => patchIP('ipv4', { value })}
                        placeholder="https://api.ipify.org"
                        hint="返回纯文本 IP 的接口；留空时使用内置公共探测服务。"
                      />
                    </FormField>
                    <FormField>
                      <TextInput
                        label="提取正则"
                        value={form.ipv4.regex}
                        onChange={(value) => patchIP('ipv4', { regex: value })}
                        placeholder="可选：从响应中提取 IP 的正则"
                      />
                    </FormField>
                  </>
                ) : (
                  <FormField error={errors.ipv4Value}>
                    <TextInput
                      label="静态地址"
                      value={form.ipv4.value}
                      onChange={(value) => patchIP('ipv4', { value })}
                      placeholder="1.2.3.4"
                    />
                  </FormField>
                )}
              </div>
            ) : null}
          </div>

          <div className="mb-3 rounded-md border border-border bg-background-secondary p-3">
            <div className="mb-2 flex items-center gap-2">
              <Switch
                isSelected={form.ipv6.enable}
                onChange={(value) => patchIP('ipv6', { enable: value })}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              <strong className="text-sm">IPv6（AAAA 记录）</strong>
            </div>
            {form.ipv6.enable ? (
              <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                <FormField>
                  <SelectInput
                    label="探测方式"
                    value={form.ipv6.mode}
                    onChange={(value) => patchIP('ipv6', { mode: value })}
                    options={IP_MODE_OPTIONS}
                  />
                </FormField>
                {form.ipv6.mode === 'interface' ? (
                  <FormField>
                    <TextInput
                      label="网卡名称"
                      value={form.ipv6.iface}
                      onChange={(value) => patchIP('ipv6', { iface: value })}
                      placeholder="留空自动选择默认网卡"
                    />
                  </FormField>
                ) : form.ipv6.mode === 'url' ? (
                  <>
                    <FormField>
                      <TextInput
                        label="获取地址"
                        value={form.ipv6.value}
                        onChange={(value) => patchIP('ipv6', { value })}
                        placeholder="https://api64.ipify.org"
                        hint="返回纯文本 IPv6 的接口；留空时使用内置公共探测服务。"
                      />
                    </FormField>
                    <FormField>
                      <TextInput
                        label="提取正则"
                        value={form.ipv6.regex}
                        onChange={(value) => patchIP('ipv6', { regex: value })}
                        placeholder="可选：从响应中提取 IP 的正则"
                      />
                    </FormField>
                  </>
                ) : (
                  <FormField error={errors.ipv6Value}>
                    <TextInput
                      label="静态地址"
                      value={form.ipv6.value}
                      onChange={(value) => patchIP('ipv6', { value })}
                      placeholder="2001:db8::1"
                    />
                  </FormField>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </FormModal>

      <FormModal
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title={logTitle}
        size="xl"
        footer={
          <div className="flex justify-end">
            <Button variant="tertiary" onPress={() => setLogOpen(false)}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {logError ? <InlineAlert status="danger">最近错误：{logError}</InlineAlert> : null}
          <DataTable
            items={logRecords}
            columns={logColumns}
            rowKey={(row) => String(row.key)}
            ariaLabel="DDNS 运行日志"
            empty="暂无执行记录"
          />
        </div>
      </FormModal>

      <ConfirmModal
        open={!!testPayload}
        title="校验提供商凭据"
        confirmText="开始校验"
        content={
          testPayload
            ? `会使用当前表单中的凭据，校验「${providerTitle(testPayload.provider)}」的字段是否完整、客户端能否构造。不会写入或删除任何解析记录。确定继续？`
            : ''
        }
        onCancel={() => setTestPayload(null)}
        onConfirm={() => {
          const payload = testPayload
          if (payload) void doTest(payload)
        }}
      />

      <ConfirmModal
        open={!!runTarget}
        title="立即执行 DDNS 规则"
        confirmText="执行"
        content={`确定立即执行「${runTarget?.name || runTarget?.id || ''}」吗？会探测当前公网 IP 并按需写入 DNS 记录。`}
        onCancel={() => setRunTarget(null)}
        onConfirm={() => {
          const target = runTarget
          setRunTarget(null)
          if (target) void doRun(target)
        }}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title="删除 DDNS 规则"
        danger
        confirmText="删除"
        content={`确定删除「${deleteTarget?.name || deleteTarget?.id || ''}」吗？删除后不再自动更新该域名。`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void doDelete(target)
        }}
      />
    </Page>
  )
}
