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
  SelectInput,
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
  country?: string
  province?: string
  city?: string
  wafAction?: string
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
  const [confirmClear, setConfirmClear] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [auto, setAuto] = useState(false)

  const seqRef = useRef(0)
  const moreRef = useRef(false)

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
      if (mode === 'more') {
        if (moreRef.current) return
        moreRef.current = true
        setMore(true)
      }
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
        if (mode === 'reset') {
          const next = await api.get<Stats>('/api/v1/logs/access/stats', params)
          setStats(next)
          const m = await api.get<Meta>('/api/v1/logs/access/meta')
          setMeta(m)
        }
      } catch (err) {
        toast.danger(errorText(err))
      } finally {
        if (mode === 'more') moreRef.current = false
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
          {row.wafAction ? (
            <div className="mt-0.5 max-w-48 truncate text-[11px] text-warning" title={row.message}>
              WAF {row.wafAction}
              {row.wafRuleId ? ` #${row.wafRuleId}` : ''}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'client',
      title: '客户端',
      render: (row) => {
        const geo = [row.country, row.province, row.city].filter(Boolean).join(' · ')
        return (
          <div className="min-w-0">
            <div className="mono text-xs">{row.clientIp || '-'}</div>
            {geo ? <div className="truncate text-[11px] text-muted">{geo}</div> : null}
          </div>
        )
      },
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

  const filterFields = (
    <>
      <div className="w-full sm:w-36">
        <SelectInput label="来源" value={source} onChange={setSource} options={SOURCES} />
      </div>
      <div className="w-full sm:w-36">
        <SelectInput label="状态" value={status} onChange={setStatus} options={STATUSES} />
      </div>
      <div className="w-full sm:w-36">
        <SelectInput label="时间范围" value={range} onChange={setRange} options={RANGES} />
      </div>
      <div className="w-full sm:w-40">
        <TextInput label="客户端 IP" value={ip} onChange={setIP} placeholder="前缀匹配" />
      </div>
      <div className="w-full sm:w-48">
        <TextInput label="关键字" value={keyword} onChange={setKeyword} placeholder="路径 / 域名 / UA" />
      </div>
    </>
  )

  const activeFilters = [source !== 'all', status !== 'all', range !== '24h', ip.trim() !== '', keyword.trim() !== ''].filter(Boolean).length

  const actions = (
    <>
      <Button size="sm" variant="secondary" isDisabled={loading || more} onPress={() => void load('reset')}>
        <RefreshCw size={14} />
        刷新
      </Button>
      <Button size="sm" variant="secondary" onPress={exportCSV}>
        <Download size={14} />
        导出
      </Button>
      <Button size="sm" variant="tertiary" onPress={() => setConfirmClear(true)}>
        <Trash2 size={14} />
        清空
      </Button>
      <Button
        size="sm"
        variant={auto ? 'primary' : 'tertiary'}
        onPress={() => {
          setAuto((prev) => !prev)
          toast.info(auto ? '已关闭自动刷新' : '已开启自动刷新（每 10 秒）')
        }}
      >
        自动刷新
      </Button>
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {meta && !meta.persist ? (
        <AlertBox status="warning" title="磁盘持久化已关闭">
          访问记录只保留在各模块的内存缓冲里，重启后丢失。可在「设置 → 日志」中开启持久化。
        </AlertBox>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-2.5 md:hidden">
          <Button size="sm" variant="secondary" onPress={() => setFiltersOpen(true)}>
            筛选{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
        </div>
        <div className="hidden flex-wrap items-end gap-2 border-b border-border p-2.5 md:flex">
          {filterFields}
          <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">{actions}</div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-xs text-muted">
          <span>匹配 {stats?.total ?? 0}</span>
          <span>失败 {failure}（{failureRate}%）</span>
          <span className="hidden sm:inline">流量 {fmtBytes(stats?.bytes ?? 0)}</span>
          <span className="hidden sm:inline">平均 {Math.round(stats?.avgDurationMs ?? 0)} ms</span>
          <span className="hidden md:inline">最活跃 {topIP?.name || '-'}</span>
        </div>

        {loading ? (
          <LoadingBlock />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <div className="min-h-0 flex-1">
              <DataTable
                items={rows}
                columns={columns}
                rowKey={(row) => row.key}
                ariaLabel="访问记录"
                virtual
                fill
                rowHeight={64}
                scrollResetKey={params}
                onEndReached={hasMore ? () => void load('more') : undefined}
                empty="没有匹配的访问记录"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                已显示 {rows.length} 条
                {meta ? ` · SQLite ${meta.keepDays} 天 / ${meta.maxFileMb} MB · 占用 ${fmtBytes(meta.totalBytes)}` : ''}
                {meta?.dropped ? ` · 丢弃 ${meta.dropped}` : ''}
              </span>
              {hasMore ? (
                <Button size="sm" variant="secondary" isDisabled={more} onPress={() => void load('more')}>
                  {more ? '加载中…' : '加载更多'}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <FormModal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="筛选访问日志"
        size="md"
        footer={
          <div className="flex justify-end">
            <Button variant="tertiary" onPress={() => setFiltersOpen(false)}>
              完成
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3">{filterFields}</div>
      </FormModal>

      <ConfirmModal
        open={confirmClear}
        title="清空访问日志"
        content="这会删除磁盘上全部访问日志文件，且无法恢复。仅关闭持久化不会删除历史记录。"
        confirmText="清空"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
      />
    </div>
  )
}
