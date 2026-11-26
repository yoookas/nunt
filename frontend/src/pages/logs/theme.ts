import { theme } from 'antd'
import { useMemo, type CSSProperties } from 'react'

/**
 * Theme tokens exposed as CSS custom properties. The page root sets them, so
 * every row/table rule can stay in the CSS module while still supporting the
 * light and dark antd algorithms. Modals and drawers render in a portal, so
 * they set the same properties on their own wrapper.
 */
export function useLogThemeVars(): CSSProperties {
  const { token } = theme.useToken()
  return useMemo(
    () =>
      ({
        '--logs-bg': token.colorBgContainer,
        '--logs-border': token.colorBorderSecondary,
        '--logs-head-tint': token.colorFillAlter,
        '--logs-hover': token.colorFillQuaternary,
        '--logs-text': token.colorText,
        '--logs-text-secondary': token.colorTextSecondary,
        '--logs-primary': token.colorPrimary,
        '--logs-warn-text': token.colorWarningText,
        '--logs-warn-bg': token.colorWarningBg,
        '--logs-error-text': token.colorErrorText,
        '--logs-error-bg': token.colorErrorBg,
        '--logs-radius': `${token.borderRadius}px`,
      }) as CSSProperties,
    [token],
  )
}
