import type { ComponentType } from 'react'
import {
  ArrowLeftRight,
  Cloud,
  Flame,
  Globe,
  HardDrive,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
} from 'lucide-react'

export interface MenuItem {
  path: string
  title: string
  icon: ComponentType<{ size?: number | string; className?: string }>
}

export const menu: MenuItem[] = [
  { path: '/', title: '概览', icon: LayoutDashboard },
  { path: '/web', title: 'Web 服务', icon: Globe },
  { path: '/forward', title: '端口转发', icon: ArrowLeftRight },
  { path: '/ddns', title: '动态域名', icon: Cloud },
  { path: '/acme', title: '证书', icon: ShieldCheck },
  { path: '/waf', title: 'WAF', icon: Flame },
  { path: '/storage', title: '存储', icon: HardDrive },
  { path: '/logs', title: '日志', icon: ScrollText },
  { path: '/settings', title: '设置', icon: Settings },
]
