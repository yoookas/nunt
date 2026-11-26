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
  Select,
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
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { api, ApiError, errorText } from '../api'
import { fmtBytes } from '../format'
import {
  confirmDelete,
  DataTable,
  Muted,
  PageHeader,
  Panel,
  Toolbar,
  useIsMobile,
} from '../components'
import { usePolling } from '../usePolling'
import ForwardRuleModal from './forward/RuleModal'
import ForwardLogsModal from './forward/LogsModal'
import {
  limitText,
  num,
  PROTOCOL_LABEL,
  PROTOCOL_OPTIONS,
  protocolColor,
  ruleAccessColor,
  ruleAccessText,
  ruleAccessTip,
  timeoutText,
  type ForwardRule,
} from './forward/types'

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
    <Tooltip title="每 5 秒自动刷新连接数与流量">
      <Space size={4}>
        <Badge status={failed ? 'error' : updatedAt ? 'processing' : 'default'} />
        <Muted>{text}</Muted>
      </Space>
    </Tooltip>
  )
}

export default function Forward() {
  const { message } = App.useApp()
  const isMobile = useIsMobile()
  const [rules, setRules] = useState<ForwardRule[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [protoFilter, setProtoFilter] = useState('all')
  const [editor, setEditor] = useState<{ open: boolean; rule: ForwardRule | null; seq: number }>({
    open: false,
    rule: null,
    seq: 0,
  })
  const [logsView, setLogsView] = useState<{ open: boolean; ruleId: string; seq: number }>({
    open: false,
    ruleId: '',
    seq: 0,
  })

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
  // failing poll only flips the hint: no toast spam from a background refresh.
  const live = usePolling(async () => {
    try {
      applyRules(await fetchRules())
    } catch (err) {
      setLoadError(err)
      throw err
    }
  }, 5000)

  const summary = useMemo(() => {
    const out = {
      enabled: 0,
      listening: 0,
      portBusy: 0,
      active: 0,
      total: 0,
      up: 0,
      down: 0,
      rejectedRule: 0,
      rejectedIp: 0,
    }
    for (const rule of rules) {
      out.active += num(rule.activeConns)
      out.total += num(rule.totalConns)
      out.up += num(rule.upBytes)
      out.down += num(rule.downBytes)
      out.rejectedRule += num(rule.rejectedRuleLimit)
      out.rejectedIp += num(rule.rejectedIpLimit)
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
          await loadRules(true)
        } catch (err) {
          message.error(errorText(err))
        }
      },
    )
  }

  const openCreate = () => setEditor((prev) => ({ open: true, rule: null, seq: prev.seq + 1 }))
  const openEdit = (rule: ForwardRule) => setEditor((prev) => ({ open: true, rule, seq: prev.seq + 1 }))
  const openLogs = (ruleId: string) =>
    setLogsView((prev) => ({ open: true, ruleId, seq: prev.seq + 1 }))

  const columns: TableColumnsType<ForwardRule> = [
    {
      title: '规则',
      key: 'rule',
      width: 280,
      render: (_value, row) => (
        <div style={{ minWidth: 200 }}>
          <Space size={6} wrap>
            <Typography.Text strong style={{ wordBreak: 'break-all' }}>
              {row.name || row.id}
            </Typography.Text>
            <Tag color={protocolColor(row.protocol)}>
              {PROTOCOL_LABEL[row.protocol || ''] || row.protocol || '-'}
            </Tag>
            {row.listening ? <Tag color="processing">监听中</Tag> : null}
            {row.disabled ? <Tag color="red">端口占用</Tag> : null}
          </Space>
          <div
            className="mono"
            style={{ fontSize: 12, marginTop: 2, wordBreak: 'break-all' }}
            title={`${row.srcAddr || '-'} → ${row.dstAddr || '-'}`}
          >
            <Typography.Text type="secondary">
              {row.srcAddr || '-'} → {row.dstAddr || '-'}
            </Typography.Text>
          </div>
          {row.remark ? <Muted>{row.remark}</Muted> : null}
        </div>
      ),
    },
    {
      title: '访问 / 限制',
      key: 'limits',
      width: 230,
      responsive: ['lg'],
      render: (_value, row) => {
        const rejected = num(row.rejectedRuleLimit) + num(row.rejectedIpLimit)
        return (
          <div>
            <Space size={4} wrap>
              <Tooltip title={ruleAccessTip(row)}>
                <Tag color={ruleAccessColor(row)}>{ruleAccessText(row)}</Tag>
              </Tooltip>
              <Muted>超时 {timeoutText(row.timeoutSec)}</Muted>
            </Space>
            <div style={{ marginTop: 2 }}>
              <Muted>
                并发 {limitText(row.connLimit)}/{limitText(row.connLimitPerIp)}
                {rejected > 0 ? ` · 拒绝 ${rejected}` : ''}
              </Muted>
            </div>
          </div>
        )
      },
    },
    {
      title: '实时统计',
      key: 'stats',
      width: 190,
      responsive: ['md'],
      render: (_value, row) => (
        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <div>
            活跃 {num(row.activeConns)} · 累计 {num(row.totalConns)}
          </div>
          <Muted>
            ↑ {fmtBytes(row.upBytes)} · ↓ {fmtBytes(row.downBytes)}
          </Muted>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      render: (_value, row) => {
        const id = String(row.id)
        return (
          <Space size={8} style={{ whiteSpace: 'nowrap' }}>
            <Switch
              size="small"
              checked={Boolean(row.enable) && !row.disabled}
              loading={busyId === id}
              disabled={busyId !== '' && busyId !== id}
              onChange={(checked) => void toggleRule(row, checked)}
              aria-label={`${row.name || row.id} 启停`}
            />
            <Muted>{row.disabled ? '端口被占用' : row.enable ? '启用' : '停用'}</Muted>
          </Space>
        )
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_value, row) => (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            icon={<FileTextOutlined />}
            onClick={() => openLogs(String(row.id))}
          >
            日志
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => removeRule(row)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="端口转发"
        subtitle="TCP / UDP 端口映射、源地址访问控制、并发上限与实时运行统计"
        extra={
          <>
            <LiveHint updatedAt={live.updatedAt} failed={live.failed} />
            <Button icon={<ReloadOutlined />} onClick={() => void loadRules()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建规则
            </Button>
          </>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`加载转发规则失败：${errorText(loadError)}`}
          action={
            <Button size="small" onClick={() => void loadRules()}>
              重试
            </Button>
          }
        />
      ) : null}

      <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile
            title="转发规则"
            value={rules.length}
            hint={`启用 ${summary.enabled} · 监听 ${summary.listening}`}
          />
        </Col>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile title="活跃连接" value={summary.active} hint="当前正在转发的连接数" />
        </Col>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile title="累计连接" value={summary.total} hint="进程启动以来接受的连接" />
        </Col>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile title="上行流量" value={fmtBytes(summary.up)} hint="客户端 → 目标" />
        </Col>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile title="下行流量" value={fmtBytes(summary.down)} hint="目标 → 客户端" />
        </Col>
        <Col xs={12} sm={12} md={8} xl={4}>
          <StatTile
            title="被限流拒绝"
            value={summary.rejectedRule + summary.rejectedIp}
            hint={`规则上限 ${summary.rejectedRule} · 单 IP ${summary.rejectedIp}`}
          />
        </Col>
      </Row>

      <Panel title="转发规则">
        <Toolbar>
          <Select
            value={protoFilter}
            onChange={setProtoFilter}
            options={[{ value: 'all', label: '全部协议' }, ...PROTOCOL_OPTIONS]}
            style={{ width: isMobile ? '100%' : 140 }}
            aria-label="协议筛选"
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索名称 / 监听 / 目标地址"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: isMobile ? '100%' : 280 }}
          />
          <Button icon={<FileTextOutlined />} onClick={() => openLogs('')}>
            访问日志
          </Button>
          <Muted>
            共 {rules.length} 条 · 显示 {filtered.length} 条
          </Muted>
        </Toolbar>

        {summary.portBusy > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={`${summary.portBusy} 条规则因监听端口被占用而自动停用`}
            description="释放端口后，打开列表中的启停开关即可重新尝试绑定。"
          />
        ) : null}

        <div style={{ marginTop: 12 }}>
          <DataTable<ForwardRule>
            rowKey={(row) => String(row.id)}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={PAGINATION}
          />
        </div>
      </Panel>

      <ForwardRuleModal
        key={editor.seq}
        open={editor.open}
        rule={editor.rule}
        onClose={() => setEditor((prev) => ({ ...prev, open: false }))}
        onSaved={() => loadRules(true)}
      />
      <ForwardLogsModal
        key={logsView.seq}
        open={logsView.open}
        rules={rules}
        initialRuleId={logsView.ruleId}
        onClose={() => setLogsView((prev) => ({ ...prev, open: false }))}
      />
    </div>
  )
}
