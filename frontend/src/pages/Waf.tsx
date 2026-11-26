import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Alert, App, Card, Collapse, Form, Grid, Space, Typography, theme, type CollapseProps } from 'antd'
import { BugOutlined, FileSearchOutlined, SafetyCertificateOutlined, SettingOutlined } from '@ant-design/icons'
import { api, errorText } from '../api'
import { Muted, useIsMobile } from '../components'
import StatusHero from './waf/StatusHero'
import ConfigSection from './waf/ConfigSection'
import RulesSection from './waf/RulesSection'
import EventsSection from './waf/EventsSection'
import TestSection from './waf/TestSection'
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

function SectionTitle({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  const { token } = theme.useToken()
  return (
    <Space size={6}>
      <span style={{ color: token.colorPrimary, display: 'inline-flex' }}>{icon}</span>
      <Typography.Text strong>{title}</Typography.Text>
      {hint ? <Muted>{hint}</Muted> : null}
    </Space>
  )
}

export default function Waf() {
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = useIsMobile()
  const wide = !!screens.lg
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
  const [openKeys, setOpenKeys] = useState<string[]>(['config'])

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

  const handleEventsChange = useCallback((count: number) => {
    setStats((prev) => (prev.events === count ? prev : { ...prev, events: count }))
  }, [])

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

  const engineError = engine?.error || stats.buildError || ''

  const configExtra = engine?.error ? '编译失败' : engine?.enabled ? '运行中' : '未运行'

  const sections = [
    {
      key: 'config',
      label: <SectionTitle icon={<SettingOutlined />} title="引擎配置" />,
      extra: <Muted>{configExtra}</Muted>,
      forceRender: true,
      children: <ConfigSection useCrs={useCrs} saving={saving} onSave={() => void saveConfig()} />,
    },
    {
      key: 'rules',
      label: <SectionTitle icon={<SafetyCertificateOutlined />} title="规则与策略" />,
      extra: <Muted>{rules.length} 个文件</Muted>,
      forceRender: true,
      children: (
        <RulesSection
          rules={rules}
          loading={rulesLoading}
          useCrs={useCrs}
          disabledRules={disabledRules}
          saving={saving}
          onRefresh={() => void loadRules()}
          onSave={() => void saveConfig()}
          onDisabledRulesChange={(next) => form.setFieldValue('disabledRules', next)}
        />
      ),
    },
    {
      key: 'events',
      label: <SectionTitle icon={<FileSearchOutlined />} title="拦截事件" />,
      extra: <Muted>{stats.events ?? 0} 条</Muted>,
      forceRender: true,
      children: (
        <EventsSection
          active={!isMobile || openKeys.includes('events')}
          onEventsChange={handleEventsChange}
        />
      ),
    },
    {
      key: 'test',
      label: <SectionTitle icon={<BugOutlined />} title="在线测试" />,
      forceRender: true,
      children: <TestSection />,
    },
  ] satisfies CollapseProps['items']

  const configCard = (
    <Card
      size="small"
      title={<SectionTitle icon={<SettingOutlined />} title="引擎配置" />}
      extra={<Muted>{configExtra}</Muted>}
    >
      <ConfigSection useCrs={useCrs} saving={saving} onSave={() => void saveConfig()} />
    </Card>
  )

  const testCard = (
    <Card size="small" title={<SectionTitle icon={<BugOutlined />} title="在线测试" />} extra={<Muted>不发出真实请求</Muted>}>
      <TestSection />
    </Card>
  )

  const rulesCard = (
    <Card
      size="small"
      title={<SectionTitle icon={<SafetyCertificateOutlined />} title="规则与策略" />}
      extra={<Muted>{rules.length} 个文件</Muted>}
    >
      <RulesSection
        rules={rules}
        loading={rulesLoading}
        useCrs={useCrs}
        disabledRules={disabledRules}
        saving={saving}
        onRefresh={() => void loadRules()}
        onSave={() => void saveConfig()}
        onDisabledRulesChange={(next) => form.setFieldValue('disabledRules', next)}
      />
    </Card>
  )

  const eventsCard = (
    <Card size="small" title={<SectionTitle icon={<FileSearchOutlined />} title="拦截事件" />} extra={<Muted>{stats.events ?? 0} 条</Muted>}>
      <EventsSection active onEventsChange={handleEventsChange} />
    </Card>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatusHero
        engine={engine}
        stats={stats}
        config={config}
        crsVersion={crsVersion}
        loading={loading}
        saving={saving}
        reloading={reloading}
        onRefresh={() => void refresh()}
        onReload={() => void reloadEngine()}
        onSave={() => void saveConfig()}
      />

      {engineError ? (
        <Alert type="error" showIcon message="规则集编译失败" description={engineError} />
      ) : null}

      <Form form={form} component={false} layout="vertical" initialValues={EMPTY_WAF_FORM}>
        {isMobile ? (
          <Collapse
            size="small"
            activeKey={openKeys}
            onChange={(keys) => setOpenKeys(keys)}
            items={sections}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: wide ? 'minmax(0, 1.35fr) minmax(0, 1fr)' : '1fr',
                gap: 12,
                alignItems: 'start',
              }}
            >
              {configCard}
              {testCard}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: wide ? 'minmax(0, 1.35fr) minmax(0, 1fr)' : '1fr',
                gap: 12,
                alignItems: 'start',
              }}
            >
              {rulesCard}
              {eventsCard}
            </div>
          </div>
        )}
      </Form>
    </div>
  )
}
