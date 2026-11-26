import { useState } from 'react'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { isTOTPChallenge, useAuth } from '../session'

export default function Login() {
  const { login, loginTOTP } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [challenge, setChallenge] = useState('')
  const [busy, setBusy] = useState(false)

  const onPassword = async (values: { password: string }) => {
    setBusy(true)
    try {
      const result = await login(values.password)
      if (isTOTPChallenge(result)) {
        setChallenge(result.challenge)
      } else {
        navigate(result.mustChangePassword ? '/password' : '/', { replace: true })
      }
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const onTOTP = async (values: { code: string }) => {
    setBusy(true)
    try {
      const user = await loginTOTP(challenge, values.code.trim())
      navigate(user.mustChangePassword ? '/password' : '/', { replace: true })
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--ant-color-bg-layout, #f5f5f5)' }}>
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            nunt
          </Typography.Title>
          <Typography.Text type="secondary">{challenge ? '两步验证' : '管理控制台'}</Typography.Text>
        </div>

        {challenge ? (
          <Form layout="vertical" onFinish={onTOTP} requiredMark={false}>
            <Form.Item name="code" label="动态验证码" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input prefix={<SafetyCertificateOutlined />} autoFocus inputMode="numeric" placeholder="6 位数字或恢复码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              登录
            </Button>
            <Button type="link" block onClick={() => setChallenge('')} style={{ marginTop: 8 }}>
              返回
            </Button>
          </Form>
        ) : (
          <Form layout="vertical" onFinish={onPassword} requiredMark={false}>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} autoFocus placeholder="管理密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              登录
            </Button>
          </Form>
        )}
      </Card>
    </div>
  )
}
