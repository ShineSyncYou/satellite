import assert from "node:assert/strict";
import test from "node:test";
import { ImageryLayer, WebMercatorTilingScheme } from "cesium";
// 集成验证当前 Cesium 的真实 INVALID -> 父级裁切流程，升级 Cesium 时也应运行。
import TileImagery from "@cesium/engine/Source/Scene/TileImagery.js";
import ImageryState from "@cesium/engine/Source/Scene/ImageryState.js";
import { AmapTileDiscardPolicy, hasAmapMissingPatch } from "../src/lib/amapTileDiscardPolicy.js";

function image(color = [34, 70, 95, 255], width = 64, height = 64) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(color, i);
  return { pixels, width, height };
}

function patch(tile, color, x0 = 0, y0 = 32, width = 32, height = 32) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      tile.pixels.set(color, (y * tile.width + x) * 4);
    }
  }
  return tile;
}

const detect = (tile) => hasAmapMissingPatch(tile.pixels, tile.width, tile.height);

test("整张占位及没有图标文字的灰绿/米白混合边界均回退", () => {
  for (const color of [[129, 135, 120, 255], [129, 135, 121, 255], [237, 234, 225, 255]]) {
    assert.equal(detect(image(color)), true);
    assert.equal(detect(patch(image(), color)), true);
    // 不能只检查中心：少量缺图完全位于角落，或瓦片内部。
    assert.equal(detect(patch(image(), color, 52, 0, 12, 12)), true);
    assert.equal(detect(patch(image(), color, 13, 17, 12, 12)), true);
  }
});

test("色差容差覆盖混合瓦片的编码变化", () => {
  assert.equal(detect(patch(image(), [130, 134, 122, 255])), true);
  assert.equal(detect(patch(image(), [236, 235, 226, 255])), true);
});

test("正常海洋、雪地、沙漠和透明像素不因低纹理而回退", () => {
  for (const color of [[4, 7, 40, 255], [251, 255, 255, 255], [200, 180, 140, 255], [129, 135, 120, 0]]) {
    assert.equal(detect(image(color)), false);
  }
  assert.equal(detect(patch(image(), [129, 135, 120, 255], 0, 0, 11, 11)), false);
  const textured = image([129, 135, 120, 255]);
  for (let y = 0; y < 64; y += 1) {
    for (let x = y % 2; x < 64; x += 2) {
      textured.pixels.set([120, 128, 111, 255], (y * 64 + x) * 4);
    }
  }
  assert.equal(detect(textured), false);
});

test("同一图片只读一次像素，正常和缺图结果都缓存", () => {
  let reads = 0;
  const policy = new AmapTileDiscardPolicy((tile) => { reads += 1; return tile.pixels; });
  assert.equal(policy.isReady(), true);
  for (const tile of [image(), image([129, 135, 120, 255])]) {
    assert.equal(policy.shouldDiscardImage(tile), detect(tile));
    assert.equal(policy.shouldDiscardImage(tile), detect(tile));
  }
  assert.equal(reads, 2);
});

test("像素读取异常不会打断渲染，且不反复读取/告警", (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  let reads = 0;
  const policy = new AmapTileDiscardPolicy(() => { reads += 1; throw new Error("pixel read failed"); });
  const tile = image();
  assert.equal(policy.shouldDiscardImage(tile), false);
  assert.equal(policy.shouldDiscardImage(tile), false);
  assert.equal(policy.shouldDiscardImage(image()), false);
  assert.equal(reads, 2);
  assert.equal(warning.mock.callCount(), 1);
});

for (const warm of [false, true]) {
  test(`Cesium 连续三级缺图回退并保持 Web Mercator 裁切位置（${warm ? "已缓存" : "直接进入近景"}）`, () => {
    const policy = new AmapTileDiscardPolicy((tile) => tile.pixels);
    const provider = { tileDiscardPolicy: policy, tilingScheme: new WebMercatorTilingScheme() };
    const layer = {
      _imageryProvider: provider,
      imageryProvider: provider,
      _calculateTextureTranslationAndScale: ImageryLayer.prototype._calculateTextureTranslationAndScale,
    };
    function imagery(level, x, y, tileImage, parent) {
      return {
        state: ImageryState.UNLOADED,
        imageryLayer: layer,
        parent,
        image: tileImage,
        rectangle: provider.tilingScheme.tileXYToRectangle(x, y, level),
        addReference() {},
        releaseReference() {},
        processStateMachine() {
          if (this.state === ImageryState.UNLOADED) {
            this.state = ImageryState.RECEIVED;
          } else if (this.state === ImageryState.RECEIVED) {
            // 真正调用 Cesium 的丢弃钩子；正常图的 GPU 上传以 READY 替代。
            if (policy.shouldDiscardImage(this.image)) {
              ImageryLayer.prototype._createTexture.call(layer, {}, this);
            } else {
              this.state = ImageryState.READY;
              this.texture = {};
            }
          }
        },
      };
    }
    const base = imagery(7, 93, 53, image(), undefined);
    if (warm) { base.state = ImageryState.READY; base.texture = {}; }
    const boundary = imagery(8, 186, 106, patch(image(), [237, 234, 225, 255]), base);
    const parent = imagery(9, 373, 212, patch(image(), [129, 135, 121, 255]), boundary);
    const child = imagery(10, 746, 425, image([129, 135, 120, 255]), parent);
    const association = new TileImagery(child, undefined, true);
    const terrain = { rectangle: child.rectangle };
    let done = false;
    for (let frame = 0; frame < 20 && !done; frame += 1) {
      done = association.processStateMachine(terrain, {}, false);
    }
    assert.equal(done, true);
    for (const missing of [child, parent, boundary]) assert.equal(missing.state, ImageryState.INVALID);
    assert.equal(association.readyImagery, base);
    const crop = association.textureTranslationAndScale;
    for (const [key, value] of Object.entries({ x: 0.25, y: 0.75, z: 0.125, w: 0.125 })) {
      assert.ok(Math.abs(crop[key] - value) < 1e-10, `${key}: ${crop[key]} != ${value}`);
    }
  });
}
