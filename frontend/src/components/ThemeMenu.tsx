import type { ReactNode } from 'react'
import { Button, Dropdown } from 'antd'
import { BgColorsOutlined, CheckOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import { useTheme, type ThemeMode } from '../theme'

const labels: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

const icons: Record<ThemeMode, ReactNode> = {
  light: <SunOutlined />,
  dark: <MoonOutlined />,
  system: <DesktopOutlined />,
}

export default function ThemeMenu() {
  const { mode, setMode } = useTheme()
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        selectedKeys: [mode],
        items: (['light', 'dark', 'system'] as ThemeMode[]).map((item) => ({
          key: item,
          icon: icons[item],
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 96 }}>
              {labels[item]}
              {mode === item ? <CheckOutlined style={{ marginLeft: 'auto', fontSize: 12 }} /> : null}
            </span>
          ),
        })),
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <Button type="text" icon={<BgColorsOutlined />} aria-label={`主题：${labels[mode]}`} />
    </Dropdown>
  )
}
