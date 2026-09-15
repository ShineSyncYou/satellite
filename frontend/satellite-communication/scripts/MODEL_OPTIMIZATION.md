# 场景模型压缩

2026-09-15：在原始模型旁生成 `*-optimized-v1.glb`，原始 GLB 保留。
主场景、首页预加载、详情模型预览统一从 `src/lib/sceneModelAssets.js` 读取资源路径。
修改版本化文件名可以避免浏览器继续命中旧资源。Python 双文件输出协议不变，前端统一覆盖模型 URI。

## 实际结果

| 模型 | 原始字节 | 压缩后字节 | 减小 | 原始三角面 | 压缩后三角面 |
| --- | ---: | ---: | ---: | ---: | ---: |
| aircraft-v1 | 6,191,516 | 1,749,352 | 71.7% | 3,233,510 | 247,808 |
| radar | 2,216,584 | 229,964 | 89.6% | 14,852 | 14,852 |
| tdrs | 1,795,448 | 640,336 | 64.3% | 197,235 | 194,218 |
| ground-station（详情预览） | 4,175,896 | 1,709,956 | 59.1% | 31,589 | 31,585 |

飞机以 0.07 的目标面数比例减面，并限制几何误差为 0.001；误差上限优先，因此最终面数可能高于目标。
卫星虽然设置了 0.25 的目标比例，但误差约束保留了绝大部分几何细节，体积降低主要来自去重和重新编码。
雷达不减面；地面站未做主动减面，焊接操作清除了 4 个退化三角面。
采用 Draco 编码，位置/法线/UV 量化位数分别为 16/12/14。此量化不是数学意义上的无损压缩。
材质去重、未使用资源清理及常色贴图折叠也会减小体积；没有缩小贴图分辨率或调整涂装。

## 复现

工具安装在临时目录，不属于生产依赖。已验证版本：

```powershell
npm install --prefix "$env:TEMP/satellite-model-tools" --no-audit --no-fund @gltf-transform/core@4.5.0 @gltf-transform/extensions@4.5.0 @gltf-transform/functions@4.5.0 meshoptimizer@1.2.0 draco3dgltf@1.5.7 gltf-validator@2.0.0-dev.3.10 playwright@1.63.0
node scripts/optimize-scene-models.mjs "$env:TEMP/satellite-model-tools"
node scripts/verify-scene-models.mjs "$env:TEMP/satellite-model-tools"
node --test src/lib/sceneModelAssets.test.mjs
npm run build
```

压缩脚本会重新生成这四个优化文件，请勿将手工修改保存在这些生成文件里。
浏览器验证脚本使用本机 Edge 无头模式，启动仅绑定 `127.0.0.1` 的临时资源服务，结束后自动关闭。
验证结果写入 `docs/model-optimization`（该目录按仓库约定不纳入 Git）：

- `report.json`：体积、面数、压缩文件验证和解码后验证。
- `cesium-validation.json`：8 个原始/压缩模型的实际加载结果、包围球中心及半径。
- `*-comparison.png`：同相机、同尺度、固定正面光照的对比截图。

glTF Validator 不直接解码 Draco，因此额外解码再验证实际几何数据；四个模型两轮验证均无错误。
Cesium 中 8 个模型均达到 ready 状态且无渲染错误。对比图中外形、涂装、朝向基本一致，包围球保持一致或仅存在浮点误差。
模型采用有损几何简化与量化，极近距离放大可能看到局部细节差异。

## 部署与回退

构建产物为 `dist`；应部署本次完整产物。原有 `dist.zip` 不会自动更新。
原始模型保留，因此部署目录总体积不一定下降；实际页面请求已改为更小的优化文件。
如需回退模型，只需把 `sceneModelAssets.js` 的四个常量改回原始 GLB 路径并重新构建。
本次没有修改云服务器或 Nginx 配置，也没有更新云端模型。
