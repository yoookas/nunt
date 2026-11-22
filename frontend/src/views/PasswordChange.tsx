import { useState } from 'react'
import { Button } from '@heroui/react'
import { Navigate, useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../session'
import { Page, PageHeader, Panel, TextInput, toast } from '../ui'

export default function PasswordChange() {
  const { user, changePassword } = useAuth()
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
    <Page>
      <PageHeader title="修改密码" sub="修改成功后当前会话仍然有效，其他旧会话会立即失效" />
      <Panel title="修改密码" className="max-w-xl">
        <form onSubmit={submit} className="stack p-4">
          <TextInput label="当前密码" type="password" value={current} onChange={setCurrent} />
          <TextInput label="新密码" type="password" value={next} onChange={setNext} hint="至少 8 位" />
          <TextInput label="确认新密码" type="password" value={confirm} onChange={setConfirm} />
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
    </Page>
  )
}
