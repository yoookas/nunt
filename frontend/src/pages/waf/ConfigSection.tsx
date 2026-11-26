import { Alert, Button, Col, Form, InputNumber, Row, Select, Switch } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { Muted } from '../../components'
import { LEVEL_OPTIONS, MODE_OPTIONS } from './types'

export interface ConfigSectionProps {
  useCrs: boolean
  saving?: boolean
  onSave: () => void
}

export default function ConfigSection({ useCrs, saving = false, onSave }: ConfigSectionProps) {
  return (
    <div>
      <Row gutter={[12, 0]}>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="enable" label="总开关" valuePropName="checked" extra="关闭后不检查流量">
            <Switch checkedChildren="启用" unCheckedChildren="关闭" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="mode" label="模式" extra="检测模式只记录">
            <Select options={MODE_OPTIONS} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="logOnly" label="仅记录" valuePropName="checked" extra="命中也不返回 403">
            <Switch />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="useCrs" label="内置 CRS" valuePropName="checked" extra="OWASP 核心规则集">
            <Switch />
          </Form.Item>
        </Col>
      </Row>

      {!useCrs ? (
        <Alert
          type="warning"
          showIcon
          message="内置 CRS 已关闭，仅自定义 SecLang 规则生效"
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Row gutter={[12, 0]}>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="paranoiaLevel" label="Paranoia Level" extra="越高越严格，误报也越多">
            <Select options={LEVEL_OPTIONS} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="executingLevel" label="执行等级" extra="不能低于 PL">
            <Select options={LEVEL_OPTIONS} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="inboundThreshold" label="入站阈值" extra="异常分数达到即触发">
            <InputNumber min={1} max={10000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="outboundThreshold" label="出站阈值" extra="响应方向异常分数">
            <InputNumber min={1} max={10000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={[12, 0]}>
        <Col xs={24} sm={12} xl={8}>
          <Form.Item
            name="bodyLimitKb"
            label="请求体上限"
            extra="0 表示后端默认 128 KB；超出部分照常转发但不检查。"
          >
            <InputNumber min={0} max={262144} precision={0} style={{ width: '100%' }} suffix="KB" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={8}>
          <Form.Item name="adminProtect" label="管理后台防护" valuePropName="checked" extra="保护后台管理接口">
            <Switch />
          </Form.Item>
        </Col>
        <Col xs={24} xl={8}>
          <Form.Item label="规则集提示">
            <Muted>修改后点「保存」，服务端会重新编译并原子替换规则集。</Muted>
          </Form.Item>
        </Col>
      </Row>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
        <Button size="small" icon={<SaveOutlined />} loading={saving} onClick={onSave}>
          保存配置
        </Button>
      </div>
    </div>
  )
}
