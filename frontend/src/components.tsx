import { Button, Card, Empty, Grid, Modal, Space, Table, Tag, Typography, type TableProps } from 'antd'
import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, extra }: { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-header" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0, fontSize: 20 }}>
          {title}
        </Typography.Title>
        {subtitle ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {subtitle}
          </Typography.Text>
        ) : null}
      </div>
      {extra ? <Space wrap>{extra}</Space> : null}
    </div>
  )
}

/** A card section with an optional heading and toolbar. */
export function Panel({
  title,
  subtitle,
  extra,
  children,
  loading,
  bodyStyle,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  extra?: ReactNode
  children: ReactNode
  loading?: boolean
  bodyStyle?: React.CSSProperties
}) {
  return (
    <Card
      size="small"
      loading={loading}
      title={
        title || subtitle ? (
          <div>
            <div>{title}</div>
            {subtitle ? (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {subtitle}
              </Typography.Text>
            ) : null}
          </div>
        ) : undefined
      }
      extra={extra}
      styles={{ body: { padding: bodyStyle?.padding ?? 16, ...bodyStyle } }}
    >
      {children}
    </Card>
  )
}

export function StatusTag({ status, text }: { status?: number; text?: ReactNode }) {
  const code = Number(status) || 0
  const color = code >= 500 ? 'red' : code >= 400 ? 'orange' : code >= 300 ? 'blue' : code >= 200 ? 'green' : 'default'
  return <Tag color={color}>{text ?? (code || '-')}</Tag>
}

export function SourceTag({ source }: { source?: string }) {
  const map: Record<string, { color: string; label: string }> = {
    web: { color: 'blue', label: 'Web' },
    forward: { color: 'green', label: '转发' },
    waf: { color: 'volcano', label: 'WAF' },
  }
  const item = map[source || ''] || { color: 'default', label: source || '-' }
  return <Tag color={item.color}>{item.label}</Tag>
}

export function LevelTag({ level }: { level?: string }) {
  const value = (level || 'info').toLowerCase()
  const color = value === 'error' ? 'red' : value === 'warn' || value === 'warning' ? 'orange' : value === 'debug' ? 'purple' : 'blue'
  return <Tag color={color}>{value.toUpperCase()}</Tag>
}

/** Table defaults shared by the configuration pages: dense and scrollable. */
export function DataTable<T extends object>({ scroll, size = 'small', pagination = false, ...rest }: TableProps<T>) {
  return (
    <Table<T>
      {...rest}
      size={size}
      pagination={pagination}
      scroll={scroll ?? { x: 'max-content' }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />, ...rest.locale }}
    />
  )
}

export function confirmDelete(title: string, content: ReactNode, onOk: () => Promise<unknown> | void) {
  Modal.confirm({
    title,
    content,
    okText: '删除',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      await onOk()
    },
  })
}

export function useIsMobile() {
  const screens = Grid.useBreakpoint()
  return !screens.md
}

export function modalWidth(wide = false): number {
  const width = typeof window === 'undefined' ? 720 : window.innerWidth
  return Math.min(wide ? 960 : 720, width - 24)
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  )
}

export function CopyButton({ text }: { text: string }) {
  return (
    <Button
      size="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          /* clipboard is unavailable on plain HTTP */
        }
      }}
    >
      复制
    </Button>
  )
}
