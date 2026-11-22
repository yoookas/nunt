import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from './layout/AppLayout.vue'
import { auth, bootstrap } from './session'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', name: 'dashboard', component: () => import('./views/Dashboard.vue') },
      { path: 'web', name: 'web', component: () => import('./views/Web.vue') },
      { path: 'forward', name: 'forward', component: () => import('./views/Forward.vue') },
      { path: 'ddns', name: 'ddns', component: () => import('./views/Ddns.vue') },
      { path: 'acme', name: 'acme', component: () => import('./views/Acme.vue') },
      { path: 'waf', name: 'waf', component: () => import('./views/Waf.vue') },
      { path: 'storage', name: 'storage', component: () => import('./views/Storage.vue') },
      { path: 'logs', name: 'logs', component: () => import('./views/Logs.vue') },
      { path: 'settings', name: 'settings', component: () => import('./views/Settings.vue') },
      { path: 'password', name: 'password', component: () => import('./views/PasswordChange.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.beforeEach(async (to) => {
  if (!auth.ready) await bootstrap()
  if (to.meta.public) return true
  if (!auth.user) {
    const next = to.fullPath && to.fullPath !== '/' ? { next: to.fullPath } : {}
    return { name: 'login', query: next }
  }
  return true
})

export default router
