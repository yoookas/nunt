import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Dropdown,
  Empty,
  Grid,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../api'
import { DataTable, Muted, PageHeader, Panel, Toolbar, useIsMobile } from '../components'
import ListenerModal from './web/ListenerModal'
import LogsModal from './web/LogsModal'
import RouteModal from './web/RouteModal'
import { AccessTag, ListenAddresses, RouteTypeTag, TlsTag } from './web/ui'
import {
  TYPE_OPTIONS,
  listenerName,
  normalizeAccessMode,
  targetText,
  tlsModeOf,
  type Certificate,
  type ListResponse,
  type WebListenerView,
  type WebRule,
} from './web/types'

const numberFormat = new Intl.NumberFormat('zh-CN')

function fmtCount(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? numberFormat.format(n) : '0'
}

/**
 * mergeVisibleOrder keeps the positions of the items a filter currently shows
 * and fills them with the new visible order, leaving hidden items where they
 * are. The reorder API always wants the complete list, so a filtered route
 * list must not move items the user cannot see.
 */
function mergeVisibleOrder(all: WebRule[], visibleIds: string[]): WebRule[] {
  const visible = new Set(visibleIds)
  const byId = new Map(all.map((item) => [item.id, item]))
  const slots: number[] = []
  all.forEach((item, index) => {
    if (visible.has(item.id)) slots.push(index)
  })
  const out = [...all]
  slots.forEach((slot, index) => {
    const item = byId.get(visibleIds[index])
    if (item !== undefined) out[slot] = item
  })
  return out
}

export default function Web() {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const screens = Grid.useBreakpoint()
  const isMobile = useIsMobile()
  const sideBySide = !!screens.xl

  const [listeners, setListeners] = useState<WebListenerView[]>([])
  const [rules, setRules] = useState<WebRule[]>([])
  const [certificates, setCertificates] = useState<Certificate[]>([])

  const [selectedListenerId, setSelectedListenerId] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [search, setSearch] = useState('')

  const [listenerLoading, setListenerLoading] = useState(true)
  const [rulesLoading, setRulesLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [listenerError, setListenerError] = useState('')
  const [ruleError, setRuleError] = useState('')
  const [busyListenerId, setBusyListenerId] = useState('')
  const [busyRuleId, setBusyRuleId] = useState('')
  const [reordering, setReordering] = useState(false)

  const [listenerModal, setListenerModal] = useState<{
    open: boolean
    listener: WebListenerView | null
  }>({ open: false, listener: null })
  const [routeModal, setRouteModal] = useState<{ open: boolean; rule: WebRule | null }>({
    open: false,
    rule: null,
  })
  const [logsRule, setLogsRule] = useState<WebRule | null>(null)

  const loadListeners = useCallback(
    async (silent = false) => {
      if (!silent) setListenerLoading(true)
      try {
        const data = await api.get<ListResponse<WebListenerView>>('/api/v1/web/listeners')
        const items = Array.isArray(data?.items) ? data.items : []
        setListeners(items)
        setSelectedListenerId((current) =>
          current !== 'all' && !items.some((item) => item.id === current) ? 'all' : current,
        )
        setListenerError('')
      } catch (err) {
        const text = errorText(err)
        setListenerError(text)
        message.error(text)
      } finally {
        if (!silent) setListenerLoading(false)
      }
    },
    [message],
  )

  const loadRules = useCallback(
    async (silent = false) => {
      if (!silent) setRulesLoading(true)
      try {
        const data = await api.get<ListResponse<WebRule>>('/api/v1/web/rules')
        setRules(Array.isArray(data?.items) ? data.items : [])
        setRuleError('')
      } catch (err) {
        const text = errorText(err)
        setRuleError(text)
        message.error(text)
      } finally {
        if (!silent) setRulesLoading(false)
      }
    },
    [message],
  )

  const loadCertificates = useCallback(async () => {
    try {
      const data = await api.get<ListResponse<Certificate>>('/api/v1/acme/certificates')
      setCertificates(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      message.error(errorText(err))
    }
  }, [message])

  const refreshAll = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        await Promise.all([loadListeners(silent), loadRules(silent), loadCertificates()])
      } finally {
        if (!silent) setRefreshing(false)
      }
    },
    [loadListeners, loadRules, loadCertificates],
  )

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const listenerOf = (listenerId: string): WebListenerView | null =>
    listeners.find((item) => item.id === listenerId) || null

  const listenerRouteCount = (listener: WebListenerView): number => {
    if (listener.routeCount !== undefined && Number.isFinite(Number(listener.routeCount))) {
      return Number(listener.routeCount)
    }
    return rules.filter((rule) => rule.listenerId === listener.id).length
  }

  const filteredRules = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return rules.filter((rule) => {
      if (selectedListenerId !== 'all' && rule.listenerId !== selectedListenerId) return false
      if (typeFilter !== 'all' && rule.type !== typeFilter) return false
      if (!keyword) return true
      const hay = [
        rule.name,
        rule.id,
        rule.path,
        rule.remark,
        listenerName(listeners, rule.listenerId),
        ...(Array.isArray(rule.domains) ? rule.domains : []),
        ...(Array.isArray(rule.proxy?.targets) ? rule.proxy?.targets ?? [] : []),
        ...(Array.isArray(rule.upstreams) ? rule.upstreams : []),
        rule.redirect?.to,
        rule.static?.root,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(keyword)
    })
  }, [rules, selectedListenerId, typeFilter, search, listeners])

  const ruleOrderIndex = useMemo(() => {
    const map = new Map<string, number>()
    filteredRules.forEach((rule, index) => map.set(rule.id, index))
    return map
  }, [filteredRules])

  const routeEmptyText = useMemo(() => {
    if (!listeners.length) return '还没有监听器，请先新建监听器'
    if (!rules.length) return '还没有 Web 路由，点击右上角「新建路由」'
    if (!filteredRules.length) {
      return selectedListenerId === 'all' ? '没有匹配的路由' : '该监听器下没有匹配的路由'
    }
    return '暂无数据'
  }, [listeners.length, rules.length, filteredRules.length, selectedListenerId])

  // ------------------------------------------------------------------ 操作

  const toggleListener = async (listener: WebListenerView, enabled: boolean) => {
    if (busyListenerId) return
    setBusyListenerId(listener.id)
    try {
      await api.post(`/api/v1/web/listeners/${encodeURIComponent(listener.id)}/toggle`)
      message.success(enabled ? '监听器已启用' : '监听器已停用')
      await Promise.all([loadListeners(true), loadRules(true)])
    } catch (err) {
      message.error(errorText(err))
      await loadListeners(true)
    } finally {
      setBusyListenerId('')
    }
  }

  const toggleRule = async (rule: WebRule, enabled: boolean) => {
    if (busyRuleId) return
    const previous = rule.enable
    setBusyRuleId(rule.id)
    setRules((current) =>
      current.map((item) => (item.id === rule.id ? { ...item, enable: enabled } : item)),
    )
    try {
      const data = await api.post<{ id: string; enable: boolean }>(
        `/api/v1/web/rules/${encodeURIComponent(rule.id)}/toggle`,
      )
      const next = !!data?.enable
      message.success(next ? '路由已启用' : '路由已停用')
      await loadRules(true)
    } catch (err) {
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? { ...item, enable: previous } : item)),
      )
      message.error(errorText(err))
    } finally {
      setBusyRuleId('')
    }
  }

  const moveListener = async (id: string, direction: -1 | 1) => {
    if (reordering) return
    const index = listeners.findIndex((item) => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= listeners.length) return
    const next = [...listeners]
    ;[next[index], next[target]] = [next[target], next[index]]
    setListeners(next)
    setReordering(true)
    try {
      await api.post('/api/v1/web/listeners/order', { ids: next.map((item) => item.id) })
    } catch (err) {
      message.error(errorText(err))
      await loadListeners(true)
    } finally {
      setReordering(false)
    }
  }

  const moveRule = async (id: string, direction: -1 | 1) => {
    if (reordering) return
    const visibleIds = filteredRules.map((rule) => rule.id)
    const index = visibleIds.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= visibleIds.length) return
    const nextVisible = [...visibleIds]
    ;[nextVisible[index], nextVisible[target]] = [nextVisible[target], nextVisible[index]]
    const nextAll = mergeVisibleOrder(rules, nextVisible)
    setRules(nextAll)
    setReordering(true)
    try {
      await api.post('/api/v1/web/rules/order', { ids: nextAll.map((rule) => rule.id) })
    } catch (err) {
      message.error(errorText(err))
      await loadRules(true)
    } finally {
      setReordering(false)
    }
  }

  const openCreateListener = () => setListenerModal({ open: true, listener: null })
  const openEditListener = (listener: WebListenerView) =>
    setListenerModal({ open: true, listener })

  const openCreateRule = () => {
    if (!listeners.length) {
      message.warning('请先新建一个监听器，路由需要绑定监听器')
      return
    }
    setRouteModal({ open: true, rule: null })
  }
  const openEditRule = (rule: WebRule) => setRouteModal({ open: true, rule })

  const askDeleteListener = (listener: WebListenerView) => {
    modal.confirm({
      title: '删除监听器',
      content: (
        <span>
          确定删除监听器「{listener.name || listener.id}」吗？该操作不可撤销。
          如果该监听器下还有路由，后端会拒绝删除并返回原因。
        </span>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await api.del(`/api/v1/web/listeners/${encodeURIComponent(listener.id)}`)
          message.success('监听器已删除')
          if (selectedListenerId === listener.id) setSelectedListenerId('all')
          await refreshAll(true)
        } catch (err) {
          message.error(errorText(err))
        }
      },
    })
  }

  const askDeleteRule = (rule: WebRule) => {
    modal.confirm({
      title: '删除 Web 路由',
      content: (
        <span>
          确定删除路由「{rule.name || rule.id}」吗？该操作不可撤销。
        </span>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await api.del(`/api/v1/web/rules/${encodeURIComponent(rule.id)}`)
          message.success('路由已删除')
          await refreshAll(true)
        } catch (err) {
          message.error(errorText(err))
        }
      },
    })
  }

  // ------------------------------------------------------------------ 监听器

  const listenerMenu = (listener: WebListenerView, index: number) => ({
    items: [
      { key: 'edit', icon: <EditOutlined />, label: '编辑' },
      {
        key: 'up',
        icon: <ArrowUpOutlined />,
        label: '上移',
        disabled: index <= 0 || reordering,
      },
      {
        key: 'down',
        icon: <ArrowDownOutlined />,
        label: '下移',
        disabled: index >= listeners.length - 1 || reordering,
      },
      { type: 'divider' as const },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'edit') openEditListener(listener)
      if (key === 'up') void moveListener(listener.id, -1)
      if (key === 'down') void moveListener(listener.id, 1)
      if (key === 'delete') askDeleteListener(listener)
    },
  })

  const listenerColumns: TableColumnsType<WebListenerView> = [
    {
      key: 'sort',
      title: '排序',
      width: 48,
      render: (_value, row, index) => (
        <Space direction="vertical" size={0}>
          <Tooltip title="上移">
            <Button
              type="text"
              size="small"
              icon={<ArrowUpOutlined />}
              disabled={index <= 0 || reordering}
              onClick={() => void moveListener(row.id, -1)}
              aria-label={`上移监听器 ${row.name || row.id}`}
            />
          </Tooltip>
          <Tooltip title="下移">
            <Button
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              disabled={index >= listeners.length - 1 || reordering}
              onClick={() => void moveListener(row.id, 1)}
              aria-label={`下移监听器 ${row.name || row.id}`}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      key: 'listener',
      title: '监听器',
      render: (_value, row) => (
        <div style={{ minWidth: 0 }}>
          <Space size={[4, 4]} wrap>
            <Typography.Text strong>{row.name || row.id}</Typography.Text>
            <TlsTag
              mode={tlsModeOf(row)}
              clientAuth={row.tls?.clientAuth}
              hsts={row.tls?.hsts}
            />
            {row.disabled ? <Tag color="orange">已停用</Tag> : null}
          </Space>
          <div style={{ marginTop: 4 }}>
            <ListenAddresses addresses={row.listen} />
          </div>
          <div style={{ marginTop: 4 }}>
            <Muted>
              {listenerRouteCount(row)} 条路由
              {row.remark ? ` · ${row.remark}` : ''}
            </Muted>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 72,
      render: (_value, row) => (
        <Tooltip title={row.disabled ? '已停用，点击启用' : '运行中，点击停用'}>
          <Switch
            size="small"
            checked={!row.disabled}
            loading={busyListenerId === row.id}
            onChange={(checked) => void toggleListener(row, checked)}
            aria-label={`启停监听器 ${row.name || row.id}`}
          />
        </Tooltip>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 48,
      render: (_value, row, index) => (
        <Dropdown menu={listenerMenu(row, index)} trigger={['click']} placement="bottomRight">
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            aria-label={`监听器操作 ${row.name || row.id}`}
          />
        </Dropdown>
      ),
    },
  ]

  // ------------------------------------------------------------------ 路由

  const routeMenu = (rule: WebRule) => ({
    items: [
      { key: 'logs', icon: <FileTextOutlined />, label: '访问日志' },
      { key: 'edit', icon: <EditOutlined />, label: '编辑路由' },
      { type: 'divider' as const },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除路由', danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'logs') setLogsRule(rule)
      if (key === 'edit') openEditRule(rule)
      if (key === 'delete') askDeleteRule(rule)
    },
  })

  const routeColumns: TableColumnsType<WebRule> = [
    {
      key: 'sort',
      title: '排序',
      width: 48,
      render: (_value, row) => {
        const index = ruleOrderIndex.get(row.id) ?? -1
        return (
          <Space direction="vertical" size={0}>
            <Tooltip title="上移">
              <Button
                type="text"
                size="small"
                icon={<ArrowUpOutlined />}
                disabled={index <= 0 || reordering}
                onClick={() => void moveRule(row.id, -1)}
                aria-label={`上移路由 ${row.name || row.id}`}
              />
            </Tooltip>
            <Tooltip title="下移">
              <Button
                type="text"
                size="small"
                icon={<ArrowDownOutlined />}
                disabled={index < 0 || index >= filteredRules.length - 1 || reordering}
                onClick={() => void moveRule(row.id, 1)}
                aria-label={`下移路由 ${row.name || row.id}`}
              />
            </Tooltip>
          </Space>
        )
      },
    },
    {
      key: 'site',
      title: '站点',
      render: (_value, row) => {
        const domains = Array.isArray(row.domains) ? row.domains : []
        return (
          <div style={{ minWidth: 0, maxWidth: 260 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {domains.length ? (
                <Typography.Text
                  strong
                  ellipsis={{
                    tooltip: (
                      <span style={{ whiteSpace: 'pre-line' }}>{domains.join('\n')}</span>
                    ),
                  }}
                  style={{ maxWidth: 200 }}
                >
                  {domains[0]}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">全部域名</Typography.Text>
              )}
              {domains.length > 1 ? <Tag>+{domains.length - 1}</Tag> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <Typography.Text className="mono" style={{ fontSize: 12 }}>
                {row.path || '/'}
              </Typography.Text>
              <Typography.Text
                type="secondary"
                ellipsis={{ tooltip: row.name || row.id }}
                style={{ fontSize: 12, maxWidth: 170 }}
              >
                {row.name || row.id}
              </Typography.Text>
            </div>
            {selectedListenerId === 'all' ? (
              <Tag color="geekblue" style={{ marginTop: 4 }}>
                {listenerName(listeners, row.listenerId)}
              </Tag>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'target',
      title: '类型 / 上游',
      width: 220,
      render: (_value, row) => (
        <div style={{ minWidth: 0, maxWidth: 220 }}>
          <RouteTypeTag type={row.type} />
          <Typography.Text
            type="secondary"
            className="mono"
            ellipsis={{ tooltip: targetText(row) }}
            style={{ display: 'block', fontSize: 12, marginTop: 2 }}
          >
            {targetText(row)}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'security',
      title: '安全',
      width: 180,
      responsive: ['lg'],
      render: (_value, row) => {
        const listener = listenerOf(row.listenerId)
        return (
          <Space size={[4, 4]} wrap>
            <TlsTag
              mode={tlsModeOf(listener)}
              clientAuth={listener?.tls?.clientAuth}
              hsts={listener?.tls?.hsts}
            />
            <Tag color={row.waf ? 'volcano' : 'default'}>WAF {row.waf ? '开' : '关'}</Tag>
          </Space>
        )
      },
    },
    {
      key: 'access',
      title: '访问',
      width: 110,
      responsive: ['lg'],
      render: (_value, row) => (
        <Space size={[4, 4]} wrap>
          <AccessTag mode={normalizeAccessMode(row.access?.mode)} />
          {row.basicAuth?.enable ? <Tag color="purple">认证</Tag> : null}
        </Space>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 150,
      render: (_value, row) => (
        <div>
          <Space size={6} align="center" wrap>
            <Switch
              size="small"
              checked={row.enable}
              loading={busyRuleId === row.id}
              onChange={(checked) => void toggleRule(row, checked)}
              aria-label={`启停路由 ${row.name || row.id}`}
            />
            {!row.enable ? (
              <Muted>已停用</Muted>
            ) : row.active ? (
              <Tag color="green">运行中</Tag>
            ) : (
              <Tooltip title={row.configError || '监听器未运行或配置尚未生效'}>
                <Tag color="orange" icon={<WarningOutlined />}>
                  未生效
                </Tag>
              </Tooltip>
            )}
          </Space>
          <div style={{ marginTop: 2 }}>
            <Muted>{fmtCount(row.requests)} 次请求</Muted>
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 48,
      render: (_value, row) => (
        <Dropdown menu={routeMenu(row)} trigger={['click']} placement="bottomRight">
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            aria-label={`路由操作 ${row.name || row.id}`}
          />
        </Dropdown>
      ),
    },
  ]

  // ------------------------------------------------------------------ 渲染

  const listenerTable = (
    <DataTable<WebListenerView>
      rowKey={(row) => row.id}
      columns={listenerColumns}
      dataSource={listeners}
      loading={listenerLoading}
      pagination={false}
      scroll={{}}
      locale={{
        emptyText: (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有监听器">
            <Button size="small" type="primary" onClick={openCreateListener}>
              新建监听器
            </Button>
          </Empty>
        ),
      }}
    />
  )

  const listenerCards = (
    <div>
      {listenerLoading && !listeners.length ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : listeners.length ? (
        listeners.map((listener, index) => (
          <div
            key={listener.id}
            style={{
              padding: '10px 12px',
              borderBottom:
                index < listeners.length - 1 ? `1px solid ${token.colorBorderSecondary}` : undefined,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={[4, 4]} wrap>
                  <Typography.Text strong>{listener.name || listener.id}</Typography.Text>
                  <TlsTag
                    mode={tlsModeOf(listener)}
                    clientAuth={listener.tls?.clientAuth}
                    hsts={listener.tls?.hsts}
                  />
                  {listener.disabled ? <Tag color="orange">已停用</Tag> : null}
                </Space>
                <div style={{ marginTop: 4 }}>
                  <ListenAddresses addresses={listener.listen} />
                </div>
                <div style={{ marginTop: 4 }}>
                  <Muted>
                    {listenerRouteCount(listener)} 条路由
                    {listener.remark ? ` · ${listener.remark}` : ''}
                  </Muted>
                </div>
              </div>
              <Space size={2} align="start">
                <Tooltip title={listener.disabled ? '已停用，点击启用' : '运行中，点击停用'}>
                  <Switch
                    size="small"
                    checked={!listener.disabled}
                    loading={busyListenerId === listener.id}
                    onChange={(checked) => void toggleListener(listener, checked)}
                    aria-label={`启停监听器 ${listener.name || listener.id}`}
                  />
                </Tooltip>
                <Dropdown
                  menu={listenerMenu(listener, index)}
                  trigger={['click']}
                  placement="bottomRight"
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<MoreOutlined />}
                    aria-label={`监听器操作 ${listener.name || listener.id}`}
                  />
                </Dropdown>
              </Space>
            </div>
          </div>
        ))
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有监听器" style={{ padding: 24 }}>
          <Button size="small" type="primary" onClick={openCreateListener}>
            新建监听器
          </Button>
        </Empty>
      )}
    </div>
  )

  const listenerPanel = (
    <Panel
      title="监听器"
      extra={<Muted>{listeners.length} 个</Muted>}
      bodyStyle={{ padding: 0 }}
    >
      {listenerError ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: 12 }}
          message="加载监听器失败"
          description={listenerError}
          action={
            <Button size="small" onClick={() => void loadListeners()}>
              重试
            </Button>
          }
        />
      ) : null}
      {isMobile ? listenerCards : listenerTable}
    </Panel>
  )

  const routePanel = (
    <Panel
      title="路由"
      extra={
        <Muted>
          共 {rules.length} 条 · 显示 {filteredRules.length} 条
        </Muted>
      }
      bodyStyle={{ padding: 0 }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Toolbar>
          <Select
            aria-label="按监听器筛选"
            value={selectedListenerId}
            onChange={setSelectedListenerId}
            options={[
              { value: 'all', label: '全部监听器' },
              ...listeners.map((listener) => ({
                value: listener.id,
                label: listener.name || listener.id,
              })),
            ]}
            style={{ width: isMobile ? '100%' : 160 }}
          />
          <Select
            aria-label="按类型筛选"
            value={typeFilter}
            onChange={setTypeFilter}
            options={[{ value: 'all', label: '全部类型' }, ...TYPE_OPTIONS]}
            style={{ width: isMobile ? '100%' : 130 }}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索域名 / 路径 / 上游"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: isMobile ? '100%' : 240 }}
          />
        </Toolbar>
      </div>

      {ruleError ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: 12 }}
          message="加载路由失败"
          description={ruleError}
          action={
            <Button size="small" onClick={() => void loadRules()}>
              重试
            </Button>
          }
        />
      ) : null}

      <DataTable<WebRule>
        rowKey={(row) => row.id}
        columns={routeColumns}
        dataSource={filteredRules}
        loading={rulesLoading}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={rulesLoading ? '加载中…' : routeEmptyText}
            >
              {!listeners.length ? (
                <Button size="small" type="primary" onClick={openCreateListener}>
                  新建监听器
                </Button>
              ) : rules.length ? null : (
                <Button size="small" type="primary" onClick={openCreateRule}>
                  新建路由
                </Button>
              )}
            </Empty>
          ),
        }}
      />
    </Panel>
  )

  return (
    <div>
      <PageHeader
        title="Web 服务"
        subtitle="监听器负责端口与 TLS，路由按域名/路径选择上游"
        extra={
          <>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refreshAll()}
            >
              刷新
            </Button>
            <Button icon={<PlusOutlined />} onClick={openCreateListener}>
              新建监听器
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateRule}>
              新建路由
            </Button>
          </>
        }
      />

      {sideBySide ? (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={8} xxl={7}>
            {listenerPanel}
          </Col>
          <Col xs={24} xl={16} xxl={17}>
            {routePanel}
          </Col>
        </Row>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {listenerPanel}
          {routePanel}
        </Space>
      )}

      <ListenerModal
        open={listenerModal.open}
        listener={listenerModal.listener}
        certificates={certificates}
        onClose={() => setListenerModal({ open: false, listener: null })}
        onSaved={() => void refreshAll(true)}
      />

      <RouteModal
        open={routeModal.open}
        rule={routeModal.rule}
        listeners={listeners}
        defaultListenerId={
          selectedListenerId !== 'all'
            ? selectedListenerId
            : listeners.length === 1
              ? listeners[0].id
              : ''
        }
        onClose={() => setRouteModal({ open: false, rule: null })}
        onSaved={() => void refreshAll(true)}
      />

      <LogsModal open={!!logsRule} rule={logsRule} onClose={() => setLogsRule(null)} />
    </div>
  )
}
