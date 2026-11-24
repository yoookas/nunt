import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setCSRF } from './api'

export interface AuthUser {
  csrf: string
  mustChangePassword: boolean
  totpEnabled?: boolean
  recoveryCodesLeft?: number
}

// The password step of a two factor login: no session exists yet, only a short
// lived challenge that has to be exchanged for one.
export interface TOTPChallenge {
  totpRequired: true
  challenge: string
}

export type LoginResult = AuthUser | TOTPChallenge

export function isTOTPChallenge(result: LoginResult): result is TOTPChallenge {
  return (result as TOTPChallenge).totpRequired === true
}

interface AuthContextValue {
  user: AuthUser | null
  ready: boolean
  login: (password: string) => Promise<LoginResult>
  loginTOTP: (challenge: string, code: string) => Promise<AuthUser>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function applySession(data: any): AuthUser {
  const user: AuthUser = {
    csrf: data?.csrf || '',
    mustChangePassword: !!data?.mustChangePassword,
    totpEnabled: !!data?.totpEnabled,
    recoveryCodesLeft: Number(data?.recoveryCodesLeft) || 0,
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

  const login = useCallback(async (password: string) => {
    const data = await api.post('/api/v1/auth/login', { password })
    if (data?.totpRequired) {
      // No session yet: the caller has to collect the second factor.
      return { totpRequired: true as const, challenge: String(data.challenge || '') }
    }
    const next = applySession(data)
    setUser(next)
    return next
  }, [])

  const loginTOTP = useCallback(async (challenge: string, code: string) => {
    const data = await api.post('/api/v1/auth/login/totp', { challenge, code })
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
    () => ({ user, ready, login, loginTOTP, logout, changePassword }),
    [user, ready, login, loginTOTP, logout, changePassword],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
