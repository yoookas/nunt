<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'

// 存储挂载管理：
//   GET    /api/v1/storage/mounts                列表（密码以 ******** 掩码返回）
//   POST   /api/v1/storage/mounts                新建
//   PUT    /api/v1/storage/mounts/{id}           编辑（密码留空或保持掩码 = 不修改）
//   DELETE /api/v1/storage/mounts/{id}           删除
//   POST   /api/v1/storage/mounts/test           测试连接（body: { mount, id }）
//   GET    /api/v1/storage/mounts/{id}/list?path= 浏览目录
// 文件下载复用管理端辅助接口 GET /api/v1/files/download?mount=&path=。
const TYPE_LABELS = { local: '本地目录', webdav: 'WebDAV' }
const pagination = { pageSize: 20, showTotal: true, size: 'mini' }
const browsePagination = { pageSize: 20, showTotal: true, size: 'mini' }

const mounts = ref([])
const loading = ref(false)
const error = ref('')
const busyId = ref('')

const editorVisible = ref(false)
const editorIsNew = ref(true)
const editorId = ref('')
const editorCreatedAt = ref('')
const saving = ref(false)
const testing = ref(false)
const testResult = ref('')
const formRef = ref(null)
const form = reactive({
  name: '',
  type: 'local',
  enable: true,
  readOnly: false,
  root: '',
  url: '',
  username: '',
  password: '',
  insecureTls: false,
  remark: '',
})

const browseVisible = ref(false)
const browseMount = ref(null)
const browsePath = ref('/')
const browseEntries = ref([])
const browseLoading = ref(false)
const browseError = ref('')

const mountColumns = [
  { title: '名称', dataIndex: 'name', slotName: 'name', ellipsis: true, tooltip: true },
  { title: '类型', dataIndex: 'type', slotName: 'type', width: 110 },
  { title: '位置', dataIndex: 'location', slotName: 'location', ellipsis: true, tooltip: true },
  { title: '访问', dataIndex: 'readOnly', slotName: 'readOnly', width: 90 },
  { title: '状态', dataIndex: 'enable', slotName: 'enable', width: 90 },
  { title: '创建时间', dataIndex: 'createdAt', slotName: 'createdAt', width: 175 },
  { title: '操作', slotName: 'actions', width: 300 },
]

const browseColumns = [
  { title: '名称', dataIndex: 'name', slotName: 'name', ellipsis: true, tooltip: true },
  { title: '类型', dataIndex: 'dir', slotName: 'type', width: 90 },
  { title: '大小', dataIndex: 'size', slotName: 'size', width: 110, align: 'right' },
  { title: '修改时间', dataIndex: 'modTime', slotName: 'modTime', width: 175 },
  { title: '操作', slotName: 'browseActions', width: 110 },
]

const rootRules = computed(() =>
  form.type === 'local' ? [{ required: true, message: '请填写本地路径' }] : [],
)

const browseParts = computed(() => {
  const parts = normalizePath(browsePath.value).split('/').filter(Boolean)
  const out = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push({ name: part, path: acc })
  }
  return out
})

/* ------------------------------------------------------------------ 路径与展示 */

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

function typeLabel(type) {
  return TYPE_LABELS[type] || '本地目录'
}

function locationOf(row) {
  if (!row) return ''
  return String((row.type === 'webdav' ? row.url : row.root) || '')
}

function normalizeEntries(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => ({
      name: entry.name || String(entry.path || '').split('/').filter(Boolean).pop() || '',
      path: normalizePath(entry.path || joinPath(browsePath.value, entry.name || '')),
      dir: !!entry.dir,
      size: Number(entry.size) || 0,
      modTime: entry.modTime || '',
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

/* ------------------------------------------------------------------ 列表 */

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.get('/api/v1/storage/mounts')
    mounts.value = Array.isArray(data)
      ? data
      : data && Array.isArray(data.mounts)
        ? data.mounts
        : data && Array.isArray(data.items)
          ? data.items
          : []
  } catch (err) {
    mounts.value = []
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

/* ------------------------------------------------------------------ 编辑器 */

function openEditor(row) {
  editorIsNew.value = !row
  editorId.value = (row && row.id) || ''
  editorCreatedAt.value = (row && row.createdAt) || ''
  form.name = (row && row.name) || ''
  form.type = (row && row.type) || 'local'
  form.enable = !row || row.enable !== false
  form.readOnly = !!(row && row.readOnly)
  form.root = (row && row.root) || ''
  form.url = (row && row.url) || ''
  form.username = (row && row.username) || ''
  form.password = (row && row.password) || ''
  form.insecureTls = !!(row && row.insecureTls)
  form.remark = (row && row.remark) || ''
  testResult.value = ''
  editorVisible.value = true
  nextTick(() => {
    if (formRef.value) formRef.value.clearValidate()
  })
}

function buildPayload() {
  const type = form.type === 'webdav' ? 'webdav' : 'local'
  const payload = {
    id: editorId.value,
    name: form.name.trim(),
    type,
    enable: !!form.enable,
    readOnly: !!form.readOnly,
    remark: form.remark.trim(),
    root: type === 'local' ? form.root.trim() : '',
    url: type === 'webdav' ? form.url.trim() : '',
    username: type === 'webdav' ? form.username.trim() : '',
    password: type === 'webdav' ? form.password : '',
    insecureTls: type === 'webdav' ? !!form.insecureTls : false,
  }
  if (editorCreatedAt.value) payload.createdAt = editorCreatedAt.value
  return payload
}

async function saveMount() {
  const errors = formRef.value ? await formRef.value.validate() : undefined
  if (errors) return
  saving.value = true
  try {
    const payload = buildPayload()
    if (editorIsNew.value) {
      await api.post('/api/v1/storage/mounts', payload)
    } else {
      await api.put(`/api/v1/storage/mounts/${encodeURIComponent(editorId.value)}`, payload)
    }
    Message.success('已保存')
    editorVisible.value = false
    await load()
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  const errors = formRef.value ? await formRef.value.validate() : undefined
  if (errors) return
  testing.value = true
  testResult.value = ''
  try {
    const payload = buildPayload()
    await api.post('/api/v1/storage/mounts/test', { mount: payload, id: editorId.value })
    testResult.value = '连接正常'
    Message.success('连接正常')
  } catch (err) {
    const message = errorText(err)
    testResult.value = message
    Message.error(message)
  } finally {
    testing.value = false
  }
}

async function testRow(row) {
  busyId.value = row.id
  try {
    await api.post('/api/v1/storage/mounts/test', { mount: row, id: row.id })
    Message.success(`连接正常：${row.name || row.id}`)
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    busyId.value = ''
  }
}

function removeMount(row) {
  Modal.confirm({
    title: '删除存储挂载',
    content: `确定删除挂载「${row.name || row.id}」吗？引用它的文件站点与 WebDAV 规则会立即失效。`,
    okText: '删除',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        await api.del(`/api/v1/storage/mounts/${encodeURIComponent(row.id)}`)
        Message.success('已删除')
        await load()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

/* ------------------------------------------------------------------ 目录浏览 */

function openBrowser(row) {
  browseMount.value = row
  browsePath.value = '/'
  browseEntries.value = []
  browseError.value = ''
  browseVisible.value = true
  loadBrowse('/')
}

async function loadBrowse(target) {
  if (!browseMount.value) return
  browsePath.value = normalizePath(target)
  browseLoading.value = true
  browseError.value = ''
  try {
    const data = await api.get(
      `/api/v1/storage/mounts/${encodeURIComponent(browseMount.value.id)}/list`,
      { path: browsePath.value },
    )
    browseEntries.value = normalizeEntries(data && data.entries)
  } catch (err) {
    browseEntries.value = []
    browseError.value = errorText(err)
  } finally {
    browseLoading.value = false
  }
}

function downloadEntry(entry) {
  if (!entry || entry.dir || !browseMount.value) return
  const url = `/api/v1/files/download?mount=${encodeURIComponent(browseMount.value.id)}&path=${encodeURIComponent(entry.path)}`
  window.open(url, '_blank', 'noopener')
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>存储</h2>
        <div class="sub">本地目录与远程 WebDAV 挂载，供文件站点与 WebDAV 规则引用</div>
      </div>
      <span class="spacer" />
      <a-button size="small" :loading="loading" @click="load">
        <template #icon><icon-refresh /></template>
        刷新
      </a-button>
      <a-button size="small" type="primary" @click="openEditor(null)">
        <template #icon><icon-plus /></template>
        新建挂载
      </a-button>
    </div>

    <a-card :bordered="false">
      <template #title>
        <div class="card-title">
          <span>存储挂载</span>
          <span class="muted card-title-note">
            {{ mounts.length ? `共 ${mounts.length} 个挂载` : '暂无挂载' }}
          </span>
        </div>
      </template>

      <a-alert v-if="error" type="warning" class="card-alert">无法读取存储挂载：{{ error }}</a-alert>

      <a-table
        :key="mounts.length"
        :columns="mountColumns"
        :data="mounts"
        :loading="loading"
        :pagination="pagination"
        row-key="id"
        size="small"
        :bordered="false"
      >
        <template #name="{ record }">
          <div class="mount-name">
            <span>{{ record.name || '未命名' }}</span>
            <span v-if="record.remark" class="muted mount-remark">{{ record.remark }}</span>
          </div>
        </template>
        <template #type="{ record }">
          <a-tag size="small" :bordered="false" color="gray">{{ typeLabel(record.type) }}</a-tag>
        </template>
        <template #location="{ record }">
          <span class="mono muted">{{ locationOf(record) || '-' }}</span>
        </template>
        <template #readOnly="{ record }">
          <a-tag size="small" :bordered="false" :color="record.readOnly ? 'orange' : 'green'">
            {{ record.readOnly ? '只读' : '可写' }}
          </a-tag>
        </template>
        <template #enable="{ record }">
          <a-tag size="small" :bordered="false" :color="record.enable ? 'green' : 'gray'">
            {{ record.enable ? '已启用' : '已停用' }}
          </a-tag>
        </template>
        <template #createdAt="{ record }">
          <span class="muted">{{ fmtTime(record.createdAt) }}</span>
        </template>
        <template #actions="{ record }">
          <a-space :size="4">
            <a-button type="text" size="mini" @click="openBrowser(record)">浏览</a-button>
            <a-button
              type="text"
              size="mini"
              :loading="busyId === record.id"
              @click="testRow(record)"
            >
              测试
            </a-button>
            <a-button type="text" size="mini" @click="openEditor(record)">编辑</a-button>
            <a-button type="text" size="mini" status="danger" @click="removeMount(record)">删除</a-button>
          </a-space>
        </template>
        <template #empty>
          <a-empty description="还没有配置存储挂载">
            <a-button type="primary" size="small" @click="openEditor(null)">新建挂载</a-button>
          </a-empty>
        </template>
      </a-table>

      <div class="muted foot">
        密码由服务端加密保存；列表里的 <span class="mono">********</span> 表示已有密码，编辑时不改动它就不会被覆盖。
        类型在编辑时不可修改，需要更换类型请删除后重新创建。
      </div>
    </a-card>

    <a-modal
      v-model:visible="editorVisible"
      :title="editorIsNew ? '新建挂载' : '编辑挂载'"
      width="640px"
      :footer="false"
      unmount-on-close
    >
      <a-form ref="formRef" :model="form" layout="vertical">
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item
              field="name"
              label="名称"
              :rules="[{ required: true, message: '请输入名称' }]"
            >
              <a-input v-model="form.name" placeholder="例如：NAS 备份" allow-clear />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item field="type" label="类型">
              <a-select v-model="form.type" :disabled="!editorIsNew">
                <a-option value="local">本地目录</a-option>
                <a-option value="webdav">WebDAV</a-option>
              </a-select>
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item field="enable" label="启用">
              <a-switch v-model="form.enable" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item field="readOnly" label="只读">
              <a-switch v-model="form.readOnly" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item
          v-if="form.type === 'local'"
          field="root"
          label="本地路径"
          :rules="rootRules"
          extra="目录必须存在且服务进程可读，例如 /data/media 或 D:/media"
        >
          <a-input v-model="form.root" placeholder="/data/media" allow-clear />
        </a-form-item>

        <template v-else>
          <a-form-item
            field="url"
            label="WebDAV 地址"
            :rules="[
              { required: true, message: '请填写 WebDAV 地址' },
              { match: /^https?:\/\//i, message: '请填写以 http:// 或 https:// 开头的地址' },
            ]"
          >
            <a-input v-model="form.url" placeholder="https://dav.example.com/remote.php/dav" allow-clear />
          </a-form-item>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item field="username" label="用户名">
                <a-input v-model="form.username" allow-clear />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item
                field="password"
                label="密码"
                :extra="editorIsNew ? '' : '留空或保持 ******** 表示不修改'"
              >
                <a-input-password
                  v-model="form.password"
                  :placeholder="editorIsNew ? '密码' : '不修改请留空'"
                />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item
            field="insecureTls"
            label="跳过证书校验"
            extra="自签名证书场景使用，会降低连接安全性"
          >
            <a-switch v-model="form.insecureTls" />
          </a-form-item>
        </template>

        <a-form-item field="remark" label="备注">
          <a-input v-model="form.remark" placeholder="可选" allow-clear />
        </a-form-item>
      </a-form>

      <div class="editor-footer">
        <a-button :loading="testing" @click="testConnection">测试连接</a-button>
        <span class="muted test-result">{{ testResult }}</span>
        <span class="spacer" />
        <a-button @click="editorVisible = false">取消</a-button>
        <a-button type="primary" :loading="saving" @click="saveMount">保存</a-button>
      </div>
    </a-modal>

    <a-modal
      v-model:visible="browseVisible"
      :title="`浏览：${(browseMount && browseMount.name) || ''}`"
      width="820px"
      :footer="false"
      unmount-on-close
    >
      <div class="toolbar">
        <a-button size="small" @click="loadBrowse(parentPath(browsePath))">上一级</a-button>
        <a-button size="small" @click="loadBrowse('/')">根目录</a-button>
        <a-button size="small" :loading="browseLoading" @click="loadBrowse(browsePath)">
          <template #icon><icon-refresh /></template>
          刷新
        </a-button>
        <span class="mono muted browse-path">{{ browsePath }}</span>
        <span class="muted browse-meta">
          {{ browseMount && browseMount.readOnly ? '只读' : '可写' }} · {{ browseEntries.length }} 项
        </span>
      </div>

      <a-breadcrumb class="crumbs">
        <a-breadcrumb-item>
          <a-button type="text" size="mini" @click="loadBrowse('/')">根目录</a-button>
        </a-breadcrumb-item>
        <a-breadcrumb-item v-for="part in browseParts" :key="part.path">
          <a-button type="text" size="mini" @click="loadBrowse(part.path)">{{ part.name }}</a-button>
        </a-breadcrumb-item>
      </a-breadcrumb>

      <a-alert v-if="browseError" type="warning" class="card-alert">
        {{ browseError }}
      </a-alert>

      <a-table
        :key="`${browseMount && browseMount.id}|${browsePath}`"
        :columns="browseColumns"
        :data="browseEntries"
        :loading="browseLoading"
        :pagination="browsePagination"
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
        <template #type="{ record }">
          <a-tag size="small" :bordered="false">{{ record.dir ? '目录' : '文件' }}</a-tag>
        </template>
        <template #size="{ record }">{{ record.dir ? '-' : fmtBytes(record.size) }}</template>
        <template #modTime="{ record }">
          <span class="muted">{{ fmtTime(record.modTime) }}</span>
        </template>
        <template #browseActions="{ record }">
          <a-button v-if="record.dir" type="text" size="mini" @click="loadBrowse(record.path)">
            打开
          </a-button>
          <a-button v-else type="text" size="mini" @click="downloadEntry(record)">下载</a-button>
        </template>
        <template #empty>
          <a-empty description="目录为空" />
        </template>
      </a-table>

      <div class="editor-footer">
        <span class="muted">
          下载地址：<span class="mono">/api/v1/files/download?mount=&lt;挂载&gt;&amp;path=&lt;路径&gt;</span>
        </span>
        <span class="spacer" />
        <a-button @click="browseVisible = false">关闭</a-button>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
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

.card-alert {
  margin-bottom: 12px;
}

.mount-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  word-break: break-word;
}

.mount-remark {
  font-size: 12px;
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

.toolbar {
  margin-bottom: 12px;
}

.browse-path {
  word-break: break-all;
}

.browse-meta {
  margin-left: auto;
  font-size: 12px;
  white-space: nowrap;
}

.crumbs {
  margin-bottom: 8px;
}

.editor-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-2);
}

.test-result {
  font-size: 12px;
  word-break: break-all;
}

.foot {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
