import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Statistic,
  Switch,
  Tabs,
  Tag,
  theme,
  type DescriptionsProps,
  type TableColumnsType,
} from 'antd'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../api'
import { fmtTime } from '../format'
import { DataTable, Muted, PageHeader, Panel, confirmDelete, useIsMobile } from '../components'
import { usePolling } from '../usePolling'
import JobModal from './acme/JobModal'
import UploadModal from './acme/UploadModal'
import AccountModal from './acme/AccountModal'
import CertDetailModal from './acme/CertDetailModal'
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
  normalizeChallenge,
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

export default function Acme() {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const isMobile = useIsMobile()

  const [jobs, setJobs] = useState<AcmeJob[]>([])
  const [certs, setCerts] = useState<Certificate[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [config, setConfig] = useState<AcmeConfig>(EMPTY_CONFIG)
  const [status, setStatus] = useState<AcmeStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  const [jobOpen, setJobOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<AcmeJob | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [detailCert, setDetailCert] = useState<Certificate | null>(null)

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
    // The page loads once; later refreshes are explicit or polled.
  }, [loadAll])

  usePolling(() => loadStatus(true), 60000)

  const keyOptions = useMemo(() => parseKeyOptions(config.keyTypes), [config.keyTypes])
  const statusStats = status?.status?.stats
  const moduleRunning = status?.status?.running
  const moduleError = status?.status?.error || ''
  const lastError = statusStats?.lastError ? String(statusStats.lastError) : ''

  const validCerts = useMemo(() => certs.filter((cert) => !cert.expired), [certs])
  const enabledJobs = useMemo(() => jobs.filter((job) => job.enable).length, [jobs])
  const soonest = useMemo(() => {
    if (!validCerts.length) return null
    return validCerts.reduce((acc, cert) => (certDaysLeft(cert) <= certDaysLeft(acc) ? cert : acc))
  }, [validCerts])

  const statDays = Number(statusStats?.nextExpiryDays)
  const nextDays = Number.isFinite(statDays) ? statDays : soonest ? certDaysLeft(soonest) : undefined
  const nextExpiry = statusStats?.nextExpiry || soonest?.notAfter

  const jobForCert = (cert: Certificate): AcmeJob | undefined =>
    cert.jobId ? jobs.find((job) => job.id === cert.jobId) : undefined

  const downloadCertificate = (cert: Certificate) => {
    // A hidden iframe keeps the attachment download from navigating the SPA
    // when the endpoint answers with an error document instead of a zip.
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

  const askIssue = (job: AcmeJob) => {
    modal.confirm({
      title: '立即签发证书',
      content: `将为「${jobLabel(job)}」提交签发请求。签发在后台异步执行，通常需要几十秒到几分钟。`,
      okText: '开始签发',
      cancelText: '取消',
      onOk: () => issueJob(job),
    })
  }

  const renewCertificate = (cert: Certificate) => {
    const job = jobForCert(cert)
    if (!job) {
      message.warning('该证书没有关联的证书任务，无法自动续期')
      return
    }
    setDetailCert(null)
    askIssue(job)
  }

  const toggleJob = async (job: AcmeJob, next: boolean) => {
    setBusyId(job.id)
    try {
      await api.post(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}/toggle`, { enable: next })
      message.success(next ? '已启用自动续期' : '已关闭自动续期')
      await Promise.all([loadJobs(true), loadStatus(true)])
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const removeJob = (job: AcmeJob) => {
    confirmDelete('删除证书任务', `确定删除「${jobLabel(job)}」吗？已签发的证书不会被删除。`, async () => {
      try {
        await api.del(`/api/v1/acme/jobs/${encodeURIComponent(job.id)}`)
        message.success('证书任务已删除')
        await Promise.all([loadJobs(true), loadStatus(true)])
      } catch (err) {
        message.error(errorText(err))
        throw err
      }
    })
  }

  const removeCertificate = (cert: Certificate) => {
    confirmDelete(
      '删除证书',
      `确定删除证书「${certDomains(cert)}」吗？使用该证书的站点会失去 TLS。`,
      async () => {
        try {
          await api.del(`/api/v1/acme/certificates/${encodeURIComponent(cert.id)}`)
          message.success('证书已删除')
          await Promise.all([loadCerts(true), loadStatus(true)])
        } catch (err) {
          message.error(errorText(err))
          throw err
        }
      },
    )
  }

  const saveJob = async (id: string, payload: AcmeJobPayload) => {
    if (id) {
      await api.put(`/api/v1/acme/jobs/${encodeURIComponent(id)}`, payload)
    } else {
      await api.post('/api/v1/acme/jobs', payload)
    }
    await Promise.all([loadJobs(true), loadStatus(true)])
  }

  const uploadCertificate = async (payload: UploadPayload) => {
    await api.post('/api/v1/acme/certificates/upload', payload)
    await Promise.all([loadCerts(true), loadStatus(true)])
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

  const openJobForm = (job: AcmeJob | null) => {
    setEditingJob(job)
    setJobOpen(true)
  }

  const certColumns: TableColumnsType<Certificate> = [
    {
      key: 'domains',
      title: '域名',
      render: (_, record) => {
        const names = Array.isArray(record.domains) ? record.domains : []
        return (
          <div>
            <span className="mono" style={{ fontSize: 12 }}>
              {names[0] || '-'}
            </span>
            {names.length > 1 ? <Muted> 等 {names.length} 个域名</Muted> : null}
            {record.remark ? (
              <div>
                <Muted>{record.remark}</Muted>
              </div>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'issuer',
      title: '签发者',
      responsive: ['md'],
      render: (_, record) => <span style={{ fontSize: 12 }}>{record.issuer || '-'}</span>,
    },
    {
      key: 'notAfter',
      title: '到期时间',
      render: (_, record) => (
        <div>
          <div style={{ fontSize: 12 }}>{fmtTime(record.notAfter)}</div>
          <Muted>{certDaysText(record)}</Muted>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      render: (_, record) => {
        const state = certState(record)
        return <Tag color={state.color}>{state.label}</Tag>
      },
    },
    {
      key: 'autoRenew',
      title: '自动续期',
      responsive: ['lg'],
      render: (_, record) =>
        record.autoRenew ? <Tag color="green">自动</Tag> : <Tag>手动</Tag>,
    },
    {
      key: 'actions',
      title: '操作',
      render: (_, record) => {
        const job = jobForCert(record)
        return (
          <Space size={0} wrap>
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDetailCert(record)}>
              详情
            </Button>
            <Button
              type="link"
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => downloadCertificate(record)}
            >
              导出
            </Button>
            {job ? (
              <Button
                type="link"
                size="small"
                icon={<SyncOutlined />}
                disabled={busyId === job.id}
                onClick={() => renewCertificate(record)}
              >
                续期
              </Button>
            ) : null}
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeCertificate(record)}
            >
              删除
            </Button>
          </Space>
        )
      },
    },
  ]

  const jobColumns: TableColumnsType<AcmeJob> = [
    {
      key: 'domains',
      title: '任务 / 域名',
      render: (_, record) => {
        const domains = record.domainsJoined || (record.domains || []).join(', ') || '-'
        return (
          <div>
            {record.name ? <div style={{ fontWeight: 500 }}>{record.name}</div> : null}
            <div className="mono" style={{ fontSize: 12 }}>
              {domains}
            </div>
            {record.remark ? (
              <div>
                <Muted>{record.remark}</Muted>
              </div>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'challenge',
      title: '挑战方式',
      render: (_, record) => (
        <Tag color={challengeColor(record.challenge)}>{challengeLabel(record.challenge)}</Tag>
      ),
    },
    {
      key: 'provider',
      title: 'DNS 提供商',
      responsive: ['md'],
      render: (_, record) =>
        normalizeChallenge(record.challenge) === 'dns' ? (
          <span className="mono" style={{ fontSize: 12 }}>
            {providers.find((item) => item.id === record.dnsProvider)?.title || record.dnsProvider || '-'}
          </span>
        ) : (
          <Muted>不使用</Muted>
        ),
    },
    {
      key: 'keyType',
      title: '密钥类型',
      responsive: ['xl'],
      render: (_, record) => <span style={{ fontSize: 12 }}>{keyLabel(record.keyType)}</span>,
    },
    {
      key: 'renewDays',
      title: '提前续期',
      responsive: ['lg'],
      render: (_, record) => `${record.renewDays || 30} 天`,
    },
    {
      key: 'enable',
      title: '自动续期',
      render: (_, record) => (
        <Switch
          size="small"
          checked={!!record.enable}
          loading={busyId === record.id}
          onChange={(next) => void toggleJob(record, next)}
        />
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (_, record) => (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            icon={<SyncOutlined />}
            loading={busyId === record.id}
            onClick={() => askIssue(record)}
          >
            签发
          </Button>
          <Button type="link" size="small" onClick={() => openJobForm(record)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => removeJob(record)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ]

  const planColumns: TableColumnsType<AcmeJob> = [
    {
      key: 'job',
      title: '证书任务',
      render: (_, record) => (
        <div>
          <div style={{ fontWeight: 500 }}>{jobLabel(record)}</div>
          <div className="mono" style={{ fontSize: 12 }}>
            {record.domainsJoined || (record.domains || []).join(', ') || '-'}
          </div>
        </div>
      ),
    },
    {
      key: 'enable',
      title: '自动续期',
      render: (_, record) =>
        record.enable ? <Tag color="green">已启用</Tag> : <Tag color="default">已停用</Tag>,
    },
    {
      key: 'window',
      title: '提前天数',
      responsive: ['md'],
      render: (_, record) => `${record.renewDays || 30} 天`,
    },
    {
      key: 'current',
      title: '当前证书到期',
      render: (_, record) => {
        const cert = matchCertForJob(record, certs)
        return cert ? (
          <div>
            <div style={{ fontSize: 12 }}>{fmtTime(cert.notAfter)}</div>
            <Muted>{certDaysText(cert)}</Muted>
          </div>
        ) : (
          <Muted>尚未签发</Muted>
        )
      },
    },
    {
      key: 'state',
      title: '续期状态',
      render: (_, record) => {
        const cert = matchCertForJob(record, certs)
        const state = jobRenewState(record, cert)
        return <Tag color={state.color}>{state.label}</Tag>
      },
    },
  ]

  const descriptionColumns = isMobile ? 1 : 2
  const accountItems: DescriptionsProps['items'] = [
    {
      key: 'running',
      label: '续期模块',
      children:
        moduleRunning === undefined ? (
          <Tag>未知</Tag>
        ) : moduleRunning ? (
          <Tag color="green">运行中</Tag>
        ) : (
          <Tag color="red">未运行</Tag>
        ),
    },
    {
      key: 'since',
      label: '运行开始',
      children: status?.status?.since ? fmtTime(status.status.since) : '-',
    },
    {
      key: 'jobs',
      label: '自动续期任务',
      children: `${enabledJobs} / ${jobs.length} 启用`,
    },
    {
      key: 'certs',
      label: '有效证书',
      children: `${validCerts.length} / ${certs.length}`,
    },
    {
      key: 'next',
      label: '最近到期',
      children: nextExpiry ? (
        <span>
          {fmtTime(nextExpiry)}
          {nextDays !== undefined ? <Muted>（{nextDays} 天）</Muted> : null}
        </span>
      ) : (
        '-'
      ),
    },
    { key: 'email', label: '联系邮箱', children: config.email || '未设置' },
    { key: 'keyType', label: '默认密钥类型', children: keyLabel(config.keyType) },
    {
      key: 'staging',
      label: 'ACME 环境',
      children: config.staging ? <Tag color="orange">staging 测试</Tag> : <Tag color="green">生产</Tag>,
    },
    {
      key: 'directory',
      label: 'ACME 目录',
      span: descriptionColumns,
      children: (
        <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {config.directory || (config.staging ? 'Let\u2019s Encrypt staging' : "Let's Encrypt production")}
        </span>
      ),
    },
    {
      key: 'detail',
      label: '模块详情',
      span: descriptionColumns,
      children: status?.status?.detail || '-',
    },
  ]

  const tabs = [
    {
      key: 'certs',
      label: '证书仓库',
      children: (
        <Panel
          title="证书仓库"
          subtitle="上传或自动签发的证书都保存在这里"
          extra={isMobile ? undefined : <Muted>导出 zip 含证书链与私钥</Muted>}
        >
          <DataTable<Certificate>
            dataSource={certs}
            columns={certColumns}
            rowKey="id"
            loading={loading}
          />
        </Panel>
      ),
    },
    {
      key: 'jobs',
      label: '证书任务',
      children: (
        <Panel
          title="证书任务"
          subtitle="任务用于按域名申请证书，并参与定时自动续期"
          extra={isMobile ? undefined : <Muted>自动续期只在任务启用时参与</Muted>}
        >
          <DataTable<AcmeJob> dataSource={jobs} columns={jobColumns} rowKey="id" loading={loading} />
        </Panel>
      ),
    },
    {
      key: 'status',
      label: '续期状态',
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel
            title="定时续期"
            subtitle="启用的任务会在证书剩余天数进入续期窗口时自动重新签发"
            extra={
              isMobile ? undefined : (
                <Button size="small" icon={<SettingOutlined />} onClick={() => setAccountOpen(true)}>
                  ACME 设置
                </Button>
              )
            }
          >
            <Descriptions size="small" bordered column={descriptionColumns} items={accountItems} />
            {moduleError ? (
              <Alert
                type="error"
                showIcon
                message="证书模块报告错误"
                description={moduleError}
                style={{ marginTop: 16 }}
              />
            ) : null}
          </Panel>

          <Panel
            title="任务续期计划"
            subtitle="按任务展示当前证书与续期窗口，实际签发在后台执行"
            extra={<Muted>每 60 秒刷新状态</Muted>}
          >
            <DataTable<AcmeJob>
              dataSource={jobs}
              columns={planColumns}
              rowKey="id"
              loading={loading}
            />
          </Panel>
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="证书"
        subtitle={`共 ${jobs.length} 个证书任务、${certs.length} 张证书 · CA：Let's Encrypt${
          config.email ? ` · ${config.email}` : ''
        }${config.staging ? ' · staging 测试环境' : ''}`}
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadAll()}>
              刷新
            </Button>
            <Button icon={<SettingOutlined />} onClick={() => setAccountOpen(true)}>
              ACME 设置
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
              上传证书
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openJobForm(null)}>
              新建任务
            </Button>
          </>
        }
      />

      {moduleRunning === false ? (
        <Alert
          type="warning"
          showIcon
          message="证书续期模块未运行"
          description={moduleError || '自动续期不会执行，请检查服务状态或查看系统日志。'}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {lastError ? (
        <Alert
          type="error"
          showIcon
          message="上次续期或签发失败"
          description={lastError}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="证书总数"
              value={certs.length}
              prefix={<SafetyCertificateOutlined />}
              valueStyle={{ fontSize: 22 }}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="有效证书"
              value={validCerts.length}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ fontSize: 22, color: token.colorSuccess }}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="自动续期任务"
              value={`${enabledJobs} / ${jobs.length}`}
              prefix={<SyncOutlined />}
              valueStyle={{ fontSize: 22 }}
            />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="最近到期"
              value={nextDays === undefined ? '—' : nextDays}
              suffix={nextDays === undefined ? undefined : '天'}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ fontSize: 22 }}
            />
          </Card>
        </Col>
      </Row>

      <Tabs items={tabs} defaultActiveKey="certs" centered={isMobile} />

      <JobModal
        open={jobOpen}
        job={editingJob}
        providers={providers}
        keyOptions={keyOptions}
        email={config.email}
        staging={!!config.staging}
        onClose={() => setJobOpen(false)}
        onSubmit={saveJob}
      />
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onSubmit={uploadCertificate} />
      <AccountModal
        open={accountOpen}
        config={config}
        keyOptions={keyOptions}
        onClose={() => setAccountOpen(false)}
        onSubmit={saveAccount}
      />
      <CertDetailModal
        cert={detailCert}
        jobs={jobs}
        onClose={() => setDetailCert(null)}
        onDownload={downloadCertificate}
        onRenew={renewCertificate}
      />
    </div>
  )
}
