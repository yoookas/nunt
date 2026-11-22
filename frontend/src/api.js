// Thin wrapper around the admin REST API: JSON in, JSON out, CSRF header on
// every write, and a single error type the pages can show.
let csrfToken = ''

export function setCSRF(token) {
  csrfToken = token || ''
}

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function buildQuery(params) {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const out = search.toString()
  return out ? `?${out}` : ''
}

async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrfToken && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken

  let response
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: options.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError('无法连接服务器，请检查网络或服务状态', 'network', 0)
  }

  if (response.status === 204) return null

  const text = await response.text()
  let data = null
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
  return data
}

export const api = {
  get: (path, params, options) => request('GET', path + buildQuery(params), undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  del: (path, options) => request('DELETE', path, undefined, options),
}

// errorText turns anything thrown by the client into a readable message.
export function errorText(err) {
  if (!err) return '未知错误'
  return err.message || String(err)
}
