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
 * - 卫星：远景冷白蓝点、中景金属/深蓝 SVG，活跃时使用金色强调
 * - 飞机：青色（#5eead4）
 * - 地面站：橙红色（#ff8c69）
 * - AC→S 链路：浅青色（#72f0ff）
 * - S→G 链路：淡橙色（#ffb08a）
 * - S→S 拓扑 ISL：深蓝灰色（#5d83a6，低透明度）
 * - S→S 路由 ISL：利用率驱动（绿→黄→红），同 A2S/S2G
 * - 覆盖波束：半透明浅蓝锥体 + 地表蜂窝（#4ea9ff）
 */

import * as Cesium from "cesium";
import { normalizeTerminalOnlyRoute } from "./routePathPolicy";
import { TOPOLOGY_LINK_STYLE } from "./satsimSceneStyle";

// ============= 颜色配置 =============
const SATELLITE_UNIFIED_COLOR = Cesium.Color.fromCssColorString("#ffd75e");
const SATELLITE_ACTIVE_COLOR = Cesium.Color.fromCssColorString("#fff19f");
const AIRCRAFT_COLOR = Cesium.Color.fromCssColorString("#5eead4");
const GROUND_STATION_COLOR = Cesium.Color.fromCssColorString("#ff8c69");
const AIRCRAFT_LABEL_COLOR = Cesium.Color.fromCssColorString("#a7fff3");
const GROUND_STATION_LABEL_COLOR = Cesium.Color.fromCssColorString("#ffd0b8");
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
const GEO_CHANGE_CHECK_INTERVAL_MS = 500;
const GEO_SUBPOINT_REBUILD_DISTANCE_M = 20000;
const GEO_ALTITUDE_REBUILD_DISTANCE_M = 20000;
const GEO_ANGLE_REBUILD_EPSILON_RAD = Cesium.Math.toRadians(0.01);
const GEO_FOOTPRINT_GRANULARITY_RAD = Cesium.Math.toRadians(2);
const HONEYCOMB_HEIGHT_M = 900;
// 服务小区的最小地表尺度；每个 footprint 内的整套网格只会等比例放大到内切边界。
const HONEYCOMB_CELL_RADIUS_M = 120000;
// 蜂窝为几何重建而非简单平移；80ms 在 5× 播放下可明显减轻跳变，同时仍保留批量 Primitive 性能收益。
const HONEYCOMB_UPDATE_INTERVAL_MS = 80;
const HONEYCOMB_PROJECTION_RAY_HEIGHT_M = 2000000;

// ============= 模型资源 =============
const SATELLITE_MODEL_URI = "/pictures/tdrs.glb";
const SATELLITE_LEO_PROXY_ICON_URI = "/pictures/satellite-leo.svg";
const SATELLITE_LEO_ACTIVE_PROXY_ICON_URI = "/pictures/satellite-leo-active.svg";
const SATELLITE_GEO_PROXY_ICON_URI = "/pictures/satellite-geo.svg";
const SATELLITE_GEO_ACTIVE_PROXY_ICON_URI = "/pictures/satellite-geo-active.svg";
// 远景点与中景图标在这段距离内交叉淡化，避免缩放时突然跳变。
const SATELLITE_PROXY_FADE_START_DISTANCE_M = 7000000;
const SATELLITE_PROXY_FADE_END_DISTANCE_M = 10000000;
const SATELLITE_PROXY_POINT_COLOR = Cesium.Color.fromCssColorString("#b9ddf2");
const SATELLITE_PROXY_POINT_ACTIVE_COLOR = Cesium.Color.fromCssColorString("#ffd75e");
const MINI_MAP_WORLD_VIEW_HEIGHT_M = 5500000;
const MINI_MAP_REGIONAL_VIEW_HEIGHT_M = 2000000;
const SATELLITE_LEO_PROXY_WIDTH_PX = 54;
const SATELLITE_LEO_PROXY_HEIGHT_PX = 36;
const SATELLITE_GEO_PROXY_WIDTH_PX = 42;
const SATELLITE_GEO_PROXY_HEIGHT_PX = 28;
const AIRCRAFT_MODEL_URI = "/pictures/Airplane.glb";
const GROUND_STATION_MODEL_URI = "/pictures/radar.glb";
const SATELLITE_MODEL_SILHOUETTE_COLOR = Cesium.Color.fromCssColorString("#ffe7a3");
// 飞机尺寸集中配置：scale 控制物理模型大小，近/远像素值控制地图缩放时的视觉尺寸。
const DEFAULT_AIRCRAFT_MODEL_SCALE = 90;
const DEFAULT_AIRCRAFT_MODEL_MIN_PIXEL_SIZE = 64;
// 仅控制近景端点：1.45 表示近景尺寸为远景尺寸的 1.45 倍，远景尺寸不受影响。
const AIRCRAFT_SIZE_NEAR_MULTIPLIER = 2.5;
const DEFAULT_AIRCRAFT_MODEL_NEAR_PIXEL_SIZE =
  DEFAULT_AIRCRAFT_MODEL_MIN_PIXEL_SIZE * AIRCRAFT_SIZE_NEAR_MULTIPLIER;
const DEFAULT_AIRCRAFT_MODEL_MAXIMUM_SCALE = 90000;
// 在 50 km～5000 km 内按对数高度平滑插值，匹配地图的指数缩放手感。
const AIRCRAFT_SIZE_NEAR_CAMERA_HEIGHT_M = 50000;
const AIRCRAFT_SIZE_FAR_CAMERA_HEIGHT_M = 9000000;
const GROUND_STATION_MODEL_MIN_PIXEL_SIZE = 38;
// 超过 5000 km 后按高度反比缩小 minimumPixelSize，固定地面站的世界尺度。
const GROUND_STATION_SCALE_FREEZE_CAMERA_HEIGHT_M = 5000000;

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
 * 飞机到达终点后位置会保持不变，此时速度朝向无法计算。
 * 缓存最后一个有效朝向，避免静止阶段模型反复重置或旋转。
 */
function createStableAircraftOrientation(position) {
  const velocityOrientation = new Cesium.VelocityOrientationProperty(position);
  const beforeTime = new Cesium.JulianDate();
  const afterTime = new Cesium.JulianDate();
  const beforePosition = new Cesium.Cartesian3();
  const currentPosition = new Cesium.Cartesian3();
  const afterPosition = new Cesium.Cartesian3();
  let lastOrientation;
  let lastTime;

  return new Cesium.CallbackProperty((time, result) => {
    if (lastTime && Cesium.JulianDate.lessThan(time, lastTime)) {
      lastOrientation = undefined;
    }
    lastTime = Cesium.JulianDate.clone(time, lastTime);

    Cesium.JulianDate.addSeconds(time, -1, beforeTime);
    Cesium.JulianDate.addSeconds(time, 1, afterTime);
    const before = position.getValue(beforeTime, beforePosition);
    const current = position.getValue(time, currentPosition);
    const after = position.getValue(afterTime, afterPosition);
    const movementStart = before || current;
    const movementEnd = after || current;
    const isMoving = movementStart
      && movementEnd
      && Cesium.Cartesian3.distanceSquared(movementStart, movementEnd) >= 1;

    if (!isMoving) {
      return Cesium.defined(lastOrientation)
        ? Cesium.Quaternion.clone(lastOrientation, result)
        : undefined;
    }

    const orientation = velocityOrientation.getValue(time, result);
    if (Cesium.defined(orientation)) {
      lastOrientation = Cesium.Quaternion.clone(orientation, lastOrientation);
      return orientation;
    }

    return Cesium.defined(lastOrientation)
      ? Cesium.Quaternion.clone(lastOrientation, result)
      : undefined;
  }, false);
}

function aircraftMinPixelSizeForCamera(viewer, nearPixelSize, farPixelSize) {
  const cameraHeight = Number(viewer?.camera?.positionCartographic?.height);
  if (!Number.isFinite(cameraHeight)) {
    return farPixelSize;
  }
  const clampedHeight = Cesium.Math.clamp(
    cameraHeight,
    AIRCRAFT_SIZE_NEAR_CAMERA_HEIGHT_M,
    AIRCRAFT_SIZE_FAR_CAMERA_HEIGHT_M,
  );
  const heightRatio = (
    Math.log(clampedHeight) - Math.log(AIRCRAFT_SIZE_NEAR_CAMERA_HEIGHT_M)
  ) / (
    Math.log(AIRCRAFT_SIZE_FAR_CAMERA_HEIGHT_M)
      - Math.log(AIRCRAFT_SIZE_NEAR_CAMERA_HEIGHT_M)
  );
  const smoothHeightRatio = heightRatio * heightRatio * (3 - 2 * heightRatio);
  return Cesium.Math.lerp(
    nearPixelSize,
    farPixelSize,
    smoothHeightRatio,
  );
}

function groundStationMinPixelSizeForCamera(viewer) {
  const cameraHeight = Number(viewer?.camera?.positionCartographic?.height);
  if (!Number.isFinite(cameraHeight) || cameraHeight <= GROUND_STATION_SCALE_FREEZE_CAMERA_HEIGHT_M) {
    return GROUND_STATION_MODEL_MIN_PIXEL_SIZE;
  }
  return GROUND_STATION_MODEL_MIN_PIXEL_SIZE
    * GROUND_STATION_SCALE_FREEZE_CAMERA_HEIGHT_M
    / cameraHeight;
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
  const aircraftMinimumPixelSize = new Cesium.CallbackProperty(
    () => aircraftMinPixelSizeForCamera(
      options.viewer,
      options.aircraftModelNearPixelSize,
      options.aircraftModelMinPixelSize,
    ),
    false,
  );
  const groundStationMinimumPixelSize = new Cesium.CallbackProperty(
    () => groundStationMinPixelSizeForCamera(options.viewer),
    false,
  );

  for (const entity of dataSource.entities.values) {
    if (entity.id === "document") {
      continue;
    }

    const nodeType = bundle.nodeTypeMap.get(entity.id);
    if (!nodeType) {
      continue;
    }

    if (entity.position && nodeType === "satellite") {
      entity.orientation = new Cesium.VelocityOrientationProperty(entity.position);
    }
    if (entity.position && nodeType === "aircraft") {
      entity.orientation = createStableAircraftOrientation(entity.position);
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
        entity.label.font = new Cesium.ConstantProperty(options.miniMode ? "600 12px Segoe UI" : "16px Segoe UI");
        entity.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, options.miniMode ? -16 : -34));
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
        entity.model.minimumPixelSize = aircraftMinimumPixelSize;
        entity.model.maximumScale = new Cesium.ConstantProperty(options.aircraftModelMaximumScale);
        entity.model.show = new Cesium.ConstantProperty(true);
      }

      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(true);
        entity.label.fillColor = new Cesium.ConstantProperty(AIRCRAFT_LABEL_COLOR);
        entity.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.TRANSPARENT);
        entity.label.outlineWidth = new Cesium.ConstantProperty(0);
        entity.label.style = new Cesium.ConstantProperty(Cesium.LabelStyle.FILL);
        entity.label.font = new Cesium.ConstantProperty(options.miniMode ? "600 12px Segoe UI" : "600 17px Segoe UI");
        entity.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, options.miniMode ? -18 : -48));
        entity.label.showBackground = new Cesium.ConstantProperty(false);
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
          minimumPixelSize: GROUND_STATION_MODEL_MIN_PIXEL_SIZE,
          maximumScale: 6000,
        });
        entity.model.minimumPixelSize = groundStationMinimumPixelSize;
        entity.model.show = new Cesium.ConstantProperty(true);
      } else {
        entity.model = undefined;
      }

      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(true);
        entity.label.fillColor = new Cesium.ConstantProperty(GROUND_STATION_LABEL_COLOR);
        entity.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.TRANSPARENT);
        entity.label.outlineWidth = new Cesium.ConstantProperty(0);
        entity.label.style = new Cesium.ConstantProperty(Cesium.LabelStyle.FILL);
        entity.label.font = new Cesium.ConstantProperty(options.miniMode ? "700 12px Segoe UI" : "700 18px Segoe UI");
        entity.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, options.miniMode ? -18 : -44));
        entity.label.showBackground = new Cesium.ConstantProperty(false);
        entity.label.scaleByDistance = new Cesium.ConstantProperty(new Cesium.NearFarScalar(1.2e6, 1.2, 9e6, 0.65));
      }
    }

    if (options.miniMode) {
      if (entity.path) {
        entity.path.show = new Cesium.ConstantProperty(false);
      }
      if (entity.label) entity.label.show = new Cesium.ConstantProperty(nodeType !== "satellite");
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
    const isGeo = isGeoSatelliteId(satId);
    const defaultImage = isGeo ? SATELLITE_GEO_PROXY_ICON_URI : SATELLITE_LEO_PROXY_ICON_URI;
    const activeImage = isGeo ? SATELLITE_GEO_ACTIVE_PROXY_ICON_URI : SATELLITE_LEO_ACTIVE_PROXY_ICON_URI;
    const point = pointCollection.add({
      // 代理必须返回原始 Entity，才能保留 Cesium 默认的双击跟踪行为。
      id: entity || satId,
      position,
      color: miniMode ? SATELLITE_UNIFIED_COLOR : SATELLITE_PROXY_POINT_COLOR,
      pixelSize: miniMode ? 2 : 2,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
      outlineWidth: 1,
      distanceDisplayCondition: miniMode
        ? undefined
        : new Cesium.DistanceDisplayCondition(SATELLITE_PROXY_FADE_START_DISTANCE_M, Number.MAX_VALUE),
      translucencyByDistance: miniMode
        ? undefined
        : new Cesium.NearFarScalar(
          SATELLITE_PROXY_FADE_START_DISTANCE_M,
          0,
          SATELLITE_PROXY_FADE_END_DISTANCE_M,
          1,
        ),
      show: true,
    });
    const billboard = billboardCollection?.add({
      id: entity || satId,
      position: Cesium.Cartesian3.clone(position),
      image: defaultImage,
      width: isGeo ? SATELLITE_GEO_PROXY_WIDTH_PX : SATELLITE_LEO_PROXY_WIDTH_PX,
      height: isGeo ? SATELLITE_GEO_PROXY_HEIGHT_PX : SATELLITE_LEO_PROXY_HEIGHT_PX,
      // 使用白色保持 SVG 自身的金属、太阳翼和强调色，不再整体染成金黄。
      color: Cesium.Color.WHITE,
      scale: 1,
      scaleByDistance: new Cesium.NearFarScalar(800000, 1.08, SATELLITE_PROXY_FADE_END_DISTANCE_M, 0.55),
      translucencyByDistance: new Cesium.NearFarScalar(
        SATELLITE_PROXY_FADE_START_DISTANCE_M,
        1,
        SATELLITE_PROXY_FADE_END_DISTANCE_M,
        0,
      ),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, SATELLITE_PROXY_FADE_END_DISTANCE_M),
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      show: true,
    }) || null;
    lookup.set(satId, {
      point,
      billboard,
      defaultImage,
      activeImage,
      defaultPointColor: miniMode ? SATELLITE_UNIFIED_COLOR : SATELLITE_PROXY_POINT_COLOR,
      defaultPointPixelSize: 2,
      detailHidden: false,
      miniHidden: false,
    });
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
    proxy.point.show = !proxy.detailHidden && !proxy.miniHidden;
    if (proxy.billboard) {
      proxy.billboard.position = Cesium.Cartesian3.clone(position);
      proxy.billboard.show = !proxy.detailHidden;
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

function applyRouteEvent(activeRoutes, event, nodeTypeMap) {
  if (event.event_kind === "snapshot") {
    activeRoutes.clear();
  }

  for (const route of event.routes || []) {
    const normalizedRoute = normalizeTerminalOnlyRoute(route, nodeTypeMap);
    activeRoutes.set(`${route.source}|${route.target}`, {
      source: route.source,
      target: route.target,
      connected: normalizedRoute.connected,
      path: normalizedRoute.path,
      hop_count: Number(route.hop_count),
      requested_bandwidth_mbps: Number(route.requested_bandwidth_mbps),
      actual_tx_bandwidth_mbps: Number(route.actual_tx_bandwidth_mbps),
      dropped_bandwidth_mbps: Number(route.dropped_bandwidth_mbps),
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
        width: TOPOLOGY_LINK_STYLE.width,
        material: TOPOLOGY_ISL_COLOR.withAlpha(TOPOLOGY_LINK_STYLE.opacity),
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
    // show 会因地球遮挡而临时设为 false；下一时刻仍必须参与计算，
    // 否则候选拓扑线一旦被遮挡就不会再恢复。
    if (!polyline || !segment) {
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
    polyline.show = true;
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

function buildGeoFootprintFillPrimitive(satelliteId, footprintPoints) {
  if (footprintPoints.length < 3) {
    return null;
  }
  const geometry = new Cesium.PolygonGeometry({
    polygonHierarchy: new Cesium.PolygonHierarchy(footprintPoints),
    height: HONEYCOMB_HEIGHT_M,
    granularity: GEO_FOOTPRINT_GRANULARITY_RAD,
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
  });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      id: `geo-footprint:${satelliteId}`,
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(COVERAGE_COLOR),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      closed: false,
    }),
    asynchronous: true,
    show: false,
  });
}

function createGeoCoverageRenderer(viewer, coveragePrimitiveCollection) {
  return {
    viewer,
    coveragePrimitiveCollection,
    outlineCollection: viewer.scene.primitives.add(new Cesium.PolylineCollection()),
    slots: new Map(),
    rebuildQueue: [],
    queuedSatelliteIds: new Set(),
    lastCheckMs: Number.NEGATIVE_INFINITY,
  };
}

function createGeoCoverageSlot(satelliteId, satEntity) {
  return {
    satelliteId,
    satEntity,
    active: true,
    fillPrimitive: null,
    beamPrimitive: null,
    outlinePolyline: null,
    lastState: null,
    pendingFillPrimitive: null,
    pendingBeamPrimitive: null,
    pendingOutlinePoints: null,
    pendingState: null,
    queuedState: null,
    queuedForce: false,
  };
}

function acquireGeoCoverageSlot(renderer, satelliteId, entityLookup) {
  const current = renderer.slots.get(satelliteId);
  if (current) {
    current.active = true;
    return current;
  }
  const satEntity = entityLookup.get(satelliteId);
  if (!satEntity?.position) {
    return null;
  }
  const slot = createGeoCoverageSlot(satelliteId, satEntity);
  renderer.slots.set(satelliteId, slot);
  return slot;
}

function removeGeoSlotPrimitive(renderer, primitive) {
  if (primitive) {
    renderer.coveragePrimitiveCollection.remove(primitive);
  }
}

function releaseGeoCoverageSlot(renderer, slot) {
  slot.active = false;
  renderer.slots.delete(slot.satelliteId);
  renderer.queuedSatelliteIds.delete(slot.satelliteId);
  removeGeoSlotPrimitive(renderer, slot.fillPrimitive);
  removeGeoSlotPrimitive(renderer, slot.beamPrimitive);
  removeGeoSlotPrimitive(renderer, slot.pendingFillPrimitive);
  if (slot.outlinePolyline) {
    renderer.outlineCollection.remove(slot.outlinePolyline);
  }
  slot.fillPrimitive = null;
  slot.beamPrimitive = null;
  slot.pendingFillPrimitive = null;
  slot.pendingBeamPrimitive = null;
  slot.outlinePolyline = null;
  slot.pendingState = null;
  slot.queuedState = null;
}

function clearGeoCoverageRenderer(renderer) {
  for (const slot of [...renderer.slots.values()]) {
    releaseGeoCoverageSlot(renderer, slot);
  }
  renderer.rebuildQueue.length = 0;
  renderer.queuedSatelliteIds.clear();
}

function createGeoCoverageState(satellitePosition, satelliteId, beamConfig) {
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(satellitePosition);
  if (!cartographic) {
    return null;
  }
  const halfAngleRad = effectiveBeamHalfAngleRad(satellitePosition, satelliteId, beamConfig);
  if (!(halfAngleRad > 0)) {
    return null;
  }
  return {
    satellitePosition: Cesium.Cartesian3.clone(satellitePosition),
    subPoint: Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0),
    altitude: cartographic.height,
    halfAngleRad,
  };
}

function geoCoverageStateNeedsRebuild(referenceState, nextState, force = false) {
  if (force || !referenceState || !nextState) {
    return true;
  }
  return Cesium.Cartesian3.distance(referenceState.subPoint, nextState.subPoint) >= GEO_SUBPOINT_REBUILD_DISTANCE_M
    || Math.abs(referenceState.altitude - nextState.altitude) >= GEO_ALTITUDE_REBUILD_DISTANCE_M
    || Math.abs(referenceState.halfAngleRad - nextState.halfAngleRad) >= GEO_ANGLE_REBUILD_EPSILON_RAD;
}

function queueGeoCoverageRebuild(renderer, slot, state, force = false) {
  const referenceState = slot.pendingState || slot.lastState;
  if (!geoCoverageStateNeedsRebuild(referenceState, state, force)) {
    return;
  }
  slot.queuedState = state;
  slot.queuedForce = slot.queuedForce || force;
  if (slot.pendingFillPrimitive || renderer.queuedSatelliteIds.has(slot.satelliteId)) {
    return;
  }
  renderer.queuedSatelliteIds.add(slot.satelliteId);
  renderer.rebuildQueue.push(slot);
}

function syncGeoOutlinePolyline(renderer, slot, outlinePoints) {
  const closedPositions = outlinePoints.map((point) => Cesium.Cartesian3.clone(point));
  closedPositions.push(Cesium.Cartesian3.clone(outlinePoints[0]));
  if (!slot.outlinePolyline) {
    slot.outlinePolyline = renderer.outlineCollection.add({
      positions: closedPositions,
      width: 1,
      material: Cesium.Material.fromType("Color", { color: Cesium.Color.clone(COVERAGE_OUTLINE_COLOR) }),
      show: true,
    });
    return;
  }
  slot.outlinePolyline.positions = closedPositions;
  slot.outlinePolyline.show = true;
}

function finalizeGeoCoverageRebuilds(renderer) {
  for (const slot of renderer.slots.values()) {
    if (!slot.pendingFillPrimitive?.ready) {
      continue;
    }
    const previousFillPrimitive = slot.fillPrimitive;
    const previousBeamPrimitive = slot.beamPrimitive;
    slot.pendingFillPrimitive.show = true;
    slot.fillPrimitive = slot.pendingFillPrimitive;
    slot.beamPrimitive = renderer.coveragePrimitiveCollection.add(slot.pendingBeamPrimitive);
    syncGeoOutlinePolyline(renderer, slot, slot.pendingOutlinePoints);
    slot.lastState = slot.pendingState;
    slot.pendingFillPrimitive = null;
    slot.pendingBeamPrimitive = null;
    slot.pendingOutlinePoints = null;
    slot.pendingState = null;
    removeGeoSlotPrimitive(renderer, previousFillPrimitive);
    removeGeoSlotPrimitive(renderer, previousBeamPrimitive);

    if (slot.queuedState && geoCoverageStateNeedsRebuild(slot.lastState, slot.queuedState, slot.queuedForce)) {
      if (!renderer.queuedSatelliteIds.has(slot.satelliteId)) {
        renderer.queuedSatelliteIds.add(slot.satelliteId);
        renderer.rebuildQueue.push(slot);
      }
    } else {
      slot.queuedState = null;
      slot.queuedForce = false;
    }
  }
}

function startNextGeoCoverageRebuild(renderer) {
  while (renderer.rebuildQueue.length > 0) {
    const slot = renderer.rebuildQueue.shift();
    renderer.queuedSatelliteIds.delete(slot.satelliteId);
    if (!slot.active || slot.pendingFillPrimitive || !slot.queuedState) {
      continue;
    }
    const state = slot.queuedState;
    slot.queuedState = null;
    slot.queuedForce = false;
    const footprintPoints = buildBeamFootprintPoints(
      state.satellitePosition,
      state.halfAngleRad,
      GEO_BEAM_SEGMENT_COUNT,
    );
    if (footprintPoints.length < 3) {
      continue;
    }
    const outlinePoints = footprintPoints.map((point) => elevatePositionAboveEllipsoid(point)).filter(Boolean);
    const fillPrimitive = buildGeoFootprintFillPrimitive(slot.satelliteId, footprintPoints);
    const beamPrimitive = buildBeamConePrimitive(state.satellitePosition, footprintPoints);
    if (!fillPrimitive || !beamPrimitive || outlinePoints.length < 3) {
      continue;
    }
    slot.pendingFillPrimitive = renderer.coveragePrimitiveCollection.add(fillPrimitive);
    slot.pendingBeamPrimitive = beamPrimitive;
    slot.pendingOutlinePoints = outlinePoints;
    slot.pendingState = state;
    break;
  }
}

function processGeoCoverageRenderer(renderer) {
  finalizeGeoCoverageRebuilds(renderer);
  startNextGeoCoverageRebuild(renderer);
}

function syncGeoCoverageRenderer({ renderer, entityLookup, accessLinks, time, beamConfig, forceCheck, forceRebuild }) {
  const now = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  const checkDue = forceCheck || (now - renderer.lastCheckMs) >= GEO_CHANGE_CHECK_INTERVAL_MS;
  const activeSatelliteIds = new Set();

  for (const accessLink of accessLinks.values()) {
    if (!isGeoSatelliteId(accessLink.satId)) {
      continue;
    }
    const slot = acquireGeoCoverageSlot(renderer, accessLink.satId, entityLookup);
    if (!slot) {
      continue;
    }
    activeSatelliteIds.add(accessLink.satId);
    if (!checkDue && (slot.lastState || slot.pendingState || slot.queuedState)) {
      continue;
    }
    const satellitePosition = slot.satEntity.position.getValue(time, scratchSatellitePosition);
    if (!satellitePosition) {
      continue;
    }
    const state = createGeoCoverageState(satellitePosition, slot.satelliteId, beamConfig);
    if (state) {
      queueGeoCoverageRebuild(renderer, slot, state, forceRebuild);
    }
  }

  for (const [satelliteId, slot] of [...renderer.slots.entries()]) {
    if (!activeSatelliteIds.has(satelliteId)) {
      releaseGeoCoverageSlot(renderer, slot);
    }
  }
  if (checkDue) {
    renderer.lastCheckMs = now;
  }
}

function updateCoverageVisibility({
  viewer,
  leoCoverageRenderer,
  geoCoverageRenderer,
  entityLookup,
  accessLinks,
  time,
  showCoverage,
  beamConfig,
  forceRefresh,
  accessChanged,
}) {
  if (!showCoverage || !beamConfig) {
    clearLeoCoverageRenderer(leoCoverageRenderer);
    clearGeoCoverageRenderer(geoCoverageRenderer);
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
  syncGeoCoverageRenderer({
    renderer: geoCoverageRenderer,
    entityLookup,
    accessLinks,
    time,
    beamConfig,
    forceCheck: forceRefresh || accessChanged,
    forceRebuild: forceRefresh,
  });
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
      proxy.point.color = proxy.defaultPointColor;
      proxy.point.pixelSize = proxy.defaultPointPixelSize;
      if (proxy.billboard) {
        proxy.billboard.image = proxy.defaultImage;
        proxy.billboard.color = Cesium.Color.WHITE;
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
      proxy.point.color = SATELLITE_PROXY_POINT_ACTIVE_COLOR;
      proxy.point.pixelSize = 3.2;
      if (proxy.billboard) {
        proxy.billboard.image = proxy.activeImage;
        proxy.billboard.color = Cesium.Color.WHITE;
        proxy.billboard.scale = 1.12;
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
    applyRouteEvent(
      state.activeRoutes,
      bundle.routeEvents[state.routeIndex],
      bundle.nodeTypeMap,
    );
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
  aircraftModelScale = DEFAULT_AIRCRAFT_MODEL_SCALE,
  aircraftModelMinPixelSize = DEFAULT_AIRCRAFT_MODEL_MIN_PIXEL_SIZE,
  aircraftModelNearPixelSize = DEFAULT_AIRCRAFT_MODEL_NEAR_PIXEL_SIZE,
  aircraftModelMaximumScale = DEFAULT_AIRCRAFT_MODEL_MAXIMUM_SCALE,
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
    viewer,
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
    aircraftModelNearPixelSize,
    aircraftModelMaximumScale,
    useSatellitePrimitives: true,
  });

  const entityLookup = buildEntityLookup(dataSource.entities);
  const satellitePrimitives = createSatellitePointPrimitives(viewer, bundle, trackStore, entityLookup, miniMode);
  const coveragePrimitiveCollection = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const leoCoverageRenderer = createLeoCoverageRenderer(viewer, coveragePrimitiveCollection);
  const geoCoverageRenderer = createGeoCoverageRenderer(viewer, coveragePrimitiveCollection);
  const routePolylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  const topologyPolylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  const routePolylinePool = [];
  const topologyPolylinePool = [];
  let topologyLinksVisible = Boolean(showTopologyLinks) && !miniMode;
  topologyPolylineCollection.show = topologyLinksVisible;

  const incrementalState = createIncrementalState(bundle);
  const activeRouteSatelliteIds = new Set();
  let miniSatelliteDisplayMode = "";
  const syncMiniSatelliteAppearance = (force = false) => {
    if (!miniMode) {
      return;
    }

    const cameraHeight = Number(viewer.camera.positionCartographic?.height);
    const nextMode = cameraHeight >= MINI_MAP_WORLD_VIEW_HEIGHT_M
      ? "world"
      : cameraHeight >= MINI_MAP_REGIONAL_VIEW_HEIGHT_M
        ? "regional"
        : "local";
    if (!force && nextMode === miniSatelliteDisplayMode) {
      return;
    }
    miniSatelliteDisplayMode = nextMode;

    for (const [satId, proxy] of satellitePrimitives.lookup) {
      const active = activeRouteSatelliteIds.has(satId);
      const geo = isGeoSatelliteId(satId);
      proxy.miniHidden = nextMode === "world" && !active;
      proxy.point.show = !proxy.detailHidden && !proxy.miniHidden;
      if (proxy.miniHidden) {
        continue;
      }
      if (active) {
        proxy.point.color = SATELLITE_PROXY_POINT_ACTIVE_COLOR;
        proxy.point.pixelSize = 4;
      } else if (nextMode === "regional") {
        proxy.point.color = SATELLITE_PROXY_POINT_COLOR.withAlpha(0.34);
        proxy.point.pixelSize = geo ? 1.6 : 1.25;
      } else {
        proxy.point.color = SATELLITE_PROXY_POINT_COLOR.withAlpha(0.55);
        proxy.point.pixelSize = geo ? 2.2 : 1.8;
      }
    }
  };
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
  let coverageAccessLinks = new Map();
  let coverageAccessSignature = "";

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
      const previousProxy = satellitePrimitives.lookup.get(trackedSatelliteId);
      if (previousProxy) {
        previousProxy.detailHidden = false;
        previousProxy.point.show = true;
        if (previousProxy.billboard) {
          previousProxy.billboard.show = true;
        }
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
    const trackedProxy = satellitePrimitives.lookup.get(trackedSatelliteId);
    if (trackedProxy) {
      trackedProxy.detailHidden = true;
      trackedProxy.point.show = false;
      if (trackedProxy.billboard) {
        trackedProxy.billboard.show = false;
      }
    }
    applySatelliteModel(entity, satelliteDetailStyleOptions);
  };
  const onTrackedEntityChanged = (trackedEntity) => syncTrackedSatelliteModel(trackedEntity);
  viewer.trackedEntityChanged.addEventListener(onTrackedEntityChanged);

  const syncTopologyLinksForTime = (time) => {
    const relativeTime = normalizeRelativeTime(time, bundle.startJulian, bundle.durationSeconds);
    const topologyState = buildTopologySegments(incrementalState.activeTopology, bundle);
    if (topologyState.signature !== lastTopologySignature) {
      syncPolylinePrimitivePool(topologyPolylineCollection, topologyPolylinePool, topologyState.segments, {
        colorResolver: () => TOPOLOGY_ISL_COLOR.withAlpha(TOPOLOGY_LINK_STYLE.opacity),
        widthResolver: () => TOPOLOGY_LINK_STYLE.width,
      });
      lastTopologySignature = topologyState.signature;
    }
    updatePolylinePrimitivePositions(topologyPolylinePool, trackStore, entityLookup, time, relativeTime);
  };

  const setTopologyLinksVisible = (visible) => {
    topologyLinksVisible = Boolean(visible) && !miniMode;
    topologyPolylineCollection.show = topologyLinksVisible;
    if (topologyLinksVisible) {
      syncTopologyLinksForTime(viewer.clock.currentTime);
    }
    viewer.scene.requestRender();
    return topologyLinksVisible;
  };

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

    const renderTopologyLinks = topologyLinksVisible;
    const needsTopologyState = renderTopologyLinks
      || (showCoverage && !miniMode)
      || typeof onSimulationTick === "function";
    const { routeChanged, topologyChanged } = advanceStateToTime(
      incrementalState,
      bundle,
      relativeTime,
      needsTopologyState,
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
        syncMiniSatelliteAppearance(true);
        lastRouteSignature = routeState.signature;
      }
    }
    updatePolylinePrimitivePositions(routePolylinePool, trackStore, entityLookup, time, relativeTime);

    if (renderTopologyLinks && (topologyChanged || incrementalState.lastRelativeTime < 1e-9)) {
      syncTopologyLinksForTime(time);
    } else if (renderTopologyLinks) {
      updatePolylinePrimitivePositions(topologyPolylinePool, trackStore, entityLookup, time, relativeTime);
    }

    // 卫星代理、飞机和链路线在每帧更新；只有裁切蜂窝/波束几何按独立频率重建。
    let accessChanged = false;
    if (coverageForceRefresh || topologyChanged || coverageTimeRewound) {
      const nextAccessLinks = collectAccessSatelliteLinks(incrementalState.activeTopology, bundle);
      const nextAccessSignature = [...nextAccessLinks.keys()].sort().join(";");
      accessChanged = nextAccessSignature !== coverageAccessSignature;
      coverageAccessLinks = nextAccessLinks;
      coverageAccessSignature = nextAccessSignature;
    }
    const coverageNow = (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
    const coverageForce = coverageForceRefresh || coverageTimeRewound;
    if (coverageForce || accessChanged || (coverageNow - lastCoverageUpdateMs) >= HONEYCOMB_UPDATE_INTERVAL_MS) {
      updateCoverageVisibility({
        viewer,
        leoCoverageRenderer,
        geoCoverageRenderer,
        entityLookup,
        accessLinks: coverageAccessLinks,
        time,
        showCoverage: showCoverage && !miniMode,
        beamConfig,
        forceRefresh: coverageForce,
        accessChanged,
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

  if (enableSatelliteModelPool) {
    updateSatelliteModelPool(viewer.clock.currentTime, true);
  }

  const onScenePreUpdate = () => processGeoCoverageRenderer(geoCoverageRenderer);
  viewer.scene.preUpdate.addEventListener(onScenePreUpdate);
  const onMiniCameraChanged = () => {
    syncMiniSatelliteAppearance();
    if (viewer.scene.requestRenderMode) {
      viewer.scene.requestRender();
    }
  };
  if (miniMode) {
    viewer.camera.changed.addEventListener(onMiniCameraChanged);
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
    setTopologyLinksVisible,
    cleanup() {
      viewer.clock.onTick.removeEventListener(onTick);
      viewer.scene.preUpdate.removeEventListener(onScenePreUpdate);
      viewer.trackedEntityChanged.removeEventListener(onTrackedEntityChanged);
      if (miniMode) {
        viewer.camera.changed.removeEventListener(onMiniCameraChanged);
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
      clearGeoCoverageRenderer(geoCoverageRenderer);
      viewer.scene.primitives.remove(leoCoverageRenderer.outlineCollection);
      viewer.scene.primitives.remove(geoCoverageRenderer.outlineCollection);
      viewer.scene.primitives.remove(topologyPolylineCollection);
      viewer.scene.primitives.remove(routePolylineCollection);
      viewer.scene.primitives.remove(coveragePrimitiveCollection);
      viewer.scene.primitives.remove(satellitePrimitives.collection);
      viewer.dataSources.remove(dataSource, true);
    },
  };
}

export default loadSatsimScenario;
