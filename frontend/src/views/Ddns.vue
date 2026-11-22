<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtTime } from '../format'

const RECORD_TYPE_OPTIONS = [
  { value: 'A', label: 'A（IPv4）' },
  { value: 'AAAA', label: 'AAAA（IPv6）' },
  { value: 'A_AND_AAAA', label: 'A + AAAA（同时更新）' },
]
const IP_MODE_OPTIONS = [
  { value: 'interface', label: '网卡地址' },
  { value: 'url', label: 'URL 获取' },
  { value: 'static', label: '静态地址' },
]
const IP_MODE_LABEL = { interface: '网卡地址', url: 'URL 获取', static: '静态地址' }

const rules = ref([])
const statusList = ref([])
const providers = ref([])
const providersLoading = ref(false)
const providersError = ref(null)
const loading = ref(false)
const statusLoading = ref(false)
const loadError = ref(null)
const statusError = ref(null)
const busyId = ref('')
const keyword = ref('')

const ruleModalVisible = ref(false)
const ruleFormRef = ref(null)
const editingId = ref('')
const originalProvider = ref('')
const originalCreds = ref({})
const originalCallback = ref(null)
const lastProvider = ref('')
const creds = reactive({})
const credDrafts = reactive({})
const testing = ref(false)

const logModalVisible = ref(false)
const logModalTitle = ref('')
const logModalError = ref('')
const logRecords = ref([])

const ruleForm = reactive({
  name: '',
  enable: true,
  provider: '',
  domain: '',
  subDomainsText: '',
  recordType: 'A',
  ttl: 600,
  intervalSec: 300,
  cron: '',
  remark: '',
  creds,
  ipv4: emptyGetIP(true),
  ipv6: emptyGetIP(false),
})

const formRules = {
  name: [{ required: true, message: '请填写规则名称' }],
  provider: [{ required: true, message: '请选择 DNS 提供商' }],
  domain: [{ required: true, message: '请填写主域名' }],
}

const ruleColumns = [
  { title: '名称', dataIndex: 'name', width: 160, slotName: 'name' },
  { title: '域名', dataIndex: 'domain', width: 230, slotName: 'domain' },
  { title: '提供商', dataIndex: 'provider', width: 150, slotName: 'provider' },
  { title: '记录类型', dataIndex: 'recordType', width: 100, slotName: 'recordType' },
  { title: '探测方式', width: 155, slotName: 'probe' },
  { title: '调度', width: 145, slotName: 'schedule' },
  { title: '当前 IP', width: 180, slotName: 'ip' },
  { title: '状态', width: 115, slotName: 'status' },
  { title: '操作', width: 235, slotName: 'actions', fixed: 'right' },
]

const statusColumns = [
  { title: '规则', dataIndex: 'name', width: 170 },
  { title: 'IPv4', dataIndex: 'ipv4', width: 160, render: ({ record }) => record.ipv4 || '-' },
  { title: 'IPv6', dataIndex: 'ipv6', width: 160, render: ({ record }) => record.ipv6 || '-' },
  { title: '上次执行', dataIndex: 'lastRun', width: 170, render: ({ record }) => fmtTime(record.lastRun) },
  { title: '上次成功', dataIndex: 'lastSuccess', width: 170, render: ({ record }) => fmtTime(record.lastSuccess) },
  { title: '成功 / 失败', width: 150, slotName: 'counts' },
  { title: '最近结果', dataIndex: 'lastError', slotName: 'message' },
  { title: '操作', width: 100, slotName: 'actions', fixed: 'right' },
]

const logColumns = [
  { title: '时间', dataIndex: 'time', width: 170, render: ({ record }) => fmtTime(record.time) },
  { title: '结果', dataIndex: 'ok', width: 100, slotName: 'ok' },
  { title: '内容', dataIndex: 'message', slotName: 'message' },
]

function emptyGetIP(enable) {
  return { enable, mode: 'url', value: '', iface: '', regex: '' }
}

function ipForm(value, enableDefault) {
  const source = value || {}
  return {
    enable: source.enable !== undefined ? !!source.enable : enableDefault,
    mode: source.mode || 'url',
    value: source.value || '',
    iface: source.iface || '',
    regex: source.regex || '',
  }
}

function onSearchInput(value) {
  keyword.value = String(value || '')
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function splitLines(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function isMasked(value) {
  const text = value == null ? '' : String(value).trim()
  return !text || text.includes('********')
}

function providerMeta(id) {
  return providers.value.find((item) => item.id === id) || null
}

function providerTitle(id) {
  const meta = providerMeta(id)
  return meta?.title || id || '-'
}

const providerOptions = computed(() => {
  const list = providers.value.map((item) => ({ value: item.id, label: item.title || item.id }))
  if (ruleForm.provider && !list.some((item) => item.value === ruleForm.provider)) {
    list.unshift({ value: ruleForm.provider, label: ruleForm.provider })
  }
  return list
})

const currentProvider = computed(() => providerMeta(ruleForm.provider))
const currentFields = computed(() => currentProvider.value?.fields || [])

const statusMap = computed(() => {
  const map = {}
  for (const item of statusList.value) {
    if (item?.id) map[item.id] = item
  }
  return map
})

const filteredRules = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return rules.value
  return rules.value.filter((rule) =>
    [rule.name, rule.domain, rule.provider, (rule.subDomains || []).join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(q),
  )
})

function statusOf(rule) {
  return rule?.id ? statusMap.value[rule.id] || null : null
}

function currentIPs(rule) {
  const state = statusOf(rule)
  if (!state) return []
  return [state.ipv4, state.ipv6].filter(Boolean)
}

function ipModeLabel(group) {
  if (!group?.enable) return '关闭'
  return IP_MODE_LABEL[group.mode] || group.mode || 'URL 获取'
}

function scheduleLabel(rule) {
  if (rule?.cron) return `cron: ${rule.cron}`
  return `每 ${num(rule?.intervalSec) || 300} 秒`
}

function lastMessage(row) {
  if (row?.lastError) return row.lastError
  const records = row?.records || []
  return records.length ? records[records.length - 1].message : '-'
}

function canReuseMask(key) {
  return !!(editingId.value && ruleForm.provider === originalProvider.value && originalCreds.value[key])
}

function credRules(field) {
  return [
    {
      validator: (value, callback) => {
        if (!field.required) return callback()
        const raw = value === undefined ? creds[field.key] : value
        const text = raw == null ? '' : String(raw).trim()
        if (text && !text.includes('********')) return callback()
        if (canReuseMask(field.key)) return callback()
        callback(`请填写${field.label}`)
      },
    },
  ]
}

function applyProviderFields(providerId, seed) {
  for (const key of Object.keys(creds)) delete creds[key]
  const fields = providerMeta(providerId)?.fields || []
  for (const field of fields) {
    creds[field.key] = seed && seed[field.key] != null ? String(seed[field.key]) : ''
  }
}

function onProviderChange(value) {
  ruleForm.provider = value
  if (lastProvider.value && lastProvider.value !== value) {
    credDrafts[lastProvider.value] = { ...creds }
  }
  const seed = credDrafts[value] || (editingId.value && value === originalProvider.value ? originalCreds.value : {})
  applyProviderFields(value, seed)
  lastProvider.value = value
  nextTick(() => ruleFormRef.value?.clearValidate())
}

function buildCreds() {
  const out = {}
  if (currentFields.value.length) {
    for (const field of currentFields.value) {
      out[field.key] = creds[field.key] == null ? '' : String(creds[field.key])
    }
  } else if (editingId.value && ruleForm.provider === originalProvider.value) {
    Object.assign(out, originalCreds.value)
  }
  return out
}

function buildGetIP(group) {
  const mode = group.mode || 'url'
  return {
    enable: !!group.enable,
    mode,
    value: mode === 'interface' ? '' : String(group.value || '').trim(),
    iface: mode === 'interface' ? String(group.iface || '').trim() : '',
    regex: mode === 'url' ? String(group.regex || '').trim() : '',
  }
}

function getIPError(group, label) {
  if (!group.enable) return ''
  if (group.mode !== 'static') return ''
  if (!String(group.value || '').trim()) return `请填写${label}`
  return ''
}

async function loadProviders() {
  providersLoading.value = true
  try {
    const data = await api.get('/api/v1/ddns/providers')
    providers.value = Array.isArray(data) ? data : (data?.providers || data?.items || [])
    providersError.value = null
  } catch (err) {
    providersError.value = err
    providers.value = []
  } finally {
    providersLoading.value = false
  }
}

async function loadRules() {
  loading.value = true
  try {
    const data = await api.get('/api/v1/ddns/rules')
    rules.value = Array.isArray(data) ? data : (data?.rules || data?.items || [])
    loadError.value = null
  } catch (err) {
    loadError.value = err
    Message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function loadStatus() {
  statusLoading.value = true
  try {
    const data = await api.get('/api/v1/ddns/status')
    statusList.value = Array.isArray(data) ? data : (data?.rules || [])
    statusError.value = null
  } catch (err) {
    statusError.value = err
    statusList.value = []
  } finally {
    statusLoading.value = false
  }
}

async function refreshAll() {
  await Promise.all([loadProviders(), loadRules(), loadStatus()])
}

function openCreate() {
  if (!providers.value.length) {
    Message.warning('还没有获取到 DNS 提供商列表，请先刷新重试')
    return
  }
  editingId.value = ''
  originalProvider.value = ''
  originalCreds.value = {}
  originalCallback.value = null
  for (const key of Object.keys(credDrafts)) delete credDrafts[key]
  const provider = providers.value[0]?.id || ''
  Object.assign(ruleForm, {
    name: '',
    enable: true,
    provider,
    domain: '',
    subDomainsText: '@',
    recordType: 'A',
    ttl: 600,
    intervalSec: 300,
    cron: '',
    remark: '',
    ipv4: emptyGetIP(true),
    ipv6: emptyGetIP(false),
  })
  applyProviderFields(provider, {})
  lastProvider.value = provider
  ruleModalVisible.value = true
  nextTick(() => ruleFormRef.value?.clearValidate())
}

function openEdit(rule) {
  editingId.value = String(rule.id || '')
  originalProvider.value = rule.provider || ''
  originalCreds.value = { ...(rule.creds || {}) }
  originalCallback.value = rule.callback || null
  for (const key of Object.keys(credDrafts)) delete credDrafts[key]
  const provider = rule.provider || providers.value[0]?.id || ''
  Object.assign(ruleForm, {
    name: rule.name || '',
    enable: rule.enable !== false,
    provider,
    domain: rule.domain || '',
    subDomainsText: (Array.isArray(rule.subDomains) ? rule.subDomains : []).join('\n'),
    recordType: rule.recordType || 'A',
    ttl: num(rule.ttl),
    intervalSec: num(rule.intervalSec),
    cron: rule.cron || '',
    remark: rule.remark || '',
    ipv4: ipForm(rule.ipv4, false),
    ipv6: ipForm(rule.ipv6, false),
  })
  applyProviderFields(provider, originalCreds.value)
  lastProvider.value = provider
  ruleModalVisible.value = true
  nextTick(() => ruleFormRef.value?.clearValidate())
}

async function submitRule() {
  if (ruleFormRef.value) {
    const errors = await ruleFormRef.value.validate()
    if (errors) return false
  }
  if (ruleForm.enable && !ruleForm.ipv4.enable && !ruleForm.ipv6.enable) {
    Message.warning('请至少启用 IPv4 或 IPv6 中的一种公网地址探测')
    return false
  }
  const ipProblem =
    getIPError(ruleForm.ipv4, ' IPv4 静态地址') ||
    getIPError(ruleForm.ipv6, ' IPv6 静态地址')
  if (ipProblem) {
    Message.warning(ipProblem.trim())
    return false
  }
  const missing = currentFields.value
    .filter((field) => field.required && isMasked(creds[field.key]) && !canReuseMask(field.key))
    .map((field) => field.label)
  if (missing.length) {
    Message.warning(`请填写凭据：${missing.join('、')}`)
    return false
  }

  const payload = {
    name: ruleForm.name.trim(),
    enable: !!ruleForm.enable,
    provider: ruleForm.provider,
    creds: buildCreds(),
    domain: ruleForm.domain.trim(),
    subDomains: splitLines(ruleForm.subDomainsText),
    recordType: ruleForm.recordType || 'A',
    ttl: num(ruleForm.ttl),
    intervalSec: num(ruleForm.intervalSec),
    cron: ruleForm.cron.trim(),
    ipv4: buildGetIP(ruleForm.ipv4),
    ipv6: buildGetIP(ruleForm.ipv6),
    callback: originalCallback.value,
    remark: ruleForm.remark.trim(),
  }

  try {
    if (editingId.value) {
      await api.put(`/api/v1/ddns/rules/${encodeURIComponent(editingId.value)}`, payload)
    } else {
      await api.post('/api/v1/ddns/rules', payload)
    }
    Message.success(editingId.value ? '规则已保存' : '规则已创建')
    await Promise.all([loadRules(), loadStatus()])
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  }
}

function testProvider() {
  if (!ruleForm.domain.trim()) {
    Message.warning('请先填写主域名')
    return
  }
  if (!ruleForm.provider) {
    Message.warning('请先选择 DNS 提供商')
    return
  }
  const fields = currentFields.value
  if (!fields.length) {
    Message.error('没有获取到当前提供商的字段元数据，无法测试')
    return
  }
  const missing = fields
    .filter((field) => field.required && isMasked(creds[field.key]))
    .map((field) => field.label)
  if (missing.length) {
    Message.warning(`测试需要重新填写凭据：${missing.join('、')}。已保存的凭据以掩码回显，无法直接用于测试。`)
    return
  }
  const payloadCreds = {}
  for (const field of fields) {
    const value = creds[field.key] == null ? '' : String(creds[field.key])
    if (value && !value.includes('********')) payloadCreds[field.key] = value
  }
  const sub = splitLines(ruleForm.subDomainsText)[0] || '@'
  const recordType = ruleForm.recordType === 'AAAA' ? 'AAAA' : 'A'
  const fqdn = sub === '@' ? ruleForm.domain.trim() : `${sub}.${ruleForm.domain.trim()}`
  Modal.confirm({
    title: '测试提供商连通性',
    content: `会使用当前表单中的凭据，向「${providerTitle(ruleForm.provider)}」真实写入一条 ${fqdn} 的 ${recordType} 测试记录（值为 192.0.2.1），随后立即删除。确定继续？`,
    okText: '开始测试',
    cancelText: '取消',
    onOk: async () => {
      testing.value = true
      try {
        const result = await api.post('/api/v1/ddns/providers/test', {
          provider: ruleForm.provider,
          creds: payloadCreds,
          domain: ruleForm.domain.trim(),
          sub,
          type: recordType,
        })
        Message.success(`连通正常：${result?.record || result?.provider || providerTitle(ruleForm.provider)}`)
      } catch (err) {
        Message.error(`测试失败：${errorText(err)}`)
      } finally {
        testing.value = false
      }
    },
  })
}

async function toggleRule(rule, value) {
  const next = typeof value === 'boolean' ? value : !rule.enable
  busyId.value = String(rule.id || '')
  try {
    await api.post(`/api/v1/ddns/rules/${encodeURIComponent(rule.id)}/toggle`, { enable: next })
    Message.success(next ? '规则已启用' : '规则已停用')
    await Promise.all([loadRules(), loadStatus()])
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

async function runRule(rule) {
  if (!rule.enable) {
    Message.warning('该规则未启用，请先启用后再执行')
    return
  }
  busyId.value = String(rule.id || '')
  try {
    const result = await api.post(`/api/v1/ddns/rules/${encodeURIComponent(rule.id)}/run`)
    const ip = [result?.ipv4, result?.ipv6].filter(Boolean).join(' / ')
    if (result?.ok === false) {
      Message.error(`执行失败：${result.message || '未知错误'}`)
    } else {
      Message.success(ip ? `执行成功：当前 IP ${ip}` : (result?.message || '执行完成'))
    }
    await Promise.all([loadRules(), loadStatus()])
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

function confirmDelete(rule) {
  Modal.confirm({
    title: '删除 DDNS 规则',
    content: `确定删除「${rule.name || rule.id}」吗？删除后不再自动更新该域名。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del(`/api/v1/ddns/rules/${encodeURIComponent(rule.id)}`)
        Message.success('规则已删除')
        await Promise.all([loadRules(), loadStatus()])
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

function openStatusLog(row) {
  logModalTitle.value = `运行日志 · ${row?.name || row?.id || ''}`
  logModalError.value = row?.lastError || ''
  const records = Array.isArray(row?.records) ? [...row.records].reverse() : []
  logRecords.value = records.map((item, index) => ({ ...item, key: `${item.time || ''}-${index}` }))
  logModalVisible.value = true
}

function openRuleLogs(rule) {
  const state = statusOf(rule) || { id: rule.id, name: rule.name || rule.id, records: [] }
  openStatusLog(state)
}


onMounted(() => {
  loadProviders()
  loadRules()
  loadStatus()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>动态域名</h2>
        <div class="sub">把域名持续指向当前公网 IP：提供商凭据、探测方式、调度与运行状态</div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading || providersLoading || statusLoading" @click="refreshAll">刷新</a-button>
      <a-button type="primary" :disabled="!providers.length" @click="openCreate">新建规则</a-button>
    </div>

    <div class="stack">
      <a-alert
        v-if="providersError"
        type="error"
        :content="`无法读取 DNS 提供商列表：${errorText(providersError)}`"
        style="margin-bottom: 0"
      >
        <template #action>
          <a-button size="mini" @click="loadProviders">重试</a-button>
        </template>
      </a-alert>

      <a-card :bordered="false">
        <template #title>DDNS 规则</template>
        <template #extra>
          <span class="muted">共 {{ rules.length }} 条，当前显示 {{ filteredRules.length }} 条</span>
        </template>

        <div class="toolbar">
          <a-input
            :model-value="keyword"
            size="small"
            style="width: 280px"
            placeholder="搜索名称 / 域名 / 提供商 / 子域名"
            allow-clear
            @input="onSearchInput"
          />
        </div>

        <div v-if="loadError" class="error-row">
          <a-alert type="error" :content="`加载 DDNS 规则失败：${errorText(loadError)}`" style="flex: 1" />
          <a-button size="small" @click="loadRules">重试</a-button>
        </div>

        <a-table
          :data="filteredRules"
          :columns="ruleColumns"
          row-key="id"
          :loading="loading"
          :pagination="false"
          :scroll="{ x: 1480 }"
          size="small"
        >
          <template #name="{ record }">
            <div class="rule-name">{{ record.name || record.id }}</div>
            <div v-if="record.remark" class="rule-remark">{{ record.remark }}</div>
          </template>
          <template #domain="{ record }">
            <div class="mono">{{ record.domain || '-' }}</div>
            <div v-if="(record.subDomains || []).length" class="chips">
              <a-tag v-for="sub in record.subDomains" :key="sub" size="small">{{ sub }}</a-tag>
            </div>
          </template>
          <template #provider="{ record }">
            <a-tag color="arcoblue" size="small">{{ providerTitle(record.provider) }}</a-tag>
          </template>
          <template #recordType="{ record }">
            <a-tag color="gray" size="small">{{ record.recordType || 'A' }}</a-tag>
          </template>
          <template #probe="{ record }">
            <div class="num-sub">IPv4：{{ ipModeLabel(record.ipv4) }}</div>
            <div class="num-sub">IPv6：{{ ipModeLabel(record.ipv6) }}</div>
          </template>
          <template #schedule="{ record }">
            <span class="mono schedule">{{ scheduleLabel(record) }}</span>
          </template>
          <template #ip="{ record }">
            <div v-for="ip in currentIPs(record)" :key="ip" class="mono ip-line">{{ ip }}</div>
            <span v-if="!currentIPs(record).length" class="muted">-</span>
          </template>
          <template #status="{ record }">
            <span class="switch-cell">
              <a-switch
                :model-value="!!record.enable"
                size="small"
                :loading="busyId === String(record.id || '')"
                @change="(value) => toggleRule(record, value)"
              />
              <span class="muted">{{ record.enable ? '启用' : '停用' }}</span>
            </span>
          </template>
          <template #actions="{ record }">
            <a-space :size="4">
              <a-button size="mini" :loading="busyId === String(record.id || '')" @click="runRule(record)">执行</a-button>
              <a-button size="mini" @click="openRuleLogs(record)">日志</a-button>
              <a-button size="mini" @click="openEdit(record)">编辑</a-button>
              <a-button size="mini" status="danger" @click="confirmDelete(record)">删除</a-button>
            </a-space>
          </template>
          <template #empty>
            <a-empty :description="rules.length ? '没有符合筛选条件的规则' : '还没有 DDNS 规则'" />
          </template>
        </a-table>
      </a-card>

      <a-card :bordered="false">
        <template #title>运行状态</template>
        <template #extra>
          <a-space :size="8">
            <span class="muted">来自 /api/v1/ddns/status</span>
            <a-button size="small" :loading="statusLoading" @click="loadStatus">刷新状态</a-button>
          </a-space>
        </template>

        <div v-if="statusError" class="error-row">
          <a-alert type="error" :content="`加载运行状态失败：${errorText(statusError)}`" style="flex: 1" />
          <a-button size="small" @click="loadStatus">重试</a-button>
        </div>

        <a-table
          :data="statusList"
          :columns="statusColumns"
          row-key="id"
          :loading="statusLoading"
          :pagination="false"
          :scroll="{ x: 1280 }"
          size="small"
        >
          <template #counts="{ record }">
            <a-space :size="4">
              <a-tag color="green" size="small">成功 {{ record.success || 0 }}</a-tag>
              <a-tag :color="record.failures ? 'red' : 'gray'" size="small">失败 {{ record.failures || 0 }}</a-tag>
            </a-space>
          </template>
          <template #message="{ record }">
            <span class="result-text" :title="lastMessage(record)">{{ lastMessage(record) }}</span>
          </template>
          <template #actions="{ record }">
            <a-button size="mini" @click="openStatusLog(record)">日志</a-button>
          </template>
          <template #empty>
            <a-empty description="暂无运行状态，规则执行一次后这里会出现当前 IP、时间与结果" />
          </template>
        </a-table>
      </a-card>
    </div>

    <a-modal
      v-model:visible="ruleModalVisible"
      :title="editingId ? '编辑 DDNS 规则' : '新建 DDNS 规则'"
      :width="780"
      :mask-closable="false"
      ok-text="保存"
      cancel-text="取消"
      :on-before-ok="submitRule"
    >
      <a-form ref="ruleFormRef" :model="ruleForm" :rules="formRules" layout="vertical">
        <div class="group-head">
          <span>基本信息</span>
        </div>
        <div class="form-grid">
          <a-form-item field="name" label="名称">
            <a-input v-model="ruleForm.name" placeholder="例如：家里宽带" allow-clear />
          </a-form-item>
          <a-form-item field="enable" label="启用">
            <a-switch v-model="ruleForm.enable" />
          </a-form-item>
          <a-form-item field="provider" label="DNS 提供商" class="full">
            <a-select
              v-model="ruleForm.provider"
              :loading="providersLoading"
              placeholder="选择 DNS 提供商"
              @change="onProviderChange"
            >
              <a-option v-for="item in providerOptions" :key="item.value" :value="item.value">
                {{ item.label }}
              </a-option>
            </a-select>
            <template #extra>
              <span v-if="providersError">无法读取提供商元数据，请点上方重试。</span>
              <span v-else-if="currentProvider?.authNote">{{ currentProvider.authNote }}</span>
              <span v-else>提供商和凭据字段由 /api/v1/ddns/providers 动态提供。</span>
            </template>
          </a-form-item>
        </div>

        <div class="group-head">
          <span>提供商凭据</span>
          <a-button size="mini" type="outline" :loading="testing" :disabled="!ruleForm.provider" @click="testProvider">
            测试连通性
          </a-button>
        </div>
        <a-alert
          v-if="providersError"
          type="error"
          :content="`无法读取提供商字段：${errorText(providersError)}`"
          style="margin-bottom: 12px"
        />
        <a-alert
          v-else
          type="info"
          content="已保存的凭据以 ******** 回显，保持掩码表示不修改；测试连通性需要重新填写凭据。"
          style="margin-bottom: 12px"
        />
        <div v-if="currentFields.length" class="form-grid">
          <a-form-item
            v-for="field in currentFields"
            :key="field.key"
            :field="`creds.${field.key}`"
            :label="field.required ? `${field.label} *` : field.label"
            :rules="credRules(field)"
            :class="{ full: field.key === 'body' || field.key === 'headers' || field.key === 'url' }"
          >
            <a-input-password
              v-if="field.secret"
              v-model="creds[field.key]"
              :placeholder="field.placeholder || '已保存的凭据不会回显'"
              autocomplete="new-password"
            />
            <a-textarea
              v-else-if="field.key === 'body' || field.key === 'headers'"
              v-model="creds[field.key]"
              :placeholder="field.placeholder || ''"
              :auto-size="{ minRows: 2, maxRows: 5 }"
            />
            <a-input v-else v-model="creds[field.key]" :placeholder="field.placeholder || ''" />
            <template v-if="field.help" #extra>{{ field.help }}</template>
          </a-form-item>
        </div>
        <a-alert
          v-else
          type="warning"
          content="没有获取到该提供商的字段说明；保存时会保留已保存的凭据不变。"
          style="margin-bottom: 12px"
        />

        <div class="group-head">
          <span>解析记录</span>
        </div>
        <div class="form-grid">
          <a-form-item field="domain" label="主域名" class="full">
            <a-input v-model="ruleForm.domain" placeholder="example.com" allow-clear />
            <template #extra>填写根域名；子域名在下一项单独维护。</template>
          </a-form-item>
          <a-form-item field="subDomainsText" label="子域名" class="full">
            <a-textarea
              v-model="ruleForm.subDomainsText"
              placeholder="每行一个：&#10;@&#10;www&#10;*"
              :auto-size="{ minRows: 3, maxRows: 8 }"
            />
            <template #extra>每行一个；@ 表示主域名，* 表示泛解析；留空等同于 @。</template>
          </a-form-item>
          <a-form-item field="recordType" label="记录类型">
            <a-select v-model="ruleForm.recordType">
              <a-option v-for="item in RECORD_TYPE_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </a-option>
            </a-select>
            <template #extra>实际写入的 A / AAAA 记录由下方 IPv4 / IPv6 探测开关决定。</template>
          </a-form-item>
          <a-form-item field="ttl" label="TTL（秒）">
            <a-input-number v-model="ruleForm.ttl" :min="0" :max="86400" :precision="0" style="width: 100%" />
            <template #extra>0 表示由后端补默认值（600）。</template>
          </a-form-item>
          <a-form-item field="intervalSec" label="检查间隔（秒）">
            <a-input-number v-model="ruleForm.intervalSec" :min="0" :max="604800" :precision="0" style="width: 100%" />
            <template #extra>cron 为空时按此间隔执行，默认 300 秒。</template>
          </a-form-item>
          <a-form-item field="cron" label="Cron 表达式">
            <a-input v-model="ruleForm.cron" placeholder="*/5 * * * *" allow-clear />
            <template #extra>非空时优先于检查间隔。</template>
          </a-form-item>
          <a-form-item field="remark" label="备注" class="full">
            <a-input v-model="ruleForm.remark" placeholder="备注（可选）" allow-clear />
          </a-form-item>
        </div>

        <div class="group-head">
          <span>公网 IP 探测</span>
          <span class="muted">至少启用一个地址族</span>
        </div>

        <div class="ip-block">
          <div class="ip-head">
            <a-switch v-model="ruleForm.ipv4.enable" size="small" />
            <strong>IPv4（A 记录）</strong>
          </div>
          <div v-if="ruleForm.ipv4.enable" class="form-grid">
            <a-form-item label="探测方式">
              <a-radio-group v-model="ruleForm.ipv4.mode" type="button" size="small">
                <a-radio v-for="item in IP_MODE_OPTIONS" :key="item.value" :value="item.value">
                  {{ item.label }}
                </a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item v-if="ruleForm.ipv4.mode === 'interface'" label="网卡名称">
              <a-input v-model="ruleForm.ipv4.iface" placeholder="留空自动选择默认网卡" allow-clear />
            </a-form-item>
            <a-form-item v-else-if="ruleForm.ipv4.mode === 'url'" label="获取地址">
              <a-input v-model="ruleForm.ipv4.value" placeholder="https://api.ipify.org" allow-clear />
              <template #extra>返回纯文本 IP 的接口；留空时使用内置公共探测服务。</template>
            </a-form-item>
            <a-form-item v-else label="静态地址">
              <a-input v-model="ruleForm.ipv4.value" placeholder="1.2.3.4" allow-clear />
            </a-form-item>
            <a-form-item v-if="ruleForm.ipv4.mode === 'url'" label="提取正则">
              <a-input v-model="ruleForm.ipv4.regex" placeholder="可选：从响应中提取 IP 的正则" allow-clear />
            </a-form-item>
          </div>
        </div>

        <div class="ip-block">
          <div class="ip-head">
            <a-switch v-model="ruleForm.ipv6.enable" size="small" />
            <strong>IPv6（AAAA 记录）</strong>
          </div>
          <div v-if="ruleForm.ipv6.enable" class="form-grid">
            <a-form-item label="探测方式">
              <a-radio-group v-model="ruleForm.ipv6.mode" type="button" size="small">
                <a-radio v-for="item in IP_MODE_OPTIONS" :key="item.value" :value="item.value">
                  {{ item.label }}
                </a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item v-if="ruleForm.ipv6.mode === 'interface'" label="网卡名称">
              <a-input v-model="ruleForm.ipv6.iface" placeholder="留空自动选择默认网卡" allow-clear />
            </a-form-item>
            <a-form-item v-else-if="ruleForm.ipv6.mode === 'url'" label="获取地址">
              <a-input v-model="ruleForm.ipv6.value" placeholder="https://api64.ipify.org" allow-clear />
              <template #extra>返回纯文本 IPv6 的接口；留空时使用内置公共探测服务。</template>
            </a-form-item>
            <a-form-item v-else label="静态地址">
              <a-input v-model="ruleForm.ipv6.value" placeholder="2001:db8::1" allow-clear />
            </a-form-item>
            <a-form-item v-if="ruleForm.ipv6.mode === 'url'" label="提取正则">
              <a-input v-model="ruleForm.ipv6.regex" placeholder="可选：从响应中提取 IP 的正则" allow-clear />
            </a-form-item>
          </div>
        </div>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="logModalVisible"
      :title="logModalTitle"
      :width="720"
      :footer="false"
      :mask-closable="true"
    >
      <a-alert v-if="logModalError" type="error" :content="`最近错误：${logModalError}`" style="margin-bottom: 12px" />
      <a-table
        :data="logRecords"
        :columns="logColumns"
        row-key="key"
        :pagination="false"
        size="small"
      >
        <template #ok="{ record }">
          <a-tag :color="record.ok ? 'green' : 'red'" size="small">{{ record.ok ? '成功' : '失败' }}</a-tag>
        </template>
        <template #message="{ record }">
          <span class="log-message">{{ record.message || '-' }}</span>
        </template>
        <template #empty>
          <a-empty description="暂无执行记录" />
        </template>
      </a-table>
    </a-modal>
  </div>
</template>

<style scoped>
.error-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.rule-name {
  font-weight: 600;
  word-break: break-word;
}

.rule-remark {
  color: var(--color-text-3);
  font-size: 12px;
  word-break: break-word;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.num-sub {
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.5;
}

.schedule {
  font-size: 12px;
  word-break: break-all;
}

.ip-line {
  font-size: 12px;
  word-break: break-all;
}

.switch-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.result-text {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 18px 0 10px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-2);
  font-size: 13px;
  font-weight: 600;
}

.group-head:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 16px;
}

.form-grid .full {
  grid-column: 1 / -1;
}

.ip-block {
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border-2);
  border-radius: 6px;
  background: var(--color-fill-1);
}

.ip-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.ip-head strong {
  font-size: 13px;
}

.log-message {
  word-break: break-word;
  overflow-wrap: anywhere;
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
