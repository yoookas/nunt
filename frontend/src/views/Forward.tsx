import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Dropdown, Switch } from '@heroui/react'
import { api, errorText } from '../api'
import { Ellipsis, FileText, Pencil, Trash2 } from 'lucide-react'
import { fmtBytes, fmtTime, splitLines } from '../format'
import { usePolling } from '../usePolling'
import {
  ConfirmModal,
  DataTable,
  FormModal,
  mergeVisibleOrder,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  StatCard,
  SelectInput,
  LiveStatus,
  StatusChip,
  TagInput,
  TextAreaInput,
  TextInput,
  ToolbarSearch,
  ToolbarSelect,
  toast,
  type Column,
} from '../ui'

const PROTOCOL_OPTIONS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'both', label: 'TCP + UDP' },
]

const PROTOCOL_LABEL: Record<string, string> = { tcp: 'TCP', udp: 'UDP', both: 'TCP + UDP' }

const ACCESS_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许列表中的 IP）' },
  { value: 'deny', label: '黑名单（拒绝列表中的 IP）' },
]

const ACCESS_LABEL: Record<string, string> = { off: '关闭', allow: '白名单', deny: '黑名单' }

const LOG_LIMIT_OPTIONS = [100, 200, 500]

const ALL_RULES = '__all__'

type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'danger'

interface AccessConfig {
  mode?: string
  ips?: string[]
  geo?: string[]
  uaMode?: string
  uas?: string[]
}

interface ForwardRule {
  id: string
  name: string
  enable: boolean
  disabled?: boolean
  protocol: string
  srcAddr: string
  dstAddr: string
  timeoutSec?: number
  maxConns?: number
  maxConnsPerIP?: number
  access?: AccessConfig
  remark?: string
  activeConns?: number
  totalConns?: number
  upBytes?: number
  downBytes?: number
  listening?: boolean
  connLimit?: number
  connLimitPerIp?: number
  rejectedRuleLimit?: number
  rejectedIpLimit?: number
}

interface ForwardLog {
  key?: string
  time?: string
  ruleId?: string
  rule?: string
  protocol?: string
  client?: string
  target?: string
  result?: string
  duration?: number
  bytesIn?: number
  bytesOut?: number
  packets?: number
}

interface ForwardLogsResponse {
  items?: ForwardLog[]
  logs?: ForwardLog[]
  total?: number
  enabled?: boolean
}

interface RuleForm {
  name: string
  enable: boolean
  protocol: string
  srcAddr: string
  dstAddr: string
  timeoutSec: number
  maxConns: number
  maxConnsPerIP: number
  accessMode: string
  accessIps: string
  accessGeo: string[]
  remark: string
}

const EMPTY_FORM: RuleForm = {
  name: '',
  enable: true,
  protocol: 'tcp',
  srcAddr: '',
  dstAddr: '',
  timeoutSec: 0,
  maxConns: 0,
  maxConnsPerIP: 0,
  accessMode: 'off',
  accessIps: '',
  accessGeo: [],
  remark: '',
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function fmtLimit(value: unknown): string {
  const n = num(value)
  return n > 0 ? String(n) : '不限'
}

function fmtTimeout(value: unknown): string {
  const n = num(value)
  return n > 0 ? `${n} 秒` : '默认 300 秒'
}

function fmtDurationNs(value: unknown): string {
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
  const hour = Math.floor(min / 60)
  return `${hour} 小时 ${min % 60} 分`
}

function resultColor(result: unknown): ChipColor {
  const text = String(result || '')
  if (text === 'closed') return 'success'
  if (text.startsWith('rejected')) return 'warning'
  if (text.startsWith('denied') || text.startsWith('failed')) return 'danger'
  return 'default'
}

function protoColor(protocol: unknown): ChipColor {
  if (protocol === 'udp') return 'warning'
  if (protocol === 'both') return 'success'
  return 'primary'
}

function accessMode(rule: ForwardRule): string {
  return rule.access?.mode || 'off'
}

function accessIps(rule: ForwardRule): string[] {
  const ips = rule.access?.ips
  return Array.isArray(ips) ? ips : []
}

function accessLabel(rule: ForwardRule): string {
  const mode = accessMode(rule)
  if (mode === 'off') return '关闭'
  return `${ACCESS_LABEL[mode] || mode} · ${accessIps(rule).length} 条`
}

function accessColor(rule: ForwardRule): ChipColor {
  const mode = accessMode(rule)
  if (mode === 'allow') return 'success'
  if (mode === 'deny') return 'danger'
  return 'default'
}

function accessTip(rule: ForwardRule): string {
  const ips = accessIps(rule)
  if (!ips.length) return '没有配置 IP 列表'
  const head = ips.slice(0, 8).join(', ')
  return ips.length > 8 ? `${head} 等 ${ips.length} 条` : head
}

function InlineAlert({ status, children }: { status: 'accent' | 'danger' | 'warning' | 'success'; children: ReactNode }) {
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

export default function Forward() {
  const [rules, setRules] = useState<ForwardRule[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [protoFilter, setProtoFilter] = useState('all')
  const [keyword, setKeyword] = useState('')

  const [logs, setLogs] = useState<ForwardLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<unknown>(null)
  const [logsEnabled, setLogsEnabled] = useState(true)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logRule, setLogRule] = useState('')
  const [logLimit, setLogLimit] = useState(200)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const logSeq = useRef(0)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [originalAccess, setOriginalAccess] = useState<{ uaMode: string; uas: string[] }>({
    uaMode: 'off',
    uas: [],
  })
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ForwardRule | null>(null)

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<ForwardRule[] | { rules?: ForwardRule[]; items?: ForwardRule[] }>(
        '/api/v1/forward/rules',
      )
      setRules(Array.isArray(data) ? data : data?.rules || data?.items || [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err)
      toast.danger(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(
    async (overrides?: { rule?: string; limit?: number }) => {
      const seq = ++logSeq.current
      const rule = overrides?.rule ?? logRule
      const limit = overrides?.limit ?? logLimit
      setLogsLoading(true)
      try {
        const data = await api.get<ForwardLogsResponse | ForwardLog[]>('/api/v1/forward/logs', {
          rule: rule || undefined,
          limit,
        })
        if (seq !== logSeq.current) return
        const items = Array.isArray(data) ? data : data?.items || data?.logs || []
        setLogs(items.map((item, index) => ({ ...item, key: item.key || `${item.time || ''}-${index}` })))
        setLogsEnabled(!Array.isArray(data) && data?.enabled !== false)
        setLogsError(null)
      } catch (err) {
        if (seq !== logSeq.current) return
        setLogsError(err)
        toast.danger(errorText(err))
      } finally {
        if (seq === logSeq.current) setLogsLoading(false)
      }
    },
    [logRule, logLimit],
  )

  useEffect(() => {
    void loadRules()
    void loadLogs()
  }, [loadRules, loadLogs])

  // Connection and traffic counters live on the rules, so re-reading the list
  // is enough to keep the stat cards live. No loading flag: the table must not
  // blink every five seconds.
  const refreshCounters = async () => {
    const data = await api.get<ForwardRule[] | { rules?: ForwardRule[]; items?: ForwardRule[] }>(
      '/api/v1/forward/rules',
    )
    setRules(Array.isArray(data) ? data : data?.rules || data?.items || [])
  }

  const live = usePolling(refreshCounters, 5000)

  useEffect(() => {
    if (!logsOpen || !autoRefresh) return
    const timer = window.setInterval(() => {
      void loadLogs()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [logsOpen, autoRefresh, loadLogs])

  const summary = useMemo(() => {
    const out = {
      active: 0,
      total: 0,
      up: 0,
      down: 0,
      rejectedRule: 0,
      rejectedIp: 0,
      rejected: 0,
      enabled: 0,
      listening: 0,
    }
    for (const rule of rules) {
      out.active += num(rule.activeConns)
      out.total += num(rule.totalConns)
      out.up += num(rule.upBytes)
      out.down += num(rule.downBytes)
      out.rejectedRule += num(rule.rejectedRuleLimit)
      out.rejectedIp += num(rule.rejectedIpLimit)
      if (rule.enable && !rule.disabled) out.enabled += 1
      if (rule.listening) out.listening += 1
    }
    out.rejected = out.rejectedRule + out.rejectedIp
    return out
  }, [rules])

  const filteredRules = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return rules.filter((rule) => {
      if (protoFilter !== 'all' && rule.protocol !== protoFilter) return false
      if (!q) return true
      return [rule.name, rule.srcAddr, rule.dstAddr, rule.remark].join(' ').toLowerCase().includes(q)
    })
  }, [rules, protoFilter, keyword])

  const reorderRules = async (nextVisibleIds: string[]) => {
    const next = mergeVisibleOrder(rules, (rule) => String(rule.id), nextVisibleIds)
    setRules(next)
    try {
      await api.post('/api/v1/forward/rules/order', { ids: next.map((rule) => String(rule.id)) })
    } catch (err) {
      toast.danger(errorText(err))
      await loadRules()
    }
  }

  const patchForm = (patch: Partial<RuleForm>) => setForm((prev) => ({ ...prev, ...patch }))

  const openCreate = () => {
    setEditingId('')
    setOriginalAccess({ uaMode: 'off', uas: [] })
    setForm({ ...EMPTY_FORM })
    setErrors({})
    setModalOpen(true)
  }

  const openEdit = (rule: ForwardRule) => {
    const access = rule.access || {}
    setEditingId(String(rule.id || ''))
    setOriginalAccess({
      uaMode: access.uaMode || 'off',
      uas: Array.isArray(access.uas) ? [...access.uas] : [],
    })
    setForm({
      name: rule.name || '',
      enable: rule.enable !== false,
      protocol: rule.protocol || 'tcp',
      srcAddr: rule.srcAddr || '',
      dstAddr: rule.dstAddr || '',
      timeoutSec: num(rule.timeoutSec),
      maxConns: num(rule.maxConns),
      maxConnsPerIP: num(rule.maxConnsPerIP),
      accessMode: access.mode || 'off',
      accessIps: (Array.isArray(access.ips) ? access.ips : []).join('\n'),
      accessGeo: Array.isArray(access.geo) ? [...access.geo] : [],
      remark: rule.remark || '',
    })
    setErrors({})
    setModalOpen(true)
  }

  const submitRule = async () => {
    const nextErrors: Record<string, string> = {}
    if (!form.name.trim()) nextErrors.name = '请填写规则名称'
    if (!form.srcAddr.trim()) nextErrors.srcAddr = '请填写源地址'
    else if (!form.srcAddr.includes(':')) nextErrors.srcAddr = '源地址必须包含端口，例如 :3389'
    if (!form.dstAddr.trim()) nextErrors.dstAddr = '请填写目标地址'
    else if (!form.dstAddr.includes(':')) nextErrors.dstAddr = '目标地址必须包含端口，例如 192.168.1.10:3389'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      toast.warning('请检查表单中的必填项')
      return
    }

    const payload = {
      name: form.name.trim(),
      enable: !!form.enable,
      protocol: form.protocol || 'tcp',
      srcAddr: form.srcAddr.trim(),
      dstAddr: form.dstAddr.trim(),
      timeoutSec: num(form.timeoutSec),
      maxConns: num(form.maxConns),
      maxConnsPerIP: num(form.maxConnsPerIP),
      access: {
        mode: form.accessMode || 'off',
        ips: splitLines(form.accessIps),
        geo: [...form.accessGeo],
        // The form does not edit the User-Agent filter, so carry it over
        // unchanged. Dropping it here would silently disable a configured one.
        uaMode: originalAccess.uaMode || 'off',
        uas: originalAccess.uas || [],
      },
      remark: form.remark.trim(),
    }

    setSaving(true)
    try {
      if (editingId) {
        await api.put(`/api/v1/forward/rules/${encodeURIComponent(editingId)}`, payload)
        toast.success('规则已保存')
      } else {
        await api.post('/api/v1/forward/rules', payload)
        toast.success('规则已创建')
      }
      setModalOpen(false)
      await Promise.all([loadRules(), loadLogs()])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (rule: ForwardRule, value: boolean) => {
    const on = rule.enable && !rule.disabled
    const next = typeof value === 'boolean' ? value : !on
    const id = String(rule.id || '')
    setBusyId(id)
    try {
      await api.post(`/api/v1/forward/rules/${encodeURIComponent(id)}/toggle`, { enable: next })
      toast.success(next ? '规则已启用' : '规则已停用')
      await loadRules()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const removeRule = async (rule: ForwardRule) => {
    const id = String(rule.id || '')
    try {
      await api.del(`/api/v1/forward/rules/${encodeURIComponent(id)}`)
      toast.success('规则已删除')
      if (logRule === id) setLogRule('')
      await Promise.all([loadRules(), loadLogs()])
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const openLogsFor = (rule?: ForwardRule) => {
    const ruleId = rule ? String(rule.id || '') : ''
    setLogRule(ruleId)
    setLogsOpen(true)
    void loadLogs({ rule: ruleId })
  }

  const columns: Column<ForwardRule>[] = [
    {
      key: 'rule',
      title: '规则',
      render: (row) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.name || row.id}</span>
            <StatusChip color={protoColor(row.protocol)}>
              {PROTOCOL_LABEL[row.protocol] || row.protocol || '-'}
            </StatusChip>
          </div>
          <div
            className="mt-0.5 truncate font-mono text-xs text-muted"
            title={`${row.srcAddr || '-'} → ${row.dstAddr || '-'}`}
          >
            {row.srcAddr || '-'} → {row.dstAddr || '-'}
          </div>
        </div>
      ),
    },
    {
      key: 'limits',
      title: '限制',
      className: 'w-44',
      render: (row) => {
        const rejected = num(row.rejectedRuleLimit) + num(row.rejectedIpLimit)
        return (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1">
              <span title={accessTip(row)}>
                <StatusChip color={accessColor(row)}>{accessLabel(row)}</StatusChip>
              </span>
              <span className="text-xs text-muted">超时 {fmtTimeout(row.timeoutSec)}</span>
            </div>
            <div
              className="mt-0.5 text-xs text-muted"
              title={`规则上限拒绝 ${num(row.rejectedRuleLimit)} 次，单 IP 上限拒绝 ${num(row.rejectedIpLimit)} 次`}
            >
              并发 {fmtLimit(row.connLimit)}/{fmtLimit(row.connLimitPerIp)}
              {rejected > 0 ? ` · 拒绝 ${rejected}` : ''}
            </div>
          </div>
        )
      },
    },
    {
      key: 'stats',
      title: '统计',
      className: 'w-40',
      render: (row) => (
        <div className="text-xs tabular-nums">
          <div>
            活跃 {num(row.activeConns)} · 累计 {num(row.totalConns)}
          </div>
          <div className="mt-0.5 text-muted">
            ↑ {fmtBytes(row.upBytes)} · ↓ {fmtBytes(row.downBytes)}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      className: 'w-36',
      render: (row) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Switch
            aria-label={`${row.name || row.id} 启停`}
            isSelected={!!row.enable && !row.disabled}
            isDisabled={busyId === String(row.id || '')}
            onChange={(value) => void toggleRule(row, value)}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          <span className="text-xs text-muted">
            {row.disabled ? '端口被占用' : row.enable ? '启用' : '停用'}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      className: 'w-16',
      render: (row) => (
        <Dropdown>
          <Dropdown.Trigger>
            <Button isIconOnly size="sm" variant="ghost" aria-label={`规则操作 ${row.name || row.id}`}>
              <Ellipsis size={16} />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <Dropdown.Menu
              onAction={(key) => {
                if (key === 'logs') openLogsFor(row)
                if (key === 'edit') openEdit(row)
                if (key === 'delete') setDeleteTarget(row)
              }}
            >
              <Dropdown.Item id="logs" textValue="查看日志">
                <FileText size={14} className="mr-2 inline" />
                查看日志
              </Dropdown.Item>
              <Dropdown.Item id="edit" textValue="编辑规则">
                <Pencil size={14} className="mr-2 inline" />
                编辑规则
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue="删除规则">
                <Trash2 size={14} className="mr-2 inline" />
                删除规则
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ),
    },
  ]

  const logColumns: Column<ForwardLog>[] = [
    {
      key: 'time',
      title: '时间',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.time)}</span>,
    },
    {
      key: 'rule',
      title: '规则',
      render: (row) => <span className="text-xs">{row.rule || row.ruleId || '-'}</span>,
    },
    {
      key: 'protocol',
      title: '协议',
      render: (row) => <span className="text-xs uppercase">{String(row.protocol || '-').toUpperCase()}</span>,
    },
    {
      key: 'client',
      title: '来源 / 目标',
      render: (row) => (
        <div className="font-mono text-xs">
          <div className="break-all">{row.client || '-'}</div>
          <div className="break-all text-muted">→ {row.target || '-'}</div>
        </div>
      ),
    },
    {
      key: 'result',
      title: '结果',
      render: (row) => (
        <span title={row.result || ''}>
          <StatusChip color={resultColor(row.result)}>{row.result || '-'}</StatusChip>
        </span>
      ),
    },
    {
      key: 'duration',
      title: '持续',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtDurationNs(row.duration)}</span>,
    },
    {
      key: 'bytes',
      title: '上行 / 下行',
      render: (row) => (
        <span className="whitespace-nowrap text-xs tabular-nums">
          ↑ {fmtBytes(row.bytesIn)} / ↓ {fmtBytes(row.bytesOut)}
        </span>
      ),
    },
    {
      key: 'packets',
      title: '数据包',
      render: (row) => <span className="text-xs tabular-nums">{row.packets ? String(row.packets) : '-'}</span>,
    },
  ]

  const ruleLogOptions = [
    { value: ALL_RULES, label: '全部规则' },
    ...rules.map((rule) => ({ value: String(rule.id), label: rule.name || String(rule.id) })),
  ]

  return (
    <Page>
      <PageHeader
        title="端口转发"
        sub="TCP / UDP 端口映射、访问控制、并发限制与实时运行统计"
        actions={
          <>
            <LiveStatus status={live} />
            <Button variant="primary" onPress={openCreate}>
              新建规则
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="转发规则"
            value={rules.length}
            hint={`启用 ${summary.enabled} · 正在监听 ${summary.listening}`}
          />
          <StatCard label="活跃连接" value={summary.active} hint="当前正在转发的连接数" />
          <StatCard label="累计连接" value={summary.total} hint="进程启动以来接受的连接" />
          <StatCard label="上行流量" value={fmtBytes(summary.up)} hint="客户端 → 目标" />
          <StatCard label="下行流量" value={fmtBytes(summary.down)} hint="目标 → 客户端" />
          <StatCard
            label="被限流拒绝"
            value={summary.rejected}
            hint={`规则上限 ${summary.rejectedRule} · 单 IP ${summary.rejectedIp}`}
          />
        </div>

        <section className="min-w-0">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="text-sm font-semibold sm:text-base">转发规则</div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <ToolbarSelect
                label="协议筛选"
                value={protoFilter}
                onChange={setProtoFilter}
                options={[{ value: 'all', label: '全部协议' }, ...PROTOCOL_OPTIONS]}
                className="w-full sm:w-32"
              />
              <ToolbarSearch
                label="搜索转发规则"
                value={keyword}
                onChange={setKeyword}
                placeholder="搜索名称 / 源地址 / 目标地址"
                className="w-full sm:w-64"
              />
              <Button variant="tertiary" onPress={() => openLogsFor()}>
                访问日志
              </Button>
              <span className="whitespace-nowrap text-xs text-muted">
                共 {rules.length} 条 · 显示 {filteredRules.length} 条
              </span>
            </div>
          </div>

          {loadError ? (
            <div className="mb-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-auto sm:min-w-64 sm:flex-1">
                  <InlineAlert status="danger">加载转发规则失败：{errorText(loadError)}</InlineAlert>
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
            ariaLabel="转发规则"
            variant="primary"
            sortable
            onReorder={(ids) => void reorderRules(ids)}
            empty={loading ? '加载中…' : rules.length ? '没有符合筛选条件的规则' : '还没有端口转发规则'}
          />
        </section>
      </div>

      <FormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? '编辑转发规则' : '新建转发规则'}
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
        <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
          <FormField error={errors.name}>
            <TextInput
              label="名称"
              value={form.name}
              onChange={(value) => patchForm({ name: value })}
              placeholder="例如：远程桌面"
              required
            />
          </FormField>
          <FormField>
            <div className="pt-6">
              <SwitchInputLocal label="启用" value={form.enable} onChange={(value) => patchForm({ enable: value })} />
            </div>
          </FormField>

          <FormField>
            <SelectInput
              label="协议"
              value={form.protocol}
              onChange={(value) => patchForm({ protocol: value })}
              options={PROTOCOL_OPTIONS}
              required
            />
          </FormField>
          <FormField>
            <NumberInput
              label="空闲超时（秒）"
              value={form.timeoutSec}
              onChange={(value) => patchForm({ timeoutSec: value })}
              min={0}
              max={86400}
              hint="0 表示使用默认 300 秒；这是空闲超时，不会因为连接总时长被断开。"
            />
          </FormField>

          <FormField error={errors.srcAddr}>
            <TextInput
              label="源地址"
              value={form.srcAddr}
              onChange={(value) => patchForm({ srcAddr: value })}
              placeholder=":3389 或 0.0.0.0:3389"
              hint="本机监听地址，可以省略 IP，只写端口。"
              required
            />
          </FormField>
          <FormField error={errors.dstAddr}>
            <TextInput
              label="目标地址"
              value={form.dstAddr}
              onChange={(value) => patchForm({ dstAddr: value })}
              placeholder="192.168.1.10:3389"
              hint="流量要转发到的内网地址。"
              required
            />
          </FormField>

          <FormField>
            <NumberInput
              label="规则并发上限"
              value={form.maxConns}
              onChange={(value) => patchForm({ maxConns: value })}
              min={0}
              max={1000000}
              hint="0 表示由后端补默认上限（1024）。"
            />
          </FormField>
          <FormField>
            <NumberInput
              label="单 IP 并发上限"
              value={form.maxConnsPerIP}
              onChange={(value) => patchForm({ maxConnsPerIP: value })}
              min={0}
              max={100000}
              hint="0 表示由后端补默认上限（64）。"
            />
          </FormField>

          <FormField full>
            <SelectInput
              label="IP 访问控制"
              value={form.accessMode}
              onChange={(value) => patchForm({ accessMode: value })}
              options={ACCESS_OPTIONS}
            />
          </FormField>
          <FormField full>
            <TextAreaInput
              label="IP 列表"
              value={form.accessIps}
              onChange={(value) => patchForm({ accessIps: value })}
              placeholder={'每行一条，支持 CIDR：\n192.168.1.0/24\n10.0.0.5'}
              hint="白名单为空时会拒绝所有来源，黑名单为空时不会拒绝任何来源。"
              rows={4}
            />
          </FormField>

          <FormField full>
            <TagInput
              label="国家 / 省份 / 城市"
              value={form.accessGeo}
              onChange={(value) => patchForm({ accessGeo: value })}
              placeholder="输入后回车，例如 中国、浙江、杭州"
              hint="同一个列表，命中任意一项即匹配；与 IP 列表取并集；私有/回环地址没有地区数据。"
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
        </div>
      </FormModal>

      <FormModal
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        title="访问日志"
        size="xl"
        footer={
          <div className="flex justify-end">
            <Button variant="tertiary" onPress={() => setLogsOpen(false)}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-56">
              <SelectInput
                label="规则"
                value={logRule || ALL_RULES}
                onChange={(value) => setLogRule(value === ALL_RULES ? '' : value)}
                options={ruleLogOptions}
              />
            </div>
            <div className="w-full sm:w-40">
              <SelectInput
                label="条数"
                value={String(logLimit)}
                onChange={(value) => setLogLimit(Number(value) || 200)}
                options={LOG_LIMIT_OPTIONS.map((limit) => ({ value: String(limit), label: `最近 ${limit} 条` }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <SwitchInputLocal label="自动刷新（5 秒）" value={autoRefresh} onChange={setAutoRefresh} />
            </div>
            <div className="flex-1" />
            <StatusChip color={logsEnabled ? 'success' : 'default'}>{logsEnabled ? '记录中' : '未启用'}</StatusChip>
            <Button size="sm" variant="secondary" isDisabled={logsLoading} onPress={() => void loadLogs()}>
              {logsLoading ? '刷新中…' : '刷新'}
            </Button>
          </div>

          {!logsEnabled ? (
            <InlineAlert status="warning">
              访问日志当前未启用（后端 forward.accessLog 关闭），新的连接不会写入日志；下方显示的是已有记录。
            </InlineAlert>
          ) : null}

          {logsError ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-auto sm:min-w-64 sm:flex-1">
                <InlineAlert status="danger">加载访问日志失败：{errorText(logsError)}</InlineAlert>
              </div>
              <Button size="sm" variant="secondary" onPress={() => void loadLogs()}>
                重试
              </Button>
            </div>
          ) : null}

          <div className="text-xs text-muted">共 {logs.length} 条</div>
          <DataTable
            items={logs}
            columns={logColumns}
            rowKey={(row) => String(row.key)}
            ariaLabel="访问日志"
            empty={logsLoading ? '加载中…' : '暂无访问日志'}
          />
          <div className="text-xs text-muted">
            本窗口只显示内存缓冲；历史记录可在「日志 → 访问日志」中按来源「端口转发」检索并导出。
          </div>
        </div>
      </FormModal>

      <ConfirmModal
        open={!!deleteTarget}
        title="删除转发规则"
        danger
        confirmText="删除"
        content={`确定删除「${deleteTarget?.name || deleteTarget?.id || ''}」吗？该端口上的转发会立即停止。`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void removeRule(target)
        }}
      />
    </Page>
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
