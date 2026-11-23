import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tabs } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import {
  ConfirmModal,
  DataTable,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  SelectInput,
  StatusChip,
  SwitchInput,
  TagInput,
  TextAreaInput,
  TextInput,
  toast,
  type Column,
  type SelectOption,
} from '../ui'

type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'danger'
type WafMode = 'detect' | 'block'

const MODE_OPTIONS: SelectOption[] = [
  { value: 'detect', label: '检测模式（只记录不拦截）' },
  { value: 'block', label: '拦截模式' },
]

const LEVEL_OPTIONS: SelectOption[] = [1, 2, 3, 4].map((value) => ({
  value: String(value),
  label: `PL${value}`,
}))

const GROUP_LABEL: Record<string, string> = {
  request: '请求',
  response: '响应',
  setup: '初始化',
}

const TEST_METHODS: SelectOption[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
  (value) => ({ value, label: value }),
)

const LOG_FILTER_OPTIONS: SelectOption[] = [
  { value: 'all', label: '全部' },
  { value: 'deny', label: '拦截' },
  { value: 'detect', label: '检测' },
]

interface WafConfig {
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

interface WafEngine {
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

interface WafConfigResponse {
  config?: WafConfig
  engine?: WafEngine
}

interface WafRuleFile {
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

interface WafRulesResponse {
  items?: WafRuleFile[]
  crsVersion?: string
}

interface WafMatchedRule {
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

interface WafTestResult {
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

interface WafLog {
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
}

interface WafForm {
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

const EMPTY_FORM: WafForm = {
  enable: false,
  mode: 'detect',
  logOnly: false,
  useCrs: true,
  paranoiaLevel: 1,
  executingLevel: 1,
  inboundThreshold: 5,
  outboundThreshold: 4,
  bodyLimitKb: 0,
  adminProtect: true,
  disabledRules: [],
  extraRules: '',
}

function clampLevel(value: unknown, fallback = 1): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(4, Math.max(1, Math.floor(number)))
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.floor(number)
}

function nonNegativeInt(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function normalizeDisabledRules(items: string[]): string[] {
  const out: string[] = []
  for (const entry of items) {
    const value = String(entry || '').trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

function ruleRange(record: WafRuleFile): string {
  const min = Number(record.minId)
  const max = Number(record.maxId)
  return min > 0 && max > 0 ? `${min}-${max}` : ''
}

function parseRange(value: unknown): [number, number] | null {
  const parts = String(value || '').trim().split('-')
  if (parts.length !== 2) return null
  const start = Number(parts[0])
  const end = Number(parts[1])
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) return null
  return [start, end]
}

function actionLabel(action: string): string {
  if (action === 'deny') return '拦截'
  if (action === 'detect') return '检测'
  return action || '-'
}

function actionTone(action: string): ChipColor {
  if (action === 'deny') return 'danger'
  if (action === 'detect') return 'warning'
  return 'default'
}

function ruleIdsOf(record: WafLog): number[] {
  const ids: number[] = []
  if (Array.isArray(record.ruleIds)) ids.push(...record.ruleIds)
  if (record.ruleId && !ids.includes(record.ruleId)) ids.push(record.ruleId)
  return ids.filter((item) => item !== undefined && item !== null)
}

export default function Waf() {
  const [config, setConfig] = useState<WafConfig | null>(null)
  const [engine, setEngine] = useState<WafEngine | null>(null)
  const [rules, setRules] = useState<WafRuleFile[]>([])
  const [logs, setLogs] = useState<WafLog[]>([])
  const [crsVersion, setCrsVersion] = useState('')
  const [form, setForm] = useState<WafForm>({ ...EMPTY_FORM, disabledRules: [] })
  const [configLoading, setConfigLoading] = useState(true)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [ruleQuery, setRuleQuery] = useState('')
  const [logFilter, setLogFilter] = useState('')
  const [testResult, setTestResult] = useState<WafTestResult | null>(null)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [testForm, setTestForm] = useState({ method: 'GET', url: '', body: '', clientIp: '' })

  const logFilterRef = useRef(logFilter)

  useEffect(() => {
    logFilterRef.current = logFilter
  }, [logFilter])

  const syncForm = (source?: Partial<WafConfig> | null) => {
    const src = source || {}
    const paranoia = clampLevel(src.paranoiaLevel, 1)
    setForm({
      enable: !!src.enable,
      mode: src.mode === 'detect' ? 'detect' : 'block',
      logOnly: !!src.logOnly,
      useCrs: src.useCrs !== false,
      paranoiaLevel: paranoia,
      executingLevel: clampLevel(src.executingLevel, paranoia),
      inboundThreshold: positiveInt(src.inboundThreshold, 5),
      outboundThreshold: positiveInt(src.outboundThreshold, 4),
      bodyLimitKb: nonNegativeInt(src.bodyLimitKb),
      adminProtect: src.adminProtect !== false,
      disabledRules: Array.isArray(src.disabledRules) ? src.disabledRules.map((item) => String(item)) : [],
      extraRules: src.extraRules || '',
    })
  }

  const loadConfig = async (showError = true) => {
    setConfigLoading(true)
    try {
      const data = await api.get<WafConfigResponse>('/api/v1/waf/config')
      const next: WafConfig = data?.config || { ...EMPTY_FORM, ruleFiles: [] }
      setConfig(next)
      setEngine(data?.engine || null)
      syncForm(next)
    } catch (err) {
      if (showError) toast.danger(errorText(err))
    } finally {
      setConfigLoading(false)
    }
  }

  const loadRules = async (showError = true) => {
    setRulesLoading(true)
    try {
      const data = await api.get<WafRulesResponse>('/api/v1/waf/rules')
      setRules(Array.isArray(data?.items) ? data.items : [])
      setCrsVersion(data?.crsVersion || '')
    } catch (err) {
      if (showError) toast.danger(errorText(err))
    } finally {
      setRulesLoading(false)
    }
  }

  const loadLogs = async (silent = false, filter = logFilter) => {
    setLogsLoading(true)
    try {
      const data = await api.get<{ items?: WafLog[] }>('/api/v1/waf/logs', {
        limit: 200,
        action: filter || undefined,
      })
      setLogs(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      if (!silent) toast.danger(errorText(err))
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => {
    void loadConfig()
    void loadRules()
    void loadLogs()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadLogs(true, logFilterRef.current)
      }
    }, 10000)
    return () => window.clearInterval(timer)
    // The page performs its initial load once; the interval only refreshes logs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveConfig = async () => {
    if (!config) {
      toast.danger('配置尚未加载完成')
      return
    }
    const payload: WafConfig = {
      ...config,
      enable: !!form.enable,
      mode: form.mode,
      logOnly: !!form.logOnly,
      useCrs: !!form.useCrs,
      paranoiaLevel: clampLevel(form.paranoiaLevel, 1),
      executingLevel: clampLevel(form.executingLevel, clampLevel(form.paranoiaLevel, 1)),
      inboundThreshold: positiveInt(form.inboundThreshold, 5),
      outboundThreshold: positiveInt(form.outboundThreshold, 4),
      bodyLimitKb: nonNegativeInt(form.bodyLimitKb),
      adminProtect: !!form.adminProtect,
      disabledRules: normalizeDisabledRules(form.disabledRules),
      extraRules: form.extraRules || '',
      ruleFiles: Array.isArray(config.ruleFiles) ? config.ruleFiles : [],
    }

    setSaving(true)
    try {
      const data = await api.put<WafConfigResponse>('/api/v1/waf/config', payload)
      const next = data?.config || payload
      setConfig(next)
      setEngine(data?.engine || engine)
      syncForm(next)
      toast.success('WAF 配置已保存并重新编译')
      await loadRules()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const filteredRules = useMemo(() => {
    const query = ruleQuery.trim().toLowerCase()
    if (!query) return rules
    return rules.filter((item) =>
      [item.title, item.titleEn, item.file, item.name, item.group, item.tag]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }, [rules, ruleQuery])

  const isRuleDisabled = (record: WafRuleFile): boolean => {
    const target = parseRange(record.disableRange || ruleRange(record))
    if (!target) return false
    return form.disabledRules.some((entry) => {
      const range = parseRange(entry)
      return !!range && range[0] <= target[0] && range[1] >= target[1]
    })
  }

  const canToggleRule = (record: WafRuleFile): boolean =>
    !!form.useCrs && !record.required && !!(record.disableRange || ruleRange(record))

  const ruleEnabled = (record: WafRuleFile): boolean =>
    record.enabled !== false && !isRuleDisabled(record)

  const ruleState = (record: WafRuleFile): { label: string; color: ChipColor } => {
    if (!form.useCrs) return { label: 'CRS 已关闭', color: 'default' }
    if (isRuleDisabled(record)) return { label: '已禁用', color: 'default' }
    if (record.reason) return { label: record.reason, color: 'warning' }
    if (record.enabled === false) return { label: '未加载', color: 'warning' }
    return { label: '启用', color: 'success' }
  }

  const toggleRule = (record: WafRuleFile, enabled: boolean) => {
    if (!canToggleRule(record)) return
    const range = record.disableRange || ruleRange(record)
    const target = parseRange(range)
    if (!target) return
    const covered = (entry: string) => {
      const parsed = parseRange(entry)
      return !!parsed && parsed[0] <= target[0] && parsed[1] >= target[1]
    }
    setForm((prev) => {
      if (enabled) {
        return { ...prev, disabledRules: prev.disabledRules.filter((entry) => !covered(entry)) }
      }
      if (prev.disabledRules.some(covered)) return prev
      return { ...prev, disabledRules: [...prev.disabledRules, range] }
    })
  }

  const runTest = async () => {
    const url = testForm.url.trim()
    if (!url) {
      toast.warning('请填写要测试的 URL 或路径')
      return
    }
    const payload: { method: string; url: string; body: string; clientIp?: string } = {
      method: testForm.method,
      url,
      body: testForm.body,
    }
    if (testForm.clientIp.trim()) payload.clientIp = testForm.clientIp.trim()

    setTesting(true)
    try {
      setTestResult(await api.post<WafTestResult>('/api/v1/waf/test', payload))
    } catch (err) {
      const text = errorText(err)
      setTestResult({ blocked: false, enforced: false, status: 0, durationMs: 0, matched: [], error: text })
      toast.danger(text)
    } finally {
      setTesting(false)
    }
  }

  const changeLogFilter = (value: string) => {
    const next = value === 'all' ? '' : value
    setLogFilter(next)
    logFilterRef.current = next
    void loadLogs(false, next)
  }

  const clearLogs = async () => {
    setConfirmClearOpen(false)
    try {
      await api.del('/api/v1/waf/logs')
      toast.success('日志已清空')
      await loadLogs()
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const verdict = (() => {
    if (!testResult) return null
    if (testResult.error) return { color: 'danger' as ChipColor, text: `检测失败：${testResult.error}` }
    if (testResult.blocked && testResult.enforced) return { color: 'danger' as ChipColor, text: '请求会被拦截' }
    if (testResult.blocked) {
      return { color: 'warning' as ChipColor, text: '命中规则，但当前模式只记录、不实际拦截' }
    }
    return { color: 'success' as ChipColor, text: '未命中拦截规则' }
  })()

  const ruleColumns: Column<WafRuleFile>[] = [
    {
      key: 'title',
      title: '规则文件',
      render: (record) => (
        <div>
          <div className="text-xs">{record.title || record.name || record.file}</div>
          <div className="mono mt-0.5 text-xs text-muted">{record.file}</div>
        </div>
      ),
    },
    {
      key: 'group',
      title: '分组',
      render: (record) => <StatusChip>{GROUP_LABEL[record.group || ''] || record.group || '-'}</StatusChip>,
    },
    {
      key: 'rules',
      title: '规则数',
      render: (record) => String(record.rules ?? '-'),
    },
    {
      key: 'range',
      title: 'ID 区间',
      render: (record) => (
        <span className="mono text-xs">{record.disableRange || ruleRange(record) || '-'}</span>
      ),
    },
    {
      key: 'state',
      title: '状态',
      render: (record) => {
        const state = ruleState(record)
        return <StatusChip color={state.color}>{state.label}</StatusChip>
      },
    },
    {
      key: 'enabled',
      title: '启用',
      render: (record) => (
        <SwitchInput
          label="启用"
          value={ruleEnabled(record)}
          disabled={!canToggleRule(record)}
          onChange={(next) => toggleRule(record, next)}
        />
      ),
    },
  ]

  const matchedColumns: Column<WafMatchedRule>[] = [
    { key: 'id', title: '规则 ID', render: (record) => String(record.id) },
    { key: 'severity', title: '严重级别', render: (record) => record.severity || '-' },
    { key: 'phase', title: '阶段', render: (record) => (record.phase ? String(record.phase) : '-') },
    { key: 'message', title: '说明', render: (record) => record.message || '-' },
    { key: 'data', title: '数据', render: (record) => record.data || '-' },
    { key: 'file', title: '文件', render: (record) => record.file || '-' },
  ]

  const logColumns: Column<WafLog>[] = [
    {
      key: 'time',
      title: '时间',
      render: (record) => <span className="text-xs text-muted">{fmtTime(record.time)}</span>,
    },
    {
      key: 'action',
      title: '动作',
      render: (record) => <StatusChip color={actionTone(record.action)}>{actionLabel(record.action)}</StatusChip>,
    },
    {
      key: 'clientIp',
      title: '客户端',
      render: (record) => <span className="text-xs">{record.clientIp || '-'}</span>,
    },
    {
      key: 'request',
      title: '请求',
      render: (record) => (
        <div>
          <div className="mono text-xs">
            {record.method || '-'} {record.uri || '-'}
          </div>
          {record.host ? <div className="mt-0.5 text-xs text-muted">{record.host}</div> : null}
        </div>
      ),
    },
    {
      key: 'rule',
      title: '站点',
      render: (record) => <span className="text-xs">{record.rule || '-'}</span>,
    },
    {
      key: 'rules',
      title: '规则',
      render: (record) => (
        <div className="flex flex-wrap gap-1">
          {ruleIdsOf(record).length ? (
            ruleIdsOf(record).map((id) => (
              <span key={id} className="rounded bg-default px-1.5 py-0.5 text-xs">
                {id}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted">-</span>
          )}
        </div>
      ),
    },
    {
      key: 'message',
      title: '说明',
      render: (record) => <span className="text-xs">{record.message || '-'}</span>,
    },
  ]

  return (
    <Page>
      <PageHeader
        title="WAF"
        sub="嵌入式 Coraza 引擎：引擎配置、规则文件、请求测试与拦截日志"
        actions={
          <>
            <StatusChip color={engine?.enabled ? 'success' : 'default'}>
              {engine?.enabled ? '运行中' : '未运行'}
            </StatusChip>
            {engine?.crsVersion || crsVersion ? (
              <span className="text-xs text-muted">CRS {engine?.crsVersion || crsVersion}</span>
            ) : null}
            <Button
              variant="secondary"
              isDisabled={configLoading}
              onPress={() => {
                void loadConfig()
                void loadRules()
              }}
            >
              重新加载
            </Button>
            <Button
              variant="primary"
              isDisabled={saving || configLoading || !config}
              onPress={() => void saveConfig()}
            >
              {saving ? '保存中…' : '保存配置'}
            </Button>
          </>
        }
      />

      <Tabs defaultSelectedKey="config" className="w-full">
        <Tabs.List aria-label="WAF 分类">
          <Tabs.Tab id="config">配置</Tabs.Tab>
          <Tabs.Tab id="rules">规则</Tabs.Tab>
          <Tabs.Tab id="test">测试</Tabs.Tab>
          <Tabs.Tab id="logs">日志</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="config" className="pt-4">
        <Panel
          title="引擎配置"
          extra={
            <span className="text-xs text-muted">
              规则 {engine?.rules ?? '-'} 条 · 文件 {engine?.ruleFiles ?? '-'} 个
            </span>
          }
        >
          <div className="p-4">
            {engine?.error ? (
              <div className="mb-3 rounded-md border border-border bg-background-secondary p-3 text-sm text-danger">
                引擎编译错误：{engine.error}
              </div>
            ) : null}

            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SwitchInput
                  label="总开关"
                  value={form.enable}
                  onChange={(enable) => setForm((prev) => ({ ...prev, enable }))}
                  hint="启用 WAF"
                />
                <SelectInput
                  label="模式"
                  value={form.mode}
                  onChange={(value) =>
                    setForm((prev) => ({ ...prev, mode: value === 'detect' ? 'detect' : 'block' }))
                  }
                  options={MODE_OPTIONS}
                />
                <SwitchInput
                  label="仅记录"
                  value={form.logOnly}
                  onChange={(logOnly) => setForm((prev) => ({ ...prev, logOnly }))}
                  hint="不返回 403"
                />
                <SwitchInput
                  label="内置 CRS"
                  value={form.useCrs}
                  onChange={(useCrs) => setForm((prev) => ({ ...prev, useCrs }))}
                  hint="使用内置规则集"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SelectInput
                  label="Paranoia Level"
                  value={String(form.paranoiaLevel)}
                  onChange={(value) => setForm((prev) => ({ ...prev, paranoiaLevel: clampLevel(value, 1) }))}
                  options={LEVEL_OPTIONS}
                  hint="等级越高越严格，误报也越多"
                />
                <SelectInput
                  label="执行等级"
                  value={String(form.executingLevel)}
                  onChange={(value) => setForm((prev) => ({ ...prev, executingLevel: clampLevel(value, 1) }))}
                  options={LEVEL_OPTIONS}
                  hint="不能低于 Paranoia Level"
                />
                <NumberInput
                  label="入站阈值"
                  value={form.inboundThreshold}
                  onChange={(inboundThreshold) => setForm((prev) => ({ ...prev, inboundThreshold }))}
                  min={1}
                  hint="异常分数达到该值触发"
                />
                <NumberInput
                  label="出站阈值"
                  value={form.outboundThreshold}
                  onChange={(outboundThreshold) => setForm((prev) => ({ ...prev, outboundThreshold }))}
                  min={1}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <NumberInput
                  label="请求体上限（KB）"
                  value={form.bodyLimitKb}
                  onChange={(bodyLimitKb) => setForm((prev) => ({ ...prev, bodyLimitKb }))}
                  min={0}
                  max={10240}
                  hint="0 表示后端默认值"
                />
                <SwitchInput
                  label="管理后台防护"
                  value={form.adminProtect}
                  onChange={(adminProtect) => setForm((prev) => ({ ...prev, adminProtect }))}
                  hint="保护后台管理接口"
                />
              </div>

              <TagInput
                label="禁用规则"
                value={form.disabledRules}
                onChange={(disabledRules) => setForm((prev) => ({ ...prev, disabledRules }))}
                placeholder="输入规则 ID 或 ID 区间后回车，例如 920100 或 900000-910000"
                hint="只接受规则 ID 或「起始-结束」区间；保存后重新编译规则集"
              />

              <TextAreaInput
                label="额外 SecLang 规则"
                value={form.extraRules}
                onChange={(extraRules) => setForm((prev) => ({ ...prev, extraRules }))}
                rows={4}
                placeholder={
                  '追加的 SecLang 规则，例如：\nSecRule ARGS "@contains evil" "id:100001,phase:2,deny,status:403,msg:自定义规则"'
                }
                hint="保存后立即重新编译规则集"
              />
            </div>
          </div>
        </Panel>
        </Tabs.Panel>
        <Tabs.Panel id="rules" className="pt-4">
        <Panel
          title="规则文件"
          extra={
            <Button size="sm" variant="tertiary" isDisabled={rulesLoading} onPress={() => void loadRules()}>
              刷新
            </Button>
          }
        >
          <div className="p-4">
            <div className="mb-3 max-w-sm">
              <TextInput
                label="搜索规则文件"
                value={ruleQuery}
                onChange={setRuleQuery}
                placeholder="按文件、分组或标签搜索"
              />
            </div>
            <DataTable
              items={filteredRules}
              columns={ruleColumns}
              rowKey={(row) => row.file}
              ariaLabel="WAF 规则文件"
              empty="没有匹配的规则文件"
            />
            <div className="mt-3 text-xs text-muted">
              取消勾选表示禁用该规则文件（写入禁用规则的 ID 区间），需保存配置后生效；CRS 关闭时规则文件不可单独切换。
            </div>
          </div>
        </Panel>
        </Tabs.Panel>
        <Tabs.Panel id="test" className="pt-4">
        <Panel
          title="请求测试"
          extra={
            <>
              <span className="text-xs text-muted">POST /api/v1/waf/test（不会真的发出请求）</span>
              <Button size="sm" variant="primary" isDisabled={testing} onPress={() => void runTest()}>
                {testing ? '测试中…' : '测试'}
              </Button>
            </>
          }
        >
          <div className="p-4">
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
                <div className="md:col-span-2">
                  <SelectInput
                    label="方法"
                    value={testForm.method}
                    onChange={(method) => setTestForm((prev) => ({ ...prev, method }))}
                    options={TEST_METHODS}
                  />
                </div>
                <div className="md:col-span-7">
                  <TextInput
                    label="URL / 路径"
                    value={testForm.url}
                    onChange={(url) => setTestForm((prev) => ({ ...prev, url }))}
                    placeholder="/admin?id=1 union select 1 或完整 URL"
                    hint="可填写完整 URL，也可以只填 path（会自动补上前导 /）"
                  />
                </div>
                <div className="md:col-span-3">
                  <TextInput
                    label="客户端 IP"
                    value={testForm.clientIp}
                    onChange={(clientIp) => setTestForm((prev) => ({ ...prev, clientIp }))}
                    placeholder="可选，默认 127.0.0.1"
                  />
                </div>
              </div>

              <TextAreaInput
                label="请求体"
                value={testForm.body}
                onChange={(body) => setTestForm((prev) => ({ ...prev, body }))}
                rows={2}
                placeholder="请求体（POST/PUT 时填写）"
              />

              {testResult ? (
                <div className="space-y-4 border-t border-border pt-4">
                  {verdict ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip color={verdict.color}>{verdict.text}</StatusChip>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip
                      color={
                        testResult.blocked ? (testResult.enforced ? 'danger' : 'warning') : 'success'
                      }
                    >
                      {testResult.blocked
                        ? testResult.enforced
                          ? '已拦截'
                          : '命中未拦截'
                        : '未拦截'}
                    </StatusChip>
                    <StatusChip>模式 {testResult.mode || '-'}</StatusChip>
                    <StatusChip>动作 {testResult.action || '-'}</StatusChip>
                    <StatusChip>HTTP {testResult.status ?? '-'}</StatusChip>
                    <StatusChip>耗时 {testResult.durationMs ?? '-'} ms</StatusChip>
                    {testResult.logOnly ? <StatusChip>logOnly</StatusChip> : null}
                    {testResult.txId ? <span className="mono text-xs text-muted">事务 {testResult.txId}</span> : null}
                  </div>

                  {testResult.ruleId ? (
                    <div className="text-xs text-muted">命中规则 ID：{testResult.ruleId}</div>
                  ) : null}
                  {testResult.message ? (
                    <div className="text-xs text-muted">说明：{testResult.message}</div>
                  ) : null}

                  {Array.isArray(testResult.matched) && testResult.matched.length ? (
                    <DataTable
                      items={testResult.matched}
                      columns={matchedColumns}
                      rowKey={(row) => `${row.id}-${row.phase || 0}-${row.message || ''}`}
                      ariaLabel="命中的 WAF 规则"
                      empty="没有命中规则"
                    />
                  ) : (
                    <div className="rounded-md border border-border p-4 text-center text-sm text-muted">
                      没有命中规则
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </Panel>
        </Tabs.Panel>
        <Tabs.Panel id="logs" className="pt-4">
        <Panel
          title="拦截日志"
          extra={
            <>
              <Button size="sm" variant="tertiary" isDisabled={logsLoading} onPress={() => void loadLogs()}>
                刷新
              </Button>
              <Button size="sm" variant="danger-soft" onPress={() => setConfirmClearOpen(true)}>
                清空
              </Button>
            </>
          }
        >
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <div className="w-40">
                <SelectInput
                  label="动作过滤"
                  value={logFilter || 'all'}
                  onChange={changeLogFilter}
                  options={LOG_FILTER_OPTIONS}
                />
              </div>
              <div className="text-xs text-muted">每 10 秒自动刷新；日志只保存在内存中，重启后清空。</div>
            </div>
            <DataTable
              items={logs}
              columns={logColumns}
              rowKey={(row) =>
                `${row.time}-${row.txId || ''}-${row.clientIp || ''}-${row.uri || ''}-${row.ruleId || ''}-${row.action}`
              }
              ariaLabel="WAF 拦截日志"
              empty="暂无拦截日志"
            />
          </div>
        </Panel>
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        open={confirmClearOpen}
        title="清空拦截日志"
        content="将清空内存中的拦截日志和统计计数，确定继续？"
        confirmText="清空"
        danger
        onCancel={() => setConfirmClearOpen(false)}
        onConfirm={() => void clearLogs()}
      />
    </Page>
  )
}
