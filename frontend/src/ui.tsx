import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Chip,
  Description,
  EmptyState,
  Input,
  Label,
  ListBox,
  Menu,
  MenuItem,
  Modal,
  NumberField,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Table,
  Tag,
  TextArea,
  TextField,
  Typography,
  toast,
} from '@heroui/react'
import { ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react'

export { toast }

/* -------------------------------------------------------------------------- */
/* Page shell                                                                 */
/* -------------------------------------------------------------------------- */

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
}

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <Typography.Heading level={2} className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </Typography.Heading>
        {sub ? (
          <Typography.Paragraph className="mt-1 max-w-prose text-xs text-muted sm:text-sm">
            {sub}
          </Typography.Paragraph>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  )
}

export function Section({
  title,
  description,
  actions,
  extra,
  children,
  className = '',
  flush,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
  flush?: boolean
}) {
  const headerActions = actions ?? extra
  const header =
    title || description || headerActions ? (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          {title ? <div className="text-sm font-semibold sm:text-base">{title}</div> : null}
          {description ? <div className="mt-0.5 text-xs text-muted">{description}</div> : null}
        </div>
        {headerActions ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{headerActions}</div>
        ) : null}
      </div>
    ) : null

  return (
    <Card className={`min-w-0 ${className}`.trim()}>
      {header}
      <Card.Content className={flush ? 'p-0' : 'p-4 sm:p-5'}>{children}</Card.Content>
    </Card>
  )
}

// Panel stays as the compatibility alias used by the pages.
export const Panel = Section

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
}) {
  // One compact tile: the label is a caption, the value and its hint share the
  // line below. The old three-line card with a large icon block wasted roughly
  // three times this height for the same information.
  return (
    <Card>
      <Card.Content className="flex items-center gap-2.5 px-3 py-2">
        {icon ? <div className="shrink-0 rounded-md bg-default p-1.5 text-foreground">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] leading-4 text-muted">{label}</div>
          <div className="flex items-baseline gap-2">
            <span className="truncate text-base font-semibold leading-5">{value}</span>
            {hint ? (
              <span className="truncate text-[11px] leading-4 text-muted" title={typeof hint === 'string' ? hint : undefined}>
                {hint}
              </span>
            ) : null}
          </div>
        </div>
      </Card.Content>
    </Card>
  )
}

/**
 * LiveStatus is only visible when a poll fails: silently refreshing pages must
 * not put a permanent caption in the header, but they must not hide stale data
 * either. It renders nothing while polling works, and a red retry line when it
 * does not.
 */
export function LiveStatus({
  status,
  className = '',
}: {
  status: { failed: boolean; refresh: () => unknown }
  className?: string
}) {
  if (!status.failed) return null
  return (
    <button
      type="button"
      onClick={() => void status.refresh()}
      title="点击立即重试"
      className={`rounded-field px-2 py-1 text-xs text-danger transition-colors hover:bg-default ${className}`.trim()}
    >
      刷新失败，点击重试
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

export interface Column<T> {
  key: string
  title: string
  render: (row: T) => ReactNode
  className?: string
}

export function DataTable<T>({
  items,
  columns,
  rowKey,
  empty = '暂无数据',
  ariaLabel = '数据表',
  loading,
}: {
  items: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  empty?: ReactNode
  ariaLabel?: string
  loading?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const measure = useMemo(
    () => () => {
      const el = scrollRef.current
      if (!el) return
      const max = el.scrollWidth - el.clientWidth
      setOverflow(max > 2)
      setAtStart(el.scrollLeft <= 2)
      setAtEnd(el.scrollLeft >= max - 2)
    },
    [],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [measure, items, columns])

  const nudge = (direction: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' })
  }

  if (loading) return <TableSkeleton columns={columns.length} />
  if (items.length === 0) {
    return (
      <EmptyState className="py-10">
        <EmptyState.Root>
          <div className="text-sm text-muted">{empty}</div>
        </EmptyState.Root>
      </EmptyState>
    )
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={measure}
        tabIndex={0}
        className="data-table-scroll w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain"
        role="region"
        aria-label={`${ariaLabel}（可横向滚动）`}
      >
        <div className="min-w-[600px] md:min-w-0">
          <Table>
            <Table.Content aria-label={ariaLabel}>
              <Table.Header>
                {columns.map((column, index) => (
                  <Table.Column key={column.key} isRowHeader={index === 0} className={column.className}>
                    {column.title}
                  </Table.Column>
                ))}
              </Table.Header>
              <Table.Body>
                {items.map((row) => (
                  <Table.Row key={rowKey(row)} id={rowKey(row)}>
                    {columns.map((column) => (
                      <Table.Cell key={column.key} className={column.className}>
                        {column.render(row)}
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table>
        </div>
      </div>

      {overflow ? (
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 md:hidden">
          <span className="mr-auto text-[11px] text-muted">左右滑动查看完整表格</span>
          <Button
            isIconOnly
            size="sm"
            variant="tertiary"
            aria-label="向左滚动表格"
            isDisabled={atStart}
            onPress={() => nudge(-1)}
          >
            <ChevronLeft size={15} />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="tertiary"
            aria-label="向右滚动表格"
            isDisabled={atEnd}
            onPress={() => nudge(1)}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function TableSkeleton({ columns = 4, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton key={columnIndex} className="h-8 flex-1 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner size="sm" />
      {label}
    </div>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <TextField
      aria-label={placeholder}
      value={value}
      onChange={onChange}
      className="w-56"
    >
      <Input placeholder={placeholder} />
    </TextField>
  )
}

/* -------------------------------------------------------------------------- */
/* Drawers / dialogs                                                          */
/* -------------------------------------------------------------------------- */

export function FormModal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'lg',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}) {
  // A form is a dialog, not a side sheet: Modal centers it on screen. The
  // Drawer component used here before anchored itself to the left edge.
  return (
    <Modal isOpen={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
      <Modal.Backdrop>
        <Modal.Container placement="center" scroll="inside" size="lg">
          <Modal.Dialog className={size === 'xl' || size === 'full' ? 'sm:max-w-3xl' : 'sm:max-w-xl'}>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
            {footer ? <Modal.Footer>{footer}</Modal.Footer> : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export function ConfirmModal({
  open,
  title,
  content,
  onCancel,
  onConfirm,
  danger,
  confirmText = '确定',
}: {
  open: boolean
  title: string
  content: ReactNode
  onCancel: () => void
  onConfirm: () => void
  danger?: boolean
  confirmText?: string
}) {
  return (
    <AlertDialog isOpen={open} onOpenChange={(isOpen: boolean) => !isOpen && onCancel()}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>{content}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={onCancel}>
                取消
              </Button>
              <Button variant={danger ? 'danger' : 'primary'} onPress={onConfirm}>
                {confirmText}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  required,
  disabled,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: ReactNode
  required?: boolean
  disabled?: boolean
  type?: string
}) {
  return (
    <TextField
      value={value}
      onChange={onChange}
      isRequired={required}
      isDisabled={disabled}
      type={type}
      className="w-full"
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
      {hint ? <Description>{hint}</Description> : null}
    </TextField>
  )
}

export function TextAreaInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 4,
  required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: ReactNode
  rows?: number
  required?: boolean
}) {
  return (
    <TextField value={value} onChange={onChange} isRequired={required} className="w-full">
      <Label>{label}</Label>
      <TextArea rows={rows} placeholder={placeholder} />
      {hint ? <Description>{hint}</Description> : null}
    </TextField>
  )
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  hint?: ReactNode
}) {
  return (
    <NumberField
      value={Number.isFinite(value) ? value : 0}
      onChange={(next: number) => onChange(Number.isFinite(next) ? next : 0)}
      minValue={min}
      maxValue={max}
      step={step}
      className="w-full"
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton>
          <Minus size={14} />
        </NumberField.DecrementButton>
        <NumberField.Input />
        <NumberField.IncrementButton>
          <Plus size={14} />
        </NumberField.IncrementButton>
      </NumberField.Group>
      {hint ? <Description>{hint}</Description> : null}
    </NumberField>
  )
}

export interface SelectOption {
  value: string
  label: string
}

export function SelectInput({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  required,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  hint?: ReactNode
  required?: boolean
  disabled?: boolean
}) {
  return (
    <Select
      selectedKey={value || null}
      onSelectionChange={(key) => onChange(key == null ? '' : String(key))}
      isRequired={required}
      isDisabled={disabled}
      placeholder={placeholder}
      className="w-full"
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      {hint ? <Description>{hint}</Description> : null}
    </Select>
  )
}

// ToolbarSelect and ToolbarSearch are the compact, label-less controls used
// inside a card header: a stacked label would make the header taller than the
// rows it filters.
export function ToolbarSelect({
  label,
  value,
  onChange,
  options,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
}) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => onChange(key == null ? '' : String(key))}
      aria-label={label}
    >
      <Select.Trigger className={`h-9 ${className}`.trim()}>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

export function ToolbarSearch({
  label,
  value,
  onChange,
  placeholder,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className={`h-9 rounded-field border border-border bg-surface px-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-focus ${className}`.trim()}
    />
  )
}

export function SwitchInput({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <Switch isSelected={value} onChange={onChange} isDisabled={disabled}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <span className="text-sm">{label}</span>
        </Switch.Content>
      </Switch>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

function TagFieldShell({
  label,
  hint,
  children,
}: {
  label?: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <span className="text-sm font-medium">{label}</span> : null}
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1">
        {children}
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

export function TagInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label?: string
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  hint?: ReactNode
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const items = draft
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!items.length) return
    const next = [...value]
    for (const item of items) if (!next.includes(item)) next.push(item)
    onChange(next)
    setDraft('')
  }

  return (
    <TagFieldShell label={label} hint={hint}>
      {value.map((item) => (
        <Tag key={item} className="gap-1">
          {item}
          <button
            type="button"
            aria-label={`移除 ${item}`}
            className="text-muted hover:text-danger"
            onClick={() => onChange(value.filter((entry) => entry !== item))}
          >
            <X size={12} />
          </button>
        </Tag>
      ))}
      <input
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault()
            add()
          } else if (event.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
      />
    </TagFieldShell>
  )
}

export function MultiSelectInput({
  label,
  value,
  onChange,
  options,
  placeholder = '请选择',
  hint,
}: {
  label?: string
  value: string[]
  onChange: (value: string[]) => void
  options: SelectOption[]
  placeholder?: string
  hint?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (item: string) => {
    onChange(value.includes(item) ? value.filter((entry) => entry !== item) : [...value, item])
  }

  return (
    <div className="flex flex-col gap-1.5" ref={rootRef}>
      {label ? <span className="text-sm font-medium">{label}</span> : null}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-left text-sm"
        >
          {value.length === 0 ? (
            <span className="text-muted">{placeholder}</span>
          ) : (
            value.map((item) => (
              <Tag key={item}>{item}</Tag>
            ))
          )}
          <ChevronDown size={14} className="ml-auto text-muted" />
        </button>
        {open ? (
          <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-overlay p-1 shadow-lg">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted">没有可选项</div>
            ) : (
              options.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-default"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(option.value)}
                    onChange={() => toggle(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

export function StatusChip({
  color,
  children,
}: {
  color?: 'default' | 'primary' | 'success' | 'warning' | 'danger'
  children: ReactNode
}) {
  return (
    <Chip
      color={color === 'primary' ? 'accent' : color || 'default'}
      size="sm"
      variant="soft"
      className="shrink-0 whitespace-nowrap"
    >
      {children}
    </Chip>
  )
}

export function AlertBox({
  status = 'default',
  title,
  children,
}: {
  status?: 'default' | 'accent' | 'success' | 'warning' | 'danger'
  title?: ReactNode
  children?: ReactNode
}) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        {children ? <Alert.Description>{children}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  )
}

export function useOptions<T>(items: T[], getValue: (item: T) => string, getLabel: (item: T) => string) {
  return useMemo(() => items.map((item) => ({ value: getValue(item), label: getLabel(item) })), [items])
}
