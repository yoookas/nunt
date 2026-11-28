import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Grid,
  Input,
  Select,
  Switch,
  Tag,
  Tooltip,
  Typography,
  type DescriptionsProps,
} from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FilterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../../api'
import {
  Muted,
  SourceTag,
  StatusTag,
  Toolbar,
  confirmDelete,
  useIsMobile,
} from '../../components'
import { copyText } from '../../clipboard'
import { fmtBytes } from '../../format'
import { VirtualList, type VirtualListHandle } from './VirtualList'
import { useLogThemeVars } from './theme'
import styles from './Logs.module.css'
import {
  bytesText,
  durationText,
  fullTime,
  geoText,
  rangeStart,
  shortTime,
  type AccessEntry,
  type AccessMeta,
  type AccessPage,
  type AccessRow,
  type AccessStats,
  type RangeKey,
} from './types'

const PAGE_SIZE = 100
const AUTO_REFRESH_MS = 10_000

const RANGES: { value: RangeKey; label: string }[] = [
  { value: '1h', label: '最近 1 小时' },
  { value: '6h', label: '最近 6 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'all', label: '全部（按保留天数）' },
]


// The drawer of a forward record keeps only the columns that exist for it.
const FORWARD_DETAIL_KEYS = new Set([
  'time',
  'source',
  'rule',
  'listen',
  'protocol',
  'status',
  'reason',
  'error',
  'clientIp',
  'geo',
  'upstream',
  'duration',
  'bytes',
  'message',
])

const STATUSES = [
  { value: 'all', label: '全部状态' },
  { value: '2xx', label: '2xx 成功' },
  { value: '3xx', label: '3xx 跳转' },
  { value: '4xx', label: '4xx 客户端错误' },
  { value: '5xx', label: '5xx 服务端错误' },
]

interface LoadOptions {
  quiet?: boolean
  clear?: boolean
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

function downloadName(header: string | null, fallback: string): string {
  if (!header) return fallback
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  if (!match || !match[1]) return fallback
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

// One column of an access table. Both tables render from a list of these, so a
// field is added by naming it once instead of touching the header and the row.
type Column = {
  key: string
  label: string
  /** grid-template-columns track used on desktop. */
  track: string
  /** Track used on the phone layout; a column without one is desktop only. */
  mobile?: string
  /** Smallest breakpoint that shows the column; unset means always. */
  min?: 'lg' | 'xl'
  className?: string
  cellClass?: (row: AccessRow) => string
  title?: (row: AccessRow) => string | undefined
  value: (row: AccessRow) => ReactNode
}

// verdictOf describes why a request did not simply succeed.
function verdictOf(row: AccessRow) {
  const waf = row.wafAction
    ? `WAF ${row.wafAction}${row.wafRuleId ? ` #${row.wafRuleId}` : ''}`
    : ''
  return [row.reason, row.error, waf].filter(Boolean).join(' · ')
}

function mono(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return '-'
  return <span className={styles.detailMono}>{value}</span>
}

export default function AccessLogs({
  active,
  source,
}: {
  active: boolean
  /** The log source of this table: the page renders one table per source. */
  source: 'web' | 'forward'
}) {
  const { message } = App.useApp()
  const messageRef = useRef(message)
  messageRef.current = message

  const isMobile = useIsMobile()
  const screens = Grid.useBreakpoint()
  const vars = useLogThemeVars()

  const [status, setStatus] = useState('all')
  const [range, setRange] = useState<RangeKey>('24h')
  const [ip, setIP] = useState('')
  const [keyword, setKeyword] = useState('')

  const [rows, setRows] = useState<AccessRow[]>([])
  const [stats, setStats] = useState<AccessStats | null>(null)
  const [meta, setMeta] = useState<AccessMeta | null>(null)
  const [statsError, setStatsError] = useState(false)
  const [metaError, setMetaError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detail, setDetail] = useState<AccessRow | null>(null)

  const listRef = useRef<VirtualListHandle | null>(null)
  const seqRef = useRef(0)
  const rowsRef = useRef<AccessRow[]>([])
  const cursorRef = useRef('')
  const hasMoreRef = useRef(false)
  const loadingMoreRef = useRef(false)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const atTopRef = useRef(true)
  const autoRefreshRef = useRef(true)
  const activeRef = useRef(active)
  activeRef.current = active
  const exportingRef = useRef(false)

  const params = useMemo(
    () => ({
      source,
      status: status === 'all' ? '' : status,
      from: rangeStart(range),
      to: '',
      ip: ip.trim(),
      q: keyword.trim(),
    }),
    [source, status, range, ip, keyword],
  )
  const paramsRef = useRef(params)
  paramsRef.current = params

  const mapItems = useCallback(
    (items: AccessEntry[]): AccessRow[] =>
      items.map((item) => {
        seqRef.current += 1
        return { ...item, key: `access-${seqRef.current}` }
      }),
    [],
  )

  const loadStats = useCallback(
    async (generation: number, query: Record<string, unknown>, signal?: AbortSignal) => {
      try {
        const next = await api.get<AccessStats>(
          '/api/v1/logs/access/stats',
          query,
          signal ? { signal } : undefined,
        )
        if (generation !== generationRef.current) return
        setStats(next)
        setStatsError(false)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        if (generation !== generationRef.current) return
        setStatsError(true)
      }
    },
    [],
  )

  const loadMeta = useCallback(async (generation: number, signal?: AbortSignal) => {
    try {
      const next = await api.get<AccessMeta>(
        '/api/v1/logs/access/meta',
        undefined,
        signal ? { signal } : undefined,
      )
      if (generation === generationRef.current) {
        setMeta(next)
        setMetaError(false)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (generation === generationRef.current) setMetaError(true)
    }
  }, [])

  const loadFirst = useCallback(
    async (options: LoadOptions = {}) => {
      const generation = ++generationRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      loadingMoreRef.current = false
      setMore(false)
      if (!options.quiet) setLoading(true)
      if (options.clear) {
        rowsRef.current = []
        setRows([])
        cursorRef.current = ''
        hasMoreRef.current = false
        setHasMore(false)
        setStats(null)
        setStatsError(false)
      }
      const query = paramsRef.current
      try {
        const page = await api.get<AccessPage>(
          '/api/v1/logs/access',
          { ...query, limit: PAGE_SIZE, cursor: '' },
          { signal: controller.signal },
        )
        if (generation !== generationRef.current) return
        const mapped = mapItems(Array.isArray(page?.items) ? page.items : [])
        rowsRef.current = mapped
        setRows(mapped)
        const nextCursor = page?.nextCursor || ''
        cursorRef.current = nextCursor
        const nextHasMore = !!page?.hasMore && mapped.length > 0 && nextCursor !== ''
        hasMoreRef.current = nextHasMore
        setHasMore(nextHasMore)
        setLastUpdated(Date.now())
        void loadStats(generation, query, controller.signal)
        void loadMeta(generation, controller.signal)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        if (generation !== generationRef.current) return
        if (!options.quiet) messageRef.current.error(errorText(err))
        if (options.clear) {
          rowsRef.current = []
          setRows([])
          cursorRef.current = ''
          hasMoreRef.current = false
          setHasMore(false)
          setStatsError(true)
          setMetaError(true)
        }
      } finally {
        if (generation === generationRef.current) setLoading(false)
      }
    },
    [loadMeta, loadStats, mapItems],
  )

  // handleAtTop is stable, so it reads the newest loader through a ref.
  const loadFirstRef = useRef(loadFirst)
  loadFirstRef.current = loadFirst

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return
    const cursor = cursorRef.current
    if (!cursor) return
    loadingMoreRef.current = true
    setMore(true)
    const generation = generationRef.current
    try {
      const page = await api.get<AccessPage>('/api/v1/logs/access', {
        ...paramsRef.current,
        limit: PAGE_SIZE,
        cursor,
      })
      if (generation !== generationRef.current) return
      const mapped = mapItems(Array.isArray(page?.items) ? page.items : [])
      if (!mapped.length) {
        cursorRef.current = ''
        hasMoreRef.current = false
        setHasMore(false)
        return
      }
      const next = rowsRef.current.concat(mapped)
      rowsRef.current = next
      setRows(next)
      const nextCursor = page?.nextCursor || ''
      cursorRef.current = nextCursor
      const nextHasMore = !!page?.hasMore && nextCursor !== '' && nextCursor !== cursor
      hasMoreRef.current = nextHasMore
      setHasMore(nextHasMore)
      setLastUpdated(Date.now())
    } catch (err) {
      if (generation !== generationRef.current) return
      messageRef.current.error(errorText(err))
      hasMoreRef.current = false
      setHasMore(false)
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false
        setMore(false)
      }
    }
  }, [mapItems])

  // Filter changes restart from page one after a short typing delay.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFirst({ clear: true })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [params, loadFirst])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const refreshStats = useCallback(() => {
    const generation = generationRef.current
    void loadStats(generation, paramsRef.current)
    void loadMeta(generation)
  }, [loadMeta, loadStats])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      if (!activeRef.current || document.hidden) return
      if (atTopRef.current || rowsRef.current.length === 0) void loadFirst({ quiet: true })
      else refreshStats()
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, loadFirst, refreshStats])

  // Like the run log: scrolling away pauses the switch, scrolling back to the
  // top turns it on again, so returning to the newest records restores live
  // updates without a second click.
  const handleAtTop = useCallback((atTop: boolean) => {
    atTopRef.current = atTop
    if (atTop) {
      if (!autoRefreshRef.current) {
        autoRefreshRef.current = true
        setAutoRefresh(true)
        // Coming back to the top resumes following right away instead of
        // waiting up to ten seconds for the next tick.
        void loadFirstRef.current({ quiet: true })
      }
    } else if (autoRefreshRef.current) {
      autoRefreshRef.current = false
      setAutoRefresh(false)
    }
  }, [])

  const handleRefresh = () => {
    listRef.current?.scrollToTop()
    void loadFirst()
  }

  const resetFilters = () => {
    setStatus('all')
    setRange('24h')
    setIP('')
    setKeyword('')
  }

  const activeFilterCount = [
    source === 'web' && status !== 'all',
    range !== '24h',
    ip.trim() !== '',
    keyword.trim() !== '',
  ].filter(Boolean).length

  const exportCSV = useCallback(async () => {
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      const response = await fetch(
        '/api/v1/logs/access/export' + queryString(paramsRef.current),
        {
          credentials: 'same-origin',
          headers: { Accept: 'text/csv' },
        },
      )
      if (!response.ok) {
        let text = `导出失败（HTTP ${response.status}）`
        try {
          const data = (await response.json()) as { error?: { message?: string } }
          if (data?.error?.message) text = data.error.message
        } catch {
          // The body was not JSON; keep the HTTP status message.
        }
        if (response.status === 401) {
          window.dispatchEvent(new CustomEvent('nunt:unauthorized'))
        }
        throw new Error(text)
      }
      const blob = await response.blob()
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const name = downloadName(
        response.headers.get('Content-Disposition'),
        `nunt-access-${stamp}.csv`,
      )
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      messageRef.current.success('CSV 已开始下载')
    } catch (err) {
      messageRef.current.error(errorText(err))
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }, [])

  const clearAll = () => {
    confirmDelete(
      '清空访问日志',
      '这会删除全部访问日志记录，且无法恢复。仅关闭持久化不会删除历史记录。',
      async () => {
        try {
          await api.del('/api/v1/logs/access')
          messageRef.current.success('访问日志已清空')
          listRef.current?.scrollToTop()
          await loadFirst({ clear: true })
        } catch (err) {
          messageRef.current.error(errorText(err))
        }
      },
    )
  }

  const copyDetail = () => {
    if (!detail) return
    const payload: Record<string, unknown> = { ...detail }
    delete payload.key
    if (copyText(JSON.stringify(payload, null, 2))) messageRef.current.success('已复制 JSON')
    else messageRef.current.error('复制失败，请手动选择文本')
  }

  const failure = (stats?.byStatus?.['4xx'] || 0) + (stats?.byStatus?.['5xx'] || 0)
  const failureRate = stats && stats.total > 0 ? ((failure / stats.total) * 100).toFixed(1) : '0.0'
  const topIP = stats?.topIps?.[0]?.name || '-'

  // A row is one line: the record in full is one click away in the drawer, so
  // the table only has to answer what an operator scans for. Each table keeps
  // its own columns, widths and headings.
  const webColumns: Column[] = [
    {
      key: 'time',
      label: '时间',
      track: 'minmax(120px,132px)',
      mobile: '56px',
      className: `${styles.mono} ${styles.muted}`,
      title: (row) => fullTime(row.time),
      value: (row) => (isMobile ? shortTime(row.time) : fullTime(row.time)),
    },
    {
      key: 'source',
      label: '来源',
      track: '54px',
      mobile: '48px',
      value: (row) => <SourceTag source={row.source} />,
    },
    {
      key: 'rule',
      label: '站点 / 规则',
      track: 'minmax(96px,0.9fr)',
      min: 'lg',
      title: (row) =>
        [row.rule || row.ruleId, row.listen, row.proto, row.tls].filter(Boolean).join(' · ') ||
        undefined,
      value: (row) => row.rule || row.ruleId || '-',
    },
    {
      key: 'host',
      label: '域名',
      track: 'minmax(96px,0.9fr)',
      min: 'lg',
      title: (row) => row.host,
      value: (row) => row.host || '-',
    },
    {
      key: 'request',
      label: '请求',
      track: 'minmax(168px,1.6fr)',
      mobile: 'minmax(120px,1fr)',
      className: styles.mono,
      title: (row) =>
        [`${row.method || '-'} ${row.path || '-'}`, row.userAgent, row.message]
          .filter(Boolean)
          .join(' · ') || undefined,
      value: (row) => `${row.method || '-'} ${row.path || '-'}`,
    },
    {
      key: 'upstream',
      label: '上游',
      track: 'minmax(96px,0.8fr)',
      min: 'xl',
      className: `${styles.mono} ${styles.muted}`,
      title: (row) =>
        row.upstreamStatus || row.attempts
          ? `${row.upstream || '-'} · ${row.upstreamStatus ?? '-'} / ${row.attempts ?? 0} 次`
          : row.upstream,
      value: (row) => row.upstream || '-',
    },
    {
      key: 'status',
      label: '状态',
      track: '62px',
      mobile: '58px',
      title: (row) => [row.result, row.wafAction && `WAF ${row.wafAction}`].filter(Boolean).join(' · ') || undefined,
      value: (row) => (row.status ? <StatusTag status={row.status} /> : row.result || '-'),
    },
    {
      key: 'note',
      label: '说明',
      track: 'minmax(88px,0.9fr)',
      min: 'lg',
      cellClass: (row) =>
        row.error ? styles.dangerText : verdictOf(row) ? styles.warnText : styles.muted,
      title: (row) => verdictOf(row),
      value: (row) => verdictOf(row) || '-',
    },
    {
      key: 'clientIp',
      label: '客户端 IP',
      track: 'minmax(96px,0.9fr)',
      className: styles.mono,
      title: (row) => [row.clientIp, geoText(row)].filter(Boolean).join(' · ') || undefined,
      value: (row) => row.clientIp || '-',
    },
    {
      key: 'geo',
      label: '地区',
      track: 'minmax(84px,0.8fr)',
      min: 'lg',
      className: styles.muted,
      title: (row) => geoText(row) || undefined,
      value: (row) => geoText(row) || '-',
    },
    {
      key: 'size',
      label: '大小',
      track: '64px',
      min: 'lg',
      className: `${styles.mono} ${styles.muted}`,
      title: (row) =>
        row.bytesIn || row.bytesOut
          ? `请求 ${fmtBytes(row.bytesIn ?? 0)} · 响应 ${fmtBytes(row.bytesOut ?? 0)}`
          : undefined,
      value: (row) => bytesText(row),
    },
    {
      key: 'duration',
      label: '耗时',
      track: '54px',
      className: `${styles.mono} ${styles.muted}`,
      value: (row) => durationText(row.durationMs),
    },
  ]

  const forwardColumns: Column[] = [
    webColumns[0],
    webColumns[1],
    {
      key: 'rule',
      label: '规则',
      track: 'minmax(96px,0.9fr)',
      min: 'lg',
      title: (row) => [row.rule || row.ruleId, row.ruleId].filter(Boolean).join(' · ') || undefined,
      value: (row) => row.rule || row.ruleId || '-',
    },
    {
      key: 'conn',
      label: '连接',
      track: 'minmax(168px,1.6fr)',
      mobile: 'minmax(120px,1fr)',
      className: styles.mono,
      title: (row) =>
        [
          `${row.listen || '-'} → ${row.upstream || '-'}`,
          row.protocol,
          row.bytesIn || row.bytesOut
            ? `↑ ${fmtBytes(row.bytesIn ?? 0)} ↓ ${fmtBytes(row.bytesOut ?? 0)}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      value: (row) => `${row.listen || '-'} → ${row.upstream || '-'}`,
    },
    {
      key: 'protocol',
      label: '协议',
      track: '44px',
      min: 'lg',
      className: `${styles.mono} ${styles.muted}`,
      value: (row) => row.protocol || '-',
    },
    {
      key: 'result',
      label: '结果',
      track: 'minmax(88px,0.8fr)',
      mobile: '58px',
      cellClass: (row) => (row.error ? styles.dangerText : ''),
      title: (row) => [row.result, row.error].filter(Boolean).join(' · ') || undefined,
      value: (row) => row.result || (row.status ? <StatusTag status={row.status} /> : '-'),
    },
    {
      key: 'reason',
      label: '原因',
      track: 'minmax(88px,0.9fr)',
      min: 'xl',
      cellClass: (row) =>
        row.reason || row.error ? styles.warnText : styles.muted,
      title: (row) => [row.reason, row.error, row.message].filter(Boolean).join(' · ') || undefined,
      value: (row) => row.reason || row.error || row.message || '-',
    },
    {
      key: 'clientIp',
      label: '客户端 IP',
      track: 'minmax(96px,0.9fr)',
      className: styles.mono,
      title: (row) => [row.clientIp, geoText(row)].filter(Boolean).join(' · ') || undefined,
      value: (row) => row.clientIp || '-',
    },
    {
      key: 'geo',
      label: '地区',
      track: 'minmax(84px,0.8fr)',
      min: 'lg',
      className: styles.muted,
      value: (row) => geoText(row) || '-',
      title: (row) => geoText(row) || undefined,
    },
    {
      key: 'bytesIn',
      label: '上行',
      track: '60px',
      min: 'lg',
      className: `${styles.mono} ${styles.muted}`,
      value: (row) => (row.bytesIn ? fmtBytes(row.bytesIn) : '-'),
    },
    {
      key: 'bytesOut',
      label: '下行',
      track: '66px',
      min: 'lg',
      className: `${styles.mono} ${styles.muted}`,
      value: (row) => (row.bytesOut ? fmtBytes(row.bytesOut) : '-'),
    },
    {
      key: 'duration',
      label: '连接时长',
      track: '58px',
      className: `${styles.mono} ${styles.muted}`,
      value: (row) => durationText(row.durationMs),
    },
  ]

  const columns = (source === 'web' ? webColumns : forwardColumns).filter((col) => {
    if (isMobile) return !!col.mobile
    if (!col.min) return true
    return col.min === 'lg' ? !!screens.lg : !!screens.xl
  })
  const template = columns
    .map((col) => (isMobile ? col.mobile : col.track))
    .join(' ')

  const header = (
    <div className={`${styles.grid} ${styles.gridHead}`} style={{ gridTemplateColumns: template }}>
      {columns.map((col) => (
        <span key={col.key} className={styles.line}>
          {col.label}
        </span>
      ))}
    </div>
  )

  const renderRow = (row: AccessRow) => {
    return (
      <div
        className={`${styles.grid} ${styles.gridRow} ${styles.clickable}`}
        style={{ gridTemplateColumns: template }}
        role="button"
        tabIndex={0}
        onClick={() => setDetail(row)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setDetail(row)
          }
        }}
      >
        {columns.map((col) => (
          <span
            key={col.key}
            className={[styles.line, col.className, col.cellClass?.(row)]
              .filter(Boolean)
              .join(' ')}
            title={col.title?.(row)}
          >
            {col.value(row)}
          </span>
        ))}
      </div>
    )
  }


  const filterFields = (stacked: boolean) => {
    const width = (value: number) => (stacked ? { width: '100%' } : { width: value })
    const size = stacked ? 'middle' : 'small'
    const field = (label: string, control: ReactNode) =>
      stacked ? (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{label}</span>
          {control}
        </div>
      ) : (
        control
      )
    return (
      <>
        {/* A forward row carries no HTTP status, so the status filter would
            only ever return nothing. */}
        {source === 'web'
          ? field(
              '状态',
              <Select
                size={size}
                value={status}
                onChange={setStatus}
                options={STATUSES}
                style={width(148)}
                aria-label="状态"
              />,
            )
          : null}
        {field(
          '时间范围',
          <Select
            size={size}
            value={range}
            onChange={(value) => setRange(value as RangeKey)}
            options={RANGES}
            style={width(150)}
            aria-label="时间范围"
          />,
        )}
        {field(
          '客户端 IP',
          <Input
            size={size}
            value={ip}
            onChange={(event) => setIP(event.target.value)}
            placeholder={stacked ? '前缀匹配' : 'IP 前缀'}
            allowClear
            style={width(138)}
            aria-label="客户端 IP"
          />,
        )}
        {field(
          '关键字',
          <Input
            size={size}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={source === 'web' ? '路径 / 域名 / UA' : '目标 / 规则 / 结果'}
            allowClear
            prefix={<SearchOutlined />}
            style={width(190)}
            aria-label="关键字"
          />,
        )}
      </>
    )
  }

  const actions = (
    <>
      <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={handleRefresh}>
        刷新
      </Button>
      <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportCSV()}>
        导出
      </Button>
      <Button size="small" danger icon={<DeleteOutlined />} onClick={clearAll}>
        清空
      </Button>
      <Tooltip title="停在列表顶部时每 10 秒刷新；向上翻看历史会自动暂停，回到顶部恢复">
        <span className={styles.switchLabel}>
          <Switch
            size="small"
            checked={autoRefresh}
            onChange={(value) => {
              autoRefreshRef.current = value
              setAutoRefresh(value)
            }}
            aria-label="自动刷新"
          />
          自动刷新
        </span>
      </Tooltip>
    </>
  )

  const storageLabel = meta
    ? meta.persist
      ? `SQLite ${meta.keepDays ?? '-'} 天 / ${meta.maxFileMb ?? '-'} MB`
      : '未开启持久化（仅内存）'
    : metaError
      ? '存储信息不可用'
      : '存储信息加载中…'
  const files = meta?.files?.length ?? 0
  const storageShort = meta
    ? meta.persist
      ? `SQLite ${meta.keepDays ?? '-'}天/${meta.maxFileMb ?? '-'}MB`
      : '未持久化'
    : metaError
      ? '存储信息不可用'
      : '加载中…'

  // A forward record has no HTTP columns; listing them empty would only be
  // noise in the drawer.
  const forwardDetail = detail?.source === 'forward'
  const detailItems: DescriptionsProps['items'] = detail
    ? [
        { key: 'time', label: '时间', children: fullTime(detail.time) },
        { key: 'source', label: '来源', children: <SourceTag source={detail.source} /> },
        {
          key: 'rule',
          label: forwardDetail ? '规则' : '站点 / 规则',
          children: detail.rule || detail.ruleId || '-',
        },
        { key: 'host', label: '域名', children: mono(detail.host) },
        { key: 'listen', label: '监听', children: mono(detail.listen) },
        {
          key: 'protocol',
          label: '协议 / TLS',
          children: mono(
            [detail.proto, detail.tls].filter(Boolean).join(' · ') || detail.protocol || '-',
          ),
        },
        { key: 'method', label: '方法', children: mono(detail.method) },
        { key: 'path', label: '路径', children: mono(detail.path) },
        {
          key: 'status',
          label: '状态 / 结果',
          children: (
            <div className={styles.detailStack}>
              {detail.status ? <StatusTag status={detail.status} /> : <span>{detail.result || '-'}</span>}
              {detail.result && detail.status ? <Muted>{detail.result}</Muted> : null}
            </div>
          ),
        },
        {
          key: 'upstreamStatus',
          label: '上游状态 / 重试',
          children:
            detail.upstreamStatus || detail.attempts
              ? `${detail.upstreamStatus ?? '-'} / ${detail.attempts ?? 0} 次`
              : '-',
        },
        { key: 'reason', label: '拒绝原因', children: detail.reason ? <span className={styles.dangerText}>{detail.reason}</span> : '-' },
        { key: 'error', label: '错误', children: detail.error ? <span className={styles.dangerText}>{detail.error}</span> : '-' },
        {
          key: 'waf',
          label: 'WAF',
          children: detail.wafAction ? (
            <div className={styles.detailStack}>
              <Tag color="volcano">
                {detail.wafAction}
                {detail.wafRuleId ? ` #${detail.wafRuleId}` : ''}
              </Tag>
              {detail.message ? <Muted>{detail.message}</Muted> : null}
            </div>
          ) : (
            '-'
          ),
        },
        { key: 'clientIp', label: '客户端 IP', children: detail.clientIp ? <Typography.Text code copyable={{ text: detail.clientIp }}>{detail.clientIp}</Typography.Text> : '-' },
        { key: 'geo', label: '地区', children: geoText(detail) || '-' },
        { key: 'upstream', label: '上游 / 目标', children: mono(detail.upstream) },
        {
          key: 'duration',
          label: forwardDetail ? '连接时长' : '耗时',
          children: detail.durationMs ? `${detail.durationMs} ms` : '-',
        },
        {
          key: 'bytes',
          label: '字节',
          children:
            detail.bytesIn || detail.bytesOut || detail.bytes
              ? `总计 ${fmtBytes(detail.bytes || (detail.bytesIn || 0) + (detail.bytesOut || 0))} · 请求 ${fmtBytes(detail.bytesIn ?? 0)} · 响应 ${fmtBytes(detail.bytesOut ?? 0)}`
              : '-',
        },
        {
          key: 'requestId',
          label: '请求 ID',
          children: detail.requestId ? (
            <Typography.Text code copyable={{ text: detail.requestId }}>
              {detail.requestId}
            </Typography.Text>
          ) : (
            '-'
          ),
        },
        {
          key: 'userAgent',
          label: 'User-Agent',
          children: detail.userAgent ? <div className={styles.detailValue}>{detail.userAgent}</div> : '-',
        },
        { key: 'message', label: '消息', children: detail.message ? <div className={styles.detailValue}>{detail.message}</div> : '-' },
      ].filter(
        (item) => !forwardDetail || FORWARD_DETAIL_KEYS.has(String(item.key)),
      )
    : []

  return (
    <div className={styles.pane}>
      <div className={styles.panel}>
        {isMobile ? (
          <div className={styles.mobileBar}>
            <div className={styles.actionScroller}>
              <Button
                size="small"
                icon={<FilterOutlined />}
                onClick={() => setDrawerOpen(true)}
              >
                筛选{activeFilterCount ? ` (${activeFilterCount})` : ''}
              </Button>
              {actions}
            </div>
          </div>
        ) : (
          <div className={styles.toolbar}>
            <Toolbar>{filterFields(false)}</Toolbar>
            <div className={styles.toolbarEnd}>{actions}</div>
          </div>
        )}

        <div className={styles.statsLine}>
          {stats ? (
            <>
              <span className={styles.statItem}>
                匹配 <span className={styles.statValue}>{stats.total}</span>
              </span>
              <span className={styles.statItem}>
                失败{' '}
                <span className={failure ? styles.statError : styles.statValue}>{failure}</span>
                （{failureRate}%）
              </span>
              <span className={styles.statItem}>
                流量 <span className={styles.statValue}>{fmtBytes(stats.bytes || 0)}</span>
              </span>
              {!isMobile ? (
                <>
                  <span className={styles.statItem}>
                    平均{' '}
                    <span className={styles.statValue}>{Math.round(stats.avgDurationMs || 0)}</span> ms
                  </span>
                  <span className={styles.statItem}>
                    最活跃 IP <span className={styles.statValue}>{topIP}</span>
                  </span>
                  {stats.complete === false ? (
                    <span className={styles.statItem}>
                      统计未完整（扫描 {stats.scanned ?? 0} 条）
                    </span>
                  ) : null}
                </>
              ) : null}
            </>
          ) : statsError ? (
            <span className={`${styles.statItem} ${styles.statError}`}>统计暂不可用</span>
          ) : (
            <span className={styles.statItem}>统计加载中…</span>
          )}
          {!isMobile && lastUpdated ? (
            <span className={styles.statItem}>
              更新于{' '}
              {new Date(lastUpdated).toLocaleTimeString('zh-CN', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          ) : null}
          {!isMobile && more ? <span className={styles.statItem}>正在加载下一页…</span> : null}
        </div>

        <div className={styles.tableArea}>
          <VirtualList<AccessRow>
            ref={listRef}
            items={rows}
            rowHeight={isMobile ? 40 : 34}
            header={header}
            headerHeight={34}
            contentMinWidth={isMobile ? 360 : 1060}
            ariaLabel="访问日志"
            rowKey={(row) => row.key}
            renderRow={renderRow}
            onReachEnd={hasMore ? () => void loadMore() : undefined}
            onAtTopChange={handleAtTop}
            loading={loading}
            resetKey={params}
            empty={
              loading
                ? '正在加载访问日志…'
                : activeFilterCount
                  ? '没有匹配的访问记录，试试调整筛选条件'
                  : '还没有访问日志'
            }
          />
        </div>

        <div className={styles.metaLine}>
          {isMobile ? (
            <>
              <span className={styles.metaItem}>
                {rows.length} 条
                {more ? ' · 加载中…' : hasMore ? ' · 继续滚动' : rows.length ? ' · 已全部' : ''}
              </span>
              <span className={styles.metaItem}>·</span>
              <span
                className={`${styles.metaItem} ${meta && !meta.persist ? styles.statWarn : ''}`}
                title={meta?.dir}
              >
                存储：{storageShort}
              </span>
              <span className={styles.metaItem}>·</span>
              <span className={styles.metaItem}>{fmtBytes(meta?.totalBytes || 0)}</span>
              {meta?.dropped ? (
                <>
                  <span className={styles.metaItem}>·</span>
                  <span className={`${styles.metaItem} ${styles.statError}`}>丢弃 {meta.dropped}</span>
                </>
              ) : null}
              {meta?.lastError ? (
                <>
                  <span className={styles.metaItem}>·</span>
                  <span className={`${styles.metaItem} ${styles.statError}`} title={meta.lastError}>
                    存储错误
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <span className={styles.metaItem}>
                已显示 {rows.length} 条
                {more
                  ? ' · 正在加载…'
                  : hasMore
                    ? ' · 继续滚动加载更多'
                    : rows.length
                      ? ' · 已全部加载'
                      : ''}
              </span>
              <span className={styles.metaItem}>·</span>
              <span
                className={`${styles.metaItem} ${meta && !meta.persist ? styles.statWarn : ''}`}
                title={meta?.dir}
              >
                存储：{storageLabel}
              </span>
              <span className={styles.metaItem}>·</span>
              <span className={styles.metaItem}>
                占用 {fmtBytes(meta?.totalBytes || 0)} · 文件 {files} 个
              </span>
              {meta?.written ? (
                <>
                  <span className={styles.metaItem}>·</span>
                  <span className={styles.metaItem}>已写入 {meta.written}</span>
                </>
              ) : null}
              {meta?.dropped ? (
                <>
                  <span className={styles.metaItem}>·</span>
                  <span className={`${styles.metaItem} ${styles.statError}`}>丢弃 {meta.dropped}</span>
                </>
              ) : null}
              {meta?.lastError ? (
                <>
                  <span className={styles.metaItem}>·</span>
                  <span className={`${styles.metaItem} ${styles.statError}`} title={meta.lastError}>
                    存储错误：{meta.lastError}
                  </span>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {isMobile ? (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="筛选访问日志"
          placement="right"
          width={Math.min(360, typeof window === 'undefined' ? 360 : window.innerWidth - 32)}
          styles={{ body: { padding: 16 } }}
          footer={
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <Button onClick={resetFilters}>重置</Button>
              <Button type="primary" onClick={() => setDrawerOpen(false)}>
                完成
              </Button>
            </div>
          }
        >
          <div className={styles.drawerFilters} style={vars}>
            {filterFields(true)}
          </div>
        </Drawer>
      ) : null}

      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="访问日志详情"
        placement={isMobile ? 'bottom' : 'right'}
        width={isMobile ? '100%' : 560}
        height={isMobile ? '100%' : undefined}
        styles={{
          body: { padding: isMobile ? 16 : 20 },
          footer: { padding: '10px 16px' },
        }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button icon={<CopyOutlined />} onClick={copyDetail}>
              复制 JSON
            </Button>
            <Button type="primary" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
        }
      >
        {detail ? (
          <div style={vars}>
            <Descriptions size="small" column={1} bordered items={detailItems} />
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
