import { useEffect, useState } from 'react'
import { Button, Drawer, Dropdown, Grid, Layout, Menu, Space, Typography, theme } from 'antd'
import { LogoutOutlined, MenuOutlined, MoreOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { menu } from '../menu'
import { useAuth } from '../session'
import CommandPalette from '../components/CommandPalette'
import ThemeMenu from '../components/ThemeMenu'

const { Header, Content } = Layout

export default function AppLayout() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.lg

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = location.pathname === '/' ? '/' : menu.find((m) => m.path !== '/' && location.pathname.startsWith(m.path))?.path || '/'

  return (
    <Layout style={{ minHeight: '100dvh', background: token.colorBgLayout }}>
      <Header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          height: 60,
          lineHeight: '60px',
          padding: '0 16px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {isMobile ? (
          <Button type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setDrawer(true)} />
        ) : null}
        {isMobile ? (
          <Typography.Text strong style={{ fontSize: 15 }}>
            {menu.find((item) => item.path !== '/' && location.pathname.startsWith(item.path))?.title || '概览'}
          </Typography.Text>
        ) : null}

        {!isMobile ? (
          <nav style={{ display: 'flex', gap: 2, flex: 1, marginLeft: 4 }}>
            {menu.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                style={({ isActive }) => ({
                  padding: '0 12px',
                  height: 60,
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: isActive ? token.colorPrimary : token.colorTextSecondary,
                  borderBottom: `2px solid ${isActive ? token.colorPrimary : 'transparent'}`,
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 13,
                })}
              >
                {item.title}
              </NavLink>
            ))}
          </nav>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <Space size={2}>
          <Button
            type="text"
            icon={<SearchOutlined />}
            onClick={() => setPalette(true)}
            aria-label="搜索或跳转"
          >
            {!isMobile ? '搜索' : null}
          </Button>
          <ThemeMenu />
          <Dropdown
            menu={{
              items: [
                { key: 'password', icon: <SettingOutlined />, label: '修改密码' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: async ({ key }) => {
                if (key === 'password') navigate('/password')
                if (key === 'logout') {
                  await logout()
                  navigate('/login')
                }
              },
            }}
          >
            <Button type="text" icon={<MoreOutlined />} aria-label="账户与退出" />
          </Dropdown>
        </Space>
      </Header>

      <Content style={{ padding: isMobile ? 12 : 24, overflow: 'auto' }}>
        <div style={{ maxWidth: 1440, margin: '0 auto' }}>
          <Outlet />
        </div>
      </Content>

      <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" width={260} title="导航" styles={{ body: { padding: 8 } }}>
        <Menu
          mode="inline"
          selectedKeys={[active]}
          items={menu.map((item) => ({ key: item.path, icon: item.icon, label: item.title }))}
          onClick={({ key }) => {
            navigate(key)
            setDrawer(false)
          }}
          style={{ borderInlineEnd: 0 }}
        />
      </Drawer>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </Layout>
  )
}
