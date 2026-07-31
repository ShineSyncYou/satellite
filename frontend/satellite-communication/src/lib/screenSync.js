/**
 * screenSync.js
 *
 * 主屏和副屏之间的双向同步机制
 * 使用 BroadcastChannel API 实现浏览器标签页之间的实时通信
 *
 * 消息类型：
 * - STATE_SNAPSHOT: 副屏请求/主屏返回当前完整状态（场景、播放速度、时间）
 * - TICK: 主屏广播仿真时刻更新
 * - SCENARIO_CHANGED: 场景切换通知
 * - PLAYBACK_CHANGED: 播放速度/状态变化通知
 * - REQUEST_SNAPSHOT: 副屏向主屏请求最新状态快照
 * - MAIN_SCREEN_DISCONNECTED: 主屏隐藏或进入后台，副屏保持最后一帧
 * - MAIN_SCREEN_EXITED: 主屏退出仿真，副屏停止在最后一帧
 */

export const SCREEN_SYNC_CHANNEL = "satsim-screen-sync-v1";

export const SCREEN_SYNC_MESSAGE_TYPES = Object.freeze({
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  TICK: "TICK",
  SCENARIO_CHANGED: "SCENARIO_CHANGED",
  PLAYBACK_CHANGED: "PLAYBACK_CHANGED",
  REQUEST_SNAPSHOT: "REQUEST_SNAPSHOT",
  MAIN_SCREEN_DISCONNECTED: "MAIN_SCREEN_DISCONNECTED",
  MAIN_SCREEN_EXITED: "MAIN_SCREEN_EXITED",
});

/**
 * 创建同步通道
 * 如果浏览器不支持 BroadcastChannel API，返回 null
 */
export function createScreenSyncChannel() {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(SCREEN_SYNC_CHANNEL);
}

/**
 * 通过同步通道发送消息
 *
 * @param {BroadcastChannel} channel - 通信通道
 * @param {string} type - 消息类型（SCREEN_SYNC_MESSAGE_TYPES 中定义）
 * @param {Object} payload - 消息负荷数据
 */
export function postScreenSyncMessage(channel, type, payload = {}) {
  if (!channel || typeof channel.postMessage !== "function") {
    return;
  }
  channel.postMessage({
    type,
    payload,
    timestampMs: Date.now(),
  });
}
