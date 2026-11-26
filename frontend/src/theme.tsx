import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeValue {
  mode: ThemeMode
  effective: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)
const STORAGE_KEY = 'nunt.theme.mode'

function savedMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(savedMode)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])

  const effective: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
    document.documentElement.dataset.theme = effective
  }, [mode, effective])

  const value = useMemo<ThemeValue>(() => ({ mode, effective, setMode }), [mode, effective])

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: effective === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: '#2f54eb',
            colorInfo: '#2f54eb',
            borderRadius: 10,
            colorBgLayout: effective === 'dark' ? '#0f1115' : '#f6f7f9',
            colorBorderSecondary: effective === 'dark' ? '#232733' : '#e8eaef',
            fontSize: 14,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          },
          components: {
            Layout: { headerBg: effective === 'dark' ? '#14161b' : '#ffffff' },
            Menu: { itemBorderRadius: 8 },
            Card: { borderRadiusLG: 12 },
            Table: { headerBg: effective === 'dark' ? '#1a1d24' : '#fafbfc' },
          },
        }}
      >
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
