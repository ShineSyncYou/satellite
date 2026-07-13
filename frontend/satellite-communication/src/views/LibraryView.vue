<template>
  <ProductScaffold>
    <template #header-actions>
      <button
        v-if="!isAdminLoggedIn"
        class="v2-button"
        @click="$router.push({ name: 'admin-login' })"
      >
        管理员登录
      </button>
      <button
        v-else
        class="v2-button"
        :disabled="adminSessionState.loading"
        @click="logoutAndRefresh"
      >
        {{ adminSessionState.loading ? "退出中..." : "退出管理员" }}
      </button>
      <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'landing' })">返回欢迎首页</button>
    </template>

    <section class="page-section wide">
      <div class="page-section__head">
        <div>
          <h1 class="page-title">场景配置库</h1>
        </div>
      </div>

      <div class="library-overview-grid">
        <article class="v2-helper-card library-summary-card">
          <span>场景总数</span>
          <strong>{{ records.length }}</strong>
          <p>当前可用于主屏和副屏展示的全部场景数量。</p>
        </article>
        <article class="v2-helper-card library-summary-card">
          <span>可直接运行</span>
          <strong>{{ runnableCount }}</strong>
          <p>包含内置场景与已完成导入的场景。</p>
        </article>
        <article class="v2-helper-card library-summary-card">
          <span>待生成任务</span>
          <strong>{{ pendingCount }}</strong>
          <p>新建任务流程已提交，但还未生成最终输出的任务。</p>
        </article>
      </div>

      <div v-if="feedbackMessage" class="state-banner" :class="feedbackType">
        {{ feedbackMessage }}
      </div>

      <div class="v2-table-card">
        <div class="v2-table-card__header">
          <span>场景列表</span>
          <span>{{ records.length }} 项</span>
        </div>
        <table class="v2-table">
          <thead>
            <tr>
              <th>场景名称</th>
              <th>来源</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in records" :key="record.id">
              <td>
                <strong>{{ record.title }}</strong>
                <p class="table-subline">{{ record.id }}</p>
              </td>
              <td>{{ formatMode(record.mode) }}</td>
              <td>
                <span class="status-pill" :class="record.status">
                  {{ formatStatus(record.status) }}
                </span>
              </td>
              <td>{{ formatCreatedAt(record.createdAt) }}</td>
              <td>
                <div class="table-actions table-actions--library">
                  <button class="v2-button v2-button--tiny" :disabled="!canRun(record)" @click="openRun(record.id)">3D 主屏</button>
                  <button class="v2-button v2-button--tiny v2-button--ghost" :disabled="!canRun(record)" @click="openMetrics(record.id)">
                    参数副屏
                  </button>
                  <button
                    v-if="record.mode === 'generated' && !canRun(record)"
                    class="v2-button v2-button--tiny v2-button--ghost"
                    @click="openTaskStatus(record.id)"
                  >
                    查看状态
                  </button>
                  <button
                    v-if="canDelete(record)"
                    class="v2-button v2-button--tiny v2-button--ghost v2-button--danger"
                    :disabled="deletingId === record.id"
                    @click="openDeleteDialog(record)"
                  >
                    {{ deletingId === record.id ? "删除中" : "删除" }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="dialogRecord" class="dialog-backdrop" @click.self="closeDeleteDialog">
      <div class="dialog-card">
        <div class="dialog-card__eyebrow">删除确认</div>
        <h3 class="dialog-card__title">确定要删除这个场景吗？</h3>
        <p class="dialog-card__body">
          <strong>{{ dialogRecord.title }}</strong>
          将从场景库中移除。
          <span v-if="dialogRecord.mode === 'imported'">对应的本地缓存也会一并删除。</span>
          此操作不可撤销。
        </p>
        <div class="dialog-card__actions">
          <button class="v2-button v2-button--ghost" :disabled="deletingId === dialogRecord.id" @click="closeDeleteDialog">取消</button>
          <button class="v2-button v2-button--danger-solid" :disabled="deletingId === dialogRecord.id" @click="confirmDelete">
            {{ deletingId === dialogRecord.id ? "正在删除..." : "确认删除" }}
          </button>
        </div>
      </div>
    </div>
  </ProductScaffold>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { adminLogout, adminSessionState, isAdminLoggedIn, refreshAdminSession } from "../lib/adminSession";
import { deleteServerScenario } from "../lib/simulationAdapter";
import { deleteUserScenario } from "../lib/scenarioStore";
import { listAllScenarioRecords, refreshServerScenarioRecords } from "../lib/runtimeScenarioCatalog";
import { openMetricsScreenWindow } from "../lib/openScreenWindow";

const router = useRouter();
const refreshKey = ref(0);
const deletingId = ref("");
const feedbackMessage = ref("");
const feedbackType = ref("");
const dialogRecord = ref(null);
let serverRefreshTimer = 0;

const records = computed(() => {
  refreshKey.value;
  return listAllScenarioRecords();
});

const runnableCount = computed(() => records.value.filter((item) => item.mode === "builtin" || item.status === "ready").length);
const pendingCount = computed(() => records.value.filter((item) => item.status === "pending" || item.status === "running").length);

function canRun(record) {
  return record.mode === "builtin" || record.status === "ready";
}

function canDelete(record) {
  return isAdminLoggedIn.value && record.mode !== "builtin";
}

function formatCreatedAt(value) {
  if (!value || value === "builtin") return "系统内置";
  return new Date(value).toLocaleString();
}

function formatMode(value) {
  return ({
    builtin: "内置",
    imported: "导入",
    generated: "新建",
    "server-generated": "服务端新建",
    "server-imported": "服务端导入",
  })[value] || value;
}

function formatStatus(value) {
  return ({ ready: "可运行", pending: "待生成", running: "生成中", failed: "失败" })[value] || value;
}

function openRun(id) {
  void router.push({ name: "run", query: { scenario: id } });
}

function openMetrics(id) {
  openMetricsScreenWindow(id);
}

function openTaskStatus(id) {
  void router.push({ name: "wizard-status", params: { id } });
}

function openDeleteDialog(record) {
  if (!canDelete(record)) {
    return;
  }
  dialogRecord.value = record;
}

function closeDeleteDialog() {
  if (deletingId.value) {
    return;
  }
  dialogRecord.value = null;
}

async function confirmDelete() {
  if (!dialogRecord.value) {
    return;
  }

  const record = dialogRecord.value;
  deletingId.value = record.id;
  feedbackMessage.value = "";
  feedbackType.value = "";

  try {
    if (record.mode === "server-generated" || record.mode === "server-imported") {
      await deleteServerScenario(record.id);
      await refreshServerScenarioRecords().catch(() => []);
    } else {
      await deleteUserScenario(record.id);
    }
    refreshKey.value += 1;
    feedbackType.value = "";
    feedbackMessage.value = `已删除场景：${record.title}`;
    dialogRecord.value = null;
  } catch (error) {
    feedbackType.value = "error";
    feedbackMessage.value = error instanceof Error ? error.message : "删除失败，请稍后重试。";
  } finally {
    deletingId.value = "";
  }
}

async function logoutAndRefresh() {
  try {
    await adminLogout();
    dialogRecord.value = null;
    feedbackType.value = "";
    feedbackMessage.value = "已退出管理员身份。";
    await refreshServerScenarioRecords().catch(() => []);
    refreshKey.value += 1;
  } catch (error) {
    feedbackType.value = "error";
    feedbackMessage.value = error instanceof Error ? error.message : "退出失败，请稍后重试。";
  }
}

onMounted(async () => {
  await refreshAdminSession().catch(() => {});
  await refreshServerScenarioRecords().catch(() => []);
  refreshKey.value += 1;
  serverRefreshTimer = window.setInterval(async () => {
    await refreshServerScenarioRecords().catch(() => []);
    refreshKey.value += 1;
  }, 5000);
});

onBeforeUnmount(() => {
  if (serverRefreshTimer) {
    window.clearInterval(serverRefreshTimer);
    serverRefreshTimer = 0;
  }
});
</script>
