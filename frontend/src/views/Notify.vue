<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'

const EVENTS = [
  { value: 'cert.issued', label: '证书签发成功 (cert.issued)' },
  { value: 'cert.failed', label: '证书签发失败 (cert.failed)' },
  { value: 'ddns.update', label: '动态域名更新成功 (ddns.update)' },
  { value: 'ddns.error', label: '动态域名更新失败 (ddns.error)' },
  { value: 'system.alert', label: '系统告警 (system.alert)' },
]

const METHODS = [
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'GET', label: 'GET' },
  { value: 'PATCH', label: 'PATCH' },
]

const hooks = ref([])
const loading = ref(false)
const loadError = ref('')
const busyId = ref('')

const editor = reactive({
  visible: false,
  saving: false,
  editing: null,
  form: { name: '', url: '', method: 'POST', enable: true, events: [] },
})

const headerRows = ref([])

const eventOptions = computed(() => {
  const known = EVENTS.map((item) => ({ value: item.value, label: item.label }))
  const used = new Set(known.map((item) => item.value))
  for (const value of editor.form.events) {
    if (value && !used.has(value)) {
      known.push({ value, label: String(value) })
      used.add(value)
    }
  }
  return known
})

const columns = [
  { title: '名称', dataIndex: 'name', width: 180 },
  { title: '地址', dataIndex: 'url', slotName: 'url' },
  { title: '方法', dataIndex: 'method', width: 90, slotName: 'method' },
  { title: '事件', slotName: 'events', width: 260 },
  { title: '状态', slotName: 'enable', width: 100 },
  { title: '操作', slotName: 'actions', width: 220 },
]

function eventLabel(name) {
  const known = EVENTS.find((item) => item.value === name)
  return known ? known.label.replace(/\s*\(.*\)$/, '') : String(name)
}

async function loadHooks() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await api.get('/api/v1/notify/webhooks')
    hooks.value = Array.isArray(data) ? data : []
  } catch (err) {
    loadError.value = errorText(err)
  } finally {
    loading.value = false
  }
}

function openEditor(row) {
  editor.editing = row ? { ...row } : null
  const draft = row || {}
  editor.form.name = draft.name || ''
  editor.form.url = draft.url || ''
  editor.form.method = draft.method || 'POST'
  editor.form.enable = draft.enable !== false
  editor.form.events = Array.isArray(draft.events) ? [...draft.events] : []
  headerRows.value = Object.entries(draft.headers || {}).map(([key, value]) => ({
    key,
    value: value === undefined || value === null ? '' : String(value),
  }))
  editor.visible = true
}

function addHeader() {
  headerRows.value.push({ key: '', value: '' })
}

function removeHeader(index) {
  headerRows.value.splice(index, 1)
}

function rowsToHeaders() {
  const headers = {}
  for (const row of headerRows.value) {
    const key = String(row.key || '').trim()
    if (key) headers[key] = String(row.value ?? '')
  }
  return headers
}


async function saveHook() {
  const name = String(editor.form.name || '').trim()
  const url = String(editor.form.url || '').trim()
  if (!name) {
    Message.warning('请填写名称')
    return false
  }
  if (!/^https?:\/\/\S+/i.test(url)) {
    Message.warning('请填写以 http:// 或 https:// 开头的地址')
    return false
  }
  const next = {
    ...(editor.editing || {}),
    id: editor.editing?.id || '',
    name,
    url,
    method: editor.form.method || 'POST',
    enable: !!editor.form.enable,
    headers: rowsToHeaders(),
    events: Array.isArray(editor.form.events) ? editor.form.events.filter(Boolean) : [],
  }
  const list = editor.editing
    ? hooks.value.map((item) => (item.id === editor.editing.id ? { ...item, ...next } : item))
    : [...hooks.value, next]

  editor.saving = true
  try {
    await api.put('/api/v1/notify/webhooks', list)
    Message.success('Webhook 已保存')
    // 重新 GET 一次：列表接口会把密钥掩码，避免把保存响应里的原值直接显示出来。
    await loadHooks()
    return true
  } catch (err) {
    Message.error(errorText(err))
    return false
  } finally {
    editor.saving = false
  }
}

async function removeHook(row) {
  Modal.confirm({
    title: '删除 Webhook',
    content: `确定要删除 Webhook「${row.name || row.url}」吗？`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        const list = hooks.value.filter((item) => item.id !== row.id)
        await api.put('/api/v1/notify/webhooks', list)
        Message.success('Webhook 已删除')
        await loadHooks()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

async function testHook(row) {
  const key = row.id || row.url
  busyId.value = key
  try {
    // The stored webhook is addressed by id: the backend fills the masked
    // headers (and the URL when it is missing) from the saved configuration,
    // so the plaintext never has to travel through the browser again.
    await api.post('/api/v1/notify/webhooks/test', { id: row.id, url: row.url })
    Message.success(`测试通知已发送：${row.name || row.url}`)
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

onMounted(loadHooks)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>通知</h2>
        <div class="sub">通过 Webhook 把证书、动态域名和系统告警发送到机器人或告警平台</div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading" @click="loadHooks">刷新</a-button>
      <a-button type="primary" @click="openEditor(null)">新建 Webhook</a-button>
    </div>

    <div class="stack">
      <a-card :bordered="false">
        <template #title>
          通知渠道
          <span v-if="hooks.length" class="muted title-count">共 {{ hooks.length }} 个</span>
        </template>

        <a-alert v-if="loadError" type="error" :content="loadError" style="margin-bottom: 12px" />
        <a-table
          :data="hooks"
          :columns="columns"
          :loading="loading"
          :pagination="false"
          :scroll="{ x: 1050 }"
          row-key="id"
        >
          <template #url="{ record }">
            <span class="mono muted url-cell">{{ record.url }}</span>
          </template>
          <template #method="{ record }">
            <a-tag size="small">{{ record.method || 'POST' }}</a-tag>
          </template>
          <template #events="{ record }">
            <a-space v-if="Array.isArray(record.events) && record.events.length" wrap>
              <a-tag v-for="name in record.events" :key="name" size="small">{{ eventLabel(name) }}</a-tag>
            </a-space>
            <span v-else class="muted">全部事件</span>
          </template>
          <template #enable="{ record }">
            <a-tag :color="record.enable ? 'green' : 'gray'" size="small">
              {{ record.enable ? '已启用' : '已停用' }}
            </a-tag>
          </template>
          <template #actions="{ record }">
            <a-space>
              <a-button
                size="mini"
                :loading="busyId === (record.id || record.url)"
                @click="testHook(record)"
              >测试</a-button>
              <a-button size="mini" @click="openEditor(record)">编辑</a-button>
              <a-button size="mini" type="text" status="danger" @click="removeHook(record)">删除</a-button>
            </a-space>
          </template>
          <template #empty>
            <a-empty description="还没有配置 Webhook 通知，点右上角「新建 Webhook」添加一个" />
          </template>
        </a-table>
      </a-card>

      <a-card :bordered="false">
        <div class="muted note">
          Webhook 会在订阅事件发生时以 JSON 形式 POST 到目标地址；自定义请求头常用于鉴权令牌，
          保存后仅以 ******** 展示，保持不变即不会覆盖原值。
        </div>
      </a-card>
    </div>

    <a-modal
      v-model:visible="editor.visible"
      :title="editor.editing ? '编辑 Webhook' : '新建 Webhook'"
      :ok-loading="editor.saving"
      :on-before-ok="saveHook"
      ok-text="保存"
      cancel-text="取消"
      :width="760"
      :mask-closable="false"
    >
      <a-form :model="editor.form" layout="vertical">
        <a-row :gutter="16">
          <a-col :span="24">
            <a-form-item field="name" label="名称">
              <a-input v-model="editor.form.name" placeholder="例如：运维群机器人" />
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item
              field="url"
              label="Webhook 地址"
              extra="以 http:// 或 https:// 开头，接收 JSON POST 请求"
            >
              <a-input v-model="editor.form.url" placeholder="https://example.com/hook" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="12">
            <a-form-item field="method" label="请求方法">
              <a-select v-model="editor.form.method">
                <a-option v-for="item in METHODS" :key="item.value" :value="item.value">{{ item.label }}</a-option>
              </a-select>
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="12">
            <a-form-item field="enable" label="启用">
              <a-switch v-model="editor.form.enable" />
              <span class="switch-text">{{ editor.form.enable ? '启用该通知' : '暂停该通知' }}</span>
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item
              field="events"
              label="订阅事件"
              extra="不选表示全部事件；可直接输入自定义事件名后回车"
            >
              <a-select
                v-model="editor.form.events"
                multiple
                allow-create
                filterable
                :options="eventOptions"
                placeholder="选择或输入事件名"
              />
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item
              label="自定义请求头"
              extra="已保存的值以 ******** 展示，保持不变即不会覆盖原值"
            >
              <div class="headers">
                <div v-for="(row, index) in headerRows" :key="index" class="header-row">
                  <a-input v-model="row.key" placeholder="Header 名称，例如 Authorization" />
                  <a-input v-model="row.value" placeholder="Header 值" />
                  <a-button type="text" status="danger" @click="removeHeader(index)">删除</a-button>
                </div>
                <a-button size="small" @click="addHeader">添加请求头</a-button>
              </div>
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.title-count {
  margin-left: 8px;
  font-size: 12px;
}

.url-cell {
  word-break: break-all;
}

.note {
  font-size: 13px;
  line-height: 1.7;
}

.switch-text {
  margin-left: 8px;
  color: var(--color-text-3);
  font-size: 12px;
}

.headers {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.header-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto;
  gap: 8px;
  align-items: center;
}
</style>
