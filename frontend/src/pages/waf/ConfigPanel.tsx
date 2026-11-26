import {
  Alert,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Row,
  Select,
  Statistic,
  Switch,
  Tag,
  type DescriptionsProps,
} from 'antd'
import { Muted, Panel, useIsMobile } from '../../components'
import { fmtTime } from '../../format'
import { LEVEL_OPTIONS, MODE_OPTIONS, type WafEngine, type WafStats } from './types'

interface EngineStatusProps {
  engine: WafEngine | null
  stats: WafStats
  loading: boolean
}

function EngineStatus({ engine, stats, loading }: EngineStatusProps) {
  const isMobile = useIsMobile()
  const columns = isMobile ? 1 : 3
  const mode = engine?.mode || stats.mode || '-'
  const modeLabel = mode === 'detect' ? '检测（只记录）' : mode === 'block' ? '拦截' : '-'

  const items: DescriptionsProps['items'] = [
    {
      key: 'enabled',
      label: '运行状态',
      children: engine?.enabled ? <Tag color="green">运行中</Tag> : <Tag>未运行</Tag>,
    },
    { key: 'mode', label: '当前模式', children: modeLabel },
    {
      key: 'logOnly',
      label: '仅记录',
      children: engine?.logOnly ? <Tag color="orange">已开启</Tag> : <Tag>关闭</Tag>,
    },
    {
      key: 'crs',
      label: '内置 CRS',
      children: (engine?.useCrs ?? stats.useCrs) ? <Tag color="blue">已启用</Tag> : <Tag>已关闭</Tag>,
    },
    {
      key: 'rules',
      label: '引擎规则',
      children: `${engine?.rules ?? stats.rules ?? '-'} 条`,
    },
    {
      key: 'files',
      label: '规则文件',
      children: `${engine?.ruleFiles ?? stats.ruleFiles ?? '-'} 个`,
    },
    {
      key: 'version',
      label: 'CRS 版本',
      children: engine?.crsVersion || stats.crsVersion || '-',
    },
    {
      key: 'fallback',
      label: 'CRS 回退',
      children: engine?.crsFallback ? (
        <Tag color="orange">已回退到自定义规则</Tag>
      ) : (
        <Tag color="green">正常</Tag>
      ),
    },
    {
      key: 'builtAt',
      label: '编译时间',
      children: fmtTime(engine?.builtAt || stats.builtAt),
    },
    {
      key: 'detail',
      label: '运行时详情',
      span: columns,
      children: <span className="mono" style={{ fontSize: 12 }}>{engine?.detail || '-'}</span>,
    },
  ]

  return (
    <Panel
      title="引擎状态"
      subtitle="来自当前已编译生效的规则集"
      loading={loading}
    >
      {engine?.error || stats.buildError ? (
        <Alert
          type="error"
          showIcon
          message="规则集编译失败"
          description={engine?.error || stats.buildError}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Descriptions size="small" bordered column={columns} items={items} />

      <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}>
          <Statistic title="请求" value={stats.requests ?? 0} valueStyle={{ fontSize: 18 }} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="已拦截" value={stats.blocked ?? 0} valueStyle={{ fontSize: 18 }} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="已检测" value={stats.detected ?? 0} valueStyle={{ fontSize: 18 }} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="错误" value={stats.errors ?? 0} valueStyle={{ fontSize: 18 }} />
        </Col>
      </Row>

      <div style={{ marginTop: 8 }}>
        <Muted>
          拦截事件 {stats.events ?? 0} 条 · 在线测试 {stats.tests ?? 0} 次
          {stats.crsFallback ? ' · CRS 已回退' : ''}
        </Muted>
      </div>

      {!loading && engine && !engine.enabled ? (
        <Alert
          type="warning"
          showIcon
          message="WAF 当前未运行"
          description="总开关关闭或规则集尚未成功编译；所有请求将直接放行。"
          style={{ marginTop: 16 }}
        />
      ) : null}
    </Panel>
  )
}

export interface ConfigPanelProps {
  engine: WafEngine | null
  stats: WafStats
  loading: boolean
  useCrs: boolean
}

export default function ConfigPanel({ engine, stats, loading, useCrs }: ConfigPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <EngineStatus engine={engine} stats={stats} loading={loading} />

      <Panel title="引擎配置" subtitle="修改后点右上角「保存配置」，服务端会重新编译规则集">
        <Row gutter={[16, 0]}>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="enable"
              label="总开关"
              valuePropName="checked"
              extra="关闭后 WAF 不检查任何流量"
            >
              <Switch checkedChildren="启用" unCheckedChildren="关闭" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item name="mode" label="模式" extra="检测模式命中后只记录">
              <Select options={MODE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="logOnly"
              label="仅记录"
              valuePropName="checked"
              extra="即使命中也不返回 403"
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="useCrs"
              label="内置 CRS"
              valuePropName="checked"
              extra="OWASP 核心规则集"
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        {!useCrs ? (
          <Alert
            type="warning"
            showIcon
            message="内置 CRS 已关闭"
            description="此时只有自定义 SecLang 规则会生效，规则文件也不能单独启用。"
            style={{ marginBottom: 16 }}
          />
        ) : null}

        <Row gutter={[16, 0]}>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="paranoiaLevel"
              label="Paranoia Level"
              extra="等级越高越严格，误报也越多"
            >
              <Select options={LEVEL_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="executingLevel"
              label="执行等级"
              extra="不能低于 Paranoia Level"
            >
              <Select options={LEVEL_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="inboundThreshold"
              label="入站阈值"
              extra="异常分数达到该值触发"
            >
              <InputNumber min={1} max={10000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item name="outboundThreshold" label="出站阈值" extra="响应方向异常分数阈值">
              <InputNumber min={1} max={10000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={[16, 0]}>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="bodyLimitKb"
              label="请求体上限"
              extra="0 表示后端默认 128 KB；只决定检查多少，超出部分照常转发。"
            >
              <InputNumber min={0} max={262144} precision={0} style={{ width: '100%' }} suffix="KB" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Form.Item
              name="adminProtect"
              label="管理后台防护"
              valuePropName="checked"
              extra="保护后台管理接口"
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>
      </Panel>
    </div>
  )
}
