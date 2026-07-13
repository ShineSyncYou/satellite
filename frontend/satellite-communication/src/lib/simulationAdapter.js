const API_BASE = "/api/simulations";
const SCENARIO_API_BASE = "/api/scenarios";
const AUTH_API_BASE = "/api/auth";

async function readJsonResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Request failed with status ${response.status}.`);
  }

  return payload;
}

/**
 * 提交一个完整 manifest 到本地仿真服务。
 * 后端会异步调用 Python 生成 bundle / czml，因此这里只返回任务 ID 和初始状态。
 */
export async function submitSimulationManifest(manifest) {
  const response = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ manifest }),
  });
  return readJsonResponse(response);
}

/**
 * 读取单个任务的状态，用于状态页轮询。
 */
export async function fetchSimulationTask(taskId) {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(taskId)}`);
  return readJsonResponse(response);
}

/**
 * 在任务完成后读取最终生成的双文件内容。
 * 兼容旧调用；共享场景运行优先使用 /api/scenarios/:id/result。
 */
export async function fetchSimulationTaskResult(taskId) {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(taskId)}/result`);
  return readJsonResponse(response);
}

export async function fetchServerScenarios() {
  const response = await fetch(SCENARIO_API_BASE);
  return readJsonResponse(response);
}

export async function fetchServerScenario(scenarioId) {
  const response = await fetch(`${SCENARIO_API_BASE}/${encodeURIComponent(scenarioId)}`);
  return readJsonResponse(response);
}

export function buildServerScenarioAssetUrl(scenarioId, assetName) {
  return `${SCENARIO_API_BASE}/${encodeURIComponent(scenarioId)}/${assetName}`;
}

export async function importServerScenario({ title, czmlPayload, bundlePayload, sourceName }) {
  const response = await fetch(`${SCENARIO_API_BASE}/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, czmlPayload, bundlePayload, sourceName }),
  });
  return readJsonResponse(response);
}

export async function deleteServerScenario(scenarioId) {
  const response = await fetch(`${SCENARIO_API_BASE}/${encodeURIComponent(scenarioId)}`, {
    method: "DELETE",
  });
  if (response.status === 204) {
    return true;
  }
  return readJsonResponse(response);
}

export async function fetchAuthStatus() {
  const response = await fetch(`${AUTH_API_BASE}/me`);
  return readJsonResponse(response);
}

export async function loginAsAdmin({ username, password }) {
  const response = await fetch(`${AUTH_API_BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  return readJsonResponse(response);
}

export async function logoutAdmin() {
  const response = await fetch(`${AUTH_API_BASE}/logout`, {
    method: "POST",
  });
  return readJsonResponse(response);
}
