import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Height of the usable content area of the shell.
 *
 * The shell renders a sticky 60px header, a padded scrolling `Content` element
 * and an auto-height max-width wrapper, so `height: 100%` does not resolve inside
 * a page. A page that must fill the window and scroll its own panes measures the
 * real viewport instead: its top is below the header, and the Content padding is
 * subtracted from the bottom. `fallback` covers the first paint, before the
 * effect has measured anything.
 */
export function useContentViewport(fallback: string) {
  const pageRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const page = pageRef.current
    const content = page?.closest('.ant-layout-content') as HTMLElement | null
    if (!content) return
    const measure = () => {
      const style = getComputedStyle(content)
      const padTop = Number.parseFloat(style.paddingTop) || 0
      const padBottom = Number.parseFloat(style.paddingBottom) || 0
      const top = content.getBoundingClientRect().top
      const available = Math.floor(window.innerHeight - top - padTop - padBottom)
      setHeight(available > 0 ? available : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [])

  return { pageRef, height: height === null ? fallback : height }
}
