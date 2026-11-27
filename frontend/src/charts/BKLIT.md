# Vendored bklit charts

`src/charts/**`, `src/lib/utils.ts` and `src/shimmering-text.tsx` are copied from
[Bklit UI](https://bklit.com), a shadcn registry of MIT licensed chart
components. They are not an npm package: the registry copies source files into
the project, so these files are ours to maintain.

- Registry: `https://ui.bklit.com/r/<name>.json`
- Entry point installed: `line-chart` (plus `y-axis`), pulled on 2026-11-28
- Everything else in `src/charts` is that entry's registry dependency closure;
  only `RequestLineChart` renders it today

## Local changes

- `chart-formatters.ts`: `shortDateFmt` / `hmsTimeFmt` use `zh-CN` and
  `shortDateFmt` carries the hour, because one dashboard day has up to 24
  hourly buckets that would otherwise dedupe to a single axis label.

Everything else is untouched. The chart palette comes from CSS variables set
inline by `src/components/RequestLineChart.tsx`, so there is no global theme
file to keep in sync.

## Tailwind

The charts style their chrome with Tailwind utilities. The app is plain CSS
modules plus antd, so `src/charts.css` imports only `tailwindcss/theme.css` and
`tailwindcss/utilities.css` — preflight is deliberately left out so it cannot
reset the antd components around the charts.

## Updating

Re-fetch the registry JSON, overwrite the files, then re-apply the local change
above and run `tsc --noEmit`. The vendored tree adds roughly 100 KB gzip to the
lazily loaded dashboard chunk.
