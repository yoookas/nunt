import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  theme,
} from 'antd'
import { CopyOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { copyText } from '../../clipboard'
import { Muted, Panel, useIsMobile } from '../../components'

type Flow = '' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'
type FactorAction = 'disable' | 'regen'

interface FactorValues {
  password: string
  code: string
}

interface Props {
  refreshToken: number
}

const recoveryCodePattern = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/

export default function SecurityPanel({ refreshToken }: Props) {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const isMobile = useIsMobile()
  const [enabled, setEnabled] = useState(false)
  const [left, setLeft] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<Flow>('')
  const [secret, setSecret] = useState('')
  const [uri, setURI] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState('')
  const [pendingAction, setPendingAction] = useState<FactorAction | null>(null)
  const [pendingValues, setPendingValues] = useState<FactorValues | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const session = await api.get('/api/v1/auth/session')
      setEnabled(!!session?.totpEnabled)
      setLeft(Number(session?.recoveryCodesLeft) || 0)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const reset = () => {
    setFlow('')
    setSecret('')
    setURI('')
    setCodes([])
    setError('')
    setPendingAction(null)
    setPendingValues(null)
  }

  const copy = (text: string, label: string) => {
    if (copyText(text)) message.success(`${label}已复制`)
    else message.error('复制失败，请手动选择文本')
  }

  const startSetup = async ({ password }: { password: string }) => {
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/v1/auth/totp/setup', { password })
      setSecret(String(result?.secret || ''))
      setURI(String(result?.uri || ''))
      setFlow('scan')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmSetup = async ({ code }: { code: string }) => {
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/v1/auth/totp/confirm', { code: code.trim() })
      setCodes(Array.isArray(result?.recoveryCodes) ? result.recoveryCodes : [])
      setFlow('codes')
      setEnabled(true)
      await load()
      message.success('双因子已启用')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const askFactor = (action: FactorAction, values: FactorValues) => {
    setError('')
    setPendingValues(values)
    setPendingAction(action)
  }

  const runPending = async () => {
    if (!pendingAction || !pendingValues) return
    const action = pendingAction
    const values = pendingValues
    setBusy(true)
    setError('')
    try {
      if (action === 'disable') {
        await api.post('/api/v1/auth/totp/disable', {
          password: values.password,
          code: values.code.trim(),
        })
        setFlow('')
        setCodes([])
        setSecret('')
        setURI('')
        setEnabled(false)
        await load()
        message.success('双因子已关闭')
      } else {
        const result = await api.post('/api/v1/auth/totp/recovery', {
          password: values.password,
          code: values.code.trim(),
        })
        setCodes(Array.isArray(result?.recoveryCodes) ? result.recoveryCodes : [])
        setFlow('codes')
        await load()
        message.success('恢复码已重新生成')
      }
      setPendingAction(null)
      setPendingValues(null)
    } catch (err) {
      // Close the confirmation and keep the form so the operator can retry;
      // the error stays visible in the panel.
      setError(errorText(err))
      setPendingAction(null)
      setPendingValues(null)
    } finally {
      setBusy(false)
    }
  }

  const factorRule = {
    validator: async (_: unknown, value: string) => {
      const text = String(value || '').replace(/\s+/g, '')
      if (!text) throw new Error('请输入验证码')
      if (!/^\d{6}$/.test(text) && !recoveryCodePattern.test(text)) {
        throw new Error('请输入 6 位动态码或 xxxxx-xxxxx 格式的恢复码')
      }
    },
  }

  const codeBlock = (text: string) => (
    <pre
      className="mono"
      style={{
        margin: 0,
        padding: 10,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        fontSize: 12,
        lineHeight: 1.6,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
      }}
    >
      {text}
    </pre>
  )

  const statusTag = loading ? (
    <Tag>读取中…</Tag>
  ) : enabled ? (
    <Tag color="green">已启用</Tag>
  ) : (
    <Tag>未启用</Tag>
  )

  const modalTitle = pendingAction === 'disable' ? '关闭双因子认证？' : '重新生成恢复码？'
  const modalText =
    pendingAction === 'disable'
      ? '关闭后登录只需要密码；当前账号的其他会话会立即失效。请确认已经理解安全影响。'
      : '重新生成会立即作废全部旧恢复码，之前保存的恢复码将无法再使用。'

  return (
    <>
      <Panel
        title="双因子认证（TOTP）"
        subtitle="密码之外再要一个验证器生成的 6 位码；启用后请把恢复码保存在离线位置"
        extra={
          <Space size={8}>
            {statusTag}
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Spin spinning={loading}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {error ? (
              <Alert
                type="error"
                showIcon
                message={error}
                closable
                onClose={() => setError('')}
              />
            ) : null}

            {flow === '' ? (
              enabled ? (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                  <Alert
                    type={left === 0 ? 'warning' : 'success'}
                    showIcon
                    message={
                      left === 0
                        ? '验证器已绑定，但恢复码已经用完'
                        : `验证器已绑定，剩余恢复码 ${left} 枚`
                    }
                    description={
                      left === 0
                        ? '建议立即重新生成恢复码并保存到离线位置，避免验证器丢失后无法登录。'
                        : '恢复码每枚只能使用一次。设备丢失时用它代替动态验证码登录。'
                    }
                  />
                  <Space wrap>
                    <Button onClick={() => setFlow('regen')}>重新生成恢复码</Button>
                    <Button danger onClick={() => setFlow('disable')}>
                      关闭双因子
                    </Button>
                  </Space>
                </Space>
              ) : (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                  <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                    启用后登录需要两个步骤，适合管理后台暴露在公网或只经反向代理访问的场景。
                    验证器密钥只在本页显示一次，请妥善保存恢复码。
                  </Typography.Paragraph>
                  <div>
                    <Button
                      type="primary"
                      icon={<SafetyCertificateOutlined />}
                      onClick={() => setFlow('password')}
                    >
                      启用双因子
                    </Button>
                  </div>
                </Space>
              )
            ) : null}

            {flow === 'password' ? (
              <Form layout="vertical" requiredMark={false} onFinish={startSetup}>
                <Steps
                  size="small"
                  current={0}
                  style={{ marginBottom: 20 }}
                  items={[{ title: '验证密码' }, { title: '添加验证器' }, { title: '保存恢复码' }]}
                />
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="先确认当前密码"
                  description="验证密码后服务端会生成新的 TOTP 密钥，密钥 5 分钟内有效。"
                />
                <Form.Item
                  name="password"
                  label="当前密码"
                  rules={[{ required: true, message: '请输入当前密码' }]}
                >
                  <Input.Password autoFocus autoComplete="current-password" />
                </Form.Item>
                <Space wrap>
                  <Button type="primary" htmlType="submit" loading={busy}>
                    下一步
                  </Button>
                  <Button onClick={reset} disabled={busy}>
                    取消
                  </Button>
                </Space>
              </Form>
            ) : null}

            {flow === 'scan' ? (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Steps
                  size="small"
                  current={1}
                  style={{ marginBottom: 4 }}
                  items={[{ title: '验证密码' }, { title: '添加验证器' }, { title: '保存恢复码' }]}
                />
                <Alert
                  type="info"
                  showIcon
                  message="请手动添加验证器账户"
                  description="当前前端构建未包含二维码生成库，暂不显示二维码。请复制下方密钥，在 1Password、Authy、Google Authenticator 等验证器中手动添加；二维码会在后续版本补上。"
                />
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={12}>
                    <Typography.Text strong>密钥（Base32）</Typography.Text>
                    <div style={{ marginTop: 8 }}>{codeBlock(secret)}</div>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      style={{ marginTop: 8 }}
                      onClick={() => copy(secret, '密钥')}
                    >
                      复制密钥
                    </Button>
                  </Col>
                  <Col xs={24} md={12}>
                    <Typography.Text strong>otpauth URI</Typography.Text>
                    <div style={{ marginTop: 8 }}>{codeBlock(uri)}</div>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      style={{ marginTop: 8 }}
                      onClick={() => copy(uri, 'otpauth URI')}
                    >
                      复制 URI
                    </Button>
                  </Col>
                </Row>
                <div>
                  <Muted>
                    验证器账户名固定为 <span className="mono">nunt:admin</span>，类型 TOTP、6 位、30 秒。密钥只在本页显示，离开后需重新开始。
                  </Muted>
                </div>
                <Form layout="vertical" requiredMark={false} onFinish={confirmSetup}>
                  <Form.Item
                    name="code"
                    label="验证码"
                    rules={[
                      { required: true, message: '请输入验证器显示的 6 位验证码' },
                      { pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' },
                    ]}
                  >
                    <Input
                      autoFocus
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="输入验证器显示的 6 位码"
                      style={{ maxWidth: 260 }}
                    />
                  </Form.Item>
                  <Space wrap>
                    <Button type="primary" htmlType="submit" loading={busy}>
                      确认启用
                    </Button>
                    <Button onClick={reset} disabled={busy}>
                      取消
                    </Button>
                  </Space>
                </Form>
              </Space>
            ) : null}

            {flow === 'codes' ? (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Steps
                  size="small"
                  current={3}
                  items={[{ title: '验证密码' }, { title: '添加验证器' }, { title: '保存恢复码' }]}
                />
                <Alert
                  type="warning"
                  showIcon
                  message="恢复码只显示这一次"
                  description="每枚恢复码只能用一次。请现在保存到离线位置（密码管理器或打印），设备丢失时用它登录。"
                />
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                    padding: 12,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadius,
                    background: token.colorFillQuaternary,
                  }}
                >
                  {codes.map((item) => (
                    <span key={item} className="mono" style={{ fontSize: 14 }}>
                      {item}
                    </span>
                  ))}
                </div>
                <Space wrap>
                  <Button icon={<CopyOutlined />} onClick={() => copy(codes.join('\n'), '恢复码')}>
                    复制全部
                  </Button>
                  <Button type="primary" onClick={reset}>
                    我已保存
                  </Button>
                </Space>
              </Space>
            ) : null}

            {flow === 'disable' || flow === 'regen' ? (
              <Form
                layout="vertical"
                requiredMark={false}
                onFinish={(values) => askFactor(flow === 'disable' ? 'disable' : 'regen', values)}
              >
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  {flow === 'disable'
                    ? '关闭双因子需要密码 + 当前验证码（或用一枚恢复码）。'
                    : '重新生成会立即作废全部旧恢复码。请输入密码 + 当前验证码（或用一枚恢复码）。'}
                </Typography.Paragraph>
                <Row gutter={[16, 0]}>
                  <Col xs={24} md={12}>
                    <Form.Item
                      name="password"
                      label="当前密码"
                      rules={[{ required: true, message: '请输入当前密码' }]}
                    >
                      <Input.Password autoFocus autoComplete="current-password" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item
                      name="code"
                      label="验证码 / 恢复码"
                      rules={[factorRule]}
                    >
                      <Input placeholder="000000 或 xxxxx-xxxxx" />
                    </Form.Item>
                  </Col>
                </Row>
                <Space wrap>
                  <Button
                    type={flow === 'disable' ? 'default' : 'primary'}
                    danger={flow === 'disable'}
                    htmlType="submit"
                  >
                    {flow === 'disable' ? '关闭双因子' : '重新生成'}
                  </Button>
                  <Button onClick={reset} disabled={busy}>
                    取消
                  </Button>
                </Space>
              </Form>
            ) : null}
          </Space>
        </Spin>
      </Panel>

      <Modal
        open={pendingAction !== null}
        title={modalTitle}
        okText={pendingAction === 'disable' ? '关闭双因子' : '重新生成'}
        cancelText="取消"
        okButtonProps={{ danger: pendingAction === 'disable' }}
        confirmLoading={busy}
        maskClosable={!busy}
        onCancel={() => {
          if (busy) return
          setPendingAction(null)
          setPendingValues(null)
        }}
        onOk={() => void runPending()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text>{modalText}</Typography.Text>
          <Alert
            type={pendingAction === 'disable' ? 'error' : 'warning'}
            showIcon
            message={pendingAction === 'disable' ? '关闭后安全性会降低' : '旧恢复码将立即作废'}
          />
        </Space>
      </Modal>
    </>
  )
}
