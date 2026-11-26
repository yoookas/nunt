import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Space, Tag, Typography } from 'antd'
import type { TableProps } from 'antd'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { DataTable, Muted } from '../../components'
import { fmtTime } from '../../format'
import { asArray, type SessionRow } from './shared'
import { InlineConfirm, SettingsSection } from './ui'

interface Props {
  refreshToken: number
}

export default function SessionsPanel({ refreshToken }: Props) {
  const { message } = App.useApp()
  const [items, setItems] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [kicking, setKicking] = useState('')
  const [kickTarget, setKickTarget] = useState<SessionRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/api/v1/auth/sessions')
      setItems(asArray<SessionRow>(data))
    } catch (err) {
      setError(errorText(err))
      message.error(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const kick = (row: SessionRow) => {
    if (row.current) {
      message.info('这是当前登录会话，请使用右上角的「退出登录」')
      return
    }
    if (!row.id) {
      message.warning('会话列表没有返回会话 ID，无法定向踢出，可以等待它自然过期')
      return
    }
    setKickTarget(row)
  }

  const confirmKick = async () => {
    if (!kickTarget?.id) return
    setKicking(kickTarget.id)
    try {
      await api.del(`/api/v1/auth/sessions/${encodeURIComponent(kickTarget.id)}`)
      message.success('会话已踢出')
      setKickTarget(null)
      await load()
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setKicking('')
    }
  }

  const columns: TableProps<SessionRow>['columns'] = [
    {
      title: '来源 IP',
      dataIndex: 'ip',
      render: (value: string, row) => (
        <Space size={6} wrap>
          <span className="mono">{value || '-'}</span>
          {row.current ? <Tag color="green">当前</Tag> : null}
        </Space>
      ),
    },
    {
      title: '客户端',
      dataIndex: 'userAgent',
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text ellipsis={{ tooltip: value || '' }} style={{ maxWidth: 360, fontSize: 12 }}>
          {value || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '登录时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => fmtTime(value),
    },
    {
      title: '过期时间',
      dataIndex: 'expiresAt',
      width: 170,
      render: (value: string) => fmtTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, row) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={!!row.current || !row.id}
          loading={kicking === row.id}
          onClick={() => kick(row)}
        >
          踢出
        </Button>
      ),
    },
  ]

  const missingId = items.some((row) => !row.current && !row.id)

  return (
    <div>
      <SettingsSection
        title="在线会话"
        description="会话保存在内存中，服务重启后全部失效"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
        first
      >
        {error ? (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message="无法读取在线会话" description={error} />
        ) : null}
        {missingId ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="部分会话没有返回会话 ID，无法定向踢出；可以等待它们自然过期。"
          />
        ) : null}
        {kickTarget ? (
          <InlineConfirm
            title="踢出该会话？"
            description={
              <>
                来自 <span className="mono">{kickTarget.ip || '未知地址'}</span> 的会话将立即失效，对方需要重新登录。
              </>
            }
            confirmText="踢出"
            danger
            busy={kicking !== ''}
            onConfirm={() => void confirmKick()}
            onCancel={() => {
              if (kicking === '') setKickTarget(null)
            }}
          />
        ) : null}
        <DataTable<SessionRow>
          rowKey={(row) => row.id || `${row.ip}|${row.createdAt}`}
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '当前没有在线会话' }}
        />
      </SettingsSection>

      <div style={{ marginTop: 14 }}>
        <Muted>
          User-Agent 始终参与会话校验；开启「会话绑定客户端 IP」后还会校验来源地址。当前会话不能在列表中踢出，请从右上角退出登录。
        </Muted>
      </div>
    </div>
  )
}
