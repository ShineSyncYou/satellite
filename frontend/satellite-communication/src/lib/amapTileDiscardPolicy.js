// 高德 style=6 实测缺图填充色：整张占位图/混合瓦片中的灰绿，以及影像边缘的米白。
// 混合瓦片不一定带“此区域无卫星图”的文字，因此不能只匹配完整占位图片。
const MISSING_FILL_COLORS = [[129, 135, 120], [237, 234, 225]];
const COLOR_TOLERANCE = 2; // 同一填充色在 PNG/JPEG 中会有少量色差。
const MIN_PATCH_SIZE = 12;

/**
 * 只识别已核验的缺图色连续实心块，不把普通低纹理海洋、雪地或零散相近像素当作缺图。
 * 任意位置出现 12×12 缺图块即弃用整张瓦片，包含边界处仍然有效的高清部分。
 */
export function hasAmapMissingPatch(pixels, width, height) {
  const runs = MISSING_FILL_COLORS.map(() => new Uint16Array(width));
  const spans = new Uint16Array(MISSING_FILL_COLORS.length);
  for (let y = 0; y < height; y += 1) {
    spans.fill(0);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      for (let colorIndex = 0; colorIndex < MISSING_FILL_COLORS.length; colorIndex += 1) {
        const color = MISSING_FILL_COLORS[colorIndex];
        const matches = pixels[offset + 3] === 255
          && Math.abs(pixels[offset] - color[0]) <= COLOR_TOLERANCE
          && Math.abs(pixels[offset + 1] - color[1]) <= COLOR_TOLERANCE
          && Math.abs(pixels[offset + 2] - color[2]) <= COLOR_TOLERANCE;
        runs[colorIndex][x] = matches ? runs[colorIndex][x] + 1 : 0;
        spans[colorIndex] = runs[colorIndex][x] >= MIN_PATCH_SIZE ? spans[colorIndex] + 1 : 0;
        if (spans[colorIndex] >= MIN_PATCH_SIZE) return true;
      }
    }
  }
  return false;
}

/** Cesium 的 INVALID 瓦片会沿父级查找有效影像，并自动计算地理裁切范围。 */
export class AmapTileDiscardPolicy {
  constructor(readPixels) {
    this.readPixels = readPixels;
    this.results = new WeakMap();
    this.warned = false;
  }

  isReady() {
    return true;
  }

  shouldDiscardImage(image) {
    if (this.results.has(image)) return this.results.get(image);
    let discard = false;
    try {
      discard = hasAmapMissingPatch(this.readPixels(image), image.width, image.height);
    } catch (error) {
      // 图源跨域策略变化等异常不能中断 Cesium 的纹理上传/渲染循环。
      if (!this.warned) {
        console.warn("[amap-imagery] 无法读取瓦片像素，跳过缺图检查", error);
        this.warned = true;
      }
    }
    this.results.set(image, discard);
    return discard;
  }
}
