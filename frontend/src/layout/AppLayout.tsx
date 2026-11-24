import { useEffect, useState } from 'react'
import { Button, Drawer, Dropdown, Menu, useOverlayState } from '@heroui/react'
import { CircleUserRound, KeyRound, LogOut, Menu as MenuIcon, TriangleAlert } from 'lucide-react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import ThemeSwitch from '../ThemeSwitch'
import { menu } from '../menu'
import { useAuth } from '../session'
import { usePolling } from '../usePolling'

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

interface HealthProblem {
  level: 'danger' | 'warning' | string
  title: string
  detail: string
}

export default function AppLayout() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [problems, setProblems] = useState<HealthProblem[]>([])
  const current = menu.find((item) => (item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)))

  const drawer = useOverlayState()

  // Surface certificate, module and renewal failures on every page: they used
  // to appear only on the overview, so a failed issuance stayed invisible
  // until somebody happened to open it.
  const refreshHealth = async () => {
    const data = await api.get<{ problems?: HealthProblem[] }>('/api/v1/system/health')
    setProblems(Array.isArray(data?.problems) ? data.problems : [])
  }

  useEffect(() => {
    void refreshHealth().catch(() => undefined)
  }, [])
  usePolling(refreshHealth, 30000)

  const onAction = async (key: string) => {
    if (key === 'password') {
      navigate('/account/password')
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
        <div className="flex-1 overflow-y-auto py-3">
          <Navigation />
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
          {problems.length > 0 ? (
            <Dropdown>
              <Dropdown.Trigger>
                <Button
                  isIconOnly
                  variant="danger-soft"
                  aria-label={`${problems.length} 个需要处理的问题`}
                >
                  <TriangleAlert size={18} />
                </Button>
              </Dropdown.Trigger>
              <Dropdown.Popover>
                <Dropdown.Menu onAction={() => navigate('/')}>
                  {problems.slice(0, 8).map((problem, index) => (
                    <Dropdown.Item
                      key={`${problem.title}-${index}`}
                      id={`problem-${index}`}
                      textValue={problem.title}
                    >
                      <div className="flex max-w-72 flex-col gap-0.5">
                        <span className={problem.level === 'danger' ? 'text-danger' : 'text-warning'}>
                          {problem.title}
                        </span>
                        <span className="whitespace-normal text-[11px] text-muted">{problem.detail}</span>
                      </div>
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Item id="overview" textValue="查看概览">
                    查看概览
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : null}
          <ThemeSwitch />
          <Dropdown>
            <Dropdown.Trigger>
              <Button isIconOnly variant="ghost" aria-label="账户菜单">
                <CircleUserRound size={18} />
              </Button>
            </Dropdown.Trigger>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={(key) => onAction(String(key))}>
                <Dropdown.Item id="password" textValue="修改密码">
                  <KeyRound size={14} className="mr-2 inline" />
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
