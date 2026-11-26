import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Modal, Select, Space, Switch, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { api, errorText } from '../../api'
import { fmtBytes, fmtTime } from '../../format'
import { DataTable, modalWidth, Muted, Toolbar, useIsMobile } from '../../components'
import {
  durationText,
  logResultColor,
  PROTOCOL_LABEL,
  type ForwardLog,
  type ForwardLogsResponse,
  type ForwardRule,
} from './types'

interface LogsModalProps {
  open: boolean
  rules: ForwardRule[]
  initialRuleId: string
  onClose: () => void
}

const LIMIT_OPTIONS = [100, 200, 500].map((value) => ({ value, label: `最近 ${value} 条` }))

export default function ForwardLogsModal({ open, rules, initialRuleId, onClose }: LogsModalProps) {
  const { message } = App.useApp()
  const isMobile = useIsMobile()
  const [ruleId, setRuleId] = useState(initialRuleId)
  const [limit, setLimit] = useState(200)
  const [auto, setAuto] = useState(false)
  const [logs, setLogs] = useState<ForwardLog[]>([])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const seq = useRef(0)

  const load = useCallback(
    async (rule: string, size: number) => {
      const ticket = ++seq.current
      setLoading(true)
      try {
        const data = await api.get<ForwardLogsResponse | ForwardLog[]>('/api/v1/forward/logs', {
          rule: rule || undefined,
          limit: size,
        })
        if (ticket !== seq.current) return
        const items = Array.isArray(data) ? data : data?.items || []
        setLogs(
          items.map((item, index) => ({
            ...item,
            key: item.key || `${item.time || ''}-${index}`,
          })),
        )
        setEnabled(Array.isArray(data) ? true : data?.enabled !== false)
        setError(null)
      } catch (err) {
        if (ticket !== seq.current) return
        setError(err)
        message.error(errorText(err))
      } finally {
        if (ticket === seq.current) setLoading(false)
      }
    },
    [message],
  )

  // A fresh open resets the filter to the rule that asked for the log window.
  useEffect(() => {
    if (!open) return
    setRuleId(initialRuleId)
    setAuto(false)
    void load(initialRuleId, limit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRuleId])

  useEffect(() => {
    if (!open || !auto) return
    const timer = window.setInterval(() => {
      void load(ruleId, limit)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [open, auto, ruleId, limit, load])

  const onRuleChange = (value: string) => {
    setRuleId(value)
    void load(value, limit)
  }

  const onLimitChange = (value: number) => {
    setLimit(value)
    void load(ruleId, value)
  }

  const columns: TableColumnsType<ForwardLog> = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 160,
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '规则',
      dataIndex: 'rule',
      key: 'rule',
      width: 140,
      render: (_value, row) => <span style={{ fontSize: 12 }}>{row.rule || row.ruleId || '-'}</span>,
    },
    {
      title: '协议',
      dataIndex: 'protocol',
      key: 'protocol',
      width: 90,
      responsive: ['md'],
      render: (value) => <Tag>{PROTOCOL_LABEL[String(value || '')] || String(value || '-').toUpperCase()}</Tag>,
    },
    {
      title: '来源 → 目标',
      key: 'endpoints',
      width: 240,
      render: (_value, row) => (
        <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          <div>{row.client || '-'}</div>
          <Muted>→ {row.target || '-'}</Muted>
        </div>
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      width: 130,
      render: (value) => (
        <Tag
          color={logResultColor(value)}
          title={String(value || '')}
          style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {String(value || '-')}
        </Tag>
      ),
    },
    {
      title: '持续',
      dataIndex: 'duration',
      key: 'duration',
      width: 100,
      responsive: ['lg'],
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{durationText(value)}</span>,
    },
    {
      title: '上行 / 下行',
      key: 'bytes',
      width: 150,
      render: (_value, row) => (
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
          ↑ {fmtBytes(row.bytesIn)} / ↓ {fmtBytes(row.bytesOut)}
        </span>
      ),
    },
    {
      title: '数据包',
      dataIndex: 'packets',
      key: 'packets',
      width: 90,
      responsive: ['xl'],
      render: (value) => <span style={{ fontSize: 12 }}>{value ? String(value) : '-'}</span>,
    },
  ]

  const ruleOptions = [
    { value: '__all__', label: '全部规则' },
    ...rules.map((rule) => ({ value: String(rule.id), label: rule.name || String(rule.id) })),
  ]

  return (
    <Modal
      open={open}
      title="访问日志"
      width={modalWidth(true)}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      styles={{ body: { maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto' } }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Toolbar>
          <Select
            value={ruleId || '__all__'}
            onChange={(value) => onRuleChange(value === '__all__' ? '' : value)}
            options={ruleOptions}
            style={{ width: isMobile ? '100%' : 220 }}
            aria-label="按规则筛选"
          />
          <Select
            value={limit}
            onChange={onLimitChange}
            options={LIMIT_OPTIONS}
            style={{ width: isMobile ? '100%' : 140 }}
            aria-label="日志条数"
          />
          <Space size={6}>
            <Switch checked={auto} onChange={setAuto} size="small" aria-label="自动刷新" />
            <Muted>自动刷新（5 秒）</Muted>
          </Space>
          <Tag color={enabled ? 'green' : 'default'}>{enabled ? '记录中' : '未启用'}</Tag>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load(ruleId, limit)}
          >
            刷新
          </Button>
          <Muted>共 {logs.length} 条</Muted>
        </Toolbar>

        {!enabled ? (
          <Alert
            type="warning"
            showIcon
            message="访问日志当前未启用"
            description="后端的端口转发访问日志开关关闭时，新连接不会写入日志；下方显示的是已有记录。"
          />
        ) : null}

        {error ? (
          <Alert
            type="error"
            showIcon
            message={`加载访问日志失败：${errorText(error)}`}
            action={
              <Button size="small" onClick={() => void load(ruleId, limit)}>
                重试
              </Button>
            }
          />
        ) : null}

        <DataTable<ForwardLog>
          rowKey={(row) => String(row.key)}
          columns={columns}
          dataSource={logs}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
        />

        <Muted>
          本窗口只显示内存缓冲；完整历史记录可在「日志 → 访问日志」中按来源「端口转发」检索并导出。
        </Muted>
      </Space>
    </Modal>
  )
}
