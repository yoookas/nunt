import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Switch,
  Typography,
} from 'antd'
import { errorText } from '../../api'
import { modalWidth, Muted } from '../../components'
import { splitLines, splitList } from '../../format'
import {
  CHALLENGE_OPTIONS,
  KEY_OPTIONS,
  type AcmeJob,
  type AcmeJobPayload,
  type Challenge,
  type KeyOption,
  type KeyType,
  type Provider,
  normalizeChallenge,
  normalizeKeyType,
} from './types'

interface JobFormValues {
  name: string
  enable: boolean
  domainsText: string
  keyType: KeyType
  challenge: Challenge
  dnsProvider: string
  dnsCreds: Record<string, string>
  dnsResolversText: string
  renewDays: number
  remark: string
}

const EMPTY_JOB_VALUES: JobFormValues = {
  name: '',
  enable: true,
  domainsText: '',
  keyType: 'ec256',
  challenge: 'http',
  dnsProvider: '',
  dnsCreds: {},
  dnsResolversText: '',
  renewDays: 30,
  remark: '',
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function toFormValues(job: AcmeJob | null): JobFormValues {
  return {
    name: job?.name || '',
    enable: job?.enable !== false,
    domainsText: (job?.domains || []).join('\n'),
    keyType: normalizeKeyType(job?.keyType),
    challenge: normalizeChallenge(job?.challenge),
    dnsProvider: job?.dnsProvider || '',
    dnsCreds: job?.dnsCreds ? { ...job.dnsCreds } : {},
    dnsResolversText: (job?.dnsResolvers || []).join('\n'),
    renewDays: Number(job?.renewDays) || 30,
    remark: job?.remark || '',
  }
}

export interface JobModalProps {
  open: boolean
  job: AcmeJob | null
  providers: Provider[]
  keyOptions: KeyOption[]
  email: string
  staging: boolean
  onClose: () => void
  onSubmit: (id: string, payload: AcmeJobPayload) => Promise<void>
}

export default function JobModal({
  open,
  job,
  providers,
  keyOptions,
  email,
  staging,
  onClose,
  onSubmit,
}: JobModalProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<JobFormValues>()
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [challenge, setChallenge] = useState<Challenge>('http')
  const [dnsProvider, setDnsProvider] = useState('')

  const provider = useMemo(
    () => providers.find((item) => item.id === dnsProvider),
    [providers, dnsProvider],
  )
  const providerFields = provider?.fields ?? []

  const providerOptions = useMemo(() => {
    const list = providers.map((item) => ({ value: item.id, label: item.title }))
    if (dnsProvider && !list.some((item) => item.value === dnsProvider)) {
      list.push({ value: dnsProvider, label: `${dnsProvider}（未在提供商列表中）` })
    }
    return list
  }, [providers, dnsProvider])

  useEffect(() => {
    if (!open) return
    const values = toFormValues(job)
    setChallenge(values.challenge)
    setDnsProvider(values.dnsProvider)
    setAdvanced(
      !!job &&
        (Number(job.renewDays) !== 30 ||
          !!job.remark ||
          (Array.isArray(job.dnsResolvers) && job.dnsResolvers.length > 0)),
    )
    form.resetFields()
    form.setFieldsValue(values)
  }, [open, job, form])

  const handleProviderChange = (value: string) => {
    const fields = providers.find((item) => item.id === value)?.fields ?? []
    const creds: Record<string, string> = {}
    for (const field of fields) {
      creds[field.key] = job?.dnsProvider === value ? job.dnsCreds?.[field.key] || '' : ''
    }
    setDnsProvider(value)
    form.setFieldValue('dnsProvider', value)
    form.setFieldValue('dnsCreds', creds)
  }

  const handleChallengeChange = (value: Challenge) => {
    setChallenge(value)
    form.setFieldValue('challenge', value)
  }

  const submit = async () => {
    try {
      // Advanced fields may be collapsed, but their values live in the form
      // store; validate the visible inputs and then read the whole store.
      await form.validateFields()
    } catch (err) {
      const fields = (err as { errorFields?: { errors?: string[] }[] })?.errorFields
      message.warning(fields?.[0]?.errors?.[0] || '请检查表单中标记的必填项')
      return
    }

    const values = form.getFieldsValue(true)
    const domains = splitList(values.domainsText || '')
    if (!domains.length) {
      message.warning('请至少填写一个域名')
      return
    }

    const activeChallenge = normalizeChallenge(values.challenge)
    if (activeChallenge !== 'dns' && domains.some((domain) => domain.startsWith('*.'))) {
      message.warning('泛域名必须使用 DNS-01 挑战')
      return
    }
    if (activeChallenge === 'dns' && !values.dnsProvider) {
      message.warning('DNS-01 挑战需要选择 DNS 提供商')
      return
    }

    const creds: Record<string, string> = activeChallenge === 'dns' ? { ...(job?.dnsCreds || {}) } : {}
    if (activeChallenge === 'dns') {
      // Only the currently selected provider's fields are written; the stored
      // masked values from the job are kept so a save cannot drop a secret.
      for (const field of providerFields) {
        const value = String(values.dnsCreds?.[field.key] || '').trim()
        if (value) creds[field.key] = value
      }
    }

    const rawDays = Number(values.renewDays)
    const payload: AcmeJobPayload = {
      name: String(values.name || '').trim(),
      enable: !!values.enable,
      domains,
      keyType: normalizeKeyType(values.keyType),
      challenge: activeChallenge,
      dnsProvider: activeChallenge === 'dns' ? values.dnsProvider : '',
      dnsCreds: creds,
      dnsResolvers: activeChallenge === 'dns' ? splitLines(values.dnsResolversText || '') : [],
      renewDays: Number.isFinite(rawDays) ? Math.max(0, Math.min(30, Math.floor(rawDays))) : 30,
      remark: String(values.remark || '').trim(),
    }

    setSaving(true)
    try {
      await onSubmit(job?.id || '', payload)
      message.success('证书任务已保存')
      onClose()
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={job ? '编辑证书任务' : '新建证书任务'}
      width={modalWidth(true)}
      onCancel={() => {
        if (!saving) onClose()
      }}
      onOk={() => void submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: saving }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      maskClosable={!saving}
      styles={{ body: { maxHeight: '68vh', overflowY: 'auto', overflowX: 'hidden', paddingRight: 8 } }}
    >
      <Alert
        type={staging ? 'warning' : 'info'}
        showIcon
        message={staging ? '当前使用 staging 测试环境' : '当前使用 Let\'s Encrypt 生产环境'}
        description={`账户邮箱：${email || '未设置'}；环境与邮箱可在「ACME 设置」中修改。`}
        style={{ marginBottom: 16 }}
      />

      <Form form={form} layout="vertical" initialValues={EMPTY_JOB_VALUES}>
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item
              name="name"
              label="名称"
              extra="留空时使用第一个域名，仅用于在列表中区分任务。"
            >
              <Input placeholder="例如：主站证书" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item
              name="enable"
              label="启用自动续期"
              valuePropName="checked"
              extra="关闭后仍可手动签发，但不会参与定时续期。"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="domainsText"
          label="域名"
          rules={[{ required: true, whitespace: true, message: '请填写至少一个域名' }]}
          extra="每行一个域名；泛域名（*.example.com）必须使用 DNS-01 挑战。"
        >
          <Input.TextArea rows={4} placeholder={'example.com\nwww.example.com\n*.example.com'} spellCheck={false} />
        </Form.Item>

        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="challenge" label="挑战方式">
              <Select
                options={CHALLENGE_OPTIONS}
                onChange={(value: Challenge) => handleChallengeChange(value)}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="keyType" label="密钥类型">
              <Select options={keyOptions.length ? keyOptions : KEY_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Switch size="small" checked={advanced} onChange={setAdvanced} />
          <Typography.Text>高级选项</Typography.Text>
          <Muted>续期提前天数、备注与 DNS 解析服务器</Muted>
        </div>

        {advanced ? (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="renewDays"
                label="续期提前天数"
                extra="0 表示使用默认的 30 天，最大值 30 天。"
              >
                <InputNumber min={0} max={30} precision={0} style={{ width: '100%' }} suffix="天" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="remark" label="备注">
                <Input placeholder="备注（可选）" allowClear />
              </Form.Item>
            </Col>
          </Row>
        ) : null}

        {challenge === 'dns' ? (
          <>
            <Divider orientation="left" orientationMargin={0} plain>
              DNS 挑战
            </Divider>
            <Form.Item
              name="dnsProvider"
              label="DNS 提供商"
              rules={[{ required: true, message: '请选择 DNS 提供商' }]}
            >
              <Select
                options={providerOptions}
                placeholder="选择 DNS 提供商"
                showSearch
                optionFilterProp="label"
                onChange={(value: string) => handleProviderChange(value)}
              />
            </Form.Item>

            {provider?.authNote ? (
              <Alert
                type="info"
                showIcon
                message="提供商说明"
                description={provider.authNote}
                style={{ marginBottom: 16 }}
              />
            ) : null}

            {providerFields.length ? (
              <Row gutter={16}>
                {providerFields.map((field) => (
                  <Col xs={24} md={12} key={field.key}>
                    <Form.Item
                      name={['dnsCreds', field.key]}
                      label={field.label}
                      rules={
                        field.required
                          ? [{ required: true, whitespace: true, message: `请填写 ${field.label}` }]
                          : undefined
                      }
                      extra={field.help || undefined}
                    >
                      {field.secret ? (
                        <Input.Password
                          autoComplete="new-password"
                          placeholder={
                            field.placeholder || (job ? '留空或保持 ******** 表示不修改' : '')
                          }
                        />
                      ) : (
                        <Input placeholder={field.placeholder || (job ? '留空表示不修改' : '')} />
                      )}
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            ) : null}

            {job && providerFields.length ? (
              <Muted>
                已保存的凭据显示为 ********；保持原值表示不修改，填写新值才会覆盖。
              </Muted>
            ) : null}

            {advanced ? (
              <Form.Item
                name="dnsResolversText"
                label="DNS 解析服务器"
                extra="留空时直接检查域名的权威服务器；填写后改为检查这些服务器。"
                style={{ marginTop: 16 }}
              >
                <Input.TextArea
                  rows={2}
                  placeholder={'每行一个，例如：\n1.1.1.1:53\n8.8.8.8:53'}
                  spellCheck={false}
                  style={{ fontFamily: MONO }}
                />
              </Form.Item>
            ) : null}
          </>
        ) : null}
      </Form>
    </Modal>
  )
}
