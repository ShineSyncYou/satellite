import assert from "node:assert/strict";
import { test } from "node:test";
import { getSceneModelUri, preloadSceneModel, scheduleSceneModelPreload } from "./sceneModelAssets.js";

test("预加载复用进行中的请求和已完成的对象 URL，失败后允许重试", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalWindow = globalThis.window;
  const created = [];
  try {
    let calls = 0;
    let finish;
    globalThis.fetch = () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    };
    const uri = "/test-aircraft.glb";
    assert.equal(getSceneModelUri(uri), uri);
    const first = preloadSceneModel(uri);
    assert.equal(preloadSceneModel(uri), first);
    assert.equal(calls, 1);
    const bytes = new ArrayBuffer(12);
    new DataView(bytes).setUint32(0, 0x46546c67, true);
    finish(new Response(bytes));
    const cached = await first;
    created.push(cached);
    assert.ok(cached.startsWith("blob:"));
    assert.equal(getSceneModelUri(uri), cached);
    assert.equal(await preloadSceneModel(uri), cached);
    assert.equal(calls, 1);

    console.warn = () => {};
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    assert.equal(await preloadSceneModel("/retry.glb"), "/retry.glb");
    globalThis.fetch = async () => new Response("<!doctype html>fallback");
    assert.equal(await preloadSceneModel("/retry.glb"), "/retry.glb");
    globalThis.fetch = async () => new Response(bytes);
    const retried = await preloadSceneModel("/retry.glb");
    created.push(retried);
    assert.ok(retried.startsWith("blob:"));

    let scheduled = 0;
    globalThis.window = { requestIdleCallback: () => { scheduled += 1; } };
    scheduleSceneModelPreload();
    scheduleSceneModelPreload();
    assert.equal(scheduled, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    created.forEach((url) => URL.revokeObjectURL(url));
  }
});
