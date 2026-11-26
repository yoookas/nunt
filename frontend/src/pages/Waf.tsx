import { useCallback, useEffect, useState } from 'react'
import { App, Button, Form, Tabs, Tag, type TabsProps } from 'antd'
import { ReloadOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons'
import { api, errorText } from '../api'
import { Muted, PageHeader } from '../components'
import ConfigPanel from './waf/ConfigPanel'
import RulesPanel from './waf/RulesPanel'
import TestPanel from './waf/TestPanel'
import LogsPanel from './waf/LogsPanel'
import {
  EMPTY_WAF_FORM,
  clampLevel,
  nonNegativeInt,
  normalizeDisabledRules,
  positiveInt,
  toWafForm,
  type WafConfig,
  type WafConfigResponse,
  type WafEngine,
  type WafForm,
  type WafRuleFile,
  type WafRulesResponse,
  type WafStats,
} from './waf/types'

export default function Waf() {
  const { message } = App.useApp()
  const [form] = Form.useForm<WafForm>()

  const [config, setConfig] = useState<WafConfig | null>(null)
  const [engine, setEngine] = useState<WafEngine | null>(null)
  const [stats, setStats] = useState<WafStats>({})
  const [rules, setRules] = useState<WafRuleFile[]>([])
  const [crsVersion, setCrsVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [tab, setTab] = useState('config')

  const watchedUseCrs = Form.useWatch('useCrs', form)
  const watchedDisabledRules = Form.useWatch('disabledRules', form)
  const useCrs = watchedUseCrs === undefined ? config?.useCrs ?? true : watchedUseCrs
  const disabledRules = Array.isArray(watchedDisabledRules)
    ? watchedDisabledRules
    : config?.disabledRules ?? []

  const loadConfig = useCallback(
    async (notify = true) => {
      setLoading(true)
      try {
        const data = await api.get<WafConfigResponse>('/api/v1/waf/config')
        const next = data?.config ?? null
        setConfig(next)
        setEngine(data?.engine ?? null)
        setStats(data?.stats ?? {})
        if (next) form.setFieldsValue(toWafForm(next))
      } catch (err) {
        if (notify) message.error(errorText(err))
      } finally {
        setLoading(false)
      }
    },
    [form, message],
  )

  const loadRules = useCallback(
    async (notify = true) => {
      setRulesLoading(true)
      try {
        const data = await api.get<WafRulesResponse>('/api/v1/waf/rules')
        setRules(Array.isArray(data?.items) ? data.items : [])
        setCrsVersion(data?.crsVersion || '')
      } catch (err) {
        if (notify) message.error(errorText(err))
      } finally {
        setRulesLoading(false)
      }
    },
    [message],
  )

  useEffect(() => {
    void loadConfig()
    void loadRules()
  }, [loadConfig, loadRules])

  const refresh = async () => {
    await Promise.all([loadConfig(), loadRules()])
  }

  const saveConfig = async () => {
    if (!config) {
      message.warning('配置尚未加载完成')
      return
    }

    let values: WafForm
    try {
      await form.validateFields()
      values = form.getFieldsValue(true)
    } catch (err) {
      const fields = (err as { errorFields?: { errors?: string[] }[] })?.errorFields
      message.warning(fields?.[0]?.errors?.[0] || '请检查配置项中的必填内容')
      return
    }

    if (Number(values.executingLevel) < Number(values.paranoiaLevel)) {
      message.warning('执行等级不能低于 Paranoia Level')
      return
    }

    const payload: WafConfig = {
      ...config,
      enable: !!values.enable,
      mode: values.mode,
      logOnly: !!values.logOnly,
      useCrs: !!values.useCrs,
      paranoiaLevel: clampLevel(values.paranoiaLevel, 1),
      executingLevel: clampLevel(values.executingLevel, values.paranoiaLevel),
      inboundThreshold: positiveInt(values.inboundThreshold, 5),
      outboundThreshold: positiveInt(values.outboundThreshold, 4),
      bodyLimitKb: nonNegativeInt(values.bodyLimitKb),
      adminProtect: !!values.adminProtect,
      disabledRules: normalizeDisabledRules(values.disabledRules),
      extraRules: values.extraRules || '',
      ruleFiles: Array.isArray(config.ruleFiles) ? config.ruleFiles : [],
    }

    setSaving(true)
    try {
      const data = await api.put<WafConfigResponse>('/api/v1/waf/config', payload)
      const next = data?.config ?? payload
      setConfig(next)
      setEngine(data?.engine ?? null)
      setStats(data?.stats ?? {})
      form.setFieldsValue(toWafForm(next))
      message.success('WAF 配置已保存并重新编译')
      await loadRules(false)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const reloadEngine = async () => {
    setReloading(true)
    try {
      const data = await api.post<{ status?: string; engine?: WafEngine }>('/api/v1/waf/reload')
      if (data?.engine) setEngine(data.engine)
      message.success('规则集已重新编译')
      await loadRules(false)
    } catch (err) {
      message.error(errorText(err))
    } finally {
      setReloading(false)
    }
  }

  const handleEventsChange = useCallback((count: number) => {
    setStats((prev) => (prev.events === count ? prev : { ...prev, events: count }))
  }, [])

  const statusLabel = engine?.error
    ? '编译失败'
    : engine
      ? engine.enabled
        ? '运行中'
        : '未运行'
      : loading
        ? '加载中'
        : '未知'
  const statusColor = engine?.error ? 'red' : engine?.enabled ? 'green' : 'default'
  const mode = engine?.mode || config?.mode
  const modeLabel = mode === 'detect' ? '检测' : mode === 'block' ? '拦截' : '-'
  const ruleCount = engine?.rules ?? stats.rules
  const fileCount = engine?.ruleFiles ?? stats.ruleFiles

  const tabs: TabsProps['items'] = [
    {
      key: 'config',
      label: '配置',
      forceRender: true,
      children: <ConfigPanel engine={engine} stats={stats} loading={loading} useCrs={useCrs} />,
    },
    {
      key: 'rules',
      label: '规则',
      forceRender: true,
      children: (
        <RulesPanel
          rules={rules}
          loading={rulesLoading}
          useCrs={useCrs}
          disabledRules={disabledRules}
          onRefresh={() => void loadRules()}
          onDisabledRulesChange={(next) => form.setFieldValue('disabledRules', next)}
        />
      ),
    },
    {
      key: 'test',
      label: '测试',
      children: <TestPanel />,
    },
    {
      key: 'logs',
      label: '拦截事件',
      children: (
        <LogsPanel active={tab === 'logs'} onEventsChange={handleEventsChange} />
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="WAF"
        subtitle={`嵌入式 Coraza 引擎 · ${modeLabel}模式 · 规则 ${ruleCount ?? '-'} 条 / 文件 ${
          fileCount ?? '-'
        } 个`}
        extra={
          <>
            <Tag color={statusColor}>{statusLabel}</Tag>
            {crsVersion ? <Muted>CRS {crsVersion}</Muted> : null}
            <Button
              icon={<SyncOutlined />}
              loading={loading || rulesLoading}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button icon={<ReloadOutlined />} loading={reloading} onClick={() => void reloadEngine()}>
              重载引擎
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!config || loading}
              onClick={() => void saveConfig()}
            >
              保存配置
            </Button>
          </>
        }
      />

      <Form form={form} component={false} layout="vertical" initialValues={EMPTY_WAF_FORM}>
        <Tabs activeKey={tab} onChange={setTab} items={tabs} />
      </Form>
    </div>
  )
}
