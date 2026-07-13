<template>
  <ProductScaffold>
    <section class="page-section narrow admin-login-page">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">管理员入口</p>
          <h1 class="page-title">管理员登录</h1>
          <p class="page-subtitle">
            普通用户无需登录即可新建和查看场景。管理员登录后，可以删除用户配置的共享场景。
          </p>
        </div>
      </div>

      <div class="admin-login-shell">
        <form class="admin-login-card" @submit.prevent="submitLogin">
          <label class="v2-field">
            <span>用户名</span>
            <input v-model.trim="username" type="text" autocomplete="username" placeholder="输入管理员用户名" />
          </label>

          <label class="v2-field">
            <span>密码</span>
            <input v-model="password" type="password" autocomplete="current-password" placeholder="输入管理员密码" />
          </label>

          <div v-if="errorText" class="state-banner error">{{ errorText }}</div>
          <div v-if="isAdminLoggedIn" class="state-banner">当前已以管理员身份登录。</div>

          <div class="page-actions">
            <button class="v2-button v2-button--ghost" type="button" @click="$router.push({ name: 'library' })">返回场景库</button>
            <button class="v2-button" type="submit" :disabled="submitting">{{ submitting ? "登录中..." : "登录" }}</button>
          </div>
        </form>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { adminLogin, isAdminLoggedIn, refreshAdminSession } from "../lib/adminSession";

const router = useRouter();
const username = ref("");
const password = ref("");
const errorText = ref("");
const submitting = ref(false);

async function submitLogin() {
  errorText.value = "";
  if (!username.value || !password.value) {
    errorText.value = "请输入管理员用户名和密码。";
    return;
  }

  submitting.value = true;
  try {
    await adminLogin({
      username: username.value,
      password: password.value,
    });
    await router.push({ name: "library" });
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "登录失败，请稍后重试。";
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await refreshAdminSession().catch(() => {});
  if (isAdminLoggedIn.value) {
    await router.replace({ name: "library" });
  }
});
</script>

<style scoped>
.admin-login-page {
  min-height: 60vh;
}

.admin-login-shell {
  display: flex;
  justify-content: flex-start;
}

.admin-login-card {
  width: min(460px, 100%);
  display: grid;
  gap: 18px;
  padding: 28px;
  border-radius: 20px;
  border: 1px solid rgba(120, 170, 208, 0.25);
  background: linear-gradient(165deg, rgba(9, 22, 38, 0.82), rgba(8, 27, 46, 0.7));
  box-shadow: 0 16px 40px rgba(2, 8, 18, 0.26);
}

.admin-login-card .page-actions {
  align-items: stretch;
}

.admin-login-card .page-actions .v2-button {
  display: inline-flex;
  align-items: center;
  min-width: 132px;
  justify-content: center;
  text-align: center;
}

@media (max-width: 720px) {
  .admin-login-card .page-actions .v2-button {
    width: 100%;
  }
}
</style>
