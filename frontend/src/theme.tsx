import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'nunt.theme'
const MEDIA = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  /** What the user picked, including "follow the system". */
  theme: ThemeMode
  /** What is actually painted right now. */
  resolved: ResolvedTheme
  setTheme: (theme: ThemeMode) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MEDIA).matches
    : false
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
}

function apply(theme: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // "system" is the default so a fresh browser follows the OS out of the box.
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  })
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(theme))

  useEffect(() => {
    const next = resolve(theme)
    setResolved(next)
    apply(next)
    localStorage.setItem(STORAGE_KEY, theme)
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    // Follow the OS live: switching the system theme repaints without a reload.
    const media = window.matchMedia(MEDIA)
    const onChange = () => {
      const value: ResolvedTheme = media.matches ? 'dark' : 'light'
      setResolved(value)
      apply(value)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: ThemeMode) => setThemeState(next), [])
  const toggle = useCallback(
    () => setThemeState((prev) => (resolve(prev) === 'dark' ? 'light' : 'dark')),
    [],
  )
  const value = useMemo(
    () => ({ theme, resolved, setTheme, toggle }),
    [theme, resolved, setTheme, toggle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
