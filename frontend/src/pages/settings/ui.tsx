import { Button, Space, Typography, theme } from 'antd'
import type { ReactNode } from 'react'
import { Muted } from '../../components'

/**
 * A titled block inside the settings detail pane. The pane already owns the
 * outer card, so sections only draw a divider between each other.
 */
export function SettingsSection({
  title,
  description,
  extra,
  children,
  first,
}: {
  title: ReactNode
  description?: ReactNode
  extra?: ReactNode
  children: ReactNode
  first?: boolean
}) {
  const { token } = theme.useToken()
  return (
    <section
      style={{
        marginTop: first ? 0 : 22,
        paddingTop: first ? 0 : 22,
        borderTop: first ? undefined : `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ minWidth: 180, flex: 1 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {title}
          </Typography.Text>
          {description ? (
            <div style={{ marginTop: 2 }}>
              <Muted>{description}</Muted>
            </div>
          ) : null}
        </div>
        {extra ? <div>{extra}</div> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * Inline confirmation strip. Replaces a modal for actions that only need one
 * acknowledgement (disable TOTP, kick a session, import a config file).
 */
export function InlineConfirm({
  title,
  description,
  confirmText = '确认',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: ReactNode
  description?: ReactNode
  confirmText?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: token.borderRadius,
        border: `1px solid ${danger ? token.colorErrorBorder : token.colorWarningBorder}`,
        background: danger ? token.colorErrorBg : token.colorWarningBg,
      }}
    >
      <Typography.Text strong style={{ fontSize: 13 }}>
        {title}
      </Typography.Text>
      {description ? (
        <div style={{ marginTop: 3, color: token.colorTextSecondary, fontSize: 12, lineHeight: '18px' }}>
          {description}
        </div>
      ) : null}
      <Space size={8} style={{ marginTop: 10 }}>
        <Button
          size="small"
          type="primary"
          danger={danger}
          loading={busy}
          onClick={onConfirm}
        >
          {confirmText}
        </Button>
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </Space>
    </div>
  )
}
