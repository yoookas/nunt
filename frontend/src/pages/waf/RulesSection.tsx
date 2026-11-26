import { useMemo, useState } from 'react'
import { Button, Checkbox, Divider, Empty, Form, Input, Select, Space, Tag, Tooltip, theme } from 'antd'
import { ReloadOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons'
import { Muted } from '../../components'
import { EntityRow } from '../../components/Workspace'
import type { ItemStatus } from '../../components/Workspace'
import {
  GROUP_LABEL,
  isRuleDisabled,
  normalizeDisabledRules,
  parseRange,
  ruleDisabledByServer,
  ruleRange,
  type WafRuleFile,
} from './types'

export interface RulesSectionProps {
  rules: WafRuleFile[]
  loading: boolean
  useCrs: boolean
  disabledRules: string[]
  saving?: boolean
  onRefresh: () => void
  onSave: () => void
  onDisabledRulesChange: (next: string[]) => void
}

export default function RulesSection({
  rules,
  loading,
  useCrs,
  disabledRules,
  saving = false,
  onRefresh,
  onSave,
  onDisabledRulesChange,
}: RulesSectionProps) {
  const { token } = theme.useToken()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('all')

  const groups = useMemo(() => {
    const seen = new Set<string>()
    for (const record of rules) if (record.group) seen.add(record.group)
    return Array.from(seen)
  }, [rules])

  const groupOptions = [
    { value: 'all', label: '全部分组' },
    ...groups.map((value) => ({ value, label: GROUP_LABEL[value] || value })),
  ]

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return rules.filter((record) => {
      if (group !== 'all' && record.group !== group) return false
      if (!keyword) return true
      return [record.title, record.titleEn, record.file, record.name, record.group, record.tag]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [rules, query, group])

  const enabled = (record: WafRuleFile): boolean =>
    useCrs && !ruleDisabledByServer(record) && !isRuleDisabled(disabledRules, record)

  const canToggle = (record: WafRuleFile): boolean =>
    useCrs &&
    !record.required &&
    !ruleDisabledByServer(record) &&
    !!parseRange(record.disableRange || ruleRange(record))

  const stateOf = (record: WafRuleFile): { label: string; color: string } => {
    if (!useCrs) return { label: 'CRS 已关闭', color: 'default' }
    if (ruleDisabledByServer(record)) return { label: record.reason || '未加载', color: 'red' }
    if (isRuleDisabled(disabledRules, record)) return { label: '已禁用', color: 'default' }
    return { label: '启用', color: 'green' }
  }

  const itemStatus = (record: WafRuleFile): ItemStatus => {
    if (!useCrs) return 'off'
    if (ruleDisabledByServer(record)) return 'error'
    if (isRuleDisabled(disabledRules, record)) return 'off'
    return 'ok'
  }

  const toggleRule = (record: WafRuleFile, next: boolean) => {
    if (!canToggle(record)) return
    const range = record.disableRange || ruleRange(record)
    const target = parseRange(range)
    if (!target) return
    const covered = (entry: string) => {
      const parsed = parseRange(entry)
      return !!parsed && parsed[0] <= target[0] && parsed[1] >= target[1]
    }
    if (next) {
      onDisabledRulesChange(normalizeDisabledRules(disabledRules.filter((entry) => !covered(entry))))
      return
    }
    if (disabledRules.some(covered)) return
    onDisabledRulesChange(normalizeDisabledRules([...disabledRules, range]))
  }

  const enabledCount = rules.filter((record) => enabled(record)).length

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索规则文件"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ width: 200, maxWidth: '100%' }}
        />
        <Select size="small" value={group} onChange={setGroup} options={groupOptions} style={{ width: 130 }} />
        <Muted>
          已启用 {enabledCount} / {rules.length}
        </Muted>
        <div style={{ flex: 1 }} />
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          刷新
        </Button>
      </div>

      <div
        style={{
          marginTop: 10,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {filtered.length ? (
            filtered.map((record) => {
              const state = stateOf(record)
              return (
                <EntityRow
                  key={record.file}
                  title={record.title || record.name || record.file}
                  subtitle={record.file}
                  status={itemStatus(record)}
                  meta={
                    <Space size={6} wrap>
                      <Tag>{GROUP_LABEL[record.group || ''] || record.group || '-'}</Tag>
                      <Muted>
                        {record.rules} 条 · {record.disableRange || ruleRange(record) || '-'}
                      </Muted>
                      <Tag color={state.color}>{state.label}</Tag>
                    </Space>
                  }
                  actions={
                    <Tooltip
                      title={
                        record.required
                          ? '初始化规则不能单独关闭'
                          : !useCrs
                            ? '请先启用内置 CRS'
                            : ruleDisabledByServer(record)
                              ? record.reason
                              : undefined
                      }
                    >
                      <span onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={enabled(record)}
                          disabled={!canToggle(record)}
                          onChange={(event) => toggleRule(record, event.target.checked)}
                        />
                      </span>
                    </Tooltip>
                  }
                />
              )
            })
          ) : (
            <div style={{ padding: 20 }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的规则文件" />
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <Muted>取消勾选会把规则文件的 ID 区间加入禁用列表，保存后重新编译生效。</Muted>
      </div>

      <Divider orientation="left" orientationMargin={0} plain style={{ marginTop: 16 }}>
        自定义规则
      </Divider>

      <Form.Item
        name="disabledRules"
        label="禁用规则 ID"
        extra="输入规则 ID 或区间后回车，例如 920100 或 900000-910000。"
        rules={[
          {
            validator: (_rule, value) => {
              const list = Array.isArray(value) ? value.map((item) => String(item)) : []
              const bad = list.filter((item) => !parseRange(item))
              if (bad.length) return Promise.reject(new Error(`无效的规则 ID：${bad.join('、')}`))
              return Promise.resolve()
            },
          },
        ]}
      >
        <Select
          mode="tags"
          tokenSeparators={[',', ' ']}
          placeholder="输入规则 ID 或区间后回车"
          maxTagCount={10}
        />
      </Form.Item>

      <Form.Item
        name="extraRules"
        label="自定义 SecLang"
        extra="追加到规则集末尾；编译失败时会保留上一份可用规则集。"
      >
        <Input.TextArea
          rows={5}
          spellCheck={false}
          placeholder={
            'SecRule ARGS "@contains evil" "id:100001,phase:2,deny,status:403,msg:自定义规则"'
          }
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
        />
      </Form.Item>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="small" icon={<SaveOutlined />} loading={saving} onClick={onSave}>
          保存配置
        </Button>
      </div>
    </div>
  )
}
