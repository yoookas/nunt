<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import { menu } from '../menu'
import { auth, logout } from '../session'
import { setTheme, theme } from '../theme'

const route = useRoute()
const router = useRouter()
const collapsed = ref(false)

const selected = computed(() => [String(route.name || 'dashboard')])

function navigate(name) {
  if (name !== route.name) router.push({ name })
}

const dark = computed({
  get: () => theme.dark,
  set: (value) => setTheme(value),
})

async function onLogout() {
  await logout()
  Message.success('已退出登录')
  router.push({ name: 'login' })
}

function onUserMenu(key) {
  if (key === 'password') router.push({ name: 'password' })
  if (key === 'logout') onLogout()
}
</script>

<template>
  <a-layout class="app-shell">
    <a-layout-sider
      v-model:collapsed="collapsed"
      collapsible
      :width="200"
      :collapsed-width="56"
      class="app-sider"
    >
      <div class="brand">
        <span class="dot" />
        <span v-if="!collapsed">nunt</span>
      </div>
      <a-menu :selected-keys="selected" @menu-item-click="navigate">
        <a-menu-item v-for="item in menu" :key="item.name">
          <template #icon><component :is="item.icon" /></template>
          {{ item.title }}
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="app-header">
        <div class="spacer" />
        <a-tooltip :content="theme.dark ? '切换到浅色主题' : '切换到深色主题'">
          <a-switch v-model="dark" size="small">
            <template #checked-icon><icon-moon /></template>
            <template #unchecked-icon><icon-sun /></template>
          </a-switch>
        </a-tooltip>
        <a-dropdown trigger="click" @select="onUserMenu">
          <a-button type="text">
            <template #icon><icon-user /></template>
            {{ auth.user || '未登录' }}
            <icon-down />
          </a-button>
          <template #content>
            <a-doption value="password">修改密码</a-doption>
            <a-doption value="logout">退出登录</a-doption>
          </template>
        </a-dropdown>
      </a-layout-header>

      <a-layout-content class="app-content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.app-shell {
  height: 100%;
}

.app-sider {
  border-right: 1px solid var(--color-border-2);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 18px;
  font-size: 16px;
  font-weight: 600;
}

.brand .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgb(var(--primary-6));
}

.app-header {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border-2);
}

.app-content {
  overflow: auto;
}
</style>
