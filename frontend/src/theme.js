import { reactive } from 'vue'

const STORAGE_KEY = 'nunt.theme'

export const theme = reactive({ dark: true })

export function applyTheme() {
  document.body.setAttribute('arco-theme', theme.dark ? 'dark' : 'light')
  document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light'
}

export function setTheme(dark) {
  theme.dark = !!dark
  localStorage.setItem(STORAGE_KEY, theme.dark ? 'dark' : 'light')
  applyTheme()
}

export function setupTheme() {
  const saved = localStorage.getItem(STORAGE_KEY)
  theme.dark = saved ? saved === 'dark' : true
  applyTheme()
}
