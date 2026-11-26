import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  Statistic,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import { confirmDelete, DataTable, Muted, PageHeader, Panel, Toolbar, useIsMobile } from '../components'
import { usePolling } from '../usePolling'
import DdnsRuleModal from './ddns/RuleModal'
import DdnsLogsModal from './ddns/LogsModal'
import {
  ipModeText,
  num,
  providerTitle,
  scheduleText,
  statusMessage,
  type DdnsRule,
  type DdnsStatus,
  type ProviderMeta,
} from './ddns/types'

const PAGINATION = { pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }

function StatTile({ title, value, hint }: { title: string; value: string | number; hint?: ReactNode }) {
  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <Statistic
        title={title}
        value={value}
        valueStyle={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}
      />
      {hint ? (
        <div style={{ marginTop: 4 }}>
          <Muted>{hint}</Muted>
        </div>
      ) : null}
    </Card>
  )
}

function LiveHint({ updatedAt, failed }: { updatedAt: number | null; failed: boolean }) {
  const text = failed
    ? '自动刷新失败'
    : updatedAt
      ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '等待自动刷新'
  return (
    <Tooltip title="每 10 秒自动刷新规则状态与执行计数">
      <Space size={4}>
        <Badge status={failed ? 'error' : updatedAt ? 'processing' : 'default'} />
        <Muted>{text}</Muted>
      </Space>
    </Tooltip>
  )
}

function normalizeRules(data: DdnsRule[] | { rules?: DdnsRule[]; items?: DdnsRule[] } | null): DdnsRule[] {
  if (Array.isArray(data)) return data
  return data?.rules || data?.items || []
}

function normalizeStatuses(data: DdnsStatus[] | { rules?: DdnsStatus[] } | null): DdnsStatus[] {
  if (Array.isArray(data)) return data
  return data?.rules || []
}

export default function Ddns() {
  const { message, modal } = App.useApp()
  const isMobile = useIsMobile()
  const [rules, setRules] = useState<DdnsRule[]>([])
  const [statuses, setStatuses] = useState<DdnsStatus[]>([])
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [rulesError, setRulesError] = useState<unknown>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<unknown>(null)
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [editor, setEditor] = useState<{ open: boolean; rule: DdnsRule | null; seq: number }>({
    open: false,
    rule: null,
    seq: 0,
  })
  const [logsTarget, setLogsTarget] = useState<{ open: boolean; status: DdnsStatus | null; seq: number }>({
    open: false,
    status: null,
    seq: 0,
  })

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

  // Schedule and last result live on the rules, the counters on the status
  // endpoint. Both are re-read quietly; a failed poll only tints the hint.
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

  const refreshAll = async () => {
    await Promise.all([loadRules(), loadStatus()])
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
          await Promise.all([loadRules(true), loadStatus(true)])
        } catch (err) {
          message.error(errorText(err))
        }
      },
    )
  }

  const openLogs = (status: DdnsStatus) =>
    setLogsTarget((prev) => ({ open: true, status, seq: prev.seq + 1 }))

  const openRuleLogs = (rule: DdnsRule) => {
    openLogs(
      statusMap[rule.id] || {
        id: rule.id,
        name: rule.name,
        enable: rule.enable,
        records: [],
      },
    )
  }

  const openCreate = () => setEditor((prev) => ({ open: true, rule: null, seq: prev.seq + 1 }))
  const openEdit = (rule: DdnsRule) => setEditor((prev) => ({ open: true, rule, seq: prev.seq + 1 }))

  const ruleColumns: TableColumnsType<DdnsRule> = [
    {
      title: '规则',
      key: 'name',
      width: 220,
      render: (_value, row) => (
        <div style={{ minWidth: 150 }}>
          <Typography.Text strong style={{ wordBreak: 'break-all' }}>
            {row.name || row.id}
          </Typography.Text>
          {row.remark ? (
            <div>
              <Muted>{row.remark}</Muted>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: '域名 / 子域',
      key: 'domain',
      width: 250,
      render: (_value, row) => (
        <div style={{ minWidth: 170 }}>
          <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {row.domain || '-'}
          </div>
          {Array.isArray(row.subDomains) && row.subDomains.length ? (
            <Space size={4} wrap style={{ marginTop: 4 }}>
              {row.subDomains.map((sub) => (
                <Tag key={sub} style={{ marginInlineEnd: 0 }}>
                  {sub}
                </Tag>
              ))}
            </Space>
          ) : null}
        </div>
      ),
    },
    {
      title: '提供商 / 类型',
      key: 'provider',
      width: 190,
      responsive: ['md'],
      render: (_value, row) => (
        <Space size={4} wrap>
          <Tag color="blue">{providerTitle(providers, row.provider)}</Tag>
          <Tag>{row.recordType || 'A'}</Tag>
        </Space>
      ),
    },
    {
      title: 'IP 探测',
      key: 'probe',
      width: 150,
      responsive: ['lg'],
      render: (_value, row) => (
        <div style={{ fontSize: 12 }}>
          <div>IPv4：{ipModeText(row.ipv4)}</div>
          <div>IPv6：{ipModeText(row.ipv6)}</div>
        </div>
      ),
    },
    {
      title: '调度',
      key: 'schedule',
      width: 180,
      responsive: ['lg'],
      render: (_value, row) => (
        <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {scheduleText(row)}
        </span>
      ),
    },
    {
      title: '当前 IP',
      key: 'ip',
      width: 170,
      responsive: ['md'],
      render: (_value, row) => {
        const state = statusMap[row.id]
        const ips = [state?.ipv4, state?.ipv6].filter(Boolean) as string[]
        if (!ips.length) return <Muted>-</Muted>
        return (
          <div className="mono" style={{ fontSize: 12 }}>
            {ips.map((ip) => (
              <div key={ip} style={{ wordBreak: 'break-all' }}>
                {ip}
              </div>
            ))}
          </div>
        )
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 140,
      render: (_value, row) => {
        const id = String(row.id)
        return (
          <Space size={8} style={{ whiteSpace: 'nowrap' }}>
            <Switch
              size="small"
              checked={Boolean(row.enable)}
              loading={busyId === id}
              disabled={busyId !== '' && busyId !== id}
              onChange={(checked) => void toggleRule(row, checked)}
              aria-label={`${row.name || row.id} 启停`}
            />
            <Muted>{row.enable ? '启用' : '停用'}</Muted>
          </Space>
        )
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_value, row) => {
        const busy = busyId === String(row.id)
        const label = (text: string) => (isMobile ? null : text)
        return (
          <Space size={0} wrap>
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={busy}
              disabled={!row.enable}
              title="立即执行"
              onClick={() => runRule(row)}
            >
              {label('执行')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<FileTextOutlined />}
              title="运行日志"
              onClick={() => openRuleLogs(row)}
            >
              {label('日志')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              title="编辑"
              onClick={() => openEdit(row)}
            >
              {label('编辑')}
            </Button>
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              title="删除"
              onClick={() => removeRule(row)}
            >
              {label('删除')}
            </Button>
          </Space>
        )
      },
    },
  ]

  const statusColumns: TableColumnsType<DdnsStatus> = [
    {
      title: '规则',
      key: 'name',
      width: 190,
      render: (_value, row) => (
        <div style={{ minWidth: 120 }}>
          <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{row.name || row.id}</div>
          <Muted>{row.enable ? '启用' : '停用'}</Muted>
        </div>
      ),
    },
    {
      title: 'IPv4',
      dataIndex: 'ipv4',
      key: 'ipv4',
      width: 150,
      render: (value) => (
        <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {value || '-'}
        </span>
      ),
    },
    {
      title: 'IPv6',
      dataIndex: 'ipv6',
      key: 'ipv6',
      width: 210,
      responsive: ['lg'],
      render: (value) => (
        <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {value || '-'}
        </span>
      ),
    },
    {
      title: '上次执行',
      dataIndex: 'lastRun',
      key: 'lastRun',
      width: 170,
      responsive: ['md'],
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '上次成功',
      dataIndex: 'lastSuccess',
      key: 'lastSuccess',
      width: 170,
      responsive: ['xl'],
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '成功 / 失败',
      key: 'counts',
      width: 160,
      responsive: ['md'],
      render: (_value, row) => (
        <Space size={4} wrap>
          <Tag color="green">成功 {num(row.success)}</Tag>
          <Tag color={num(row.failures) ? 'red' : 'default'}>失败 {num(row.failures)}</Tag>
        </Space>
      ),
    },
    {
      title: '最近结果',
      key: 'message',
      render: (_value, row) => {
        const text = statusMessage(row)
        return (
          <Typography.Text
            ellipsis={{ tooltip: text }}
            style={{ maxWidth: 300, fontSize: 12 }}
          >
            {text}
          </Typography.Text>
        )
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_value, row) => (
        <Button type="link" size="small" icon={<FileTextOutlined />} title="运行日志" onClick={() => openLogs(row)}>
          {isMobile ? null : '日志'}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="动态域名"
        subtitle="把域名持续指向当前公网 IP：提供商凭据、探测方式、调度与运行状态"
        extra={
          <>
            <LiveHint updatedAt={live.updatedAt} failed={live.failed} />
            <Button
              icon={<ReloadOutlined />}
              loading={loading || statusLoading}
              onClick={() => void refreshAll()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!providers.length}
              title={providers.length ? undefined : '尚未获取到 DNS 提供商列表'}
              onClick={openCreate}
            >
              新建规则
            </Button>
          </>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {providersError ? (
          <Alert
            type="error"
            showIcon
            message={`无法读取 DNS 提供商列表：${errorText(providersError)}`}
            action={
              <Button size="small" onClick={() => void loadProviders()} loading={providersLoading}>
                重试
              </Button>
            }
          />
        ) : null}

        {!providersError && !providersLoading && !providers.length ? (
          <Alert
            type="warning"
            showIcon
            message="尚未获取到 DNS 提供商列表"
            description="新建规则依赖提供商字段元数据；请点击重试或检查后端 /api/v1/ddns/providers。"
            action={
              <Button size="small" onClick={() => void loadProviders()} loading={providersLoading}>
                重试
              </Button>
            }
          />
        ) : null}

        <Row gutter={[8, 8]}>
          <Col xs={12} md={6}>
            <StatTile title="DDNS 规则" value={rules.length} hint={`启用 ${summary.enabled} 条`} />
          </Col>
          <Col xs={12} md={6}>
            <StatTile title="已启用" value={summary.enabled} hint="当前参与调度的规则" />
          </Col>
          <Col xs={12} md={6}>
            <StatTile title="累计成功" value={summary.success} hint="来自 /api/v1/ddns/status" />
          </Col>
          <Col xs={12} md={6}>
            <StatTile title="累计失败" value={summary.failures} hint="失败原因可在运行日志中查看" />
          </Col>
        </Row>

        <Panel title="DDNS 规则">
          <Toolbar>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索名称 / 域名 / 提供商 / 子域名"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: isMobile ? '100%' : 300 }}
            />
            <Muted>
              共 {rules.length} 条 · 显示 {filtered.length} 条
            </Muted>
          </Toolbar>

          {rulesError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              message={`加载 DDNS 规则失败：${errorText(rulesError)}`}
              action={
                <Button size="small" onClick={() => void loadRules()}>
                  重试
                </Button>
              }
            />
          ) : null}

          <div style={{ marginTop: 12 }}>
            <DataTable<DdnsRule>
              rowKey={(row) => String(row.id)}
              columns={ruleColumns}
              dataSource={filtered}
              loading={loading}
              pagination={PAGINATION}
            />
          </div>
        </Panel>

        <Panel
          title="运行状态"
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={statusLoading}
              onClick={() => void loadStatus()}
            >
              刷新状态
            </Button>
          }
        >
          <Muted>来自 /api/v1/ddns/status；规则执行一次后这里会出现当前 IP、时间与结果。</Muted>

          {statusError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              message={`加载运行状态失败：${errorText(statusError)}`}
              action={
                <Button size="small" onClick={() => void loadStatus()}>
                  重试
                </Button>
              }
            />
          ) : null}

          <div style={{ marginTop: 12 }}>
            <DataTable<DdnsStatus>
              rowKey={(row) => String(row.id)}
              columns={statusColumns}
              dataSource={statuses}
              loading={statusLoading}
              pagination={PAGINATION}
            />
          </div>
        </Panel>
      </div>

      <DdnsRuleModal
        key={editor.seq}
        open={editor.open}
        rule={editor.rule}
        providers={providers}
        providersLoading={providersLoading}
        providersError={providersError}
        onReloadProviders={() => void loadProviders()}
        onClose={() => setEditor((prev) => ({ ...prev, open: false }))}
        onSaved={async () => {
          await Promise.all([loadRules(true), loadStatus(true)])
        }}
      />
      <DdnsLogsModal
        key={logsTarget.seq}
        open={logsTarget.open}
        status={logsTarget.status}
        onClose={() => setLogsTarget((prev) => ({ ...prev, open: false }))}
      />
    </div>
  )
}
