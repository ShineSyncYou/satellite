import { spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
} from "node:zlib";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Vite loads .env for the browser build, but this standalone Node service does
// not. Load it here as well so `npm run server` and `npm run dev:all` share the
// same local configuration. Existing process environment variables still take
// precedence, which keeps deployment-time configuration authoritative.
const ENV_FILE_PATH = path.join(PROJECT_ROOT, ".env");
if (existsSync(ENV_FILE_PATH)) {
  process.loadEnvFile(ENV_FILE_PATH);
}

const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..", "..");
const DEFAULT_SATSIM_ROOT = existsSync(path.join(WORKSPACE_ROOT, "satsim"))
  ? path.join(WORKSPACE_ROOT, "satsim")
  : path.join(WORKSPACE_ROOT, "satsim");
const SATSIM_ROOT = process.env.SATSIM_ROOT || DEFAULT_SATSIM_ROOT;
const SATSIM_CZML_TOOL_ROOT = process.env.SATSIM_CZML_TOOL_ROOT || SATSIM_ROOT;
const TASK_ROOT = path.resolve(PROJECT_ROOT, ".generated-simulations");
const SCENARIO_DB_PATH = process.env.SATSIM_SCENARIO_DB_PATH || path.join(TASK_ROOT, "scenario.db");
const LEGACY_SCENARIO_DB_PATH = path.join(TASK_ROOT, "scenario-db.json");
const SERVER_PORT = Number(process.env.SATSIM_V2_SERVER_PORT || 8787);
const ADMIN_USERNAME = process.env.SATSIM_ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.SATSIM_ADMIN_PASSWORD || "";
const AUTH_SECRET = process.env.SATSIM_AUTH_SECRET || "";
const AUTH_COOKIE_NAME = "satsim_admin";
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SCENARIO_ASSET_NAMES = Object.freeze(["bundle.json", "render.czml"]);
const COMPRESSION_VARIANTS = Object.freeze([
  {
    encoding: "br",
    extension: ".br",
    createStream: () => createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    }),
  },
  {
    encoding: "gzip",
    extension: ".gz",
    createStream: () => createGzip({ level: 6 }),
  },
]);
const isWindows = process.platform === "win32";

const tasks = new Map();
const compressionJobs = new Map();
let scenarioDb = null;
let compressionQueue = Promise.resolve();

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function notFound(res) {
  jsonResponse(res, 404, { error: "Not found." });
}

function badRequest(res, message) {
  jsonResponse(res, 400, { error: message });
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { error: "Method not allowed." });
}

function unauthorized(res, message = "Unauthorized.") {
  jsonResponse(res, 401, { error: message });
}

function forbidden(res, message = "Forbidden.") {
  jsonResponse(res, 403, { error: message });
}

function makeTaskId() {
  return `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function makeScenarioId(prefix = "scenario") {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function resolvePythonExecutable() {
  const explicit = process.env.SATSIM_PYTHON;
  if (explicit) {
    return explicit;
  }

  const venvPython = isWindows
    ? path.join(SATSIM_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(SATSIM_ROOT, ".venv", "bin", "python");
  return venvPython;
}

function normalizePathname(pathname) {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return pathname;
  }

  if (pathname === "/health" || pathname.startsWith("/simulations")) {
    return `/api${pathname}`;
  }

  return pathname;
}

function serializeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "Unknown error");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileStatOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function compressedVariantIsFresh(sourceStat, variantPath) {
  const variantStat = await fileStatOrNull(variantPath);
  if (!variantStat || variantStat.size <= 0 || variantStat.mtimeMs < sourceStat.mtimeMs) {
    return null;
  }
  return variantStat;
}

async function writeCompressedVariant(sourcePath, sourceStat, variant) {
  const targetPath = `${sourcePath}${variant.extension}`;
  if (await compressedVariantIsFresh(sourceStat, targetPath)) return;

  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      createReadStream(sourcePath),
      variant.createStream(),
      createWriteStream(temporaryPath),
    );
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function compressScenarioAsset(sourcePath) {
  const sourceStat = await fileStatOrNull(sourcePath);
  if (!sourceStat?.isFile()) return;
  for (const variant of COMPRESSION_VARIANTS) {
    try {
      await writeCompressedVariant(sourcePath, sourceStat, variant);
    } catch (error) {
      console.warn(
        `[satsim-v2-server] failed to create ${variant.encoding} asset ${sourcePath}:`,
        serializeError(error),
      );
    }
  }
}

async function compressScenarioAssets(assetPaths) {
  for (const assetPath of assetPaths) {
    await compressScenarioAsset(assetPath);
  }
}

function queueScenarioAssetCompression(sourcePath) {
  if (compressionJobs.has(sourcePath)) return compressionJobs.get(sourcePath);
  const job = compressionQueue
    .catch(() => {})
    .then(() => compressScenarioAsset(sourcePath))
    .finally(() => {
      compressionJobs.delete(sourcePath);
    });
  compressionQueue = job;
  compressionJobs.set(sourcePath, job);
  return job;
}

function parseAcceptEncoding(headerValue) {
  const qualities = new Map();
  for (const part of String(headerValue || "").split(",")) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(";");
    if (!rawName) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split("=");
      if (name === "q") {
        const parsed = Number(value);
        quality = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
    }
    qualities.set(rawName, quality);
  }
  return qualities;
}

function encodingQuality(qualities, encoding) {
  if (qualities.has(encoding)) return qualities.get(encoding);
  if (qualities.has("*")) return qualities.get("*");
  return encoding === "identity" ? 1 : 0;
}

function buildAssetEtag(sourceStat, encoding) {
  return `"${sourceStat.size.toString(16)}-${Math.trunc(sourceStat.mtimeMs).toString(16)}-${encoding}"`;
}

function requestCacheMatches(req, etag, sourceStat) {
  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch) {
    return ifNoneMatch
      .split(",")
      .map((value) => value.trim())
      .some((value) => value === "*" || value === etag || value === `W/${etag}`);
  }

  const ifModifiedSince = Date.parse(String(req.headers["if-modified-since"] || ""));
  if (!Number.isFinite(ifModifiedSince)) return false;
  return Math.floor(sourceStat.mtimeMs / 1000) * 1000 <= ifModifiedSince;
}

async function selectScenarioAssetVariant(req, sourcePath) {
  const sourceStat = await fileStatOrNull(sourcePath);
  if (!sourceStat?.isFile()) return null;

  const qualities = parseAcceptEncoding(req.headers["accept-encoding"]);
  const available = [];
  for (const variant of COMPRESSION_VARIANTS) {
    const variantPath = `${sourcePath}${variant.extension}`;
    const variantStat = await compressedVariantIsFresh(sourceStat, variantPath);
    if (variantStat) {
      available.push({
        encoding: variant.encoding,
        filePath: variantPath,
        stat: variantStat,
        preference: variant.encoding === "br" ? 2 : 1,
      });
    } else {
      void queueScenarioAssetCompression(sourcePath);
    }
  }
  available.push({
    encoding: "identity",
    filePath: sourcePath,
    stat: sourceStat,
    preference: 0,
  });

  const selected = available
    .map((candidate) => ({
      ...candidate,
      quality: encodingQuality(qualities, candidate.encoding),
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => (right.quality - left.quality) || (right.preference - left.preference))[0];

  return selected ? { ...selected, sourceStat } : { unacceptable: true, sourceStat };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function taskDir(taskId) {
  return path.join(TASK_ROOT, taskId);
}

function taskMetadataPath(taskId) {
  return path.join(taskDir(taskId), "task.json");
}

function scenarioDir(scenarioId) {
  return path.join(TASK_ROOT, scenarioId);
}

function scenarioResultPath(scenarioId) {
  return path.join(scenarioDir(scenarioId), "result.json");
}

function scenarioAssetPath(scenarioId, assetName) {
  return path.join(scenarioDir(scenarioId), assetName);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) {
          return [part.trim(), ""];
        }
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
      })
      .filter(([key]) => key),
  );
}

function setCookie(res, value, options = {}) {
  const parts = [`${AUTH_COOKIE_NAME}=${value}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res) {
  setCookie(res, "", { maxAge: 0 });
}

function signAuthPayload(payload) {
  return createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
}

function encodeAuthToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = signAuthPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function decodeAuthToken(token) {
  if (!token || !AUTH_SECRET) {
    return null;
  }

  const [encodedPayload, signature] = String(token).split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signAuthPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature, "utf-8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf-8");
  if (
    signatureBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf-8"));
    if (!payload?.exp || Number(payload.exp) < Date.now()) {
      return null;
    }
    if (payload.role !== "admin" || !payload.username) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getAuthSession(req) {
  const cookies = parseCookies(req);
  const payload = decodeAuthToken(cookies[AUTH_COOKIE_NAME]);
  if (!payload) {
    return { role: "guest", username: "" };
  }
  return {
    role: payload.role,
    username: payload.username,
  };
}

function ensureAdmin(req, res) {
  const session = getAuthSession(req);
  if (session.role !== "admin") {
    forbidden(res, "Admin privileges are required.");
    return null;
  }
  return session;
}

function authEnabled() {
  return Boolean(ADMIN_USERNAME && ADMIN_PASSWORD && AUTH_SECRET);
}

function getScenarioDb() {
  if (scenarioDb) {
    return scenarioDb;
  }
  scenarioDb = new Database(SCENARIO_DB_PATH);
  scenarioDb.pragma("journal_mode = WAL");
  scenarioDb.pragma("foreign_keys = ON");
  scenarioDb.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      backend_task_id TEXT,
      summary_json TEXT,
      source_name TEXT,
      artifacts_json TEXT,
      error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT 'public'
    );

    CREATE INDEX IF NOT EXISTS idx_scenarios_status ON scenarios(status);
    CREATE INDEX IF NOT EXISTS idx_scenarios_created_at ON scenarios(created_at);
    CREATE INDEX IF NOT EXISTS idx_scenarios_backend_task_id ON scenarios(backend_task_id);
  `);
  return scenarioDb;
}

function stringifyNullable(value) {
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseNullableJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function scenarioRowToRecord(row) {
  if (!row) {
    return null;
  }
  return normalizeScenarioRecord({
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generatedAt: row.generated_at,
    backendTaskId: row.backend_task_id,
    summary: parseNullableJson(row.summary_json),
    sourceName: row.source_name,
    artifacts: parseNullableJson(row.artifacts_json),
    error: row.error,
    createdBy: row.created_by,
  });
}

function normalizeScenarioRecord(record) {
  return {
    id: String(record.id),
    title: String(record.title || record.sourceName || record.id),
    mode: String(record.mode || "server-generated"),
    status: String(record.status || "pending"),
    createdAt: record.createdAt || record.submittedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.finishedAt || record.createdAt || new Date().toISOString(),
    generatedAt: record.generatedAt || null,
    backendTaskId: record.backendTaskId || (record.mode === "server-generated" ? record.id : ""),
    summary: record.summary || null,
    sourceName: record.sourceName || record.title || record.id,
    artifacts: record.artifacts || null,
    error: record.error || "",
    createdBy: record.createdBy || "public",
  };
}

async function upsertScenarioRecord(record) {
  const normalized = normalizeScenarioRecord(record);
  const db = getScenarioDb();
  db.prepare(`
    INSERT INTO scenarios (
      id, title, mode, status, created_at, updated_at, generated_at,
      backend_task_id, summary_json, source_name, artifacts_json, error, created_by
    )
    VALUES (
      @id, @title, @mode, @status, @createdAt, @updatedAt, @generatedAt,
      @backendTaskId, @summaryJson, @sourceName, @artifactsJson, @error, @createdBy
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      mode = excluded.mode,
      status = excluded.status,
      updated_at = excluded.updated_at,
      generated_at = excluded.generated_at,
      backend_task_id = excluded.backend_task_id,
      summary_json = excluded.summary_json,
      source_name = excluded.source_name,
      artifacts_json = excluded.artifacts_json,
      error = excluded.error,
      created_by = excluded.created_by
  `).run({
    ...normalized,
    summaryJson: stringifyNullable(normalized.summary),
    artifactsJson: stringifyNullable(normalized.artifacts),
  });
  return normalized;
}

async function patchScenarioRecord(scenarioId, patch) {
  const current = await getScenarioRecord(scenarioId);
  const next = normalizeScenarioRecord({
    ...(current || { id: scenarioId }),
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  return upsertScenarioRecord(next);
}

async function getScenarioRecord(scenarioId) {
  const row = getScenarioDb().prepare("SELECT * FROM scenarios WHERE id = ?").get(scenarioId);
  return scenarioRowToRecord(row);
}

async function listScenarioRecords() {
  const rows = getScenarioDb()
    .prepare("SELECT * FROM scenarios ORDER BY created_at DESC, id DESC")
    .all();
  return rows.map(scenarioRowToRecord).filter(Boolean);
}

async function deleteScenarioRecord(scenarioId) {
  getScenarioDb().prepare("DELETE FROM scenarios WHERE id = ?").run(scenarioId);
}

async function persistTask(task) {
  const dir = taskDir(task.taskId);
  await ensureDir(dir);
  await fs.writeFile(taskMetadataPath(task.taskId), JSON.stringify(task, null, 2), "utf-8");
}

async function loadPersistedTask(taskId) {
  try {
    const raw = await fs.readFile(taskMetadataPath(taskId), "utf-8");
    const parsed = JSON.parse(raw);
    tasks.set(taskId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function getTask(taskId) {
  if (tasks.has(taskId)) {
    return tasks.get(taskId);
  }
  return loadPersistedTask(taskId);
}

function buildSampleConfig(manifest) {
  const preview = manifest?.sampleConfigPreview;
  if (!preview || typeof preview !== "object") {
    throw new Error("Manifest is missing sampleConfigPreview.");
  }
  if (!manifest?.tleText) {
    throw new Error("Manifest is missing tleText.");
  }
  if (!Array.isArray(manifest?.aircraftRoutes) || manifest.aircraftRoutes.length === 0) {
    throw new Error("Manifest must contain at least one aircraft route.");
  }
  if (manifest?.groundStation?.lat == null || manifest?.groundStation?.lon == null) {
    throw new Error("Manifest must contain a valid ground station coordinate.");
  }

  return {
    ...preview,
    // 统一由服务端生成标准 ISO 时间，避免不同客户端提交的时间字符串格式不兼容。
    start_time: new Date().toISOString(),
    tle_file: "input.tle",
    isl_cross_plane_high_latitude_limit_deg: 70,
    isl_block_seam_cross_plane: true,
  };
}

function summarizeTask(task, bundlePayload = null) {
  const metadata = bundlePayload?.metadata?.constellation || {};
  return {
    satelliteCount: metadata.satellite_count ?? task.manifest?.tleValidation?.satelliteCount ?? 0,
    aircraftCount: metadata.aircraft_count ?? task.manifest?.aircraftRoutes?.length ?? 0,
    groundStationCount: metadata.ground_station_count ?? 1,
    demandCount: task.manifest?.trafficDemands?.length ?? 0,
  };
}

function makePublicTaskPayload(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    submittedAt: task.submittedAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
    error: task.error || "",
    summary: task.summary || summarizeTask(task),
    artifacts: task.artifacts || null,
    logs: task.logs || {},
  };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed (${code}): ${stderr || stdout || args.join(" ")}`));
    });
  });
}

async function updateTask(taskId, patch) {
  const current = (await getTask(taskId)) || {};
  const next = {
    ...current,
    ...patch,
  };
  tasks.set(taskId, next);
  await persistTask(next);
  if (next.scenarioId) {
    await patchScenarioRecord(next.scenarioId, {
      id: next.scenarioId,
      title: next.manifest?.title || next.scenarioId,
      mode: "server-generated",
      status: next.status,
      createdAt: next.submittedAt,
      generatedAt: next.finishedAt || null,
      backendTaskId: next.taskId,
      summary: next.summary || summarizeTask(next),
      artifacts: next.artifacts || null,
      error: next.error || "",
      sourceName: next.manifest?.title || next.taskId,
    });
  }
  return next;
}

async function executeSimulationTask(task) {
  const pythonExecutable = resolvePythonExecutable();
  const dir = taskDir(task.taskId);
  const tlePath = path.join(dir, "input.tle");
  const manifestPath = path.join(dir, "manifest.json");
  const sampleConfigPath = path.join(dir, "sample_config.json");
  const rawBundlePath = path.join(dir, "simulation_bundle.json");
  const renderCzmlPath = path.join(dir, "render.czml");
  const bundleJsonPath = path.join(dir, "bundle.json");

  try {
    await updateTask(task.taskId, {
      status: "running",
      startedAt: new Date().toISOString(),
      error: "",
    });

    await ensureDir(dir);
    await fs.writeFile(manifestPath, JSON.stringify(task.manifest, null, 2), "utf-8");
    await fs.writeFile(tlePath, `${String(task.manifest.tleText || "").trim()}\n`, "utf-8");

    const sampleConfig = buildSampleConfig(task.manifest);
    await fs.writeFile(sampleConfigPath, JSON.stringify(sampleConfig, null, 2), "utf-8");

    const simulationResult = await runCommand(
      pythonExecutable,
      ["-m", "satellite_sim.main", "--config", sampleConfigPath, "--output", rawBundlePath],
      { cwd: SATSIM_ROOT },
    );

    await updateTask(task.taskId, {
      logs: {
        ...(task.logs || {}),
        simulation: [simulationResult.stdout, simulationResult.stderr].filter(Boolean).join("\n").trim(),
        sampleConfig: JSON.stringify(sampleConfig, null, 2),
      },
    });

    const czmlResult = await runCommand(
      pythonExecutable,
      ["tools/bundle_to_czml.py", "--bundle", rawBundlePath, "--czml", renderCzmlPath, "--bundle-json", bundleJsonPath],
      { cwd: SATSIM_CZML_TOOL_ROOT },
    );

    const bundlePayload = JSON.parse(await fs.readFile(bundleJsonPath, "utf-8"));
    const czmlPayload = JSON.parse(await fs.readFile(renderCzmlPath, "utf-8"));
    const summary = summarizeTask(task, bundlePayload);

    await fs.writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          scenarioId: task.scenarioId || task.taskId,
          taskId: task.taskId,
          generatedAt: new Date().toISOString(),
          sourceName: task.manifest?.title || task.taskId,
          summary,
          czmlPayload,
          bundlePayload,
        },
        null,
        2,
      ),
      "utf-8",
    );
    await compressScenarioAssets([bundleJsonPath, renderCzmlPath]);

    await updateTask(task.taskId, {
      status: "ready",
      finishedAt: new Date().toISOString(),
      summary,
      artifacts: {
        sampleConfigFile: path.basename(sampleConfigPath),
        bundleFile: path.basename(bundleJsonPath),
        czmlFile: path.basename(renderCzmlPath),
      },
      logs: {
        ...(await getTask(task.taskId)).logs,
        czml: [czmlResult.stdout, czmlResult.stderr].filter(Boolean).join("\n").trim(),
      },
    });
  } catch (error) {
    const current = await getTask(task.taskId);
    await updateTask(task.taskId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: serializeError(error),
      logs: current?.logs || {},
    });
  }
}

async function handleCreateTask(req, res) {
  let payload;
  try {
    payload = await readRequestBody(req);
  } catch (error) {
    badRequest(res, serializeError(error));
    return;
  }

  const manifest = payload?.manifest;
  if (!manifest || typeof manifest !== "object") {
    badRequest(res, "manifest is required.");
    return;
  }

  const taskId = makeTaskId();
  const task = {
    taskId,
    scenarioId: taskId,
    status: "pending",
    submittedAt: new Date().toISOString(),
    manifest,
    summary: summarizeTask({ manifest }),
    logs: {},
  };

  tasks.set(taskId, task);
  await persistTask(task);
  await upsertScenarioRecord({
    id: task.scenarioId,
    title: manifest.title || task.taskId,
    mode: "server-generated",
    status: task.status,
    createdAt: task.submittedAt,
    backendTaskId: task.taskId,
    summary: task.summary,
    sourceName: manifest.title || task.taskId,
  });
  void executeSimulationTask(task);

  jsonResponse(res, 202, {
    taskId,
    scenarioId: task.scenarioId,
    status: task.status,
    submittedAt: task.submittedAt,
  });
}

async function handleTaskStatus(res, taskId) {
  const task = await getTask(taskId);
  if (!task) {
    notFound(res);
    return;
  }
  jsonResponse(res, 200, makePublicTaskPayload(task));
}

async function handleTaskResult(res, taskId) {
  const task = await getTask(taskId);
  if (!task) {
    notFound(res);
    return;
  }
  if (task.status !== "ready") {
    jsonResponse(res, 409, { error: "Task is not ready yet.", status: task.status });
    return;
  }

  const resultPath = path.join(taskDir(taskId), "result.json");
  try {
    const raw = await fs.readFile(resultPath, "utf-8");
    const payload = JSON.parse(raw);
    jsonResponse(res, 200, payload);
  } catch (error) {
    jsonResponse(res, 500, { error: `Failed to load task result: ${serializeError(error)}` });
  }
}

function makePublicScenarioRecord(record) {
  return normalizeScenarioRecord(record);
}

async function getScenarioAircraftRoutes(record) {
  if (!record?.backendTaskId) {
    return [];
  }
  const task = await getTask(record.backendTaskId);
  if (!Array.isArray(task?.manifest?.aircraftRoutes)) {
    return [];
  }
  return task.manifest.aircraftRoutes.map((route) => ({
    id: String(route.id || ""),
    startAirportCode: String(route.startAirportCode || ""),
    endAirportCode: String(route.endAirportCode || ""),
  })).filter((route) => route.id);
}

async function handleListScenarios(res) {
  const records = await listScenarioRecords();
  jsonResponse(res, 200, {
    scenarios: records.map(makePublicScenarioRecord),
  });
}

async function handleScenarioDetails(res, scenarioId) {
  const record = await getScenarioRecord(scenarioId);
  if (!record) {
    notFound(res);
    return;
  }
  jsonResponse(res, 200, {
    ...makePublicScenarioRecord(record),
    aircraftRoutes: await getScenarioAircraftRoutes(record),
  });
}

async function handleScenarioResult(res, scenarioId) {
  const record = await getScenarioRecord(scenarioId);
  if (!record) {
    notFound(res);
    return;
  }
  if (record.status !== "ready") {
    jsonResponse(res, 409, { error: "Scenario is not ready yet.", status: record.status });
    return;
  }

  const resultPath = scenarioResultPath(scenarioId);
  try {
    const raw = await fs.readFile(resultPath, "utf-8");
    jsonResponse(res, 200, JSON.parse(raw));
  } catch (error) {
    jsonResponse(res, 500, { error: `Failed to load scenario result: ${serializeError(error)}` });
  }
}

async function handleScenarioAsset(req, res, scenarioId, assetName) {
  const record = await getScenarioRecord(scenarioId);
  if (!record) {
    notFound(res);
    return;
  }
  if (record.status !== "ready") {
    jsonResponse(res, 409, { error: "Scenario is not ready yet.", status: record.status });
    return;
  }
  if (!SCENARIO_ASSET_NAMES.includes(assetName)) {
    notFound(res);
    return;
  }

  const filePath = scenarioAssetPath(scenarioId, assetName);
  const selected = await selectScenarioAssetVariant(req, filePath);
  if (!selected) {
    notFound(res);
    return;
  }
  if (selected.unacceptable) {
    res.writeHead(406, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Vary": "Accept-Encoding",
    });
    res.end(JSON.stringify({ error: "No acceptable content encoding is available." }));
    return;
  }

  const etag = buildAssetEtag(selected.sourceStat, selected.encoding);
  const responseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": selected.stat.size,
    "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    "ETag": etag,
    "Last-Modified": selected.sourceStat.mtime.toUTCString(),
    "Vary": "Accept-Encoding",
  };
  if (selected.encoding !== "identity") {
    responseHeaders["Content-Encoding"] = selected.encoding;
  }

  if (requestCacheMatches(req, etag, selected.sourceStat)) {
    delete responseHeaders["Content-Length"];
    res.writeHead(304, responseHeaders);
    res.end();
    return;
  }

  res.writeHead(200, responseHeaders);
  createReadStream(selected.filePath).pipe(res);
}

async function handleDeleteScenario(req, res, scenarioId) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  const record = await getScenarioRecord(scenarioId);
  if (!record) {
    notFound(res);
    return;
  }

  const directoriesToRemove = new Set([scenarioDir(scenarioId)]);
  if (record.backendTaskId) {
    directoriesToRemove.add(taskDir(record.backendTaskId));
  }

  for (const dir of directoriesToRemove) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  tasks.delete(scenarioId);
  if (record.backendTaskId) {
    tasks.delete(record.backendTaskId);
  }
  await deleteScenarioRecord(scenarioId);

  res.writeHead(204);
  res.end();
}

async function handleImportScenario(req, res) {
  let payload;
  try {
    payload = await readRequestBody(req);
  } catch (error) {
    badRequest(res, serializeError(error));
    return;
  }

  const czmlPayload = payload?.czmlPayload;
  const bundlePayload = payload?.bundlePayload;
  if (!Array.isArray(czmlPayload)) {
    badRequest(res, "czmlPayload must be a CZML JSON array.");
    return;
  }
  if (!bundlePayload?.metadata || !Array.isArray(bundlePayload?.node_tracks)) {
    badRequest(res, "bundlePayload must be a valid satsim bundle JSON.");
    return;
  }

  const scenarioId = makeScenarioId("server-imported");
  const createdAt = new Date().toISOString();
  const dir = scenarioDir(scenarioId);
  const summary = {
    satelliteCount: bundlePayload.metadata?.constellation?.satellite_count ?? 0,
    aircraftCount: bundlePayload.metadata?.constellation?.aircraft_count ?? 0,
    groundStationCount: bundlePayload.metadata?.constellation?.ground_station_count ?? 0,
    demandCount: Array.isArray(bundlePayload.route_events?.[0]?.routes)
      ? bundlePayload.route_events[0].routes.length
      : 0,
  };

  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "render.czml"), JSON.stringify(czmlPayload, null, 2), "utf-8");
  await fs.writeFile(path.join(dir, "bundle.json"), JSON.stringify(bundlePayload, null, 2), "utf-8");
  await fs.writeFile(
    scenarioResultPath(scenarioId),
    JSON.stringify(
      {
        scenarioId,
        taskId: "",
        generatedAt: createdAt,
        sourceName: payload.sourceName || payload.title || scenarioId,
        summary,
        czmlPayload,
        bundlePayload,
      },
      null,
      2,
    ),
    "utf-8",
  );
  await compressScenarioAssets([
    path.join(dir, "bundle.json"),
    path.join(dir, "render.czml"),
  ]);

  const record = await upsertScenarioRecord({
    id: scenarioId,
    title: payload.title || payload.sourceName || `Imported Scenario ${createdAt}`,
    mode: "server-imported",
    status: "ready",
    createdAt,
    generatedAt: createdAt,
    summary,
    sourceName: payload.sourceName || payload.title || scenarioId,
    artifacts: {
      czmlFile: "render.czml",
      bundleFile: "bundle.json",
    },
  });

  jsonResponse(res, 201, makePublicScenarioRecord(record));
}

async function handleAuthStatus(req, res) {
  const session = getAuthSession(req);
  jsonResponse(res, 200, session);
}

async function handleAuthLogin(req, res) {
  if (!authEnabled()) {
    jsonResponse(res, 503, {
      error: "Admin login is not configured. Please set SATSIM_ADMIN_USERNAME, SATSIM_ADMIN_PASSWORD, and SATSIM_AUTH_SECRET.",
    });
    return;
  }

  let payload;
  try {
    payload = await readRequestBody(req);
  } catch (error) {
    badRequest(res, serializeError(error));
    return;
  }

  if (payload?.username !== ADMIN_USERNAME || payload?.password !== ADMIN_PASSWORD) {
    unauthorized(res, "Invalid username or password.");
    return;
  }

  const token = encodeAuthToken({
    username: ADMIN_USERNAME,
    role: "admin",
    exp: Date.now() + AUTH_TOKEN_TTL_MS,
  });
  setCookie(res, token, { maxAge: AUTH_TOKEN_TTL_MS / 1000 });
  jsonResponse(res, 200, { role: "admin", username: ADMIN_USERNAME });
}

async function handleAuthLogout(_req, res) {
  clearAuthCookie(res);
  jsonResponse(res, 200, { role: "guest", username: "" });
}

async function seedScenarioDbIfEmpty() {
  const db = getScenarioDb();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM scenarios").get();
  if (Number(existing?.count || 0) > 0) {
    return;
  }

  if (await fileExists(LEGACY_SCENARIO_DB_PATH)) {
    try {
      const raw = await fs.readFile(LEGACY_SCENARIO_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.scenarios) ? parsed.scenarios : [];
      for (const record of records) {
        await upsertScenarioRecord(record);
      }
    } catch (error) {
      console.warn("[satsim-v2-server] failed to import legacy scenario-db.json:", serializeError(error));
    }
  }

  const afterLegacy = db.prepare("SELECT COUNT(*) AS count FROM scenarios").get();
  if (Number(afterLegacy?.count || 0) > 0) {
    return;
  }

  await ensureDir(TASK_ROOT);
  const entries = await fs.readdir(TASK_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("task-")) {
      continue;
    }
    const task = await loadPersistedTask(entry.name);
    if (!task) {
      continue;
    }
    await upsertScenarioRecord({
      id: task.scenarioId || task.taskId,
      title: task.manifest?.title || task.taskId,
      mode: "server-generated",
      status: task.status,
      createdAt: task.submittedAt,
      generatedAt: task.finishedAt || null,
      backendTaskId: task.taskId,
      summary: task.summary || summarizeTask(task),
      artifacts: task.artifacts || null,
      error: task.error || "",
      sourceName: task.manifest?.title || task.taskId,
    });
  }
}

async function backfillScenarioAssetCompression() {
  const records = (await listScenarioRecords()).filter((record) => record.status === "ready");
  for (const record of records) {
    for (const assetName of SCENARIO_ASSET_NAMES) {
      const assetPath = scenarioAssetPath(record.id, assetName);
      if (await fileExists(assetPath)) {
        await queueScenarioAssetCompression(assetPath);
      }
    }
  }
}

async function bootstrap() {
  await ensureDir(TASK_ROOT);
  await seedScenarioDbIfEmpty();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = normalizePathname(requestUrl.pathname);

    if (pathname === "/api/health") {
      jsonResponse(res, 200, {
        ok: true,
        python: resolvePythonExecutable(),
        satsimRoot: SATSIM_ROOT,
        czmlToolRoot: SATSIM_CZML_TOOL_ROOT,
      });
      return;
    }

    if (pathname === "/api/simulations") {
      if (req.method === "POST") {
        await handleCreateTask(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    if (pathname === "/api/scenarios") {
      if (req.method === "GET") {
        await handleListScenarios(res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    if (pathname === "/api/scenarios/import") {
      if (req.method === "POST") {
        await handleImportScenario(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    if (pathname === "/api/auth/me") {
      if (req.method === "GET") {
        await handleAuthStatus(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    if (pathname === "/api/auth/login") {
      if (req.method === "POST") {
        await handleAuthLogin(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    if (pathname === "/api/auth/logout") {
      if (req.method === "POST") {
        await handleAuthLogout(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }

    const scenarioResultMatch = pathname.match(/^\/api\/scenarios\/([^/]+)\/result$/);
    if (scenarioResultMatch) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      await handleScenarioResult(res, decodeURIComponent(scenarioResultMatch[1]));
      return;
    }

    const scenarioAssetMatch = pathname.match(/^\/api\/scenarios\/([^/]+)\/(render\.czml|bundle\.json)$/);
    if (scenarioAssetMatch) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      await handleScenarioAsset(req, res, decodeURIComponent(scenarioAssetMatch[1]), scenarioAssetMatch[2]);
      return;
    }

    const scenarioDetailsMatch = pathname.match(/^\/api\/scenarios\/([^/]+)$/);
    if (scenarioDetailsMatch) {
      if (req.method === "GET") {
        await handleScenarioDetails(res, decodeURIComponent(scenarioDetailsMatch[1]));
        return;
      }
      if (req.method === "DELETE") {
        await handleDeleteScenario(req, res, decodeURIComponent(scenarioDetailsMatch[1]));
        return;
      }
      methodNotAllowed(res);
      return;
    }

    const taskStatusMatch = pathname.match(/^\/api\/simulations\/([^/]+)$/);
    if (taskStatusMatch) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      await handleTaskStatus(res, decodeURIComponent(taskStatusMatch[1]));
      return;
    }

    const taskResultMatch = pathname.match(/^\/api\/simulations\/([^/]+)\/result$/);
    if (taskResultMatch) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      await handleTaskResult(res, decodeURIComponent(taskResultMatch[1]));
      return;
    }

    notFound(res);
  });

  server.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`[satsim-v2-server] listening on http://127.0.0.1:${SERVER_PORT}`);
    console.log(`[satsim-v2-server] satsim root: ${SATSIM_ROOT}`);
    console.log(`[satsim-v2-server] python: ${resolvePythonExecutable()}`);
    console.log(`[satsim-v2-server] admin auth: ${authEnabled() ? "enabled" : "disabled"}`);
    void backfillScenarioAssetCompression().catch((error) => {
      console.warn("[satsim-v2-server] compression backfill failed:", serializeError(error));
    });
  });
}

process.on("uncaughtException", (error) => {
  console.error("[satsim-v2-server] uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[satsim-v2-server] unhandled rejection:", reason);
});

bootstrap().catch((error) => {
  console.error("[satsim-v2-server] bootstrap failed:", error);
  process.exitCode = 1;
});
