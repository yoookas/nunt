import { useEffect, useState } from 'react'
import { Button, Card, Typography } from '@heroui/react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { isTOTPChallenge, useAuth, type AuthUser } from '../session'
import ThemeSwitch from '../ThemeSwitch'
import { TextInput, toast } from '../ui'

export default function Login() {
  const { user, ready, login, loginTOTP } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const from = String((location.state as any)?.from || '/')

  useEffect(() => {
    if (ready && user && !user.mustChangePassword) {
      navigate(from, { replace: true })
    }
  }, [ready, user, navigate, from])

  if (ready && user) {
    return <Navigate to={user.mustChangePassword ? '/password' : '/'} replace />
  }

  const afterLogin = (next: AuthUser) => {
    if (next.mustChangePassword) {
      toast.warning('首次登录，请先修改初始密码')
      navigate('/password', { replace: true })
      return
    }
    navigate(from, { replace: true })
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password) {
      setError('请输入密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await login(password)
      if (isTOTPChallenge(result)) {
        // The password was right but a second factor is required: keep the
        // challenge and ask for the code instead of navigating away.
        setChallenge(result.challenge)
        setPassword('')
        setCode('')
        return
      }
      afterLogin(result)
    } catch (err) {
      const message = errorText(err)
      setError(message)
      toast.danger(message)
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!code.trim()) {
      setError(recovery ? '请输入恢复码' : '请输入验证码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await loginTOTP(challenge, code.trim())
      afterLogin(next)
    } catch (err) {
      setError(errorText(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const back = () => {
    setChallenge('')
    setCode('')
    setError('')
    setRecovery(false)
  }

  const secondStep = challenge !== ''

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* A toolbar row keeps the switch in normal flow: nothing overlaps the
          card on short viewports, and the position matches the console. */}
      <div className="flex justify-end p-3">
        <ThemeSwitch />
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-sm">
        <Card.Content className="p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-base font-bold text-accent-foreground">
              n
            </span>
            <div>
              <Typography.Heading level={3} className="text-lg font-semibold">
                nunt
              </Typography.Heading>
              <Typography.Paragraph className="text-xs text-muted">
                {secondStep ? '两步验证' : '登录到管理后台'}
              </Typography.Paragraph>
            </div>
          </div>

          {secondStep ? (
            <form onSubmit={submitCode} className="space-y-5">
              <Typography.Paragraph className="text-xs leading-5 text-muted">
                {recovery
                  ? '输入一枚未使用的恢复码（形如 xxxxx-xxxxx）。每枚只能用一次。'
                  : '输入验证器应用里当前显示的 6 位验证码。'}
              </Typography.Paragraph>
              <TextInput
                label={recovery ? '恢复码' : '验证码'}
                value={code}
                onChange={setCode}
                placeholder={recovery ? 'xxxxx-xxxxx' : '000000'}
                required
              />
              {error ? <div className="text-sm text-danger">{error}</div> : null}
              <Button type="submit" variant="primary" fullWidth isDisabled={busy}>
                {busy ? '验证中…' : '验证并登录'}
              </Button>
              <div className="flex items-center justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setRecovery((prev) => !prev)
                    setCode('')
                    setError('')
                  }}
                >
                  {recovery ? '改用验证码' : '改用恢复码'}
                </Button>
                <Button size="sm" variant="ghost" onPress={back}>
                  返回
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={submitPassword} className="space-y-5">
              <TextInput
                label="密码"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="登录密码"
                required
              />
              {error ? <div className="text-sm text-danger">{error}</div> : null}
              <Button type="submit" variant="primary" fullWidth isDisabled={busy}>
                {busy ? '登录中…' : '登录'}
              </Button>
            </form>
          )}
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
