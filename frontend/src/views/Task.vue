<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtTime } from '../format'

const ACTION_LABEL = {
  'module.toggle': '模块开关',
  'rule.toggle': '规则开关',
  'http.request': 'HTTP 请求',
  'notify.webhook': '发送通知',
  'shell.exec': '执行 Shell',
}

const ACTION_OPTIONS = Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }))

const MODULE_ACTIONS = [
  { value: 'on', label: '启动' },
  { value: 'off', label: '停止' },
  { value: 'toggle', label: '切换' },
]

const RULE_ACTIONS = [
  { value: 'on', label: '启用规则' },
  { value: 'off', label: '停用规则' },
]

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => ({ value, label: value }))

const CRON_EXAMPLES = [
  { cron: '*/5 * * * *', label: '每 5 分钟' },
  { cron: '0 * * * *', label: '每小时' },
  { cron: '30 3 * * *', label: '每天 03:30' },
  { cron: '0 4 * * 0', label: '每周日 04:00' },
  { cron: '@daily', label: '每天' },
  { cron: '@every 30m', label: '每 30 分钟' },
]

const items = ref([])
const modules = ref([])
const allowShell = ref(false)
const loading = ref(true)
const saving = ref(false)
const allowShellSaving = ref(false)
const busyId = ref('')
const taskModal = ref(false)
const detailVisible = ref(false)
const editingId = ref('')
const detailTask = ref(null)

const taskForm = reactive({
  name: '',
  enable: true,
  cron: '0 3 * * *',
  remark: '',
  actions: [],
})

const refreshTimers = new Set()

const editing = computed(() => !!editingId.value)
const taskTitle = computed(() => (editing.value ? '编辑计划任务' : '新建计划任务'))
const moduleOptions = computed(() =>
  modules.value.map((item) => ({ value: item.name, label: item.title ? `${item.title}（${item.name}）` : item.name })),
)
const shellActionCount = computed(
  () => items.value.filter((item) => (item.actions || []).some((action) => action.type === 'shell.exec')).length,
)
const detailLogs = computed(() => {
  const logs = detailTask.value?.state?.logs
  return Array.isArray(logs) ? [...logs].reverse() : []
})
const detailActions = computed(() => {
  const logs = detailTask.value?.state?.logs
  if (!Array.isArray(logs) || !logs.length) return []
  return logs[logs.length - 1]?.actions || []
})

const taskColumns = [
  { title: '名称', dataIndex: 'name', slotName: 'name' },
  { title: 'Cron', dataIndex: 'cron', slotName: 'cron', width: 140 },
  { title: '动作', dataIndex: 'actions', slotName: 'actionTags', width: 180 },
  { title: '状态', dataIndex: 'enable', slotName: 'state', width: 140 },
  { title: '上次运行', dataIndex: 'lastRun', slotName: 'lastRun', width: 170 },
  { title: '最近结果', dataIndex: 'lastResult', slotName: 'result' },
  { title: '下次运行', dataIndex: 'nextRun', slotName: 'nextRun', width: 170 },
  { title: '操作', slotName: 'operations', width: 260 },
]

const detailLogColumns = [
  { title: '时间', slotName: 'time', width: 170 },
  { title: '结果', slotName: 'ok', width: 80 },
  { title: '耗时', dataIndex: 'durationMs', width: 90 },
  { title: '错误', slotName: 'error' },
  { title: '输出预览', slotName: 'preview' },
]

const detailActionColumns = [
  { title: '序号', dataIndex: 'index', width: 70 },
  { title: '动作', slotName: 'type', width: 130 },
  { title: '目标', dataIndex: 'target', width: 160, ellipsis: true, tooltip: true },
  { title: '结果', slotName: 'ok', width: 80 },
  { title: '耗时 (ms)', slotName: 'duration', width: 110 },
  { title: '输出', slotName: 'output' },
]

function blankAction(type = 'module.toggle') {
  return {
    type,
    target: '',
    value: defaultActionValue(type),
    method: 'GET',
    url: '',
    headersText: '',
    body: '',
    command: '',
  }
}

function defaultActionValue(type) {
  if (type === 'module.toggle') return 'on'
  if (type === 'rule.toggle') return 'on'
  return ''
}

function normalizeActionValue(type, value) {
  const raw = String(value || '').trim().toLowerCase()
  if (type === 'module.toggle') {
    // The backend accepts "restart" as an alias for a toggle; keep the select
    // showing a value the current option list really contains.
    if (raw === 'restart' || raw === 'switch' || raw === 'flip') return 'toggle'
    if (['on', 'off', 'toggle'].includes(raw)) return raw
    return 'on'
  }
  if (type === 'rule.toggle') {
    if (raw === 'on' || raw === 'off') return raw
    return 'on'
  }
  return value || ''
}

function headersToText(headers) {
  if (!headers || typeof headers !== 'object') return ''
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function headersFromText(text) {
  const out = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function fromStoredAction(action) {
  const type = action?.type || 'module.toggle'
  return {
    type,
    target: action?.target || '',
    value: normalizeActionValue(type, action?.value),
    method: String(action?.method || 'GET').toUpperCase(),
    url: action?.url || '',
    headersText: headersToText(action?.headers),
    body: action?.body || '',
    command: action?.command || '',
  }
}

function actionLabel(type) {
  return ACTION_LABEL[type] || type || '-'
}

function actionSummary(action) {
  if (!action) return '-'
  const label = actionLabel(action.type)
  if (action.target) return `${label} · ${action.target}`
  if (action.url) return `${label} · ${action.url}`
  if (action.command) return `${label} · ${action.command.slice(0, 24)}`
  return label
}

function taskState(record) {
  return record?.state || {}
}

function resultLabel(record) {
  const state = taskState(record)
  if (!state.lastRun) return '尚未运行'
  return state.lastResult || '已运行'
}

function resultTone(record) {
  const state = taskState(record)
  if (!state.lastRun) return 'gray'
  if (String(state.lastResult || '').toLowerCase().startsWith('failed')) return 'red'
  if (state.lastResult === 'success') return 'green'
  return 'gray'
}

function logTone(entry) {
  return entry?.ok ? 'green' : 'red'
}

// Go serialises ActionLog.Duration (time.Duration) as nanoseconds, while the
// run level LogEntry.Duration is already milliseconds.
function actionDurationMs(record) {
  const value = Number(record?.duration)
  return Number.isFinite(value) ? Math.round(value / 1e6) : 0
}

function isCronLike(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (text.startsWith('@')) {
    return /^@(daily|hourly|weekly|monthly|yearly|annually|midnight|every\s+\S+)$/.test(text)
  }
  return text.split(/\s+/).length === 5
}

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const [taskResult, moduleResult] = await Promise.allSettled([
      api.get('/api/v1/task/items'),
      api.get('/api/v1/modules'),
    ])
    if (taskResult.status === 'fulfilled') {
      items.value = Array.isArray(taskResult.value) ? taskResult.value : []
    } else if (!silent) {
      Message.error(`读取计划任务失败：${errorText(taskResult.reason)}`)
    }
    if (moduleResult.status === 'fulfilled') {
      modules.value = Array.isArray(moduleResult.value) ? moduleResult.value : []
      const taskModule = modules.value.find((item) => item.name === 'task')
      if (taskModule && typeof taskModule.stats?.allowShell === 'boolean') {
        allowShell.value = taskModule.stats.allowShell
      } else if (items.value.length) {
        allowShell.value = !!items.value[0].allowShell
      }
    } else if (!silent) {
      Message.error(`读取模块状态失败：${errorText(moduleResult.reason)}`)
    }
    // The task list carries the same flag, so a failed module status request
    // does not hide the real state of the global switch.
    if (items.value.length && moduleResult.status !== 'fulfilled') {
      allowShell.value = !!items.value[0].allowShell
    }
  } finally {
    loading.value = false
  }
}

function scheduleRefresh() {
  for (const timer of refreshTimers) clearTimeout(timer)
  refreshTimers.clear()
  for (const delay of [1200, 3500]) {
    const timer = setTimeout(() => {
      refreshTimers.delete(timer)
      load(true)
    }, delay)
    refreshTimers.add(timer)
  }
}

function openTask(row) {
  const base = row || {}
  editingId.value = base.id || ''
  taskForm.name = base.name || ''
  taskForm.enable = base.enable !== false
  taskForm.cron = base.cron || '0 3 * * *'
  taskForm.remark = base.remark || ''
  const actions = Array.isArray(base.actions) && base.actions.length ? base.actions : [blankAction()]
  taskForm.actions = actions.map(fromStoredAction)
  taskModal.value = true
}

function addAction() {
  taskForm.actions = [...taskForm.actions, blankAction()]
}

function removeAction(index) {
  taskForm.actions = taskForm.actions.filter((_, current) => current !== index)
}

function onActionTypeChange(action) {
  action.target = ''
  action.value = defaultActionValue(action.type)
  action.method = 'GET'
  action.url = ''
  action.headersText = ''
  action.body = ''
  action.command = ''
}

function buildActions() {
  return taskForm.actions.map((action) => {
    const type = action.type
    if (type === 'module.toggle') {
      return { type, target: action.target.trim(), value: action.value || 'on' }
    }
    if (type === 'rule.toggle') {
      return { type, target: action.target.trim(), value: action.value || 'on' }
    }
    if (type === 'http.request') {
      const result = { type, method: (action.method || 'GET').toUpperCase(), url: action.url.trim() }
      const headers = headersFromText(action.headersText)
      if (Object.keys(headers).length) result.headers = headers
      if (action.body !== '') result.body = action.body
      return result
    }
    if (type === 'notify.webhook') {
      return { type, value: action.value.trim() }
    }
    return { type, command: action.command.trim() }
  })
}

function validateActions(actions) {
  if (!actions.length) {
    Message.error('请至少添加一个动作')
    return false
  }
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]
    const prefix = `第 ${index + 1} 个动作`
    if (action.type === 'module.toggle' && !action.target) {
      Message.error(`${prefix}：请填写模块名`)
      return false
    }
    if (action.type === 'rule.toggle') {
      if (!/^[^:]+:.+/.test(action.target)) {
        Message.error(`${prefix}：规则目标必须形如 web:<id>、forward:<id> 或 ddns:<id>`)
        return false
      }
      const kind = action.target.split(':')[0].trim().toLowerCase()
      if (!['web', 'forward', 'ddns'].includes(kind)) {
        Message.error(`${prefix}：规则目标前缀只能是 web、forward 或 ddns`)
        return false
      }
    }
    if (action.type === 'http.request' && !action.url) {
      Message.error(`${prefix}：请填写请求 URL`)
      return false
    }
    if (action.type === 'shell.exec' && !action.command) {
      Message.error(`${prefix}：请填写要执行的命令`)
      return false
    }
  }
  return true
}

async function saveTask() {
  const name = taskForm.name.trim()
  const cron = taskForm.cron.trim()
  if (!name) {
    Message.error('请填写任务名称')
    return false
  }
  if (!cron) {
    Message.error('请填写 Cron 表达式')
    return false
  }
  if (!isCronLike(cron)) {
    Message.error('Cron 表达式应为 5 段式（分 时 日 月 周）或 @daily / @every 30m 这类快捷写法')
    return false
  }
  const actions = buildActions()
  if (!validateActions(actions)) return false
  if (actions.some((action) => action.type === 'shell.exec') && !allowShell.value) {
    Message.warning('当前未允许 Shell 执行，保存后该动作会在运行时失败')
  }

  const payload = {
    name,
    enable: !!taskForm.enable,
    cron,
    remark: taskForm.remark.trim(),
    actions,
  }

  saving.value = true
  try {
    if (editing.value) {
      await api.put(`/api/v1/task/items/${encodeURIComponent(editing.value)}`, payload)
    } else {
      await api.post('/api/v1/task/items', payload)
    }
    Message.success('计划任务已保存')
    await load()
    return true
  } catch (err) {
    Message.error(`保存失败：${errorText(err)}`)
    return false
  } finally {
    saving.value = false
  }
}

async function toggleTask(row, next) {
  busyId.value = row.id
  try {
    await api.post(`/api/v1/task/items/${encodeURIComponent(row.id)}/toggle`, { enable: next })
    Message.success(next ? '已启用' : '已停用')
    await load(true)
  } catch (err) {
    Message.error(`切换失败：${errorText(err)}`)
  } finally {
    busyId.value = ''
  }
}

async function runTask(row) {
  busyId.value = row.id
  try {
    await api.post(`/api/v1/task/items/${encodeURIComponent(row.id)}/run`)
    Message.success('任务已开始执行')
    scheduleRefresh()
  } catch (err) {
    Message.error(`运行失败：${errorText(err)}`)
  } finally {
    busyId.value = ''
  }
}

function deleteTask(row) {
  Modal.confirm({
    title: '删除计划任务',
    content: `确定删除「${row.name || row.id}」吗？该任务的历史运行状态会一并移除。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del(`/api/v1/task/items/${encodeURIComponent(row.id)}`)
        Message.success('已删除')
        await load(true)
      } catch (err) {
        Message.error(`删除失败：${errorText(err)}`)
      }
    },
  })
}

function openDetail(row) {
  detailTask.value = row
  detailVisible.value = true
}

// The task API reports allowShell but has no dedicated write route, so the
// global switch persists tasks.allowShell through the supported system
// configuration import endpoint.
function onAllowShellChange(next) {
  if (allowShellSaving.value) return
  const enabling = !!next
  Modal.confirm({
    title: enabling ? '允许执行 Shell 命令' : '禁止执行 Shell 命令',
    content: enabling
      ? '开启后，shell.exec 动作会以服务运行用户的权限直接执行命令（不经过 shell），只应完全信任任务配置时开启。'
      : '关闭后，包含 shell.exec 的动作会在运行时失败，其他动作不受影响。',
    okText: enabling ? '开启' : '关闭',
    cancelText: '取消',
    onOk: async () => {
      allowShellSaving.value = true
      try {
        await api.put('/api/v1/task/settings', { allowShell: enabling })
        allowShell.value = enabling
        Message.success(enabling ? '已允许 Shell 执行' : '已禁止 Shell 执行')
        await load(true)
      } catch (err) {
        Message.error(`保存失败：${errorText(err)}`)
      } finally {
        allowShellSaving.value = false
      }
    },
  })
}

onMounted(() => {
  load()
})

onUnmounted(() => {
  for (const timer of refreshTimers) clearTimeout(timer)
  refreshTimers.clear()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>计划任务</h2>
        <div class="sub">
          共 {{ items.length }} 个任务，其中 {{ shellActionCount }} 个包含 Shell 动作；cron 使用 5 段式或 @daily / @every 快捷写法
        </div>
      </div>
      <div class="spacer" />
      <a-tooltip content="写入 tasks.allowShell；关闭时 shell.exec 动作会在运行时失败">
        <div class="shell-switch">
          <span class="muted">允许 Shell 执行</span>
          <a-switch
            size="small"
            :model-value="allowShell"
            :loading="allowShellSaving"
            @change="onAllowShellChange"
          />
        </div>
      </a-tooltip>
      <a-button :loading="loading" @click="load()">刷新</a-button>
      <a-button type="primary" @click="openTask(null)">新建任务</a-button>
    </div>

    <a-card :bordered="false">
      <template #title>任务列表</template>
      <template #extra>
        <span class="muted">动作按顺序执行，任一动作失败会记录到运行结果中</span>
      </template>

      <a-table
        :data="items"
        :columns="taskColumns"
        :pagination="false"
        :loading="loading"
        row-key="id"
        :scroll="{ x: 1280 }"
        size="small"
      >
        <template #name="{ record }">
          <div>
            <div>{{ record.name || record.id }}</div>
            <div v-if="record.remark" class="muted cell-note">{{ record.remark }}</div>
          </div>
        </template>
        <template #cron="{ record }">
          <span class="mono">{{ record.cron || '-' }}</span>
        </template>
        <template #actionTags="{ record }">
          <a-space wrap size="mini">
            <a-tooltip v-for="(action, index) in (record.actions || []).slice(0, 3)" :key="index" :content="actionSummary(action)">
              <a-tag>{{ actionLabel(action.type) }}</a-tag>
            </a-tooltip>
            <span v-if="(record.actions || []).length > 3" class="muted">+{{ record.actions.length - 3 }}</span>
          </a-space>
        </template>
        <template #state="{ record }">
          <a-space>
            <a-switch
              size="small"
              :model-value="!!record.enable"
              :loading="busyId === record.id"
              @change="(value) => toggleTask(record, value)"
            />
            <a-tag v-if="taskState(record).running" color="blue">运行中</a-tag>
            <span v-else class="muted">{{ record.enable ? '已启用' : '已停用' }}</span>
          </a-space>
        </template>
        <template #lastRun="{ record }">
          {{ taskState(record).lastRun ? fmtTime(taskState(record).lastRun) : '-' }}
        </template>
        <template #result="{ record }">
          <div class="result-cell">
            <a-tag :color="resultTone(record)">{{ resultLabel(record) }}</a-tag>
            <span v-if="taskState(record).lastDurationMs" class="muted"> {{ taskState(record).lastDurationMs }} ms</span>
            <div v-if="taskState(record).preview" class="muted cell-note preview">{{ taskState(record).preview }}</div>
          </div>
        </template>
        <template #nextRun="{ record }">
          <span :class="{ muted: !record.nextRun }">{{ record.nextRun ? fmtTime(record.nextRun) : '-' }}</span>
        </template>
        <template #operations="{ record }">
          <a-space>
            <a-button size="mini" :loading="busyId === record.id" @click="runTask(record)">立即运行</a-button>
            <a-button size="mini" @click="openTask(record)">编辑</a-button>
            <a-button size="mini" @click="openDetail(record)">运行状态</a-button>
            <a-button size="mini" status="danger" @click="deleteTask(record)">删除</a-button>
          </a-space>
        </template>
        <template #empty>
          <a-empty description="还没有计划任务，点右上角「新建任务」创建" />
        </template>
      </a-table>
    </a-card>

    <a-modal
      v-model:visible="taskModal"
      :title="taskTitle"
      :width="820"
      :ok-loading="saving"
      ok-text="保存"
      cancel-text="取消"
      :mask-closable="false"
      :on-before-ok="saveTask"
    >
      <a-form :model="taskForm" layout="vertical">
        <a-row :gutter="16">
          <a-col :xs="24" :md="12">
            <a-form-item label="名称" required>
              <a-input v-model="taskForm.name" placeholder="例如 每天检查证书" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="6">
            <a-form-item label="启用">
              <a-switch v-model="taskForm.enable" />
              <span class="muted inline-note">参与调度</span>
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="6">
            <a-form-item label="备注">
              <a-input v-model="taskForm.remark" placeholder="可选" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item label="Cron 表达式" required>
          <a-input v-model="taskForm.cron" placeholder="*/5 * * * *" />
          <div class="cron-examples">
            <a-button
              v-for="example in CRON_EXAMPLES"
              :key="example.cron"
              size="mini"
              @click="taskForm.cron = example.cron"
            >
              {{ example.label }}
            </a-button>
          </div>
          <template #extra>
            <span class="muted">5 段式（分 时 日 月 周），也支持 @daily、@every 30m 这类快捷写法</span>
          </template>
        </a-form-item>

        <a-divider orientation="left">动作</a-divider>
        <div v-if="!taskForm.actions.length" class="muted empty-actions">还没有动作，点下面的「添加动作」加一个。</div>

        <div v-for="(action, index) in taskForm.actions" :key="index" class="action-card">
          <div class="action-head">
            <a-select
              v-model="action.type"
              :options="ACTION_OPTIONS"
              style="width: 170px"
              @change="onActionTypeChange(action)"
            />
            <span class="muted">动作 {{ index + 1 }}</span>
            <div class="spacer" />
            <a-button size="mini" status="danger" @click="removeAction(index)">删除</a-button>
          </div>

          <a-row :gutter="12">
            <template v-if="action.type === 'module.toggle'">
              <a-col :xs="24" :md="12">
                <a-form-item label="模块名" required>
                  <a-input v-model="action.target" placeholder="模块名，例如 web / ddns / waf / forward" />
                  <template #extra>
                    <span class="muted">
                      可用模块：{{ moduleOptions.map((item) => item.value).join(' / ') || '（未读取到模块列表）' }}
                    </span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="12">
                <a-form-item label="动作">
                  <a-select v-model="action.value" :options="MODULE_ACTIONS" />
                </a-form-item>
              </a-col>
            </template>

            <template v-else-if="action.type === 'rule.toggle'">
              <a-col :xs="24" :md="14">
                <a-form-item label="规则目标" required>
                  <a-input v-model="action.target" placeholder="web:<id> / forward:<id> / ddns:<id>" />
                  <template #extra>
                    <span class="muted">格式为「模块:规则 ID」，例如 web:ab12cd34</span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="10">
                <a-form-item label="动作">
                  <a-select v-model="action.value" :options="RULE_ACTIONS" />
                </a-form-item>
              </a-col>
            </template>

            <template v-else-if="action.type === 'http.request'">
              <a-col :xs="24" :md="6">
                <a-form-item label="方法">
                  <a-select v-model="action.method" :options="HTTP_METHODS" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="18">
                <a-form-item label="URL" required>
                  <a-input v-model="action.url" placeholder="https://example.com/hook" />
                </a-form-item>
              </a-col>
              <a-col :span="24">
                <a-form-item label="请求头">
                  <a-textarea
                    v-model="action.headersText"
                    :auto-size="{ minRows: 2, maxRows: 4 }"
                    placeholder="每行一条 key: value"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="24">
                <a-form-item label="请求体">
                  <a-textarea v-model="action.body" :auto-size="{ minRows: 2, maxRows: 5 }" placeholder="请求体（可选）" />
                </a-form-item>
              </a-col>
            </template>

            <template v-else-if="action.type === 'notify.webhook'">
              <a-col :span="24">
                <a-form-item label="通知内容">
                  <a-input v-model="action.value" placeholder="留空使用默认文案" />
                  <template #extra>
                    <span class="muted">通过「通知」页面配置的 webhook 渠道发送</span>
                  </template>
                </a-form-item>
              </a-col>
            </template>

            <template v-else>
              <a-col :span="24">
                <a-form-item label="命令" required>
                  <a-textarea
                    v-model="action.command"
                    :auto-size="{ minRows: 2, maxRows: 4 }"
                    placeholder="直接执行的命令，不经过 shell"
                  />
                  <template #extra>
                    <span v-if="allowShell" class="muted">当前已允许 Shell 执行</span>
                    <span v-else class="warn-text">当前未允许 Shell 执行，该动作运行时将失败；请先打开页面顶部的全局开关</span>
                  </template>
                </a-form-item>
              </a-col>
            </template>
          </a-row>
        </div>

        <a-button class="add-action" @click="addAction">添加动作</a-button>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="detailVisible"
      :title="`运行状态 - ${detailTask?.name || detailTask?.id || ''}`"
      :width="900"
      :footer="false"
      :mask-closable="false"
    >
      <a-descriptions :column="3" bordered size="small">
        <a-descriptions-item label="运行中">
          {{ detailTask?.state?.running ? '是' : '否' }}
        </a-descriptions-item>
        <a-descriptions-item label="运行次数">{{ detailTask?.state?.runs ?? 0 }}</a-descriptions-item>
        <a-descriptions-item label="成功 / 失败">
          {{ detailTask?.state?.successes ?? 0 }} / {{ detailTask?.state?.failures ?? 0 }}
        </a-descriptions-item>
        <a-descriptions-item label="上次运行">{{ fmtTime(detailTask?.state?.lastRun) }}</a-descriptions-item>
        <a-descriptions-item label="上次耗时">{{ detailTask?.state?.lastDurationMs ?? 0 }} ms</a-descriptions-item>
        <a-descriptions-item label="下次运行">{{ fmtTime(detailTask?.nextRun) }}</a-descriptions-item>
        <a-descriptions-item label="最近结果" :span="3">
          <a-tag :color="resultTone(detailTask)">{{ resultLabel(detailTask) }}</a-tag>
        </a-descriptions-item>
        <a-descriptions-item v-if="detailTask?.state?.preview" label="输出预览" :span="3">
          <span class="mono preview-block">{{ detailTask.state.preview }}</span>
        </a-descriptions-item>
      </a-descriptions>

      <a-divider orientation="left">最近动作结果</a-divider>
      <a-table
        :data="detailActions"
        :columns="detailActionColumns"
        :pagination="false"
        size="small"
        :scroll="{ x: 760 }"
      >
        <template #type="{ record }">{{ actionLabel(record.type) }}</template>
        <template #ok="{ record }">
          <a-tag :color="record.ok ? 'green' : 'red'">{{ record.ok ? '成功' : '失败' }}</a-tag>
        </template>
        <template #duration="{ record }">{{ actionDurationMs(record) }}</template>
        <template #output="{ record }">
          <span class="mono preview">{{ record.error || record.output || '-' }}</span>
        </template>
        <template #empty>
          <a-empty description="没有动作执行记录" />
        </template>
      </a-table>

      <a-divider orientation="left">运行历史</a-divider>
      <a-table
        :data="detailLogs"
        :columns="detailLogColumns"
        :pagination="false"
        size="small"
        :scroll="{ x: 760 }"
      >
        <template #time="{ record }">{{ fmtTime(record.time) }}</template>
        <template #ok="{ record }">
          <a-tag :color="logTone(record)">{{ record.ok ? '成功' : '失败' }}</a-tag>
        </template>
        <template #error="{ record }">
          <span class="muted">{{ record.error || '-' }}</span>
        </template>
        <template #preview="{ record }">
          <span class="mono preview">{{ record.preview || '-' }}</span>
        </template>
        <template #empty>
          <a-empty description="还没有运行记录" />
        </template>
      </a-table>
    </a-modal>
  </div>
</template>

<style scoped>
.shell-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
}

.inline-note {
  margin-left: 8px;
  font-size: 12px;
}

.cell-note {
  margin-top: 2px;
  font-size: 11px;
}

.result-cell {
  min-width: 0;
}

.preview {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.preview-block {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
}

.cron-examples {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.empty-actions {
  margin-bottom: 8px;
  font-size: 12px;
}

.action-card {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--border-radius-medium);
  background: var(--color-fill-1);
}

.action-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.add-action {
  margin-top: 4px;
}

.warn-text {
  color: rgb(var(--warning-6));
}
</style>
