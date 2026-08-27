import * as Cesium from "cesium";

export const OFFLINE_IMAGERY_MAX_LEVEL = 6;
export const AMAP_GLOBAL_IMAGERY_MAX_LEVEL = 7;
export const AMAP_CHINA_IMAGERY_MAX_LEVEL = 18;
export const AMAP_ANNOTATION_MAX_LEVEL = 8;

// 高等级卫星影像仅覆盖中国区域；全球层在实测稳定的 7 级停止后由 Cesium 放大父瓦片。
const AMAP_CHINA_HIGH_RES_RECTANGLE = Cesium.Rectangle.fromDegrees(72, 16, 138, 55);

const AMAP_PROBE_URLS = [
  "https://webst01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x=1&y=1&z=1",
  "https://webst02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x=1&y=1&z=1",
];
const AMAP_PROBE_TIMEOUT_MS = 5000;

const OFFLINE_DAY_TILE_URL = import.meta.env.VITE_OFFLINE_DAY_TILE_URL;

/** @type {WeakMap<Cesium.Viewer, { offline: Cesium.ImageryLayer | null, amapGlobalBase: Cesium.ImageryLayer | null, amapChinaBase: Cesium.ImageryLayer | null, amapAnno: Cesium.ImageryLayer | null }>} */
const viewerImageryState = new WeakMap();

let lastAmapReachable = null;
let amapProbePromise = null;

export function isOfflineImageryEnabled() {
  return typeof OFFLINE_DAY_TILE_URL === "string" && OFFLINE_DAY_TILE_URL.length > 0;
}

function getImageryState(viewer) {
  if (!viewerImageryState.has(viewer)) {
    viewerImageryState.set(viewer, {
      offline: null,
      amapGlobalBase: null,
      amapChinaBase: null,
      amapAnno: null,
    });
  }
  return viewerImageryState.get(viewer);
}

export function createOfflineImageryProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: `${OFFLINE_DAY_TILE_URL}/{z}/{x}/{reverseY}.png`,
    maximumLevel: OFFLINE_IMAGERY_MAX_LEVEL,
    minimumLevel: 0,
    tilingScheme: new Cesium.GeographicTilingScheme(),
  });
}

function createAmapBaseProvider({ maximumLevel, rectangle } = {}) {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://webst0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel,
    ...(rectangle ? { rectangle } : {}),
  });
}

function createAmapAnnotationProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&scl=1&ltype=4",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: AMAP_ANNOTATION_MAX_LEVEL,
    // 高德文字与图标已经烘焙进标注瓦片，按中国范围限制整层，避免国外灰色地名干扰首都层。
    rectangle: AMAP_CHINA_HIGH_RES_RECTANGLE,
  });
}

function probeImageUrl(url, timeoutMs = AMAP_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(false);
      return;
    }

    const image = new Image();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/** 探测高德是否可达（局域网-only 时返回 false，比 navigator.onLine 准确） */
export async function canReachAmapImagery() {
  for (const url of AMAP_PROBE_URLS) {
    if (await probeImageUrl(url)) {
      lastAmapReachable = true;
      return true;
    }
  }
  lastAmapReachable = false;
  return false;
}

function startAmapProbe() {
  if (!amapProbePromise) {
    amapProbePromise = canReachAmapImagery().finally(() => {
      amapProbePromise = null;
    });
  }
  return amapProbePromise;
}

if (typeof window !== "undefined") {
  startAmapProbe();
}

function ensureOfflineLayer(viewer) {
  const state = getImageryState(viewer);
  if (!state.offline && isOfflineImageryEnabled()) {
    state.offline = viewer.imageryLayers.addImageryProvider(createOfflineImageryProvider(), 0);
    state.offline.show = false;
  }
  return state.offline;
}

function ensureAmapLayers(viewer) {
  const state = getImageryState(viewer);
  if (!state.amapGlobalBase) {
    state.amapGlobalBase = viewer.imageryLayers.addImageryProvider(createAmapBaseProvider({
      maximumLevel: AMAP_GLOBAL_IMAGERY_MAX_LEVEL,
    }));
    state.amapChinaBase = viewer.imageryLayers.addImageryProvider(createAmapBaseProvider({
      maximumLevel: AMAP_CHINA_IMAGERY_MAX_LEVEL,
      rectangle: AMAP_CHINA_HIGH_RES_RECTANGLE,
    }));
    state.amapAnno = viewer.imageryLayers.addImageryProvider(createAmapAnnotationProvider());
    state.amapGlobalBase.show = false;
    state.amapChinaBase.show = false;
    state.amapAnno.show = false;
  }
  return state;
}

function setLayerVisible(layer, visible) {
  if (layer) {
    layer.show = visible;
  }
}

function showAmapOnly(viewer, offline, state) {
  ensureAmapLayers(viewer);
  setLayerVisible(offline, false);
  setLayerVisible(state.amapGlobalBase, true);
  setLayerVisible(state.amapChinaBase, true);
  setLayerVisible(state.amapAnno, true);
}

function showOfflineOnly(viewer, offline, state) {
  setLayerVisible(state.amapGlobalBase, false);
  setLayerVisible(state.amapChinaBase, false);
  setLayerVisible(state.amapAnno, false);
  setLayerVisible(offline, true);
}

/**
 * 探测外网：可达用高德，不可达用局域网同源瓦片 /tiles/day/。
 * @returns {Promise<"online" | "offline" | "none">}
 */
export async function applyGlobeImageryLayers(viewer) {
  if (!viewer || viewer.isDestroyed()) {
    return "none";
  }

  if (!isOfflineImageryEnabled()) {
    const state = getImageryState(viewer);
    viewer.imageryLayers.removeAll(true);
    state.offline = null;
    state.amapGlobalBase = null;
    state.amapChinaBase = null;
    state.amapAnno = null;
    ensureAmapLayers(viewer);
    const onlineState = getImageryState(viewer);
    setLayerVisible(onlineState.amapGlobalBase, true);
    setLayerVisible(onlineState.amapChinaBase, true);
    setLayerVisible(onlineState.amapAnno, true);
    viewer.scene.requestRender();
    return (await canReachAmapImagery()) ? "online" : "none";
  }

  const useAmap = await startAmapProbe();
  const state = getImageryState(viewer);

  if (useAmap) {
    showAmapOnly(viewer, state.offline, state);
    viewer.scene.requestRender();
    return "online";
  }

  const offline = ensureOfflineLayer(viewer);
  showOfflineOnly(viewer, offline, state);
  viewer.scene.requestRender();
  return "offline";
}

/** 高德连续失败时回退局域网瓦片 */
export function bindAmapImageryFallback(viewer) {
  if (!viewer || viewer.isDestroyed() || !isOfflineImageryEnabled()) {
    return () => {};
  }

  ensureAmapLayers(viewer);
  const state = getImageryState(viewer);

  let errorCount = 0;
  const onError = () => {
    if (!viewer || viewer.isDestroyed() || !state.amapGlobalBase?.show) {
      return;
    }
    errorCount += 1;
    if (errorCount < 3) {
      return;
    }
    console.warn("[offline-imagery] 高德瓦片加载失败，切换局域网瓦片");
    const offline = ensureOfflineLayer(viewer);
    showOfflineOnly(viewer, offline, state);
    viewer.scene.requestRender();
  };

  const monitoredProviders = [state.amapGlobalBase, state.amapChinaBase, state.amapAnno]
    .filter(Boolean)
    .map((layer) => layer.imageryProvider);
  for (const provider of monitoredProviders) {
    provider.errorEvent.addEventListener(onError);
  }

  return () => {
    errorCount = 0;
    for (const provider of monitoredProviders) {
      provider.errorEvent.removeEventListener(onError);
    }
  };
}

/**
 * 网络变化时重新探测并切换底图。
 * @returns {() => void} 取消监听
 */
export function bindGlobeImageryNetworkSync(viewer) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onNetworkChange = () => {
    void applyGlobeImageryLayers(viewer);
  };

  window.addEventListener("online", onNetworkChange);
  window.addEventListener("offline", onNetworkChange);

  return () => {
    window.removeEventListener("online", onNetworkChange);
    window.removeEventListener("offline", onNetworkChange);
  };
}

export function getLastAmapReachable() {
  return lastAmapReachable;
}
