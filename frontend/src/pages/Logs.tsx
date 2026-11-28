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
  // Same as the web page: the three tabs are the page header, so the strip sits
  // flush under the app header and the content padding is cancelled on top.
  const pagePad = isMobile ? 12 : 24
  const fallback = `calc(100dvh - 60px - ${pagePad}px)`
  const { pageRef, height } = useContentViewport(fallback)
  const pageHeight = typeof height === 'number' ? height + pagePad : height

  return (
    <div
      ref={pageRef}
      className={styles.page}
      style={{ ...vars, height: pageHeight, marginTop: -pagePad }}
    >
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
            key: 'web',
            label: 'Web 访问',
            children: <AccessLogs active={tab === 'web'} source="web" />,
          },
          {
            key: 'forward',
            label: '端口转发',
            children: <AccessLogs active={tab === 'forward'} source="forward" />,
          },
        ]}
      />
    </div>
  )
}
