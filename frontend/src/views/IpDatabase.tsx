import { useCallback, useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { api, errorText } from '../api'
import { fmtBytes, fmtTime } from '../format'
import {
  AlertBox,
  Page,
  PageHeader,
  Panel,
  SelectInput,
  StatusChip,
  TextInput,
  toast,
} from '../ui'

/* -------------------------------------------------------------------------
 * 地址库类型注册表
 *
 * 现在只有 ip2region 一种离线库，但页面不是围绕它写死的：类型、接口、
 * 保存字段、查询结果字段都由下面的描述符声明，渲染逻辑只认描述符。
 * 以后接入第二种库（例如另一个 xdb 变种或纯真库）时，加一条记录即可，
 * 下拉框会在 PROVIDERS 多于一项时自动出现。
 * ---------------------------------------------------------------------- */

interface DbStatus {
  path?: string
  loaded?: boolean
  ipVersion?: number
  size?: number
  createdAt?: string
  error?: string
}

interface LookupRecord {
  ip?: string
  country?: string
  region?: string
  province?: string
  provinceNormalized?: string
  city?: string
  isp?: string
  raw?: string
}

interface StatusResponse {
  status?: DbStatus
  provinces?: string[]
  source?: string
}

interface ProviderEndpoints {
  status: string
  save: string
  reload: string
  lookup: string
}

interface GeoProvider {
  id: string
  label: string
  format: string
  description: string
  pathHint: string
  endpoints: ProviderEndpoints
  /** 保存接口期望的 JSON 字段名（后端拒绝未知字段）。 */
  saveField: string
  lookupFields: { key: keyof LookupRecord; label: string }[]
}

const PROVIDERS: GeoProvider[] = [
  {
    id: 'ip2region',
    label: 'ip2region',
    format: 'xdb 离线库',
    description: '单文件、完全离线，按 IPv4 / IPv6 返回国家、省份、城市与运营商。',
    pathHint:
      'xdb 文件路径；留空表示不启用地理过滤。文件可从 github.com/lionsoul2014/ip2region 获取。',
    endpoints: {
      status: '/api/v1/system/ip2region',
      save: '/api/v1/system/ip2region',
      reload: '/api/v1/system/ip2region/reload',
      lookup: '/api/v1/system/ip2region/lookup',
    },
    saveField: 'path',
    lookupFields: [
      { key: 'country', label: '国家/地区' },
      { key: 'provinceNormalized', label: '省份（标准）' },
      { key: 'city', label: '城市' },
      { key: 'isp', label: '运营商' },
    ],
  },
]

interface ProviderState {
  path: string
  status: DbStatus
  /** 首次状态请求是否已经返回，用于区分「未加载」和「还没读到」。 */
  loaded: boolean
  saving: boolean
  reloading: boolean
  testIP: string
  result: LookupRecord | null
  looking: boolean
  provinceCount: number
  provinceSource: string
}

const EMPTY_STATE: ProviderState = {
  path: '',
  status: {},
  loaded: false,
  saving: false,
  reloading: false,
  testIP: '',
  result: null,
  looking: false,
  provinceCount: 0,
  provinceSource: 'builtin',
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export default function IpDatabase() {
  const [providerId, setProviderId] = useState(PROVIDERS[0].id)
  const provider = PROVIDERS.find((item) => item.id === providerId) ?? PROVIDERS[0]
  // 每种地址库各自保存一份编辑状态，切换类型时已输入的路径不会丢。
  const [states, setStates] = useState<Record<string, ProviderState>>({})
  const state = states[provider.id] ?? EMPTY_STATE

  const patch = useCallback(
    (next: Partial<ProviderState> | ((prev: ProviderState) => Partial<ProviderState>)) => {
      setStates((prev) => {
        const current = prev[provider.id] ?? EMPTY_STATE
        const changes = typeof next === 'function' ? next(current) : next
        return { ...prev, [provider.id]: { ...current, ...changes } }
      })
    },
    [provider.id],
  )

  const load = useCallback(async () => {
    try {
      const data = await api.get<StatusResponse>(provider.endpoints.status)
      const status = data?.status || {}
      patch((prev) => ({
        status,
        loaded: true,
        path: status.path ?? prev.path,
        provinceCount: data?.provinces?.length || 0,
        provinceSource: data?.source || 'builtin',
      }))
    } catch (err) {
      patch({ loaded: true })
      toast.danger(`读取地址库状态失败：${errorText(err)}`)
    }
  }, [patch, provider.endpoints.status])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    const path = state.path.trim()
    patch({ saving: true })
    try {
      const data = await api.put<StatusResponse>(provider.endpoints.save, {
        [provider.saveField]: path,
      })
      const status = data?.status || {}
      patch((prev) => ({
        status,
        path: status.path ?? path,
        provinceCount: data?.provinces?.length || prev.provinceCount,
        provinceSource: data?.source || prev.provinceSource,
      }))
      toast.success(path ? '地址库已加载' : '已停用地址库')
    } catch (err) {
      toast.danger(`保存失败：${errorText(err)}`)
    } finally {
      patch({ saving: false })
    }
  }

  const reload = async () => {
    patch({ reloading: true })
    try {
      const data = await api.post<StatusResponse>(provider.endpoints.reload)
      const status = data?.status || {}
      patch((prev) => ({
        status,
        provinceCount: data?.provinces?.length || prev.provinceCount,
        provinceSource: data?.source || prev.provinceSource,
      }))
      toast.success('地址库已重新加载')
    } catch (err) {
      toast.danger(`重新加载失败：${errorText(err)}`)
    } finally {
      patch({ reloading: false })
    }
  }

  const lookup = async () => {
    const ip = state.testIP.trim()
    if (!ip) {
      toast.warning('请输入要查询的 IP')
      return
    }
    patch({ looking: true })
    try {
      const result = await api.post<LookupRecord>(provider.endpoints.lookup, { ip })
      patch({ result: result || null })
    } catch (err) {
      patch({ result: null })
      toast.danger(`查询失败：${errorText(err)}`)
    } finally {
      patch({ looking: false })
    }
  }

  const configured = !!state.status.path
  const statusColor = state.status.loaded ? 'success' : configured ? 'danger' : 'default'
  const statusText = state.status.loaded ? '已加载' : configured ? '加载失败' : '未启用'

  return (
    <Page>
      <PageHeader
        title="IP 地址库"
        sub="Web 规则与端口转发的国家、省份过滤依赖这份离线地址库；不配置时省份使用内置列表，也不做地理匹配。"
        actions={
          <Button variant="secondary" isDisabled={state.saving || state.reloading} onPress={() => void load()}>
            刷新
          </Button>
        }
      />

      <div className="space-y-5">
        {!state.loaded ? null : !configured ? (
          <AlertBox status="warning" title="尚未配置地址库">
            国家/省份过滤目前不会生效。填入 xdb 文件路径并保存后，Web 规则与端口转发即可按地区限制访问。
          </AlertBox>
        ) : null}

        <Panel
          title="数据库"
          extra={<StatusChip color={statusColor}>{statusText}</StatusChip>}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">类型</span>
              {PROVIDERS.length > 1 ? (
                <div className="w-full sm:w-64">
                  <SelectInput
                    label="地址库类型"
                    value={provider.id}
                    onChange={setProviderId}
                    options={PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
                  />
                </div>
              ) : (
                <StatusChip color="primary">{provider.label}</StatusChip>
              )}
              <span className="text-xs text-muted">{provider.format}</span>
            </div>

            <div className="text-xs leading-6 text-muted">{provider.description}</div>

            <TextInput
              label="数据库路径"
              value={state.path}
              onChange={(value) => patch({ path: value })}
              placeholder="/data/ip2region.xdb"
              hint={provider.pathHint}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" isDisabled={state.saving} onPress={() => void save()}>
                {state.saving ? '保存中…' : '保存并加载'}
              </Button>
              <Button
                variant="secondary"
                isDisabled={state.reloading || !configured}
                onPress={() => void reload()}
              >
                {state.reloading ? '重新加载中…' : '重新加载'}
              </Button>
              {state.status.createdAt ? (
                <span className="text-xs text-muted">数据日期：{fmtTime(state.status.createdAt)}</span>
              ) : null}
              {state.status.size ? (
                <span className="text-xs text-muted">大小：{fmtBytes(state.status.size)}</span>
              ) : null}
              {state.status.ipVersion ? (
                <span className="text-xs text-muted">IPv{state.status.ipVersion}</span>
              ) : null}
              {state.provinceCount ? (
                <span className="text-xs text-muted">
                  省份：{state.provinceSource === 'database' ? '来自地址库' : '内置列表'}（{state.provinceCount} 个）
                </span>
              ) : null}
            </div>

            {state.status.error ? (
              <AlertBox status="danger" title="地址库状态异常">
                {state.status.error}
              </AlertBox>
            ) : null}

            <div className="text-xs leading-6 text-muted">
              修改路径后会先用新文件做一次加载校验，校验失败不会覆盖现有配置；替换了同名文件可以直接「重新加载」。
              以后新增其它离线地址库时，会以类型选择的形式出现在这里。
            </div>
          </div>
        </Panel>

        <Panel title="查询测试" description="用来确认地址库内容与过滤值是否对得上">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full sm:w-64">
                <TextInput
                  label="IP 地址"
                  value={state.testIP}
                  onChange={(value) => patch({ testIP: value })}
                  placeholder="1.1.1.1"
                />
              </div>
              <Button
                variant="secondary"
                isDisabled={state.looking || !state.status.loaded}
                onPress={() => void lookup()}
              >
                {state.looking ? '查询中…' : '查询'}
              </Button>
              {!state.status.loaded ? (
                <span className="text-xs text-muted">需要先加载地址库</span>
              ) : null}
            </div>

            {state.result ? (
              <div className="rounded-lg border border-border">
                <div className="mono border-b border-border px-4 py-2 text-sm">{state.result.ip || state.testIP}</div>
                <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  {provider.lookupFields.map((field) => (
                    <div key={field.key}>
                      <div className="text-xs text-muted">{field.label}</div>
                      <div className="mt-0.5 text-sm">{state.result?.[field.key] || '-'}</div>
                    </div>
                  ))}
                </div>
                {state.result.raw ? (
                  <div className="mono border-t border-border px-4 py-2 text-xs text-muted">
                    原始记录：{state.result.raw}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs leading-6 text-muted">
              省份按地址库返回结果匹配，配置时可写「浙江」或「浙江省」；私有地址与 IPv6 不参与地理匹配。
              查询只读本地文件，不会发起任何外部请求。
            </div>
          </div>
        </Panel>
      </div>
    </Page>
  )
}
