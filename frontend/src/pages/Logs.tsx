import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Tabs } from 'antd'
import AccessLogs from './logs/AccessLogs'
import RunLogs from './logs/RunLogs'
import { useLogThemeVars } from './logs/theme'
import styles from './logs/Logs.module.css'
import { useIsMobile } from '../components'

// The app header already renders the page title ("日志"); keep a heading for
// screen readers only instead of repeating it in the content area.
const hiddenTitle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

/**
 * The shell renders a sticky 60px header, a padded scrolling Content and an
 * auto-height max-width wrapper (`height:100%` no longer resolves here). The
 * page therefore measures the real content viewport: its top is below the
 * header, and the shell's Content padding is subtracted from the bottom.
 */
function useLogsViewportHeight(mobile: boolean) {
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
  }, [mobile])

  // Correct for the current shell even before the first measurement.
  const fallback = mobile ? 'calc(100dvh - 60px - 24px)' : 'calc(100dvh - 60px - 48px)'
  return { pageRef, height: height === null ? fallback : height }
}

export default function Logs() {
  const [tab, setTab] = useState('run')
  const vars = useLogThemeVars()
  const isMobile = useIsMobile()
  const { pageRef, height } = useLogsViewportHeight(isMobile)

  return (
    <div ref={pageRef} className={styles.page} style={{ ...vars, height }}>
      <h2 style={hiddenTitle}>日志</h2>
      <Tabs
        className={styles.tabs}
        activeKey={tab}
        onChange={setTab}
        animated={false}
        items={[
          {
            key: 'run',
            label: '运行日志',
            children: <RunLogs />,
          },
          {
            key: 'access',
            label: '访问日志',
            children: <AccessLogs active={tab === 'access'} />,
          },
        ]}
      />
    </div>
  )
}
