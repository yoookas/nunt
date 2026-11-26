import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Col, Form, Input, InputNumber, Row, Space, Switch, Typography } from 'antd'
import type { TableProps } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { api, errorText } from '../../api'
import { DataTable, Muted } from '../../components'
import { fmtBytes, fmtTime } from '../../format'
import {
  EMPTY_BACKUP,
  asArray,
  downloadFile,
  isValidAbsoluteDir,
  type BackupFile,
  type BackupForm,
} from './shared'
import { SettingsSection } from './ui'

interface Props {
  refreshToken: number
}

export default function BackupPanel({ refreshToken }: Props) {
  const [form] = Form.useForm<BackupForm>()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [files, setFiles] = useState<BackupFile[]>([])
  const [dir, setDir] = useState('')

  const loadFiles = useCallback(async () => {
    const data = await api.get('/api/v1/system/backup/files')
    setFiles(asArray<BackupFile>(data?.files))
    setDir(String(data?.dir || ''))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get('/api/v1/system/backup/files')
      const cfg = data?.config || {}
      form.setFieldsValue({
        enabled: !!cfg.enabled,
        intervalHours: Number(cfg.intervalHours) || 24,
        keep: Number(cfg.keep) || 7,
        dir: String(cfg.dir || ''),
      })
      setFiles(asArray<BackupFile>(data?.files))
      setDir(String(data?.dir || ''))
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [form, message])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const onFinish = async (values: BackupForm) => {
    setSaving(true)
    try {
      const result = await api.put('/api/v1/system/backup/config', {
        enabled: !!values.enabled,
        intervalHours: Number(values.intervalHours),
        keep: Number(values.keep),
        dir: String(values.dir || '').trim(),
      })
      if (result) {
        form.setFieldsValue({
          enabled: !!result.enabled,
          intervalHours: Number(result.intervalHours) || 24,
          keep: Number(result.keep) || 7,
          dir: String(result.dir || ''),
        })
      }
      message.success('备份设置已保存')
      await loadFiles().catch(() => undefined)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const createBackup = async () => {
    setCreating(true)
    try {
      await downloadFile('/api/v1/system/backup', 'nunt-backup.tar.gz')
      message.success('备份已生成并开始下载')
      await loadFiles().catch(() => undefined)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  const columns: TableProps<BackupFile>['columns'] = [
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
      title: '时间',
      dataIndex: 'modTime',
      render: (value: string) => fmtTime(value),
    },
  ]

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="备份包含密钥材料"
        description="归档中包含配置、证书、ACME 账号与 secret.key。归档权限为 0600，但离开本机前请自行加密；日志与旧备份不在归档内。"
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={EMPTY_BACKUP}
        requiredMark={false}
        onFinish={onFinish}
        disabled={loading}
      >
        <SettingsSection
          title="自动备份"
          description="按间隔把配置、密钥、证书与 ACME 账号打成 tar.gz"
          first
        >
          <Row gutter={[16, 0]}>
            <Col xs={24} md={8}>
              <Form.Item
                name="enabled"
                label="启用定时备份"
                valuePropName="checked"
                extra="服务启动后约 45 秒检查一次，到间隔才写入；重启不会连续生成"
              >
                <Switch />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="intervalHours"
                label="间隔（小时）"
                rules={[{ required: true, message: '请输入备份间隔' }]}
              >
                <InputNumber min={1} max={720} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="keep"
                label="保留份数"
                rules={[{ required: true, message: '请输入保留份数' }]}
              >
                <InputNumber min={1} max={60} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                name="dir"
                label="备份目录（可选）"
                extra="必须是绝对路径；留空则写入数据目录下的 backups/"
                rules={[
                  {
                    validator: async (_, value: string) => {
                      if (!isValidAbsoluteDir(value)) {
                        throw new Error('请输入绝对路径，或以 / 开头的目录')
                      }
                    },
                  },
                ]}
              >
                <Input placeholder="<数据目录>/backups" allowClear />
              </Form.Item>
            </Col>
          </Row>

          <Space wrap>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} disabled={loading}>
              保存备份设置
            </Button>
            <Button icon={<CloudDownloadOutlined />} loading={creating} onClick={() => void createBackup()}>
              立即备份并下载
            </Button>
            {dir ? <Muted>当前备份目录：{dir}</Muted> : null}
          </Space>
        </SettingsSection>
      </Form>

      <SettingsSection
        title="备份文件"
        description="按修改时间倒序，超过保留份数的旧归档会被自动清理"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} disabled={saving || creating}>
            刷新
          </Button>
        }
      >
        <DataTable<BackupFile>
          rowKey="name"
          columns={columns}
          dataSource={files}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '还没有备份文件' }}
        />
      </SettingsSection>

      <Typography.Paragraph type="secondary" style={{ margin: '14px 0 0', fontSize: 12 }}>
        手动下载同样会生成一份新的归档并纳入保留策略，因此可以随时用它验证备份流程。
      </Typography.Paragraph>
    </div>
  )
}
