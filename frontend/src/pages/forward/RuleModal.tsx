import { useMemo, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd'
import { api, errorText } from '../../api'
import { modalWidth, Muted } from '../../components'
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

interface RuleModalProps {
  open: boolean
  /** null means "create". */
  rule: ForwardRule | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}

const NUM_STYLE = { width: '100%' }

export default function ForwardRuleModal({ open, rule, onClose, onSaved }: RuleModalProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<RuleFormValues>()
  const [saving, setSaving] = useState(false)
  const initial = useMemo(() => ruleFormValues(rule), [rule])
  const accessMode = Form.useWatch('accessMode', form) ?? initial.accessMode

  const originalUaMode = rule?.access?.uaMode || 'off'
  const originalUas = Array.isArray(rule?.access?.uas) ? rule?.access?.uas ?? [] : []

  const submit = async () => {
    // getFieldsValue(true) keeps the values of the access fields that are
    // unmounted while the filter is off, so switching the filter back on in the
    // same dialog does not lose the list.
    const values = form.getFieldsValue(true) as RuleFormValues
    const payload = buildRulePayload(values, rule?.access)
    setSaving(true)
    try {
      const saved = rule?.id
        ? await api.put<ForwardRule>(`/api/v1/forward/rules/${encodeURIComponent(rule.id)}`, payload)
        : await api.post<ForwardRule>('/api/v1/forward/rules', payload)
      const autoDisabled = Boolean(saved?.disabled)
      if (autoDisabled) {
        message.warning('规则已保存，但监听端口被占用，后端已自动停用；请释放端口后重新启用')
      } else {
        message.success(rule?.id ? '规则已保存' : '规则已创建')
      }
      await onSaved()
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
      title={rule?.id ? '编辑转发规则' : '新建转发规则'}
      width={modalWidth(true)}
      onCancel={() => {
        if (!saving) onClose()
      }}
      maskClosable={false}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100dvh - 240px)', overflowY: 'auto', paddingTop: 8 } }}
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
        scrollToFirstError
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
            <Form.Item name="enable" label="启用状态" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </Col>

          <Col xs={24} md={12}>
            <Form.Item name="protocol" label="协议" rules={[{ required: true, message: '请选择协议' }]}>
              <Select options={PROTOCOL_OPTIONS} />
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

          <Col xs={24}>
            <Form.Item name="remark" label="备注">
              <Input placeholder="备注（可选）" maxLength={128} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  )
}
