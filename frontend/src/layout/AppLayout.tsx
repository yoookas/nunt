import { Button, Dropdown } from '@heroui/react'
import { LogOut, Moon, Sun, UserRound } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { menu } from '../menu'
import { useAuth } from '../session'
import { useTheme } from '../theme'

export default function AppLayout() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()

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
      <aside className="flex w-14 shrink-0 flex-col border-r border-border bg-background-secondary md:w-56">
        <div className="flex h-14 items-center gap-2 px-4 text-base font-semibold">
          <span className="brand-dot" />
          <span className="hidden md:inline">nunt</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {menu.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-default text-foreground'
                      : 'text-muted hover:bg-default/60 hover:text-foreground',
                  ].join(' ')
                }
              >
                <Icon size={18} className="shrink-0" />
                <span className="hidden md:inline">{item.title}</span>
              </NavLink>
            )
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
          <div className="flex-1" />
          <Button
            isIconOnly
            variant="ghost"
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            onPress={toggle}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
          <Dropdown>
            <Dropdown.Trigger>
              <Button variant="ghost">
                <UserRound size={16} />
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
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
