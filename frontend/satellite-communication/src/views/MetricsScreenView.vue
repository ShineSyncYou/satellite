<template>
  <div class="metrics-root">
    <header class="metrics-header">
      <div class="header-left">
        <h1>链路参数副屏</h1>
        <p>场景：<strong>{{ activeScenarioLabel }}</strong> · 时刻：<strong>{{ formattedTime }}</strong> · 速率：<strong>{{ playbackText }}</strong></p>
      </div>
      <div class="header-right">
        <button type="button" @click="openMainScreen">打开3D主屏</button>
        <span class="sync-badge" :class="{ online: state.channelOnline }">{{ syncStatusText }}</span>
      </div>
    </header>

    <main class="metrics-content">
      <div v-if="state.error" class="state-box error">{{ state.error }}</div>
      <div v-else-if="state.loading" class="state-box">正在加载 {{ activeScenarioLabel }} 场景参数...</div>
      <section v-else class="dashboard-grid">
        <section class="column left-column">
          <article class="panel mini-map-panel">
            <header class="panel-header"><h2>态势小地图</h2><span>2D</span></header>
            <div id="metricsMiniMap" class="mini-map-container"></div>
          </article>

          <article class="panel ground-panel">
            <header class="panel-header"><h2>地面站信息</h2><span>{{ groundStationInfo.id || "--" }}</span></header>
            <div class="ground-main">
              <div class="ground-art">
                <img
                  class="radar-model"
                  src="/pictures/ground-station.webp"
                  alt="地面站天线"
                  decoding="async"
                >
              </div>
              <div class="ground-metrics">
                <p><span>位置</span><strong>{{ groundStationInfo.positionText }}</strong></p>
                <p><span>天气</span><strong>{{ weatherText }}</strong></p>
                <p><span>平均端到端丢包率</span><strong>{{ groundStationInfo.lossText }}</strong></p>
                <p><span>当前有效带宽</span><strong>{{ groundStationInfo.bandwidthText }}</strong></p>
                <p><span>接入飞机节点</span><strong>{{ groundStationInfo.connectedAircraftCount }}</strong></p>
              </div>
            </div>
            <div class="ground-chart-stack">
              <div id="groundBandwidthChart" class="ground-chart"></div>
              <div id="groundLossChart" class="ground-chart"></div>
            </div>
          </article>
        </section>

        <section class="column middle-column">
          <article class="panel list-panel">
            <header class="panel-header"><h2>参与路由卫星</h2><span>{{ satelliteRows.length }} 颗</span></header>
            <div v-if="satelliteRows.length === 0" class="empty-tip">当前时刻无参与路由卫星</div>
            <div v-else class="entity-list">
              <article v-for="sat in satelliteRows" :key="sat.id" class="entity-card sat-card">
                <div class="entity-head"><h3>{{ sat.id }}</h3><span class="tag">{{ sat.linkCount }} 链路连接数量</span></div>
                <div class="entity-grid">
                  <p><span>位置</span><strong>{{ sat.positionText }}</strong></p>
                  <p><span>高度</span><strong>{{ sat.altitudeText }}</strong></p>
                  <p><span>关联链路</span><strong>{{ sat.linkCount }}</strong></p>
                  <p><span>当前发送带宽</span><strong>{{ sat.txRateText }}</strong></p>
                  <p><span>平均利用率</span><strong>{{ sat.utilizationText }}</strong></p>
                </div>
              </article>
            </div>
          </article>
        </section>

        <section class="column right-column">
          <article class="panel list-panel">
            <header class="panel-header"><h2>飞机信息</h2><span>{{ aircraftRows.length }} 架</span></header>
            <div v-if="aircraftRows.length === 0" class="empty-tip">当前场景无飞机数据</div>
            <div v-else class="entity-list">
              <article v-for="ac in aircraftRows" :key="ac.id" class="entity-card ac-card">
                <div class="entity-head">
                  <h3>{{ ac.routeTitle }}</h3>
                  <span class="tag" :class="{ active: ac.connected }">{{ ac.connected ? "在线" : "离线" }}</span>
                </div>
                <div class="entity-grid aircraft-meta-grid">
                  <p><span>位置</span><strong>{{ ac.positionText }}</strong></p>
                  <p><span>高度</span><strong>{{ ac.altitudeText }}</strong></p>
                </div>
                <div class="aircraft-chart-grid">
                  <div
                    v-for="metric in AIRCRAFT_METRIC_OPTIONS"
                    :key="`${ac.id}-${metric.key}`"
                    class="aircraft-chart-cell"
                  >
                    <div class="aircraft-chart-title">{{ metric.title }}</div>
                    <div class="aircraft-mini-chart" :ref="getAircraftMiniChartRef(ac.id, metric.key)"></div>
                  </div>
                </div>
              </article>
            </div>
          </article>
        </section>
      </section>
    </main>
  </div>
</template>

<script setup>
import * as Cesium from "cesium";
import * as echarts from "echarts";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import loadSatsimScenario from "../lib/loadSatsimScenario";
// 副屏图表直接消费 bundle.json，而不是从 CZML 里反向解析业务数据。
import { loadSatsimBundleSource } from "../lib/bundleRouteMetrics";
import { normalizeTerminalOnlyRoute } from "../lib/routePathPolicy";
import { getScenarioRecordSync, listRunnableScenarioRecords, refreshServerScenarioRecords, resolveScenarioRuntime } from "../lib/runtimeScenarioCatalog";
import {
  createScreenSyncChannel,
  postScreenSyncMessage,
  SCREEN_SYNC_MESSAGE_TYPES,
} from "../lib/screenSync";
import {
  applyGlobeImageryLayers,
  bindAmapImageryFallback,
  bindGlobeImageryNetworkSync,
} from "../lib/offlineImagery.js";
import { openMainScreenWindow } from "../lib/openScreenWindow";
import "../Widgets/widgets.css";

const DASHBOARD_UPDATE_THROTTLE_MS = 250;
const CHART_PUSH_MIN_INTERVAL_MS = 500;
const CHART_MAX_POINTS = 600;
const AIRCRAFT_METRIC_OPTIONS = Object.freeze([
  { key: "bw", title: "有效带宽", color: "#7c6cff" },
  { key: "latency", title: "时延", color: "#22d3ee" },
  { key: "ber", title: "BER", color: "#34d399" },
  { key: "hop", title: "跳数", color: "#f59e0b" },
]);

const initialScenarioKey = new URLSearchParams(window.location.search).get("scenario") || "";
const state = reactive({ scenarioKey: initialScenarioKey, durationS: 0, currentTimeS: 0, playbackMultiplier: 6, shouldAnimate: true, loading: false, error: "", channelOnline: false, primaryDisconnected: false, primaryExited: false });
const satelliteRows = ref([]);
const aircraftRows = ref([]);
const groundStationInfo = ref({ id: "", positionText: "--", bandwidthText: "--", lossText: "--", connectedAircraftCount: 0, lossRaw: null, bandwidthRaw: null, latitude: null, longitude: null });
const currentScenarioRuntime = ref(null);
let currentScenarioBundle = null;
const weatherText = ref("--");

let screenSyncChannel = null;
let loadSequence = 0;
let lastDashboardRenderAtMs = Number.NEGATIVE_INFINITY;
let lastChartPushAtMs = Number.NEGATIVE_INFINITY;
let groundChartBootstrapTimeoutIds = [];

let nodeTracksById = new Map();
let nodeTypeById = new Map();
let topologyEvents = [];
let routeEvents = [];
let allAircraftIds = [];
let groundStationId = "";

const sim = { lastTime: -1, topologyIndex: 0, routeIndex: 0, activeTopology: new Map(), activeRoutes: new Map() };

let miniViewer = null;
let miniScenarioHandle = null;
let groundBandwidthChart = null;
let groundLossChart = null;
const miniImageryCleanup = { networkSync: null, fallback: null };
const groundChartSeries = { time: [], loss: [], bw: [], buckets: [] };
const groundChartPinnedTimeByKey = new Map();
const aircraftMiniChartHosts = new Map();
const aircraftMiniCharts = new Map();
const aircraftChartSeriesById = new Map();
const aircraftChartRefHandlers = new Map();
const aircraftChartPinnedTimeByKey = new Map();

const activeScenarioLabel = computed(() => getScenarioRecordSync(state.scenarioKey)?.title || state.scenarioKey || "未选择场景");
const formattedTime = computed(() => formatClockText(state.currentTimeS));
const playbackText = computed(() => `${Number(state.playbackMultiplier || 0).toFixed(2)}x`);
const syncStatusText = computed(() => {
  if (state.channelOnline) return "已连接主屏";
  if (state.primaryExited) return "主屏已退出";
  return state.primaryDisconnected ? "主屏已断连" : "等待主屏连接";
});

const nowMs = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

function normalizeRelativeTime(relativeTimeS, durationS) {
  const t = Number(relativeTimeS);
  const d = Number(durationS);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(d) || d <= 0) return t;
  if (t < d) return t;
  const r = t % d;
  return Math.abs(r) < 1e-9 ? d : r;
}

function formatClockText(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function formatNum(value, digits = 2, suffix = "") { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : "--"; }
function sortByRelativeTime(items) { return [...(items || [])].sort((a, b) => Number(a.relative_time_s) - Number(b.relative_time_s)); }

function routeActualTxBandwidth(route) {
  const actual = Number(route?.actual_tx_bandwidth_mbps);
  if (Number.isFinite(actual)) return Math.max(0, actual);
  const effective = Number(route?.effective_bandwidth_mbps);
  return Number.isFinite(effective) ? Math.max(0, effective) : 0;
}

function findActiveTopologyLink(source, target) {
  for (const link of sim.activeTopology.values()) {
    if ((link.source === source && link.target === target) || (link.source === target && link.target === source)) {
      return link;
    }
  }
  return null;
}

function resetSimState() {
  // 回放从头（或场景切换）时，增量状态需要重置。
  sim.lastTime = -1;
  sim.topologyIndex = 0;
  sim.routeIndex = 0;
  sim.activeTopology.clear();
  sim.activeRoutes.clear();
}

function applyTopologyEvent(event) {
  // 维护当前时刻生效的拓扑链路集合。
  if (event.event_kind === "snapshot") sim.activeTopology.clear();
  for (const link of event.links_upsert || []) {
    sim.activeTopology.set(`${link.source}|${link.target}|${link.type}`, {
      source: String(link.source), target: String(link.target), type: String(link.type || ""),
      bandwidth_mbps: Number(link.bandwidth_mbps), tx_rate_mbps: Number(link.tx_rate_mbps), utilization: Number(link.utilization),
    });
  }
  for (const link of event.links_remove || []) sim.activeTopology.delete(`${link.source}|${link.target}|${link.type}`);
}

function applyRouteEvent(event) {
  // 维护当前时刻生效的业务路由集合。
  if (event.event_kind === "snapshot") sim.activeRoutes.clear();
  for (const route of event.routes || []) {
    const normalizedRoute = normalizeTerminalOnlyRoute(route, nodeTypeById);
    sim.activeRoutes.set(`${route.source}|${route.target}`, {
      source: String(route.source), target: String(route.target), connected: normalizedRoute.connected, path: normalizedRoute.path,
      hop_count: Number(route.hop_count), requested_bandwidth_mbps: Number(route.requested_bandwidth_mbps),
      actual_tx_bandwidth_mbps: Number(route.actual_tx_bandwidth_mbps), dropped_bandwidth_mbps: Number(route.dropped_bandwidth_mbps),
      effective_bandwidth_mbps: Number(route.effective_bandwidth_mbps), latency_ms: Number(route.latency_ms),
      packet_loss_rate: Number(route.packet_loss_rate), ber: Number(route.ber),
    });
  }
}

function advanceSimToTime(relativeTimeS) {
  // 仅前推到当前时刻，避免每帧全量扫描全部事件。
  if (sim.lastTime >= 0 && relativeTimeS + 1e-9 < sim.lastTime) resetSimState();
  while (sim.topologyIndex < topologyEvents.length && Number(topologyEvents[sim.topologyIndex].relative_time_s) <= relativeTimeS + 1e-9) {
    applyTopologyEvent(topologyEvents[sim.topologyIndex]);
    sim.topologyIndex += 1;
  }
  while (sim.routeIndex < routeEvents.length && Number(routeEvents[sim.routeIndex].relative_time_s) <= relativeTimeS + 1e-9) {
    applyRouteEvent(routeEvents[sim.routeIndex]);
    sim.routeIndex += 1;
  }
  sim.lastTime = relativeTimeS;
}

function interpolateTrack(track, relativeTimeS) {
  // 在轨迹采样点之间做线性插值，得到当前经纬高。
  const samples = track?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const t = Number(relativeTimeS);
  if (!Number.isFinite(t)) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t <= Number(first.relative_time_s)) return { latDeg: Number(first.lat_deg), lonDeg: Number(first.lon_deg), altKm: Number(first.alt_km) };
  if (t >= Number(last.relative_time_s)) return { latDeg: Number(last.lat_deg), lonDeg: Number(last.lon_deg), altKm: Number(last.alt_km) };

  let left = 0; let right = samples.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (Number(samples[mid].relative_time_s) < t) left = mid + 1;
    else right = mid - 1;
  }
  const hi = Math.min(samples.length - 1, left);
  const lo = Math.max(0, hi - 1);
  const s0 = samples[lo]; const s1 = samples[hi];
  const t0 = Number(s0.relative_time_s); const t1 = Number(s1.relative_time_s);
  const ratio = Math.abs(t1 - t0) < 1e-9 ? 0 : (t - t0) / (t1 - t0);
  return {
    latDeg: Number(s0.lat_deg) + (Number(s1.lat_deg) - Number(s0.lat_deg)) * ratio,
    lonDeg: Number(s0.lon_deg) + (Number(s1.lon_deg) - Number(s0.lon_deg)) * ratio,
    altKm: Number(s0.alt_km) + (Number(s1.alt_km) - Number(s0.alt_km)) * ratio,
  };
}

function posText(position) { return position ? `${position.lonDeg.toFixed(3)}°, ${position.latDeg.toFixed(3)}°` : "--"; }

function teardownViewerImagery(cleanup) {
  if (cleanup.networkSync) {
    cleanup.networkSync();
    cleanup.networkSync = null;
  }
  if (cleanup.fallback) {
    cleanup.fallback();
    cleanup.fallback = null;
  }
}

function setupViewerImagery(viewer, cleanup) {
  void applyGlobeImageryLayers(viewer).then(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    teardownViewerImagery(cleanup);
    cleanup.networkSync = bindGlobeImageryNetworkSync(viewer);
    cleanup.fallback = bindAmapImageryFallback(viewer);
  });
}

async function initMiniMap() {
  // 副屏左上角小地图：复用主工程的 miniMode 渲染能力。
  await nextTick();
  const host = document.getElementById("metricsMiniMap");
  if (!host) return;

  const miniViewerHostChanged = miniViewer && !miniViewer.isDestroyed() && miniViewer.container !== host;
  if (miniViewerHostChanged) {
    if (miniScenarioHandle) {
      miniScenarioHandle.cleanup();
      miniScenarioHandle = null;
    }
    teardownViewerImagery(miniImageryCleanup);
    miniViewer.destroy();
    miniViewer = null;
  }

  if (!miniViewer || miniViewer.isDestroyed()) {
    miniViewer = new Cesium.Viewer(host, {
      animation: false, baseLayerPicker: false, fullscreenButton: false, geocoder: false, homeButton: false, infoBox: false,
      navigationHelpButton: false, sceneMode: Cesium.SceneMode.SCENE2D, sceneModePicker: false, selectionIndicator: false, timeline: false,
      shouldAnimate: false, requestRenderMode: true, terrainProvider: new Cesium.EllipsoidTerrainProvider(), imageryProvider: false,
    });
    miniViewer.cesiumWidget.creditContainer.style.display = "none";
    miniViewer.scene.screenSpaceCameraController.enableTilt = false;
    miniViewer.scene.screenSpaceCameraController.enableLook = false;
    miniViewer.scene.screenSpaceCameraController.enableRotate = false;
    setupViewerImagery(miniViewer, miniImageryCleanup);
    miniViewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(104.0, 35.0, 7600000), duration: 0 });
  }
  if (miniScenarioHandle) miniScenarioHandle.cleanup();
  if (!currentScenarioRuntime.value || !currentScenarioBundle) return;
  miniScenarioHandle = await loadSatsimScenario({
    viewer: miniViewer, czmlSource: currentScenarioRuntime.value.czmlSource, bundleSource: currentScenarioBundle, miniMode: true, showCoverage: false, showLabels: false, showSatelliteModel: false,
    maxAircraft: 10, maxGroundStations: 1, showTopologyLinks: true, playbackMultiplier: 1,
  });
  syncMiniMapTime(true);
  miniViewer.resize();
  miniViewer.scene.requestRender();
}

function syncMiniMapTime(force = false) {
  if (!miniViewer || miniViewer.isDestroyed() || !miniScenarioHandle?.bundle?.startJulian) return;
  const current = Cesium.JulianDate.addSeconds(miniScenarioHandle.bundle.startJulian, Number(state.currentTimeS || 0), new Cesium.JulianDate());
  Cesium.JulianDate.clone(current, miniViewer.clock.currentTime);
  miniViewer.clock.shouldAnimate = false;
  if (force || miniViewer.scene.requestRenderMode) miniViewer.scene.requestRender();
}

function ensureGroundCharts() {
  const bwHost = document.getElementById("groundBandwidthChart");
  const lossHost = document.getElementById("groundLossChart");
  if (bwHost) {
    if (groundBandwidthChart && groundBandwidthChart.getDom() !== bwHost) {
      groundBandwidthChart.dispose();
      groundBandwidthChart = null;
    }
    if (!groundBandwidthChart) {
      groundBandwidthChart = echarts.init(bwHost, null, { renderer: "canvas" });
      bindGroundChartInteractions("bw", groundBandwidthChart);
    }
  }
  if (lossHost) {
    if (groundLossChart && groundLossChart.getDom() !== lossHost) {
      groundLossChart.dispose();
      groundLossChart = null;
    }
    if (!groundLossChart) {
      groundLossChart = echarts.init(lossHost, null, { renderer: "canvas" });
      bindGroundChartInteractions("loss", groundLossChart);
    }
  }
}

function groundChartByMetric(metricKey) {
  return metricKey === "bw" ? groundBandwidthChart : groundLossChart;
}

function clearPinnedGroundTooltip(metricKey) {
  const chart = groundChartByMetric(metricKey);
  groundChartPinnedTimeByKey.delete(metricKey);
  if (!chart) return;
  chart.setOption({
    tooltip: {
      triggerOn: "mousemove|click",
      alwaysShowContent: false,
    },
  });
  chart.dispatchAction({ type: "hideTip" });
}

function restorePinnedGroundTooltip(metricKey) {
  const chart = groundChartByMetric(metricKey);
  const pinnedTime = groundChartPinnedTimeByKey.get(metricKey);
  if (!chart || !Number.isFinite(pinnedTime)) return;

  let dataIndex = groundChartSeries.time.findIndex((time) => Math.abs(Number(time) - pinnedTime) < 1e-6);
  if (dataIndex < 0) {
    const pinnedBucket = chartBucketForTime(pinnedTime);
    if (pinnedBucket != null) {
      dataIndex = groundChartSeries.buckets.findIndex((bucket) => bucket === pinnedBucket);
    }
  }
  if (dataIndex < 0) {
    clearPinnedGroundTooltip(metricKey);
    return;
  }
  chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex });
}

function pinGroundTooltip(metricKey, params) {
  const chart = groundChartByMetric(metricKey);
  const pinnedTime = Number(params?.data?.[0]);
  if (!chart || !Number.isFinite(pinnedTime)) return;

  groundChartPinnedTimeByKey.set(metricKey, pinnedTime);
  chart.setOption({
    tooltip: {
      triggerOn: "none",
      alwaysShowContent: true,
    },
  });
  restorePinnedGroundTooltip(metricKey);
}

function bindGroundChartInteractions(metricKey, chart) {
  chart.on("click", (params) => {
    if (params?.componentType !== "series" || !Number.isInteger(params?.dataIndex)) return;
    pinGroundTooltip(metricKey, params);
  });
  chart.getZr().on("click", (event) => {
    if (event?.target) return;
    clearPinnedGroundTooltip(metricKey);
  });
}

function clearGroundChartBootstrapTimers() {
  if (groundChartBootstrapTimeoutIds.length === 0) return;
  for (const timeoutId of groundChartBootstrapTimeoutIds) window.clearTimeout(timeoutId);
  groundChartBootstrapTimeoutIds = [];
}

function scheduleGroundChartBootstrap(sequenceToken) {
  clearGroundChartBootstrapTimers();

  const runOnce = () => {
    if (sequenceToken !== loadSequence) return;
    ensureGroundCharts();
    renderGroundCharts();
    if (groundBandwidthChart) groundBandwidthChart.resize();
    if (groundLossChart) groundLossChart.resize();
  };

  runOnce();
  for (const delayMs of [120, 320, 680]) {
    const timeoutId = window.setTimeout(() => { runOnce(); }, delayMs);
    groundChartBootstrapTimeoutIds.push(timeoutId);
  }
}

function renderGroundBandwidthChart() {
  if (!groundBandwidthChart) return;
  const data = groundChartSeries.time.map((t, i) => [t, groundChartSeries.bw[i]]);
  const completeOption = {
    backgroundColor: "transparent",
    animation: false,
    title: {
      text: "bandwidth",
      top: 2,
      left: 8,
      textStyle: { color: "#bdd7f2", fontSize: 11, fontWeight: 500 },
    },
    grid: { left: 52, right: 20, top: 24, bottom: 28 },
    tooltip: {
      trigger: "axis",
      triggerOn: "mousemove|click",
      alwaysShowContent: false,
      renderMode: "html",
      appendToBody: true,
      confine: false,
      className: "metrics-echarts-tooltip",
      extraCssText: "z-index:99999;pointer-events:none;",
      valueFormatter: (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)} Mbps` : "--"),
    },
    xAxis: {
      type: "value",
      min: 0,
      max: Number(state.durationS || 0),
      splitNumber: 4,
      axisLabel: { color: "#9fb2c5", fontSize: 10, formatter: (v) => formatClockText(v), hideOverlap: true },
      axisLine: { lineStyle: { color: "#2d4a67" } },
      splitLine: { lineStyle: { color: "rgba(86,132,168,0.22)" } },
    },
    yAxis: {
      type: "value",
      splitNumber: 3,
      axisLabel: { color: "#9fb2c5", fontSize: 10, hideOverlap: true },
      axisLine: { lineStyle: { color: "#2d4a67" } },
      splitLine: { lineStyle: { color: "rgba(86,132,168,0.22)" } },
    },
    series: [{
      id: "ground-bw",
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.2, color: "#7c6cff" },
      data,
    }],
  };
  const existingSeries = groundBandwidthChart.getOption()?.series;
  if (!Array.isArray(existingSeries) || existingSeries.length === 0) {
    groundBandwidthChart.setOption(completeOption);
  } else {
    groundBandwidthChart.setOption({
      xAxis: { max: Number(state.durationS || 0) },
      series: [{ id: "ground-bw", data }],
    }, { lazyUpdate: true, silent: true });
  }
  restorePinnedGroundTooltip("bw");
}

function renderGroundLossChart() {
  if (!groundLossChart) return;
  const data = groundChartSeries.time.map((t, i) => [t, groundChartSeries.loss[i]]);
  const completeOption = {
    backgroundColor: "transparent",
    animation: false,
    title: {
      text: "loss",
      top: 2,
      left: 8,
      textStyle: { color: "#bdd7f2", fontSize: 11, fontWeight: 500 },
    },
    grid: { left: 66, right: 20, top: 24, bottom: 28 },
    tooltip: {
      trigger: "axis",
      triggerOn: "mousemove|click",
      alwaysShowContent: false,
      renderMode: "html",
      appendToBody: true,
      confine: false,
      className: "metrics-echarts-tooltip",
      extraCssText: "z-index:99999;pointer-events:none;",
      valueFormatter: (v) => (Number.isFinite(Number(v)) ? Number(v).toExponential(2) : "--"),
    },
    xAxis: {
      type: "value",
      min: 0,
      max: Number(state.durationS || 0),
      splitNumber: 4,
      axisLabel: { color: "#9fb2c5", fontSize: 10, formatter: (v) => formatClockText(v), hideOverlap: true },
      axisLine: { lineStyle: { color: "#2d4a67" } },
      splitLine: { lineStyle: { color: "rgba(86,132,168,0.22)" } },
    },
    yAxis: {
      type: "value",
      splitNumber: 3,
      axisLabel: { color: "#9fb2c5", fontSize: 10, hideOverlap: true, formatter: (v) => Number(v).toExponential(1) },
      axisLine: { lineStyle: { color: "#2d4a67" } },
      splitLine: { lineStyle: { color: "rgba(86,132,168,0.22)" } },
    },
    series: [{
      id: "ground-loss",
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.1, color: "#ff6b6b" },
      data,
    }],
  };
  const existingSeries = groundLossChart.getOption()?.series;
  if (!Array.isArray(existingSeries) || existingSeries.length === 0) {
    groundLossChart.setOption(completeOption);
  } else {
    groundLossChart.setOption({
      xAxis: { max: Number(state.durationS || 0) },
      series: [{ id: "ground-loss", data }],
    }, { lazyUpdate: true, silent: true });
  }
  restorePinnedGroundTooltip("loss");
}

function renderGroundCharts() {
  renderGroundBandwidthChart();
  renderGroundLossChart();
}

function clearChartSeriesData(series) {
  series.time = [];
  series.buckets = [];
  for (const key of Object.keys(series)) {
    if (key !== "time" && key !== "buckets" && Array.isArray(series[key])) {
      series[key] = [];
    }
  }
}

function chartBucketForTime(relativeTimeS) {
  const durationS = Number(state.durationS);
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const bucketWidthS = durationS / Math.max(1, CHART_MAX_POINTS - 1);
  return Math.min(
    CHART_MAX_POINTS - 1,
    Math.max(0, Math.floor(Number(relativeTimeS) / Math.max(bucketWidthS, Number.EPSILON))),
  );
}

function upsertChartPoint(series, relativeTimeS, values) {
  const timeS = Number(relativeTimeS);
  if (!Number.isFinite(timeS)) return;
  const lastTimeS = series.time[series.time.length - 1];
  if (Number.isFinite(lastTimeS) && timeS + 1e-9 < lastTimeS) {
    clearChartSeriesData(series);
  }

  if (series.time.length === 0 && timeS > 0) {
    series.time.push(0);
    series.buckets.push(0);
    for (const key of Object.keys(values)) series[key].push(0);
  }

  const configuredBucket = chartBucketForTime(timeS);
  const bucket = configuredBucket == null
    ? (series.buckets[series.buckets.length - 1] ?? -1) + 1
    : configuredBucket;
  const lastIndex = series.time.length - 1;
  const replaceLast = lastIndex >= 0 && series.buckets[lastIndex] === bucket;

  if (replaceLast) {
    series.time[lastIndex] = timeS;
    for (const [key, value] of Object.entries(values)) series[key][lastIndex] = value;
  } else {
    series.time.push(timeS);
    series.buckets.push(bucket);
    for (const [key, value] of Object.entries(values)) series[key].push(value);
  }

  if (series.time.length > CHART_MAX_POINTS) {
    series.time.shift();
    series.buckets.shift();
    for (const key of Object.keys(values)) series[key].shift();
  }
}

function resetGroundCharts() {
  groundChartPinnedTimeByKey.clear();
  clearChartSeriesData(groundChartSeries);
  lastChartPushAtMs = Number.NEGATIVE_INFINITY;
  renderGroundCharts();
}

function pushGroundPoint(relativeTimeS, lossValue, bwValue) {
  upsertChartPoint(groundChartSeries, relativeTimeS, {
    loss: Number.isFinite(lossValue) ? lossValue : null,
    bw: Number.isFinite(bwValue) ? bwValue : null,
  });
}

function rebuildGroundInfo(relativeTimeS) {
  if (!groundStationId) {
    groundStationInfo.value = { id: "", positionText: "--", bandwidthText: "--", lossText: "--", connectedAircraftCount: 0, lossRaw: null, bandwidthRaw: null, latitude: null, longitude: null };
    return;
  }

  const gsPosition = interpolateTrack(nodeTracksById.get(groundStationId), relativeTimeS);
  const gsRoutes = [...sim.activeRoutes.values()].filter((route) => (
    route.connected
    && Array.isArray(route.path)
    && route.path[route.path.length - 1] === groundStationId
  ));

  const routeEffectiveSum = gsRoutes.reduce((sum, route) => sum + (Number.isFinite(Number(route.effective_bandwidth_mbps)) ? Number(route.effective_bandwidth_mbps) : 0), 0);
  const totalBw = routeEffectiveSum;
  const lossSamples = gsRoutes.map((route) => Number(route.packet_loss_rate)).filter((v) => Number.isFinite(v));
  const avgLoss = lossSamples.length > 0 ? lossSamples.reduce((sum, value) => sum + value, 0) / lossSamples.length : NaN;
  const connectedAircraftIds = new Set();
  for (const route of gsRoutes) {
    if (Array.isArray(route.path)) {
      for (const nodeId of route.path) {
        if (nodeTypeById.get(nodeId) === "aircraft") {
          connectedAircraftIds.add(nodeId);
        }
      }
    }
    if (nodeTypeById.get(route.source) === "aircraft") connectedAircraftIds.add(route.source);
    if (nodeTypeById.get(route.target) === "aircraft") connectedAircraftIds.add(route.target);
  }

  groundStationInfo.value = {
    id: groundStationId,
    positionText: posText(gsPosition),
    bandwidthText: formatNum(totalBw, 2, " Mbps"),
    lossText: Number.isFinite(avgLoss) ? `${(avgLoss * 100).toFixed(2)}%` : "--",
    connectedAircraftCount: connectedAircraftIds.size,
    lossRaw: Number.isFinite(avgLoss) ? avgLoss : null,
    bandwidthRaw: Number.isFinite(totalBw) ? totalBw : null,
    latitude: gsPosition ? gsPosition.latDeg : null,
    longitude: gsPosition ? gsPosition.lonDeg : null,
  };
}

function rebuildSatelliteRows(relativeTimeS) {
  const activeSatelliteIds = new Set();
  const routeCountBySatellite = new Map();
  for (const route of sim.activeRoutes.values()) {
    if (!route.connected || !Array.isArray(route.path)) continue;
    for (const nodeId of route.path) {
      if (nodeTypeById.get(nodeId) !== "satellite") continue;
      activeSatelliteIds.add(nodeId);
      routeCountBySatellite.set(nodeId, (routeCountBySatellite.get(nodeId) || 0) + 1);
    }
  }

  const linkStats = new Map();
  for (const link of sim.activeTopology.values()) {
    const update = (nodeId) => {
      if (!activeSatelliteIds.has(nodeId)) return;
      const prev = linkStats.get(nodeId) || { linkCount: 0, outgoingByLink: new Map() };
      prev.linkCount += 1;
      linkStats.set(nodeId, prev);
    };
    update(link.source);
    update(link.target);
  }

  for (const route of sim.activeRoutes.values()) {
    if (!route.connected || !Array.isArray(route.path)) continue;
    const actualTx = routeActualTxBandwidth(route);
    for (let index = 0; index < route.path.length - 1; index += 1) {
      const nodeId = route.path[index];
      if (nodeTypeById.get(nodeId) !== "satellite") continue;
      const peerId = route.path[index + 1];
      const link = findActiveTopologyLink(nodeId, peerId);
      if (!link) continue;
      const stats = linkStats.get(nodeId) || { linkCount: 0, outgoingByLink: new Map() };
      const linkId = `${link.source}|${link.target}|${link.type}`;
      const outgoing = stats.outgoingByLink.get(linkId) || { rate: 0, capacity: Number(link.bandwidth_mbps) };
      outgoing.rate += actualTx;
      stats.outgoingByLink.set(linkId, outgoing);
      linkStats.set(nodeId, stats);
    }
  }

  const rows = [...activeSatelliteIds].map((id) => {
    const position = interpolateTrack(nodeTracksById.get(id), relativeTimeS);
    const stats = linkStats.get(id) || { linkCount: 0, outgoingByLink: new Map() };
    const outgoingLinks = [...stats.outgoingByLink.values()];
    const txSum = outgoingLinks.reduce((sum, link) => sum + link.rate, 0);
    const capacitySum = outgoingLinks.reduce((sum, link) => sum + (Number.isFinite(link.capacity) ? link.capacity : 0), 0);
    const avgUtil = capacitySum > 0 ? txSum / capacitySum : NaN;
    return {
      id,
      routeCount: routeCountBySatellite.get(id) || 0,
      positionText: posText(position),
      altitudeText: position ? `${position.altKm.toFixed(2)} km` : "--",
      linkCount: stats.linkCount,
      txRateText: formatNum(txSum, 1, " Mbps"),
      utilizationText: Number.isFinite(avgUtil) ? `${(avgUtil * 100).toFixed(1)}%` : "--",
      sortRouteCount: routeCountBySatellite.get(id) || 0,
      sortTx: txSum,
    };
  });

  rows.sort((a, b) => (b.sortRouteCount - a.sortRouteCount) || (Number(b.sortTx || 0) - Number(a.sortTx || 0)));
  satelliteRows.value = rows.slice(0, 120);
}

function routeForAircraft(aircraftId) {
  const candidates = [...sim.activeRoutes.values()].filter((route) => route.connected && Array.isArray(route.path) && route.path.includes(aircraftId));
  if (candidates.length === 0) return null;
  const withGround = candidates.find((route) => groundStationId && route.path.includes(groundStationId));
  return withGround || candidates[0];
}

function ensureAircraftSeries(id) {
  if (!aircraftChartSeriesById.has(id)) {
    aircraftChartSeriesById.set(id, {
      time: [],
      bw: [],
      latency: [],
      ber: [],
      hop: [],
      buckets: [],
    });
  }
  return aircraftChartSeriesById.get(id);
}

function aircraftMetricChartKey(id, metricKey) {
  return `${id}::${metricKey}`;
}

function disposeAircraftMiniChart(chartKey) {
  const chart = aircraftMiniCharts.get(chartKey);
  if (chart) {
    chart.dispose();
    aircraftMiniCharts.delete(chartKey);
  }
  aircraftChartPinnedTimeByKey.delete(chartKey);
  aircraftMiniChartHosts.delete(chartKey);
  aircraftChartRefHandlers.delete(chartKey);
}

function getAircraftMiniChartRef(id, metricKey) {
  const chartKey = aircraftMetricChartKey(id, metricKey);
  if (!aircraftChartRefHandlers.has(chartKey)) {
    aircraftChartRefHandlers.set(chartKey, (el) => setAircraftMiniChartHost(id, metricKey, el));
  }
  return aircraftChartRefHandlers.get(chartKey);
}

function setAircraftMiniChartHost(id, metricKey, el) {
  if (!id || !metricKey) return;
  const chartKey = aircraftMetricChartKey(id, metricKey);
  if (!el) {
    disposeAircraftMiniChart(chartKey);
    return;
  }
  aircraftMiniChartHosts.set(chartKey, el);
  if (!aircraftMiniCharts.has(chartKey)) {
    const chart = echarts.init(el, null, { renderer: "canvas" });
    bindAircraftMiniChartInteractions(chartKey, chart);
    aircraftMiniCharts.set(chartKey, chart);
  }
  renderAircraftMiniChart(id, metricKey);
}

function clearPinnedAircraftTooltip(chartKey) {
  const chart = aircraftMiniCharts.get(chartKey);
  aircraftChartPinnedTimeByKey.delete(chartKey);
  if (!chart) return;
  chart.setOption({
    tooltip: {
      triggerOn: "mousemove|click",
      alwaysShowContent: false,
    },
  });
  chart.dispatchAction({ type: "hideTip" });
}

function restorePinnedAircraftTooltip(chartKey) {
  const chart = aircraftMiniCharts.get(chartKey);
  const pinnedTime = aircraftChartPinnedTimeByKey.get(chartKey);
  if (!chart || !Number.isFinite(pinnedTime)) return;

  const [id] = chartKey.split("::");
  const series = aircraftChartSeriesById.get(id);
  let dataIndex = series?.time?.findIndex((time) => Math.abs(Number(time) - pinnedTime) < 1e-6) ?? -1;
  if (dataIndex < 0) {
    const pinnedBucket = chartBucketForTime(pinnedTime);
    if (pinnedBucket != null) {
      dataIndex = series?.buckets?.findIndex((bucket) => bucket === pinnedBucket) ?? -1;
    }
  }
  if (dataIndex < 0) {
    clearPinnedAircraftTooltip(chartKey);
    return;
  }
  chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex });
}

function pinAircraftTooltip(chartKey, params) {
  const chart = aircraftMiniCharts.get(chartKey);
  const pinnedTime = Number(params?.data?.[0]);
  if (!chart || !Number.isFinite(pinnedTime)) return;

  aircraftChartPinnedTimeByKey.set(chartKey, pinnedTime);
  chart.setOption({
    tooltip: {
      triggerOn: "none",
      alwaysShowContent: true,
    },
  });
  restorePinnedAircraftTooltip(chartKey);
}

function bindAircraftMiniChartInteractions(chartKey, chart) {
  chart.on("click", (params) => {
    if (params?.componentType !== "series" || !Number.isInteger(params?.dataIndex)) return;
    pinAircraftTooltip(chartKey, params);
  });
  chart.getZr().on("click", (event) => {
    if (event?.target) return;
    clearPinnedAircraftTooltip(chartKey);
  });
}

function renderAircraftMiniChart(id, metricKey) {
  const chartKey = aircraftMetricChartKey(id, metricKey);
  const chart = aircraftMiniCharts.get(chartKey);
  const series = aircraftChartSeriesById.get(id);
  if (!chart || !series) return;
  const metric = AIRCRAFT_METRIC_OPTIONS.find((item) => item.key === metricKey);
  if (!metric) return;

  const data = series.time.map((t, i) => [t, series[metricKey][i]]);
  const numericValues = data.map(([, value]) => Number(value)).filter((value) => Number.isFinite(value));
  const safeMin = numericValues.length > 0 ? Math.min(...numericValues) : 0;
  const safeMax = numericValues.length > 0 ? Math.max(...numericValues) : 0;
  let yAxisMin = "dataMin";
  let yAxisMax = "dataMax";
  if (metricKey === "bw") {
    yAxisMin = 0;
    yAxisMax = safeMax <= 0 ? 1 : safeMax * 1.15;
  } else if (metricKey === "hop") {
    yAxisMin = 0;
    yAxisMax = safeMax <= 0 ? 1 : Math.ceil(safeMax + 1);
  } else if (metricKey === "latency") {
    yAxisMin = safeMin <= 0 ? 0 : safeMin * 0.9;
    yAxisMax = safeMax <= 0 ? 1 : safeMax * 1.1;
  } else if (metricKey === "ber") {
    if (safeMax <= 0) {
      yAxisMin = 0;
      yAxisMax = 1e-7;
    } else if (Math.abs(safeMax - safeMin) < 1e-12) {
      yAxisMin = Math.max(0, safeMin * 0.9);
      yAxisMax = safeMax * 1.1;
    }
  }
  const yAxisFormatter = metricKey === "ber"
    ? (v) => Number(v).toExponential(1)
    : metricKey === "bw"
      ? (v) => Number(v).toFixed(1)
      : (v) => Number(v).toFixed(0);
  const tooltipUnit = metricKey === "latency"
    ? " ms"
    : metricKey === "bw"
      ? " Mbps"
      : "";
  const completeOption = {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 28, right: 8, top: 8, bottom: 14 },
    xAxis: {
      type: "value",
      min: 0,
      max: Number(state.durationS || 0),
      splitNumber: 2,
      axisLabel: { show: true, color: "#89aac8", fontSize: 8, formatter: (v) => formatClockText(v), hideOverlap: true },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "rgba(74, 121, 160, 0.35)" } },
      splitLine: { lineStyle: { color: "rgba(74, 121, 160, 0.16)" } },
    },
    yAxis: {
      type: "value",
      min: yAxisMin,
      max: yAxisMax,
      scale: true,
      splitNumber: 2,
      axisLabel: { color: "#89aac8", fontSize: 8, formatter: yAxisFormatter, hideOverlap: true },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "rgba(74, 121, 160, 0.35)" } },
      splitLine: { lineStyle: { color: "rgba(74, 121, 160, 0.16)" } },
    },
    tooltip: {
      show: true,
      trigger: "axis",
      triggerOn: "mousemove|click",
      alwaysShowContent: false,
      renderMode: "html",
      appendToBody: true,
      confine: false,
      className: "metrics-echarts-tooltip",
      extraCssText: "z-index:99999;pointer-events:none;",
      axisPointer: { type: "line", show: true, snap: true },
      formatter: (params) => {
        const first = Array.isArray(params) ? params[0] : null;
        const x = Number(first?.data?.[0]);
        const y = Number(first?.data?.[1]);
        const timeText = Number.isFinite(x) ? formatClockText(x) : "--";
        let valueText = "--";
        if (Number.isFinite(y)) {
          if (metricKey === "ber") valueText = y.toExponential(2);
          else if (metricKey === "bw") valueText = `${y.toFixed(2)}${tooltipUnit}`;
          else valueText = `${y.toFixed(3)}${tooltipUnit}`;
        }
        return `${metric.title}<br/>t=${timeText}<br/>value=${valueText}`;
      },
    },
    series: [{
      id: chartKey,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1, color: metric.color },
      emphasis: { lineStyle: { width: 1.4, color: metric.color } },
      data,
    }],
  };

  const existingSeries = chart.getOption()?.series;
  if (!Array.isArray(existingSeries) || existingSeries.length === 0) {
    chart.setOption(completeOption);
  } else {
    chart.setOption({
      xAxis: { max: Number(state.durationS || 0) },
      yAxis: { min: yAxisMin, max: yAxisMax },
      series: [{ id: chartKey, data }],
    }, { lazyUpdate: true, silent: true });
  }
  restorePinnedAircraftTooltip(chartKey);
}

function resetAircraftCharts() {
  for (const chart of aircraftMiniCharts.values()) {
    chart.clear();
  }
  aircraftChartPinnedTimeByKey.clear();
  aircraftChartSeriesById.clear();
}

function pushAircraftPoint(id, relativeTimeS, route) {
  const series = ensureAircraftSeries(id);
  upsertChartPoint(series, relativeTimeS, {
    bw: route && Number.isFinite(Number(route.effective_bandwidth_mbps)) ? Number(route.effective_bandwidth_mbps) : 0,
    latency: route && Number.isFinite(Number(route.latency_ms)) ? Number(route.latency_ms) : null,
    ber: route && Number.isFinite(Number(route.ber)) ? Number(route.ber) : null,
    hop: route && Number.isFinite(Number(route.hop_count)) ? Number(route.hop_count) : null,
  });
}

function renderAllAircraftCharts({ resize = false } = {}) {
  for (const [chartKey, chart] of aircraftMiniCharts.entries()) {
    const [id, metricKey] = chartKey.split("::");
    if (resize) chart.resize();
    renderAircraftMiniChart(id, metricKey);
  }
}

function rebuildAircraftRows(relativeTimeS, shouldSampleCharts) {
  const rows = allAircraftIds.map((id) => {
    const position = interpolateTrack(nodeTracksById.get(id), relativeTimeS);
    const route = routeForAircraft(id);
    const targetId = route?.target || groundStationId || "GS_1";
    if (shouldSampleCharts) pushAircraftPoint(id, relativeTimeS, route);
    return {
      id,
      connected: Boolean(route),
      routeTitle: `${id} -> ${targetId}`,
      positionText: posText(position),
      altitudeText: position ? `${position.altKm.toFixed(2)} km` : "--",
    };
  });
  // 固定顺序，避免频繁重排导致图表节点反复销毁重建。
  rows.sort((a, b) => a.id.localeCompare(b.id));
  aircraftRows.value = rows;
}

function sampleChartHistoryAt(relativeTimeS) {
  advanceSimToTime(relativeTimeS);
  rebuildGroundInfo(relativeTimeS);
  for (const id of allAircraftIds) {
    pushAircraftPoint(id, relativeTimeS, routeForAircraft(id));
  }
  pushGroundPoint(
    relativeTimeS,
    Number(groundStationInfo.value.lossRaw),
    Number(groundStationInfo.value.bandwidthRaw),
  );
}

function backfillChartHistory(relativeTimeS) {
  const targetTimeS = Number(relativeTimeS);
  if (!Number.isFinite(targetTimeS)) return;

  const lastTimeS = groundChartSeries.time[groundChartSeries.time.length - 1];
  if (Number.isFinite(lastTimeS) && targetTimeS + 1e-9 < lastTimeS) {
    resetSimState();
    resetGroundCharts();
    resetAircraftCharts();
  }

  const targetBucket = chartBucketForTime(targetTimeS);
  if (targetBucket == null) return;

  const lastBucket = groundChartSeries.buckets[groundChartSeries.buckets.length - 1] ?? -1;
  const bucketWidthS = Number(state.durationS) / Math.max(1, CHART_MAX_POINTS - 1);
  for (let bucket = lastBucket + 1; bucket < targetBucket; bucket += 1) {
    sampleChartHistoryAt(bucket * bucketWidthS);
  }
}

function refreshDashboard(force = false) {
  // 按节流频率刷新三列数据，避免每帧重算过重。
  const now = nowMs();
  if (!force && (now - lastDashboardRenderAtMs) < DASHBOARD_UPDATE_THROTTLE_MS) return;
  lastDashboardRenderAtMs = now;
  const shouldSampleCharts = force || (now - lastChartPushAtMs) >= CHART_PUSH_MIN_INTERVAL_MS;

  const relativeTimeS = normalizeRelativeTime(state.currentTimeS, state.durationS);
  if (shouldSampleCharts) backfillChartHistory(relativeTimeS);
  advanceSimToTime(relativeTimeS);
  rebuildGroundInfo(relativeTimeS);
  rebuildSatelliteRows(relativeTimeS);
  rebuildAircraftRows(relativeTimeS, shouldSampleCharts);
  if (shouldSampleCharts) {
    pushGroundPoint(relativeTimeS, Number(groundStationInfo.value.lossRaw), Number(groundStationInfo.value.bandwidthRaw));
    renderGroundCharts();
    renderAllAircraftCharts();
    lastChartPushAtMs = now;
  }
  syncMiniMapTime();
}

async function refreshWeather() {
  // 使用 open-meteo 的免费接口读取地面站天气，失败时回退文案。
  const { latitude, longitude } = groundStationInfo.value;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    weatherText.value = "暂无天气数据";
    return;
  }
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode&timezone=Asia%2FShanghai`);
    if (!response.ok) throw new Error(`weather status ${response.status}`);
    const payload = await response.json();
    const current = payload?.current || {};
    const map = new Map([[0, "晴"], [1, "晴间多云"], [2, "多云"], [3, "阴"], [61, "小雨"], [63, "中雨"], [65, "大雨"], [71, "小雪"], [80, "阵雨"], [95, "雷暴"]]);
    weatherText.value = `${map.get(Number(current.weathercode)) || "未知"} / ${formatNum(current.temperature_2m, 1, "°C")}`;
  } catch {
    weatherText.value = "天气服务不可用";
  }
}

function extractScenarioData(bundle) {
  nodeTracksById = new Map();
  nodeTypeById = new Map();
  for (const track of bundle.node_tracks || []) {
    const normalizedTrack = { ...track, samples: sortByRelativeTime(track.samples || []) };
    nodeTracksById.set(String(track.id), normalizedTrack);
    nodeTypeById.set(String(track.id), String(track.type || ""));
  }

  topologyEvents = sortByRelativeTime(bundle.topology_events || []);
  routeEvents = sortByRelativeTime(bundle.route_events || []);
  allAircraftIds = [...nodeTypeById.entries()].filter(([, type]) => type === "aircraft").map(([id]) => id).sort((a, b) => a.localeCompare(b));
  groundStationId = [...nodeTypeById.entries()].find(([, type]) => type === "ground_station")?.[0] || "";

  state.durationS = Number(bundle?.metadata?.duration_s || 0);
  state.currentTimeS = normalizeRelativeTime(state.currentTimeS, state.durationS);
  resetSimState();
  resetGroundCharts();
  resetAircraftCharts();
}

async function loadScenarioMetrics(scenarioKey) {
  if (!getScenarioRecordSync(scenarioKey)) {
    state.error = "暂无可运行场景，请先在场景配置库导入或生成场景。";
    state.loading = false;
    return;
  }
  const currentSequence = ++loadSequence;
  state.loading = true;
  state.error = "";
  if (miniScenarioHandle) {
    miniScenarioHandle.cleanup();
    miniScenarioHandle = null;
  }
  currentScenarioRuntime.value = null;
  currentScenarioBundle = null;

  try {
    const runtime = await resolveScenarioRuntime(scenarioKey);
    const bundle = await loadSatsimBundleSource(runtime.bundleSource);
    if (currentSequence !== loadSequence) return;

    currentScenarioRuntime.value = runtime;
    currentScenarioBundle = bundle;
    extractScenarioData(bundle);
    state.scenarioKey = scenarioKey;
    // 先让三列布局渲染出来，再初始化左上角 Cesium 小地图容器。
    state.loading = false;
    await nextTick();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    if (currentSequence !== loadSequence) return;
    ensureGroundCharts();
    renderGroundCharts();
    scheduleGroundChartBootstrap(currentSequence);
    refreshDashboard(true);
    await initMiniMap();
    await nextTick();
    resizeDashboard();
    scheduleGroundChartBootstrap(currentSequence);
    if (currentSequence !== loadSequence) return;
    await refreshWeather();
    scheduleGroundChartBootstrap(currentSequence);
  } catch (error) {
    if (currentSequence !== loadSequence) return;
    state.error = error instanceof Error ? error.message : String(error);
    currentScenarioRuntime.value = null;
    currentScenarioBundle = null;
    satelliteRows.value = [];
    aircraftRows.value = [];
    state.loading = false;
  }
}

async function applySnapshot(payload) {
  const nextScenario = String(payload?.scenarioKey || state.scenarioKey);
  if (getScenarioRecordSync(nextScenario) && nextScenario !== state.scenarioKey) await loadScenarioMetrics(nextScenario);

  const playback = payload?.playback || {};
  if (Number.isFinite(Number(playback.multiplier))) state.playbackMultiplier = Number(playback.multiplier);
  if (typeof playback.shouldAnimate === "boolean") state.shouldAnimate = playback.shouldAnimate;

  const simulation = payload?.simulation || {};
  if (Number.isFinite(Number(simulation.durationS))) state.durationS = Number(simulation.durationS);
  if (Number.isFinite(Number(simulation.relativeTimeS))) state.currentTimeS = normalizeRelativeTime(Number(simulation.relativeTimeS), state.durationS);
}

async function handleSyncMessage(event) {
  const message = event?.data || {};
  const type = message.type;
  const payload = message.payload || {};
  if (!type) return;

  if (type === SCREEN_SYNC_MESSAGE_TYPES.MAIN_SCREEN_DISCONNECTED) {
    state.channelOnline = false;
    state.primaryDisconnected = true;
    state.primaryExited = false;
    state.shouldAnimate = false;
    return;
  }

  if (type === SCREEN_SYNC_MESSAGE_TYPES.MAIN_SCREEN_EXITED) {
    state.channelOnline = false;
    state.primaryDisconnected = false;
    state.primaryExited = true;
    state.shouldAnimate = false;
    return;
  }

  state.channelOnline = true;
  state.primaryDisconnected = false;
  state.primaryExited = false;
  if (type === SCREEN_SYNC_MESSAGE_TYPES.STATE_SNAPSHOT) {
    await applySnapshot(payload);
    return;
  }
  if (type === SCREEN_SYNC_MESSAGE_TYPES.SCENARIO_CHANGED) {
    const key = String(payload?.scenarioKey || "");
    if (getScenarioRecordSync(key) && key !== state.scenarioKey) await loadScenarioMetrics(key);
    return;
  }
  if (type === SCREEN_SYNC_MESSAGE_TYPES.PLAYBACK_CHANGED) {
    if (Number.isFinite(Number(payload.multiplier))) state.playbackMultiplier = Number(payload.multiplier);
    if (typeof payload.shouldAnimate === "boolean") state.shouldAnimate = payload.shouldAnimate;
    return;
  }
  if (type === SCREEN_SYNC_MESSAGE_TYPES.TICK) {
    const key = String(payload?.scenarioKey || "");
    if (getScenarioRecordSync(key) && key !== state.scenarioKey) return;
    if (Number.isFinite(Number(payload.relativeTimeS))) state.currentTimeS = normalizeRelativeTime(Number(payload.relativeTimeS), state.durationS);
  }
}

function openMainScreen() {
  const opened = openMainScreenWindow(state.scenarioKey);
  if (!opened) window.open(`/#/run?scenario=${encodeURIComponent(state.scenarioKey)}`, "_blank");
}

function connectScreenSync() {
  screenSyncChannel = createScreenSyncChannel();
  if (!screenSyncChannel) return;
  screenSyncChannel.onmessage = (event) => { void handleSyncMessage(event); };
  postScreenSyncMessage(screenSyncChannel, SCREEN_SYNC_MESSAGE_TYPES.REQUEST_SNAPSHOT, {});
}

function resizeDashboard() {
  if (groundBandwidthChart) groundBandwidthChart.resize();
  if (groundLossChart) groundLossChart.resize();
  renderGroundCharts();
  renderAllAircraftCharts({ resize: true });
  if (miniViewer && !miniViewer.isDestroyed()) {
    miniViewer.resize();
    miniViewer.scene.requestRender();
  }
}

watch(() => state.currentTimeS, () => { refreshDashboard(); });

onMounted(async () => {
  await refreshServerScenarioRecords().catch(() => []);
  if (!getScenarioRecordSync(state.scenarioKey)) {
    state.scenarioKey = listRunnableScenarioRecords()[0]?.id || "";
  }
  if (state.scenarioKey) {
    await loadScenarioMetrics(state.scenarioKey);
  } else {
    state.error = "暂无可运行场景，请先在场景配置库导入或生成场景。";
  }
  connectScreenSync();
  window.addEventListener("resize", resizeDashboard);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resizeDashboard);
  if (screenSyncChannel) {
    screenSyncChannel.close();
    screenSyncChannel = null;
  }
  if (miniScenarioHandle) miniScenarioHandle.cleanup();
  currentScenarioBundle = null;
  currentScenarioRuntime.value = null;
  teardownViewerImagery(miniImageryCleanup);
  if (miniViewer && !miniViewer.isDestroyed()) miniViewer.destroy();
  if (groundBandwidthChart) {
    groundBandwidthChart.dispose();
    groundBandwidthChart = null;
  }
  if (groundLossChart) {
    groundLossChart.dispose();
    groundLossChart = null;
  }
  groundChartPinnedTimeByKey.clear();
  clearGroundChartBootstrapTimers();
  for (const chart of aircraftMiniCharts.values()) chart.dispose();
  aircraftMiniCharts.clear();
  aircraftMiniChartHosts.clear();
  aircraftChartPinnedTimeByKey.clear();
  aircraftChartSeriesById.clear();
  aircraftChartRefHandlers.clear();
});
</script>
<style scoped>
:global(html),
:global(body),
:global(#metrics-app),
.metrics-root {
  margin: 0;
  width: 100%;
  height: 100%;
}

.metrics-root {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  background: #06111f;
  color: #dce8f5;
  overflow: hidden;
}

.metrics-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 16px; border-bottom: 1px solid rgba(108, 146, 178, 0.35); background: rgba(8, 18, 32, 0.56); backdrop-filter: blur(8px); }
.header-left h1 { margin: 0; font-size: 20px; font-weight: 700; }
.header-left p { margin: 6px 0 0; font-size: 13px; color: #9fbbd6; }
.header-right { display: flex; align-items: center; gap: 10px; }
.header-right button { height: 32px; border-radius: 8px; border: 1px solid rgba(120, 170, 208, 0.46); background: rgba(13, 29, 48, 0.62); color: #dce8f5; padding: 0 10px; }
.header-right button { cursor: pointer; }
.sync-badge { font-size: 12px; padding: 4px 8px; border-radius: 6px; background: rgba(148, 63, 63, 0.34); color: #ffd4d4; }
.sync-badge.online { background: rgba(73, 142, 94, 0.28); color: #d4f6dc; }

.metrics-content {
  flex: 1;
  overflow: auto;
  padding: 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(124, 170, 208, 0.3) rgba(7, 18, 32, 0.05);
}

.metrics-content::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.metrics-content::-webkit-scrollbar-track {
  background: rgba(7, 18, 32, 0.08);
  border-radius: 999px;
}

.metrics-content::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(119, 168, 209, 0.3), rgba(72, 113, 148, 0.24));
  border-radius: 999px;
  border: 1px solid rgba(7, 18, 32, 0.18);
}

.metrics-content::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(138, 189, 231, 0.42), rgba(86, 136, 178, 0.32));
}
.state-box { margin: 36px auto; width: fit-content; padding: 12px 16px; border-radius: 10px; border: 1px solid rgba(131, 170, 201, 0.36); background: rgba(16, 34, 57, 0.46); }
.state-box.error { border-color: rgba(214, 90, 90, 0.65); color: #ffd9d9; }

.dashboard-grid { height: 100%; display: grid; grid-template-columns: minmax(320px, 0.92fr) minmax(260px, 0.72fr) minmax(420px, 1.36fr); gap: 12px; align-items: stretch; }
.column { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.panel { border: 1px solid rgba(104, 154, 198, 0.42); border-radius: 12px; background: linear-gradient(165deg, rgba(10, 23, 40, 0.56), rgba(8, 26, 47, 0.42)); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px rgba(145, 195, 238, 0.08); min-height: 0; }
.panel-header { display: flex; align-items: baseline; justify-content: space-between; padding: 10px 12px 8px; border-bottom: 1px solid rgba(117, 171, 213, 0.2); }
.panel-header h2 { margin: 0; font-size: 15px; color: #dbeafe; letter-spacing: 0.5px; }
.panel-header span { color: #93c5fd; font-size: 12px; }

.mini-map-panel { flex: 1 1 50%; min-height: 220px; overflow: hidden; }
.mini-map-container { width: 100%; height: calc(100% - 42px); }
.ground-panel { flex: 1 1 50%; min-height: 320px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; }
.ground-main { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 8px; padding: 8px 10px 0; min-height: 0; overflow: hidden; align-content: start; }
.ground-art { position: relative; min-height: 148px; border-radius: 10px; background: radial-gradient(circle at 50% 50%, rgba(66, 153, 225, 0.22), rgba(10, 27, 49, 0.18)); border: 1px solid rgba(107, 177, 234, 0.3); display: flex; justify-content: center; align-items: center; overflow: hidden; }
.ground-art .radar-model { width: 128px; height: 128px; object-fit: contain; }
.ground-metrics { display: flex; flex-direction: column; gap: 6px; }
.ground-metrics p { margin: 0; display: flex; justify-content: space-between; gap: 10px; font-size: 12px; min-height: 18px; }
.ground-metrics span { color: #93c5fd; }
.ground-metrics strong { color: #e2e8f0; font-weight: 600; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
.ground-chart-stack { min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 6px 10px 10px; box-sizing: border-box; width: 100%; overflow: hidden; }
.ground-chart { width: 100%; height: 100%; min-height: 0; overflow: hidden; border-radius: 8px; }

.list-panel { flex: 1; display: flex; flex-direction: column; }
.empty-tip { padding: 14px; color: #93a9bc; font-size: 13px; }
.entity-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(124, 170, 208, 0.38) rgba(7, 18, 32, 0.12);
}

.entity-list::-webkit-scrollbar {
  width: 8px;
}

.entity-list::-webkit-scrollbar-track {
  background: rgba(7, 18, 32, 0.12);
  border-radius: 999px;
}

.entity-list::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(119, 168, 209, 0.46), rgba(72, 113, 148, 0.34));
  border-radius: 999px;
  border: 1px solid rgba(7, 18, 32, 0.22);
}

.entity-list::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(138, 189, 231, 0.58), rgba(86, 136, 178, 0.44));
}
.entity-card { border: 1px solid rgba(106, 162, 207, 0.28); border-radius: 10px; padding: 8px 9px; background: rgba(9, 24, 42, 0.55); backdrop-filter: blur(6px); }
.entity-head { display: flex; justify-content: space-between; align-items: center; }
.entity-head h3 { margin: 0; color: #e2e8f0; font-size: 14px; font-weight: 700; }
.tag { border: 1px solid rgba(129, 177, 218, 0.45); border-radius: 999px; color: #9fc7e7; font-size: 10px; padding: 2px 8px; white-space: nowrap; }
.tag.active { color: #d4f6dc; border-color: rgba(74, 186, 112, 0.55); }
.entity-grid { margin-top: 7px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.entity-grid p { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.entity-grid span { color: #87add0; font-size: 11px; }
.entity-grid strong { color: #e2e8f0; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sat-card { box-shadow: inset 0 0 0 1px rgba(255, 215, 94, 0.08); }
.ac-card { box-shadow: inset 0 0 0 1px rgba(94, 234, 212, 0.08); }
.aircraft-meta-grid { margin-bottom: 6px; grid-template-columns: minmax(0, 1.6fr) minmax(98px, 1fr); align-items: start; }
.aircraft-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; border-top: 1px solid rgba(120, 168, 208, 0.22); padding-top: 6px; margin-top: 4px; }
.aircraft-chart-cell { border: 1px solid rgba(103, 151, 192, 0.26); border-radius: 6px; background: rgba(6, 17, 31, 0.16); padding: 4px; min-height: 102px; }
.aircraft-chart-title { color: #a6c0d8; font-size: 10px; line-height: 1; margin-bottom: 3px; }
.aircraft-mini-chart { width: 100%; height: 86px; }
.metrics-echarts-tooltip {
  padding: 6px 8px;
  border: 1px solid rgba(132, 180, 220, 0.46);
  border-radius: 6px;
  background: rgba(8, 20, 36, 0.92);
  color: #dbeafe;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
  font-size: 11px;
  line-height: 1.45;
}

@media (max-width: 1600px) {
  .dashboard-grid {
    height: 100%;
    min-height: 0;
    grid-template-columns: minmax(340px, 1.02fr) minmax(240px, 0.68fr) minmax(360px, 1.16fr);
    gap: 10px;
  }
  .mini-map-panel {
    flex: 0 0 clamp(240px, 32vh, 360px);
    height: clamp(240px, 32vh, 360px);
    min-height: 240px;
    max-height: 360px;
  }
  .ground-panel {
    flex: 1 1 auto;
    min-height: 280px;
  }
  .panel-header { padding: 8px 10px 7px; }
  .panel-header h2 { font-size: 14px; }
  .panel-header span { font-size: 11px; }
}

@media (max-width: 1280px) {
  .metrics-header {
    flex-wrap: wrap;
    gap: 12px 16px;
  }
  .header-right {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .dashboard-grid {
    grid-template-columns: 1fr;
    height: auto;
  }
  .left-column,
  .middle-column,
  .right-column {
    grid-column: auto;
    grid-row: auto;
  }
  .column {
    min-height: auto;
  }
  .mini-map-panel {
    flex: 0 0 clamp(200px, 24vh, 280px);
    height: clamp(200px, 24vh, 280px);
    min-height: 200px;
    max-height: 280px;
  }
  .ground-panel {
    flex: 1 1 auto;
    min-height: 390px;
  }
  .ground-main {
    grid-template-columns: 148px minmax(0, 1fr);
    align-items: center;
  }
}

@media (max-width: 900px) {
  .metrics-content {
    padding: 10px;
  }
  .header-left h1 {
    font-size: 18px;
  }
  .header-left p {
    font-size: 12px;
  }
  .header-right {
    gap: 8px;
  }
  .header-right button {
    width: 100%;
  }
  .ground-main {
    grid-template-columns: 1fr;
    gap: 10px;
    padding: 10px 10px 0;
  }
  .ground-art {
    min-height: 168px;
  }
  .ground-art .radar-model {
    width: 148px;
    height: 148px;
  }
  .ground-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }
  .ground-metrics p {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .ground-metrics strong {
    max-width: none;
    text-align: left;
  }
  .ground-chart-stack {
    min-height: 230px;
  }
  .entity-grid,
  .aircraft-meta-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {
  .ground-metrics {
    grid-template-columns: 1fr;
  }
  .aircraft-chart-grid {
    grid-template-columns: 1fr;
  }
}
</style>



