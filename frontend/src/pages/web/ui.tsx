// Small presentational pieces shared by the Web service page and its dialogs.
// Everything here is Ant Design; the old HeroUI chips and tag inputs have no
// equivalent outside this folder.
import { accessSummary, type Access } from '../../access'
import { Select, Space, Tag, Tooltip, Typography, theme } from 'antd'
import type { ReactNode } from 'react'
import { Muted } from '../../components'
import {
  TLS_LABEL,
  ruleTypeLabel,
  type ClientAuthMode,
  type RouteType,
  type TLSMode,
} from './types'

/** A form section heading with an optional one line description. */
export function SectionTitle({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        marginBottom: 12,
        paddingTop: 10,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Text strong>{title}</Typography.Text>
      {hint ? (
        <div style={{ marginTop: 2 }}>
          <Muted>{hint}</Muted>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Tag input built on a Select in tags mode. The dropdown is suppressed: values
 * are added with Enter (or a comma) exactly like the old chip input.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
}: {
  value?: string[]
  onChange?: (value: string[]) => void
  placeholder?: string
  id?: string
  ariaLabel?: string
}) {
  return (
    <Select
      id={id}
      mode="tags"
      value={Array.isArray(value) ? value : []}
      onChange={(next: string[]) => onChange?.(next)}
      placeholder={placeholder}
      tokenSeparators={[',', '，']}
      open={false}
      suffixIcon={null}
      filterOption={false}
      notFoundContent={null}
      aria-label={ariaLabel}
      style={{ width: '100%' }}
    />
  )
}

/** A TLS mode chip with the mTLS / HSTS extras of the owning listener. */
export function TlsTag({
  mode,
  clientAuth,
  hsts,
}: {
  mode: TLSMode
  clientAuth?: ClientAuthMode
  hsts?: boolean
}) {
  const color = mode === 'auto' ? 'green' : mode === 'custom' ? 'blue' : 'default'
  const label = mode === 'off' ? 'TLS 关' : mode === 'auto' ? 'TLS 自动' : 'TLS 指定'
  return (
    <Space size={[4, 4]} wrap>
      <Tooltip title={`TLS：${TLS_LABEL[mode] || mode}`}>
        <Tag color={color} style={{ marginInlineEnd: 0 }}>
          {label}
        </Tag>
      </Tooltip>
      {mode !== 'off' && clientAuth && clientAuth !== 'off' ? (
        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
          mTLS
        </Tag>
      ) : null}
      {mode !== 'off' && hsts ? (
        <Tag style={{ marginInlineEnd: 0 }}>HSTS</Tag>
      ) : null}
    </Space>
  )
}

/** Access policy chip. `inherit` only makes sense on a route. */
export function AccessTag({ access }: { access?: Access | null }) {
  const summary = accessSummary(access)
  const color =
    !access || access.mode === 'off'
      ? undefined
      : access.mode === 'inherit'
        ? 'geekblue'
        : access.ip?.rest === 'deny'
          ? 'volcano'
          : 'orange'
  return (
    <Tooltip title="从上到下匹配，第一条命中的生效">
      <Tag color={color} style={{ marginInlineEnd: 0 }}>
        {summary}
      </Tag>
    </Tooltip>
  )
}

const TYPE_COLOR: Record<string, string> = {
  proxy: 'blue',
  redirect: 'orange',
  static: 'green',
}

/** Route type chip. */
export function RouteTypeTag({ type }: { type: RouteType | string }) {
  return (
    <Tag color={TYPE_COLOR[String(type)] || 'default'} style={{ marginInlineEnd: 0 }}>
      {ruleTypeLabel(type)}
    </Tag>
  )
}

/** Listen addresses rendered as monospace chips. */
export function ListenAddresses({ addresses }: { addresses?: string[] }) {
  const list = (Array.isArray(addresses) ? addresses : []).filter(Boolean)
  if (!list.length) return <Muted>未配置</Muted>
  return (
    <Space size={[4, 4]} wrap>
      {list.map((address, index) => (
        <Tag key={`${address}-${index}`} className="mono" style={{ marginInlineEnd: 0 }}>
          {address}
        </Tag>
      ))}
    </Space>
  )
}
