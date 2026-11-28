import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Col, Empty, Progress, Row, Skeleton, Tag, Typography, theme } from 'antd'
import { api } from '../api'
import { fmtBytes, fmtDuration } from '../format'
import RequestLineChart from '../components/RequestLineChart'
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
  denied?: number
  blocked?: number
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

/** One line of the service card: a dot, a name, a figure and a detail. */
function ServiceLine({
  title,
  tone,
  value,
  note,
}: {
  title: string
  tone: string
  value: string
  note?: string
}) {
  return (
    <Row align="middle" wrap={false} gutter={8}>
      {/* Three fixed, left-aligned columns: the names, the figures and the
          details each start on their own line, whatever their width. */}
      <Col flex="0 0 84px" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tone,
            flexShrink: 0,
          }}
        />
        <Typography.Text ellipsis style={{ fontSize: 13 }}>
          {title}
        </Typography.Text>
      </Col>
      <Col flex="0 0 64px">
        <Typography.Text strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
          {value}
        </Typography.Text>
      </Col>
      <Col flex="1 1 auto" style={{ minWidth: 0 }}>
        {note ? (
          <Typography.Text
            type="secondary"
            style={{
              fontSize: 11,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {note}
          </Typography.Text>
        ) : null}
      </Col>
    </Row>
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
    setLoading(false)
  }

  const live = usePolling(load, 10_000)

  // The first load goes through the poll status too, so the card can say when
  // it was last refreshed instead of showing a blank spot until the first tick.
  useEffect(() => {
    void live.refresh().finally(() => setLoading(false))
    // live.refresh is stable; running this once on mount is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const host = stats?.host
  const cores = num(stats?.numCpu)
  const load1 = num(host?.load1)
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
  const webTotal = webSeries.reduce((sum, point) => sum + num(point.total), 0)
  const forwardTotal = forwardSeries.reduce((sum, point) => sum + num(point.total), 0)

  const bodyStyle = { padding: 14, minHeight: 132 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {problems.map((problem, index) => (
        <Alert
          key={`${problem.title}-${index}`}
          type={problem.level === 'danger' ? 'error' : 'warning'}
          showIcon
          message={problem.title}
          description={problem.detail}
        />
      ))}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 14,
        }}
      >
        {/* 系统概览 */}
        <Card
          size="small"
          title="系统概览"
          style={cardStyle}
          styles={{ body: bodyStyle }}
          extra={
            live.updatedAt ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                更新于{' '}
                {new Date(live.updatedAt).toLocaleTimeString('zh-CN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Typography.Text>
            ) : null
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              minWidth: 0,
            }}
          >
            <Typography.Text strong style={{ fontSize: 16 }} ellipsis>
              {stats?.hostname || '主机'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {info?.version?.version || 'dev'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已运行 {stats ? fmtDuration(stats.uptimeSec) : '-'}
            </Typography.Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
              {health ? (
                problems.length ? (
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                    {problems.length} 项需要处理
                  </Tag>
                ) : (
                  <Tag color="green" style={{ marginInlineEnd: 0 }}>
                    运行正常
                  </Tag>
                )
              ) : null}
              {live.failed ? (
                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                  刷新失败
                </Tag>
              ) : null}
            </div>
          </div>
        </Card>

        {/* 系统资源 */}
        <Card title="系统资源" size="small" style={cardStyle} styles={{ body: bodyStyle }}>
          {loading ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <Meter
                label="CPU 负载"
                percent={cpuPct}
                danger={cpuPct > 85}
                detail={
                  cores ? `${load1.toFixed(2)} / ${cores} 核` : '负载不可用'
                }
              />
              <Meter
                label="内存"
                percent={memPct}
                danger={memPct > 85}
                detail={memTotal ? `${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}` : '统计不可用'}
              />
              <Meter
                label="Go 堆内存"
                percent={memTotal ? (heap / memTotal) * 100 : 0}
                detail={heap ? fmtBytes(heap) : '尚未采集'}
              />
            </div>
          )}
        </Card>

        {/* 磁盘 */}
        <Card title="磁盘" size="small" style={cardStyle} styles={{ body: bodyStyle }}>
          {loading ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : disks.length ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {disks.slice(0, 3).map((disk, index) => {
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
              })}
              {disks.length > 3 ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  另有 {disks.length - 3} 个挂载点
                </Typography.Text>
              ) : null}
            </div>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              磁盘统计不可用
            </Typography.Text>
          )}
        </Card>

        {/* 服务 */}
        <Card title="服务" size="small" style={cardStyle} styles={{ body: bodyStyle }}>
          <div style={{ display: 'grid', gap: 9 }}>
            <ServiceLine
              title="Web 服务"
              tone="#2f54eb"
              value={`${num(web.routes) || num(info?.webRules)} 条路由`}
              note={`${num(web.listeners)} 个监听器`}
            />
            <ServiceLine
              title="端口转发"
              tone="#13a8a8"
              value={`${num(forward.listening) || num(forward.enabled)} 个监听`}
              note={`${num(forward.activeConnections)} 个活跃连接`}
            />
            <ServiceLine
              title="动态域名"
              tone="#389e0d"
              value={`${num(ddns.enabled)} 个启用`}
              note={`${num(ddns.rules)} 条规则`}
            />
            <ServiceLine
              title="证书"
              tone="#d48806"
              value={`${certTotal} 张`}
              note={
                num(certs?.expired)
                  ? `${num(certs?.expired)} 张已过期`
                  : expiring
                    ? `${expiring} 张 30 天内到期`
                    : '全部有效'
              }
            />
          </div>
        </Card>
      </div>

      {/* 两条请求曲线 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
        <Card
          title="Web 服务请求"
          size="small"
          style={cardStyle}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatCount(webTotal)} 次 · 最近 24 小时
            </Typography.Text>
          }
          styles={{ body: { padding: '12px 16px 8px' } }}
        >
          <RequestLineChart
            points={webSeries}
            color={token.colorPrimary}
            empty={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求数据" />}
          />
        </Card>
        <Card
          title="端口转发请求"
          size="small"
          style={cardStyle}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatCount(forwardTotal)} 次 · 最近 24 小时
            </Typography.Text>
          }
          styles={{ body: { padding: '12px 16px 8px' } }}
        >
          <RequestLineChart
            points={forwardSeries}
            color="#13a8a8"
            empty={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接数据" />}
          />
        </Card>
      </div>
    </div>
  )
}
