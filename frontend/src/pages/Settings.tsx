import { useState, type ReactNode } from 'react'
import { Alert, Button, Tabs, Typography } from 'antd'
import {
  CloudDownloadOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ImportOutlined,
} from '@ant-design/icons'
import { PageHeader, useIsMobile } from '../components'
import AboutPanel from './settings/AboutPanel'
import BackupPanel from './settings/BackupPanel'
import ConfigPanel from './settings/ConfigPanel'
import LogsPanel from './settings/LogsPanel'
import SecurityPanel from './settings/SecurityPanel'
import SessionsPanel from './settings/SessionsPanel'
import SystemPanel from './settings/SystemPanel'

function tabLabel(icon: ReactNode, text: string) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {icon}
      {text}
    </span>
  )
}

export default function Settings() {
  const isMobile = useIsMobile()
  const [tab, setTab] = useState('system')
  const [refreshToken, setRefreshToken] = useState(0)
  const [moved, setMoved] = useState<{ addr: string; url: string } | null>(null)

  const onListenMoved = (target: { addr: string; url: string }) => {
    setMoved(target)
  }

  return (
    <div>
      <PageHeader
        title="设置"
        subtitle="系统参数、日志、双因子、会话、备份与配置导入导出"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            刷新
          </Button>
        }
      />

      {moved ? (
        <Alert
          type="success"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={`管理后台监听地址已切换为 ${moved.addr || '新地址'}`}
          description={
            <span>
              当前页面仍连接在旧地址上，继续操作可能失败。
              {moved.url ? (
                <>
                  {' '}
                  <Typography.Link href={moved.url} target="_blank" rel="noopener noreferrer">
                    用新地址打开
                  </Typography.Link>
                </>
              ) : null}
            </span>
          }
          onClose={() => setMoved(null)}
        />
      ) : null}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        tabPosition={isMobile ? 'top' : 'left'}
        size={isMobile ? 'small' : 'middle'}
        items={[
          {
            key: 'system',
            label: tabLabel(<SettingOutlined />, '系统'),
            children: <SystemPanel refreshToken={refreshToken} onListenMoved={onListenMoved} />,
          },
          {
            key: 'logs',
            label: tabLabel(<FileTextOutlined />, '日志'),
            children: <LogsPanel refreshToken={refreshToken} />,
          },
          {
            key: 'security',
            label: tabLabel(<SafetyCertificateOutlined />, '安全'),
            children: <SecurityPanel refreshToken={refreshToken} />,
          },
          {
            key: 'sessions',
            label: tabLabel(<TeamOutlined />, '会话'),
            children: <SessionsPanel refreshToken={refreshToken} />,
          },
          {
            key: 'backup',
            label: tabLabel(<CloudDownloadOutlined />, '备份'),
            children: <BackupPanel refreshToken={refreshToken} />,
          },
          {
            key: 'config',
            label: tabLabel(<ImportOutlined />, '配置'),
            children: (
              <ConfigPanel
                onChanged={() => setRefreshToken((value) => value + 1)}
                onListenMoved={onListenMoved}
              />
            ),
          },
          {
            key: 'about',
            label: tabLabel(<InfoCircleOutlined />, '关于'),
            children: <AboutPanel refreshToken={refreshToken} />,
          },
        ]}
        tabBarStyle={isMobile ? undefined : { minWidth: 132 }}
      />
    </div>
  )
}
