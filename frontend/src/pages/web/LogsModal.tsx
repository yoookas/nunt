import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Empty, Modal, Switch, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { DataTable, Muted, StatusTag, modalWidth } from '../../components'
import { fmtBytes, fmtTime } from '../../format'
import type { AccessEntry, ListResponse, WebRule } from './types'

/** The API returns a few more fields than the generated types need to name. */
interface LogEntry extends AccessEntry {
  host?: string
  proto?: string
  tls?: string
  upstreamStatus?: number
  attempts?: number
  bytesIn?: number
  bytesOut?: number
  requestId?: string
  reason?: string
  error?: string
  wafAction?: string
  wafRuleId?: number
  message?: string
  country?: string
  province?: string
  city?: string
}

interface LogRow extends LogEntry {
  _key: string
}

export default function LogsModal({
  open,
  rule,
  onClose,
}: {
  open: boolean
  rule: WebRule | null
  onClose: () => void
}) {
  const { message } = App.useApp()
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [error, setError] = useState('')
  const loadingRef = useRef(false)
  const ruleId = rule?.id || ''

  const load = useCallback(
    async (silent = false) => {
      if (!ruleId || loadingRef.current) return
      loadingRef.current = true
      setLoading(true)
      try {
        const data = await api.get<ListResponse<LogEntry>>('/api/v1/web/logs', {
          rule: ruleId,
          limit: 200,
        })
        const items = Array.isArray(data?.items) ? data.items : []
        setRows(items.map((item, index) => ({ ...item, _key: `${item.time || ''}-${index}` })))
        setError('')
      } catch (err) {
        const text = errorText(err)
        setError(text)
        if (!silent) message.error(text)
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [ruleId, message],
  )

  useEffect(() => {
    if (!open) {
      setRows([])
      setError('')
      return
    }
    void load(false)
    if (!auto) return
    const timer = window.setInterval(() => {
      void load(true)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [open, auto, load])

  const columns = [
    {
      key: 'time',
      title: '时间',
      width: 154,
      render: (_: unknown, row: LogRow) => (
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(row.time)}</span>
      ),
    },
    {
      key: 'client',
      title: '客户端',
      width: 132,
      responsive: ['md' as const],
      render: (_: unknown, row: LogRow) => (
        <Typography.Text className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {row.clientIp || '-'}
        </Typography.Text>
      ),
    },
    {
      key: 'request',
      title: '请求',
      render: (_: unknown, row: LogRow) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
            <Typography.Text className="mono" style={{ fontSize: 12, flex: 'none' }}>
              {row.method || '-'}
            </Typography.Text>
            <Typography.Text
              className="mono"
              ellipsis={{ tooltip: row.path }}
              style={{ fontSize: 12, minWidth: 0 }}
            >
              {row.path || '-'}
            </Typography.Text>
          </div>
          <Typography.Text
            type="secondary"
            ellipsis={{ tooltip: row.userAgent }}
            style={{ fontSize: 11, display: 'block', maxWidth: 460 }}
          >
            {row.userAgent || '-'}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'result',
      title: '结果',
      width: 148,
      render: (_: unknown, row: LogRow) => (
        <div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <StatusTag status={row.status} text={row.status || '-'} />
            <Typography.Text style={{ fontSize: 12 }}>
              {row.duration || (row.durationMs != null ? `${row.durationMs} ms` : '-')}
            </Typography.Text>
          </div>
          <Muted>{fmtBytes(row.bytes)}</Muted>
        </div>
      ),
    },
    {
      key: 'upstream',
      title: '上游',
      width: 190,
      responsive: ['lg' as const],
      render: (_: unknown, row: LogRow) => (
        <Typography.Text
          className="mono"
          ellipsis={{ tooltip: row.upstream }}
          style={{ fontSize: 12, maxWidth: 180 }}
        >
          {row.upstream || '-'}
        </Typography.Text>
      ),
    },
    {
      key: 'geo',
      title: '地区',
      width: 130,
      responsive: ['xl' as const],
      render: (_: unknown, row: LogRow) => {
        const geo = [row.country, row.province, row.city].filter(Boolean).join(' / ')
        return (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {geo || '-'}
          </Typography.Text>
        )
      },
    },
  ]

  return (
    <Modal
      open={open}
      title={`访问日志 · ${rule?.name || rule?.id || ''}`}
      width={modalWidth(true)}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      styles={{ body: { maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto' } }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Switch size="small" checked={auto} onChange={setAuto} aria-label="自动刷新访问日志" />
          <Typography.Text style={{ fontSize: 13 }}>每 5 秒自动刷新</Typography.Text>
        </span>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load(false)}
        >
          刷新
        </Button>
        <div style={{ flex: 1 }} />
        <Muted>最近 {rows.length} 条</Muted>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="加载访问日志失败"
          description={error}
          action={
            <Button size="small" onClick={() => void load(false)}>
              重试
            </Button>
          }
        />
      ) : null}

      <DataTable<LogRow>
        rowKey={(row) => row._key}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: false, size: 'small' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={loading ? '加载中…' : '暂无访问日志（可能未开启访问日志记录）'}
            />
          ),
        }}
      />

      <div style={{ marginTop: 8 }}>
        <Muted>
          本窗口只显示内存缓冲；历史记录可在「日志」页面按站点检索并导出。
        </Muted>
      </div>
    </Modal>
  )
}
