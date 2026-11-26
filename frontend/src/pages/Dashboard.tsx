import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Alert, Button, Card, Col, Empty, Progress, Row, Skeleton, Tag, Typography, theme } from 'antd'
import {
  ArrowRightOutlined,
  AuditOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  FileProtectOutlined,
  GlobalOutlined,
  LockOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api, errorText } from '../api'
import { fmtBytes, fmtDuration, fmtTime } from '../format'
import { usePolling } from '../usePolling'

interface ModuleStatus {
  name: string
  title?: string
  running?: boolean
  detail?: string
  error?: string
  stats?: Record<string, unknown>
}

interface SystemInfo {
  version?: { version?: string; commit?: string }
  webRules?: number
  modules?: ModuleStatus[]
  certs?: { count?: number; loadErrors?: number }
  adminListen?: string
  dataDir?: string
}

interface HostStats {
  load1?: number
  load5?: number
  memTotalBytes?: number
  memFreeBytes?: number
  memUsedPct?: number
  diskTotalBytes?: number
  diskFreeBytes?: number
}

interface SystemStats {
  hostname?: string
  os?: string
  arch?: string
  numCpu?: number
  uptimeSec?: number
  heapBytes?: number
  goroutines?: number
  host?: HostStats | null
}

interface Problem {
  level?: string
  title: string
  detail: string
}

interface Health {
  problems?: Problem[]
  certs?: { total?: number; expired?: number; expiring7?: number; expiring30?: number; nextDays?: number }
}

interface LogEntry {
  time: string
  level: string
  msg: string
}

interface AccessStats {
  total?: number
  bytes?: number
  byStatus?: Record<string, number>
  avgDurationMs?: number
}

interface SeriesPoint {
  time: string
  total: number
  errors4xx: number
  errors5xx: number
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function ModuleCard({
  icon,
  title,
  path,
  metric,
  hint,
  tone,
}: {
  icon: ReactNode
  title: string
  path: string
  metric: ReactNode
  hint: ReactNode
  tone?: string
}) {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  return (
    <Card
      hoverable
      onClick={() => navigate(path)}
      style={{ height: '100%', cursor: 'pointer' }}
      styles={{ body: { padding: 16 } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            background: tone || token.colorFillSecondary,
            color: tone ? '#fff' : token.colorPrimary,
            fontSize: 16,
          }}
        >
          {icon}
        </span>
        <Typography.Text strong style={{ fontSize: 14 }}>
          {title}
        </Typography.Text>
        <ArrowRightOutlined style={{ marginLeft: 'auto', color: token.colorTextTertiary, fontSize: 12 }} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 650, lineHeight: 1.1 }}>{metric}</div>
      <div style={{ marginTop: 6, color: token.colorTextSecondary, fontSize: 12 }}>{hint}</div>
    </Card>
  )
}

export default function Dashboard() {
  const { token } = theme.useToken()
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [modules, setModules] = useState<ModuleStatus[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [access, setAccess] = useState<AccessStats | null>(null)
  const [series, setSeries] = useState<SeriesPoint[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const [infoData, statsData, moduleData, healthData, logData, accessData, seriesData] = await Promise.all([
      api.get<SystemInfo>('/api/v1/system/info').catch(() => null),
      api.get<SystemStats>('/api/v1/system/stats').catch(() => null),
      api.get<ModuleStatus[]>('/api/v1/modules').catch(() => []),
      api.get<Health>('/api/v1/system/health').catch(() => null),
      api.get<{ entries?: LogEntry[] }>('/api/v1/system/logs', { limit: 8 }).catch(() => null),
      api.get<AccessStats>('/api/v1/logs/access/stats', { from }).catch(() => null),
      api.get<{ points?: SeriesPoint[] }>('/api/v1/logs/access/series', { bucket: 3600 }).catch(() => null),
    ])
    if (infoData) setInfo(infoData)
    if (statsData) setStats(statsData)
    if (Array.isArray(moduleData)) setModules(moduleData)
    if (healthData) setHealth(healthData)
    if (Array.isArray(logData?.entries)) setLogs(logData.entries)
    if (accessData) setAccess(accessData)
    if (Array.isArray(seriesData?.points)) setSeries(seriesData.points)
    setError('')
    setLoading(false)
  }

  const live = usePolling(load, 10_000)

  useEffect(() => {
    let alive = true
    load().catch((err) => {
      if (alive) {
        setError(errorText(err))
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const host = stats?.host
  const memPct = num(host?.memUsedPct) || (num(host?.memTotalBytes) ? (1 - num(host?.memFreeBytes) / num(host?.memTotalBytes)) * 100 : 0)
  const diskPct = num(host?.diskTotalBytes) ? (1 - num(host?.diskFreeBytes) / num(host?.diskTotalBytes)) * 100 : 0
  const cpuPct = num(stats?.numCpu) ? Math.min(100, (num(host?.load1) / num(stats?.numCpu)) * 100) : 0

  const moduleMap = useMemo(() => {
    const map = new Map<string, ModuleStatus>()
    for (const item of modules) map.set(item.name, item)
    for (const item of info?.modules ?? []) if (!map.has(item.name)) map.set(item.name, item)
    return map
  }, [modules, info])

  const web = moduleMap.get('web')?.stats ?? {}
  const forward = moduleMap.get('forward')?.stats ?? {}
  const ddns = moduleMap.get('ddns')?.stats ?? {}
  const waf = moduleMap.get('waf')?.stats ?? {}

  const problems = health?.problems ?? []
  const certs = health?.certs
  const certTotal = num(certs?.total) || num(info?.certs?.count)
  const expiring = num(certs?.expiring7)
  const total24 = num(access?.total)
  const failure = num(access?.byStatus?.['4xx']) + num(access?.byStatus?.['5xx'])
  const sortedSeries = useMemo(() => [...series].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()).slice(-24), [series])
  const maxSeries = Math.max(1, ...sortedSeries.map((point) => point.total))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0, fontSize: 20 }}>
            系统概览
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {stats?.hostname || '主机'} · {info?.version?.version || 'dev'} · 运行 {stats ? fmtDuration(stats.uptimeSec) : '-'}
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
        <Typography.Text type={live.failed ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          {live.failed ? '刷新失败' : '实时'}
        </Typography.Text>
        <Button icon={<ReloadOutlined />} onClick={() => void live.refresh()}>
          刷新
        </Button>
      </div>

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

      <Card styles={{ body: { padding: 0 } }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {[
            {
              label: 'CPU 负载',
              value: stats?.numCpu ? `${num(host?.load1).toFixed(2)}` : '-',
              hint: stats?.numCpu ? `${stats.numCpu} 核 · 5 分钟 ${num(host?.load5).toFixed(2)}` : '负载不可用',
              pct: cpuPct,
            },
            {
              label: '内存',
              value: host?.memTotalBytes ? `${memPct.toFixed(0)}%` : '-',
              hint: host?.memTotalBytes ? `${fmtBytes(num(host?.memTotalBytes) - num(host?.memFreeBytes))} / ${fmtBytes(host?.memTotalBytes)}` : '内存统计不可用',
              pct: memPct,
            },
            {
              label: '磁盘',
              value: host?.diskTotalBytes ? `${diskPct.toFixed(0)}%` : '-',
              hint: host?.diskTotalBytes ? `剩余 ${fmtBytes(host?.diskFreeBytes)}` : '磁盘统计不可用',
              pct: diskPct,
            },
            {
              label: '今日请求',
              value: loading ? '-' : total24.toLocaleString(),
              hint: `失败 ${failure.toLocaleString()} · 平均 ${Math.round(num(access?.avgDurationMs))} ms`,
              pct: undefined,
            },
          ].map((item) => (
            <div key={item.label} style={{ padding: '18px 20px', borderRight: `1px solid ${token.colorBorderSecondary}` }}>
              <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{item.label}</div>
              <div style={{ fontSize: 24, fontWeight: 650, marginTop: 4 }}>{loading ? <Skeleton.Input active size="small" /> : item.value}</div>
              <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 4 }}>{item.hint}</div>
              {item.pct !== undefined ? (
                <Progress percent={Math.round(item.pct)} showInfo={false} size="small" strokeColor={item.pct > 85 ? '#ff4d4f' : token.colorPrimary} style={{ marginTop: 6 }} />
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard
            icon={<GlobalOutlined />}
            title="Web 服务"
            path="/web"
            metric={num(web.listeners) || '-'}
            hint={`${num(web.routes) || num(info?.webRules)} 条路由`}
            tone="#2f54eb"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard
            icon={<SwapOutlined />}
            title="端口转发"
            path="/forward"
            metric={num(forward.listening) || num(forward.enabled) || 0}
            hint={`${num(forward.activeConnections)} 活跃连接 · ${num(forward.rules)} 条规则`}
            tone="#13a8a8"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard
            icon={<CloudServerOutlined />}
            title="动态域名"
            path="/ddns"
            metric={num(ddns.enabled) || 0}
            hint={`${num(ddns.rules)} 条规则`}
            tone="#389e0d"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard
            icon={<LockOutlined />}
            title="证书"
            path="/acme"
            metric={certTotal || 0}
            hint={num(certs?.expired) ? `${num(certs?.expired)} 张已过期` : expiring ? `${expiring} 张 7 天内到期` : '全部有效'}
            tone="#d48806"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard
            icon={<FileProtectOutlined />}
            title="WAF"
            path="/waf"
            metric={waf.enabled ? '已启用' : '未启用'}
            hint={`拦截 ${num(waf.blocked)} 次 · 检测 ${num(waf.detected)} 次`}
            tone="#cf1322"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard icon={<AuditOutlined />} title="日志" path="/logs" metric="运行 + 访问" hint="实时流 / 按条件检索" tone="#595959" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard icon={<DatabaseOutlined />} title="IP 地址库" path="/ipdb" metric="v4 / v6" hint="上传、查询、诊断" tone="#722ed1" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ModuleCard icon={<SettingOutlined />} title="设置" path="/settings" metric="系统" hint="日志、安全、备份与配置" tone="#8c8c8c" />
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={14}>
          <Card title="最近 24 小时请求" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>每小时</Typography.Text>} styles={{ body: { padding: 16 } }}>
            {sortedSeries.length ? (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
                {sortedSeries.map((point) => {
                  const height = Math.max(2, Math.round((point.total / maxSeries) * 100))
                  return (
                    <div key={point.time} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }} title={`${fmtTime(point.time)} · ${point.total} 次`}>
                      <div
                        style={{
                          height: `${height}%`,
                          borderRadius: 3,
                          background: point.errors5xx ? '#ff7875' : point.errors4xx ? '#ffc069' : token.colorPrimary,
                          opacity: 0.85,
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="最近日志" extra={<a href="#/logs">查看全部</a>} styles={{ body: { padding: 0 } }}>
            {logs.length ? (
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                {logs.map((entry) => (
                  <div key={`${entry.time}-${entry.msg}`} style={{ display: 'flex', gap: 8, padding: '8px 16px', borderTop: `1px solid ${token.colorBorderSecondary}`, fontSize: 12 }}>
                    <span className="mono" style={{ color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>{fmtTime(entry.time)}</span>
                    <Typography.Text ellipsis={{ tooltip: entry.msg }} style={{ flex: 1, fontSize: 12 }}>
                      {entry.msg}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}
