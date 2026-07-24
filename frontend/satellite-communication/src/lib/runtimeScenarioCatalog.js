import { getScenarioAssets, getStoredScenarioRecord, listStoredScenarioRecords } from "./scenarioStore";
import { buildServerScenarioAssetUrl, fetchServerScenario, fetchServerScenarios } from "./simulationAdapter";

let serverScenarioRecords = [];
let refreshPromise = null;

function normalizeServerScenarioRecord(record) {
  return {
    id: String(record.id),
    title: record.title || record.sourceName || record.id,
    mode: record.mode || "server-generated",
    czmlSource: null,
    bundleSource: null,
    createdAt: record.createdAt || record.generatedAt || "server",
    status: record.status || "pending",
    backendTaskId: record.backendTaskId || "",
    generatedAt: record.generatedAt || null,
    summary: record.summary || null,
    sourceName: record.sourceName || record.title || record.id,
    artifacts: record.artifacts || null,
    error: record.error || "",
    aircraftRoutes: Array.isArray(record.aircraftRoutes) ? record.aircraftRoutes : [],
  };
}

export async function refreshServerScenarioRecords() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = fetchServerScenarios()
    .then((payload) => {
      serverScenarioRecords = Array.isArray(payload?.scenarios)
        ? payload.scenarios.map(normalizeServerScenarioRecord)
        : [];
      return serverScenarioRecords;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export function listServerScenarioRecords() {
  return serverScenarioRecords;
}

function getServerScenarioRecordSync(id) {
  return serverScenarioRecords.find((item) => item.id === id) || null;
}

async function getServerScenarioRecord(id) {
  const cached = getServerScenarioRecordSync(id);
  if (cached) {
    return cached;
  }

  const record = await fetchServerScenario(id);
  const normalized = normalizeServerScenarioRecord(record);
  serverScenarioRecords = [
    normalized,
    ...serverScenarioRecords.filter((item) => item.id !== normalized.id),
  ];
  return normalized;
}

function listVisibleLocalScenarioRecords() {
  const serverIds = new Set(serverScenarioRecords.map((item) => item.id));
  const serverTaskIds = new Set(serverScenarioRecords.map((item) => item.backendTaskId).filter(Boolean));
  return listStoredScenarioRecords().filter((record) => (
    !serverIds.has(record.id)
    && !serverTaskIds.has(record.backendTaskId)
  ));
}

export function listAllScenarioRecords() {
  return [...serverScenarioRecords, ...listVisibleLocalScenarioRecords()];
}

export function listRunnableScenarioRecords() {
  return listAllScenarioRecords().filter((item) => item.status === "ready");
}

export function getScenarioRecordSync(id) {
  return listAllScenarioRecords().find((item) => item.id === id) || null;
}

export async function resolveScenarioRuntime(id) {
  const serverRecord = getServerScenarioRecordSync(id) || await getServerScenarioRecord(id).catch(() => null);
  if (serverRecord) {
    if (serverRecord.status !== "ready") {
      throw new Error(`Scenario is not ready yet: ${id}`);
    }
    return {
      record: serverRecord,
      czmlSource: buildServerScenarioAssetUrl(id, "render.czml"),
      bundleSource: buildServerScenarioAssetUrl(id, "bundle.json"),
    };
  }

  const record = getStoredScenarioRecord(id);
  if (!record) {
    throw new Error(`Scenario not found: ${id}`);
  }
  if (record.status !== "ready") {
    throw new Error(`Scenario is not ready yet: ${id}`);
  }
  const assets = await getScenarioAssets(id);
  if (!assets?.czmlPayload || !assets?.bundlePayload) {
    throw new Error(`Scenario assets are missing: ${id}`);
  }
  return {
    record,
    czmlSource: assets.czmlPayload,
    bundleSource: assets.bundlePayload,
  };
}

export function makeScenarioOption(record) {
  return {
    key: record.id,
    label: record.title,
  };
}

export function listScenarioOptions() {
  return listRunnableScenarioRecords().map(makeScenarioOption);
}
