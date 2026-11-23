import { useEffect, useRef } from 'react'

/**
 * usePolling calls fn on an interval, skipping ticks while the tab is hidden
 * and catching up once when it becomes visible again.
 *
 * fn is kept in a ref, so callers can pass an inline closure without
 * re-creating the timer on every render. Failures are the caller's business:
 * a poll must not raise a toast every five seconds.
 */
export function usePolling(fn: () => unknown, intervalMs: number, enabled = true) {
  const saved = useRef(fn)
  saved.current = fn

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
        if (!document.hidden) void saved.current()
      }, intervalMs)
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        void saved.current()
        start()
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs])
}
