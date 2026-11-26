import { Alert, Button, Modal, Tag } from 'antd'
import type { TableColumnsType } from 'antd'
import { fmtTime } from '../../format'
import { DataTable, modalWidth, Muted } from '../../components'
import type { DdnsRecord, DdnsStatus } from './types'

interface DdnsLogsModalProps {
  open: boolean
  status: DdnsStatus | null
  onClose: () => void
}

export default function DdnsLogsModal({ open, status, onClose }: DdnsLogsModalProps) {
  const records: DdnsRecord[] = Array.isArray(status?.records)
    ? [...(status?.records ?? [])].reverse()
    : []

  const columns: TableColumnsType<DdnsRecord> = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 170,
      render: (value) => <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTime(value)}</span>,
    },
    {
      title: '结果',
      dataIndex: 'ok',
      key: 'ok',
      width: 90,
      render: (value) => <Tag color={value ? 'green' : 'red'}>{value ? '成功' : '失败'}</Tag>,
    },
    {
      title: '内容',
      dataIndex: 'message',
      key: 'message',
      render: (value) => <span style={{ fontSize: 12, wordBreak: 'break-word' }}>{value || '-'}</span>,
    },
  ]

  return (
    <Modal
      open={open}
      title={`运行日志 · ${status?.name || status?.id || ''}`}
      width={modalWidth(true)}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      styles={{ body: { maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto' } }}
      destroyOnHidden
    >
      {status?.lastError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="最近一次执行失败"
          description={status.lastError}
        />
      ) : null}

      <Muted>
        共 {records.length} 条执行记录 · 最近执行 {fmtTime(status?.lastRun)} · 最近成功{' '}
        {fmtTime(status?.lastSuccess)}
      </Muted>

      <div style={{ marginTop: 12 }}>
        <DataTable<DdnsRecord>
          rowKey={(_row, index) => String(index)}
          columns={columns}
          dataSource={records}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
          locale={{ emptyText: '暂无执行记录' }}
        />
      </div>
    </Modal>
  )
}
