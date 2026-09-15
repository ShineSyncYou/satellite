// GLB 均为自包含资源。对象 URL 在当前页面生命周期内保留，跨路由复用，
// 避免云端缓存头不合适时 Cesium 再次下载；刷新页面后由浏览器释放。
export const AIRCRAFT_MODEL_URI = "/pictures/aircraft-v1-optimized-v1.glb";
export const GROUND_STATION_MODEL_URI = "/pictures/radar-optimized-v1.glb";
export const SATELLITE_MODEL_URI = "/pictures/tdrs-optimized-v1.glb";
export const GROUND_STATION_PREVIEW_MODEL_URI = "/pictures/ground-station-optimized-v1.glb";

const resources = new Map();
let scheduled = false;

export function getSceneModelUri(uri) {
  return resources.get(uri)?.objectUrl || uri;
}

export function preloadSceneModel(uri) {
  if (resources.has(uri)) return resources.get(uri).promise;
  const entry = {};
  resources.set(uri, entry);
  entry.promise = (async () => {
    const controller = new AbortController();
    // 云端实测飞机模型约 48 秒，弱网下不能过早中断后再从头下载。
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(uri, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      // 防止反向代理把模型请求错误地返回为 index.html。
      if (buffer.byteLength < 12 || new DataView(buffer).getUint32(0, true) !== 0x46546c67) {
        throw new Error("Invalid GLB");
      }
      entry.objectUrl = URL.createObjectURL(new Blob([buffer], { type: "model/gltf-binary" }));
      return entry.objectUrl;
    } catch (error) {
      resources.delete(uri);
      console.warn(`模型预加载失败，将由场景正常重试：${uri}`, error);
      return uri;
    } finally {
      clearTimeout(timeout);
    }
  })();
  return entry.promise;
}

export function scheduleSceneModelPreload() {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;
  const start = async () => {
    // 串行预取，优先飞机和地面站，减少与首页资源争抢带宽。
    for (const uri of [AIRCRAFT_MODEL_URI, GROUND_STATION_MODEL_URI, SATELLITE_MODEL_URI, GROUND_STATION_PREVIEW_MODEL_URI]) {
      await preloadSceneModel(uri);
    }
  };
  if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 2000 });
  else window.setTimeout(start, 1000);
}
