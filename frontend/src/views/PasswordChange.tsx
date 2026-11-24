import { useState } from 'react'
import { Button, Card, Typography } from '@heroui/react'
import { Navigate, useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../session'
import ThemeSwitch from '../ThemeSwitch'
import { Page, PageHeader, Panel, TextInput, toast } from '../ui'

/**
 * PasswordChange exists in two shells.
 *
 * With `standalone` it is the screen shown before the console opens, used when
 * the first password still has to be replaced: no navigation, only the form
 * and a way out. Without it, the same form lives inside the console for a
 * voluntary change (header menu → "修改密码").
 */
export default function PasswordChange({ standalone = false }: { standalone?: boolean }) {
  const { user, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  if (!user) return <Navigate to="/login" replace />

  const forced = user.mustChangePassword
  const title = forced ? '设置新密码' : '修改密码'
  const sub = forced
    ? '首次登录需要先设置一个新密码；保存后才能进入控制台，其他旧会话会立即失效。'
    : '修改成功后当前会话仍然有效，其他旧会话会立即失效。'

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

  const fields = (
    <>
      <TextInput label="当前密码" type="password" value={current} onChange={setCurrent} />
      <TextInput label="新密码" type="password" value={next} onChange={setNext} hint="至少 8 位" />
      <TextInput label="确认新密码" type="password" value={confirm} onChange={setConfirm} />
    </>
  )

  if (standalone) {
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
                  {title}
                </Typography.Heading>
                <Typography.Paragraph className="mt-1 text-xs leading-5 text-muted">{sub}</Typography.Paragraph>
              </div>
              <form onSubmit={submit} className="space-y-4">
                {fields}
                <Button type="submit" variant="primary" fullWidth isDisabled={busy}>
                  {busy ? '保存中…' : '保存'}
                </Button>
                {forced ? (
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

  return (
    <Page>
      <div className="mx-auto w-full max-w-md space-y-5">
        <PageHeader title={title} sub={sub} />
        <Panel>
          <form onSubmit={submit} className="space-y-4">
            {fields}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" isDisabled={busy}>
                {busy ? '保存中…' : '保存'}
              </Button>
              <Button variant="tertiary" onPress={() => navigate('/')}>
                返回
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </Page>
  )
}
