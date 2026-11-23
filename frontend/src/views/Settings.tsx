import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Switch, Tabs } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import { useAuth } from '../session'
import { useTheme } from '../theme'
import {
  ConfirmModal,
  DataTable,
  FormModal,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  SelectInput,
  StatusChip,
  SwitchInput,
  TagInput,
  TextInput,
  toast,
  type Column,
  type SelectOption,
} from '../ui'

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

interface SystemForm {
  adminListen: string
  baseUrl: string
  logLevel: string
  sessionTtlHours: number
  loginMaxFail: number
  loginLockMinutes: number
  trustProxy: boolean
  sessionBindIp: boolean
  checkUpdate: boolean
  theme: string
  adminAllowIps: string[]
  ip2regionDb: string
}

interface ListenState {
  actual: string
  config: string
  source: string
  env: string
  applied: boolean
  notice: string
}

interface AdminAllowInfo {
  restricted?: boolean
  failClosed?: boolean
  valid?: number
  blocked?: number
  entries?: string[]
}

interface SystemInfo {
  adminListen?: string
  adminListenConfig?: string
  adminListenSource?: string
  adminListenEnv?: string
  adminListenNotice?: string
  adminAllowList?: AdminAllowInfo | null
}

interface SystemSettingsResponse extends Partial<SystemForm> {
  adminListenConfig?: string
  adminListenSource?: string
  adminListenEnv?: string
  adminListenApplied?: boolean
  adminListenNotice?: string
}

interface IP2RegionStatus {
  path?: string
  loaded?: boolean
  ipVersion?: number
  size?: number
  createdAt?: string
  error?: string
}

interface IP2RegionLookup {
  ip?: string
  country?: string
  region?: string
  province?: string
  provinceNormalized?: string
  city?: string
  isp?: string
  raw?: string
}

interface IP2RegionState {
  path: string
  status: IP2RegionStatus
  testIP: string
  result: IP2RegionLookup | null
  saving: boolean
  reloading: boolean
  looking: boolean
}

interface UserRow {
  id: string
  username: string
  role?: string
  enabled: boolean
  mustChangePassword?: boolean
  createdAt?: string
  lastLogin?: string
}

interface TokenRow {
  id: string
  name: string
  scopes?: string[]
  enabled: boolean
  createdAt?: string
  lastUsed?: string
}

interface SessionRow {
  __key: string
  id?: string
  username: string
  ip?: string
  userAgent?: string
  createdAt?: string
  expiresAt?: string
  current?: boolean
}

interface ListState<T> {
  items: T[]
  loading: boolean
  loaded: boolean
  error: string
}

interface UserListState extends ListState<UserRow> {
  busyId: string
}

type NoticeStatus = 'accent' | 'danger' | 'default' | 'success' | 'warning'

/* -------------------------------------------------------------------------
 * Constants & helpers
 * ---------------------------------------------------------------------- */

const LOG_LEVELS: SelectOption[] = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const THEMES: SelectOption[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
]

const EMPTY_SYSTEM: SystemForm = {
  adminListen: '',
  baseUrl: '',
  logLevel: 'info',
  sessionTtlHours: 12,
  loginMaxFail: 5,
  loginLockMinutes: 10,
  trustProxy: false,
  sessionBindIp: false,
  checkUpdate: false,
  theme: 'dark',
  adminAllowIps: [],
  ip2regionDb: '',
}

const EMPTY_LISTEN: ListenState = {
  actual: '',
  config: '',
  source: 'config',
  env: '',
  applied: true,
  notice: '',
}

const EMPTY_IP2REGION: IP2RegionState = {
  path: '',
  status: {},
  testIP: '',
  result: null,
  saving: false,
  reloading: false,
  looking: false,
}

function emptyList<T>(): ListState<T> {
  return { items: [], loading: false, loaded: false, error: '' }
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  const items = (value as { items?: unknown } | null | undefined)?.items
  return Array.isArray(items) ? (items as T[]) : []
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(value ?? '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function adminListenURL(addr: string): string {
  const match = /:([0-9]+)\s*$/.exec(String(addr || '').trim())
  if (!match) return ''
  const loc = window.location
  return `${loc.protocol}//${loc.hostname || 'localhost'}:${match[1]}/`
}

function downloadText(filename: string, content: string, mime = 'application/json;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

function Notice({
  status,
  title,
  children,
}: {
  status: NoticeStatus
  title?: ReactNode
  children?: ReactNode
}) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        {children ? <Alert.Description>{children}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <div className="p-4 text-sm leading-6 text-muted">{children}</div>
}

function Separator() {
  return <div className="my-4 border-t border-border" />
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export default function Settings() {
  const { user } = useAuth()
  const { setTheme } = useTheme()
  const currentUsername = user?.username || ''

  const [tab, setTab] = useState('system')

  /* ---- system ---- */
  const [system, setSystem] = useState<SystemForm>(EMPTY_SYSTEM)
  const [systemLoading, setSystemLoading] = useState(false)
  const [systemSaving, setSystemSaving] = useState(false)
  const [systemLoaded, setSystemLoaded] = useState(false)
  const [systemError, setSystemError] = useState('')
  const [listen, setListen] = useState<ListenState>(EMPTY_LISTEN)
  const [allowInfo, setAllowInfo] = useState<AdminAllowInfo | null>(null)
  const [switched, setSwitched] = useState<{ addr: string; url: string } | null>(null)

  /* ---- ip2region ---- */
  const [ip2region, setIp2region] = useState<IP2RegionState>(EMPTY_IP2REGION)

  /* ---- users ---- */
  const [users, setUsers] = useState<UserListState>({ ...emptyList<UserRow>(), busyId: '' })
  const [userDialog, setUserDialog] = useState<{
    open: boolean
    editingId: string
    saving: boolean
    form: { username: string; password: string; enabled: boolean }
  }>({ open: false, editingId: '', saving: false, form: { username: '', password: '', enabled: true } })
  const [passwordDialog, setPasswordDialog] = useState<{
    open: boolean
    saving: boolean
    user: UserRow | null
    password: string
  }>({ open: false, saving: false, user: null, password: '' })
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null)
  const [disableUser, setDisableUser] = useState<UserRow | null>(null)

  /* ---- tokens ---- */
  const [tokens, setTokens] = useState<ListState<TokenRow>>(emptyList<TokenRow>())
  const [tokenDialog, setTokenDialog] = useState<{
    open: boolean
    saving: boolean
    form: { name: string; scopes: string[] }
  }>({ open: false, saving: false, form: { name: '', scopes: [] } })
  const [tokenResult, setTokenResult] = useState<{ open: boolean; name: string; token: string }>({
    open: false,
    name: '',
    token: '',
  })
  const [deleteToken, setDeleteToken] = useState<TokenRow | null>(null)

  /* ---- sessions ---- */
  const [sessions, setSessions] = useState<ListState<SessionRow>>(emptyList<SessionRow>())
  const [kickTarget, setKickTarget] = useState<SessionRow | null>(null)

  /* ---- backup ---- */
  const [configBusy, setConfigBusy] = useState('')
  const [rawDialog, setRawDialog] = useState({ open: false, loading: false, text: '' })
  const [importCandidate, setImportCandidate] = useState<unknown>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const envControlled = listen.source === 'env'
  const listenNotice = (() => {
    if (listen.notice) return listen.notice
    if (envControlled) {
      const env = listen.env || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT'
      return `当前监听地址由环境变量 ${env} 控制（实际生效 ${listen.actual || '未知'}）：修改配置不会改变运行中的端口，需移除该环境变量并重启服务后才生效。`
    }
    if (!listen.applied && listen.actual) {
      return `配置值 ${listen.config || '（空）'} 与实际监听地址 ${listen.actual} 不一致，请检查启动参数或重新保存设置。`
    }
    return ''
  })()

  const allowNotice = (() => {
    if (!allowInfo) return null
    if (allowInfo.failClosed) {
      return {
        status: 'danger' as NoticeStatus,
        text: `管理端 IP 白名单没有有效条目，当前会拒绝所有管理端访问（已拦截 ${allowInfo.blocked || 0} 次）。请尽快修正白名单。`,
      }
    }
    if (allowInfo.restricted) {
      return {
        status: 'accent' as NoticeStatus,
        text: `管理端 IP 白名单已生效：${allowInfo.valid || 0} 条有效规则，自启动以来已拦截 ${allowInfo.blocked || 0} 次请求。`,
      }
    }
    return {
      status: 'accent' as NoticeStatus,
      text: '管理端 IP 白名单未启用（留空）。任何能连接到管理端口的客户端都可以尝试登录。',
    }
  })()

  /* ---- system loading ---- */

  const applySettingsForm = (data: Partial<SystemForm>) => {
    setSystem({
      adminListen: data.adminListen || '',
      baseUrl: data.baseUrl || '',
      logLevel: data.logLevel || 'info',
      sessionTtlHours: Number(data.sessionTtlHours) || 12,
      loginMaxFail: Number(data.loginMaxFail) || 5,
      loginLockMinutes: Number(data.loginLockMinutes) || 10,
      trustProxy: !!data.trustProxy,
      sessionBindIp: !!data.sessionBindIp,
      checkUpdate: data.checkUpdate !== false,
      theme: data.theme || 'dark',
      adminAllowIps: toList(data.adminAllowIps),
      ip2regionDb: data.ip2regionDb || '',
    })
  }

  const applyListenFromInfo = (info: SystemInfo | null, settings: Partial<SystemForm> | null) => {
    if (!info) return
    setListen({
      actual: info.adminListen || '',
      config: info.adminListenConfig ?? settings?.adminListen ?? '',
      source: info.adminListenSource || 'config',
      env: info.adminListenEnv || '',
      applied: true,
      notice: info.adminListenNotice || '',
    })
    setAllowInfo(info.adminAllowList || null)
  }

  const applyServerResponse = (data: SystemSettingsResponse) => {
    applySettingsForm(data)
    setListen({
      actual: data.adminListen || '',
      config: data.adminListenConfig ?? data.adminListen ?? '',
      source: data.adminListenSource || 'config',
      env: data.adminListenEnv || '',
      applied: data.adminListenApplied !== false,
      notice: data.adminListenNotice || '',
    })
    // The form always shows the stored value; an env override only changes the
    // address that is really in use.
    setSystem((prev) => ({ ...prev, adminListen: data.adminListenConfig ?? data.adminListen ?? prev.adminListen }))
  }

  const loadSystem = async () => {
    if (systemLoading) return
    setSystemLoading(true)
    setSystemError('')
    try {
      const [settings, info] = await Promise.all([
        api.get<Partial<SystemForm>>('/api/v1/system/settings'),
        api.get<SystemInfo>('/api/v1/system/info').catch(() => null),
      ])
      applySettingsForm(settings || {})
      applyListenFromInfo(info, settings)
      const configListen = info?.adminListenConfig ?? settings?.adminListen ?? ''
      const actual = info?.adminListen || settings?.adminListen || ''
      setListen((prev) => ({ ...prev, config: configListen, actual }))
      setSystem((prev) => ({ ...prev, adminListen: configListen }))
      setIp2region((prev) =>
        prev.path ? prev : { ...prev, path: String(settings?.ip2regionDb || prev.path) },
      )
      setSystemLoaded(true)
    } catch (err) {
      setSystemError(errorText(err))
    } finally {
      setSystemLoading(false)
    }
  }

  const validateNumbers = (): boolean => {
    const rules: [number, number, number, string][] = [
      [system.sessionTtlHours, 1, 720, '会话有效期需要在 1–720 小时之间'],
      [system.loginMaxFail, 1, 100, '登录失败次数需要在 1–100 之间'],
      [system.loginLockMinutes, 1, 1440, '锁定时长需要在 1–1440 分钟之间'],
    ]
    for (const [value, min, max, message] of rules) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < min || number > max) {
        toast.warning(message)
        return false
      }
    }
    return true
  }

  const saveSystem = async () => {
    if (!validateNumbers()) return
    const payload = {
      adminListen: String(system.adminListen || '').trim(),
      adminAllowIps: toList(system.adminAllowIps),
      trustProxy: !!system.trustProxy,
      sessionBindIp: !!system.sessionBindIp,
      logLevel: system.logLevel || 'info',
      sessionTtlHours: Number(system.sessionTtlHours),
      loginMaxFail: Number(system.loginMaxFail),
      loginLockMinutes: Number(system.loginLockMinutes),
      theme: system.theme || 'dark',
      checkUpdate: !!system.checkUpdate,
      baseUrl: String(system.baseUrl || '').trim(),
      ip2regionDb: String(system.ip2regionDb || '').trim(),
    }
    const previous = listen.actual || listen.config
    setSystemSaving(true)
    try {
      const result = await api.put<SystemSettingsResponse>('/api/v1/system/settings', payload)
      if (result) applyServerResponse(result)
      else {
        applySettingsForm(payload)
        setListen((prev) => ({ ...prev, config: payload.adminListen, actual: payload.adminListen || prev.actual }))
      }
      if (payload.theme === 'dark' || payload.theme === 'light') {
        setTheme(payload.theme)
      }
      const effective = result?.adminListen || listen.actual || payload.adminListen
      if (result?.adminListenSource === 'env') {
        toast.warning('设置已保存；监听地址仍由环境变量控制，未改变实际端口')
      } else if (effective && previous && effective !== previous) {
        setSwitched({ addr: effective, url: adminListenURL(effective) })
        toast.success(`管理后台已切换到 ${effective}，当前页面仍在旧地址`)
      } else {
        toast.success('设置已保存')
      }
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSystemSaving(false)
    }
  }

  /* ---- ip2region ---- */

  const loadIP2Region = async () => {
    try {
      const data = await api.get<{ status?: IP2RegionStatus; provinces?: string[] }>(
        '/api/v1/system/ip2region',
      )
      const status = data?.status || {}
      setIp2region((prev) => ({
        ...prev,
        status,
        path: status.path || prev.path || system.ip2regionDb,
      }))
    } catch (err) {
      toast.danger(`读取 IP 地址库状态失败：${errorText(err)}`)
    }
  }

  const saveIP2Region = async () => {
    setIp2region((prev) => ({ ...prev, saving: true }))
    try {
      const path = ip2region.path.trim()
      const data = await api.put<{ status?: IP2RegionStatus }>('/api/v1/system/ip2region', { path })
      setIp2region((prev) => ({ ...prev, status: data?.status || {}, path }))
      setSystem((prev) => ({ ...prev, ip2regionDb: path }))
      toast.success(path ? 'IP 地址库已加载' : '已停用 IP 地址库')
    } catch (err) {
      toast.danger(`保存失败：${errorText(err)}`)
    } finally {
      setIp2region((prev) => ({ ...prev, saving: false }))
    }
  }

  const reloadIP2Region = async () => {
    setIp2region((prev) => ({ ...prev, reloading: true }))
    try {
      const data = await api.post<{ status?: IP2RegionStatus }>('/api/v1/system/ip2region/reload')
      setIp2region((prev) => ({ ...prev, status: data?.status || {} }))
      toast.success('IP 地址库已重新加载')
    } catch (err) {
      toast.danger(`重新加载失败：${errorText(err)}`)
    } finally {
      setIp2region((prev) => ({ ...prev, reloading: false }))
    }
  }

  const lookupIP2Region = async () => {
    const ip = ip2region.testIP.trim()
    if (!ip) {
      toast.warning('请输入要查询的 IP')
      return
    }
    setIp2region((prev) => ({ ...prev, looking: true }))
    try {
      const result = await api.post<IP2RegionLookup>('/api/v1/system/ip2region/lookup', { ip })
      setIp2region((prev) => ({ ...prev, result: result || null }))
    } catch (err) {
      setIp2region((prev) => ({ ...prev, result: null }))
      toast.danger(`查询失败：${errorText(err)}`)
    } finally {
      setIp2region((prev) => ({ ...prev, looking: false }))
    }
  }

  /* ---- users ---- */

  const loadUsers = async (force = false) => {
    if (users.loading) return
    if (users.loaded && !force) return
    setUsers((prev) => ({ ...prev, loading: true, error: '' }))
    try {
      const data = await api.get('/api/v1/auth/users')
      setUsers({ items: asArray<UserRow>(data), loading: false, loaded: true, error: '', busyId: '' })
    } catch (err) {
      setUsers((prev) => ({ ...prev, loading: false, loaded: true, error: errorText(err) }))
    }
  }

  const openCreateUser = () => {
    setUserDialog({ open: true, editingId: '', saving: false, form: { username: '', password: '', enabled: true } })
  }

  const openEditUser = (row: UserRow) => {
    setUserDialog({
      open: true,
      editingId: row.id,
      saving: false,
      form: { username: row.username || '', password: '', enabled: !!row.enabled },
    })
  }

  const saveUser = async () => {
    const username = userDialog.form.username.trim()
    const password = userDialog.form.password
    if (!username) {
      toast.warning('请填写用户名')
      return
    }
    if (!userDialog.editingId && password.length < 8) {
      toast.warning('密码长度至少 8 位')
      return
    }
    setUserDialog((prev) => ({ ...prev, saving: true }))
    try {
      if (userDialog.editingId) {
        await api.put(`/api/v1/auth/users/${encodeURIComponent(userDialog.editingId)}`, {
          username,
          enabled: !!userDialog.form.enabled,
        })
        toast.success('用户已更新')
      } else {
        await api.post('/api/v1/auth/users', {
          username,
          password,
          enabled: !!userDialog.form.enabled,
        })
        toast.success('用户已创建')
      }
      setUserDialog((prev) => ({ ...prev, open: false }))
      await loadUsers(true)
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setUserDialog((prev) => ({ ...prev, saving: false }))
    }
  }

  const openResetPassword = (row: UserRow) => {
    setPasswordDialog({ open: true, saving: false, user: row, password: '' })
  }

  const savePassword = async () => {
    const password = passwordDialog.password
    if (password.length < 8) {
      toast.warning('新密码长度至少 8 位')
      return
    }
    if (!passwordDialog.user?.id) {
      toast.danger('用户信息不完整，无法重置密码')
      return
    }
    setPasswordDialog((prev) => ({ ...prev, saving: true }))
    try {
      await api.put(`/api/v1/auth/users/${encodeURIComponent(passwordDialog.user.id)}`, { password })
      toast.success('密码已重置，该用户的会话已失效')
      setPasswordDialog((prev) => ({ ...prev, open: false }))
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setPasswordDialog((prev) => ({ ...prev, saving: false }))
    }
  }

  const applyToggleUser = async (row: UserRow, enabled: boolean) => {
    setUsers((prev) => ({ ...prev, busyId: row.id }))
    try {
      await api.put(`/api/v1/auth/users/${encodeURIComponent(row.id)}`, { enabled })
      setUsers((prev) => ({
        ...prev,
        items: prev.items.map((item) => (item.id === row.id ? { ...item, enabled } : item)),
      }))
      toast.success(enabled ? '用户已启用' : '用户已停用')
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setUsers((prev) => ({ ...prev, busyId: '' }))
    }
  }

  const requestToggleUser = (row: UserRow, enabled: boolean) => {
    if (row.username === currentUsername) {
      toast.warning('不能停用当前登录的账号')
      return
    }
    if (!enabled) {
      setDisableUser(row)
      return
    }
    void applyToggleUser(row, true)
  }

  const confirmDisableUser = async () => {
    const target = disableUser
    if (!target) return
    setDisableUser(null)
    await applyToggleUser(target, false)
  }

  const requestDeleteUser = (row: UserRow) => {
    if (row.username === currentUsername) {
      toast.warning('不能删除当前登录的账号')
      return
    }
    setDeleteUser(row)
  }

  const confirmDeleteUser = async () => {
    const target = deleteUser
    if (!target) return
    setDeleteUser(null)
    try {
      await api.del(`/api/v1/auth/users/${encodeURIComponent(target.id)}`)
      toast.success('用户已删除')
      await loadUsers(true)
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  /* ---- tokens ---- */

  const loadTokens = async (force = false) => {
    if (tokens.loading) return
    if (tokens.loaded && !force) return
    setTokens((prev) => ({ ...prev, loading: true, error: '' }))
    try {
      const data = await api.get('/api/v1/auth/tokens')
      setTokens({ items: asArray<TokenRow>(data), loading: false, loaded: true, error: '' })
    } catch (err) {
      setTokens((prev) => ({ ...prev, loading: false, loaded: true, error: errorText(err) }))
    }
  }

  const openCreateToken = () => {
    setTokenDialog({ open: true, saving: false, form: { name: '', scopes: [] } })
  }

  const createToken = async () => {
    const name = tokenDialog.form.name.trim()
    if (!name) {
      toast.warning('请填写 Token 名称')
      return
    }
    setTokenDialog((prev) => ({ ...prev, saving: true }))
    try {
      const result = await api.post<{ token?: string }>('/api/v1/auth/tokens', {
        name,
        scopes: toList(tokenDialog.form.scopes),
      })
      setTokenResult({ open: true, name, token: result?.token || '' })
      setTokenDialog((prev) => ({ ...prev, open: false }))
      await loadTokens(true)
      toast.success('Token 已创建，请立即复制保存')
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setTokenDialog((prev) => ({ ...prev, saving: false }))
    }
  }

  const copyTokenValue = async () => {
    const ok = await copyText(tokenResult.token)
    if (ok) toast.success('Token 已复制到剪贴板')
    else toast.danger('复制失败，请手动选择文本')
  }

  const confirmDeleteToken = async () => {
    const target = deleteToken
    if (!target) return
    setDeleteToken(null)
    try {
      await api.del(`/api/v1/auth/tokens/${encodeURIComponent(target.id)}`)
      toast.success('Token 已删除')
      await loadTokens(true)
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  /* ---- sessions ---- */

  const loadSessions = async (force = false) => {
    if (sessions.loading) return
    if (sessions.loaded && !force) return
    setSessions((prev) => ({ ...prev, loading: true, error: '' }))
    try {
      const data = await api.get('/api/v1/auth/sessions')
      const items = asArray<Omit<SessionRow, '__key'>>(data).map((row, index) => ({
        ...row,
        __key: row.id || `${row.username}|${row.ip}|${row.createdAt}|${index}`,
      }))
      setSessions({ items, loading: false, loaded: true, error: '' })
    } catch (err) {
      setSessions((prev) => ({ ...prev, loading: false, loaded: true, error: errorText(err) }))
    }
  }

  const findUserForSession = async (row: SessionRow): Promise<UserRow | null> => {
    let list = users.items
    let found = list.find((item) => item.username === row.username) || null
    if (found) return found
    try {
      const data = await api.get('/api/v1/auth/users')
      list = asArray<UserRow>(data)
      setUsers({ items: list, loading: false, loaded: true, error: '', busyId: '' })
    } catch (err) {
      toast.danger(`读取用户列表失败：${errorText(err)}`)
      return null
    }
    found = list.find((item) => item.username === row.username) || null
    return found
  }

  const resetPasswordForSession = async (row: SessionRow) => {
    const target = await findUserForSession(row)
    if (!target) {
      toast.warning('在用户列表中找不到该账号，可能已被删除')
      return
    }
    openResetPassword(target)
  }

  const requestKickSession = (row: SessionRow) => {
    if (row.current) {
      toast.info('这是当前登录会话，请使用右上角的「退出登录」')
      return
    }
    setKickTarget(row)
  }

  const confirmKickSession = async () => {
    const target = kickTarget
    if (!target) return
    setKickTarget(null)
    if (!target.id) {
      await resetPasswordForSession(target)
      return
    }
    try {
      await api.del(`/api/v1/auth/sessions/${encodeURIComponent(target.id)}`)
      toast.success('会话已踢出')
      await loadSessions(true)
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  /* ---- backup ---- */

  const exportConfig = async () => {
    setConfigBusy('export')
    try {
      const data = await api.get('/api/v1/system/config')
      const text = JSON.stringify(data, null, 2)
      const stamp = new Date().toISOString().slice(0, 10)
      downloadText(`nunt-config-${stamp}.json`, text)
      toast.success('配置已导出')
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setConfigBusy('')
    }
  }

  const showRawConfig = async () => {
    setRawDialog({ open: true, loading: true, text: '' })
    try {
      const data = await api.get('/api/v1/system/config')
      let text: string
      try {
        text = JSON.stringify(data, null, 2)
      } catch {
        text = String(data)
      }
      setRawDialog({ open: true, loading: false, text })
    } catch (err) {
      setRawDialog({ open: true, loading: false, text: `读取失败：${errorText(err)}` })
    }
  }

  const copyRawConfig = async () => {
    const ok = await copyText(rawDialog.text)
    if (ok) toast.success('已复制到剪贴板')
    else toast.danger('复制失败，请手动选择文本')
  }

  const pickImportFile = () => {
    const input = fileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files && input.files[0]
    input.value = ''
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      toast.danger('文件不是合法的 JSON')
      return
    }
    setImportCandidate(parsed)
  }

  const confirmImportConfig = async () => {
    if (importCandidate === null) return
    const parsed = importCandidate
    setImportCandidate(null)
    setConfigBusy('import')
    const previous = listen.actual || listen.config
    try {
      const result = await api.put<{
        adminListen?: string
        adminListenSource?: string
      }>('/api/v1/system/config', { config: parsed })
      const effective = result?.adminListen || ''
      const moved = result?.adminListenSource !== 'env' && effective && previous && effective !== previous
      toast.success('配置已导入并重新加载')
      if (result?.adminListenSource === 'env') {
        toast.warning('导入的监听地址仍由环境变量控制，实际端口未改变')
      } else if (moved) {
        // The old port is gone; keep showing the new address instead of
        // hammering an address that no longer answers.
        setSwitched({ addr: effective, url: adminListenURL(effective) })
      } else {
        await loadSystem()
        await Promise.all([loadUsers(true), loadTokens(true), loadSessions(true)])
      }
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setConfigBusy('')
    }
  }

  const reloadConfig = async () => {
    setConfigBusy('reload')
    try {
      await api.post('/api/v1/system/reload')
      toast.success('已通知各模块重新加载配置')
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setConfigBusy('')
    }
  }

  /* ---- initial load & lazy tabs ---- */

  useEffect(() => {
    void loadSystem()
    void loadIP2Region()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'users') void loadUsers()
    else if (tab === 'tokens') void loadTokens()
    else if (tab === 'sessions') void loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  /* ---- columns ---- */

  const userColumns: Column<UserRow>[] = [
    {
      key: 'username',
      title: '用户名',
      render: (row) => (
        <div className="flex items-center gap-2">
          <span>{row.username}</span>
          {row.username === currentUsername ? <StatusChip color="primary">当前</StatusChip> : null}
        </div>
      ),
    },
    { key: 'role', title: '角色', render: (row) => <span className="text-sm">{row.role || 'admin'}</span> },
    {
      key: 'status',
      title: '状态',
      render: (row) => {
        const self = row.username === currentUsername
        const busy = users.busyId === row.id
        return (
          <div className="flex items-center gap-2">
            <Switch
              size="sm"
              isSelected={!!row.enabled}
              isDisabled={self || busy}
              aria-label={`${row.username} 启用状态`}
              onChange={(enabled: boolean) => requestToggleUser(row, enabled)}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <span className={row.enabled ? 'text-sm text-success' : 'text-sm text-muted'}>
              {row.enabled ? '已启用' : '已停用'}
            </span>
            {row.mustChangePassword ? <StatusChip color="warning">待改密</StatusChip> : null}
          </div>
        )
      },
    },
    { key: 'lastLogin', title: '最近登录', render: (row) => <span className="text-sm text-muted">{fmtTime(row.lastLogin)}</span> },
    { key: 'createdAt', title: '创建时间', render: (row) => <span className="text-sm text-muted">{fmtTime(row.createdAt)}</span> },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onPress={() => openEditUser(row)}>
            编辑
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => openResetPassword(row)}>
            重置密码
          </Button>
          <Button
            size="sm"
            variant="danger-soft"
            isDisabled={row.username === currentUsername}
            onPress={() => requestDeleteUser(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ]

  const tokenColumns: Column<TokenRow>[] = [
    { key: 'name', title: '名称', render: (row) => <span className="text-sm">{row.name}</span> },
    {
      key: 'scopes',
      title: '权限范围',
      render: (row) =>
        Array.isArray(row.scopes) && row.scopes.length ? (
          <div className="flex flex-wrap gap-1">
            {row.scopes.map((scope) => (
              <StatusChip key={scope}>{scope}</StatusChip>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted">默认（完全管理权限）</span>
        ),
    },
    {
      key: 'enabled',
      title: '状态',
      render: (row) => (
        <StatusChip color={row.enabled ? 'success' : 'default'}>{row.enabled ? '有效' : '已停用'}</StatusChip>
      ),
    },
    { key: 'lastUsed', title: '最近使用', render: (row) => <span className="text-sm text-muted">{fmtTime(row.lastUsed)}</span> },
    { key: 'createdAt', title: '创建时间', render: (row) => <span className="text-sm text-muted">{fmtTime(row.createdAt)}</span> },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <Button size="sm" variant="danger-soft" onPress={() => setDeleteToken(row)}>
          删除
        </Button>
      ),
    },
  ]

  const sessionColumns: Column<SessionRow>[] = [
    {
      key: 'username',
      title: '用户',
      render: (row) => (
        <div className="flex items-center gap-2">
          <span>{row.username}</span>
          {row.current ? <StatusChip color="success">当前会话</StatusChip> : null}
        </div>
      ),
    },
    {
      key: 'ip',
      title: '来源 IP',
      render: (row) => <span className="mono text-sm text-muted">{row.ip || '-'}</span>,
    },
    {
      key: 'userAgent',
      title: '客户端',
      render: (row) => (
        <span className="block max-w-[280px] truncate text-sm text-muted" title={row.userAgent || ''}>
          {row.userAgent || '-'}
        </span>
      ),
    },
    { key: 'createdAt', title: '登录时间', render: (row) => <span className="text-sm text-muted">{fmtTime(row.createdAt)}</span> },
    { key: 'expiresAt', title: '过期时间', render: (row) => <span className="text-sm text-muted">{fmtTime(row.expiresAt)}</span> },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!!row.current}
            onPress={() => requestKickSession(row)}
          >
            踢出
          </Button>
          <Button size="sm" variant="tertiary" onPress={() => void resetPasswordForSession(row)}>
            重置密码
          </Button>
        </div>
      ),
    },
  ]

  const sessionMissingId = sessions.items.some((row) => !row.current && !row.id)

  return (
    <Page>
      <PageHeader
        title="系统设置"
        sub="系统参数、用户、API Token、在线会话与配置备份"
        actions={
          <Button variant="secondary" isDisabled={systemLoading} onPress={() => void loadSystem()}>
            刷新
          </Button>
        }
      />

      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))} className="w-full">
        <Tabs.ListContainer>
          <Tabs.List aria-label="设置分类">
            <Tabs.Tab id="system">系统</Tabs.Tab>
            <Tabs.Tab id="users">用户</Tabs.Tab>
            <Tabs.Tab id="tokens">Token</Tabs.Tab>
            <Tabs.Tab id="sessions">会话</Tabs.Tab>
            <Tabs.Tab id="backup">备份</Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="system">
          <div className="space-y-5 pt-4">
            {switched ? (
              <Notice status="success" title="管理后台监听地址已切换">
                <span>
                  新地址为 <code className="mono">{switched.addr}</code>，当前页面仍连接在旧地址上。
                </span>
                {switched.url ? (
                  <a
                    className="ml-2 font-medium text-link underline"
                    href={switched.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    用新地址打开
                  </a>
                ) : null}
              </Notice>
            ) : null}

            {listenNotice ? <Notice status="warning">{listenNotice}</Notice> : null}

            {allowNotice ? <Notice status={allowNotice.status}>{allowNotice.text}</Notice> : null}

            {systemError ? <Notice status="danger">{systemError}</Notice> : null}

            <Panel title="系统参数" extra={<span className="text-xs text-muted">监听地址保存后立即生效</span>}>
              {systemError && !systemLoaded ? (
                <div className="flex flex-col items-center gap-3 px-4 py-12 text-sm text-muted">
                  <span>无法读取系统设置：{systemError}</span>
                  <Button variant="primary" onPress={() => void loadSystem()}>
                    重试
                  </Button>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveSystem()
                  }}
                >
                  <div className="grid gap-4 p-4 md:grid-cols-2">
                    <TextInput
                      label="管理监听地址"
                      value={system.adminListen}
                      onChange={(value) => setSystem((prev) => ({ ...prev, adminListen: value }))}
                      placeholder=":8080 或 127.0.0.1:8080"
                      disabled={envControlled}
                      hint={
                        envControlled
                          ? `当前由环境变量 ${listen.env || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT'} 控制，修改配置不会改变运行中的端口`
                          : '保存后先绑定新地址再关闭旧地址；端口被占用或环境变量接管时会保留旧监听'
                      }
                    />
                    <TextInput
                      label="外部访问地址"
                      value={system.baseUrl}
                      onChange={(value) => setSystem((prev) => ({ ...prev, baseUrl: value }))}
                      placeholder="https://admin.example.com"
                      hint="用于生成回跳链接，可留空"
                    />

                    <SelectInput
                      label="日志级别"
                      value={system.logLevel}
                      onChange={(value) => setSystem((prev) => ({ ...prev, logLevel: value }))}
                      options={LOG_LEVELS}
                    />
                    <SelectInput
                      label="默认主题"
                      value={system.theme}
                      onChange={(value) => setSystem((prev) => ({ ...prev, theme: value }))}
                      options={THEMES}
                      hint="仅作为新设备的默认值，本机选择保存在浏览器中"
                    />

                    <NumberInput
                      label="会话有效期（小时）"
                      value={system.sessionTtlHours}
                      min={1}
                      max={720}
                      onChange={(value) => setSystem((prev) => ({ ...prev, sessionTtlHours: value }))}
                    />
                    <NumberInput
                      label="登录失败次数上限"
                      value={system.loginMaxFail}
                      min={1}
                      max={100}
                      onChange={(value) => setSystem((prev) => ({ ...prev, loginMaxFail: value }))}
                    />
                    <NumberInput
                      label="锁定时长（分钟）"
                      value={system.loginLockMinutes}
                      min={1}
                      max={1440}
                      onChange={(value) => setSystem((prev) => ({ ...prev, loginLockMinutes: value }))}
                    />

                    <SwitchInput
                      label="信任反向代理"
                      value={system.trustProxy}
                      onChange={(value) => setSystem((prev) => ({ ...prev, trustProxy: value }))}
                      hint="使用 X-Forwarded-For 识别客户端 IP，仅在管理端位于可信代理之后时开启"
                    />
                    <SwitchInput
                      label="会话绑定客户端 IP"
                      value={system.sessionBindIp}
                      onChange={(value) => setSystem((prev) => ({ ...prev, sessionBindIp: value }))}
                      hint="开启后会话只能从登录时的地址使用（移动网络会频繁重登）；User-Agent 始终校验"
                    />
                    <SwitchInput
                      label="检查更新"
                      value={system.checkUpdate}
                      onChange={(value) => setSystem((prev) => ({ ...prev, checkUpdate: value }))}
                      hint="启动时检查新版本"
                    />

                    <div className="md:col-span-2">
                      <TagInput
                        label="管理后台 IP 白名单"
                        value={system.adminAllowIps}
                        onChange={(value) => setSystem((prev) => ({ ...prev, adminAllowIps: value }))}
                        placeholder="输入 IP 或 CIDR 后按回车添加"
                        hint="留空表示不限制；支持单个地址与 CIDR，输入后按回车、逗号或分号添加"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                    <Button
                      type="submit"
                      variant="primary"
                      isDisabled={systemLoading || !systemLoaded || systemSaving}
                    >
                      {systemSaving ? '保存中…' : '保存设置'}
                    </Button>
                    <Button type="button" variant="tertiary" isDisabled={systemLoading} onPress={() => void loadSystem()}>
                      还原
                    </Button>
                    {systemLoading ? <span className="text-xs text-muted">正在读取系统设置…</span> : null}
                  </div>

                  {listen.actual || listen.config ? (
                    <div className="mono flex flex-wrap gap-4 border-t border-border px-4 py-3 text-xs text-muted">
                      <span>实际生效：{listen.actual || '-'}</span>
                      <span>配置值：{listen.config || '-'}</span>
                      <span>来源：{listen.source === 'env' ? `环境变量 ${listen.env || ''}` : '配置文件'}</span>
                    </div>
                  ) : null}
                </form>
              )}
            </Panel>

            <Panel title="IP 地址库（ip2region）" extra={<span className="text-xs text-muted">用于 Web / 端口转发的国家、省份过滤</span>}>
              <div className="p-4">
                <TextInput
                  label="数据库路径"
                  value={ip2region.path}
                  onChange={(value) => setIp2region((prev) => ({ ...prev, path: value }))}
                  placeholder="/data/ip2region.xdb"
                  hint="ip2region.xdb 文件路径；留空表示不启用地理过滤。数据库可从 github.com/lionsoul2014/ip2region 下载。"
                />

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button variant="primary" isDisabled={ip2region.saving} onPress={() => void saveIP2Region()}>
                    {ip2region.saving ? '保存中…' : '保存并加载'}
                  </Button>
                  <Button variant="secondary" isDisabled={ip2region.reloading} onPress={() => void reloadIP2Region()}>
                    {ip2region.reloading ? '重新加载中…' : '重新加载'}
                  </Button>
                  <StatusChip color={ip2region.status.loaded ? 'success' : 'default'}>
                    {ip2region.status.loaded ? '已加载' : '未加载'}
                  </StatusChip>
                  {ip2region.status.createdAt ? (
                    <span className="text-xs text-muted">数据日期：{fmtTime(ip2region.status.createdAt)}</span>
                  ) : null}
                  {ip2region.status.size ? (
                    <span className="text-xs text-muted">大小：{fmtBytes(ip2region.status.size)}</span>
                  ) : null}
                </div>

                {ip2region.status.error ? (
                  <div className="mt-3">
                    <Notice status="danger">{ip2region.status.error}</Notice>
                  </div>
                ) : null}

                <Separator />

                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-full sm:w-56">
                    <TextInput
                      label="查询测试"
                      value={ip2region.testIP}
                      onChange={(value) => setIp2region((prev) => ({ ...prev, testIP: value }))}
                      placeholder="1.1.1.1"
                    />
                  </div>
                  <Button variant="secondary" isDisabled={ip2region.looking} onPress={() => void lookupIP2Region()}>
                    {ip2region.looking ? '查询中…' : '查询'}
                  </Button>
                  {ip2region.result ? (
                    <span className="mono text-sm text-muted">
                      {ip2region.result.country || '-'} /{' '}
                      {ip2region.result.provinceNormalized || ip2region.result.province || '-'} /{' '}
                      {ip2region.result.isp || '-'}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 text-xs leading-6 text-muted">
                  省份按 ip2region 返回结果匹配，配置时可写「浙江」或「浙江省」；私有地址与 IPv6 不参与地理匹配。
                </div>
              </div>
            </Panel>
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="users">
          <div className="space-y-5 pt-4">
            <Panel
              title="用户管理"
              extra={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" isDisabled={users.loading} onPress={() => void loadUsers(true)}>
                    刷新
                  </Button>
                  <Button size="sm" variant="primary" onPress={openCreateUser}>
                    新建用户
                  </Button>
                </div>
              }
            >
              <div className="p-4">
                {users.error ? (
                  <div className="mb-3">
                    <Notice status="danger">{users.error}</Notice>
                  </div>
                ) : null}
                <div className={users.loading ? 'opacity-60' : ''}>
                  <DataTable
                    items={users.items}
                    columns={userColumns}
                    rowKey={(row) => row.id || `${row.username}-${row.createdAt || ''}`}
                    ariaLabel="用户列表"
                    empty="暂无用户，点右上角「新建用户」创建第一个账号"
                  />
                </div>
              </div>
            </Panel>
            <Panel>
              <Note>后端当前创建的账号均为管理员角色；重置密码后该用户的所有会话会立即失效。</Note>
            </Panel>
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="tokens">
          <div className="space-y-5 pt-4">
            <Panel
              title="API Token"
              extra={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" isDisabled={tokens.loading} onPress={() => void loadTokens(true)}>
                    刷新
                  </Button>
                  <Button size="sm" variant="primary" onPress={openCreateToken}>
                    新建 Token
                  </Button>
                </div>
              }
            >
              <div className="p-4">
                {tokens.error ? (
                  <div className="mb-3">
                    <Notice status="danger">{tokens.error}</Notice>
                  </div>
                ) : null}
                <div className={tokens.loading ? 'opacity-60' : ''}>
                  <DataTable
                    items={tokens.items}
                    columns={tokenColumns}
                    rowKey={(row) => row.id}
                    ariaLabel="API Token 列表"
                    empty="还没有创建 API Token"
                  />
                </div>
              </div>
            </Panel>
            <Panel>
              <Note>
                Token 仅在创建时完整显示一次，请立即复制保存；服务端只保存摘要。留空权限范围表示完全管理权限，填 read
                只会得到只读权限。
              </Note>
            </Panel>
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="sessions">
          <div className="space-y-5 pt-4">
            <Panel
              title="在线会话"
              extra={
                <Button size="sm" variant="secondary" isDisabled={sessions.loading} onPress={() => void loadSessions(true)}>
                  刷新
                </Button>
              }
            >
              <div className="p-4">
                {sessions.error ? (
                  <div className="mb-3">
                    <Notice status="danger">{sessions.error}</Notice>
                  </div>
                ) : null}
                {sessionMissingId ? (
                  <div className="mb-3">
                    <Notice status="accent">
                      当前后端返回的会话列表不含会话 ID，无法定向踢出；可在对应行使用「重置密码」让该用户全部会话立即失效。
                    </Notice>
                  </div>
                ) : null}
                <div className={sessions.loading ? 'opacity-60' : ''}>
                  <DataTable
                    items={sessions.items}
                    columns={sessionColumns}
                    rowKey={(row) => row.__key}
                    ariaLabel="在线会话列表"
                    empty="当前没有在线会话"
                  />
                </div>
              </div>
            </Panel>
            <Panel>
              <Note>
                会话保存在内存中，服务重启后全部失效。User-Agent 始终参与校验；开启「会话绑定客户端 IP」后还会校验来源地址。
              </Note>
            </Panel>
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="backup">
          <div className="space-y-5 pt-4">
            <Panel title="配置导入 / 导出">
              <div className="p-4">
                <Notice status="accent">
                  导出的 JSON 中所有密钥以 ******** 呈现；直接回导时这些字段会沿用现有值，不会把掩码写进配置。
                </Notice>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary" isDisabled={configBusy === 'export'} onPress={() => void exportConfig()}>
                    {configBusy === 'export' ? '导出中…' : '导出配置'}
                  </Button>
                  <Button variant="secondary" onPress={() => void showRawConfig()}>
                    查看当前配置 JSON
                  </Button>
                </div>

                <Separator />

                <div className="mb-3 text-sm leading-6 text-muted">
                  导入会替换配置（用户仅在带有密码哈希时被替换），随后自动重载各模块。
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" isDisabled={configBusy === 'import'} onPress={pickImportFile}>
                    {configBusy === 'import' ? '导入中…' : '选择配置文件并导入'}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(event) => void onImportFile(event)}
                  />
                </div>

                <Separator />

                <div className="mb-3 text-sm leading-6 text-muted">
                  修改配置文件后可用「重载配置」让各模块重新读取，无需重启进程。
                </div>
                <Button variant="secondary" isDisabled={configBusy === 'reload'} onPress={() => void reloadConfig()}>
                  {configBusy === 'reload' ? '重载中…' : '重载配置'}
                </Button>
              </div>
            </Panel>
          </div>
        </Tabs.Panel>
      </Tabs>

      {/* ------------------------------------------------------------------ */}
      {/* Modals                                                              */}
      {/* ------------------------------------------------------------------ */}

      <FormModal
        open={userDialog.open}
        onClose={() => {
          if (!userDialog.saving) setUserDialog((prev) => ({ ...prev, open: false }))
        }}
        title={userDialog.editingId ? '编辑用户' : '新建用户'}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="tertiary"
              isDisabled={userDialog.saving}
              onPress={() => setUserDialog((prev) => ({ ...prev, open: false }))}
            >
              取消
            </Button>
            <Button variant="primary" isDisabled={userDialog.saving} onPress={() => void saveUser()}>
              {userDialog.saving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <TextInput
            label="用户名"
            value={userDialog.form.username}
            onChange={(value) =>
              setUserDialog((prev) => ({ ...prev, form: { ...prev.form, username: value } }))
            }
            placeholder="登录用户名"
            required
          />
          {!userDialog.editingId ? (
            <TextInput
              label="密码"
              type="password"
              value={userDialog.form.password}
              onChange={(value) =>
                setUserDialog((prev) => ({ ...prev, form: { ...prev.form, password: value } }))
              }
              placeholder="初始密码"
              hint="至少 8 位"
              required
            />
          ) : null}
          <SwitchInput
            label="启用"
            value={userDialog.form.enabled}
            onChange={(value) => setUserDialog((prev) => ({ ...prev, form: { ...prev.form, enabled: value } }))}
            hint={userDialog.form.enabled ? '允许登录' : '禁止登录'}
          />
        </div>
      </FormModal>

      <FormModal
        open={passwordDialog.open}
        onClose={() => {
          if (!passwordDialog.saving) setPasswordDialog((prev) => ({ ...prev, open: false }))
        }}
        title={`重置密码${passwordDialog.user ? '：' + passwordDialog.user.username : ''}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="tertiary"
              isDisabled={passwordDialog.saving}
              onPress={() => setPasswordDialog((prev) => ({ ...prev, open: false }))}
            >
              取消
            </Button>
            <Button variant="primary" isDisabled={passwordDialog.saving} onPress={() => void savePassword()}>
              {passwordDialog.saving ? '重置中…' : '重置'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <Notice status="warning">重置后该用户的所有会话会立即失效（包括当前会话，如果重置的是本人）。</Notice>
          <TextInput
            label="新密码"
            type="password"
            value={passwordDialog.password}
            onChange={(value) => setPasswordDialog((prev) => ({ ...prev, password: value }))}
            hint="至少 8 位"
            required
          />
        </div>
      </FormModal>

      <FormModal
        open={tokenDialog.open}
        onClose={() => {
          if (!tokenDialog.saving) setTokenDialog((prev) => ({ ...prev, open: false }))
        }}
        title="新建 API Token"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="tertiary"
              isDisabled={tokenDialog.saving}
              onPress={() => setTokenDialog((prev) => ({ ...prev, open: false }))}
            >
              取消
            </Button>
            <Button variant="primary" isDisabled={tokenDialog.saving} onPress={() => void createToken()}>
              {tokenDialog.saving ? '创建中…' : '创建'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <TextInput
            label="名称"
            value={tokenDialog.form.name}
            onChange={(value) => setTokenDialog((prev) => ({ ...prev, form: { ...prev.form, name: value } }))}
            placeholder="例如：监控脚本"
            required
          />
          <TagInput
            label="权限范围"
            value={tokenDialog.form.scopes}
            onChange={(value) => setTokenDialog((prev) => ({ ...prev, form: { ...prev.form, scopes: value } }))}
            placeholder="输入范围后按回车添加"
            hint="留空表示完全管理权限（等同 admin）；填 read 只会得到只读权限"
          />
        </div>
      </FormModal>

      <FormModal
        open={tokenResult.open}
        onClose={() => setTokenResult((prev) => ({ ...prev, open: false }))}
        title={`Token 已创建${tokenResult.name ? '：' + tokenResult.name : ''}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="primary" onPress={() => void copyTokenValue()}>
              复制令牌
            </Button>
            <Button variant="tertiary" onPress={() => setTokenResult((prev) => ({ ...prev, open: false }))}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <Notice status="warning">请立即复制并妥善保存，关闭本窗口后将无法再次查看。</Notice>
          <textarea
            className="mono min-h-20 w-full resize-y rounded-md border border-border bg-default p-3 text-sm"
            readOnly
            rows={3}
            value={tokenResult.token || '（后端未返回令牌）'}
            aria-label="新 Token"
          />
        </div>
      </FormModal>

      <FormModal
        open={rawDialog.open}
        onClose={() => setRawDialog((prev) => ({ ...prev, open: false }))}
        title="当前配置（密钥已脱敏）"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="primary" isDisabled={rawDialog.loading} onPress={() => void copyRawConfig()}>
              复制
            </Button>
            <Button variant="tertiary" onPress={() => setRawDialog((prev) => ({ ...prev, open: false }))}>
              关闭
            </Button>
          </div>
        }
      >
        <pre className="mono max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-default p-3 text-xs leading-6">
          {rawDialog.loading ? '加载中…' : rawDialog.text}
        </pre>
      </FormModal>

      <ConfirmModal
        open={!!deleteUser}
        title="删除用户"
        content={
          <>
            确定要删除用户「{deleteUser?.username}」吗？该用户的所有会话会立即失效。
          </>
        }
        danger
        confirmText="删除"
        onCancel={() => setDeleteUser(null)}
        onConfirm={() => void confirmDeleteUser()}
      />

      <ConfirmModal
        open={!!disableUser}
        title="停用用户"
        content={
          <>
            确定要停用用户「{disableUser?.username}」吗？停用后该账号无法登录，但已有会话仍可能保持有效，如有需要请重置密码。
          </>
        }
        danger
        confirmText="停用"
        onCancel={() => setDisableUser(null)}
        onConfirm={() => void confirmDisableUser()}
      />

      <ConfirmModal
        open={!!deleteToken}
        title="删除 API Token"
        content={
          <>
            确定要删除 Token「{deleteToken?.name}」吗？使用它的客户端会立即失效。
          </>
        }
        danger
        confirmText="删除"
        onCancel={() => setDeleteToken(null)}
        onConfirm={() => void confirmDeleteToken()}
      />

      <ConfirmModal
        open={!!kickTarget}
        title={kickTarget?.id ? '踢出会话' : '无法定向踢出'}
        content={
          kickTarget?.id ? (
            <>
              确定结束用户「{kickTarget?.username}」来自 {kickTarget?.ip || '未知地址'} 的会话吗？
            </>
          ) : (
            <>
              当前后端返回的会话列表不含会话 ID，无法只结束「{kickTarget?.username}」的这一条会话。是否改为重置该用户密码？重置后该用户的所有会话会立即失效。
            </>
          )
        }
        danger={!!kickTarget?.id}
        confirmText={kickTarget?.id ? '踢出' : '重置密码'}
        onCancel={() => setKickTarget(null)}
        onConfirm={() => void confirmKickSession()}
      />

      <ConfirmModal
        open={importCandidate !== null}
        title="导入配置"
        content="导入会覆盖当前的系统、Web、转发、动态域名、证书、存储与 WAF 配置，确定继续吗？"
        danger
        confirmText="导入"
        onCancel={() => setImportCandidate(null)}
        onConfirm={() => void confirmImportConfig()}
      />
    </Page>
  )
}
