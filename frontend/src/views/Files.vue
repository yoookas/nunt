<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'

// 文件管理页。数据来源有两种：
//   * 存储挂载：GET /api/v1/storage/mounts/{id}/list，只读浏览 + 下载
//     （GET /api/v1/files/download?mount=&path=）。
//   * 文件站点：Web 规则里 type=filebrowser 的规则，浏览与全部写操作都走站点
//     自己的 JSON 接口 <站点地址>/_api/{list,upload,mkdir,rename,delete}，
//     分享链接走管理端 GET/POST /api/v1/files/shares 与 DELETE /api/v1/files/shares/{token}。
const KIND_LABELS = {
  dir: '目录',
  image: '图片',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  pdf: 'PDF',
  code: '代码',
  text: '文本',
  doc: '文档',
  file: '文件',
}

const pagination = { pageSize: 50, showTotal: true, size: 'mini' }

const mounts = ref([])
const rules = ref([])
const metaLoading = ref(false)
const metaError = ref('')

const sourceKind = ref('mount') // 'mount' | 'rule'
const mountId = ref('')
const ruleId = ref('')
const siteBase = ref('')

const path = ref('/')
const pathInput = ref('/')
const entries = ref([])
const listLoading = ref(false)
const listError = ref('')
const filter = ref('')
const readOnly = ref(false)
const overwrite = ref(false)

const capabilities = reactive({ upload: false, mkdir: false, rename: false, delete: false, share: false })

const mkdirVisible = ref(false)
const mkdirSubmitting = ref(false)
const mkdirForm = reactive({ name: '' })

const renameVisible = ref(false)
const renameSubmitting = ref(false)
const renameForm = reactive({ path: '', name: '' })

const shareVisible = ref(false)
const shareSubmitting = ref(false)
const shareForm = reactive({ rule: '', path: '/', ttlMinutes: 0, allowDownload: true })

const shares = ref([])
const sharesLoading = ref(false)
const sharesError = ref('')
const shareRuleFilter = ref('')

let uploadTimer = 0
let uploading = 0

/* ------------------------------------------------------------------ 计算属性 */

const currentMount = computed(() => mounts.value.find((item) => item.id === mountId.value) || null)
const currentRule = computed(() => rules.value.find((item) => item.id === ruleId.value) || null)
const fileRules = computed(() =>
  rules.value.filter((item) => item && item.type === 'filebrowser' && item.files),
)
const sourceKey = computed(() => {
  if (sourceKind.value === 'rule' && ruleId.value) return `rule:${ruleId.value}`
  if (sourceKind.value === 'mount' && mountId.value) return `mount:${mountId.value}`
  return ''
})
// 当前挂载被哪个文件站点引用：有的话可以一键切换过去以获得写能力。
const matchingRule = computed(() => {
  if (sourceKind.value !== 'mount' || !mountId.value) return null
  return fileRules.value.find((item) => item.files && item.files.mountId === mountId.value) || null
})
const siteEndpoint = computed(() => `${normalizedBase() || '（与后台同源）'}/_api`)
// 站点接口没有 CORS 头，跨源时浏览器会直接拦掉；提示用户改用反向代理后的同源地址。
const siteCrossOrigin = computed(() => {
  const raw = String(siteBase.value || '').trim()
  if (!raw) return false
  try {
    return new URL(raw, window.location.href).origin !== window.location.origin
  } catch {
    return false
  }
})

const filteredEntries = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (!keyword) return entries.value
  return entries.value.filter((item) => item.name.toLowerCase().includes(keyword))
})

const emptyText = computed(() => {
  if (!sourceKey.value) return '请选择存储挂载或文件站点'
  if (filter.value.trim()) return '没有匹配的文件'
  return '该目录为空'
})

const pathParts = computed(() => {
  const parts = normalizePath(path.value).split('/').filter(Boolean)
  const out = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push({ name: part, path: acc })
  }
  return out
})

const canShare = computed(() => capabilities.share && !!fileRules.value.length)

const uploadTip = computed(() =>
  capabilities.upload ? '上传文件到当前目录' : '请选择文件站点（可写位置）后再上传',
)
const mkdirTip = computed(() =>
  capabilities.mkdir ? '在当前目录下新建目录' : '请选择文件站点（可写位置）后再新建目录',
)
const shareTip = computed(() =>
  canShare.value ? '为当前目录创建分享链接' : '创建分享链接需要先选择文件站点',
)

const fileColumns = [
  { title: '名称', dataIndex: 'name', slotName: 'name', ellipsis: true, tooltip: true },
  { title: '类型', dataIndex: 'kind', slotName: 'kind', width: 100 },
  { title: '大小', dataIndex: 'size', slotName: 'size', width: 110, align: 'right' },
  { title: '修改时间', dataIndex: 'modTime', slotName: 'modTime', width: 180 },
  { title: '操作', slotName: 'actions', width: 330 },
]

const shareColumns = [
  { title: '站点', dataIndex: 'ruleId', slotName: 'rule', width: 150, ellipsis: true, tooltip: true },
  { title: '路径', dataIndex: 'path', slotName: 'sharePath', ellipsis: true, tooltip: true },
  { title: '链接', dataIndex: 'url', slotName: 'url', width: 240, ellipsis: true, tooltip: true },
  { title: '允许下载', dataIndex: 'allowDownload', slotName: 'allowDownload', width: 100 },
  { title: '有效期至', dataIndex: 'expiresAt', slotName: 'expiresAt', width: 175 },
  { title: '创建时间', dataIndex: 'createdAt', slotName: 'createdAt', width: 175 },
  { title: '操作', slotName: 'shareActions', width: 150 },
]

/* ------------------------------------------------------------------ 路径与站点地址 */

function normalizePath(value) {
  let out = String(value || '').trim()
  if (!out) return '/'
  if (!out.startsWith('/')) out = `/${out}`
  out = out.replace(/\/{2,}/g, '/')
  if (out.length > 1) out = out.replace(/\/+$/, '')
  return out || '/'
}

function joinPath(base, name) {
  const parent = normalizePath(base)
  return `${parent === '/' ? '' : parent}/${String(name || '').replace(/^\/+/, '')}`
}

function parentPath(value) {
  const clean = normalizePath(value)
  const index = clean.lastIndexOf('/')
  return index <= 0 ? '/' : clean.slice(0, index)
}

function normalizedBase() {
  const raw = String(siteBase.value || '').trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

function splitHostPort(address) {
  const raw = String(address || '').trim()
  if (!raw) return { host: '', port: '' }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end > 0) {
      const rest = raw.slice(end + 1)
      return { host: raw.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : '' }
    }
  }
  const index = raw.lastIndexOf(':')
  if (index < 0) return { host: raw, port: '' }
  return { host: raw.slice(0, index), port: raw.slice(index + 1) }
}

// 规则只暴露 listen/domains，没有「站点对外地址」字段，这里按监听地址推导一个默认值；
// 通过反向代理访问时，页面上的「站点地址」可以手工改。
function defaultSiteBase(rule) {
  if (!rule) return ''
  const listen = Array.isArray(rule.listen) && rule.listen.length ? rule.listen[0] : ''
  const { host, port } = splitHostPort(listen)
  const secure = !!(rule.tls && (rule.tls.mode === 'auto' || rule.tls.mode === 'custom'))
  const scheme = secure ? 'https' : 'http'
  const wildcard =
    !host || host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === 'localhost'
  const hostname = wildcard ? window.location.hostname : host
  const defaultPort = secure ? '443' : '80'
  const portPart = port && port !== defaultPort ? `:${port}` : ''
  const origin = `${scheme}://${hostname}${portPart}`
  const prefix = normalizePath(rule.path)
  if (origin === window.location.origin) return prefix === '/' ? '' : prefix
  return prefix === '/' ? origin : `${origin}${prefix}`
}

/* ------------------------------------------------------------------ 通用请求 */

function buildQuery(params) {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

// 站点接口不在管理端 mux 上，错误信封由站点自己返回，单独解析一次以便展示真正的失败原因。
async function siteRequest(method, name, options = {}) {
  const url = `${normalizedBase()}/_api/${name}${buildQuery(options.params)}`
  const headers = { Accept: 'application/json' }
  let body
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(url, { method, headers, body, credentials: 'same-origin' })
  } catch {
    throw new Error(
      '无法访问文件站点接口（可能被跨域策略、站点认证或网络中断拦住）。可在「站点地址」里填写可访问的站点地址，或直接打开站点页面管理文件。',
    )
  }
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!response.ok) {
    let message = data && data.error ? data.error.message : ''
    if (!message && data && Array.isArray(data.failed) && data.failed.length) {
      message = data.failed.map((item) => `${item.name || item.path || ''}：${item.error || '失败'}`).join('；')
    }
    if (!message) message = `文件站点返回 HTTP ${response.status}`
    throw new Error(message)
  }
  if (response.status !== 204 && data === null) {
    throw new Error(
      '文件站点返回的不是 JSON（可能被后台静态页或登录页拦截），请检查「站点地址」是否指向文件站点本身。',
    )
  }
  return data
}

/* ------------------------------------------------------------------ 取数 */

function applySource(kind, id) {
  sourceKind.value = kind
  if (kind === 'rule') {
    ruleId.value = id
    mountId.value = ''
    siteBase.value = defaultSiteBase(currentRule.value)
  } else {
    mountId.value = id
    ruleId.value = ''
    siteBase.value = ''
  }
  readOnly.value = false
  resetCapabilities()
  path.value = '/'
  pathInput.value = '/'
  filter.value = ''
}

function resetCapabilities() {
  capabilities.upload = false
  capabilities.mkdir = false
  capabilities.rename = false
  capabilities.delete = false
  capabilities.share = false
}

function normalizeEntries(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => ({
      name: entry.name || String(entry.path || '').split('/').filter(Boolean).pop() || '',
      path: normalizePath(entry.path || joinPath(path.value, entry.name || '')),
      dir: !!entry.dir,
      size: Number(entry.size) || 0,
      modTime: entry.modTime || '',
      kind: entry.kind || (entry.dir ? 'dir' : 'file'),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

async function loadMeta() {
  metaLoading.value = true
  metaError.value = ''
  try {
    const [mountData, ruleData] = await Promise.all([
      api.get('/api/v1/storage/mounts'),
      api.get('/api/v1/web/rules').catch(() => null),
    ])
    mounts.value = Array.isArray(mountData)
      ? mountData
      : mountData && Array.isArray(mountData.items)
        ? mountData.items
        : []
    const list = ruleData && Array.isArray(ruleData.items)
      ? ruleData.items
      : Array.isArray(ruleData)
        ? ruleData
        : []
    rules.value = list

    const stillValid =
      sourceKey.value &&
      ((sourceKind.value === 'mount' && mounts.value.some((item) => item.id === mountId.value)) ||
        (sourceKind.value === 'rule' && rules.value.some((item) => item.id === ruleId.value)))

    if (!stillValid) {
      if (mounts.value.length) applySource('mount', mounts.value[0].id)
      else if (fileRules.value.length) applySource('rule', fileRules.value[0].id)
      else applySource('mount', '')
    } else if (sourceKind.value === 'rule' && !siteBase.value) {
      siteBase.value = defaultSiteBase(currentRule.value)
    }
  } catch (err) {
    metaError.value = errorText(err)
    mounts.value = []
  } finally {
    metaLoading.value = false
  }
  if (sourceKey.value) await loadList()
}

async function loadList() {
  if (!sourceKey.value) {
    entries.value = []
    readOnly.value = false
    resetCapabilities()
    return
  }
  listLoading.value = true
  listError.value = ''
  try {
    if (sourceKind.value === 'rule') {
      const data = await siteRequest('GET', 'list', { params: { path: path.value, size: 2000 } })
      readOnly.value = !!(data && data.readOnly)
      const can = (data && data.can) || {}
      capabilities.upload = !!can.upload
      capabilities.mkdir = !!can.mkdir
      capabilities.rename = !!can.rename
      capabilities.delete = !!can.delete
      capabilities.share = !!can.share
      entries.value = normalizeEntries(data && data.entries)
    } else {
      const data = await api.get(
        `/api/v1/storage/mounts/${encodeURIComponent(mountId.value)}/list`,
        { path: path.value },
      )
      readOnly.value = !!(currentMount.value && currentMount.value.readOnly)
      resetCapabilities()
      entries.value = normalizeEntries(data && data.entries)
    }
  } catch (err) {
    entries.value = []
    resetCapabilities()
    listError.value = errorText(err)
  } finally {
    listLoading.value = false
  }
}

async function loadShares() {
  sharesLoading.value = true
  sharesError.value = ''
  try {
    const params = shareRuleFilter.value ? { rule: shareRuleFilter.value } : undefined
    const data = await api.get('/api/v1/files/shares', params)
    shares.value = Array.isArray(data)
      ? data
      : data && Array.isArray(data.items)
        ? data.items
        : []
  } catch (err) {
    shares.value = []
    sharesError.value = errorText(err)
  } finally {
    sharesLoading.value = false
  }
}

async function reloadAll() {
  await loadMeta()
  await loadShares()
}

/* ------------------------------------------------------------------ 浏览动作 */

function onSourceChange(value) {
  const raw = String(value || '')
  const index = raw.indexOf(':')
  if (index < 0) return
  applySource(raw.slice(0, index) === 'rule' ? 'rule' : 'mount', raw.slice(index + 1))
  loadList()
}

function goPath(target) {
  path.value = normalizePath(target)
  loadList()
}

function goTypedPath() {
  goPath(pathInput.value)
}

function resetSiteBase() {
  siteBase.value = defaultSiteBase(currentRule.value)
}

function useMatchingRule() {
  if (matchingRule.value) onSourceChange(`rule:${matchingRule.value.id}`)
}

function kindLabel(entry) {
  if (entry.dir) return '目录'
  return KIND_LABELS[entry.kind] || '文件'
}

function downloadUrl(entry, inline) {
  const suffix = inline ? '&inline=1' : ''
  if (sourceKind.value === 'rule') {
    const base = normalizedBase()
    return `${base}/_api/download?path=${encodeURIComponent(entry.path)}${suffix}`
  }
  if (!mountId.value) return ''
  return `/api/v1/files/download?mount=${encodeURIComponent(mountId.value)}&path=${encodeURIComponent(entry.path)}${suffix}`
}

function openEntry(entry, inline) {
  const url = downloadUrl(entry, inline)
  if (!url) return
  window.open(url, '_blank', 'noopener')
}

/* ------------------------------------------------------------------ 写操作 */

function openMkdir() {
  if (!capabilities.mkdir) {
    Message.warning('当前位置不允许新建目录，请选择可写的文件站点')
    return
  }
  mkdirForm.name = ''
  mkdirVisible.value = true
}

async function submitMkdir() {
  const name = mkdirForm.name.trim()
  if (!name) {
    Message.warning('请输入目录名称')
    return false
  }
  mkdirSubmitting.value = true
  try {
    await siteRequest('POST', 'mkdir', { body: { path: path.value, name } })
    Message.success(`已创建目录 ${name}`)
    await loadList()
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    mkdirSubmitting.value = false
  }
}

function openRename(entry) {
  if (!capabilities.rename) {
    Message.warning('当前位置不允许重命名')
    return
  }
  renameForm.path = entry.path
  renameForm.name = entry.name
  renameVisible.value = true
}

async function submitRename() {
  const name = renameForm.name.trim()
  if (!name) {
    Message.warning('请输入新的名称')
    return false
  }
  renameSubmitting.value = true
  try {
    await siteRequest('POST', 'rename', { body: { path: renameForm.path, name } })
    Message.success('已重命名')
    await loadList()
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    renameSubmitting.value = false
  }
}

function removeEntry(entry) {
  if (!capabilities.delete) {
    Message.warning('当前位置不允许删除')
    return
  }
  Modal.confirm({
    title: '删除确认',
    content: `确定删除${entry.dir ? '目录' : '文件'}「${entry.name}」吗？目录会连带其中的内容一起删除，且不可撤销。`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await siteRequest('POST', 'delete', { body: { paths: [entry.path] } })
        Message.success('已删除')
        await loadList()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

// 上传走站点的 multipart 接口：POST <站点地址>/_api/upload?path=<当前目录>&confirm=0|1。
// 后端按 part 的 filename 落盘，因此字段名固定用 "file"。
function uploadFile(option) {
  if (!capabilities.upload) {
    option.onError(new Error('当前位置不允许上传'))
    Message.warning('当前位置不允许上传，请选择可写的文件站点')
    return { abort: () => {} }
  }
  const file = option.fileItem && option.fileItem.file
  if (!file) {
    option.onError(new Error('文件读取失败'))
    return { abort: () => {} }
  }
  const confirm = overwrite.value ? '1' : '0'
  const url = `${normalizedBase()}/_api/upload?path=${encodeURIComponent(path.value)}&confirm=${confirm}`
  const form = new FormData()
  form.append('file', file, file.name)

  uploading += 1
  const xhr = new XMLHttpRequest()
  const finish = () => {
    uploading = Math.max(0, uploading - 1)
    scheduleReload()
  }
  xhr.open('POST', url)
  xhr.withCredentials = true
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable && event.total > 0) {
      // Arco Upload 的进度是 0~1 的小数，不是百分比。
      option.onProgress(event.loaded / event.total)
    }
  }
  xhr.onload = () => {
    let data = null
    try {
      data = JSON.parse(xhr.responseText)
    } catch {
      data = null
    }
    const saved = (data && data.saved) || []
    const failed = (data && data.failed) || []
    if (xhr.status >= 200 && xhr.status < 300) {
      option.onSuccess(data)
      if (saved.length) Message.success(`已上传 ${file.name}`)
      if (failed.length) {
        Message.warning(failed.map((item) => `${item.name || file.name}：${item.error || '失败'}`).join('；'))
      }
      finish()
      return
    }
    let message = (data && data.error && data.error.message) || ''
    if (!message && failed.length) {
      message = failed.map((item) => `${item.name || file.name}：${item.error || '失败'}`).join('；')
    }
    if (!message) message = `上传失败（HTTP ${xhr.status}）`
    option.onError(new Error(message))
    Message.error(message)
    finish()
  }
  xhr.onerror = () => {
    const message =
      '上传请求失败（跨域、站点认证或网络错误）。可在「站点地址」里填写可访问的站点地址后重试。'
    option.onError(new Error(message))
    Message.error(message)
    finish()
  }
  xhr.onabort = () => finish()
  xhr.send(form)
  return { abort: () => xhr.abort() }
}

function scheduleReload() {
  if (uploadTimer) window.clearTimeout(uploadTimer)
  uploadTimer = window.setTimeout(() => {
    uploadTimer = 0
    if (uploading === 0) loadList()
  }, 400)
}

/* ------------------------------------------------------------------ 分享链接 */

function ruleName(id) {
  const rule = rules.value.find((item) => item.id === id)
  return rule ? rule.name || rule.id : id || '-'
}

function shareLink(share) {
  const url = String((share && share.url) || '')
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  return `${window.location.origin}${url}`
}

function openShare(target) {
  if (!fileRules.value.length) {
    Message.warning('没有可用的文件站点（Web 规则类型为「文件管理」），无法创建分享链接')
    return
  }
  let rule = null
  if (sourceKind.value === 'rule' && currentRule.value) rule = currentRule.value
  if (!rule) rule = matchingRule.value
  if (!rule) rule = fileRules.value[0]
  shareForm.rule = rule.id
  shareForm.path = typeof target === 'string' ? target : normalizePath(path.value)
  shareForm.ttlMinutes = Number(rule.files && rule.files.shareTtlMinutes) || 0
  shareForm.allowDownload = true
  shareVisible.value = true
}

async function submitShare() {
  if (!shareForm.rule) {
    Message.warning('请选择文件站点')
    return false
  }
  const target = shareForm.path.trim()
  if (!target) {
    Message.warning('请填写要分享的路径')
    return false
  }
  const targetRule = rules.value.find((item) => item.id === shareForm.rule)
  if (targetRule && targetRule.files && !targetRule.files.shareLinks) {
    Message.warning('该文件站点未启用分享链接（files.shareLinks），请先在 Web 服务规则中开启')
    return false
  }
  shareSubmitting.value = true
  try {
    const created = await api.post('/api/v1/files/shares', {
      rule: shareForm.rule,
      path: target,
      ttlMinutes: Number(shareForm.ttlMinutes) || 0,
      allowDownload: !!shareForm.allowDownload,
    })
    Message.success('分享链接已创建')
    shareVisible.value = false
    await loadShares()
    const link = shareLink(created)
    if (link) copyText(link)
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    shareSubmitting.value = false
  }
}

function openShareLink(share) {
  const link = shareLink(share)
  if (!link) {
    Message.warning('该分享链接没有可用的地址')
    return
  }
  window.open(link, '_blank', 'noopener')
}

function removeShare(share) {
  Modal.confirm({
    title: '取消分享',
    content: `确定取消「${share.path}」的分享链接吗？取消后原链接立即失效。`,
    okText: '取消分享',
    cancelText: '保留',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/files/shares/${encodeURIComponent(share.token || share.id)}`)
        Message.success('已取消分享')
        await loadShares()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

async function copyText(text) {
  const value = String(text || '')
  if (!value) return
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      Message.success('已复制链接')
      return
    } catch {
      /* 回退到提示手动复制 */
    }
  }
  Message.warning(`请手动复制：${value}`)
}

/* ------------------------------------------------------------------ 其他 */

watch(path, (value) => {
  pathInput.value = value
})

watch(shareRuleFilter, () => {
  loadShares()
})

onMounted(async () => {
  await loadMeta()
  await loadShares()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>文件管理</h2>
        <div class="sub">浏览存储挂载与文件站点，下载、上传、新建目录、重命名、删除并管理分享链接</div>
      </div>
      <span class="spacer" />
      <a-button size="small" :loading="metaLoading || listLoading" @click="reloadAll">
        <template #icon><icon-refresh /></template>
        刷新
      </a-button>
      <a-tooltip :content="uploadTip">
        <span class="btn-wrap">
          <a-upload
            :custom-request="uploadFile"
            :show-file-list="false"
            :disabled="!capabilities.upload"
            multiple
          >
            <template #upload-button>
              <a-button size="small" type="primary" :disabled="!capabilities.upload">
                <template #icon><icon-upload /></template>
                上传文件
              </a-button>
            </template>
          </a-upload>
        </span>
      </a-tooltip>
      <a-tooltip :content="overwrite ? '同名文件将被覆盖' : '同名文件将被跳过'">
        <a-checkbox v-model="overwrite" class="overwrite">覆盖同名文件</a-checkbox>
      </a-tooltip>
      <a-tooltip :content="mkdirTip">
        <span class="btn-wrap">
          <a-button size="small" :disabled="!capabilities.mkdir" @click="openMkdir">
            <template #icon><icon-folder-add /></template>
            新建目录
          </a-button>
        </span>
      </a-tooltip>
      <a-tooltip :content="shareTip">
        <span class="btn-wrap">
          <a-button size="small" :disabled="!canShare" @click="openShare()">
            <template #icon><icon-share-alt /></template>
            创建分享
          </a-button>
        </span>
      </a-tooltip>
    </div>

    <a-card :bordered="false" class="card-gap">
      <template #title>
        <div class="card-title">
          <span>浏览</span>
          <a-tag
            v-if="sourceKind === 'rule' && sourceKey"
            size="small"
            :bordered="false"
            :color="readOnly ? 'orange' : 'green'"
          >
            {{ readOnly ? '只读站点' : '可写站点' }}
          </a-tag>
          <a-tag
            v-else-if="sourceKind === 'mount' && currentMount"
            size="small"
            :bordered="false"
            color="gray"
          >
            {{ currentMount.readOnly ? '只读挂载' : '挂载' }}
          </a-tag>
        </div>
      </template>

      <div class="toolbar">
        <a-select
          :model-value="sourceKey"
          class="source-select"
          size="small"
          placeholder="选择存储挂载或文件站点"
          :loading="metaLoading"
          @change="onSourceChange"
        >
          <a-optgroup label="存储挂载（只读浏览 / 下载）">
            <a-option v-for="item in mounts" :key="`mount:${item.id}`" :value="`mount:${item.id}`">
              {{ item.name || item.id }}（{{ item.type === 'webdav' ? 'WebDAV' : '本地' }}）
            </a-option>
          </a-optgroup>
          <a-optgroup label="文件站点（可上传 / 新建 / 重命名 / 删除 / 分享）">
            <a-option v-for="item in fileRules" :key="`rule:${item.id}`" :value="`rule:${item.id}`">
              {{ item.name || item.id }}（{{ item.path || '/' }}）
            </a-option>
          </a-optgroup>
        </a-select>
        <a-button size="small" :disabled="!sourceKey" @click="goPath(parentPath(path))">上一级</a-button>
        <a-button size="small" :disabled="!sourceKey" @click="goPath('/')">根目录</a-button>
        <a-input
          v-model="pathInput"
          class="path-input"
          size="small"
          placeholder="/sub/dir"
          allow-clear
          @press-enter="goTypedPath"
        />
        <a-button size="small" :disabled="!sourceKey" @click="goTypedPath">前往</a-button>
        <a-button size="small" :loading="listLoading" :disabled="!sourceKey" @click="loadList">
          <template #icon><icon-refresh /></template>
          刷新
        </a-button>
        <a-input v-model="filter" class="filter-input" size="small" placeholder="过滤当前目录" allow-clear />
      </div>

      <div v-if="sourceKind === 'rule'" class="toolbar toolbar-sub">
        <span class="muted toolbar-label">站点地址</span>
        <a-input
          v-model="siteBase"
          class="site-input"
          size="small"
          placeholder="留空表示与后台同源，例如 https://example.com/files"
          @press-enter="loadList"
        />
        <a-button size="small" @click="resetSiteBase">按规则推导</a-button>
        <span class="muted toolbar-hint">
          写入与分享调用站点接口 <span class="mono">{{ siteEndpoint }}</span>；站点若启用 BasicAuth / IP 白名单，浏览器需能直接访问该地址。
        </span>
      </div>

      <a-breadcrumb v-if="sourceKey" class="crumbs">
        <a-breadcrumb-item>
          <a-button type="text" size="mini" @click="goPath('/')">根目录</a-button>
        </a-breadcrumb-item>
        <a-breadcrumb-item v-for="part in pathParts" :key="part.path">
          <a-button type="text" size="mini" @click="goPath(part.path)">{{ part.name }}</a-button>
        </a-breadcrumb-item>
      </a-breadcrumb>

      <div v-if="sourceKind === 'mount' && currentMount" class="hint muted">
        当前以「存储挂载」方式只读浏览；上传 / 新建目录 / 重命名 / 删除 / 分享需要通过文件站点完成。
        <template v-if="matchingRule">
          该挂载被文件站点「{{ matchingRule.name || matchingRule.id }}」引用，
          <a-button type="text" size="mini" @click="useMatchingRule">切换到该文件站点</a-button>
        </template>
      </div>
      <div v-else-if="sourceKind === 'rule' && currentRule" class="hint muted">
        规则：{{ currentRule.name || currentRule.id }} · 路径 {{ currentRule.path || '/' }}
        <template v-if="readOnly"> · 该站点为只读，写操作已禁用</template>
      </div>

      <a-alert v-if="metaError" type="warning" class="card-alert">无法读取存储挂载：{{ metaError }}</a-alert>
      <a-alert v-if="sourceKind === 'rule' && siteCrossOrigin" type="warning" class="card-alert">
        当前「站点地址」与后台不同源。文件站点接口没有开放 CORS，浏览器会拦截跨源请求；请填写通过反向代理与后台同源的站点地址（例如
        <span class="mono">https://example.com/files</span>），或直接打开站点页面管理文件。
      </a-alert>
      <a-alert v-if="listError" type="warning" class="card-alert">目录读取失败：{{ listError }}</a-alert>

      <a-table
        :key="`${sourceKey}|${path}|${filter}`"
        :columns="fileColumns"
        :data="filteredEntries"
        :loading="listLoading"
        :pagination="sourceKey ? pagination : false"
        row-key="path"
        size="small"
        :bordered="false"
      >
        <template #name="{ record }">
          <span class="entry-name" :class="{ 'entry-dir': record.dir }">
            <icon-folder v-if="record.dir" />
            <icon-file v-else />
            {{ record.name }}{{ record.dir ? '/' : '' }}
          </span>
        </template>
        <template #kind="{ record }">
          <a-tag size="small" :bordered="false" color="gray">{{ kindLabel(record) }}</a-tag>
        </template>
        <template #size="{ record }">{{ record.dir ? '-' : fmtBytes(record.size) }}</template>
        <template #modTime="{ record }">
          <span class="muted">{{ fmtTime(record.modTime) }}</span>
        </template>
        <template #actions="{ record }">
          <a-space :size="4">
            <a-button v-if="record.dir" type="text" size="mini" @click="goPath(record.path)">打开</a-button>
            <a-button v-else type="text" size="mini" @click="openEntry(record, false)">下载</a-button>
            <a-button v-if="!record.dir" type="text" size="mini" @click="openEntry(record, true)">预览</a-button>
            <a-button
              v-if="capabilities.rename"
              type="text"
              size="mini"
              @click="openRename(record)"
            >
              重命名
            </a-button>
            <a-button
              v-if="capabilities.share"
              type="text"
              size="mini"
              @click="openShare(record.path)"
            >
              分享
            </a-button>
            <a-button
              v-if="capabilities.delete"
              type="text"
              size="mini"
              status="danger"
              @click="removeEntry(record)"
            >
              删除
            </a-button>
          </a-space>
        </template>
        <template #empty>
          <a-empty :description="emptyText" />
        </template>
      </a-table>

      <div class="muted foot">
        下载地址：挂载模式使用 <span class="mono">/api/v1/files/download?mount=&lt;挂载&gt;&amp;path=&lt;路径&gt;</span>，
        文件站点模式使用 <span class="mono">&lt;站点地址&gt;/_api/download?path=&lt;路径&gt;</span>；预览额外带 <span class="mono">inline=1</span>。
      </div>
    </a-card>

    <a-card :bordered="false" class="card-gap">
      <template #title>
        <div class="card-title">
          <span>分享链接</span>
          <span class="muted card-title-note">GET /api/v1/files/shares · DELETE /api/v1/files/shares/{token}</span>
        </div>
      </template>

      <div class="toolbar">
        <a-select v-model="shareRuleFilter" class="source-select" size="small" placeholder="全部站点">
          <a-option value="">全部站点</a-option>
          <a-option v-for="item in fileRules" :key="item.id" :value="item.id">
            {{ item.name || item.id }}
          </a-option>
        </a-select>
        <a-button size="small" :loading="sharesLoading" @click="loadShares">
          <template #icon><icon-refresh /></template>
          刷新
        </a-button>
        <a-button size="small" type="primary" :disabled="!fileRules.length" @click="openShare()">
          <template #icon><icon-share-alt /></template>
          创建分享
        </a-button>
      </div>

      <a-alert v-if="sharesError" type="warning" class="card-alert">
        分享链接接口不可用：{{ sharesError }}
        （分享链接由文件管理模块提供，模块未启用时不可用）
      </a-alert>

      <a-table
        :key="shareRuleFilter"
        :columns="shareColumns"
        :data="shares"
        :loading="sharesLoading"
        :pagination="pagination"
        row-key="token"
        size="small"
        :bordered="false"
      >
        <template #rule="{ record }">
          <span>{{ ruleName(record.ruleId) }}</span>
        </template>
        <template #sharePath="{ record }">
          <span class="mono">{{ record.path }}</span>
        </template>
        <template #url="{ record }">
          <span class="mono">{{ shareLink(record) || '-' }}</span>
        </template>
        <template #allowDownload="{ record }">
          <a-tag size="small" :bordered="false" :color="record.allowDownload ? 'green' : 'gray'">
            {{ record.allowDownload ? '允许' : '禁止' }}
          </a-tag>
        </template>
        <template #expiresAt="{ record }">
          <span class="muted">{{ record.expiresAt ? fmtTime(record.expiresAt) : '永久' }}</span>
        </template>
        <template #createdAt="{ record }">
          <span class="muted">{{ fmtTime(record.createdAt) }}</span>
        </template>
        <template #shareActions="{ record }">
          <a-space :size="4">
            <a-button type="text" size="mini" @click="copyText(shareLink(record))">复制</a-button>
            <a-button
              type="text"
              size="mini"
              :disabled="!shareLink(record)"
              @click="openShareLink(record)"
            >
              打开
            </a-button>
            <a-button type="text" size="mini" status="danger" @click="removeShare(record)">删除</a-button>
          </a-space>
        </template>
        <template #empty>
          <a-empty description="暂无分享链接" />
        </template>
      </a-table>
    </a-card>

    <a-modal
      v-model:visible="mkdirVisible"
      title="新建目录"
      :ok-loading="mkdirSubmitting"
      ok-text="创建"
      cancel-text="取消"
      @before-ok="submitMkdir"
    >
      <a-form :model="mkdirForm" layout="vertical">
        <a-form-item label="所在位置">
          <span class="mono">{{ path }}</span>
        </a-form-item>
        <a-form-item
          field="name"
          label="目录名称"
          :rules="[{ required: true, message: '请输入目录名称' }]"
        >
          <a-input v-model="mkdirForm.name" placeholder="新目录名称" allow-clear />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="renameVisible"
      title="重命名"
      :ok-loading="renameSubmitting"
      ok-text="保存"
      cancel-text="取消"
      @before-ok="submitRename"
    >
      <a-form :model="renameForm" layout="vertical">
        <a-form-item label="当前路径">
          <span class="mono">{{ renameForm.path }}</span>
        </a-form-item>
        <a-form-item
          field="name"
          label="新名称"
          :rules="[{ required: true, message: '请输入新的名称' }]"
        >
          <a-input v-model="renameForm.name" placeholder="新的名称" allow-clear />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="shareVisible"
      title="创建分享链接"
      :ok-loading="shareSubmitting"
      ok-text="创建"
      cancel-text="取消"
      @before-ok="submitShare"
    >
      <a-form :model="shareForm" layout="vertical">
        <a-form-item field="rule" label="文件站点">
          <a-select v-model="shareForm.rule" placeholder="选择文件站点">
            <a-option v-for="item in fileRules" :key="item.id" :value="item.id">
              {{ item.name || item.id }}（{{ item.path || '/' }}）
            </a-option>
          </a-select>
        </a-form-item>
        <a-form-item
          field="path"
          label="分享路径（相对站点根目录）"
          :rules="[{ required: true, message: '请输入要分享的路径' }]"
        >
          <a-input v-model="shareForm.path" placeholder="/dir 或 /dir/file.txt" allow-clear />
        </a-form-item>
        <a-form-item field="ttlMinutes" label="有效期（分钟，0 表示使用站点默认值）">
          <a-input-number v-model="shareForm.ttlMinutes" :min="0" :max="525600" />
        </a-form-item>
        <a-form-item field="allowDownload" label="允许下载">
          <a-switch v-model="shareForm.allowDownload" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.page-header {
  flex-wrap: wrap;
}

.card-gap {
  margin-bottom: 16px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.card-title-note {
  font-size: 12px;
  font-weight: 400;
}

.toolbar {
  margin-bottom: 12px;
}

.toolbar-sub {
  align-items: center;
}

.toolbar-label {
  font-size: 12px;
}

.toolbar-hint {
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.source-select {
  width: 300px;
}

.path-input {
  width: 220px;
}

.filter-input {
  width: 180px;
}

.site-input {
  flex: 1;
  min-width: 260px;
}

.crumbs {
  margin-bottom: 8px;
}

.hint {
  margin-bottom: 8px;
  font-size: 12.5px;
  line-height: 1.7;
}

.card-alert {
  margin-bottom: 12px;
}

.entry-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  word-break: break-all;
}

.entry-dir {
  color: rgb(var(--primary-6));
  font-weight: 600;
}

.overwrite {
  font-size: 12px;
  white-space: nowrap;
}

.btn-wrap {
  display: inline-flex;
}

.foot {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
