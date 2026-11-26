import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Select, Space, Switch, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { api, errorText } from '../../api'
import { fmtBytes, fmtTime } from '../../format'
import { DataTable, Muted } from '../../components'
import {
  durationText,
  logResultColor,
  PROTOCOL_LABEL,
  type ForwardLog,
  type ForwardLogsResponse,
  type ForwardRule,
} from './types'

const LIMIT_OPTIONS = [50, 100, 200].map((value) => ({ value, label: `最近 ${value} 条` }))

/** The per-rule access log buffer, shown inside the detail pane. */
export default function ForwardLogsPanel({ rule }: { rule: ForwardRule }) {
  const { message } = App.useApp()
  const [limit, setLimit] = useState(100)
  const [auto, setAuto] = useState(false)
  const [logs, setLogs] = useState<ForwardLog[]>([])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const seq = useRef(0)

  const load = useCallback(
    async (size: number) => {
      const ticket = ++seq.current
      setLoading(true)
      try {
        const data = await api.get<ForwardLogsResponse | ForwardLog[]>('/api/v1/forward/logs', {
          rule: rule.id,
          limit: size,
        })
        if (ticket !== seq.current) return
        const items = Array.isArray(data) ? data : data?.items || []
        setLogs(items.map((item, index) => ({ ...item, key: item.key || `${item.time || ''}-${index}` })))
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
    [message, rule.id],
  )

  useEffect(() => {
    void load(limit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule.id])

  useEffect(() => {
    if (!auto) return
    const timer = window.setInterval(() => {
      void load(limit)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [auto, limit, load])

  const changeLimit = (value: number) => {
    setLimit(value)
    void load(value)
  }

  const columns: TableColumnsType<ForwardLog> = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 150,
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '来源 → 目标',
      key: 'endpoints',
      render: (_value, row) => (
        <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          <div>{row.client || '-'}</div>
          <Muted>
            → {row.target || '-'} · {PROTOCOL_LABEL[row.protocol || ''] || String(row.protocol || '').toUpperCase() || '-'}
          </Muted>
        </div>
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      width: 110,
      render: (value) => (
        <Tag
          color={logResultColor(value)}
          title={String(value || '')}
          style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {String(value || '-')}
        </Tag>
      ),
    },
    {
      title: '流量',
      key: 'bytes',
      width: 150,
      responsive: ['md'],
      render: (_value, row) => (
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
          ↑ {fmtBytes(row.bytesIn)} / ↓ {fmtBytes(row.bytesOut)}
        </span>
      ),
    },
    {
      title: '持续',
      dataIndex: 'duration',
      key: 'duration',
      width: 90,
      responsive: ['lg'],
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{durationText(value)}</span>,
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <Select
          size="small"
          value={limit}
          onChange={changeLimit}
          options={LIMIT_OPTIONS}
          style={{ width: 130 }}
          aria-label="日志条数"
        />
        <Space size={6}>
          <Switch checked={auto} onChange={setAuto} size="small" aria-label="自动刷新日志" />
          <Muted>自动刷新</Muted>
        </Space>
        <Tag color={enabled ? 'green' : 'default'}>{enabled ? '记录中' : '未启用'}</Tag>
        <Muted>共 {logs.length} 条</Muted>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load(limit)}
          style={{ marginLeft: 'auto' }}
        >
          刷新
        </Button>
      </div>

      {!enabled ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="访问日志当前未启用"
          description="后端的端口转发访问日志开关关闭时，新连接不会写入；这里显示的是已有记录。"
        />
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={`加载访问日志失败：${errorText(error)}`}
          action={
            <Button size="small" onClick={() => void load(limit)}>
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
        pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
        locale={{ emptyText: loading ? '加载中…' : '暂无访问日志' }}
      />

      <Muted>本面板只显示内存缓冲；完整历史可在「日志 → 访问日志」按来源「端口转发」检索。</Muted>
    </div>
  )
}
