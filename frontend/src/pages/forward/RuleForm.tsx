import { useMemo } from 'react'
import { Alert, Button, Col, Form, Input, InputNumber, Row, Select, Space, Tag } from 'antd'
import { Muted } from '../../components'
import {
  ACCESS_LABEL,
  ACCESS_OPTIONS,
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
  const accessMode = Form.useWatch('accessMode', form) ?? initial.accessMode

  const originalUaMode = rule?.access?.uaMode || 'off'
  const originalUas = Array.isArray(rule?.access?.uas) ? rule?.access?.uas ?? [] : []

  const submit = () => {
    // getFieldsValue(true) keeps values of the access fields that unmount while
    // the filter is off, so switching the filter back on in the same edit does
    // not lose the list.
    const values = form.getFieldsValue(true) as RuleFormValues
    const payload = buildRulePayload(values, { enable, originalAccess: rule?.access })
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
            name="accessMode"
            label="IP 访问控制"
            extra="白名单为空时拒绝所有来源；黑名单为空时不拒绝任何来源。地区列表仅在白名单 / 黑名单模式下保存；私有 / 回环地址没有地区数据。"
          >
            <Select options={ACCESS_OPTIONS} />
          </Form.Item>
        </Col>

        {accessMode !== 'off' ? (
          <Col xs={24}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item name="accessIps" label="IP 列表" extra="每行一条，支持 CIDR。">
                  <Input.TextArea rows={4} placeholder={'192.168.1.0/24\n10.0.0.5'} className="mono" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="accessGeo"
                  label="国家 / 省份 / 城市"
                  extra="命中任意一项即匹配，与 IP 列表取并集。"
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[',', '，']}
                    placeholder="输入后回车，例如 中国、浙江、杭州"
                    notFoundContent={<Muted>直接输入后回车</Muted>}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Col>
        ) : null}

        {originalUas.length || originalUaMode !== 'off' ? (
          <Col xs={24}>
            <Alert
              type="info"
              showIcon
              message="已保存的 User-Agent 过滤将被原样保留"
              description={
                <Space size={4} wrap>
                  <Tag>{ACCESS_LABEL[originalUaMode] || originalUaMode}</Tag>
                  <Muted>共 {originalUas.length} 条规则；端口转发不评估 User-Agent，本表单不修改该列表。</Muted>
                </Space>
              }
            />
          </Col>
        ) : null}
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
