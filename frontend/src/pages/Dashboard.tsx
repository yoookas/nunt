import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Empty, Progress, Skeleton, Tag, Typography, theme } from 'antd'
import { api, errorText } from '../api'
import { fmtBytes, fmtDuration, fmtTime } from '../format'
import { usePolling } from '../usePolling'

interface ModuleStatus {
  name: string
  title?: string
  running?: boolean
  stats?: Record<string, unknown>
}

interface SystemInfo {
  version?: { version?: string }
  webRules?: number
  modules?: ModuleStatus[]
  certs?: { count?: number; loadErrors?: number }
}

interface DiskStat {
  path?: string
  totalBytes?: number
  freeBytes?: number
}

interface HostStats {
  load1?: number
  load5?: number
  memTotalBytes?: number
  memFreeBytes?: number
  memUsedPct?: number
  diskTotalBytes?: number
  diskFreeBytes?: number
  diskPath?: string
  disks?: DiskStat[]
}

interface SystemStats {
  hostname?: string
  numCpu?: number
  uptimeSec?: number
  heapBytes?: number
  host?: HostStats | null
}

interface Health {
  problems?: { level?: string; title: string; detail: string }[]
  certs?: { total?: number; expired?: number; expiring7?: number; expiring30?: number }
}

interface SeriesPoint {
  time: string
  total: number
  errors4xx?: number
  errors5xx?: number
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const formatCount = (value: number): string => value.toLocaleString('zh-CN')

/** One metric row: label, a progress bar and a value hint. */
function Meter({
  label,
  percent,
  detail,
  danger,
}: {
  label: string
  percent: number
  detail: string
  danger?: boolean
}) {
  const { token } = theme.useToken()
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Typography.Text style={{ fontSize: 13 }}>{label}</Typography.Text>
        <div style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detail}
        </Typography.Text>
      </div>
      <Progress
        percent={Math.max(0, Math.min(100, Math.round(percent)))}
        showInfo={false}
        size={['100%', 8]}
        strokeColor={danger ? token.colorError : token.colorPrimary}
        style={{ margin: '2px 0 0' }}
      />
    </div>
  )
}

/** A compact hourly bar chart with the peak and the time span underneath. */
function RequestChart({ points, color }: { points: SeriesPoint[]; color: string }) {
  const { token } = theme.useToken()
  const sorted = useMemo(
    () => [...points].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()),
    [points],
  )
  const peak = Math.max(1, ...sorted.map((point) => num(point.total)))
  const total = sorted.reduce((sum, point) => sum + num(point.total), 0)

  if (!sorted.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求数据" style={{ padding: 24 }} />
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <Typography.Text style={{ fontSize: 22, fontWeight: 650 }}>{formatCount(total)}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          次 · 峰值 {formatCount(peak)} / 小时
        </Typography.Text>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
        {sorted.map((point) => {
          const height = Math.max(2, Math.round((num(point.total) / peak) * 100))
          const failed = num(point.errors5xx) + num(point.errors4xx)
          return (
            <div
              key={point.time}
              title={`${fmtTime(point.time)} · ${formatCount(num(point.total))} 次${failed ? `（${failed} 次失败）` : ''}`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
            >
              <div
                style={{
                  height: `${height}%`,
                  minHeight: 2,
                  borderRadius: 3,
                  background: failed ? token.colorWarning : color,
                  opacity: 0.85,
                }}
              />
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {fmtTime(sorted[0].time)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {fmtTime(sorted[sorted.length - 1].time)}
        </Typography.Text>
      </div>
    </div>
  )
}

/** One block of the merged service card. */
function ServiceStat({
  title,
  primary,
  lines,
  tone,
}: {
  title: string
  primary: string
  lines: string[]
  tone: string
}) {
  const { token } = theme.useToken()
  return (
    <div style={{ padding: '2px 0', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone, flexShrink: 0 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {title}
        </Typography.Text>
      </div>
      <div style={{ fontSize: 18, fontWeight: 650, marginTop: 1, color: token.colorText }}>{primary}</div>
      {lines.map((line) => (
        <div key={line} style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 1 }}>
          {line}
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const { token } = theme.useToken()
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [modules, setModules] = useState<ModuleStatus[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [webSeries, setWebSeries] = useState<SeriesPoint[]>([])
  const [forwardSeries, setForwardSeries] = useState<SeriesPoint[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const [infoData, statsData, moduleData, healthData, webData, forwardData] = await Promise.all([
      api.get<SystemInfo>('/api/v1/system/info').catch(() => null),
      api.get<SystemStats>('/api/v1/system/stats').catch(() => null),
      api.get<ModuleStatus[]>('/api/v1/modules').catch(() => []),
      api.get<Health>('/api/v1/system/health').catch(() => null),
      api.get<{ points?: SeriesPoint[] }>('/api/v1/logs/access/series', {
        bucket: 3600,
        source: 'web',
        from,
      }).catch(() => null),
      api.get<{ points?: SeriesPoint[] }>('/api/v1/logs/access/series', {
        bucket: 3600,
        source: 'forward',
        from,
      }).catch(() => null),
    ])
    if (infoData) setInfo(infoData)
    if (statsData) setStats(statsData)
    if (Array.isArray(moduleData)) setModules(moduleData)
    if (healthData) setHealth(healthData)
    if (Array.isArray(webData?.points)) setWebSeries(webData.points)
    if (Array.isArray(forwardData?.points)) setForwardSeries(forwardData.points)
    setError('')
    setLoading(false)
  }

  const live = usePolling(load, 10_000)

  useEffect(() => {
    void load().catch((err) => {
      setError(errorText(err))
      setLoading(false)
    })
  }, [])

  const host = stats?.host
  const cores = num(stats?.numCpu)
  const load1 = num(host?.load1)
  const load5 = num(host?.load5)
  const cpuPct = cores ? Math.min(100, (load1 / cores) * 100) : 0
  const memTotal = num(host?.memTotalBytes)
  const memUsed = Math.max(0, memTotal - num(host?.memFreeBytes))
  const memPct = num(host?.memUsedPct) || (memTotal ? (memUsed / memTotal) * 100 : 0)
  const heap = num(stats?.heapBytes)

  const disks: DiskStat[] = useMemo(() => {
    if (Array.isArray(host?.disks) && host.disks.length) return host.disks
    if (num(host?.diskTotalBytes)) {
      return [{ path: host?.diskPath || '数据目录', total: host?.diskTotalBytes, free: host?.diskFreeBytes }]
    }
    return []
  }, [host])

  const moduleMap = useMemo(() => {
    const map = new Map<string, ModuleStatus>()
    for (const item of modules) map.set(item.name, item)
    for (const item of info?.modules ?? []) if (!map.has(item.name)) map.set(item.name, item)
    return map
  }, [modules, info])
  const web = moduleMap.get('web')?.stats ?? {}
  const forward = moduleMap.get('forward')?.stats ?? {}
  const ddns = moduleMap.get('ddns')?.stats ?? {}

  const certs = health?.certs
  const certTotal = num(certs?.total) || num(info?.certs?.count)
  const expiring = num(certs?.expiring30) || num(certs?.expiring7)
  const problems = health?.problems ?? []

  const cardStyle = { borderColor: token.colorBorderSecondary, height: '100%' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card size="small" style={cardStyle} styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <Typography.Title level={4} style={{ margin: 0, fontSize: 18 }}>
              系统概览
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {stats?.hostname || '主机'} · {info?.version?.version || 'dev'} · 运行{' '}
              {stats ? fmtDuration(stats.uptimeSec) : '-'}
            </Typography.Text>
          </div>
          <div style={{ flex: 1 }} />
          {health ? (
            problems.length ? (
              <Tag color="orange">{problems.length} 项需要处理</Tag>
            ) : (
              <Tag color="green">运行正常</Tag>
            )
          ) : null}
          {live.failed ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              刷新失败
            </Typography.Text>
          ) : null}
        </div>
      </Card>

      {error ? <Alert type="error" showIcon message="概览数据加载失败" description={error} /> : null}
      {problems.map((problem, index) => (
        <Alert
          key={`${problem.title}-${index}`}
          type={problem.level === 'danger' ? 'error' : 'warning'}
          showIcon
          message={problem.title}
          description={problem.detail}
        />
      ))}

      {/* 资源与磁盘 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        <Card title="系统资源" size="small" style={cardStyle} styles={{ body: { padding: 16, display: 'grid', gap: 14 } }}>
          {loading ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : (
            <>
              <Meter
                label="CPU 负载"
                percent={cpuPct}
                danger={cpuPct > 85}
                detail={
                  cores
                    ? `${load1.toFixed(2)} / ${cores} 核 · 5 分钟 ${load5.toFixed(2)}`
                    : '负载不可用'
                }
              />
              <Meter
                label="内存"
                percent={memPct}
                danger={memPct > 85}
                detail={memTotal ? `${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}` : '内存统计不可用'}
              />
              <Meter
                label="Go 堆内存"
                percent={memTotal ? (heap / memTotal) * 100 : 0}
                detail={
                  heap
                    ? `${fmtBytes(heap)}${memTotal ? ` · 占系统内存 ${((heap / memTotal) * 100).toFixed(1)}%` : ''}`
                    : '尚未采集'
                }
              />
            </>
          )}
        </Card>

        <Card
          title="磁盘"
          size="small"
          style={cardStyle}
          styles={{ body: { padding: 16, display: 'grid', gap: 14 } }}
        >
          {loading ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : disks.length ? (
            disks.map((disk, index) => {
              const total = num(disk.totalBytes)
              const free = num(disk.freeBytes)
              const pct = total ? ((total - free) / total) * 100 : 0
              return (
                <Meter
                  key={`${disk.path ?? 'disk'}-${index}`}
                  label={disk.path || `磁盘 ${index + 1}`}
                  percent={pct}
                  danger={pct > 90}
                  detail={total ? `${fmtBytes(total - free)} / ${fmtBytes(total)}` : '统计不可用'}
                />
              )
            })
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              磁盘统计不可用
            </Typography.Text>
          )}
        </Card>

      </div>

      {/* 服务汇总 */}
      <Card title="服务" size="small" style={cardStyle} styles={{ body: { padding: 12 } }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          <ServiceStat
            title="Web 服务"
            tone="#2f54eb"
            primary={`${num(web.routes) || num(info?.webRules)} 条路由`}
            lines={[`${num(web.listeners)} 个监听器`]}
          />
          <ServiceStat
            title="端口转发"
            tone="#13a8a8"
            primary={`${num(forward.listening) || num(forward.enabled)} 个监听`}
            lines={[
              `${num(forward.rules)} 条规则 · ${num(forward.activeConnections)} 个活跃连接`,
            ]}
          />
          <ServiceStat
            title="动态域名"
            tone="#389e0d"
            primary={`${num(ddns.enabled)} 个启用`}
            lines={[`${num(ddns.rules)} 条规则`]}
          />
          <ServiceStat
            title="证书"
            tone="#d48806"
            primary={`${certTotal} 张`}
            lines={[
              num(certs?.expired)
                ? `${num(certs?.expired)} 张已过期`
                : expiring
                  ? `${expiring} 张 30 天内到期`
                  : '全部有效',
            ]}
          />
        </div>
      </Card>

      {/* 两条请求曲线 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
        <Card
          title="Web 服务请求"
          size="small"
          style={cardStyle}
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>最近 24 小时</Typography.Text>}
          styles={{ body: { padding: 16 } }}
        >
          <RequestChart points={webSeries} color={token.colorPrimary} />
        </Card>
        <Card
          title="端口转发请求"
          size="small"
          style={cardStyle}
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>最近 24 小时</Typography.Text>}
          styles={{ body: { padding: 16 } }}
        >
          <RequestChart points={forwardSeries} color="#13a8a8" />
        </Card>
      </div>
    </div>
  )
}
