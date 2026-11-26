import { useMemo, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tabs,
} from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { modalWidth, Muted } from '../../components'
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

interface RuleModalProps {
  open: boolean
  /** null means "create". */
  rule: DdnsRule | null
  providers: ProviderMeta[]
  providersLoading: boolean
  providersError: unknown
  onReloadProviders: () => void
  onClose: () => void
  onSaved: () => void | Promise<void>
}

interface FailedField {
  name: (string | number)[]
  errors: string[]
}

const FULL_STYLE = { width: '100%' }

export default function DdnsRuleModal({
  open,
  rule,
  providers,
  providersLoading,
  providersError,
  onReloadProviders,
  onClose,
  onSaved,
}: RuleModalProps) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<DdnsFormValues>()
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [activeTab, setActiveTab] = useState('basic')

  const initial = useMemo<DdnsFormValues>(() => {
    const provider = rule?.provider || providers[0]?.id || ''
    const fields = providers.find((item) => item.id === provider)?.fields || []
    return ddnsFormValues(rule, provider, fields)
  }, [rule, providers])

  const draftsRef = useRef<Record<string, Record<string, string>>>({})
  const draftsLastProvider = useRef(initial.provider)

  const provider = (Form.useWatch('provider', form) as string | undefined) ?? initial.provider
  const ipv4 =
    (Form.useWatch('ipv4', form) as GetIPFormValues | undefined) ?? initial.ipv4
  const ipv6 =
    (Form.useWatch('ipv6', form) as GetIPFormValues | undefined) ?? initial.ipv6
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

  const staticCredRule = (family: 'ipv4' | 'ipv6') => ({
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
    const seed =
      draft || (rule?.id && next === (rule.provider || '') ? rule.creds || {} : {})
    draftsLastProvider.current = next
    form.setFieldsValue({ provider: next, creds: fillCreds(nextFields, seed) })
  }

  const handleTest = () => {
    const values = form.getFieldsValue(true) as DdnsFormValues
    const domain = String(values.domain || '').trim()
    if (!domain) {
      setActiveTab('basic')
      message.warning('请先填写主域名')
      return
    }
    if (!values.provider) {
      setActiveTab('basic')
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

  const submit = async () => {
    const values = form.getFieldsValue(true) as DdnsFormValues
    if (values.enable !== false && !values.ipv4?.enable && !values.ipv6?.enable) {
      setActiveTab('basic')
      message.warning('请至少启用 IPv4 或 IPv6 中的一种公网地址探测')
      return
    }
    const payload = buildDdnsPayload(values, {
      fields,
      originalCreds: rule?.creds,
      originalCallback: rule?.callback ?? null,
      providerIsOriginal,
    })
    setSaving(true)
    try {
      if (rule?.id) {
        await api.put(`/api/v1/ddns/rules/${encodeURIComponent(rule.id)}`, payload)
        message.success('规则已保存')
      } else {
        await api.post('/api/v1/ddns/rules', payload)
        message.success('规则已创建')
      }
      await onSaved()
      onClose()
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const handleFinishFailed = ({ errorFields }: { errorFields: FailedField[] }) => {
    const first = errorFields[0]
    const root = String(first?.name?.[0] ?? '')
    if (root === 'creds') {
      setActiveTab('creds')
    } else if (['ttl', 'intervalSec', 'cron', 'remark'].includes(root)) {
      setActiveTab('advanced')
    } else {
      setActiveTab('basic')
    }
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
            <Input placeholder={field.placeholder || ''} className={field.key === 'url' ? 'mono' : undefined} />
          )}
        </Form.Item>
      </Col>
    )
  }

  const basicTab = (
    <>
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
          <Form.Item name="enable" label="启用状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Col>

        <Col xs={24} md={12}>
          <Form.Item
            name="provider"
            label="DNS 提供商"
            rules={[{ required: true, message: '请选择 DNS 提供商' }]}
            extra={
              providersError
                ? '无法读取提供商元数据，请点「凭据」页的重试按钮。'
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
          <Form.Item
            name="recordType"
            label="记录类型"
            extra="实际写入的 A / AAAA 记录由下方 IPv4 / IPv6 探测开关决定。"
          >
            <Select options={RECORD_TYPE_OPTIONS} />
          </Form.Item>
        </Col>

        <Col xs={24}>
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
            <Input.TextArea rows={4} placeholder={'@\nwww\n*'} className="mono" />
          </Form.Item>
        </Col>
      </Row>

      <Muted>至少启用一个地址族；启用的地址族需要一个可用的公网地址探测方式。</Muted>

      <Card
        size="small"
        title="IPv4（A 记录）"
        style={{ marginTop: 8 }}
        styles={{ body: { padding: 12 } }}
        extra={
          <Form.Item noStyle name={['ipv4', 'enable']} valuePropName="checked">
            <Switch size="small" aria-label="启用 IPv4 探测" />
          </Form.Item>
        }
      >
        {ipv4.enable ? (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name={['ipv4', 'mode']} label="探测方式">
                <Select options={IP_MODE_OPTIONS} />
              </Form.Item>
            </Col>
            {ipv4.mode === 'interface' ? (
              <Col xs={24} md={12}>
                <Form.Item
                  name={['ipv4', 'iface']}
                  label="网卡名称"
                  extra="留空时自动选择默认网卡。"
                >
                  <Input placeholder="例如 eth0" />
                </Form.Item>
              </Col>
            ) : ipv4.mode === 'url' ? (
              <>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['ipv4', 'value']}
                    label="获取地址"
                    extra="返回纯文本 IP 的接口；留空时使用内置公共探测服务。"
                  >
                    <Input placeholder="https://api.ipify.org" className="mono" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['ipv4', 'regex']}
                    label="提取正则"
                    extra="可选：从响应中提取 IP 的正则。"
                  >
                    <Input placeholder="例如 ([0-9.]+)" className="mono" />
                  </Form.Item>
                </Col>
              </>
            ) : (
              <Col xs={24} md={12}>
                <Form.Item
                  name={['ipv4', 'value']}
                  label="静态地址"
                  rules={[staticCredRule('ipv4')]}
                >
                  <Input placeholder="1.2.3.4" className="mono" />
                </Form.Item>
              </Col>
            )}
          </Row>
        ) : (
          <Muted>关闭后不写入 A 记录。</Muted>
        )}
      </Card>

      <Card
        size="small"
        title="IPv6（AAAA 记录）"
        style={{ marginTop: 12 }}
        styles={{ body: { padding: 12 } }}
        extra={
          <Form.Item noStyle name={['ipv6', 'enable']} valuePropName="checked">
            <Switch size="small" aria-label="启用 IPv6 探测" />
          </Form.Item>
        }
      >
        {ipv6.enable ? (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name={['ipv6', 'mode']} label="探测方式">
                <Select options={IP_MODE_OPTIONS} />
              </Form.Item>
            </Col>
            {ipv6.mode === 'interface' ? (
              <Col xs={24} md={12}>
                <Form.Item
                  name={['ipv6', 'iface']}
                  label="网卡名称"
                  extra="留空时自动选择默认网卡。"
                >
                  <Input placeholder="例如 eth0" />
                </Form.Item>
              </Col>
            ) : ipv6.mode === 'url' ? (
              <>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['ipv6', 'value']}
                    label="获取地址"
                    extra="返回纯文本 IPv6 的接口；留空时使用内置公共探测服务。"
                  >
                    <Input placeholder="https://api64.ipify.org" className="mono" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name={['ipv6', 'regex']}
                    label="提取正则"
                    extra="可选：从响应中提取 IP 的正则。"
                  >
                    <Input placeholder="例如 ([0-9a-fA-F:]+)" className="mono" />
                  </Form.Item>
                </Col>
              </>
            ) : (
              <Col xs={24} md={12}>
                <Form.Item
                  name={['ipv6', 'value']}
                  label="静态地址"
                  rules={[staticCredRule('ipv6')]}
                >
                  <Input placeholder="2001:db8::1" className="mono" />
                </Form.Item>
              </Col>
            )}
          </Row>
        ) : (
          <Muted>关闭后不写入 AAAA 记录。</Muted>
        )}
      </Card>
    </>
  )

  const credTab = (
    <>
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
        style={{ marginBottom: 16 }}
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

      <Button
        icon={<SafetyCertificateOutlined />}
        loading={testing}
        disabled={!fields.length}
        onClick={handleTest}
        style={{ marginTop: 8 }}
      >
        校验凭据
      </Button>
    </>
  )

  const advancedTab = (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="高级选项都有后端默认值"
        description="TTL 默认 600 秒，检查间隔默认 300 秒；填写 cron 后以 cron 为准。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="ttl" label="TTL（秒）" extra="0 表示由后端补默认值（600）。">
            <InputNumber min={0} max={86400} precision={0} style={FULL_STYLE} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="intervalSec"
            label="检查间隔（秒）"
            extra="cron 为空时按此间隔执行，默认 300 秒。"
          >
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
            <>
              已保存的回调{' '}
              <span className="mono">
                {rule.callback.method || 'GET'} {rule.callback.url || ''}
              </span>{' '}
              会在保存时原样保留，本表单不修改它。需要使用自定义回调时，请选择「自定义回调」提供商并在「凭据」页填写
              URL / 方法 / 请求头 / 请求体。
            </>
          }
        />
      ) : null}
    </>
  )

  return (
    <Modal
      open={open}
      title={rule?.id ? '编辑 DDNS 规则' : '新建 DDNS 规则'}
      width={modalWidth(true)}
      onCancel={() => {
        if (!saving) onClose()
      }}
      maskClosable={false}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100dvh - 240px)', overflowY: 'auto', paddingTop: 4 } }}
      footer={
        <Space>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="primary" loading={saving} onClick={() => form.submit()}>
            保存
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initial}
        onFinish={submit}
        onFinishFailed={handleFinishFailed}
        scrollToFirstError
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'basic', label: '基础', forceRender: true, children: basicTab },
            { key: 'creds', label: '凭据', forceRender: true, children: credTab },
            { key: 'advanced', label: '高级', forceRender: true, children: advancedTab },
          ]}
        />
      </Form>
    </Modal>
  )
}
