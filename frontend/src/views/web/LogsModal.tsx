import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import { api, errorText } from '../../api'
import { fmtBytes, fmtTime } from '../../format'
import {
  DataTable,
  FormModal,
  StatusChip,
  SwitchInput,
  toast,
  type Column,
} from '../../ui'
import type { AccessEntry, ListResponse, WebRule } from './types'

interface LogRow extends AccessEntry {
  _key: string
}

function statusColor(code: number | undefined): 'success' | 'warning' | 'primary' | 'danger' | 'default' {
  const value = Number(code) || 0
  if (value >= 500) return 'danger'
  if (value >= 400) return 'warning'
  if (value >= 300) return 'primary'
  if (value >= 200) return 'success'
  return 'default'
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
  const [logs, setLogs] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const loadingRef = useRef(false)
  const ruleId = rule?.id || ''

  const load = useCallback(
    async (silent = false) => {
      if (!ruleId || loadingRef.current) return
      loadingRef.current = true
      setLoading(true)
      try {
        const data = await api.get<ListResponse<AccessEntry>>('/api/v1/web/logs', {
          rule: ruleId,
          limit: 200,
        })
        const items = Array.isArray(data?.items) ? data.items : []
        setLogs(items.map((item, index) => ({ ...item, _key: `${item.time || ''}-${index}` })))
      } catch (err) {
        if (!silent) toast.danger(errorText(err))
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [ruleId],
  )

  useEffect(() => {
    if (!open) {
      setLogs([])
      return
    }
    void load(false)
    if (!auto) return
    const timer = window.setInterval(() => {
      void load(true)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [open, auto, load])

  const columns: Column<LogRow>[] = [
    {
      key: 'time',
      title: '时间',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.time)}</span>,
    },
    {
      key: 'clientIp',
      title: '客户端',
      render: (row) => <span className="mono text-xs">{row.clientIp || '-'}</span>,
    },
    {
      key: 'method',
      title: '方法',
      render: (row) => <span className="text-xs">{row.method || '-'}</span>,
    },
    {
      key: 'path',
      title: '路径',
      render: (row) => (
        <span className="mono block max-w-xs truncate text-xs" title={row.path}>
          {row.path || '-'}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <StatusChip color={statusColor(row.status)}>{row.status || '-'}</StatusChip>
      ),
    },
    {
      key: 'duration',
      title: '耗时',
      render: (row) => (
        <span className="whitespace-nowrap text-xs">
          {row.duration || (row.durationMs != null ? `${row.durationMs} ms` : '-')}
        </span>
      ),
    },
    {
      key: 'bytes',
      title: '大小',
      render: (row) => <span className="whitespace-nowrap text-xs">{fmtBytes(row.bytes)}</span>,
    },
    {
      key: 'upstream',
      title: '上游',
      render: (row) => <span className="mono text-xs">{row.upstream || '-'}</span>,
    },
    {
      key: 'ua',
      title: 'User-Agent',
      render: (row) => (
        <span className="block max-w-xs truncate text-xs text-muted" title={row.userAgent}>
          {row.userAgent || '-'}
        </span>
      ),
    },
  ]

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={`访问日志 · ${rule?.name || rule?.id || ''}`}
      size="xl"
      footer={
        <div className="flex justify-end">
          <Button variant="tertiary" onPress={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="toolbar">
          <SwitchInput label="每 5 秒自动刷新" value={auto} onChange={setAuto} />
          <Button size="sm" variant="secondary" isDisabled={loading} onPress={() => void load(false)}>
            {loading ? '加载中…' : '刷新'}
          </Button>
          <div className="spacer" />
          <span className="text-xs text-muted">最近 {logs.length} 条</span>
        </div>
        <div className="overflow-x-auto">
          <DataTable
            items={logs}
            columns={columns}
            rowKey={(row) => row._key}
            ariaLabel="访问日志"
            empty={loading ? '加载中…' : '暂无访问日志（可能未开启访问日志记录）'}
          />
        </div>
      </div>
    </FormModal>
  )
}
