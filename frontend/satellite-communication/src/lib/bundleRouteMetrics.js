/**
 * bundleRouteMetrics.js
 *
 * 处理 satsim bundle.json 的指标提取模块。
 *
 * 当前项目已经改为“双文件方案”：
 * 1. render.czml：只负责实体动画渲染
 * 2. bundle.json：只负责 topology / route / metrics 等业务数据
 *
 * 这个模块专门读取 bundle.json，并把 AC -> GS 的链路指标整理成
 * 前端图表可直接消费的时间序列。
 */

import { normalizeTerminalOnlyRoute } from "./routePathPolicy";

const EPSILON = 1e-9;

const bundleCache = new Map();

/**
 * 生成路由的唯一标识符 (source|target 格式)
 */
function routeIdentity(route) {
  return `${String(route.source)}|${String(route.target)}`;
}

/**
 * 生成边的唯一标识符 (自动排序避免重复)
 */
function edgeIdentity(source, target) {
  const left = String(source);
  const right = String(target);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * 安全转换为数字，无效值返回默认值
 */
function toSafeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 收集仿真数据中的所有时间点（从轨迹、拓扑事件、路由事件）
 * 用于生成时间轴
 */
function collectBundleTimes(bundle) {
  const times = new Set();

  for (const track of bundle.node_tracks || []) {
    for (const sample of track.samples || []) {
      times.add(toSafeNumber(sample.relative_time_s, 0));
    }
  }
  for (const event of bundle.topology_events || []) {
    times.add(toSafeNumber(event.relative_time_s, 0));
  }
  for (const event of bundle.route_events || []) {
    times.add(toSafeNumber(event.relative_time_s, 0));
  }

  return [...times].sort((left, right) => left - right);
}

/**
 * 建立节点类型映射表 (nodeId → type)
 * 用于后续判断是否为 aircraft-groundstation 路由对
 */
function extractNodeTypeMap(bundle) {
  const nodeTypeMap = new Map();
  for (const track of bundle.node_tracks || []) {
    nodeTypeMap.set(String(track.id), String(track.type || ""));
  }
  return nodeTypeMap;
}

/**
 * 判断是否为 AC→GS（飞机到地面站）路由对
 * 仅关注此类路由的指标展示
 */
function isAircraftGroundStationPair(source, target, nodeTypeMap) {
  const sourceType = nodeTypeMap.get(String(source)) || "";
  const targetType = nodeTypeMap.get(String(target)) || "";
  return sourceType !== targetType
    && (sourceType === "aircraft" || targetType === "aircraft")
    && (sourceType === "ground_station" || targetType === "ground_station");
}

/**
 * 应用拓扑事件，更新当前链路状态
 * 支持 snapshot 和 delta 两种模式
 */
function applyTopologyEvent(currentLinks, event) {
  if (String(event.event_kind || "delta") === "snapshot") {
    currentLinks.clear();
  }

  for (const link of event.links_upsert || []) {
    currentLinks.set(edgeIdentity(link.source, link.target), {
      source: String(link.source),
      target: String(link.target),
      type: String(link.type || ""),
      bandwidth_mbps: toSafeNumber(link.bandwidth_mbps, 0),
      tx_rate_mbps: toSafeNumber(link.tx_rate_mbps, 0),
      utilization: toSafeNumber(link.utilization, 0),
    });
  }

  for (const link of event.links_remove || []) {
    currentLinks.delete(edgeIdentity(link.source, link.target));
  }
}

/**
 * 应用路由事件，更新当前路由状态
 * 记录路由的连接状态、跳数、带宽、延迟等指标
 */
function applyRouteEvent(currentRoutes, event, nodeTypeMap) {
  if (String(event.event_kind || "delta") === "snapshot") {
    currentRoutes.clear();
  }

  for (const route of event.routes || []) {
    const normalizedRoute = normalizeTerminalOnlyRoute(route, nodeTypeMap);
    const routeKey = routeIdentity(route);
    currentRoutes.set(routeKey, {
      source: String(route.source),
      target: String(route.target),
      connected: normalizedRoute.connected,
      path: normalizedRoute.path,
      hop_count: normalizedRoute.connected
        ? Math.max(0, normalizedRoute.path.length - 1)
        : 0,
      requested_bandwidth_mbps: toSafeNumber(route.requested_bandwidth_mbps, 0),
      actual_tx_bandwidth_mbps: toSafeNumber(route.actual_tx_bandwidth_mbps, 0),
      dropped_bandwidth_mbps: toSafeNumber(route.dropped_bandwidth_mbps, 0),
      effective_bandwidth_mbps: toSafeNumber(route.effective_bandwidth_mbps, 0),
      latency_ms: toSafeNumber(route.latency_ms, -1),
      packet_loss_rate: toSafeNumber(route.packet_loss_rate, 1),
      ber: toSafeNumber(route.ber, 1),
    });
  }
}

/**
 * 计算路由的带宽指标
 * - offeredBandwidthMbps: 路由请求发送速率
 * - effectiveBandwidthMbps: 实际有效带宽（考虑丢包率）
 */
function routeBandwidthMetrics(route, currentLinks) {
  const path = route.path || [];
  if (!route.connected || path.length < 2) {
    return { offeredBandwidthMbps: 0, effectiveBandwidthMbps: 0 };
  }

  const firstHop = currentLinks.get(edgeIdentity(path[0], path[1]));
  const actualTxBandwidthMbps = toSafeNumber(route.actual_tx_bandwidth_mbps, 0);
  const hasActualTxBandwidth = Number.isFinite(Number(route.actual_tx_bandwidth_mbps));
  const offeredBandwidthMbps = toSafeNumber(
    route.requested_bandwidth_mbps,
    actualTxBandwidthMbps > 0
      ? actualTxBandwidthMbps
      : (firstHop ? toSafeNumber(firstHop.tx_rate_mbps, 0) : 0),
  );

  let effectiveBandwidthMbps = toSafeNumber(route.effective_bandwidth_mbps, 0);
  if (effectiveBandwidthMbps <= 0 && !hasActualTxBandwidth && offeredBandwidthMbps > 0) {
    const packetLossRate = Math.min(Math.max(toSafeNumber(route.packet_loss_rate, 1), 0), 1);
    effectiveBandwidthMbps = offeredBandwidthMbps * Math.max(0, 1 - packetLossRate);
  }

  return { offeredBandwidthMbps, effectiveBandwidthMbps };
}

/**
 * 路由排序函数（源地址 → 目标地址的字典序）
 */
function sortRouteKeys(left, right) {
  const [leftSource, leftTarget] = left.split("|");
  const [rightSource, rightTarget] = right.split("|");
  if (leftSource !== rightSource) {
    return leftSource.localeCompare(rightSource);
  }
  return leftTarget.localeCompare(rightTarget);
}

/**
 * 从仿真包中提取所有 AC→GS 路由的时间序列指标
 *
 * @param {Object} bundle - 仿真数据包
 * @returns {Object} 包含路由列表、样本数据、仿真时长等信息
 */
export function buildRouteMetricsFromBundle(bundle) {
  const nodeTypeMap = extractNodeTypeMap(bundle);
  const timeline = collectBundleTimes(bundle);
  const topologyEvents = [...(bundle.topology_events || [])]
    .sort((left, right) => toSafeNumber(left.relative_time_s, 0) - toSafeNumber(right.relative_time_s, 0));
  const routeEvents = [...(bundle.route_events || [])]
    .sort((left, right) => toSafeNumber(left.relative_time_s, 0) - toSafeNumber(right.relative_time_s, 0));

  const currentLinks = new Map();
  const currentRoutes = new Map();
  let topologyIndex = 0;
  let routeIndex = 0;
  const samplesByRoute = new Map();

  // 按时间轴遍历，逐步应用事件，收集每条路由在各时间点的指标
  for (const relativeTimeS of timeline) {
    while (
      topologyIndex < topologyEvents.length
      && toSafeNumber(topologyEvents[topologyIndex].relative_time_s, 0) <= relativeTimeS + EPSILON
    ) {
      applyTopologyEvent(currentLinks, topologyEvents[topologyIndex]);
      topologyIndex += 1;
    }

    while (
      routeIndex < routeEvents.length
      && toSafeNumber(routeEvents[routeIndex].relative_time_s, 0) <= relativeTimeS + EPSILON
    ) {
      applyRouteEvent(currentRoutes, routeEvents[routeIndex], nodeTypeMap);
      routeIndex += 1;
    }

    const sortedRouteKeys = [...currentRoutes.keys()].sort(sortRouteKeys);
    for (const routeKey of sortedRouteKeys) {
      const route = currentRoutes.get(routeKey);
      if (!route) {
        continue;
      }
      // 仅关注 AC→GS 路由
      if (!isAircraftGroundStationPair(route.source, route.target, nodeTypeMap)) {
        continue;
      }

      const { offeredBandwidthMbps, effectiveBandwidthMbps } = routeBandwidthMetrics(route, currentLinks);
      const samples = samplesByRoute.get(routeKey) || [];
      samples.push({
        relativeTimeS,
        connected: Boolean(route.connected),
        offeredBandwidthMbps,
        effectiveBandwidthMbps,
        latencyMs: toSafeNumber(route.latency_ms, -1),
        packetLossRate: toSafeNumber(route.packet_loss_rate, 1),
        ber: toSafeNumber(route.ber, 1),
        hopCount: toSafeNumber(route.hop_count, 0),
      });
      samplesByRoute.set(routeKey, samples);
    }
  }

  return {
    routeKeys: [...samplesByRoute.keys()].sort(sortRouteKeys),
    samplesByRoute,
    durationSeconds: toSafeNumber(bundle?.metadata?.duration_s, 0),
    startTimeIso: String(bundle?.metadata?.start_time || ""),
  };
}

/**
 * 从独立 bundle.json 加载仿真包（带缓存）
 *
 * @param {string} bundleSource - bundle.json 文件 URL
 * @returns {Promise<Object>} 仿真包对象
 * @throws {Error} 如果加载或解析失败
 */
export async function loadSatsimBundleSource(bundleSource) {
  if (bundleSource && typeof bundleSource === "object") {
    if (!bundleSource.metadata || !Array.isArray(bundleSource.node_tracks)) {
      throw new Error("Invalid satsim bundle JSON payload.");
    }
    return bundleSource;
  }

  if (bundleCache.has(bundleSource)) {
    return bundleCache.get(bundleSource);
  }

  const response = await fetch(bundleSource);
  if (!response.ok) {
    throw new Error(`Failed to load bundle JSON: ${response.status} ${response.statusText}`);
  }

  const bundle = await response.json();
  if (!bundle || typeof bundle !== "object" || !bundle.metadata || !Array.isArray(bundle.node_tracks)) {
    throw new Error("Invalid satsim bundle JSON payload.");
  }

  bundleCache.set(bundleSource, bundle);
  return bundle;
}

/**
 * 二分查找最接近指定时间的样本索引
 */
export function findNearestSampleIndex(samples, relativeTimeS) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return -1;
  }

  let left = 0;
  let right = samples.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const middleTime = toSafeNumber(samples[middle]?.relativeTimeS, 0);
    if (Math.abs(middleTime - relativeTimeS) <= EPSILON) {
      return middle;
    }
    if (middleTime < relativeTimeS) {
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  if (left >= samples.length) {
    return samples.length - 1;
  }
  if (right < 0) {
    return 0;
  }
  const leftDistance = Math.abs(toSafeNumber(samples[left]?.relativeTimeS, 0) - relativeTimeS);
  const rightDistance = Math.abs(toSafeNumber(samples[right]?.relativeTimeS, 0) - relativeTimeS);
  return leftDistance < rightDistance ? left : right;
}
