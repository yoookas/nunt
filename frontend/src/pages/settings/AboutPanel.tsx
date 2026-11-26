import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Space, Tag, Typography, theme } from 'antd'
import { ApiOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { Muted, useIsMobile } from '../../components'
import { fmtBytes, fmtDuration, fmtTime } from '../../format'
import type { SystemInfo, SystemStats } from './shared'
import { SettingsSection } from './ui'

interface Props {
  refreshToken: number
}

export default function AboutPanel({ refreshToken }: Props) {
  const isMobile = useIsMobile()
  const { token } = theme.useToken()
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [infoData, statsData] = await Promise.all([
        api.get<SystemInfo>('/api/v1/system/info'),
        api.get<SystemStats>('/api/v1/system/stats').catch(() => null),
      ])
      setInfo(infoData || null)
      setStats(statsData || null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const version = info?.version
  const versionText = version?.version || '-'

  return (
    <div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="无法读取版本信息"
          description={error}
          action={
            <Button size="small" loading={loading} onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 20,
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            fontSize: 22,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
          }}
        >
          <ApiOutlined />
        </div>
        <div style={{ minWidth: 0 }}>
          <Space size={8} wrap>
            <Typography.Text strong style={{ fontSize: 18 }}>
              nunt
            </Typography.Text>
            <Tag color="blue">{versionText}</Tag>
          </Space>
          <div>
            <Muted>轻量反向代理与端口转发管理控制台</Muted>
          </div>
        </div>
      </div>

      <SettingsSection
        title="构建与运行环境"
        description="版本信息来自运行中的进程；升级二进制后需重启服务才会更新"
        first
      >
        <Descriptions
          bordered
          size="small"
          column={isMobile ? 1 : 2}
          items={[
            { key: 'version', label: '版本', children: <span className="mono">{versionText}</span> },
            {
              key: 'commit',
              label: '提交',
              children: version?.commit ? (
                <span className="mono">{String(version.commit).slice(0, 12)}</span>
              ) : (
                '-'
              ),
            },
            { key: 'build', label: '构建时间', children: version?.buildTime || '-' },
            { key: 'go', label: 'Go 版本', children: version?.goVersion || '-' },
            {
              key: 'platform',
              label: '平台',
              children: version?.os && version?.arch ? `${version.os}/${version.arch}` : '-',
            },
            {
              key: 'data',
              label: '数据目录',
              children: (
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {info?.dataDir || '-'}
                </span>
              ),
            },
            { key: 'listen', label: '管理监听', children: <span className="mono">{info?.adminListen || '-'}</span> },
            {
              key: 'source',
              label: '监听来源',
              children: info?.adminListenSource === 'env' ? `环境变量 ${info.adminListenEnv || ''}` : '配置文件',
            },
            { key: 'started', label: '启动时间', children: fmtTime(stats?.startTime) },
            { key: 'uptime', label: '运行时长', children: stats ? fmtDuration(stats.uptimeSec) : '-' },
            { key: 'heap', label: '内存堆', children: stats ? fmtBytes(stats.heapBytes) : '-' },
            { key: 'goroutines', label: '协程', children: stats?.goroutines ?? '-' },
            { key: 'routes', label: 'Web 路由', children: info?.webRules ?? '-' },
            { key: 'cpu', label: 'CPU 核心', children: stats?.numCpu ?? '-' },
          ]}
        />
        <div style={{ marginTop: 14 }}>
          <Muted>前端不检查更新，也不会向外部服务发送任何请求。</Muted>
        </div>
      </SettingsSection>
    </div>
  )
}
