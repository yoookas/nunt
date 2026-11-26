import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Modal,
  Space,
  Typography,
  Upload,
  theme,
} from 'antd'
import {
  CodeOutlined,
  CopyOutlined,
  DownloadOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../../api'
import { copyText } from '../../clipboard'
import { Muted, Panel, Toolbar, modalWidth } from '../../components'
import { adminListenURL, downloadText, type SystemInfo } from './shared'

interface Props {
  onChanged: () => void
  onListenMoved: (target: { addr: string; url: string }) => void
}

interface ImportCandidate {
  name: string
  size: number
  config: unknown
}

export default function ConfigPanel({ onChanged, onListenMoved }: Props) {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [busy, setBusy] = useState<'' | 'export' | 'import' | 'reload'>('')
  const [rawOpen, setRawOpen] = useState(false)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawText, setRawText] = useState('')
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null)
  const [importError, setImportError] = useState('')

  const exportConfig = async () => {
    setBusy('export')
    try {
      const data = await api.get('/api/v1/system/config')
      const stamp = new Date().toISOString().slice(0, 10)
      downloadText(`nunt-config-${stamp}.json`, JSON.stringify(data, null, 2))
      message.success('配置已导出')
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy('')
    }
  }

  const showRawConfig = async () => {
    setRawOpen(true)
    setRawLoading(true)
    setRawText('')
    try {
      const data = await api.get('/api/v1/system/config')
      setRawText(JSON.stringify(data, null, 2))
    } catch (err) {
      setRawText(`读取失败：${errorText(err)}`)
    } finally {
      setRawLoading(false)
    }
  }

  const copyRaw = () => {
    if (copyText(rawText)) message.success('已复制到剪贴板')
    else message.error('复制失败，请手动选择文本')
  }

  const readImportFile = async (file: File): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        message.error('配置文件必须是 JSON 对象')
        return
      }
      // Accept both a bare exported config and a {"config": {...}} wrapper.
      const root = parsed as Record<string, unknown>
      const config =
        root.config && typeof root.config === 'object' && !Array.isArray(root.config)
          ? root.config
          : parsed
      setImportError('')
      setCandidate({ name: file.name, size: file.size, config })
    } catch {
      message.error('文件不是合法的 JSON')
    }
  }

  const confirmImport = async () => {
    if (!candidate) return
    setBusy('import')
    setImportError('')
    try {
      const before = await api.get<SystemInfo>('/api/v1/system/info').catch(() => null)
      const previous = before?.adminListen || ''
      const result = await api.put<{
        adminListen?: string
        adminListenConfig?: string
        adminListenSource?: string
      }>('/api/v1/system/config', { config: candidate.config })
      const effective = result?.adminListen || ''
      const targetURL = adminListenURL(effective)
      const moved = result?.adminListenSource !== 'env' && !!effective && !!previous && effective !== previous
      message.success('配置已导入并重新加载')
      if (result?.adminListenSource === 'env') {
        message.warning('导入的监听地址仍由环境变量控制，实际端口未改变')
      } else if (moved) {
        // The old port may already be closed; do not keep calling it from the
        // panels and let the operator jump to the new address instead.
        onListenMoved({ addr: effective, url: targetURL })
      } else {
        onChanged()
      }
      setCandidate(null)
    } catch (err) {
      setImportError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  const reloadConfig = async () => {
    setBusy('reload')
    try {
      await api.post('/api/v1/system/reload')
      message.success('已通知各模块重新加载配置')
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="密钥以掩码导出，回导不会覆盖现有密钥"
        description="导出的 JSON 中所有密钥以 ******** 呈现，管理员密码哈希与恢复码不会导出；直接回导时这些掩码字段会沿用现有值，不会把 ******** 写进配置。"
      />

      <Panel title="配置导出" subtitle="导出当前系统、Web、端口转发、动态域名、证书与 WAF 配置">
        <Toolbar>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={busy === 'export'}
            onClick={() => void exportConfig()}
          >
            导出配置
          </Button>
          <Button icon={<CodeOutlined />} onClick={() => void showRawConfig()}>
            查看当前配置 JSON
          </Button>
        </Toolbar>
      </Panel>

      <Panel title="配置导入" subtitle="导入会替换配置（管理员密码哈希会保留），随后自动重载各模块">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="导入是破坏性操作"
            description="当前配置会被文件中的配置覆盖，包括监听地址、Web 路由、转发规则、证书与 WAF 设置；请先导出一份备份。"
          />
          <Space wrap>
            <Upload
              accept=".json,application/json"
              showUploadList={false}
              disabled={busy !== ''}
              beforeUpload={(file) => {
                void readImportFile(file)
                return false
              }}
            >
              <Button icon={<UploadOutlined />} disabled={busy !== ''} loading={busy === 'import'}>
                选择配置文件
              </Button>
            </Upload>
            <Muted>仅支持 UTF-8 的 JSON 文件，大小以服务器限制为准。</Muted>
          </Space>
        </Space>
      </Panel>

      <Panel title="重载配置" subtitle="修改配置文件后让各模块重新读取，无需重启进程">
        <Toolbar>
          <Button
            icon={<ReloadOutlined />}
            loading={busy === 'reload'}
            disabled={busy === 'import'}
            onClick={() => void reloadConfig()}
          >
            重载配置
          </Button>
          <Muted>只重新读取磁盘上的配置，不会回滚未保存的修改。</Muted>
        </Toolbar>
      </Panel>

      <Modal
        open={rawOpen}
        title="当前配置（密钥已脱敏）"
        width={modalWidth(true)}
        onCancel={() => setRawOpen(false)}
        footer={
          <Space>
            <Button type="primary" icon={<CopyOutlined />} disabled={rawLoading} onClick={copyRaw}>
              复制
            </Button>
            <Button onClick={() => setRawOpen(false)}>关闭</Button>
          </Space>
        }
      >
        <pre
          className="mono"
          style={{
            margin: 0,
            maxHeight: '60vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            padding: 12,
            fontSize: 12,
            lineHeight: 1.7,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            background: token.colorFillQuaternary,
          }}
        >
          {rawLoading ? '加载中…' : rawText}
        </pre>
      </Modal>

      <Modal
        open={candidate !== null}
        title="导入配置"
        okText="导入"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={busy === 'import'}
        maskClosable={busy !== 'import'}
        onCancel={() => {
          if (busy !== 'import') setCandidate(null)
        }}
        onOk={() => void confirmImport()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text>
            将从 <span className="mono">{candidate?.name}</span>（{candidate?.size ?? 0} 字节）导入配置。
          </Typography.Text>
          <Alert
            type="warning"
            showIcon
            message="导入会覆盖当前的系统、Web、转发、动态域名、证书与 WAF 配置，确定继续吗？"
          />
          <div>
            <Muted>掩码字段（********）会保留现有密钥；管理员密码哈希不会被覆盖。</Muted>
          </div>
          {importError ? <Alert type="error" showIcon message="导入失败" description={importError} /> : null}
        </Space>
      </Modal>

    </Space>
  )
}
