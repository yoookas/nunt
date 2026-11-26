import { useEffect, useState } from 'react'
import { App, Button, Col, Form, Input, Modal, Row, Space, Upload } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { errorText } from '../../api'
import { modalWidth, Muted } from '../../components'
import { splitList } from '../../format'
import type { UploadPayload } from './types'

interface UploadFormValues {
  name: string
  domainsText: string
  cert: string
  key: string
  chain: string
}

const EMPTY_VALUES: UploadFormValues = {
  name: '',
  domainsText: '',
  cert: '',
  key: '',
  chain: '',
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export interface UploadModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (payload: UploadPayload) => Promise<void>
}

export default function UploadModal({ open, onClose, onSubmit }: UploadModalProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<UploadFormValues>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue(EMPTY_VALUES)
  }, [open, form])

  const submit = async () => {
    let values: UploadFormValues
    try {
      await form.validateFields()
      values = form.getFieldsValue(true)
    } catch (err) {
      const fields = (err as { errorFields?: { errors?: string[] }[] })?.errorFields
      message.warning(fields?.[0]?.errors?.[0] || '证书和私钥都是必填项')
      return
    }

    const cert = String(values.cert || '').trim()
    const key = String(values.key || '').trim()
    if (!cert || !key) {
      message.warning('证书和私钥都是必填项')
      return
    }
    const chain = String(values.chain || '').trim()
    const payload: UploadPayload = {
      name: String(values.name || '').trim(),
      domains: splitList(String(values.domainsText || '')),
      cert,
      certificate: cert,
      key,
      privateKey: key,
    }
    if (chain) payload.chain = chain

    setSaving(true)
    try {
      await onSubmit(payload)
      message.success('证书已上传')
      onClose()
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const pemLabel = (text: string, field: 'cert' | 'key' | 'chain', accept: string) => (
    <Space size={6}>
      <span>{text}</span>
      <Upload
        accept={accept}
        showUploadList={false}
        beforeUpload={(file) => {
          void file
            .text()
            .then((content) => {
              form.setFieldValue(field, content)
              message.success(`已读取 ${file.name}`)
            })
            .catch(() => message.error('读取文件失败'))
          return false
        }}
      >
        <Button type="link" size="small" icon={<FolderOpenOutlined />} style={{ padding: 0, height: 'auto' }}>
          选择文件
        </Button>
      </Upload>
    </Space>
  )

  return (
    <Modal
      open={open}
      title="上传证书"
      width={modalWidth(true)}
      onCancel={() => {
        if (!saving) onClose()
      }}
      onOk={() => void submit()}
      okText="上传"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: saving }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      maskClosable={!saving}
      styles={{ body: { maxHeight: '68vh', overflowY: 'auto', overflowX: 'hidden', paddingRight: 8 } }}
    >
      <Form form={form} layout="vertical" initialValues={EMPTY_VALUES}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="备注（可选）">
              <Input placeholder="例如：旧服务器证书" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="domainsText"
              label="域名（可选）"
              extra="留空时从证书的 SAN 读取；多个域名用逗号分隔。"
            >
              <Input placeholder="example.com, *.example.com" allowClear />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="cert"
          label={pemLabel('证书（PEM）', 'cert', '.pem,.crt,.cer,.txt')}
          rules={[{ required: true, whitespace: true, message: '请填写证书 PEM' }]}
          extra="可以粘贴 PEM 文本，也可以从文件读取；需要包含完整的中间证书链。"
        >
          <Input.TextArea
            rows={5}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellCheck={false}
            style={{ fontFamily: MONO }}
          />
        </Form.Item>

        <Form.Item
          name="key"
          label={pemLabel('私钥（PEM）', 'key', '.pem,.key,.txt')}
          rules={[{ required: true, whitespace: true, message: '请填写私钥 PEM' }]}
          extra="私钥只会保存在服务端；页面上再次打开时不会回显。"
        >
          <Input.TextArea
            rows={5}
            placeholder="-----BEGIN PRIVATE KEY-----"
            spellCheck={false}
            style={{ fontFamily: MONO }}
          />
        </Form.Item>

        <Form.Item
          name="chain"
          label={pemLabel('中间证书链（可选）', 'chain', '.pem,.crt,.cer,.txt')}
          extra="如果证书文本里已经包含中间链，可以留空。"
        >
          <Input.TextArea
            rows={3}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellCheck={false}
            style={{ fontFamily: MONO }}
          />
        </Form.Item>
        <Muted>上传的证书不会自动续期；如需自动续期，请创建证书任务。</Muted>
      </Form>
    </Modal>
  )
}
