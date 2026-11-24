import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, ListBox, Select, Switch } from '@heroui/react'
import { Pencil, Trash2 } from 'lucide-react'
import { api, errorText } from '../api'
import {
  ConfirmModal,
  DataTable,
  Page,
  PageHeader,
  Panel,
  StatusChip,
  ToolbarSearch,
  ToolbarSelect,
  toast,
  type Column,
} from '../ui'
import ListenerModal from './web/ListenerModal'
import LogsModal from './web/LogsModal'
import RouteModal from './web/RouteModal'
import {
  TLS_LABEL,
  TYPE_OPTIONS,
  certDomainsText,
  certTooltip,
  listenerName,
  ruleTypeColor,
  ruleTypeLabel,
  targetText,
  tlsColor,
  tlsModeOf,
  type Certificate,
  type ListResponse,
  type WebListenerView,
  type WebRule,
} from './web/types'


export default function Web() {
  const [listeners, setListeners] = useState<WebListenerView[]>([])
  const [rules, setRules] = useState<WebRule[]>([])
  const [certificates, setCertificates] = useState<Certificate[]>([])

  const [selectedListenerId, setSelectedListenerId] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [search, setSearch] = useState('')

  const [loading, setLoading] = useState(true)
  const [listenerLoading, setListenerLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [listenerError, setListenerError] = useState('')
  const [routeError, setRouteError] = useState('')
  const [busyRuleId, setBusyRuleId] = useState('')
  const [busyListenerId, setBusyListenerId] = useState('')

  const [listenerModal, setListenerModal] = useState<{
    open: boolean
    listener: WebListenerView | null
  }>({ open: false, listener: null })
  const [routeModal, setRouteModal] = useState<{ open: boolean; rule: WebRule | null }>({
    open: false,
    rule: null,
  })
  const [logsRule, setLogsRule] = useState<WebRule | null>(null)
  const [deleteListener, setDeleteListener] = useState<WebListenerView | null>(null)
  const [deleteRule, setDeleteRule] = useState<WebRule | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadListeners = useCallback(async () => {
    setListenerLoading(true)
    try {
      const data = await api.get<ListResponse<WebListenerView>>('/api/v1/web/listeners')
      const items = Array.isArray(data?.items) ? data.items : []
      setListeners(items)
      setSelectedListenerId((current) =>
        current !== 'all' && !items.some((item) => item.id === current) ? 'all' : current,
      )
      setListenerError('')
    } catch (err) {
      const message = errorText(err)
      setListenerError(message)
      toast.danger(message)
    } finally {
      setListenerLoading(false)
    }
  }, [])

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<ListResponse<WebRule>>('/api/v1/web/rules')
      setRules(Array.isArray(data?.items) ? data.items : [])
      setRouteError('')
    } catch (err) {
      const message = errorText(err)
      setRouteError(message)
      toast.danger(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOptions = useCallback(async () => {
    try {
      const data = await api.get<ListResponse<Certificate>>('/api/v1/acme/certificates')
      setCertificates(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      toast.danger(errorText(err))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([loadListeners(), loadRules(), loadOptions()])
    } finally {
      setRefreshing(false)
    }
  }, [loadListeners, loadRules, loadOptions])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const listenerOf = (listenerId: string): WebListenerView | null =>
    listeners.find((item) => item.id === listenerId) || null

  const listenerRouteCount = (listener: WebListenerView): number => {
    const count = Number(listener.routeCount)
    if (Number.isFinite(count)) return count
    return rules.filter((rule) => rule.listenerId === listener.id).length
  }

  const filteredRules = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return rules.filter((rule) => {
      if (selectedListenerId !== 'all' && rule.listenerId !== selectedListenerId) return false
      if (typeFilter !== 'all' && rule.type !== typeFilter) return false
      if (!keyword) return true
      const proxy = rule.proxy
      const redirect = rule.redirect
      const stat = rule.static
      const hay = [
        rule.name,
        rule.id,
        rule.path,
        rule.remark,
        listenerName(listeners, rule.listenerId),
        ...(Array.isArray(rule.domains) ? rule.domains : []),
        ...(Array.isArray(proxy?.targets) ? proxy?.targets ?? [] : []),
        redirect?.to,
        stat?.root,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(keyword)
    })
  }, [rules, selectedListenerId, typeFilter, search, listeners])

  const routeEmptyText = (() => {
    if (!listeners.length) return '还没有监听器，请先新建监听器'
    if (!rules.length) return '还没有 Web 路由，点击右上角新建'
    if (!filteredRules.length) {
      return selectedListenerId === 'all' ? '没有匹配的路由' : '该监听器下没有匹配的路由'
    }
    return '暂无数据'
  })()

  const selectListener = (listener: WebListenerView) => {
    setSelectedListenerId(listener.id)
  }

  const rowCell = (listener: WebListenerView, content: ReactNode) => (
    <div
      role="button"
      tabIndex={0}
      className="cursor-pointer rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      onClick={() => selectListener(listener)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          selectListener(listener)
        }
      }}
    >
      {content}
    </div>
  )

  const toggleListener = async (listener: WebListenerView, enabled: boolean) => {
    if (busyListenerId || enabled === !listener.disabled) return
    setBusyListenerId(listener.id)
    try {
      await api.post(`/api/v1/web/listeners/${encodeURIComponent(listener.id)}/toggle`)
      toast.success(enabled ? '监听器已启用' : '监听器已停用')
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyListenerId('')
      await Promise.all([loadListeners(), loadRules()])
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
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? { ...item, enable: next } : item)),
      )
      toast.success(next ? '已启用' : '已停用')
      await loadRules()
    } catch (err) {
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? { ...item, enable: previous } : item)),
      )
      toast.danger(errorText(err))
    } finally {
      setBusyRuleId('')
    }
  }

  const openCreateListener = () => setListenerModal({ open: true, listener: null })
  const openEditListener = (listener: WebListenerView) =>
    setListenerModal({ open: true, listener })

  const openCreateRule = () => {
    if (!listeners.length) {
      toast.warning('请先新建一个监听器，路由需要绑定监听器')
      return
    }
    setRouteModal({ open: true, rule: null })
  }

  const openEditRule = (rule: WebRule) => setRouteModal({ open: true, rule })

  const confirmDeleteListener = async () => {
    if (!deleteListener || deleting) return
    const target = deleteListener
    setDeleting(true)
    try {
      await api.del(`/api/v1/web/listeners/${encodeURIComponent(target.id)}`)
      toast.success('已删除')
      if (selectedListenerId === target.id) setSelectedListenerId('all')
      setDeleteListener(null)
      setListenerError('')
      await refreshAll()
    } catch (err) {
      const message = errorText(err)
      setListenerError(message)
      toast.danger(message)
    } finally {
      setDeleting(false)
    }
  }

  const confirmDeleteRule = async () => {
    if (!deleteRule || deleting) return
    const target = deleteRule
    setDeleting(true)
    try {
      await api.del(`/api/v1/web/rules/${encodeURIComponent(target.id)}`)
      toast.success('已删除')
      setDeleteRule(null)
      await refreshAll()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setDeleting(false)
    }
  }


  const routeColumns: Column<WebRule>[] = []
  if (selectedListenerId === 'all') {
    routeColumns.push({
      key: 'listener',
      title: '监听器',
      render: (row) => (
        <span className="rounded-full bg-default px-2 py-0.5 text-xs text-default-foreground">
          {listenerName(listeners, row.listenerId)}
        </span>
      ),
    })
  }
  routeColumns.push(
    {
      key: 'domains',
      title: '域名',
      render: (row) => {
        const domains = Array.isArray(row.domains) ? row.domains : []
        return (
          <div className="flex flex-wrap items-center gap-1">
            {domains.slice(0, 2).map((domain) => (
              <span
                key={domain}
                className="rounded-full bg-default px-2 py-0.5 text-xs text-default-foreground"
              >
                {domain}
              </span>
            ))}
            {domains.length > 2 ? (
              <span className="text-xs text-muted">+{domains.length - 2}</span>
            ) : null}
            {!domains.length ? <span className="text-muted">全部</span> : null}
          </div>
        )
      },
    },
    {
      key: 'path',
      title: '路径',
      render: (row) => (
        <div>
          <div className="mono">{row.path || '/'}</div>
          <div className="text-xs text-muted">{row.name || row.id}</div>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Switch
            isSelected={row.enable}
            isDisabled={busyRuleId === row.id}
            onChange={(selected) => void toggleRule(row, selected)}
            aria-label={`启停路由 ${row.name || row.id}`}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          <span className="text-xs text-muted">{row.enable ? '已启用' : '已停用'}</span>
          {row.active ? <StatusChip color="success">运行中</StatusChip> : null}
        </div>
      ),
    },
    {
      key: 'type',
      title: '类型',
      render: (row) => (
        <StatusChip color={ruleTypeColor(row.type)}>{ruleTypeLabel(row.type)}</StatusChip>
      ),
    },
    {
      key: 'target',
      title: '目标摘要',
      render: (row) => (
        <span className="mono block max-w-64 truncate text-xs text-muted" title={targetText(row)}>
          {targetText(row)}
        </span>
      ),
    },
    {
      key: 'tls',
      title: 'TLS',
      render: (row) => {
        const mode = tlsModeOf(listenerOf(row.listenerId))
        return <StatusChip color={tlsColor(mode)}>{TLS_LABEL[mode] || '关闭'}</StatusChip>
      },
    },
    {
      key: 'waf',
      title: 'WAF',
      render: (row) => (
        <StatusChip color={row.waf ? 'success' : 'default'}>
          {row.waf ? '已开启' : '关闭'}
        </StatusChip>
      ),
    },
    {
      key: 'requests',
      title: '请求数',
      render: (row) => (
        <span className="text-muted">{Number(row.requests || 0).toLocaleString()}</span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onPress={() => openEditRule(row)}>
            编辑
          </Button>
          <Button size="sm" variant="secondary" onPress={() => setLogsRule(row)}>
            日志
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => setDeleteRule(row)}>
            删除
          </Button>
        </div>
      ),
    },
  )

  const defaultListenerId =
    selectedListenerId !== 'all'
      ? selectedListenerId
      : listeners.length === 1
        ? listeners[0].id
        : ''

  return (
    <Page>
      <PageHeader
        title="Web 服务"
        sub="监听器负责端口与 TLS，路由按域名/路径选择上游"
        actions={
          <>
            <Button variant="secondary" isDisabled={refreshing} onPress={() => void refreshAll()}>
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
            <Button variant="secondary" onPress={openCreateListener}>
              新建监听器
            </Button>
            <Button variant="primary" onPress={openCreateRule}>
              新建路由
            </Button>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Panel
          title="监听器"
          extra={<span className="text-xs text-muted">{listeners.length} 个</span>}
          className="self-start"
          flush
        >
          {listenerError ? (
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm text-danger">
              <span className="flex-1">{listenerError}</span>
              <Button size="sm" variant="ghost" onPress={() => void loadListeners()}>
                重试
              </Button>
            </div>
          ) : null}
          {/* A flat list instead of cards inside a card: the panel border and
              dividers do the separating, so each row is one click target plus
              two icon actions. */}
          <div className="divide-y divide-border">
            {listeners.length > 0 ? (
              <button
                type="button"
                aria-pressed={selectedListenerId === 'all'}
                onClick={() => setSelectedListenerId('all')}
                className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                  selectedListenerId === 'all'
                    ? 'bg-accent-soft text-accent-soft-foreground'
                    : 'hover:bg-default/60'
                }`}
              >
                <span className="flex-1 font-medium">全部监听器</span>
                <StatusChip color={selectedListenerId === 'all' ? 'primary' : 'default'}>
                  {listeners.length}
                </StatusChip>
              </button>
            ) : null}
            {listeners.map((listener) => {
              const mode = tlsModeOf(listener)
              const active = selectedListenerId === listener.id
              return (
                <div
                  key={listener.id}
                  className={`flex items-center gap-1 pr-2 transition-colors ${
                    active ? 'bg-accent-soft/50' : 'hover:bg-default/50'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectListener(listener)}
                    className="min-w-0 flex-1 px-4 py-2 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{listener.name || listener.id}</span>
                      <StatusChip color={tlsColor(mode)}>{TLS_LABEL[mode] || '关闭'}</StatusChip>
                      {listener.disabled ? <StatusChip color="warning">已停用</StatusChip> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      {(Array.isArray(listener.listen) ? listener.listen : []).map((item) => (
                        <span key={item} className="mono rounded bg-default px-1.5 py-0.5">
                          {item}
                        </span>
                      ))}
                      <span>{listenerRouteCount(listener)} 条路由</span>
                      {listener.tls?.clientAuth && listener.tls.clientAuth !== 'off' ? <span>mTLS</span> : null}
                    </div>
                  </button>
                  <Switch
                    isSelected={!listener.disabled}
                    isDisabled={busyListenerId === listener.id}
                    onChange={(enabled) => void toggleListener(listener, enabled)}
                    aria-label={`启停监听器 ${listener.name || listener.id}`}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`编辑监听器 ${listener.name || listener.id}`}
                    onPress={() => openEditListener(listener)}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`删除监听器 ${listener.name || listener.id}`}
                    onPress={() => setDeleteListener(listener)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )
            })}
            {!listeners.length && !listenerLoading ? (
              <div className="px-4 py-8 text-center text-sm text-muted">还没有监听器</div>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="路由"
          className="min-w-0"
          flush
          extra={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <ToolbarSelect
                label="类型筛选"
                value={typeFilter}
                onChange={setTypeFilter}
                options={[{ value: 'all', label: '全部类型' }, ...TYPE_OPTIONS]}
                className="w-full sm:w-36"
              />
              <ToolbarSearch
                label="搜索路由"
                value={search}
                onChange={setSearch}
                placeholder="搜索域名 / 路径 / 上游"
                className="w-full sm:w-64"
              />
              <span className="whitespace-nowrap text-xs text-muted">
                共 {rules.length} 条 · 显示 {filteredRules.length} 条
              </span>
            </div>
          }
        >

          {routeError ? (
            <div className="flex items-center gap-2 border-y border-border px-4 py-2 text-sm text-danger">
              <span className="flex-1">加载路由失败：{routeError}</span>
              <Button size="sm" variant="ghost" onPress={() => void loadRules()}>
                重试
              </Button>
            </div>
          ) : null}

          <DataTable
              items={filteredRules}
              columns={routeColumns}
              rowKey={(row) => row.id}
              ariaLabel="Web 路由"
              empty={loading ? '加载中…' : routeEmptyText}
            />
        </Panel>
      </div>

      <ListenerModal
        open={listenerModal.open}
        listener={listenerModal.listener}
        certificates={certificates}
        onClose={() => setListenerModal({ open: false, listener: null })}
        onSaved={() => void refreshAll()}
      />

      <RouteModal
        open={routeModal.open}
        rule={routeModal.rule}
        listeners={listeners}
        certificates={certificates}
        defaultListenerId={defaultListenerId}
        onClose={() => setRouteModal({ open: false, rule: null })}
        onSaved={() => void refreshAll()}
      />

      <LogsModal open={!!logsRule} rule={logsRule} onClose={() => setLogsRule(null)} />

      <ConfirmModal
        open={!!deleteListener}
        title="删除监听器"
        danger
        confirmText={deleting ? '删除中…' : '删除'}
        onCancel={() => setDeleteListener(null)}
        onConfirm={() => void confirmDeleteListener()}
        content={
          <span>
            确定删除监听器「{deleteListener?.name || deleteListener?.id}」吗？该操作不可撤销。
            如果该监听器下还有路由，后端会拒绝删除并返回原因。
          </span>
        }
      />

      <ConfirmModal
        open={!!deleteRule}
        title="删除 Web 路由"
        danger
        confirmText={deleting ? '删除中…' : '删除'}
        onCancel={() => setDeleteRule(null)}
        onConfirm={() => void confirmDeleteRule()}
        content={
          <span>
            确定删除路由「{deleteRule?.name || deleteRule?.id}」吗？该操作不可撤销。
          </span>
        }
      />
    </Page>
  )
}
