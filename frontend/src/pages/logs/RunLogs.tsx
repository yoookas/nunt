import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  App,
  Button,
  Descriptions,
  Input,
  Modal,
  Select,
  Switch,
  Tag,
  type TableColumnsType,
} from 'antd'
import {
  CheckCircleOutlined,
  ClearOutlined,
  CopyOutlined,
  DisconnectOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { DataTable, LevelTag, Muted, Toolbar, modalWidth, useIsMobile } from '../../components'
import { copyText } from '../../clipboard'
import { fmtTime } from '../../format'
import { VirtualList, type VirtualListHandle } from './VirtualList'
import { useLogThemeVars } from './theme'
import styles from './Logs.module.css'
import {
  LEVEL_OPTIONS,
  LEVEL_RANK,
  MAX_LOG_ENTRIES,
  attrEntries,
  attrsText,
  componentOf,
  logHaystack,
  logSignature,
  normalizeLog,
  shortTime,
  type LogEntry,
} from './types'

/**
 * The backend registers one SSE stream for every event type at
 * /api/v1/events (internal/api/events.go); /api/v1/system/logs is a one-shot
 * backlog endpoint, not a stream. Log records arrive as envelopes shaped
 * `{type:"log", data:{time, level, msg, attrs}}`. The server replays its
 * recent backlog on every new connection, including the automatic one
 * EventSource makes after a drop, so duplicate fingerprints are dropped.
 */
const STREAM_URL = '/api/v1/events'
const FLUSH_MS = 180

type Status = 'connecting' | 'open' | 'reconnecting' | 'error'

type ScrollAction = { type: 'top' } | { type: 'by'; delta: number }

const STATUS_META: Record<Status, { color: string; label: string; icon: ReactNode }> = {
  connecting: { color: 'processing', label: '正在连接', icon: <SyncOutlined spin /> },
  open: { color: 'success', label: '实时更新', icon: <CheckCircleOutlined /> },
  reconnecting: { color: 'warning', label: '正在重连', icon: <SyncOutlined spin /> },
  error: { color: 'error', label: '连接已断开', icon: <DisconnectOutlined /> },
}

interface AttrRow {
  key: string
  name: string
  value: string
}

function trimSeen(seen: Set<string>): void {
  if (seen.size <= MAX_LOG_ENTRIES * 2) return
  let remove = seen.size - MAX_LOG_ENTRIES
  for (const key of seen) {
    if (remove <= 0) break
    seen.delete(key)
    remove -= 1
  }
}

function messageClass(level: string): string {
  const name = level.toLowerCase()
  if (name.startsWith('err') || name === 'fatal') return styles.msgError
  if (name.startsWith('warn')) return styles.msgWarn
  if (name.startsWith('deb')) return styles.msgDebug
  return ''
}

export default function RunLogs() {
  const { message } = App.useApp()
  const messageRef = useRef(message)
  messageRef.current = message

  const isMobile = useIsMobile()
  const vars = useLogThemeVars()
  const rowHeight = isMobile ? 34 : 30
  const rowHeightRef = useRef(rowHeight)
  rowHeightRef.current = rowHeight

  const [entries, setEntries] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [keyword, setKeyword] = useState('')
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>('connecting')
  const [streamError, setStreamError] = useState('')
  const [detail, setDetail] = useState<LogEntry | null>(null)

  const listRef = useRef<VirtualListHandle | null>(null)
  const sourceRef = useRef<EventSource | null>(null)
  const pausedRef = useRef(false)
  const autoScrollRef = useRef(true)
  const seenRef = useRef(new Set<string>())
  const seqRef = useRef(0)
  const droppedRef = useRef(0)
  const bufferRef = useRef<LogEntry[]>([])
  const flushTimerRef = useRef<number | null>(null)
  const scrollActionRef = useRef<ScrollAction | null>(null)
  const filtersRef = useRef({ level, keyword })
  filtersRef.current = { level, keyword }

  const flush = useCallback(() => {
    flushTimerRef.current = null
    const buffered = bufferRef.current
    if (!buffered.length) return
    bufferRef.current = []
    // The buffer is arrival order; the list renders newest first.
    const batch = buffered.slice().reverse()

    if (autoScrollRef.current) {
      scrollActionRef.current = { type: 'top' }
    } else {
      // Only rows that survive the active filters move the list; otherwise a
      // filtered view would jump for logs the user cannot see.
      const active = filtersRef.current
      const minRank = active.level ? LEVEL_RANK[active.level] || 0 : 0
      const needle = active.keyword.trim().toLowerCase()
      let added = 0
      for (const item of batch) {
        if (minRank && (LEVEL_RANK[item.level] || 20) < minRank) continue
        if (needle && !logHaystack(item).includes(needle)) continue
        added += 1
      }
      if (added > 0) {
        const previous = scrollActionRef.current
        const delta = added * rowHeightRef.current
        scrollActionRef.current = {
          type: 'by',
          delta: (previous?.type === 'by' ? previous.delta : 0) + delta,
        }
      }
    }

    setEntries((prev) => {
      const next = batch.concat(prev)
      return next.length > MAX_LOG_ENTRIES ? next.slice(0, MAX_LOG_ENTRIES) : next
    })
    setLoading(false)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      flush()
    }, FLUSH_MS)
  }, [flush])

  const pushEntry = useCallback(
    (input: unknown) => {
      const item = normalizeLog(input)
      if (!item) return
      // Pausing drops events instead of buffering them: resuming shows only
      // what happens after the click, matching the connection staying open.
      if (pausedRef.current) {
        droppedRef.current += 1
        return
      }
      const signature = logSignature(item)
      if (seenRef.current.has(signature)) return
      seenRef.current.add(signature)
      trimSeen(seenRef.current)

      seqRef.current += 1
      bufferRef.current.push({ ...item, key: seqRef.current })
      scheduleFlush()
    },
    [scheduleFlush],
  )

  const closeSource = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close()
      sourceRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    closeSource()
    setStreamError('')
    setStatus('connecting')
    setLoading(true)

    if (typeof EventSource === 'undefined') {
      setStatus('error')
      setLoading(false)
      setStreamError('当前浏览器不支持 EventSource，无法接收实时日志')
      return
    }

    let source: EventSource
    try {
      source = new EventSource(STREAM_URL)
    } catch (err) {
      setStatus('error')
      setLoading(false)
      setStreamError((err as Error)?.message || '无法建立事件流连接')
      return
    }
    sourceRef.current = source

    source.onopen = () => {
      if (sourceRef.current !== source) return
      setStatus('open')
      setStreamError('')
      setLoading(false)
    }

    source.onerror = () => {
      if (sourceRef.current !== source) return
      setLoading(false)
      if (source.readyState === 2) {
        setStatus('error')
        setStreamError('事件流已关闭：请检查登录状态、服务端连接数上限或反向代理的 SSE 配置')
      } else {
        setStatus('reconnecting')
        setStreamError('事件流中断，浏览器正在自动重连…')
      }
    }

    source.onmessage = (event) => {
      if (sourceRef.current !== source) return
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (!payload || typeof payload !== 'object') return
      const envelope = payload as { type?: string; data?: unknown }
      if (envelope.type !== 'log') return
      pushEntry(envelope.data)
    }
  }, [closeSource, pushEntry])

  useEffect(() => {
    connect()
    return () => {
      closeSource()
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      bufferRef.current = []
    }
  }, [closeSource, connect])

  // Keep the view pinned to the top after a batch, or hold the reading
  // position when the user scrolled away / turned following off.
  useLayoutEffect(() => {
    const action = scrollActionRef.current
    scrollActionRef.current = null
    if (!action) return
    if (action.type === 'top') listRef.current?.scrollToTop()
    else listRef.current?.scrollBy(action.delta)
  }, [entries])

  useEffect(() => {
    if (autoScrollRef.current) listRef.current?.scrollToTop()
  }, [level, keyword])

  const filtered = useMemo(() => {
    const minRank = level ? LEVEL_RANK[level] || 0 : 0
    const needle = keyword.trim().toLowerCase()
    if (!minRank && !needle) return entries
    return entries.filter((item) => {
      if (minRank && (LEVEL_RANK[item.level] || 20) < minRank) return false
      if (needle && !logHaystack(item).includes(needle)) return false
      return true
    })
  }, [entries, level, keyword])

  const counter = level || keyword.trim() ? `${filtered.length} / ${entries.length} 条` : `${entries.length} 条`

  const togglePause = () => {
    if (!pausedRef.current) {
      pausedRef.current = true
      setPaused(true)
      // Drop the already buffered batch so the frozen view really stops.
      bufferRef.current = []
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      messageRef.current.info('已暂停接收新日志，SSE 连接保持')
      return
    }
    pausedRef.current = false
    setPaused(false)
    const skipped = droppedRef.current
    droppedRef.current = 0
    messageRef.current.success(
      skipped ? `已恢复接收（暂停期间的 ${skipped} 条日志不会补发）` : '已恢复接收',
    )
  }

  const clearView = () => {
    bufferRef.current = []
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    scrollActionRef.current = null
    droppedRef.current = 0
    setEntries([])
    setLoading(false)
    listRef.current?.scrollToTop()
    // Fingerprints stay: a reconnect replays the same backlog, and it must not
    // refill the view that was just cleared.
    messageRef.current.info('已清屏（仅清空当前视图，不影响服务端日志）')
  }

  const reconnect = () => {
    connect()
    messageRef.current.info('正在重新连接事件流…')
  }

  const changeAutoScroll = (value: boolean) => {
    autoScrollRef.current = value
    setAutoScroll(value)
    if (value) listRef.current?.scrollToTop()
  }

  const handleAtTop = useCallback((atTop: boolean) => {
    if (atTop) {
      if (!autoScrollRef.current) {
        autoScrollRef.current = true
        setAutoScroll(true)
      }
    } else if (autoScrollRef.current) {
      autoScrollRef.current = false
      setAutoScroll(false)
    }
  }, [])

  const copyDetail = () => {
    if (!detail) return
    const payload = {
      time: detail.time,
      level: detail.level,
      msg: detail.msg,
      attrs: detail.attrs ?? {},
    }
    if (copyText(JSON.stringify(payload, null, 2))) messageRef.current.success('已复制 JSON')
    else messageRef.current.error('复制失败，请手动选择文本')
  }

  const detailAttrs = useMemo<AttrRow[]>(() => {
    if (!detail) return []
    return attrEntries(detail.attrs).map(([name, value], index) => ({
      key: `${index}:${name}`,
      name,
      value,
    }))
  }, [detail])

  const attrColumns: TableColumnsType<AttrRow> = [
    {
      title: '字段',
      dataIndex: 'name',
      width: 150,
      render: (value: string) => <span className={`${styles.mono} ${styles.muted}`}>{value}</span>,
    },
    {
      title: '值',
      dataIndex: 'value',
      render: (value: string) => <span className={styles.detailMono}>{value || '""'}</span>,
    },
  ]

  const template = isMobile ? '64px 68px minmax(0,1fr)' : '148px 72px 130px minmax(0,1fr)'

  const header = (
    <div className={`${styles.grid} ${styles.gridHead}`} style={{ gridTemplateColumns: template }}>
      <span className={styles.line}>时间</span>
      <span className={styles.line}>级别</span>
      {!isMobile ? <span className={styles.line}>组件</span> : null}
      <span className={styles.line}>内容</span>
    </div>
  )

  const renderRow = (item: LogEntry) => {
    const component = componentOf(item.attrs)
    const attrs = attrsText(item.attrs)
    const title =
      `${fmtTime(item.time)}  ${item.level.toUpperCase()}  ${component || '-'}  ${item.msg}${attrs}`.trim()
    return (
      <div
        className={`${styles.grid} ${styles.gridRow} ${styles.clickable}`}
        style={{ gridTemplateColumns: template }}
        role="button"
        tabIndex={0}
        title={title}
        onClick={() => setDetail(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setDetail(item)
          }
        }}
      >
        <span className={`${styles.line} ${styles.mono} ${styles.muted}`}>
          {isMobile ? shortTime(item.time) : fmtTime(item.time)}
        </span>
        <span className={styles.line}>
          <LevelTag level={item.level} />
        </span>
        {!isMobile ? (
          <span className={`${styles.line} ${styles.mono} ${styles.muted}`}>{component || '-'}</span>
        ) : null}
        <span className={`${styles.line} ${styles.mono} ${messageClass(item.level)}`}>
          {item.msg || '(空消息)'}
          {attrs ? <span className={styles.muted}>{attrs}</span> : null}
        </span>
      </div>
    )
  }

  const meta = STATUS_META[status]

  const actions = (
    <>
      <Tag color={meta.color} icon={meta.icon}>
        {meta.label}
      </Tag>
      <Button
        size="small"
        icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
        onClick={togglePause}
      >
        {paused ? '继续' : '暂停'}
      </Button>
      <Button size="small" icon={<ClearOutlined />} onClick={clearView}>
        清屏
      </Button>
      <Button size="small" icon={<ReloadOutlined />} onClick={reconnect}>
        重连
      </Button>
      <span className={styles.counter}>{counter}</span>
      <span className={styles.switchLabel}>
        <Switch
          size="small"
          checked={autoScroll}
          onChange={changeAutoScroll}
          aria-label="自动滚动"
        />
        自动滚动
      </span>
    </>
  )

  return (
    <div className={styles.pane}>
      {streamError ? (
        <div
          className={`${styles.notice} ${status === 'error' ? styles.noticeError : styles.noticeWarn}`}
          role="alert"
        >
          <WarningOutlined className={styles.noticeIcon} />
          <span>{streamError}</span>
        </div>
      ) : null}
      {paused ? (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <PauseCircleOutlined className={styles.noticeIcon} />
          <span>已暂停接收新日志；SSE 连接仍保持，继续后只接收之后产生的新日志。</span>
        </div>
      ) : null}

      <div className={styles.panel}>
        {isMobile ? (
          <div className={styles.mobileBar}>
            <div className={styles.mobileFilters}>
              <Select
                size="small"
                value={level}
                onChange={setLevel}
                options={LEVEL_OPTIONS}
                style={{ width: 118 }}
                aria-label="日志级别"
              />
              <Input
                size="small"
                allowClear
                prefix={<SearchOutlined />}
                placeholder="按关键字过滤…"
                aria-label="关键字"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div className={styles.actionScroller}>{actions}</div>
          </div>
        ) : (
          <div className={styles.toolbar}>
            <Toolbar>
              <Select
                size="small"
                value={level}
                onChange={setLevel}
                options={LEVEL_OPTIONS}
                style={{ width: 132 }}
                aria-label="日志级别"
              />
              <Input
                size="small"
                allowClear
                prefix={<SearchOutlined />}
                placeholder="按关键字过滤…"
                aria-label="关键字"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                style={{ width: 240 }}
              />
            </Toolbar>
            <div className={styles.toolbarEnd}>{actions}</div>
          </div>
        )}

        <div className={styles.tableArea}>
          <VirtualList<LogEntry>
            ref={listRef}
            items={filtered}
            rowHeight={rowHeight}
            header={header}
            headerHeight={rowHeight}
            contentMinWidth={isMobile ? 320 : 640}
            ariaLabel="实时运行日志"
            rowKey={(item) => String(item.key)}
            renderRow={renderRow}
            onAtTopChange={handleAtTop}
            loading={loading}
            empty={
              loading
                ? '正在连接事件流…'
                : entries.length
                  ? '没有匹配的日志，换个级别或关键字试试'
                  : status === 'error'
                    ? '事件流未连接，请点击「重连」'
                    : '暂无日志，新日志会实时出现在这里'
            }
          />
        </div>

        <div className={styles.metaLine}>
          <span className={styles.metaItem}>
            {isMobile ? '上限' : '最多保留'} {MAX_LOG_ENTRIES} 条
          </span>
          <span className={styles.metaItem}>·</span>
          <span className={styles.metaItem}>
            {isMobile ? '顶部跟随 · 清屏仅本地' : '新日志在上；滚回顶部后恢复跟随'}
          </span>
          {!isMobile ? (
            <>
              <span className={styles.metaItem}>·</span>
              <span className={styles.metaItem}>清屏只影响当前页面</span>
            </>
          ) : null}
        </div>
      </div>

      <Modal
        open={detail !== null}
        onCancel={() => setDetail(null)}
        title="运行日志详情"
        width={modalWidth(false)}
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
          <div className={styles.modalBody} style={vars}>
            <Descriptions
              size="small"
              column={1}
              bordered
              items={[
                { key: 'time', label: '时间', children: fmtTime(detail.time) },
                { key: 'level', label: '级别', children: <LevelTag level={detail.level} /> },
                { key: 'component', label: '组件', children: componentOf(detail.attrs) || '-' },
                {
                  key: 'msg',
                  label: '消息',
                  children: <div className={styles.detailValue}>{detail.msg || '(空消息)'}</div>,
                },
                {
                  key: 'rawTime',
                  label: '原始时间',
                  children: <span className={styles.detailMono}>{detail.time || '-'}</span>,
                },
              ]}
            />
            <span className={styles.sectionTitle}>结构化字段</span>
            {detailAttrs.length ? (
              <DataTable<AttrRow>
                rowKey="key"
                columns={attrColumns}
                dataSource={detailAttrs}
                pagination={false}
                tableLayout="fixed"
                scroll={{ y: Math.min(240, detailAttrs.length * 40 + 40) }}
                locale={{ emptyText: '没有额外字段' }}
              />
            ) : (
              <Muted>这条日志没有额外字段。</Muted>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
