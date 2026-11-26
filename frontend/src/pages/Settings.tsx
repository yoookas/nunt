import { useState, type ReactNode } from 'react'
import { Alert, Button, Card, Menu, Typography, theme, type MenuProps } from 'antd'
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  FileTextOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Muted, useIsMobile } from '../components'
import AboutPanel from './settings/AboutPanel'
import BackupPanel from './settings/BackupPanel'
import ConfigPanel from './settings/ConfigPanel'
import LogsPanel from './settings/LogsPanel'
import SecurityPanel from './settings/SecurityPanel'
import SessionsPanel from './settings/SessionsPanel'
import SystemPanel from './settings/SystemPanel'

interface SectionDef {
  key: string
  title: string
  description: string
  icon: ReactNode
}

const SECTIONS: SectionDef[] = [
  {
    key: 'system',
    title: '系统',
    description: '监听地址、代理、会话与访问控制',
    icon: <SettingOutlined />,
  },
  {
    key: 'logs',
    title: '日志',
    description: '访问日志保留与运行日志轮转',
    icon: <FileTextOutlined />,
  },
  {
    key: 'security',
    title: '安全',
    description: '双因子认证与恢复码',
    icon: <SafetyCertificateOutlined />,
  },
  {
    key: 'sessions',
    title: '会话',
    description: '查看并踢出在线会话',
    icon: <TeamOutlined />,
  },
  {
    key: 'backup',
    title: '备份',
    description: '定时归档、下载与保留策略',
    icon: <CloudDownloadOutlined />,
  },
  {
    key: 'config',
    title: '配置',
    description: '导入、导出与重载配置',
    icon: <ImportOutlined />,
  },
  {
    key: 'about',
    title: '关于',
    description: '版本、构建信息与运行环境',
    icon: <InfoCircleOutlined />,
  },
]

function SectionHeading({ section }: { section: SectionDef }) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        paddingBottom: 14,
        marginBottom: 18,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: token.colorPrimaryBg,
          color: token.colorPrimary,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          fontSize: 15,
        }}
      >
        {section.icon}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Typography.Text strong style={{ fontSize: 14 }}>
          {section.title}
        </Typography.Text>
        <div style={{ marginTop: 1 }}>
          <Muted>{section.description}</Muted>
        </div>
      </div>
    </div>
  )
}

export default function Settings() {
  const { token } = theme.useToken()
  const isMobile = useIsMobile()
  const [active, setActive] = useState('system')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [moved, setMoved] = useState<{ addr: string; url: string } | null>(null)

  const current = SECTIONS.find((item) => item.key === active) ?? SECTIONS[0]

  const openSection = (key: string) => {
    setActive(key)
    if (isMobile) setMobileDetail(true)
  }

  const menuItems: MenuProps['items'] = SECTIONS.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: isMobile ? (
      <div style={{ padding: '2px 0', lineHeight: '18px' }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
        <div
          style={{
            marginTop: 1,
            fontSize: 11,
            lineHeight: '16px',
            color: token.colorTextSecondary,
            whiteSpace: 'normal',
          }}
        >
          {item.description}
        </div>
      </div>
    ) : (
      item.title
    ),
  }))

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[active]}
      items={menuItems}
      onClick={({ key }) => openSection(String(key))}
      inlineIndent={16}
      style={{ borderInlineEnd: 0, background: 'transparent' }}
    />
  )

  const menuCard = (
    <Card
      styles={{ body: { padding: 6 } }}
      style={{
        borderColor: token.colorBorderSecondary,
        position: isMobile ? undefined : 'sticky',
        top: isMobile ? undefined : 12,
      }}
    >
      {menu}
    </Card>
  )

  const renderSection = () => {
    switch (active) {
      case 'logs':
        return <LogsPanel refreshToken={refreshToken} />
      case 'security':
        return <SecurityPanel refreshToken={refreshToken} />
      case 'sessions':
        return <SessionsPanel refreshToken={refreshToken} />
      case 'backup':
        return <BackupPanel refreshToken={refreshToken} />
      case 'config':
        return (
          <ConfigPanel
            onChanged={() => setRefreshToken((value) => value + 1)}
            onListenMoved={(target) => setMoved(target)}
          />
        )
      case 'about':
        return <AboutPanel refreshToken={refreshToken} />
      case 'system':
      default:
        return <SystemPanel refreshToken={refreshToken} onListenMoved={(target) => setMoved(target)} />
    }
  }

  const detailCard = (
    <Card
      styles={{ body: { padding: isMobile ? 16 : 20 } }}
      style={{ borderColor: token.colorBorderSecondary, minHeight: isMobile ? undefined : 360 }}
    >
      <SectionHeading section={current} />
      {renderSection()}
    </Card>
  )

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            display: 'grid',
            placeItems: 'center',
            fontSize: 14,
          }}
        >
          <SettingOutlined />
        </span>
        <Typography.Text strong style={{ fontSize: 15 }}>
          设置
        </Typography.Text>
        {!isMobile ? <Muted>系统参数与运维操作</Muted> : null}
        <div style={{ flex: 1 }} />
        {(current.key !== 'config' && (!isMobile || mobileDetail)) ? (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            刷新
          </Button>
        ) : null}
      </div>

      {moved ? (
        <Alert
          type="success"
          showIcon
          closable
          style={{ marginBottom: 12 }}
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

      {isMobile ? (
        mobileDetail ? (
          <div>
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={() => setMobileDetail(false)}
              style={{ paddingInline: 4, marginBottom: 8 }}
            >
              全部设置
            </Button>
            {detailCard}
          </div>
        ) : (
          menuCard
        )
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '220px minmax(0, 1fr)',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {menuCard}
          {detailCard}
        </div>
      )}
    </div>
  )
}
