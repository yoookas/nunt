import { useMemo, useState } from 'react'
import {
  App,
  Button,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons'
import { errorText } from '../../api'
import { splitLines, splitList } from '../../format'
import { Muted } from '../../components'
import {
  CHALLENGE_OPTIONS,
  KEY_OPTIONS,
  normalizeChallenge,
  normalizeKeyType,
  type AcmeJob,
  type AcmeJobPayload,
  type Challenge,
  type KeyOption,
  type KeyType,
  type Provider,
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

export interface JobEditorProps {
  job: AcmeJob | null
  providers: Provider[]
  keyOptions: KeyOption[]
  email: string
  staging: boolean
  saving?: boolean
  issuing?: boolean
  onSave: (id: string, payload: AcmeJobPayload) => Promise<string | void>
  onIssue: (job: AcmeJob) => void
  onDelete: (job: AcmeJob) => void
  onCancel: () => void
}

export default function JobEditor({
  job,
  providers,
  keyOptions,
  email,
  staging,
  saving = false,
  issuing = false,
  onSave,
  onIssue,
  onDelete,
  onCancel,
}: JobEditorProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<JobFormValues>()
  const initialValues = useMemo(() => toFormValues(job), [job])
  const [internalSaving, setInternalSaving] = useState(false)
  const [advanced, setAdvanced] = useState(() => {
    if (!job) return false
    return (
      Number(job.renewDays) !== 30 ||
      !!job.remark ||
      (Array.isArray(job.dnsResolvers) && job.dnsResolvers.length > 0)
    )
  })
  const [challenge, setChallenge] = useState<Challenge>(initialValues.challenge)
  const [dnsProvider, setDnsProvider] = useState(initialValues.dnsProvider)

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
      await form.validateFields()
    } catch (err) {
      const fields = (err as { errorFields?: { errors?: string[] }[] })?.errorFields
      message.warning(fields?.[0]?.errors?.[0] || '请检查表单中的必填项')
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

    setInternalSaving(true)
    try {
      await onSave(job?.id || '', payload)
      message.success(job ? '证书任务已保存' : '证书任务已创建')
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setInternalSaving(false)
    }
  }

  const busy = saving || internalSaving

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{ minWidth: 180, flex: 1 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {job ? job.name || job.id : '新建证书任务'}
          </Typography.Title>
          <Space size={6} wrap>
            <Tag color={staging ? 'orange' : 'green'}>{staging ? 'staging' : '生产'}</Tag>
            <Muted>{`${email || '未设置联系邮箱'} · Let's Encrypt`}</Muted>
          </Space>
        </div>
        <Space wrap size={6}>
          {job ? (
            <Popconfirm
              title="立即签发证书？"
              description="将提交后台签发请求，通常需要几十秒到几分钟。"
              okText="开始签发"
              cancelText="取消"
              onConfirm={() => onIssue(job)}
            >
              <Button size="small" icon={<SyncOutlined />} loading={issuing}>
                签发
              </Button>
            </Popconfirm>
          ) : (
            <Button size="small" onClick={onCancel}>
              取消
            </Button>
          )}
          {job ? (
            <Popconfirm
              title="删除这个证书任务？"
              description="已签发的证书不会被删除。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(job)}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          ) : null}
          <Button size="small" type="primary" icon={<SaveOutlined />} loading={busy} onClick={() => void submit()}>
            保存
          </Button>
        </Space>
      </div>

      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Row gutter={[12, 0]}>
          <Col xs={24} md={14}>
            <Form.Item name="name" label="名称">
              <Input placeholder="留空时使用第一个域名" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="enable" label="自动续期" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="domainsText"
          label="域名"
          rules={[{ required: true, whitespace: true, message: '请填写至少一个域名' }]}
          extra="每行一个域名；泛域名（*.example.com）必须使用 DNS-01 挑战。"
          style={{ marginBottom: 12 }}
        >
          <Input.TextArea
            rows={3}
            placeholder={'example.com\nwww.example.com\n*.example.com'}
            spellCheck={false}
            style={{ fontFamily: MONO }}
          />
        </Form.Item>

        <Row gutter={[12, 0]}>
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

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Switch size="small" checked={advanced} onChange={setAdvanced} />
          <Typography.Text>高级选项</Typography.Text>
          <Muted>续期提前天数、备注与 DNS 解析服务器</Muted>
        </div>

        {advanced ? (
          <Row gutter={[12, 0]}>
            <Col xs={24} md={12}>
              <Form.Item name="renewDays" label="续期提前天数" extra="0 表示默认 30 天，最大 30 天。">
                <InputNumber min={0} max={30} precision={0} style={{ width: '100%' }} suffix="天" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="remark" label="备注">
                <Input placeholder="可选" allowClear />
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
              <div style={{ marginBottom: 12 }}>
                <Muted>{provider.authNote}</Muted>
              </div>
            ) : null}

            {providerFields.length ? (
              <Row gutter={[12, 0]}>
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
              <div style={{ marginBottom: 12 }}>
                <Muted>已保存的凭据显示为 ********；保持原值表示不修改。</Muted>
              </div>
            ) : null}

            {advanced ? (
              <Form.Item
                name="dnsResolversText"
                label="DNS 解析服务器"
                extra="留空时直接检查域名的权威服务器；填写后改为检查这些服务器。"
                style={{ marginTop: 12 }}
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
    </div>
  )
}
