import * as Cesium from "cesium";

import {
  DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
  DEFAULT_AIRCRAFT_RATE_MBPS,
  DEFAULT_GROUND_STATION_ALT_KM,
  DEFAULT_ROUTE_SAMPLE_COUNT,
} from "./wizardDraft";
import { getAirportByCode } from "./airportCatalog";

export const WEATHER_PRESET_OPTIONS = Object.freeze([
  {
    key: "clear",
    label: "晴朗",
    icon: "☀",
    description: "默认晴空场景",
    rainFadeIntensity: 0.0,
  },
  {
    key: "cloudy",
    label: "多云",
    icon: "☁",
    description: "轻度云层遮挡",
    rainFadeIntensity: 0.08,
  },
  {
    key: "rain",
    label: "降雨",
    icon: "🌧",
    description: "存在雨衰影响",
    rainFadeIntensity: 0.15,
  },
  {
    key: "storm",
    label: "强对流",
    icon: "⛈",
    description: "重度衰减预设",
    rainFadeIntensity: 0.25,
  },
]);

const AUTO_TLE_NAME_PATTERN = /^(?<prefix>[A-Za-z0-9]+)_(?<plane>\d+)_(?<slot>\d+)$/;
const AUTO_TLE_GEO_NAME_PATTERN = /^(?<prefix>[A-Za-z0-9]+)_GEO$/i;

function roundTo(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function nullableRound(value, digits = 6) {
  if (value == null || value === "" || Number.isNaN(Number(value))) {
    return null;
  }
  return roundTo(value, digits);
}

function normalizeLongitude(lon) {
  let normalized = Number(lon);
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return roundTo(normalized, 6);
}

function toCartesianPositions(points) {
  return points.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.alt * 1000));
}

export function formatCoordinate(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }
  return `${roundTo(value, 4)}°`;
}

export function formatAltitudeKm(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }
  return `${roundTo(value, 2)} km`;
}

export function getWeatherPresetMeta(key) {
  return WEATHER_PRESET_OPTIONS.find((item) => item.key === key) || WEATHER_PRESET_OPTIONS[0];
}

export function parseTleCatalog(tleText) {
  const normalizedLines = String(tleText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedLines.length < 3) {
    throw new Error("TLE 内容不足，至少需要卫星名称与两行根数。");
  }

  if (normalizedLines.length % 3 !== 0) {
    throw new Error("TLE 内容格式不完整，请确保每颗卫星包含名称、Line1、Line2 共三行。");
  }

  const satellites = [];
  for (let index = 0; index < normalizedLines.length; index += 3) {
    const name = normalizedLines[index];
    const line1 = normalizedLines[index + 1];
    const line2 = normalizedLines[index + 2];

    if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) {
      throw new Error(`第 ${index / 3 + 1} 颗卫星的 TLE 两行根数格式不正确。`);
    }

    satellites.push({ name, line1, line2 });
  }

  return satellites;
}

export function validateAutoWalkerTle(tleText) {
  try {
    const satellites = parseTleCatalog(tleText);
    const sampleNames = satellites.slice(0, 5).map((item) => item.name);
    const unmatched = satellites.find((item) => (
      !AUTO_TLE_NAME_PATTERN.test(item.name)
      && !AUTO_TLE_GEO_NAME_PATTERN.test(item.name)
    ));
    if (unmatched) {
      return {
        isValid: false,
        message: `卫星名称 ${unmatched.name} 不满足自动映射规则，要求形如 PREFIX_轨道面_槽位。`,
        satelliteCount: satellites.length,
        sampleNames,
      };
    }

    return {
      isValid: true,
      message: `已识别 ${satellites.length} 颗卫星，可自动生成 sat_mapping。`,
      satelliteCount: satellites.length,
      sampleNames,
    };
  } catch (error) {
    return {
      isValid: false,
      message: error instanceof Error ? error.message : "TLE 校验失败。",
      satelliteCount: 0,
      sampleNames: [],
    };
  }
}

export function buildAutoSatMapping(tleText) {
  const satellites = parseTleCatalog(tleText);
  const mapping = {};
  let geoIndex = 0;

  for (const satellite of satellites) {
    if (AUTO_TLE_GEO_NAME_PATTERN.test(satellite.name)) {
      geoIndex += 1;
      mapping[satellite.name] = `sat_geo_${geoIndex}`;
      continue;
    }

    const match = satellite.name.match(AUTO_TLE_NAME_PATTERN);
    if (!match?.groups) {
      throw new Error(`卫星名称 ${satellite.name} 无法自动生成 sat_mapping。`);
    }
    const plane = Number(match.groups.plane);
    const slot = Number(match.groups.slot);
    mapping[satellite.name] = `sat_${plane}_${slot}`;
  }

  return mapping;
}

function safeBuildAutoSatMapping(tleText) {
  try {
    return {
      mapping: buildAutoSatMapping(tleText),
      error: null,
    };
  } catch (error) {
    return {
      mapping: {},
      error: error instanceof Error ? error.message : "sat_mapping 生成失败。",
    };
  }
}

export function buildAircraftRoutePoints({
  start,
  end,
  durationSeconds,
  cruiseAltKm = DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
  sampleCount = DEFAULT_ROUTE_SAMPLE_COUNT,
  startProgressPercent = 0,
}) {
  const startCartographic = Cesium.Cartographic.fromDegrees(start.lon, start.lat);
  const endCartographic = Cesium.Cartographic.fromDegrees(end.lon, end.lat);
  const geodesic = new Cesium.EllipsoidGeodesic(startCartographic, endCartographic);
  const safeSamples = Math.max(2, Number(sampleCount) || DEFAULT_ROUTE_SAMPLE_COUNT);
  const safeDuration = Math.max(60, Number(durationSeconds) || 600);
  const progressFraction = clamp(startProgressPercent, 0, 100) / 100;
  const points = [];

  for (let index = 0; index < safeSamples; index += 1) {
    const timelineFraction = safeSamples === 1 ? 0 : index / (safeSamples - 1);
    const fraction = progressFraction + ((1 - progressFraction) * timelineFraction);
    const cartographic = geodesic.interpolateUsingFraction(fraction);
    points.push({
      time_s: roundTo(safeDuration * timelineFraction, 6),
      lat: roundTo(Cesium.Math.toDegrees(cartographic.latitude), 6),
      lon: normalizeLongitude(Cesium.Math.toDegrees(cartographic.longitude)),
      alt: roundTo(cruiseAltKm, 3),
    });
  }

  if (points.length > 0) {
    points[0].time_s = 0;
    points[points.length - 1].time_s = safeDuration;
  }

  return points;
}

export function makeAircraftRoute({
  index,
  start,
  end,
  startAirportCode = "",
  endAirportCode = "",
  startProgressPercent = 0,
  durationSeconds,
  cruiseAltKm = DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
  sampleCount = DEFAULT_ROUTE_SAMPLE_COUNT,
  rateMbps = DEFAULT_AIRCRAFT_RATE_MBPS,
}) {
  const id = `AC_${index}`;
  const points = buildAircraftRoutePoints({
    start,
    end,
    durationSeconds,
    cruiseAltKm,
    sampleCount,
    startProgressPercent,
  });
  const firstPoint = points[0] || start;

  return {
    id,
    start: {
      lat: roundTo(firstPoint.lat, 6),
      lon: normalizeLongitude(firstPoint.lon),
    },
    end: {
      lat: roundTo(end.lat, 6),
      lon: normalizeLongitude(end.lon),
    },
    origin: {
      lat: roundTo(start.lat, 6),
      lon: normalizeLongitude(start.lon),
    },
    startAirportCode,
    endAirportCode,
    startProgressPercent: roundTo(clamp(startProgressPercent, 0, 100), 3),
    cruiseAltKm: roundTo(cruiseAltKm, 3),
    rateMbps: roundTo(rateMbps, 3),
    points,
  };
}

export function buildAircraftRouteFromAirports({
  index,
  startAirportCode,
  endAirportCode,
  startProgressPercent = 0,
  durationSeconds,
  cruiseAltKm = DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
  sampleCount = DEFAULT_ROUTE_SAMPLE_COUNT,
  rateMbps = DEFAULT_AIRCRAFT_RATE_MBPS,
}) {
  const startAirport = getAirportByCode(startAirportCode);
  const endAirport = getAirportByCode(endAirportCode);
  if (!startAirport || !endAirport) {
    throw new Error("请选择有效的起始机场和终点机场。");
  }
  return makeAircraftRoute({
    index,
    start: startAirport,
    end: endAirport,
    startAirportCode: startAirport.code,
    endAirportCode: endAirport.code,
    startProgressPercent,
    durationSeconds,
    cruiseAltKm,
    sampleCount,
    rateMbps,
  });
}

export function rebuildRouteWithAltitude(route, durationSeconds, sampleCount = DEFAULT_ROUTE_SAMPLE_COUNT) {
  const points = buildAircraftRoutePoints({
    start: route.origin || route.start,
    end: route.end,
    durationSeconds,
    cruiseAltKm: route.cruiseAltKm,
    sampleCount,
    startProgressPercent: route.startProgressPercent || 0,
  });
  const firstPoint = points[0] || route.start;
  return {
    ...route,
    cruiseAltKm: roundTo(route.cruiseAltKm, 3),
    start: {
      lat: roundTo(firstPoint.lat, 6),
      lon: normalizeLongitude(firstPoint.lon),
    },
    points,
  };
}

export function buildTrafficDemands(aircraftRoutes, groundStationId = "GS_1") {
  return aircraftRoutes.map((route) => ({
    source: route.id,
    target: groundStationId,
    rate_mbps: roundTo(route.rateMbps ?? DEFAULT_AIRCRAFT_RATE_MBPS, 3),
  }));
}

export function rebuildRoutesForManifest({
  aircraftRoutes,
  durationSeconds,
  sampleCount = DEFAULT_ROUTE_SAMPLE_COUNT,
}) {
  return (aircraftRoutes || []).map((route) => {
    const points = buildAircraftRoutePoints({
      start: route.origin || route.start,
      end: route.end,
      durationSeconds,
      cruiseAltKm: route.cruiseAltKm ?? DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
      sampleCount,
      startProgressPercent: route.startProgressPercent || 0,
    });
    const firstPoint = points[0] || route.start;
    return {
      ...route,
      start: {
        lat: roundTo(firstPoint.lat, 6),
        lon: normalizeLongitude(firstPoint.lon),
      },
      points,
    };
  });
}

function buildAircraftTrajectories(aircraftRoutes) {
  return aircraftRoutes.map((route) => ({
    id: route.id,
    points: route.points.map((point) => ({
      time_s: point.time_s,
      lat: point.lat,
      lon: point.lon,
      alt: point.alt,
    })),
  }));
}

function buildGroundStationPreview(groundStation) {
  return [
    {
      id: groundStation.id || "GS_1",
      lat: nullableRound(groundStation.lat, 6),
      lon: groundStation.lon == null ? null : normalizeLongitude(groundStation.lon),
      alt: roundTo(groundStation.alt_km ?? DEFAULT_GROUND_STATION_ALT_KM, 3),
    },
  ];
}

export function buildSampleConfigPreview(draft) {
  const totalMissionDurationMin = Number(draft.simulationParams?.totalMissionDurationMin || 10);
  const durationSeconds = totalMissionDurationMin * 60;
  const timeStepSeconds = Number(draft.simulationParams?.timeStepSeconds || 30);
  const weatherMeta = getWeatherPresetMeta(draft.environmentParams?.weatherPreset);
  const { mapping, error } = safeBuildAutoSatMapping(draft.tleText);
  const aircraftRoutes = rebuildRoutesForManifest({
    aircraftRoutes: draft.aircraftRoutes || [],
    durationSeconds,
    sampleCount: Number(draft.trajectoryConfig?.routeSampleCount || DEFAULT_ROUTE_SAMPLE_COUNT),
  });

  return {
    start_time: new Date().toISOString(),
    duration: durationSeconds,
    time_step: timeStepSeconds,
    event_sampling_enabled: true,
    event_sampling_min_step: 1,
    tle_file: draft.tleFileName || "uploaded.tle",
    sat_mapping: mapping,
    sat_mapping_error: error,
    aircraft_traj: buildAircraftTrajectories(aircraftRoutes),
    ground_stations: buildGroundStationPreview(draft.groundStation),
    sat_antenna_angle: roundTo(draft.communicationParams?.satAntennaAngleDeg ?? 25, 3),
    geo_sat_antenna_angle: roundTo(draft.communicationParams?.geoSatAntennaAngleDeg ?? 8, 3),
    bw_gsl: roundTo(draft.communicationParams?.bwGslMbps ?? 150, 3),
    bw_isl: roundTo(draft.communicationParams?.bwIslMbps ?? 500, 3),
    rain_fade_intensity: weatherMeta.rainFadeIntensity,
    traffic_demands: buildTrafficDemands(aircraftRoutes, draft.groundStation?.id || "GS_1"),
  };
}

export function buildWizardManifest(draft) {
  const weatherMeta = getWeatherPresetMeta(draft.environmentParams?.weatherPreset);
  const totalMissionDurationMin = Number(draft.simulationParams?.totalMissionDurationMin || 10);
  const durationSeconds = totalMissionDurationMin * 60;
  const aircraftRoutes = rebuildRoutesForManifest({
    aircraftRoutes: draft.aircraftRoutes || [],
    durationSeconds,
    sampleCount: Number(draft.trajectoryConfig?.routeSampleCount || DEFAULT_ROUTE_SAMPLE_COUNT),
  }).map((route) => ({
    id: route.id,
    start: route.start,
    end: route.end,
    origin: route.origin || route.start,
    startAirportCode: route.startAirportCode || "",
    endAirportCode: route.endAirportCode || "",
    startProgressPercent: roundTo(route.startProgressPercent || 0, 3),
    cruiseAltKm: roundTo(route.cruiseAltKm ?? DEFAULT_AIRCRAFT_CRUISE_ALT_KM, 3),
    rateMbps: roundTo(route.rateMbps ?? DEFAULT_AIRCRAFT_RATE_MBPS, 3),
    points: route.points || [],
  }));
  const trafficDemands = buildTrafficDemands(aircraftRoutes, draft.groundStation?.id || "GS_1");

  return {
    title: draft.title || "未命名仿真任务",
    tleText: draft.tleText,
    tleFileName: draft.tleFileName || "uploaded.tle",
    satMappingStrategy: draft.satMappingStrategy || "auto-walker-name",
    tleValidation: draft.tleValidation,
    groundStation: {
      id: draft.groundStation?.id || "GS_1",
      name: draft.groundStation?.name || "地面站 GS_1",
      lat: nullableRound(draft.groundStation?.lat, 6),
      lon: draft.groundStation?.lon == null ? null : normalizeLongitude(draft.groundStation?.lon),
      alt_km: roundTo(draft.groundStation?.alt_km ?? DEFAULT_GROUND_STATION_ALT_KM, 3),
    },
    aircraftRoutes,
    trafficDemands,
    simulationParams: {
      totalMissionDurationMin: Number(draft.simulationParams?.totalMissionDurationMin || 10),
      simulationSpeedMultiplier: Number(draft.simulationParams?.simulationSpeedMultiplier || 5),
      timeStepSeconds: Number(draft.simulationParams?.timeStepSeconds || 30),
    },
    communicationParams: {
      satAntennaAngleDeg: roundTo(draft.communicationParams?.satAntennaAngleDeg ?? 25, 3),
      geoSatAntennaAngleDeg: roundTo(draft.communicationParams?.geoSatAntennaAngleDeg ?? 8, 3),
      geoSatAntennaAngleDeg: roundTo(draft.communicationParams?.geoSatAntennaAngleDeg ?? 8, 3),
      bwGslMbps: roundTo(draft.communicationParams?.bwGslMbps ?? 150, 3),
      bwIslMbps: roundTo(draft.communicationParams?.bwIslMbps ?? 500, 3),
      intraSatelliteBusMbps: roundTo(draft.communicationParams?.intraSatelliteBusMbps ?? 800, 3),
    },
    environmentParams: {
      weatherPreset: weatherMeta.key,
      weatherLabel: weatherMeta.label,
      rainFadeIntensity: weatherMeta.rainFadeIntensity,
    },
    sampleConfigPreview: buildSampleConfigPreview({
      ...draft,
      aircraftRoutes: draft.aircraftRoutes || [],
    }),
  };
}

export function buildRouteMapGraphics(aircraftRoutes) {
  return (aircraftRoutes || []).map((route, index) => ({
    id: route.id,
    color: index % 2 === 0 ? "#72f0ff" : "#ffd75e",
    positions: toCartesianPositions(route.points || []),
  }));
}

export function buildRoutePointMarkers(aircraftRoutes) {
  const markers = [];
  for (const route of aircraftRoutes || []) {
    markers.push({
      id: `${route.id}-start`,
      label: `${route.id} 起点`,
      lat: route.start.lat,
      lon: route.start.lon,
      color: "#5eead4",
    });
    markers.push({
      id: `${route.id}-end`,
      label: `${route.id} 终点`,
      lat: route.end.lat,
      lon: route.end.lon,
      color: "#ffd75e",
    });
  }
  return markers;
}
