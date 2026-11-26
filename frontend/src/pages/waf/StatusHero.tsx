import { Badge, Button, Card, Space, Tag, Typography, theme } from 'antd'
import { ReloadOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { fmtTime } from '../../format'
import { Muted } from '../../components'
import type { WafConfig, WafEngine, WafStats } from './types'

function Metric({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.25, color }}>{value.toLocaleString('zh-CN')}</div>
    </div>
  )
}

export interface StatusHeroProps {
  engine: WafEngine | null
  stats: WafStats
  config: WafConfig | null
  crsVersion: string
  loading: boolean
  saving: boolean
  reloading: boolean
  onRefresh: () => void
  onReload: () => void
  onSave: () => void
}

export default function StatusHero({
  engine,
  stats,
  config,
  crsVersion,
  loading,
  saving,
  reloading,
  onRefresh,
  onReload,
  onSave,
}: StatusHeroProps) {
  const { token } = theme.useToken()
  const mode = engine?.mode || config?.mode || stats.mode
  const modeLabel = mode === 'detect' ? '检测模式' : mode === 'block' ? '拦截模式' : '模式未知'
  const enabled = !!engine?.enabled
  const statusText = engine?.error ? '编译失败' : !engine ? '状态未知' : enabled ? '运行中' : '未运行'
  const badge: 'success' | 'error' | 'default' = engine?.error ? 'error' : enabled ? 'success' : 'default'
  const crsOn = engine?.useCrs ?? config?.useCrs ?? true
  const crs = engine?.crsVersion || crsVersion || (crsOn ? '未加载' : '已关闭')
  const ruleCount = engine?.rules ?? stats.rules
  const fileCount = engine?.ruleFiles ?? stats.ruleFiles
  const statusBackground = engine?.error
    ? token.colorErrorBg
    : enabled
      ? token.colorSuccessBg
      : token.colorFillQuaternary

  return (
    <Card styles={{ body: { padding: 14 } }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 14 }}>
        <div
          style={{
            flex: '1 1 250px',
            minWidth: 230,
            padding: '10px 12px',
            borderRadius: 8,
            background: statusBackground,
          }}
        >
          <Space size={8} wrap>
            <Badge status={badge} text={<Typography.Text strong>{statusText}</Typography.Text>} />
            <Tag color={mode === 'block' ? 'red' : 'orange'}>{modeLabel}</Tag>
            {engine?.logOnly ? <Tag>仅记录</Tag> : null}
          </Space>
          <div style={{ marginTop: 6 }} title={engine?.detail}>
            <Muted>
              {crsOn ? `CRS ${crs}` : 'CRS 已关闭'} · {ruleCount ?? '-'} 条规则 · {fileCount ?? '-'} 个文件
            </Muted>
          </div>
          <div>
            <Muted>编译于 {fmtTime(engine?.builtAt || stats.builtAt)}</Muted>
          </div>
        </div>

        <div
          style={{
            flex: '2 1 320px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <Metric label="请求" value={stats.requests ?? 0} />
          <Metric label="拦截" value={stats.blocked ?? 0} color={token.colorError} />
          <Metric label="检测" value={stats.detected ?? 0} color={token.colorWarning} />
          <Metric label="错误" value={stats.errors ?? 0} color={token.colorError} />
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
          <Button size="small" icon={<ThunderboltOutlined />} loading={reloading} onClick={onReload}>
            重载
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!config || loading}
            onClick={onSave}
          >
            保存
          </Button>
        </div>
      </div>
    </Card>
  )
}
