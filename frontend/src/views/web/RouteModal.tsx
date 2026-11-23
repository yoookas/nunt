import { useEffect, useState } from 'react'
import { Button, Input, TextField } from '@heroui/react'
import { api, errorText } from '../../api'
import { splitLines } from '../../format'
import { useProvinces } from '../../useProvinces'
import {
  FormModal,
  MultiSelectInput,
  NumberInput,
  SelectInput,
  SwitchInput,
  TagInput,
  TextAreaInput,
  TextInput,
  toast,
  type SelectOption,
} from '../../ui'
import {
  ACCESS_OPTIONS,
  BALANCE_OPTIONS,
  REDIRECT_STATUS_OPTIONS,
  TYPE_OPTIONS,
  balanceValue,
  kvToText,
  listenerOptions,
  normalizeAccessMode,
  textToKV,
  type AccessMode,
  type BasicAuthUser,
  type Certificate,
  type ProxyTarget,
  type RedirectTarget,
  type RouteType,
  type StaticTarget,
  type UAMode,
  type WebListenerView,
  type WebRule,
} from './types'

interface AuthUserForm {
  username: string
  password: string
}

interface RouteForm {
  name: string
  enable: boolean
  listenerId: string
  type: RouteType
  domains: string
  path: string
  priority: number
  remark: string
  waf: boolean
  accessMode: AccessMode
  accessIps: string
  accessCountries: string[]
  accessProvinces: string[]
  uaMode: UAMode
  uaList: string
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
  redirectTo: string
  redirectStatus: number
  redirectKeep: boolean
  staticRoot: string
  staticIndex: string
  staticListing: boolean
  staticSPA: boolean
  staticCache: number
}

function blankForm(): RouteForm {
  return {
    name: '',
    enable: true,
    listenerId: '',
    type: 'proxy',
    domains: '',
    path: '/',
    priority: 0,
    remark: '',
    waf: false,
    accessMode: 'off',
    accessIps: '',
    accessCountries: [],
    accessProvinces: [],
    uaMode: 'off',
    uaList: '',
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
    redirectTo: '',
    redirectStatus: 302,
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

function Section({ title }: { title: string }) {
  return (
    <div className="md:col-span-2 mt-2 border-b border-border pb-1 text-xs font-semibold text-muted">
      {title}
    </div>
  )
}

export default function RouteModal({
  open,
  rule,
  listeners,
  certificates,
  defaultListenerId,
  onClose,
  onSaved,
}: {
  open: boolean
  rule: WebRule | null
  listeners: WebListenerView[]
  certificates: Certificate[]
  defaultListenerId: string
  onClose: () => void
  onSaved: () => void
}) {
  const provinces = useProvinces()
  const [form, setForm] = useState<RouteForm>(blankForm)
  const [existingAuthNames, setExistingAuthNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!rule) {
      const fallback =
        defaultListenerId && listeners.some((item) => item.id === defaultListenerId)
          ? defaultListenerId
          : listeners.length === 1
            ? listeners[0].id
            : ''
      setExistingAuthNames([])
      setForm({ ...blankForm(), listenerId: fallback })
      return
    }

    const access = rule.access
    const auth = rule.basicAuth
    const proxy = rule.proxy
    const redirect = rule.redirect
    const stat = rule.static
    setExistingAuthNames(
      (Array.isArray(auth?.users) ? auth?.users ?? [] : []).map((user) => user.username),
    )
    setForm({
      ...blankForm(),
      name: rule.name || '',
      enable: !!rule.enable,
      listenerId: rule.listenerId || defaultListenerId,
      type: rule.type || 'proxy',
      domains: (Array.isArray(rule.domains) ? rule.domains : []).join('\n'),
      path: rule.path || '/',
      priority: num(rule.priority, 0),
      remark: rule.remark || '',
      waf: !!rule.waf,
      accessMode: normalizeAccessMode(access?.mode),
      accessIps: (Array.isArray(access?.ips) ? access?.ips ?? [] : []).join('\n'),
      accessCountries: Array.isArray(access?.countries) ? [...(access?.countries ?? [])] : [],
      accessProvinces: Array.isArray(access?.provinces) ? [...(access?.provinces ?? [])] : [],
      uaMode: normalizeAccessMode(access?.uaMode),
      uaList: (Array.isArray(access?.uas) ? access?.uas ?? [] : []).join('\n'),
      authEnable: !!auth?.enable,
      authUsers: (Array.isArray(auth?.users) ? auth?.users ?? [] : []).map((user) => ({
        username: user.username || '',
        password: '',
      })),
      proxyTargets: (Array.isArray(proxy?.targets) ? proxy?.targets ?? [] : []).join('\n'),
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
      redirectTo: redirect?.to || '',
      redirectStatus: num(redirect?.status, 302) || 302,
      redirectKeep: !!redirect?.keepPath,
      staticRoot: stat?.root || '',
      staticIndex: (Array.isArray(stat?.index) ? stat?.index ?? [] : []).join(' '),
      staticListing: !!stat?.listing,
      staticSPA: !!stat?.spa,
      staticCache: num(stat?.cacheSeconds, 0),
    })
    // `listeners` is deliberately not a dependency: reloading the listener list
    // while the dialog is open must not wipe the form the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule, defaultListenerId])

  const patch = (next: Partial<RouteForm>) => setForm((prev) => ({ ...prev, ...next }))

  // Advanced fields stay folded unless the rule already uses one of them, so
  // editing a simple rule does not show a wall of options.
  useEffect(() => {
    if (!rule) {
      setAdvanced(false)
      return
    }
    const p = rule.proxy
    setAdvanced(
      Number(rule.priority || 0) !== 0 ||
        !!rule.remark ||
        Number(p?.timeoutSec || 0) > 0 ||
        Number(p?.rateLimitPerSec || 0) > 0 ||
        Number(p?.maxBodyBytes || 0) > 0 ||
        !!p?.insecureTls ||
        !!p?.disableCompression ||
        !!p?.h2c ||
        !!p?.pathPrefix ||
        !!p?.pathReplace ||
        Object.keys(p?.headers || {}).length > 0 ||
        Object.keys(p?.respHeaders || {}).length > 0,
    )
  }, [rule])

  const updateUser = (index: number, next: Partial<AuthUserForm>) => {
    setForm((prev) => ({
      ...prev,
      authUsers: prev.authUsers.map((user, position) =>
        position === index ? { ...user, ...next } : user,
      ),
    }))
  }

  const save = async () => {
    const name = form.name.trim()
    if (!name) {
      toast.warning('请填写路由名称')
      return
    }
    if (!form.listenerId || !listeners.some((item) => item.id === form.listenerId)) {
      toast.warning('请选择所属监听器')
      return
    }

    const type = form.type
    const domains = splitLines(form.domains)
    const proxyTargets = splitLines(form.proxyTargets)
    if (type === 'proxy' && !proxyTargets.length) {
      toast.warning('反向代理路由至少需要一个上游地址')
      return
    }
    if (type === 'redirect' && !form.redirectTo.trim()) {
      toast.warning('重定向路由必须填写目标地址')
      return
    }
    if (type === 'static' && !form.staticRoot.trim()) {
      toast.warning('静态托管路由必须填写本机目录')
      return
    }

    const users: BasicAuthUser[] = form.authUsers
      .map((user) => ({
        username: String(user.username || '').trim(),
        password: String(user.password || ''),
      }))
      .filter((user) => user.username || user.password)
    if (form.authEnable) {
      if (!users.length) {
        toast.warning('启用 BasicAuth 后至少需要一个账号')
        return
      }
      if (users.some((user) => !user.username)) {
        toast.warning('BasicAuth 账号的用户名不能为空')
        return
      }
      const missing = users.filter(
        (user) => !user.password && !existingAuthNames.includes(user.username),
      )
      if (missing.length) {
        toast.warning(`账号「${missing[0].username}」还没有设置密码`)
        return
      }
      if (new Set(users.map((user) => user.username)).size !== users.length) {
        toast.warning('BasicAuth 账号的用户名不能重复')
        return
      }
    }

    const authUsers = form.authEnable
      ? users
      : users.filter((user) => existingAuthNames.includes(user.username))

    const payload: {
      name: string
      enable: boolean
      type: RouteType
      listenerId: string
      domains: string[]
      path: string
      priority: number
      waf: boolean
      access: {
        mode: AccessMode
        ips: string[]
        countries: string[]
        provinces: string[]
        uaMode: UAMode
        uas: string[]
      }
      basicAuth: { enable: boolean; users: BasicAuthUser[] }
      proxy: ProxyTarget | null
      redirect: RedirectTarget | null
      static: StaticTarget | null
      remark: string
    } = {
      name,
      enable: !!form.enable,
      type,
      listenerId: form.listenerId,
      domains,
      path: form.path.trim() || '/',
      priority: num(form.priority, 0),
      waf: !!form.waf,
      access: {
        mode: form.accessMode,
        ips: splitLines(form.accessIps),
        countries: [...form.accessCountries],
        provinces: [...form.accessProvinces],
        uaMode: form.uaMode,
        uas: splitLines(form.uaList),
      },
      // Keeping the existing accounts while BasicAuth is off avoids losing
      // them on an unrelated edit; the backend keeps the stored hashes for
      // names it already knows when the password is empty.
      basicAuth: { enable: !!form.authEnable, users: authUsers },
      proxy: null,
      redirect: null,
      static: null,
      remark: form.remark.trim(),
    }

    if (type === 'proxy') {
      payload.proxy = {
        targets: proxyTargets,
        balance: balanceValue(form.proxyBalance),
        hostHeader: form.proxyHostHeader.trim(),
        headers: textToKV(form.proxyHeaders),
        respHeaders: textToKV(form.proxyRespHeaders),
        pathPrefix: form.proxyPathPrefix.trim(),
        pathReplace: form.proxyPathReplace.trim(),
        timeoutSec: num(form.proxyTimeout, 0),
        insecureTls: !!form.proxyInsecure,
        disableCompression: !!form.proxyNoCompress,
        h2c: !!form.proxyH2C,
        rateLimitPerSec: num(form.proxyRateLimit, 0),
        maxBodyBytes: num(form.proxyMaxBody, 0),
      }
    } else if (type === 'redirect') {
      payload.redirect = {
        to: form.redirectTo.trim(),
        status: num(form.redirectStatus, 302),
        keepPath: !!form.redirectKeep,
      }
    } else if (type === 'static') {
      payload.static = {
        root: form.staticRoot.trim(),
        index: form.staticIndex
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean),
        listing: !!form.staticListing,
        spa: !!form.staticSPA,
        cacheSeconds: num(form.staticCache, 0),
      }
    }

    setSaving(true)
    try {
      if (rule) {
        await api.put(`/api/v1/web/rules/${encodeURIComponent(rule.id)}`, payload)
      } else {
        await api.post('/api/v1/web/rules', payload)
      }
      toast.success('保存成功')
      onClose()
      onSaved()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={rule ? '编辑 Web 路由' : '新建 Web 路由'}
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="tertiary" isDisabled={saving} onPress={onClose}>
            取消
          </Button>
          <Button variant="primary" isDisabled={saving} onPress={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      }
    >
      <div className="max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
          <Section title="基本信息" />
          <TextInput
            label="名称"
            value={form.name}
            onChange={(value) => patch({ name: value })}
            placeholder="例如 博客首页"
            required
          />
          <SelectInput
            label="所属监听器"
            value={form.listenerId}
            onChange={(value) => patch({ listenerId: value })}
            options={listenerOptions(listeners)}
            placeholder="选择监听器"
            required
            hint="端口与 TLS 由所属监听器统一配置，路由不再单独设置"
          />
          <SelectInput
            label="类型"
            value={form.type}
            onChange={(value) => patch({ type: value as RouteType })}
            options={TYPE_OPTIONS}
            required
          />
          <TextInput
            label="路径"
            value={form.path}
            onChange={(value) => patch({ path: value })}
            placeholder="/"
            hint="前缀匹配，例如 /blog"
          />
          <SwitchInput
            label="启用"
            value={form.enable}
            onChange={(value) => patch({ enable: value })}
            hint="停用后路由保留配置但不再对外服务"
          />
          <div className="md:col-span-2">
            <TextAreaInput
              label="域名"
              value={form.domains}
              onChange={(value) => patch({ domains: value })}
              rows={2}
              placeholder="每行一个域名，例如 example.com、*.example.com"
              hint="留空表示匹配任意 Host，支持 *.example.com 通配"
            />
          </div>

          <div className="md:col-span-2 mt-1">
            <SwitchInput
              label="高级选项"
              value={advanced}
              onChange={setAdvanced}
              hint="优先级、备注、超时、限速、请求体上限、路径重写、自定义请求/响应头；不展开也能正常保存"
            />
          </div>

          {advanced ? (
            <>
              <NumberInput
                label="优先级"
                value={form.priority}
                onChange={(value) => patch({ priority: Number.isFinite(value) ? value : 0 })}
                min={0}
                hint="数字越小越优先，默认 0"
              />
              <TextInput
                label="备注"
                value={form.remark}
                onChange={(value) => patch({ remark: value })}
                placeholder="可选"
              />
            </>
          ) : null}

          {form.type === 'proxy' ? (
            <>
              <Section title="反向代理" />
              <div className="md:col-span-2">
                <TextAreaInput
                  label="上游列表"
                  value={form.proxyTargets}
                  onChange={(value) => patch({ proxyTargets: value })}
                  rows={3}
                  placeholder="每行一个，例如 http://127.0.0.1:8080"
                  hint="支持 http/https，未写协议时默认 http://"
                  required
                />
              </div>
              <SelectInput
                label="负载均衡"
                value={form.proxyBalance}
                onChange={(value) => patch({ proxyBalance: value })}
                options={BALANCE_OPTIONS}
              />
              <TextInput
                label="Host 头"
                value={form.proxyHostHeader}
                onChange={(value) => patch({ proxyHostHeader: value })}
                placeholder="留空透传客户端 Host"
              />
              {advanced ? (
                <>
              <NumberInput
                label="超时（秒）"
                value={form.proxyTimeout}
                onChange={(value) => patch({ proxyTimeout: Number.isFinite(value) ? value : 0 })}
                min={0}
                hint="0 表示使用默认值"
              />
              <NumberInput
                label="限速（请求/秒）"
                value={form.proxyRateLimit}
                onChange={(value) =>
                  patch({ proxyRateLimit: Number.isFinite(value) ? value : 0 })
                }
                min={0}
                hint="按客户端地址限速，0 表示不限制"
              />
              <NumberInput
                label="请求体上限（字节）"
                value={form.proxyMaxBody}
                onChange={(value) => patch({ proxyMaxBody: Number.isFinite(value) ? value : 0 })}
                min={0}
                hint="0 表示不限制，1048576 = 1 MiB"
              />
              <SwitchInput
                label="跳过上游证书校验"
                value={form.proxyInsecure}
                onChange={(value) => patch({ proxyInsecure: value })}
              />
              <SwitchInput
                label="禁用压缩"
                value={form.proxyNoCompress}
                onChange={(value) => patch({ proxyNoCompress: value })}
              />
              <SwitchInput
                label="h2c 上游"
                value={form.proxyH2C}
                onChange={(value) => patch({ proxyH2C: value })}
                hint="明文 HTTP/2 上游，原生 gRPC 常用"
              />
              <TextInput
                label="路径重写前缀"
                value={form.proxyPathPrefix}
                onChange={(value) => patch({ proxyPathPrefix: value })}
                placeholder="例如 /api"
              />
              <TextInput
                label="路径替换为"
                value={form.proxyPathReplace}
                onChange={(value) => patch({ proxyPathReplace: value })}
                placeholder="例如 /"
              />
              <div className="md:col-span-2">
                <TextAreaInput
                  label="请求头"
                  value={form.proxyHeaders}
                  onChange={(value) => patch({ proxyHeaders: value })}
                  rows={2}
                  placeholder="每行一条，例如 X-Real-IP: $remote_addr"
                />
              </div>
              <div className="md:col-span-2">
                <TextAreaInput
                  label="响应头"
                  value={form.proxyRespHeaders}
                  onChange={(value) => patch({ proxyRespHeaders: value })}
                  rows={2}
                  placeholder="每行一条，例如 X-Frame-Options: DENY"
                />
              </div>
                </>
              ) : null}
            </>
          ) : null}

          {form.type === 'redirect' ? (
            <>
              <Section title="重定向" />
              <div className="md:col-span-2">
                <TextInput
                  label="目标地址"
                  value={form.redirectTo}
                  onChange={(value) => patch({ redirectTo: value })}
                  placeholder="https://example.com/new"
                  required
                />
              </div>
              <SelectInput
                label="状态码"
                value={String(form.redirectStatus)}
                onChange={(value) => patch({ redirectStatus: num(value, 302) })}
                options={REDIRECT_STATUS_OPTIONS}
              />
              <SwitchInput
                label="保留原始路径"
                value={form.redirectKeep}
                onChange={(value) => patch({ redirectKeep: value })}
                hint="开启后把请求路径拼接在目标地址之后"
              />
            </>
          ) : null}

          {form.type === 'static' ? (
            <>
              <Section title="静态托管" />
              <TextInput
                label="本地目录"
                value={form.staticRoot}
                onChange={(value) => patch({ staticRoot: value })}
                placeholder="例如 /var/www/site"
                hint="本机目录，必须存在且服务进程可读"
                required
              />
              <TextInput
                label="索引文件"
                value={form.staticIndex}
                onChange={(value) => patch({ staticIndex: value })}
                placeholder="index.html index.htm"
                hint="空格分隔"
              />
              <NumberInput
                label="缓存秒数"
                value={form.staticCache}
                onChange={(value) => patch({ staticCache: Number.isFinite(value) ? value : 0 })}
                min={0}
                hint="0 表示不缓存"
              />
              <SwitchInput
                label="目录列表"
                value={form.staticListing}
                onChange={(value) => patch({ staticListing: value })}
              />
              <SwitchInput
                label="单页应用模式"
                value={form.staticSPA}
                onChange={(value) => patch({ staticSPA: value })}
                hint="找不到文件时回退到 index.html"
              />
            </>
          ) : null}

          <Section title="访问控制" />
          <SelectInput
            label="IP 策略"
            value={form.accessMode}
            onChange={(value) => patch({ accessMode: normalizeAccessMode(value) })}
            options={ACCESS_OPTIONS}
          />
          <SelectInput
            label="UA 策略"
            value={form.uaMode}
            onChange={(value) => patch({ uaMode: normalizeAccessMode(value) })}
            options={ACCESS_OPTIONS}
          />
          {form.accessMode !== 'off' ? (
            <>
              <div className="md:col-span-2">
                <TextAreaInput
                  label="IP 列表"
                  value={form.accessIps}
                  onChange={(value) => patch({ accessIps: value })}
                  rows={2}
                  placeholder="每行一条，支持 CIDR，例如 192.168.1.0/24"
                  hint="与下面的国家/省份取并集，命中任意一条即放行（白名单）或拒绝（黑名单）"
                />
              </div>
              <div className="md:col-span-2">
                <TagInput
                  label="国家/地区（ip2region）"
                  value={form.accessCountries}
                  onChange={(value) => patch({ accessCountries: value })}
                  placeholder="输入国家名后回车，例如 中国、美国"
                  hint="与 IP 列表取并集；需先在「设置 → IP 地址库」配置数据库"
                />
              </div>
              <div className="md:col-span-2">
                <MultiSelectInput
                  label="省份（ip2region）"
                  value={form.accessProvinces}
                  onChange={(value) => patch({ accessProvinces: value })}
                  options={provinces.options}
                  placeholder="选择省份"
                  hint={`省份列表${provinces.source === 'database' ? '来自 ip2region 地址库' : '为内置列表'}，私有地址不参与地理匹配`}
                />
              </div>
            </>
          ) : null}
          {form.uaMode !== 'off' ? (
            <div className="md:col-span-2">
              <TextAreaInput
                label="UA 列表"
                value={form.uaList}
                onChange={(value) => patch({ uaList: value })}
                rows={2}
                placeholder="每行一条，支持 * 通配，例如 *bot*"
              />
            </div>
          ) : null}

          <Section title="BasicAuth" />
          <SwitchInput
            label="启用 BasicAuth"
            value={form.authEnable}
            onChange={(value) => patch({ authEnable: value })}
          />
          {form.authEnable ? (
            <div className="md:col-span-2 flex flex-col gap-2">
              {form.authUsers.length ? (
                <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <span className="text-xs text-muted">用户名</span>
                  <span className="text-xs text-muted">密码</span>
                  <span />
                </div>
              ) : (
                <div className="text-xs text-muted">还没有账号，至少添加一个账号才能生效。</div>
              )}
              {form.authUsers.map((user, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <TextField
                    value={user.username}
                    onChange={(value) => updateUser(index, { username: value })}
                    aria-label={`第 ${index + 1} 个账号的用户名`}
                  >
                    <Input placeholder="用户名" />
                  </TextField>
                  <TextField
                    value={user.password}
                    onChange={(value) => updateUser(index, { password: value })}
                    aria-label={`第 ${index + 1} 个账号的密码`}
                  >
                    <Input
                      type="password"
                      placeholder={
                        existingAuthNames.includes(user.username) ? '留空表示不修改密码' : '密码'
                      }
                    />
                  </TextField>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() =>
                      patch({ authUsers: form.authUsers.filter((_, position) => position !== index) })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => patch({ authUsers: [...form.authUsers, { username: '', password: '' }] })}
                >
                  添加账号
                </Button>
              </div>
              <div className="field-hint">已有账号的密码留空表示保持原密码；新增账号必须填写密码。</div>
            </div>
          ) : null}

          <Section title="WAF" />
          <SwitchInput
            label="WAF 检查"
            value={form.waf}
            onChange={(value) => patch({ waf: value })}
            hint="关闭后该路由完全不经过 WAF"
          />
        </div>
      </div>
    </FormModal>
  )
}
