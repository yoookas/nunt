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
  const showExtraColumns = !isMobile && !!screens.xxl
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
  const [autoRefresh, setAutoRefresh] = useState(false)
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

  const handleAtTop = useCallback((atTop: boolean) => {
    atTopRef.current = atTop
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
    status !== 'all',
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

  const template = isMobile
    ? '62px 56px minmax(150px,1.6fr) 72px minmax(96px,1fr)'
    : showExtraColumns
      ? '140px 74px minmax(150px,1.1fr) minmax(220px,1.6fr) 150px minmax(140px,1fr) 72px 80px 86px'
      : '130px 70px minmax(140px,1.1fr) minmax(200px,1.6fr) 140px minmax(130px,1fr) 66px'

  const header = (
    <div className={`${styles.grid} ${styles.gridHead}`} style={{ gridTemplateColumns: template }}>
      <span className={styles.line}>时间</span>
      <span className={styles.line}>来源</span>
      {!isMobile ? <span className={styles.line}>站点 / 规则</span> : null}
      <span className={styles.line}>请求</span>
      <span className={styles.line}>状态 / 结果</span>
      <span className={styles.line}>客户端</span>
      {!isMobile ? <span className={styles.line}>耗时</span> : null}
      {showExtraColumns ? (
        <>
          <span className={styles.line}>大小</span>
          <span className={styles.line}>请求 ID</span>
        </>
      ) : null}
    </div>
  )

  const renderRow = (row: AccessRow) => {
    const geo = geoText(row)
    const size = bytesText(row)
    const waf = row.wafAction
      ? `WAF ${row.wafAction}${row.wafRuleId ? ` #${row.wafRuleId}` : ''}`
      : ''
    const verdict = [row.reason, row.error, waf].filter(Boolean).join(' · ')
    const verdictClass = row.error ? styles.dangerText : styles.warnText
    const ruleSub = [row.host, row.listen, row.proto || row.protocol, row.tls]
      .filter(Boolean)
      .join(' · ')
    const requestMain =
      row.source === 'forward'
        ? `${row.listen || '-'} → ${row.upstream || '-'}`
        : `${row.method || '-'} ${row.path || '-'}`
    const requestSub = isMobile
      ? row.rule || row.host || row.userAgent || row.message || ''
      : row.source === 'forward'
        ? [
            row.bytesIn ? `↑ ${fmtBytes(row.bytesIn)}` : '',
            row.bytesOut ? `↓ ${fmtBytes(row.bytesOut)}` : '',
          ]
            .filter(Boolean)
            .join(' ')
        : row.userAgent || row.message || ''
    const sizeTitle =
      row.bytesIn || row.bytesOut
        ? `请求 ${fmtBytes(row.bytesIn ?? 0)} · 响应 ${fmtBytes(row.bytesOut ?? 0)}`
        : undefined

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
        <span className={`${styles.line} ${styles.mono} ${styles.muted}`} title={fullTime(row.time)}>
          {isMobile ? shortTime(row.time) : fullTime(row.time)}
        </span>
        <span className={styles.line}>
          <SourceTag source={row.source} />
        </span>
        {!isMobile ? (
          <div className={styles.stack} title={[row.rule || row.ruleId, ruleSub].filter(Boolean).join(' · ')}>
            <span className={styles.line}>{row.rule || row.ruleId || '-'}</span>
            <span className={`${styles.line} ${styles.tiny}`}>{ruleSub || '-'}</span>
          </div>
        ) : null}
        <div className={styles.stack} title={`${requestMain}${requestSub ? ` · ${requestSub}` : ''}`}>
          <span className={`${styles.line} ${styles.mono}`}>{requestMain}</span>
          {requestSub ? <span className={`${styles.line} ${styles.tiny}`}>{requestSub}</span> : null}
        </div>
        <div className={styles.stack} title={verdict || undefined}>
          {row.status ? (
            <span className={styles.line}>
              <StatusTag status={row.status} />
            </span>
          ) : (
            <span className={`${styles.line} ${styles.tiny}`}>{row.result || '-'}</span>
          )}
          {verdict ? (
            <span className={`${styles.line} ${styles.tiny} ${verdictClass}`}>{verdict}</span>
          ) : null}
        </div>
        <div className={styles.stack} title={[row.clientIp, geo].filter(Boolean).join(' · ')}>
          <span className={`${styles.line} ${styles.mono}`}>{row.clientIp || '-'}</span>
          {geo ? <span className={`${styles.line} ${styles.tiny}`}>{geo}</span> : null}
        </div>
        {!isMobile ? (
          <span className={`${styles.line} ${styles.muted}`}>{durationText(row.durationMs)}</span>
        ) : null}
        {showExtraColumns ? (
          <>
            <span className={`${styles.line} ${styles.muted}`} title={sizeTitle}>
              {size}
            </span>
            <span
              className={`${styles.line} ${styles.mono} ${styles.muted}`}
              title={row.requestId || undefined}
            >
              {row.requestId ? row.requestId.slice(0, 8) : '-'}
            </span>
          </>
        ) : null}
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
        {field(
          '状态',
          <Select
            size={size}
            value={status}
            onChange={setStatus}
            options={STATUSES}
            style={width(148)}
            aria-label="状态"
          />,
        )}
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
            placeholder="路径 / 域名 / UA"
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
      <Tooltip title="每 10 秒刷新统计；在列表顶部时同时刷新列表">
        <span className={styles.switchLabel}>
          <Switch
            size="small"
            checked={autoRefresh}
            onChange={setAutoRefresh}
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

  const detailItems: DescriptionsProps['items'] = detail
    ? [
        { key: 'time', label: '时间', children: fullTime(detail.time) },
        { key: 'source', label: '来源', children: <SourceTag source={detail.source} /> },
        { key: 'rule', label: '站点 / 规则', children: detail.rule || detail.ruleId || '-' },
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
          label: '耗时',
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
      ]
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
            rowHeight={58}
            header={header}
            headerHeight={isMobile ? 38 : 40}
            contentMinWidth={isMobile ? 540 : showExtraColumns ? 1180 : 960}
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
