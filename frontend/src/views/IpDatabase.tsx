import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import { Upload } from 'lucide-react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import { AlertBox, Page, PageHeader, Panel, StatusChip, TextInput, toast } from '../ui'

interface DbStatus {
  path?: string
  loaded?: boolean
  ipVersion?: number
  size?: number
  createdAt?: string
  error?: string
}

interface LookupRecord {
  country?: string
  province?: string
  provinceNormalized?: string
  city?: string
  isp?: string
  raw?: string
}

interface StatusResponse {
  v4?: DbStatus
  v6?: DbStatus
}

const LOOKUP_FIELDS: { key: keyof LookupRecord; label: string }[] = [
  { key: 'country', label: '国家/地区' },
  { key: 'provinceNormalized', label: '省份（标准）' },
  { key: 'city', label: '城市' },
  { key: 'isp', label: '运营商' },
]

function statusColor(status: DbStatus): 'success' | 'danger' | 'default' {
  if (status.loaded) return 'success'
  if (status.path) return 'danger'
  return 'default'
}

function statusText(status: DbStatus): string {
  if (status.loaded) return '已加载'
  if (status.path) return '加载失败'
  return '未配置'
}

export default function IpDatabase() {
  const [v4, setV4] = useState<DbStatus>({})
  const [v6, setV6] = useState<DbStatus>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'' | '4' | '6' | 'reload'>('')
  const [testIP, setTestIP] = useState('')
  const [result, setResult] = useState<LookupRecord | null>(null)
  const [looking, setLooking] = useState(false)

  const file4Ref = useRef<HTMLInputElement>(null)
  const file6Ref = useRef<HTMLInputElement>(null)

  const apply = useCallback((data: StatusResponse | null) => {
    setV4(data?.v4 || {})
    setV6(data?.v6 || {})
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api.get<StatusResponse>('/api/v1/system/ip2region')
      apply(data)
    } catch (err) {
      toast.danger(`读取地址库状态失败：${errorText(err)}`)
    } finally {
      setLoaded(true)
    }
  }, [apply])

  useEffect(() => {
    void load()
  }, [load])

  const upload = async (version: 4 | 6, file: File) => {
    setBusy(String(version) as '4' | '6')
    try {
      const data = await api.upload<StatusResponse>('/api/v1/system/ip2region/upload', file)
      apply(data)
      toast.success(`IPv${version} 地址库已上传并启用`)
    } catch (err) {
      toast.danger(`上传失败：${errorText(err)}`)
    } finally {
      setBusy('')
      if (version === 4 && file4Ref.current) file4Ref.current.value = ''
      if (version === 6 && file6Ref.current) file6Ref.current.value = ''
    }
  }

  const reload = async () => {
    setBusy('reload')
    try {
      const data = await api.post<StatusResponse>('/api/v1/system/ip2region/reload')
      apply(data)
      toast.success('地址库已重新加载')
    } catch (err) {
      toast.danger(`重新加载失败：${errorText(err)}`)
    } finally {
      setBusy('')
    }
  }

  const lookup = async () => {
    const ip = testIP.trim()
    if (!ip) {
      toast.warning('请输入要查询的 IP')
      return
    }
    setLooking(true)
    try {
      const data = await api.post<LookupRecord>('/api/v1/system/ip2region/lookup', { ip })
      setResult(data || null)
    } catch (err) {
      setResult(null)
      toast.danger(`查询失败：${errorText(err)}`)
    } finally {
      setLooking(false)
    }
  }

  const dbCard = (version: 4 | 6, status: DbStatus, fileRef: React.RefObject<HTMLInputElement | null>) => (
    <Panel
      title={`IPv${version} 地址库`}
      extra={<StatusChip color={statusColor(status)}>{statusText(status)}</StatusChip>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {status.size ? <span>大小：{fmtBytes(status.size)}</span> : null}
          {status.createdAt ? <span>数据日期：{fmtTime(status.createdAt)}</span> : null}
          {status.path ? <span className="mono break-all">{status.path}</span> : null}
        </div>
        {status.error ? (
          <AlertBox status="danger" title="地址库状态异常">
            {status.error}
          </AlertBox>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            isDisabled={busy !== ''}
            onPress={() => fileRef.current?.click()}
          >
            <Upload size={15} />
            {busy === String(version) ? '上传中…' : status.loaded ? '更换地址库' : '上传地址库'}
          </Button>
          <span className="text-xs text-muted">
            选择 ip2region 的 IPv{version} xdb 文件，上传后立即启用；校验失败不会替换现有库。
          </span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".xdb,application/octet-stream"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void upload(version, file)
          }}
        />
      </div>
    </Panel>
  )

  const configured = !!(v4.path || v6.path)

  return (
    <Page>
      <PageHeader
        title="IP 地址库"
        sub="Web 规则与端口转发的国家、省份过滤依赖离线 xdb；IPv4 与 IPv6 各用一份库，互不影响。"
        actions={
          <Button variant="secondary" isDisabled={busy !== ''} onPress={() => void reload()}>
            {busy === 'reload' ? '重载中…' : '重新加载'}
          </Button>
        }
      />

      <div className="space-y-5">
        {loaded && !configured ? (
          <AlertBox status="warning" title="尚未配置地址库">
            国家/省份过滤目前不会生效。上传 IPv4 或 IPv6 的 xdb 文件后即可按地区限制访问。
          </AlertBox>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          {dbCard(4, v4, file4Ref)}
          {dbCard(6, v6, file6Ref)}
        </div>

        <Panel title="查询测试" description="用来确认地址库内容与过滤值是否对得上">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full sm:w-72">
                <TextInput
                  label="IP 地址"
                  value={testIP}
                  onChange={setTestIP}
                  placeholder="1.1.1.1 或 2400:3200::1"
                />
              </div>
              <Button
                variant="secondary"
                isDisabled={looking || (!v4.loaded && !v6.loaded)}
                onPress={() => void lookup()}
              >
                {looking ? '查询中…' : '查询'}
              </Button>
              {!v4.loaded && !v6.loaded ? <span className="text-xs text-muted">需要先上传地址库</span> : null}
            </div>

            {result ? (
              <div className="rounded-lg border border-border">
                <div className="mono border-b border-border px-4 py-2 text-sm">{testIP.trim()}</div>
                <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  {LOOKUP_FIELDS.map((field) => (
                    <div key={field.key}>
                      <div className="text-xs text-muted">{field.label}</div>
                      <div className="mt-0.5 text-sm">{result[field.key] || '-'}</div>
                    </div>
                  ))}
                </div>
                {result.raw ? (
                  <div className="mono border-t border-border px-4 py-2 text-xs text-muted">
                    原始记录：{result.raw}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs leading-6 text-muted">
              私有地址不参与地理匹配；省份按地址库返回结果匹配，配置时可写「浙江」或「浙江省」。
              查询只读本地文件，不会发起任何外部请求。
            </div>
          </div>
        </Panel>
      </div>
    </Page>
  )
}
