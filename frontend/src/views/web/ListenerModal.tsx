import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { api, errorText } from '../../api'
import {
  FormModal,
  SelectInput,
  SwitchInput,
  TagInput,
  TextAreaInput,
  TextInput,
  toast,
} from '../../ui'
import {
  CLIENT_AUTH_OPTIONS,
  TLS_OPTIONS,
  certOptions,
  normalizeClientAuth,
  normalizeTLSMode,
  type Certificate,
  type ClientAuthMode,
  type TLSMode,
  type WebListenerView,
} from './types'

interface ListenerForm {
  name: string
  listen: string[]
  tlsMode: TLSMode
  tlsCertId: string
  tlsHsts: boolean
  clientAuth: ClientAuthMode
  clientCa: string
  remark: string
}

function blankForm(): ListenerForm {
  return {
    name: '',
    listen: [],
    tlsMode: 'off',
    tlsCertId: '',
    tlsHsts: false,
    clientAuth: 'off',
    clientCa: '',
    remark: '',
  }
}

export default function ListenerModal({
  open,
  listener,
  certificates,
  onClose,
  onSaved,
}: {
  open: boolean
  listener: WebListenerView | null
  certificates: Certificate[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ListenerForm>(blankForm)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!listener) {
      setForm(blankForm())
      return
    }
    setForm({
      name: listener.name || '',
      listen: (Array.isArray(listener.listen) ? listener.listen : []).map((item) => String(item)),
      tlsMode: normalizeTLSMode(listener.tls?.mode),
      tlsCertId: listener.tls?.certId || '',
      tlsHsts: !!listener.tls?.hsts,
      clientAuth: normalizeClientAuth(listener.tls?.clientAuth),
      clientCa: listener.tls?.clientCa || '',
      remark: listener.remark || '',
    })
  }, [open, listener])

  const patch = (next: Partial<ListenerForm>) => setForm((prev) => ({ ...prev, ...next }))

  const save = async () => {
    const listen = form.listen.map((item) => String(item ?? '').trim()).filter(Boolean)
    if (!listen.length) {
      toast.warning('请至少填写一个监听地址，例如 :443')
      return
    }
    const mode = normalizeTLSMode(form.tlsMode)
    if (mode === 'custom' && !form.tlsCertId.trim()) {
      toast.warning('指定证书模式必须选择一个证书')
      return
    }
    const clientAuth: ClientAuthMode = mode === 'off' ? 'off' : normalizeClientAuth(form.clientAuth)
    if (clientAuth !== 'off' && !form.clientCa.trim()) {
      toast.warning('要求客户端证书时必须提供签发它的 CA 证书（PEM）')
      return
    }

    const payload = {
      name: form.name.trim(),
      listen,
      tls: {
        mode,
        certId: mode === 'custom' ? form.tlsCertId.trim() : '',
        hsts: mode !== 'off' && form.tlsHsts,
        clientAuth,
        clientCa: clientAuth === 'off' ? '' : form.clientCa.trim(),
      },
      remark: form.remark.trim(),
    }

    setSaving(true)
    try {
      if (listener) {
        await api.put(`/api/v1/web/listeners/${encodeURIComponent(listener.id)}`, payload)
      } else {
        await api.post('/api/v1/web/listeners', payload)
      }
      toast.success('保存成功')
      onClose()
      onSaved()
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={listener ? '编辑监听器' : '新建监听器'}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="tertiary" isDisabled={saving} onPress={onClose}>
            取消
          </Button>
          <Button variant="primary" isDisabled={saving} onPress={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
        <TextInput
          label="名称"
          value={form.name}
          onChange={(value) => patch({ name: value })}
          placeholder="例如 HTTPS 主站"
          hint="留空时后端会使用第一个监听地址作为名称"
        />
        <TextInput
          label="备注"
          value={form.remark}
          onChange={(value) => patch({ remark: value })}
          placeholder="可选"
        />
        <div className="md:col-span-2">
          <TagInput
            label="监听地址"
            value={form.listen}
            onChange={(value) => patch({ listen: value })}
            placeholder="输入后回车，例如 :443、[::]:443"
            hint="每行/每个标签一个地址，支持 :443、0.0.0.0:8080、[::]:443；同一地址不能属于两个监听器。"
          />
        </div>
        <SelectInput
          label="TLS 模式"
          value={form.tlsMode}
          onChange={(value) => patch({ tlsMode: normalizeTLSMode(value) })}
          options={TLS_OPTIONS}
          required
          hint="关闭 = 纯 HTTP；自动证书 = 按路由域名自动申请/续期；指定证书 = 该监听器下所有域名共用一张已上传证书。"
        />
        <SwitchInput
          label="HSTS"
          value={form.tlsHsts}
          onChange={(value) => patch({ tlsHsts: value })}
          disabled={form.tlsMode === 'off'}
          hint="仅 TLS 非关闭时可用，对 TLS 响应附加 Strict-Transport-Security"
        />
        <SelectInput
          label="客户端证书（mTLS）"
          value={form.tlsMode === 'off' ? 'off' : form.clientAuth}
          onChange={(value) => patch({ clientAuth: normalizeClientAuth(value) })}
          options={CLIENT_AUTH_OPTIONS}
          disabled={form.tlsMode === 'off'}
          hint="要求访问者出示由指定 CA 签发的证书，适合设备或脚本的双向认证"
        />
        {form.tlsMode !== 'off' && form.clientAuth !== 'off' ? (
          <div className="md:col-span-2">
            <TextAreaInput
              label="客户端 CA 证书（PEM）"
              value={form.clientCa}
              onChange={(value) => patch({ clientCa: value })}
              rows={5}
              required
              placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
              hint="可包含多张 CA；保存时会校验能否解析出至少一张证书，解析失败会被拒绝。"
            />
          </div>
        ) : null}
        {form.tlsMode === 'custom' ? (
          <div className="md:col-span-2">
            <SelectInput
              label="指定证书"
              value={form.tlsCertId}
              onChange={(value) => patch({ tlsCertId: value })}
              options={certOptions(certificates)}
              placeholder={certificates.length ? '选择已上传的证书' : '还没有可用证书，请先到「证书」页面申请或上传'}
              required
              hint="证书来自「证书」页面；指定证书模式下，该监听器下的所有域名都使用这张证书。"
            />
          </div>
        ) : null}
      </div>
    </FormModal>
  )
}
