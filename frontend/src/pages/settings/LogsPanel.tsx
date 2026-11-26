import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Col, Divider, Form, InputNumber, Row, Space, Switch, Typography } from 'antd'
import type { TableProps } from 'antd'
import { DownloadOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { DataTable, Muted, Panel } from '../../components'
import { fmtBytes, fmtTime } from '../../format'
import { EMPTY_LOG, asArray, downloadFile, type LogFileRow, type LogForm } from './shared'

interface Props {
  refreshToken: number
}

export default function LogsPanel({ refreshToken }: Props) {
  const [form] = Form.useForm<LogForm>()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [files, setFiles] = useState<LogFileRow[]>([])
  const [downloading, setDownloading] = useState('')

  const loadFiles = useCallback(async () => {
    const data = await api.get('/api/v1/system/logs/files').catch(() => [])
    setFiles(asArray<LogFileRow>(data))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cfg, data] = await Promise.all([
        api.get('/api/v1/logs/config'),
        api.get('/api/v1/system/logs/files').catch(() => []),
      ])
      form.setFieldsValue({
        persist: cfg?.access?.persist !== false,
        keepDays: Number(cfg?.access?.keepDays) || 7,
        maxFileMb: Number(cfg?.access?.maxFileMb) || 64,
        appMaxFileMb: Number(cfg?.app?.maxFileMb) || 8,
        appKeepFiles: Number(cfg?.app?.keepFiles) || 3,
      })
      setFiles(asArray<LogFileRow>(data))
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [form, message])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const onFinish = async (values: LogForm) => {
    setSaving(true)
    try {
      const result = await api.put('/api/v1/logs/config', {
        access: {
          persist: !!values.persist,
          keepDays: Number(values.keepDays),
          maxFileMb: Number(values.maxFileMb),
        },
        app: {
          maxFileMb: Number(values.appMaxFileMb),
          keepFiles: Number(values.appKeepFiles),
        },
      })
      if (result) {
        form.setFieldsValue({
          persist: result?.access?.persist !== false,
          keepDays: Number(result?.access?.keepDays) || 7,
          maxFileMb: Number(result?.access?.maxFileMb) || 64,
          appMaxFileMb: Number(result?.app?.maxFileMb) || 8,
          appKeepFiles: Number(result?.app?.keepFiles) || 3,
        })
      }
      message.success('日志设置已保存')
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const downloadLog = async (row: LogFileRow) => {
    setDownloading(row.name)
    try {
      await downloadFile(`/api/v1/system/logs/download?name=${encodeURIComponent(row.name)}`, row.name)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setDownloading('')
    }
  }

  const columns: TableProps<LogFileRow>['columns'] = [
    {
      title: '文件',
      dataIndex: 'name',
      render: (value: string) => <span className="mono">{value}</span>,
    },
    {
      title: '大小',
      dataIndex: 'size',
      render: (value: number) => fmtBytes(value),
    },
    {
      title: '修改时间',
      dataIndex: 'modTime',
      render: (value: string) => fmtTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          icon={<DownloadOutlined />}
          loading={downloading === row.name}
          onClick={() => void downloadLog(row)}
        >
          下载
        </Button>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Panel title="日志设置" subtitle="访问日志写入磁盘的保留策略与运行日志文件的轮转规则">
        <Form
          form={form}
          layout="vertical"
          initialValues={EMPTY_LOG}
          requiredMark={false}
          onFinish={onFinish}
          disabled={loading}
        >
          <Divider orientation="left" plain style={{ marginTop: 0 }}>
            <Typography.Text strong>访问日志（Web / 端口转发 / WAF）</Typography.Text>
          </Divider>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="关闭写入磁盘后只保留内存缓冲，重启即丢失；已写入数据库的记录不会被删除。"
          />
          <Row gutter={[16, 0]}>
            <Col xs={24} md={8}>
              <Form.Item
                name="persist"
                label="写入磁盘"
                valuePropName="checked"
                extra="记入 SQLite，可在「日志 → 访问日志」检索与导出"
              >
                <Switch />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="keepDays"
                label="保留天数"
                rules={[{ required: true, message: '请输入保留天数' }]}
                extra="超过保留期的记录会在启动时与每小时清理一次"
              >
                <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="maxFileMb"
                label="数据库上限（MB）"
                rules={[{ required: true, message: '请输入数据库上限' }]}
                extra="超过后按时间删除最旧的记录"
              >
                <InputNumber min={1} max={4096} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>
            <Typography.Text strong>运行日志文件</Typography.Text>
          </Divider>
          <Row gutter={[16, 0]}>
            <Col xs={24} md={8}>
              <Form.Item
                name="appMaxFileMb"
                label="单文件上限（MB）"
                rules={[{ required: true, message: '请输入单文件上限' }]}
              >
                <InputNumber min={1} max={1024} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="appKeepFiles"
                label="保留份数"
                rules={[{ required: true, message: '请输入保留份数' }]}
                extra="轮转后的 nunt.log.1…n 保留几份"
              >
                <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Space wrap>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} disabled={loading}>
              保存日志设置
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={saving}>
              还原
            </Button>
            <Muted>记录会同时进入各模块的内存缓冲，供页面实时查看。</Muted>
          </Space>
        </Form>
      </Panel>

      <Panel
        title="运行日志文件"
        subtitle="数据目录 logs/ 下的进程日志，下载需要管理员会话"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              void loadFiles().catch((err) => message.error(errorText(err)))
            }}
          >
            刷新
          </Button>
        }
      >
        <DataTable<LogFileRow>
          rowKey="name"
          columns={columns}
          dataSource={files}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '还没有运行日志文件' }}
        />
      </Panel>
    </Space>
  )
}
