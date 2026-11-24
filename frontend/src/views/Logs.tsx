import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { Alert, Button, Tabs } from '@heroui/react'
import { Copy, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { copyText } from '../clipboard'
import { fmtTime } from '../format'
import AccessLogs from './AccessLogs'
import {
  FormModal,
  Page,
  PageHeader,
  Panel,
  SelectInput,
  StatusChip,
  SwitchInput,
  TextInput,
  toast,
  type SelectOption,
} from '../ui'

/* -------------------------------------------------------------------------
 * Constants & types
 * ---------------------------------------------------------------------- */

// The browser keeps a bounded window; older entries are dropped as new ones
// arrive so a long-running tab cannot grow without limit.
const MAX_ENTRIES = 1000

const LEVELS: SelectOption[] = [
  { value: 'all', label: '全部级别' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 }

type Status = 'connecting' | 'open' | 'reconnecting' | 'error'

interface RawLog {
  time: string | null
  level: string
  msg: string
  attrs: Record<string, unknown> | null
}

interface LogEntry extends RawLog {
  seq: number
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function normalizeLog(input: unknown): RawLog | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return { time: null, level: 'info', msg: input, attrs: null }
  if (typeof input !== 'object') return { time: null, level: 'info', msg: String(input), attrs: null }

  const entry = input as Record<string, unknown>
  const timeValue = entry.time ?? entry.timestamp ?? null
  const attrs =
    entry.attrs && typeof entry.attrs === 'object' && !Array.isArray(entry.attrs)
      ? (entry.attrs as Record<string, unknown>)
      : null

  return {
    time: timeValue === null || timeValue === undefined || timeValue === '' ? null : String(timeValue),
    level: String(entry.level ?? entry.lvl ?? 'info').toLowerCase(),
    msg: String(entry.msg ?? entry.message ?? ''),
    attrs,
  }
}

function attrsText(attrs: Record<string, unknown> | null): string {
  if (!attrs) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(attrs)) {
    // The component has its own column.
    if (key === 'component') continue
    let text: string
    if (value === null || value === undefined) text = ''
    else if (typeof value === 'object') {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    } else text = String(value)
    parts.push(`${key}=${text}`)
  }
  return parts.length ? `  ${parts.join('  ')}` : ''
}

// attrEntries flattens the attributes into displayable lines, skipping the
// component (it has its own field) and stringifying structured values.
function attrEntries(attrs: Record<string, unknown> | null): [string, string][] {
  if (!attrs) return []
  const out: [string, string][] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'component') continue
    let text: string
    if (value === null || value === undefined) text = ''
    else if (typeof value === 'object') {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    } else text = String(value)
    out.push([key, text])
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

async function copyLogJSON(item: LogEntry | null): Promise<void> {
  if (!item) return
  const text = JSON.stringify(
    { time: item.time, level: item.level, msg: item.msg, attrs: item.attrs ?? {} },
    null,
    2,
  )
  if (copyText(text)) {
    toast.success('已复制 JSON')
  } else {
    toast.danger('复制失败，请手动选择文本')
  }
}

function signature(item: RawLog): string {
  return `${item.time || ''}|${item.level}|${item.msg}`
}

function trimSeen(seen: Set<string>): void {
  if (seen.size <= MAX_ENTRIES * 2) return
  const remove = seen.size - MAX_ENTRIES
  let count = 0
  for (const key of seen) {
    if (count >= remove) break
    seen.delete(key)
    count += 1
  }
}

function levelColor(level: string): string {
  const name = String(level || '').toLowerCase()
  if (name.startsWith('err') || name === 'fatal') return 'text-danger'
  if (name.startsWith('warn')) return 'text-warning'
  if (name.startsWith('deb')) return 'text-muted'
  if (name.startsWith('info')) return 'text-accent'
  return 'text-foreground'
}

function statusMeta(status: Status): {
  color: 'default' | 'primary' | 'success' | 'warning' | 'danger'
  label: string
} {
  switch (status) {
    case 'open':
      return { color: 'success', label: '实时连接中' }
    case 'reconnecting':
      return { color: 'warning', label: '正在重连' }
    case 'error':
      return { color: 'danger', label: '连接已断开' }
    default:
      return { color: 'primary', label: '正在连接' }
  }
}

function Notice({
  status,
  children,
}: {
  status: 'accent' | 'danger' | 'default' | 'success' | 'warning'
  children: ReactNode
}) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

function RunLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [detail, setDetail] = useState<LogEntry | null>(null)
  const [keyword, setKeyword] = useState('')
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>('connecting')
  const [streamError, setStreamError] = useState('')

  const sourceRef = useRef<EventSource | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const scrollPendingRef = useRef(false)
  const pausedRef = useRef(false)
  const autoScrollRef = useRef(true)
  const seenRef = useRef(new Set<string>())
  const seqRef = useRef(0)
  const droppedRef = useRef(0)
  const entriesRef = useRef<LogEntry[]>([])

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const scrollToBottom = useCallback(() => {
    const view = listRef.current
    if (view) view.scrollTop = view.scrollHeight
  }, [])

  const scheduleScroll = useCallback(() => {
    if (scrollPendingRef.current) return
    scrollPendingRef.current = true
    frameRef.current = requestAnimationFrame(() => {
      scrollPendingRef.current = false
      frameRef.current = null
      if (autoScrollRef.current) scrollToBottom()
    })
  }, [scrollToBottom])

  const pushEntry = useCallback(
    (input: unknown) => {
      const item = normalizeLog(input)
      if (!item) return
      if (pausedRef.current) {
        // Pausing drops events on purpose instead of buffering them: resuming
        // only shows what happens after the click.
        droppedRef.current += 1
        return
      }
      const key = signature(item)
      if (seenRef.current.has(key)) return
      seenRef.current.add(key)

      const next: LogEntry = { ...item, seq: seqRef.current++ }
      setEntries((prev) => {
        const merged = prev.concat(next)
        return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
      })
      trimSeen(seenRef.current)
      setLoading(false)
      if (autoScrollRef.current) scheduleScroll()
    },
    [scheduleScroll],
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
    setLoading(entriesRef.current.length === 0)

    if (typeof EventSource === 'undefined') {
      setStatus('error')
      setLoading(false)
      setStreamError('当前浏览器不支持 EventSource，无法接收实时日志')
      return
    }

    let source: EventSource
    try {
      source = new EventSource('/api/v1/events')
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
      // 2 === EventSource.CLOSED; anything else means the browser will retry.
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
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      scrollPendingRef.current = false
    }
  }, [connect, closeSource])

  useEffect(() => {
    if (autoScrollRef.current) scheduleScroll()
  }, [entries.length, level, keyword, scheduleScroll])

  /* ---- filters ---- */

  const filtered = useMemo(() => {
    const min = level ? LEVEL_RANK[level] || 0 : 0
    const key = keyword.trim().toLowerCase()
    if (!min && !key) return entries
    return entries.filter((item) => {
      if (min && (LEVEL_RANK[item.level] || 20) < min) return false
      if (key && !`${item.msg} ${String(item.attrs?.component ?? '')} ${attrsText(item.attrs)}`.toLowerCase().includes(key)) return false
      return true
    })
  }, [entries, level, keyword])

  const visible = filtered
  const total = entries.length
  const matched = filtered.length
  const shown = visible.length
  const counter =
    matched === total
      ? shown === total
        ? `${total} 条`
        : `${shown} / ${total} 条`
      : `${shown} / ${matched} 条匹配（共 ${total} 条）`

  /* ---- actions ---- */

  const togglePause = () => {
    if (!pausedRef.current) {
      pausedRef.current = true
      setPaused(true)
      toast.info('已暂停接收新日志，SSE 连接保持')
      return
    }
    pausedRef.current = false
    setPaused(false)
    const skipped = droppedRef.current
    droppedRef.current = 0
    toast.success(skipped ? `已继续接收（暂停期间的 ${skipped} 条日志不会补发）` : '已继续接收')
    if (autoScrollRef.current) scheduleScroll()
  }

  const clearView = () => {
    setEntries([])
    entriesRef.current = []
    droppedRef.current = 0
    setLoading(false)
    // Keep the dedup fingerprints so an automatic SSE replay cannot refill the
    // view we just cleared.
    toast.info('已清屏（仅清空当前视图，不影响服务端日志）')
    if (listRef.current) listRef.current.scrollTop = 0
  }

  const reconnect = () => {
    connect()
    toast.info('正在重新连接事件流…')
  }

  const onAutoScrollChange = (value: boolean) => {
    autoScrollRef.current = value
    setAutoScroll(value)
    if (value) scrollToBottom()
  }

  const onViewScroll = (event: UIEvent<HTMLDivElement>) => {
    const view = event.currentTarget
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24
    if (nearBottom !== autoScrollRef.current) {
      autoScrollRef.current = nearBottom
      setAutoScroll(nearBottom)
      if (nearBottom) scrollToBottom()
    }
  }

  const meta = statusMeta(status)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip color={meta.color}>{meta.label}</StatusChip>
        <Button variant="secondary" onPress={reconnect}>
          <RefreshCw size={14} />
          重新连接
        </Button>
        <span className="text-xs text-muted">通过 SSE 实时接收，连接建立后先回放服务端最近 100 条历史</span>
      </div>

      <div className="space-y-5">
        {streamError ? (
          <Notice status={status === 'error' ? 'danger' : 'warning'}>{streamError}</Notice>
        ) : null}
        {paused ? (
          <Notice status="warning">
            已暂停接收新日志；SSE 连接仍保持，继续后只接收之后产生的新日志。
          </Notice>
        ) : null}

        <Panel title="运行日志" extra={<span className="text-xs text-muted">{counter}</span>}>
          <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
            <div className="w-full sm:w-40">
              <SelectInput
                label="日志级别"
                value={level || 'all'}
                onChange={(value) => setLevel(value === 'all' ? '' : value)}
                options={LEVELS}
              />
            </div>
            <div className="w-full sm:w-56">
              <TextInput
                label="关键字"
                value={keyword}
                onChange={setKeyword}
                placeholder="按关键字过滤…"
              />
            </div>
            <Button variant={paused ? 'primary' : 'secondary'} onPress={togglePause}>
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? '继续' : '暂停'}
            </Button>
            <Button variant="tertiary" onPress={clearView}>
              <Trash2 size={14} />
              清屏
            </Button>
            <div className="flex-1" />
            <SwitchInput label="自动滚动" value={autoScroll} onChange={onAutoScrollChange} />
          </div>

          <div
            ref={listRef}
            className="h-[min(62vh,560px)] overflow-auto bg-background-secondary"
            onScroll={onViewScroll}
            role="log"
            aria-live="off"
            aria-label="实时日志"
          >
            <div className="min-w-[640px]">
              <div className="sticky top-0 z-10 grid grid-cols-[150px_70px_120px_minmax(0,1fr)] gap-3 border-b border-border bg-surface px-4 py-2 text-xs font-medium text-muted">
                <span>时间</span>
                <span>级别</span>
                <span>组件</span>
                <span>内容</span>
              </div>

              {visible.map((item) => {
                const attrs = attrsText(item.attrs)
                return (
                  <div
                    key={item.seq}
                    role="button"
                    tabIndex={0}
                    title="点击查看结构化详情"
                    onClick={() => setDetail(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setDetail(item)
                      }
                    }}
                    className="grid cursor-pointer grid-cols-[150px_70px_120px_minmax(0,1fr)] gap-3 border-b border-border px-4 py-1.5 text-xs hover:bg-default/50 focus:bg-default/50 focus:outline-none"
                  >
                    <span className="text-muted">{fmtTime(item.time)}</span>
                    <span className={`mono font-semibold ${levelColor(item.level)}`}>
                      {String(item.level || 'info').toUpperCase()}
                    </span>
                    <span className="mono truncate text-muted" title={String(item.attrs?.component ?? '')}>
                      {String(item.attrs?.component ?? '-')}
                    </span>
                    <span className={`mono whitespace-pre-wrap break-words leading-5 ${levelColor(item.level)}`}>
                      {item.msg}
                      {attrs ? <span className="text-muted">{attrs}</span> : null}
                    </span>
                  </div>
                )
              })}

              {visible.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted">
                  {loading
                    ? '正在连接事件流…'
                    : entries.length
                      ? '没有匹配的日志，换个级别或关键字试试'
                      : '暂无日志，新日志会实时出现在这里'}
                </div>
              ) : null}
            </div>
          </div>

          <div className="border-t border-border p-3 text-xs leading-5 text-muted">
            日志窗口最多保留 {MAX_ENTRIES} 条；清屏只影响当前页面。SSE 中断后浏览器会自动重连，服务端回放的历史会按
            时间、级别与内容去重。
          </div>
        </Panel>
      </div>

      <FormModal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="日志详情"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={() => void copyLogJSON(detail)}>
              <Copy size={14} />
              复制 JSON
            </Button>
            <Button variant="tertiary" onPress={() => setDetail(null)}>
              关闭
            </Button>
          </div>
        }
      >
        {detail ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted">时间</dt>
              <dd className="mono">{fmtTime(detail.time)}</dd>
              <dt className="text-muted">级别</dt>
              <dd className={`mono font-semibold ${levelColor(detail.level)}`}>
                {String(detail.level || 'info').toUpperCase()}
              </dd>
              <dt className="text-muted">组件</dt>
              <dd className="mono">{String(detail.attrs?.component ?? '-')}</dd>
              <dt className="text-muted">内容</dt>
              <dd className="whitespace-pre-wrap break-words">{detail.msg}</dd>
            </dl>
            {attrEntries(detail.attrs).length ? (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[10rem_1fr] gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted">
                  <span>字段</span>
                  <span>值</span>
                </div>
                {attrEntries(detail.attrs).map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[10rem_1fr] gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="mono break-all text-muted">{key}</span>
                    <span className="mono whitespace-pre-wrap break-all">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted">这条日志没有额外字段。</div>
            )}
          </div>
        ) : null}
      </FormModal>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Page shell: run log (live) and access log (persisted) side by side.
 * ---------------------------------------------------------------------- */

export default function Logs() {
  const [tab, setTab] = useState('run')

  return (
    <Page>
      <PageHeader
        title="日志"
        sub="运行日志实时接收，访问日志落盘保留，可按来源、状态与关键字检索"
      />
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))} className="w-full">
        <Tabs.ListContainer>
          <Tabs.List aria-label="日志分类">
            <Tabs.Tab id="run">运行日志</Tabs.Tab>
            <Tabs.Tab id="access">访问日志</Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="run">
          <div className="pt-4">
            <RunLogs />
          </div>
        </Tabs.Panel>
        <Tabs.Panel id="access">
          <div className="pt-4">
            <AccessLogs />
          </div>
        </Tabs.Panel>
      </Tabs>
    </Page>
  )
}
