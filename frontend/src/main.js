import { createApp } from 'vue'
import {
  IconCloud,
  IconDashboard,
  IconDown,
  IconFile,
  IconFire,
  IconFolder,
  IconLink,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSafe,
  IconSettings,
  IconStorage,
  IconSun,
  IconSwap,
  IconUser,
} from '@arco-design/web-vue/es/icon'
import '@arco-design/web-vue/dist/arco.css'

import './styles.css'
import App from './App.vue'
import router from './router'
import { setupTheme } from './theme'

setupTheme()

const app = createApp(App)
// Register only the icons the shell and the pages use; the full icon set is
// several hundred components.
for (const [name, icon] of Object.entries({
  IconCloud,
  IconDashboard,
  IconDown,
  IconFile,
  IconFire,
  IconFolder,
  IconLink,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSafe,
  IconSettings,
  IconStorage,
  IconSun,
  IconSwap,
  IconUser,
})) {
  app.component(name, icon)
}
app.use(router)

// A 401 from any request means the session is gone: drop the local state and
// let the router guard send the user back to the login page.
window.addEventListener('nunt:unauthorized', () => {
  const current = router.currentRoute.value
  if (current.name !== 'login') {
    router.push({ name: 'login', query: current.fullPath && current.fullPath !== '/' ? { next: current.fullPath } : {} })
  }
})

// Exposed for the jsdom smoke test (scripts/smoke.mjs): it navigates through
// the real router so every route's chunk and page is actually mounted. It is a
// plain client side handle and exposes nothing the browser devtools could not
// already do.
window.__nunt = { router }

app.mount('#app')
