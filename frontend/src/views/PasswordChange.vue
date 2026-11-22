<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import { changePassword } from '../session'
import { errorText } from '../api'

const router = useRouter()
const form = reactive({ current: '', next: '', confirm: '' })
const loading = ref(false)

async function submit() {
  if (form.next.length < 8) {
    Message.warning('新密码长度至少 8 位')
    return
  }
  if (form.next !== form.confirm) {
    Message.warning('两次输入的新密码不一致')
    return
  }
  loading.value = true
  try {
    await changePassword(form.current, form.next)
    Message.success('密码已修改')
    router.push('/')
  } catch (err) {
    Message.error(errorText(err))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>修改密码</h2>
        <div class="sub">修改成功后当前会话仍然有效，其他旧会话会立即失效</div>
      </div>
    </div>
    <a-card style="max-width: 460px">
      <a-form :model="form" layout="vertical">
        <a-form-item field="current" label="当前密码">
          <a-input-password v-model="form.current" />
        </a-form-item>
        <a-form-item field="next" label="新密码" extra="至少 8 位">
          <a-input-password v-model="form.next" />
        </a-form-item>
        <a-form-item field="confirm" label="确认新密码">
          <a-input-password v-model="form.confirm" />
        </a-form-item>
        <a-button type="primary" :loading="loading" @click="submit">保存</a-button>
      </a-form>
    </a-card>
  </div>
</template>
