import { useCallback, useEffect, useState } from 'react'
import { App, Button, Empty, Popconfirm, Segmented, Space, Spin, Tag } from 'antd'
import { ClearOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { fmtTime } from '../../format'
import { Muted, StatusTag, useIsMobile } from '../../components'
import { EntityRow } from '../../components/Workspace'
import { usePolling } from '../../usePolling'
import {
  actionColor,
  actionLabel,
  ruleIdsOf,
  type WafLog,
  type WafLogsResponse,
} from './types'

type ActionFilter = '' | 'deny' | 'detect'

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'deny', label: '拦截' },
  { value: 'detect', label: '检测' },
]

export interface EventsSectionProps {
  active: boolean
  onEventsChange?: (count: number) => void
}

export default function EventsSection({ active, onEventsChange }: EventsSectionProps) {
  const { message } = App.useApp()
  const isMobile = useIsMobile()
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

  const clearLogs = async () => {
    try {
      await api.del('/api/v1/waf/logs')
      message.success('拦截事件已清空')
      await loadLogs()
    } catch (err) {
      message.error(errorText(err))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Segmented
          size="small"
          value={filter || 'all'}
          options={FILTER_OPTIONS}
          onChange={(value) => setFilter(value === 'deny' || value === 'detect' ? value : '')}
        />
        {isMobile ? null : <Muted>共 {total} 条 · 10 秒刷新</Muted>}
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          loading={loading}
          aria-label="刷新拦截事件"
          onClick={() => void loadLogs()}
        >
          {isMobile ? null : '刷新'}
        </Button>
        <Popconfirm
          title="清空拦截事件？"
          description="内存中的事件和按规则统计会重置。"
          okText="清空"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void clearLogs()}
        >
          <Button
            size="small"
            danger
            type="text"
            icon={<ClearOutlined />}
            disabled={!total && !logs.length}
            aria-label="清空拦截事件"
          >
            {isMobile ? null : '清空'}
          </Button>
        </Popconfirm>
      </div>

      <div
        style={{
          marginTop: 10,
          maxHeight: 380,
          minHeight: 80,
          overflowY: 'auto',
          border: '1px solid rgba(5,5,5,0.06)',
          borderRadius: 8,
        }}
      >
        {loading && !logs.length ? (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : logs.length ? (
          logs.map((record) => (
            <EntityRow
              key={`${record.time}-${record.txId || ''}-${record.clientIp || ''}-${record.uri || ''}-${
                record.ruleId || ''
              }-${record.action}`}
              title={<span className="mono" style={{ fontSize: 12 }}>{`${record.method || '-'} ${record.uri || '-'}`}</span>}
              subtitle={`${record.clientIp || '-'}${record.host ? ` · ${record.host}` : ''}`}
              status={record.action === 'deny' ? 'error' : 'warn'}
              actions={<Muted>{fmtTime(record.time)}</Muted>}
              meta={
                <Space size={[4, 4]} wrap>
                  <Tag color={actionColor(record.action)}>{actionLabel(record.action)}</Tag>
                  {ruleIdsOf(record).map((id) => (
                    <Tag key={id}>{id}</Tag>
                  ))}
                  <StatusTag status={record.status} />
                  {record.message ? <Muted>{record.message}</Muted> : null}
                </Space>
              }
            />
          ))
        ) : (
          <div style={{ padding: 20 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无拦截事件" />
          </div>
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <Muted>历史记录可在「日志 → 访问日志」按来源 WAF 检索；这里只保留进程内最近事件。</Muted>
      </div>
    </div>
  )
}
