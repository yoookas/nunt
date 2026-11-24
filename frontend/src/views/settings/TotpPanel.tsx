import { copyText } from '../../clipboard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import qrcode from 'qrcode-generator'
import { api, errorText } from '../../api'
import { AlertBox, Panel, StatusChip, TextInput, toast } from '../../ui'

// QRCode draws the otpauth URI locally. Nothing leaves the browser: the canvas
// is painted from the module matrix, so there is no image request at all.
function QRCode({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !text) return
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()

    const count = qr.getModuleCount()
    const scale = 4
    const margin = 2
    const size = (count + margin * 2) * scale
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#000000'
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale)
        }
      }
    }
  }, [text])

  return <canvas ref={ref} className="rounded-lg border border-border bg-white" aria-label="双因子绑定二维码" />
}

type Flow = '' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'

const copy = async (text: string, label: string) => {
  if (copyText(text)) {
    toast.success(`${label}已复制`)
  } else {
    toast.danger('复制失败，请手动选择文本')
  }
}

export default function TotpPanel() {
  const [enabled, setEnabled] = useState(false)
  const [left, setLeft] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<Flow>('')
  const [password, setPassword] = useState('')
  const [secret, setSecret] = useState('')
  const [uri, setURI] = useState('')
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const session = await api.get<any>('/api/v1/auth/session')
      setEnabled(!!session?.totpEnabled)
      setLeft(Number(session?.recoveryCodesLeft) || 0)
    } catch (err) {
      toast.danger(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const reset = () => {
    setFlow('')
    setPassword('')
    setSecret('')
    setURI('')
    setCode('')
    setCodes([])
    setError('')
  }

  const setup = async () => {
    if (!password) {
      setError('请输入当前密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/v1/auth/totp/setup', { password })
      setSecret(String(result?.secret || ''))
      setURI(String(result?.uri || ''))
      setFlow('scan')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!code.trim()) {
      setError('请输入验证器显示 6 位验证码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/v1/auth/totp/confirm', { code: code.trim() })
      setCodes(Array.isArray(result?.recoveryCodes) ? result.recoveryCodes : [])
      setFlow('codes')
      await load()
    } catch (err) {
      setError(errorText(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError('')
    try {
      await api.post('/api/v1/auth/totp/disable', { password, code: code.trim() })
      toast.success('双因子已关闭')
      reset()
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/v1/auth/totp/recovery', { password, code: code.trim() })
      setCodes(Array.isArray(result?.recoveryCodes) ? result.recoveryCodes : [])
      setFlow('codes')
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const statusChip = loading ? (
    <StatusChip>读取中…</StatusChip>
  ) : enabled ? (
    <StatusChip color="success">已启用</StatusChip>
  ) : (
    <StatusChip>未启用</StatusChip>
  )

  return (
    <Panel
      title="双因子认证（TOTP）"
      description="密码之外再要一个验证器生成的 6 位码；启用后请把恢复码保存在离线位置"
      extra={statusChip}
    >
      <div className="space-y-4 p-4">
        {error ? <AlertBox status="danger">{error}</AlertBox> : null}

        {flow === '' ? (
          enabled ? (
            <div className="space-y-4">
              <div className="text-sm text-muted">
                验证器：<span className="text-foreground">已绑定</span>，剩余恢复码{' '}
                <span className="text-foreground">{left}</span> 枚。
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onPress={() => setFlow('regen')}>
                  重新生成恢复码
                </Button>
                <Button variant="danger-soft" onPress={() => setFlow('disable')}>
                  关闭双因子
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-sm leading-6 text-muted">
                启用后登录需要两个步骤，适合管理后台暴露在公网或只经反代访问的场景。
                二维码在本机生成，不会请求任何外部服务。
              </div>
              <Button variant="primary" onPress={() => setFlow('password')}>
                启用双因子
              </Button>
            </div>
          )
        ) : null}

        {flow === 'password' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void setup()
            }}
          >
            <TextInput label="当前密码" type="password" value={password} onChange={setPassword} required />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" isDisabled={busy}>
                {busy ? '生成中…' : '下一步'}
              </Button>
              <Button variant="tertiary" onPress={reset}>
                取消
              </Button>
            </div>
          </form>
        ) : null}

        {flow === 'scan' ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <QRCode text={uri} />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="text-sm leading-6 text-muted">
                  用验证器（1Password、Authy、Google Authenticator 等）扫描二维码，或手动输入下面的密钥。
                  二维码与密钥只在本页显示。
                </div>
                <div className="rounded-lg border border-border bg-surface p-2">
                  <div className="mono break-all text-xs">{secret}</div>
                </div>
                <Button variant="secondary" size="sm" onPress={() => void copy(secret, '密钥')}>
                  复制密钥
                </Button>
              </div>
            </div>
            <TextInput
              label="验证码"
              value={code}
              onChange={setCode}
              placeholder="输入验证器显示的 6 位码"
              required
            />
            <div className="flex gap-2">
              <Button variant="primary" isDisabled={busy} onPress={() => void confirm()}>
                {busy ? '校验中…' : '确认启用'}
              </Button>
              <Button variant="tertiary" onPress={reset}>
                取消
              </Button>
            </div>
          </div>
        ) : null}

        {flow === 'codes' ? (
          <div className="space-y-4">
            <AlertBox status="warning" title="恢复码只显示这一次">
              每枚恢复码只能用一次。请现在保存到离线位置（密码管理器或打印），设备丢失时用它登录。
            </AlertBox>
            <div className="mono grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
              {codes.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onPress={() => void copy(codes.join('\n'), '恢复码')}>
                复制全部
              </Button>
              <Button variant="primary" onPress={reset}>
                我已保存
              </Button>
            </div>
          </div>
        ) : null}

        {flow === 'disable' || flow === 'regen' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void (flow === 'disable' ? disable() : regenerate())
            }}
          >
            <div className="text-sm text-muted">
              {flow === 'disable'
                ? '关闭双因子需要密码 + 当前验证码（或用一枚恢复码）。'
                : '重新生成会立即作废全部旧恢复码。请输入密码 + 当前验证码（或用一枚恢复码）。'}
            </div>
            <TextInput label="当前密码" type="password" value={password} onChange={setPassword} required />
            <TextInput
              label="验证码 / 恢复码"
              value={code}
              onChange={setCode}
              placeholder="000000 或 xxxxx-xxxxx"
              required
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant={flow === 'disable' ? 'danger-soft' : 'primary'}
                isDisabled={busy}
              >
                {busy ? '处理中…' : flow === 'disable' ? '关闭双因子' : '重新生成'}
              </Button>
              <Button variant="tertiary" onPress={reset}>
                取消
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Panel>
  )
}
