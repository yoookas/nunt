import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  type UIEvent,
} from 'react'
import { Spin } from 'antd'
import styles from './Logs.module.css'

export interface VirtualListHandle {
  scrollToTop: () => void
  scrollBy: (delta: number) => void
  getScrollTop: () => number
}

export interface VirtualListProps<T> {
  items: T[]
  rowHeight: number
  header: ReactNode
  headerHeight: number
  contentMinWidth?: number
  ariaLabel: string
  rowKey: (item: T, index: number) => string
  renderRow: (item: T, index: number) => ReactNode
  /** Called when the viewport nears the bottom (infinite loading). */
  onReachEnd?: () => void
  /** Called only when the user (or a scroll) crosses the top threshold. */
  onAtTopChange?: (atTop: boolean) => void
  empty?: ReactNode
  loading?: boolean
  /** Scroll back to the top whenever this value changes. */
  resetKey?: unknown
  overscan?: number
}

const NEAR_END_PX = 240
const AT_TOP_PX = 8
const END_THROTTLE_MS = 400

function VirtualListInner<T>(props: VirtualListProps<T>, ref: ForwardedRef<VirtualListHandle>) {
  const {
    items,
    rowHeight,
    header,
    headerHeight,
    contentMinWidth,
    ariaLabel,
    rowKey,
    renderRow,
    onReachEnd,
    onAtTopChange,
    empty,
    loading,
    resetKey,
    overscan = 6,
  } = props

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingTopRef = useRef(0)
  const lastEndRef = useRef(0)
  const atTopRef = useRef(true)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [overflowX, setOverflowX] = useState(false)
  const [atStartX, setAtStartX] = useState(true)
  const [atEndX, setAtEndX] = useState(true)

  const endCb = useRef(onReachEnd)
  endCb.current = onReachEnd
  const topCb = useRef(onAtTopChange)
  topCb.current = onAtTopChange

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setViewport(el.clientHeight)
    const maxLeft = el.scrollWidth - el.clientWidth
    setOverflowX(maxLeft > 2)
    setAtStartX(el.scrollLeft <= 2)
    setAtEndX(el.scrollLeft >= maxLeft - 2)
  }, [])

  useEffect(() => {
    measure()
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [measure])

  // Content width/height can change without the viewport resizing.
  useEffect(() => {
    measure()
  }, [measure, items.length, rowHeight, headerHeight])

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    },
    [],
  )

  const cancelPendingFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const notifyEnd = useCallback(() => {
    const now = Date.now()
    if (now - lastEndRef.current < END_THROTTLE_MS) return
    lastEndRef.current = now
    endCb.current?.()
  }, [])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    pendingTopRef.current = el.scrollTop

    const maxLeft = el.scrollWidth - el.clientWidth
    const nextOverflow = maxLeft > 2
    setOverflowX((prev) => (prev === nextOverflow ? prev : nextOverflow))
    const nextAtStart = el.scrollLeft <= 2
    setAtStartX((prev) => (prev === nextAtStart ? prev : nextAtStart))
    const nextAtEnd = el.scrollLeft >= maxLeft - 2
    setAtEndX((prev) => (prev === nextAtEnd ? prev : nextAtEnd))

    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setScrollTop(pendingTopRef.current)
        const atTop = pendingTopRef.current <= AT_TOP_PX
        if (atTop !== atTopRef.current) {
          atTopRef.current = atTop
          topCb.current?.(atTop)
        }
        if (
          el.scrollHeight > el.clientHeight + rowHeight &&
          el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_END_PX
        ) {
          notifyEnd()
        }
      })
    }
  }

  // On mount, after a filter change, or after appending a page that still
  // leaves the list shorter than the viewport, keep asking for the next page.
  useEffect(() => {
    if (!items.length) return
    const timer = window.setTimeout(() => {
      const el = scrollRef.current
      if (!el) return
      if (el.scrollHeight > 0 && el.scrollHeight <= el.clientHeight + rowHeight) {
        // Bypass the scroll throttle: a list shorter than its viewport cannot
        // scroll again to ask for the next page.
        endCb.current?.()
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [items.length, rowHeight, viewport, notifyEnd])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    cancelPendingFrame()
    pendingTopRef.current = 0
    el.scrollTop = 0
    setScrollTop(0)
    if (!atTopRef.current) {
      atTopRef.current = true
      topCb.current?.(true)
    }
  }, [cancelPendingFrame, resetKey])

  useImperativeHandle(
    ref,
    () => ({
      scrollToTop: () => {
        const el = scrollRef.current
        if (!el) return
        cancelPendingFrame()
        pendingTopRef.current = 0
        el.scrollTop = 0
        setScrollTop(0)
        if (!atTopRef.current) {
          atTopRef.current = true
          topCb.current?.(true)
        }
      },
      scrollBy: (delta: number) => {
        const el = scrollRef.current
        if (!el || !delta) return
        cancelPendingFrame()
        el.scrollTop += delta
        pendingTopRef.current = el.scrollTop
        setScrollTop(el.scrollTop)
      },
      getScrollTop: () => scrollRef.current?.scrollTop ?? 0,
    }),
    [cancelPendingFrame],
  )

  const bodyHeight = items.length * rowHeight
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight) - overscan)
  const visibleCount = Math.max(1, Math.ceil((viewport + headerHeight) / rowHeight) + overscan * 2)
  const end = Math.min(items.length, start + visibleCount)
  const visible = items.slice(start, end)

  return (
    <div className={styles.vScrollWrap}>
      <div
        ref={scrollRef}
        className={styles.vScroll}
        onScroll={handleScroll}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
      >
        <div ref={contentRef} className={styles.vContent} style={{ minWidth: contentMinWidth }}>
          <div className={styles.vHeader} style={{ height: headerHeight }}>
            {header}
          </div>
          <div className={styles.vBody} style={{ height: bodyHeight }}>
            {visible.map((item, offset) => {
              const index = start + offset
              return (
                <div
                  key={rowKey(item, index)}
                  className={styles.vRow}
                  style={{ top: index * rowHeight, height: rowHeight }}
                >
                  {renderRow(item, index)}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className={styles.vEmpty} style={{ top: headerHeight }} aria-live="polite">
          {loading ? <Spin size="small" /> : null}
          {empty}
        </div>
      ) : null}

      {overflowX && !atStartX ? <div className={`${styles.hFade} ${styles.hFadeLeft}`} /> : null}
      {overflowX && !atEndX ? <div className={`${styles.hFade} ${styles.hFadeRight}`} /> : null}
    </div>
  )
}

/**
 * A small windowed list: fixed-height rows and a sticky header inside one
 * scroll container (so horizontal scrolling keeps the header aligned too).
 */
export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<VirtualListHandle> },
) => ReactElement
