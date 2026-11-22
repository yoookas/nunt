<script setup>
import { onMounted, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtBytes, fmtDuration, fmtTime } from '../format'

const info = ref(null)
const stats = ref(null)
const modules = ref([])
const logs = ref([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const [infoData, statsData, moduleData, logData] = await Promise.all([
      api.get('/api/v1/system/info'),
      api.get('/api/v1/system/stats'),
      api.get('/api/v1/modules'),
      api.get('/api/v1/system/logs', { limit: 50 }),
    ])
    info.value = infoData
    stats.value = statsData
    modules.value = moduleData || []
    logs.value = logData?.entries || []
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function moduleAction(module, action) {
  const label = { start: '启动', stop: '停止', restart: '重启' }[action]
  Modal.confirm({
    title: `${label}模块 ${module.title || module.name}`,
    content: '会立即影响该模块正在提供的服务，确定继续？',
    onOk: async () => {
      try {
        await api.post(`/api/v1/modules/${encodeURIComponent(module.name)}/${action}`)
        Message.success(`${label}成功`)
        await load()
      } catch (err) {
        Message.error(errorText(err))
      }
    },
  })
}

const moduleColumns = [
  { title: '模块', dataIndex: 'title' },
  { title: '标识', dataIndex: 'name', width: 120 },
  {
    title: '状态',
    dataIndex: 'running',
    width: 110,
    render: ({ record }) => (record.running ? '运行中' : '已停止'),
  },
  { title: '详情', dataIndex: 'detail', ellipsis: true, tooltip: true },
  {
    title: '操作',
    width: 210,
    slotName: 'actions',
  },
]

const logColumns = [
  { title: '时间', dataIndex: 'time', width: 170, render: ({ record }) => fmtTime(record.time) },
  { title: '级别', dataIndex: 'level', width: 90 },
  { title: '内容', dataIndex: 'msg', ellipsis: true, tooltip: true },
]

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <div class="sub">运行状态、模块与最近的日志</div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading" @click="load">刷新</a-button>
    </div>

    <a-spin :loading="loading" style="width: 100%">
      <div class="stack">
        <div class="grid-cards">
          <a-card :bordered="false">
            <div class="stat-label">版本</div>
            <div class="stat-value">{{ info?.version?.version || '-' }}</div>
            <div class="muted mono">{{ info?.version?.commit?.slice(0, 8) || '' }}</div>
          </a-card>
          <a-card :bordered="false">
            <div class="stat-label">运行时长</div>
            <div class="stat-value">{{ fmtDuration(stats?.uptimeSec) }}</div>
            <div class="muted">启动于 {{ fmtTime(stats?.startTime) }}</div>
          </a-card>
          <a-card :bordered="false">
            <div class="stat-label">Web 规则</div>
            <div class="stat-value">{{ info?.webRules ?? '-' }}</div>
            <div class="muted">证书 {{ info?.certs?.count ?? 0 }} 张<span v-if="info?.certs?.loadErrors">（{{ info.certs.loadErrors }} 个加载失败）</span></div>
          </a-card>
          <a-card :bordered="false">
            <div class="stat-label">内存 / 协程</div>
            <div class="stat-value">{{ fmtBytes(stats?.heapBytes) }}</div>
            <div class="muted">{{ stats?.goroutines ?? '-' }} goroutines</div>
          </a-card>
          <a-card :bordered="false">
            <div class="stat-label">主机</div>
            <div class="stat-value">{{ stats?.hostname || info?.hostname || '-' }}</div>
            <div class="muted">{{ stats?.os }}/{{ stats?.arch }} · {{ stats?.numCpu }} 核</div>
          </a-card>
          <a-card v-if="stats?.host" :bordered="false">
            <div class="stat-label">系统负载 / 内存</div>
            <div class="stat-value">{{ Number(stats.host.load1 || 0).toFixed(2) }}</div>
            <div class="muted">已用 {{ Number(stats.host.memUsedPct || 0).toFixed(1) }}% · 磁盘剩余 {{ fmtBytes(stats.host.diskFreeBytes) }}</div>
          </a-card>
        </div>

        <a-card :bordered="false">
          <template #title>模块</template>
          <a-table :data="modules" :columns="moduleColumns" :pagination="false" row-key="name">
            <template #actions="{ record }">
              <a-space>
                <a-button size="mini" :disabled="record.running" @click="moduleAction(record, 'start')">启动</a-button>
                <a-button size="mini" :disabled="!record.running" @click="moduleAction(record, 'stop')">停止</a-button>
                <a-button size="mini" @click="moduleAction(record, 'restart')">重启</a-button>
              </a-space>
            </template>
          </a-table>
        </a-card>

        <a-card :bordered="false">
          <template #title>最近日志</template>
          <a-table :data="logs" :columns="logColumns" :pagination="false" row-key="time" size="small" />
        </a-card>
      </div>
    </a-spin>
  </div>
</template>
