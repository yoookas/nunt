<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import { auth } from '../session'
import { setTheme } from '../theme'

const LOG_LEVELS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const THEMES = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
]

const activeTab = ref('system')

/* -------------------------------------------------------------------------
 * 系统参数
 * ---------------------------------------------------------------------- */

const system = reactive({
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
})

const systemLoading = ref(false)
const systemSaving = ref(false)
const systemLoaded = ref(false)
const systemError = ref('')

// 监听地址的真实状态：配置值、实际生效值以及来源（环境变量会接管实际端口）。
const listen = reactive({
  actual: '',
  config: '',
  source: 'config',
  env: '',
  applied: true,
  notice: '',
})

const allowInfo = ref(null)
// 保存后如果监听地址真的换了，旧端口已经关闭，需要把新地址一直显示在页面上。
const switched = ref(null)

const envControlled = computed(() => listen.source === 'env')

const listenNotice = computed(() => {
  if (listen.notice) return listen.notice
  if (envControlled.value) {
    const env = listen.env || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT'
    return `当前监听地址由环境变量 ${env} 控制（实际生效 ${listen.actual || '未知'}）：修改配置不会改变运行中的端口，需移除该环境变量并重启服务后才生效。`
  }
  if (!listen.applied && listen.actual) {
    return `配置值 ${listen.config || '（空）'} 与实际监听地址 ${listen.actual} 不一致，请检查启动参数或重新保存设置。`
  }
  return ''
})

const allowNotice = computed(() => {
  const info = allowInfo.value
  if (!info) return null
  if (info.failClosed) {
    return {
      type: 'error',
      text: `管理端 IP 白名单没有有效条目，当前会拒绝所有管理端访问（已拦截 ${info.blocked || 0} 次）。请尽快修正白名单。`,
    }
  }
  if (info.restricted) {
    return {
      type: 'info',
      text: `管理端 IP 白名单已生效：${info.valid || 0} 条有效规则，自启动以来已拦截 ${info.blocked || 0} 次请求。`,
    }
  }
  return {
    type: 'info',
    text: '管理端 IP 白名单未启用（留空）。任何能连接到管理端口的客户端都可以尝试登录。',
  }
})

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(value ?? '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function adminListenURL(addr) {
  const match = /:([0-9]+)\s*$/.exec(String(addr || '').trim())
  if (!match) return ''
  const loc = window.location
  return `${loc.protocol}//${loc.hostname || 'localhost'}:${match[1]}/`
}

function applySettingsForm(data) {
  system.adminListen = data.adminListen || ''
  system.baseUrl = data.baseUrl || ''
  system.logLevel = data.logLevel || 'info'
  system.sessionTtlHours = Number(data.sessionTtlHours) || 12
  system.loginMaxFail = Number(data.loginMaxFail) || 5
  system.loginLockMinutes = Number(data.loginLockMinutes) || 10
  system.trustProxy = !!data.trustProxy
  system.sessionBindIp = !!data.sessionBindIp
  system.checkUpdate = data.checkUpdate !== false
  system.theme = data.theme || 'dark'
  system.adminAllowIps = toList(data.adminAllowIps)
}

function applyListenFromInfo(info, settings) {
  if (!info) return
  listen.actual = info.adminListen || ''
  listen.config = info.adminListenConfig ?? settings?.adminListen ?? ''
  listen.source = info.adminListenSource || 'config'
  listen.env = info.adminListenEnv || ''
  // /system/info 只给出实际生效值与来源；地址尚未保存过时不做“配置不一致”的推断，
  // 避免把 ":8080" 与 "0.0.0.0:8080" 这类等价写法误报成不一致。
  listen.applied = true
  listen.notice = info.adminListenNotice || ''
  allowInfo.value = info.adminAllowList || null
}

function applyServerResponse(data) {
  const source = data.adminListenSource || 'config'
  listen.actual = data.adminListen || ''
  listen.config = data.adminListenConfig ?? data.adminListen ?? ''
  listen.source = source
  listen.env = data.adminListenEnv || ''
  listen.applied = data.adminListenApplied !== false
  listen.notice = data.adminListenNotice || ''
  applySettingsForm(data)
  // 表单里始终展示配置文件中的值；环境变量只影响实际生效地址。
  system.adminListen = listen.config
}

async function loadSystem() {
  systemLoading.value = true
  systemError.value = ''
  try {
    const [settings, info] = await Promise.all([
      api.get('/api/v1/system/settings'),
      api.get('/api/v1/system/info').catch(() => null),
    ])
    applySettingsForm(settings || {})
    applyListenFromInfo(info, settings)
    listen.config = info?.adminListenConfig ?? settings?.adminListen ?? ''
    listen.actual = info?.adminListen || listen.actual || settings?.adminListen || ''
    system.adminListen = listen.config
    systemLoaded.value = true
  } catch (err) {
    systemError.value = errorText(err)
  } finally {
    systemLoading.value = false
  }
}

function validateNumbers() {
  const rules = [
    [system.sessionTtlHours, 1, 720, '会话有效期需要在 1–720 小时之间'],
    [system.loginMaxFail, 1, 100, '登录失败次数需要在 1–100 之间'],
    [system.loginLockMinutes, 1, 1440, '锁定时长需要在 1–1440 分钟之间'],
  ]
  for (const [value, min, max, message] of rules) {
    const number = Number(value)
    if (!Number.isFinite(number) || number < min || number > max) {
      Message.warning(message)
      return false
    }
  }
  return true
}

async function saveSystem() {
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
  }
  const previous = listen.actual || listen.config
  systemSaving.value = true
  try {
    const result = await api.put('/api/v1/system/settings', payload)
    if (result) applyServerResponse(result)
    else {
      applySettingsForm(payload)
      listen.config = payload.adminListen
    }
    if (payload.theme === 'dark' || payload.theme === 'light') {
      setTheme(payload.theme === 'dark')
    }
    const effective = result?.adminListen || listen.actual || payload.adminListen
    if (result?.adminListenSource === 'env') {
      Message.warning('设置已保存；监听地址仍由环境变量控制，未改变实际端口')
    } else if (effective && previous && effective !== previous) {
      switched.value = { addr: effective, url: adminListenURL(effective) }
      Message.success(`管理后台已切换到 ${effective}，当前页面仍在旧地址`)
    } else {
      Message.success('设置已保存')
    }
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    systemSaving.value = false
  }
}

/* -------------------------------------------------------------------------
 * 用户管理
 * ---------------------------------------------------------------------- */

const users = ref([])
const usersLoading = ref(false)
const usersLoaded = ref(false)
const usersError = ref('')
const userBusy = ref('')

const userDialog = reactive({
  visible: false,
  saving: false,
  editingId: '',
  form: { username: '', password: '', enabled: true },
})

const passwordDialog = reactive({
  visible: false,
  saving: false,
  user: null,
  password: '',
})

const userColumns = [
  { title: '用户名', dataIndex: 'username', slotName: 'username', width: 180 },
  { title: '角色', dataIndex: 'role', width: 100, render: ({ record }) => record.role || 'admin' },
  { title: '状态', slotName: 'status', width: 230 },
  { title: '最近登录', dataIndex: 'lastLogin', width: 180, render: ({ record }) => fmtTime(record.lastLogin) },
  { title: '创建时间', dataIndex: 'createdAt', width: 180, render: ({ record }) => fmtTime(record.createdAt) },
  { title: '操作', slotName: 'actions', width: 260 },
]

async function loadUsers(force = false) {
  if (usersLoading.value) return
  if (usersLoaded.value && !force) return
  usersLoading.value = true
  usersError.value = ''
  try {
    const data = await api.get('/api/v1/auth/users')
    users.value = Array.isArray(data) ? data : []
    usersLoaded.value = true
  } catch (err) {
    usersError.value = errorText(err)
  } finally {
    usersLoading.value = false
  }
}

function openCreateUser() {
  userDialog.editingId = ''
  userDialog.form = { username: '', password: '', enabled: true }
  userDialog.visible = true
}

function openEditUser(row) {
  userDialog.editingId = row.id
  userDialog.form = { username: row.username || '', password: '', enabled: !!row.enabled }
  userDialog.visible = true
}

async function saveUser() {
  const username = String(userDialog.form.username || '').trim()
  const password = String(userDialog.form.password || '')
  if (!username) {
    Message.warning('请填写用户名')
    return false
  }
  if (!userDialog.editingId && password.length < 8) {
    Message.warning('密码长度至少 8 位')
    return false
  }
  userDialog.saving = true
  try {
    if (userDialog.editingId) {
      await api.put(`/api/v1/auth/users/${encodeURIComponent(userDialog.editingId)}`, {
        username,
        enabled: !!userDialog.form.enabled,
      })
      Message.success('用户已更新')
    } else {
      await api.post('/api/v1/auth/users', {
        username,
        password,
        enabled: !!userDialog.form.enabled,
      })
      Message.success('用户已创建')
    }
    await loadUsers(true)
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    userDialog.saving = false
  }
}

function openResetPassword(row) {
  passwordDialog.user = row
  passwordDialog.password = ''
  passwordDialog.visible = true
}

async function savePassword() {
  const password = String(passwordDialog.password || '')
  if (password.length < 8) {
    Message.warning('新密码长度至少 8 位')
    return false
  }
  if (!passwordDialog.user?.id) {
    Message.error('用户信息不完整，无法重置密码')
    return false
  }
  passwordDialog.saving = true
  try {
    await api.put(`/api/v1/auth/users/${encodeURIComponent(passwordDialog.user.id)}`, { password })
    Message.success('密码已重置，该用户的会话已失效')
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    passwordDialog.saving = false
  }
}

async function toggleUser(row, enabled) {
  if (row.username === auth.user) {
    Message.warning('不能停用当前登录的账号')
    return
  }
  userBusy.value = row.id
  try {
    await api.put(`/api/v1/auth/users/${encodeURIComponent(row.id)}`, { enabled: !!enabled })
    row.enabled = !!enabled
    Message.success(enabled ? '用户已启用' : '用户已停用')
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    userBusy.value = ''
  }
}

function removeUser(row) {
  if (row.username === auth.user) {
    Message.warning('不能删除当前登录的账号')
    return
  }
  Modal.confirm({
    title: '删除用户',
    content: `确定要删除用户「${row.username}」吗？该用户的所有会话会立即失效。`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/auth/users/${encodeURIComponent(row.id)}`)
        Message.success('用户已删除')
        await loadUsers(true)
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

/* -------------------------------------------------------------------------
 * API Token
 * ---------------------------------------------------------------------- */

const tokens = ref([])
const tokensLoading = ref(false)
const tokensLoaded = ref(false)
const tokensError = ref('')

const tokenDialog = reactive({
  visible: false,
  saving: false,
  form: { name: '', scopes: [] },
})

const tokenResult = reactive({
  visible: false,
  name: '',
  token: '',
})

const tokenColumns = [
  { title: '名称', dataIndex: 'name', width: 200 },
  { title: '权限范围', dataIndex: 'scopes', slotName: 'scopes' },
  {
    title: '状态',
    dataIndex: 'enabled',
    width: 100,
    render: ({ record }) => (record.enabled ? '有效' : '已停用'),
  },
  { title: '最近使用', dataIndex: 'lastUsed', width: 180, render: ({ record }) => fmtTime(record.lastUsed) },
  { title: '创建时间', dataIndex: 'createdAt', width: 180, render: ({ record }) => fmtTime(record.createdAt) },
  { title: '操作', slotName: 'actions', width: 100 },
]

async function loadTokens(force = false) {
  if (tokensLoading.value) return
  if (tokensLoaded.value && !force) return
  tokensLoading.value = true
  tokensError.value = ''
  try {
    const data = await api.get('/api/v1/auth/tokens')
    tokens.value = Array.isArray(data) ? data : []
    tokensLoaded.value = true
  } catch (err) {
    tokensError.value = errorText(err)
  } finally {
    tokensLoading.value = false
  }
}

function openCreateToken() {
  tokenDialog.form = { name: '', scopes: [] }
  tokenDialog.visible = true
}

async function createToken() {
  const name = String(tokenDialog.form.name || '').trim()
  if (!name) {
    Message.warning('请填写 Token 名称')
    return false
  }
  tokenDialog.saving = true
  try {
    const result = await api.post('/api/v1/auth/tokens', {
      name,
      scopes: toList(tokenDialog.form.scopes),
    })
    tokenResult.token = result?.token || ''
    tokenResult.name = name
    tokenResult.visible = true
    tokenDialog.visible = false
    await loadTokens(true)
    return false
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    tokenDialog.saving = false
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(tokenResult.token)
    Message.success('Token 已复制到剪贴板')
  } catch (err) {
    Message.error('复制失败，请手动选择文本')
  }
}

function removeToken(row) {
  Modal.confirm({
    title: '删除 API Token',
    content: `确定要删除 Token「${row.name}」吗？使用它的客户端会立即失效。`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/auth/tokens/${encodeURIComponent(row.id)}`)
        Message.success('Token 已删除')
        await loadTokens(true)
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

/* -------------------------------------------------------------------------
 * 在线会话
 * ---------------------------------------------------------------------- */

const sessions = ref([])
const sessionsLoading = ref(false)
const sessionsLoaded = ref(false)
const sessionsError = ref('')

const sessionMissingId = computed(() =>
  sessions.value.some((row) => !row.current && !row.id),
)

const sessionColumns = [
  { title: '用户', dataIndex: 'username', slotName: 'user', width: 180 },
  { title: '来源 IP', dataIndex: 'ip', width: 160, render: ({ record }) => record.ip || '-' },
  { title: '客户端', dataIndex: 'userAgent', ellipsis: true, tooltip: true },
  { title: '登录时间', dataIndex: 'createdAt', width: 180, render: ({ record }) => fmtTime(record.createdAt) },
  { title: '过期时间', dataIndex: 'expiresAt', width: 180, render: ({ record }) => fmtTime(record.expiresAt) },
  { title: '操作', slotName: 'actions', width: 190 },
]

async function loadSessions(force = false) {
  if (sessionsLoading.value) return
  if (sessionsLoaded.value && !force) return
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    const data = await api.get('/api/v1/auth/sessions')
    sessions.value = (Array.isArray(data) ? data : []).map((row, index) => ({
      ...row,
      // 后端当前不返回会话 ID；这里补一个仅用于表格 row-key 的本地键。
      __key: row.id || `${row.username}|${row.ip}|${row.createdAt}|${index}`,
    }))
    sessionsLoaded.value = true
  } catch (err) {
    sessionsError.value = errorText(err)
  } finally {
    sessionsLoading.value = false
  }
}

function kickSession(row) {
  if (row.current) {
    Message.info('这是当前登录会话，请使用右上角的「退出登录」')
    return
  }
  if (!row.id) {
    Modal.confirm({
      title: '无法定向踢出',
      content: `当前后端返回的会话列表不含会话 ID，无法只结束「${row.username}」的这一条会话。是否改为重置该用户密码？重置后该用户的所有会话会立即失效。`,
      okText: '重置密码',
      cancelText: '取消',
      onOk: () => resetPasswordForSession(row),
    })
    return
  }
  Modal.confirm({
    title: '踢出会话',
    content: `确定结束用户「${row.username}」来自 ${row.ip || '未知地址'} 的会话吗？`,
    okText: '踢出',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/auth/sessions/${encodeURIComponent(row.id)}`)
        Message.success('会话已踢出')
        await loadSessions(true)
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

async function resetPasswordForSession(row) {
  if (!usersLoaded.value) await loadUsers()
  const user = users.value.find((item) => item.username === row.username)
  if (!user) {
    Message.warning('在用户列表中找不到该账号，可能已被删除')
    return
  }
  openResetPassword(user)
}

/* -------------------------------------------------------------------------
 * 配置导入 / 导出
 * ---------------------------------------------------------------------- */

const configBusy = ref('')
const importInput = ref(null)
const rawDialog = reactive({ visible: false, loading: false, text: '' })

function downloadText(filename, content, mime = 'application/json;charset=utf-8') {
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

async function exportConfig() {
  configBusy.value = 'export'
  try {
    const response = await fetch('/api/v1/system/config', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) {
      let message = `导出失败（HTTP ${response.status}）`
      try {
        const data = await response.json()
        if (data?.error?.message) message = data.error.message
      } catch (err) {
        /* 忽略非 JSON 错误体 */
      }
      throw new Error(message)
    }
    const text = await response.text()
    const disposition = response.headers.get('content-disposition') || ''
    const match = /filename="?([^";]+)"?/i.exec(disposition)
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(match ? match[1] : `nunt-config-${stamp}.json`, text)
    Message.success('配置已导出')
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    configBusy.value = ''
  }
}

function pickImportFile() {
  const input = importInput.value
  if (!input) return
  input.value = ''
  input.click()
}

async function onImportFile(event) {
  const input = event.target
  const file = input.files && input.files[0]
  if (!file) return
  input.value = ''
  let parsed
  try {
    parsed = JSON.parse(await file.text())
  } catch (err) {
    Message.error('文件不是合法的 JSON')
    return
  }
  Modal.confirm({
    title: '导入配置',
    content: '导入会覆盖当前的系统、Web、转发、动态域名、证书、存储、WAF、任务与通知配置，确定继续吗？',
    okText: '导入',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      configBusy.value = 'import'
      const previous = listen.actual || listen.config
      try {
        const result = await api.put('/api/v1/system/config', { config: parsed })
        const effective = result?.adminListen || ''
        const moved = result?.adminListenSource !== 'env' && effective && previous && effective !== previous
        Message.success('配置已导入并重新加载')
        if (result?.adminListenSource === 'env') {
          Message.warning('导入的监听地址仍由环境变量控制，实际端口未改变')
        } else if (moved) {
          // 旧端口已经关闭，继续向旧地址取数只会得到网络错误；把新地址常驻显示。
          switched.value = { addr: effective, url: adminListenURL(effective) }
        } else {
          await loadSystem()
          await Promise.all([loadUsers(true), loadTokens(true), loadSessions(true)])
        }
      } catch (err) {
        Message.error(errorText(err))
      } finally {
        configBusy.value = ''
      }
    },
  })
}

async function reloadConfig() {
  configBusy.value = 'reload'
  try {
    await api.post('/api/v1/system/reload')
    Message.success('已通知各模块重新加载配置')
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    configBusy.value = ''
  }
}

async function showRawConfig() {
  rawDialog.loading = true
  rawDialog.text = ''
  rawDialog.visible = true
  try {
    const data = await api.get('/api/v1/system/config')
    try {
      rawDialog.text = JSON.stringify(data, null, 2)
    } catch (err) {
      rawDialog.text = String(data)
    }
  } catch (err) {
    rawDialog.text = `读取失败：${errorText(err)}`
  } finally {
    rawDialog.loading = false
  }
}

async function copyRawConfig() {
  try {
    await navigator.clipboard.writeText(rawDialog.text)
    Message.success('已复制到剪贴板')
  } catch (err) {
    Message.error('复制失败，请手动选择文本')
  }
}

/* ---------------------------------------------------------------------- */

function onTabChange(key) {
  const name = String(key)
  if (name === 'users') loadUsers()
  else if (name === 'tokens') loadTokens()
  else if (name === 'sessions') loadSessions()
}

onMounted(loadSystem)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>系统设置</h2>
        <div class="sub">系统参数、用户、API Token、在线会话与配置备份</div>
      </div>
      <div class="spacer" />
      <a-button :loading="systemLoading" @click="loadSystem">刷新</a-button>
    </div>

    <a-tabs v-model:active-key="activeTab" type="card" lazy-load @change="onTabChange">
      <a-tab-pane key="system" title="系统">
        <div class="stack">
          <a-alert v-if="switched" type="success" class="switched-alert">
            <template #title>管理后台监听地址已切换</template>
            <div class="switched-body">
              <span>
                新地址为 <code class="mono">{{ switched.addr }}</code>，当前页面仍连接在旧地址上。
              </span>
              <a v-if="switched.url" :href="switched.url" target="_blank" rel="noopener">用新地址打开</a>
            </div>
          </a-alert>

          <a-alert v-if="listenNotice" type="warning" :content="listenNotice" />

          <a-alert
            v-if="allowNotice"
            :type="allowNotice.type"
            :content="allowNotice.text"
          />

          <a-alert v-if="systemError" type="error" :content="systemError" />

          <a-card :bordered="false">
            <template #title>系统参数</template>
            <template #extra>
              <span class="muted">监听地址保存后立即生效</span>
            </template>

            <a-result
              v-if="systemError && !systemLoaded"
              status="warning"
              title="无法读取系统设置"
              :subtitle="systemError"
            >
              <template #extra>
                <a-button type="primary" @click="loadSystem">重试</a-button>
              </template>
            </a-result>

            <a-spin v-else :loading="systemLoading" style="width: 100%">
              <a-form :model="system" layout="vertical" class="settings-form">
                <a-row :gutter="16">
                  <a-col :xs="24" :md="12">
                    <a-form-item
                      field="adminListen"
                      label="管理监听地址"
                      extra="保存后先绑定新地址再关闭旧地址；端口被占用或环境变量接管时会保留旧监听"
                    >
                      <a-input
                        v-model="system.adminListen"
                        placeholder=":8080 或 127.0.0.1:8080"
                        :disabled="envControlled"
                      />
                    </a-form-item>
                  </a-col>
                  <a-col :xs="24" :md="12">
                    <a-form-item field="baseUrl" label="外部访问地址" extra="用于生成回跳链接，可留空">
                      <a-input v-model="system.baseUrl" placeholder="https://admin.example.com" />
                    </a-form-item>
                  </a-col>

                  <a-col :xs="24" :md="12">
                    <a-form-item field="logLevel" label="日志级别">
                      <a-select v-model="system.logLevel">
                        <a-option v-for="item in LOG_LEVELS" :key="item.value" :value="item.value">{{ item.label }}</a-option>
                      </a-select>
                    </a-form-item>
                  </a-col>
                  <a-col :xs="24" :md="12">
                    <a-form-item field="theme" label="默认主题" extra="仅作为新设备的默认值，本机选择保存在浏览器中">
                      <a-select v-model="system.theme">
                        <a-option v-for="item in THEMES" :key="item.value" :value="item.value">{{ item.label }}</a-option>
                      </a-select>
                    </a-form-item>
                  </a-col>

                  <a-col :xs="24" :md="8">
                    <a-form-item field="sessionTtlHours" label="会话有效期（小时）">
                      <a-input-number v-model="system.sessionTtlHours" :min="1" :max="720" :precision="0" style="width: 100%" />
                    </a-form-item>
                  </a-col>
                  <a-col :xs="24" :md="8">
                    <a-form-item field="loginMaxFail" label="登录失败次数上限">
                      <a-input-number v-model="system.loginMaxFail" :min="1" :max="100" :precision="0" style="width: 100%" />
                    </a-form-item>
                  </a-col>
                  <a-col :xs="24" :md="8">
                    <a-form-item field="loginLockMinutes" label="锁定时长（分钟）">
                      <a-input-number v-model="system.loginLockMinutes" :min="1" :max="1440" :precision="0" style="width: 100%" />
                    </a-form-item>
                  </a-col>

                  <a-col :xs="24" :md="12">
                    <a-form-item
                      field="trustProxy"
                      label="信任反向代理"
                      extra="使用 X-Forwarded-For 识别客户端 IP，仅在管理端位于可信代理之后时开启"
                    >
                      <a-switch v-model="system.trustProxy" />
                      <span class="switch-text">{{ system.trustProxy ? '已开启' : '已关闭' }}</span>
                    </a-form-item>
                  </a-col>
                  <a-col :xs="24" :md="12">
                    <a-form-item
                      field="sessionBindIp"
                      label="会话绑定客户端 IP"
                      extra="开启后会话只能从登录时的地址使用（移动网络会频繁重登）；User-Agent 始终校验"
                    >
                      <a-switch v-model="system.sessionBindIp" />
                      <span class="switch-text">{{ system.sessionBindIp ? '已开启' : '已关闭' }}</span>
                    </a-form-item>
                  </a-col>

                  <a-col :xs="24" :md="12">
                    <a-form-item field="checkUpdate" label="检查更新" extra="启动时检查新版本">
                      <a-switch v-model="system.checkUpdate" />
                      <span class="switch-text">{{ system.checkUpdate ? '已开启' : '已关闭' }}</span>
                    </a-form-item>
                  </a-col>

                  <a-col :span="24">
                    <a-form-item
                      field="adminAllowIps"
                      label="管理后台 IP 白名单"
                      extra="留空表示不限制；支持单个地址与 CIDR，输入后按回车、逗号或分号添加"
                    >
                      <a-input-tag
                        v-model="system.adminAllowIps"
                        allow-clear
                        placeholder="输入 IP 或 CIDR 后按回车添加"
                      />
                    </a-form-item>
                  </a-col>
                </a-row>

                <div class="form-actions">
                  <a-space>
                    <a-button type="primary" :loading="systemSaving" :disabled="systemLoading || !systemLoaded" @click="saveSystem">保存设置</a-button>
                    <a-button :disabled="systemLoading" @click="loadSystem">还原</a-button>
                  </a-space>
                </div>
              </a-form>
            </a-spin>

            <div v-if="listen.actual || listen.config" class="listen-summary mono">
              <span>实际生效：{{ listen.actual || '-' }}</span>
              <span>配置值：{{ listen.config || '-' }}</span>
              <span>来源：{{ listen.source === 'env' ? `环境变量 ${listen.env || ''}` : '配置文件' }}</span>
            </div>
          </a-card>
        </div>
      </a-tab-pane>

      <a-tab-pane key="users" title="用户">
        <div class="stack">
          <a-card :bordered="false">
            <template #title>用户管理</template>
            <template #extra>
              <a-space>
                <a-button size="small" :loading="usersLoading" @click="loadUsers(true)">刷新</a-button>
                <a-button size="small" type="primary" @click="openCreateUser">新建用户</a-button>
              </a-space>
            </template>

            <a-alert v-if="usersError" type="error" :content="usersError" style="margin-bottom: 12px" />
            <a-table
              :data="users"
              :columns="userColumns"
              :loading="usersLoading"
              :pagination="false"
              :scroll="{ x: 1050 }"
              row-key="id"
            >
              <template #username="{ record }">
                <span>{{ record.username }}</span>
                <a-tag v-if="record.username === auth.user" size="small" color="arcoblue" class="inline-tag">当前</a-tag>
              </template>
              <template #status="{ record }">
                <a-space>
                  <a-switch
                    size="small"
                    :model-value="record.enabled"
                    :loading="userBusy === record.id"
                    :disabled="record.username === auth.user"
                    @change="(value) => toggleUser(record, value)"
                  />
                  <span :class="record.enabled ? 'text-ok' : 'muted'">{{ record.enabled ? '已启用' : '已停用' }}</span>
                  <a-tag v-if="record.mustChangePassword" size="small" color="orange">待改密</a-tag>
                </a-space>
              </template>
              <template #lastLogin="{ record }">
                <span class="muted">{{ fmtTime(record.lastLogin) }}</span>
              </template>
              <template #createdAt="{ record }">
                <span class="muted">{{ fmtTime(record.createdAt) }}</span>
              </template>
              <template #actions="{ record }">
                <a-space>
                  <a-button size="mini" @click="openEditUser(record)">编辑</a-button>
                  <a-button size="mini" @click="openResetPassword(record)">重置密码</a-button>
                  <a-button
                    size="mini"
                    type="text"
                    status="danger"
                    :disabled="record.username === auth.user"
                    @click="removeUser(record)"
                  >删除</a-button>
                </a-space>
              </template>
              <template #empty>
                <a-empty description="暂无用户，点右上角「新建用户」创建第一个账号" />
              </template>
            </a-table>
          </a-card>

          <a-card :bordered="false">
            <div class="muted note">
              后端当前创建的账号均为管理员角色；重置密码后该用户的所有会话会立即失效。
            </div>
          </a-card>
        </div>
      </a-tab-pane>

      <a-tab-pane key="tokens" title="Token">
        <div class="stack">
          <a-card :bordered="false">
            <template #title>API Token</template>
            <template #extra>
              <a-space>
                <a-button size="small" :loading="tokensLoading" @click="loadTokens(true)">刷新</a-button>
                <a-button size="small" type="primary" @click="openCreateToken">新建 Token</a-button>
              </a-space>
            </template>

            <a-alert v-if="tokensError" type="error" :content="tokensError" style="margin-bottom: 12px" />
            <a-table
              :data="tokens"
              :columns="tokenColumns"
              :loading="tokensLoading"
              :pagination="false"
              :scroll="{ x: 950 }"
              row-key="id"
            >
              <template #scopes="{ record }">
                <a-space v-if="Array.isArray(record.scopes) && record.scopes.length">
                  <a-tag v-for="scope in record.scopes" :key="scope" size="small">{{ scope }}</a-tag>
                </a-space>
                <span v-else class="muted">默认（完全管理权限）</span>
              </template>
              <template #enabled="{ record }">
                <a-tag :color="record.enabled ? 'green' : 'gray'" size="small">{{ record.enabled ? '有效' : '已停用' }}</a-tag>
              </template>
              <template #lastUsed="{ record }">
                <span class="muted">{{ fmtTime(record.lastUsed) }}</span>
              </template>
              <template #createdAt="{ record }">
                <span class="muted">{{ fmtTime(record.createdAt) }}</span>
              </template>
              <template #actions="{ record }">
                <a-button size="mini" type="text" status="danger" @click="removeToken(record)">删除</a-button>
              </template>
              <template #empty>
                <a-empty description="还没有创建 API Token" />
              </template>
            </a-table>
          </a-card>

          <a-card :bordered="false">
            <div class="muted note">
              Token 仅在创建时完整显示一次，请立即复制保存；服务端只保存摘要。留空权限范围表示完全管理权限，填 read 只会得到只读权限。
            </div>
          </a-card>
        </div>
      </a-tab-pane>

      <a-tab-pane key="sessions" title="会话">
        <div class="stack">
          <a-card :bordered="false">
            <template #title>在线会话</template>
            <template #extra>
              <a-button size="small" :loading="sessionsLoading" @click="loadSessions(true)">刷新</a-button>
            </template>

            <a-alert v-if="sessionsError" type="error" :content="sessionsError" style="margin-bottom: 12px" />
            <a-alert
              v-if="sessionMissingId"
              type="info"
              show-icon
              content="当前后端返回的会话列表不含会话 ID，无法定向踢出；可在对应行使用「重置密码」让该用户全部会话立即失效。"
              style="margin-bottom: 12px"
            />
            <a-table
              :data="sessions"
              :columns="sessionColumns"
              :loading="sessionsLoading"
              :pagination="false"
              :scroll="{ x: 1150 }"
              row-key="__key"
            >
              <template #user="{ record }">
                <span>{{ record.username }}</span>
                <a-tag v-if="record.current" size="small" color="green" class="inline-tag">当前会话</a-tag>
              </template>
              <template #ip="{ record }">
                <span class="mono muted">{{ record.ip || '-' }}</span>
              </template>
              <template #actions="{ record }">
                <a-space>
                  <a-button size="mini" :disabled="record.current" @click="kickSession(record)">踢出</a-button>
                  <a-button size="mini" @click="resetPasswordForSession(record)">重置密码</a-button>
                </a-space>
              </template>
              <template #empty>
                <a-empty description="当前没有在线会话" />
              </template>
            </a-table>
          </a-card>

          <a-card :bordered="false">
            <div class="muted note">
              会话保存在内存中，服务重启后全部失效。User-Agent 始终参与校验；开启「会话绑定客户端 IP」后还会校验来源地址。
            </div>
          </a-card>
        </div>
      </a-tab-pane>

      <a-tab-pane key="backup" title="备份">
        <div class="stack">
          <a-card :bordered="false">
            <template #title>配置导入 / 导出</template>
            <a-alert
              type="info"
              show-icon
              content="导出的 JSON 中所有密钥以 ******** 呈现；直接回导时这些字段会沿用现有值，不会把掩码写进配置。"
              style="margin-bottom: 16px"
            />

            <a-space wrap>
              <a-button type="primary" :loading="configBusy === 'export'" @click="exportConfig">导出配置</a-button>
              <a-button :loading="configBusy === 'raw'" @click="showRawConfig">查看当前配置 JSON</a-button>
            </a-space>

            <a-divider />

            <div class="muted note" style="margin-bottom: 12px">
              导入会替换配置（用户仅在带有密码哈希时被替换），随后自动重载各模块。
            </div>
            <a-space wrap>
              <a-button :loading="configBusy === 'import'" @click="pickImportFile">选择配置文件并导入</a-button>
              <input
                ref="importInput"
                type="file"
                accept="application/json,.json"
                class="hidden-input"
                @change="onImportFile"
              />
            </a-space>

            <a-divider />

            <div class="muted note" style="margin-bottom: 12px">
              修改配置文件后可用「重载配置」让各模块重新读取，无需重启进程。
            </div>
            <a-button :loading="configBusy === 'reload'" @click="reloadConfig">重载配置</a-button>
          </a-card>
        </div>
      </a-tab-pane>
    </a-tabs>

    <!-- 用户编辑 -->
    <a-modal
      v-model:visible="userDialog.visible"
      :title="userDialog.editingId ? '编辑用户' : '新建用户'"
      :ok-loading="userDialog.saving"
      :on-before-ok="saveUser"
      ok-text="保存"
      cancel-text="取消"
      :mask-closable="false"
    >
      <a-form :model="userDialog.form" layout="vertical">
        <a-form-item field="username" label="用户名">
          <a-input v-model="userDialog.form.username" placeholder="登录用户名" />
        </a-form-item>
        <a-form-item
          v-if="!userDialog.editingId"
          field="password"
          label="密码"
          extra="至少 8 位"
        >
          <a-input-password v-model="userDialog.form.password" placeholder="初始密码" autocomplete="new-password" />
        </a-form-item>
        <a-form-item field="enabled" label="启用">
          <a-switch v-model="userDialog.form.enabled" />
          <span class="switch-text">{{ userDialog.form.enabled ? '允许登录' : '禁止登录' }}</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 重置密码 -->
    <a-modal
      v-model:visible="passwordDialog.visible"
      :title="`重置密码${passwordDialog.user ? '：' + passwordDialog.user.username : ''}`"
      :ok-loading="passwordDialog.saving"
      :on-before-ok="savePassword"
      ok-text="重置"
      cancel-text="取消"
      :mask-closable="false"
    >
      <a-alert
        type="warning"
        show-icon
        content="重置后该用户的所有会话会立即失效（包括当前会话，如果重置的是本人）。"
        style="margin-bottom: 12px"
      />
      <a-form layout="vertical">
        <a-form-item label="新密码" extra="至少 8 位">
          <a-input-password v-model="passwordDialog.password" autocomplete="new-password" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 新建 Token -->
    <a-modal
      v-model:visible="tokenDialog.visible"
      title="新建 API Token"
      :ok-loading="tokenDialog.saving"
      :on-before-ok="createToken"
      ok-text="创建"
      cancel-text="取消"
      :mask-closable="false"
    >
      <a-form :model="tokenDialog.form" layout="vertical">
        <a-form-item field="name" label="名称">
          <a-input v-model="tokenDialog.form.name" placeholder="例如：监控脚本" />
        </a-form-item>
        <a-form-item
          field="scopes"
          label="权限范围"
          extra="留空表示完全管理权限（等同 admin）；填 read 只会得到只读权限"
        >
          <a-input-tag v-model="tokenDialog.form.scopes" allow-clear placeholder="输入范围后按回车添加" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- Token 只显示一次 -->
    <a-modal
      v-model:visible="tokenResult.visible"
      :title="`Token 已创建${tokenResult.name ? '：' + tokenResult.name : ''}`"
      :footer="false"
      :mask-closable="false"
    >
      <a-alert
        type="warning"
        show-icon
        content="请立即复制并妥善保存，关闭本窗口后将无法再次查看。"
        style="margin-bottom: 12px"
      />
      <a-textarea
        :model-value="tokenResult.token || '（后端未返回令牌）'"
        readonly
        :auto-size="{ minRows: 2, maxRows: 4 }"
        class="mono"
      />
      <div class="dialog-actions">
        <a-button type="primary" @click="copyToken">复制令牌</a-button>
        <a-button @click="tokenResult.visible = false">关闭</a-button>
      </div>
    </a-modal>

    <!-- 当前配置 -->
    <a-modal
      v-model:visible="rawDialog.visible"
      title="当前配置（密钥已脱敏）"
      :footer="false"
      :width="820"
    >
      <a-spin :loading="rawDialog.loading" style="width: 100%">
        <pre class="raw-json mono">{{ rawDialog.text }}</pre>
      </a-spin>
      <div class="dialog-actions">
        <a-button type="primary" :disabled="rawDialog.loading" @click="copyRawConfig">复制</a-button>
        <a-button @click="rawDialog.visible = false">关闭</a-button>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.switched-alert {
  margin-bottom: 0;
}

.switched-body {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.switched-body a {
  color: rgb(var(--primary-6));
  font-weight: 600;
}

.settings-form {
  margin-top: 4px;
}

.switch-text {
  margin-left: 8px;
  color: var(--color-text-3);
  font-size: 12px;
}

.form-actions {
  display: flex;
  justify-content: flex-start;
  margin-top: 4px;
}

.listen-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-2);
  color: var(--color-text-3);
  font-size: 12px;
}

.text-ok {
  color: rgb(var(--green-6));
}

.inline-tag {
  margin-left: 6px;
}

.note {
  font-size: 13px;
  line-height: 1.7;
}

.hidden-input {
  display: none;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.raw-json {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--color-border-2);
  border-radius: 4px;
  background: var(--color-fill-1);
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
