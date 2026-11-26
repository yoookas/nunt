import { useCallback, useEffect, useState } from 'react'
import { App, Button, Segmented, Space, Tag, type TableColumnsType } from 'antd'
import { ClearOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { fmtTime } from '../../format'
import { DataTable, Muted, Panel, StatusTag, Toolbar } from '../../components'
import { usePolling } from '../../usePolling'
import {
  actionColor,
  actionLabel,
  ruleIdsOf,
  type WafLog,
  type WafLogsResponse,
} from './types'

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'deny', label: '拦截' },
  { value: 'detect', label: '检测' },
]

type ActionFilter = '' | 'deny' | 'detect'

export interface LogsPanelProps {
  active: boolean
  onEventsChange?: (count: number) => void
}

export default function LogsPanel({ active, onEventsChange }: LogsPanelProps) {
  const { message, modal } = App.useApp()
  const [logs, setLogs] = useState<WafLog[]>([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState<ActionFilter>('')
  const [loading, setLoading] = useState(false)

  const loadLogs = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const data = await api.get<WafLogsResponse>('/api/v1/waf/logs', {
          limit: 200,
          action: filter || undefined,
        })
        setLogs(Array.isArray(data?.items) ? data.items : [])
        const count = Number(data?.total) || 0
        setTotal(count)
        onEventsChange?.(count)
      } catch (err) {
        if (!silent) message.error(errorText(err))
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [filter, message, onEventsChange],
  )

  useEffect(() => {
    if (!active) return
    void loadLogs()
  }, [active, loadLogs])

  usePolling(() => loadLogs(true), 10000, active)

  const clearLogs = () => {
    modal.confirm({
      title: '清空拦截事件',
      content: '将清空内存中的拦截事件和统计计数，确定继续？',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.del('/api/v1/waf/logs')
          message.success('拦截事件已清空')
          await loadLogs()
        } catch (err) {
          message.error(errorText(err))
          throw err
        }
      },
    })
  }

  const columns: TableColumnsType<WafLog> = [
    {
      key: 'time',
      title: '时间',
      width: 170,
      render: (_, record) => <span style={{ fontSize: 12 }}>{fmtTime(record.time)}</span>,
    },
    {
      key: 'action',
      title: '动作',
      width: 80,
      render: (_, record) => (
        <Tag color={actionColor(record.action)}>{actionLabel(record.action)}</Tag>
      ),
    },
    {
      key: 'source',
      title: '来源',
      render: (_, record) => (
        <div>
          <div className="mono" style={{ fontSize: 12 }}>
            {record.clientIp || '-'}
          </div>
          {record.host ? <Muted>{record.host}</Muted> : null}
        </div>
      ),
    },
    {
      key: 'request',
      title: '请求',
      render: (_, record) => (
        <div style={{ maxWidth: 360 }}>
          <div className="mono" style={{ fontSize: 12 }} title={`${record.method || '-'} ${record.uri || '-'}`}>
            {record.method || '-'} {record.uri || '-'}
          </div>
          {record.proto ? <Muted>{record.proto}</Muted> : null}
        </div>
      ),
    },
    {
      key: 'rules',
      title: '规则',
      render: (_, record) => {
        const ids = ruleIdsOf(record)
        return (
          <div style={{ maxWidth: 300 }}>
            {ids.length ? (
              <Space size={[4, 4]} wrap>
                {ids.map((id) => (
                  <Tag key={id} style={{ marginInlineEnd: 0 }}>
                    {id}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Muted>-</Muted>
            )}
            {record.message ? (
              <div style={{ marginTop: 2 }}>
                <Muted>{record.message}</Muted>
              </div>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'site',
      title: '站点',
      responsive: ['lg'],
      render: (_, record) => <span style={{ fontSize: 12 }}>{record.rule || '-'}</span>,
    },
    {
      key: 'status',
      title: 'HTTP',
      width: 80,
      responsive: ['md'],
      render: (_, record) => <StatusTag status={record.status} />,
    },
  ]

  return (
    <Panel
      title="拦截事件"
      subtitle="最近 200 条（内存最多 500 条）"
      extra={
        <Toolbar>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadLogs()}>
            刷新
          </Button>
          <Button
            size="small"
            danger
            icon={<ClearOutlined />}
            disabled={!logs.length && !total}
            onClick={clearLogs}
          >
            清空
          </Button>
        </Toolbar>
      }
    >
      <Toolbar>
        <Segmented
          value={filter || 'all'}
          options={FILTER_OPTIONS}
          onChange={(value) => {
            const next = value === 'deny' || value === 'detect' ? value : ''
            setFilter(next)
          }}
        />
        <Muted>每 10 秒自动刷新 · 当前共 {total} 条</Muted>
      </Toolbar>

      <div style={{ marginTop: 12 }}>
        <DataTable<WafLog>
          dataSource={logs}
          columns={columns}
          rowKey={(record) =>
            `${record.time}-${record.txId || ''}-${record.clientIp || ''}-${record.uri || ''}-${
              record.ruleId || ''
            }-${record.action}`
          }
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <Muted>
          历史拦截记录可在「日志 → 访问日志」中按来源 WAF 检索；这里只保留进程内最近的事件。
        </Muted>
      </div>
    </Panel>
  )
}
