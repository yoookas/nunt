import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Empty,
  Grid,
  Input,
  Select,
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
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { api, ApiError, errorText } from '../api'
import { fmtBytes } from '../format'
import { confirmDelete, Muted } from '../components'
import { EntityRow, PaneTitle, Workspace, type ItemStatus } from '../components/Workspace'
import { usePolling } from '../usePolling'
import ForwardRuleForm from './forward/RuleForm'
import { AccessTag } from './web/ui'
import {
  num,
  PROTOCOL_LABEL,
  PROTOCOL_OPTIONS,
  protocolColor,

  type ForwardRule,
} from './forward/types'

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: token.colorFillQuaternary, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{label}</div>
      <div
        title={typeof value === 'string' ? value : undefined}
        style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 11, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

function ruleStatus(rule: ForwardRule): ItemStatus {
  if (rule.disabled) return 'warn'
  if (!rule.enable) return 'off'
  return rule.listening ? 'ok' : 'warn'
}

export default function Forward() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const screens = Grid.useBreakpoint()
  const desktop = Boolean(screens.lg)

  const [rules, setRules] = useState<ForwardRule[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [protoFilter, setProtoFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftEnable, setDraftEnable] = useState(true)

  const fetchRules = useCallback(async () => {
    const data = await api.get<ForwardRule[] | { rules?: ForwardRule[]; items?: ForwardRule[] }>(
      '/api/v1/forward/rules',
    )
    return Array.isArray(data) ? data : data?.rules || data?.items || []
  }, [])

  const applyRules = useCallback((next: ForwardRule[]) => {
    setRules(next)
    setLoadError(null)
  }, [])

  const loadRules = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        applyRules(await fetchRules())
      } catch (err) {
        setLoadError(err)
        if (!quiet) message.error(errorText(err))
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [applyRules, fetchRules, message],
  )

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  // Live counters live on the rules endpoint, so a quiet re-read is enough. A
  // failing poll only flips the badge: no toast spam from a background refresh.
  const live = usePolling(async () => {
    try {
      applyRules(await fetchRules())
    } catch (err) {
      setLoadError(err)
      throw err
    }
  }, 5000)

  const summary = useMemo(() => {
    const out = { enabled: 0, listening: 0, portBusy: 0, active: 0 }
    for (const rule of rules) {
      out.active += num(rule.activeConns)
      if (rule.disabled) out.portBusy += 1
      if (rule.enable && !rule.disabled) out.enabled += 1
      if (rule.listening) out.listening += 1
    }
    return out
  }, [rules])

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return rules.filter((rule) => {
      if (protoFilter !== 'all' && (rule.protocol || 'tcp') !== protoFilter) return false
      if (!q) return true
      return [rule.name, rule.srcAddr, rule.dstAddr, rule.remark]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [rules, protoFilter, keyword])

  const selectedRule = useMemo(
    () => rules.find((rule) => rule.id === selectedId) || null,
    [rules, selectedId],
  )

  // Desktop keeps a detail pane; without a manual choice, show the first rule.
  useEffect(() => {
    if (!desktop || creating) return
    if (selectedId && rules.some((rule) => rule.id === selectedId)) return
    setSelectedId(rules.length ? rules[0].id : null)
  }, [desktop, creating, rules, selectedId])

  const selectRule = (rule: ForwardRule) => {
    setCreating(false)
    setSelectedId(String(rule.id))
  }

  const openCreate = () => {
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
        ? await api.post<ForwardRule>('/api/v1/forward/rules', payload)
        : await api.put<ForwardRule>(`/api/v1/forward/rules/${encodeURIComponent(current.id)}`, payload)
      const next = await fetchRules()
      setRules(next)
      setLoadError(null)

      let id = String(saved?.id || '')
      if (!id && isCreate) {
        const name = String(payload.name || '')
        id = next.find((rule) => (rule.name || '') === name)?.id || ''
      }
      if (!id) id = current?.id || ''
      const fresh = next.find((rule) => rule.id === id)
      if (fresh?.disabled && payload.enable !== false) {
        message.warning(
          isCreate
            ? '规则已创建，但监听端口被占用，后端已自动停用；请释放端口后重新启用'
            : '规则已保存，但监听端口被占用，后端已自动停用；请释放端口后重新启用',
        )
      } else {
        message.success(isCreate ? '规则已创建' : '规则已保存')
      }
      setCreating(false)
      setSelectedId(id || (desktop ? next[0]?.id ?? null : null))
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (rule: ForwardRule, next: boolean) => {
    const id = String(rule.id)
    setBusyId(id)
    try {
      await api.post(`/api/v1/forward/rules/${encodeURIComponent(id)}/toggle`, { enable: next })
      message.success(next ? '规则已启用' : '规则已停用')
    } catch (err) {
      // 409 means the bind failed: the backend left the rule disabled, so the
      // switch has to snap back after the reload below.
      if (err instanceof ApiError && err.status === 409) {
        message.warning(errorText(err))
      } else {
        message.error(errorText(err))
      }
    } finally {
      await loadRules(true)
      setBusyId('')
    }
  }

  const removeRule = (rule: ForwardRule) => {
    confirmDelete(
      '删除转发规则',
      `确定删除「${rule.name || rule.id}」吗？该端口上的转发会立即停止。`,
      async () => {
        try {
          await api.del(`/api/v1/forward/rules/${encodeURIComponent(String(rule.id))}`)
          message.success('规则已删除')
          const next = await fetchRules()
          setRules(next)
          setLoadError(null)
          setCreating(false)
          setSelectedId(desktop ? next[0]?.id ?? null : null)
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

  const listPane = (
    <div>
      <PaneTitle
        title="端口转发"
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
              loading={loading}
              aria-label="刷新规则"
              onClick={() => void loadRules()}
            />
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建
            </Button>
          </Space>
        }
      />

      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称 / 监听 / 目标地址"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <Select
            size="small"
            value={protoFilter}
            onChange={setProtoFilter}
            options={[{ value: 'all', label: '全部协议' }, ...PROTOCOL_OPTIONS]}
            style={{ flex: 1, minWidth: 110 }}
            aria-label="协议筛选"
          />
          <Muted>
            {filtered.length}/{rules.length}
            {summary.portBusy ? ` · 端口占用 ${summary.portBusy}` : ''}
          </Muted>
        </div>
      </div>

      {loadError ? (
        <div style={{ padding: 10 }}>
          <Alert
            type="error"
            showIcon
            message="加载规则失败"
            description={errorText(loadError)}
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
          const hasAccess = Boolean(rule.access && rule.access.mode !== 'off')
          return (
          <EntityRow
            key={rule.id}
            title={rule.name || rule.id}
            subtitle={
              <span className="mono">
                {rule.srcAddr || '-'} → {rule.dstAddr || '-'}
              </span>
            }
            meta={
              <Space size={4} wrap>
                <Tag color={protocolColor(rule.protocol)} style={{ marginInlineEnd: 0 }}>
                  {PROTOCOL_LABEL[rule.protocol || ''] || rule.protocol || '-'}
                </Tag>
                {hasAccess ? <AccessTag access={rule.access} /> : null}
                {rule.enable ? null : <Tag style={{ marginInlineEnd: 0 }}>已停用</Tag>}
                <Muted>
                  活跃 {num(rule.activeConns)} · ↑ {fmtBytes(rule.upBytes)}
                </Muted>
              </Space>
            }
            status={ruleStatus(rule)}
            selected={!creating && selectedRule?.id === rule.id}
            onClick={() => selectRule(rule)}
            actions={
              <div onClick={(event) => event.stopPropagation()}>
                <Switch
                  size="small"
                  checked={Boolean(rule.enable)}
                  loading={busyId === String(rule.id)}
                  disabled={busyId !== '' && busyId !== String(rule.id)}
                  onChange={(checked) => void toggleRule(rule, checked)}
                  aria-label={`启停规则 ${rule.name || rule.id}`}
                />
              </div>
            }
          />
          )
        })}

        {!loading && !filtered.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={rules.length ? '没有符合筛选条件的规则' : '还没有端口转发规则'}
            style={{ padding: '24px 0' }}
          >
            {!rules.length ? (
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建规则
              </Button>
            ) : null}
          </Empty>
        ) : null}
      </div>
    </div>
  )

  const rule = selectedRule
  // The form keeps the rule's real switch state; a port-busy rule is saved as
  // enabled so that saving it retries the bind.
  const effectiveEnable = rule ? Boolean(rule.enable) && !rule.disabled : draftEnable

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
      <Muted>创建后会立即按填写的监听地址尝试绑定端口。</Muted>
      <Section title="规则配置" first>
        <ForwardRuleForm
          key="new"
          rule={null}
          enable={draftEnable}
          saving={saving}
          onSubmit={saveRule}
          onCancel={backToList}
          cancelLabel="取消"
        />
      </Section>
    </div>
  ) : rule ? (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {rule.name || rule.id}
        </Typography.Title>
        <Tag color={protocolColor(rule.protocol)}>
          {PROTOCOL_LABEL[rule.protocol || ''] || rule.protocol || '-'}
        </Tag>
        {rule.access && rule.access.mode !== 'off' ? (
          <AccessTag access={rule.access} />
        ) : null}
        {rule.disabled ? <Tag color="error">端口占用</Tag> : null}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => removeRule(rule)}
          >
            删除
          </Button>
        </div>
      </div>
      <div className="mono" style={{ marginTop: 4, fontSize: 12, wordBreak: 'break-all' }}>
        <Typography.Text type="secondary">
          {rule.srcAddr || '-'} → {rule.dstAddr || '-'}
        </Typography.Text>
      </div>
      {rule.remark ? <Muted>{rule.remark}</Muted> : null}

      {rule.disabled ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 10 }}
          message="端口被占用，规则已自动停用"
          description="释放占用该端口的进程后，用列表里的开关重新启用；后端会重试绑定。"
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(116px, 1fr))',
          gap: 8,
          marginTop: 14,
        }}
      >
        <Metric label="活跃连接" value={num(rule.activeConns)} hint="当前正在转发" />
        <Metric label="累计连接" value={num(rule.totalConns)} hint="进程启动以来" />
        <Metric label="上行流量" value={fmtBytes(rule.upBytes)} hint="客户端 → 目标" />
        <Metric label="下行流量" value={fmtBytes(rule.downBytes)} hint="目标 → 客户端" />
        <Metric
          label="被上限拒绝"
          value={num(rule.rejectedRuleLimit) + num(rule.rejectedIpLimit)}
          hint={`规则 ${num(rule.rejectedRuleLimit)} · 单 IP ${num(rule.rejectedIpLimit)}`}
        />
      </div>

      <Section
        title="规则配置"
        extra={<Muted>保存后立即生效 · 并发 {num(rule.connLimit) || '不限'}/{num(rule.connLimitPerIp) || '不限'}</Muted>}
        first={false}
      >
        <ForwardRuleForm
          key={rule.id}
          rule={rule}
          enable={effectiveEnable}
          saving={saving}
          onSubmit={saveRule}
        />
      </Section>
    </div>
  ) : (
    <div style={{ padding: '56px 0' }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={rules.length ? '从左侧选择一条规则查看详情' : '还没有端口转发规则'}
      >
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
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
