<template>
  <ProductScaffold>
    <section class="page-section narrow">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">任务状态</p>
          <h1 class="page-title">仿真任务生成中</h1>
          <p class="page-subtitle">
            这里会轮询本地仿真服务的执行状态。任务完成后，系统会自动把
            `render.czml + bundle.json` 写回浏览器本地场景库，后续可直接进入主屏和副屏。
          </p>
        </div>
      </div>

      <div v-if="record" class="v2-helper-card stack-gap">
        <div>
          <h3>{{ record.title }}</h3>
          <p>本地记录 ID：{{ record.id }}</p>
          <p>后端任务 ID：{{ record.backendTaskId || "--" }}</p>
          <p>
            当前状态：
            <span class="status-pill" :class="statusPillClass">{{ statusLabel }}</span>
          </p>
        </div>

        <div class="form-grid two-up">
          <div class="v2-helper-card stack-gap">
            <h3>任务摘要</h3>
            <p>卫星数量：{{ taskSummary.satelliteCount }}</p>
            <p>飞机数量：{{ taskSummary.aircraftCount }}</p>
            <p>地面站数量：{{ taskSummary.groundStationCount }}</p>
            <p>业务需求：{{ taskSummary.demandCount }}</p>
          </div>
          <div class="v2-helper-card stack-gap">
            <h3>生成产物</h3>
            <p>配置文件：{{ taskArtifacts.sampleConfigName }}</p>
            <p>仿真结果：{{ taskArtifacts.bundleName }}</p>
            <p>CZML 文件：{{ taskArtifacts.czmlName }}</p>
          </div>
        </div>

        <div class="v2-helper-card stack-gap">
          <div class="log-card-header">
            <div>
              <h3>执行摘要</h3>
            </div>
            <button class="v2-button v2-button--ghost" :disabled="!taskLogText" @click="openLogModal">
              查看完整日志
            </button>
          </div>

          <ul class="task-step-list">
            <li :class="{ done: logStepStates.sampleConfig }">
              <strong>配置准备</strong>
              <span>{{ logStepStates.sampleConfig ? "已完成输入配置准备" : "等待生成" }}</span>
            </li>
            <li :class="{ done: logStepStates.simulation }">
              <strong>核心仿真</strong>
              <span>{{ logStepStates.simulation ? "已完成场景仿真计算" : "等待执行" }}</span>
            </li>
            <li :class="{ done: logStepStates.czml }">
              <strong>场景文件生成</strong>
              <span>{{ logStepStates.czml ? "已完成场景文件输出" : "等待生成" }}</span>
            </li>
          </ul>
        </div>

        <details class="v2-helper-card stack-gap">
          <summary class="manifest-summary">查看 Manifest 预览</summary>
          <pre class="manifest-preview">{{ formattedManifest }}</pre>
        </details>
      </div>

      <div v-else class="state-banner error">
        未找到对应的本地任务记录，请返回场景库重新发起任务。
      </div>

      <div v-if="errorText" class="state-banner error">
        {{ errorText }}
      </div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'library' })">返回场景库</button>
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'wizard-tle' })">继续新建任务</button>
        <button class="v2-button" :disabled="!canOpenRun" @click="openRun">打开 3D 主屏</button>
        <button class="v2-button" :disabled="!canOpenRun" @click="openMetrics">打开参数副屏</button>
      </div>
    </section>

    <div v-if="isLogModalOpen" class="dialog-backdrop" @click.self="closeLogModal">
      <div class="dialog-card log-dialog-card">
        <div class="dialog-card__eyebrow">完整日志</div>
        <h3 class="dialog-card__title">任务执行日志</h3>
        <p class="dialog-card__body">
          这里展示 `sample_config`、Python 仿真和 CZML 转换的完整输出，便于排查失败原因。
        </p>
        <pre class="manifest-preview log-modal-preview">{{ taskLogText || "当前暂无日志输出。" }}</pre>
        <div class="dialog-card__actions">
          <button class="v2-button" @click="closeLogModal">关闭</button>
        </div>
      </div>
    </div>
  </ProductScaffold>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { fetchSimulationTask } from "../lib/simulationAdapter";
import { refreshServerScenarioRecords } from "../lib/runtimeScenarioCatalog";
import {
  getStoredScenarioRecord,
  updateStoredScenarioRecord,
} from "../lib/scenarioStore";
import { openMetricsScreenWindow } from "../lib/openScreenWindow";

const route = useRoute();
const router = useRouter();
const localRecordId = computed(() => String(route.params.id || ""));
const refreshKey = ref(0);
const errorText = ref("");
const taskStatus = ref(null);
const isHydratingResult = ref(false);
const isLogModalOpen = ref(false);
let pollTimer = 0;

const record = computed(() => {
  refreshKey.value;
  return getStoredScenarioRecord(localRecordId.value);
});

const formattedManifest = computed(() => JSON.stringify(record.value?.manifest || {}, null, 2));

const statusValue = computed(() => {
  if (record.value?.status === "ready") return "ready";
  if (record.value?.status === "failed") return "failed";
  if (taskStatus.value?.status) return taskStatus.value.status;
  return record.value?.status || "pending";
});

const statusPillClass = computed(() => {
  if (statusValue.value === "ready") return "ready";
  if (statusValue.value === "failed") return "error";
  if (statusValue.value === "running") return "pending";
  return "pending";
});

const statusLabel = computed(() => {
  return {
    pending: "排队中",
    running: "生成中",
    ready: "已完成",
    failed: "失败",
  }[statusValue.value] || statusValue.value;
});

const taskSummary = computed(() => ({
  satelliteCount: taskStatus.value?.summary?.satelliteCount ?? record.value?.manifest?.tleValidation?.satelliteCount ?? "--",
  aircraftCount: taskStatus.value?.summary?.aircraftCount ?? record.value?.manifest?.aircraftRoutes?.length ?? "--",
  groundStationCount: taskStatus.value?.summary?.groundStationCount ?? 1,
  demandCount: taskStatus.value?.summary?.demandCount ?? record.value?.manifest?.trafficDemands?.length ?? "--",
}));

const taskArtifacts = computed(() => ({
  sampleConfigName: taskStatus.value?.artifacts?.sampleConfigFile || "sample_config.json",
  bundleName: taskStatus.value?.artifacts?.bundleFile || "simulation_bundle.json",
  czmlName: taskStatus.value?.artifacts?.czmlFile || "render.czml",
}));

const taskLogText = computed(() => {
  const logs = taskStatus.value?.logs;
  if (!logs) return "";
  return [
    logs.sampleConfig ? `# sample_config\n${logs.sampleConfig}` : "",
    logs.simulation ? `# simulation\n${logs.simulation}` : "",
    logs.czml ? `# czml\n${logs.czml}` : "",
  ].filter(Boolean).join("\n\n");
});

const logStepStates = computed(() => ({
  sampleConfig: Boolean(taskStatus.value?.logs?.sampleConfig),
  simulation: Boolean(taskStatus.value?.artifacts?.bundleFile || taskStatus.value?.status === "ready"),
  czml: Boolean(taskStatus.value?.artifacts?.czmlFile || taskStatus.value?.status === "ready"),
}));

const canOpenRun = computed(() => record.value?.status === "ready");

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
}

function scheduleNextPoll(delayMs = 2000) {
  stopPolling();
  pollTimer = window.setTimeout(() => {
    void pollTaskStatus();
  }, delayMs);
}

function openLogModal() {
  if (!taskLogText.value) return;
  isLogModalOpen.value = true;
}

function closeLogModal() {
  isLogModalOpen.value = false;
}

async function hydrateReadyAssets(_taskId) {
  if (!record.value || isHydratingResult.value || record.value.status === "ready") {
    return;
  }

  isHydratingResult.value = true;
  try {
    await refreshServerScenarioRecords().catch(() => []);
    updateStoredScenarioRecord(record.value.id, {
      status: "ready",
      generatedAt: new Date().toISOString(),
      artifactSummary: taskStatus.value?.summary || null,
    });
    refreshKey.value += 1;
  } finally {
    isHydratingResult.value = false;
  }
}

async function pollTaskStatus() {
  if (!record.value?.backendTaskId) {
    errorText.value = "当前任务缺少后端任务 ID，无法继续轮询生成状态。";
    return;
  }

  try {
    const task = await fetchSimulationTask(record.value.backendTaskId);
    taskStatus.value = task;
    errorText.value = "";

    if (task.status === "ready") {
      updateStoredScenarioRecord(record.value.id, { status: "pending" });
      refreshKey.value += 1;
      await hydrateReadyAssets(task.taskId);
      stopPolling();
      return;
    }

    if (task.status === "failed") {
      updateStoredScenarioRecord(record.value.id, {
        status: "failed",
        taskError: task.error || "任务执行失败",
      });
      refreshKey.value += 1;
      errorText.value = task.error || "任务执行失败，请检查完整日志。";
      stopPolling();
      return;
    }

    updateStoredScenarioRecord(record.value.id, { status: task.status || "pending" });
    refreshKey.value += 1;
    scheduleNextPoll();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "任务状态查询失败，请稍后重试。";
    scheduleNextPoll(4000);
  }
}

function openRun() {
  if (!record.value?.id || record.value.status !== "ready") {
    return;
  }
  void router.push({ name: "run", query: { scenario: record.value.id } });
}

function openMetrics() {
  if (!record.value?.id || record.value.status !== "ready") {
    return;
  }
  openMetricsScreenWindow(record.value.id);
}

onMounted(async () => {
  await nextTick();
  window.scrollTo({ top: 0, behavior: "auto" });

  if (!record.value) {
    errorText.value = "未找到对应的本地任务记录。";
    return;
  }
  if (record.value.status === "ready") {
    return;
  }
  void pollTaskStatus();
});

onBeforeUnmount(() => {
  stopPolling();
});
</script>

<style scoped>
.log-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.task-step-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.task-step-list li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.34);
  border: 1px solid rgba(148, 163, 184, 0.18);
}

.task-step-list li.done {
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(8, 47, 73, 0.26);
}

.task-step-list strong {
  color: #e2e8f0;
}

.task-step-list span {
  color: rgba(226, 232, 240, 0.8);
  text-align: right;
}

.manifest-summary {
  cursor: pointer;
  color: #e2e8f0;
  font-weight: 600;
}

.log-dialog-card {
  width: min(1080px, calc(100vw - 64px));
}

.log-modal-preview {
  max-height: 62vh;
  overflow: auto;
  margin: 0;
}

@media (max-width: 900px) {
  .log-card-header {
    flex-direction: column;
  }

  .task-step-list li {
    flex-direction: column;
  }

  .task-step-list span {
    text-align: left;
  }

  .log-dialog-card {
    width: min(100vw - 24px, 1080px);
  }
}
</style>
