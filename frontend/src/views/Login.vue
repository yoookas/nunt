<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import { login } from '../session'
import { errorText } from '../api'

const router = useRouter()
const route = useRoute()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error = ref('')

async function submit() {
  if (!form.username || !form.password) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const data = await login(form.username.trim(), form.password)
    if (data.mustChangePassword) {
      Message.warning('首次登录，请先修改初始密码')
      router.push({ name: 'password' })
      return
    }
    router.push(String(route.query.next || '/'))
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-shell">
    <a-card class="login-card" :bordered="false">
      <div class="login-brand"><span class="dot" />nunt</div>
      <a-form :model="form" layout="vertical">
        <a-form-item field="username" label="用户名">
          <a-input v-model="form.username" placeholder="admin" allow-clear autofocus />
        </a-form-item>
        <a-form-item field="password" label="密码">
          <a-input-password v-model="form.password" placeholder="密码" @press-enter="submit" />
        </a-form-item>
        <a-alert v-if="error" type="error" :content="error" style="margin-bottom: 12px" />
        <a-button type="primary" long :loading="loading" @click="submit">登录</a-button>
      </a-form>
    </a-card>
  </div>
</template>
