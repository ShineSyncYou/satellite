<template>
  <ProductScaffold>
    <section class="page-section wide wizard-page-section">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">地面站配置</p>
          <h1 class="page-title">步骤 3 · 地面站点选与天气预设</h1>
          <p class="page-subtitle">首版只允许创建 1 个地面站，在中国区域平面地图上点击位置后补充名称与高度，同时选择天气预设写入任务清单。</p>
        </div>
      </div>

      <div class="form-grid two-up wizard-map-layout">
        <div class="v2-helper-card stack-gap wizard-map-card">
          <h3>地面站点选地图（中国区域平面视图）</h3>
          <WizardCesiumMap
            :height="430"
            :hint="'请在中国区域点击一个地面站位置，重复点击会覆盖 GS_1 的坐标。'"
            :markers="groundStationMarker"
            @map-click="onMapClick"
          />
        </div>

        <div class="v2-helper-card stack-gap wizard-status-card">
          <h3>GS_1 参数</h3>

          <label class="v2-field">
            <span>地面站名称</span>
            <input v-model="stationName" name="groundStationName" type="text" placeholder="例如：西安地面站" />
          </label>

          <label class="v2-field">
            <span>地面站高度（km）</span>
            <input v-model.number="stationAltKm" name="groundStationAltitude" type="number" min="0" max="5" step="0.1" />
          </label>

          <div class="station-coordinate-grid">
            <div class="station-coordinate-card">
              <span class="station-coordinate-card__label"><span aria-hidden="true">◉</span> 纬度</span>
              <strong>{{ stationLatDisplay }}</strong>
            </div>
            <div class="station-coordinate-card">
              <span class="station-coordinate-card__label"><span aria-hidden="true">◌</span> 经度</span>
              <strong>{{ stationLonDisplay }}</strong>
            </div>
          </div>

          <div class="weather-preset-section">
            <h3>天气预设</h3>
            <div class="weather-preset-grid">
              <button
                v-for="weather in WEATHER_PRESET_OPTIONS"
                :key="weather.key"
                type="button"
                class="weather-preset-card"
                :class="{ 'is-active': weatherPreset === weather.key }"
                :aria-pressed="weatherPreset === weather.key"
                @click="weatherPreset = weather.key"
              >
                <span class="weather-preset-card__icon" aria-hidden="true">{{ weather.icon }}</span>
                <span class="weather-preset-card__label">{{ weather.label }}</span>
                <span class="weather-preset-card__description">{{ weather.description }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorText" class="state-banner error">{{ errorText }}</div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'wizard-trajectory' })">上一步</button>
        <button class="v2-button" @click="goNext">下一步</button>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import WizardCesiumMap from "../components/task/WizardCesiumMap.vue";
import { formatCoordinate, WEATHER_PRESET_OPTIONS } from "../lib/wizardScenarioBuilder";
import { DEFAULT_GROUND_STATION_ALT_KM, getWizardDraft, updateWizardDraft } from "../lib/wizardDraft";

const router = useRouter();
const draft = getWizardDraft();
const stationName = ref(draft.groundStation?.name || "地面站 GS_1");
const stationLat = ref(draft.groundStation?.lat);
const stationLon = ref(draft.groundStation?.lon);
const stationAltKm = ref(Number(draft.groundStation?.alt_km ?? DEFAULT_GROUND_STATION_ALT_KM));
const weatherPreset = ref(draft.environmentParams?.weatherPreset || "clear");
const errorText = ref("");

const groundStationMarker = computed(() => (
  stationLat.value == null || stationLon.value == null
    ? []
    : [{
        id: "GS_1",
        label: "GS_1",
        lat: stationLat.value,
        lon: stationLon.value,
        altKm: stationAltKm.value,
        color: "#ff8c69",
        pixelSize: 12,
      }]
));
const stationLatDisplay = computed(() => (
  stationLat.value == null
    ? "未选择"
    : `${formatCoordinate(Math.abs(stationLat.value))} ${stationLat.value >= 0 ? "N" : "S"}`
));
const stationLonDisplay = computed(() => (
  stationLon.value == null
    ? "未选择"
    : `${formatCoordinate(Math.abs(stationLon.value))} ${stationLon.value >= 0 ? "E" : "W"}`
));

function onMapClick(position) {
  errorText.value = "";
  stationLat.value = position.lat;
  stationLon.value = position.lon;
}

function goNext() {
  errorText.value = "";
  if (stationLat.value == null || stationLon.value == null) {
    errorText.value = "请先在地图上点击生成 GS_1 的位置。";
    return;
  }
  if (!stationName.value.trim()) {
    errorText.value = "请填写地面站名称。";
    return;
  }

  updateWizardDraft({
    groundStation: {
      id: "GS_1",
      name: stationName.value.trim(),
      lat: stationLat.value,
      lon: stationLon.value,
      alt_km: Number(stationAltKm.value || DEFAULT_GROUND_STATION_ALT_KM),
    },
    environmentParams: {
      weatherPreset: weatherPreset.value,
    },
  });
  router.push({ name: "wizard-parameters" });
}
</script>

<style scoped>
.wizard-page-section {
  max-width: 1680px;
}

.wizard-map-layout {
  grid-template-columns: minmax(0, 1.42fr) minmax(360px, 0.58fr);
  align-items: stretch;
}

.wizard-map-card,
.wizard-status-card {
  height: 100%;
}

.station-coordinate-grid,
.weather-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.station-coordinate-card,
.weather-preset-card {
  border: 1px solid var(--v2-border);
  border-radius: 14px;
  background: rgba(5, 20, 36, 0.68);
}

.station-coordinate-card {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
}

.station-coordinate-card__label {
  color: var(--v2-text-muted);
  font-size: 12px;
  letter-spacing: 0.1em;
  font-weight: 700;
}

.station-coordinate-card__label span {
  color: var(--v2-primary);
  margin-right: 6px;
}

.station-coordinate-card strong {
  color: var(--v2-text);
  font-size: 20px;
}

.weather-preset-section {
  display: grid;
  gap: 12px;
}

.weather-preset-section h3 {
  margin: 0;
}

.weather-preset-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  grid-template-areas:
    "icon label"
    "icon description";
  align-items: center;
  gap: 2px 10px;
  min-height: 82px;
  padding: 12px;
  color: var(--v2-text);
  text-align: left;
  cursor: pointer;
}

.weather-preset-card:hover,
.weather-preset-card.is-active {
  border-color: rgba(36, 179, 255, 0.7);
  background: rgba(36, 179, 255, 0.14);
}

.weather-preset-card__icon {
  grid-area: icon;
  font-size: 20px;
}

.weather-preset-card__label {
  grid-area: label;
  font-weight: 700;
}

.weather-preset-card__description {
  grid-area: description;
  color: var(--v2-text-muted);
  font-size: 12px;
}

@media (max-width: 1200px) {
  .wizard-map-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .station-coordinate-grid,
  .weather-preset-grid {
    grid-template-columns: 1fr;
  }
}
</style>
