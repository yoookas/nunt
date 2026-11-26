import { lazy, Suspense, type ReactNode } from 'react'
import { createHashRouter, Navigate, Outlet, useLocation } from 'react-router-dom'
import { Spin } from 'antd'
import AppLayout from './layout/AppLayout'
import { useAuth } from './session'

const Login = lazy(() => import('./pages/Login'))
const PasswordChange = lazy(() => import('./pages/PasswordChange'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Web = lazy(() => import('./pages/Web'))
const Forward = lazy(() => import('./pages/Forward'))
const Ddns = lazy(() => import('./pages/Ddns'))
const Acme = lazy(() => import('./pages/Acme'))
const Waf = lazy(() => import('./pages/Waf'))
const Logs = lazy(() => import('./pages/Logs'))
const IpDatabase = lazy(() => import('./pages/IpDatabase'))
const Settings = lazy(() => import('./pages/Settings'))

function Loading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <Spin />
    </div>
  )
}

function page(node: ReactNode) {
  return <Suspense fallback={<Loading />}>{node}</Suspense>
}

function RequireAuth() {
  const { user, ready } = useAuth()
  const location = useLocation()
  if (!ready) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (user.mustChangePassword && location.pathname !== '/password') return <Navigate to="/password" replace />
  return <Outlet />
}

function LoginGate() {
  const { user, ready } = useAuth()
  if (!ready) return <Loading />
  if (user) return <Navigate to={user.mustChangePassword ? '/password' : '/'} replace />
  return page(<Login />)
}

function PasswordGate() {
  const { user, ready } = useAuth()
  if (!ready) return <Loading />
  if (!user) return <Navigate to="/login" replace />
  return page(<PasswordChange />)
}

export const router = createHashRouter([
  { path: '/login', element: <LoginGate /> },
  { path: '/password', element: <PasswordGate /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: page(<Dashboard />) },
          { path: 'web', element: page(<Web />) },
          { path: 'forward', element: page(<Forward />) },
          { path: 'ddns', element: page(<Ddns />) },
          { path: 'acme', element: page(<Acme />) },
          { path: 'waf', element: page(<Waf />) },
          { path: 'logs', element: page(<Logs />) },
          { path: 'ipdb', element: page(<IpDatabase />) },
          { path: 'settings', element: page(<Settings />) },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
