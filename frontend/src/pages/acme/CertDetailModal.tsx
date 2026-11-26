import { Alert, Button, Descriptions, Divider, Modal, Space, Tag, Typography, type DescriptionsProps } from 'antd'
import { DownloadOutlined, SyncOutlined } from '@ant-design/icons'
import { modalWidth, Muted, useIsMobile } from '../../components'
import { fmtTime } from '../../format'
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

export interface CertDetailModalProps {
  cert: Certificate | null
  jobs: AcmeJob[]
  onClose: () => void
  onDownload: (cert: Certificate) => void
  onRenew: (cert: Certificate) => void
}

export default function CertDetailModal({ cert, jobs, onClose, onDownload, onRenew }: CertDetailModalProps) {
  const isMobile = useIsMobile()
  const job = cert?.jobId ? jobs.find((item) => item.id === cert.jobId) : undefined
  const state = cert ? certState(cert) : { color: 'default', label: '-' }
  const columns = isMobile ? 1 : 2

  const items: DescriptionsProps['items'] = cert
    ? [
        {
          key: 'domains',
          label: 'SAN（域名）',
          span: columns,
          children:
            cert.domains && cert.domains.length ? (
              <Space size={[4, 4]} wrap>
                {cert.domains.map((domain) => (
                  <Tag key={domain} className="mono" style={{ fontSize: 12 }}>
                    {domain}
                  </Tag>
                ))}
              </Space>
            ) : (
              '-'
            ),
        },
        { key: 'issuer', label: '签发者', children: cert.issuer || '-' },
        { key: 'source', label: '来源', children: sourceLabel(cert.source) },
        { key: 'notBefore', label: '生效时间', children: fmtTime(cert.notBefore) },
        { key: 'notAfter', label: '到期时间', children: fmtTime(cert.notAfter) },
        {
          key: 'days',
          label: '剩余有效期',
          children: <Tag color={state.color}>{certDaysText(cert)}</Tag>,
        },
        {
          key: 'state',
          label: '状态',
          children: <Tag color={state.color}>{state.label}</Tag>,
        },
        { key: 'keyType', label: '密钥类型', children: cert.keyType ? keyLabel(cert.keyType) : '-' },
        {
          key: 'autoRenew',
          label: '自动续期',
          children: cert.autoRenew ? <Tag color="green">自动续期</Tag> : <Tag>手动管理</Tag>,
        },
        {
          key: 'job',
          label: '关联任务',
          children: job ? jobLabel(job) : cert.jobId ? cert.jobId : '-',
        },
        { key: 'remark', label: '备注', children: cert.remark || '-' },
        { key: 'updatedAt', label: '更新时间', children: fmtTime(cert.updatedAt) },
        {
          key: 'id',
          label: '证书 ID',
          children: (
            <Typography.Text code style={{ wordBreak: 'break-all' }}>
              {cert.id}
            </Typography.Text>
          ),
        },
      ]
    : []

  return (
    <Modal
      open={!!cert}
      title="证书详情"
      width={modalWidth(true)}
      onCancel={onClose}
      footer={
        cert ? (
          <Space wrap>
            <Button onClick={onClose}>关闭</Button>
            {job ? (
              <Button icon={<SyncOutlined />} onClick={() => onRenew(cert)}>
                续期
              </Button>
            ) : null}
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => onDownload(cert)}>
              导出 zip
            </Button>
          </Space>
        ) : null
      }
      styles={{ body: { maxHeight: '66vh', overflowY: 'auto', overflowX: 'hidden' } }}
    >
      {cert ? (
        <div>
          {cert.expired ? (
            <Alert
              type="error"
              showIcon
              message="证书已过期"
              description="使用这张证书的站点会在 TLS 握手时失败，请尽快上传新证书或重新签发。"
              style={{ marginBottom: 16 }}
            />
          ) : certDaysLeft(cert) <= 15 ? (
            <Alert
              type="warning"
              showIcon
              message="证书即将到期"
              description="如果已启用自动续期，请检查证书任务与 DNS/80/443 端口是否正常。"
              style={{ marginBottom: 16 }}
            />
          ) : null}

          <Descriptions size="small" bordered column={columns} items={items} />

          <Divider orientation="left" orientationMargin={0} plain>
            证书链
          </Divider>
          <Alert
            type="info"
            showIcon
            message="证书链与私钥打包在导出文件中"
            description={
              <span>
                点击「导出 zip」下载 <Typography.Text code>cert.pem</Typography.Text>（叶子证书及中间链）和{' '}
                <Typography.Text code>key.pem</Typography.Text>（私钥）。服务端只以压缩包形式提供完整链，
                页面上不单独回显私钥内容。
              </span>
            }
          />
          <div style={{ marginTop: 12 }}>
            <Muted>
              域名：{certDomains(cert)} · 自动续期：{cert.autoRenew ? '是' : '否'}
              {job ? ` · 任务：${jobLabel(job)}` : ''}
            </Muted>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
