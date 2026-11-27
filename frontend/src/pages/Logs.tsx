import { useState, type CSSProperties } from 'react'
import { Tabs } from 'antd'
import AccessLogs from './logs/AccessLogs'
import RunLogs from './logs/RunLogs'
import { useLogThemeVars } from './logs/theme'
import styles from './logs/Logs.module.css'
import { useIsMobile } from '../components'
import { useContentViewport } from '../components/useContentViewport'

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

export default function Logs() {
  const [tab, setTab] = useState('run')
  const vars = useLogThemeVars()
  const isMobile = useIsMobile()
  const fallback = isMobile ? 'calc(100dvh - 60px - 24px)' : 'calc(100dvh - 60px - 48px)'
  const { pageRef, height } = useContentViewport(fallback)

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
