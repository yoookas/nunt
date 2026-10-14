// nunt 管理后台 API 客户端。
//
// 约定：
//   * 所有请求同源，携带 cookie（credentials: 'same-origin'）。
//   * 写操作（POST/PUT/PATCH/DELETE）自动附加 X-CSRF-Token。
//   * 失败统一抛出 Error，message 为后端 {error:{message}} 中的信息（当前后端为英文，
//     前端兜底为中文）；err.status / err.code 保留原始状态与错误码供页面判断。

const CSRF_HEADER = 'X-CSRF-Token';

let csrfToken = '';
let unauthorizedHandler = null;

/** setCsrf 保存登录/会话接口返回的 CSRF 令牌（仅存内存）。 */
export function setCsrf(token) {
  csrfToken = typeof token === 'string' ? token : '';
}

/** getCsrf 返回当前内存中的 CSRF 令牌。 */
export function getCsrf() {
  return csrfToken;
}

/** onUnauthorized 注册会话失效回调（401 时触发，用于回到登录页）。 */
export function onUnauthorized(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

function buildURL(path, params) {
  let url = String(path || '');
  if (url.startsWith('api/')) url = '/' + url;
  if (params && typeof params === 'object') {
    const search = new URLSearchParams();
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) search.append(key, String(item));
      } else {
        search.append(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

async function toError(res) {
  let message = '';
  let code = '';
  try {
    const text = await res.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object') {
          if (data.error && typeof data.error === 'object') {
            message = String(data.error.message || '');
            code = String(data.error.code || '');
          } else if (typeof data.message === 'string') {
            message = data.message;
          }
        }
      } catch (err) {
        message = text.slice(0, 300);
      }
    }
  } catch (err) {
    /* 读取失败时退回状态码文案 */
  }
  if (!message) {
    if (res.status === 401) message = '登录状态已失效，请重新登录';
    else if (res.status === 403) message = '没有权限执行该操作';
    else if (res.status === 404) message = '请求的接口不存在';
    else if (res.status === 429) message = '操作过于频繁，请稍后再试';
    else if (res.status >= 500) message = '服务器内部错误（' + res.status + '）';
    else message = '请求失败（HTTP ' + res.status + '）';
  }
  const error = new Error(message);
  error.status = res.status;
  error.code = code;
  return error;
}

async function parseBody(res) {
  if (res.status === 204 || res.status === 205) return null;
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return text;
    }
  }
  return text;
}

async function request(method, path, { params, body, headers, signal } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    cache: 'no-store',
  };
  if (signal) init.signal = signal;
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    init.headers[CSRF_HEADER] = csrfToken;
  }

  let res;
  try {
    res = await fetch(buildURL(path, params), init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    const error = new Error('无法连接到服务器，请检查网络或服务状态');
    error.status = 0;
    error.cause = err;
    throw error;
  }

  if (!res.ok) {
    const error = await toError(res);
    const isAuthPath = String(path || '').includes('/auth/');
    if (res.status === 401 && !isAuthPath && typeof unauthorizedHandler === 'function') {
      unauthorizedHandler(error);
    }
    throw error;
  }
  return parseBody(res);
}

/** api 是页面共用的请求对象。 */
export const api = {
  request,
  get(path, params) {
    return request('GET', path, { params });
  },
  post(path, body, params) {
    return request('POST', path, { body: body === undefined ? {} : body, params });
  },
  put(path, body, params) {
    return request('PUT', path, { body: body === undefined ? {} : body, params });
  },
  del(path, params) {
    return request('DELETE', path, { params });
  },
  /**
   * upload 以 multipart/form-data 上传，onProgress(percent, loaded, total)。
   */
  upload(path, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildURL(path));
      xhr.withCredentials = true;
      xhr.responseType = 'text';
      xhr.setRequestHeader('Accept', 'application/json');
      if (csrfToken) xhr.setRequestHeader(CSRF_HEADER, csrfToken);
      if (typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (event) => {
          const total = event.lengthComputable ? event.total : 0;
          const percent = total > 0 ? Math.round((event.loaded / total) * 100) : 0;
          onProgress(percent, event.loaded, total);
        });
      }
      xhr.addEventListener('error', () => {
        const error = new Error('上传失败：无法连接到服务器');
        error.status = 0;
        reject(error);
      });
      xhr.addEventListener('abort', () => {
        const error = new Error('上传已取消');
        error.status = 0;
        reject(error);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let data = xhr.responseText;
          if (data) {
            try { data = JSON.parse(data); } catch (err) { /* 保留文本 */ }
          } else {
            data = null;
          }
          resolve(data);
          return;
        }
        let message = '';
        let code = '';
        try {
          const parsed = JSON.parse(xhr.responseText || '{}');
          if (parsed && parsed.error) {
            message = String(parsed.error.message || '');
            code = String(parsed.error.code || '');
          }
        } catch (err) { /* 忽略 */ }
        if (!message) message = '上传失败（HTTP ' + xhr.status + '）';
        const error = new Error(message);
        error.status = xhr.status;
        error.code = code;
        if (xhr.status === 401 && typeof unauthorizedHandler === 'function') unauthorizedHandler(error);
        reject(error);
      });
      xhr.send(formData);
    });
  },
};

export default api;
