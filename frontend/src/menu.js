// The admin navigation. Each entry maps to a route and an Arco icon component
// registered globally by main.js.
export const menu = [
  { name: 'dashboard', path: '/', title: '概览', icon: 'IconDashboard' },
  { name: 'web', path: '/web', title: 'Web 服务', icon: 'IconLink' },
  { name: 'forward', path: '/forward', title: '端口转发', icon: 'IconSwap' },
  { name: 'ddns', path: '/ddns', title: '动态域名', icon: 'IconCloud' },
  { name: 'acme', path: '/acme', title: '证书', icon: 'IconSafe' },
  { name: 'waf', path: '/waf', title: 'WAF', icon: 'IconFire' },
  { name: 'task', path: '/task', title: '计划任务', icon: 'IconSchedule' },
  { name: 'notify', path: '/notify', title: '通知', icon: 'IconNotification' },
  { name: 'storage', path: '/storage', title: '存储', icon: 'IconStorage' },
  { name: 'logs', path: '/logs', title: '日志', icon: 'IconFile' },
  { name: 'settings', path: '/settings', title: '设置', icon: 'IconSettings' },
]
