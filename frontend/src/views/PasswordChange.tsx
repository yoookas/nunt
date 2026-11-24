import { useState } from 'react'
import { Button, Card, Typography } from '@heroui/react'
import { Navigate, useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../session'
import ThemeSwitch from '../ThemeSwitch'
import { TextInput, toast } from '../ui'

export default function PasswordChange() {
  const { user, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  if (!user) return <Navigate to="/login" replace />

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (next.length < 8) {
      toast.warning('新密码长度至少 8 位')
      return
    }
    if (next !== confirm) {
      toast.warning('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      toast.success('密码已修改')
      navigate('/', { replace: true })
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex justify-end p-3">
        <ThemeSwitch />
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <Card.Content className="space-y-5 p-6 sm:p-8">
            <div>
              <Typography.Heading level={2} className="text-lg font-semibold">
                {user.mustChangePassword ? '设置新密码' : '修改密码'}
              </Typography.Heading>
              <Typography.Paragraph className="mt-1 text-xs leading-5 text-muted">
                {user.mustChangePassword
                  ? '首次登录需要先设置一个新密码；保存后才能进入控制台，其他旧会话会立即失效。'
                  : '修改成功后当前会话仍然有效，其他旧会话会立即失效。'}
              </Typography.Paragraph>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <TextInput label="当前密码" type="password" value={current} onChange={setCurrent} />
              <TextInput label="新密码" type="password" value={next} onChange={setNext} hint="至少 8 位" />
              <TextInput label="确认新密码" type="password" value={confirm} onChange={setConfirm} />
              <Button type="submit" variant="primary" fullWidth isDisabled={busy}>
                {busy ? '保存中…' : '保存'}
              </Button>
              {user.mustChangePassword ? (
                <Button variant="tertiary" fullWidth onPress={() => void logout()}>
                  退出登录
                </Button>
              ) : (
                <Button variant="tertiary" fullWidth onPress={() => navigate('/')}>
                  返回
                </Button>
              )}
            </form>
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
