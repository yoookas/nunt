import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import { Download, RefreshCw, Trash2 } from 'lucide-react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import {
  AlertBox,
  ConfirmModal,
  DataTable,
  FormModal,
  LoadingBlock,
  Panel,
  SelectInput,
  StatCard,
  StatusChip,
  TextInput,
  toast,
  type Column,
  type SelectOption,
} from '../ui'

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

interface Entry {
  time: string
  source: string
  ruleId?: string
  rule?: string
  listen?: string
  host?: string
  method?: string
  path?: string
  status?: number
  clientIp?: string
  userAgent?: string
  upstream?: string
  durationMs?: number
  bytes?: number
  bytesIn?: number
  bytesOut?: number
  protocol?: string
  proto?: string
  tls?: string
  requestId?: string
  upstreamStatus?: number
  attempts?: number
  reason?: string
  error?: string
  result?: string
  wafRuleId?: number
  message?: string
}

interface Row extends Entry {
  key: string
}

interface PageResult {
  items: Entry[]
  nextCursor?: string
  hasMore: boolean
  scanned: number
  truncated?: boolean
}

interface Count {
  name: string
  count: number
}

interface Stats {
  total: number
  bytes: number
  avgDurationMs: number
  bySource: Record<string, number>
  byStatus: Record<string, number>
  topIps: Count[]
  topPaths: Count[]
  topRules: Count[]
  scanned: number
  complete: boolean
  files: number
}

interface Meta {
  dir: string
  persist: boolean
  keepDays: number
  maxFileMb: number
  queued: number
  written: number
  dropped: number
  totalBytes: number
  files: { name: string; size: number; day: string }[]
}

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

const PAGE_SIZE = 100

const RANGES: SelectOption[] = [
  { value: '1h', label: '最近 1 小时' },
  { value: '6h', label: '最近 6 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'all', label: '全部（按保留天数）' },
]

const SOURCES: SelectOption[] = [
  { value: 'all', label: '全部来源' },
  { value: 'web', label: 'Web 服务' },
  { value: 'forward', label: '端口转发' },
  { value: 'waf', label: 'WAF' },
]

const STATUSES: SelectOption[] = [
  { value: 'all', label: '全部状态' },
  { value: '2xx', label: '2xx 成功' },
  { value: '3xx', label: '3xx 跳转' },
  { value: '4xx', label: '4xx 客户端错误' },
  { value: '5xx', label: '5xx 服务端错误' },
]

const SOURCE_META: Record<string, { label: string; color: 'primary' | 'success' | 'warning' | 'default' }> = {
  web: { label: 'Web', color: 'primary' },
  forward: { label: '转发', color: 'success' },
  waf: { label: 'WAF', color: 'warning' },
}

function rangeStart(range: string): string {
  const now = Date.now()
  const table: Record<string, number> = {
    '1h': 3600_000,
    '6h': 6 * 3600_000,
    '24h': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
  }
  const span = table[range]
  return span ? new Date(now - span).toISOString() : ''
}

function statusColor(status: number | undefined): 'default' | 'success' | 'warning' | 'danger' {
  const code = Number(status || 0)
  if (code >= 500) return 'danger'
  if (code >= 400) return 'warning'
  if (code >= 200 && code < 400) return 'success'
  return 'default'
}

function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export default function AccessLogs() {
  const [source, setSource] = useState('all')
  const [status, setStatus] = useState('all')
  const [range, setRange] = useState('24h')
  const [ip, setIP] = useState('')
  const [keyword, setKeyword] = useState('')

  const [rows, setRows] = useState<Row[]>([])
  const [cursor, setCursor] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [detail, setDetail] = useState<Row | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [auto, setAuto] = useState(false)

  const seqRef = useRef(0)

  const params = useMemo(
    () => ({
      source: source === 'all' ? '' : source,
      status: status === 'all' ? '' : status,
      from: rangeStart(range),
      to: '',
      ip: ip.trim(),
      q: keyword.trim(),
    }),
    [source, status, range, ip, keyword],
  )

  const load = useCallback(
    async (mode: 'reset' | 'more', quiet = false) => {
      if (mode === 'more') setMore(true)
      else if (!quiet) setLoading(true)
      try {
        const query = {
          ...params,
          limit: PAGE_SIZE,
          cursor: mode === 'more' ? cursor : '',
        }
        const page = await api.get<PageResult>('/api/v1/logs/access', query)
        const mapped: Row[] = (page.items || []).map((item) => {
          seqRef.current += 1
          return { ...item, key: `${seqRef.current}` }
        })
        setRows((prev) => (mode === 'more' ? prev.concat(mapped) : mapped))
        setCursor(page.nextCursor || '')
        setHasMore(!!page.hasMore)
        setTruncated(!!page.truncated)
        if (mode === 'reset') {
          const next = await api.get<Stats>('/api/v1/logs/access/stats', params)
          setStats(next)
          const m = await api.get<Meta>('/api/v1/logs/access/meta')
          setMeta(m)
        }
      } catch (err) {
        toast.danger(errorText(err))
      } finally {
        setLoading(false)
        setMore(false)
      }
    },
    [params, cursor],
  )

  // Reload from the first page whenever the filters change. The short delay
  // keeps a fast typist from firing one request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load('reset')
    }, 250)
    return () => window.clearTimeout(timer)
    // load is intentionally not a dependency: it closes over the cursor, and a
    // cursor change must not reload the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  useEffect(() => {
    if (!auto) return
    const timer = window.setInterval(() => {
      // A background refresh must not replace the table with a loading block.
      void load('reset', true)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [auto, load])

  const exportCSV = () => {
    const url = '/api/v1/logs/access/export' + queryString(params)
    const link = document.createElement('a')
    link.href = url
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const clearAll = async () => {
    try {
      await api.del('/api/v1/logs/access')
      toast.success('访问日志已清空')
      setConfirmClear(false)
      setRows([])
      setCursor('')
      setHasMore(false)
      void load('reset')
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const failure = (stats?.byStatus['4xx'] || 0) + (stats?.byStatus['5xx'] || 0)
  const failureRate = stats && stats.total > 0 ? ((failure / stats.total) * 100).toFixed(1) : '0.0'
  const topIP = stats?.topIps?.[0]

  const columns: Column<Row>[] = [
    {
      key: 'time',
      title: '时间',
      render: (row) => <span className="text-xs text-muted">{fmtTime(row.time)}</span>,
    },
    {
      key: 'source',
      title: '来源',
      render: (row) => {
        const meta = SOURCE_META[row.source] || { label: row.source || '-', color: 'default' as const }
        return <StatusChip color={meta.color}>{meta.label}</StatusChip>
      },
    },
    {
      key: 'rule',
      title: '站点 / 规则',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm">{row.rule || row.ruleId || '-'}</div>
          <div className="truncate text-[11px] text-muted">
            {[row.host, row.listen, row.protocol].filter(Boolean).join(' · ') || '-'}
          </div>
        </div>
      ),
    },
    {
      key: 'request',
      title: '请求',
      render: (row) => {
        if (row.source === 'forward') {
          return (
            <div className="mono min-w-0 text-xs">
              <div className="truncate">
                {row.clientIp || '-'} → {row.upstream || '-'}
              </div>
              <div className="truncate text-[11px] text-muted">
                {row.bytesIn ? `↑ ${fmtBytes(row.bytesIn)} ` : ''}
                {row.bytesOut ? `↓ ${fmtBytes(row.bytesOut)}` : ''}
              </div>
            </div>
          )
        }
        return (
          <div className="mono min-w-0 text-xs">
            <div className="truncate">
              <span className="text-muted">{row.method || '-'}</span> {row.path || '-'}
            </div>
            {row.message ? <div className="truncate text-[11px] text-muted">{row.message}</div> : null}
          </div>
        )
      },
    },
    {
      key: 'result',
      title: '状态 / 结果',
      render: (row) => (
        <div className="min-w-0">
          {row.status ? (
            <StatusChip color={statusColor(row.status)}>{row.status}</StatusChip>
          ) : (
            <span className="text-xs text-muted">{row.result || '-'}</span>
          )}
          {row.reason || row.error ? (
            <div className="mt-0.5 max-w-48 truncate text-[11px] text-warning" title={row.error || row.reason}>
              {row.reason || row.error}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'client',
      title: '客户端',
      render: (row) => <span className="mono text-xs">{row.clientIp || '-'}</span>,
    },
    {
      key: 'duration',
      title: '耗时',
      render: (row) => <span className="text-xs text-muted">{row.durationMs ? `${row.durationMs} ms` : '-'}</span>,
    },
    {
      key: 'bytes',
      title: '大小',
      render: (row) => (
        <span
          className="text-xs text-muted"
          title={row.bytesIn || row.bytesOut ? `请求 ${fmtBytes(row.bytesIn ?? 0)} · 响应 ${fmtBytes(row.bytesOut ?? 0)}` : undefined}
        >
          {row.bytes ? fmtBytes(row.bytes) : '-'}
        </span>
      ),
    },
    {
      key: 'requestId',
      title: '请求 ID',
      render: (row) => (
        <span className="mono text-[11px] text-muted" title={row.requestId}>
          {row.requestId ? row.requestId.slice(0, 8) : '-'}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      {meta && !meta.persist ? (
        <AlertBox status="warning" title="磁盘持久化已关闭">
          访问记录只保留在各模块的内存缓冲里，重启后丢失。可在「设置 → 日志」中开启持久化。
        </AlertBox>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard label="匹配记录" value={(stats?.total ?? 0).toLocaleString()} hint={`匹配 ${stats?.scanned ?? 0} 条`} />
        <StatCard label="失败请求" value={failure.toLocaleString()} hint={`占比 ${failureRate}%（4xx + 5xx）`} />
        <StatCard label="流量合计" value={fmtBytes(stats?.bytes ?? 0)} hint={`平均耗时 ${Math.round(stats?.avgDurationMs ?? 0)} ms`} />
        <StatCard
          label="最活跃客户端"
          value={topIP?.name || '-'}
          hint={topIP ? `${topIP.count.toLocaleString()} 条记录` : '暂无数据'}
        />
      </div>

      <Panel
        title="访问日志"
        description="Web 请求、端口转发连接与 WAF 拦截都会落盘，可按来源、状态、IP 与关键字检索"
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" isDisabled={loading || more} onPress={() => void load('reset')}>
              <RefreshCw size={14} />
              刷新
            </Button>
            <Button variant="secondary" onPress={exportCSV}>
              <Download size={14} />
              导出 CSV
            </Button>
            <Button variant="tertiary" onPress={() => setConfirmClear(true)}>
              <Trash2 size={14} />
              清空
            </Button>
            <Button
              variant={auto ? 'primary' : 'tertiary'}
              onPress={() => {
                setAuto((prev) => !prev)
                toast.info(auto ? '已关闭自动刷新' : '已开启自动刷新（每 10 秒）')
              }}
            >
              自动刷新
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
          <div className="w-full sm:w-40">
            <SelectInput label="来源" value={source} onChange={setSource} options={SOURCES} />
          </div>
          <div className="w-full sm:w-44">
            <SelectInput label="状态" value={status} onChange={setStatus} options={STATUSES} />
          </div>
          <div className="w-full sm:w-44">
            <SelectInput label="时间范围" value={range} onChange={setRange} options={RANGES} />
          </div>
          <div className="w-full sm:w-40">
            <TextInput label="客户端 IP" value={ip} onChange={setIP} placeholder="前缀匹配，如 192.168." />
          </div>
          <div className="w-full sm:w-52">
            <TextInput label="关键字" value={keyword} onChange={setKeyword} placeholder="路径 / 域名 / UA / 结果" />
          </div>
        </div>

        {loading ? (
          <LoadingBlock />
        ) : (
          <div className="space-y-3 p-3">
            <div className="md:hidden">
              {rows.length ? (
                <div className="overflow-hidden rounded-lg border border-border">
                  {rows.map((row) => {
                    const meta = SOURCE_META[row.source] || { label: row.source || '-', color: 'default' as const }
                    return (
                      <button
                        key={row.key}
                        type="button"
                        onClick={() => setDetail(row)}
                        className="flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-default/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted">{fmtTime(row.time)}</span>
                          <StatusChip color={meta.color}>{meta.label}</StatusChip>
                          <span className="flex-1" />
                          {row.status ? (
                            <StatusChip color={statusColor(row.status)}>{row.status}</StatusChip>
                          ) : (
                            <span className="text-xs text-muted">{row.result || '-'}</span>
                          )}
                        </div>
                        <div className="truncate text-sm font-medium">{row.rule || row.ruleId || '-'}</div>
                        <div className="mono truncate text-xs text-muted">
                          {row.method || '-'} {row.path || '-'}
                        </div>
                        {row.reason || row.error ? (
                          <div className="truncate text-[11px] text-warning">{row.reason || row.error}</div>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
                          <span className="mono">{row.clientIp || '-'}</span>
                          <span>{row.durationMs ? `${row.durationMs} ms` : '-'}</span>
                          <span>{row.bytes ? fmtBytes(row.bytes) : '-'}</span>
                          {row.requestId ? <span className="mono">{row.requestId.slice(0, 8)}</span> : null}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted">
                  {loading ? '加载中…' : '没有匹配的访问记录'}
                </div>
              )}
            </div>
            <div className="hidden md:block">
              <DataTable
                items={rows}
                columns={columns}
                rowKey={(row) => row.key}
                ariaLabel="访问记录"
                empty="没有匹配的访问记录"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                已显示 {rows.length} 条
              </span>
              {hasMore ? (
                <Button variant="secondary" isDisabled={more} onPress={() => void load('more')}>
                  {more ? '加载中…' : '加载更多'}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="存储状态" description="访问日志数据库的位置、保留策略与写入计数">
        <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-muted">目录</div>
            <div className="mono break-all text-xs">{meta?.dir || '-'}</div>
          </div>
          <div>
            <div className="text-xs text-muted">保留</div>
            <div className="text-sm">
              {meta ? `${meta.keepDays} 天 · 数据库上限 ${meta.maxFileMb} MB` : '-'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">已写入 / 丢弃</div>
            <div className="text-sm">
              {(meta?.written ?? 0).toLocaleString()} / {(meta?.dropped ?? 0).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">数据库 / 占用</div>
            <div className="text-sm">
              {meta?.files?.length ?? 0} 个 · {fmtBytes(meta?.totalBytes ?? 0)}
            </div>
          </div>
        </div>
        {meta?.files?.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {meta.files.slice(-8).map((file) => (
              <StatusChip key={file.name}>
                {file.name.replace('access-', '').replace('.jsonl', '')} · {fmtBytes(file.size)}
              </StatusChip>
            ))}
          </div>
        ) : null}
      </Panel>

      <ConfirmModal
        open={confirmClear}
        title="清空访问日志"
        content="这会删除磁盘上全部访问日志文件，且无法恢复。仅关闭持久化不会删除历史记录。"
        confirmText="清空"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
      />
      <FormModal
        open={!!detail}
        onClose={() => setDetail(null)}
        title="访问记录详情"
        size="lg"
        footer={
          <div className="flex justify-end">
            <Button variant="tertiary" onPress={() => setDetail(null)}>
              关闭
            </Button>
          </div>
        }
      >
        {detail ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Detail label="时间" value={fmtTime(detail.time)} />
              <Detail label="来源" value={detail.source} />
              <Detail label="站点 / 规则" value={detail.rule || detail.ruleId || '-'} />
              <Detail label="监听 / 域名" value={[detail.listen, detail.host].filter(Boolean).join(' · ') || '-'} />
              <Detail label="方法" value={detail.method || '-'} />
              <Detail label="路径" value={detail.path || '-'} mono />
              <Detail label="状态" value={detail.status ? String(detail.status) : detail.result || '-'} />
              <Detail label="客户端" value={detail.clientIp || '-'} mono />
              <Detail label="耗时" value={detail.durationMs ? `${detail.durationMs} ms` : '-'} />
              <Detail
                label="字节"
                value={detail.bytesIn || detail.bytesOut
                  ? `请求 ${fmtBytes(detail.bytesIn ?? 0)} · 响应 ${fmtBytes(detail.bytesOut ?? 0)} · 合计 ${fmtBytes(detail.bytes ?? 0)}`
                  : detail.bytes ? fmtBytes(detail.bytes) : '-'}
              />
              <Detail label="上游" value={detail.upstream || '-'} mono />
              <Detail
                label="上游状态 / 尝试"
                value={[detail.upstreamStatus, detail.attempts ? `${detail.attempts} 次` : ''].filter(Boolean).join(' · ') || '-'}
              />
              <Detail label="HTTP / TLS" value={[detail.proto, detail.tls ? `TLS ${detail.tls}` : ''].filter(Boolean).join(' · ') || '-'} />
              <Detail label="请求 ID" value={detail.requestId || '-'} mono />
            </div>
            {detail.reason || detail.error ? (
              <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                {detail.reason ? <div>拒绝原因：{detail.reason}</div> : null}
                {detail.error ? <div className="mono mt-1 break-all">错误：{detail.error}</div> : null}
              </div>
            ) : null}
            {detail.userAgent ? (
              <div>
                <div className="text-xs text-muted">User-Agent</div>
                <div className="mono break-all text-xs">{detail.userAgent}</div>
              </div>
            ) : null}
            {detail.message ? (
              <div>
                <div className="text-xs text-muted">消息</div>
                <div className="text-xs">{detail.message}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </FormModal>
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={['mt-0.5 break-words', mono ? 'mono text-xs' : ''].filter(Boolean).join(' ')}>{value || '-'}</div>
    </div>
  )
}
