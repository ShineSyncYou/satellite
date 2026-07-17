<template>
  <div class="scene-root">
    <div class="platform-title">
      <img class="platform-logo" src="/pictures/comac_logo.png" alt="COMAC" />
      <span class="platform-title-main">空天地一体</span><span class="platform-title-highlight">卫星通信仿真平台</span>
    </div>
    <div id="cesiumContainer"></div>
    <div v-if="sceneLoading || sceneLoadError || sceneEmpty" class="scene-loading-mask" :class="{ 'scene-loading-mask--error': sceneLoadError }">
      <div class="scene-loading-card">
        <strong>{{ sceneEmpty ? "暂无可运行场景" : (sceneLoadError ? "场景加载失败" : "场景加载中") }}</strong>
        <p>{{ sceneEmpty ? emptyScenarioText : (sceneLoadError || sceneLoadingText) }}</p>
      </div>
    </div>

    <div class="tool-bar">
      <label class="scenario-label" for="scenarioSelect">场景</label>
      <div id="scenarioSelect" class="scenario-select custom-select" :class="{ open: isScenarioMenuOpen }">
        <button type="button" class="custom-select-trigger" :disabled="isScenarioSwitching" @click="toggleScenarioMenu">
          {{ selectedScenarioLabel }}
        </button>
        <ul v-show="isScenarioMenuOpen" class="custom-select-menu">
          <li v-for="option in scenarioOptions" :key="option.key">
            <button
              type="button"
              class="custom-select-option"
              :class="{ active: option.key === selectedScenario }"
              @click="chooseScenario(option.key)"
            >
              {{ option.label }}
            </button>
          </li>
        </ul>
      </div>

      <button class="tool-btn" :disabled="isScenarioSwitching" @click="goBackToLanding">返回首页</button>
      <button class="tool-btn" :disabled="isScenarioSwitching" @click="flyToChina">中国居中</button>
      <button class="tool-btn" :disabled="isScenarioSwitching" @click="openMetricsScreen">打开参数副屏</button>

      <div class="playback-group" aria-label="仿真播放">
        <button type="button" class="tool-btn" :disabled="isScenarioSwitching" @click="togglePlaybackPause">
          {{ playbackPaused ? "播放" : "暂停" }}
        </button>
        <label class="playback-label" for="playbackSpeedSelect">速率</label>
        <div id="playbackSpeedSelect" class="scenario-select custom-select" :class="{ open: isSpeedMenuOpen }">
          <button type="button" class="custom-select-trigger" :disabled="isScenarioSwitching" @click="toggleSpeedMenu">
            {{ selectedPlaybackSpeedLabel }}
          </button>
          <ul v-show="isSpeedMenuOpen" class="custom-select-menu">
            <li v-for="speed in PLAYBACK_SPEED_OPTIONS" :key="speed">
              <button
                type="button"
                class="custom-select-option"
                :class="{ active: speed === playbackMultiplier }"
                @click="choosePlaybackSpeed(speed)"
              >
                {{ speed }}×
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
    <div v-if="coverageWarning" class="coverage-warning" role="status">{{ coverageWarning }}</div>

    <aside v-if="selectedEntityInfo" class="entity-info-panel">
      <div class="entity-info-header">
        <div>
          <p class="entity-type">{{ selectedEntityInfo.typeLabel }}</p>
          <h3>{{ selectedEntityInfo.id }}</h3>
        </div>
        <button class="entity-close-btn" type="button" @click="clearSelectedEntity">关闭</button>
      </div>

      <div class="entity-model-preview">
        <model-viewer
          v-if="modelViewerReady && !modelPreviewError"
          :key="selectedEntityInfo.id"
          :src="selectedEntityInfo.modelSrc"
          camera-controls
          auto-rotate
          @load="onEntityPreviewModelLoad"
          @error="onEntityPreviewModelError"
          shadow-intensity="0.8"
          exposure="1.1"
          environment-image="neutral"
        />
        <img v-else-if="modelPreviewError" class="entity-model-preview-fallback" src="/pictures/satellite-proxy.svg" alt="卫星预览" />
        <div v-else class="entity-model-preview-loading">正在加载卫星预览…</div>
      </div>

      <div class="entity-info-grid">
        <div class="entity-item">
          <span class="entity-item-label">经度</span>
          <span class="entity-item-value">{{ selectedEntityInfo.longitudeText }}</span>
        </div>
        <div class="entity-item">
          <span class="entity-item-label">纬度</span>
          <span class="entity-item-value">{{ selectedEntityInfo.latitudeText }}</span>
        </div>
        <div class="entity-item">
          <span class="entity-item-label">高度</span>
          <span class="entity-item-value">{{ selectedEntityInfo.altitudeText }}</span>
        </div>
        <div class="entity-item">
          <span class="entity-item-label">仿真时刻</span>
          <span class="entity-item-value">{{ selectedEntityInfo.relativeTimeText }}</span>
        </div>
      </div>

      <div class="entity-stats">
        <div class="entity-stat-card">
          <span class="entity-stat-label">关联链路</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.linkCount }}</span>
        </div>
        <div class="entity-stat-card">
          <span class="entity-stat-label">当前发送带宽</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.txRateText }}</span>
        </div>
        <div class="entity-stat-card">
          <span class="entity-stat-label">链路总容量</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.capacityText }}</span>
        </div>
        <div class="entity-stat-card">
          <span class="entity-stat-label">平均利用率</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.utilizationText }}</span>
        </div>
        <div class="entity-stat-card">
          <span class="entity-stat-label">{{ selectedEntityInfo.routeCountLabel }}</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.routeCount }}</span>
        </div>
        <div class="entity-stat-card">
          <span class="entity-stat-label">平均时延</span>
          <span class="entity-stat-value">{{ selectedEntityInfo.latencyText }}</span>
        </div>
      </div>

      <div v-if="selectedEntityInfo.linkDetails.length > 0" class="entity-links">
        <h4>链路明细</h4>
        <ul>
          <li v-for="link in selectedEntityInfo.linkDetails" :key="link.id">
            <span>{{ link.peer }}</span>
            <span>{{ link.type }}</span>
            <span>{{ link.txRateText }}</span>
            <span>{{ link.lossText }}</span>
          </li>
        </ul>
      </div>
    </aside>
  </div>
</template>

<script setup>
/**
 * App.vue - 卫星通信 3D 仿真主屏应用
 *
 * 核心功能：
 * 1. 使用 Cesium.js 渲染地球和卫星、飞机、地面站 3D 模型
 * 2. 从 CZML 数据源加载动态仿真数据（轨迹、链路等）
 * 3. 实时演示仿真场景，支持播放控制
 * 4. 提供场景切换、导航、平面图显示等交互功能
 * 5. 与链路参数副屏保持双向同步
 *
 * 局域网无外网时使用同源 /tiles/day/ 瓦片，外网可达时使用高德卫星；地球为光滑椭球。
 */

import * as Cesium from "cesium";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import loadSatsimScenario from "../lib/loadSatsimScenario";
import { getScenarioRecordSync, listRunnableScenarioRecords, listScenarioOptions, refreshServerScenarioRecords, resolveScenarioRuntime } from "../lib/runtimeScenarioCatalog";
import { createScreenSyncChannel, postScreenSyncMessage, SCREEN_SYNC_MESSAGE_TYPES } from "../lib/screenSync";
import {
  applyGlobeImageryLayers,
  bindAmapImageryFallback,
  bindGlobeImageryNetworkSync,
} from "../lib/offlineImagery.js";
import { openMetricsScreenWindow } from "../lib/openScreenWindow";
import "../Widgets/widgets.css";

// ============= 常量 =============
// ============= 播放速度 =============
/** 仿真时间与真实时间之比（对应 Cesium clock.multiplier） */
const PLAYBACK_SPEED_OPTIONS = [1, 2, 5, 10];
const DEFAULT_PLAYBACK_MULTIPLIER = 5;
const EARTH_SIDEREAL_DAY_SEC = 86164;
const SATELLITE_DOUBLE_CLICK_RADIUS_PX = 30;
const SYNC_TICK_THROTTLE_MS = 60;                                     // 副屏同步时刻的节流间隔

// ============= 组件状态 =============
const route = useRoute();
const router = useRouter();
const selectedScenario = ref(typeof route.query.scenario === "string" ? route.query.scenario : "");                                     // 选中的场景
const isScenarioSwitching = ref(false);                               // 场景切换中的锁定状态
const playbackMultiplier = ref(DEFAULT_PLAYBACK_MULTIPLIER);
const playbackPaused = ref(false);
const selectedEntityInfo = ref(null);                                 // 左侧实体详情面板
const selectedEntityId = ref("");                                     // 当前选中实体 ID
const modelViewerReady = ref(typeof window !== "undefined" && Boolean(window.customElements?.get("model-viewer")));
const modelPreviewError = ref(false);
const isScenarioMenuOpen = ref(false);
const isSpeedMenuOpen = ref(false);
const currentScenarioRuntime = ref(null);
const scenarioCatalogRefreshKey = ref(0);
const sceneLoading = ref(true);
const sceneLoadingText = ref("正在准备场景资源...");
const sceneLoadError = ref("");
const sceneEmpty = ref(false);
const coverageWarning = ref("");
const emptyScenarioText = "请先在场景配置库导入或生成场景。";
const scenarioOptions = computed(() => {
  scenarioCatalogRefreshKey.value;
  return listScenarioOptions();
});
const selectedScenarioLabel = computed(
  () => scenarioOptions.value.find((option) => option.key === selectedScenario.value)?.label
    || getScenarioRecordSync(selectedScenario.value)?.title
    || "未选择场景",
);
const selectedPlaybackSpeedLabel = computed(() => `${playbackMultiplier.value}×`);


// ============= Cesium 相关 =============
let viewer = null;                                                    // 主 3D 视图
let removeAutoRotate = null;                                          // 地球自转销毁函数
let removeImageryNetworkSync = null;
let removeImageryFallback = null;
let removeScreenSyncTick = null;                                      // 屏幕同步销毁函数
let lastRotateTime = null;                                            // 上次自转计算时刻
let mainScenarioHandle = null;                                        // 主屏场景加载句柄
let screenSyncChannel = null;                                         // 副屏同步通道
let lastSyncTickAtMs = Number.NEGATIVE_INFINITY;                      // 上次同步的时间戳
let lastPlaybackSignature = "";                                       // 上次播放状态的签名
let pickHandler = null;                                               // 鼠标拾取事件
let latestActiveTopology = new Map();                                 // 当前时刻生效链路
let latestActiveRoutes = new Map();                                   // 当前时刻生效路由
let latestRelativeTimeS = 0;                                          // 当前仿真相对时间
let modelViewerModulePromise = null;                                  // model-viewer 懒加载

/**
 * 仅在需要展示左侧实体 3D 预览时才加载 model-viewer，减少首屏 JS 体积。
 */
function ensureModelViewerLoaded() {
  if (typeof window === "undefined") {
    return Promise.resolve(false);
  }
  if (window.customElements?.get("model-viewer")) {
    return Promise.resolve(true);
  }
  if (!modelViewerModulePromise) {
    modelViewerModulePromise = import("@google/model-viewer")
      .then(() => Boolean(window.customElements?.get("model-viewer")))
      .catch((error) => {
        modelViewerModulePromise = null;
        console.warn("model-viewer load failed:", error);
        return false;
      });
  }
  return modelViewerModulePromise;
}

/**
 * 获取当前选中场景的 CZML 数据源 URL
 */
function currentCzmlSource() {
  return currentScenarioRuntime.value?.czmlSource || null;
}

// 主屏当前场景的业务数据来源：链路、路由、点击信息面板都依赖它。
function currentBundleSource() {
  return currentScenarioRuntime.value?.bundleSource || null;
}

function isKnownScenarioKey(key) {
  return typeof key === "string" && Boolean(getScenarioRecordSync(key));
}

function pickDefaultScenarioKey() {
  return listRunnableScenarioRecords()[0]?.id || "";
}

function ensureSelectedScenario() {
  if (isKnownScenarioKey(selectedScenario.value)) {
    return true;
  }
  selectedScenario.value = pickDefaultScenarioKey();
  return Boolean(selectedScenario.value);
}

function syncRouteScenarioQuery(replace = true) {
  const nextQuery = { ...route.query };
  if (selectedScenario.value) {
    nextQuery.scenario = selectedScenario.value;
  } else {
    delete nextQuery.scenario;
  }
  const navigate = replace ? router.replace : router.push;
  void navigate({ name: "run", query: nextQuery });
}


/**
 * 将节点类型转成中文展示文案。
 */
function nodeTypeLabel(nodeType) {
  if (nodeType === "satellite") return "卫星";
  if (nodeType === "aircraft") return "飞机";
  if (nodeType === "ground_station") return "地面站";
  return "未知";
}

function formatFixed(value, digits = 2, suffix = "") {
  if (!Number.isFinite(Number(value))) return "--";
  return `${Number(value).toFixed(digits)}${suffix}`;
}

/**
 * 读取当前时刻实体地理坐标。
 */
function readEntityPosition(entity) {
  if (!viewer || !entity?.position) {
    return null;
  }
  const cartesian = entity.position.getValue(viewer.clock.currentTime);
  if (!cartesian) {
    return null;
  }
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  if (!cartographic) {
    return null;
  }
  return {
    lonDeg: Cesium.Math.toDegrees(cartographic.longitude),
    latDeg: Cesium.Math.toDegrees(cartographic.latitude),
    altKm: cartographic.height / 1000,
  };
}

function linkLossRateFromRoute(route) {
  const loss = Number(route?.packet_loss_rate);
  if (Number.isFinite(loss)) {
    return Math.max(0, Math.min(1, loss));
  }
  return null;
}

/**
 * 信息面板模型加载完成后，为飞机模型增加色彩，避免 Airplane.glb 在 panel 里偏白。
 */
function onEntityPreviewModelLoad(event) {
  const nodeType = selectedEntityInfo.value?.nodeType;
  if (nodeType !== "aircraft") {
    return;
  }
  const materials = event?.target?.model?.materials;
  if (!Array.isArray(materials) || materials.length === 0) {
    return;
  }
  for (const material of materials) {
    const pbr = material?.pbrMetallicRoughness;
    if (pbr?.setBaseColorFactor) {
      pbr.setBaseColorFactor([0.36, 0.8, 0.96, 1]);
    }
    if (pbr?.setMetallicFactor) {
      pbr.setMetallicFactor(0.16);
    }
    if (pbr?.setRoughnessFactor) {
      pbr.setRoughnessFactor(0.44);
    }
  }
}

function onEntityPreviewModelError() {
  modelPreviewError.value = true;
}

/**
 * 基于当前生效拓扑，统计实体关联链路。
 */
function collectEntityLinks(entityId) {
  const links = [];
  for (const link of latestActiveTopology.values()) {
    if (link.source !== entityId && link.target !== entityId) {
      continue;
    }
    links.push({
      id: `${link.source}|${link.target}|${link.type}`,
      peer: link.source === entityId ? link.target : link.source,
      type: link.type || "LINK",
      txRate: Number(link.tx_rate_mbps),
      capacity: Number(link.bandwidth_mbps),
      utilization: Number(link.utilization),
    });
  }
  return links;
}

/**
 * 基于当前生效路由，统计实体参与的业务路径。
 */
function collectEntityRoutes(entityId) {
  const routes = [];
  for (const route of latestActiveRoutes.values()) {
    if (!route?.connected || !Array.isArray(route.path)) {
      continue;
    }
    if (!route.path.includes(entityId)) {
      continue;
    }
    routes.push(route);
  }
  return routes;
}

/**
 * 构建左侧详情面板数据（卫星/飞机）。
 */
function buildSelectedEntityInfo(entityId) {
  const bundle = mainScenarioHandle?.bundle;
  const entity = mainScenarioHandle?.entityLookup?.get(entityId);
  if (!bundle || !entity) {
    return null;
  }

  const nodeType = bundle.nodeTypeMap.get(entityId);
  if (nodeType !== "satellite" && nodeType !== "aircraft" && nodeType !== "ground_station") {
    return null;
  }

  const location = readEntityPosition(entity);
  const links = collectEntityLinks(entityId);
  const routes = collectEntityRoutes(entityId);

  const totalTx = links.reduce((sum, item) => sum + (Number.isFinite(item.txRate) ? item.txRate : 0), 0);
  const totalCapacity = links.reduce(
    (sum, item) => sum + (Number.isFinite(item.capacity) ? item.capacity : 0),
    0,
  );

  const utilizationSamples = links
    .map((item) => (
      Number.isFinite(item.utilization)
        ? item.utilization
        : (Number.isFinite(item.capacity) && item.capacity > 0 && Number.isFinite(item.txRate)
          ? item.txRate / item.capacity
          : NaN)
    ))
    .filter((value) => Number.isFinite(value));

  const avgUtilization = utilizationSamples.length > 0
    ? utilizationSamples.reduce((sum, value) => sum + value, 0) / utilizationSamples.length
    : NaN;

  const latencySamples = routes
    .map((route) => Number(route.latency_ms))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const avgLatencyMs = latencySamples.length > 0
    ? latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length
    : NaN;
  const connectedAircraftIds = new Set();
  if (nodeType === "ground_station") {
    for (const route of routes) {
      if (!Array.isArray(route.path)) {
        continue;
      }
      for (const nodeId of route.path) {
        if (bundle.nodeTypeMap.get(nodeId) === "aircraft") {
          connectedAircraftIds.add(nodeId);
        }
      }
    }
  }

  const linkDetails = links.slice(0, 8).map((link) => {
    const routeLossSamples = routes
      .filter((route) => Array.isArray(route.path) && route.path.includes(link.peer))
      .map((route) => linkLossRateFromRoute(route))
      .filter((value) => value != null);
    const avgLoss = routeLossSamples.length > 0
      ? routeLossSamples.reduce((sum, value) => sum + value, 0) / routeLossSamples.length
      : null;
    return {
      id: link.id,
      peer: link.peer,
      type: link.type,
      txRateText: formatFixed(link.txRate, 1, " Mbps"),
      lossText: avgLoss == null ? "--" : `${(avgLoss * 100).toFixed(2)}%`,
    };
  });

  return {
    id: entityId,
    nodeType,
    typeLabel: nodeTypeLabel(nodeType),
    modelSrc: nodeType === "aircraft"
      ? "/pictures/Airplane.glb"
      : nodeType === "ground_station"
      ? "/pictures/Telescope_2.gltf"
      : "/pictures/tdrs.glb",
    longitudeText: location ? `${location.lonDeg.toFixed(4)}°` : "--",
    latitudeText: location ? `${location.latDeg.toFixed(4)}°` : "--",
    altitudeText: location ? `${location.altKm.toFixed(2)} km` : "--",
    relativeTimeText: `${latestRelativeTimeS.toFixed(2)} s`,
    linkCount: links.length,
    routeCount: nodeType === "ground_station" ? connectedAircraftIds.size : routes.length,
    routeCountLabel: nodeType === "ground_station" ? "连接飞机数量" : "参与路由",
    txRateText: formatFixed(totalTx, 1, " Mbps"),
    capacityText: formatFixed(totalCapacity, 1, " Mbps"),
    utilizationText: Number.isFinite(avgUtilization) ? `${(avgUtilization * 100).toFixed(1)}%` : "--",
    latencyText: Number.isFinite(avgLatencyMs) ? `${avgLatencyMs.toFixed(2)} ms` : "--",
    linkDetails,
  };
}

function refreshSelectedEntityInfo() {
  if (!selectedEntityId.value) {
    selectedEntityInfo.value = null;
    return;
  }
  selectedEntityInfo.value = buildSelectedEntityInfo(selectedEntityId.value);
}

function clearSelectedEntity() {
  selectedEntityId.value = "";
  selectedEntityInfo.value = null;
}

function resolveNearbyVisibleSatelliteEntity(windowPosition) {
  if (!viewer || viewer.isDestroyed() || !mainScenarioHandle) {
    return null;
  }
  const earthOccluder = new Cesium.Occluder(
    new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Cesium.Ellipsoid.WGS84.maximumRadius),
    viewer.camera.positionWC,
  );
  const radiusSquared = SATELLITE_DOUBLE_CLICK_RADIUS_PX * SATELLITE_DOUBLE_CLICK_RADIUS_PX;
  const worldPosition = new Cesium.Cartesian3();
  const screenPosition = new Cesium.Cartesian2();
  let nearestEntity = null;
  let nearestDistanceSquared = radiusSquared;

  for (const satelliteId of mainScenarioHandle.bundle.satelliteIds || []) {
    const entity = mainScenarioHandle.entityLookup.get(satelliteId);
    const position = entity?.position?.getValue(viewer.clock.currentTime, worldPosition);
    if (!position || !earthOccluder.isPointVisible(position)) {
      continue;
    }
    const projected = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position, screenPosition);
    if (!projected) {
      continue;
    }
    const offsetX = projected.x - windowPosition.x;
    const offsetY = projected.y - windowPosition.y;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;
    if (distanceSquared <= nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestEntity = entity;
    }
  }
  return nearestEntity;
}

/**
 * 绑定主屏实体拾取事件：点击卫星/飞机后打开左侧详情。
 */
function bindEntityPickHandler() {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }
  if (pickHandler) {
    pickHandler.destroy();
    pickHandler = null;
  }

  pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const resolvePickedEntityId = (movement) => {
    const pickResults = viewer.scene.drillPick(movement.position, 12) || [];
    for (const picked of pickResults) {
      const entity = picked?.id;
      const candidateId = typeof entity?.id === "string"
        ? entity.id
        : (typeof entity === "string" ? entity : null);
      if (!candidateId) {
        continue;
      }
      const nodeType = mainScenarioHandle?.bundle?.nodeTypeMap?.get(candidateId);
      if (nodeType === "satellite" || nodeType === "aircraft" || nodeType === "ground_station") {
        return candidateId;
      }
    }
    return "";
  };

  pickHandler.setInputAction((movement) => {
    const entityId = resolvePickedEntityId(movement);
    if (!entityId) {
      return;
    }

    void ensureModelViewerLoaded().then((ready) => {
      modelViewerReady.value = ready;
      modelPreviewError.value = false;
      selectedEntityId.value = entityId;
      refreshSelectedEntityInfo();
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  pickHandler.setInputAction((movement) => {
    const exactEntityId = resolvePickedEntityId(movement);
    const exactEntity = exactEntityId
      && mainScenarioHandle?.bundle?.nodeTypeMap?.get(exactEntityId) === "satellite"
      ? mainScenarioHandle.entityLookup.get(exactEntityId)
      : null;
    const satelliteEntity = exactEntity || resolveNearbyVisibleSatelliteEntity(movement.position);
    if (satelliteEntity) {
      viewer.trackedEntity = satelliteEntity;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

}

function unbindEntityPickHandler() {
  if (pickHandler) {
    pickHandler.destroy();
    pickHandler = null;
  }
}

/**
 * 将界面上的倍率、暂停状态写入主 Cesium 时钟，并通知副屏。
 */
function applyPlaybackToViewers() {
  if (!viewer || viewer.isDestroyed()) return;

  viewer.clock.multiplier = playbackMultiplier.value;
  viewer.clock.shouldAnimate = !playbackPaused.value;

  broadcastPlaybackChanged();
}

function onPlaybackSpeedInput() {
  if (isScenarioSwitching.value) return;
  applyPlaybackToViewers();
}

function togglePlaybackPause() {
  if (isScenarioSwitching.value) return;
  playbackPaused.value = !playbackPaused.value;
  applyPlaybackToViewers();
}

function closeToolbarMenus() {
  isScenarioMenuOpen.value = false;
  isSpeedMenuOpen.value = false;
}

function toggleScenarioMenu() {
  if (isScenarioSwitching.value) return;
  isScenarioMenuOpen.value = !isScenarioMenuOpen.value;
  if (isScenarioMenuOpen.value) {
    isSpeedMenuOpen.value = false;
  }
}

function toggleSpeedMenu() {
  if (isScenarioSwitching.value) return;
  isSpeedMenuOpen.value = !isSpeedMenuOpen.value;
  if (isSpeedMenuOpen.value) {
    isScenarioMenuOpen.value = false;
  }
}

function chooseScenario(nextScenario) {
  closeToolbarMenus();
  if (isScenarioSwitching.value || nextScenario === selectedScenario.value) return;
  selectedScenario.value = nextScenario;
  void switchScenario();
}

function choosePlaybackSpeed(nextSpeed) {
  closeToolbarMenus();
  if (isScenarioSwitching.value || Number(nextSpeed) === playbackMultiplier.value) return;
  playbackMultiplier.value = Number(nextSpeed);
  onPlaybackSpeedInput();
}

function handleDocumentPointerDown(event) {
  const target = event?.target;
  if (!(target instanceof Element)) {
    closeToolbarMenus();
    return;
  }
  if (!target.closest(".custom-select")) {
    closeToolbarMenus();
  }
}

/**
 * 创建主 3D 视图
 * 配置项：
 * - 禁用所有默认 UI 小部件（动画、导航、时间线等）
 * - 启用高精度渲染和抗锯齿
 * - 关闭地球光照、雾效、大气效应（简化渲染）
 * - 在线高德卫星 / 离线本地影像瓦片
 */
function createViewer() {
  viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    shouldAnimate: true,
    resolutionScale: Math.min(window.devicePixelRatio || 1, 1.5),
    msaaSamples: 4,
    scene: {
      maximumScreenSpaceError: 1.8,
      preloadAncestors: false,
      preloadSiblings: false,
    },
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    imageryProvider: false,
    // ========== 新增：彻底关闭星空（推荐方式） ==========
    skyBox: false,          // 不创建星空盒
    skyAtmosphere: false,   // 同时关闭大气层（保险）
    sun: false,             // 关闭太阳
    moon: false,            // 关闭月亮
  });

  viewer.scene.globe.enableLighting = false;
  viewer.scene.fxaa = true;
  viewer.cesiumWidget.creditContainer.style.display = "none";
  viewer.scene.fog.enabled = false;
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.globe.textureCompressionEnabled = false;
  viewer.scene.globe.maximumScreenSpaceError = 1.8;

  viewer.scene.backgroundColor = Cesium.Color.BLACK;

  void applyGlobeImageryLayers(viewer).then(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    if (removeImageryNetworkSync) {
      removeImageryNetworkSync();
    }
    if (removeImageryFallback) {
      removeImageryFallback();
    }
    removeImageryNetworkSync = bindGlobeImageryNetworkSync(viewer);
    removeImageryFallback = bindAmapImageryFallback(viewer);
  });
}


/**
 * 绑定地球自转动画
 * 根据仿真播放速度，自动旋转相机以模拟地球自转
 * 旋转角速度随 clock.multiplier 变化，与仿真倍率一致
 */
function bindAutoRotate() {
  const earthRate = (2 * Math.PI) / EARTH_SIDEREAL_DAY_SEC;
  const onTick = (clock) => {
    if (!viewer || viewer.isDestroyed()) return;

    if (!lastRotateTime) {
      lastRotateTime = Cesium.JulianDate.clone(clock.currentTime);
      return;
    }

    const deltaSeconds = Cesium.JulianDate.secondsDifference(clock.currentTime, lastRotateTime);
    Cesium.JulianDate.clone(clock.currentTime, lastRotateTime);
    viewer.scene.camera.rotate(
      Cesium.Cartesian3.UNIT_Z,
      -earthRate * clock.multiplier * deltaSeconds,
    );
  };

  viewer.clock.onTick.addEventListener(onTick);
  removeAutoRotate = () => viewer.clock.onTick.removeEventListener(onTick);
}


/**
 * 规范化相对时间
 * 计算当前时刻距仿真起始时刻的秒数
 * 支持循环播放：若超过仿真时长，返回模运算结果
 */
function normalizeRelativeTime(currentTime, startTime, durationSeconds) {
  const diff = Cesium.JulianDate.secondsDifference(currentTime, startTime);
  if (diff <= 0) {
    return 0;
  }
  if (diff < durationSeconds) {
    return diff;
  }
  const remainder = diff % durationSeconds;
  return Math.abs(remainder) < 1e-9 ? durationSeconds : remainder;
}


/**
 * 构建同步快照负荷
 * 包含：场景、播放状态、仿真时刻、时钟信息
 * 用于主屏向副屏推送状态更新
 */
function buildSyncSnapshotPayload() {
  const bundle = mainScenarioHandle?.bundle;
  const durationS = Number(bundle?.durationSeconds || 0);
  const startJulian = bundle?.startJulian;
  const relativeTimeS = (bundle && startJulian)
    ? normalizeRelativeTime(viewer.clock.currentTime, startJulian, durationS)
    : 0;

  return {
    scenarioKey: selectedScenario.value,
    playback: {
      multiplier: Number(viewer.clock.multiplier || DEFAULT_PLAYBACK_MULTIPLIER),
      shouldAnimate: Boolean(viewer.clock.shouldAnimate),
    },
    simulation: {
      relativeTimeS,
      durationS,
      startTimeIso: bundle?.metadata?.start_time || null,
    },
    clock: {
      currentTimeIso: Cesium.JulianDate.toIso8601(viewer.clock.currentTime),
      startTimeIso: Cesium.JulianDate.toIso8601(viewer.clock.startTime),
      stopTimeIso: Cesium.JulianDate.toIso8601(viewer.clock.stopTime),
    },
  };
}


/**
 * 向副屏广播完整状态快照
 * 响应副屏的 REQUEST_SNAPSHOT 消息
 */
function broadcastSnapshot() {
  if (!screenSyncChannel || !viewer || !mainScenarioHandle) return;
  postScreenSyncMessage(screenSyncChannel, SCREEN_SYNC_MESSAGE_TYPES.STATE_SNAPSHOT, buildSyncSnapshotPayload());
}


/**
 * 向副屏广播场景变化通知
 */
function broadcastScenarioChanged() {
  if (!screenSyncChannel) return;
  postScreenSyncMessage(screenSyncChannel, SCREEN_SYNC_MESSAGE_TYPES.SCENARIO_CHANGED, {
    scenarioKey: selectedScenario.value,
  });
}


/**
 * 向副屏广播播放状态变化（速度、暂停/播放）
 */
function broadcastPlaybackChanged() {
  if (!screenSyncChannel || !viewer) return;
  postScreenSyncMessage(screenSyncChannel, SCREEN_SYNC_MESSAGE_TYPES.PLAYBACK_CHANGED, {
    multiplier: Number(viewer.clock.multiplier || DEFAULT_PLAYBACK_MULTIPLIER),
    shouldAnimate: Boolean(viewer.clock.shouldAnimate),
  });
}


/**
 * 绑定屏幕同步 TICK
 * 每 60ms 向副屏广播一次当前仿真时刻
 * 并检测播放状态变化，按需推送
 */
function bindScreenSyncTick() {
  if (!viewer || !screenSyncChannel || !mainScenarioHandle) return;

  const onTick = () => {
    const now = (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();

    const playbackSignature = `${viewer.clock.shouldAnimate ? 1 : 0}|${Number(viewer.clock.multiplier).toFixed(6)}`;
    if (playbackSignature !== lastPlaybackSignature) {
      lastPlaybackSignature = playbackSignature;
      broadcastPlaybackChanged();
    }

    if (now - lastSyncTickAtMs < SYNC_TICK_THROTTLE_MS) {
      return;
    }
    lastSyncTickAtMs = now;

    const bundle = mainScenarioHandle?.bundle;
    if (!bundle) {
      return;
    }
    const relativeTimeS = normalizeRelativeTime(
      viewer.clock.currentTime,
      bundle.startJulian,
      bundle.durationSeconds,
    );
    postScreenSyncMessage(screenSyncChannel, SCREEN_SYNC_MESSAGE_TYPES.TICK, {
      scenarioKey: selectedScenario.value,
      relativeTimeS,
      currentTimeIso: Cesium.JulianDate.toIso8601(viewer.clock.currentTime),
    });
  };

  viewer.clock.onTick.addEventListener(onTick);
  removeScreenSyncTick = () => viewer.clock.onTick.removeEventListener(onTick);
  onTick();
}


/**
 * 解绑屏幕同步 TICK
 */
function unbindScreenSyncTick() {
  if (removeScreenSyncTick) {
    removeScreenSyncTick();
    removeScreenSyncTick = null;
  }
  lastSyncTickAtMs = Number.NEGATIVE_INFINITY;
  lastPlaybackSignature = "";
}


/**
 * 处理来自副屏的同步消息
 * 支持副屏的快照请求和场景变更通知
 */
function handleScreenSyncMessage(event) {
  const message = event?.data || {};
  const type = message.type;
  const payload = message.payload || {};

  if (type === SCREEN_SYNC_MESSAGE_TYPES.REQUEST_SNAPSHOT) {
    broadcastSnapshot();
    return;
  }

  if (type === SCREEN_SYNC_MESSAGE_TYPES.SCENARIO_CHANGED) {
    const nextScenario = String(payload?.scenarioKey || "");
    if (!isKnownScenarioKey(nextScenario)) {
      return;
    }
    if (nextScenario === selectedScenario.value || isScenarioSwitching.value) {
      return;
    }
    selectedScenario.value = nextScenario;
    void switchScenario();
  }
}


/**
 * 初始化屏幕同步通道
 * 创建 BroadcastChannel 并设置消息监听
 */
function initializeScreenSync() {
  screenSyncChannel = createScreenSyncChannel();
  if (!screenSyncChannel) {
    return;
  }
  screenSyncChannel.onmessage = handleScreenSyncMessage;
}


/**
 * 关闭屏幕同步通道
 */
function closeScreenSync() {
  if (!screenSyncChannel) return;
  screenSyncChannel.close();
  screenSyncChannel = null;
}


/**
 * 飞行到中国地区
 * 地心坐标约 104E, 30N，高度 630 万米
 * 动画时长 1.5 秒
 */
function goBackToLanding() {
  void router.push({ name: "landing" });
}

function flyToChina() {
  if (!viewer || viewer.isDestroyed()) return;
  // trackedEntity 会在每一帧改写相机变换；先解除跟踪，后续 flyTo 才是地球固定视角。
  viewer.trackedEntity = undefined;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(104.0, 30.4, 6300000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-84),
      roll: 0,
    },
    duration: 1.5,
  });
}


/**
 * 设置初始俯视图
 * 相机位置更高，以展示全局场景
 */
function setInitialOverview() {
  if (!viewer || viewer.isDestroyed()) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(104.0, 30.4, 19500000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-88),
      roll: 0,
    },
    duration: 1.8,
  });
}


/**
 * 打开链路参数副屏
 * 如果弹窗被浏览器阻止，降级为普通新标签页
 */
function openMetricsScreen() {
  const opened = openMetricsScreenWindow(selectedScenario.value);
  if (!opened) {
    window.open(`/metrics.html?scenario=${encodeURIComponent(selectedScenario.value)}`, "_blank");
  }
}


/**
 * 清理场景加载句柄
 * 释放 CZML 资源和动态对象
 */
function cleanupScenarioHandles() {
  if (mainScenarioHandle) {
    mainScenarioHandle.cleanup();
    mainScenarioHandle = null;
  }
}


/**
 * 销毁所有 Cesium 场景
 * 清理事件监听、句柄、viewer 实例
 */
function destroyAllScenes() {
  if (removeAutoRotate) removeAutoRotate();
  if (removeImageryNetworkSync) {
    removeImageryNetworkSync();
    removeImageryNetworkSync = null;
  }
  if (removeImageryFallback) {
    removeImageryFallback();
    removeImageryFallback = null;
  }
  unbindScreenSyncTick();
  unbindEntityPickHandler();
  cleanupScenarioHandles();
  latestActiveTopology = new Map();
  latestActiveRoutes = new Map();
  latestRelativeTimeS = 0;
  clearSelectedEntity();

  if (viewer && !viewer.isDestroyed()) viewer.destroy();

  viewer = null;
  removeAutoRotate = null;
  lastRotateTime = null;
}


/**
 * 初始化主 3D 场景
 *
 * 加载流程：
 * 1. 创建 Cesium Viewer
 * 2. 从 CZML 数据源加载仿真数据（卫星、飞机、地面站、链路、覆盖区域）
 * 3. 绑定地球自转和屏幕同步
 * 4. 设置初始相机视角
 * 5. 向副屏广播当前状态
 *
 * 配置说明：
 * - showSatelliteModel: 渲染卫星 3D 模型（启用池化以优化性能）
 * - showCoverage: 显示通信覆盖范围
 * - showTopologyLinks: 显示链路拓扑
 * - showLabels: 显示卫星标签
 */
async function initializeMainScene() {
  sceneLoading.value = true;
  sceneLoadError.value = "";
  sceneEmpty.value = false;
  coverageWarning.value = "";
  if (!selectedScenario.value) {
    sceneLoading.value = false;
    sceneEmpty.value = true;
    return;
  }
  sceneLoadingText.value = "正在读取场景资源...";
  currentScenarioRuntime.value = await resolveScenarioRuntime(selectedScenario.value);

  createViewer();
  sceneLoadingText.value = "正在构建三维场景...";

  mainScenarioHandle = await loadSatsimScenario({
    viewer,
    czmlSource: currentCzmlSource(),
    bundleSource: currentBundleSource(),
    miniMode: false,
    showCoverage: true,
    showLabels: true,
    // 主地图未选中卫星使用批量化 SVG 代理；高精 tdrs.glb 仍由既有详情视图按需加载。
    showSatelliteModel: false,
    satelliteModelPoolEnabled: false,
    maxAircraft: 10,
    maxGroundStations: 1,
    showTopologyLinks: true,
    playbackMultiplier: playbackMultiplier.value,
    onSimulationTick: ({ relativeTimeS, activeTopology, activeRoutes }) => {
      latestRelativeTimeS = Number(relativeTimeS) || 0;
      latestActiveTopology = activeTopology || new Map();
      latestActiveRoutes = activeRoutes || new Map();
      if (selectedEntityId.value) {
        refreshSelectedEntityInfo();
      }
    },
  });
  coverageWarning.value = mainScenarioHandle.coverageWarning;

  bindEntityPickHandler();
  bindAutoRotate();
  bindScreenSyncTick();
  applyPlaybackToViewers();
  setInitialOverview();
  broadcastSnapshot();
  sceneLoading.value = false;
}


/**
 * 切换仿真场景
 *
 * 流程：
 * 1. 销毁当前主屏场景
 * 2. 加载新场景数据
 * 3. 向副屏广播新场景
 */
async function switchScenario() {
  if (isScenarioSwitching.value) return;

  isScenarioSwitching.value = true;
  try {
    destroyAllScenes();
    await initializeMainScene();
    syncRouteScenarioQuery();

    broadcastScenarioChanged();
    broadcastSnapshot();
  } catch (error) {
    sceneLoadError.value = error instanceof Error ? error.message : "场景加载失败，请稍后重试。";
  } finally {
    isScenarioSwitching.value = false;
  }
}


// ============= 生命周期 =============
/**
 * 组件挂载
 * 1. 初始化屏幕同步通道
 * 2. 初始化主 3D 场景
 */
onMounted(async () => {
  document.documentElement.classList.add("scene-page");
  document.body.classList.add("scene-page");
  document.getElementById("app")?.classList.add("scene-page");
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  await refreshServerScenarioRecords().catch(() => []);
  scenarioCatalogRefreshKey.value += 1;
  if (!ensureSelectedScenario()) {
    syncRouteScenarioQuery();
    initializeScreenSync();
    sceneLoading.value = false;
    sceneEmpty.value = true;
    return;
  }
  syncRouteScenarioQuery();
  initializeScreenSync();
  try {
    await initializeMainScene();
  } catch (error) {
    sceneLoadError.value = error instanceof Error ? error.message : "场景加载失败，请稍后重试。";
  }
});


/**
 * 组件卸载前
 * 销毁所有场景和资源，关闭同步通道
 */
onBeforeUnmount(() => {
  document.documentElement.classList.remove("scene-page");
  document.body.classList.remove("scene-page");
  document.getElementById("app")?.classList.remove("scene-page");
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  destroyAllScenes();
  closeScreenSync();
});
</script>

<style scoped>
.platform-title {
  position: absolute;
  top: 16px;
  left: 18px;
  z-index: 30;
  font-size: 2rem;
  font-weight: bold;
  letter-spacing: 1px;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 10px;
  text-shadow: 0 2px 8px #000a, 0 1px 0 #2228;
}

.platform-logo {
  height: 48px;
  width: auto;
  object-fit: contain;
  flex-shrink: 0;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6));
}

.platform-title-main {
  color: #005aab;
  font-weight: 900;
}

.platform-title-highlight {
  color: #80c642;
  font-weight: 900;
  margin-left: 2px;
}

:global(html.scene-page),
:global(body.scene-page),
:global(#app.scene-page),
.scene-root,
#cesiumContainer {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.scene-root {
  position: relative;
}

#cesiumContainer {
  background: radial-gradient(circle at 15% 20%, #13305a 0%, #0a1e3a 55%, #050d1e 100%);
  filter: saturate(1.08) contrast(1.04);
}

.scene-loading-mask {
  position: absolute;
  inset: 0;
  z-index: 18;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 50% 30%, rgba(43, 103, 168, 0.28), transparent 48%),
    linear-gradient(180deg, rgba(4, 12, 24, 0.3), rgba(4, 12, 24, 0.68));
  backdrop-filter: blur(3px);
}

.scene-loading-mask--error {
  background:
    radial-gradient(circle at 50% 30%, rgba(149, 34, 34, 0.24), transparent 48%),
    linear-gradient(180deg, rgba(16, 7, 7, 0.5), rgba(16, 7, 7, 0.78));
}

.scene-loading-card {
  width: min(420px, calc(100vw - 48px));
  padding: 20px 22px;
  border-radius: 16px;
  border: 1px solid rgba(125, 211, 252, 0.28);
  background: rgba(8, 20, 36, 0.82);
  box-shadow: 0 20px 50px rgba(2, 8, 18, 0.35);
  color: #e2e8f0;
  text-align: center;
}

.scene-loading-card strong {
  display: block;
  font-size: 18px;
}

.scene-loading-card p {
  margin: 8px 0 0;
  color: #cbd5e1;
  line-height: 1.6;
}

.tool-bar {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  /* 统一间距 */
  row-gap: 10px;
  max-width: calc(100vw - 24px);
  justify-content: flex-end;
  z-index: 20;
}

.coverage-warning {
  position: absolute;
  top: 62px;
  right: 12px;
  z-index: 20;
  max-width: min(360px, calc(100vw - 24px));
  padding: 8px 12px;
  border: 1px solid rgba(250, 204, 21, 0.48);
  border-radius: 8px;
  background: rgba(72, 47, 8, 0.9);
  color: #fef3c7;
  font-size: 12px;
  line-height: 1.45;
}

.playback-group {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与工具栏 gap 保持一致 */
  padding-left: 2px;
  margin-left: 0;
}

.playback-label {
  color: #dbeafe;
  font-size: 12px;
  white-space: nowrap;
}

.scenario-label {
  color: #dbeafe;
  font-size: 12px;
}

.scenario-select {
  display: inline-block;
  font-size: 13px;
}

.custom-select {
  position: relative;
  display: inline-block;
}

.custom-select-trigger {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  border: 1px solid rgba(125, 211, 252, 0.5);
  background: rgba(15, 23, 42, 0.78);
  color: #e2e8f0;
  padding: 8px 28px 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 400;
  outline: none;
  backdrop-filter: blur(4px);
  cursor: pointer;
  line-height: normal;
  position: relative;
}

.custom-select-trigger::after {
  content: "";
  position: absolute;
  right: 10px;
  top: 50%;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid #dbeafe;
  border-bottom: 1.5px solid #dbeafe;
  transform: translateY(-62%) rotate(45deg);
  pointer-events: none;
}

.custom-select.open .custom-select-trigger::after {
  transform: translateY(-28%) rotate(225deg);
}

.custom-select-trigger:hover {
  background: rgba(30, 41, 59, 0.86);
}

.custom-select-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.custom-select-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  min-width: 100%;
  border: 1px solid rgba(125, 211, 252, 0.5);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 8px 18px rgba(2, 8, 18, 0.44);
  z-index: 35;
}

.custom-select-option {
  width: 100%;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  font-size: 13px;
  padding: 7px 8px;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
}

.custom-select-option:hover {
  background: rgba(59, 130, 246, 0.22);
}

.custom-select-option.active {
  background: rgba(31, 68, 128, 0.32);
  color: #eff6ff;
}

.tool-btn {
  border: 1px solid rgba(125, 211, 252, 0.5);
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(4px);
}

.tool-btn:hover {
  background: rgba(30, 41, 59, 0.86);
}

.tool-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.entity-info-panel {
  position: absolute;
  top: 84px;
  left: 12px;
  width: min(360px, calc(100vw - 24px));
  max-height: calc(100vh - 110px);
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(122, 170, 210, 0.42) rgba(9, 20, 36, 0.08);
  z-index: 25;
  border: 1px solid rgba(116, 169, 212, 0.5);
  border-radius: 12px;
  background: linear-gradient(160deg, rgba(9, 20, 36, 0.86), rgba(8, 29, 52, 0.84));
  backdrop-filter: blur(5px);
  box-shadow: 0 10px 24px rgba(2, 8, 18, 0.52);
  padding: 12px;
}

.entity-info-panel::-webkit-scrollbar {
  width: 8px;
}

.entity-info-panel::-webkit-scrollbar-track {
  background: rgba(9, 20, 36, 0.12);
  border-radius: 999px;
}

.entity-info-panel::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(116, 169, 212, 0.5), rgba(78, 128, 170, 0.34));
  border-radius: 999px;
  border: 1px solid rgba(10, 28, 49, 0.32);
}

.entity-info-panel::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(132, 188, 231, 0.6), rgba(93, 150, 196, 0.45));
}

.entity-info-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.entity-type {
  margin: 0;
  color: #7dd3fc;
  font-size: 12px;
  letter-spacing: 1px;
}

.entity-info-header h3 {
  margin: 4px 0 0;
  color: #e2e8f0;
  font-size: 18px;
}

.entity-close-btn {
  border: 1px solid rgba(125, 211, 252, 0.45);
  background: rgba(15, 23, 42, 0.68);
  color: #dbeafe;
  border-radius: 8px;
  padding: 5px 10px;
  cursor: pointer;
}

.entity-info-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.entity-model-preview {
  margin-top: 10px;
  border: 1px solid rgba(125, 211, 252, 0.24);
  border-radius: 10px;
  background: radial-gradient(circle at 50% 30%, rgba(38, 86, 126, 0.42), rgba(11, 24, 40, 0.55));
  overflow: hidden;
}

.entity-model-preview model-viewer {
  width: 100%;
  height: 180px;
  --poster-color: transparent;
  background: transparent;
}

.entity-model-preview-loading {
  display: grid;
  height: 180px;
  place-items: center;
  color: rgba(226, 242, 255, 0.72);
  font-size: 13px;
}

.entity-model-preview-fallback {
  display: block;
  width: 100%;
  height: 180px;
  object-fit: contain;
  padding: 28px;
}

.entity-item {
  padding: 8px 9px;
  border-radius: 8px;
  background: rgba(11, 32, 58, 0.54);
  border: 1px solid rgba(117, 171, 213, 0.22);
}

.entity-item-label {
  display: block;
  color: #93c5fd;
  font-size: 12px;
}

.entity-item-value {
  display: block;
  margin-top: 2px;
  color: #f8fafc;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.entity-stats {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.entity-stat-card {
  border: 1px solid rgba(125, 211, 252, 0.23);
  border-radius: 8px;
  padding: 8px 9px;
  background: rgba(14, 40, 68, 0.45);
}

.entity-stat-label {
  color: #93c5fd;
  font-size: 12px;
  display: block;
}

.entity-stat-value {
  margin-top: 2px;
  color: #e2e8f0;
  font-size: 14px;
  display: block;
}

.entity-links {
  margin-top: 10px;
}

.entity-links h4 {
  margin: 0 0 7px;
  color: #cfe9ff;
  font-size: 14px;
}

.entity-links ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entity-links li {
  display: grid;
  grid-template-columns: 1.1fr 0.7fr 0.9fr 0.8fr;
  gap: 6px;
  font-size: 12px;
  color: #dbeafe;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: rgba(10, 28, 49, 0.46);
}

@media (max-width: 900px) {
  .entity-info-panel {
    top: 110px;
    max-height: calc(100vh - 130px);
  }

  .tool-btn {
    padding: 7px 10px;
    font-size: 12px;
  }

  .scenario-select {
    display: inline-block;
    font-size: 12px;
  }

  .custom-select-trigger {
    padding: 6px 24px 6px 8px;
    font-size: 12px;
  }
}
</style>
