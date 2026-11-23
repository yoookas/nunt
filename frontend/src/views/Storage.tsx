import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Chip } from '@heroui/react'
import { ChevronRight, File, Folder, Plus, RefreshCw } from 'lucide-react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import {
  ConfirmModal,
  DataTable,
  FormModal,
  Page,
  PageHeader,
  Panel,
  SwitchInput,
  TextInput,
  toast,
  type Column,
} from '../ui'

// 存储挂载管理：
//   GET    /api/v1/storage/mounts                列表（密码以 ******** 掩码返回）
//   POST   /api/v1/storage/mounts                新建
//   PUT    /api/v1/storage/mounts/{id}           编辑（密码留空或保持掩码 = 不修改）
//   DELETE /api/v1/storage/mounts/{id}           删除
//   POST   /api/v1/storage/mounts/test           测试连接（body: { mount, id }）
//   GET    /api/v1/storage/mounts/{id}/list?path= 浏览目录
const PAGE_SIZE = 20


interface Mount {
  id: string
  name?: string
  type?: string
  root?: string
  readOnly?: boolean
  enable?: boolean
  remark?: string
  createdAt?: string
}

interface MountPayload {
  id: string
  name: string
  type: 'local'
  enable: boolean
  readOnly: boolean
  remark: string
  root: string
  createdAt?: string
}

interface MountForm {
  name: string
  enable: boolean
  readOnly: boolean
  root: string
  remark: string
}

interface FormErrors {
  name?: string
  root?: string
}

interface TestResult {
  ok: boolean
  message: string
}

interface BrowseEntry {
  name: string
  path: string
  dir: boolean
  size: number
  modTime: string
}

/* ------------------------------------------------------------------ 路径与展示 */

function normalizePath(value: unknown): string {
  let out = String(value || '').trim()
  if (!out) return '/'
  if (!out.startsWith('/')) out = `/${out}`
  out = out.replace(/\/{2,}/g, '/')
  if (out.length > 1) out = out.replace(/\/+$/, '')
  return out || '/'
}

function joinPath(base: string, name: string): string {
  const parent = normalizePath(base)
  return `${parent === '/' ? '' : parent}/${String(name || '').replace(/^\/+/, '')}`
}

function parentPath(value: string): string {
  const clean = normalizePath(value)
  const index = clean.lastIndexOf('/')
  return index <= 0 ? '/' : clean.slice(0, index)
}

function locationOf(row: Mount): string {
  return String(row.root || '')
}

function normalizeEntries(list: unknown, base: string): BrowseEntry[] {
  const source = Array.isArray(list) ? list : []
  return source
    .map((raw) => {
      const entry = (raw || {}) as Record<string, unknown>
      const name =
        String(entry.name || '') ||
        String(entry.path || '')
          .split('/')
          .filter(Boolean)
          .pop() ||
        ''
      return {
        name,
        path: normalizePath(entry.path || joinPath(base, name)),
        dir: !!entry.dir,
        size: Number(entry.size) || 0,
        modTime: entry.modTime ? String(entry.modTime) : '',
      }
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

function mountListOf(data: unknown): Mount[] {
  if (Array.isArray(data)) return data as Mount[]
  const record = (data || {}) as { mounts?: unknown; items?: unknown }
  if (Array.isArray(record.mounts)) return record.mounts as Mount[]
  if (Array.isArray(record.items)) return record.items as Mount[]
  return []
}

function hintWithError(error: string | undefined, hint?: ReactNode): ReactNode {
  if (error) return <span style={{ color: 'var(--danger)' }}>{error}</span>
  return hint
}

function formOf(row: Mount | null): MountForm {
  return {
    name: row?.name || '',
    enable: !row || row.enable !== false,
    readOnly: !!row?.readOnly,
    root: row?.root || '',
    remark: row?.remark || '',
  }
}

function validateMount(form: MountForm): FormErrors {
  const errors: FormErrors = {}
  if (!form.name.trim()) errors.name = '请输入名称'
  if (!form.root.trim()) errors.root = '请填写本地路径'
  return errors
}

function buildPayload(form: MountForm, id: string, createdAt: string): MountPayload {
  const payload: MountPayload = {
    id,
    name: form.name.trim(),
    type: 'local',
    enable: !!form.enable,
    readOnly: !!form.readOnly,
    remark: form.remark.trim(),
    root: form.root.trim(),
  }
  if (createdAt) payload.createdAt = createdAt
  return payload
}

function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number
  pageCount: number
  onChange: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2 text-xs text-muted">
      <span>
        第 {page} / {pageCount} 页
      </span>
      <Button size="sm" variant="ghost" isDisabled={page <= 1} onPress={() => onChange(page - 1)}>
        上一页
      </Button>
      <Button size="sm" variant="ghost" isDisabled={page >= pageCount} onPress={() => onChange(page + 1)}>
        下一页
      </Button>
    </div>
  )
}

export default function Storage() {
  const [mounts, setMounts] = useState<Mount[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [mountPage, setMountPage] = useState(1)

  // 编辑器
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorIsNew, setEditorIsNew] = useState(true)
  const [editorId, setEditorId] = useState('')
  const [editorCreatedAt, setEditorCreatedAt] = useState('')
  const [form, setForm] = useState<MountForm>(() => formOf(null))
  const [formErrors, setFormErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 目录浏览
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseMount, setBrowseMount] = useState<Mount | null>(null)
  const [browsePath, setBrowsePath] = useState('/')
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState('')
  const [browsePage, setBrowsePage] = useState(1)
  const browseSeq = useRef(0)

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Mount | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/api/v1/storage/mounts')
      setMounts(mountListOf(data))
      setMountPage(1)
    } catch (err) {
      setMounts([])
      const message = errorText(err)
      setError(message)
      toast.danger(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /* ---------------------------------------------------------------- 列表操作 */

  const openEditor = (row: Mount | null) => {
    setEditorIsNew(!row)
    setEditorId(row?.id || '')
    setEditorCreatedAt(row?.createdAt || '')
    setForm(formOf(row))
    setFormErrors({})
    setTestResult(null)
    setEditorOpen(true)
  }

  const updateForm = <K extends keyof MountForm>(key: K, value: MountForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setFormErrors({})
  }

  const saveMount = async () => {
    const errors = validateMount(form)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    try {
      const payload = buildPayload(form, editorId, editorCreatedAt)
      if (editorIsNew) {
        await api.post('/api/v1/storage/mounts', payload)
      } else {
        await api.put(`/api/v1/storage/mounts/${encodeURIComponent(editorId)}`, payload)
      }
      toast.success('已保存')
      setEditorOpen(false)
      await load()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const testInEditor = async () => {
    const errors = validateMount(form)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return
    setTesting(true)
    setTestResult(null)
    try {
      await api.post('/api/v1/storage/mounts/test', {
        mount: buildPayload(form, editorId, editorCreatedAt),
        id: editorId,
      })
      setTestResult({ ok: true, message: '连接正常' })
      toast.success('连接正常')
    } catch (err) {
      const message = errorText(err)
      setTestResult({ ok: false, message })
      toast.danger(message)
    } finally {
      setTesting(false)
    }
  }

  const testRow = async (row: Mount) => {
    setBusyId(row.id)
    try {
      await api.post('/api/v1/storage/mounts/test', { mount: row, id: row.id })
      toast.success(`连接正常：${row.name || row.id}`)
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setBusyId('')
    }
  }

  const confirmDelete = async () => {
    const row = deleteTarget
    if (!row || deleting) return
    setDeleting(true)
    try {
      await api.del(`/api/v1/storage/mounts/${encodeURIComponent(row.id)}`)
      toast.success('已删除')
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  /* ---------------------------------------------------------------- 目录浏览 */

  const loadBrowse = async (mount: Mount, target: string) => {
    const path = normalizePath(target)
    const seq = (browseSeq.current += 1)
    setBrowsePath(path)
    setBrowsePage(1)
    setBrowseLoading(true)
    setBrowseError('')
    try {
      const data = await api.get(
        `/api/v1/storage/mounts/${encodeURIComponent(mount.id)}/list`,
        { path },
      )
      if (seq !== browseSeq.current) return
      const record = (data || {}) as { entries?: unknown }
      setBrowseEntries(normalizeEntries(record.entries, path))
    } catch (err) {
      if (seq !== browseSeq.current) return
      setBrowseEntries([])
      const message = errorText(err)
      setBrowseError(message)
      toast.danger(message)
    } finally {
      if (seq === browseSeq.current) setBrowseLoading(false)
    }
  }

  const openBrowser = (row: Mount) => {
    browseSeq.current += 1
    setBrowseMount(row)
    setBrowsePath('/')
    setBrowseEntries([])
    setBrowseError('')
    setBrowsePage(1)
    setBrowseOpen(true)
    void loadBrowse(row, '/')
  }

  const closeBrowser = () => {
    browseSeq.current += 1
    setBrowseOpen(false)
    setBrowseLoading(false)
  }

  /* ---------------------------------------------------------------- 渲染数据 */

  const mountPageCount = Math.max(1, Math.ceil(mounts.length / PAGE_SIZE))
  const mountPageSafe = Math.min(mountPage, mountPageCount)
  const visibleMounts = mounts.slice((mountPageSafe - 1) * PAGE_SIZE, mountPageSafe * PAGE_SIZE)

  const browsePageCount = Math.max(1, Math.ceil(browseEntries.length / PAGE_SIZE))
  const browsePageSafe = Math.min(browsePage, browsePageCount)
  const visibleEntries = browseEntries.slice(
    (browsePageSafe - 1) * PAGE_SIZE,
    browsePageSafe * PAGE_SIZE,
  )

  const browseParts = (() => {
    const parts = normalizePath(browsePath).split('/').filter(Boolean)
    const out: { name: string; path: string }[] = []
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      out.push({ name: part, path: acc })
    }
    return out
  })()

  const mountColumns: Column<Mount>[] = [
    {
      key: 'name',
      title: '名称/备注',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words">{row.name || '未命名'}</span>
          {row.remark ? <span className="text-xs text-muted">{row.remark}</span> : null}
        </div>
      ),
    },
    {
      key: 'location',
      title: '位置',
      render: (row) => (
        <span className="mono text-xs text-muted" title={locationOf(row) || undefined}>
          {locationOf(row) || '-'}
        </span>
      ),
    },
    {
      key: 'readOnly',
      title: '只读',
      className: 'whitespace-nowrap',
      render: (row) => (
        <Chip size="sm" variant="soft" color={row.readOnly ? 'warning' : 'success'}>
          {row.readOnly ? '只读' : '可写'}
        </Chip>
      ),
    },
    {
      key: 'enable',
      title: '启用',
      className: 'whitespace-nowrap',
      render: (row) => (
        <Chip size="sm" variant="soft" color={row.enable ? 'success' : 'default'}>
          {row.enable ? '已启用' : '已停用'}
        </Chip>
      ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      className: 'whitespace-nowrap',
      render: (row) => <span className="text-xs text-muted">{fmtTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      className: 'whitespace-nowrap',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onPress={() => openBrowser(row)}>
            浏览
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busyId === row.id}
            onPress={() => void testRow(row)}
          >
            {busyId === row.id ? '测试中…' : '测试'}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => openEditor(row)}>
            编辑
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => setDeleteTarget(row)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  const browseColumns: Column<BrowseEntry>[] = [
    {
      key: 'name',
      title: '名称',
      render: (row) => (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {row.dir ? (
            <Folder size={14} style={{ color: 'var(--accent)' }} className="shrink-0" />
          ) : (
            <File size={14} className="shrink-0 text-muted" />
          )}
          <span className={`break-all ${row.dir ? 'font-medium' : ''}`}>
            {row.name}
            {row.dir ? '/' : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'type',
      title: '类型',
      className: 'whitespace-nowrap',
      render: (row) => (
        <Chip size="sm" variant="soft" color="default">
          {row.dir ? '目录' : '文件'}
        </Chip>
      ),
    },
    {
      key: 'size',
      title: '大小',
      className: 'whitespace-nowrap text-right',
      render: (row) => <span className="text-xs text-muted">{row.dir ? '-' : fmtBytes(row.size)}</span>,
    },
    {
      key: 'modTime',
      title: '修改时间',
      className: 'whitespace-nowrap',
      render: (row) => <span className="text-xs text-muted">{fmtTime(row.modTime)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      className: 'whitespace-nowrap',
      render: (row) =>
        row.dir ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              if (browseMount) void loadBrowse(browseMount, row.path)
            }}
          >
            打开
          </Button>
        ) : (
          <span className="text-xs text-muted">-</span>
        ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="存储"
        sub="本地目录挂载，作为静态托管的只读存储后端"
        actions={
          <>
            <Button variant="secondary" isDisabled={loading} onPress={() => void load()}>
              <RefreshCw size={16} />
              {loading ? '刷新中…' : '刷新'}
            </Button>
            <Button variant="primary" onPress={() => openEditor(null)}>
              <Plus size={16} />
              新建挂载
            </Button>
          </>
        }
      />

      <Panel
        title="存储挂载"
        extra={
          <span className="text-xs text-muted">
            {mounts.length > 0 ? `共 ${mounts.length} 个挂载` : '暂无挂载'}
          </span>
        }
      >
        <div className="flex min-w-0 flex-col">
          {error ? (
            <div className="px-4 pt-4">
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>无法读取存储挂载</Alert.Title>
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Content>
              </Alert>
            </div>
          ) : null}
          <DataTable
            items={visibleMounts}
            columns={mountColumns}
            rowKey={(row) => row.id}
            ariaLabel="存储挂载"
            empty={
              loading ? (
                '加载中…'
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <span>还没有配置存储挂载</span>
                  <Button size="sm" variant="primary" onPress={() => openEditor(null)}>
                    新建挂载
                  </Button>
                </div>
              )
            }
          />
          <Pager page={mountPageSafe} pageCount={mountPageCount} onChange={setMountPage} />
          <div className="border-t border-border px-4 py-3 text-xs leading-relaxed text-muted">
            存储挂载只支持本地目录，供静态托管读取；目录路径创建后仍可修改。
          </div>
        </div>
      </Panel>

      <FormModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editorIsNew ? '新建挂载' : '编辑挂载'}
        footer={
          <div className="flex w-full items-center gap-2">
            <Button variant="secondary" isDisabled={saving || testing} onPress={() => void testInEditor()}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <div className="flex-1" />
            <Button variant="tertiary" isDisabled={saving} onPress={() => setEditorOpen(false)}>
              取消
            </Button>
            <Button variant="primary" isDisabled={saving || testing} onPress={() => void saveMount()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <TextInput
            label="名称"
            required
            value={form.name}
            onChange={(value) => updateForm('name', value)}
            placeholder="例如：NAS 备份"
            hint={hintWithError(formErrors.name)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchInput
              label="启用"
              value={form.enable}
              onChange={(value) => updateForm('enable', value)}
            />
            <SwitchInput
              label="只读"
              value={form.readOnly}
              onChange={(value) => updateForm('readOnly', value)}
            />
          </div>

          <TextInput
            label="本地目录"
            required
            value={form.root}
            onChange={(value) => updateForm('root', value)}
            placeholder="/data/media"
            hint={hintWithError(
              formErrors.root,
              '目录必须存在且服务进程可读，例如 /data/media 或 D:/media',
            )}
          />

          <TextInput
            label="备注"
            value={form.remark}
            onChange={(value) => updateForm('remark', value)}
            placeholder="可选"
          />

          {testResult ? (
            <Alert status={testResult.ok ? 'success' : 'danger'}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{testResult.ok ? '连接正常' : '连接失败'}</Alert.Title>
                {testResult.ok ? null : (
                  <Alert.Description>
                    <span className="break-all">{testResult.message}</span>
                  </Alert.Description>
                )}
              </Alert.Content>
            </Alert>
          ) : null}
        </div>
      </FormModal>

      <FormModal
        open={browseOpen}
        onClose={closeBrowser}
        title={`浏览：${browseMount?.name || browseMount?.id || ''}`}
        size="xl"
        footer={
          <div className="flex w-full items-center">
            <div className="flex-1" />
            <Button variant="tertiary" onPress={closeBrowser}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!browseMount || browseLoading}
              onPress={() => browseMount && void loadBrowse(browseMount, parentPath(browsePath))}
            >
              上一级
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!browseMount || browseLoading}
              onPress={() => browseMount && void loadBrowse(browseMount, '/')}
            >
              根目录
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!browseMount || browseLoading}
              onPress={() => browseMount && void loadBrowse(browseMount, browsePath)}
            >
              <RefreshCw size={14} />
              刷新
            </Button>
            <span className="mono min-w-0 break-all text-xs text-muted">{browsePath}</span>
            <span className="ml-auto whitespace-nowrap text-xs text-muted">
              {browseMount?.readOnly ? '只读' : '可写'} · {browseEntries.length} 项
            </span>
          </div>

          <nav aria-label="目录路径" className="flex flex-wrap items-center gap-1 text-xs">
            <Button size="sm" variant="ghost" onPress={() => browseMount && void loadBrowse(browseMount, '/')}>
              根目录
            </Button>
            {browseParts.map((part) => (
              <span key={part.path} className="inline-flex items-center gap-1">
                <ChevronRight size={12} className="text-muted" />
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => browseMount && void loadBrowse(browseMount, part.path)}
                >
                  {part.name}
                </Button>
              </span>
            ))}
          </nav>

          {browseError ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>无法读取目录</Alert.Title>
                <Alert.Description>
                  <span className="break-all">{browseError}</span>
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          <DataTable
            items={visibleEntries}
            columns={browseColumns}
            rowKey={(row) => row.path}
            ariaLabel="目录内容"
            empty={browseLoading ? '加载中…' : '目录为空'}
          />
          <Pager page={browsePageSafe} pageCount={browsePageCount} onChange={setBrowsePage} />
        </div>
      </FormModal>

      <ConfirmModal
        open={!!deleteTarget}
        title="删除存储挂载"
        danger
        confirmText={deleting ? '删除中…' : '删除'}
        content={
          <>
            确定删除挂载「{deleteTarget?.name || deleteTarget?.id || ''}」吗？引用它的静态托管
            规则会立即失效。
          </>
        }
        onCancel={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
      />
    </Page>
  )
}
