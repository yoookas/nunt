import AccessEditor from '../../components/AccessEditor'
import { useMemo } from 'react'
import { Button, Col, Form, Input, InputNumber, Row, Select } from 'antd'
import {
  buildRulePayload,
  listenError,
  PROTOCOL_OPTIONS,
  ruleFormValues,
  type ForwardRule,
  type RuleFormValues,
} from './types'

interface ForwardRuleFormProps {
  /** null means "create". */
  rule: ForwardRule | null
  /** The header switch owns enable: the payload takes it from here. */
  enable: boolean
  saving: boolean
  onSubmit: (payload: Record<string, unknown>) => void | Promise<void>
  onCancel?: () => void
  cancelLabel?: string
}

const NUM_STYLE = { width: '100%' }

/**
 * The inline rule editor. It owns validation and payload building; the page
 * owns the request and the selection. Mount it with a key per rule so the
 * form starts from the right values.
 */
export default function ForwardRuleForm({
  rule,
  enable,
  saving,
  onSubmit,
  onCancel,
  cancelLabel,
}: ForwardRuleFormProps) {
  const [form] = Form.useForm<RuleFormValues>()
  const initial = useMemo(() => ruleFormValues(rule), [rule])

  const submit = () => {
    // getFieldsValue(true) keeps values of the access fields that unmount while
    // the filter is off, so switching the filter back on in the same edit does
    // not lose the list.
    const values = form.getFieldsValue(true) as RuleFormValues
    const payload = buildRulePayload(values, { enable })
    void onSubmit(payload)
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initial}
      onFinish={submit}
      scrollToFirstError
      style={{ marginBottom: 0 }}
    >
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: '请填写规则名称' }]}
          >
            <Input placeholder="例如：远程桌面" maxLength={64} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="protocol" label="协议" rules={[{ required: true, message: '请选择协议' }]}>
            <Select options={PROTOCOL_OPTIONS} />
          </Form.Item>
        </Col>

        <Col xs={24} md={12}>
          <Form.Item
            name="srcAddr"
            label="监听地址"
            extra="本机监听地址，可以省略 IP，只写端口。"
            rules={[
              {
                validator: (_rule, value) => {
                  const problem = listenError(value, '监听地址')
                  return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
                },
              },
            ]}
          >
            <Input placeholder=":3389 或 0.0.0.0:3389" className="mono" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="dstAddr"
            label="目标地址"
            extra="流量要转发到的内网地址。"
            rules={[
              {
                validator: (_rule, value) => {
                  const problem = listenError(value, '目标地址')
                  return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
                },
              },
            ]}
          >
            <Input placeholder="192.168.1.10:3389" className="mono" />
          </Form.Item>
        </Col>

        <Col xs={24} md={12}>
          <Form.Item
            name="timeoutSec"
            label="空闲超时（秒）"
            extra="0 表示使用默认 300 秒；这是空闲超时，不会因为连接总时长被断开。"
          >
            <InputNumber min={0} max={86400} precision={0} style={NUM_STYLE} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="maxConns"
            label="规则并发上限"
            extra="0 表示由后端补默认上限（1024）；这是连接数上限，不是带宽限速。"
          >
            <InputNumber min={0} max={1000000} precision={0} style={NUM_STYLE} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="maxConnsPerIP"
            label="单 IP 并发上限"
            extra="0 表示由后端补默认上限（64）。"
          >
            <InputNumber min={0} max={100000} precision={0} style={NUM_STYLE} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="remark" label="备注">
            <Input placeholder="备注（可选）" maxLength={128} />
          </Form.Item>
        </Col>

        <Col xs={24}>
          <Form.Item
            name="access"
            label="访问控制"
            extra="从上到下匹配，第一条命中的规则生效；端口转发没有 User-Agent，因此不提供客户端规则。"
          >
            <AccessEditor allowUA={false} allowInherit={false} />
          </Form.Item>
        </Col>
      </Row>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
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
