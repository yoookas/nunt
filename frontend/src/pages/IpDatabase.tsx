import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Col,
  Descriptions,
  Empty,
  Input,
  Row,
  Space,
  Tag,
  Typography,
  Upload,
  theme,
} from 'antd'
import {
  GlobalOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import { Muted, PageHeader, Panel, Toolbar } from '../components'

interface DbStatus {
  path?: string
  loaded?: boolean
  ipVersion?: number
  size?: number
  createdAt?: string
  error?: string
}

interface StatusResponse {
  v4?: DbStatus
  v6?: DbStatus
}

interface LookupRecord {
  ip?: string
  country?: string
  province?: string
  provinceNormalized?: string
  city?: string
  isp?: string
  raw?: string
}

type Busy = '' | 'upload4' | 'upload6' | 'reload'

const MAX_XDB_BYTES = 256 * 1024 * 1024

/** Reads the first 20 bytes of the xdb header and checks its IP version. */
async function validateXDB(file: File, expected: 4 | 6): Promise<void> {
  if (!/\.xdb$/i.test(file.name)) {
    throw new Error('请选择 .xdb 格式的 ip2region 地址库文件')
  }
  if (file.size <= 0) {
    throw new Error('文件为空，请重新选择')
  }
  if (file.size > MAX_XDB_BYTES) {
    throw new Error('文件超过 256 MiB 上限，无法上传')
  }
  if (file.size < 20) {
    throw new Error('文件太小，不是有效的 ip2region xdb 地址库')
  }
  let header: ArrayBuffer
  try {
    header = await file.slice(0, 20).arrayBuffer()
  } catch {
    throw new Error('无法读取文件内容，请重新选择文件')
  }
  if (header.byteLength < 20) {
    throw new Error('无法读取文件头，请重新选择文件')
  }
  const ipVersion = new DataView(header).getUint16(16, true)
  if (ipVersion !== 4 && ipVersion !== 6) {
    throw new Error('文件头不是有效的 ip2region xdb 地址库')
  }
  if (ipVersion !== expected) {
    throw new Error(`该文件是 IPv${ipVersion} 地址库，请使用 IPv${ipVersion} 的上传入口`)
  }
}

function statusMeta(status: DbStatus): { color: string; text: string } {
  if (status.loaded) return { color: 'green', text: '已加载' }
  if (status.path) return { color: 'red', text: '加载失败' }
  return { color: 'default', text: '未配置' }
}

export default function IpDatabase() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [v4, setV4] = useState<DbStatus>({})
  const [v6, setV6] = useState<DbStatus>({})
  const [statusReady, setStatusReady] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState<Busy>('')
  const [testIP, setTestIP] = useState('')
  const [result, setResult] = useState<LookupRecord | null>(null)
  const [looking, setLooking] = useState(false)

  const apply = useCallback((data: StatusResponse | null) => {
    setV4(data?.v4 ?? {})
    setV6(data?.v6 ?? {})
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api.get<StatusResponse>('/api/v1/system/ip2region')
      apply(data)
      setStatusError('')
    } catch (err) {
      setStatusError(errorText(err))
    } finally {
      setStatusReady(true)
    }
  }, [apply])

  useEffect(() => {
    void load()
  }, [load])

  const configured = Boolean(v4.path || v6.path)
  const hasAnyDb = Boolean(v4.loaded || v6.loaded)

  // A lookup result belongs to the database that answered it; when both
  // databases are gone, keeping the form and the result would be misleading.
  useEffect(() => {
    if (statusReady && !hasAnyDb) {
      setTestIP('')
      setResult(null)
    }
  }, [statusReady, hasAnyDb])

  const clearLookup = () => {
    setTestIP('')
    setResult(null)
  }

  const lookup = async () => {
    if (looking) return
    const ip = testIP.trim()
    if (!ip) {
      message.warning('请输入要查询的 IP 地址')
      return
    }
    if (!hasAnyDb) {
      message.warning('地址库尚未加载，请先上传地址库或重新加载')
      clearLookup()
      return
    }
    setLooking(true)
    try {
      const data = await api.post<LookupRecord>('/api/v1/system/ip2region/lookup', { ip })
      setResult(data ?? null)
    } catch (err) {
      setResult(null)
      message.error(errorText(err))
    } finally {
      setLooking(false)
    }
  }

  const upload = async (version: 4 | 6, file: File) => {
    try {
      await validateXDB(file, version)
    } catch (err) {
      message.error(errorText(err))
      return
    }
    const key: Busy = version === 4 ? 'upload4' : 'upload6'
    setBusy(key)
    try {
      const data = await api.upload<StatusResponse>('/api/v1/system/ip2region/upload', file)
      apply(data)
      setStatusError('')
      setResult(null)
      const target = version === 4 ? data?.v4 : data?.v6
      if (target?.loaded) {
        message.success(`IPv${version} 地址库已上传并启用`)
      } else {
        message.warning(`文件已上传，但 IPv${version} 地址库尚未加载，请查看状态或重新加载`)
      }
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setBusy('')
    }
  }

  const reload = async () => {
    if (!configured) {
      message.warning('尚未配置地址库，请先上传 .xdb 文件')
      return
    }
    setBusy('reload')
    try {
      const data = await api.post<StatusResponse>('/api/v1/system/ip2region/reload')
      apply(data)
      setStatusError('')
      setResult(null)
      message.success('地址库已重新加载')
    } catch (err) {
      message.error(errorText(err))
      // The failed reload is also visible in the per-family status, so refresh
      // the cards instead of leaving stale "已加载" tags behind.
      await load()
    } finally {
      setBusy('')
    }
  }

  const renderDbCard = (version: 4 | 6, status: DbStatus) => {
    const meta = statusMeta(status)
    const uploadKey: Busy = version === 4 ? 'upload4' : 'upload6'
    return (
      <Panel
        title={`IPv${version} 地址库`}
        extra={<Tag color={meta.color}>{meta.text}</Tag>}
        loading={!statusReady}
      >
        <Descriptions
          size="small"
          column={1}
          colon={false}
          items={[
            {
              key: 'path',
              label: '文件路径',
              children: status.path ? (
                <Typography.Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {status.path}
                </Typography.Text>
              ) : (
                <Muted>未配置</Muted>
              ),
            },
            {
              key: 'version',
              label: '库版本',
              children: status.ipVersion ? `IPv${status.ipVersion}` : '-',
            },
            {
              key: 'size',
              label: '文件大小',
              children: status.size ? fmtBytes(status.size) : '-',
            },
            {
              key: 'createdAt',
              label: '数据日期',
              children: status.createdAt ? fmtTime(status.createdAt) : '-',
            },
          ]}
        />

        {status.error ? (
          <Alert
            type="error"
            showIcon
            message="地址库加载异常"
            description={status.error}
            style={{ marginTop: 12 }}
          />
        ) : null}

        {!status.path ? (
          <div style={{ marginTop: 8 }}>
            <Muted>未上传：涉及 IPv{version} 的国家、省份过滤不会生效。</Muted>
          </div>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <Toolbar>
            <Upload
              accept=".xdb,application/octet-stream"
              showUploadList={false}
              multiple={false}
              disabled={busy !== '' || !statusReady}
              beforeUpload={(file) => {
                void upload(version, file)
                return Upload.LIST_IGNORE
              }}
            >
              <Button
                type={status.loaded ? 'default' : 'primary'}
                icon={<UploadOutlined />}
                loading={busy === uploadKey}
                disabled={busy !== '' && busy !== uploadKey}
              >
                {status.loaded ? '更换地址库' : '上传地址库'}
              </Button>
            </Upload>
            <Muted>
              选择 IPv{version} 的 ip2region .xdb 文件；上传前会校验文件头与大小，服务端再次校验，
              校验失败不会替换现有库。
            </Muted>
          </Toolbar>
        </div>
      </Panel>
    )
  }

  const hasGeo = Boolean(result?.country || result?.province || result?.city || result?.isp)

  return (
    <div>
      <PageHeader
        title="IP 地址库"
        subtitle="Web 规则与端口转发的国家、省份过滤依赖离线 xdb；IPv4 与 IPv6 各用一份库，互不影响。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={busy === 'reload'}
            disabled={!configured || (busy !== '' && busy !== 'reload')}
            onClick={() => void reload()}
          >
            重新加载
          </Button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {statusError ? (
          <Alert
            type="error"
            showIcon
            message="读取地址库状态失败"
            description={statusError}
            action={
              <Button size="small" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        ) : statusReady && !configured ? (
          <Alert
            type="warning"
            showIcon
            message="尚未配置地址库"
            description="国家/省份过滤目前不会生效。上传 IPv4 或 IPv6 的 xdb 文件后即可按地区限制访问。"
          />
        ) : null}

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            {renderDbCard(4, v4)}
          </Col>
          <Col xs={24} lg={12}>
            {renderDbCard(6, v6)}
          </Col>
        </Row>

        <Panel
          title="查询测试"
          subtitle="用来确认地址库内容与过滤值是否对得上"
          extra={statusReady && !hasAnyDb && !statusError ? <Muted>需要先上传地址库</Muted> : null}
          loading={!statusReady}
        >
          <Row gutter={[8, 8]} align="middle">
            <Col xs={24} sm={14} md={10} lg={8}>
              <Input
                value={testIP}
                onChange={(event) => setTestIP(event.target.value)}
                onPressEnter={() => void lookup()}
                placeholder="1.1.1.1 或 2400:3200::1"
                prefix={<GlobalOutlined />}
                allowClear
                maxLength={64}
                disabled={!statusReady}
                aria-label="要查询的 IP 地址"
              />
            </Col>
            <Col xs={12} sm={5} md={4} lg={3}>
              <Button
                type="primary"
                block
                icon={<SearchOutlined />}
                loading={looking}
                disabled={!hasAnyDb}
                onClick={() => void lookup()}
              >
                查询
              </Button>
            </Col>
            <Col xs={12} sm={5} md={4} lg={3}>
              <Button block onClick={clearLookup} disabled={!testIP && !result}>
                清空
              </Button>
            </Col>
          </Row>

          {result ? (
            <div style={{ marginTop: 16 }}>
              <Space wrap size={8} style={{ marginBottom: 8 }}>
                <Tag color="blue" className="mono">
                  {result.ip || '-'}
                </Tag>
                <Muted>查询结果</Muted>
              </Space>
              <Descriptions
                bordered
                size="small"
                column={{ xs: 1, sm: 2, lg: 4 }}
                items={[
                  { key: 'country', label: '国家/地区', children: result.country || '-' },
                  {
                    key: 'province',
                    label: '省份',
                    children: result.province ? (
                      <span>
                        {result.province}
                        {result.provinceNormalized && result.provinceNormalized !== result.province ? (
                          <Muted>（标准：{result.provinceNormalized}）</Muted>
                        ) : null}
                      </span>
                    ) : (
                      '-'
                    ),
                  },
                  { key: 'city', label: '城市', children: result.city || '-' },
                  { key: 'isp', label: '运营商', children: result.isp || '-' },
                ]}
              />
              {!hasGeo ? (
                <Alert
                  type="warning"
                  showIcon
                  message="该地址没有地理信息"
                  description="私有地址、保留地址或地址库未覆盖的网段不会返回国家与城市，这是正常结果。"
                  style={{ marginTop: 12 }}
                />
              ) : null}
              <div style={{ marginTop: 12 }}>
                <Muted>原始记录</Muted>
                <div
                  className="mono"
                  style={{
                    marginTop: 4,
                    padding: '8px 12px',
                    borderRadius: token.borderRadius,
                    background: token.colorFillQuaternary,
                    fontSize: 12,
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {result.raw || '-'}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={hasAnyDb ? '输入 IP 地址后查询所属地区' : '上传地址库后可查询'}
              />
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Alert
              type="info"
              showIcon
              message="私有与保留地址没有地理位置"
              description={
                <span>
                  私有地址（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8、169.254.0.0/16）和
                  IPv6 本地地址（fc00::/7、fe80::/10、::1）不属于任何公网地区，查询返回空字段是正常结果。
                  省份过滤按地址库返回值匹配，可写「浙江」或「浙江省」；查询只读本地 xdb，不会发起外部请求。
                </span>
              }
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}
