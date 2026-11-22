import { useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  Table,
  TextArea,
  TextField,
  toast,
} from '@heroui/react'
import { X } from 'lucide-react'

export { toast }

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>
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
    <div className="page-header">
      <div>
        <div className="page-title">{title}</div>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      <div className="spacer" />
      {actions ? <div className="toolbar">{actions}</div> : null}
    </div>
  )
}

export function Panel({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      {title || extra ? (
        <Card.Header className="flex flex-wrap items-center gap-3">
          <Card.Title className="text-base">{title}</Card.Title>
          <div className="flex-1" />
          {extra}
        </Card.Header>
      ) : null}
      <Card.Content className="p-0">{children}</Card.Content>
    </Card>
  )
}

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
}: {
  items: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  empty?: ReactNode
  ariaLabel?: string
}) {
  if (items.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-muted">{empty}</div>
  }
  return (
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
  )
}

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
  return (
    <Modal isOpen={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size={size === 'xl' ? 'lg' : size}>
          <Modal.Dialog>
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
    <TextField value={value} onChange={onChange} isRequired={required} isDisabled={disabled}>
      <Label>{label}</Label>
      <Input type={type} placeholder={placeholder} />
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
    <TextField value={value} onChange={onChange} isRequired={required}>
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
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="number"
        className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-focus"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
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
    <div className="flex flex-col gap-1.5">
      {label ? <span className="text-sm font-medium">{label}</span> : null}
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2 py-1">
        {value.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-full bg-default px-2 py-0.5 text-xs"
          >
            {item}
            <button
              type="button"
              aria-label={`移除 ${item}`}
              className="text-muted hover:text-danger"
              onClick={() => onChange(value.filter((entry) => entry !== item))}
            >
              <X size={12} />
            </button>
          </span>
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
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
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
    <FormModal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="tertiary" onPress={onCancel}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onPress={onConfirm}>
            {confirmText}
          </Button>
        </div>
      }
    >
      <div className="text-sm">{content}</div>
    </FormModal>
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
    <Chip color={color === 'primary' ? 'accent' : color || 'default'} size="sm" variant="soft">
      {children}
    </Chip>
  )
}

export function useOptions<T>(items: T[], getValue: (item: T) => string, getLabel: (item: T) => string) {
  return useMemo(() => items.map((item) => ({ value: getValue(item), label: getLabel(item) })), [items])
}
