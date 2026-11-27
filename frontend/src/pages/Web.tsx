import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Empty,
  Input,
  Tabs,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  ApiOutlined,
  BranchesOutlined,
  HolderOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api, errorText } from '../api'
import { Muted, useIsMobile } from '../components'
import { useContentViewport } from '../components/useContentViewport'
import { usePolling } from '../usePolling'
import { EntityRow, PaneTitle, Workspace, type ItemStatus } from '../components/Workspace'
import ListenerForm, { type ListenerPayload } from './web/ListenerForm'
import RouteForm, { type RoutePayload } from './web/RouteForm'
import { AccessTag, RouteTypeTag, TlsTag } from './web/ui'
import {
  TYPE_OPTIONS,
  listenerName,
  tlsModeOf,
  type Certificate,
  type ListResponse,
  type WebListenerView,
  type WebRule,
} from './web/types'

type Mode = 'listeners' | 'rules'

// The shell header already names the page, so the content area keeps a heading
// for screen readers only instead of repeating the title on screen.
const hiddenTitle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const NEW_ID = '__new__'
const numberFormat = new Intl.NumberFormat('zh-CN')

function fmtCount(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? numberFormat.format(n) : '0'
}

function listenerStatus(listener: WebListenerView): ItemStatus {
  if (listener.disabled) return 'off'
  return Array.isArray(listener.listen) && listener.listen.length ? 'ok' : 'warn'
}

function routeStatus(rule: WebRule): ItemStatus {
  if (rule.configError) return 'error'
  if (!rule.enable) return 'off'
  return rule.active ? 'ok' : 'warn'
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

/** One list row wired to dnd-kit; the handle is passed into the row actions. */
function SortableEntity({
  id,
  label,
  disabled,
  children,
}: {
  id: string
  label: string
  disabled?: boolean
  children: (handle: ReactNode) => ReactNode
}) {
  const { token } = theme.useToken()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        background: token.colorBgContainer,
        position: isDragging ? 'relative' : undefined,
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      {children(
        <Tooltip title="拖动排序">
          <Button
            ref={setActivatorNodeRef}
            type="text"
            size="small"
            icon={<HolderOutlined />}
            aria-label={`拖动排序 ${label}`}
            disabled={disabled}
            onClick={(event) => event.stopPropagation()}
            style={{ cursor: 'grab', touchAction: 'none' }}
            {...attributes}
            {...listeners}
          />
        </Tooltip>,
      )}
    </div>
  )
}

/**
 * One workspace pane: a header that stays put (title, filters, load error) above
 * a body that scrolls on its own, so a long list never grows the page.
 */
function ListPane({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <>
      <div style={{ flexShrink: 0 }}>{header}</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
    </>
  )
}

export default function Web() {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const isMobile = useIsMobile()
  // The page fills the window and each pane scrolls inside itself, so a long
  // route list never turns into a scrollbar on the whole page.
  const viewportFallback = isMobile ? 'calc(100dvh - 60px - 24px)' : 'calc(100dvh - 60px - 48px)'
  const { pageRef, height } = useContentViewport(viewportFallback)

  const [mode, setMode] = useState<Mode>('listeners')
  const [listeners, setListeners] = useState<WebListenerView[]>([])
  const [rules, setRules] = useState<WebRule[]>([])
  const [certificates, setCertificates] = useState<Certificate[]>([])

  const [selectedListenerId, setSelectedListenerId] = useState('')
  const [selectedRuleId, setSelectedRuleId] = useState('')
  const [listenerFilter, setListenerFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [ruleSearch, setRuleSearch] = useState('')

  const [listenerLoading, setListenerLoading] = useState(true)
  const [rulesLoading, setRulesLoading] = useState(true)
  const [listenerError, setListenerError] = useState('')
  const [ruleError, setRuleError] = useState('')

  const [savingListener, setSavingListener] = useState(false)
  const [savingRule, setSavingRule] = useState(false)
  const [busyListenerId, setBusyListenerId] = useState('')
  const [busyRuleId, setBusyRuleId] = useState('')
  const [reordering, setReordering] = useState(false)
  const [listenerRevision, setListenerRevision] = useState(0)
  const [routeRevision, setRouteRevision] = useState(0)
  const dirtyRef = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const loadListeners = useCallback(
    // silent: no loading spinner. quiet: no toast (a background poll must not
    // spam errors; it reports the failure through the freshness badge).
    async (silent = false, quiet = false): Promise<WebListenerView[] | null> => {
      if (!silent) setListenerLoading(true)
      try {
        const data = await api.get<ListResponse<WebListenerView>>('/api/v1/web/listeners')
        const items = Array.isArray(data?.items) ? data.items : []
        setListeners(items)
        setSelectedListenerId((current) => {
          if (current && current !== NEW_ID && !items.some((item) => item.id === current)) {
            dirtyRef.current = false
            return ''
          }
          return current
        })
        setListenerFilter((current) =>
          current !== 'all' && !items.some((item) => item.id === current) ? 'all' : current,
        )
        setListenerError('')
        return items
      } catch (err) {
        const text = errorText(err)
        setListenerError(text)
        if (!quiet) message.error(text)
        return null
      } finally {
        if (!silent) setListenerLoading(false)
      }
    },
    [message],
  )

  const loadRules = useCallback(
    async (silent = false, quiet = false): Promise<WebRule[] | null> => {
      if (!silent) setRulesLoading(true)
      try {
        const data = await api.get<ListResponse<WebRule>>('/api/v1/web/rules')
        const items = Array.isArray(data?.items) ? data.items : []
        setRules(items)
        setSelectedRuleId((current) => {
          if (current && current !== NEW_ID && !items.some((item) => item.id === current)) {
            dirtyRef.current = false
            return ''
          }
          return current
        })
        setRuleError('')
        return items
      } catch (err) {
        const text = errorText(err)
        setRuleError(text)
        if (!quiet) message.error(text)
        return null
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
      await Promise.all([loadListeners(silent), loadRules(silent), loadCertificates()])
    },
    [loadListeners, loadRules, loadCertificates],
  )

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // The counters shown here (requests, running state) change on the server, and
  // every other list page polls them; doing the same makes a manual refresh
  // button unnecessary. A tick is skipped while a save, toggle or reorder is in
  // flight so it cannot fight the optimistic update, and it never toasts.
  const busy =
    savingListener ||
    savingRule ||
    busyListenerId !== '' ||
    busyRuleId !== '' ||
    reordering
  const live = usePolling(
    async () => {
      const [nextListeners, nextRules] = await Promise.all([
        loadListeners(true, true),
        loadRules(true, true),
      ])
      if (nextListeners === null || nextRules === null) throw new Error('refresh failed')
    },
    10_000,
    !busy,
  )
  const liveLabel = live.failed
    ? '自动刷新失败'
    : live.updatedAt
      ? `更新于 ${new Date(live.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '等待自动刷新'

  const selectedListener =
    selectedListenerId && selectedListenerId !== NEW_ID
      ? listeners.find((item) => item.id === selectedListenerId) || null
      : null
  const selectedRule =
    selectedRuleId && selectedRuleId !== NEW_ID
      ? rules.find((item) => item.id === selectedRuleId) || null
      : null
  const isNewListener = selectedListenerId === NEW_ID
  const isNewRule = selectedRuleId === NEW_ID

  const listenerRouteCount = (listener: WebListenerView): number => {
    if (listener.routeCount !== undefined && Number.isFinite(Number(listener.routeCount))) {
      return Number(listener.routeCount)
    }
    return rules.filter((rule) => rule.listenerId === listener.id).length
  }

  const filteredRules = useMemo(() => {
    const keyword = ruleSearch.trim().toLowerCase()
    return rules.filter((rule) => {
      if (listenerFilter !== 'all' && rule.listenerId !== listenerFilter) return false
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
  }, [rules, listenerFilter, typeFilter, ruleSearch, listeners])

  const runningListeners = listeners.filter(
    (listener) => !listener.disabled && (Array.isArray(listener.listen) ? listener.listen.length : 0) > 0,
  ).length
  const runningRules = rules.filter((rule) => rule.enable && rule.active).length
  const filtersActive =
    listenerFilter !== 'all' || typeFilter !== 'all' || ruleSearch.trim().length > 0

  const defaultListenerId = (() => {
    const candidate =
      selectedListenerId && selectedListenerId !== NEW_ID
        ? selectedListenerId
        : listenerFilter !== 'all'
          ? listenerFilter
          : listeners.length === 1
            ? listeners[0].id
            : ''
    return listeners.some((listener) => listener.id === candidate) ? candidate : ''
  })()

  const markDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])

  const guard = useCallback(
    (action: () => void) => {
      if (!dirtyRef.current) {
        action()
        return
      }
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '当前表单有未保存的内容，继续操作会丢失这些修改。',
        okText: '放弃修改',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk() {
          dirtyRef.current = false
          action()
        },
      })
    },
    [modal],
  )

  const selectListener = (id: string) => {
    if (id === selectedListenerId) return
    guard(() => {
      dirtyRef.current = false
      setSelectedListenerId(id)
    })
  }

  const selectRule = (id: string) => {
    if (id === selectedRuleId) return
    guard(() => {
      dirtyRef.current = false
      setSelectedRuleId(id)
    })
  }

  const changeMode = (next: Mode) => {
    if (next === mode) return
    guard(() => {
      dirtyRef.current = false
      if (mode === 'listeners' && selectedListenerId === NEW_ID) setSelectedListenerId('')
      if (mode === 'rules' && selectedRuleId === NEW_ID) setSelectedRuleId('')
      setMode(next)
    })
  }

  const startNewListener = () => {
    guard(() => {
      dirtyRef.current = false
      setMode('listeners')
      setSelectedListenerId(NEW_ID)
    })
  }

  const startNewRule = () => {
    if (!listeners.length) {
      guard(() => {
        dirtyRef.current = false
        setMode('listeners')
        setSelectedListenerId(NEW_ID)
        message.info('请先新建监听器，保存后再创建路由')
      })
      return
    }
    guard(() => {
      dirtyRef.current = false
      setMode('rules')
      setSelectedRuleId(NEW_ID)
    })
  }

  const cancelListenerEdit = () => {
    dirtyRef.current = false
    setSelectedListenerId('')
  }

  const cancelRuleEdit = () => {
    dirtyRef.current = false
    setSelectedRuleId('')
  }

  const goBack = () => {
    guard(() => {
      dirtyRef.current = false
      if (mode === 'listeners') setSelectedListenerId('')
      else setSelectedRuleId('')
    })
  }

  const saveListener = async (payload: ListenerPayload) => {
    setSavingListener(true)
    try {
      const saved =
        selectedListenerId === NEW_ID
          ? await api.post<WebListenerView>('/api/v1/web/listeners', payload)
          : await api.put<WebListenerView>(
              `/api/v1/web/listeners/${encodeURIComponent(selectedListenerId)}`,
              payload,
            )
      if (saved) {
        setListeners((current) => {
          const exists = current.some((item) => item.id === saved.id)
          return exists
            ? current.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...current]
        })
      }
      if (saved?.disabled) {
        message.warning('端口被占用，监听器已保存但自动停用；释放端口后可手动启用')
      } else {
        message.success('监听器已保存')
      }
      dirtyRef.current = false
      const targetId = saved?.id || (selectedListenerId !== NEW_ID ? selectedListenerId : '')
      await loadListeners(true)
      await loadRules(true)
      if (targetId) setSelectedListenerId(targetId)
      setListenerRevision((value) => value + 1)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSavingListener(false)
    }
  }

  const saveRule = async (payload: RoutePayload) => {
    setSavingRule(true)
    try {
      let id = selectedRuleId
      if (selectedRuleId === NEW_ID) {
        const created = await api.post<{ id: string }>('/api/v1/web/rules', payload)
        id = created?.id || NEW_ID
        if (id !== NEW_ID) {
          const optimistic: WebRule = { ...payload, id, active: false, requests: 0 }
          setRules((current) => [optimistic, ...current.filter((item) => item.id !== id)])
          // Make sure the route that was just created is visible in the list.
          setRuleSearch('')
          setTypeFilter('all')
          setListenerFilter('all')
        }
      } else {
        await api.put(`/api/v1/web/rules/${encodeURIComponent(selectedRuleId)}`, payload)
        setRules((current) =>
          current.map((item) =>
            item.id === selectedRuleId ? { ...item, ...payload } : item,
          ),
        )
      }
      message.success('路由已保存')
      dirtyRef.current = false
      await loadRules(true)
      await loadListeners(true)
      if (id && id !== NEW_ID) {
        setSelectedRuleId(id)
        setRouteRevision((value) => value + 1)
      }
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSavingRule(false)
    }
  }

  const toggleListener = async (listener: WebListenerView, enabled: boolean) => {
    if (busyListenerId) return
    const previous = !!listener.disabled
    setBusyListenerId(listener.id)
    setListeners((current) =>
      current.map((item) => (item.id === listener.id ? { ...item, disabled: !enabled } : item)),
    )
    try {
      await api.post(`/api/v1/web/listeners/${encodeURIComponent(listener.id)}/toggle`)
      message.success(enabled ? '监听器已启用' : '监听器已停用')
      await Promise.all([loadListeners(true), loadRules(true)])
    } catch (err) {
      setListeners((current) =>
        current.map((item) => (item.id === listener.id ? { ...item, disabled: previous } : item)),
      )
      message.error(errorText(err))
      await loadListeners(true)
    } finally {
      setBusyListenerId('')
    }
  }

  const toggleRule = (rule: WebRule, enabled: boolean) => {
    if (busyRuleId) return

    const run = async () => {
      const previous = rule.enable
      setBusyRuleId(rule.id)
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? { ...item, enable: enabled } : item)),
      )
      try {
        await api.post<{ id: string; enable: boolean }>(
          `/api/v1/web/rules/${encodeURIComponent(rule.id)}/toggle`,
        )
        message.success(enabled ? '路由已启用' : '路由已停用')
        await loadRules(true)
        // Reload the open editor so its enable switch cannot overwrite the
        // toggle on the next save.
        if (selectedRuleId === rule.id) {
          dirtyRef.current = false
          setRouteRevision((value) => value + 1)
        }
      } catch (err) {
        setRules((current) =>
          current.map((item) => (item.id === rule.id ? { ...item, enable: previous } : item)),
        )
        message.error(errorText(err))
      } finally {
        setBusyRuleId('')
      }
    }

    if (selectedRuleId === rule.id && dirtyRef.current) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '切换该路由的状态会重新加载编辑表单，未保存的修改将丢失。',
        okText: '放弃并切换',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk() {
          dirtyRef.current = false
          void run()
        },
      })
      return
    }
    void run()
  }

  const onListenerDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reordering) return
    const oldIndex = listeners.findIndex((item) => item.id === String(active.id))
    const newIndex = listeners.findIndex((item) => item.id === String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(listeners, oldIndex, newIndex)
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

  const onRuleDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reordering) return
    const visibleIds = filteredRules.map((rule) => rule.id)
    const oldIndex = visibleIds.indexOf(String(active.id))
    const newIndex = visibleIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const nextVisible = arrayMove(visibleIds, oldIndex, newIndex)
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
          dirtyRef.current = false
          setSelectedListenerId('')
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
      content: <span>确定删除路由「{rule.name || rule.id}」吗？该操作不可撤销。</span>,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await api.del(`/api/v1/web/rules/${encodeURIComponent(rule.id)}`)
          message.success('路由已删除')
          dirtyRef.current = false
          setSelectedRuleId('')
          await refreshAll(true)
        } catch (err) {
          message.error(errorText(err))
        }
      },
    })
  }

  const clearRouteFilters = () => {
    setRuleSearch('')
    setTypeFilter('all')
    setListenerFilter('all')
  }

  const listenerPaneHeader = (
    <>
      <PaneTitle
        title="监听器"
        subtitle={`共 ${listeners.length} 个`}
      />
      {listenerError ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: 8 }}
          message="加载监听器失败"
          description={listenerError}
          action={
            <Button size="small" onClick={() => void loadListeners()}>
              重试
            </Button>
          }
        />
      ) : null}
    </>
  )

  const listenerList = (
    <ListPane header={listenerPaneHeader}>
      <Spin spinning={listenerLoading}>
        <div style={{ minHeight: 120 }}>
          {isNewListener ? (
            <EntityRow
              title="新建监听器"
              subtitle="尚未保存"
              status="warn"
              selected
            />
          ) : null}
          {listeners.length ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => void onListenerDragEnd(event)}
            >
              <SortableContext
                items={listeners.map((listener) => listener.id)}
                strategy={verticalListSortingStrategy}
              >
                {listeners.map((listener) => (
                  <SortableEntity
                    key={listener.id}
                    id={listener.id}
                    label={listener.name || listener.id}
                    disabled={reordering}
                  >
                    {(handle) => (
                      <EntityRow
                        title={listener.name || listener.id}
                        subtitle={
                          (Array.isArray(listener.listen) ? listener.listen : []).join(' · ') ||
                          '未配置监听地址'
                        }
                        status={listenerStatus(listener)}
                        selected={selectedListenerId === listener.id}
                        onClick={() => selectListener(listener.id)}
                        meta={
                          <Space size={[4, 4]} wrap>
                            <TlsTag
                              mode={tlsModeOf(listener)}
                              clientAuth={listener.tls?.clientAuth}
                              hsts={listener.tls?.hsts}
                            />
                            {listener.disabled ? <Tag>已停用</Tag> : null}
                            <Muted>{listenerRouteCount(listener)} 条路由</Muted>
                          </Space>
                        }
                        actions={
                          <div
                            onClick={(event) => event.stopPropagation()}
                            style={{ display: 'flex', alignItems: 'center', gap: 2 }}
                          >
                            {handle}
                            <Switch
                              size="small"
                              checked={!listener.disabled}
                              loading={busyListenerId === listener.id}
                              onChange={(checked) => void toggleListener(listener, checked)}
                              aria-label={`启停监听器 ${listener.name || listener.id}`}
                            />
                          </div>
                        }
                      />
                    )}
                  </SortableEntity>
                ))}
              </SortableContext>
            </DndContext>
          ) : !isNewListener ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有监听器"
              style={{ padding: 24 }}
            >
              <Button type="primary" size="small" onClick={startNewListener}>
                新建监听器
              </Button>
            </Empty>
          ) : null}
        </div>
      </Spin>
    </ListPane>
  )

  const routePaneHeader = (
    <>
      <PaneTitle
        title="路由"
        subtitle={`${filteredRules.length} / ${rules.length} 条`}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: 8,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索域名 / 路径 / 上游"
          value={ruleSearch}
          onChange={(event) => setRuleSearch(event.target.value)}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <Select
            size="small"
            aria-label="按监听器筛选"
            value={listenerFilter}
            onChange={setListenerFilter}
            options={[
              { value: 'all', label: '全部监听器' },
              ...listeners.map((listener) => ({
                value: listener.id,
                label: listener.name || listener.id,
              })),
            ]}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Select
            size="small"
            aria-label="按类型筛选"
            value={typeFilter}
            onChange={setTypeFilter}
            options={[{ value: 'all', label: '全部类型' }, ...TYPE_OPTIONS]}
            style={{ width: 100 }}
          />
        </div>
      </div>
      {ruleError ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: 8 }}
          message="加载路由失败"
          description={ruleError}
          action={
            <Button size="small" onClick={() => void loadRules()}>
              重试
            </Button>
          }
        />
      ) : null}
    </>
  )

  const routeList = (
    <ListPane header={routePaneHeader}>
      <Spin spinning={rulesLoading}>
        <div style={{ minHeight: 120 }}>
          {isNewRule ? (
            <EntityRow
              title="新建路由"
              subtitle="尚未保存"
              status="warn"
              selected
            />
          ) : null}
          {filteredRules.length ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => void onRuleDragEnd(event)}
            >
              <SortableContext
                items={filteredRules.map((rule) => rule.id)}
                strategy={verticalListSortingStrategy}
              >
                {filteredRules.map((rule) => {
                  const domains = Array.isArray(rule.domains) ? rule.domains : []
                  return (
                    <SortableEntity
                      key={rule.id}
                      id={rule.id}
                      label={rule.name || rule.id}
                      disabled={reordering}
                    >
                      {(handle) => (
                        <EntityRow
                          title={rule.name || rule.id}
                          subtitle={`${domains[0] || '全部域名'}${rule.path || '/'} · ${listenerName(listeners, rule.listenerId)}`}
                          status={routeStatus(rule)}
                          selected={selectedRuleId === rule.id}
                          onClick={() => selectRule(rule.id)}
                          meta={
                            <Space size={[4, 4]} wrap>
                              <RouteTypeTag type={rule.type} />
                              <AccessTag access={rule.access} />
                              {rule.waf ? <Tag color="volcano">WAF</Tag> : null}
                              <Muted>{fmtCount(rule.requests)} 次</Muted>
                            </Space>
                          }
                          actions={
                            <div
                              onClick={(event) => event.stopPropagation()}
                              style={{ display: 'flex', alignItems: 'center', gap: 2 }}
                            >
                              {handle}
                              <Switch
                                size="small"
                                checked={rule.enable}
                                loading={busyRuleId === rule.id}
                                onChange={(checked) => void toggleRule(rule, checked)}
                                aria-label={`启停路由 ${rule.name || rule.id}`}
                              />
                            </div>
                          }
                        />
                      )}
                    </SortableEntity>
                  )
                })}
              </SortableContext>
            </DndContext>
          ) : !isNewRule ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                rules.length
                  ? '没有匹配的路由'
                  : listeners.length
                    ? '还没有 Web 路由'
                    : '还没有监听器，先创建监听器再建路由'
              }
              style={{ padding: 24 }}
            >
              {filtersActive ? (
                <Button size="small" onClick={clearRouteFilters}>
                  清除筛选
                </Button>
              ) : listeners.length ? (
                <Button type="primary" size="small" onClick={startNewRule}>
                  新建路由
                </Button>
              ) : (
                <Button type="primary" size="small" onClick={startNewListener}>
                  新建监听器
                </Button>
              )}
            </Empty>
          ) : null}
        </div>
      </Spin>
    </ListPane>
  )

  const listenerDetail = isNewListener ? (
    <ListenerForm
      key={`listener-new-${listenerRevision}`}
      listener={null}
      certificates={certificates}
      saving={savingListener}
      onSave={(payload) => void saveListener(payload)}
      onCancel={cancelListenerEdit}
      onDirtyChange={markDirty}
    />
  ) : selectedListener ? (
    <ListenerForm
      key={`listener-${selectedListener.id}-${listenerRevision}`}
      listener={selectedListener}
      certificates={certificates}
      saving={savingListener}
      onSave={(payload) => void saveListener(payload)}
      onCancel={cancelListenerEdit}
      onDelete={() => askDeleteListener(selectedListener)}
      onDirtyChange={markDirty}
    />
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        selectedListenerId ? '该监听器已不存在，请刷新后重试' : '选择左侧监听器进行编辑'
      }
      style={{ padding: 40 }}
    >
      <Button type="primary" icon={<PlusOutlined />} onClick={startNewListener}>
        新建监听器
      </Button>
    </Empty>
  )

  const ruleDetail = isNewRule ? (
    <RouteForm
      key={`rule-new-${routeRevision}`}
      rule={null}
      listeners={listeners}
      defaultListenerId={defaultListenerId}
      saving={savingRule}
      onSave={(payload) => void saveRule(payload)}
      onCancel={cancelRuleEdit}
      onDirtyChange={markDirty}
    />
  ) : selectedRule ? (
    <RouteForm
      key={`rule-${selectedRule.id}-${routeRevision}`}
      rule={selectedRule}
      listeners={listeners}
      defaultListenerId={defaultListenerId}
      saving={savingRule}
      onSave={(payload) => void saveRule(payload)}
      onCancel={cancelRuleEdit}
      onDelete={() => askDeleteRule(selectedRule)}
      onDirtyChange={markDirty}
    />
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        !listeners.length
          ? '还没有监听器，先创建监听器再建路由'
          : selectedRuleId
            ? '该路由已不存在，请刷新后重试'
            : '选择左侧路由进行编辑'
      }
      style={{ padding: 40 }}
    >
      {listeners.length ? (
        <Button type="primary" icon={<PlusOutlined />} onClick={startNewRule}>
          新建路由
        </Button>
      ) : (
        <Button type="primary" icon={<PlusOutlined />} onClick={startNewListener}>
          新建监听器
        </Button>
      )}
    </Empty>
  )

  const detailSelected =
    mode === 'listeners' ? selectedListenerId !== '' : selectedRuleId !== ''

  return (
    <div ref={pageRef} style={{ height, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <h2 style={hiddenTitle}>Web 服务</h2>

      <Tabs
        activeKey={mode}
        onChange={(key) => changeMode(key as Mode)}
        animated={false}
        style={{ flexShrink: 0 }}
        tabBarStyle={{ marginBottom: 8 }}
        tabBarExtraContent={
          <Space size={8}>
            <Tooltip title={`${liveLabel}（点击立即刷新）`}>
              <span
                onClick={() => void live.refresh()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
              >
                <Badge status={live.failed ? 'error' : live.updatedAt ? 'processing' : 'default'} />
                {isMobile ? null : (
                  <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {liveLabel}
                  </Typography.Text>
                )}
              </span>
            </Tooltip>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={mode === 'listeners' ? startNewListener : startNewRule}
            >
              {mode === 'listeners' ? '新建监听器' : '新建路由'}
            </Button>
          </Space>
        }
        items={[
          {
            key: 'listeners',
            label: (
              <span
                title="运行中 / 总数"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <ApiOutlined />
                监听器
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {runningListeners}/{listeners.length}
                </Typography.Text>
              </span>
            ),
          },
          {
            key: 'rules',
            label: (
              <span
                title="运行中 / 总数"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <BranchesOutlined />
                路由
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {runningRules}/{rules.length}
                </Typography.Text>
              </span>
            ),
          },
        ]}
      />

      <Workspace
        fill
        listWidth={360}
        list={mode === 'listeners' ? listenerList : routeList}
        detail={mode === 'listeners' ? listenerDetail : ruleDetail}
        selected={detailSelected}
        onBack={goBack}
      />
    </div>
  )
}
