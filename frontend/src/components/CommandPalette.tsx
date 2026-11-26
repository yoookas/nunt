import { useEffect, useMemo, useRef, useState } from 'react'
import { Input, List, Modal, Tag, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { menu } from '../menu'

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const inputRef = useRef<any>(null)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const timer = setTimeout(() => inputRef.current?.focus?.(), 60)
    return () => clearTimeout(timer)
  }, [open])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return menu
    return menu.filter((item) => item.title.toLowerCase().includes(q) || item.path.includes(q))
  }, [query])

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={560} styles={{ body: { padding: 0 } }} destroyOnHidden>
      <div style={{ padding: 12, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
        <Input
          ref={inputRef}
          size="large"
          variant="borderless"
          prefix={<SearchOutlined />}
          placeholder="跳转到模块…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => {
            if (items[0]) {
              navigate(items[0].path)
              onClose()
            }
          }}
        />
      </div>
      <List
        dataSource={items}
        style={{ maxHeight: 380, overflow: 'auto', padding: 8 }}
        locale={{ emptyText: '没有匹配的模块' }}
        renderItem={(item) => (
          <List.Item
            style={{ cursor: 'pointer', borderRadius: 8, padding: '10px 12px' }}
            onClick={() => {
              navigate(item.path)
              onClose()
            }}
            extra={item.path === '/' ? <Tag>首页</Tag> : null}
          >
            <List.Item.Meta avatar={item.icon} title={<Typography.Text>{item.title}</Typography.Text>} />
          </List.Item>
        )}
      />
      <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(0,0,0,0.06)', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
        Enter 打开第一个结果 · Esc 关闭
      </div>
    </Modal>
  )
}
