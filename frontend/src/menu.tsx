import {
  AuditOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileProtectOutlined,
  GlobalOutlined,
  LockOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'

export interface NavItem {
  path: string
  title: string
  icon: ReactNode
}

export const menu: NavItem[] = [
  { path: '/', title: '概览', icon: <DashboardOutlined /> },
  { path: '/web', title: 'Web 服务', icon: <GlobalOutlined /> },
  { path: '/forward', title: '端口转发', icon: <SwapOutlined /> },
  { path: '/ddns', title: '动态域名', icon: <CloudServerOutlined /> },
  { path: '/acme', title: '证书', icon: <LockOutlined /> },
  { path: '/waf', title: 'WAF', icon: <FileProtectOutlined /> },
  { path: '/logs', title: '日志', icon: <AuditOutlined /> },
  { path: '/ipdb', title: 'IP 地址库', icon: <DatabaseOutlined /> },
  { path: '/settings', title: '设置', icon: <SettingOutlined /> },
]
