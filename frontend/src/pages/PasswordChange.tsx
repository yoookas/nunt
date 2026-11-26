import { useState } from 'react'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../session'

export default function PasswordChange() {
  const { changePassword, logout, user } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const onFinish = async (values: { current: string; next: string; confirm: string }) => {
    if (values.next !== values.confirm) {
      message.error('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await changePassword(values.current, values.next)
      message.success('密码已修改')
      navigate('/', { replace: true })
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Typography.Title level={4}>{user?.mustChangePassword ? '首次登录必须修改密码' : '修改密码'}</Typography.Title>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="current" label="当前密码" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} autoFocus />
          </Form.Item>
          <Form.Item name="next" label="新密码" rules={[{ required: true, min: 12, message: '至少 12 个字符' }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            保存
          </Button>
          <Button
            type="link"
            block
            style={{ marginTop: 8 }}
            onClick={async () => {
              await logout()
              navigate('/login', { replace: true })
            }}
          >
            退出登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
