import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { errorText, api } from '../api'
import { fmtBytes, fmtDuration, fmtTime } from '../format'
import { DataTable, Page, PageHeader, Panel, StatusChip, toast, type Column } from '../ui'

interface ModuleStatus {
  name: string
  title: string
  running: boolean
  detail?: string
  error?: string
}

interface LogEntry {
  time: string
  level: string
  msg: string
}

export default function Dashboard() {
  const [info, setInfo] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [modules, setModules] = useState<ModuleStatus[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [infoData, statsData, moduleData, logData] = await Promise.all([
        api.get('/api/v1/system/info'),
        api.get('/api/v1/system/stats'),
        api.get('/api/v1/modules'),
        api.get('/api/v1/system/logs', { limit: 50 }),
      ])
      setInfo(infoData)
      setStats(statsData)
      setModules(Array.isArray(moduleData) ? moduleData : [])
      setLogs(Array.isArray(logData?.entries) ? logData.entries : [])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const moduleColumns: Column<ModuleStatus>[] = [
    {
      key: 'title',
      title: '模块',
      render: (row) => (
        <div>
          <div>{row.title || row.name}</div>
          <div className="mono text-xs text-muted">{row.name}</div>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <StatusChip color={row.running ? 'success' : 'default'}>{row.running ? '运行中' : '已停止'}</StatusChip>
      ),
    },
    { key: 'detail', title: '详情', render: (row) => <span className="text-xs text-muted">{row.detail || row.error || '-'}</span> },
  ]

  const logColumns: Column<LogEntry>[] = [
    { key: 'time', title: '时间', render: (row) => <span className="text-xs">{fmtTime(row.time)}</span> },
    { key: 'level', title: '级别', render: (row) => <span className="text-xs uppercase">{row.level}</span> },
    { key: 'msg', title: '内容', render: (row) => <span className="text-xs">{row.msg}</span> },
  ]

  const cards = [
    { label: '版本', value: info?.version?.version || '-', hint: String(info?.version?.commit || '').slice(0, 8) },
    { label: '运行时长', value: fmtDuration(stats?.uptimeSec), hint: `启动于 ${fmtTime(stats?.startTime)}` },
    {
      label: 'Web 规则',
      value: String(info?.webRules ?? '-'),
      hint: `证书 ${info?.certs?.count ?? 0} 张`,
    },
    { label: '内存 / 协程', value: fmtBytes(stats?.heapBytes), hint: `${stats?.goroutines ?? '-'} goroutines` },
    { label: '主机', value: stats?.hostname || '-', hint: `${stats?.os || ''}/${stats?.arch || ''} · ${stats?.numCpu ?? '-'} 核` },
    {
      label: '负载 / 内存',
      value: Number(stats?.host?.load1 || 0).toFixed(2),
      hint: `已用 ${Number(stats?.host?.memUsedPct || 0).toFixed(1)}% · 磁盘剩余 ${fmtBytes(stats?.host?.diskFreeBytes)}`,
    },
  ]

  return (
    <Page>
      <PageHeader
        title="概览"
        sub="运行状态、模块与最近的日志"
        actions={
          <Button variant="secondary" isDisabled={loading} onPress={() => void load()}>
            刷新
          </Button>
        }
      />
      <div className="stack">
        <div className="cards">
          {cards.map((card) => (
            <Panel key={card.label}>
              <div className="p-4">
                <div className="stat-label">{card.label}</div>
                <div className="stat-value">{card.value}</div>
                <div className="mt-1 text-xs text-muted">{card.hint}</div>
              </div>
            </Panel>
          ))}
        </div>
        <Panel title="模块">
          <DataTable items={modules} columns={moduleColumns} rowKey={(row) => row.name} ariaLabel="模块" />
        </Panel>
        <Panel title="最近日志">
          <DataTable items={logs} columns={logColumns} rowKey={(row) => `${row.time}-${row.msg}`} ariaLabel="日志" />
        </Panel>
      </div>
    </Page>
  )
}
