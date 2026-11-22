import { reactive } from 'vue'
import { api, setCSRF } from './api'

export const auth = reactive({
  user: '',
  csrf: '',
  mustChangePassword: false,
  ready: false,
})

function apply(data) {
  auth.user = data?.username || ''
  auth.csrf = data?.csrf || ''
  auth.mustChangePassword = !!data?.mustChangePassword
  setCSRF(auth.csrf)
}

export async function bootstrap() {
  try {
    apply(await api.get('/api/v1/auth/session'))
  } catch {
    auth.user = ''
    setCSRF('')
  } finally {
    auth.ready = true
  }
}

export async function login(username, password) {
  const data = await api.post('/api/v1/auth/login', { username, password })
  apply(data)
  return data
}

export async function logout() {
  try {
    await api.post('/api/v1/auth/logout')
  } finally {
    auth.user = ''
    auth.mustChangePassword = false
    setCSRF('')
  }
}

export async function changePassword(current, next) {
  await api.post('/api/v1/auth/password', { current, new: next })
  auth.mustChangePassword = false
}
