import type { ReactNode } from 'react'
import { Button, Card, Grid, Typography, theme } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'

export type ItemStatus = 'ok' | 'warn' | 'error' | 'off'

const statusColor: Record<ItemStatus, string> = {
  ok: '#52c41a',
  warn: '#faad14',
  error: '#ff4d4f',
  off: '#bfbfbf',
}

/** A compact entity row used inside the list pane. */
export function EntityRow({
  title,
  subtitle,
  meta,
  status,
  selected,
  onClick,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  status?: ItemStatus
  selected?: boolean
  onClick?: () => void
  actions?: ReactNode
}) {
  const { token } = theme.useToken()
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '12px 14px',
        cursor: onClick ? 'pointer' : 'default',
        background: selected ? token.colorPrimaryBg : undefined,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          marginTop: 6,
          flexShrink: 0,
          background: status ? statusColor[status] : statusColor.off,
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ flex: 1, fontSize: 13, color: selected ? token.colorPrimary : undefined }}>
            {title}
          </Typography.Text>
          {actions}
        </div>
        {subtitle ? (
          <div style={{ marginTop: 2, color: token.colorTextSecondary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        ) : null}
        {meta ? <div style={{ marginTop: 4 }}>{meta}</div> : null}
      </div>
    </div>
  )
}

/**
 * Two-pane workspace. Desktop shows the list on the left and the selected
 * detail on the right; mobile shows one of them, with a back button on detail.
 */
export function Workspace({
  list,
  detail,
  selected,
  onBack,
  listWidth = 340,
}: {
  list: ReactNode
  detail: ReactNode
  selected: boolean
  onBack: () => void
  listWidth?: number
}) {
  const screens = Grid.useBreakpoint()
  const { token } = theme.useToken()
  const desktop = screens.lg

  if (!desktop) {
    return selected ? (
      <div>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ marginBottom: 8 }}>
          返回列表
        </Button>
        <Card styles={{ body: { padding: 16 } }}>{detail}</Card>
      </div>
    ) : (
      <Card styles={{ body: { padding: 0 } }}>{list}</Card>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `${listWidth}px minmax(0, 1fr)`, gap: 12, alignItems: 'start' }}>
      <Card styles={{ body: { padding: 0 } }} style={{ borderColor: token.colorBorderSecondary }}>
        {list}
      </Card>
      <Card styles={{ body: { padding: 20 } }} style={{ minHeight: 420 }}>
        {detail}
      </Card>
    </div>
  )
}

export function PaneTitle({ title, subtitle, extra }: { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid rgba(5,5,5,0.06)' }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Text strong>{title}</Typography.Text>
        {subtitle ? (
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{subtitle}</div>
        ) : null}
      </div>
      <div style={{ marginLeft: 'auto' }}>{extra}</div>
    </div>
  )
}
