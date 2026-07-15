/**
 * loadSatsimScenario.js
 *
 * Cesium 场景加载核心模块
 * 负责从 CZML 数据源加载和动态渲染仿真数据
 *
 * 核心功能：
 * 1. 加载 CZML 数据和内嵌的 bundle 元数据
 * 2. 创建卫星、飞机、地面站等实体及其 3D 模型
 * 3. 渲染链路（AC→S、S→G、S→S）和覆盖范围
 * 4. 实时更新实体位置和动态属性（如可见性状态）
 * 5. 支持模型池化优化性能（卫星模型复用）
 * 6. 支持 2D 平面图和 3D 主屏两种渲染模式
 *
 * 颜色配置：
 * - 卫星：金黄色（#ffd75e），活跃时浅金色（#fff19f）
 * - 飞机：青色（#5eead4）
 * - 地面站：橙红色（#ff8c69）
 * - AC→S 链路：浅青色（#72f0ff）
 * - S→G 链路：淡橙色（#ffb08a）
 * - S→S 拓扑 ISL：深蓝灰色（#5d83a6，低透明度）
 * - S→S 路由 ISL：利用率驱动（绿→黄→红），同 A2S/S2G
 * - 覆盖波束：半透明浅蓝锥体 + 地表蜂窝（#4ea9ff）
 */

import * as Cesium from "cesium";

// ============= 颜色配置 =============
const SATELLITE_UNIFIED_COLOR = Cesium.Color.fromCssColorString("#ffd75e");
const SATELLITE_ACTIVE_COLOR = Cesium.Color.fromCssColorString("#fff19f");
const AIRCRAFT_COLOR = Cesium.Color.fromCssColorString("#5eead4");
const GROUND_STATION_COLOR = Cesium.Color.fromCssColorString("#ff8c69");
const LINK_IDLE_COLOR = Cesium.Color.fromCssColorString("#4ade80");
const LINK_BUSY_COLOR = Cesium.Color.fromCssColorString("#facc15");
const LINK_CONGESTED_COLOR = Cesium.Color.fromCssColorString("#ef4444");
const ROUTE_FALLBACK_COLOR = Cesium.Color.fromCssColorString("#c5d7eb");
const TOPOLOGY_ISL_COLOR = Cesium.Color.fromCssColorString("#5d83a6");
const COVERAGE_BEAM_COLOR = Cesium.Color.fromCssColorString("#4ea9ff").withAlpha(0.15);
const COVERAGE_COLOR = Cesium.Color.fromCssColorString("#4ea9ff").withAlpha(0.10);
const COVERAGE_OUTLINE_COLOR = Cesium.Color.fromCssColorString("#e8f7ff").withAlpha(0.30);
const GEO_BEAM_SEGMENT_COUNT = 48;
const LEO_FOOTPRINT_SEGMENT_COUNT = 48;
const GEO_BEAM_UPDATE_INTERVAL_MS = 160;
const HONEYCOMB_HEIGHT_M = 900;
// 服务小区的最小地表尺度；每个 footprint 内的整套网格只会等比例放大到内切边界。
const HONEYCOMB_CELL_RADIUS_M = 120000;
// 蜂窝为几何重建而非简单平移；80ms 在 5× 播放下可明显减轻跳变，同时仍保留批量 Primitive 性能收益。
const HONEYCOMB_UPDATE_INTERVAL_MS = 80;
const HONEYCOMB_PROJECTION_RAY_HEIGHT_M = 2000000;

// ============= 模型资源 =============
const SATELLITE_MODEL_URI = "/pictures/tdrs.glb";
const SATELLITE_PROXY_ICON_URI = "/pictures/satellite-proxy.svg";
const SATELLITE_PROXY_NEAR_DISTANCE_M = 6000000;
const AIRCRAFT_MODEL_URI = "/pictures/Airplane.glb";
const GROUND_STATION_MODEL_URI = "/pictures/radar.glb";
const SATELLITE_MODEL_SILHOUETTE_COLOR = Cesium.Color.fromCssColorString("#ffe7a3");

// ============= 临时计算对象（避免频繁 new，提升性能）=============
const scratchSourcePosition = new Cesium.Cartesian3();
const scratchTargetPosition = new Cesium.Cartesian3();
const scratchSatellitePosition = new Cesium.Cartesian3();
const scratchMidpoint = new Cesium.Cartesian3();
const scratchSatelliteVisibilitySphere = new Cesium.BoundingSphere(undefined, 1);
const scratchLinkColor = new Cesium.Color();
const scratchLinkColorLerp = new Cesium.Color();
const scratchPrimitiveSourcePosition = new Cesium.Cartesian3();
const scratchPrimitiveTargetPosition = new Cesium.Cartesian3();

/**
 * 安全克隆 JulianDate
 * 避免多处共享同一对象引起意外修改
 */
function cloneTime(value) {
  return Cesium.JulianDate.clone(value, new Cesium.JulianDate());
}

/**
 * 加载数据源：若 source 为字符串则 fetch + JSON 解析，否则直接返回已有对象。
 * @param {string|object} source - URL 字符串或已解析的 JSON
 * @param {string} label - 用于错误提示的名称
 */
function ensureLoadedData(source, label) {
  if (typeof source !== "string") {
    return Promise.resolve(source);
  }

  return fetch(source).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${label}: ${response.status} ${response.statusText}`);
    }
    return response.json();
  });
}

function isValidBundlePayload(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.metadata
    && Array.isArray(value.node_tracks),
  );
}

/**
 * 将当前 Cesium 时间转为相对于仿真起始的秒数，并处理循环播放的取模。
 * @param {Cesium.JulianDate} currentTime
 * @param {Cesium.JulianDate} startTime
 * @param {number} durationSeconds - 仿真总时长（秒）
 * @returns {number} 0 ~ durationSeconds 范围内的相对时间
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

/** 将 node_tracks 数组转为 Map<id, type>，供 O(1) 查询节点类型。 */
function toNodeTypeMap(nodeTracks) {
  const map = new Map();
  for (const track of nodeTracks || []) {
    map.set(track.id, track.type);
  }
  return map;
}

/**
 * 按节点类型筛选并排序 ID，可选截断到 maxCount 个。
 * 用于限制渲染的飞机/地面站数量（卫星不限制）。
 */
function limitedIds(nodeTracks, nodeType, maxCount) {
  const ids = (nodeTracks || [])
    .filter((track) => track.type === nodeType)
    .map((track) => track.id)
    .sort((left, right) => left.localeCompare(right));

  if (typeof maxCount === "number" && maxCount >= 0) {
    return ids.slice(0, maxCount);
  }
  return ids;
}

/**
 * 构建本次场景中实际渲染的节点 ID 集合（卫星全量 + 飞机/地面站按上限截断）。
 * CZML 加载后会通过此集合剔除多余实体，减少渲染开销。
 */
function buildVisibleNodeIds(nodeTracks, { maxAircraft, maxGroundStations }) {
  const satellites = limitedIds(nodeTracks, "satellite");
  const aircraft = limitedIds(nodeTracks, "aircraft", maxAircraft);
  const groundStations = limitedIds(nodeTracks, "ground_station", maxGroundStations);
  return new Set([...satellites, ...aircraft, ...groundStations]);
}

function sortByRelativeTime(items) {
  return [...(items || [])].sort(
    (left, right) => Number(left.relative_time_s) - Number(right.relative_time_s),
  );
}

function normalizeBundle(bundle, options) {
  // 统一在加载阶段完成节点筛选和事件排序，渲染阶段只做增量推进。
  const nodeTracks = [...(bundle.node_tracks || [])];
  const nodeTypeMap = toNodeTypeMap(nodeTracks);
  const visibleNodeIds = buildVisibleNodeIds(nodeTracks, options);
  const satelliteIds = nodeTracks
    .filter((track) => track.type === "satellite" && visibleNodeIds.has(track.id))
    .map((track) => track.id);
  const groundStationIds = nodeTracks
    .filter((track) => track.type === "ground_station" && visibleNodeIds.has(track.id))
    .map((track) => track.id);

  return {
    ...bundle,
    nodeTypeMap,
    visibleNodeIds,
    satelliteIds,
    groundStationIds,
    startJulian: Cesium.JulianDate.fromIso8601(bundle.metadata.start_time),
    durationSeconds: Number(bundle.metadata.duration_s),
    topologyEvents: sortByRelativeTime(bundle.topology_events),
    routeEvents: sortByRelativeTime(bundle.route_events),
  };
}

function applyViewerClock(viewer, dataSource, bundle, playbackMultiplier) {
  const effectiveMultiplier = Number(playbackMultiplier);
  if (dataSource.clock) {
    viewer.clock.startTime = cloneTime(dataSource.clock.startTime);
    viewer.clock.stopTime = cloneTime(dataSource.clock.stopTime);
    viewer.clock.currentTime = cloneTime(dataSource.clock.currentTime);
    viewer.clock.clockRange = dataSource.clock.clockRange;
    viewer.clock.multiplier = effectiveMultiplier;
    viewer.clock.shouldAnimate = true;
    viewer.clockTrackedDataSource = dataSource;
    return;
  }

  const startTime = Cesium.JulianDate.fromIso8601(bundle.metadata.start_time);
  const stopTime = Cesium.JulianDate.addSeconds(
    startTime,
    Number(bundle.metadata.duration_s),
    new Cesium.JulianDate(),
  );

  viewer.clock.startTime = cloneTime(startTime);
  viewer.clock.stopTime = cloneTime(stopTime);
  viewer.clock.currentTime = cloneTime(startTime);
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.multiplier = effectiveMultiplier;
  viewer.clock.shouldAnimate = true;
}

function pruneInvisibleEntities(dataSource, visibleNodeIds) {
  for (const entity of [...dataSource.entities.values]) {
    if (entity.id === "document") {
      continue;
    }
    if (!visibleNodeIds.has(entity.id)) {
      dataSource.entities.remove(entity);
    }
  }
}

/**
 * 确保实体有 ModelGraphics，并强制覆盖 URI。
 * 强制覆盖 URI 是为了防止 CZML 内嵌的 model 属性干扰（确保加载正确的 glb 文件）。
 */
function ensureModel(entity, uri, defaults) {
  if (!entity.model) {
    entity.model = new Cesium.ModelGraphics({
      uri,
      ...defaults,
    });
  }
  // Always force the URI so CZML-provided models get the correct file.
  entity.model.uri = new Cesium.ConstantProperty(uri);
}

function applySatelliteModel(entity, options) {
  ensureModel(entity, SATELLITE_MODEL_URI, {
    scale: options.satelliteModelScale,
    minimumPixelSize: options.satelliteModelMinPixelSize,
    maximumScale: options.satelliteModelMaximumScale,
    silhouetteColor: SATELLITE_MODEL_SILHOUETTE_COLOR,
    silhouetteSize: 1.1,
  });
  entity.model.scale = new Cesium.ConstantProperty(options.satelliteModelScale);
  entity.model.minimumPixelSize = new Cesium.ConstantProperty(options.satelliteModelMinPixelSize);
  entity.model.maximumScale = new Cesium.ConstantProperty(options.satelliteModelMaximumScale);
  entity.model.silhouetteColor = new Cesium.ConstantProperty(SATELLITE_MODEL_SILHOUETTE_COLOR);
  entity.model.silhouetteSize = new Cesium.ConstantProperty(1.1);
  entity.model.distanceDisplayCondition = new Cesium.ConstantProperty(
    new Cesium.DistanceDisplayCondition(0, options.satelliteModelMaxViewDistance),
  );
  entity.model.show = new Cesium.ConstantProperty(true);
}

function styleEntities(dataSource, bundle, options) {
  for (const entity of dataSource.entities.values) {
    if (entity.id === "document") {
      continue;
    }

    const nodeType = bundle.nodeTypeMap.get(entity.id);
    if (!nodeType) {
      continue;
    }

    if (entity.position && (nodeType === "satellite" || nodeType === "aircraft")) {
      entity.orientation = new Cesium.VelocityOrientationProperty(entity.position);
    }

    if (nodeType === "satellite") {
      if (entity.point) {
        entity.point.color = new Cesium.ConstantProperty(SATELLITE_UNIFIED_COLOR);
        entity.point.pixelSize = new Cesium.ConstantProperty(options.miniMode ? 2 : 1.8);
        entity.point.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK.withAlpha(0.25));
        entity.point.outlineWidth = new Cesium.ConstantProperty(1);
        entity.point.show = new Cesium.ConstantProperty(!options.useSatellitePrimitives);
      }

      if (entity.path) {
        entity.path.show = new Cesium.ConstantProperty(false);
      }

      if (!options.miniMode && options.showSatelliteModel && (!options.satelliteModelPoolEnabled || isGeoSatelliteId(entity.id))) {
        // GEO 卫星不进入延迟模型池，避免高轨模型在播放一段时间后突然出现。
        applySatelliteModel(entity, {
          ...options,
          satelliteModelMaxViewDistance: isGeoSatelliteId(entity.id)
            ? Math.max(options.satelliteModelMaxViewDistance, 100000000)
            : options.satelliteModelMaxViewDistance,
        });
      } else {
        entity.model = undefined;
      }

      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(false);
        entity.label.text = new Cesium.ConstantProperty(entity.id);
        entity.label.fillColor = new Cesium.ConstantProperty(SATELLITE_ACTIVE_COLOR);
        entity.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK);
        entity.label.outlineWidth = new Cesium.ConstantProperty(3);
        entity.label.font = new Cesium.ConstantProperty("16px Segoe UI");
        entity.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, -34));
        entity.label.scaleByDistance = new Cesium.ConstantProperty(new Cesium.NearFarScalar(1.5e6, 1.25, 9e6, 0.55));
      }
    }

    if (nodeType === "aircraft") {
      if (entity.point) {
        entity.point.color = new Cesium.ConstantProperty(AIRCRAFT_COLOR);
        entity.point.pixelSize = new Cesium.ConstantProperty(options.miniMode ? 5 : 8);
        entity.point.show = new Cesium.ConstantProperty(options.miniMode);
      }

      // Hide aircraft trajectory path to avoid confusion with uplink/downlink lines.
      if (entity.path) {
        entity.path.show = new Cesium.ConstantProperty(false);
      }

      if (!options.miniMode) {
        ensureModel(entity, AIRCRAFT_MODEL_URI, {
          scale: options.aircraftModelScale,
          minimumPixelSize: options.aircraftModelMinPixelSize,
          maximumScale: options.aircraftModelMaximumScale,
        });
        entity.model.scale = new Cesium.ConstantProperty(options.aircraftModelScale);
        entity.model.minimumPixelSize = new Cesium.ConstantProperty(options.aircraftModelMinPixelSize);
        entity.model.maximumScale = new Cesium.ConstantProperty(options.aircraftModelMaximumScale);
        entity.model.show = new Cesium.ConstantProperty(true);
      }

      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(!options.miniMode);
        entity.label.fillColor = new Cesium.ConstantProperty(Cesium.Color.WHITE);
        entity.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK);
        entity.label.outlineWidth = new Cesium.ConstantProperty(3);
        entity.label.font = new Cesium.ConstantProperty("16px Segoe UI");
        entity.label.scaleByDistance = new Cesium.ConstantProperty(new Cesium.NearFarScalar(1.2e6, 1.2, 8e6, 0.6));
      }
    }

    if (nodeType === "ground_station") {
      if (entity.point) {
        entity.point.color = new Cesium.ConstantProperty(GROUND_STATION_COLOR);
        entity.point.pixelSize = new Cesium.ConstantProperty(options.miniMode ? 7 : 18);
        entity.point.outlineColor = new Cesium.ConstantProperty(Cesium.Color.WHITE);
        entity.point.outlineWidth = new Cesium.ConstantProperty(2);
        entity.point.show = new Cesium.ConstantProperty(options.miniMode);
      }

      if (!options.miniMode) {
        ensureModel(entity, GROUND_STATION_MODEL_URI, {
          scale: 0.95,
          minimumPixelSize: 38,
          maximumScale: 6000,
        });
        entity.model.show = new Cesium.ConstantProperty(true);
      } else {
        entity.model = undefined;
      }

      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(!options.miniMode);
        entity.label.fillColor = new Cesium.ConstantProperty(Cesium.Color.WHITE);
        entity.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK);
        entity.label.outlineWidth = new Cesium.ConstantProperty(3);
        entity.label.font = new Cesium.ConstantProperty("18px Segoe UI");
        entity.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, -38));
        entity.label.scaleByDistance = new Cesium.ConstantProperty(new Cesium.NearFarScalar(1.2e6, 1.2, 9e6, 0.65));
      }
    }

    if (options.miniMode) {
      if (entity.path) {
        entity.path.show = new Cesium.ConstantProperty(false);
      }
      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(false);
      }
      entity.model = undefined;
    }
  }
}

function createSatellitePointPrimitives(viewer, bundle, trackStore, entityLookup, miniMode) {
  const collection = new Cesium.PrimitiveCollection();
  const pointCollection = collection.add(new Cesium.PointPrimitiveCollection());
  const billboardCollection = miniMode ? null : collection.add(new Cesium.BillboardCollection());
  const lookup = new Map();

  for (const satId of bundle.satelliteIds) {
    const entity = entityLookup.get(satId);
    const track = trackStore.get(satId);
    if (!track) {
      continue;
    }

    const position = sampleCompactTrack(track, 0, new Cesium.Cartesian3());
    const point = pointCollection.add({
      // 代理必须返回原始 Entity，才能保留 Cesium 默认的双击跟踪行为。
      id: entity || satId,
      position,
      color: SATELLITE_UNIFIED_COLOR,
      pixelSize: miniMode ? 2 : 1.8,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.25),
      outlineWidth: 1,
      distanceDisplayCondition: miniMode
        ? undefined
        : new Cesium.DistanceDisplayCondition(SATELLITE_PROXY_NEAR_DISTANCE_M, Number.MAX_VALUE),
      show: true,
    });
    const billboard = billboardCollection?.add({
      id: entity || satId,
      position: Cesium.Cartesian3.clone(position),
      image: SATELLITE_PROXY_ICON_URI,
      width: 28,
      height: 18,
      color: SATELLITE_UNIFIED_COLOR,
      scale: 1,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, SATELLITE_PROXY_NEAR_DISTANCE_M),
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      show: true,
    }) || null;
    lookup.set(satId, { point, billboard });
  }

  viewer.scene.primitives.add(collection);
  return { collection, lookup };
}

function updateSatellitePointPrimitives(primitiveLookup, trackStore, relativeTime) {
  for (const [satId, proxy] of primitiveLookup) {
    const track = trackStore.get(satId);
    if (!track) {
      proxy.point.show = false;
      if (proxy.billboard) {
        proxy.billboard.show = false;
      }
      continue;
    }
    // 不能直接把 primitive.position 作为 result 传给 sampleCompactTrack：
    // Cesium Primitive setter 使用 Cartesian3.equals 做脏检测，
    // 而 Cartesian3.equals 对同一引用 (===) 直接短路返回 true，导致位置更新被跳过。
    // 先用 scratch 采样，再 clone 生成新引用触发 setter 更新。
    const position = sampleCompactTrack(track, relativeTime, scratchSatellitePosition);
    proxy.point.position = Cesium.Cartesian3.clone(position);
    proxy.point.show = true;
    if (proxy.billboard) {
      proxy.billboard.position = Cesium.Cartesian3.clone(position);
      proxy.billboard.show = true;
    }
  }
}

function selectNearestVisibleSatelliteIds(viewer, satelliteEntities, time, maxCount) {
  const camera = viewer.camera;
  const cullingVolume = camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera.positionWC);
  const visible = [];

  for (const entity of satelliteEntities) {
    const position = entity.position?.getValue(time, scratchSatellitePosition);
    if (!position) {
      continue;
    }

    if (!occluder.isPointVisible(position)) {
      continue;
    }

    scratchSatelliteVisibilitySphere.center = position;
    scratchSatelliteVisibilitySphere.radius = 1;
    if (cullingVolume.computeVisibility(scratchSatelliteVisibilitySphere) === Cesium.Intersect.OUTSIDE) {
      continue;
    }

    visible.push({
      id: entity.id,
      distance: Cesium.Cartesian3.distance(camera.positionWC, position),
    });
  }

  visible.sort((left, right) => left.distance - right.distance);
  return new Set(visible.slice(0, Math.max(0, Number(maxCount) || 0)).map((item) => item.id));
}

function clearSatelliteModels(entityLookup, modeledSatelliteIds) {
  for (const satId of modeledSatelliteIds) {
    const entity = entityLookup.get(satId);
    if (entity) {
      entity.model = undefined;
    }
  }
  modeledSatelliteIds.clear();
}

function syncSatelliteModelPool({
  entityLookup,
  modeledSatelliteIds,
  targetSatelliteIds,
  styleOptions,
}) {
  for (const satId of modeledSatelliteIds) {
    if (targetSatelliteIds.has(satId)) {
      continue;
    }
    const entity = entityLookup.get(satId);
    if (entity) {
      entity.model = undefined;
    }
  }

  for (const satId of targetSatelliteIds) {
    if (modeledSatelliteIds.has(satId)) {
      continue;
    }
    const entity = entityLookup.get(satId);
    if (entity) {
      applySatelliteModel(entity, styleOptions);
    }
  }

  modeledSatelliteIds.clear();
  for (const satId of targetSatelliteIds) {
    modeledSatelliteIds.add(satId);
  }
}

function buildEntityLookup(entities) {
  const lookup = new Map();
  for (const entity of entities.values) {
    lookup.set(entity.id, entity);
  }
  return lookup;
}

function routeSegmentType(sourceType, targetType) {
  if (sourceType === "aircraft" || targetType === "aircraft") {
    return "A2S";
  }
  if (sourceType === "ground_station" || targetType === "ground_station") {
    return "S2G";
  }
  return "S2S";
}

function clampRatio(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function linkLoadRatio(link) {
  if (!link || typeof link !== "object") {
    return null;
  }

  if (Number.isFinite(link.utilization)) {
    return clampRatio(link.utilization);
  }

  if (Number.isFinite(link.bandwidth_mbps) && link.bandwidth_mbps > 0 && Number.isFinite(link.tx_rate_mbps)) {
    return clampRatio(link.tx_rate_mbps / link.bandwidth_mbps);
  }

  return null;
}

function utilizationColor(ratio, alpha = 1) {
  const safeRatio = clampRatio(ratio);
  if (safeRatio < 0.5) {
    const t = safeRatio / 0.5;
    Cesium.Color.lerp(LINK_IDLE_COLOR, LINK_BUSY_COLOR, t, scratchLinkColorLerp);
  } else {
    const t = (safeRatio - 0.5) / 0.5;
    Cesium.Color.lerp(LINK_BUSY_COLOR, LINK_CONGESTED_COLOR, t, scratchLinkColorLerp);
  }
  return Cesium.Color.clone(scratchLinkColorLerp, scratchLinkColor).withAlpha(alpha);
}

function resolveActiveLink(activeTopology, source, target) {
  const candidates = [
    `${source}|${target}|ISL`,
    `${source}|${target}|GSL`,
    `${target}|${source}|ISL`,
    `${target}|${source}|GSL`,
  ];

  for (const key of candidates) {
    const link = activeTopology.get(key);
    if (link) {
      return link;
    }
  }
  return null;
}

function routeSegmentColor(segment) {
  if (Number.isFinite(segment.loadRatio)) {
    return utilizationColor(segment.loadRatio, 0.96);
  }
  return ROUTE_FALLBACK_COLOR;
}

function routeSegmentWidth(segmentOrType) {
  const type = typeof segmentOrType === "string" ? segmentOrType : segmentOrType?.type;
  if (type === "S2S") {
    return 1.1;
  }
  // A2S / S2G 接入链路
  return 1.2;
}

function applyRouteEvent(activeRoutes, event) {
  if (event.event_kind === "snapshot") {
    activeRoutes.clear();
  }

  for (const route of event.routes || []) {
    activeRoutes.set(`${route.source}|${route.target}`, {
      source: route.source,
      target: route.target,
      connected: Boolean(route.connected),
      path: [...(route.path || [])],
      hop_count: Number(route.hop_count),
      effective_bandwidth_mbps: Number(route.effective_bandwidth_mbps),
      latency_ms: Number(route.latency_ms),
      packet_loss_rate: Number(route.packet_loss_rate),
      ber: Number(route.ber),
    });
  }
}

function applyTopologyEvent(activeTopology, event) {
  if (event.event_kind === "snapshot") {
    activeTopology.clear();
  }

  for (const link of event.links_upsert || []) {
    activeTopology.set(`${link.source}|${link.target}|${link.type}`, {
      source: link.source,
      target: link.target,
      type: link.type,
      bandwidth_mbps: Number(link.bandwidth_mbps),
      tx_rate_mbps: Number(link.tx_rate_mbps),
      utilization: Number(link.utilization),
    });
  }

  for (const link of event.links_remove || []) {
    activeTopology.delete(`${link.source}|${link.target}|${link.type}`);
  }
}

function buildRouteSegments(activeRoutes, activeTopology, bundle) {
  const segments = [];
  const activeRouteSatelliteIds = new Set();

  for (const route of activeRoutes.values()) {
    if (!route.connected || route.path.length < 2) {
      continue;
    }
    if (!route.path.every((nodeId) => bundle.visibleNodeIds.has(nodeId))) {
      continue;
    }

    for (let index = 0; index < route.path.length - 1; index += 1) {
      const source = route.path[index];
      const target = route.path[index + 1];
      const sourceType = bundle.nodeTypeMap.get(source);
      const targetType = bundle.nodeTypeMap.get(target);
      const type = routeSegmentType(sourceType, targetType);
      const activeLink = resolveActiveLink(activeTopology, source, target);

      if (sourceType === "satellite") {
        activeRouteSatelliteIds.add(source);
      }
      if (targetType === "satellite") {
        activeRouteSatelliteIds.add(target);
      }

      segments.push({
        id: `route:${route.source}:${route.target}:${index}`,
        source,
        target,
        sourceType,
        targetType,
        type,
        linkType: activeLink?.type,
        loadRatio: linkLoadRatio(activeLink),
      });
    }
  }

  return {
    segments,
    activeRouteSatelliteIds,
    signature: segments
      .map((segment) => `${segment.source}>${segment.target}:${segment.type}:${segment.loadRatio ?? "na"}`)
      .join(";"),
  };
}

function positionPairCallback(entityLookup, sourceId, targetId) {
  return new Cesium.CallbackProperty((time) => {
    const sourceEntity = entityLookup.get(sourceId);
    const targetEntity = entityLookup.get(targetId);
    if (!sourceEntity?.position || !targetEntity?.position) {
      return [];
    }

    const sourcePosition = sourceEntity.position.getValue(time, scratchSourcePosition);
    const targetPosition = targetEntity.position.getValue(time, scratchTargetPosition);
    if (!sourcePosition || !targetPosition) {
      return [];
    }

    return [
      Cesium.Cartesian3.clone(sourcePosition, new Cesium.Cartesian3()),
      Cesium.Cartesian3.clone(targetPosition, new Cesium.Cartesian3()),
    ];
  }, false);
}

function rebuildRouteEntities(routeDataSource, entityLookup, segments) {
  routeDataSource.entities.removeAll();
  for (const segment of segments) {
    routeDataSource.entities.add({
      id: segment.id,
      polyline: {
        positions: positionPairCallback(entityLookup, segment.source, segment.target),
        width: routeSegmentWidth(segment.type),
        material: new Cesium.PolylineGlowMaterialProperty({
          color: routeSegmentColor(segment),
          glowPower: 0.16,
        }),
      },
    });
  }
}

function rebuildTopologyEntities(topologyDataSource, entityLookup, activeTopology, bundle) {
  topologyDataSource.entities.removeAll();
  for (const link of activeTopology.values()) {
    if (!bundle.visibleNodeIds.has(link.source) || !bundle.visibleNodeIds.has(link.target)) {
      continue;
    }
    if (link.type !== "ISL") {
      continue;
    }

    topologyDataSource.entities.add({
      id: `topology:${link.source}:${link.target}:${link.type}`,
      polyline: {
        positions: positionPairCallback(entityLookup, link.source, link.target),
        width: 0.55,
        material: TOPOLOGY_ISL_COLOR.withAlpha(0.16),
      },
    });
  }
}

function ensurePolylinePrimitive(collection, pool, index) {
  if (pool[index]) {
    return pool[index];
  }

  const polyline = collection.add({
    positions: [new Cesium.Cartesian3(), new Cesium.Cartesian3()],
    width: 1,
    material: Cesium.Material.fromType("Color", { color: ROUTE_FALLBACK_COLOR }),
    show: false,
  });
  polyline._satsimPositions = [new Cesium.Cartesian3(), new Cesium.Cartesian3()];
  pool[index] = polyline;
  return polyline;
}

function syncPolylinePrimitivePool(collection, pool, segments, options = {}) {
  const colorResolver = options.colorResolver || (() => ROUTE_FALLBACK_COLOR);
  const widthResolver = options.widthResolver || (() => 1);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const polyline = ensurePolylinePrimitive(collection, pool, index);
    const color = colorResolver(segment);
    polyline._satsimSegment = segment;
    polyline.width = widthResolver(segment);
    // 必须新建 Material 对象：Cesium Polyline 的 material setter 用引用比较 (===)，
    // 只改 uniforms.color 不会触发脏标记，渲染缓存会一直用旧颜色。
    polyline.material = Cesium.Material.fromType("Color", { color: Cesium.Color.clone(color) });
    polyline.show = true;
  }

  for (let index = segments.length; index < pool.length; index += 1) {
    if (pool[index]) {
      pool[index].show = false;
      pool[index]._satsimSegment = null;
    }
  }
}

const EARTH_OCCLUSION_MIN_HEIGHT_M = 0;

function isEarthOccluded(p1, p2) {
  Cesium.Cartesian3.midpoint(p1, p2, scratchMidpoint);
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(scratchMidpoint);
  return cartographic.height < EARTH_OCCLUSION_MIN_HEIGHT_M;
}

function updatePolylinePrimitivePositions(pool, trackStore, entityLookup, time, relativeTime) {
  for (const polyline of pool) {
    const segment = polyline?._satsimSegment;
    if (!polyline || !polyline.show || !segment) {
      continue;
    }

    const sourcePosition = resolveNodePosition(
      trackStore,
      entityLookup,
      segment.source,
      time,
      relativeTime,
      scratchPrimitiveSourcePosition,
    );
    const targetPosition = resolveNodePosition(
      trackStore,
      entityLookup,
      segment.target,
      time,
      relativeTime,
      scratchPrimitiveTargetPosition,
    );

    if (!sourcePosition || !targetPosition) {
      polyline.show = false;
      continue;
    }

    // 线段穿过地球内部时隐藏，避免渲染穿地的奇怪连线
    // （例如极轨星座 wrap-around 连接的两颗卫星分处地球两侧）
    if (isEarthOccluded(sourcePosition, targetPosition)) {
      polyline.show = false;
      continue;
    }

    Cesium.Cartesian3.clone(sourcePosition, polyline._satsimPositions[0]);
    Cesium.Cartesian3.clone(targetPosition, polyline._satsimPositions[1]);
    polyline.positions = polyline._satsimPositions;
  }
}

function buildTopologySegments(activeTopology, bundle) {
  const segments = [];
  for (const link of activeTopology.values()) {
    if (!bundle.visibleNodeIds.has(link.source) || !bundle.visibleNodeIds.has(link.target)) {
      continue;
    }
    if (link.type !== "ISL") {
      continue;
    }
    segments.push({
      id: `topology:${link.source}:${link.target}:${link.type}`,
      source: link.source,
      target: link.target,
      type: link.type,
    });
  }
  return {
    segments,
    signature: segments.map((segment) => `${segment.source}>${segment.target}:${segment.type}`).join(";"),
  };
}

function collectAccessSatelliteLinks(activeTopology, bundle) {
  const links = new Map();
  const bestBySatellite = new Map();
  for (const link of activeTopology.values()) {
    if (link.type !== "GSL") {
      continue;
    }
    if (!bundle.visibleNodeIds.has(link.source) || !bundle.visibleNodeIds.has(link.target)) {
      continue;
    }

    const sourceType = bundle.nodeTypeMap.get(link.source);
    const targetType = bundle.nodeTypeMap.get(link.target);
    let satId = "";
    let targetId = "";
    if (sourceType === "satellite" && (targetType === "ground_station" || targetType === "aircraft")) {
      satId = link.source;
      targetId = link.target;
    } else if ((sourceType === "ground_station" || sourceType === "aircraft") && targetType === "satellite") {
      satId = link.target;
      targetId = link.source;
    }

    if (satId && targetId) {
      const priority = Number.isFinite(link.tx_rate_mbps) ? Number(link.tx_rate_mbps) : 0;
      const current = bestBySatellite.get(satId);
      if (!current || priority > current.priority) {
        bestBySatellite.set(satId, { satId, priority });
      }
    }
  }
  for (const accessLink of bestBySatellite.values()) {
    links.set(accessLink.satId, { satId: accessLink.satId });
  }
  return links;
}

function getSubPointOnGround(satPosition, result = new Cesium.Cartesian3()) {
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(satPosition);
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    0,
    Cesium.Ellipsoid.WGS84,
    result,
  );
}

function isGeoSatelliteId(satelliteId) {
  return String(satelliteId || "").startsWith("sat_geo_");
}

function resolveBeamConfig(metadata) {
  const beam = metadata?.beam;
  const satelliteAngle = Number(beam?.sat_antenna_angle_deg);
  const geoAngle = Number(beam?.geo_sat_antenna_angle_deg);
  if (!Number.isFinite(satelliteAngle) || satelliteAngle <= 0 || !Number.isFinite(geoAngle) || geoAngle <= 0) {
    return null;
  }
  return { satelliteAngle, geoAngle };
}

function configuredBeamHalfAngleRad(satelliteId, beamConfig) {
  const degrees = isGeoSatelliteId(satelliteId) ? beamConfig.geoAngle : beamConfig.satelliteAngle;
  return Cesium.Math.toRadians(degrees);
}

function effectiveBeamHalfAngleRad(satellitePosition, satelliteId, beamConfig) {
  const subPoint = getSubPointOnGround(satellitePosition, new Cesium.Cartesian3());
  const surfaceRadius = Cesium.Cartesian3.magnitude(subPoint);
  const satelliteRadius = Cesium.Cartesian3.magnitude(satellitePosition);
  if (!Number.isFinite(surfaceRadius) || !Number.isFinite(satelliteRadius) || satelliteRadius <= surfaceRadius) {
    return 0;
  }
  // Keep a small margin inside the tangent ray so every boundary ray intersects WGS84.
  const horizonAngle = Math.asin(clampRatio(surfaceRadius / satelliteRadius)) - Cesium.Math.toRadians(0.05);
  return Math.max(0, Math.min(configuredBeamHalfAngleRad(satelliteId, beamConfig), horizonAngle));
}

function computeBeamFootprintRadius(satellitePosition, halfAngleRad) {
  const footprintPosition = getSubPointOnGround(satellitePosition, new Cesium.Cartesian3());
  const height = Cesium.Cartesian3.distance(satellitePosition, footprintPosition);
  return Math.max(1, height * Math.tan(halfAngleRad));
}

function buildGeoBeamBasis(satellitePosition) {
  const footprintPosition = getSubPointOnGround(satellitePosition, new Cesium.Cartesian3());
  const centerDirection = Cesium.Cartesian3.subtract(footprintPosition, satellitePosition, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(centerDirection, centerDirection);

  let axisX = Cesium.Cartesian3.cross(centerDirection, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(axisX) < 1e-6) {
    axisX = Cesium.Cartesian3.cross(centerDirection, Cesium.Cartesian3.UNIT_X, axisX);
  }
  Cesium.Cartesian3.normalize(axisX, axisX);

  const axisY = Cesium.Cartesian3.cross(axisX, centerDirection, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(axisY, axisY);

  return { centerDirection, axisX, axisY };
}

function computeGeoBeamDirection(basis, angleRad, halfAngleRad) {
  const ringDirection = Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(basis.axisX, Math.cos(angleRad), new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(basis.axisY, Math.sin(angleRad), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(basis.centerDirection, Math.cos(halfAngleRad), new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(ringDirection, Math.sin(halfAngleRad), ringDirection),
    new Cesium.Cartesian3(),
  );
  return Cesium.Cartesian3.normalize(direction, direction);
}

function intersectGeoBeamWithEarth(satellitePosition, direction) {
  const ray = new Cesium.Ray(satellitePosition, direction);
  const interval = Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84);
  if (!interval) {
    return null;
  }

  const distance = interval.start >= 0 ? interval.start : interval.stop;
  if (!Number.isFinite(distance) || distance < 0) {
    return null;
  }

  return Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());
}

function buildBeamFootprintPoints(satellitePosition, halfAngleRad, segmentCount = GEO_BEAM_SEGMENT_COUNT) {
  if (!satellitePosition) {
    return [];
  }

  const basis = buildGeoBeamBasis(satellitePosition);
  const footprintPoints = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const angleRad = (Cesium.Math.TWO_PI * index) / segmentCount;
    const direction = computeGeoBeamDirection(basis, angleRad, halfAngleRad);
    const point = intersectGeoBeamWithEarth(satellitePosition, direction);
    if (point) {
      footprintPoints.push(point);
    }
  }

  return footprintPoints;
}

function buildBeamConePrimitive(satellitePosition, footprintPoints) {
  if (footprintPoints.length < 3) {
    return null;
  }

  const vertexCount = footprintPoints.length + 1;
  const positions = new Float64Array(vertexCount * 3);
  positions[0] = satellitePosition.x;
  positions[1] = satellitePosition.y;
  positions[2] = satellitePosition.z;
  footprintPoints.forEach((point, index) => {
    const offset = (index + 1) * 3;
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
  });

  const indices = new Uint16Array(footprintPoints.length * 3);
  for (let index = 0; index < footprintPoints.length; index += 1) {
    const offset = index * 3;
    indices[offset] = 0;
    indices[offset + 1] = index + 1;
    indices[offset + 2] = ((index + 1) % footprintPoints.length) + 1;
  }

  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
    },
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });

  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(COVERAGE_BEAM_COLOR),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      closed: false,
    }),
    asynchronous: false,
  });
}

function removeGeoBeamPrimitive(info, coveragePrimitiveCollection) {
  if (!info.geoBeamPrimitive) {
    return;
  }
  coveragePrimitiveCollection.remove(info.geoBeamPrimitive);
  info.geoBeamPrimitive = null;
  info.geoBeamLastUpdateMs = Number.NEGATIVE_INFINITY;
}

function syncGeoBeamPrimitive(info, coveragePrimitiveCollection, satellitePosition, footprintPoints, force = false) {
  if (!satellitePosition) {
    removeGeoBeamPrimitive(info, coveragePrimitiveCollection);
    return false;
  }

  const now = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!force && info.geoBeamPrimitive && (now - info.geoBeamLastUpdateMs) < GEO_BEAM_UPDATE_INTERVAL_MS) {
    info.geoBeamPrimitive.show = true;
    return true;
  }

  const nextPrimitive = buildBeamConePrimitive(satellitePosition, footprintPoints);
  if (!nextPrimitive) {
    removeGeoBeamPrimitive(info, coveragePrimitiveCollection);
    return false;
  }

  const previousPrimitive = info.geoBeamPrimitive;
  info.geoBeamPrimitive = coveragePrimitiveCollection.add(nextPrimitive);
  info.geoBeamLastUpdateMs = now;
  if (previousPrimitive) {
    coveragePrimitiveCollection.remove(previousPrimitive);
  }
  return true;
}

function buildHoneycombRing(radius) {
  const results = [];
  for (let q = -radius; q <= radius; q += 1) {
    for (let r = -radius; r <= radius; r += 1) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) === radius) {
        results.push({ q, r });
      }
    }
  }
  results.sort((left, right) => Math.atan2(left.r + left.q / 2, left.q) - Math.atan2(right.r + right.q / 2, right.q));
  return results;
}

function buildHoneycombOffsets(maxRing) {
  const offsets = [{ q: 0, r: 0 }];
  for (let radius = 1; radius <= maxRing; radius += 1) {
    offsets.push(...buildHoneycombRing(radius));
  }
  return offsets;
}

function axialToLocalOffset(offset, radiusMeters) {
  return {
    x: radiusMeters * 1.5 * offset.q,
    y: radiusMeters * Math.sqrt(3) * (offset.r + offset.q / 2),
  };
}

function buildCompactTrackStore(bundle) {
  const tracks = new Map();

  for (const track of bundle.node_tracks || []) {
    if (!bundle.visibleNodeIds.has(track.id)) {
      continue;
    }

    const samples = sortByRelativeTime(track.samples);
    if (!samples.length) {
      continue;
    }

    const times = new Float32Array(samples.length);
    const positions = new Float32Array(samples.length * 3);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const position = Cesium.Cartesian3.fromDegrees(
        Number(sample.lon_deg),
        Number(sample.lat_deg),
        Number(sample.alt_km) * 1000,
      );
      times[index] = Number(sample.relative_time_s);
      positions[index * 3] = position.x;
      positions[index * 3 + 1] = position.y;
      positions[index * 3 + 2] = position.z;
    }

    tracks.set(track.id, {
      id: track.id,
      type: track.type,
      times,
      positions,
      cursor: 0,
    });
  }

  return tracks;
}

function copyCompactPosition(track, index, result) {
  const offset = index * 3;
  result.x = track.positions[offset];
  result.y = track.positions[offset + 1];
  result.z = track.positions[offset + 2];
  return result;
}

function sampleCompactTrack(track, relativeTime, result = new Cesium.Cartesian3()) {
  const lastIndex = track.times.length - 1;
  if (lastIndex <= 0 || relativeTime <= track.times[0]) {
    return copyCompactPosition(track, 0, result);
  }
  if (relativeTime >= track.times[lastIndex]) {
    return copyCompactPosition(track, lastIndex, result);
  }

  let cursor = Math.min(Math.max(track.cursor || 0, 0), lastIndex - 1);
  if (relativeTime < track.times[cursor]) {
    cursor = 0;
  }
  while (cursor < lastIndex - 1 && relativeTime > track.times[cursor + 1]) {
    cursor += 1;
  }
  track.cursor = cursor;

  const leftTime = track.times[cursor];
  const rightTime = track.times[cursor + 1];
  const ratio = rightTime > leftTime ? (relativeTime - leftTime) / (rightTime - leftTime) : 0;
  const leftOffset = cursor * 3;
  const rightOffset = (cursor + 1) * 3;
  result.x = Cesium.Math.lerp(track.positions[leftOffset], track.positions[rightOffset], ratio);
  result.y = Cesium.Math.lerp(track.positions[leftOffset + 1], track.positions[rightOffset + 1], ratio);
  result.z = Cesium.Math.lerp(track.positions[leftOffset + 2], track.positions[rightOffset + 2], ratio);
  return result;
}

function resolveNodePosition(trackStore, entityLookup, nodeId, time, relativeTime, result) {
  const compactTrack = trackStore.get(nodeId);
  if (compactTrack) {
    return sampleCompactTrack(compactTrack, relativeTime, result);
  }

  const entity = entityLookup.get(nodeId);
  return entity?.position?.getValue(time, result);
}

function signedArea(points) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function localPointToSurfacePosition(point, transform) {
  const rayOrigin = Cesium.Matrix4.multiplyByPoint(
    transform,
    new Cesium.Cartesian3(point.x, point.y, HONEYCOMB_PROJECTION_RAY_HEIGHT_M),
    new Cesium.Cartesian3(),
  );
  const down = Cesium.Matrix4.multiplyByPointAsVector(
    transform,
    new Cesium.Cartesian3(0, 0, -1),
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.normalize(down, down);
  const ray = new Cesium.Ray(rayOrigin, down);
  const interval = Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84);
  if (!interval) {
    return null;
  }
  const distance = interval.start >= 0 ? interval.start : interval.stop;
  if (!Number.isFinite(distance) || distance < 0) {
    return null;
  }
  const surfacePoint = Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(surfacePoint);
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    HONEYCOMB_HEIGHT_M,
    Cesium.Ellipsoid.WGS84,
  );
}

function elevatePositionAboveEllipsoid(position, heightMeters = HONEYCOMB_HEIGHT_M) {
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(position);
  if (!cartographic) {
    return null;
  }
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    heightMeters,
    Cesium.Ellipsoid.WGS84,
  );
}

function buildLeoHoneycombCells(satellitePosition, footprintPoints) {
  const footprintCenter = getSubPointOnGround(satellitePosition, new Cesium.Cartesian3());
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(footprintCenter);
  const inverse = Cesium.Matrix4.inverseTransformation(transform, new Cesium.Matrix4());
  let boundary = footprintPoints
    .map((position) => Cesium.Matrix4.multiplyByPoint(inverse, position, new Cesium.Cartesian3()))
    .map((position) => ({ x: position.x, y: position.y }));
  if (boundary.length < 3) {
    return [];
  }
  if (signedArea(boundary) < 0) {
    boundary = [...boundary].reverse();
  }

  // 取局部 footprint 的最小径向距离，得到完全位于真实 WGS84 边界内的内切圆。
  const inscribedRadius = Math.min(...boundary.map((point) => Math.hypot(point.x, point.y)));
  if (!Number.isFinite(inscribedRadius) || inscribedRadius <= 0) {
    return [];
  }

  // 默认以 120 km 为最小单元尺寸确定网格规模，再整体放大。
  // sqrt(3) * ring + 1 是六边形簇的保守外接半径系数，保证最外层完整格子内切 footprint。
  const targetRings = Math.max(
    0,
    Math.floor((inscribedRadius / HONEYCOMB_CELL_RADIUS_M - 1) / Math.sqrt(3)),
  );
  const cellRadius = inscribedRadius / (Math.sqrt(3) * targetRings + 1);

  return buildHoneycombOffsets(targetRings).map((offset) => {
    const center = axialToLocalOffset(offset, cellRadius);
    const hexagon = Array.from({ length: 6 }, (_, index) => {
      const angleRad = Cesium.Math.toRadians(index * 60);
      return {
        x: center.x + cellRadius * Math.cos(angleRad),
        y: center.y + cellRadius * Math.sin(angleRad),
      };
    });
    const positions = hexagon.map((point) => localPointToSurfacePosition(point, transform)).filter(Boolean);
    return positions.length >= 3 ? positions : null;
  }).filter(Boolean);
}

function buildLeoHoneycombFillPrimitive(cells) {
  if (!cells.length) {
    return null;
  }

  const positionValues = [];
  const indices = [];
  let vertexOffset = 0;
  for (const cell of cells) {
    for (const position of cell) {
      positionValues.push(position.x, position.y, position.z);
    }
    for (let index = 1; index < cell.length - 1; index += 1) {
      indices.push(vertexOffset, vertexOffset + index, vertexOffset + index + 1);
    }
    vertexOffset += cell.length;
  }
  if (!indices.length) {
    return null;
  }

  const positions = new Float64Array(positionValues);
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
    },
    indices: new Uint32Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });

  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(COVERAGE_BEAM_COLOR),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      closed: false,
    }),
    asynchronous: false,
  });
}

function positionIdentityKey(position) {
  return `${Math.round(position.x * 10)}:${Math.round(position.y * 10)}:${Math.round(position.z * 10)}`;
}

function buildLeoOutlineSegments(cells, footprintOutline) {
  const segments = [];
  const seenEdges = new Set();
  const addEdge = (start, end) => {
    const startKey = positionIdentityKey(start);
    const endKey = positionIdentityKey(end);
    if (startKey === endKey) {
      return;
    }
    const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    if (seenEdges.has(edgeKey)) {
      return;
    }
    seenEdges.add(edgeKey);
    segments.push([start, end]);
  };

  for (const cell of cells) {
    for (let index = 0; index < cell.length; index += 1) {
      addEdge(cell[index], cell[(index + 1) % cell.length]);
    }
  }
  for (let index = 0; index < footprintOutline.length; index += 1) {
    addEdge(footprintOutline[index], footprintOutline[(index + 1) % footprintOutline.length]);
  }
  return segments;
}

function ensureCoverageOutlinePolyline(collection, pool, index) {
  if (pool[index]) {
    return pool[index];
  }
  const polyline = collection.add({
    positions: [new Cesium.Cartesian3(), new Cesium.Cartesian3()],
    width: 1,
    material: Cesium.Material.fromType("Color", { color: Cesium.Color.clone(COVERAGE_OUTLINE_COLOR) }),
    show: false,
  });
  polyline._coveragePositions = [new Cesium.Cartesian3(), new Cesium.Cartesian3()];
  pool[index] = polyline;
  return polyline;
}

function syncLeoOutlinePolylinePool(renderer) {
  let index = 0;
  for (const slot of renderer.activeSlots.values()) {
    if (!slot.visible) {
      continue;
    }
    for (const segment of slot.outlineSegments) {
      const polyline = ensureCoverageOutlinePolyline(renderer.outlineCollection, renderer.outlinePool, index);
      Cesium.Cartesian3.clone(segment[0], polyline._coveragePositions[0]);
      Cesium.Cartesian3.clone(segment[1], polyline._coveragePositions[1]);
      polyline.positions = polyline._coveragePositions;
      polyline.show = true;
      index += 1;
    }
  }
  for (let cursor = index; cursor < renderer.outlinePool.length; cursor += 1) {
    renderer.outlinePool[cursor].show = false;
  }
  renderer.outlinesDirty = false;
}

function createLeoCoverageRenderer(viewer, coveragePrimitiveCollection) {
  return {
    coveragePrimitiveCollection,
    outlineCollection: viewer.scene.primitives.add(new Cesium.PolylineCollection()),
    outlinePool: [],
    activeSlots: new Map(),
    freeSlots: [],
    earthOccluder: new Cesium.Occluder(
      new Cesium.BoundingSphere(new Cesium.Cartesian3(), Cesium.Ellipsoid.WGS84.maximumRadius),
      viewer.camera.positionWC,
    ),
    outlinesDirty: false,
  };
}

function createLeoCoverageSlot() {
  return {
    satelliteId: "",
    beamPrimitive: null,
    fillPrimitive: null,
    outlineSegments: [],
    footprintRadius: 0,
    lastUpdateMs: Number.NEGATIVE_INFINITY,
    visible: false,
  };
}

function removeLeoCoverageFill(slot, coveragePrimitiveCollection) {
  if (!slot.fillPrimitive) {
    return;
  }
  coveragePrimitiveCollection.remove(slot.fillPrimitive);
  slot.fillPrimitive = null;
}

function removeLeoBeamCone(slot, coveragePrimitiveCollection) {
  if (!slot.beamPrimitive) {
    return;
  }
  coveragePrimitiveCollection.remove(slot.beamPrimitive);
  slot.beamPrimitive = null;
}

function acquireLeoCoverageSlot(renderer, satelliteId) {
  const current = renderer.activeSlots.get(satelliteId);
  if (current) {
    return current;
  }
  const slot = renderer.freeSlots.pop() || createLeoCoverageSlot();
  slot.satelliteId = satelliteId;
  slot.lastUpdateMs = Number.NEGATIVE_INFINITY;
  slot.visible = false;
  renderer.activeSlots.set(satelliteId, slot);
  return slot;
}

function releaseLeoCoverageSlot(renderer, slot) {
  removeLeoBeamCone(slot, renderer.coveragePrimitiveCollection);
  removeLeoCoverageFill(slot, renderer.coveragePrimitiveCollection);
  renderer.activeSlots.delete(slot.satelliteId);
  slot.satelliteId = "";
  slot.outlineSegments = [];
  slot.footprintRadius = 0;
  slot.lastUpdateMs = Number.NEGATIVE_INFINITY;
  slot.visible = false;
  renderer.freeSlots.push(slot);
  renderer.outlinesDirty = true;
}

function hideLeoCoverageSlot(renderer, slot) {
  if (slot.beamPrimitive) {
    slot.beamPrimitive.show = false;
  }
  if (slot.fillPrimitive) {
    slot.fillPrimitive.show = false;
  }
  if (slot.visible) {
    slot.visible = false;
    renderer.outlinesDirty = true;
  }
}

function isCoverageSphereVisible(viewer, renderer, sphere) {
  const camera = viewer.camera;
  const cullingVolume = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
  if (cullingVolume.computeVisibility(sphere) === Cesium.Intersect.OUTSIDE) {
    return false;
  }
  renderer.earthOccluder.cameraPosition = camera.positionWC;
  return renderer.earthOccluder.isBoundingSphereVisible(sphere);
}

function approximateLeoCoverageSphere(satellitePosition, halfAngleRad, previousRadius) {
  const center = getSubPointOnGround(satellitePosition, new Cesium.Cartesian3());
  const radius = previousRadius > 0
    ? previousRadius
    : computeBeamFootprintRadius(satellitePosition, halfAngleRad);
  return new Cesium.BoundingSphere(center, Math.max(1, radius));
}

function syncLeoCoverageSlot({ viewer, renderer, slot, satellitePosition, satelliteId, beamConfig, force }) {
  const halfAngleRad = effectiveBeamHalfAngleRad(satellitePosition, satelliteId, beamConfig);
  if (halfAngleRad <= 0) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }

  const approximateBounds = approximateLeoCoverageSphere(satellitePosition, halfAngleRad, slot.footprintRadius);
  if (!isCoverageSphereVisible(viewer, renderer, approximateBounds)) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }

  const now = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!force && slot.visible && slot.fillPrimitive && slot.beamPrimitive && (now - slot.lastUpdateMs) < HONEYCOMB_UPDATE_INTERVAL_MS) {
    slot.fillPrimitive.show = true;
    slot.beamPrimitive.show = true;
    return true;
  }

  const footprintPoints = buildBeamFootprintPoints(satellitePosition, halfAngleRad, LEO_FOOTPRINT_SEGMENT_COUNT);
  if (footprintPoints.length < 3) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }
  const footprintOutline = footprintPoints.map((point) => elevatePositionAboveEllipsoid(point)).filter(Boolean);
  if (footprintOutline.length < 3) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }
  const exactBounds = Cesium.BoundingSphere.fromPoints(footprintOutline);
  slot.footprintRadius = exactBounds.radius;
  if (!isCoverageSphereVisible(viewer, renderer, exactBounds)) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }

  const cells = buildLeoHoneycombCells(satellitePosition, footprintPoints);
  const nextFillPrimitive = buildLeoHoneycombFillPrimitive(cells);
  const nextBeamPrimitive = buildBeamConePrimitive(satellitePosition, footprintPoints);
  if (!nextFillPrimitive || !nextBeamPrimitive) {
    hideLeoCoverageSlot(renderer, slot);
    return false;
  }

  const previousFillPrimitive = slot.fillPrimitive;
  const previousBeamPrimitive = slot.beamPrimitive;
  slot.fillPrimitive = renderer.coveragePrimitiveCollection.add(nextFillPrimitive);
  slot.beamPrimitive = renderer.coveragePrimitiveCollection.add(nextBeamPrimitive);
  slot.outlineSegments = buildLeoOutlineSegments(cells, footprintOutline);
  slot.lastUpdateMs = now;
  slot.visible = true;
  renderer.outlinesDirty = true;
  if (previousFillPrimitive) {
    renderer.coveragePrimitiveCollection.remove(previousFillPrimitive);
  }
  if (previousBeamPrimitive) {
    renderer.coveragePrimitiveCollection.remove(previousBeamPrimitive);
  }
  return true;
}

function clearLeoCoverageRenderer(renderer) {
  for (const slot of [...renderer.activeSlots.values()]) {
    releaseLeoCoverageSlot(renderer, slot);
  }
  if (renderer.outlinesDirty) {
    syncLeoOutlinePolylinePool(renderer);
  }
}

function syncLeoCoverageRenderer({ viewer, renderer, entityLookup, accessLinks, time, beamConfig, force }) {
  const activeSatelliteIds = new Set();
  for (const accessLink of accessLinks.values()) {
    if (isGeoSatelliteId(accessLink.satId)) {
      continue;
    }
    const satEntity = entityLookup.get(accessLink.satId);
    const satellitePosition = satEntity?.position?.getValue(time, scratchSatellitePosition);
    if (!satellitePosition) {
      continue;
    }
    activeSatelliteIds.add(accessLink.satId);
    const slot = acquireLeoCoverageSlot(renderer, accessLink.satId);
    syncLeoCoverageSlot({
      viewer,
      renderer,
      slot,
      satellitePosition,
      satelliteId: accessLink.satId,
      beamConfig,
      force,
    });
  }

  for (const [satelliteId, slot] of [...renderer.activeSlots.entries()]) {
    if (!activeSatelliteIds.has(satelliteId)) {
      releaseLeoCoverageSlot(renderer, slot);
    }
  }
  if (renderer.outlinesDirty) {
    syncLeoOutlinePolylinePool(renderer);
  }
}

function ensureGeoCoverageEntity(coverageDataSource, entityLookup, geoCoverageEntities, accessLink, beamConfig) {
  const current = geoCoverageEntities.get(accessLink.satId);
  if (current) {
    return current;
  }

  const satEntity = entityLookup.get(accessLink.satId);
  if (!satEntity?.position) {
    return null;
  }

  const footprintEntity = coverageDataSource.entities.add({
    id: `coverage-footprint:${accessLink.satId}`,
    show: false,
    polygon: {
      hierarchy: new Cesium.ConstantProperty(new Cesium.PolygonHierarchy([])),
      material: COVERAGE_COLOR,
      outline: true,
      outlineColor: COVERAGE_OUTLINE_COLOR,
      perPositionHeight: false,
    },
  });

  const value = {
    footprintEntity,
    satEntity,
    geoBeamPrimitive: null,
    geoBeamLastUpdateMs: Number.NEGATIVE_INFINITY,
    visible: false,
  };
  geoCoverageEntities.set(accessLink.satId, value);
  return value;
}

function hideGeoCoverageEntity(info, coveragePrimitiveCollection) {
  info.footprintEntity.show = false;
  if (info.geoBeamPrimitive) {
    info.geoBeamPrimitive.show = false;
  }
  info.visible = false;
}

function releaseGeoCoverageEntity(coverageDataSource, geoCoverageEntities, satelliteId, coveragePrimitiveCollection) {
  const info = geoCoverageEntities.get(satelliteId);
  if (!info) {
    return;
  }
  removeGeoBeamPrimitive(info, coveragePrimitiveCollection);
  coverageDataSource.entities.remove(info.footprintEntity);
  geoCoverageEntities.delete(satelliteId);
}

function syncGeoCoverageEntity(info, coveragePrimitiveCollection, satellitePosition, satelliteId, beamConfig, force) {
  const now = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!force && info.visible && (now - info.geoBeamLastUpdateMs) < GEO_BEAM_UPDATE_INTERVAL_MS) {
    info.footprintEntity.show = true;
    if (info.geoBeamPrimitive) {
      info.geoBeamPrimitive.show = true;
    }
    return true;
  }

  const halfAngleRad = effectiveBeamHalfAngleRad(satellitePosition, satelliteId, beamConfig);
  const footprintPoints = halfAngleRad > 0
    ? buildBeamFootprintPoints(satellitePosition, halfAngleRad, GEO_BEAM_SEGMENT_COUNT)
    : [];
  if (footprintPoints.length < 3) {
    hideGeoCoverageEntity(info, coveragePrimitiveCollection);
    return false;
  }
  info.footprintEntity.polygon.hierarchy = new Cesium.ConstantProperty(new Cesium.PolygonHierarchy(footprintPoints));
  info.footprintEntity.show = true;

  const beamShown = syncGeoBeamPrimitive(
    info,
    coveragePrimitiveCollection,
    satellitePosition,
    footprintPoints,
    force || !info.visible,
  );
  info.visible = beamShown;
  return beamShown;
}

function updateCoverageVisibility({
  viewer,
  coverageDataSource,
  coveragePrimitiveCollection,
  leoCoverageRenderer,
  geoCoverageEntities,
  entityLookup,
  accessLinks,
  time,
  showCoverage,
  beamConfig,
  forceRefresh,
}) {
  if (!showCoverage || !beamConfig) {
    clearLeoCoverageRenderer(leoCoverageRenderer);
    for (const satelliteId of [...geoCoverageEntities.keys()]) {
      releaseGeoCoverageEntity(coverageDataSource, geoCoverageEntities, satelliteId, coveragePrimitiveCollection);
    }
    return;
  }

  syncLeoCoverageRenderer({
    viewer,
    renderer: leoCoverageRenderer,
    entityLookup,
    accessLinks,
    time,
    beamConfig,
    force: forceRefresh,
  });

  const activeGeoSatelliteIds = new Set();
  for (const accessLink of accessLinks.values()) {
    if (!isGeoSatelliteId(accessLink.satId)) {
      continue;
    }
    const info = ensureGeoCoverageEntity(coverageDataSource, entityLookup, geoCoverageEntities, accessLink, beamConfig);
    if (!info) {
      continue;
    }
    activeGeoSatelliteIds.add(accessLink.satId);
    const satPosition = info.satEntity.position.getValue(time, scratchSatellitePosition);
    if (satPosition) {
      syncGeoCoverageEntity(
        info,
        coveragePrimitiveCollection,
        satPosition,
        accessLink.satId,
        beamConfig,
        forceRefresh,
      );
    } else {
      hideGeoCoverageEntity(info, coveragePrimitiveCollection);
    }
  }
  for (const satelliteId of [...geoCoverageEntities.keys()]) {
    if (!activeGeoSatelliteIds.has(satelliteId)) {
      releaseGeoCoverageEntity(coverageDataSource, geoCoverageEntities, satelliteId, coveragePrimitiveCollection);
    }
  }
}

function applySatelliteActivityStyles(entityLookup, satellitePrimitiveLookup, lastActiveIds, nextActiveIds) {
  for (const satId of lastActiveIds) {
    if (nextActiveIds.has(satId)) {
      continue;
    }
    const entity = entityLookup.get(satId);
    if (!entity) {
      continue;
    }
    if (entity.label) {
      entity.label.show = new Cesium.ConstantProperty(false);
    }
    if (entity.point) {
      entity.point.color = new Cesium.ConstantProperty(SATELLITE_UNIFIED_COLOR);
      entity.point.pixelSize = new Cesium.ConstantProperty(1.8);
    }
    const proxy = satellitePrimitiveLookup?.get(satId);
    if (proxy) {
      proxy.point.color = SATELLITE_UNIFIED_COLOR;
      proxy.point.pixelSize = 1.8;
      if (proxy.billboard) {
        proxy.billboard.color = SATELLITE_UNIFIED_COLOR;
        proxy.billboard.scale = 1;
      }
    }
  }

  for (const satId of nextActiveIds) {
    const entity = entityLookup.get(satId);
    if (!entity) {
      continue;
    }
    if (entity.label) {
      entity.label.show = new Cesium.ConstantProperty(true);
    }
    if (entity.point) {
      entity.point.color = new Cesium.ConstantProperty(SATELLITE_ACTIVE_COLOR);
      entity.point.pixelSize = new Cesium.ConstantProperty(2.6);
    }
    const proxy = satellitePrimitiveLookup?.get(satId);
    if (proxy) {
      proxy.point.color = SATELLITE_ACTIVE_COLOR;
      proxy.point.pixelSize = 2.6;
      if (proxy.billboard) {
        proxy.billboard.color = SATELLITE_ACTIVE_COLOR;
        proxy.billboard.scale = 1.14;
      }
    }
  }
}

function createIncrementalState(bundle) {
  return {
    lastRelativeTime: -1,
    routeIndex: 0,
    topologyIndex: 0,
    activeRoutes: new Map(),
    activeTopology: new Map(),
  };
}

function resetIncrementalState(state) {
  state.lastRelativeTime = -1;
  state.routeIndex = 0;
  state.topologyIndex = 0;
  state.activeRoutes.clear();
  state.activeTopology.clear();
}

function advanceStateToTime(state, bundle, relativeTime, enableTopologyLinks) {
  let routeChanged = false;
  let topologyChanged = false;

  if (state.lastRelativeTime >= 0 && relativeTime + 1e-9 < state.lastRelativeTime) {
    resetIncrementalState(state);
  }

  while (
    state.routeIndex < bundle.routeEvents.length
    && Number(bundle.routeEvents[state.routeIndex].relative_time_s) <= relativeTime + 1e-9
  ) {
    applyRouteEvent(state.activeRoutes, bundle.routeEvents[state.routeIndex]);
    routeChanged = true;
    state.routeIndex += 1;
  }

  if (enableTopologyLinks) {
    while (
      state.topologyIndex < bundle.topologyEvents.length
      && Number(bundle.topologyEvents[state.topologyIndex].relative_time_s) <= relativeTime + 1e-9
    ) {
      applyTopologyEvent(state.activeTopology, bundle.topologyEvents[state.topologyIndex]);
      topologyChanged = true;
      state.topologyIndex += 1;
    }
  }

  state.lastRelativeTime = relativeTime;
  return { routeChanged, topologyChanged };
}


/**
 * 加载仿真场景到 Cesium 视图
 *
 * 核心流程：
 * 1. 从 CZML 数据源加载数据和内嵌的 bundle 元数据
 * 2. 创建 CZML DataSource 并添加到 viewer
 * 3. 配置 viewer 时钟和播放速度
 * 4. 初始化卫星、飞机、地面站等实体样式
 * 5. 创建并初始化链路、拓扑、覆盖等数据源
 * 6. 绑定时钟 tick 事件，实时更新场景
 *
 * 参数说明：
 * @param {Object} viewer - Cesium Viewer 实例
 * @param {string} czmlSource - CZML 数据源 URL
 * @param {boolean} miniMode - 平面图模式（禁用模型和覆盖）
 * @param {boolean} showCoverage - 显示通信覆盖范围
 * @param {boolean} showLabels - 显示实体标签
 * @param {boolean} showSatelliteModel - 显示卫星 3D 模型
 * @param {boolean} satelliteModelPoolEnabled - 启用卫星模型池化（优化性能）
 * @param {number} satelliteModelPoolSize - 模型池大小（同时显示的卫星数）
 * @param {number} maxAircraft - 最多显示的飞机数
 * @param {number} maxGroundStations - 最多显示的地面站数
 * @param {number} playbackMultiplier - 仿真播放速度倍数
 *
 * @returns {Promise<Object>} 返回场景句柄，包含：
 *   - bundle: 仿真元数据
 *   - dataSource: CZML DataSource
 *   - cleanup(): 清理资源的方法
 */
/**
 * 加载一组 satsim 场景到 Cesium Viewer。
 *
 * 注意当前输入是双文件：
 * 1. czmlSource：渲染层文件
 * 2. bundleSource：业务逻辑文件
 */
export async function loadSatsimScenario({
  viewer,
  czmlSource,
  bundleSource,
  miniMode = false,
  showCoverage = true,
  showLabels = true,
  showSatelliteModel = true,
  satelliteModelPoolEnabled = true,
  satelliteModelPoolSize = 60,
  satelliteModelEnableHeight = 12500000,
  satelliteModelDisableHeight = 13500000,
  satelliteModelUpdateThrottleMs = 250,
  satelliteModelScale = 0.21,
  satelliteModelMinPixelSize = 15,
  satelliteModelMaximumScale = 120000,
  satelliteModelMaxViewDistance = 32000000,
  aircraftModelScale = 30,
  aircraftModelMinPixelSize = 50,
  aircraftModelMaximumScale = 50000,
  maxAircraft = 10,
  maxGroundStations = 1,
  showTopologyLinks = true,
  playbackMultiplier = 6,
  onSimulationTick = null,
}) {
  const czmlPayload = await ensureLoadedData(czmlSource, "CZML");
  // bundle.json 才是 topology / route / 指标的真实来源。
  const bundlePayload = await ensureLoadedData(bundleSource, "satsim bundle JSON");
  if (!isValidBundlePayload(bundlePayload)) {
    throw new Error("Invalid satsim bundle payload.");
  }

  const bundle = normalizeBundle(bundlePayload, { maxAircraft, maxGroundStations });
  const beamConfig = resolveBeamConfig(bundle.metadata);
  const trackStore = buildCompactTrackStore(bundle);
  const dataSource = await Cesium.CzmlDataSource.load(czmlPayload);
  await viewer.dataSources.add(dataSource);
  pruneInvisibleEntities(dataSource, bundle.visibleNodeIds);
  applyViewerClock(viewer, dataSource, bundle, playbackMultiplier);
  styleEntities(dataSource, bundle, {
    miniMode,
    showLabels,
    showSatelliteModel,
    satelliteModelPoolEnabled,
    satelliteModelScale,
    satelliteModelMinPixelSize,
    satelliteModelMaximumScale,
    satelliteModelMaxViewDistance,
    aircraftModelScale,
    aircraftModelMinPixelSize,
    aircraftModelMaximumScale,
    useSatellitePrimitives: true,
  });

  const entityLookup = buildEntityLookup(dataSource.entities);
  const coverageDataSource = new Cesium.CustomDataSource("satsim-coverage");
  const satellitePrimitives = createSatellitePointPrimitives(viewer, bundle, trackStore, entityLookup, miniMode);
  const coveragePrimitiveCollection = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const leoCoverageRenderer = createLeoCoverageRenderer(viewer, coveragePrimitiveCollection);
  const routePolylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  const topologyPolylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  const routePolylinePool = [];
  const topologyPolylinePool = [];

  await viewer.dataSources.add(coverageDataSource);

  const incrementalState = createIncrementalState(bundle);
  const geoCoverageEntities = new Map();
  const activeRouteSatelliteIds = new Set();
  const satelliteStyleOptions = {
    satelliteModelScale,
    satelliteModelMinPixelSize,
    satelliteModelMaximumScale,
    satelliteModelMaxViewDistance,
  };
  // 主地图默认不加载卫星 GLB；Cesium 跟踪某颗卫星时才临时使用这一套高精参数。
  const satelliteDetailStyleOptions = {
    satelliteModelScale: 0.65,
    satelliteModelMinPixelSize: 96,
    satelliteModelMaximumScale: 120000,
    satelliteModelMaxViewDistance: Number.MAX_VALUE,
  };
  const enableSatelliteModelPool = !miniMode && showSatelliteModel && satelliteModelPoolEnabled;
  const satelliteEntities = enableSatelliteModelPool
    ? bundle.satelliteIds
      .filter((satId) => !isGeoSatelliteId(satId))
      .map((satId) => entityLookup.get(satId))
      .filter((entity) => entity?.position)
    : [];
  const modeledSatelliteIds = new Set();
  let trackedSatelliteId = "";
  let satelliteModelPoolActive = false;
  let lastModelPoolUpdateMs = Number.NEGATIVE_INFINITY;
  let lastRouteSignature = "";
  let lastTopologySignature = "";
  let lastAppliedRelativeTime = Number.NaN;
  let lastCoverageRelativeTime = Number.NEGATIVE_INFINITY;
  let lastCoverageUpdateMs = Number.NEGATIVE_INFINITY;
  let coverageForceRefresh = true;
  let topologyRestoreTimer = null;

  const updateSatelliteModelPool = (time, force = false) => {
    if (!enableSatelliteModelPool) {
      return;
    }

    const cameraHeight = viewer.camera.positionCartographic?.height;
    if (!Number.isFinite(cameraHeight)) {
      return;
    }

    if (!satelliteModelPoolActive && cameraHeight <= satelliteModelEnableHeight) {
      satelliteModelPoolActive = true;
    } else if (satelliteModelPoolActive && cameraHeight >= satelliteModelDisableHeight) {
      satelliteModelPoolActive = false;
      clearSatelliteModels(entityLookup, modeledSatelliteIds);
      return;
    }

    if (!satelliteModelPoolActive) {
      return;
    }

    const now = (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
    if (!force && (now - lastModelPoolUpdateMs) < Number(satelliteModelUpdateThrottleMs)) {
      return;
    }
    lastModelPoolUpdateMs = now;

    const targetSatelliteIds = selectNearestVisibleSatelliteIds(
      viewer,
      satelliteEntities,
      time,
      satelliteModelPoolSize,
    );
    syncSatelliteModelPool({
      entityLookup,
      modeledSatelliteIds,
      targetSatelliteIds,
      styleOptions: satelliteStyleOptions,
    });
  };

  const syncTrackedSatelliteModel = (trackedEntity) => {
    const nextSatelliteId = bundle.nodeTypeMap.get(trackedEntity?.id) === "satellite"
      ? trackedEntity.id
      : "";
    if (trackedSatelliteId && trackedSatelliteId !== nextSatelliteId) {
      const previousEntity = entityLookup.get(trackedSatelliteId);
      if (previousEntity) {
        previousEntity.model = undefined;
      }
    }

    trackedSatelliteId = nextSatelliteId;
    if (!trackedSatelliteId) {
      return;
    }

    const entity = entityLookup.get(trackedSatelliteId);
    if (!entity) {
      trackedSatelliteId = "";
      return;
    }
    applySatelliteModel(entity, satelliteDetailStyleOptions);
  };
  const onTrackedEntityChanged = (trackedEntity) => syncTrackedSatelliteModel(trackedEntity);
  viewer.trackedEntityChanged.addEventListener(onTrackedEntityChanged);

  const updateScene = (time) => {
    // Cesium 在暂停、相机缩放时仍会触发 clock.onTick。
    // 世界坐标只在仿真时刻变化时更新，避免静态场景重复重建点、链路和覆盖。
    const relativeTime = normalizeRelativeTime(time, bundle.startJulian, bundle.durationSeconds);
    const simulationTimeChanged = !Number.isFinite(lastAppliedRelativeTime)
      || Math.abs(relativeTime - lastAppliedRelativeTime) > 1e-6;
    if (!simulationTimeChanged) {
      return;
    }

    const coverageTimeRewound = relativeTime + 1e-9 < lastCoverageRelativeTime;
    updateSatellitePointPrimitives(satellitePrimitives.lookup, trackStore, relativeTime);

    const { routeChanged, topologyChanged } = advanceStateToTime(
      incrementalState,
      bundle,
      relativeTime,
      showTopologyLinks && !miniMode,
    );

    if (routeChanged || topologyChanged || lastRouteSignature === "") {
      const routeState = buildRouteSegments(
        incrementalState.activeRoutes,
        incrementalState.activeTopology,
        bundle,
      );
      if (routeState.signature !== lastRouteSignature) {
        syncPolylinePrimitivePool(routePolylineCollection, routePolylinePool, routeState.segments, {
          colorResolver: routeSegmentColor,
          widthResolver: (segment) => routeSegmentWidth(segment),
        });
        applySatelliteActivityStyles(
          entityLookup,
          satellitePrimitives.lookup,
          activeRouteSatelliteIds,
          routeState.activeRouteSatelliteIds,
        );

        activeRouteSatelliteIds.clear();
        for (const satId of routeState.activeRouteSatelliteIds) {
          activeRouteSatelliteIds.add(satId);
        }
        lastRouteSignature = routeState.signature;
      }
    }
    updatePolylinePrimitivePositions(routePolylinePool, trackStore, entityLookup, time, relativeTime);

    if ((showTopologyLinks && !miniMode) && (topologyChanged || incrementalState.lastRelativeTime < 1e-9)) {
      const topologyState = buildTopologySegments(incrementalState.activeTopology, bundle);
      if (topologyState.signature !== lastTopologySignature) {
        syncPolylinePrimitivePool(topologyPolylineCollection, topologyPolylinePool, topologyState.segments, {
          colorResolver: () => TOPOLOGY_ISL_COLOR.withAlpha(0.16),
          widthResolver: () => 0.55,
        });
        lastTopologySignature = topologyState.signature;
      }
    }
    updatePolylinePrimitivePositions(topologyPolylinePool, trackStore, entityLookup, time, relativeTime);

    // 卫星代理、飞机和链路线在每帧更新；只有裁切蜂窝/波束几何按独立频率重建。
    const coverageNow = (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
    const coverageForce = coverageForceRefresh || topologyChanged || coverageTimeRewound;
    if (coverageForce || (coverageNow - lastCoverageUpdateMs) >= HONEYCOMB_UPDATE_INTERVAL_MS) {
      updateCoverageVisibility({
        viewer,
        coverageDataSource,
        coveragePrimitiveCollection,
        leoCoverageRenderer,
        geoCoverageEntities,
        entityLookup,
        accessLinks: collectAccessSatelliteLinks(incrementalState.activeTopology, bundle),
        time,
        showCoverage: showCoverage && !miniMode,
        beamConfig,
        forceRefresh: coverageForce,
      });
      coverageForceRefresh = false;
      lastCoverageRelativeTime = relativeTime;
      lastCoverageUpdateMs = coverageNow;
    }
    lastAppliedRelativeTime = relativeTime;
    updateSatelliteModelPool(time);

    // 向外部透出当前仿真帧状态，便于 UI 侧构建信息面板/统计面板。
    if (typeof onSimulationTick === "function") {
      onSimulationTick({
        time,
        relativeTimeS: relativeTime,
        bundle,
        entityLookup,
        activeRoutes: incrementalState.activeRoutes,
        activeTopology: incrementalState.activeTopology,
      });
    }

    if (viewer.scene.requestRenderMode) {
      viewer.scene.requestRender();
    }
  };

  const onCameraMoveStart = () => {
    if (topologyRestoreTimer) {
      clearTimeout(topologyRestoreTimer);
      topologyRestoreTimer = null;
    }
    if (showTopologyLinks && !miniMode) {
      topologyPolylineCollection.show = false;
    }
  };

  const onCameraMoveEnd = () => {
    if (!showTopologyLinks || miniMode) {
      return;
    }
    if (topologyRestoreTimer) {
      clearTimeout(topologyRestoreTimer);
    }
    topologyRestoreTimer = setTimeout(() => {
      topologyRestoreTimer = null;
      if (!viewer || viewer.isDestroyed()) {
        return;
      }
      topologyPolylineCollection.show = true;
      if (viewer.scene.requestRenderMode) {
        viewer.scene.requestRender();
      }
    }, 200);
  };
  viewer.camera.moveStart.addEventListener(onCameraMoveStart);
  viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);
  if (enableSatelliteModelPool) {
    updateSatelliteModelPool(viewer.clock.currentTime, true);
  }

  const onTick = (clock) => updateScene(clock.currentTime);
  viewer.clock.onTick.addEventListener(onTick);
  updateScene(viewer.clock.currentTime);

  return {
    bundle,
    dataSource,
    entityLookup,
    coverageAvailable: Boolean(beamConfig),
    coverageWarning: beamConfig ? "" : "场景缺少波束参数，请重新生成。",
    cleanup() {
      viewer.clock.onTick.removeEventListener(onTick);
      viewer.camera.moveStart.removeEventListener(onCameraMoveStart);
      viewer.camera.moveEnd.removeEventListener(onCameraMoveEnd);
      viewer.trackedEntityChanged.removeEventListener(onTrackedEntityChanged);
      if (topologyRestoreTimer) {
        clearTimeout(topologyRestoreTimer);
        topologyRestoreTimer = null;
      }
      if (enableSatelliteModelPool) {
        clearSatelliteModels(entityLookup, modeledSatelliteIds);
      }
      if (trackedSatelliteId) {
        const detailEntity = entityLookup.get(trackedSatelliteId);
        if (detailEntity) {
          detailEntity.model = undefined;
        }
        trackedSatelliteId = "";
      }
      viewer.dataSources.remove(coverageDataSource, true);
      viewer.scene.primitives.remove(leoCoverageRenderer.outlineCollection);
      viewer.scene.primitives.remove(topologyPolylineCollection);
      viewer.scene.primitives.remove(routePolylineCollection);
      viewer.scene.primitives.remove(coveragePrimitiveCollection);
      viewer.scene.primitives.remove(satellitePrimitives.collection);
      viewer.dataSources.remove(dataSource, true);
    },
  };
}

export default loadSatsimScenario;
