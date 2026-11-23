import { useEffect, useState } from 'react'
import { Button, Card, Typography } from '@heroui/react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../session'
import { TextInput, toast } from '../ui'

export default function Login() {
  const { user, ready, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (ready && user && !user.mustChangePassword) {
      navigate(String((location.state as any)?.from || '/'), { replace: true })
    }
  }, [ready, user, navigate, location.state])

  if (ready && user) {
    return <Navigate to={user.mustChangePassword ? '/password' : '/'} replace />
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await login(username.trim(), password)
      if (next.mustChangePassword) {
        toast.warning('首次登录，请先修改初始密码')
        navigate('/password', { replace: true })
      } else {
        navigate(String((location.state as any)?.from || '/'), { replace: true })
      }
    } catch (err) {
      setError(errorText(err))
      toast.danger(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
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
                登录到管理后台
              </Typography.Paragraph>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-5">
            <TextInput label="用户名" value={username} onChange={setUsername} placeholder="admin" required />
            <TextInput
              label="密码"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="密码"
              required
            />
            {error ? <div className="text-sm text-danger">{error}</div> : null}
            <Button type="submit" variant="primary" fullWidth isDisabled={busy}>
              {busy ? '登录中…' : '登录'}
            </Button>
          </form>
        </Card.Content>
      </Card>
    </div>
  )
}
