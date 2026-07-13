const USER_SCENARIO_STORAGE_KEY = "satsim-v2-scenarios";
const WIZARD_DRAFT_STORAGE_KEY = "satsim-v2-wizard-draft";
const DB_NAME = "satsim-v2-db";
const DB_VERSION = 1;
const ASSET_STORE_NAME = "scenario-assets";

/**
 * 本地场景资产放到 IndexedDB，避免把大体积 CZML / bundle 直接塞进 localStorage。
 * localStorage 只存轻量的 manifest 列表，真正的双文件内容按场景 ID 存一份。
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
        db.createObjectStore(ASSET_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
  });
}

function readJsonList(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonList(key, items) {
  localStorage.setItem(key, JSON.stringify(items));
}

function upsertById(items, nextItem) {
  const remaining = items.filter((item) => item?.id !== nextItem.id);
  return [nextItem, ...remaining];
}

function sanitizeScenarioAsset(value) {
  // Vue ref/reactive ???????? IndexedDB??????? JSON ???
  return JSON.parse(JSON.stringify(value));
}

export function makeScenarioId(prefix = "scenario") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listStoredScenarioRecords() {
  return readJsonList(USER_SCENARIO_STORAGE_KEY);
}

export function getStoredScenarioRecord(id) {
  return listStoredScenarioRecords().find((item) => item.id === id) || null;
}

export function saveStoredScenarioRecord(record) {
  const current = listStoredScenarioRecords();
  writeJsonList(USER_SCENARIO_STORAGE_KEY, upsertById(current, record));
  return record;
}

/**
 * 按 ID 更新已有场景记录。
 * 这里保持“局部补丁”语义，方便任务状态从 pending -> running -> ready/failed 逐步回写。
 */
export function updateStoredScenarioRecord(id, patch) {
  const current = listStoredScenarioRecords();
  const target = current.find((item) => item?.id === id);
  if (!target) {
    return null;
  }
  const nextRecord = {
    ...target,
    ...patch,
  };
  writeJsonList(USER_SCENARIO_STORAGE_KEY, upsertById(current, nextRecord));
  return nextRecord;
}

export function removeStoredScenarioRecord(id) {
  const current = listStoredScenarioRecords();
  writeJsonList(
    USER_SCENARIO_STORAGE_KEY,
    current.filter((item) => item?.id !== id),
  );
}

export async function saveScenarioAssets(id, assets) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
    tx.objectStore(ASSET_STORE_NAME).put({ id, ...assets });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to write scenario assets."));
  });
  db.close();
}

export async function getScenarioAssets(id) {
  const db = await openDatabase();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, "readonly");
    const request = tx.objectStore(ASSET_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Failed to read scenario assets."));
  });
  db.close();
  return result;
}

export async function deleteScenarioAssets(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
    tx.objectStore(ASSET_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to delete scenario assets."));
  });
  db.close();
}

export async function saveImportedScenario({ title, czmlPayload, bundlePayload, sourceName }) {
  const id = makeScenarioId("imported");
  const createdAt = new Date().toISOString();
  const record = {
    id,
    title: title || sourceName || `Imported Scenario ${createdAt}`,
    mode: "imported",
    czmlSource: null,
    bundleSource: null,
    createdAt,
    status: "ready",
  };
  await saveScenarioAssets(id, {
    czmlPayload: sanitizeScenarioAsset(czmlPayload),
    bundlePayload: sanitizeScenarioAsset(bundlePayload),
    sourceName,
    createdAt,
  });
  saveStoredScenarioRecord(record);
  return record;
}

/**
 * 删除用户侧场景记录：
 * - imported: 删除 manifest + IndexedDB 中的双文件资产
 * - generated: 删除 manifest；当前首版没有对应大文件资产
 */
export async function deleteUserScenario(id) {
  const record = getStoredScenarioRecord(id);
  if (!record) {
    return false;
  }

  removeStoredScenarioRecord(id);

  if (record.mode === "imported" || record.mode === "generated") {
    await deleteScenarioAssets(id);
  }

  return true;
}

/**
 * “新建仿真”首版只保存一个待生成任务的 manifest。
 * 等后端接口接入后，可以在这里补状态轮询和结果回写。
 */
export function saveGeneratedScenarioManifest({
  id = makeScenarioId("generated"),
  title,
  manifest,
  backendTaskId = "",
  status = "pending",
  createdAt = new Date().toISOString(),
}) {
  const record = {
    id,
    title: title || `Generated Scenario ${createdAt}`,
    mode: "generated",
    czmlSource: null,
    bundleSource: null,
    createdAt,
    status,
    backendTaskId,
    manifest,
  };
  saveStoredScenarioRecord(record);
  return record;
}

export function loadWizardDraft() {
  try {
    const raw = sessionStorage.getItem(WIZARD_DRAFT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveWizardDraft(draft) {
  sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearWizardDraft() {
  sessionStorage.removeItem(WIZARD_DRAFT_STORAGE_KEY);
}
