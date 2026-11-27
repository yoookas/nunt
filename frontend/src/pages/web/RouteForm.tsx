import AccessEditor from '../../components/AccessEditor'
import { emptyAccess, normalizeAccess, type Access } from '../../access'
import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
  type FormProps,
} from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Muted } from '../../components'
import { splitLines, splitList } from '../../format'
import { RouteTypeTag, SectionTitle, TagInput } from './ui'
import {
  BALANCE_OPTIONS,
  REDIRECT_STATUS_OPTIONS,

  TYPE_OPTIONS,
  balanceValue,
  kvToText,
  listenerName,
  listenerOptions,


  textToKV,

  type BasicAuthUser,
  type ProxyTarget,
  type RedirectTarget,
  type RouteType,
  type StaticTarget,

  type WebListenerView,
  type WebRule,
} from './types'

interface AuthUserForm {
  username: string
  password: string
}

interface RouteFormValues {
  name: string
  enable: boolean
  listenerId: string
  type: RouteType
  domains: string[]
  path: string
  priority: number
  remark: string
  wafMode: string
  access: Access
  authEnable: boolean
  authUsers: AuthUserForm[]
  proxyTargets: string
  proxyBalance: string
  proxyHostHeader: string
  proxyHeaders: string
  proxyRespHeaders: string
  proxyPathPrefix: string
  proxyPathReplace: string
  proxyTimeout: number
  proxyInsecure: boolean
  proxyNoCompress: boolean
  proxyH2C: boolean
  proxyRateLimit: number
  proxyMaxBody: number
  corsEnable: boolean
  corsOrigins: string
  corsMethods: string
  corsHeaders: string
  corsCredentials: boolean
  corsMaxAge: number
  redirectTo: string
  redirectStatus: string
  redirectKeep: boolean
  staticRoot: string
  staticIndex: string
  staticListing: boolean
  staticSPA: boolean
  staticCache: number
}

function blankForm(listenerId = ''): RouteFormValues {
  return {
    name: '',
    enable: true,
    listenerId,
    type: 'proxy',
    domains: [],
    path: '/',
    priority: 0,
    remark: '',
    wafMode: 'inherit',
    access: emptyAccess(),
    authEnable: false,
    authUsers: [],
    proxyTargets: '',
    proxyBalance: 'roundrobin',
    proxyHostHeader: '',
    proxyHeaders: '',
    proxyRespHeaders: '',
    proxyPathPrefix: '',
    proxyPathReplace: '',
    proxyTimeout: 0,
    proxyInsecure: false,
    proxyNoCompress: false,
    proxyH2C: false,
    proxyRateLimit: 0,
    proxyMaxBody: 0,
    corsEnable: false,
    corsOrigins: '',
    corsMethods: '',
    corsHeaders: '',
    corsCredentials: false,
    corsMaxAge: 0,
    redirectTo: '',
    redirectStatus: '302',
    redirectKeep: false,
    staticRoot: '',
    staticIndex: 'index.html',
    staticListing: false,
    staticSPA: false,
    staticCache: 0,
  }
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function lines(list: unknown): string {
  return (Array.isArray(list) ? list : []).map((item) => String(item)).join('\n')
}

function ruleToForm(rule: WebRule, fallbackListenerId: string): RouteFormValues {
  const access = rule.access
  const auth = rule.basicAuth
  const proxy = rule.proxy
  const redirect = rule.redirect
  const stat = rule.static
  return {
    ...blankForm(),
    name: rule.name || '',
    enable: !!rule.enable,
    listenerId: rule.listenerId || fallbackListenerId,
    type: rule.type || 'proxy',
    domains: Array.isArray(rule.domains) ? [...rule.domains] : [],
    path: rule.path || '/',
    priority: num(rule.priority, 0),
    remark: rule.remark || '',
    wafMode: rule.wafMode || 'inherit',
    access: normalizeAccess(access),
    authEnable: !!auth?.enable,
    authUsers: (Array.isArray(auth?.users) ? auth?.users ?? [] : []).map((user) => ({
      username: user.username || '',
      password: '',
    })),
    proxyTargets: lines(proxy?.targets),
    proxyBalance: balanceValue(proxy?.balance),
    proxyHostHeader: proxy?.hostHeader || '',
    proxyHeaders: kvToText(proxy?.headers),
    proxyRespHeaders: kvToText(proxy?.respHeaders),
    proxyPathPrefix: proxy?.pathPrefix || '',
    proxyPathReplace: proxy?.pathReplace || '',
    proxyTimeout: num(proxy?.timeoutSec, 0),
    proxyInsecure: !!proxy?.insecureTls,
    proxyNoCompress: !!proxy?.disableCompression,
    proxyH2C: !!proxy?.h2c,
    proxyRateLimit: num(proxy?.rateLimitPerSec, 0),
    proxyMaxBody: num(proxy?.maxBodyBytes, 0),
    corsEnable: !!proxy?.cors,
    corsOrigins: lines(proxy?.cors?.origins),
    corsMethods: (Array.isArray(proxy?.cors?.methods) ? proxy?.cors?.methods ?? [] : []).join(', '),
    corsHeaders: (Array.isArray(proxy?.cors?.headers) ? proxy?.cors?.headers ?? [] : []).join(', '),
    corsCredentials: !!proxy?.cors?.credentials,
    corsMaxAge: num(proxy?.cors?.maxAge, 0),
    redirectTo: redirect?.to || '',
    redirectStatus: String(num(redirect?.status, 302) || 302),
    redirectKeep: !!redirect?.keepPath,
    staticRoot: stat?.root || '',
    staticIndex: (Array.isArray(stat?.index) ? stat?.index ?? [] : []).join(' '),
    staticListing: !!stat?.listing,
    staticSPA: !!stat?.spa,
    staticCache: num(stat?.cacheSeconds, 0),
  }
}

/** Which tab owns a field, so a validation error hidden behind a tab is shown. */
const FIELD_TAB: Record<string, string> = {
  name: 'basic',
  enable: 'basic',
  listenerId: 'basic',
  type: 'basic',
  domains: 'basic',
  path: 'basic',
  proxyTargets: 'target',
  proxyBalance: 'target',
  proxyHostHeader: 'target',
  proxyHeaders: 'target',
  proxyRespHeaders: 'target',
  proxyPathPrefix: 'target',
  proxyPathReplace: 'target',
  proxyTimeout: 'target',
  proxyInsecure: 'target',
  proxyNoCompress: 'target',
  proxyH2C: 'target',
  proxyRateLimit: 'target',
  proxyMaxBody: 'target',
  corsEnable: 'target',
  corsOrigins: 'target',
  corsMethods: 'target',
  corsHeaders: 'target',
  corsCredentials: 'target',
  corsMaxAge: 'target',
  redirectTo: 'target',
  redirectStatus: 'target',
  redirectKeep: 'target',
  staticRoot: 'target',
  staticIndex: 'target',
  staticListing: 'target',
  staticSPA: 'target',
  staticCache: 'target',
  access: 'access',
  authEnable: 'access',
  authUsers: 'access',
  priority: 'advanced',
  remark: 'advanced',
  wafMode: 'advanced',
}

export interface RoutePayload {
  name: string
  enable: boolean
  type: RouteType
  listenerId: string
  domains: string[]
  path: string
  priority: number
  wafMode: string
  access: Access
  basicAuth: { enable: boolean; users: BasicAuthUser[] }
  proxy: ProxyTarget | null
  redirect: RedirectTarget | null
  static: StaticTarget | null
  remark: string
}

export default function RouteForm({
  rule,
  listeners,
  defaultListenerId,
  saving,
  onSave,
  onCancel,
  onDelete,
  onDirtyChange,
}: {
  rule: WebRule | null
  listeners: WebListenerView[]
  defaultListenerId: string
  saving?: boolean
  onSave: (payload: RoutePayload) => void
  onCancel: () => void
  onDelete?: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [form] = Form.useForm<RouteFormValues>()
  const [tab, setTab] = useState('basic')

  const type = (Form.useWatch('type', form) ?? rule?.type ?? 'proxy') as RouteType
  const listenerWAF = !!listeners.find(
    (item) => item.id === String(Form.useWatch('listenerId', form) ?? rule?.listenerId ?? ''),
  )?.waf
  const authEnable = !!Form.useWatch('authEnable', form)
  const corsEnable = !!Form.useWatch('corsEnable', form)

  const existingAuthNames = (Array.isArray(rule?.basicAuth?.users) ? rule?.basicAuth?.users ?? [] : []).map(
    (user) => user.username || '',
  )
  const fallbackListenerId =
    defaultListenerId && listeners.some((item) => item.id === defaultListenerId)
      ? defaultListenerId
      : listeners.length === 1
        ? listeners[0].id
        : ''
  const initialValues = rule
    ? ruleToForm(rule, defaultListenerId)
    : blankForm(fallbackListenerId)

  const handleFinish = (values: RouteFormValues) => {
    const type = values.type || 'proxy'
    const proxyTargets = splitLines(String(values.proxyTargets ?? ''))
    const domains = (Array.isArray(values.domains) ? values.domains : [])
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean)
    // Fields hidden by the current mode are not registered and therefore
    // absent from the submitted values. Fall back to the stored rule so an
    // unrelated save never drops the lists the backend still holds.

    const authUsers: BasicAuthUser[] = (Array.isArray(values.authUsers) ? values.authUsers : [])
      .map((user) => ({
        username: String(user?.username || '').trim(),
        password: String(user?.password || ''),
      }))
      .filter((user) => user.username || user.password)

    const payload: RoutePayload = {
      name: String(values.name || '').trim(),
      enable: !!values.enable,
      type,
      listenerId: values.listenerId,
      domains,
      path: String(values.path || '').trim() || '/',
      priority: num(values.priority, 0),
      wafMode: String(values.wafMode || 'inherit'),
      access: normalizeAccess(values.access ?? rule?.access),
      // Disabled BasicAuth keeps the accounts that already exist (with an
      // empty password, which means "keep the stored hash" server side).
      basicAuth: {
        enable: !!values.authEnable,
        users: values.authEnable
          ? authUsers
          : authUsers.filter((user) => existingAuthNames.includes(user.username)),
      },
      proxy: null,
      redirect: null,
      static: null,
      remark: String(values.remark || '').trim(),
    }

    if (type === 'proxy') {
      payload.proxy = {
        targets: proxyTargets,
        balance: balanceValue(values.proxyBalance),
        hostHeader: String(values.proxyHostHeader || '').trim(),
        headers: textToKV(values.proxyHeaders),
        respHeaders: textToKV(values.proxyRespHeaders),
        pathPrefix: String(values.proxyPathPrefix || '').trim(),
        pathReplace: String(values.proxyPathReplace || '').trim(),
        timeoutSec: num(values.proxyTimeout, 0),
        insecureTls: !!values.proxyInsecure,
        disableCompression: !!values.proxyNoCompress,
        h2c: !!values.proxyH2C,
        rateLimitPerSec: num(values.proxyRateLimit, 0),
        maxBodyBytes: num(values.proxyMaxBody, 0),
        cors: values.corsEnable
          ? {
              origins: splitLines(String(values.corsOrigins ?? '')),
              methods: splitList(String(values.corsMethods ?? '')),
              headers: splitList(String(values.corsHeaders ?? '')),
              credentials: !!values.corsCredentials,
              maxAge: num(values.corsMaxAge, 0),
            }
          : null,
      }
    } else if (type === 'redirect') {
      payload.redirect = {
        to: String(values.redirectTo || '').trim(),
        status: num(values.redirectStatus, 302) || 302,
        keepPath: !!values.redirectKeep,
      }
    } else if (type === 'static') {
      payload.static = {
        root: String(values.staticRoot || '').trim(),
        index: String(values.staticIndex || '')
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean),
        listing: !!values.staticListing,
        spa: !!values.staticSPA,
        cacheSeconds: num(values.staticCache, 0),
      }
    }

    onSave(payload)
  }

  const onFinishFailed: NonNullable<FormProps<RouteFormValues>['onFinishFailed']> = ({
    errorFields,
  }) => {
    const first = errorFields[0]
    if (first) {
      const root = String(Array.isArray(first.name) ? first.name[0] : first.name)
      setTab(FIELD_TAB[root] || 'basic')
    }
    message.warning('请检查表单中标记的字段')
  }

  const authUsernameRules = (index: number) =>
    authEnable
      ? [
          {
            validator: (_rule: unknown, value: unknown) => {
              const name = String(value ?? '').trim()
              const password = String(
                form.getFieldValue(['authUsers', index, 'password']) ?? '',
              )
              if (!name && !password) return Promise.resolve()
              if (!name) return Promise.reject(new Error('请输入用户名'))
              const users = (form.getFieldValue('authUsers') as AuthUserForm[] | undefined) || []
              const names = users.map((user) => String(user?.username ?? '').trim())
              if (names.filter((item) => item === name).length > 1) {
                return Promise.reject(new Error('用户名不能重复'))
              }
              return Promise.resolve()
            },
          },
        ]
      : []

  const authPasswordRules = (index: number) =>
    authEnable
      ? [
          {
            validator: (_rule: unknown, value: unknown) => {
              const name = String(
                form.getFieldValue(['authUsers', index, 'username']) ?? '',
              ).trim()
              const password = String(value ?? '')
              if (!name) return Promise.resolve()
              if (!password && !existingAuthNames.includes(name)) {
                return Promise.reject(new Error('新账号必须填写密码'))
              }
              return Promise.resolve()
            },
          },
        ]
      : []

  const targetLabel = type === 'proxy' ? '代理' : type === 'redirect' ? '跳转' : '静态'

  const basicTab = (
    <>
      <SectionTitle title="站点与匹配" hint="路由按域名 + 路径前缀匹配；同一监听器内路径越长越优先。" />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: '请填写路由名称' }]}
          >
            <Input placeholder="例如 博客首页" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="listenerId"
            label="所属监听器"
            rules={[{ required: true, message: '请选择所属监听器' }]}
            extra="端口与 TLS 由所属监听器统一配置"
          >
            <Select
              options={listenerOptions(listeners)}
              placeholder="选择监听器"
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="type" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select options={TYPE_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="path" label="路径" extra="前缀匹配，例如 /blog；留空视为 /">
            <Input placeholder="/" className="mono" />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item
            name="domains"
            label="域名"
            extra="留空表示匹配任意 Host，支持 *.example.com 通配"
          >
            <TagInput placeholder="输入后回车，例如 example.com" ariaLabel="域名列表" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="enable"
            label="启用路由"
            valuePropName="checked"
            extra="停用后保留配置但不再对外服务"
          >
            <Switch />
          </Form.Item>
        </Col>
      </Row>
    </>
  )

  const proxyTab = (
    <>
      <SectionTitle
        title="上游与负载均衡"
        hint="支持 http/https；未写协议时默认 http://。多个上游时按负载均衡策略分发。"
      />
      <Row gutter={16}>
        <Col span={24}>
          <Form.Item
            name="proxyTargets"
            label="上游列表"
            rules={[
              {
                validator: (_rule: unknown, value: unknown) => {
                  if (!splitLines(String(value ?? '')).length) {
                    return Promise.reject(new Error('反向代理路由至少需要一个上游地址'))
                  }
                  return Promise.resolve()
                },
              },
            ]}
            extra="每行一个，例如 http://127.0.0.1:8080"
          >
            <Input.TextArea
              rows={3}
              className="mono"
              placeholder={'http://127.0.0.1:8080\nhttp://127.0.0.1:8081'}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="proxyBalance" label="负载均衡">
            <Select options={BALANCE_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="proxyHostHeader" label="Host 头" extra="留空透传客户端 Host">
            <Input placeholder="例如 example.com" className="mono" allowClear />
          </Form.Item>
        </Col>
      </Row>

      <Collapse
        size="small"
        style={{ marginTop: 4 }}
        items={[
          {
            key: 'rewrite',
            label: '路径改写与自定义头',
            forceRender: true,
            children: (
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="proxyPathPrefix"
                    label="路径重写前缀"
                    extra="匹配到的前缀会替换为「路径替换为」"
                  >
                    <Input placeholder="例如 /api" className="mono" allowClear />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name="proxyPathReplace" label="路径替换为">
                    <Input placeholder="例如 /" className="mono" allowClear />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="proxyHeaders"
                    label="请求头"
                    extra="每行一条，例如 X-Real-IP: $remote_addr"
                  >
                    <Input.TextArea rows={2} className="mono" placeholder="X-Real-IP: $remote_addr" />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="proxyRespHeaders"
                    label="响应头"
                    extra="每行一条，例如 X-Frame-Options: DENY"
                  >
                    <Input.TextArea rows={2} className="mono" placeholder="X-Frame-Options: DENY" />
                  </Form.Item>
                </Col>
              </Row>
            ),
          },
          {
            key: 'limits',
            label: '超时、限速与请求体',
            forceRender: true,
            children: (
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item name="proxyTimeout" label="超时（秒）" extra="0 表示使用默认值">
                    <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name="proxyRateLimit"
                    label="限速（请求/秒）"
                    extra="按客户端地址限速，0 表示不限制"
                  >
                    <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name="proxyMaxBody"
                    label="请求体上限（字节）"
                    extra="0 表示不限制，1048576 = 1 MiB"
                  >
                    <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name="proxyInsecure"
                    label="跳过上游证书校验"
                    valuePropName="checked"
                    extra="仅自签名或内网上游使用"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name="proxyNoCompress"
                    label="禁用压缩"
                    valuePropName="checked"
                    extra="适合已经压缩过的响应"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    name="proxyH2C"
                    label="h2c 上游"
                    valuePropName="checked"
                    extra="明文 HTTP/2 上游，原生 gRPC 常用"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
            ),
          },
          {
            key: 'cors',
            label: 'CORS 跨域',
            forceRender: true,
            children: (
              <>
                <Form.Item
                  name="corsEnable"
                  label="启用 CORS"
                  valuePropName="checked"
                  extra="由代理直接回应跨域预检（OPTIONS）并补 Access-Control-* 头；关闭时完全交给上游"
                >
                  <Switch />
                </Form.Item>
                {corsEnable ? (
                  <Row gutter={16}>
                    <Col span={24}>
                      <Form.Item
                        name="corsOrigins"
                        label="允许的来源"
                        rules={[
                          {
                            validator: (_rule: unknown, value: unknown) => {
                              if (!splitLines(String(value ?? '')).length) {
                                return Promise.reject(
                                  new Error('启用 CORS 后至少需要一个允许的来源（* 表示全部）'),
                                )
                              }
                              return Promise.resolve()
                            },
                          },
                        ]}
                        extra="每行一个，精确匹配（忽略大小写与末尾斜杠）；填 * 表示允许任何来源"
                      >
                        <Input.TextArea
                          rows={2}
                          className="mono"
                          placeholder={'https://app.example.com\n*'}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="corsMethods"
                        label="允许的方法"
                        extra="逗号或空格分隔；留空表示常用方法"
                      >
                        <Input placeholder="GET, POST" className="mono" allowClear />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="corsHeaders"
                        label="允许的请求头"
                        extra="逗号分隔；留空表示回显预检请求里的头"
                      >
                        <Input placeholder="Content-Type, Authorization" className="mono" allowClear />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="corsCredentials"
                        label="允许携带凭据"
                        valuePropName="checked"
                        extra="开启后浏览器不接受 * 作为来源，会回显具体 Origin"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="corsMaxAge"
                        label="预检缓存（秒）"
                        extra="Access-Control-Max-Age；0 表示不设置"
                      >
                        <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>
                ) : null}
              </>
            ),
          },
        ]}
      />
    </>
  )

  const redirectTab = (
    <>
      <SectionTitle title="重定向目标" hint="把匹配到的请求跳转到目标地址，可按需保留原始路径。" />
      <Row gutter={16}>
        <Col span={24}>
          <Form.Item
            name="redirectTo"
            label="目标地址"
            rules={[{ required: true, whitespace: true, message: '重定向路由必须填写目标地址' }]}
          >
            <Input placeholder="https://example.com/new" className="mono" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="redirectStatus" label="状态码">
            <Select options={REDIRECT_STATUS_OPTIONS} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="redirectKeep"
            label="保留原始路径"
            valuePropName="checked"
            extra="开启后把请求路径拼接在目标地址之后"
          >
            <Switch />
          </Form.Item>
        </Col>
      </Row>
    </>
  )

  const staticTab = (
    <>
      <SectionTitle
        title="静态托管"
        hint="目录必须存在且服务进程可读；SPA 模式把未命中的请求回退到索引文件，否则返回 404。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item
            name="staticRoot"
            label="本地目录"
            rules={[{ required: true, whitespace: true, message: '静态托管路由必须填写本机目录' }]}
            extra="例如 /var/www/site"
          >
            <Input placeholder="/var/www/site" className="mono" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="staticIndex" label="索引文件" extra="空格分隔，例如 index.html index.htm">
            <Input placeholder="index.html" className="mono" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="staticCache" label="缓存秒数" extra="0 表示不缓存">
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="staticListing"
            label="目录列表"
            valuePropName="checked"
            extra="没有索引文件时允许浏览目录"
          >
            <Switch />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="staticSPA"
            label="单页应用模式"
            valuePropName="checked"
            extra="找不到文件时回退到索引文件"
          >
            <Switch />
          </Form.Item>
        </Col>
      </Row>
    </>
  )

  const accessTab = (
    <>
      <SectionTitle
        title="IP / 地区 / UA 过滤"
        hint="继承监听器：使用所属监听器的规则；自定义：本条路由覆盖监听器规则。"
      />
      <Form.Item
        name="access"
        label="访问控制"
        extra="从上到下匹配，第一条命中的规则生效。"
      >
        <AccessEditor />
      </Form.Item>

      <SectionTitle
        title="BasicAuth"
        hint="为整个路由增加 HTTP 基础认证；已有账号的密码留空表示保持原密码。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="authEnable" label="启用 BasicAuth" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
      </Row>
      {authEnable ? (
        <>
          <div style={{ marginBottom: 8 }}>
            <Muted>新增账号必须填写密码；编辑时已有账号留空密码即可保持不变。</Muted>
          </div>
          <Form.List name="authUsers">
            {(fields, { add, remove }) => (
              <div style={{ marginTop: 12 }}>
                {fields.length ? (
                  fields.map((field, index) => (
                    <div
                      key={field.key}
                      style={{
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: 8,
                        padding: '10px 12px 0',
                        marginBottom: 8,
                      }}
                    >
                      <Row gutter={8}>
                        <Col xs={24} sm={10}>
                          <Form.Item
                            name={[field.name, 'username']}
                            label="用户名"
                            rules={authUsernameRules(field.name)}
                            style={{ marginBottom: 8 }}
                          >
                            <Input placeholder="用户名" autoComplete="off" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={10}>
                          <Form.Item
                            name={[field.name, 'password']}
                            label="密码"
                            rules={authPasswordRules(field.name)}
                            style={{ marginBottom: 8 }}
                          >
                            <Input.Password
                              placeholder="留空表示不修改"
                              autoComplete="new-password"
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={4}>
                          <Button
                            danger
                            type="text"
                            icon={<DeleteOutlined />}
                            aria-label={`删除第 ${index + 1} 个账号`}
                            onClick={() => remove(field.name)}
                          >
                            删除
                          </Button>
                        </Col>
                      </Row>
                    </div>
                  ))
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message="还没有账号，至少添加一个账号后认证才会生效"
                  />
                )}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => add({ username: '', password: '' } as AuthUserForm)}
                >
                  添加账号
                </Button>
              </div>
            )}
          </Form.List>
        </>
      ) : null}
    </>
  )

  const advancedTab = (
    <>
      <SectionTitle
        title="匹配优先级"
        hint="数字越大越优先；同优先级先按路径长度，再按列表顺序。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="priority" label="优先级" extra="默认 0">
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item name="remark" label="备注">
            <Input placeholder="可选" allowClear />
          </Form.Item>
        </Col>
      </Row>

      <SectionTitle
        title="WAF"
        hint="WAF 规则集在「WAF」页面配置；这里只控制该路由是否经过 WAF。"
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item
            name="wafMode"
            label="WAF 检查"
            extra="继承时跟随监听器开关；启用/关闭会覆盖监听器。"
          >
            <Select
              options={[
                { value: 'inherit', label: `继承监听器（当前：${listenerWAF ? '启用' : '关闭'}）` },
                { value: 'on', label: '启用' },
                { value: 'off', label: '关闭' },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        提示：路由顺序在左侧列表中拖动排序，顺序会参与同优先级路由的匹配。
      </Typography.Text>
    </>
  )

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleFinish}
      onFinishFailed={onFinishFailed}
      onValuesChange={() => onDirtyChange?.(true)}
      disabled={saving}
      initialValues={initialValues}
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
          {rule ? rule.name || rule.id : '新建 Web 路由'}
        </Typography.Text>
        <RouteTypeTag type={type} />
        {rule ? (
          !rule.enable ? (
            <Tag>已停用</Tag>
          ) : rule.active ? (
            <Tag color="green">运行中</Tag>
          ) : (
            <Tooltip title={rule.configError || '监听器未运行或配置尚未生效'}>
              <Tag color="orange">未生效</Tag>
            </Tooltip>
          )
        ) : (
          <Tag>草稿</Tag>
        )}
        <Muted>
          {rule
            ? `${(Array.isArray(rule.domains) ? rule.domains : [])[0] || '全部域名'}${rule.path || '/'} · ${listenerName(listeners, rule.listenerId)}`
            : '保存后立即生效'}
        </Muted>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        tabBarGutter={8}
        items={[
          { key: 'basic', label: '基本', children: basicTab, forceRender: true },
          {
            key: 'target',
            label: targetLabel,
            children: type === 'redirect' ? redirectTab : type === 'static' ? staticTab : proxyTab,
            forceRender: true,
          },
          { key: 'access', label: '访问', children: accessTab, forceRender: true },
          { key: 'advanced', label: '高级', children: advancedTab, forceRender: true },
        ]}
      />

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
        {rule && onDelete ? (
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
