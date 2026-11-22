<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Message, Modal } from '@arco-design/web-vue'
import { api, errorText } from '../api'
import { fmtTime } from '../format'

const CHALLENGE_OPTIONS = [
  { value: 'http', label: 'HTTP-01（需要 80 端口可访问）' },
  { value: 'dns', label: 'DNS-01（泛域名必须使用）' },
  { value: 'tls', label: 'TLS-ALPN-01（需要 443 端口）' },
]

const KEY_OPTIONS = [
  { value: 'ec256', label: 'ECDSA P-256（默认）' },
  { value: 'ec384', label: 'ECDSA P-384' },
  { value: 'rsa2048', label: 'RSA 2048' },
  { value: 'rsa4096', label: 'RSA 4096' },
]

const CHALLENGE_LABEL = { http: 'HTTP-01', dns: 'DNS-01', tls: 'TLS-ALPN-01' }

// Only used when /api/v1/ddns/providers cannot be read; the real form always
// comes from the provider metadata returned by the backend.
const FALLBACK_PROVIDERS = [
  {
    id: 'alidns',
    title: '阿里云解析 DNS',
    fields: [
      { key: 'accesskeyid', label: 'AccessKey ID', required: true, placeholder: 'LTAI...' },
      { key: 'accesskeysecret', label: 'AccessKey Secret', secret: true, required: true, placeholder: 'AccessKey Secret' },
    ],
  },
  {
    id: 'dnspod',
    title: 'DNSPod（腾讯云）',
    fields: [
      { key: 'id', label: '登录 Token ID', required: true, placeholder: '123456' },
      { key: 'token', label: '登录 Token', secret: true, required: true, placeholder: 'API Token' },
    ],
  },
  {
    id: 'custom',
    title: '自定义回调（Custom Callback）',
    fields: [
      { key: 'url', label: '请求 URL', required: true, placeholder: 'https://example.com/ddns?host={fqdn}&ip={ip}' },
      { key: 'method', label: '请求方法', placeholder: 'POST' },
      { key: 'headers', label: '请求头', placeholder: 'Authorization: Bearer xxx' },
      { key: 'body', label: '请求体', placeholder: '{"host":"{fqdn}","ip":"{ip}"}' },
      { key: 'user', label: 'BasicAuth 用户名', placeholder: '可选' },
      { key: 'pass', label: 'BasicAuth 密码', secret: true, placeholder: '可选' },
    ],
  },
]

const jobs = ref([])
const certs = ref([])
const providers = ref([])
const loading = ref(true)
const saving = ref(false)
const busyId = ref('')
const jobModal = ref(false)
const uploadModal = ref(false)
const editingId = ref('')

const jobForm = reactive({
  name: '',
  enable: true,
  domainsText: '',
  keyType: 'ec256',
  challenge: 'http',
  dnsProvider: '',
  dnsCreds: {},
  dnsResolversText: '',
  renewDays: 30,
  remark: '',
})

const uploadForm = reactive({
  name: '',
  domainsText: '',
  cert: '',
  key: '',
  chain: '',
})

const certFile = ref(null)
const keyFile = ref(null)
const pollTimers = new Set()

const editing = computed(() => !!editingId.value)
const jobTitle = computed(() => (editing.value ? '编辑证书任务' : '新建证书任务'))

const jobColumns = [
  { title: '域名', dataIndex: 'domainsJoined', slotName: 'domains', ellipsis: true, tooltip: true },
  { title: '挑战方式', dataIndex: 'challenge', slotName: 'challenge', width: 120 },
  { title: 'DNS 提供商', dataIndex: 'dnsProvider', slotName: 'provider', width: 160, ellipsis: true, tooltip: true },
  { title: '续期天数', dataIndex: 'renewDays', slotName: 'renewDays', width: 100 },
  { title: '启用', dataIndex: 'enable', slotName: 'enable', width: 90 },
  { title: '操作', slotName: 'actions', width: 220 },
]

const certColumns = [
  { title: '域名', dataIndex: 'domains', slotName: 'domains' },
  { title: '颁发者', dataIndex: 'issuer', ellipsis: true, tooltip: true },
  { title: '到期时间', dataIndex: 'notAfter', slotName: 'notAfter', width: 180 },
  { title: '剩余天数', dataIndex: 'daysLeft', slotName: 'daysLeft', width: 110 },
  { title: '来源', dataIndex: 'source', slotName: 'source', width: 100 },
  { title: '操作', slotName: 'actions', width: 90 },
]

function normalizeKeyType(value) {
  const key = String(value || '').trim().toLowerCase()
  return KEY_OPTIONS.some((item) => item.value === key) ? key : 'ec256'
}

function normalizeChallenge(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'dns' || raw === 'dns-01') return 'dns'
  if (raw === 'tls' || raw === 'tls-alpn-01') return 'tls'
  return 'http'
}

function splitDomains(text) {
  return String(text || '')
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitLines(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function baseDomain(value) {
  const text = String(value || '')
  return text.startsWith('*.') ? text.slice(2) : text
}

function normalizeProviders(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      id: item.id,
      title: item.title || item.id,
      fields: (Array.isArray(item.fields) ? item.fields : []).map((field) => ({
        key: field.key,
        label: field.label || field.key,
        secret: !!field.secret,
        required: !!field.required,
        placeholder: field.placeholder || '',
        help: field.help || '',
      })),
      authNote: item.authNote || '',
    }))
    .filter((item) => item.id)
}

const providerFields = computed(() => {
  const provider = providers.value.find((item) => item.id === jobForm.dnsProvider)
  return provider ? provider.fields : []
})

const providerOptions = computed(() => {
  const list = providers.value.map((item) => ({ value: item.id, label: item.title }))
  if (jobForm.dnsProvider && !list.some((item) => item.value === jobForm.dnsProvider)) {
    list.push({ value: jobForm.dnsProvider, label: `${jobForm.dnsProvider}（未在提供商列表中）` })
  }
  return list
})

const providerNote = computed(() => {
  const provider = providers.value.find((item) => item.id === jobForm.dnsProvider)
  return provider ? provider.authNote : ''
})

function challengeLabel(value) {
  return CHALLENGE_LABEL[normalizeChallenge(value)] || value || '-'
}

function providerLabel(value) {
  if (!value) return '-'
  const provider = providers.value.find((item) => item.id === value)
  return provider ? provider.title : value
}

function certDomains(record) {
  const list = Array.isArray(record?.domains) ? record.domains : []
  return list.length ? list.join(', ') : '-'
}

function certDaysLeft(record) {
  const value = Number(record?.daysLeft)
  return Number.isFinite(value) ? value : 0
}

function certTone(record) {
  const days = certDaysLeft(record)
  if (record?.expired || days <= 0) return 'red'
  if (days <= 15) return 'orange'
  return 'green'
}

function certSourceLabel(source) {
  if (!source) return '-'
  if (source === 'upload') return '上传'
  if (source === 'acme') return 'ACME'
  return String(source)
}

async function loadProviders() {
  try {
    providers.value = normalizeProviders(await api.get('/api/v1/ddns/providers'))
  } catch {
    providers.value = FALLBACK_PROVIDERS.map((item) => ({ ...item, fields: item.fields.map((field) => ({ ...field })) }))
  }
}

async function loadJobs(silent = false) {
  try {
    const data = await api.get('/api/v1/acme/jobs')
    jobs.value = Array.isArray(data?.items) ? data.items : []
  } catch (err) {
    if (!silent) Message.error(`读取证书任务失败：${errorText(err)}`)
  }
}

async function loadCerts(silent = false) {
  try {
    const data = await api.get('/api/v1/acme/certificates')
    certs.value = Array.isArray(data?.items) ? data.items : []
  } catch (err) {
    if (!silent) Message.error(`读取证书仓库失败：${errorText(err)}`)
  }
}

async function loadAll() {
  loading.value = true
  try {
    await Promise.all([loadProviders(), loadJobs(), loadCerts()])
  } finally {
    loading.value = false
  }
}

function ensureCredFields() {
  for (const field of providerFields.value) {
    if (!(field.key in jobForm.dnsCreds)) jobForm.dnsCreds[field.key] = ''
  }
}

function onProviderChange() {
  // Switching provider must not carry the previous provider's secrets along.
  jobForm.dnsCreds = {}
  ensureCredFields()
}

function openJobForm(job) {
  const base = job || {}
  editingId.value = base.id || ''
  jobForm.name = base.name || ''
  jobForm.enable = base.enable !== false
  jobForm.domainsText = (Array.isArray(base.domains) ? base.domains : []).join('\n')
  jobForm.keyType = normalizeKeyType(base.keyType)
  jobForm.challenge = normalizeChallenge(base.challenge)
  jobForm.dnsProvider = base.dnsProvider || ''
  jobForm.dnsCreds = { ...(base.dnsCreds || {}) }
  jobForm.dnsResolversText = (Array.isArray(base.dnsResolvers) ? base.dnsResolvers : []).join('\n')
  jobForm.renewDays = Number(base.renewDays) || 30
  jobForm.remark = base.remark || ''
  ensureCredFields()
  jobModal.value = true
}

async function saveJob() {
  const domains = splitDomains(jobForm.domainsText)
  if (!domains.length) {
    Message.error('请至少填写一个域名')
    return false
  }
  if (jobForm.challenge === 'dns') {
    if (!jobForm.dnsProvider) {
      Message.error('DNS-01 挑战需要选择 DNS 提供商')
      return false
    }
    const missing = providerFields.value.filter((field) => field.required && !String(jobForm.dnsCreds[field.key] || '').trim())
    if (missing.length) {
      Message.error(`请填写 ${missing.map((field) => field.label).join('、')}`)
      return false
    }
  }

  const creds = {}
  if (jobForm.challenge === 'dns') {
    // Keep every stored credential, including provider fields this build of
    // the UI does not render, so a save cannot silently drop a secret.
    for (const [key, raw] of Object.entries(jobForm.dnsCreds)) {
      const value = String(raw || '').trim()
      if (value) creds[key] = value
    }
  }

  const renewDays = Number(jobForm.renewDays)
  const payload = {
    name: jobForm.name.trim(),
    enable: !!jobForm.enable,
    domains,
    keyType: normalizeKeyType(jobForm.keyType),
    challenge: normalizeChallenge(jobForm.challenge),
    dnsProvider: jobForm.challenge === 'dns' ? jobForm.dnsProvider : '',
    dnsCreds: creds,
    dnsResolvers: jobForm.challenge === 'dns' ? splitLines(jobForm.dnsResolversText) : [],
    renewDays: Number.isFinite(renewDays) && renewDays > 0 ? Math.min(30, Math.floor(renewDays)) : 30,
    remark: jobForm.remark.trim(),
  }

  saving.value = true
  try {
    if (editing.value) {
      await api.put(`/api/v1/acme/jobs/${encodeURIComponent(editing.value)}`, payload)
    } else {
      await api.post('/api/v1/acme/jobs', payload)
    }
    Message.success('证书任务已保存')
    await loadJobs()
    return true
  } catch (err) {
    Message.error(`保存失败：${errorText(err)}`)
    return false
  } finally {
    saving.value = false
  }
}

async function toggleJob(job, next) {
  busyId.value = job.id
  try {
    await api.post(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}/toggle`, { enable: next })
    Message.success(next ? '已启用' : '已停用')
    await loadJobs()
  } catch (err) {
    Message.error(`切换失败：${errorText(err)}`)
  } finally {
    busyId.value = ''
  }
}

function deleteJob(job) {
  Modal.confirm({
    title: '删除证书任务',
    content: `确定删除「${job.name || job.domainsJoined || job.id}」吗？已签发的证书不会被删除。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}`)
        Message.success('已删除')
        await loadJobs()
      } catch (err) {
        Message.error(`删除失败：${errorText(err)}`)
      }
    },
  })
}

function waitForCertificate(job) {
  const wanted = (Array.isArray(job?.domains) ? job.domains : []).map(baseDomain).filter(Boolean)
  if (!wanted.length) return
  let polls = 0
  const tick = async () => {
    polls += 1
    await loadCerts(true)
    const hit = certs.value.find((cert) => {
      const names = (Array.isArray(cert?.domains) ? cert.domains : []).map(baseDomain)
      return wanted.every((name) => names.includes(name))
    })
    if (hit) {
      Message.success(`证书已签发：${certDomains(hit)}`)
      await loadJobs(true)
      return
    }
    if (polls >= 12) {
      Message.info('签发仍在后台进行，可稍后在证书仓库查看结果')
      return
    }
    const timer = setTimeout(tick, 5000)
    pollTimers.add(timer)
  }
  const timer = setTimeout(tick, 5000)
  pollTimers.add(timer)
}

function issueJob(job) {
  Modal.confirm({
    title: '立即签发证书',
    content: `将立即为「${job.name || job.domainsJoined || job.id}」申请证书。签发在后台异步执行，通常需要几十秒到几分钟。`,
    okText: '开始签发',
    cancelText: '取消',
    onOk: async () => {
      busyId.value = job.id
      try {
        await api.post(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}/issue`)
        Message.success('签发请求已提交，正在等待结果…')
        waitForCertificate(job)
      } catch (err) {
        Message.error(`签发失败：${errorText(err)}`)
      } finally {
        busyId.value = ''
      }
    },
  })
}

function deleteCert(cert) {
  Modal.confirm({
    title: '删除证书',
    content: `确定删除证书「${certDomains(cert)}」吗？使用该证书的站点会失去 TLS。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await api.del(`/api/v1/acme/certificates/${encodeURIComponent(cert.id)}`)
        Message.success('已删除')
        await loadCerts()
      } catch (err) {
        Message.error(`删除失败：${errorText(err)}`)
      }
    },
  })
}

function openUpload() {
  uploadForm.name = ''
  uploadForm.domainsText = ''
  uploadForm.cert = ''
  uploadForm.key = ''
  uploadForm.chain = ''
  uploadModal.value = true
}

async function readPem(event, field) {
  const file = event?.target?.files?.[0]
  if (!file) return
  try {
    uploadForm[field] = await file.text()
    Message.success(`已读取 ${file.name}`)
  } catch {
    Message.error('读取文件失败')
  } finally {
    if (event?.target) event.target.value = ''
  }
}

async function uploadCertificate() {
  if (!uploadForm.cert.trim()) {
    Message.error('请填写证书 PEM')
    return false
  }
  if (!uploadForm.key.trim()) {
    Message.error('请填写私钥 PEM')
    return false
  }
  const cert = uploadForm.cert.trim()
  const key = uploadForm.key.trim()
  const payload = {
    name: uploadForm.name.trim(),
    domains: splitDomains(uploadForm.domainsText),
    cert,
    certificate: cert,
    key,
    privateKey: key,
  }
  if (uploadForm.chain.trim()) payload.chain = uploadForm.chain.trim()

  saving.value = true
  try {
    await api.post('/api/v1/acme/certificates/upload', payload)
    Message.success('证书已上传')
    await loadCerts()
    return true
  } catch (err) {
    Message.error(`上传失败：${errorText(err)}`)
    return false
  } finally {
    saving.value = false
  }
}

onMounted(loadAll)

onUnmounted(() => {
  for (const timer of pollTimers) clearTimeout(timer)
  pollTimers.clear()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>证书</h2>
        <div class="sub">
          共 {{ jobs.length }} 个证书任务、{{ certs.length }} 张证书；DNS 凭据由 DDNS 提供商元数据动态生成
        </div>
      </div>
      <div class="spacer" />
      <a-button :loading="loading" @click="loadAll">刷新</a-button>
      <a-button @click="openUpload">上传证书</a-button>
      <a-button type="primary" @click="openJobForm(null)">新建任务</a-button>
    </div>

    <a-spin :loading="loading" style="width: 100%">
      <div class="stack">
        <a-card :bordered="false">
          <template #title>证书任务</template>
          <template #extra>
            <span class="muted">自动续期只在任务启用时参与</span>
          </template>
          <a-table
            :data="jobs"
            :columns="jobColumns"
            :pagination="false"
            row-key="id"
            :scroll="{ x: 980 }"
            size="small"
          >
            <template #domains="{ record }">
              <div>
                <div class="mono">{{ record.domainsJoined || (record.domains || []).join(', ') || '-' }}</div>
                <div v-if="record.remark" class="muted cell-note">{{ record.remark }}</div>
              </div>
            </template>
            <template #challenge="{ record }">
              <a-tag>{{ challengeLabel(record.challenge) }}</a-tag>
            </template>
            <template #provider="{ record }">
              <span v-if="normalizeChallenge(record.challenge) === 'dns'" class="mono">
                {{ providerLabel(record.dnsProvider) }}
              </span>
              <span v-else class="muted">不使用</span>
            </template>
            <template #renewDays="{ record }">
              {{ record.renewDays || 30 }} 天
            </template>
            <template #enable="{ record }">
              <a-switch
                size="small"
                :model-value="!!record.enable"
                :loading="busyId === record.id"
                @change="(value) => toggleJob(record, value)"
              />
            </template>
            <template #actions="{ record }">
              <a-space>
                <a-button size="mini" :loading="busyId === record.id" @click="issueJob(record)">签发</a-button>
                <a-button size="mini" @click="openJobForm(record)">编辑</a-button>
                <a-button size="mini" status="danger" @click="deleteJob(record)">删除</a-button>
              </a-space>
            </template>
            <template #empty>
              <a-empty description="还没有证书任务，点右上角「新建任务」创建" />
            </template>
          </a-table>
        </a-card>

        <a-card :bordered="false">
          <template #title>证书仓库</template>
          <template #extra>
            <span class="muted">上传或自动签发的证书都保存在这里</span>
          </template>
          <a-table
            :data="certs"
            :columns="certColumns"
            :pagination="false"
            row-key="id"
            :scroll="{ x: 960 }"
            size="small"
          >
            <template #domains="{ record }">
              <span class="mono">{{ certDomains(record) }}</span>
            </template>
            <template #notAfter="{ record }">
              <span>{{ fmtTime(record.notAfter) }}</span>
              <div v-if="record.expired" class="muted cell-note">已过期</div>
            </template>
            <template #daysLeft="{ record }">
              <a-tag :color="certTone(record)">
                {{ record.expired ? '已过期' : `${certDaysLeft(record)} 天` }}
              </a-tag>
            </template>
            <template #source="{ record }">
              <a-tag>{{ certSourceLabel(record.source) }}</a-tag>
            </template>
            <template #actions="{ record }">
              <a-button size="mini" status="danger" @click="deleteCert(record)">删除</a-button>
            </template>
            <template #empty>
              <a-empty description="证书仓库为空" />
            </template>
          </a-table>
        </a-card>
      </div>
    </a-spin>

    <a-modal
      v-model:visible="jobModal"
      :title="jobTitle"
      :width="760"
      :ok-loading="saving"
      ok-text="保存"
      cancel-text="取消"
      :mask-closable="false"
      :on-before-ok="saveJob"
    >
      <a-form :model="jobForm" layout="vertical">
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="名称">
              <a-input v-model="jobForm.name" placeholder="例如 主站证书（留空则使用第一个域名）" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="启用">
              <a-switch v-model="jobForm.enable" />
              <span class="muted inline-note">参与自动续期</span>
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item label="域名" required>
          <a-textarea
            v-model="jobForm.domainsText"
            :auto-size="{ minRows: 3, maxRows: 6 }"
            placeholder="每行一个域名：&#10;example.com&#10;*.example.com"
          />
          <template #extra>
            <span class="muted">每行一个域名；泛域名必须使用 DNS-01 挑战</span>
          </template>
        </a-form-item>

        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="挑战方式">
              <a-select v-model="jobForm.challenge" :options="CHALLENGE_OPTIONS" @change="ensureCredFields" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="密钥类型">
              <a-select v-model="jobForm.keyType" :options="KEY_OPTIONS" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="续期提前天数">
              <a-input-number v-model="jobForm.renewDays" :min="0" :max="30" style="width: 100%" />
              <template #extra>
                <span class="muted">0 表示默认 30 天，最大 30 天</span>
              </template>
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="备注">
              <a-input v-model="jobForm.remark" placeholder="备注（可选）" />
            </a-form-item>
          </a-col>
        </a-row>

        <template v-if="jobForm.challenge === 'dns'">
          <a-divider orientation="left">DNS 挑战</a-divider>
          <a-form-item label="DNS 提供商" required>
            <a-select
              v-model="jobForm.dnsProvider"
              placeholder="选择 DNS 提供商"
              allow-clear
              @change="onProviderChange"
            >
              <a-option v-for="provider in providerOptions" :key="provider.value" :value="provider.value">
                {{ provider.label }}
              </a-option>
            </a-select>
            <template #extra>
              <span v-if="providerNote" class="muted">{{ providerNote }}</span>
            </template>
          </a-form-item>

          <a-row v-if="providerFields.length" :gutter="16">
            <a-col v-for="field in providerFields" :key="field.key" :span="12">
              <a-form-item :label="field.label" :required="field.required">
                <a-input-password
                  v-if="field.secret"
                  v-model="jobForm.dnsCreds[field.key]"
                  :placeholder="field.placeholder || (editing ? '留空或保持 ******** 表示不修改' : '')"
                />
                <a-input
                  v-else
                  v-model="jobForm.dnsCreds[field.key]"
                  :placeholder="field.placeholder || (editing ? '留空或保持 ******** 表示不修改' : '')"
                />
                <template #extra>
                  <span class="muted">{{ field.help }}</span>
                </template>
              </a-form-item>
            </a-col>
          </a-row>
          <div v-if="editing && providerFields.length" class="muted cell-note credential-note">
            已保存的凭据显示为 ********；保持原值即表示不修改，填写新值才会覆盖。
          </div>

          <a-form-item label="DNS 解析服务器">
            <a-textarea
              v-model="jobForm.dnsResolversText"
              :auto-size="{ minRows: 2, maxRows: 4 }"
              placeholder="每行一个，例如：&#10;1.1.1.1:53&#10;8.8.8.8:53"
            />
            <template #extra>
              <span class="muted">校验 TXT 记录时使用的解析服务器，留空使用系统默认</span>
            </template>
          </a-form-item>
        </template>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="uploadModal"
      title="上传证书"
      :width="760"
      :ok-loading="saving"
      ok-text="上传"
      cancel-text="取消"
      :mask-closable="false"
      :on-before-ok="uploadCertificate"
    >
      <a-form :model="uploadForm" layout="vertical">
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="名称">
              <a-input v-model="uploadForm.name" placeholder="名称（可选）" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="域名">
              <a-input v-model="uploadForm.domainsText" placeholder="example.com, *.example.com（可选）" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item label="证书（PEM）" required>
          <div class="toolbar">
            <a-button size="small" @click="certFile?.click()">选择文件…</a-button>
            <span class="muted">也可以直接粘贴 PEM 文本</span>
          </div>
          <a-textarea
            v-model="uploadForm.cert"
            :auto-size="{ minRows: 6, maxRows: 12 }"
            placeholder="-----BEGIN CERTIFICATE-----"
          />
          <input ref="certFile" type="file" accept=".pem,.crt,.cer,.txt" class="hidden-file" @change="readPem($event, 'cert')" />
        </a-form-item>

        <a-form-item label="私钥（PEM）" required>
          <div class="toolbar">
            <a-button size="small" @click="keyFile?.click()">选择文件…</a-button>
            <span class="muted">也可以直接粘贴 PEM 文本</span>
          </div>
          <a-textarea
            v-model="uploadForm.key"
            :auto-size="{ minRows: 6, maxRows: 12 }"
            placeholder="-----BEGIN PRIVATE KEY-----"
          />
          <input ref="keyFile" type="file" accept=".pem,.key,.txt" class="hidden-file" @change="readPem($event, 'key')" />
        </a-form-item>

        <a-form-item label="证书链（可选）">
          <a-textarea
            v-model="uploadForm.chain"
            :auto-size="{ minRows: 2, maxRows: 6 }"
            placeholder="中间证书链（可选）"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.cell-note {
  margin-top: 2px;
  font-size: 11px;
}

.inline-note {
  margin-left: 8px;
  font-size: 12px;
}

.hidden-file {
  display: none;
}

.credential-note {
  margin-bottom: 10px;
}
</style>
