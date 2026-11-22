import { useEffect, useState } from 'react'
import { api } from './api'

const FALLBACK = [
  '北京', '天津', '河北', '山西', '内蒙古',
  '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '重庆', '四川', '贵州', '云南', '西藏',
  '陕西', '甘肃', '青海', '宁夏', '新疆',
  '香港', '澳门', '台湾',
]

export interface ProvinceState {
  options: { value: string; label: string }[]
  source: 'database' | 'builtin'
}

// useProvinces loads the province picker values from the ip2region database.
// The backend enumerates the provinces that actually occur in the xdb and
// falls back to the built-in list when no database is loaded.
export function useProvinces(): ProvinceState {
  const [state, setState] = useState<ProvinceState>({
    options: FALLBACK.map((name) => ({ value: name, label: name })),
    source: 'builtin',
  })

  useEffect(() => {
    let alive = true
    api
      .get('/api/v1/system/ip2region/provinces')
      .then((data: any) => {
        if (!alive) return
        const list = Array.isArray(data?.provinces) ? data.provinces : []
        if (!list.length) return
        setState({
          options: list.map((name: string) => ({ value: name, label: name })),
          source: data?.source === 'database' ? 'database' : 'builtin',
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return state
}
