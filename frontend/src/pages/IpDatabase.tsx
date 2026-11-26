import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  Row,
  Skeleton,
  Tag,
  Typography,
  Upload,
  theme,
} from 'antd'
import {
  CloudUploadOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'

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
type StatusTone = 'ok' | 'error' | 'off'
type Family = 'v4' | 'v6'

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

function statusMeta(status: DbStatus): { tone: StatusTone; label: string } {
  if (status.loaded) return { tone: 'ok', label: '已加载' }
  if (status.path) return { tone: 'error', label: '加载失败' }
  return { tone: 'off', label: '未配置' }
}

function baseName(path?: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function shortDate(value?: string): string {
  const text = fmtTime(value)
  return text === '-' ? '—' : text.slice(0, 10)
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flex: '0 0 auto',
      }}
    />
  )
}

function Meta({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  const { token } = theme.useToken()
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{label}</div>
      <div
        title={title}
        style={{
          marginTop: 2,
          fontSize: 13,
          color: token.colorText,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function ResultTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        minWidth: 0,
        padding: '10px 12px',
        borderRadius: token.borderRadius,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
      }}
    >
      <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 14, fontWeight: 500, lineHeight: 1.4, wordBreak: 'break-word' }}>
        {value || '—'}
      </div>
      {hint ? <div style={{ marginTop: 2, fontSize: 11, color: token.colorTextTertiary }}>{hint}</div> : null}
    </div>
  )
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
  const [lookupError, setLookupError] = useState('')
  const [uploadErrors, setUploadErrors] = useState<Record<Family, string>>({ v4: '', v6: '' })

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
  const loadedCount = (v4.loaded ? 1 : 0) + (v6.loaded ? 1 : 0)
  const hasGeo = Boolean(result?.country || result?.province || result?.city)

  // A lookup result belongs to the database that answered it; when both
  // databases are gone, keeping the form and the result would be misleading.
  useEffect(() => {
    if (statusReady && !hasAnyDb) {
      setTestIP('')
      setResult(null)
      setLookupError('')
    }
  }, [statusReady, hasAnyDb])

  const clearLookup = () => {
    setTestIP('')
    setResult(null)
    setLookupError('')
  }

  const lookup = async () => {
    if (looking) return
    const ip = testIP.trim()
    if (!ip) {
      message.warning('请输入要查询的 IP 地址')
      return
    }
    if (!hasAnyDb) {
      message.warning('地址库尚未加载，请先上传地址库')
      clearLookup()
      return
    }
    const family = ip.includes(':') ? 6 : 4
    if (family === 4 ? !v4.loaded : !v6.loaded) {
      setResult(null)
      setLookupError(`IPv${family} 地址库尚未加载，请先上传 IPv${family} 的 xdb 文件`)
      return
    }
    setLooking(true)
    setLookupError('')
    try {
      const data = await api.post<LookupRecord>('/api/v1/system/ip2region/lookup', { ip })
      setResult(data ?? null)
    } catch (err) {
      setResult(null)
      setLookupError(errorText(err))
    } finally {
      setLooking(false)
    }
  }

  const upload = async (version: 4 | 6, file: File) => {
    const family: Family = version === 4 ? 'v4' : 'v6'
    try {
      await validateXDB(file, version)
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [family]: errorText(err) }))
      return
    }
    const key: Busy = version === 4 ? 'upload4' : 'upload6'
    setBusy(key)
    setUploadErrors((prev) => ({ ...prev, [family]: '' }))
    try {
      const data = await api.upload<StatusResponse>('/api/v1/system/ip2region/upload', file)
      apply(data)
      setStatusError('')
      setResult(null)
      setLookupError('')
      const target = version === 4 ? data?.v4 : data?.v6
      if (target?.loaded) {
        message.success(`IPv${version} 地址库已上传并启用`)
      } else {
        message.warning(`文件已上传，但 IPv${version} 地址库尚未加载，请查看状态或重新加载`)
      }
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [family]: errorText(err) }))
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
      setUploadErrors({ v4: '', v6: '' })
      setResult(null)
      setLookupError('')
      message.success('地址库已重新加载')
    } catch (err) {
      message.error(errorText(err))
      // The failed reload is also visible in the per-family status, so refresh
      // the cards instead of leaving stale "已加载" labels behind.
      await load()
    } finally {
      setBusy('')
    }
  }

  const renderDbCard = (version: 4 | 6, status: DbStatus) => {
    const family: Family = version === 4 ? 'v4' : 'v6'
    const uploadKey: Busy = version === 4 ? 'upload4' : 'upload6'
    const meta: { tone: StatusTone; label: string } = !statusReady
      ? { tone: 'off', label: '读取中' }
      : statusError
        ? { tone: 'off', label: '状态未知' }
        : statusMeta(status)
    const toneColor =
      meta.tone === 'ok' ? token.colorSuccess : meta.tone === 'error' ? token.colorError : token.colorTextTertiary
    const uploading = busy === uploadKey
    const reloading = busy === 'reload'
    const working = uploading || reloading
    const fileName = baseName(status.path)

    return (
      <Card
        size="small"
        style={{ height: '100%' }}
        styles={{ body: { padding: 14 } }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <StatusDot color={toneColor} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>IPv{version} 地址库</span>
            <span style={{ fontSize: 12, color: toneColor, fontWeight: 400 }}>{meta.label}</span>
          </div>
        }
      >
        {!statusReady ? (
          <Skeleton active title={false} paragraph={{ rows: 4 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                minWidth: 0,
                padding: '10px 12px',
                borderRadius: token.borderRadius,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorFillQuaternary,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <DatabaseOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
                <Typography.Text
                  strong
                  ellipsis={{ tooltip: status.path }}
                  style={{ flex: 1, minWidth: 0, fontSize: 13 }}
                >
                  {fileName || (statusError ? '状态未知' : '尚未选择文件')}
                </Typography.Text>
              </div>
              <div
                className="mono"
                title={status.path}
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: token.colorTextSecondary,
                  wordBreak: 'break-all',
                }}
              >
                {status.path ||
                  (statusError ? '状态读取失败，请重试' : `上传 IPv${version} 的 ip2region .xdb 文件后启用`)}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 8 }}>
              <Meta label="大小" value={status.size ? fmtBytes(status.size) : '—'} />
              <Meta label="版本" value={`IPv${status.ipVersion || version}`} />
              <Meta
                label="数据日期"
                value={status.createdAt ? shortDate(status.createdAt) : '—'}
                title={status.createdAt ? fmtTime(status.createdAt) : undefined}
              />
            </div>

            {status.error ? (
              <Alert type="error" showIcon message="地址库加载异常" description={status.error} />
            ) : null}

            <Upload.Dragger
              accept=".xdb,application/octet-stream"
              showUploadList={false}
              multiple={false}
              height={94}
              disabled={busy !== '' || !statusReady}
              style={{ background: token.colorFillQuaternary }}
              beforeUpload={(file) => {
                void upload(version, file)
                return Upload.LIST_IGNORE
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                {working ? (
                  <LoadingOutlined spin style={{ fontSize: 19, color: token.colorPrimary }} />
                ) : (
                  <CloudUploadOutlined style={{ fontSize: 19, color: token.colorPrimary }} />
                )}
                <span style={{ fontSize: 13, color: token.colorText }}>
                  {reloading
                    ? '正在重新加载…'
                    : uploading
                      ? '正在上传…'
                      : status.loaded
                        ? '拖放或点击更换地址库'
                        : '拖放或点击上传地址库'}
                </span>
                <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  仅 IPv{version} · 校验文件头 · ≤ 256 MiB
                </span>
              </div>
            </Upload.Dragger>

            {uploadErrors[family] ? (
              <Alert type="error" showIcon message="无法上传该文件" description={uploadErrors[family]} />
            ) : null}
          </div>
        )}
      </Card>
    )
  }

  const resultVersion = (result?.ip || testIP).includes(':') ? 6 : 4

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <Typography.Title level={4} style={{ margin: 0, fontSize: 20, lineHeight: 1.3 }}>
            IP 地址库
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            离线 ip2region · IPv4 / IPv6 独立加载，供 Web 与转发规则做地区过滤
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {statusReady ? (
            statusError ? (
              <Tag color="red">状态未知</Tag>
            ) : !configured ? (
              <Tag color="orange">未配置地址库</Tag>
            ) : (
              <Tag color={loadedCount === 2 ? 'green' : 'orange'}>{loadedCount}/2 已加载</Tag>
            )
          ) : (
            <Tag>读取中</Tag>
          )}
          <Button
            icon={<ReloadOutlined />}
            loading={busy === 'reload'}
            disabled={!statusReady || !configured || (busy !== '' && busy !== 'reload')}
            onClick={() => void reload()}
          >
            重新加载
          </Button>
        </div>
      </div>

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
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          {renderDbCard(4, v4)}
        </Col>
        <Col xs={24} lg={12}>
          {renderDbCard(6, v6)}
        </Col>
      </Row>

      <Card styles={{ body: { padding: 16 } }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <SearchOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong>地址查询</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            确认地址库内容与过滤值是否对得上
          </Typography.Text>
          <div style={{ flex: 1 }} />
          {statusReady && !hasAnyDb ? (
            <Tag color={statusError ? 'red' : 'orange'}>{statusError ? '状态未知' : '尚未加载地址库'}</Tag>
          ) : null}
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorFillQuaternary,
          }}
        >
          <Input.Search
            value={testIP}
            onChange={(event) => {
              const value = event.target.value
              setTestIP(value)
              setLookupError('')
              if (!value.trim() || (result && value.trim() !== result.ip)) setResult(null)
            }}
            onSearch={(_value, _event, info) => {
              if (info?.source === 'clear') {
                clearLookup()
                return
              }
              void lookup()
            }}
            placeholder="输入 IPv4 或 IPv6 地址，例如 1.1.1.1"
            prefix={<GlobalOutlined />}
            enterButton={
              <>
                <SearchOutlined /> 查询
              </>
            }
            size="large"
            allowClear
            maxLength={64}
            loading={looking}
            disabled={!statusReady || !hasAnyDb}
            aria-label="要查询的 IP 地址"
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              marginTop: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: token.colorTextTertiary,
            }}
          >
            <InfoCircleOutlined style={{ marginTop: 2 }} />
            <span>
              私有与保留地址（10/8、172.16/12、192.168/16、fc00::/7、fe80::/10 等）没有地理位置；查询只读本地 xdb，不发起外部请求。
            </span>
          </div>
        </div>

        {lookupError ? (
          <Alert type="error" showIcon message="查询失败" description={lookupError} style={{ marginTop: 12 }} />
        ) : null}

        {!statusReady ? (
          <div style={{ marginTop: 14 }}>
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
          </div>
        ) : result ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <Typography.Text strong className="mono" style={{ fontSize: 20, lineHeight: 1.2 }}>
                {result.ip || testIP.trim() || '—'}
              </Typography.Text>
              <Tag color={resultVersion === 6 ? 'geekblue' : 'blue'}>IPv{resultVersion}</Tag>
              <Tag color={hasGeo ? 'green' : 'orange'}>{hasGeo ? '已匹配' : '无地理信息'}</Tag>
              <div style={{ flex: 1 }} />
              <Button type="text" size="small" onClick={clearLookup}>
                清空
              </Button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: 8,
              }}
            >
              <ResultTile label="国家/地区" value={result.country || '—'} />
              <ResultTile
                label="省份"
                value={result.province || '—'}
                hint={
                  result.provinceNormalized && result.provinceNormalized !== result.province
                    ? `标准：${result.provinceNormalized}`
                    : undefined
                }
              />
              <ResultTile label="城市" value={result.city || '—'} />
              <ResultTile label="运营商" value={result.isp || '—'} />
            </div>

            {!hasGeo ? (
              <Alert
                type="warning"
                showIcon
                message="该地址没有地理信息"
                description="私有/保留地址或地址库未覆盖的网段不会返回国家与城市，地区过滤不会命中。"
                style={{ marginTop: 12 }}
              />
            ) : null}

            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                原始记录
              </Typography.Text>
              <div
                className="mono"
                style={{
                  marginTop: 4,
                  padding: '8px 10px',
                  borderRadius: token.borderRadius,
                  background: token.colorFillQuaternary,
                  fontSize: 12,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {result.raw || '—'}
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              marginTop: 14,
              padding: '20px 12px',
              textAlign: 'center',
              border: `1px dashed ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
            }}
          >
            <GlobalOutlined style={{ fontSize: 24, color: token.colorTextQuaternary }} />
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {statusError ? '无法读取地址库状态，请先重试' : hasAnyDb ? '输入 IP 查看归属地' : '上传地址库后即可查询'}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: token.colorTextSecondary }}>
              支持 IPv4 / IPv6；私有与保留地址不会返回地理信息
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
