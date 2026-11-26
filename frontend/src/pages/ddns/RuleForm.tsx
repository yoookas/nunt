import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
  theme,
} from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { Muted } from '../../components'
import { splitLines } from '../../format'
import {
  buildDdnsPayload,
  cronError,
  ddnsFormValues,
  fillCreds,
  IP_MODE_OPTIONS,
  isMasked,
  MASK,
  providerTitle,
  RECORD_TYPE_OPTIONS,
  staticIPError,
  type DdnsFormValues,
  type DdnsRule,
  type GetIPFormValues,
  type ProviderField,
  type ProviderMeta,
} from './types'

interface DdnsRuleFormProps {
  /** null means "create". */
  rule: DdnsRule | null
  /** The header switch owns enable: the payload takes it from here. */
  enable: boolean
  providers: ProviderMeta[]
  providersLoading: boolean
  providersError: unknown
  onReloadProviders: () => void
  saving: boolean
  onSubmit: (payload: Record<string, unknown>) => void | Promise<void>
  onCancel?: () => void
  cancelLabel?: string
}

interface FailedField {
  name: (string | number)[]
  errors: string[]
}

const FULL_STYLE = { width: '100%' }

function FormSection({
  title,
  extra,
  first,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  first?: boolean
  children: ReactNode
}) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        marginTop: first ? 0 : 22,
        paddingTop: first ? 0 : 18,
        borderTop: first ? undefined : `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Typography.Text strong>{title}</Typography.Text>
        {extra ? <div style={{ marginLeft: 'auto' }}>{extra}</div> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * The inline DDNS editor: basic, probe, credentials and advanced sections in
 * one scrollable form. It owns validation, provider credential drafts and the
 * payload; the page owns the request, selection and the enable switch.
 */
export default function DdnsRuleForm({
  rule,
  enable,
  providers,
  providersLoading,
  providersError,
  onReloadProviders,
  saving,
  onSubmit,
  onCancel,
  cancelLabel,
}: DdnsRuleFormProps) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<DdnsFormValues>()
  const [testing, setTesting] = useState(false)

  const initial = useMemo<DdnsFormValues>(() => {
    const provider = rule?.provider || providers[0]?.id || ''
    const fields = providers.find((item) => item.id === provider)?.fields || []
    return ddnsFormValues(rule, provider, fields)
  }, [rule, providers])

  const draftsRef = useRef<Record<string, Record<string, string>>>({})
  const draftsLastProvider = useRef(initial.provider)

  const provider = (Form.useWatch('provider', form) as string | undefined) ?? initial.provider
  const ipv4 = (Form.useWatch('ipv4', form) as GetIPFormValues | undefined) ?? initial.ipv4
  const ipv6 = (Form.useWatch('ipv6', form) as GetIPFormValues | undefined) ?? initial.ipv6
  const currentProvider = providers.find((item) => item.id === provider) || null
  const fields = currentProvider?.fields || []
  const providerIsOriginal = Boolean(rule?.id) && provider === (rule?.provider || '')

  const providerOptions = useMemo(() => {
    const out = providers.map((item) => ({ value: item.id, label: item.title || item.id }))
    const original = rule?.provider || ''
    if (original && !out.some((item) => item.value === original)) {
      out.unshift({ value: original, label: original })
    }
    return out
  }, [providers, rule])

  const canReuseMask = (key: string): boolean => providerIsOriginal && Boolean(rule?.creds?.[key])

  const credRule = (field: ProviderField) => ({
    validator: (_rule: unknown, value: unknown) => {
      const text = value == null ? '' : String(value).trim()
      if (text && !text.includes(MASK)) return Promise.resolve()
      if (canReuseMask(field.key)) return Promise.resolve()
      return Promise.reject(new Error(`请填写${field.label}`))
    },
  })

  const staticIPRule = (family: 'ipv4' | 'ipv6') => ({
    validator: (_rule: unknown, value: unknown) => {
      const problem = staticIPError(family, value)
      return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
    },
  })

  const cronRule = {
    validator: (_rule: unknown, value: unknown) => {
      const problem = cronError(value)
      return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
    },
  }

  const handleProviderChange = (next: string) => {
    const prev = draftsLastProvider.current
    if (prev && prev !== next) {
      draftsRef.current[prev] = (form.getFieldValue('creds') || {}) as Record<string, string>
    }
    const nextFields = providers.find((item) => item.id === next)?.fields || []
    const draft = draftsRef.current[next]
    const seed = draft || (rule?.id && next === (rule.provider || '') ? rule.creds || {} : {})
    draftsLastProvider.current = next
    form.setFieldsValue({ provider: next, creds: fillCreds(nextFields, seed) })
  }

  const handleTest = () => {
    const values = form.getFieldsValue(true) as DdnsFormValues
    const domain = String(values.domain || '').trim()
    if (!domain) {
      message.warning('请先填写主域名')
      return
    }
    if (!values.provider) {
      message.warning('请先选择 DNS 提供商')
      return
    }
    if (!fields.length) {
      message.error('没有获取到当前提供商的字段元数据，无法校验')
      return
    }
    const missing = fields
      .filter((field) => field.required && isMasked(values.creds?.[field.key]))
      .map((field) => field.label)
    if (missing.length) {
      message.warning(`校验需要重新填写凭据：${missing.join('、')}。已保存的凭据以掩码回显，无法直接用于校验。`)
      return
    }
    const creds: Record<string, string> = {}
    for (const field of fields) {
      const value = values.creds?.[field.key]
      if (value && !String(value).includes(MASK)) creds[field.key] = String(value)
    }
    const sub = splitLines(values.subDomainsText || '')[0] || '@'
    const type = values.recordType === 'AAAA' ? 'AAAA' : 'A'
    const providerName = providerTitle(providers, values.provider)
    modal.confirm({
      title: '校验提供商凭据',
      content: `会使用当前表单中的凭据，校验「${providerName}」的字段是否完整、客户端能否构造。不会写入或删除任何解析记录。确定继续？`,
      okText: '开始校验',
      cancelText: '取消',
      onOk: async () => {
        setTesting(true)
        try {
          const result = await api.post<{ provider?: string }>('/api/v1/ddns/providers/test', {
            provider: values.provider,
            creds,
            domain,
            sub,
            type,
          })
          message.success(`凭据格式有效：${result?.provider || providerName}（未写入任何记录）`)
        } catch (err) {
          message.error(`校验失败：${errorText(err)}`)
        } finally {
          setTesting(false)
        }
      },
    })
  }

  const submit = () => {
    const values = form.getFieldsValue(true) as DdnsFormValues
    if (enable !== false && !values.ipv4?.enable && !values.ipv6?.enable) {
      message.warning('请至少启用 IPv4 或 IPv6 中的一种公网地址探测')
      return
    }
    const payload = buildDdnsPayload(values, {
      enable,
      fields,
      originalCreds: rule?.creds,
      originalCallback: rule?.callback ?? null,
      providerIsOriginal,
    })
    void onSubmit(payload)
  }

  const handleFinishFailed = ({ errorFields }: { errorFields: FailedField[] }) => {
    const first = errorFields[0]
    message.warning(`请检查表单：${first?.errors?.[0] || '有必填项未填写'}`)
  }

  const renderCredField = (field: ProviderField) => {
    const full = field.key === 'url' || field.key === 'body' || field.key === 'headers'
    return (
      <Col xs={24} md={full ? 24 : 12} key={field.key}>
        <Form.Item
          name={['creds', field.key]}
          label={field.label}
          required={field.required}
          rules={field.required ? [credRule(field)] : []}
          extra={field.help}
        >
          {field.secret ? (
            <Input.Password
              placeholder={field.placeholder || '已保存的凭据不会回显'}
              autoComplete="new-password"
            />
          ) : field.key === 'body' || field.key === 'headers' ? (
            <Input.TextArea rows={3} placeholder={field.placeholder || ''} className="mono" />
          ) : (
            <Input
              placeholder={field.placeholder || ''}
              className={field.key === 'url' ? 'mono' : undefined}
            />
          )}
        </Form.Item>
      </Col>
    )
  }

  const probeCard = (family: 'ipv4' | 'ipv6', group: GetIPFormValues) => (
    <Card
      size="small"
      title={family === 'ipv4' ? 'IPv4（A 记录）' : 'IPv6（AAAA 记录）'}
      style={{ marginTop: family === 'ipv4' ? 0 : 12 }}
      styles={{ body: { padding: 12 } }}
      extra={
        <Form.Item noStyle name={[family, 'enable']} valuePropName="checked">
          <Switch size="small" aria-label={`启用 ${family} 探测`} />
        </Form.Item>
      }
    >
      {group.enable ? (
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name={[family, 'mode']} label="探测方式">
              <Select options={IP_MODE_OPTIONS} />
            </Form.Item>
          </Col>
          {group.mode === 'interface' ? (
            <Col xs={24} md={12}>
              <Form.Item name={[family, 'iface']} label="网卡名称" extra="留空时自动选择默认网卡。">
                <Input placeholder="例如 eth0" />
              </Form.Item>
            </Col>
          ) : group.mode === 'url' ? (
            <>
              <Col xs={24} md={12}>
                <Form.Item
                  name={[family, 'value']}
                  label="获取地址"
                  extra={
                    family === 'ipv4'
                      ? '返回纯文本 IP 的接口；留空时使用内置公共探测服务。'
                      : '返回纯文本 IPv6 的接口；留空时使用内置公共探测服务。'
                  }
                >
                  <Input
                    placeholder={family === 'ipv4' ? 'https://api.ipify.org' : 'https://api64.ipify.org'}
                    className="mono"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name={[family, 'regex']} label="提取正则" extra="可选：从响应中提取 IP 的正则。">
                  <Input placeholder={family === 'ipv4' ? '例如 ([0-9.]+)' : '例如 ([0-9a-fA-F:]+)'} className="mono" />
                </Form.Item>
              </Col>
            </>
          ) : (
            <Col xs={24} md={12}>
              <Form.Item name={[family, 'value']} label="静态地址" rules={[staticIPRule(family)]}>
                <Input placeholder={family === 'ipv4' ? '1.2.3.4' : '2001:db8::1'} className="mono" />
              </Form.Item>
            </Col>
          )}
        </Row>
      ) : (
        <Muted>{family === 'ipv4' ? '关闭后不写入 A 记录。' : '关闭后不写入 AAAA 记录。'}</Muted>
      )}
    </Card>
  )

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initial}
      onFinish={submit}
      onFinishFailed={handleFinishFailed}
      scrollToFirstError
      style={{ marginBottom: 0 }}
    >
      <FormSection title="基础信息" first>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item
              name="name"
              label="名称"
              rules={[{ required: true, whitespace: true, message: '请填写规则名称' }]}
            >
              <Input placeholder="例如：家里宽带" maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="provider"
              label="DNS 提供商"
              rules={[{ required: true, message: '请选择 DNS 提供商' }]}
              extra={
                providersError
                  ? '无法读取提供商元数据，请点「提供商凭据」里的重试按钮。'
                  : currentProvider?.authNote || '提供商与凭据字段由 /api/v1/ddns/providers 动态提供。'
              }
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={providersLoading}
                options={providerOptions}
                placeholder="选择 DNS 提供商"
                onChange={handleProviderChange}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="recordType" label="记录类型" extra="实际写入的 A / AAAA 记录由下方 IPv4 / IPv6 探测开关决定。">
              <Select options={RECORD_TYPE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="domain"
              label="主域名"
              rules={[{ required: true, whitespace: true, message: '请填写主域名' }]}
              extra="填写根域名；子域名在下一项单独维护。"
            >
              <Input placeholder="example.com" className="mono" />
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item
              name="subDomainsText"
              label="子域名"
              extra="每行一个；@ 表示主域名，* 表示泛解析；留空等同于 @。"
            >
              <Input.TextArea rows={3} placeholder={'@\nwww\n*'} className="mono" />
            </Form.Item>
          </Col>
        </Row>
      </FormSection>

      <FormSection title="公网 IP 探测" extra={<Muted>至少启用一个地址族</Muted>}>
        {probeCard('ipv4', ipv4)}
        {probeCard('ipv6', ipv6)}
      </FormSection>

      <FormSection
        title="提供商凭据"
        extra={
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            loading={testing}
            disabled={!fields.length}
            onClick={handleTest}
          >
            校验凭据
          </Button>
        }
      >
        {providersError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="无法读取 DNS 提供商列表"
            description={errorText(providersError)}
            action={
              <Button size="small" onClick={onReloadProviders}>
                重试
              </Button>
            }
          />
        ) : null}

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="凭据以掩码回显"
          description={`已保存的凭据以 ${MASK} 回显，保持掩码或清空都表示不修改；校验凭据需要重新填写。校验只检查字段与客户端构造，不会写入或删除解析记录。`}
        />

        {fields.length ? (
          <Row gutter={16}>{fields.map(renderCredField)}</Row>
        ) : (
          <Alert
            type="warning"
            showIcon
            message="没有获取到该提供商的字段说明"
            description="重新加载提供商列表后再试；直接保存会保留已保存的凭据不变。"
          />
        )}
      </FormSection>

      <FormSection title="高级选项" extra={<Muted>未填时使用后端默认值</Muted>}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="ttl" label="TTL（秒）" extra="0 表示由后端补默认值（600）。">
              <InputNumber min={0} max={86400} precision={0} style={FULL_STYLE} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="intervalSec" label="检查间隔（秒）" extra="cron 为空时按此间隔执行，默认 300 秒。">
              <InputNumber min={0} max={604800} precision={0} style={FULL_STYLE} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="cron"
              label="Cron 表达式"
              rules={[cronRule]}
              extra="非空时优先于检查间隔；5 段表达式，例如 */5 * * * *。"
            >
              <Input placeholder="*/5 * * * *" className="mono" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="remark" label="备注">
              <Input placeholder="备注（可选）" maxLength={128} />
            </Form.Item>
          </Col>
        </Row>

        {rule?.callback ? (
          <Alert
            type="info"
            showIcon
            message="旧版自定义回调配置已保留"
            description={
              <Space size={4} wrap>
                <span className="mono">
                  {rule.callback.method || 'GET'} {rule.callback.url || ''}
                </span>
                <Muted>
                  会在保存时原样保留，本表单不修改它。需要使用自定义回调时，请选择「自定义回调」提供商并在「提供商凭据」中填写
                  URL / 方法 / 请求头 / 请求体。
                </Muted>
              </Space>
            }
          />
        ) : null}
      </FormSection>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        {onCancel ? <Button onClick={onCancel}>{cancelLabel || '取消'}</Button> : null}
        <Button onClick={() => form.resetFields()} disabled={saving}>
          还原
        </Button>
        <Button type="primary" loading={saving} onClick={() => form.submit()}>
          {rule ? '保存' : '创建'}
        </Button>
      </div>
    </Form>
  )
}
