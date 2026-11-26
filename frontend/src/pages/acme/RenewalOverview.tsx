import type { ReactNode } from 'react'
import { Alert, Button, Space, Tag, Typography } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { fmtTime } from '../../format'
import { Muted } from '../../components'
import { EntityRow } from '../../components/Workspace'
import {
  certDaysLeft,
  certDaysText,
  jobLabel,
  jobRenewState,
  matchCertForJob,
  type AcmeConfig,
  type AcmeJob,
  type AcmeModuleStatus,
  type AcmeStatusStats,
  type Certificate,
} from './types'

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.25 }}>{value}</div>
    </div>
  )
}

export interface RenewalOverviewProps {
  module?: AcmeModuleStatus
  stats?: AcmeStatusStats
  jobs: AcmeJob[]
  certs: Certificate[]
  config: AcmeConfig
  keyLabel: string
  onOpenJob: (job: AcmeJob) => void
  onOpenAccount: () => void
}

export default function RenewalOverview({
  module,
  stats,
  jobs,
  certs,
  config,
  keyLabel,
  onOpenJob,
  onOpenAccount,
}: RenewalOverviewProps) {
  const enabledJobs = jobs.filter((job) => job.enable).length
  const valid = certs.filter((cert) => !cert.expired)
  const nextDays = Number(stats?.nextExpiryDays)
  const nextExpiry = stats?.nextExpiry
  const lastError = stats?.lastError ? String(stats.lastError) : ''
  const running = module?.running

  const plans = jobs
    .map((job) => {
      const cert = matchCertForJob(job, certs)
      return { job, cert, state: jobRenewState(job, cert), days: cert ? certDaysLeft(cert) : 9999 }
    })
    .sort((a, b) => a.days - b.days)
  const attention = plans.filter(
    (plan) =>
      plan.job.enable &&
      (!plan.cert || plan.cert.expired || plan.days <= (Number(plan.job.renewDays) || 30)),
  )

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 180, flex: 1 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            续期概览
          </Typography.Title>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            {running === undefined ? (
              <Tag>状态未知</Tag>
            ) : running ? (
              <Tag color="green">自动续期运行中</Tag>
            ) : (
              <Tag color="red">模块未运行</Tag>
            )}
            <Tag color={config.staging ? 'orange' : 'green'}>{config.staging ? 'staging' : '生产'}</Tag>
            <Muted>{config.email || '未设置联系邮箱'}</Muted>
          </Space>
        </div>
        <Button size="small" icon={<SettingOutlined />} onClick={onOpenAccount}>
          账户设置
        </Button>
      </div>

      {running === false ? (
        <Alert
          type="warning"
          showIcon
          message="证书续期模块未运行"
          description={module?.error || '自动续期不会执行，请检查服务状态或系统日志。'}
          style={{ marginBottom: 14 }}
        />
      ) : null}
      {lastError ? (
        <Alert
          type="error"
          showIcon
          message="上次续期或签发失败"
          description={lastError}
          style={{ marginBottom: 14 }}
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 14,
          marginBottom: 16,
        }}
      >
        <Metric label="证书" value={`${valid.length} / ${certs.length}`} />
        <Metric label="自动续期任务" value={`${enabledJobs} / ${jobs.length}`} />
        <Metric
          label="最近到期"
          value={Number.isFinite(nextDays) ? `${nextDays} 天` : nextExpiry ? fmtTime(nextExpiry) : '-'}
        />
        <Metric label="上次错误" value={lastError ? '有' : '无'} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <Space size={6} wrap>
          <Muted>默认密钥：{keyLabel}</Muted>
          <Muted>·</Muted>
          <Muted>最近检查由后台定时执行</Muted>
        </Space>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          需要关注
        </Typography.Text>
        <Tag color={attention.length ? 'orange' : 'green'}>{attention.length}</Tag>
      </div>

      {attention.length ? (
        <div style={{ border: '1px solid rgba(5,5,5,0.06)', borderRadius: 8, overflow: 'hidden' }}>
          {attention.slice(0, 8).map(({ job, cert, state }) => (
            <EntityRow
              key={job.id}
              title={jobLabel(job)}
              subtitle={(job.domains || []).join(', ')}
              status={state.label === '已过期' ? 'error' : 'warn'}
              meta={
                <Space size={6} wrap>
                  <Tag color={state.color}>{state.label}</Tag>
                  <Muted>
                    {cert ? `${certDaysText(cert)} · 到期 ${fmtTime(cert.notAfter)}` : '尚未签发'}
                  </Muted>
                </Space>
              }
              onClick={() => onOpenJob(job)}
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            border: '1px dashed rgba(5,5,5,0.12)',
            borderRadius: 8,
            padding: '14px 16px',
          }}
        >
          <Muted>所有启用的任务都在续期窗口外，当前无需处理。</Muted>
        </div>
      )}
    </div>
  )
}
