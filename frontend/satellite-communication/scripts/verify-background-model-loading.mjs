// 回归：模型请求未完成/失败时主屏仍可操作，下载结束后可复用缓存。
// Usage: node scripts/verify-background-model-loading.mjs <tool-directory>
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const project = fileURLToPath(new URL('../', import.meta.url));
const requireTool = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
const { chromium } = requireTool('playwright');
const server = await createServer({ root: project, server: { host: '127.0.0.1', port: 0, open: false } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const start = '2026-09-15T00:00:00Z';
const record = { id: 'background-model-test', title: '后台模型加载测试', status: 'ready', mode: 'server-imported',
  summary: { satelliteCount: 0, aircraftCount: 1, groundStationCount: 1 }, aircraftRoutes: [] };
const nodes = [{ id: 'AC_1', type: 'aircraft', lon: 110, lat: 30, alt: 10 },
  { id: 'GS_1', type: 'ground_station', lon: 108, lat: 32, alt: 0 }];
const bundle = { metadata: { start_time: start, duration_s: 600 },
  node_tracks: nodes.map(n => ({ id: n.id, type: n.type,
    samples: [0, 600].map(t => ({ relative_time_s: t, lon_deg: n.lon + (n.type === 'aircraft' ? t / 600 : 0), lat_deg: n.lat, alt_km: n.alt })) })),
  topology_events: [], route_events: [] };
const czml = [{ id: 'document', version: '1.0', clock: { interval: `${start}/2026-09-15T00:10:00Z`, currentTime: start } },
  ...nodes.map(n => ({ id: n.id, position: { epoch: start,
    cartographicDegrees: [0,n.lon,n.lat,n.alt*1000,600,n.lon+(n.type==='aircraft'?1:0),n.lat,n.alt*1000] },
    point: { pixelSize: 8 }, label: { text: n.id } }))];
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/tiles/')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json = {};
    if (url.pathname === '/api/scenarios') json = { scenarios: [record] };
    else if (url.pathname.endsWith('/render.czml')) json = czml;
    else if (url.pathname.endsWith('/bundle.json')) json = bundle;
    else if (url.pathname.startsWith('/api/scenarios/')) json = record;
    return route.fulfill({ json });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let pending = 0;
  await page.route('**/*.glb', async route => { pending++; await gate; await route.continue(); });
  await page.goto(`${origin}/#/run?scenario=${record.id}`);
  await page.locator('.playback-progress:enabled').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.scene-loading-mask').count(), 0);
  assert.ok(pending >= 2, '飞机和地面站请求应仍被扣住');
  const progress = await page.locator('.playback-progress').inputValue();
  await page.waitForFunction(previous => Number(document.querySelector('.playback-progress').value) > Number(previous), progress);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).waitFor();
  console.log('PASS: 模型请求挂起时，遮罩消失、进度推进、播放按钮可操作');
  await page.evaluate(async () => {
    // Vite 开发模式使用 ESM Cesium，按实际 URL 引用同一个模块实例。
    const url = performance.getEntriesByType('resource').find(entry => /\/deps\/cesium\.js/.test(entry.name)).name;
    const Cesium = await import(url);
    window.__sceneTestModels = [];
    const original = Cesium.Model.fromGltfAsync;
    Cesium.Model.fromGltfAsync = async function(...args) {
      const model = await original.apply(this, args);
      window.__sceneTestModels.push(model);
      return model;
    };
  });
  release();
  const cached = await page.evaluate(async () => {
    const assets = await import('/src/lib/sceneModelAssets.js');
    return Promise.all([assets.AIRCRAFT_MODEL_URI, assets.GROUND_STATION_MODEL_URI].map(assets.preloadSceneModel));
  });
  assert.ok(cached.every(uri => uri.startsWith('blob:')));
  assert.equal(pending, 2, '场景与缓存应复用同一次模型下载');
  await page.waitForFunction(() => window.__sceneTestModels?.filter(model => model.ready).length >= 2, {}, { timeout: 30000 });
  console.log('PASS: 放行后两种模型进入缓存并完成 Cesium 渲染准备，未重复请求');
  await page.close();

  const failed = await context.newPage();
  failed.on('pageerror', error => errors.push(String(error)));
  await failed.route('**/*.glb', route => route.fulfill({ status: 503, body: 'Model unavailable' }));
  await failed.goto(`${origin}/#/run?scenario=${record.id}`);
  await failed.locator('.playback-progress:enabled').waitFor({ timeout: 60000 });
  assert.equal(await failed.locator('.scene-loading-mask').count(), 0);
  await failed.getByRole('button', { name: '暂停', exact: true }).click();
  console.log('PASS: 模型下载失败仍可进入页面和操作播放');
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
