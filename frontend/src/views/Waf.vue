<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtTime } from '../format'

const MODE_OPTIONS = [
  { value: 'detect', label: '检测模式（只记录不拦截）' },
  { value: 'block', label: '拦截模式' },
]

const LEVEL_OPTIONS = [1, 2, 3, 4].map((value) => ({ value, label: `PL${value}` }))

const GROUP_LABEL = { request: '请求', response: '响应', setup: '初始化' }

const TEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((value) => ({
  value,
  label: value,
}))

const config = ref(null)
const engine = ref(null)
const rules = ref([])
const logs = ref([])
const crsVersion = ref('')
const configLoading = ref(true)
const rulesLoading = ref(false)
const logsLoading = ref(false)
const saving = ref(false)
const testing = ref(false)
const ruleQuery = ref('')
const logFilter = ref('')
const testResult = ref(null)

const form = reactive({
  enable: false,
  mode: 'detect',
  logOnly: false,
  useCrs: true,
  paranoiaLevel: 1,
  executingLevel: 1,
  inboundThreshold: 5,
  outboundThreshold: 4,
  bodyLimitKb: 0,
  adminProtect: true,
  disabledRules: [],
  extraRules: '',
})

const testForm = reactive({
  method: 'GET',
  url: '',
  body: '',
  clientIp: '',
})

const engineTone = computed(() => (engine.value?.enabled ? 'green' : 'gray'))
const engineText = computed(() => (engine.value?.enabled ? '运行中' : '未运行'))

const filteredRules = computed(() => {
  const query = ruleQuery.value.trim().toLowerCase()
  if (!query) return rules.value
  return rules.value.filter((item) =>
    [item.title, item.titleEn, item.file, item.name, item.group, item.tag]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query),
  )
})

const ruleColumns = [
  { title: '规则文件', dataIndex: 'title', slotName: 'title' },
  { title: '分组', dataIndex: 'group', slotName: 'group', width: 90 },
  { title: '规则数', dataIndex: 'rules', width: 90 },
  { title: 'ID 区间', dataIndex: 'disableRange', slotName: 'range', width: 160 },
  { title: '状态', dataIndex: 'enabled', slotName: 'state', width: 130 },
  { title: '启用', slotName: 'enabled', width: 80 },
]

const logColumns = [
  { title: '时间', dataIndex: 'time', slotName: 'time', width: 176 },
  { title: '动作', dataIndex: 'action', slotName: 'action', width: 90 },
  { title: '客户端', dataIndex: 'clientIp', width: 150 },
  { title: '请求', dataIndex: 'uri', slotName: 'request' },
  { title: '站点', dataIndex: 'rule', width: 130, ellipsis: true, tooltip: true },
  { title: '规则', dataIndex: 'ruleId', slotName: 'rules', width: 180 },
  { title: '说明', dataIndex: 'message', ellipsis: true, tooltip: true },
]

const matchedColumns = [
  { title: '规则 ID', dataIndex: 'id', width: 100 },
  { title: '严重级别', dataIndex: 'severity', width: 110 },
  { title: '阶段', dataIndex: 'phase', width: 80 },
  { title: '说明', dataIndex: 'message', ellipsis: true, tooltip: true },
  { title: '数据', dataIndex: 'data', ellipsis: true, tooltip: true },
  { title: '文件', dataIndex: 'file', ellipsis: true, tooltip: true },
]

function clampLevel(value, fallback = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(4, Math.max(1, Math.floor(number)))
}

function syncForm(cfg) {
  const source = cfg || {}
  form.enable = !!source.enable
  form.mode = source.mode === 'detect' ? 'detect' : 'block'
  form.logOnly = !!source.logOnly
  form.useCrs = source.useCrs !== false
  form.paranoiaLevel = clampLevel(source.paranoiaLevel, 1)
  form.executingLevel = clampLevel(source.executingLevel, form.paranoiaLevel)
  form.inboundThreshold = Number(source.inboundThreshold) > 0 ? Number(source.inboundThreshold) : 5
  form.outboundThreshold = Number(source.outboundThreshold) > 0 ? Number(source.outboundThreshold) : 4
  form.bodyLimitKb = Number(source.bodyLimitKb) > 0 ? Number(source.bodyLimitKb) : 0
  form.adminProtect = source.adminProtect !== false
  form.disabledRules = Array.isArray(source.disabledRules) ? source.disabledRules.map((item) => String(item)) : []
  form.extraRules = source.extraRules || ''
}

async function loadConfig(showError = true) {
  configLoading.value = true
  try {
    const data = await api.get('/api/v1/waf/config')
    config.value = data?.config || {}
    engine.value = data?.engine || null
    syncForm(config.value)
  } catch (err) {
    if (showError) Message.error(`读取 WAF 配置失败：${errorText(err)}`)
  } finally {
    configLoading.value = false
  }
}

async function saveConfig() {
  if (!config.value) {
    Message.error('配置尚未加载完成')
    return
  }
  const disabledRules = (form.disabledRules || [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const payload = {
    ...config.value,
    enable: !!form.enable,
    mode: form.mode,
    logOnly: !!form.logOnly,
    useCrs: !!form.useCrs,
    paranoiaLevel: clampLevel(form.paranoiaLevel, 1),
    executingLevel: clampLevel(form.executingLevel, clampLevel(form.paranoiaLevel, 1)),
    inboundThreshold: Number(form.inboundThreshold) || 5,
    outboundThreshold: Number(form.outboundThreshold) || 4,
    bodyLimitKb: Number(form.bodyLimitKb) || 0,
    adminProtect: !!form.adminProtect,
    disabledRules,
    extraRules: form.extraRules || '',
    ruleFiles: Array.isArray(config.value.ruleFiles) ? config.value.ruleFiles : [],
  }

  saving.value = true
  try {
    const data = await api.put('/api/v1/waf/config', payload)
    config.value = data?.config || payload
    engine.value = data?.engine || engine.value
    syncForm(config.value)
    Message.success('WAF 配置已保存并重新编译')
    await loadRules()
  } catch (err) {
    Message.error(`保存失败：${errorText(err)}`)
  } finally {
    saving.value = false
  }
}

async function loadRules(showError = true) {
  rulesLoading.value = true
  try {
    const data = await api.get('/api/v1/waf/rules')
    rules.value = Array.isArray(data?.items) ? data.items : []
    crsVersion.value = data?.crsVersion || ''
  } catch (err) {
    if (showError) Message.error(`读取规则文件失败：${errorText(err)}`)
  } finally {
    rulesLoading.value = false
  }
}

function ruleRange(record) {
  const min = Number(record?.minId)
  const max = Number(record?.maxId)
  return min > 0 && max > 0 ? `${min}-${max}` : ''
}

function parseRange(value) {
  const parts = String(value || '').trim().split('-')
  if (parts.length !== 2) return null
  const start = Number(parts[0])
  const end = Number(parts[1])
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) return null
  return [start, end]
}

function isRuleDisabled(record) {
  const target = parseRange(record?.disableRange || ruleRange(record))
  if (!target) return false
  return (form.disabledRules || []).some((entry) => {
    const range = parseRange(entry)
    return range && range[0] <= target[0] && range[1] >= target[1]
  })
}

function canToggleRule(record) {
  return !!form.useCrs && !record?.required && !!(record?.disableRange || ruleRange(record))
}

function ruleEnabled(record) {
  return record?.enabled !== false && !isRuleDisabled(record)
}

function ruleState(record) {
  if (!form.useCrs) return { label: 'CRS 已关闭', tone: 'gray' }
  if (isRuleDisabled(record)) return { label: '已禁用', tone: 'gray' }
  if (record?.reason) return { label: record.reason, tone: 'orange' }
  if (record?.enabled === false) return { label: '未加载', tone: 'orange' }
  return { label: '启用', tone: 'green' }
}

function toggleRule(record, enabled) {
  if (!canToggleRule(record)) return
  const range = record.disableRange || ruleRange(record)
  const target = parseRange(range)
  if (!target) return
  const covered = (entry) => {
    const parsed = parseRange(entry)
    return parsed && parsed[0] <= target[0] && parsed[1] >= target[1]
  }
  if (enabled) {
    form.disabledRules = form.disabledRules.filter((entry) => !covered(entry))
    return
  }
  if (!form.disabledRules.some(covered)) {
    form.disabledRules = [...form.disabledRules, range]
  }
}

async function loadLogs(silent = false) {
  logsLoading.value = true
  try {
    const data = await api.get('/api/v1/waf/logs', { limit: 200, action: logFilter.value || undefined })
    logs.value = Array.isArray(data?.items) ? data.items : []
  } catch (err) {
    if (!silent) Message.error(`读取拦截日志失败：${errorText(err)}`)
  } finally {
    logsLoading.value = false
  }
}

function clearLogs() {
  Modal.confirm({
    title: '清空拦截日志',
    content: '将清空内存中的拦截日志和统计计数，确定继续？',
    okText: '清空',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del('/api/v1/waf/logs')
        Message.success('日志已清空')
        await loadLogs()
      } catch (err) {
        Message.error(`清空失败：${errorText(err)}`)
      }
    },
  })
}

function actionLabel(action) {
  if (action === 'deny') return '拦截'
  if (action === 'detect') return '检测'
  return action || '-'
}

function actionTone(action) {
  if (action === 'deny') return 'red'
  if (action === 'detect') return 'orange'
  return 'gray'
}

function ruleIdsOf(record) {
  const ids = []
  if (Array.isArray(record?.ruleIds)) ids.push(...record.ruleIds)
  if (record?.ruleId && !ids.includes(record.ruleId)) ids.push(record.ruleId)
  return ids.filter((item) => item !== undefined && item !== null && item !== '')
}

async function runTest() {
  const url = testForm.url.trim()
  if (!url) {
    Message.error('请填写要测试的 URL 或路径')
    return
  }
  const payload = {
    method: testForm.method,
    url,
    body: testForm.body,
  }
  if (testForm.clientIp.trim()) payload.clientIp = testForm.clientIp.trim()

  testing.value = true
  try {
    testResult.value = await api.post('/api/v1/waf/test', payload)
  } catch (err) {
    testResult.value = { error: errorText(err) }
    Message.error(`检测失败：${errorText(err)}`)
  } finally {
    testing.value = false
  }
}

const verdict = computed(() => {
  const result = testResult.value
  if (!result) return null
  if (result.error) return { type: 'error', text: `检测失败：${result.error}` }
  if (result.blocked && result.enforced) return { type: 'error', text: '请求会被拦截' }
  if (result.blocked) return { type: 'warning', text: '命中规则，但当前模式只记录、不实际拦截' }
  return { type: 'success', text: '未命中拦截规则' }
})

let logTimer = null

onMounted(() => {
  loadConfig()
  loadRules()
  loadLogs()
  logTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadLogs(true)
  }, 10000)
})

onUnmounted(() => {
  if (logTimer) clearInterval(logTimer)
  logTimer = null
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>WAF</h2>
        <div class="sub">
          嵌入式 Coraza 引擎：引擎配置、规则文件、请求测试与拦截日志
        </div>
      </div>
      <div class="spacer" />
      <a-tag :color="engineTone">{{ engineText }}</a-tag>
      <span v-if="engine?.crsVersion || crsVersion" class="muted">CRS {{ engine?.crsVersion || crsVersion }}</span>
      <a-button :loading="configLoading" @click="loadConfig()">重新加载</a-button>
      <a-button type="primary" :loading="saving" @click="saveConfig">保存配置</a-button>
    </div>

    <div class="stack">
      <a-card :bordered="false">
        <template #title>引擎配置</template>
        <template #extra>
          <span class="muted">
            规则 {{ engine?.rules ?? '-' }} 条 · 文件 {{ engine?.ruleFiles ?? '-' }} 个
          </span>
        </template>

        <a-alert v-if="engine?.error" type="warning" class="block-gap" :show-icon="true">
          引擎编译错误：{{ engine.error }}
        </a-alert>

        <a-spin :loading="configLoading" style="width: 100%">
          <a-form :model="form" layout="vertical">
            <a-row :gutter="16">
              <a-col :xs="24" :md="6">
                <a-form-item label="总开关">
                  <a-switch v-model="form.enable" />
                  <span class="muted inline-note">启用 WAF</span>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="模式">
                  <a-select v-model="form.mode" :options="MODE_OPTIONS" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="仅记录">
                  <a-switch v-model="form.logOnly" />
                  <span class="muted inline-note">不返回 403</span>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="内置 CRS">
                  <a-switch v-model="form.useCrs" />
                  <span class="muted inline-note">使用内置规则集</span>
                </a-form-item>
              </a-col>
            </a-row>

            <a-row :gutter="16">
              <a-col :xs="24" :md="6">
                <a-form-item label="Paranoia Level">
                  <a-select v-model="form.paranoiaLevel" :options="LEVEL_OPTIONS" />
                  <template #extra>
                    <span class="muted">等级越高越严格，误报也越多</span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="执行等级">
                  <a-select v-model="form.executingLevel" :options="LEVEL_OPTIONS" />
                  <template #extra>
                    <span class="muted">不能低于 Paranoia Level</span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="入站阈值">
                  <a-input-number v-model="form.inboundThreshold" :min="1" style="width: 100%" />
                  <template #extra>
                    <span class="muted">异常分数达到该值触发</span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="出站阈值">
                  <a-input-number v-model="form.outboundThreshold" :min="1" style="width: 100%" />
                </a-form-item>
              </a-col>
            </a-row>

            <a-row :gutter="16">
              <a-col :xs="24" :md="6">
                <a-form-item label="请求体上限（KB）">
                  <a-input-number v-model="form.bodyLimitKb" :min="0" :max="10240" style="width: 100%" />
                  <template #extra>
                    <span class="muted">bodyLimitKb；0 表示后端默认值</span>
                  </template>
                </a-form-item>
              </a-col>
              <a-col :xs="24" :md="6">
                <a-form-item label="管理后台防护">
                  <a-switch v-model="form.adminProtect" />
                  <span class="muted inline-note">保护后台管理接口</span>
                </a-form-item>
              </a-col>
            </a-row>

            <a-form-item label="禁用规则">
              <a-input-tag
                v-model="form.disabledRules"
                placeholder="输入规则 ID 或 ID 区间后回车，例如 920100 或 900000-910000"
                :max-tag-count="8"
              />
              <template #extra>
                <span class="muted">只接受规则 ID 或「起始-结束」区间；保存后重新编译规则集</span>
              </template>
            </a-form-item>

            <a-form-item label="额外 SecLang 规则">
              <a-textarea
                v-model="form.extraRules"
                :auto-size="{ minRows: 4, maxRows: 10 }"
                placeholder="追加的 SecLang 规则，例如：&#10;SecRule ARGS &quot;@contains evil&quot; &quot;id:100001,phase:2,deny,status:403,msg:自定义规则&quot;"
              />
              <template #extra>
                <span class="muted">保存后立即重新编译规则集</span>
              </template>
            </a-form-item>
          </a-form>
        </a-spin>
      </a-card>

      <a-card :bordered="false">
        <template #title>规则文件</template>
        <template #extra>
          <a-input
            v-model="ruleQuery"
            size="small"
            allow-clear
            placeholder="搜索规则文件"
            style="width: 220px"
          />
          <a-button size="small" :loading="rulesLoading" style="margin-left: 8px" @click="loadRules()">刷新</a-button>
        </template>

        <a-table
          :data="filteredRules"
          :columns="ruleColumns"
          :pagination="false"
          :loading="rulesLoading"
          row-key="file"
          :scroll="{ x: 860 }"
          size="small"
        >
          <template #title="{ record }">
            <div>
              <div>{{ record.title || record.name || record.file }}</div>
              <div class="muted mono cell-note">{{ record.file }}</div>
            </div>
          </template>
          <template #group="{ record }">
            <a-tag>{{ GROUP_LABEL[record.group] || record.group || '-' }}</a-tag>
          </template>
          <template #range="{ record }">
            <span class="mono">{{ record.disableRange || ruleRange(record) || '-' }}</span>
          </template>
          <template #state="{ record }">
            <a-tag :color="ruleState(record).tone">{{ ruleState(record).label }}</a-tag>
          </template>
          <template #enabled="{ record }">
            <a-switch
              size="small"
              :model-value="ruleEnabled(record)"
              :disabled="!canToggleRule(record)"
              @change="(value) => toggleRule(record, value)"
            />
          </template>
          <template #empty>
            <a-empty description="没有匹配的规则文件" />
          </template>
        </a-table>
        <div class="muted cell-note">
          取消勾选表示禁用该规则文件（写入禁用规则的 ID 区间），需保存配置后生效；CRS 关闭时规则文件不可单独切换。
        </div>
      </a-card>

      <a-card :bordered="false">
        <template #title>请求测试</template>
        <template #extra>
          <span class="muted">POST /api/v1/waf/test（不会真的发出请求）</span>
          <a-button type="primary" size="small" :loading="testing" style="margin-left: 8px" @click="runTest">
            测试
          </a-button>
        </template>

        <a-form :model="testForm" layout="vertical">
          <a-row :gutter="16">
            <a-col :xs="24" :md="4">
              <a-form-item label="方法">
                <a-select v-model="testForm.method" :options="TEST_METHODS" />
              </a-form-item>
            </a-col>
            <a-col :xs="24" :md="14">
              <a-form-item label="URL / 路径">
                <a-input v-model="testForm.url" placeholder="/admin?id=1 union select 1 或完整 URL" />
                <template #extra>
                  <span class="muted">可填写完整 URL，也可以只填 path（会自动补上前导 /）</span>
                </template>
              </a-form-item>
            </a-col>
            <a-col :xs="24" :md="6">
              <a-form-item label="客户端 IP">
                <a-input v-model="testForm.clientIp" placeholder="可选，默认 127.0.0.1" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="请求体">
            <a-textarea
              v-model="testForm.body"
              :auto-size="{ minRows: 2, maxRows: 8 }"
              placeholder="请求体（POST/PUT 时填写）"
            />
          </a-form-item>
        </a-form>

        <template v-if="testResult">
          <a-divider orientation="left">判定结果</a-divider>
          <a-alert v-if="verdict" :type="verdict.type" :show-icon="true" class="block-gap">
            {{ verdict.text }}
          </a-alert>
          <a-space class="block-gap" wrap>
            <a-tag :color="testResult.blocked ? (testResult.enforced ? 'red' : 'orange') : 'green'">
              {{ testResult.blocked ? (testResult.enforced ? '已拦截' : '命中未拦截') : '未拦截' }}
            </a-tag>
            <a-tag>模式 {{ testResult.mode || '-' }}</a-tag>
            <a-tag>动作 {{ testResult.action || '-' }}</a-tag>
            <a-tag>HTTP {{ testResult.status ?? '-' }}</a-tag>
            <a-tag>耗时 {{ testResult.durationMs ?? '-' }} ms</a-tag>
            <a-tag v-if="testResult.logOnly">logOnly</a-tag>
            <a-tag v-if="testResult.txId" class="mono">事务 {{ testResult.txId }}</a-tag>
          </a-space>
          <div v-if="testResult.ruleId" class="muted">命中规则 ID：{{ testResult.ruleId }}</div>
          <div v-if="testResult.message" class="muted">说明：{{ testResult.message }}</div>

          <a-table
            v-if="Array.isArray(testResult.matched) && testResult.matched.length"
            class="block-gap"
            :data="testResult.matched"
            :columns="matchedColumns"
            :pagination="false"
            size="small"
            :scroll="{ x: 720 }"
          />
          <a-empty v-else description="没有命中规则" />
        </template>
      </a-card>

      <a-card :bordered="false">
        <template #title>拦截日志</template>
        <template #extra>
          <a-select
            v-model="logFilter"
            size="small"
            style="width: 120px"
            @change="() => loadLogs()"
          >
            <a-option value="">全部</a-option>
            <a-option value="deny">拦截</a-option>
            <a-option value="detect">检测</a-option>
          </a-select>
          <a-button size="small" :loading="logsLoading" style="margin-left: 8px" @click="loadLogs()">刷新</a-button>
          <a-button size="small" status="danger" style="margin-left: 8px" @click="clearLogs">清空</a-button>
        </template>

        <a-table
          :data="logs"
          :columns="logColumns"
          :pagination="false"
          :loading="logsLoading"
          :scroll="{ x: 1080 }"
          size="small"
        >
          <template #time="{ record }">
            <span class="muted">{{ fmtTime(record.time) }}</span>
          </template>
          <template #action="{ record }">
            <a-tag :color="actionTone(record.action)">{{ actionLabel(record.action) }}</a-tag>
          </template>
          <template #request="{ record }">
            <span class="mono">{{ record.method || '-' }} {{ record.uri || '-' }}</span>
            <div v-if="record.host" class="muted cell-note">{{ record.host }}</div>
          </template>
          <template #rules="{ record }">
            <a-space wrap size="mini">
              <a-tag v-for="id in ruleIdsOf(record)" :key="id">{{ id }}</a-tag>
            </a-space>
          </template>
          <template #empty>
            <a-empty description="暂无拦截日志" />
          </template>
        </a-table>
        <div class="muted cell-note">每 10 秒自动刷新；日志只保存在内存中，重启后清空。</div>
      </a-card>
    </div>
  </div>
</template>

<style scoped>
.block-gap {
  margin-bottom: 12px;
}

.inline-note {
  margin-left: 8px;
  font-size: 12px;
}

.cell-note {
  margin-top: 2px;
  font-size: 11px;
}
</style>
