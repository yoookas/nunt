import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd'
import { BugOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { DataTable, Muted, Panel, StatusTag, Toolbar, useIsMobile } from '../../components'
import {
  TEST_METHOD_OPTIONS,
  type WafMatchedRule,
  type WafTestResult,
} from './types'

interface TestFormValues {
  method: string
  url: string
  body: string
  clientIp: string
}

const INITIAL_VALUES: TestFormValues = { method: 'GET', url: '', body: '', clientIp: '' }

type VerdictType = 'success' | 'info' | 'warning' | 'error'

function verdictOf(result: WafTestResult): { type: VerdictType; title: string; description: string } {
  if (result.error) {
    return {
      type: 'warning',
      title: '检测未完成',
      description: result.error,
    }
  }
  if (result.blocked && result.enforced) {
    return {
      type: 'error',
      title: '请求会被拦截',
      description: result.message || '命中至少一条拦截规则，按当前模式实际返回拦截状态。',
    }
  }
  if (result.blocked) {
    return {
      type: 'warning',
      title: '命中规则，但当前模式只记录',
      description: result.message || '检测模式或「仅记录」开启时不会实际拦截该请求。',
    }
  }
  return {
    type: 'success',
    title: '未命中拦截规则',
    description: '按当前已编译的规则集，这个请求可以通过。',
  }
}

export default function TestPanel() {
  const { message } = App.useApp()
  const isMobile = useIsMobile()
  const [form] = Form.useForm<TestFormValues>()
  const [result, setResult] = useState<WafTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const run = async (values: TestFormValues) => {
    const url = String(values.url || '').trim()
    if (!url) {
      message.warning('请填写要测试的 URL 或路径')
      return
    }
    const payload: { method: string; url: string; body: string; clientIp?: string } = {
      method: values.method,
      url,
      body: values.body || '',
    }
    const clientIp = String(values.clientIp || '').trim()
    if (clientIp) payload.clientIp = clientIp

    setTesting(true)
    try {
      setResult(await api.post<WafTestResult>('/api/v1/waf/test', payload))
    } catch (err) {
      const text = errorText(err)
      setResult({ blocked: false, enforced: false, matched: [], error: text })
      message.error(text)
    } finally {
      setTesting(false)
    }
  }

  const verdict = result ? verdictOf(result) : null
  const matched = Array.isArray(result?.matched) ? result.matched : []

  const matchedColumns: TableColumnsType<WafMatchedRule> = [
    { key: 'id', title: '规则 ID', width: 100, render: (_, record) => String(record.id) },
    {
      key: 'severity',
      title: '严重级别',
      responsive: ['md'],
      render: (_, record) => record.severity || '-',
    },
    {
      key: 'phase',
      title: '阶段',
      width: 70,
      responsive: ['md'],
      render: (_, record) => (record.phase ? String(record.phase) : '-'),
    },
    { key: 'message', title: '说明', render: (_, record) => record.message || '-' },
    {
      key: 'data',
      title: '匹配数据',
      responsive: ['lg'],
      render: (_, record) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {record.data || '-'}
        </span>
      ),
    },
    {
      key: 'file',
      title: '文件',
      responsive: ['xl'],
      render: (_, record) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {record.file || '-'}
        </span>
      ),
    },
  ]

  return (
    <Panel
      title="请求测试"
      subtitle="把构造的请求交给当前引擎判定，不会真的发到后端"
      extra={
        <Toolbar>
          {isMobile ? null : <Muted>POST /api/v1/waf/test</Muted>}
          <Button
            type="primary"
            size="small"
            icon={<BugOutlined />}
            loading={testing}
            onClick={() => form.submit()}
          >
            发送测试
          </Button>
        </Toolbar>
      }
    >
      <Form form={form} layout="vertical" initialValues={INITIAL_VALUES} onFinish={run}>
        <Row gutter={[16, 0]}>
          <Col xs={24} sm={6} md={4}>
            <Form.Item name="method" label="方法">
              <Select options={TEST_METHOD_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={18} md={14}>
            <Form.Item
              name="url"
              label="URL / 路径"
              rules={[{ required: true, whitespace: true, message: '请填写 URL 或路径' }]}
              extra="可填写完整 URL，也可以只填 path（会自动补上前导 /）。"
            >
              <Input placeholder="/admin?id=1 union select 1 或 https://example.com/x" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="clientIp" label="客户端 IP" extra="可留空，默认 127.0.0.1。">
              <Input placeholder="127.0.0.1" allowClear />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="body" label="请求体" extra="POST / PUT 等方法的请求体，可留空。">
          <Input.TextArea
            rows={3}
            spellCheck={false}
            placeholder='{"name":"test"}'
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          />
        </Form.Item>
      </Form>

      {result && verdict ? (
        <div style={{ marginTop: 8 }}>
          <Alert type={verdict.type} showIcon message={verdict.title} description={verdict.description} />

          <Space size={[8, 8]} wrap style={{ marginTop: 12 }}>
            <Tag>模式 {result.mode || '-'}</Tag>
            <Tag>动作 {result.action || '-'}</Tag>
            <StatusTag status={result.status} text={result.status ? undefined : '-'} />
            <Tag>耗时 {result.durationMs ?? '-'} ms</Tag>
            {result.logOnly ? <Tag color="orange">仅记录</Tag> : null}
            {!result.enforced && result.blocked ? <Tag color="orange">未强制拦截</Tag> : null}
            {result.ruleId ? <Tag color="red">规则 {result.ruleId}</Tag> : null}
            {result.txId ? (
              <Typography.Text className="mono" type="secondary" style={{ fontSize: 12 }}>
                事务 {result.txId}
              </Typography.Text>
            ) : null}
          </Space>

          {result.message && result.message !== verdict.description ? (
            <div style={{ marginTop: 8 }}>
              <Muted>说明：{result.message}</Muted>
            </div>
          ) : null}

          <div style={{ marginTop: 16 }}>
            {matched.length ? (
              <DataTable<WafMatchedRule>
                dataSource={matched}
                columns={matchedColumns}
                rowKey={(record) => `${record.id}-${record.phase || 0}-${record.message || ''}`}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={result.error ? '没有返回命中详情' : '没有命中规则'}
              />
            )}
          </div>
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="填写请求后点击「发送测试」，查看命中规则与拦截判定"
          style={{ marginTop: 24 }}
        />
      )}
    </Panel>
  )
}
