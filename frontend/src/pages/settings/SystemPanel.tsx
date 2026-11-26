import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  theme,
} from 'antd'
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { Muted } from '../../components'
import {
  ADDRESS_PATTERN,
  EMPTY_LISTEN,
  EMPTY_SYSTEM,
  LOG_LEVELS,
  THEMES,
  adminListenURL,
  isValidBaseURL,
  isValidListen,
  toList,
  type AdminAllowInfo,
  type ListenState,
  type SystemForm,
  type SystemInfo,
  type SystemSettingsResponse,
} from './shared'
import { SettingsSection } from './ui'

interface Props {
  /** Incremented by the page header refresh button. */
  refreshToken: number
  onListenMoved: (target: { addr: string; url: string }) => void
}

export default function SystemPanel({ refreshToken, onListenMoved }: Props) {
  const [form] = Form.useForm<SystemForm>()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [listen, setListen] = useState<ListenState>(EMPTY_LISTEN)
  const [allowInfo, setAllowInfo] = useState<AdminAllowInfo | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [settings, info] = await Promise.all([
        api.get<Partial<SystemForm>>('/api/v1/system/settings'),
        api.get<SystemInfo>('/api/v1/system/info').catch(() => null),
      ])
      const configListen = info?.adminListenConfig ?? settings?.adminListen ?? ''
      form.setFieldsValue({
        adminListen: configListen,
        baseUrl: settings?.baseUrl || '',
        logLevel: settings?.logLevel || 'info',
        sessionTtlHours: Number(settings?.sessionTtlHours) || 12,
        loginMaxFail: Number(settings?.loginMaxFail) || 5,
        loginLockMinutes: Number(settings?.loginLockMinutes) || 10,
        trustProxy: !!settings?.trustProxy,
        sessionBindIp: !!settings?.sessionBindIp,
        theme: settings?.theme || 'system',
        adminAllowIps: toList(settings?.adminAllowIps),
      })
      setListen({
        actual: info?.adminListen || settings?.adminListen || '',
        config: configListen,
        source: info?.adminListenSource || 'config',
        env: info?.adminListenEnv || '',
        applied: true,
        notice: info?.adminListenNotice || '',
      })
      setAllowInfo(info?.adminAllowList || null)
      setLoaded(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const envControlled = listen.source === 'env'
  const listenNotice = (() => {
    if (listen.notice) return listen.notice
    if (envControlled) {
      const env = listen.env || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT'
      return `当前监听地址由环境变量 ${env} 控制（实际生效 ${listen.actual || '未知'}）：修改配置不会改变运行中的端口，需移除该环境变量并重启服务后才生效。`
    }
    if (!listen.applied && listen.actual) {
      return `配置值 ${listen.config || '（空）'} 与实际监听地址 ${listen.actual} 不一致，请检查启动参数或重新保存设置。`
    }
    return ''
  })()

  const allowNotice = (() => {
    if (!allowInfo) return null
    if (allowInfo.failClosed) {
      return {
        type: 'error' as const,
        text: `管理端 IP 白名单没有有效条目，当前会拒绝所有管理端访问（已拦截 ${allowInfo.blocked || 0} 次）。请尽快修正白名单。`,
      }
    }
    if (allowInfo.restricted) {
      return {
        type: 'info' as const,
        text: `管理端 IP 白名单已生效：${allowInfo.valid || 0} 条有效规则，自启动以来已拦截 ${allowInfo.blocked || 0} 次请求。`,
      }
    }
    return {
      type: 'warning' as const,
      text: '管理端 IP 白名单未启用（留空）。任何能连接到管理端口的客户端都可以尝试登录。',
    }
  })()

  const onFinish = async (values: SystemForm) => {
    const payload = {
      adminListen: String(values.adminListen || '').trim(),
      baseUrl: String(values.baseUrl || '').trim(),
      logLevel: values.logLevel || 'info',
      sessionTtlHours: Number(values.sessionTtlHours),
      loginMaxFail: Number(values.loginMaxFail),
      loginLockMinutes: Number(values.loginLockMinutes),
      trustProxy: !!values.trustProxy,
      sessionBindIp: !!values.sessionBindIp,
      theme: values.theme || 'system',
      adminAllowIps: toList(values.adminAllowIps),
    }
    const previous = listen.actual || listen.config
    setSaving(true)
    try {
      const result = await api.put<SystemSettingsResponse>('/api/v1/system/settings', payload)
      if (!result) {
        await load()
        message.success('设置已保存')
        return
      }
      const configListen = result.adminListenConfig ?? payload.adminListen
      form.setFieldsValue({ adminListen: configListen })
      setListen({
        actual: result.adminListen || payload.adminListen,
        config: configListen,
        source: result.adminListenSource || 'config',
        env: result.adminListenEnv || '',
        applied: result.adminListenApplied !== false,
        notice: result.adminListenNotice || '',
      })
      setAllowInfo((prev) => {
        const entries = payload.adminAllowIps.length
        return {
          ...(prev || {}),
          entries,
          restricted: entries > 0,
          valid: entries,
          failClosed: false,
          trustProxy: payload.trustProxy,
        }
      })
      const effective = result.adminListen || ''
      if (result.adminListenSource === 'env') {
        message.warning('设置已保存；监听地址仍由环境变量控制，未改变实际端口')
      } else if (effective && previous && effective !== previous) {
        onListenMoved({ addr: effective, url: adminListenURL(effective) })
        message.success(`管理后台已切换到 ${effective}，当前页面仍在旧地址`)
      } else {
        message.success('设置已保存')
      }
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="无法读取系统设置"
          description={error}
          action={
            <Button size="small" onClick={() => void load()} loading={loading}>
              重试
            </Button>
          }
        />
      ) : null}

      {listenNotice ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={listenNotice} />
      ) : null}
      {allowNotice ? (
        <Alert type={allowNotice.type} showIcon style={{ marginBottom: 12 }} message={allowNotice.text} />
      ) : null}

      <Spin spinning={loading}>
        <Form
          form={form}
          layout="vertical"
          initialValues={EMPTY_SYSTEM}
          requiredMark={false}
          onFinish={onFinish}
          disabled={loading && !loaded}
        >
          <SettingsSection
            title="基础"
            description="监听地址保存后立即生效；日志级别与主题用于新连接或新设备。"
            first
          >
            <Row gutter={[16, 0]}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="adminListen"
                  label="管理监听地址"
                  extra={
                    envControlled
                      ? `当前由环境变量 ${listen.env || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT'} 控制，修改配置不会改变运行中的端口`
                      : '留空使用默认值；端口被占用或环境变量接管时会保留旧监听'
                  }
                  rules={[
                    {
                      validator: async (_, value: string) => {
                        if (!isValidListen(value)) {
                          throw new Error('格式应为 :8080、127.0.0.1:8080 或 [::1]:8080')
                        }
                      },
                    },
                  ]}
                >
                  <Input placeholder=":8080 或 127.0.0.1:8080" disabled={envControlled} allowClear />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="baseUrl"
                  label="外部访问地址"
                  extra="用于生成回跳链接，可留空"
                  rules={[
                    {
                      validator: async (_, value: string) => {
                        if (!isValidBaseURL(value)) {
                          throw new Error('请输入以 http:// 或 https:// 开头的地址')
                        }
                      },
                    },
                  ]}
                >
                  <Input placeholder="https://admin.example.com" allowClear />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="logLevel" label="日志级别">
                  <Select options={LOG_LEVELS} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="theme" label="默认主题" extra="仅作为新设备的默认值，本机选择保存在浏览器中">
                  <Select options={THEMES} />
                </Form.Item>
              </Col>
            </Row>
          </SettingsSection>

          <SettingsSection
            title="代理与会话"
            description="客户端 IP 的识别方式；只有管理端位于可信代理之后时才需要改动。"
          >
            <Row gutter={[16, 0]}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="trustProxy"
                  label="信任反向代理"
                  valuePropName="checked"
                  extra="使用 X-Forwarded-For 识别客户端 IP，仅在管理端位于可信代理之后时开启"
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="sessionBindIp"
                  label="会话绑定客户端 IP"
                  valuePropName="checked"
                  extra="开启后会话只能从登录时的地址使用（移动网络会频繁重登）；User-Agent 始终校验"
                >
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
          </SettingsSection>

          <SettingsSection
            title="登录与访问控制"
            description="登录限制与管理后台的访问白名单，白名单留空表示不限制。"
          >
            <Row gutter={[16, 0]}>
              <Col xs={24} md={8}>
                <Form.Item
                  name="sessionTtlHours"
                  label="会话有效期（小时）"
                  extra="仅影响之后创建的会话"
                  rules={[{ required: true, message: '请输入会话有效期' }]}
                >
                  <InputNumber min={1} max={720} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  name="loginMaxFail"
                  label="登录失败次数上限"
                  rules={[{ required: true, message: '请输入失败次数上限' }]}
                >
                  <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  name="loginLockMinutes"
                  label="锁定时长（分钟）"
                  rules={[{ required: true, message: '请输入锁定时长' }]}
                >
                  <InputNumber min={1} max={1440} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item
                  name="adminAllowIps"
                  label="管理后台 IP 白名单"
                  extra="支持单个地址与 CIDR，输入后按回车、逗号或分号添加；留空表示不限制"
                  rules={[
                    {
                      validator: async (_, value: string[] | undefined) => {
                        const invalid = (value || []).map((item) => item.trim()).filter((item) => item && !ADDRESS_PATTERN.test(item))
                        if (invalid.length > 0) {
                          throw new Error(`无效的地址：${invalid.join('、')}`)
                        }
                      },
                    },
                  ]}
                >
                  <Select
                    mode="tags"
                    open={false}
                    suffixIcon={null}
                    notFoundContent={null}
                    tokenSeparators={[',', '，', ' ', ';', '；']}
                    placeholder="输入 IP 或 CIDR 后按回车添加"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
            </Row>
          </SettingsSection>

          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!loaded || loading}
            >
              保存设置
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={saving}>
              还原
            </Button>
            {loading ? <Muted>正在读取系统设置…</Muted> : null}
          </Space>

          {listen.actual || listen.config ? (
            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
              }}
            >
              <Muted>
                实际生效：<span className="mono">{listen.actual || '-'}</span>
              </Muted>
              <Muted>
                配置值：<span className="mono">{listen.config || '-'}</span>
              </Muted>
              <Muted>来源：{listen.source === 'env' ? `环境变量 ${listen.env || ''}` : '配置文件'}</Muted>
            </div>
          ) : null}
        </Form>
      </Spin>
    </div>
  )
}
