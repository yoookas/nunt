import { useEffect, useState } from 'react'
import { usePolling } from '../usePolling'
import { Button, Typography } from '@heroui/react'
import { Activity, Boxes, Cpu, Globe, HardDrive, Server } from 'lucide-react'
import { api, errorText } from '../api'
import { fmtBytes, fmtDuration, fmtTime } from '../format'
import {
  AlertBox,
  DataTable,
  LoadingBlock,
  Page,
  PageHeader,
  Section,
  StatCard,
  LiveStatus,
  StatusChip,
  toast,
  type Column,
} from '../ui'

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

interface HealthProblem {
  level: 'danger' | 'warning'
  title: string
  detail: string
}

interface SeriesPoint {
  time: string
  total: number
  errors4xx: number
  errors5xx: number
  bytes: number
}

interface Health {
  certs: { total: number; expired: number; expiring7: number; expiring30: number; nextDays?: number }
  problems: HealthProblem[]
}

export default function Dashboard() {
  const [info, setInfo] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [modules, setModules] = useState<ModuleStatus[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [series, setSeries] = useState<SeriesPoint[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [infoData, statsData, moduleData, logData, healthData, seriesData] = await Promise.all([
        api.get('/api/v1/system/info'),
        api.get('/api/v1/system/stats'),
        api.get('/api/v1/modules'),
        api.get('/api/v1/system/logs', { limit: 30 }),
        api.get('/api/v1/system/health').catch(() => null),
        api.get('/api/v1/logs/access/series', { bucket: 3600 }).catch(() => null),
      ])
      setInfo(infoData)
      setStats(statsData)
      setHealth(healthData)
      setSeries(Array.isArray(seriesData?.points) ? seriesData.points : [])
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

  // The overview shows live numbers (memory, goroutines, connections, recent
  // logs), so refresh them in place. The 24 hour series is left alone: it is
  // hourly data and re-reading a day of logs every few seconds is wasteful.
  const refreshLive = async () => {
    const [infoData, statsData, moduleData, logData, healthData] = await Promise.all([
      api.get('/api/v1/system/info'),
      api.get('/api/v1/system/stats'),
      api.get('/api/v1/modules'),
      api.get('/api/v1/system/logs', { limit: 30 }),
      api.get('/api/v1/system/health').catch(() => null),
    ])
    if (infoData) setInfo(infoData)
    if (statsData) setStats(statsData)
    if (Array.isArray(moduleData)) setModules(moduleData)
    if (Array.isArray(logData?.entries)) setLogs(logData.entries)
    if (healthData) setHealth(healthData)
  }

  const live = usePolling(refreshLive, 5000)

  // The 24 hour trend is hourly data: refreshing it every few seconds would
  // rescan a day of access logs for nothing.
  usePolling(async () => {
    const data = await api.get('/api/v1/logs/access/series', { bucket: 3600 })
    if (Array.isArray(data?.points)) setSeries(data.points)
  }, 300000)

  const seriesMax = series.reduce((max, point) => Math.max(max, point.total), 0)

  const moduleColumns: Column<ModuleStatus>[] = [
    {
      key: 'title',
      title: '模块',
      render: (row) => (
        <div className="flex items-center gap-2">
          <Boxes size={15} className="text-muted" />
          <div>
            <div className="text-sm">{row.title || row.name}</div>
            <div className="mono text-[11px] text-muted">{row.name}</div>
          </div>
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
    {
      key: 'detail',
      title: '详情',
      render: (row) => <span className="text-xs text-muted">{row.detail || row.error || '-'}</span>,
    },
  ]

  const logColumns: Column<LogEntry>[] = [
    { key: 'time', title: '时间', render: (row) => <span className="text-xs text-muted">{fmtTime(row.time)}</span> },
    {
      key: 'level',
      title: '级别',
      render: (row) => (
        <StatusChip color={row.level === 'error' ? 'danger' : row.level === 'warn' ? 'warning' : 'default'}>
          {row.level}
        </StatusChip>
      ),
    },
    { key: 'msg', title: '内容', render: (row) => <span className="text-xs">{row.msg}</span> },
  ]

  return (
    <Page>
      <PageHeader
        title="概览"
        sub="运行状态、模块健康度与最近的日志"
        actions={<LiveStatus status={live} />}
      />

      {loading && !info ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-6">
          {health?.problems?.length ? (
            <div className="space-y-2">
              {health.problems.map((problem, index) => (
                <AlertBox
                  key={`${problem.title}-${index}`}
                  status={problem.level === 'danger' ? 'danger' : 'warning'}
                  title={problem.title}
                >
                  {problem.detail}
                </AlertBox>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatCard
              icon={<Server size={16} />}
              label="版本"
              value={info?.version?.version || '-'}
              hint={String(info?.version?.commit || '').slice(0, 8)}
            />
            <StatCard
              icon={<Activity size={16} />}
              label="运行时长"
              value={fmtDuration(stats?.uptimeSec)}
              hint={`启动于 ${fmtTime(stats?.startTime)}`}
            />
            <StatCard
              icon={<Globe size={16} />}
              label="Web 路由"
              value={String(info?.webRules ?? '-')}
              hint={
                health?.certs
                  ? `证书 ${health.certs.total} 张${
                      typeof health.certs.nextDays === 'number' ? ` · 最近到期 ${health.certs.nextDays} 天` : ''
                    }`
                  : `证书 ${info?.certs?.count ?? 0} 张`
              }
            />
            <StatCard
              icon={<Cpu size={16} />}
              label="内存 / 协程"
              value={fmtBytes(stats?.heapBytes)}
              hint={`${stats?.goroutines ?? '-'} goroutines`}
            />
          </div>

          <Section
            title="请求趋势"
            description="最近 24 小时，按小时聚合访问日志（无日志时为空）"
            extra={<span className="text-xs text-muted">峰值 {seriesMax} 次/小时</span>}
          >
            {series.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted">暂无访问日志</div>
            ) : (
              <div className="flex h-28 items-end gap-1 px-4 pb-4" role="img" aria-label="最近 24 小时请求量">
                {series.map((point) => {
                  const height = seriesMax > 0 ? Math.max(4, Math.round((point.total / seriesMax) * 100)) : 4
                  const failed = point.errors5xx > 0
                  return (
                    <div
                      key={point.time}
                      className={`flex-1 rounded-t ${failed ? 'bg-danger/70' : 'bg-accent/70'}`}
                      style={{ height: `${height}%` }}
                      title={`${fmtTime(point.time)} · ${point.total} 次 · 4xx ${point.errors4xx} · 5xx ${point.errors5xx} · ${fmtBytes(point.bytes)}`}
                    />
                  )
                })}
              </div>
            )}
          </Section>

          <div className="grid gap-6 xl:grid-cols-3">
            <div className="min-w-0 space-y-6 xl:col-span-2">
              <Section title="模块" description="每个模块的启动状态与最近一次错误" flush>
                <DataTable
                  items={modules}
                  columns={moduleColumns}
                  rowKey={(row) => row.name}
                  ariaLabel="模块"
                  loading={loading}
                  empty="没有已注册的模块"
                />
              </Section>
            </div>
            <Section title="主机" description="当前进程所在机器的资源概览">
              <div className="space-y-4">
                <div>
                  <Typography.Paragraph className="text-xs text-muted">主机名</Typography.Paragraph>
                  <div className="text-sm font-medium">{stats?.hostname || '-'}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-muted">系统</div>
                    <div className="text-sm">
                      {stats?.os || '-'}/{stats?.arch || '-'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">CPU</div>
                    <div className="text-sm">{stats?.numCpu ?? '-'} 核</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">负载</div>
                    <div className="text-sm">{Number(stats?.host?.load1 || 0).toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">内存占用</div>
                    <div className="text-sm">{Number(stats?.host?.memUsedPct || 0).toFixed(1)}%</div>
                  </div>
                  <div className="col-span-2">
                    <div className="flex items-center gap-1 text-xs text-muted">
                      <HardDrive size={13} /> 磁盘剩余
                    </div>
                    <div className="text-sm">{fmtBytes(stats?.host?.diskFreeBytes)}</div>
                  </div>
                </div>
              </div>
            </Section>
          </div>

          <Section title="最近日志" description="最新 30 条进程日志" flush>
            <DataTable
              items={logs}
              columns={logColumns}
              rowKey={(row) => `${row.time}-${row.msg}`}
              ariaLabel="日志"
              empty="暂无日志"
            />
          </Section>
        </div>
      )}
    </Page>
  )
}
