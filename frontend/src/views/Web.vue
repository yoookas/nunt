<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'

const TYPE_OPTIONS = [
  { value: 'proxy', label: '反向代理' },
  { value: 'redirect', label: '重定向' },
  { value: 'static', label: '静态托管' },
  { value: 'filebrowser', label: '文件管理' },
  { value: 'webdav', label: 'WebDAV' },
]

const TYPE_LABEL = TYPE_OPTIONS.reduce((out, item) => {
  out[item.value] = item.label
  return out
}, {})

const TYPE_COLOR = {
  proxy: 'arcoblue',
  redirect: 'orange',
  static: 'green',
  filebrowser: 'purple',
  webdav: 'cyan',
}

const TLS_OPTIONS = [
  { value: 'off', label: '关闭（仅 HTTP）' },
  { value: 'auto', label: '自动证书（ACME）' },
  { value: 'custom', label: '指定证书' },
]
const TLS_LABEL = { off: '关闭', auto: '自动证书', custom: '指定证书' }

const ACCESS_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许以下列表）' },
  { value: 'deny', label: '黑名单（拒绝以下列表）' },
]

const BALANCE_OPTIONS = [
  { value: 'roundrobin', label: '轮询' },
  { value: 'random', label: '随机' },
  { value: 'iphash', label: 'IP 哈希' },
]
const BALANCE_LABEL = {
  roundrobin: '轮询',
  random: '随机',
  iphash: 'IP 哈希',
  round_robin: '轮询',
  ip_hash: 'IP 哈希',
  least_conn: '最少连接',
}
const BALANCE_ALIASES = { round_robin: 'roundrobin', ip_hash: 'iphash', least_conn: 'roundrobin' }

const REDIRECT_STATUS_OPTIONS = [
  { value: 301, label: '301 永久重定向' },
  { value: 302, label: '302 临时重定向' },
  { value: 307, label: '307 保持方法' },
  { value: 308, label: '308 永久且保持方法' },
]

function balanceValue(value) {
  const key = String(value ?? '').trim()
  if (BALANCE_OPTIONS.some((item) => item.value === key)) return key
  return BALANCE_ALIASES[key] || 'roundrobin'
}

function splitList(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function kvToText(map) {
  return Object.entries(map || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function textToKV(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).trim()
  }
  return out
}

function ruleTypeLabel(type) {
  return TYPE_LABEL[type] || type || '-'
}

function ruleTypeColor(type) {
  return TYPE_COLOR[type] || 'gray'
}

function targetText(rule) {
  if (!rule) return '-'
  if (rule.type === 'proxy') {
    const proxy = rule.proxy || {}
    const targets = Array.isArray(proxy.targets) ? proxy.targets : []
    if (!targets.length) return '-'
    const extra = targets.length > 1
      ? `（${BALANCE_LABEL[proxy.balance] || proxy.balance || '轮询'}，共 ${targets.length} 个）`
      : ''
    return `${targets[0]}${extra}`
  }
  if (rule.type === 'redirect') {
    const redirect = rule.redirect || {}
    return `${redirect.to || '-'} [${redirect.status || 302}]`
  }
  if (rule.type === 'static') {
    const stat = rule.static || {}
    return stat.mountId ? `挂载: ${stat.mountId}` : (stat.root || '-')
  }
  const files = rule.files || {}
  return files.mountId ? `挂载: ${files.mountId}${files.root ? ` ${files.root}` : ''}` : (files.root || '-')
}

function statusColor(code) {
  const n = Number(code) || 0
  if (n >= 500) return 'red'
  if (n >= 400) return 'orange'
  if (n >= 300) return 'arcoblue'
  if (n >= 200) return 'green'
  return 'gray'
}

/* ------------------------------------------------------------------ 列表 */

const rules = ref([])
const loading = ref(false)
const busyId = ref('')
const typeFilter = ref('all')
const search = ref('')

const filteredRules = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return rules.value.filter((rule) => {
    if (typeFilter.value !== 'all' && rule.type !== typeFilter.value) return false
    if (!keyword) return true
    const hay = [
      rule.name,
      rule.id,
      rule.path,
      rule.remark,
      ...(Array.isArray(rule.listen) ? rule.listen : []),
      ...(Array.isArray(rule.domains) ? rule.domains : []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(keyword)
  })
})

const columns = [
  { title: '名称', dataIndex: 'name', width: 200, slotName: 'name' },
  { title: '类型', dataIndex: 'type', width: 110, slotName: 'type' },
  { title: '监听', dataIndex: 'listen', width: 160, slotName: 'listen' },
  { title: '域名', dataIndex: 'domains', width: 180, slotName: 'domains' },
  { title: '目标', dataIndex: 'target', ellipsis: true, tooltip: true, slotName: 'target' },
  { title: 'TLS', dataIndex: 'tls', width: 105, slotName: 'tls' },
  { title: 'WAF', dataIndex: 'waf', width: 90, slotName: 'waf' },
  { title: '状态', dataIndex: 'enable', width: 180, slotName: 'status' },
  { title: '请求数', dataIndex: 'requests', width: 100, slotName: 'requests' },
  { title: '操作', width: 180, fixed: 'right', slotName: 'actions' },
]

async function load() {
  loading.value = true
  try {
    const data = await api.get('/api/v1/web/rules')
    rules.value = Array.isArray(data?.items) ? data.items : []
  } catch (err) {
    rules.value = []
    Message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function onToggle(rule, value) {
  if (busyId.value) return
  busyId.value = rule.id
  const previous = rule.enable
  rule.enable = !!value
  try {
    const data = await api.post(`/api/v1/web/rules/${encodeURIComponent(rule.id)}/toggle`)
    Message.success(data?.enable ? '已启用' : '已停用')
    await load()
  } catch (err) {
    rule.enable = previous
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

function confirmDelete(rule) {
  Modal.confirm({
    title: '删除 Web 规则',
    content: `确定删除规则「${rule.name || rule.id}」吗？该操作不可撤销。`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/web/rules/${encodeURIComponent(rule.id)}`)
        Message.success('已删除')
        await load()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

/* ------------------------------------------------------------------ 选项 */

const mounts = ref([])
const certificates = ref([])

const mountOptions = computed(() => [
  { value: '', label: '（不使用挂载，直接使用本地目录）' },
  ...mounts.value.map((mount) => ({
    value: mount.id,
    label: `${mount.name || mount.id}${mount.type ? `（${mount.type}）` : ''}`,
  })),
])

const certOptions = computed(() =>
  certificates.value.map((cert) => ({
    value: cert.id,
    label: `${(cert.domains || []).join(', ') || cert.id}${cert.expired ? '（已过期）' : ''}`,
  })),
)

async function loadOptions() {
  const [mountResult, certResult] = await Promise.allSettled([
    api.get('/api/v1/storage/mounts'),
    api.get('/api/v1/acme/certificates'),
  ])
  if (mountResult.status === 'fulfilled') {
    const data = mountResult.value
    const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
    mounts.value = list.filter((mount) => mount.enable !== false)
  }
  if (certResult.status === 'fulfilled') {
    const data = certResult.value
    certificates.value = Array.isArray(data?.items) ? data.items : []
  }
}

/* ------------------------------------------------------------------ 表单 */

function blankForm() {
  return {
    name: '',
    type: 'proxy',
    enable: true,
    listen: '',
    domains: '',
    path: '/',
    priority: 0,
    remark: '',
    tlsMode: 'off',
    tlsCertId: '',
    tlsHsts: false,
    waf: false,
    accessMode: 'off',
    accessIps: '',
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
    staticMountId: '',
    staticRoot: '',
    staticIndex: 'index.html',
    staticListing: false,
    staticSPA: false,
    staticCache: 0,
    filesMountId: '',
    filesRoot: '/',
    filesTitle: '',
    filesReadOnly: false,
    filesUpload: false,
    filesDelete: false,
    filesMkdir: false,
    filesRename: false,
    filesHidden: false,
    filesShare: false,
    filesShareTTL: 0,
  }
}

const formVisible = ref(false)
const saving = ref(false)
const editingId = ref('')
const existingAuthNames = ref([])
const form = reactive(blankForm())

function addAuthUser() {
  form.authUsers.push({ username: '', password: '' })
}

function removeAuthUser(index) {
  form.authUsers.splice(index, 1)
}

function openCreate() {
  editingId.value = ''
  existingAuthNames.value = []
  Object.assign(form, blankForm())
  formVisible.value = true
}

function openEdit(rule) {
  const tls = rule.tls || {}
  const access = rule.access || {}
  const auth = rule.basicAuth || {}
  const proxy = rule.proxy || {}
  const redirect = rule.redirect || {}
  const stat = rule.static || {}
  const files = rule.files || {}

  editingId.value = rule.id
  existingAuthNames.value = (Array.isArray(auth.users) ? auth.users : []).map((user) => user.username)

  Object.assign(form, blankForm(), {
    name: rule.name || '',
    type: rule.type || 'proxy',
    enable: !!rule.enable,
    listen: (Array.isArray(rule.listen) ? rule.listen : []).join('\n'),
    domains: (Array.isArray(rule.domains) ? rule.domains : []).join('\n'),
    path: rule.path || '/',
    priority: num(rule.priority, 0),
    remark: rule.remark || '',
    tlsMode: tls.mode || 'off',
    tlsCertId: tls.certId || '',
    tlsHsts: !!tls.hsts,
    waf: !!rule.waf,
    accessMode: access.mode || 'off',
    accessIps: (Array.isArray(access.ips) ? access.ips : []).join('\n'),
    uaMode: access.uaMode || 'off',
    uaList: (Array.isArray(access.uas) ? access.uas : []).join('\n'),
    authEnable: !!auth.enable,
    authUsers: (Array.isArray(auth.users) ? auth.users : []).map((user) => ({
      username: user.username || '',
      password: '',
    })),
    proxyTargets: (Array.isArray(proxy.targets) ? proxy.targets : []).join('\n'),
    proxyBalance: balanceValue(proxy.balance),
    proxyHostHeader: proxy.hostHeader || '',
    proxyHeaders: kvToText(proxy.headers),
    proxyRespHeaders: kvToText(proxy.respHeaders),
    proxyPathPrefix: proxy.pathPrefix || '',
    proxyPathReplace: proxy.pathReplace || '',
    proxyTimeout: num(proxy.timeoutSec, 0),
    proxyInsecure: !!proxy.insecureTls,
    proxyNoCompress: !!proxy.disableCompression,
    proxyH2C: !!proxy.h2c,
    proxyRateLimit: num(proxy.rateLimitPerSec, 0),
    proxyMaxBody: num(proxy.maxBodyBytes, 0),
    redirectTo: redirect.to || '',
    redirectStatus: Number(redirect.status) || 302,
    redirectKeep: !!redirect.keepPath,
    staticMountId: stat.mountId || '',
    staticRoot: stat.root || '',
    staticIndex: (Array.isArray(stat.index) ? stat.index : []).join(' '),
    staticListing: !!stat.listing,
    staticSPA: !!stat.spa,
    staticCache: num(stat.cacheSeconds, 0),
    filesMountId: files.mountId || '',
    filesRoot: files.root || '/',
    filesTitle: files.title || '',
    filesReadOnly: !!files.readOnly,
    filesUpload: !!files.allowUpload,
    filesDelete: !!files.allowDelete,
    filesMkdir: !!files.allowMkdir,
    filesRename: !!files.allowRename,
    filesHidden: !!files.showHidden,
    filesShare: !!files.shareLinks,
    filesShareTTL: num(files.shareTtlMinutes, 0),
  })
  formVisible.value = true
}

async function saveRule() {
  const name = form.name.trim()
  if (!name) {
    Message.warning('请填写规则名称')
    return
  }
  const listen = splitList(form.listen)
  if (!listen.length) {
    Message.warning('请至少填写一个监听地址，例如 :443')
    return
  }
  const domains = splitList(form.domains)
  const type = TYPE_LABEL[form.type] ? form.type : 'proxy'

  if (form.tlsMode === 'custom' && !form.tlsCertId.trim()) {
    Message.warning('指定证书模式必须选择一个证书')
    return
  }
  if (form.tlsMode === 'auto' && !domains.some((domain) => domain !== '*' && !domain.startsWith('~'))) {
    Message.warning('自动证书模式至少需要一个具体域名（不能只有通配符）')
    return
  }

  const proxyTargets = splitList(form.proxyTargets)
  if (type === 'proxy' && !proxyTargets.length) {
    Message.warning('反向代理规则至少需要一个上游地址')
    return
  }
  if (type === 'redirect' && !form.redirectTo.trim()) {
    Message.warning('重定向规则必须填写目标地址')
    return
  }
  if (type === 'static') {
    if (!form.staticMountId.trim() && !form.staticRoot.trim()) {
      Message.warning('静态托管规则必须填写存储挂载或本地目录')
      return
    }
  }
  if (type === 'filebrowser' || type === 'webdav') {
    if (!form.filesMountId.trim() && !form.filesRoot.trim()) {
      Message.warning('文件服务规则必须填写存储挂载或根目录')
      return
    }
  }

  const users = form.authUsers
    .map((user) => ({ username: String(user.username || '').trim(), password: String(user.password || '') }))
    .filter((user) => user.username || user.password)
  if (form.authEnable) {
    if (!users.length) {
      Message.warning('启用 BasicAuth 后至少需要一个账号')
      return
    }
    if (users.some((user) => !user.username)) {
      Message.warning('BasicAuth 账号的用户名不能为空')
      return
    }
    const missing = users.filter(
      (user) => !user.password && !existingAuthNames.value.includes(user.username),
    )
    if (missing.length) {
      Message.warning(`账号「${missing[0].username}」还没有设置密码`)
      return
    }
    if (new Set(users.map((user) => user.username)).size !== users.length) {
      Message.warning('BasicAuth 账号的用户名不能重复')
      return
    }
  }

  const payload = {
    name,
    enable: !!form.enable,
    type,
    listen,
    domains,
    path: form.path.trim() || '/',
    priority: num(form.priority, 0),
    tls: {
      mode: form.tlsMode,
      certId: form.tlsMode === 'custom' ? form.tlsCertId.trim() : '',
      hsts: !!form.tlsHsts,
    },
    waf: !!form.waf,
    access: {
      mode: form.accessMode,
      ips: splitList(form.accessIps),
      uaMode: form.uaMode,
      uas: splitList(form.uaList),
    },
    basicAuth: {
      enable: !!form.authEnable,
      // Keeping the existing accounts while BasicAuth is off avoids losing them
      // on an unrelated edit; the backend keeps the stored hashes for names it
      // already knows when the password is empty.
      users: form.authEnable
        ? users
        : users.filter((user) => existingAuthNames.value.includes(user.username)),
    },
    proxy: null,
    redirect: null,
    static: null,
    files: null,
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
      mountId: form.staticMountId.trim(),
      root: form.staticRoot.trim(),
      index: form.staticIndex.split(/\s+/).filter((item) => item.length > 0),
      listing: !!form.staticListing,
      spa: !!form.staticSPA,
      cacheSeconds: num(form.staticCache, 0),
    }
  } else {
    payload.files = {
      mountId: form.filesMountId.trim(),
      root: form.filesRoot.trim() || '/',
      title: form.filesTitle.trim(),
      readOnly: !!form.filesReadOnly,
      allowUpload: !!form.filesUpload,
      allowDelete: !!form.filesDelete,
      allowMkdir: !!form.filesMkdir,
      allowRename: !!form.filesRename,
      showHidden: !!form.filesHidden,
      shareLinks: !!form.filesShare,
      shareTtlMinutes: num(form.filesShareTTL, 0),
    }
  }

  saving.value = true
  try {
    if (editingId.value) {
      await api.put(`/api/v1/web/rules/${encodeURIComponent(editingId.value)}`, payload)
    } else {
      await api.post('/api/v1/web/rules', payload)
    }
    Message.success('保存成功')
    formVisible.value = false
    await load()
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    saving.value = false
  }
}

/* ------------------------------------------------------------------ 访问日志 */

const logVisible = ref(false)
const logLoading = ref(false)
const logAuto = ref(true)
const logRule = ref(null)
const logs = ref([])
let logTimer = null

const logColumns = [
  { title: '时间', dataIndex: 'time', width: 170, slotName: 'time' },
  { title: '客户端', dataIndex: 'clientIp', width: 140, slotName: 'clientIp' },
  { title: '方法', dataIndex: 'method', width: 80, slotName: 'method' },
  { title: '路径', dataIndex: 'path', ellipsis: true, tooltip: true },
  { title: '状态', dataIndex: 'status', width: 90, slotName: 'status' },
  { title: '耗时', dataIndex: 'duration', width: 100, slotName: 'duration' },
  { title: '大小', dataIndex: 'bytes', width: 100, slotName: 'bytes' },
  { title: '上游', dataIndex: 'upstream', width: 180, slotName: 'upstream' },
  { title: 'User-Agent', dataIndex: 'userAgent', width: 240, ellipsis: true, tooltip: true },
]

function openLogs(rule) {
  logRule.value = rule
  logs.value = []
  logVisible.value = true
  loadLogs()
}

async function loadLogs(silent = false) {
  if (!logRule.value || logLoading.value) return
  logLoading.value = true
  try {
    const data = await api.get('/api/v1/web/logs', { rule: logRule.value.id, limit: 200 })
    const items = Array.isArray(data?.items) ? data.items : []
    logs.value = items.map((item, index) => ({
      ...item,
      _key: `${item.time || ''}-${index}`,
    }))
  } catch (err) {
    if (!silent) Message.error(errorText(err))
  } finally {
    logLoading.value = false
  }
}

function stopLogTimer() {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

function startLogTimer() {
  stopLogTimer()
  logTimer = setInterval(() => {
    if (logVisible.value && logAuto.value) loadLogs(true)
  }, 5000)
}

watch(logVisible, (visible) => {
  if (visible) startLogTimer()
  else stopLogTimer()
})

onBeforeUnmount(stopLogTimer)

onMounted(() => {
  load()
  loadOptions()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>Web 服务</h2>
        <div class="sub">
          管理反向代理、重定向、静态托管、文件管理与 WebDAV 规则，共 {{ rules.length }} 条
        </div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading" @click="load">刷新</a-button>
      <a-button type="primary" @click="openCreate">新建规则</a-button>
    </div>

    <a-card :bordered="false">
      <div class="toolbar">
        <a-radio-group v-model="typeFilter" type="button" size="small">
          <a-radio value="all">全部</a-radio>
          <a-radio v-for="item in TYPE_OPTIONS" :key="item.value" :value="item.value">
            {{ item.label }}
          </a-radio>
        </a-radio-group>
        <div class="spacer" />
        <a-input
          v-model="search"
          allow-clear
          placeholder="搜索名称 / 域名 / 监听 / 路径"
          style="width: 260px"
        />
      </div>

      <a-table
        :data="filteredRules"
        :columns="columns"
        :loading="loading"
        :pagination="{ pageSize: 20, showTotal: true, showJumper: true }"
        :scroll="{ x: 1400 }"
        row-key="id"
      >
        <template #name="{ record }">
          <div class="cell-title">
            <span>{{ record.name || record.id }}</span>
            <a-tag
              v-if="record.configError"
              size="small"
              color="red"
              :title="record.configError"
            >配置错误</a-tag>
          </div>
          <div class="cell-sub">{{ record.path || '/' }}</div>
        </template>

        <template #type="{ record }">
          <a-tag :color="ruleTypeColor(record.type)" size="small">{{ ruleTypeLabel(record.type) }}</a-tag>
        </template>

        <template #listen="{ record }">
          <div class="tag-list">
            <a-tag
              v-for="item in (record.listen || []).slice(0, 2)"
              :key="item"
              size="small"
            >{{ item }}</a-tag>
            <span v-if="(record.listen || []).length > 2" class="muted">
              +{{ record.listen.length - 2 }}
            </span>
            <span v-if="!(record.listen || []).length" class="muted">-</span>
          </div>
        </template>

        <template #domains="{ record }">
          <div class="tag-list">
            <a-tag
              v-for="item in (record.domains || []).slice(0, 2)"
              :key="item"
              size="small"
            >{{ item }}</a-tag>
            <span v-if="(record.domains || []).length > 2" class="muted">
              +{{ record.domains.length - 2 }}
            </span>
            <span v-if="!(record.domains || []).length" class="muted">全部</span>
          </div>
        </template>

        <template #target="{ record }">
          <span class="mono cell-sub">{{ targetText(record) }}</span>
        </template>

        <template #tls="{ record }">
          <a-tag
            size="small"
            :color="(record.tls && record.tls.mode && record.tls.mode !== 'off') ? 'green' : 'gray'"
          >{{ TLS_LABEL[record.tls && record.tls.mode] || '关闭' }}</a-tag>
        </template>

        <template #waf="{ record }">
          <a-tag v-if="record.waf" size="small" color="green">已开启</a-tag>
          <span v-else class="muted">关闭</span>
        </template>

        <template #status="{ record }">
          <div class="state-cell">
            <a-switch
              size="small"
              :model-value="record.enable"
              :loading="busyId === record.id"
              @change="(value) => onToggle(record, value)"
            />
            <span class="muted">{{ record.enable ? '已启用' : '已停用' }}</span>
            <a-tag v-if="record.active" size="small" color="green">运行中</a-tag>
          </div>
        </template>

        <template #requests="{ record }">
          <span class="muted">{{ record.requests || 0 }}</span>
        </template>

        <template #actions="{ record }">
          <a-space>
            <a-button size="mini" @click="openLogs(record)">日志</a-button>
            <a-button size="mini" @click="openEdit(record)">编辑</a-button>
            <a-button size="mini" status="danger" @click="confirmDelete(record)">删除</a-button>
          </a-space>
        </template>

        <template #empty>
          <a-empty :description="rules.length ? '没有匹配的规则' : '还没有 Web 规则，点击右上角新建'">
            <template v-if="!rules.length" #default>
              <div>还没有 Web 规则</div>
              <a-button type="primary" size="small" style="margin-top: 8px" @click="openCreate">
                新建规则
              </a-button>
            </template>
          </a-empty>
        </template>
      </a-table>
    </a-card>

    <!-- 新建 / 编辑规则 -->
    <a-drawer
      v-model:visible="formVisible"
      :width="760"
      unmount-on-close
      :title="editingId ? '编辑 Web 规则' : '新建 Web 规则'"
    >
      <a-form :model="form" layout="vertical">
        <div class="section-title">基本信息</div>
        <div class="form-grid">
          <a-form-item label="名称" required>
            <a-input v-model="form.name" placeholder="例如 博客首页" allow-clear />
          </a-form-item>
          <a-form-item label="类型" required>
            <a-select v-model="form.type" :options="TYPE_OPTIONS" />
          </a-form-item>
          <a-form-item label="路径">
            <a-input v-model="form.path" placeholder="/" />
            <div class="hint">前缀匹配，例如 /blog</div>
          </a-form-item>
          <a-form-item label="优先级">
            <a-input-number v-model="form.priority" :min="0" style="width: 100%" />
            <div class="hint">数字越小越优先</div>
          </a-form-item>
          <a-form-item label="监听地址" required class="span-2">
            <a-textarea
              v-model="form.listen"
              :auto-size="{ minRows: 3, maxRows: 6 }"
              placeholder="每行一个，例如 :443 或 0.0.0.0:8080"
            />
            <div class="hint">每行一个监听地址，支持 :443、0.0.0.0:8080、[::]:443</div>
          </a-form-item>
          <a-form-item label="域名" class="span-2">
            <a-textarea
              v-model="form.domains"
              :auto-size="{ minRows: 2, maxRows: 5 }"
              placeholder="每行一个域名，例如 example.com、*.example.com"
            />
            <div class="hint">留空表示匹配任意 Host，支持 *.example.com 通配</div>
          </a-form-item>
          <a-form-item label="启用">
            <a-switch v-model="form.enable" />
            <div class="hint">停用后规则保留配置但不再对外服务</div>
          </a-form-item>
          <a-form-item label="备注">
            <a-input v-model="form.remark" placeholder="可选" allow-clear />
          </a-form-item>
        </div>

        <div class="section-title">TLS</div>
        <div class="form-grid">
          <a-form-item label="TLS 模式">
            <a-select v-model="form.tlsMode" :options="TLS_OPTIONS" />
          </a-form-item>
          <a-form-item v-if="form.tlsMode === 'custom'" label="证书" required>
            <a-select
              v-model="form.tlsCertId"
              :options="certOptions"
              allow-create
              allow-search
              placeholder="选择或输入证书 ID"
            />
            <div class="hint">证书来自「证书」页面，可手动填写证书 ID</div>
          </a-form-item>
          <a-form-item label="HSTS">
            <a-switch v-model="form.tlsHsts" />
            <div class="hint">对 TLS 请求附加 Strict-Transport-Security</div>
          </a-form-item>
        </div>

        <div class="section-title">WAF</div>
        <div class="form-grid">
          <a-form-item label="WAF 检查">
            <a-switch v-model="form.waf" />
            <div class="hint">关闭后该路由完全不经过 WAF</div>
          </a-form-item>
        </div>

        <template v-if="form.type === 'proxy'">
          <div class="section-title">反向代理</div>
          <div class="form-grid">
            <a-form-item label="上游列表" required class="span-2">
              <a-textarea
                v-model="form.proxyTargets"
                :auto-size="{ minRows: 3, maxRows: 8 }"
                placeholder="每行一个，例如 http://127.0.0.1:8080"
              />
              <div class="hint">支持 http/https，未写协议时默认 http://</div>
            </a-form-item>
            <a-form-item label="负载均衡">
              <a-select v-model="form.proxyBalance" :options="BALANCE_OPTIONS" />
            </a-form-item>
            <a-form-item label="Host 头">
              <a-input v-model="form.proxyHostHeader" placeholder="留空透传客户端 Host" allow-clear />
            </a-form-item>
            <a-form-item label="超时（秒）">
              <a-input-number v-model="form.proxyTimeout" :min="0" style="width: 100%" />
              <div class="hint">0 表示使用默认值</div>
            </a-form-item>
            <a-form-item label="限速（请求/秒）">
              <a-input-number v-model="form.proxyRateLimit" :min="0" style="width: 100%" />
              <div class="hint">按客户端地址限速，0 表示不限制</div>
            </a-form-item>
            <a-form-item label="请求体上限（字节）">
              <a-input-number v-model="form.proxyMaxBody" :min="0" style="width: 100%" />
              <div class="hint">0 表示不限制，1048576 = 1 MiB</div>
            </a-form-item>
            <a-form-item label="跳过上游证书校验">
              <a-switch v-model="form.proxyInsecure" />
            </a-form-item>
            <a-form-item label="禁用压缩">
              <a-switch v-model="form.proxyNoCompress" />
            </a-form-item>
            <a-form-item label="h2c 上游">
              <a-switch v-model="form.proxyH2C" />
              <div class="hint">明文 HTTP/2 上游，原生 gRPC 常用</div>
            </a-form-item>
            <a-form-item label="路径重写前缀">
              <a-input v-model="form.proxyPathPrefix" placeholder="例如 /api" allow-clear />
            </a-form-item>
            <a-form-item label="路径替换为">
              <a-input v-model="form.proxyPathReplace" placeholder="例如 /" allow-clear />
            </a-form-item>
            <a-form-item label="请求头" class="span-2">
              <a-textarea
                v-model="form.proxyHeaders"
                :auto-size="{ minRows: 2, maxRows: 6 }"
                class="mono"
                placeholder="每行一条，例如 X-Real-IP: $remote_addr"
              />
            </a-form-item>
            <a-form-item label="响应头" class="span-2">
              <a-textarea
                v-model="form.proxyRespHeaders"
                :auto-size="{ minRows: 2, maxRows: 6 }"
                class="mono"
                placeholder="每行一条，例如 X-Frame-Options: DENY"
              />
            </a-form-item>
          </div>
        </template>

        <template v-else-if="form.type === 'redirect'">
          <div class="section-title">重定向</div>
          <div class="form-grid">
            <a-form-item label="目标地址" required class="span-2">
              <a-input v-model="form.redirectTo" placeholder="https://example.com/new" allow-clear />
            </a-form-item>
            <a-form-item label="状态码">
              <a-select v-model="form.redirectStatus" :options="REDIRECT_STATUS_OPTIONS" />
            </a-form-item>
            <a-form-item label="保留原始路径">
              <a-switch v-model="form.redirectKeep" />
              <div class="hint">开启后把请求路径拼接在目标地址之后</div>
            </a-form-item>
          </div>
        </template>

        <template v-else-if="form.type === 'static'">
          <div class="section-title">静态托管</div>
          <div class="form-grid">
            <a-form-item label="存储挂载">
              <a-select
                v-model="form.staticMountId"
                :options="mountOptions"
                allow-create
                allow-search
                placeholder="选择存储挂载"
              />
            </a-form-item>
            <a-form-item label="本地目录">
              <a-input v-model="form.staticRoot" placeholder="例如 /var/www/site" allow-clear />
              <div class="hint">未选择挂载时使用该目录</div>
            </a-form-item>
            <a-form-item label="索引文件">
              <a-input v-model="form.staticIndex" placeholder="index.html index.htm" allow-clear />
              <div class="hint">空格分隔</div>
            </a-form-item>
            <a-form-item label="缓存秒数">
              <a-input-number v-model="form.staticCache" :min="0" style="width: 100%" />
              <div class="hint">0 表示不缓存</div>
            </a-form-item>
            <a-form-item label="目录列表">
              <a-switch v-model="form.staticListing" />
            </a-form-item>
            <a-form-item label="单页应用模式">
              <a-switch v-model="form.staticSPA" />
              <div class="hint">找不到文件时回退到 index.html</div>
            </a-form-item>
          </div>
        </template>

        <template v-else>
          <div class="section-title">{{ form.type === 'webdav' ? 'WebDAV' : '文件管理' }}</div>
          <div class="form-grid">
            <a-form-item label="存储挂载">
              <a-select
                v-model="form.filesMountId"
                :options="mountOptions"
                allow-create
                allow-search
                placeholder="选择存储挂载"
              />
            </a-form-item>
            <a-form-item label="根目录">
              <a-input v-model="form.filesRoot" placeholder="/" allow-clear />
              <div class="hint">未选择挂载时使用该目录</div>
            </a-form-item>
            <a-form-item label="页面标题">
              <a-input v-model="form.filesTitle" placeholder="留空使用规则名称" allow-clear />
            </a-form-item>
            <a-form-item label="只读">
              <a-switch v-model="form.filesReadOnly" />
              <div class="hint">只读会禁止所有写操作</div>
            </a-form-item>
            <a-form-item label="上传">
              <a-switch v-model="form.filesUpload" />
            </a-form-item>
            <a-form-item label="删除">
              <a-switch v-model="form.filesDelete" />
            </a-form-item>
            <a-form-item label="新建目录">
              <a-switch v-model="form.filesMkdir" />
            </a-form-item>
            <a-form-item label="重命名">
              <a-switch v-model="form.filesRename" />
            </a-form-item>
            <a-form-item label="显示隐藏文件">
              <a-switch v-model="form.filesHidden" />
            </a-form-item>
            <a-form-item label="分享链接">
              <a-switch v-model="form.filesShare" />
            </a-form-item>
            <a-form-item label="分享有效期（分钟）">
              <a-input-number v-model="form.filesShareTTL" :min="0" style="width: 100%" />
              <div class="hint">0 表示永久</div>
            </a-form-item>
            <a-form-item class="span-2">
              <div class="notice">
                文件管理与 WebDAV 必须配置 BasicAuth 或 IP 白名单，否则运行时会拒绝所有请求（403）。
              </div>
            </a-form-item>
          </div>
        </template>

        <div class="section-title">访问控制</div>
        <div class="form-grid">
          <a-form-item label="IP 策略">
            <a-select v-model="form.accessMode" :options="ACCESS_OPTIONS" />
          </a-form-item>
          <a-form-item label="UA 策略">
            <a-select v-model="form.uaMode" :options="ACCESS_OPTIONS" />
          </a-form-item>
          <a-form-item label="IP 列表" class="span-2">
            <a-textarea
              v-model="form.accessIps"
              :auto-size="{ minRows: 2, maxRows: 6 }"
              placeholder="每行一条，支持 CIDR，例如 192.168.1.0/24"
            />
          </a-form-item>
          <a-form-item label="UA 列表" class="span-2">
            <a-textarea
              v-model="form.uaList"
              :auto-size="{ minRows: 2, maxRows: 6 }"
              placeholder="每行一条，支持 * 通配，例如 *bot*"
            />
          </a-form-item>
        </div>

        <div class="section-title">BasicAuth</div>
        <div class="form-grid">
          <a-form-item label="启用 BasicAuth">
            <a-switch v-model="form.authEnable" />
          </a-form-item>
          <a-form-item v-if="form.authEnable" label="账号" class="span-2">
            <div class="auth-list">
              <div v-if="!form.authUsers.length" class="hint">还没有账号，至少添加一个账号才能生效。</div>
              <div v-for="(user, index) in form.authUsers" :key="index" class="auth-row">
                <a-input v-model="user.username" placeholder="用户名" allow-clear />
                <a-input-password
                  v-model="user.password"
                  :placeholder="existingAuthNames.includes(user.username) ? '留空表示不修改密码' : '密码'"
                />
                <a-button status="danger" size="small" @click="removeAuthUser(index)">删除</a-button>
              </div>
              <a-button size="small" @click="addAuthUser">添加账号</a-button>
              <div class="hint">已有账号的密码留空表示保持原密码；新增账号必须填写密码。</div>
            </div>
          </a-form-item>
        </div>
      </a-form>

      <template #footer>
        <div class="drawer-footer">
          <a-button @click="formVisible = false">取消</a-button>
          <a-button type="primary" :loading="saving" @click="saveRule">保存</a-button>
        </div>
      </template>
    </a-drawer>

    <!-- 访问日志 -->
    <a-drawer
      v-model:visible="logVisible"
      :width="920"
      :footer="false"
      unmount-on-close
      :title="`访问日志 · ${logRule?.name || logRule?.id || ''}`"
    >
      <div class="log-toolbar">
        <a-space>
          <a-switch v-model="logAuto" size="small" />
          <span class="muted">每 5 秒自动刷新</span>
          <a-button size="small" :loading="logLoading" @click="loadLogs(false)">刷新</a-button>
          <span class="muted">最近 {{ logs.length }} 条</span>
        </a-space>
      </div>
      <a-table
        :data="logs"
        :columns="logColumns"
        :loading="logLoading"
        :pagination="false"
        :scroll="{ x: 1200 }"
        row-key="_key"
        size="small"
      >
        <template #time="{ record }">{{ fmtTime(record.time) }}</template>
        <template #clientIp="{ record }">
          <span class="mono">{{ record.clientIp || '-' }}</span>
        </template>
        <template #method="{ record }">{{ record.method || '-' }}</template>
        <template #status="{ record }">
          <a-tag size="small" :color="statusColor(record.status)">{{ record.status || '-' }}</a-tag>
        </template>
        <template #duration="{ record }">
          {{ record.duration || (record.durationMs != null ? `${record.durationMs} ms` : '-') }}
        </template>
        <template #bytes="{ record }">{{ fmtBytes(record.bytes) }}</template>
        <template #upstream="{ record }">
          <span class="mono">{{ record.upstream || '-' }}</span>
        </template>
        <template #empty>
          <a-empty description="暂无访问日志（可能未开启访问日志记录）" />
        </template>
      </a-table>
    </a-drawer>
  </div>
</template>

<style scoped>
.section-title {
  margin: 8px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border-2);
  color: var(--color-text-2);
  font-size: 13px;
  font-weight: 600;
}

.section-title:first-child {
  margin-top: 0;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 16px;
}

.form-grid .span-2 {
  grid-column: 1 / -1;
}

.hint {
  margin-top: 4px;
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.5;
}

.cell-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  word-break: break-word;
}

.cell-sub {
  color: var(--color-text-3);
  font-size: 12px;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.state-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.auth-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.auth-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: center;
  gap: 8px;
}

.notice {
  padding: 8px 12px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--border-radius-small, 4px);
  background: var(--color-fill-2);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.6;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
</style>
