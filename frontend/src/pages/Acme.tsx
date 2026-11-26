import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Empty, Grid, Input, Segmented, Space, Spin, Tag, Typography } from 'antd'
import {
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import { Muted } from '../components'
import { EntityRow, PaneTitle, Workspace, type ItemStatus } from '../components/Workspace'
import { usePolling } from '../usePolling'
import CertDetail from './acme/CertDetail'
import JobEditor from './acme/JobEditor'
import RenewalOverview from './acme/RenewalOverview'
import AccountDrawer from './acme/AccountDrawer'
import UploadDrawer from './acme/UploadDrawer'
import {
  baseDomain,
  certDaysLeft,
  certDaysText,
  certDomains,
  certState,
  challengeColor,
  challengeLabel,
  jobLabel,
  jobRenewState,
  keyLabel,
  matchCertForJob,
  normalizeKeyType,
  normalizeProviders,
  parseKeyOptions,
  type AccountPayload,
  type AcmeConfig,
  type AcmeJob,
  type AcmeJobPayload,
  type AcmeStatusResponse,
  type Certificate,
  type Provider,
  type UploadPayload,
} from './acme/types'

const EMPTY_CONFIG: AcmeConfig = { email: '', keyType: 'ec256' }

type ListMode = 'certs' | 'jobs' | 'renewal'
type Selection =
  | { kind: 'cert'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'draft' }
  | { kind: 'overview' }
  | null

function certItemStatus(cert: Certificate): ItemStatus {
  if (cert.expired) return 'error'
  if (certDaysLeft(cert) <= 15) return 'warn'
  return 'ok'
}

function jobItemStatus(job: AcmeJob, cert?: Certificate): ItemStatus {
  if (!job.enable) return 'off'
  if (!cert) return 'warn'
  if (cert.expired) return 'error'
  if (certDaysLeft(cert) <= (Number(job.renewDays) || 30)) return 'warn'
  return 'ok'
}

function renewItemStatus(label: string): ItemStatus {
  if (label === '已过期') return 'error'
  if (label === '待续期' || label === '尚未签发') return 'warn'
  if (label === '已停用') return 'off'
  return 'ok'
}

export default function Acme() {
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const desktop = !!screens.lg

  const [jobs, setJobs] = useState<AcmeJob[]>([])
  const [certs, setCerts] = useState<Certificate[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [config, setConfig] = useState<AcmeConfig>(EMPTY_CONFIG)
  const [status, setStatus] = useState<AcmeStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  const [mode, setMode] = useState<ListMode>('certs')
  const [selection, setSelection] = useState<Selection>(null)
  const [draftSeq, setDraftSeq] = useState(0)
  const [query, setQuery] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)

  const pollTimers = useRef<number[]>([])

  const loadProviders = useCallback(async () => {
    try {
      setProviders(normalizeProviders(await api.get('/api/v1/acme/providers')))
    } catch (err) {
      setProviders([])
      message.error(errorText(err))
    }
  }, [message])

  const loadJobs = useCallback(
    async (silent = false): Promise<AcmeJob[]> => {
      try {
        const data = await api.get<{ items?: AcmeJob[] }>('/api/v1/acme/jobs')
        const items = Array.isArray(data?.items) ? data.items : []
        setJobs(items)
        return items
      } catch (err) {
        if (!silent) message.error(errorText(err))
        return []
      }
    },
    [message],
  )

  const loadCerts = useCallback(
    async (silent = false): Promise<Certificate[]> => {
      try {
        const data = await api.get<{ items?: Certificate[] }>('/api/v1/acme/certificates')
        const items = Array.isArray(data?.items) ? data.items : []
        setCerts(items)
        return items
      } catch (err) {
        if (!silent) message.error(errorText(err))
        return []
      }
    },
    [message],
  )

  const loadConfig = useCallback(async () => {
    try {
      const data = await api.get<AcmeConfig>('/api/v1/acme/config')
      setConfig({
        email: data?.email || '',
        keyType: normalizeKeyType(data?.keyType),
        staging: !!data?.staging,
        directory: data?.directory,
        keyTypes: Array.isArray(data?.keyTypes) ? data.keyTypes : undefined,
      })
    } catch (err) {
      message.error(errorText(err))
    }
  }, [message])

  const loadStatus = useCallback(
    async (silent = false) => {
      try {
        setStatus(await api.get<AcmeStatusResponse>('/api/v1/acme/status'))
      } catch (err) {
        if (!silent) message.error(errorText(err))
      }
    },
    [message],
  )

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([loadProviders(), loadJobs(), loadCerts(), loadConfig(), loadStatus()])
    } finally {
      setLoading(false)
    }
  }, [loadProviders, loadJobs, loadCerts, loadConfig, loadStatus])

  useEffect(() => {
    void loadAll()
    return () => {
      for (const timer of pollTimers.current) window.clearTimeout(timer)
      pollTimers.current = []
    }
  }, [loadAll])

  usePolling(() => loadStatus(true), 60000)

  const keyOptions = useMemo(() => parseKeyOptions(config.keyTypes), [config.keyTypes])
  const statusStats = status?.status?.stats
  const moduleRunning = status?.status?.running
  const lastError = statusStats?.lastError ? String(statusStats.lastError) : ''
  const enabledJobs = useMemo(() => jobs.filter((job) => job.enable).length, [jobs])
  const validCerts = useMemo(() => certs.filter((cert) => !cert.expired), [certs])

  const selectedCert =
    selection?.kind === 'cert' ? certs.find((cert) => cert.id === selection.id) : undefined
  const selectedJob =
    selection?.kind === 'job' ? jobs.find((job) => job.id === selection.id) : undefined

  const firstCertID = certs[0]?.id || ''
  const firstJobID = jobs[0]?.id || ''

  // Drop a selection whose entity disappeared after a reload.
  useEffect(() => {
    if (!selection || loading) return
    if (selection.kind === 'cert' && !certs.some((cert) => cert.id === selection.id)) {
      setSelection(null)
    } else if (selection.kind === 'job' && !jobs.some((job) => job.id === selection.id)) {
      setSelection(null)
    }
  }, [selection, certs, jobs, loading])

  // Desktop works like a command center: keep a useful detail pane open.
  useEffect(() => {
    if (!desktop || selection) return
    if (mode === 'renewal') {
      setSelection({ kind: 'overview' })
    } else if (mode === 'certs' && firstCertID) {
      setSelection({ kind: 'cert', id: firstCertID })
    } else if (mode === 'jobs' && firstJobID) {
      setSelection({ kind: 'job', id: firstJobID })
    }
  }, [desktop, selection, mode, firstCertID, firstJobID])

  const changeMode = (next: ListMode) => {
    setMode(next)
    setQuery('')
    if (!desktop) {
      setSelection(null)
      return
    }
    if (next === 'certs') {
      setSelection(firstCertID ? { kind: 'cert', id: firstCertID } : null)
    } else if (next === 'jobs') {
      setSelection(firstJobID ? { kind: 'job', id: firstJobID } : null)
    } else {
      setSelection({ kind: 'overview' })
    }
  }

  const startDraft = () => {
    setMode('jobs')
    setQuery('')
    setDraftSeq((value) => value + 1)
    setSelection({ kind: 'draft' })
  }

  const openCert = (cert: Certificate) => {
    setSelection({ kind: 'cert', id: cert.id })
  }

  const openJob = (job: AcmeJob) => {
    setMode((current) => (current === 'certs' ? 'jobs' : current))
    setSelection({ kind: 'job', id: job.id })
  }

  const jobForCert = (cert: Certificate): AcmeJob | undefined =>
    cert.jobId ? jobs.find((job) => job.id === cert.jobId) : undefined

  const downloadCertificate = (cert: Certificate) => {
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = `/api/v1/acme/certificates/${encodeURIComponent(cert.id)}/download`
    document.body.appendChild(frame)
    window.setTimeout(() => frame.remove(), 60000)
  }

  const waitForCertificate = (job: AcmeJob) => {
    const wanted = (job.domains || []).map(baseDomain).filter(Boolean)
    if (!wanted.length) return
    let polls = 0
    const tick = async () => {
      polls += 1
      const list = await loadCerts(true)
      const hit = list.find((cert) => {
        const names = (cert.domains || []).map(baseDomain)
        return wanted.every((name) => names.includes(name))
      })
      if (hit) {
        message.success(`证书已签发：${certDomains(hit)}`)
        await Promise.all([loadJobs(true), loadStatus(true)])
        return
      }
      if (polls >= 12) {
        message.info('签发仍在后台进行，可稍后在证书仓库查看结果')
        return
      }
      pollTimers.current.push(window.setTimeout(() => void tick(), 5000))
    }
    pollTimers.current.push(window.setTimeout(() => void tick(), 5000))
  }

  const issueJob = async (job: AcmeJob) => {
    setBusyId(job.id)
    try {
      await api.post(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}/issue`)
      message.success('签发请求已提交，正在等待结果…')
      waitForCertificate(job)
      await Promise.all([loadJobs(true), loadStatus(true)])
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const renewCertificate = (cert: Certificate) => {
    const job = jobForCert(cert)
    if (!job) {
      message.warning('该证书没有关联的证书任务，无法自动续期')
      return
    }
    void issueJob(job)
  }

  const saveJob = async (id: string, payload: AcmeJobPayload): Promise<string> => {
    let savedId = id
    if (id) {
      await api.put(`/api/v1/acme/jobs/${encodeURIComponent(id)}`, payload)
    } else {
      const data = await api.post<{ id?: string }>('/api/v1/acme/jobs', payload)
      savedId = String(data?.id || '')
    }
    await Promise.all([loadJobs(true), loadStatus(true)])
    if (!id && savedId) {
      setMode('jobs')
      setSelection({ kind: 'job', id: savedId })
    }
    return savedId
  }

  const removeJob = async (job: AcmeJob) => {
    try {
      await api.del(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}`)
      message.success('证书任务已删除')
      await Promise.all([loadJobs(true), loadStatus(true)])
      if (selection?.kind === 'job' && selection.id === job.id) setSelection(null)
    } catch (err) {
      message.error(errorText(err))
    }
  }

  const removeCertificate = async (cert: Certificate) => {
    try {
      await api.del(`/api/v1/acme/certificates/${encodeURIComponent(cert.id)}`)
      message.success('证书已删除')
      await Promise.all([loadCerts(true), loadStatus(true)])
      if (selection?.kind === 'cert' && selection.id === cert.id) setSelection(null)
    } catch (err) {
      message.error(errorText(err))
    }
  }

  const uploadCertificate = async (payload: UploadPayload) => {
    const data = await api.post<{ id?: string }>('/api/v1/acme/certificates/upload', payload)
    await Promise.all([loadCerts(true), loadStatus(true)])
    if (data?.id) {
      setMode('certs')
      setSelection({ kind: 'cert', id: data.id })
    }
  }

  const saveAccount = async (payload: AccountPayload) => {
    const data = await api.put<AcmeConfig>('/api/v1/acme/config', payload)
    setConfig({
      email: data?.email ?? payload.email,
      keyType: normalizeKeyType(data?.keyType ?? payload.keyType),
      staging: data?.staging ?? payload.staging,
      directory: data?.directory,
      keyTypes: Array.isArray(data?.keyTypes) ? data.keyTypes : undefined,
    })
    await loadStatus(true)
  }

  const keyword = query.trim().toLowerCase()
  const filteredCerts = useMemo(() => {
    if (!keyword) return certs
    return certs.filter((cert) =>
      [certDomains(cert), cert.remark, cert.issuer].join(' ').toLowerCase().includes(keyword),
    )
  }, [certs, keyword])
  const filteredJobs = useMemo(() => {
    if (!keyword) return jobs
    return jobs.filter((job) =>
      [jobLabel(job), (job.domains || []).join(' '), job.remark, job.dnsProvider]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    )
  }, [jobs, keyword])

  const listTitle = mode === 'certs' ? '证书仓库' : mode === 'jobs' ? '证书任务' : '续期状态'
  const listSubtitle =
    mode === 'certs'
      ? `${certs.length} 张证书 · ${validCerts.length} 有效`
      : mode === 'jobs'
        ? `${jobs.length} 个任务 · ${enabledJobs} 个自动续期`
        : '按任务查看当前证书与续期窗口'

  const listBody = (() => {
    if (loading && !certs.length && !jobs.length) {
      return (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin />
        </div>
      )
    }

    if (mode === 'certs') {
      if (!filteredCerts.length) {
        return (
          <div style={{ padding: 20 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={keyword ? '没有匹配的证书' : '还没有证书'}
            >
              {keyword ? null : (
                <Button size="small" onClick={() => setUploadOpen(true)}>
                  上传证书
                </Button>
              )}
            </Empty>
          </div>
        )
      }
      return filteredCerts.map((cert) => {
        const state = certState(cert)
        return (
          <EntityRow
            key={cert.id}
            title={cert.domains?.[0] || cert.remark || '证书'}
            subtitle={
              cert.domains?.length > 1 ? `${cert.issuer} · ${cert.domains.length} 个域名` : cert.issuer
            }
            status={certItemStatus(cert)}
            selected={selection?.kind === 'cert' && selection.id === cert.id}
            actions={cert.autoRenew ? <Tag color="green">自动</Tag> : undefined}
            meta={
              <Space size={6} wrap>
                <Muted>到期 {fmtTime(cert.notAfter)}</Muted>
                <Tag color={state.color}>{certDaysText(cert)}</Tag>
              </Space>
            }
            onClick={() => openCert(cert)}
          />
        )
      })
    }

    if (mode === 'jobs') {
      if (!filteredJobs.length) {
        return (
          <div style={{ padding: 20 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={keyword ? '没有匹配的任务' : '还没有证书任务'}
            >
              {keyword ? null : (
                <Button size="small" onClick={startDraft}>
                  新建任务
                </Button>
              )}
            </Empty>
          </div>
        )
      }
      return filteredJobs.map((job) => {
        const cert = matchCertForJob(job, certs)
        return (
          <EntityRow
            key={job.id}
            title={jobLabel(job)}
            subtitle={(job.domains || []).join(', ') || '-'}
            status={jobItemStatus(job, cert)}
            selected={selection?.kind === 'job' && selection.id === job.id}
            meta={
              <Space size={6} wrap>
                <Tag color={challengeColor(job.challenge)}>{challengeLabel(job.challenge)}</Tag>
                <Muted>{job.renewDays || 30} 天</Muted>
                <Muted>{cert ? `剩余 ${certDaysText(cert)}` : '尚未签发'}</Muted>
              </Space>
            }
            onClick={() => openJob(job)}
          />
        )
      })
    }

    return (
      <>
        <EntityRow
          title="续期概览"
          subtitle="模块状态、账户与需要关注的任务"
          status={moduleRunning === false ? 'error' : lastError ? 'warn' : 'ok'}
          selected={selection?.kind === 'overview'}
          meta={<Muted>{enabledJobs} / {jobs.length} 个任务启用</Muted>}
          onClick={() => setSelection({ kind: 'overview' })}
        />
        {filteredJobs.length ? (
          filteredJobs.map((job) => {
            const cert = matchCertForJob(job, certs)
            const state = jobRenewState(job, cert)
            return (
              <EntityRow
                key={job.id}
                title={jobLabel(job)}
                subtitle={(job.domains || []).join(', ') || '-'}
                status={renewItemStatus(state.label)}
                selected={selection?.kind === 'job' && selection.id === job.id}
                meta={
                  <Space size={6} wrap>
                    <Tag color={state.color}>{state.label}</Tag>
                    <Muted>{cert ? `${certDaysText(cert)} · 到期 ${fmtTime(cert.notAfter)}` : '尚未签发'}</Muted>
                  </Space>
                }
                onClick={() => openJob(job)}
              />
            )
          })
        ) : (
          <div style={{ padding: 16 }}>
            <Muted>{keyword ? '没有匹配的任务' : '还没有证书任务'}</Muted>
          </div>
        )}
      </>
    )
  })()

  const list = (
    <div>
      <div style={{ padding: 10 }}>
        <Segmented
          block
          size="small"
          value={mode}
          onChange={(value) => changeMode(value as ListMode)}
          options={[
            { value: 'certs', label: `证书 ${certs.length}` },
            { value: 'jobs', label: `任务 ${jobs.length}` },
            { value: 'renewal', label: '续期状态' },
          ]}
        />
      </div>
      <div style={{ padding: '0 10px 10px' }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索域名、名称或备注"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <PaneTitle title={listTitle} subtitle={listSubtitle} />
      <div style={{ maxHeight: 'calc(100dvh - 260px)', minHeight: 120, overflowY: 'auto' }}>{listBody}</div>
    </div>
  )

  const detail = (() => {
    if (selectedCert) {
      const job = jobForCert(selectedCert)
      return (
        <CertDetail
          cert={selectedCert}
          job={job}
          onRenew={renewCertificate}
          onDelete={(cert) => void removeCertificate(cert)}
          onDownload={downloadCertificate}
          onOpenJob={openJob}
        />
      )
    }
    if (selectedJob) {
      return (
        <JobEditor
          key={selectedJob.id}
          job={selectedJob}
          providers={providers}
          keyOptions={keyOptions}
          email={config.email}
          staging={!!config.staging}
          issuing={busyId === selectedJob.id}
          onSave={saveJob}
          onIssue={(job) => void issueJob(job)}
          onDelete={(job) => void removeJob(job)}
          onCancel={() => setSelection(null)}
        />
      )
    }
    if (selection?.kind === 'draft') {
      return (
        <JobEditor
          key={`draft-${draftSeq}`}
          job={null}
          providers={providers}
          keyOptions={keyOptions}
          email={config.email}
          staging={!!config.staging}
          onSave={saveJob}
          onIssue={() => undefined}
          onDelete={() => undefined}
          onCancel={() => setSelection(null)}
        />
      )
    }
    if (selection?.kind === 'overview') {
      return (
        <RenewalOverview
          module={status?.status}
          stats={statusStats}
          jobs={jobs}
          certs={certs}
          config={config}
          keyLabel={keyLabel(config.keyType)}
          onOpenJob={openJob}
          onOpenAccount={() => setAccountOpen(true)}
        />
      )
    }
    return (
      <div style={{ padding: '28px 8px' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧的证书或任务查看详情">
          <Space wrap>
            <Button size="small" onClick={startDraft}>
              新建任务
            </Button>
            <Button size="small" onClick={() => setUploadOpen(true)}>
              上传证书
            </Button>
          </Space>
        </Empty>
      </div>
    )
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Typography.Text strong style={{ fontSize: 18 }}>
          证书
        </Typography.Text>
        <Muted>
          {certs.length} 张证书 · {jobs.length} 个任务 · {enabledJobs} 个自动续期
        </Muted>
        <Tag color={config.staging ? 'orange' : 'green'}>{config.staging ? 'staging' : '生产'}</Tag>
        {moduleRunning === false ? <Tag color="red">续期模块未运行</Tag> : null}
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadAll()}>
          刷新
        </Button>
        <Button size="small" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          上传
        </Button>
        <Button size="small" icon={<SettingOutlined />} onClick={() => setAccountOpen(true)}>
          账户
        </Button>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={startDraft}>
          新建任务
        </Button>
      </div>

      {moduleRunning === false ? (
        <Alert
          type="warning"
          showIcon
          message="证书续期模块未运行，自动续期不会执行"
          description={status?.status?.error || '请检查服务状态或系统日志。'}
        />
      ) : null}
      {lastError ? (
        <Alert type="error" showIcon message="上次续期或签发失败" description={lastError} />
      ) : null}

      <Workspace
        list={list}
        detail={detail}
        selected={!!selection}
        onBack={() => setSelection(null)}
        listWidth={340}
      />

      <AccountDrawer
        open={accountOpen}
        config={config}
        keyOptions={keyOptions}
        onClose={() => setAccountOpen(false)}
        onSubmit={saveAccount}
      />
      <UploadDrawer
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSubmit={uploadCertificate}
      />
    </div>
  )
}
