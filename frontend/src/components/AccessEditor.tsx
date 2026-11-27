import { Button, Input, Select, Space, Tag, Typography } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import {
  emptyAccess,
  normalizeAccess,
  type Access,
  type AccessEntry,
  type AccessList,
} from '../access'

const ACTION_OPTIONS = [
  { value: 'allow', label: '允许' },
  { value: 'deny', label: '拒绝' },
]

const ADDRESS_KINDS = [
  { value: 'ip', label: 'IP 段' },
  { value: 'geo', label: '地区' },
]

/**
 * Editor for one ordered list. The last row is the pinned "everything else"
 * action: it cannot be moved or removed, because the walk always ends there.
 */
function ListEditor({
  title,
  hint,
  list,
  kinds,
  placeholder,
  onChange,
}: {
  title: string
  hint: string
  list: AccessList
  kinds: { value: string; label: string }[]
  placeholder: (kind: string) => string
  onChange: (next: AccessList) => void
}) {
  const patch = (index: number, next: Partial<AccessEntry>) => {
    onChange({
      ...list,
      entries: list.entries.map((entry, i) => (i === index ? { ...entry, ...next } : entry)),
    })
  }

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= list.entries.length) return
    const entries = [...list.entries]
    const [item] = entries.splice(index, 1)
    entries.splice(target, 0, item)
    onChange({ ...list, entries })
  }

  const remove = (index: number) => {
    onChange({ ...list, entries: list.entries.filter((_, i) => i !== index) })
  }

  const add = () => {
    const entry: AccessEntry = {
      action: 'allow',
      kind: kinds[0].value as AccessEntry['kind'],
      value: '',
    }
    // Adding a rule never touches the "everything else" action: flipping it
    // under the operator was the surprising part, and the default already
    // matches what a new list means.
    onChange({ ...list, entries: [...list.entries, entry] })
  }

  return (
    <div style={{ marginTop: 8 }}>
      <Space size={6} style={{ marginBottom: 4 }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      </Space>
      {list.entries.map((entry, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <Tag style={{ marginInlineEnd: 0, minWidth: 26, textAlign: 'center' }}>{index + 1}</Tag>
          <Select
            size="small"
            value={entry.action}
            options={ACTION_OPTIONS}
            style={{ width: 84 }}
            onChange={(value) => patch(index, { action: value })}
          />
          <Select
            size="small"
            value={entry.kind}
            options={kinds}
            style={{ width: 96 }}
            disabled={kinds.length < 2}
            onChange={(value) => patch(index, { kind: value, value: '' })}
          />
          <Input
            size="small"
            value={entry.value}
            placeholder={placeholder(entry.kind)}
            onChange={(event) => patch(index, { value: event.target.value })}
          />
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            aria-label="上移"
            disabled={index === 0}
            onClick={() => move(index, -1)}
          />
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            aria-label="下移"
            disabled={index === list.entries.length - 1}
            onClick={() => move(index, 1)}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除这条规则"
            onClick={() => remove(index)}
          />
        </div>
      ))}
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          padding: '6px 8px',
          marginBottom: 6,
          borderRadius: 6,
          background: 'rgba(0,0,0,0.03)',
        }}
      >
        <Tag style={{ marginInlineEnd: 0, minWidth: 26, textAlign: 'center' }}>…</Tag>
        <Typography.Text type="secondary">其余流量</Typography.Text>
        <Select
          size="small"
          value={list.rest}
          options={ACTION_OPTIONS}
          style={{ width: 84 }}
          onChange={(value) => onChange({ ...list, rest: value })}
        />
      </div>
      <Button size="small" icon={<PlusOutlined />} onClick={add}>
        添加规则
      </Button>
    </div>
  )
}

/** Address rules plus the optional client (user agent) list. */
export default function AccessEditor({
  value,
  onChange,
  allowUA = true,
  allowInherit = true,
}: {
  value?: Access
  onChange?: (next: Access) => void
  allowUA?: boolean
  allowInherit?: boolean
}) {
  // keepEmpty: a row that was just added still has no value, and dropping it
  // here would make the button look broken.
  const access = normalizeAccess(value ?? emptyAccess(), { keepEmpty: true })
  const update = (next: Partial<Access>) => onChange?.({ ...access, ...next })

  return (
    <div>
      <Select
        value={access.mode}
        style={{ width: 200 }}
        onChange={(mode) => update({ mode })}
        options={[
          { value: 'off', label: '关闭（不过滤）' },
          { value: 'rules', label: '自定义规则' },
          ...(allowInherit ? [{ value: 'inherit', label: '继承监听器' }] : []),
        ]}
      />
      {access.mode === 'rules' ? (
        <>
          <ListEditor
            title="IP 与地区"
            hint="从上到下匹配，第一条命中即生效"
            list={access.ip}
            kinds={ADDRESS_KINDS}
            placeholder={(kind) =>
              kind === 'geo' ? '国家 / 省 / 城市，例如 浙江' : 'IP 或网段，例如 10.0.0.0/8'
            }
            onChange={(ip) => update({ ip })}
          />
          {allowUA ? (
            <ListEditor
              title="客户端标识（UA）"
              hint="按子串匹配，例如 curl 或 *bot*"
              list={access.ua}
              kinds={[{ value: 'ua', label: 'UA' }]}
              placeholder={() => 'UA 片段，例如 bot'}
              onChange={(ua) => update({ ua })}
            />
          ) : null}
        </>
      ) : null}
      {access.mode === 'inherit' ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          使用所属监听器的规则，包括它的“其余”动作。
        </Typography.Text>
      ) : null}
    </div>
  )
}
