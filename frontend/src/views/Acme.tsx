import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tabs } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtTime, splitLines, splitList } from '../format'
import { usePolling } from '../usePolling'
import {
  AlertBox,
  ConfirmModal,
  DataTable,
  FormModal,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  SelectInput,
  StatusChip,
  SwitchInput,
  TextAreaInput,
  TextInput,
  toast,
  type Column,
  type SelectOption,
} from '../ui'

type KeyType = 'ec256' | 'ec384' | 'rsa2048' | 'rsa4096'
type Challenge = 'http' | 'dns' | 'tls'
type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'danger'

const KEY_OPTIONS: SelectOption[] = [
  { value: 'ec256', label: 'ECDSA P-256（默认）' },
  { value: 'ec384', label: 'ECDSA P-384' },
  { value: 'rsa2048', label: 'RSA 2048' },
  { value: 'rsa4096', label: 'RSA 4096' },
]

const CHALLENGE_OPTIONS: SelectOption[] = [
  { value: 'http', label: 'HTTP-01（需要 80 端口可访问）' },
  { value: 'dns', label: 'DNS-01（泛域名必须使用）' },
  { value: 'tls', label: 'TLS-ALPN-01（需要 443 端口）' },
]

const CHALLENGE_LABEL: Record<Challenge, string> = {
  http: 'HTTP-01',
  dns: 'DNS-01',
  tls: 'TLS-ALPN-01',
}

interface ProviderField {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder: string
  help: string
}

interface Provider {
  id: string
  title: string
  fields: ProviderField[]
  authNote: string
}

interface AcmeJob {
  id: string
  name: string
  enable: boolean
  domains: string[]
  domainsJoined?: string
  keyType?: string
  challenge?: string
  dnsProvider?: string
  dnsCreds?: Record<string, string>
  dnsResolvers?: string[]
  renewDays?: number
  remark?: string
}

interface Certificate {
  id: string
  domains: string[]
  issuer: string
  notBefore?: string
  notAfter: string
  source?: string
  remark?: string
  daysLeft?: number
  expired?: boolean
}

interface AcmeConfig {
  email: string
  keyType: string
  staging?: boolean
  directory?: string
  keyTypes?: { id: string; title: string }[]
}

interface JobFormState {
  name: string
  enable: boolean
  domainsText: string
  keyType: KeyType
  challenge: Challenge
  dnsProvider: string
  dnsCreds: Record<string, string>
  dnsResolversText: string
  renewDays: number
  remark: string
}

interface UploadFormState {
  name: string
  domainsText: string
  cert: string
  key: string
  chain: string
}

const EMPTY_JOB: JobFormState = {
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
}

function normalizeKeyType(value: unknown): KeyType {
  const key = String(value || '').trim().toLowerCase()
  return KEY_OPTIONS.some((item) => item.value === key) ? (key as KeyType) : 'ec256'
}

function normalizeChallenge(value: unknown): Challenge {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'dns' || raw === 'dns-01') return 'dns'
  if (raw === 'tls' || raw === 'tls-alpn-01') return 'tls'
  return 'http'
}

function baseDomain(value: string): string {
  return value.startsWith('*.') ? value.slice(2) : value
}

function normalizeProviders(list: unknown): Provider[] {
  return (Array.isArray(list) ? list : [])
    .map((raw) => {
      const item = (raw || {}) as Record<string, unknown>
      return {
        id: String(item.id || ''),
        title: String(item.title || item.id || ''),
        fields: (Array.isArray(item.fields) ? item.fields : []).map((rawField) => {
          const field = (rawField || {}) as Record<string, unknown>
          return {
            key: String(field.key || ''),
            label: String(field.label || field.key || ''),
            secret: !!field.secret,
            required: !!field.required,
            placeholder: String(field.placeholder || ''),
            help: String(field.help || ''),
          }
        }),
        authNote: String(item.authNote || ''),
      }
    })
    .filter((item) => item.id)
}

function challengeLabel(value: unknown): string {
  return CHALLENGE_LABEL[normalizeChallenge(value)]
}

function certDomains(record: Certificate): string {
  return Array.isArray(record.domains) && record.domains.length ? record.domains.join(', ') : '-'
}

function certDaysLeft(record: Certificate): number {
  const value = Number(record.daysLeft)
  return Number.isFinite(value) ? value : 0
}

function certTone(record: Certificate): ChipColor {
  const days = certDaysLeft(record)
  if (record.expired || days <= 0) return 'danger'
  if (days <= 15) return 'warning'
  return 'success'
}

function certSourceLabel(source?: string): string {
  if (!source) return '-'
  if (source === 'upload') return '上传'
  if (source === 'acme') return 'ACME'
  return source
}

function jobLabel(job: AcmeJob | null): string {
  if (!job) return ''
  return job.name || job.domainsJoined || (job.domains || []).join(', ') || job.id
}

export default function Acme() {
  const [jobs, setJobs] = useState<AcmeJob[]>([])
  const [certs, setCerts] = useState<Certificate[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [config, setConfig] = useState<AcmeConfig>({ email: '', keyType: 'ec256' })
  const [loading, setLoading] = useState(true)

  const [jobOpen, setJobOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [jobSaving, setJobSaving] = useState(false)
  const [uploadSaving, setUploadSaving] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)

  const [jobForm, setJobForm] = useState<JobFormState>({ ...EMPTY_JOB, dnsCreds: {} })
  const [jobAdvanced, setJobAdvanced] = useState(false)
  const [uploadForm, setUploadForm] = useState<UploadFormState>({
    name: '',
    domainsText: '',
    cert: '',
    key: '',
    chain: '',
  })
  const [configForm, setConfigForm] = useState({ email: '', keyType: 'ec256' as KeyType, staging: false })

  const [deleteJobTarget, setDeleteJobTarget] = useState<AcmeJob | null>(null)
  const [deleteCertTarget, setDeleteCertTarget] = useState<Certificate | null>(null)
  const [issueTarget, setIssueTarget] = useState<AcmeJob | null>(null)

  const certFileRef = useRef<HTMLInputElement>(null)
  const keyFileRef = useRef<HTMLInputElement>(null)
  const chainFileRef = useRef<HTMLInputElement>(null)
  const pollTimers = useRef<number[]>([])

  const providerFields = useMemo(
    () => providers.find((item) => item.id === jobForm.dnsProvider)?.fields ?? [],
    [providers, jobForm.dnsProvider],
  )

  const providerNote = useMemo(
    () => providers.find((item) => item.id === jobForm.dnsProvider)?.authNote ?? '',
    [providers, jobForm.dnsProvider],
  )

  const providerOptions = useMemo<SelectOption[]>(() => {
    const list = providers.map((item) => ({ value: item.id, label: item.title }))
    if (jobForm.dnsProvider && !list.some((item) => item.value === jobForm.dnsProvider)) {
      list.push({ value: jobForm.dnsProvider, label: `${jobForm.dnsProvider}（未在提供商列表中）` })
    }
    return list
  }, [providers, jobForm.dnsProvider])

  const keyOptions = useMemo<SelectOption[]>(() => {
    const list = (config.keyTypes || [])
      .map((item) => ({ value: item.id, label: item.title }))
      .filter((item) => item.value)
    return list.length ? list : KEY_OPTIONS
  }, [config.keyTypes])

  const editing = !!editingId

  const credsForProvider = (providerId: string, base: Record<string, string> = {}) => {
    const provider = providers.find((item) => item.id === providerId)
    const creds = { ...base }
    for (const field of provider?.fields ?? []) {
      if (!(field.key in creds)) creds[field.key] = ''
    }
    return creds
  }

  const loadConfig = async () => {
    try {
      const data = await api.get<AcmeConfig>('/api/v1/acme/config')
      const next: AcmeConfig = {
        email: data?.email || '',
        keyType: normalizeKeyType(data?.keyType),
        staging: !!data?.staging,
        keyTypes: Array.isArray(data?.keyTypes) ? data.keyTypes : undefined,
      }
      setConfig(next)
      setConfigForm({ email: next.email, keyType: next.keyType as KeyType, staging: !!next.staging })
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const loadProviders = async () => {
    try {
      setProviders(normalizeProviders(await api.get('/api/v1/ddns/providers')))
    } catch (err) {
      setProviders([])
      toast.danger(errorText(err))
    }
  }

  const loadJobs = async (silent = false): Promise<AcmeJob[]> => {
    try {
      const data = await api.get<{ items?: AcmeJob[] }>('/api/v1/acme/jobs')
      const items = Array.isArray(data?.items) ? data.items : []
      setJobs(items)
      return items
    } catch (err) {
      if (!silent) toast.danger(errorText(err))
      return []
    }
  }

  const loadCerts = async (silent = false): Promise<Certificate[]> => {
    try {
      const data = await api.get<{ items?: Certificate[] }>('/api/v1/acme/certificates')
      const items = Array.isArray(data?.items) ? data.items : []
      setCerts(items)
      return items
    } catch (err) {
      if (!silent) toast.danger(errorText(err))
      return []
    }
  }

  // The ACME module keeps the last failure. Report it as a toast, once per
  // distinct message: a banner on every visit was noise, and the persistent
  // hint lives in the header indicator.
  const notifiedError = useRef('')
  const loadHealth = async () => {
    try {
      const data = await api.get<{ acme?: { lastError?: string | null } }>('/api/v1/system/health')
      const message = String(data?.acme?.lastError || '')
      if (!message) {
        notifiedError.current = ''
        return
      }
      if (message === notifiedError.current) return
      notifiedError.current = message
      toast.danger(`证书任务失败：${message}`, { timeout: 12000 })
    } catch {
      // Health is best effort; the header indicator reports what it can.
    }
  }

  usePolling(loadHealth, 30000)

  const loadAll = async () => {
    setLoading(true)
    try {
      await Promise.all([loadProviders(), loadJobs(), loadCerts(), loadConfig(), loadHealth()])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
    return () => {
      for (const timer of pollTimers.current) window.clearTimeout(timer)
      pollTimers.current = []
    }
    // The page loads its data once; every later refresh is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openJobForm = (job: AcmeJob | null) => {
    const challenge = normalizeChallenge(job?.challenge)
    const dnsProvider = job?.dnsProvider || ''
    const baseCreds = job?.dnsCreds ? { ...job.dnsCreds } : {}
    setEditingId(job?.id || '')
    setJobForm({
      name: job?.name || '',
      enable: job?.enable !== false,
      domainsText: (Array.isArray(job?.domains) ? job.domains : []).join('\n'),
      keyType: normalizeKeyType(job?.keyType),
      challenge,
      dnsProvider,
      dnsCreds: challenge === 'dns' ? credsForProvider(dnsProvider, baseCreds) : baseCreds,
      dnsResolversText: (Array.isArray(job?.dnsResolvers) ? job.dnsResolvers : []).join('\n'),
      renewDays: Number(job?.renewDays) || 30,
      remark: job?.remark || '',
    })
    setJobAdvanced(
      !!job && (Number(job.renewDays) !== 30 || !!job.remark || (job.dnsResolvers || []).length > 0),
    )
    setJobOpen(true)
  }

  const handleChallengeChange = (value: string) => {
    const challenge = normalizeChallenge(value)
    setJobForm((prev) => ({
      ...prev,
      challenge,
      dnsCreds: challenge === 'dns' ? credsForProvider(prev.dnsProvider, prev.dnsCreds) : prev.dnsCreds,
    }))
  }

  const handleProviderChange = (value: string) => {
    setJobForm((prev) =>
      prev.dnsProvider === value
        ? prev
        : {
            ...prev,
            dnsProvider: value,
            dnsCreds: credsForProvider(value),
          },
    )
  }

  const setCredential = (key: string, value: string) => {
    setJobForm((prev) => ({ ...prev, dnsCreds: { ...prev.dnsCreds, [key]: value } }))
  }

  const saveConfig = async () => {
    const email = configForm.email.trim()
    if (email && !email.includes('@')) {
      toast.warning('联系邮箱格式不正确')
      return
    }
    setConfigSaving(true)
    try {
      await api.put('/api/v1/acme/config', { email, keyType: configForm.keyType, staging: configForm.staging })
      toast.success('ACME 设置已保存')
      setConfigOpen(false)
      await loadConfig()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setConfigSaving(false)
    }
  }

  const saveJob = async () => {
    const domains = splitList(jobForm.domainsText)
    if (!domains.length) {
      toast.warning('请至少填写一个域名')
      return
    }
    if (jobForm.challenge === 'dns') {
      if (!jobForm.dnsProvider) {
        toast.warning('DNS-01 挑战需要选择 DNS 提供商')
        return
      }
      const missing = providerFields.filter(
        (field) => field.required && !String(jobForm.dnsCreds[field.key] || '').trim(),
      )
      if (missing.length) {
        toast.warning(`请填写 ${missing.map((field) => field.label).join('、')}`)
        return
      }
    }

    const creds: Record<string, string> = {}
    if (jobForm.challenge === 'dns') {
      // Keep every stored credential, including fields this build of the UI
      // does not render, so a save cannot silently drop a secret.
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

    setJobSaving(true)
    try {
      if (editing) {
        await api.put(`/api/v1/acme/jobs/${encodeURIComponent(editingId)}`, payload)
      } else {
        await api.post('/api/v1/acme/jobs', payload)
      }
      toast.success('证书任务已保存')
      setJobOpen(false)
      await loadJobs()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setJobSaving(false)
    }
  }

  const toggleJob = async (job: AcmeJob, next: boolean) => {
    setBusyId(job.id)
    try {
      await api.post(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}/toggle`, { enable: next })
      toast.success(next ? '已启用' : '已停用')
      await loadJobs()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const confirmDeleteJob = async () => {
    const target = deleteJobTarget
    if (!target) return
    setDeleteJobTarget(null)
    try {
      await api.del(`/api/v1/acme/jobs/${encodeURIComponent(target.id)}`)
      toast.success('已删除')
      await loadJobs()
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const waitForCertificate = (job: AcmeJob) => {
    const wanted = (Array.isArray(job.domains) ? job.domains : []).map(baseDomain).filter(Boolean)
    if (!wanted.length) return
    let polls = 0
    const tick = async () => {
      polls += 1
      const list = await loadCerts(true)
      const hit = list.find((cert) => {
        const names = (Array.isArray(cert.domains) ? cert.domains : []).map(baseDomain)
        return wanted.every((name) => names.includes(name))
      })
      if (hit) {
        toast.success(`证书已签发：${certDomains(hit)}`)
        await loadJobs(true)
        return
      }
      if (polls >= 12) {
        toast.info('签发仍在后台进行，可稍后在证书仓库查看结果')
        return
      }
      pollTimers.current.push(window.setTimeout(() => void tick(), 5000))
    }
    pollTimers.current.push(window.setTimeout(() => void tick(), 5000))
  }

  const confirmIssue = async () => {
    const target = issueTarget
    if (!target) return
    setIssueTarget(null)
    setBusyId(target.id)
    try {
      await api.post(`/api/v1/acme/jobs/${encodeURIComponent(target.id)}/issue`)
      toast.success('签发请求已提交，正在等待结果…')
      waitForCertificate(target)
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const confirmDeleteCert = async () => {
    const target = deleteCertTarget
    if (!target) return
    setDeleteCertTarget(null)
    try {
      await api.del(`/api/v1/acme/certificates/${encodeURIComponent(target.id)}`)
      toast.success('已删除')
      await loadCerts()
    } catch (err) {
      toast.danger(errorText(err))
    }
  }

  const downloadCertificate = (cert: Certificate) => {
    window.open(`/api/v1/acme/certificates/${encodeURIComponent(cert.id)}/download`, '_blank', 'noopener,noreferrer')
  }

  const openUpload = () => {
    setUploadForm({ name: '', domainsText: '', cert: '', key: '', chain: '' })
    setUploadOpen(true)
  }

  const readPem = async (event: React.ChangeEvent<HTMLInputElement>, field: 'cert' | 'key' | 'chain') => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      setUploadForm((prev) => ({ ...prev, [field]: text }))
      toast.success(`已读取 ${file.name}`)
    } catch {
      toast.danger('读取文件失败')
    } finally {
      input.value = ''
    }
  }

  const uploadCertificate = async () => {
    if (!uploadForm.cert.trim()) {
      toast.warning('请填写证书 PEM')
      return
    }
    if (!uploadForm.key.trim()) {
      toast.warning('请填写私钥 PEM')
      return
    }
    const cert = uploadForm.cert.trim()
    const key = uploadForm.key.trim()
    const payload: Record<string, unknown> = {
      name: uploadForm.name.trim(),
      domains: splitList(uploadForm.domainsText),
      cert,
      certificate: cert,
      key,
      privateKey: key,
    }
    if (uploadForm.chain.trim()) payload.chain = uploadForm.chain.trim()

    setUploadSaving(true)
    try {
      await api.post('/api/v1/acme/certificates/upload', payload)
      toast.success('证书已上传')
      setUploadOpen(false)
      await loadCerts()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setUploadSaving(false)
    }
  }

  const jobColumns: Column<AcmeJob>[] = [
    {
      key: 'domains',
      title: '域名',
      render: (record) => (
        <div>
          <div className="mono text-xs">{record.domainsJoined || (record.domains || []).join(', ') || '-'}</div>
          {record.remark ? <div className="mt-0.5 text-xs text-muted">{record.remark}</div> : null}
        </div>
      ),
    },
    {
      key: 'challenge',
      title: '挑战方式',
      render: (record) => <StatusChip>{challengeLabel(record.challenge)}</StatusChip>,
    },
    {
      key: 'provider',
      title: 'DNS 提供商',
      render: (record) =>
        normalizeChallenge(record.challenge) === 'dns' ? (
          <span className="mono text-xs">
            {providers.find((item) => item.id === record.dnsProvider)?.title || record.dnsProvider || '-'}
          </span>
        ) : (
          <span className="text-xs text-muted">不使用</span>
        ),
    },
    {
      key: 'renewDays',
      title: '续期天数',
      render: (record) => `${record.renewDays || 30} 天`,
    },
    {
      key: 'enable',
      title: '启用',
      render: (record) => (
        <SwitchInput
          label=""
          value={!!record.enable}
          disabled={busyId === record.id}
          onChange={(next) => void toggleJob(record, next)}
        />
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (record) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="tertiary" isDisabled={busyId === record.id} onPress={() => setIssueTarget(record)}>
            签发
          </Button>
          <Button size="sm" variant="secondary" onPress={() => openJobForm(record)}>
            编辑
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => setDeleteJobTarget(record)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  const certColumns: Column<Certificate>[] = [
    {
      key: 'remark',
      title: '备注',
      render: (record) => <span className="text-xs">{record.remark || '-'}</span>,
    },
    {
      key: 'domains',
      title: '域名',
      render: (record) => <span className="mono text-xs">{certDomains(record)}</span>,
    },
    {
      key: 'issuer',
      title: '颁发者',
      render: (record) => <span className="text-xs">{record.issuer || '-'}</span>,
    },
    {
      key: 'notAfter',
      title: '到期时间',
      render: (record) => (
        <div>
          <div className="text-xs">{fmtTime(record.notAfter)}</div>
          {record.expired ? <div className="mt-0.5 text-xs text-muted">已过期</div> : null}
        </div>
      ),
    },
    {
      key: 'daysLeft',
      title: '剩余天数',
      render: (record) => (
        <StatusChip color={certTone(record)}>
          {record.expired ? '已过期' : `${certDaysLeft(record)} 天`}
        </StatusChip>
      ),
    },
    {
      key: 'source',
      title: '来源',
      render: (record) => <StatusChip>{certSourceLabel(record.source)}</StatusChip>,
    },
    {
      key: 'actions',
      title: '操作',
      render: (record) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="tertiary" onPress={() => downloadCertificate(record)}>
            下载
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => setDeleteCertTarget(record)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="证书"
        sub={`共 ${jobs.length} 个证书任务、${certs.length} 张证书；CA：Let's Encrypt${
          config.email ? ` · ${config.email}` : ''
        }`}
        actions={
          <>
            <Button variant="secondary" isDisabled={loading} onPress={() => void loadAll()}>
              刷新
            </Button>
            <Button variant="tertiary" onPress={() => setConfigOpen(true)}>
              ACME 设置
            </Button>
            <Button variant="tertiary" onPress={openUpload}>
              上传证书
            </Button>
            <Button variant="primary" onPress={() => openJobForm(null)}>
              新建任务
            </Button>
          </>
        }
      />

      <Tabs defaultSelectedKey="certs" className="w-full">
        <Tabs.List aria-label="证书分类">
          <Tabs.Tab id="certs">证书仓库</Tabs.Tab>
          <Tabs.Tab id="jobs">证书任务</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="certs" className="pt-4">
        <Panel
          title="证书仓库"
          extra={<span className="text-xs text-muted">上传或自动签发的证书都保存在这里</span>}
        >
          <DataTable
            items={certs}
            columns={certColumns}
            rowKey={(row) => row.id}
            ariaLabel="证书仓库"
            empty="证书仓库为空"
          />
        </Panel>
        </Tabs.Panel>
        <Tabs.Panel id="jobs" className="pt-4">
        <Panel
          title="证书任务"
          extra={<span className="text-xs text-muted">自动续期只在任务启用时参与</span>}
        >
          <DataTable
            items={jobs}
            columns={jobColumns}
            rowKey={(row) => row.id}
            ariaLabel="证书任务"
            empty="还没有证书任务，点右上角「新建任务」创建"
          />
        </Panel>
        </Tabs.Panel>
      </Tabs>

      <FormModal
        open={jobOpen}
        onClose={() => setJobOpen(false)}
        title={editing ? '编辑证书任务' : '新建证书任务'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={() => setJobOpen(false)}>
              取消
            </Button>
            <Button variant="primary" isDisabled={jobSaving} onPress={() => void saveJob()}>
              {jobSaving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextInput
              label="名称"
              value={jobForm.name}
              onChange={(name) => setJobForm((prev) => ({ ...prev, name }))}
              placeholder="例如 主站证书（留空则使用第一个域名）"
            />
            <SwitchInput
              label="启用"
              value={jobForm.enable}
              onChange={(enable) => setJobForm((prev) => ({ ...prev, enable }))}
              hint="参与自动续期"
            />
          </div>

          <TextAreaInput
            label="域名"
            value={jobForm.domainsText}
            onChange={(domainsText) => setJobForm((prev) => ({ ...prev, domainsText }))}
            rows={4}
            required
            placeholder={'每行一个域名：\nexample.com\n*.example.com'}
            hint="每行一个域名；泛域名必须使用 DNS-01 挑战"
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectInput
              label="挑战方式"
              value={jobForm.challenge}
              onChange={handleChallengeChange}
              options={CHALLENGE_OPTIONS}
            />
            <SelectInput
              label="密钥类型"
              value={jobForm.keyType}
              onChange={(value) => setJobForm((prev) => ({ ...prev, keyType: normalizeKeyType(value) }))}
              options={keyOptions}
            />
          </div>

          <SwitchInput
            label="高级选项"
            value={jobAdvanced}
            onChange={setJobAdvanced}
            hint="续期提前天数、备注、DNS 解析服务器；不展开也能正常保存"
          />

          {jobAdvanced ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NumberInput
              label="续期提前天数"
              value={jobForm.renewDays}
              onChange={(renewDays) => setJobForm((prev) => ({ ...prev, renewDays }))}
              min={0}
              max={30}
              hint="0 表示默认 30 天，最大 30 天"
            />
            <TextInput
              label="备注"
              value={jobForm.remark}
              onChange={(remark) => setJobForm((prev) => ({ ...prev, remark }))}
              placeholder="备注（可选）"
            />
          </div>
          ) : null}

          {jobForm.challenge === 'dns' ? (
            <>
              <div className="border-t border-border pt-4 text-sm font-medium">DNS 挑战</div>
              <SelectInput
                label="DNS 提供商"
                value={jobForm.dnsProvider}
                onChange={handleProviderChange}
                options={providerOptions}
                placeholder="选择 DNS 提供商"
                required
                hint={providerNote || undefined}
              />

              {providerFields.length ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {providerFields.map((field) => (
                    <TextInput
                      key={field.key}
                      label={field.label}
                      value={jobForm.dnsCreds[field.key] || ''}
                      onChange={(value) => setCredential(field.key, value)}
                      type={field.secret ? 'password' : 'text'}
                      required={field.required}
                      placeholder={
                        field.placeholder || (editing ? '留空或保持 ******** 表示不修改' : '')
                      }
                      hint={field.help || undefined}
                    />
                  ))}
                </div>
              ) : null}

              {editing && providerFields.length ? (
                <div className="text-xs text-muted">
                  已保存的凭据显示为 ********；保持原值即表示不修改，填写新值才会覆盖。
                </div>
              ) : null}

              {jobAdvanced ? (
              <TextAreaInput
                label="DNS 解析服务器"
                value={jobForm.dnsResolversText}
                onChange={(dnsResolversText) =>
                  setJobForm((prev) => ({ ...prev, dnsResolversText }))
                }
                rows={2}
                placeholder={'每行一个，例如：\n1.1.1.1:53\n8.8.8.8:53'}
                hint="留空时直接检查域名的权威服务器；填写后改为检查这些解析服务器"
              />
              ) : null}
            </>
          ) : null}
        </div>
      </FormModal>

      <FormModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="上传证书"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button variant="primary" isDisabled={uploadSaving} onPress={() => void uploadCertificate()}>
              {uploadSaving ? '上传中…' : '上传'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextInput
              label="备注"
              value={uploadForm.name}
              onChange={(name) => setUploadForm((prev) => ({ ...prev, name }))}
              placeholder="备注（可选）"
            />
            <TextInput
              label="域名"
              value={uploadForm.domainsText}
              onChange={(domainsText) => setUploadForm((prev) => ({ ...prev, domainsText }))}
              placeholder="example.com, *.example.com（可选）"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <Button size="sm" variant="tertiary" onPress={() => certFileRef.current?.click()}>
                选择文件…
              </Button>
              <span className="text-xs text-muted">也可以直接粘贴 PEM 文本</span>
            </div>
            <TextAreaInput
              label="证书（PEM）"
              value={uploadForm.cert}
              onChange={(cert) => setUploadForm((prev) => ({ ...prev, cert }))}
              rows={6}
              required
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <Button size="sm" variant="tertiary" onPress={() => keyFileRef.current?.click()}>
                选择文件…
              </Button>
              <span className="text-xs text-muted">也可以直接粘贴 PEM 文本</span>
            </div>
            <TextAreaInput
              label="私钥（PEM）"
              value={uploadForm.key}
              onChange={(key) => setUploadForm((prev) => ({ ...prev, key }))}
              rows={6}
              required
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <Button size="sm" variant="tertiary" onPress={() => chainFileRef.current?.click()}>
                选择文件…
              </Button>
              <span className="text-xs text-muted">中间证书链（可选）</span>
            </div>
            <TextAreaInput
              label="证书链（可选）"
              value={uploadForm.chain}
              onChange={(chain) => setUploadForm((prev) => ({ ...prev, chain }))}
              rows={2}
              placeholder="中间证书链（可选）"
            />
          </div>

          <input
            ref={certFileRef}
            type="file"
            accept=".pem,.crt,.cer,.txt"
            className="hidden"
            onChange={(event) => void readPem(event, 'cert')}
          />
          <input
            ref={keyFileRef}
            type="file"
            accept=".pem,.key,.txt"
            className="hidden"
            onChange={(event) => void readPem(event, 'key')}
          />
          <input
            ref={chainFileRef}
            type="file"
            accept=".pem,.crt,.cer,.txt"
            className="hidden"
            onChange={(event) => void readPem(event, 'chain')}
          />
        </div>
      </FormModal>

      <FormModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title="ACME 账户设置"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={() => setConfigOpen(false)}>
              取消
            </Button>
            <Button variant="primary" isDisabled={configSaving} onPress={() => void saveConfig()}>
              {configSaving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="rounded-md border border-border bg-background-secondary p-3 text-sm text-muted">
            证书颁发机构固定为 Let&apos;s Encrypt，所有证书任务共用一个 ACME 账户。
          </div>
          <SwitchInput
            label="使用 staging（测试）环境"
            value={configForm.staging}
            onChange={(value) => setConfigForm((prev) => ({ ...prev, staging: value }))}
            hint="staging 签发的是浏览器不信任的测试证书，配额宽松，适合调试挑战；切换后需要重新签发，正式使用前务必关掉。"
          />
          {configForm.staging ? (
            <AlertBox status="warning" title="当前是测试环境">
              staging 证书不能被浏览器信任，不要把它配到对外的 Web 规则上。切换回正式环境后重新签发一次即可。
            </AlertBox>
          ) : null}
          <TextInput
            label="联系邮箱"
            value={configForm.email}
            onChange={(email) => setConfigForm((prev) => ({ ...prev, email }))}
            placeholder="ops@example.com（可选）"
            hint="注册 ACME 账户时提交；所有证书任务共用一个账户"
          />
          <SelectInput
            label="默认密钥类型"
            value={configForm.keyType}
            onChange={(value) => setConfigForm((prev) => ({ ...prev, keyType: normalizeKeyType(value) }))}
            options={keyOptions}
            hint="任务里单独设置的密钥类型会覆盖这里"
          />
        </div>
      </FormModal>

      <ConfirmModal
        open={!!deleteJobTarget}
        title="删除证书任务"
        content={`确定删除「${jobLabel(deleteJobTarget)}」吗？已签发的证书不会被删除。`}
        confirmText="删除"
        danger
        onCancel={() => setDeleteJobTarget(null)}
        onConfirm={() => void confirmDeleteJob()}
      />

      <ConfirmModal
        open={!!deleteCertTarget}
        title="删除证书"
        content={`确定删除证书「${deleteCertTarget ? certDomains(deleteCertTarget) : ''}」吗？使用该证书的站点会失去 TLS。`}
        confirmText="删除"
        danger
        onCancel={() => setDeleteCertTarget(null)}
        onConfirm={() => void confirmDeleteCert()}
      />

      <ConfirmModal
        open={!!issueTarget}
        title="立即签发证书"
        content={`将立即为「${jobLabel(issueTarget)}」申请证书。签发在后台异步执行，通常需要几十秒到几分钟。`}
        confirmText="开始签发"
        onCancel={() => setIssueTarget(null)}
        onConfirm={() => void confirmIssue()}
      />
    </Page>
  )
}
