import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Switch, Tabs } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import { useAuth } from '../session'
import TotpPanel from './settings/TotpPanel'
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
  theme: string
  adminAllowIps: string[]
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

interface SessionRow {
  __key: string
  id?: string
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
  { value: 'system', label: '跟随系统' },
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
  theme: 'dark',
  adminAllowIps: [],
}

const EMPTY_LISTEN: ListenState = {
  actual: '',
  config: '',
  source: 'config',
  env: '',
  applied: true,
  notice: '',
}

interface LogForm {
  persist: boolean
  keepDays: number
  maxFileMb: number
  appMaxFileMb: number
  appKeepFiles: number
}

const EMPTY_LOG: LogForm = {
  persist: true,
  keepDays: 7,
  maxFileMb: 64,
  appMaxFileMb: 8,
  appKeepFiles: 3,
}

interface LogFileRow {
  name: string
  size: number
  modTime: string
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

function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs leading-5 text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Separator() {
  return <div className="my-4 border-t border-border" />
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export default function Settings() {
  const { setTheme } = useTheme()

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

  /* ---- logs ---- */
  const [logForm, setLogForm] = useState<LogForm>(EMPTY_LOG)
  const [logLoading, setLogLoading] = useState(false)
  const [logSaving, setLogSaving] = useState(false)
  const [logFiles, setLogFiles] = useState<LogFileRow[]>([])

  /* ---- sessions ---- */
  const [sessions, setSessions] = useState<ListState<SessionRow>>(emptyList<SessionRow>())
  const [kickTarget, setKickTarget] = useState<SessionRow | null>(null)

  /* ---- backup ---- */
  const [configBusy, setConfigBusy] = useState('')
  const [backupCfg, setBackupCfg] = useState({ enabled: false, intervalHours: 24, keep: 7, dir: '' })
  const [backupFiles, setBackupFiles] = useState<{ name: string; size: number; modTime: string }[]>([])
  const [backupDir, setBackupDir] = useState('')
  const [backupSaving, setBackupSaving] = useState(false)

  const loadBackup = async () => {
    try {
      const data = await api.get<any>('/api/v1/system/backup/files')
      const cfg = data?.config || {}
      setBackupCfg({
        enabled: !!cfg.enabled,
        intervalHours: Number(cfg.intervalHours) || 24,
        keep: Number(cfg.keep) || 7,
        dir: String(cfg.dir || ''),
      })
      setBackupFiles(Array.isArray(data?.files) ? data.files : [])
      setBackupDir(String(data?.dir || ''))
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const saveBackup = async () => {
    setBackupSaving(true)
    try {
      await api.put('/api/v1/system/backup/config', backupCfg)
      toast.success('备份设置已保存')
      await loadBackup()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBackupSaving(false)
    }
  }
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
      theme: data.theme || 'dark',
      adminAllowIps: toList(data.adminAllowIps),
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
      setSystemLoaded(true)
    } catch (err) {
      setSystemError(errorText(err))
    } finally {
      setSystemLoading(false)
    }
  }

  /* ---- logs ---- */

  const loadLogs = async () => {
    if (logLoading) return
    setLogLoading(true)
    try {
      const [cfg, files] = await Promise.all([
        api.get<any>('/api/v1/logs/config'),
        api.get<LogFileRow[]>('/api/v1/system/logs/files').catch(() => []),
      ])
      setLogForm({
        persist: cfg?.access?.persist !== false,
        keepDays: Number(cfg?.access?.keepDays) || 7,
        maxFileMb: Number(cfg?.access?.maxFileMb) || 64,
        appMaxFileMb: Number(cfg?.app?.maxFileMb) || 8,
        appKeepFiles: Number(cfg?.app?.keepFiles) || 3,
      })
      setLogFiles(Array.isArray(files) ? files : [])
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setLogLoading(false)
    }
  }

  const saveLogs = async () => {
    const rules: [number, number, number, string][] = [
      [logForm.keepDays, 1, 365, '访问日志保留天数需要在 1–365 之间'],
      [logForm.maxFileMb, 1, 1024, '访问日志单文件上限需要在 1–1024 MB 之间'],
      [logForm.appMaxFileMb, 1, 1024, '运行日志单文件上限需要在 1–1024 MB 之间'],
      [logForm.appKeepFiles, 1, 10, '运行日志保留份数需要在 1–10 之间'],
    ]
    for (const [value, min, max, message] of rules) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < min || number > max) {
        toast.warning(message)
        return
      }
    }
    setLogSaving(true)
    try {
      await api.put('/api/v1/logs/config', {
        access: { persist: logForm.persist, keepDays: logForm.keepDays, maxFileMb: logForm.maxFileMb },
        app: { maxFileMb: logForm.appMaxFileMb, keepFiles: logForm.appKeepFiles },
      })
      toast.success('日志设置已保存')
      void loadLogs()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setLogSaving(false)
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
      baseUrl: String(system.baseUrl || '').trim(),
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
      if (payload.theme === 'dark' || payload.theme === 'light' || payload.theme === 'system') {
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

  /* ---- sessions ---- */

  const loadSessions = async (force = false) => {
    if (sessions.loading) return
    if (sessions.loaded && !force) return
    setSessions((prev) => ({ ...prev, loading: true, error: '' }))
    try {
      const data = await api.get('/api/v1/auth/sessions')
      const items = asArray<Omit<SessionRow, '__key'>>(data).map((row, index) => ({
        ...row,
        __key: row.id || `${row.ip}|${row.createdAt}|${index}`,
      }))
      setSessions({ items, loading: false, loaded: true, error: '' })
    } catch (err) {
      setSessions((prev) => ({ ...prev, loading: false, loaded: true, error: errorText(err) }))
    }
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
      toast.warning('会话已失效，请让对方重新登录')
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
        await loadSessions(true)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'logs') void loadLogs()
    else if (tab === 'sessions') void loadSessions()
    else if (tab === 'backup') void loadBackup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  /* ---- columns ---- */

  const sessionColumns: Column<SessionRow>[] = [
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
        </div>
      ),
    },
  ]

  const sessionMissingId = sessions.items.some((row) => !row.current && !row.id)

  return (
    <Page>
      <PageHeader
        title="系统设置"
        sub="系统参数、在线会话、日志与配置备份"
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
            <Tabs.Tab id="logs">日志</Tabs.Tab>
            <Tabs.Tab id="security">安全</Tabs.Tab>
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
                  <div className="space-y-5 p-4">
                    <FieldGroup title="基础" hint="监听地址保存后立即生效；其余项在下次请求时生效。">
                      <div className="grid gap-4 md:grid-cols-2">
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
                      </div>
                    </FieldGroup>

                    <FieldGroup title="网络" hint="客户端 IP 的识别方式；只有管理端位于可信代理之后时才需要改动。">
                      <div className="grid gap-4 md:grid-cols-2">
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
                      </div>
                    </FieldGroup>

                    <FieldGroup title="安全" hint="登录限制与管理后台的访问白名单。">
                      <div className="grid gap-4 md:grid-cols-2">
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
                    </FieldGroup>
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
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="logs">
          <div className="space-y-5 pt-4">
            <Panel
              title="访问日志（Web / 端口转发 / WAF）"
              extra={
                <Button variant="primary" isDisabled={logSaving || logLoading} onPress={() => void saveLogs()}>
                  {logSaving ? '保存中…' : '保存'}
                </Button>
              }
            >
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <SwitchInput
                  label="写入磁盘"
                  value={logForm.persist}
                  onChange={(value) => setLogForm((prev) => ({ ...prev, persist: value }))}
                  hint="关闭后只保留内存缓冲，重启即丢失；已有文件不会被删除。"
                />
                <NumberInput
                  label="保留天数"
                  value={logForm.keepDays}
                  onChange={(value) => setLogForm((prev) => ({ ...prev, keepDays: value }))}
                  min={1}
                  max={365}
                  hint="超期的日志文件会在启动时与每小时清理一次。"
                />
                <NumberInput
                  label="单文件上限（MB）"
                  value={logForm.maxFileMb}
                  onChange={(value) => setLogForm((prev) => ({ ...prev, maxFileMb: value }))}
                  min={1}
                  max={1024}
                  hint="超过后当天会滚动到新的序号文件。"
                />
              </div>
              <div className="border-t border-border px-4 py-3 text-xs leading-6 text-muted">
                记录会同时进入各模块的内存缓冲（页面右上角的实时弹窗）与磁盘。可在「日志 → 访问日志」中按来源、状态、IP 与关键字检索并导出 CSV。
              </div>
            </Panel>

            <Panel
              title="运行日志文件"
              extra={
                <Button variant="secondary" isDisabled={logLoading} onPress={() => void loadLogs()}>
                  刷新
                </Button>
              }
            >
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <NumberInput
                  label="单文件上限（MB）"
                  value={logForm.appMaxFileMb}
                  onChange={(value) => setLogForm((prev) => ({ ...prev, appMaxFileMb: value }))}
                  min={1}
                  max={1024}
                />
                <NumberInput
                  label="保留份数"
                  value={logForm.appKeepFiles}
                  onChange={(value) => setLogForm((prev) => ({ ...prev, appKeepFiles: value }))}
                  min={1}
                  max={10}
                  hint="轮转后的 nunt.log.1…n 保留几份。"
                />
              </div>
              <div className="border-t border-border">
                <DataTable
                  items={logFiles}
                  ariaLabel="运行日志文件"
                  rowKey={(row) => row.name}
                  empty="还没有运行日志文件"
                  columns={[
                    { key: 'name', title: '文件', render: (row) => <span className="mono text-xs">{row.name}</span> },
                    { key: 'size', title: '大小', render: (row) => <span className="text-xs text-muted">{fmtBytes(row.size)}</span> },
                    {
                      key: 'time',
                      title: '修改时间',
                      render: (row) => <span className="text-xs text-muted">{fmtTime(row.modTime)}</span>,
                    },
                    {
                      key: 'download',
                      title: '操作',
                      render: (row) => (
                        <a
                          className="text-xs text-link underline"
                          href={`/api/v1/system/logs/download?name=${encodeURIComponent(row.name)}`}
                        >
                          下载
                        </a>
                      ),
                    },
                  ]}
                />
              </div>
            </Panel>
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}
        <Tabs.Panel id="security">
          <div className="space-y-5 pt-4">
            <TotpPanel />
          </div>
        </Tabs.Panel>

        {/* ------------------------------------------------------------------ */}

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
                      当前后端返回的会话列表不含会话 ID，无法定向踢出；可以结束全部会话，或等待它自然过期。
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
            <Panel
              title="自动备份"
              description="按间隔把配置、密钥、证书与 ACME 账号打成 tar.gz；日志与旧备份不包含在内"
              extra={
                <Button variant="primary" isDisabled={backupSaving} onPress={() => void saveBackup()}>
                  {backupSaving ? '保存中…' : '保存'}
                </Button>
              }
            >
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <SwitchInput
                  label="启用定时备份"
                  value={backupCfg.enabled}
                  onChange={(value) => setBackupCfg((prev) => ({ ...prev, enabled: value }))}
                  hint="服务启动后约 45 秒检查一次，到间隔才写入；重启不会连续生成。"
                />
                <NumberInput
                  label="间隔（小时）"
                  value={backupCfg.intervalHours}
                  onChange={(value) => setBackupCfg((prev) => ({ ...prev, intervalHours: value }))}
                  min={1}
                  max={720}
                />
                <NumberInput
                  label="保留份数"
                  value={backupCfg.keep}
                  onChange={(value) => setBackupCfg((prev) => ({ ...prev, keep: value }))}
                  min={1}
                  max={60}
                />
                <div className="md:col-span-3">
                  <TextInput
                    label="备份目录（可选）"
                    value={backupCfg.dir}
                    onChange={(value) => setBackupCfg((prev) => ({ ...prev, dir: value }))}
                    placeholder={backupDir || '<数据目录>/backups'}
                    hint="必须是绝对路径；留空则写入数据目录下的 backups/。归档权限 0600，但包含 secret.key，离开本机前请自行加密。"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border p-4">
                <Button
                  variant="secondary"
                  onPress={() => {
                    const link = document.createElement('a')
                    link.href = '/api/v1/system/backup'
                    link.download = ''
                    document.body.appendChild(link)
                    link.click()
                    link.remove()
                  }}
                >
                  立即备份并下载
                </Button>
                <span className="text-xs text-muted">{backupDir ? `目录：${backupDir}` : ''}</span>
              </div>
              <div className="border-t border-border">
                <DataTable
                  items={backupFiles}
                  ariaLabel="备份文件"
                  rowKey={(row) => row.name}
                  empty="还没有备份文件"
                  columns={[
                    { key: 'name', title: '文件', render: (row) => <span className="mono text-xs">{row.name}</span> },
                    { key: 'size', title: '大小', render: (row) => <span className="text-xs text-muted">{fmtBytes(row.size)}</span> },
                    { key: 'time', title: '时间', render: (row) => <span className="text-xs text-muted">{fmtTime(row.modTime)}</span> },
                  ]}
                />
              </div>
            </Panel>

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
                  导入会替换配置（管理员密码哈希会保留），随后自动重载各模块。
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
        open={!!kickTarget}
        title={kickTarget?.id ? '踢出会话' : '无法定向踢出'}
        content={
          kickTarget?.id ? (
            <>
              确定结束来自 {kickTarget?.ip || '未知地址'} 的会话吗？
            </>
          ) : (
            <>
              当前后端返回的会话列表不含会话 ID，无法只结束来自 {kickTarget?.ip || '未知地址'} 的这一条会话。可以结束全部会话，或等待它自然过期。
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
        content="导入会覆盖当前的系统、Web、转发、动态域名、证书与 WAF 配置，确定继续吗？"
        danger
        confirmText="导入"
        onCancel={() => setImportCandidate(null)}
        onConfirm={() => void confirmImportConfig()}
      />
    </Page>
  )
}
