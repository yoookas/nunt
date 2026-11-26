import type { ReactNode } from 'react'
import { Alert, Button, Popconfirm, Space, Tag, Typography, theme } from 'antd'
import { CloudDownloadOutlined, DeleteOutlined, ExportOutlined, SyncOutlined } from '@ant-design/icons'
import { fmtTime } from '../../format'
import { Muted } from '../../components'
import {
  certDaysLeft,
  certDaysText,
  certDomains,
  certState,
  jobLabel,
  keyLabel,
  sourceLabel,
  type AcmeJob,
  type Certificate,
} from './types'

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{children}</div>
    </div>
  )
}

export interface CertDetailProps {
  cert: Certificate
  job?: AcmeJob
  onRenew: (cert: Certificate) => void
  onDelete: (cert: Certificate) => void
  onDownload: (cert: Certificate) => void
  onOpenJob: (job: AcmeJob) => void
}

export default function CertDetail({ cert, job, onRenew, onDelete, onDownload, onOpenJob }: CertDetailProps) {
  const { token } = theme.useToken()
  const state = certState(cert)
  const days = certDaysLeft(cert)

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 180, flex: 1 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {cert.domains?.[0] || cert.remark || '证书'}
          </Typography.Title>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            <Tag color={state.color}>{state.label}</Tag>
            <Muted>{certDomains(cert)}</Muted>
          </Space>
        </div>
        <Space wrap size={6}>
          {job ? (
            <Popconfirm
              title="立即续期这张证书？"
              description="将为关联任务重新签发证书。"
              okText="开始续期"
              cancelText="取消"
              onConfirm={() => onRenew(cert)}
            >
              <Button size="small" icon={<SyncOutlined />}>
                续期
              </Button>
            </Popconfirm>
          ) : null}
          <Button size="small" icon={<CloudDownloadOutlined />} onClick={() => onDownload(cert)}>
            导出 zip
          </Button>
          <Popconfirm
            title="删除这张证书？"
            description="使用该证书的站点会失去 TLS。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(cert)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {cert.expired ? (
        <Alert
          type="error"
          showIcon
          message="证书已过期"
          description="使用这张证书的站点会在 TLS 握手时失败，请尽快续期或上传新证书。"
          style={{ marginBottom: 14 }}
        />
      ) : days <= 15 ? (
        <Alert
          type="warning"
          showIcon
          message="证书即将到期"
          description={`剩余 ${certDaysText(cert)}。${
            job ? '已关联证书任务，可在任务中立即续期。' : '这张证书没有关联任务，不会自动续期。'
          }`}
          style={{ marginBottom: 14 }}
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 14,
          marginBottom: 16,
        }}
      >
        <DetailItem label="签发者">{cert.issuer || '-'}</DetailItem>
        <DetailItem label="来源">{sourceLabel(cert.source)}</DetailItem>
        <DetailItem label="密钥类型">{cert.keyType ? keyLabel(cert.keyType) : '-'}</DetailItem>
        <DetailItem label="自动续期">
          {cert.autoRenew ? <Tag color="green">自动</Tag> : <Tag>手动管理</Tag>}
        </DetailItem>
        <DetailItem label="生效时间">{fmtTime(cert.notBefore)}</DetailItem>
        <DetailItem label="到期时间">{fmtTime(cert.notAfter)}</DetailItem>
        <DetailItem label="剩余有效期">
          <Tag color={state.color}>{certDaysText(cert)}</Tag>
        </DetailItem>
        <DetailItem label="更新时间">{fmtTime(cert.updatedAt)}</DetailItem>
        <DetailItem label="关联任务">
          {job ? (
            <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onOpenJob(job)}>
              <ExportOutlined /> {jobLabel(job)}
            </Button>
          ) : (
            <Muted>没有关联任务</Muted>
          )}
        </DetailItem>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          SAN（域名）
        </Typography.Text>
        <div style={{ marginTop: 6 }}>
          {cert.domains?.length ? (
            <Space size={[4, 4]} wrap>
              {cert.domains.map((domain) => (
                <Tag key={domain} className="mono" style={{ fontSize: 12 }}>
                  {domain}
                </Tag>
              ))}
            </Space>
          ) : (
            <Muted>-</Muted>
          )}
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          padding: '12px 14px',
          background: token.colorFillQuaternary,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            证书链与私钥
          </Typography.Text>
          <Tag>cert.pem</Tag>
          <Tag>key.pem</Tag>
          <div style={{ flex: 1 }} />
          <Button size="small" type="primary" ghost icon={<CloudDownloadOutlined />} onClick={() => onDownload(cert)}>
            导出 zip
          </Button>
        </div>
        <div style={{ marginTop: 6 }}>
          <Muted>
            导出包包含叶子证书及中间链（cert.pem）和私钥（key.pem）。服务端只以 zip 形式提供完整链。
          </Muted>
        </div>
      </div>

      {cert.remark ? (
        <div style={{ marginTop: 14 }}>
          <Muted>备注：{cert.remark}</Muted>
        </div>
      ) : null}
    </div>
  )
}
