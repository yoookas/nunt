import { useEffect, useState } from 'react'
import { Alert, App, Form, Input, Modal, Select, Switch, Typography } from 'antd'
import { errorText } from '../../api'
import { modalWidth, Muted } from '../../components'
import { KEY_OPTIONS, normalizeKeyType, type AccountPayload, type AcmeConfig, type KeyOption, type KeyType } from './types'

interface AccountFormValues {
  email: string
  keyType: KeyType
  staging: boolean
}

export interface AccountModalProps {
  open: boolean
  config: AcmeConfig
  keyOptions: KeyOption[]
  onClose: () => void
  onSubmit: (payload: AccountPayload) => Promise<void>
}

export default function AccountModal({ open, config, keyOptions, onClose, onSubmit }: AccountModalProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<AccountFormValues>()
  const [saving, setSaving] = useState(false)
  const [staging, setStaging] = useState(false)

  useEffect(() => {
    if (!open) return
    form.resetFields()
    setStaging(!!config.staging)
    form.setFieldsValue({
      email: config.email || '',
      keyType: normalizeKeyType(config.keyType),
      staging: !!config.staging,
    })
  }, [open, config, form])

  const submit = async () => {
    let values: AccountFormValues
    try {
      await form.validateFields()
      values = form.getFieldsValue(true)
    } catch (err) {
      const fields = (err as { errorFields?: { errors?: string[] }[] })?.errorFields
      message.warning(fields?.[0]?.errors?.[0] || '请检查邮箱格式')
      return
    }

    setSaving(true)
    try {
      await onSubmit({
        email: String(values.email || '').trim(),
        keyType: normalizeKeyType(values.keyType),
        staging: !!values.staging,
      })
      message.success('ACME 设置已保存')
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
      title="ACME 账户设置"
      width={modalWidth()}
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
      styles={{ body: { maxHeight: '68vh', overflowY: 'auto', overflowX: 'hidden' } }}
    >
      <Alert
        type="info"
        showIcon
        message="所有证书任务共用一个 ACME 账户"
        description="证书颁发机构固定为 Let's Encrypt；邮箱用于注册账户和接收 CA 通知。"
        style={{ marginBottom: 20 }}
      />

      <Form form={form} layout="vertical" initialValues={{ email: '', keyType: 'ec256', staging: false }}>
        <Form.Item
          name="staging"
          label="使用 staging（测试）环境"
          valuePropName="checked"
          extra="staging 签发的是浏览器不信任的测试证书，配额宽松，适合调试挑战；切换后需要重新签发，正式使用前务必关闭。"
        >
          <Switch
            checkedChildren="staging"
            unCheckedChildren="生产"
            onChange={(checked) => setStaging(checked)}
          />
        </Form.Item>

        {staging ? (
          <Alert
            type="warning"
            showIcon
            message="当前使用测试环境"
            description="staging 证书不会被浏览器信任，不要配置到对外的 Web 规则上。切换回生产环境后重新签发一次即可。"
            style={{ marginBottom: 20 }}
          />
        ) : null}

        <Form.Item
          name="email"
          label="联系邮箱"
          rules={[{ type: 'email', message: '邮箱格式不正确' }]}
          extra="可留空；保存时提交给 Let's Encrypt 用于账户联系。"
        >
          <Input placeholder="ops@example.com" allowClear autoComplete="email" />
        </Form.Item>

        <Form.Item
          name="keyType"
          label="默认密钥类型"
          extra="新建任务时默认使用该密钥类型，任务内单独设置的值会覆盖这里。"
        >
          <Select options={keyOptions.length ? keyOptions : KEY_OPTIONS} />
        </Form.Item>

        {config.directory ? (
          <div>
            <Muted>ACME 目录</Muted>
            <div style={{ marginTop: 4 }}>
              <Typography.Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {config.directory}
              </Typography.Text>
            </div>
          </div>
        ) : null}
      </Form>
    </Modal>
  )
}
