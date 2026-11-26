import { Alert, Button, Col, Form, Input, Row, Select, Switch, Tag, Typography, theme } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import { Muted } from '../../components'
import { SectionTitle, TagInput } from './ui'
import {
  ACCESS_OPTIONS,
  CLIENT_AUTH_OPTIONS,
  TLS_OPTIONS,
  certOptions,
  normalizeAccessMode,
  normalizeClientAuth,
  normalizeTLSMode,
  normalizeUAMode,
  type AccessMode,
  type Certificate,
  type ClientAuthMode,
  type TLSMode,
  type UAMode,
  type WebListenerView,
} from './types'

export interface ListenerPayload {
  name: string
  listen: string[]
  tls: {
    mode: TLSMode
    certId: string
    hsts: boolean
    clientAuth: ClientAuthMode
    clientCa: string
  }
  access: {
    mode: AccessMode
    ips: string[]
    geo: string[]
    uaMode: UAMode
    uas: string[]
  }
  remark: string
}

interface ListenerFormValues {
  name: string
  listen: string[]
  tlsMode: TLSMode
  certId: string
  hsts: boolean
  clientAuth: ClientAuthMode
  clientCa: string
  accessMode: AccessMode
  accessIps: string
  accessGeo: string[]
  uaMode: UAMode
  uaList: string
  remark: string
}

function blankForm(): ListenerFormValues {
  return {
    name: '',
    listen: [],
    tlsMode: 'off',
    certId: '',
    hsts: false,
    clientAuth: 'off',
    clientCa: '',
    accessMode: 'off',
    accessIps: '',
    accessGeo: [],
    uaMode: 'off',
    uaList: '',
    remark: '',
  }
}

function lines(list: unknown): string {
  return (Array.isArray(list) ? list : []).map((item) => String(item)).join('\n')
}

function splitLines(value: string): string[] {
  return String(value ?? '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

function listenerToForm(listener: WebListenerView): ListenerFormValues {
  return {
    name: listener.name || '',
    listen: (Array.isArray(listener.listen) ? listener.listen : []).map((item) => String(item)),
    tlsMode: normalizeTLSMode(listener.tls?.mode),
    certId: listener.tls?.certId || '',
    hsts: !!listener.tls?.hsts,
    clientAuth: normalizeClientAuth(listener.tls?.clientAuth),
    clientCa: listener.tls?.clientCa || '',
    accessMode: normalizeAccessMode(listener.access?.mode),
    accessIps: lines(listener.access?.ips),
    accessGeo: Array.isArray(listener.access?.geo) ? [...(listener.access?.geo ?? [])] : [],
    uaMode: normalizeUAMode(listener.access?.uaMode),
    uaList: lines(listener.access?.uas),
    remark: listener.remark || '',
  }
}

export default function ListenerForm({
  listener,
  certificates,
  saving,
  onSave,
  onCancel,
  onDelete,
  onDirtyChange,
}: {
  listener: WebListenerView | null
  certificates: Certificate[]
  saving?: boolean
  onSave: (payload: ListenerPayload) => void
  onCancel: () => void
  onDelete?: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { token } = theme.useToken()
  const [form] = Form.useForm<ListenerFormValues>()

  const tlsMode = (Form.useWatch('tlsMode', form) ?? 'off') as TLSMode
  const clientAuth = (Form.useWatch('clientAuth', form) ?? 'off') as ClientAuthMode
  const accessMode = (Form.useWatch('accessMode', form) ?? 'off') as AccessMode
  const uaMode = (Form.useWatch('uaMode', form) ?? 'off') as UAMode
  const certs = Array.isArray(certificates) ? certificates : []
  const listen = (Array.isArray(listener?.listen) ? listener?.listen ?? [] : []).join(' · ')

  const handleFinish = (values: ListenerFormValues) => {
    const listen = (Array.isArray(values.listen) ? values.listen : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
    const mode = normalizeTLSMode(values.tlsMode)
    const auth = mode === 'off' ? 'off' : normalizeClientAuth(values.clientAuth)
    // A section hidden from the start never registers its fields, so use the
    // stored listener as a fallback instead of sending empty lists.
    const accessIps = values.accessIps !== undefined ? values.accessIps : lines(listener?.access?.ips)
    const uaList = values.uaList !== undefined ? values.uaList : lines(listener?.access?.uas)
    const accessGeo = Array.isArray(values.accessGeo)
      ? values.accessGeo
      : Array.isArray(listener?.access?.geo)
        ? listener?.access?.geo ?? []
        : []
    const payload: ListenerPayload = {
      name: String(values.name || '').trim(),
      listen,
      tls: {
        mode,
        certId: mode === 'custom' ? String(values.certId || '').trim() : '',
        hsts: mode !== 'off' && !!values.hsts,
        clientAuth: auth,
        clientCa: auth === 'off' ? '' : String(values.clientCa || '').trim(),
      },
      access: {
        mode: normalizeAccessMode(values.accessMode),
        ips: splitLines(accessIps),
        geo: accessGeo.map((item) => String(item).trim()).filter(Boolean),
        uaMode: normalizeUAMode(values.uaMode),
        uas: splitLines(uaList),
      },
      remark: String(values.remark || '').trim(),
    }
    onSave(payload)
  }

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleFinish}
      onValuesChange={() => onDirtyChange?.(true)}
      disabled={saving}
      initialValues={listener ? listenerToForm(listener) : blankForm()}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <Typography.Text strong style={{ fontSize: 15 }}>
          {listener ? listener.name || listener.id : '新建监听器'}
        </Typography.Text>
        {listener ? (
          listener.disabled ? (
            <Tag color="orange">已停用</Tag>
          ) : (
            <Tag color="green">运行中</Tag>
          )
        ) : (
          <Tag>草稿</Tag>
        )}
        <Muted>{listener ? listen || '未配置监听地址' : '保存后立即生效'}</Muted>
      </div>

      {listener?.disabled ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="该监听器当前处于停用状态"
          description="保存不会自动启用它；释放端口后请在列表里手动启用。"
        />
      ) : null}

      <SectionTitle title="基本信息" />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="name" label="名称" extra="留空时后端会使用第一个监听地址作为名称">
            <Input placeholder="例如 HTTPS 主站" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="remark" label="备注">
            <Input placeholder="可选" allowClear />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item
            name="listen"
            label="监听地址"
            rules={[
              {
                validator: (_rule, value: unknown) => {
                  const list = Array.isArray(value)
                    ? value.map((item) => String(item).trim()).filter(Boolean)
                    : []
                  if (!list.length) return Promise.reject(new Error('请至少填写一个监听地址'))
                  return Promise.resolve()
                },
              },
            ]}
            extra="支持 :443、0.0.0.0:8080、[::]:443；同一地址不能属于两个监听器。端口被占用时监听器会自动停用，可稍后手动启用。"
          >
            <TagInput placeholder="输入后回车，例如 :443" ariaLabel="监听地址" />
          </Form.Item>
        </Col>
      </Row>

      <SectionTitle
        title="TLS 与客户端证书"
        hint="关闭 = 纯 HTTP；自动证书 = 按路由域名自动申请/续期；指定证书 = 该监听器下所有域名共用一张已上传证书。TLS 开启时自动协商 HTTP/2，明文监听同时接受 h2c；当前版本没有单独的 HTTP/3 开关。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item
            name="tlsMode"
            label="TLS 模式"
            rules={[{ required: true, message: '请选择 TLS 模式' }]}
          >
            <Select options={TLS_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="clientAuth"
            label="客户端证书（mTLS）"
            extra="要求访问者出示由指定 CA 签发的证书，适合设备或脚本的双向认证"
          >
            <Select
              options={CLIENT_AUTH_OPTIONS}
              disabled={tlsMode === 'off'}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="hsts"
            label="HSTS"
            valuePropName="checked"
            extra="仅 TLS 非关闭时可用，会附加 Strict-Transport-Security"
          >
            <Switch disabled={tlsMode === 'off'} />
          </Form.Item>
        </Col>
        {tlsMode === 'custom' ? (
          <Col xs={24} md={12}>
            <Form.Item
              name="certId"
              label="指定证书"
              rules={[
                {
                  validator: (_rule, value: unknown) => {
                    if (!String(value ?? '').trim()) {
                      return Promise.reject(new Error('指定证书模式必须选择一个证书'))
                    }
                    return Promise.resolve()
                  },
                },
              ]}
              extra="证书来自「证书」页面；该监听器下的所有域名都使用这张证书"
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={certOptions(certs)}
                placeholder={
                  certs.length ? '选择已上传的证书' : '还没有可用证书，请先到「证书」页面申请或上传'
                }
                notFoundContent="没有可用证书"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        ) : null}
        {tlsMode === 'custom' && !certs.length ? (
          <Col span={24}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="还没有可用证书"
              description={
                <span>
                  请先到 <Link to="/acme">证书</Link> 页面申请或上传证书，再回到这里选择。
                </span>
              }
            />
          </Col>
        ) : null}
        {tlsMode !== 'off' && clientAuth !== 'off' ? (
          <Col span={24}>
            <Form.Item
              name="clientCa"
              label="客户端 CA 证书（PEM）"
              rules={[{ required: true, message: '请填写签发客户端证书的 CA（PEM）' }]}
              extra="可包含多张 CA；保存时后端会校验至少能解析出一张证书"
            >
              <Input.TextArea
                rows={5}
                className="mono"
                placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
              />
            </Form.Item>
          </Col>
        ) : null}
      </Row>

      <SectionTitle
        title="访问过滤（监听器默认）"
        hint="这里配置的规则作用于本监听器下所有「继承监听器」的路由；路由也可以自定义规则来覆盖它。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="accessMode" label="访问策略">
            <Select options={ACCESS_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="uaMode" label="UA 策略">
            <Select options={ACCESS_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        {accessMode !== 'off' ? (
          <>
            <Col span={24}>
              <Form.Item
                name="accessIps"
                label="IP 列表"
                extra="每行一条，支持 CIDR，例如 192.168.1.0/24；与地区列表取并集"
              >
                <Input.TextArea rows={2} className="mono" placeholder="192.168.1.0/24" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                name="accessGeo"
                label="国家 / 省份 / 城市"
                extra="同一个列表，命中任意一项即匹配；私有/回环地址没有地区数据；服务在反向代理后面时需开启信任代理"
              >
                <TagInput placeholder="输入后回车，例如 中国、浙江、杭州" ariaLabel="地区列表" />
              </Form.Item>
            </Col>
          </>
        ) : null}
        {uaMode !== 'off' ? (
          <Col span={24}>
            <Form.Item name="uaList" label="UA 列表" extra="每行一条，支持 * 通配，例如 *bot*">
              <Input.TextArea rows={2} className="mono" placeholder="*bot*" />
            </Form.Item>
          </Col>
        ) : null}
      </Row>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginTop: 4,
          padding: '12px 0',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        {listener && onDelete ? (
          <Button danger type="text" icon={<DeleteOutlined />} onClick={onDelete} disabled={saving}>
            删除
          </Button>
        ) : null}
        <div style={{ flex: 1 }} />
        <Button onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存
        </Button>
      </div>
    </Form>
  )
}
