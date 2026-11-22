import { lazy, Suspense, type ReactNode } from 'react'
import { createHashRouter, Navigate, Outlet, useLocation } from 'react-router-dom'
import AppLayout from './layout/AppLayout'
import { useAuth } from './session'
import { Page, PageHeader } from './ui'
import Dashboard from './views/Dashboard'
import Login from './views/Login'
import PasswordChange from './views/PasswordChange'
const Web = lazy(() => import('./views/Web'))
const Forward = lazy(() => import('./views/Forward'))
const Ddns = lazy(() => import('./views/Ddns'))
const Acme = lazy(() => import('./views/Acme'))
const Waf = lazy(() => import('./views/Waf'))
const Storage = lazy(() => import('./views/Storage'))
const Logs = lazy(() => import('./views/Logs'))
const Settings = lazy(() => import('./views/Settings'))

function RequireAuth() {
  const { user, ready } = useAuth()
  const location = useLocation()

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted">加载中…</div>
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (user.mustChangePassword && location.pathname !== '/password') {
    return <Navigate to="/password" replace />
  }
  return <Outlet />
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted">加载中…</div>}>{children}</Suspense>
}

function Placeholder({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} sub="页面开发中" />
    </Page>
  )
}

const router = createHashRouter([
  { path: '/login', element: <Login /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Dashboard /> },
          { path: 'web', element: <Web /> },
          { path: 'forward', element: <Forward /> },
          { path: 'ddns', element: <Ddns /> },
          { path: 'acme', element: <Acme /> },
          { path: 'waf', element: <Waf /> },
          { path: 'storage', element: <Storage /> },
          { path: 'logs', element: <Logs /> },
          { path: 'settings', element: <Settings /> },
          { path: 'password', element: <PasswordChange /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default router
export { Placeholder }
