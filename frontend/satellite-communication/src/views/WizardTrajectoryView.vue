<template>
  <ProductScaffold>
    <section class="page-section wide wizard-page-section">
      <div class="page-section__head">
        <div>
          <h1 class="page-title">步骤 2 · 飞机航线配置</h1>
        </div>
      </div>

      <div class="form-grid two-up">
        <label class="v2-field">
          <span>任务类型</span>
          <select v-model="missionType" name="missionType">
            <option value="constellation-monitoring">星座监测</option>
            <option value="handover-evaluation">切换评估</option>
            <option value="link-stress-test">链路压力测试</option>
          </select>
        </label>
        <label class="v2-field">
          <span>优先级</span>
          <select v-model="priority" name="priority">
            <option value="balanced">平衡模式</option>
            <option value="latency-first">低时延优先</option>
            <option value="capacity-first">高容量优先</option>
          </select>
        </label>
      </div>

      <div class="trajectory-layout">
        <form class="v2-helper-card stack-gap route-form" @submit.prevent="addRoute">
          <div class="route-form__head">
            <h3>新增飞机航线</h3>
            <span>{{ durationMinutes }} 分钟任务窗口</span>
          </div>

          <div class="form-grid two-up">
            <label class="v2-field">
              <span>飞机编号</span>
              <input v-model.trim="newRouteId" name="aircraftId" type="text" placeholder="例如：AC_1" />
            </label>
            <label class="v2-field">
              <span>航线进度（%）</span>
              <input v-model.number="newStartProgressPercent" name="startProgressPercent" type="number" min="0" max="100" step="1" />
            </label>
          </div>

          <div class="form-grid two-up">
            <label class="v2-field">
              <span>起始机场</span>
              <select v-model="newStartAirportCode" name="startAirport">
                <optgroup v-for="group in AIRPORT_GROUPS" :key="group.label" :label="group.label">
                  <option v-for="airport in group.airports" :key="airport.code" :value="airport.code">
                    {{ formatAirportLabel(airport) }}
                  </option>
                </optgroup>
              </select>
            </label>
            <label class="v2-field">
              <span>终点机场</span>
              <select v-model="newEndAirportCode" name="endAirport">
                <optgroup v-for="group in AIRPORT_GROUPS" :key="group.label" :label="group.label">
                  <option v-for="airport in group.airports" :key="airport.code" :value="airport.code">
                    {{ formatAirportLabel(airport) }}
                  </option>
                </optgroup>
              </select>
            </label>
          </div>

          <div class="form-grid two-up">
            <label class="v2-field">
              <span>巡航高度（km）</span>
              <input v-model.number="newCruiseAltKm" name="cruiseAltitude" type="number" min="8" max="16" step="0.1" />
            </label>
            <label class="v2-field">
              <span>业务带宽（Mbps）</span>
              <input v-model.number="newRateMbps" name="rateMbps" type="number" min="1" step="1" />
            </label>
          </div>

          <div class="route-preview">
            <span>仿真起点</span>
            <strong>{{ previewStartText }}</strong>
          </div>

          <button class="v2-button" type="submit">添加航线</button>
        </form>

        <div class="v2-helper-card stack-gap route-summary">
          <h3>当前配置</h3>
          <div class="route-summary__stats">
            <div>
              <span>飞机数量</span>
              <strong>{{ routes.length }}</strong>
            </div>
            <div>
              <span>轨迹点</span>
              <strong>{{ routeSampleCount }}</strong>
            </div>
            <div>
              <span>时长</span>
              <strong>{{ durationMinutes }} 分钟</strong>
            </div>
          </div>
          <p>飞机以固定 850 km/h 沿大圆航线飞行；抵达终点后保持巡航高度并继续通信。</p>
        </div>
      </div>

      <div v-if="routes.length" class="v2-table-card">
        <div class="v2-table-card__header">
          <span>飞机航线</span>
          <span>{{ routes.length }} 架</span>
        </div>
        <table class="v2-table route-table">
          <thead>
            <tr>
              <th>飞机</th>
              <th>航线</th>
              <th>进度</th>
              <th>高度</th>
              <th>带宽</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="route in routes" :key="route.id">
              <td>
                <strong>{{ route.id }}</strong>
                <p class="table-subline">{{ route.points.length }} 个轨迹点</p>
              </td>
              <td>
                <strong>{{ routeAirportText(route) }}</strong>
                <p class="table-subline">仿真起点 {{ formatCoordinate(route.start.lat) }} / {{ formatCoordinate(route.start.lon) }}</p>
              </td>
              <td>
                <input
                  class="route-table__input"
                  :value="route.startProgressPercent ?? 0"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  @input="onProgressChange(route.id, $event)"
                />
              </td>
              <td>
                <input
                  class="route-table__input"
                  :value="route.cruiseAltKm"
                  type="number"
                  min="8"
                  max="16"
                  step="0.1"
                  @input="onAltitudeChange(route.id, $event)"
                />
              </td>
              <td>
                <input
                  class="route-table__input"
                  :value="route.rateMbps"
                  type="number"
                  min="1"
                  step="1"
                  @input="onRateChange(route.id, $event)"
                />
              </td>
              <td>
                <button class="v2-button v2-button--tiny v2-button--ghost" @click="removeRoute(route.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <label class="v2-field">
        <span>航线备注</span>
        <textarea v-model="routeNotes" name="routeNotes" rows="5" placeholder="记录验证目标或业务背景"></textarea>
      </label>

      <div v-if="errorText" class="state-banner error">{{ errorText }}</div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'wizard-tle' })">上一步</button>
        <button class="v2-button" @click="goNext">下一步</button>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { AIRPORT_GROUPS, formatAirportLabel, getAirportByCode } from "../lib/airportCatalog";
import {
  buildAircraftRouteFromAirports,
  buildTrafficDemands,
  formatCoordinate,
  rebuildRouteWithAltitude,
} from "../lib/wizardScenarioBuilder";
import {
  DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
  DEFAULT_AIRCRAFT_RATE_MBPS,
  DEFAULT_MISSION_DURATION_MIN,
  DEFAULT_ROUTE_SAMPLE_COUNT,
  getWizardDraft,
  updateWizardDraft,
} from "../lib/wizardDraft";

const router = useRouter();
const draft = getWizardDraft();

const missionType = ref(draft.trajectoryConfig?.missionType || "constellation-monitoring");
const priority = ref(draft.trajectoryConfig?.priority || "balanced");
const routeNotes = ref(draft.trajectoryConfig?.routeNotes || "");
const routeSampleCount = Number(draft.trajectoryConfig?.routeSampleCount || DEFAULT_ROUTE_SAMPLE_COUNT);
const routes = ref(Array.isArray(draft.aircraftRoutes) ? [...draft.aircraftRoutes] : []);
const errorText = ref("");
const durationMinutes = Number(draft.simulationParams?.totalMissionDurationMin || DEFAULT_MISSION_DURATION_MIN);
const durationSeconds = durationMinutes * 60;

const newRouteId = ref("");
const newStartAirportCode = ref("TFU");
const newEndAirportCode = ref("PVG");
const newStartProgressPercent = ref(0);
const newCruiseAltKm = ref(DEFAULT_AIRCRAFT_CRUISE_ALT_KM);
const newRateMbps = ref(DEFAULT_AIRCRAFT_RATE_MBPS);

const previewRoute = computed(() => buildRouteSafely({
  id: newRouteId.value || nextAircraftId(),
  startAirportCode: newStartAirportCode.value,
  endAirportCode: newEndAirportCode.value,
  startProgressPercent: newStartProgressPercent.value,
  cruiseAltKm: newCruiseAltKm.value,
  rateMbps: newRateMbps.value,
}));
const previewStartText = computed(() => {
  const route = previewRoute.value;
  if (!route?.points?.length) {
    return "--";
  }
  const firstPoint = route.points[0];
  return `${formatCoordinate(firstPoint.lat)} / ${formatCoordinate(firstPoint.lon)}`;
});

function nextAircraftIndex() {
  const existing = routes.value
    .map((route) => Number(String(route.id || "").replace("AC_", "")))
    .filter((value) => Number.isFinite(value));
  return existing.length ? Math.max(...existing) + 1 : 1;
}

function nextAircraftId() {
  return `AC_${nextAircraftIndex()}`;
}

function routeIndexFromId(id) {
  const numeric = Number(String(id || "").replace("AC_", ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : nextAircraftIndex();
}

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function buildRouteSafely({
  id,
  startAirportCode,
  endAirportCode,
  startProgressPercent,
  cruiseAltKm,
  rateMbps,
}) {
  try {
    const route = buildAircraftRouteFromAirports({
      index: routeIndexFromId(id),
      startAirportCode,
      endAirportCode,
      startProgressPercent: clampProgress(startProgressPercent),
      durationSeconds,
      cruiseAltKm,
      sampleCount: routeSampleCount,
      rateMbps,
    });
    return {
      ...route,
      id,
    };
  } catch {
    return null;
  }
}

function validateRouteInput({ id, startAirportCode, endAirportCode, startProgressPercent, cruiseAltKm, rateMbps }) {
  if (!id.trim()) {
    return "请填写飞机编号。";
  }
  if (routes.value.some((route) => route.id === id.trim())) {
    return "飞机编号已存在，请使用不同编号。";
  }
  if (!getAirportByCode(startAirportCode) || !getAirportByCode(endAirportCode)) {
    return "请选择有效的起始机场和终点机场。";
  }
  if (startAirportCode === endAirportCode) {
    return "请选择不同的起始机场和终点机场。";
  }
  if (!Number.isFinite(Number(startProgressPercent)) || Number(startProgressPercent) < 0 || Number(startProgressPercent) > 100) {
    return "航线进度需要在 0 到 100 之间。";
  }
  if (!Number.isFinite(Number(cruiseAltKm)) || Number(cruiseAltKm) <= 0) {
    return "请填写有效的巡航高度。";
  }
  if (!Number.isFinite(Number(rateMbps)) || Number(rateMbps) <= 0) {
    return "请填写大于 0 的业务带宽。";
  }
  return "";
}

function addRoute() {
  errorText.value = "";
  const id = (newRouteId.value || nextAircraftId()).trim();
  const validationError = validateRouteInput({
    id,
    startAirportCode: newStartAirportCode.value,
    endAirportCode: newEndAirportCode.value,
    startProgressPercent: newStartProgressPercent.value,
    cruiseAltKm: newCruiseAltKm.value,
    rateMbps: newRateMbps.value,
  });
  if (validationError) {
    errorText.value = validationError;
    return;
  }

  const route = buildRouteSafely({
    id,
    startAirportCode: newStartAirportCode.value,
    endAirportCode: newEndAirportCode.value,
    startProgressPercent: newStartProgressPercent.value,
    cruiseAltKm: newCruiseAltKm.value,
    rateMbps: newRateMbps.value,
  });
  if (!route) {
    errorText.value = "航线生成失败，请检查机场选择。";
    return;
  }

  routes.value = [...routes.value, route];
  newRouteId.value = nextAircraftId();
  newStartProgressPercent.value = 0;
}

function rebuildRoute(route, patch = {}) {
  const next = {
    ...route,
    ...patch,
  };
  if (next.startAirportCode && next.endAirportCode) {
    return buildRouteSafely({
      id: next.id,
      startAirportCode: next.startAirportCode,
      endAirportCode: next.endAirportCode,
      startProgressPercent: next.startProgressPercent || 0,
      cruiseAltKm: next.cruiseAltKm,
      rateMbps: next.rateMbps,
    }) || next;
  }
  return rebuildRouteWithAltitude(next, durationSeconds, routeSampleCount);
}

function onProgressChange(routeId, event) {
  const nextProgress = Number(event.target.value);
  routes.value = routes.value.map((route) => (
    route.id === routeId
      ? rebuildRoute(route, { startProgressPercent: clampProgress(nextProgress) })
      : route
  ));
}

function onAltitudeChange(routeId, event) {
  const nextAlt = Number(event.target.value);
  routes.value = routes.value.map((route) => (
    route.id === routeId
      ? rebuildRoute(route, {
          cruiseAltKm: Number.isFinite(nextAlt) ? nextAlt : DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
        })
      : route
  ));
}

function onRateChange(routeId, event) {
  const nextRate = Number(event.target.value);
  routes.value = routes.value.map((route) => (
    route.id === routeId
      ? { ...route, rateMbps: Number.isFinite(nextRate) ? nextRate : DEFAULT_AIRCRAFT_RATE_MBPS }
      : route
  ));
}

function removeRoute(routeId) {
  routes.value = routes.value.filter((route) => route.id !== routeId);
}

function routeAirportText(route) {
  const startAirport = getAirportByCode(route.startAirportCode);
  const endAirport = getAirportByCode(route.endAirportCode);
  if (startAirport && endAirport) {
    return `${startAirport.city}${startAirport.name} → ${endAirport.city}${endAirport.name}`;
  }
  return `${formatCoordinate(route.origin?.lat ?? route.start.lat)} / ${formatCoordinate(route.origin?.lon ?? route.start.lon)} → ${formatCoordinate(route.end.lat)} / ${formatCoordinate(route.end.lon)}`;
}

function validateRoutesForSubmit() {
  if (!routes.value.length) {
    return "请至少添加 1 条飞机航线。";
  }
  if (routes.value.some((route) => !route.rateMbps || route.rateMbps <= 0)) {
    return "每架飞机都需要填写大于 0 的业务带宽。";
  }
  if (routes.value.some((route) => !Array.isArray(route.points) || route.points.length < 2)) {
    return "每条航线都需要包含有效轨迹。";
  }
  return "";
}

function goNext() {
  errorText.value = "";
  const validationError = validateRoutesForSubmit();
  if (validationError) {
    errorText.value = validationError;
    return;
  }

  updateWizardDraft({
    aircraftRoutes: routes.value,
    trafficDemands: buildTrafficDemands(routes.value, "GS_1"),
    trajectoryConfig: {
      missionType: missionType.value,
      aircraftCount: routes.value.length,
      priority: priority.value,
      routeNotes: routeNotes.value,
      cruiseAltKm: DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
      routeSampleCount,
    },
  });
  router.push({ name: "wizard-ground-stations" });
}

if (!newRouteId.value) {
  newRouteId.value = nextAircraftId();
}
</script>

<style scoped>
.wizard-page-section {
  max-width: 1820px;
}

.trajectory-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.32fr) minmax(320px, 0.68fr);
  gap: 18px;
  align-items: stretch;
}

.route-form,
.route-summary {
  height: 100%;
}

.route-form__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.route-form__head h3,
.route-summary h3 {
  margin: 0;
}

.route-form__head span {
  color: var(--v2-text-muted);
  font-size: 13px;
}

.route-preview {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid rgba(137, 206, 255, 0.16);
  background: rgba(5, 20, 36, 0.44);
}

.route-preview span,
.route-summary__stats span {
  color: var(--v2-text-muted);
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.route-preview strong {
  font-size: 18px;
}

.route-summary__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.route-summary__stats div {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid rgba(137, 206, 255, 0.12);
  background: rgba(5, 20, 36, 0.4);
}

.route-summary__stats strong {
  font-size: 24px;
}

.route-summary p {
  margin: 0;
  color: var(--v2-text-muted);
  line-height: 1.7;
}

.route-table__input {
  width: 110px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(5, 20, 36, 0.92);
  color: var(--v2-text);
  border-radius: 10px;
  padding: 9px 10px;
}

@media (max-width: 1200px) {
  .trajectory-layout {
    grid-template-columns: 1fr;
  }

  .route-summary__stats {
    grid-template-columns: 1fr;
  }
}
</style>
