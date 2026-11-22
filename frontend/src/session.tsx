import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setCSRF } from './api'

export interface AuthUser {
  username: string
  csrf: string
  mustChangePassword: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  ready: boolean
  login: (username: string, password: string) => Promise<AuthUser>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function applySession(data: any): AuthUser {
  const user: AuthUser = {
    username: data?.username || '',
    csrf: data?.csrf || '',
    mustChangePassword: !!data?.mustChangePassword,
  }
  setCSRF(user.csrf)
  return user
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .get('/api/v1/auth/session')
      .then((data) => {
        if (alive) setUser(applySession(data))
      })
      .catch(() => {
        if (alive) setUser(null)
      })
      .finally(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      setCSRF('')
    }
    window.addEventListener('nunt:unauthorized', onUnauthorized)
    return () => window.removeEventListener('nunt:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const data = await api.post('/api/v1/auth/login', { username, password })
    const next = applySession(data)
    setUser(next)
    return next
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout')
    } finally {
      setUser(null)
      setCSRF('')
    }
  }, [])

  const changePassword = useCallback(async (current: string, next: string) => {
    await api.post('/api/v1/auth/password', { current, new: next })
    setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev))
  }, [])

  const value = useMemo(
    () => ({ user, ready, login, logout, changePassword }),
    [user, ready, login, logout, changePassword],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
