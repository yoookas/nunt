<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { fmtTime } from '../format'

const MAX_ENTRIES = 3000
const MAX_RENDER = 2000

const LEVELS = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 }

const entries = ref([])
const level = ref('')
const keyword = ref('')
const paused = ref(false)
let droppedCount = 0
const autoScroll = ref(true)
const loading = ref(true)
const status = ref('connecting')
const streamError = ref('')
const viewRef = ref(null)

let source = null
let seq = 0
let scrollPending = false
const seen = new Set()

const statusMeta = computed(() => {
  switch (status.value) {
    case 'open':
      return { color: 'green', label: '实时连接中' }
    case 'reconnecting':
      return { color: 'orange', label: '正在重连' }
    case 'error':
      return { color: 'red', label: '连接已断开' }
    default:
      return { color: 'arcoblue', label: '正在连接' }
  }
})

const filtered = computed(() => {
  const min = level.value ? LEVEL_RANK[level.value] || 0 : 0
  const key = keyword.value.trim().toLowerCase()
  if (!min && !key) return entries.value
  return entries.value.filter((item) => {
    if (min && (LEVEL_RANK[item.level] || 20) < min) return false
    if (key && !`${item.msg} ${attrsText(item.attrs)}`.toLowerCase().includes(key)) return false
    return true
  })
})

const visible = computed(() => {
  const list = filtered.value
  return list.length > MAX_RENDER ? list.slice(list.length - MAX_RENDER) : list
})

const counter = computed(() => {
  const total = entries.value.length
  const matched = filtered.value.length
  const shown = visible.value.length
  if (matched === total) return shown === total ? `${total} 条` : `${shown} / ${total} 条`
  return `${shown} / ${matched} 条匹配（共 ${total} 条）`
})

const columns = [
  { title: '时间', dataIndex: 'time', width: 176, render: ({ record }) => fmtTime(record.time) },
  { title: '级别', dataIndex: 'level', width: 90, slotName: 'level' },
  { title: '内容', dataIndex: 'msg', slotName: 'message' },
]

function normalizeLog(entry) {
  if (entry === null || entry === undefined) return null
  if (typeof entry === 'string') {
    return { time: null, level: 'info', msg: entry, attrs: null }
  }
  if (typeof entry !== 'object') {
    return { time: null, level: 'info', msg: String(entry), attrs: null }
  }
  return {
    time: entry.time || entry.timestamp || null,
    level: String(entry.level || entry.lvl || 'info').toLowerCase(),
    msg: String(entry.msg || entry.message || ''),
    attrs: entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null,
  }
}

function attrsText(attrs) {
  if (!attrs) return ''
  const parts = []
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    let text
    if (value === null || value === undefined) text = ''
    else if (typeof value === 'object') {
      try {
        text = JSON.stringify(value)
      } catch (err) {
        text = String(value)
      }
    } else text = String(value)
    parts.push(`${key}=${text}`)
  }
  return parts.length ? `  ${parts.join('  ')}` : ''
}

function signature(item) {
  return `${item.time || ''}|${item.level}|${item.msg}|${attrsText(item.attrs)}`
}

function trimSeen() {
  if (seen.size <= MAX_ENTRIES * 2) return
  const remove = seen.size - MAX_ENTRIES
  let count = 0
  for (const key of seen) {
    if (count >= remove) break
    seen.delete(key)
    count += 1
  }
}

function pushEntry(raw) {
  const item = normalizeLog(raw)
  if (!item) return
  if (paused.value) {
    // 暂停只是当前页面不追加；不要为每条日志触发一次响应式更新。
    droppedCount += 1
    return
  }
  const key = signature(item)
  if (seen.has(key)) return
  seen.add(key)
  item.seq = seq
  seq += 1
  entries.value.push(item)
  if (entries.value.length > MAX_ENTRIES) {
    entries.value.splice(0, entries.value.length - MAX_ENTRIES)
  }
  trimSeen()
  if (autoScroll.value) scheduleScroll()
}

function scheduleScroll() {
  if (scrollPending) return
  scrollPending = true
  requestAnimationFrame(() => {
    scrollPending = false
    if (autoScroll.value) scrollToBottom()
  })
}

function scrollToBottom() {
  const view = viewRef.value
  if (view) view.scrollTop = view.scrollHeight
}

function onViewScroll(event) {
  const view = event.target
  if (!view) return
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24
  if (nearBottom !== autoScroll.value) {
    autoScroll.value = nearBottom
    if (nearBottom) scrollToBottom()
  }
}

function onAutoScrollChange(value) {
  autoScroll.value = !!value
  if (autoScroll.value) scrollToBottom()
}

function closeSource() {
  if (source) {
    source.close()
    source = null
  }
}

function connect() {
  closeSource()
  streamError.value = ''
  status.value = 'connecting'
  loading.value = entries.value.length === 0
  if (typeof EventSource === 'undefined') {
    status.value = 'error'
    loading.value = false
    streamError.value = '当前浏览器不支持 EventSource，无法接收实时日志'
    return
  }
  try {
    source = new EventSource('/api/v1/events')
  } catch (err) {
    status.value = 'error'
    loading.value = false
    streamError.value = err?.message || '无法建立事件流连接'
    return
  }
  source.onopen = () => {
    status.value = 'open'
    streamError.value = ''
    loading.value = false
  }
  source.onerror = () => {
    if (!source) return
    loading.value = false
    if (source.readyState === EventSource.CLOSED) {
      status.value = 'error'
      streamError.value = '事件流已关闭：请检查登录状态、服务端连接数上限或反向代理的 SSE 配置'
    } else {
      status.value = 'reconnecting'
      streamError.value = '事件流中断，浏览器正在自动重连…'
    }
  }
  source.onmessage = (event) => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch (err) {
      return
    }
    if (!payload || payload.type !== 'log') return
    pushEntry(payload.data)
  }
}

function togglePause() {
  paused.value = !paused.value
  if (paused.value) {
    Message.info('已暂停接收新日志，SSE 连接保持')
  } else {
    const skipped = droppedCount
    droppedCount = 0
    Message.success(skipped ? `已继续接收（暂停期间的 ${skipped} 条日志不会补发）` : '已继续接收')
    if (autoScroll.value) scheduleScroll()
  }
}

function clearView() {
  entries.value = []
  droppedCount = 0
  // 保留去重指纹：EventSource 自动重连回放的历史不会把刚清空的视图重新填满。
  loading.value = false
  Message.info('已清屏（仅清空当前视图，不影响服务端日志）')
  nextTick(() => {
    const view = viewRef.value
    if (view) view.scrollTop = 0
  })
}

function reconnect() {
  connect()
  Message.info('正在重新连接事件流…')
}

function levelClass(value) {
  const name = String(value || '').toLowerCase()
  if (name.startsWith('err') || name === 'fatal') return 'error'
  if (name.startsWith('warn')) return 'warn'
  if (name.startsWith('deb')) return 'debug'
  return 'info'
}

watch(
  () => visible.value.length,
  () => {
    if (autoScroll.value) scheduleScroll()
  },
  { flush: 'post' },
)

onMounted(connect)
onBeforeUnmount(closeSource)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>日志</h2>
        <div class="sub">通过 SSE 实时接收运行日志；连接建立后先回放服务端最近 100 条历史</div>
      </div>
      <div class="spacer" />
      <a-tag :color="statusMeta.color" size="large">{{ statusMeta.label }}</a-tag>
      <a-button @click="reconnect">重新连接</a-button>
    </div>

    <div class="stack">
      <a-alert
        v-if="streamError"
        :type="status === 'error' ? 'error' : 'warning'"
        :content="streamError"
      />
      <a-alert
        v-if="paused"
        type="warning"
        show-icon
        content="已暂停接收新日志；SSE 连接仍保持，继续后只接收之后产生的新日志。"
      />

      <a-card :bordered="false">
        <template #title>运行日志</template>
        <template #extra>
          <span class="muted counter">{{ counter }}</span>
        </template>

        <div class="toolbar log-toolbar">
          <a-select v-model="level" class="level-select" placeholder="全部级别" aria-label="日志级别过滤">
            <a-option v-for="item in LEVELS" :key="item.value" :value="item.value">{{ item.label }}</a-option>
          </a-select>
          <a-input
            v-model="keyword"
            class="keyword-input"
            placeholder="按关键字过滤…"
            aria-label="关键字过滤"
            allow-clear
          />
          <a-button :status="paused ? 'success' : 'warning'" @click="togglePause">
            {{ paused ? '继续' : '暂停' }}
          </a-button>
          <a-button @click="clearView">清屏</a-button>
          <div class="spacer" />
          <a-switch :model-value="autoScroll" size="small" aria-label="自动滚动" @change="onAutoScrollChange" />
          <span class="muted switch-label">自动滚动</span>
        </div>

        <div ref="viewRef" class="log-view" @scroll="onViewScroll">
          <a-table
            :data="visible"
            :columns="columns"
            :loading="loading"
            :pagination="false"
            size="small"
            row-key="seq"
            :bordered="false"
          >
            <template #level="{ record }">
              <span :class="['log-level', `level-${levelClass(record.level)}`]">
                {{ String(record.level || 'info').toUpperCase() }}
              </span>
            </template>
            <template #message="{ record }">
              <span :class="['log-msg', `msg-${levelClass(record.level)}`]">
                {{ record.msg }}<span v-if="attrsText(record.attrs)" class="log-attrs">{{ attrsText(record.attrs) }}</span>
              </span>
            </template>
            <template #empty>
              <a-empty :description="entries.length ? '没有匹配的日志，换个级别或关键字试试' : '暂无日志，新日志会实时出现在这里'" />
            </template>
          </a-table>
        </div>

        <div class="muted log-note">
          日志窗口最多保留 3000 条、最多渲染 2000 条；清屏只影响当前页面。SSE 中断后浏览器会自动重连，
          服务端回放的历史会按时间和内容去重。
        </div>
      </a-card>
    </div>
  </div>
</template>

<style scoped>
.counter {
  font-size: 12px;
}

.log-toolbar {
  margin-bottom: 10px;
}

.level-select {
  width: 150px;
}

.keyword-input {
  width: 240px;
}

.switch-label {
  font-size: 12px;
}

.log-view {
  height: min(62vh, 560px);
  overflow: auto;
  border: 1px solid var(--color-border-2);
  border-radius: 4px;
  background: var(--color-fill-1);
}

.log-view :deep(.arco-table) {
  background: transparent;
}

.log-view :deep(.arco-table-th) {
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-weight: 500;
}

.log-view :deep(.arco-table-td) {
  background: transparent;
  border-bottom: 1px solid var(--color-border-1);
  vertical-align: top;
}

.log-view :deep(.arco-table-tr:hover .arco-table-td) {
  background: var(--color-fill-2);
}

.log-level {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  white-space: nowrap;
}

.level-debug {
  color: rgb(var(--gray-6));
}

.level-info {
  color: rgb(var(--arcoblue-6));
}

.level-warn {
  color: rgb(var(--orange-6));
}

.level-error {
  color: rgb(var(--red-6));
}

.log-msg {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-indent: -2em;
  padding-left: 2em;
  color: var(--color-text-1);
}

.msg-warn {
  color: rgb(var(--orange-7));
}

.msg-error {
  color: rgb(var(--red-7));
}

.log-attrs {
  color: var(--color-text-3);
}

.log-note {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
}
</style>
