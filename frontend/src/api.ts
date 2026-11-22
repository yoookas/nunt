// Thin wrapper around the admin REST API: JSON in, JSON out, CSRF header on
// every write, and a single error type the pages can show.
let csrfToken = ''

export function setCSRF(token: string): void {
  csrfToken = token || ''
}

export class ApiError extends Error {
  code: string
  status: number

  constructor(message: string, code = '', status = 0) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

interface RequestOptions {
  signal?: AbortSignal
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const out = search.toString()
  return out ? `?${out}` : ''
}

async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrfToken && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: options.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError('无法连接服务器，请检查网络或服务状态', 'network', 0)
  }

  if (response.status === 204) return null as T

  const text = await response.text()
  let data: any = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || response.statusText || `HTTP ${response.status}`
    const error = new ApiError(message, data?.error?.code || '', response.status)
    if (response.status === 401) window.dispatchEvent(new CustomEvent('nunt:unauthorized'))
    throw error
  }
  return data as T
}

export const api = {
  get: <T = any>(path: string, params?: Record<string, unknown>, options?: RequestOptions) =>
    request<T>('GET', path + buildQuery(params), undefined, options),
  post: <T = any>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body ?? {}, options),
  put: <T = any>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body ?? {}, options),
  del: <T = any>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
}

export function errorText(err: unknown): string {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return (err as Error)?.message || String(err)
}
