<template>
  <ProductScaffold>
    <section class="page-section wide wizard-page-section">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">仿真配置</p>
          <h1 class="page-title">步骤 4 · 仿真参数与生成提交</h1>
          <p class="page-subtitle">这里收集首版任务参数并生成完整 manifest，不触发真实 Python，仅为后续后端接入固化输入合同。</p>
        </div>
      </div>

      <div class="form-grid two-up">
        <label class="v2-field">
          <span>任务总时长（分钟）</span>
          <input v-model.number="durationMin" name="durationMin" type="number" min="1" max="120" />
        </label>
        <label class="v2-field">
          <span>仿真倍速</span>
          <select v-model.number="speedMultiplier" name="speedMultiplier">
            <option :value="1">1x</option>
            <option :value="2">2x</option>
            <option :value="5">5x</option>
            <option :value="10">10x</option>
          </select>
        </label>
      </div>

      <div class="form-grid two-up">
        <label class="v2-field">
          <span>卫星天线角度（deg）</span>
          <input v-model.number="satAntennaAngleDeg" name="satAntennaAngleDeg" type="number" min="1" step="1" />
        </label>
        <label class="v2-field">
          <span>轨迹采样间隔（秒）</span>
          <input v-model.number="timeStepSeconds" name="timeStepSeconds" type="number" min="5" step="5" />
        </label>
      </div>

      <div class="bandwidth-preview-layout">
        <div class="bandwidth-grid">
          <label class="v2-field">
            <span>地空链路带宽（Mbps）</span>
            <input v-model.number="bwGslMbps" name="bwGslMbps" type="number" min="1" step="1" />
          </label>
          <label class="v2-field">
            <span>星间链路带宽（Mbps）</span>
            <input v-model.number="bwIslMbps" name="bwIslMbps" type="number" min="1" step="1" />
          </label>
          <label class="v2-field">
            <span>星上总线带宽（Mbps）</span>
            <input v-model.number="intraSatelliteBusMbps" name="intraSatelliteBusMbps" type="number" min="1" step="10" />
          </label>
        </div>
        <div class="v2-helper-card stack-gap">
          <h3>生成前预览</h3>
          <p>TLE 校验：{{ previewValidationText }}</p>
          <p>飞机数量：{{ previewAircraftCount }}</p>
          <p>地面站坐标：{{ previewGroundStationText }}</p>
          <p>天气预设：{{ previewWeatherText }}</p>
        </div>
      </div>

      <div class="v2-table-card">
        <div class="v2-table-card__header">
          <span>飞机业务需求预览</span>
          <span>{{ previewManifest.trafficDemands.length }} 条</span>
        </div>
        <table class="v2-table">
          <thead>
            <tr>
              <th>飞机</th>
              <th>目标地面站</th>
              <th>带宽（Mbps）</th>
              <th>轨迹点数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="route in previewManifest.aircraftRoutes" :key="route.id">
              <td>{{ route.id }}</td>
              <td>{{ previewManifest.groundStation.id }}</td>
              <td>{{ route.rateMbps }}</td>
              <td>{{ route.points.length }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="errorText" class="state-banner error">{{ errorText }}</div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'wizard-ground-stations' })">上一步</button>
        <button class="v2-button" :disabled="submitting" @click="submitManifest">{{ submitting ? "提交中..." : "生成任务清单" }}</button>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { submitSimulationManifest } from "../lib/simulationAdapter";
import { saveGeneratedScenarioManifest } from "../lib/scenarioStore";
import { buildWizardManifest, formatCoordinate, getWeatherPresetMeta } from "../lib/wizardScenarioBuilder";
import { getWizardDraft, updateWizardDraft } from "../lib/wizardDraft";

const router = useRouter();
const draft = getWizardDraft();
const durationMin = ref(Number(draft.simulationParams?.totalMissionDurationMin || 10));
const speedMultiplier = ref(Number(draft.simulationParams?.simulationSpeedMultiplier || 5));
const timeStepSeconds = ref(Number(draft.simulationParams?.timeStepSeconds || 30));
const satAntennaAngleDeg = ref(Number(draft.communicationParams?.satAntennaAngleDeg || 35));
const bwGslMbps = ref(Number(draft.communicationParams?.bwGslMbps || 150));
const bwIslMbps = ref(Number(draft.communicationParams?.bwIslMbps || 500));
const intraSatelliteBusMbps = ref(Number(draft.communicationParams?.intraSatelliteBusMbps || 800));
const submitting = ref(false);
const errorText = ref("");

const previewDraft = computed(() => ({
  ...draft,
  simulationParams: {
    ...draft.simulationParams,
    totalMissionDurationMin: durationMin.value,
    simulationSpeedMultiplier: speedMultiplier.value,
    timeStepSeconds: timeStepSeconds.value,
  },
  communicationParams: {
    ...draft.communicationParams,
    satAntennaAngleDeg: satAntennaAngleDeg.value,
    bwGslMbps: bwGslMbps.value,
    bwIslMbps: bwIslMbps.value,
    intraSatelliteBusMbps: intraSatelliteBusMbps.value,
  },
}));
const previewManifest = computed(() => buildWizardManifest(previewDraft.value));
const previewValidationText = computed(() => previewManifest.value.tleValidation?.message || "未校验");
const previewAircraftCount = computed(() => previewManifest.value.aircraftRoutes.length);
const previewGroundStationText = computed(() => {
  const groundStation = previewManifest.value.groundStation;
  if (groundStation.lat == null || groundStation.lon == null) {
    return "未选择";
  }
  return `${formatCoordinate(groundStation.lat)} / ${formatCoordinate(groundStation.lon)}`;
});
const previewWeatherText = computed(() => getWeatherPresetMeta(previewManifest.value.environmentParams?.weatherPreset).label);

async function submitManifest() {
  errorText.value = "";
  if (!previewManifest.value.tleValidation?.isValid) {
    errorText.value = "当前 TLE 校验未通过，请返回步骤 1 修正。";
    return;
  }
  if (!previewManifest.value.aircraftRoutes.length) {
    errorText.value = "当前没有可提交的飞机航线，请返回步骤 2 创建。";
    return;
  }
  if (previewManifest.value.groundStation.lat == null || previewManifest.value.groundStation.lon == null) {
    errorText.value = "当前没有有效的地面站坐标，请返回步骤 3 点选。";
    return;
  }

  submitting.value = true;
  try {
    const nextDraft = updateWizardDraft({
      simulationParams: {
        totalMissionDurationMin: durationMin.value,
        simulationSpeedMultiplier: speedMultiplier.value,
        timeStepSeconds: timeStepSeconds.value,
      },
      communicationParams: {
        satAntennaAngleDeg: satAntennaAngleDeg.value,
        bwGslMbps: bwGslMbps.value,
        bwIslMbps: bwIslMbps.value,
        intraSatelliteBusMbps: intraSatelliteBusMbps.value,
      },
    });
    const manifest = buildWizardManifest(nextDraft);
    const task = await submitSimulationManifest(manifest);
    const record = saveGeneratedScenarioManifest({
      id: task.scenarioId || task.taskId,
      title: manifest.title,
      manifest,
      backendTaskId: task.taskId,
      status: task.status || "pending",
    });
    router.push({ name: "wizard-status", params: { id: record.id } });
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "任务生成失败，请稍后重试。";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.wizard-page-section {
  max-width: 1820px;
}

.bandwidth-preview-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 18px;
}

.bandwidth-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}

@media (max-width: 1200px) {
  .bandwidth-preview-layout,
  .bandwidth-grid {
    grid-template-columns: 1fr;
  }
}
</style>
