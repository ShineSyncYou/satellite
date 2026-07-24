import { clearWizardDraft, loadWizardDraft, saveWizardDraft } from "./scenarioStore";

export const DEFAULT_GROUND_STATION_ALT_KM = 0.0;
export const DEFAULT_AIRCRAFT_CRUISE_ALT_KM = 10.6;
export const DEFAULT_AIRCRAFT_CRUISE_SPEED_KMH = 850;
export const DEFAULT_AIRCRAFT_RATE_MBPS = 25.0;
export const DEFAULT_ROUTE_SAMPLE_COUNT = 21;
export const DEFAULT_MISSION_DURATION_MIN = 60;

function defaultDraft() {
  return {
    title: "",
    tleText: "",
    tleFileName: "",
    satMappingStrategy: "auto-walker-name",
    tleValidation: {
      isValid: false,
      message: "请先导入合法的 TLE 文件或文本。",
      satelliteCount: 0,
      sampleNames: [],
    },
    trajectoryConfig: {
      missionType: "constellation-monitoring",
      routeNotes: "",
      aircraftCount: 0,
      priority: "balanced",
      cruiseAltKm: DEFAULT_AIRCRAFT_CRUISE_ALT_KM,
      routeSampleCount: DEFAULT_ROUTE_SAMPLE_COUNT,
    },
    aircraftRoutes: [],
    trafficDemands: [],
    groundStation: {
      id: "GS_1",
      name: "地面站 GS_1",
      lat: null,
      lon: null,
      alt_km: DEFAULT_GROUND_STATION_ALT_KM,
    },
    simulationParams: {
      totalMissionDurationMin: DEFAULT_MISSION_DURATION_MIN,
      simulationSpeedMultiplier: 5,
      timeStepSeconds: 30,
    },
    communicationParams: {
      satAntennaAngleDeg: 25.0,
      geoSatAntennaAngleDeg: 8.0,
      bwGslMbps: 150.0,
      bwIslMbps: 500.0,
      intraSatelliteBusMbps: 800.0,
    },
    environmentParams: {
      weatherPreset: "clear",
    },
  };
}

function mergeDraft(loadedDraft) {
  const base = defaultDraft();
  const next = loadedDraft || {};
  return {
    ...base,
    ...next,
    tleValidation: {
      ...base.tleValidation,
      ...(next.tleValidation || {}),
    },
    trajectoryConfig: {
      ...base.trajectoryConfig,
      ...(next.trajectoryConfig || {}),
    },
    aircraftRoutes: Array.isArray(next.aircraftRoutes) ? next.aircraftRoutes : base.aircraftRoutes,
    trafficDemands: Array.isArray(next.trafficDemands) ? next.trafficDemands : base.trafficDemands,
    groundStation: {
      ...base.groundStation,
      ...(next.groundStation || {}),
    },
    simulationParams: {
      ...base.simulationParams,
      ...(next.simulationParams || {}),
    },
    communicationParams: {
      ...base.communicationParams,
      ...(next.communicationParams || {}),
    },
    environmentParams: {
      ...base.environmentParams,
      ...(next.environmentParams || {}),
    },
  };
}

export function getWizardDraft() {
  return mergeDraft(loadWizardDraft());
}

export function updateWizardDraft(patch) {
  const current = getWizardDraft();
  const draft = mergeDraft({
    ...current,
    ...patch,
    tleValidation: patch.tleValidation ? { ...current.tleValidation, ...patch.tleValidation } : current.tleValidation,
    trajectoryConfig: patch.trajectoryConfig ? { ...current.trajectoryConfig, ...patch.trajectoryConfig } : current.trajectoryConfig,
    groundStation: patch.groundStation ? { ...current.groundStation, ...patch.groundStation } : current.groundStation,
    simulationParams: patch.simulationParams ? { ...current.simulationParams, ...patch.simulationParams } : current.simulationParams,
    communicationParams: patch.communicationParams ? { ...current.communicationParams, ...patch.communicationParams } : current.communicationParams,
    environmentParams: patch.environmentParams ? { ...current.environmentParams, ...patch.environmentParams } : current.environmentParams,
  });
  saveWizardDraft(draft);
  return draft;
}

export function resetWizardDraft() {
  clearWizardDraft();
  return defaultDraft();
}
