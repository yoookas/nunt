import { useMemo, useState } from 'react'
import { Button, Checkbox, Form, Input, Select, Tag, Tooltip, type TableColumnsType } from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { DataTable, Muted, Panel, Toolbar } from '../../components'
import {
  GROUP_LABEL,
  isRuleDisabled,
  normalizeDisabledRules,
  parseRange,
  ruleDisabledByServer,
  ruleRange,
  type WafRuleFile,
} from './types'

export interface RulesPanelProps {
  rules: WafRuleFile[]
  loading: boolean
  useCrs: boolean
  disabledRules: string[]
  onRefresh: () => void
  onDisabledRulesChange: (next: string[]) => void
}

export default function RulesPanel({
  rules,
  loading,
  useCrs,
  disabledRules,
  onRefresh,
  onDisabledRulesChange,
}: RulesPanelProps) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('all')

  const groups = useMemo(() => {
    const seen = new Set<string>()
    for (const record of rules) {
      if (record.group) seen.add(record.group)
    }
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

  const canToggle = (record: WafRuleFile): boolean =>
    useCrs &&
    !record.required &&
    !ruleDisabledByServer(record) &&
    !!parseRange(record.disableRange || ruleRange(record))

  const ruleEnabled = (record: WafRuleFile): boolean =>
    useCrs && !ruleDisabledByServer(record) && !isRuleDisabled(disabledRules, record)

  const ruleState = (record: WafRuleFile): { label: string; color: string } => {
    if (!useCrs) return { label: 'CRS 已关闭', color: 'default' }
    if (ruleDisabledByServer(record)) return { label: record.reason || '未加载', color: 'red' }
    if (isRuleDisabled(disabledRules, record)) return { label: '已禁用', color: 'default' }
    return { label: '启用', color: 'green' }
  }

  const toggleRule = (record: WafRuleFile, enabled: boolean) => {
    if (!canToggle(record)) return
    const range = record.disableRange || ruleRange(record)
    const target = parseRange(range)
    if (!target) return
    const covered = (entry: string) => {
      const parsed = parseRange(entry)
      return !!parsed && parsed[0] <= target[0] && parsed[1] >= target[1]
    }
    if (enabled) {
      onDisabledRulesChange(normalizeDisabledRules(disabledRules.filter((entry) => !covered(entry))))
      return
    }
    if (disabledRules.some(covered)) return
    onDisabledRulesChange(normalizeDisabledRules([...disabledRules, range]))
  }

  const enabledCount = rules.filter((record) => ruleEnabled(record)).length

  const columns: TableColumnsType<WafRuleFile> = [
    {
      key: 'enabled',
      title: '启用',
      width: 64,
      render: (_, record) => (
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
          <Checkbox
            checked={ruleEnabled(record)}
            disabled={!canToggle(record)}
            onChange={(event) => toggleRule(record, event.target.checked)}
          />
        </Tooltip>
      ),
    },
    {
      key: 'title',
      title: '规则文件',
      render: (_, record) => (
        <div>
          <div>{record.title || record.name || record.file}</div>
          <Muted>{record.file}</Muted>
          {record.tag ? (
            <div>
              <Muted>{record.tag}</Muted>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'group',
      title: '分组',
      responsive: ['md'],
      render: (_, record) => (
        <Tag>{GROUP_LABEL[record.group || ''] || record.group || '-'}</Tag>
      ),
    },
    {
      key: 'rules',
      title: '规则数',
      width: 90,
      responsive: ['lg'],
      render: (_, record) => String(record.rules ?? '-'),
    },
    {
      key: 'range',
      title: 'ID 区间',
      responsive: ['md'],
      render: (_, record) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {record.disableRange || ruleRange(record) || '-'}
        </span>
      ),
    },
    {
      key: 'state',
      title: '状态',
      width: 130,
      render: (_, record) => {
        const state = ruleState(record)
        return <Tag color={state.color}>{state.label}</Tag>
      },
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel
        title="规则文件"
        subtitle="勾选启用；取消勾选会禁用该文件"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
        }
      >
        <Toolbar>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="按文件、分组或标签搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: 260, maxWidth: '100%' }}
          />
          <Select
            value={group}
            onChange={setGroup}
            options={groupOptions}
            style={{ width: 140, maxWidth: '100%' }}
          />
          <Muted>
            已启用 {enabledCount} / {rules.length} · 显示 {filtered.length} 个
          </Muted>
        </Toolbar>

        <div style={{ marginTop: 12 }}>
          <DataTable<WafRuleFile>
            dataSource={filtered}
            columns={columns}
            rowKey="file"
            loading={loading}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <Muted>
            取消勾选后需点右上角「保存配置」重新编译才会生效；标有必选的初始化文件不能单独关闭。CRS
            关闭时规则文件不可切换。
          </Muted>
        </div>
      </Panel>

      <Panel title="自定义规则" subtitle="禁用规则 ID、额外 SecLang 规则；保存后立即重新编译">
        <Form.Item
          name="disabledRules"
          label="禁用规则 ID"
          extra="输入规则 ID 或 ID 区间后回车，例如 920100 或 900000-910000。只接受数字与「-」。"
          rules={[
            {
              validator: (_rule, value) => {
                const list = Array.isArray(value) ? value.map((item) => String(item)) : []
                const bad = list.filter((item) => !parseRange(item))
                if (bad.length) {
                  return Promise.reject(new Error(`无效的规则 ID：${bad.join('、')}`))
                }
                return Promise.resolve()
              },
            },
          ]}
        >
          <Select
            mode="tags"
            tokenSeparators={[',', ' ']}
            placeholder="输入规则 ID 或 ID 区间后回车"
            maxTagCount={10}
          />
        </Form.Item>

        <Form.Item
          name="extraRules"
          label="额外 SecLang 规则"
          extra="追加到规则集末尾；保存后立即重新编译，语法错误时服务端会保留上一份可用规则集。"
        >
          <Input.TextArea
            rows={8}
            spellCheck={false}
            placeholder={
              '追加的 SecLang 规则，例如：\nSecRule ARGS "@contains evil" "id:100001,phase:2,deny,status:403,msg:自定义规则"'
            }
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          />
        </Form.Item>
      </Panel>
    </div>
  )
}
