import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Empty,
  Grid,
  Input,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import { confirmDelete, DataTable, Muted } from '../components'
import { EntityRow, PaneTitle, Workspace, type ItemStatus } from '../components/Workspace'
import { usePolling } from '../usePolling'
import DdnsRuleForm from './ddns/RuleForm'
import {
  ipModeText,
  num,
  providerTitle,
  scheduleText,
  statusMessage,
  type DdnsRecord,
  type DdnsRule,
  type DdnsStatus,
  type ProviderMeta,
} from './ddns/types'

function normalizeRules(data: DdnsRule[] | { rules?: DdnsRule[]; items?: DdnsRule[] } | null): DdnsRule[] {
  if (Array.isArray(data)) return data
  return data?.rules || data?.items || []
}

function normalizeStatuses(data: DdnsStatus[] | { rules?: DdnsStatus[] } | null): DdnsStatus[] {
  if (Array.isArray(data)) return data
  return data?.rules || []
}

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: token.colorFillQuaternary, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{label}</div>
      <div
        title={typeof value === 'string' ? value : undefined}
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
      {hint ? (
        <div
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}

function Section({
  title,
  extra,
  first,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  first?: boolean
  children: ReactNode
}) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        marginTop: first ? 4 : 22,
        paddingTop: first ? 0 : 18,
        borderTop: first ? undefined : `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Typography.Text strong>{title}</Typography.Text>
        {extra ? <div style={{ marginLeft: 'auto' }}>{extra}</div> : null}
      </div>
      {children}
    </div>
  )
}

export default function Ddns() {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const screens = Grid.useBreakpoint()
  const desktop = Boolean(screens.lg)

  const [rules, setRules] = useState<DdnsRule[]>([])
  const [statuses, setStatuses] = useState<DdnsStatus[]>([])
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [rulesError, setRulesError] = useState<unknown>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<unknown>(null)
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftEnable, setDraftEnable] = useState(true)

  const fetchRules = useCallback(async () => {
    const data = await api.get<DdnsRule[] | { rules?: DdnsRule[]; items?: DdnsRule[] }>('/api/v1/ddns/rules')
    return normalizeRules(data)
  }, [])

  const fetchStatuses = useCallback(async () => {
    const data = await api.get<DdnsStatus[] | { rules?: DdnsStatus[] }>('/api/v1/ddns/status')
    return normalizeStatuses(data)
  }, [])

  const loadRules = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        setRules(await fetchRules())
        setRulesError(null)
      } catch (err) {
        setRulesError(err)
        if (!quiet) message.error(errorText(err))
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [fetchRules, message],
  )

  const loadStatus = useCallback(
    async (quiet = false) => {
      if (!quiet) setStatusLoading(true)
      try {
        setStatuses(await fetchStatuses())
        setStatusError(null)
      } catch (err) {
        setStatusError(err)
        if (!quiet) message.error(errorText(err))
      } finally {
        if (!quiet) setStatusLoading(false)
      }
    },
    [fetchStatuses, message],
  )

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      const data = await api.get<ProviderMeta[] | { providers?: ProviderMeta[]; items?: ProviderMeta[] }>(
        '/api/v1/ddns/providers',
      )
      setProviders(Array.isArray(data) ? data : data?.providers || data?.items || [])
      setProvidersError(null)
    } catch (err) {
      setProviders([])
      setProvidersError(err)
      message.error(errorText(err))
    } finally {
      setProvidersLoading(false)
    }
  }, [message])

  useEffect(() => {
    void loadProviders()
    void loadRules()
    void loadStatus()
  }, [loadProviders, loadRules, loadStatus])

  const live = usePolling(async () => {
    let ok = false
    try {
      setRules(await fetchRules())
      setRulesError(null)
      ok = true
    } catch (err) {
      setRulesError(err)
    }
    try {
      setStatuses(await fetchStatuses())
      setStatusError(null)
      ok = true
    } catch (err) {
      setStatusError(err)
    }
    if (!ok) throw new Error('ddns refresh failed')
  }, 10000)

  const statusMap = useMemo(() => {
    const map: Record<string, DdnsStatus> = {}
    for (const item of statuses) {
      if (item?.id) map[item.id] = item
    }
    return map
  }, [statuses])

  const summary = useMemo(() => {
    let enabled = 0
    let success = 0
    let failures = 0
    for (const rule of rules) if (rule.enable) enabled += 1
    for (const item of statuses) {
      success += num(item.success)
      failures += num(item.failures)
    }
    return { enabled, success, failures }
  }, [rules, statuses])

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return rules
    return rules.filter((rule) =>
      [rule.name, rule.domain, rule.provider, (rule.subDomains || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [rules, keyword])

  const selectedRule = useMemo(
    () => rules.find((rule) => rule.id === selectedId) || null,
    [rules, selectedId],
  )
  const selectedStatus = selectedRule ? statusMap[selectedRule.id] || null : null

  useEffect(() => {
    if (!desktop || creating) return
    if (selectedId && rules.some((rule) => rule.id === selectedId)) return
    setSelectedId(rules.length ? rules[0].id : null)
  }, [desktop, creating, rules, selectedId])

  const selectRule = (rule: DdnsRule) => {
    setCreating(false)
    setSelectedId(String(rule.id))
  }

  const openCreate = () => {
    if (!providers.length) {
      message.warning('还没有获取到 DNS 提供商列表，请先重试加载')
      return
    }
    setCreating(true)
    setSelectedId(null)
    setDraftEnable(true)
  }

  const backToList = () => {
    setCreating(false)
    setSelectedId(null)
  }

  const saveRule = async (payload: Record<string, unknown>) => {
    const current = selectedRule
    const isCreate = creating || !current
    setSaving(true)
    try {
      const saved = isCreate
        ? await api.post<{ id?: string }>('/api/v1/ddns/rules', payload)
        : await api.put(`/api/v1/ddns/rules/${encodeURIComponent(current.id)}`, payload)
      const [nextRules, nextStatuses] = await Promise.all([fetchRules(), fetchStatuses()])
      setRules(nextRules)
      setStatuses(nextStatuses)
      setRulesError(null)
      setStatusError(null)

      let id = String(saved?.id || '')
      if (!id && isCreate) {
        const name = String(payload.name || '')
        id = nextRules.find((rule) => (rule.name || '') === name)?.id || ''
      }
      if (!id) id = current?.id || ''
      message.success(isCreate ? '规则已创建' : '规则已保存')
      setCreating(false)
      setSelectedId(id || (desktop ? nextRules[0]?.id ?? null : null))
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (rule: DdnsRule, next: boolean) => {
    const id = String(rule.id)
    setBusyId(id)
    try {
      await api.post(`/api/v1/ddns/rules/${encodeURIComponent(id)}/toggle`, { enable: next })
      message.success(next ? '规则已启用' : '规则已停用')
      await Promise.all([loadRules(true), loadStatus(true)])
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const runRule = (rule: DdnsRule) => {
    if (!rule.enable) {
      message.warning('该规则未启用，请先启用后再执行')
      return
    }
    const id = String(rule.id)
    modal.confirm({
      title: '立即执行 DDNS 规则',
      content: `确定立即执行「${rule.name || rule.id}」吗？会探测当前公网 IP 并按需写入 DNS 记录。`,
      okText: '执行',
      cancelText: '取消',
      onOk: async () => {
        setBusyId(id)
        try {
          const result = await api.post<{
            ipv4?: string
            ipv6?: string
            ok?: boolean
            message?: string
          }>(`/api/v1/ddns/rules/${encodeURIComponent(id)}/run`)
          const ips = [result?.ipv4, result?.ipv6].filter(Boolean).join(' / ')
          if (result?.ok === false) {
            message.error(`执行失败：${result.message || '未知错误'}`)
          } else {
            message.success(ips ? `执行成功：当前 IP ${ips}` : result?.message || '执行完成')
          }
          await Promise.all([loadRules(true), loadStatus(true)])
        } catch (err) {
          message.error(errorText(err))
        } finally {
          setBusyId('')
        }
      },
    })
  }

  const removeRule = (rule: DdnsRule) => {
    confirmDelete(
      '删除 DDNS 规则',
      `确定删除「${rule.name || rule.id}」吗？删除后不再自动更新该域名。`,
      async () => {
        try {
          await api.del(`/api/v1/ddns/rules/${encodeURIComponent(String(rule.id))}`)
          message.success('规则已删除')
          const [nextRules, nextStatuses] = await Promise.all([fetchRules(), fetchStatuses()])
          setRules(nextRules)
          setStatuses(nextStatuses)
          setCreating(false)
          setSelectedId(desktop ? nextRules[0]?.id ?? null : null)
        } catch (err) {
          message.error(errorText(err))
        }
      },
    )
  }

  const liveLabel = live.failed
    ? '自动刷新失败'
    : live.updatedAt
      ? `更新于 ${new Date(live.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '等待自动刷新'

  const ruleSignal = (rule: DdnsRule): ItemStatus => {
    if (!rule.enable) return 'off'
    const state = statusMap[rule.id]
    if (state?.lastError) return 'error'
    if (state?.lastSuccess) return 'ok'
    return 'warn'
  }

  const listPane = (
    <div>
      <PaneTitle
        title="动态域名"
        subtitle={`共 ${rules.length} · 启用 ${summary.enabled}`}
        extra={
          <Space size={4}>
            <Tooltip title={liveLabel}>
              <Badge status={live.failed ? 'error' : live.updatedAt ? 'processing' : 'default'} />
            </Tooltip>
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              loading={loading || statusLoading}
              aria-label="刷新规则与状态"
              onClick={() => void Promise.all([loadRules(), loadStatus()])}
            />
            <Tooltip title={providers.length ? undefined : '尚未获取到 DNS 提供商列表'}>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!providers.length}
                onClick={openCreate}
              >
                新建
              </Button>
            </Tooltip>
          </Space>
        }
      />

      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称 / 域名 / 提供商 / 子域名"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <div style={{ marginTop: 6, textAlign: 'right' }}>
          <Muted>
            {filtered.length}/{rules.length} · 成功 {summary.success} / 失败 {summary.failures}
          </Muted>
        </div>
      </div>

      {providersError ? (
        <div style={{ padding: 10 }}>
          <Alert
            type="error"
            showIcon
            message="无法读取 DNS 提供商"
            description={errorText(providersError)}
            action={
              <Button size="small" loading={providersLoading} onClick={() => void loadProviders()}>
                重试
              </Button>
            }
          />
        </div>
      ) : null}

      {rulesError ? (
        <div style={{ padding: 10 }}>
          <Alert
            type="error"
            showIcon
            message="加载规则失败"
            description={errorText(rulesError)}
            action={
              <Button size="small" onClick={() => void loadRules()}>
                重试
              </Button>
            }
          />
        </div>
      ) : null}

      <div style={desktop ? { maxHeight: 'calc(100dvh - 280px)', overflowY: 'auto' } : undefined}>
        {loading && !rules.length ? (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <Spin size="small" />
          </div>
        ) : null}

        {filtered.map((rule) => {
          const state = statusMap[rule.id]
          const ips = [state?.ipv4, state?.ipv6].filter(Boolean) as string[]
          return (
            <EntityRow
              key={rule.id}
              title={rule.name || rule.id}
              subtitle={
                <span className="mono">
                  {rule.domain || '-'}
                  {Array.isArray(rule.subDomains) && rule.subDomains.length
                    ? ` · ${rule.subDomains.join(', ')}`
                    : ''}
                </span>
              }
              meta={
                <Space size={4} wrap>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    {providerTitle(providers, rule.provider)}
                  </Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>{rule.recordType || 'A'}</Tag>
                  {ips.length ? (
                    <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                      {ips.join(' / ')}
                    </Typography.Text>
                  ) : null}
                </Space>
              }
              status={ruleSignal(rule)}
              selected={!creating && selectedRule?.id === rule.id}
              onClick={() => selectRule(rule)}
            />
          )
        })}

        {!loading && !filtered.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={rules.length ? '没有符合筛选条件的规则' : '还没有 DDNS 规则'}
            style={{ padding: '24px 0' }}
          >
            {!rules.length ? (
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!providers.length}
                onClick={openCreate}
              >
                新建规则
              </Button>
            ) : null}
          </Empty>
        ) : null}
      </div>
    </div>
  )

  const effectiveEnable = selectedRule ? Boolean(selectedRule.enable) : draftEnable

  const recordColumns: TableColumnsType<DdnsRecord> = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 160,
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '结果',
      dataIndex: 'ok',
      key: 'ok',
      width: 80,
      render: (value) => <Tag color={value ? 'green' : 'red'}>{value ? '成功' : '失败'}</Tag>,
    },
    {
      title: '内容',
      dataIndex: 'message',
      key: 'message',
      render: (value) => <span style={{ fontSize: 12, wordBreak: 'break-word' }}>{value || '-'}</span>,
    },
  ]

  const runtimeSection = (rule: DdnsRule, state: DdnsStatus | null) => {
    const records: DdnsRecord[] = Array.isArray(state?.records)
      ? [...(state?.records ?? [])]
          .reverse()
          .map((record, index) => ({ ...record, key: `${record.time || ''}-${index}` }))
      : []
    return (
      <Section
        title="运行状态"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={statusLoading}
            onClick={() => void loadStatus()}
          >
            刷新
          </Button>
        }
      >
        {statusError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 10 }}
            message={`加载运行状态失败：${errorText(statusError)}`}
            action={
              <Button size="small" onClick={() => void loadStatus()}>
                重试
              </Button>
            }
          />
        ) : null}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 8,
          }}
        >
          <Metric label="IPv4" value={state?.ipv4 || '-'} hint={ipModeText(rule.ipv4)} />
          <Metric label="IPv6" value={state?.ipv6 || '-'} hint={ipModeText(rule.ipv6)} />
          <Metric label="上次执行" value={fmtTime(state?.lastRun)} hint={scheduleText(rule)} />
          <Metric label="上次成功" value={fmtTime(state?.lastSuccess)} />
          <Metric
            label="成功 / 失败"
            value={`${num(state?.success)} / ${num(state?.failures)}`}
            hint="来自 /api/v1/ddns/status"
          />
        </div>

        {state?.lastError ? (
          <Alert type="error" showIcon style={{ marginTop: 10 }} message="最近一次执行失败" description={state.lastError} />
        ) : state ? (
          <div style={{ marginTop: 8 }}>
            <Muted>最近结果：{statusMessage(state)}</Muted>
          </div>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <DataTable<DdnsRecord>
            rowKey={(row) => String(row.key)}
            columns={recordColumns}
            dataSource={records}
            pagination={{ pageSize: 5, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
            locale={{ emptyText: loading ? '加载中…' : '暂无执行记录，执行一次后这里会出现结果' }}
          />
        </div>
      </Section>
    )
  }

  const detailMeta = (rule: DdnsRule) => (
    <div style={{ marginTop: 4 }}>
      <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
        <Typography.Text type="secondary">{rule.domain || '-'}</Typography.Text>
      </div>
      <Space size={4} wrap style={{ marginTop: 4 }}>
        {(rule.subDomains || []).map((sub) => (
          <Tag key={sub} style={{ marginInlineEnd: 0 }}>
            {sub}
          </Tag>
        ))}
        <Muted>{scheduleText(rule)}</Muted>
      </Space>
    </div>
  )

  const detailPane = creating ? (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          新建规则
        </Typography.Title>
        <Tag>草稿</Tag>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Muted>启用</Muted>
          <Switch checked={draftEnable} onChange={setDraftEnable} size="small" aria-label="新建规则默认启用" />
        </div>
      </div>
      <Muted>创建后按调度自动执行；也可以保存后在详情里立即执行一次。</Muted>
      <div style={{ marginTop: 12 }}>
        <DdnsRuleForm
          key="new"
          rule={null}
          enable={draftEnable}
          providers={providers}
          providersLoading={providersLoading}
          providersError={providersError}
          onReloadProviders={() => void loadProviders()}
          saving={saving}
          onSubmit={saveRule}
          onCancel={backToList}
          cancelLabel="取消"
        />
      </div>
    </div>
  ) : selectedRule ? (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {selectedRule.name || selectedRule.id}
        </Typography.Title>
        <Tag color="blue">{providerTitle(providers, selectedRule.provider)}</Tag>
        <Tag>{selectedRule.recordType || 'A'}</Tag>
        {selectedRule.enable ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button
            size="small"
            type="text"
            icon={<PlayCircleOutlined />}
            disabled={!selectedRule.enable}
            loading={busyId === String(selectedRule.id)}
            onClick={() => runRule(selectedRule)}
          >
            执行
          </Button>
          <Tooltip title={effectiveEnable ? '停用这条规则' : '启用这条规则'}>
            <Switch
              size="small"
              checked={effectiveEnable}
              loading={busyId === String(selectedRule.id)}
              disabled={busyId !== '' && busyId !== String(selectedRule.id)}
              onChange={(checked) => void toggleRule(selectedRule, checked)}
              aria-label={`${selectedRule.name || selectedRule.id} 启停`}
            />
          </Tooltip>
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => removeRule(selectedRule)}
          >
            删除
          </Button>
        </div>
      </div>
      {detailMeta(selectedRule)}
      {selectedRule.remark ? <Muted>{selectedRule.remark}</Muted> : null}

      {runtimeSection(selectedRule, selectedStatus)}

      <Section title="规则配置" extra={<Muted>基础、凭据、高级设置都在这里</Muted>}>
        <DdnsRuleForm
          key={selectedRule.id}
          rule={selectedRule}
          enable={effectiveEnable}
          providers={providers}
          providersLoading={providersLoading}
          providersError={providersError}
          onReloadProviders={() => void loadProviders()}
          saving={saving}
          onSubmit={saveRule}
        />
      </Section>
    </div>
  ) : (
    <div style={{ padding: '56px 0' }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={rules.length ? '从左侧选择一条规则查看详情' : '还没有 DDNS 规则'}
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!providers.length}
          onClick={openCreate}
        >
          新建规则
        </Button>
      </Empty>
    </div>
  )

  return (
    <Workspace
      list={listPane}
      detail={detailPane}
      selected={creating || Boolean(selectedRule)}
      onBack={backToList}
      listWidth={340}
    />
  )
}
