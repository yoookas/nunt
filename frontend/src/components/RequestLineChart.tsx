import { theme, Typography } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useMemo } from 'react'
import Grid from '../charts/grid'
import { Line, LineChart } from '../charts/line-chart'
import ChartTooltip from '../charts/tooltip/chart-tooltip'
import XAxis from '../charts/x-axis'
import { YAxis } from '../charts/y-axis'

/** One bucket of /api/v1/logs/access/series. */
export interface RequestPoint {
  time: string
  total?: number
  denied?: number
  blocked?: number
}

interface Series {
  key: string
  label: string
  color: string
  /** Draw the line with dashes to keep it visually below the totals. */
  dashed?: boolean
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const count = (value: number): string => value.toLocaleString('zh-CN')

/** Bucket label in the tooltip: "11/27 16:00". */
function shortStamp(value: unknown): string {
  const date = new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
}

/**
 * RequestLineChart draws one bucket series per line: the total, the requests an
 * access rule refused and the ones the WAF intercepted. The chart is the vendored
 * bklit line chart, themed from the antd tokens so it matches the surrounding
 * cards in light and dark mode.
 */
export default function RequestLineChart({
  points,
  color,
  height = 180,
  empty,
}: {
  points: RequestPoint[]
  /** Colour of the totals line; the two refusal lines keep their own colours. */
  color: string
  height?: number
  empty: ReactNode
}) {
  const { token } = theme.useToken()

  const data = useMemo(
    () =>
      points.map((point) => ({
        time: point.time,
        total: num(point.total),
        denied: num(point.denied),
        blocked: num(point.blocked),
      })),
    [points],
  )

  const refusals = useMemo<Series[]>(() => {
    const all: Series[] = [
      { key: 'denied', label: '访问规则拦截', color: token.colorWarning, dashed: true },
      { key: 'blocked', label: 'WAF 拦截', color: token.colorError, dashed: true },
    ]
    return all.filter((item) => data.some((row) => num(row[item.key as 'total']) > 0))
  }, [data, token.colorWarning, token.colorError])

  const series = useMemo<Series[]>(() => {
    // A line that stays on zero for the whole window only adds a flat stroke on
    // the axis; the forward table never has a WAF interception, for one.
    return [{ key: 'total', label: '总请求', color }, ...refusals]
  }, [color, refusals])

  // The dual axis keeps the refusal timing readable; the legend carries the
  // magnitude, which the two scales would otherwise hide.
  const totals = useMemo(() => {
    const sum: Record<string, number> = {}
    for (const item of ['total', 'denied', 'blocked']) {
      sum[item] = data.reduce((acc, row) => acc + num(row[item as 'total']), 0)
    }
    return sum
  }, [data])

  // The vendored charts read their palette from CSS variables on an ancestor,
  // which keeps them independent from antd's own tokens.
  const vars = {
    '--background': token.colorBgContainer,
    '--foreground': token.colorText,
    '--muted-foreground': token.colorTextTertiary,
    '--border': token.colorBorderSecondary,
    '--radius-xl': `${token.borderRadiusLG}px`,
    '--chart-background': token.colorBgContainer,
    '--chart-foreground': token.colorText,
    '--chart-foreground-muted': token.colorTextTertiary,
    '--chart-label': token.colorTextTertiary,
    '--chart-grid': token.colorBorderSecondary,
    '--chart-crosshair': token.colorTextQuaternary,
    '--chart-marker-background': token.colorBgContainer,
    '--chart-marker-border': token.colorBorderSecondary,
    '--chart-marker-foreground': token.colorText,
    '--chart-marker-badge-background': token.colorFillSecondary,
    '--chart-marker-badge-foreground': token.colorText,
    '--chart-tooltip-background': token.colorBgElevated,
    '--chart-indicator-color': color,
    '--chart-indicator-secondary-color': token.colorWarning,
    '--chart-segment-background': token.colorFillQuaternary,
    '--chart-segment-line': token.colorBorder,
    '--chart-brush-border': token.colorBorder,
    '--chart-line-primary': color,
    '--chart-line-secondary': token.colorWarning,
    '--chart-1': color,
    '--chart-2': token.colorWarning,
    '--chart-3': token.colorError,
    '--chart-4': token.colorSuccess,
    '--chart-5': token.colorTextTertiary,
  } as CSSProperties

  if (!data.length) {
    return <div style={{ height, display: 'grid', placeItems: 'center' }}>{empty}</div>
  }

  return (
    <div style={vars}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 2 }}>
        {series.map((item) => (
          <span key={item.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: `${item.dashed ? 2 : 3}px ${item.dashed ? 'dashed' : 'solid'} ${item.color}`,
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {item.label}
            </Typography.Text>
            <Typography.Text strong style={{ fontSize: 11 }}>
              {count(totals[item.key] ?? 0)}
            </Typography.Text>
          </span>
        ))}
      </div>
      <LineChart
        data={data}
        xDataKey="time"
        aspectRatio={undefined}
        animationDuration={600}
        margin={{ top: 12, right: 16, bottom: 30, left: 44 }}
        style={{ height }}
      >
        <Grid horizontal numTicksRows={4} />
        <XAxis numTicks={5} />
        <YAxis numTicks={4} />
        <ChartTooltip
          showDatePill={false}
          panelStyle={{
            // A plain white popover with a dark `currentColor` border stands
            // out of an antd card; the filled grey matches the page instead.
            backgroundColor: token.colorFillTertiary,
            borderColor: token.colorBorderSecondary,
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.08)',
          }}
          content={({ point }) => (
            <div style={{ padding: '8px 10px', minWidth: 150 }}>
              <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 4 }}>
                {shortStamp(point.time)}
              </div>
              {series.map((item) => (
                <div
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 18,
                    fontSize: 12,
                    lineHeight: '20px',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: item.color,
                      }}
                    />
                    <span>{item.label}</span>
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {count(num(point[item.key]))}
                  </span>
                </div>
              ))}
            </div>
          )}
        />
        {series.map((item) => (
          <Line
            key={item.key}
            dataKey={item.key}
            stroke={item.color}
            strokeWidth={item.key === 'total' ? 2.5 : 1.5}
            dashFromIndex={item.dashed ? 0 : undefined}
            dashArray="5,4"
            // Without this bklit fades the stroke out towards both ends, which
            // makes the last bucket look empty.
            fadeEdges={false}
          />
        ))}
      </LineChart>
    </div>
  )
}
