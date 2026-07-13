import * as Cesium from "cesium";

export const OFFLINE_IMAGERY_MAX_LEVEL = 6;
export const AMAP_ANNOTATION_MAX_LEVEL = 8;

const AMAP_PROBE_URLS = [
  "https://webst01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x=1&y=1&z=1",
  "https://webst02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x=1&y=1&z=1",
];
const AMAP_PROBE_TIMEOUT_MS = 5000;

const OFFLINE_DAY_TILE_URL = import.meta.env.VITE_OFFLINE_DAY_TILE_URL;

/** @type {WeakMap<Cesium.Viewer, { offline: Cesium.ImageryLayer | null, amapBase: Cesium.ImageryLayer | null, amapAnno: Cesium.ImageryLayer | null }>} */
const viewerImageryState = new WeakMap();

let lastAmapReachable = null;
let amapProbePromise = null;

export function isOfflineImageryEnabled() {
  return typeof OFFLINE_DAY_TILE_URL === "string" && OFFLINE_DAY_TILE_URL.length > 0;
}

function getImageryState(viewer) {
  if (!viewerImageryState.has(viewer)) {
    viewerImageryState.set(viewer, { offline: null, amapBase: null, amapAnno: null });
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

function createAmapBaseProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://webst0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: 18,
  });
}

function createAmapAnnotationProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&scl=1&ltype=4",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: AMAP_ANNOTATION_MAX_LEVEL,
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
  if (!state.amapBase) {
    state.amapBase = viewer.imageryLayers.addImageryProvider(createAmapBaseProvider());
    state.amapAnno = viewer.imageryLayers.addImageryProvider(createAmapAnnotationProvider());
    state.amapBase.show = false;
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
  setLayerVisible(state.amapBase, true);
  setLayerVisible(state.amapAnno, true);
}

function showOfflineOnly(viewer, offline, state) {
  setLayerVisible(state.amapBase, false);
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
    state.amapBase = null;
    state.amapAnno = null;
    ensureAmapLayers(viewer);
    setLayerVisible(getImageryState(viewer).amapBase, true);
    setLayerVisible(getImageryState(viewer).amapAnno, true);
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
    if (!viewer || viewer.isDestroyed() || !state.amapBase?.show) {
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

  state.amapBase.imageryProvider.errorEvent.addEventListener(onError);
  if (state.amapAnno) {
    state.amapAnno.imageryProvider.errorEvent.addEventListener(onError);
  }

  return () => {
    errorCount = 0;
    state.amapBase?.imageryProvider.errorEvent.removeEventListener(onError);
    state.amapAnno?.imageryProvider.errorEvent.removeEventListener(onError);
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
