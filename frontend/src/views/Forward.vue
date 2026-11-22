<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import { PROVINCE_OPTIONS } from '../provinces'

const PROTOCOL_OPTIONS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'both', label: 'TCP + UDP' },
]
const PROTOCOL_LABEL = { tcp: 'TCP', udp: 'UDP', both: 'TCP + UDP' }
const ACCESS_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许列表中的 IP）' },
  { value: 'deny', label: '黑名单（拒绝列表中的 IP）' },
]
const ACCESS_LABEL = { off: '关闭', allow: '白名单', deny: '黑名单' }
const LOG_LIMIT_OPTIONS = [100, 200, 500]

const rules = ref([])
const loading = ref(false)
const loadError = ref(null)
const busyId = ref('')
const protoFilter = ref('all')
const keyword = ref('')

const logs = ref([])
const logsLoading = ref(false)
const logsError = ref(null)
const logsEnabled = ref(true)
const logRule = ref('')
const logLimit = ref(200)
const autoRefresh = ref(false)
let logTimer = null
let logSeq = 0

const ruleModalVisible = ref(false)
const ruleFormRef = ref(null)
const editingId = ref('')
const originalAccess = ref({ uaMode: 'off', uas: [] })
const ruleForm = reactive({
  name: '',
  enable: true,
  protocol: 'tcp',
  srcAddr: '',
  dstAddr: '',
  timeoutSec: 0,
  maxConns: 0,
  maxConnsPerIP: 0,
  accessMode: 'off',
  accessIps: '',
  accessCountries: [],
  accessProvinces: [],
  remark: '',
})

const ruleRules = {
  name: [{ required: true, message: '请填写规则名称' }],
  protocol: [{ required: true, message: '请选择协议' }],
  srcAddr: [
    { required: true, message: '请填写源地址' },
    {
      validator: (value, callback) => {
        const text = String(value || '').trim()
        if (text && !text.includes(':')) callback('源地址必须包含端口，例如 :3389')
        else callback()
      },
    },
  ],
  dstAddr: [
    { required: true, message: '请填写目标地址' },
    {
      validator: (value, callback) => {
        const text = String(value || '').trim()
        if (text && !text.includes(':')) callback('目标地址必须包含端口，例如 192.168.1.10:3389')
        else callback()
      },
    },
  ],
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

const summary = computed(() => {
  const out = {
    active: 0,
    total: 0,
    up: 0,
    down: 0,
    rejectedRule: 0,
    rejectedIp: 0,
    enabled: 0,
    listening: 0,
  }
  for (const rule of rules.value) {
    out.active += num(rule.activeConns)
    out.total += num(rule.totalConns)
    out.up += num(rule.upBytes)
    out.down += num(rule.downBytes)
    out.rejectedRule += num(rule.rejectedRuleLimit)
    out.rejectedIp += num(rule.rejectedIpLimit)
    if (rule.enable) out.enabled += 1
    if (rule.listening) out.listening += 1
  }
  out.rejected = out.rejectedRule + out.rejectedIp
  return out
})

const filteredRules = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return rules.value.filter((rule) => {
    if (protoFilter.value !== 'all' && rule.protocol !== protoFilter.value) return false
    if (!q) return true
    return [rule.name, rule.srcAddr, rule.dstAddr, rule.remark]
      .join(' ')
      .toLowerCase()
      .includes(q)
  })
})

const ruleColumns = [
  { title: '名称', dataIndex: 'name', width: 170, slotName: 'name' },
  { title: '协议', dataIndex: 'protocol', width: 100, slotName: 'protocol' },
  { title: '源地址', dataIndex: 'srcAddr', width: 190, slotName: 'srcAddr' },
  { title: '目标地址', dataIndex: 'dstAddr', width: 190, slotName: 'dstAddr' },
  { title: '访问控制', width: 150, slotName: 'access' },
  { title: '并发上限', width: 150, slotName: 'limits' },
  { title: '超时', width: 110, slotName: 'timeout' },
  { title: '连接（活跃 / 累计）', width: 150, slotName: 'connections' },
  { title: '流量（上行 / 下行）', width: 190, slotName: 'traffic' },
  { title: '限流拒绝', width: 125, slotName: 'rejected' },
  { title: '状态', width: 115, slotName: 'status' },
  { title: '操作', width: 210, slotName: 'actions', fixed: 'right' },
]

const logColumns = [
  { title: '时间', dataIndex: 'time', width: 170, render: ({ record }) => fmtTime(record.time) },
  { title: '规则', dataIndex: 'rule', width: 160, render: ({ record }) => record.rule || record.ruleId || '-' },
  { title: '协议', dataIndex: 'protocol', width: 85, render: ({ record }) => String(record.protocol || '-').toUpperCase() },
  { title: '来源', dataIndex: 'client', width: 180, render: ({ record }) => record.client || '-' },
  { title: '目标', dataIndex: 'target', width: 180, render: ({ record }) => record.target || '-' },
  { title: '结果', dataIndex: 'result', width: 210, slotName: 'result' },
  { title: '持续', dataIndex: 'duration', width: 105, render: ({ record }) => fmtDurationNs(record.duration) },
  { title: '上行 / 下行', width: 190, slotName: 'bytes' },
  { title: '数据包', dataIndex: 'packets', width: 90, render: ({ record }) => (record.packets ? String(record.packets) : '-') },
]

const logPagination = { pageSize: 20, showTotal: true, showJumper: true, size: 'small' }

function accessMode(rule) {
  return rule?.access?.mode || 'off'
}

function accessIps(rule) {
  return Array.isArray(rule?.access?.ips) ? rule.access.ips : []
}

function accessLabel(rule) {
  const mode = accessMode(rule)
  if (mode === 'off') return '关闭'
  return `${ACCESS_LABEL[mode] || mode} · ${accessIps(rule).length} 条`
}

function accessColor(rule) {
  const mode = accessMode(rule)
  if (mode === 'allow') return 'green'
  if (mode === 'deny') return 'red'
  return 'gray'
}

function accessTip(rule) {
  const ips = accessIps(rule)
  if (!ips.length) return '没有配置 IP 列表'
  const head = ips.slice(0, 8).join(', ')
  return ips.length > 8 ? `${head} 等 ${ips.length} 条` : head
}

function protoColor(protocol) {
  if (protocol === 'udp') return 'purple'
  if (protocol === 'both') return 'cyan'
  return 'arcoblue'
}

function fmtLimit(value) {
  const n = num(value)
  return n > 0 ? String(n) : '不限'
}

function fmtTimeout(value) {
  const n = num(value)
  return n > 0 ? `${n} 秒` : '默认 300 秒'
}

function fmtDurationNs(value) {
  const ns = Number(value)
  if (!Number.isFinite(ns) || ns <= 0) return '-'
  const ms = ns / 1e6
  if (ms < 1) return `${Math.max(1, Math.round(ns / 1e3))} µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`
  const min = Math.floor(sec / 60)
  const rest = Math.round(sec % 60)
  if (min < 60) return `${min} 分 ${rest} 秒`
  const hour = Math.floor(min / 60)
  return `${hour} 小时 ${min % 60} 分`
}

function resultColor(result) {
  const text = String(result || '')
  if (text === 'closed') return 'green'
  if (text.startsWith('rejected')) return 'orange'
  if (text.startsWith('denied') || text.startsWith('failed')) return 'red'
  return 'gray'
}

function onSearchInput(value) {
  keyword.value = String(value || '')
}

async function loadRules() {
  loading.value = true
  try {
    const data = await api.get('/api/v1/forward/rules')
    rules.value = Array.isArray(data) ? data : (data?.rules || data?.items || [])
    loadError.value = null
  } catch (err) {
    loadError.value = err
    Message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function loadLogs() {
  const seq = ++logSeq
  logsLoading.value = true
  try {
    const data = await api.get('/api/v1/forward/logs', {
      rule: logRule.value || undefined,
      limit: logLimit.value,
    })
    if (seq !== logSeq) return
    const items = Array.isArray(data) ? data : (data?.items || data?.logs || [])
    logs.value = items.map((item, index) => ({ ...item, key: item.key || `${item.time || ''}-${index}` }))
    logsEnabled.value = data?.enabled !== false
    logsError.value = null
  } catch (err) {
    if (seq !== logSeq) return
    logsError.value = err
    Message.error(errorText(err))
  } finally {
    if (seq === logSeq) logsLoading.value = false
  }
}

async function refreshAll() {
  await Promise.all([loadRules(), loadLogs()])
}

function openCreate() {
  editingId.value = ''
  originalAccess.value = { uaMode: 'off', uas: [] }
  Object.assign(ruleForm, {
    name: '',
    enable: true,
    protocol: 'tcp',
    srcAddr: '',
    dstAddr: '',
    timeoutSec: 0,
    maxConns: 0,
    maxConnsPerIP: 0,
    accessMode: 'off',
    accessIps: '',
    remark: '',
  })
  ruleModalVisible.value = true
  nextTick(() => ruleFormRef.value?.clearValidate())
}

function openEdit(rule) {
  const access = rule.access || {}
  editingId.value = String(rule.id || '')
  originalAccess.value = {
    uaMode: access.uaMode || 'off',
    uas: Array.isArray(access.uas) ? access.uas : [],
  }
  Object.assign(ruleForm, {
    name: rule.name || '',
    enable: rule.enable !== false,
    protocol: rule.protocol || 'tcp',
    srcAddr: rule.srcAddr || '',
    dstAddr: rule.dstAddr || '',
    timeoutSec: num(rule.timeoutSec),
    maxConns: num(rule.maxConns),
    maxConnsPerIP: num(rule.maxConnsPerIP),
    accessMode: access.mode || 'off',
    accessIps: (Array.isArray(access.ips) ? access.ips : []).join('\n'),
    accessCountries: Array.isArray(access.countries) ? [...access.countries] : [],
    accessProvinces: Array.isArray(access.provinces) ? [...access.provinces] : [],
    remark: rule.remark || '',
  })
  ruleModalVisible.value = true
  nextTick(() => ruleFormRef.value?.clearValidate())
}

async function submitRule() {
  if (ruleFormRef.value) {
    const errors = await ruleFormRef.value.validate()
    if (errors) return false
  }
  const payload = {
    name: ruleForm.name.trim(),
    enable: !!ruleForm.enable,
    protocol: ruleForm.protocol || 'tcp',
    srcAddr: ruleForm.srcAddr.trim(),
    dstAddr: ruleForm.dstAddr.trim(),
    timeoutSec: num(ruleForm.timeoutSec),
    maxConns: num(ruleForm.maxConns),
    maxConnsPerIP: num(ruleForm.maxConnsPerIP),
    access: {
      mode: ruleForm.accessMode || 'off',
      ips: splitLines(ruleForm.accessIps),
      countries: [...(ruleForm.accessCountries || [])],
      provinces: [...(ruleForm.accessProvinces || [])],
      uaMode: originalAccess.value.uaMode || 'off',
      uas: originalAccess.value.uas || [],
    },
    remark: ruleForm.remark.trim(),
  }
  try {
    if (editingId.value) {
      await api.put(`/api/v1/forward/rules/${encodeURIComponent(editingId.value)}`, payload)
    } else {
      await api.post('/api/v1/forward/rules', payload)
    }
    Message.success(editingId.value ? '规则已保存' : '规则已创建')
    await Promise.all([loadRules(), loadLogs()])
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  }
}

async function toggleRule(rule, value) {
  const next = typeof value === 'boolean' ? value : !rule.enable
  busyId.value = String(rule.id || '')
  try {
    await api.post(`/api/v1/forward/rules/${encodeURIComponent(rule.id)}/toggle`, { enable: next })
    Message.success(next ? '规则已启用' : '规则已停用')
    await loadRules()
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

function confirmDelete(rule) {
  Modal.confirm({
    title: '删除转发规则',
    content: `确定删除「${rule.name || rule.id}」吗？该端口上的转发会立即停止。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del(`/api/v1/forward/rules/${encodeURIComponent(rule.id)}`)
        Message.success('规则已删除')
        if (logRule.value === rule.id) logRule.value = ''
        await Promise.all([loadRules(), loadLogs()])
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

function openLogsFor(rule) {
  logRule.value = rule.id || ''
  loadLogs()
  if (typeof document !== 'undefined') {
    document.getElementById('forward-logs-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

watch(autoRefresh, (enabled) => {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
  if (enabled) logTimer = setInterval(loadLogs, 5000)
})

onMounted(() => {
  loadRules()
  loadLogs()
})

onUnmounted(() => {
  if (logTimer) clearInterval(logTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>端口转发</h2>
        <div class="sub">TCP / UDP 端口映射、访问控制、并发限制与实时运行统计</div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading || logsLoading" @click="refreshAll">刷新</a-button>
      <a-button type="primary" @click="openCreate">新建规则</a-button>
    </div>

    <div class="stack">
      <a-card :bordered="false">
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">转发规则</div>
            <div class="stat-value">{{ rules.length }}</div>
            <div class="stat-note">启用 {{ summary.enabled }} · 正在监听 {{ summary.listening }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">活跃连接</div>
            <div class="stat-value">{{ summary.active }}</div>
            <div class="stat-note">当前正在转发的连接数</div>
          </div>
          <div class="stat">
            <div class="stat-label">累计连接</div>
            <div class="stat-value">{{ summary.total }}</div>
            <div class="stat-note">进程启动以来接受的连接</div>
          </div>
          <div class="stat">
            <div class="stat-label">上行流量</div>
            <div class="stat-value">{{ fmtBytes(summary.up) }}</div>
            <div class="stat-note">客户端 → 目标</div>
          </div>
          <div class="stat">
            <div class="stat-label">下行流量</div>
            <div class="stat-value">{{ fmtBytes(summary.down) }}</div>
            <div class="stat-note">目标 → 客户端</div>
          </div>
          <div class="stat">
            <div class="stat-label">被限流拒绝</div>
            <div class="stat-value">{{ summary.rejected }}</div>
            <div class="stat-note">规则上限 {{ summary.rejectedRule }} · 单 IP {{ summary.rejectedIp }}</div>
          </div>
        </div>
      </a-card>

      <a-card :bordered="false">
        <template #title>转发规则</template>
        <template #extra>
          <span class="muted">共 {{ rules.length }} 条，当前显示 {{ filteredRules.length }} 条</span>
        </template>

        <div class="toolbar">
          <a-select v-model="protoFilter" size="small" style="width: 170px">
            <a-option value="all">全部协议</a-option>
            <a-option v-for="item in PROTOCOL_OPTIONS" :key="item.value" :value="item.value">
              {{ item.label }}
            </a-option>
          </a-select>
          <a-input
            :model-value="keyword"
            size="small"
            style="width: 260px"
            placeholder="搜索名称 / 源地址 / 目标地址"
            allow-clear
            @input="onSearchInput"
          />
        </div>

        <div v-if="loadError" class="error-row">
          <a-alert type="error" :content="`加载转发规则失败：${errorText(loadError)}`" style="flex: 1" />
          <a-button size="small" @click="loadRules">重试</a-button>
        </div>

        <a-table
          :data="filteredRules"
          :columns="ruleColumns"
          row-key="id"
          :loading="loading"
          :pagination="false"
          :scroll="{ x: 1780 }"
          size="small"
        >
          <template #name="{ record }">
            <div class="rule-name">{{ record.name || record.id }}</div>
            <div v-if="record.remark" class="rule-remark">{{ record.remark }}</div>
          </template>
          <template #protocol="{ record }">
            <a-tag :color="protoColor(record.protocol)" size="small">
              {{ PROTOCOL_LABEL[record.protocol] || record.protocol || '-' }}
            </a-tag>
          </template>
          <template #srcAddr="{ record }">
            <span class="mono addr">{{ record.srcAddr || '-' }}</span>
          </template>
          <template #dstAddr="{ record }">
            <span class="mono addr">{{ record.dstAddr || '-' }}</span>
          </template>
          <template #access="{ record }">
            <a-tooltip :content="accessTip(record)">
              <a-tag :color="accessColor(record)" size="small">{{ accessLabel(record) }}</a-tag>
            </a-tooltip>
          </template>
          <template #limits="{ record }">
            <div class="num">总 {{ fmtLimit(record.connLimit) }}</div>
            <div class="num-sub">单 IP {{ fmtLimit(record.connLimitPerIp) }}</div>
          </template>
          <template #timeout="{ record }">
            <span class="num">{{ fmtTimeout(record.timeoutSec) }}</span>
          </template>
          <template #connections="{ record }">
            <span class="num">{{ num(record.activeConns) }} / {{ num(record.totalConns) }}</span>
          </template>
          <template #traffic="{ record }">
            <div class="num">↑ {{ fmtBytes(record.upBytes) }}</div>
            <div class="num-sub">↓ {{ fmtBytes(record.downBytes) }}</div>
          </template>
          <template #rejected="{ record }">
            <a-tooltip :content="`规则上限拒绝 ${num(record.rejectedRuleLimit)} 次，单 IP 上限拒绝 ${num(record.rejectedIpLimit)} 次`">
              <span class="num">{{ num(record.rejectedRuleLimit) + num(record.rejectedIpLimit) }}</span>
            </a-tooltip>
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
              <a-button size="mini" @click="openLogsFor(record)">日志</a-button>
              <a-button size="mini" @click="openEdit(record)">编辑</a-button>
              <a-button size="mini" status="danger" @click="confirmDelete(record)">删除</a-button>
            </a-space>
          </template>
          <template #empty>
            <a-empty :description="rules.length ? '没有符合筛选条件的规则' : '还没有端口转发规则'" />
          </template>
        </a-table>
      </a-card>

      <a-card id="forward-logs-card" :bordered="false">
        <template #title>访问日志</template>
        <template #extra>
          <a-space :size="10">
            <a-tag :color="logsEnabled ? 'green' : 'gray'" size="small">
              {{ logsEnabled ? '记录中' : '未启用' }}
            </a-tag>
            <span class="muted">自动刷新（5 秒）</span>
            <a-switch v-model="autoRefresh" size="small" />
            <a-button size="small" :loading="logsLoading" @click="loadLogs">刷新</a-button>
          </a-space>
        </template>

        <div class="toolbar">
          <a-select
            v-model="logRule"
            size="small"
            style="width: 220px"
            placeholder="全部规则"
            allow-clear
            @change="loadLogs"
          >
            <a-option v-for="rule in rules" :key="rule.id" :value="rule.id">
              {{ rule.name || rule.id }}
            </a-option>
          </a-select>
          <a-select v-model="logLimit" size="small" style="width: 140px" @change="loadLogs">
            <a-option v-for="limit in LOG_LIMIT_OPTIONS" :key="limit" :value="limit">
              最近 {{ limit }} 条
            </a-option>
          </a-select>
          <span class="muted">共 {{ logs.length }} 条</span>
        </div>

        <a-alert
          v-if="!logsEnabled"
          type="warning"
          content="访问日志当前未启用（后端 forward.accessLog 关闭），新的连接不会写入日志；下方显示的是已有记录。"
          style="margin-bottom: 12px"
        />
        <div v-if="logsError" class="error-row">
          <a-alert type="error" :content="`加载访问日志失败：${errorText(logsError)}`" style="flex: 1" />
          <a-button size="small" @click="loadLogs">重试</a-button>
        </div>

        <a-table
          :data="logs"
          :columns="logColumns"
          row-key="key"
          :loading="logsLoading"
          :pagination="logPagination"
          :scroll="{ x: 1420 }"
          size="small"
        >
          <template #result="{ record }">
            <a-tag :color="resultColor(record.result)" size="small" class="result-tag" :title="record.result">
              {{ record.result || '-' }}
            </a-tag>
          </template>
          <template #bytes="{ record }">
            <span class="num">↑ {{ fmtBytes(record.bytesIn) }} / ↓ {{ fmtBytes(record.bytesOut) }}</span>
          </template>
          <template #empty>
            <a-empty description="暂无访问日志" />
          </template>
        </a-table>
      </a-card>
    </div>

    <a-modal
      v-model:visible="ruleModalVisible"
      :title="editingId ? '编辑转发规则' : '新建转发规则'"
      :width="760"
      :mask-closable="false"
      ok-text="保存"
      cancel-text="取消"
      :on-before-ok="submitRule"
    >
      <a-form ref="ruleFormRef" :model="ruleForm" :rules="ruleRules" layout="vertical">
        <div class="form-grid">
          <a-form-item field="name" label="名称">
            <a-input v-model="ruleForm.name" placeholder="例如：远程桌面" allow-clear />
          </a-form-item>
          <a-form-item field="enable" label="启用">
            <a-switch v-model="ruleForm.enable" />
          </a-form-item>

          <a-form-item field="protocol" label="协议">
            <a-select v-model="ruleForm.protocol">
              <a-option v-for="item in PROTOCOL_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </a-option>
            </a-select>
          </a-form-item>
          <a-form-item field="timeoutSec" label="空闲超时（秒）">
            <a-input-number v-model="ruleForm.timeoutSec" :min="0" :max="86400" :precision="0" style="width: 100%" />
            <template #extra>0 表示使用默认 300 秒；这是空闲超时，不会因为连接总时长被断开。</template>
          </a-form-item>

          <a-form-item field="srcAddr" label="源地址">
            <a-input v-model="ruleForm.srcAddr" placeholder=":3389 或 0.0.0.0:3389" allow-clear />
            <template #extra>本机监听地址，可以省略 IP，只写端口。</template>
          </a-form-item>
          <a-form-item field="dstAddr" label="目标地址">
            <a-input v-model="ruleForm.dstAddr" placeholder="192.168.1.10:3389" allow-clear />
            <template #extra>流量要转发到的内网地址。</template>
          </a-form-item>

          <a-form-item field="maxConns" label="规则并发上限">
            <a-input-number v-model="ruleForm.maxConns" :min="0" :max="1000000" :precision="0" style="width: 100%" />
            <template #extra>0 表示由后端补默认上限（1024）。</template>
          </a-form-item>
          <a-form-item field="maxConnsPerIP" label="单 IP 并发上限">
            <a-input-number v-model="ruleForm.maxConnsPerIP" :min="0" :max="100000" :precision="0" style="width: 100%" />
            <template #extra>0 表示由后端补默认上限（64）。</template>
          </a-form-item>

          <a-form-item field="accessMode" label="IP 访问控制" class="full">
            <a-select v-model="ruleForm.accessMode">
              <a-option v-for="item in ACCESS_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </a-option>
            </a-select>
          </a-form-item>
          <a-form-item field="accessIps" label="IP 列表" class="full">
            <a-textarea
              v-model="ruleForm.accessIps"
              placeholder="每行一条，支持 CIDR：&#10;192.168.1.0/24&#10;10.0.0.5"
              :auto-size="{ minRows: 3, maxRows: 8 }"
            />
            <template #extra>白名单为空时会拒绝所有来源，黑名单为空时不会拒绝任何来源。</template>
          </a-form-item>

          <a-form-item field="accessCountries" label="国家/地区（ip2region）" class="full">
            <a-select
              v-model="ruleForm.accessCountries"
              mode="multiple"
              allow-create
              allow-clear
              placeholder="输入国家名后回车，例如 中国、美国"
            />
            <template #extra>与 IP 列表取并集；需把 IP 访问控制设为白名单/黑名单，并先在「设置 → IP 地址库」配置数据库。</template>
          </a-form-item>
          <a-form-item field="accessProvinces" label="省份（ip2region）" class="full">
            <a-select
              v-model="ruleForm.accessProvinces"
              mode="multiple"
              allow-create
              allow-clear
              :options="PROVINCE_OPTIONS"
              placeholder="例如 浙江、广东"
            />
            <template #extra>与 IP 列表取并集；私有地址不参与地理匹配。</template>
          </a-form-item>

          <a-form-item field="remark" label="备注" class="full">
            <a-input v-model="ruleForm.remark" placeholder="备注（可选）" allow-clear />
          </a-form-item>
        </div>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
  gap: 12px;
}

.stat {
  padding: 2px 0;
}

.stat-label {
  color: var(--color-text-3);
  font-size: 12px;
}

.stat-value {
  margin-top: 2px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}

.stat-note {
  margin-top: 2px;
  color: var(--color-text-3);
  font-size: 11px;
}

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

.addr {
  font-size: 12px;
}

.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.num-sub {
  color: var(--color-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.switch-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.result-tag {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 16px;
}

.form-grid .full {
  grid-column: 1 / -1;
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
