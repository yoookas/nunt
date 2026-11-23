import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollStatus {
  /** When the last successful poll finished, or null before the first one. */
  updatedAt: number | null
  failed: boolean
  /** Runs the polled function right away (the status indicator uses it). */
  refresh: () => Promise<void>
}

/**
 * usePolling calls fn on an interval, skipping ticks while the tab is hidden
 * and catching up once when it becomes visible again.
 *
 * fn is kept in a ref, so callers can pass an inline closure without
 * re-creating the timer on every render. Throwing marks the poll as failed
 * instead of raising a toast: an auto-refreshing page must not spam errors,
 * but it should say it is showing stale numbers.
 */
export function usePolling(fn: () => unknown, intervalMs: number, enabled = true): PollStatus {
  const saved = useRef(fn)
  saved.current = fn
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      await saved.current()
      setUpdatedAt(Date.now())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    const start = () => {
      stop()
      timer = window.setInterval(() => {
        if (!document.hidden) void refresh()
      }, intervalMs)
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        void refresh()
        start()
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs, refresh])

  return { updatedAt, failed, refresh }
}
