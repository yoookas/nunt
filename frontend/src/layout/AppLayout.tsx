import { useState } from 'react'
import { Avatar, Button, Drawer, Dropdown, Menu, useOverlayState } from '@heroui/react'
import { LogOut, Menu as MenuIcon, Monitor, Moon, Sun } from 'lucide-react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { menu } from '../menu'
import { useAuth } from '../session'
import { useTheme, type ThemeMode } from '../theme'

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const active = menu.find((item) => (item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)))

  return (
    <Menu
      aria-label="主导航"
      selectionMode="single"
      selectedKeys={active ? [active.path] : []}
      onSelectionChange={(keys) => {
        const next = [...keys][0]
        if (next != null) {
          navigate(String(next))
          onNavigate?.()
        }
      }}
      className="px-2"
    >
      {menu.map((item) => {
        const Icon = item.icon
        return (
          <Menu.Item key={item.path} id={item.path} textValue={item.title}>
            <Icon size={18} />
            <span>{item.title}</span>
          </Menu.Item>
        )
      })}
    </Menu>
  )
}

export default function AppLayout() {
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const current = menu.find((item) => (item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)))

  const drawer = useOverlayState()

  const onAction = async (key: string) => {
    if (key === 'password') {
      navigate('/password')
      return
    }
    if (key === 'logout') {
      await logout()
      navigate('/login')
    }
  }

  return (
    <div className="flex h-full min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-sm font-bold text-accent-foreground">
            n
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">nunt</div>
            <div className="text-[11px] text-muted">edge console</div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          <Navigation />
        </div>
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 rounded-xl bg-background px-3 py-2">
            <Avatar size="sm">
              <Avatar.Fallback>{(user?.username || '?').slice(0, 1).toUpperCase()}</Avatar.Fallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{user?.username}</div>
              <div className="text-[11px] text-muted">管理员</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
          <Button
            isIconOnly
            variant="ghost"
            className="md:hidden"
            aria-label="打开导航"
            onPress={() => setMobileOpen(true)}
          >
            <MenuIcon size={18} />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{current?.title || '概览'}</div>
            <div className="truncate text-[11px] text-muted">nunt 管理后台</div>
          </div>
          <div className="flex-1" />
          <Dropdown>
            <Dropdown.Trigger>
              <Button isIconOnly variant="ghost" aria-label="颜色模式">
                {theme === 'system' ? <Monitor size={18} /> : theme === 'light' ? <Sun size={18} /> : <Moon size={18} />}
              </Button>
            </Dropdown.Trigger>
            <Dropdown.Popover>
              <Dropdown.Menu
                selectionMode="single"
                selectedKeys={[theme]}
                onAction={(key) => setTheme(String(key) as ThemeMode)}
              >
                <Dropdown.Item id="light" textValue="浅色">
                  浅色
                </Dropdown.Item>
                <Dropdown.Item id="dark" textValue="深色">
                  深色
                </Dropdown.Item>
                <Dropdown.Item id="system" textValue="跟随系统">
                  跟随系统
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Dropdown>
            <Dropdown.Trigger>
              <Button variant="ghost">
                <Avatar size="sm">
                  <Avatar.Fallback>{(user?.username || '?').slice(0, 1).toUpperCase()}</Avatar.Fallback>
                </Avatar>
                <span className="hidden sm:inline">{user?.username || '未登录'}</span>
              </Button>
            </Dropdown.Trigger>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={(key) => onAction(String(key))}>
                <Dropdown.Item id="password" textValue="修改密码">
                  修改密码
                </Dropdown.Item>
                <Dropdown.Item id="logout" textValue="退出登录">
                  <LogOut size={14} className="mr-2 inline" />
                  退出登录
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <Drawer isOpen={mobileOpen} onOpenChange={setMobileOpen}>
        <Drawer.Backdrop>
          <Drawer.Content placement="left">
            <Drawer.Dialog>
              <Drawer.Header>
                <Drawer.Heading>nunt</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body className="p-0">
                <Navigation onNavigate={() => setMobileOpen(false)} />
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  )
}
