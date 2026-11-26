import { useState } from 'react'
import { Alert, App, Button, Col, Form, Input, Row, Select, Space, Tag, Typography } from 'antd'
import { BugOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { Muted, StatusTag } from '../../components'
import { TEST_METHOD_OPTIONS, type WafMatchedRule, type WafTestResult } from './types'

interface TestFormValues {
  method: string
  url: string
  body: string
  clientIp: string
}

const INITIAL_VALUES: TestFormValues = { method: 'GET', url: '', body: '', clientIp: '' }

type VerdictType = 'success' | 'info' | 'warning' | 'error'

function verdictOf(result: WafTestResult): { type: VerdictType; title: string; description?: string } {
  if (result.error) {
    return { type: 'warning', title: '检测未完成', description: result.error }
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
      title: '命中规则，但当前只记录',
      description: result.message || '检测模式或「仅记录」开启时不会实际拦截该请求。',
    }
  }
  return { type: 'success', title: '未命中拦截规则' }
}

function MatchedRow({ hit }: { hit: WafMatchedRule }) {
  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(5,5,5,0.06)' }}>
      <Space size={6} wrap>
        <Tag>{hit.id}</Tag>
        <Typography.Text strong style={{ fontSize: 12 }}>
          {hit.message || '规则命中'}
        </Typography.Text>
        {hit.severity ? <Tag color={hit.severity === 'CRITICAL' ? 'red' : 'orange'}>{hit.severity}</Tag> : null}
        {hit.phase ? <Muted>phase {hit.phase}</Muted> : null}
      </Space>
      {hit.data ? (
        <div style={{ marginTop: 4 }}>
          <Muted>
            <span className="mono">{hit.data}</span>
          </Muted>
        </div>
      ) : null}
    </div>
  )
}

export default function TestSection() {
  const { message } = App.useApp()
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

  return (
    <div>
      <Form form={form} layout="vertical" initialValues={INITIAL_VALUES} onFinish={run}>
        <Row gutter={[8, 0]}>
          <Col xs={24} sm={5} md={4}>
            <Form.Item name="method" label="方法">
              <Select size="small" options={TEST_METHOD_OPTIONS} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={19} md={14}>
            <Form.Item
              name="url"
              label="URL / 路径"
              rules={[{ required: true, whitespace: true, message: '请填写 URL 或路径' }]}
            >
              <Input size="small" placeholder="/admin?id=1 union select 1" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="clientIp" label="客户端 IP">
              <Input size="small" placeholder="默认 127.0.0.1" allowClear />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="body" label="请求体">
          <Input.TextArea
            rows={2}
            spellCheck={false}
            placeholder='{"name":"test"}'
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          />
        </Form.Item>
        <Button type="primary" size="small" icon={<BugOutlined />} htmlType="submit" loading={testing}>
          发送测试
        </Button>
      </Form>

      {result && verdict ? (
        <div style={{ marginTop: 12 }}>
          <Alert
            type={verdict.type}
            showIcon
            message={verdict.title}
            description={verdict.description}
          />
          <Space size={[6, 6]} wrap style={{ marginTop: 10 }}>
            <Tag>模式 {result.mode || '-'}</Tag>
            <Tag>动作 {result.action || '-'}</Tag>
            <StatusTag status={result.status} text={result.status ? undefined : '无状态'} />
            <Tag>耗时 {result.durationMs ?? '-'} ms</Tag>
            {result.logOnly ? <Tag color="orange">仅记录</Tag> : null}
            {result.ruleId ? <Tag color="red">规则 {result.ruleId}</Tag> : null}
            {result.txId ? <Muted>tx {result.txId}</Muted> : null}
          </Space>

          {matched.length ? (
            <div
              style={{
                marginTop: 10,
                maxHeight: 200,
                overflowY: 'auto',
                border: '1px solid rgba(5,5,5,0.06)',
                borderRadius: 8,
              }}
            >
              {matched.map((hit) => (
                <MatchedRow key={`${hit.id}-${hit.phase || 0}-${hit.line || 0}`} hit={hit} />
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <Muted>没有返回命中规则详情。</Muted>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            marginTop: 12,
            border: '1px dashed rgba(5,5,5,0.12)',
            borderRadius: 8,
            padding: '12px 14px',
          }}
        >
          <Muted>填写请求后发送测试，引擎只做判定，不会真的请求后端。</Muted>
        </div>
      )}
    </div>
  )
}
