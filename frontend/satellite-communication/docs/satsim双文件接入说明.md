# satsim 双文件接入说明

## 1. 目标

当前项目采用“双文件方案”：

1. `*.render.czml`
   - 只负责 Cesium 渲染
   - 包含时钟、卫星/飞机/地面站轨迹、模型、点位等
2. `*.bundle.json`
   - 只负责业务逻辑
   - 包含 `metadata`、`node_tracks`、`topology_events`、`route_events` 以及后续扩展指标

当前正式方案已经不是把双文件放到前端 `public/data/satsim`，而是统一落到服务端共享场景库，再通过 `/api/scenarios/:id/*` 提供给前端。

## 2. 当前目录和关键入口

### Python 工具

- 转换脚本：[bundle_to_czml.py](/E:/Projects/satellite/satsim/tools/bundle_to_czml.py)

### 前端关键入口

- 运行时场景目录解析：[runtimeScenarioCatalog.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/runtimeScenarioCatalog.js)
- 主屏/副屏 Cesium 加载：[loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js)
- 副屏指标提取：[bundleRouteMetrics.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/bundleRouteMetrics.js)
- Node API：[index.mjs](/E:/Projects/satellite/frontend/satellite-communication/server/index.mjs)

### 服务端场景目录

- 共享场景根目录：`frontend/satellite-communication/.generated-simulations`
- 记录数据库：`frontend/satellite-communication/.generated-simulations/scenario.db`

## 3. 从 Python 到前端的完整流程

### 第 1 步：satsim 生成 simulation bundle

Python 仿真先输出原始的 `simulation_bundle_*.json`。

这个文件是场景主数据源，至少包含：

1. `metadata`
2. `node_tracks`
3. `topology_events`
4. `route_events`

如果后续新增流量、统计或图表字段，也优先保留在这个 bundle 里。

### 第 2 步：运行转换脚本

用 [bundle_to_czml.py](/E:/Projects/satellite/satsim/tools/bundle_to_czml.py) 把原始 bundle 转成前端双文件。

PowerShell 示例：

```powershell
cd E:\Projects\satellite\satsim

python tools\bundle_to_czml.py `
  --bundle data\simulation_bundle_gw2_800sat_5ac_1gs_30s.json `
  --czml data\simulation_bundle_gw2_800sat_5ac_1gs_30s.render.czml `
  --bundle-json data\simulation_bundle_gw2_800sat_5ac_1gs_30s.bundle.json `
  --multiplier 18
```

`busy`、`seam`、`GEO` 场景也是同样流程，只是换输入输出文件名。

### 第 3 步：导入或生成服务端场景

当前正式接入有两种方式：

1. 新建仿真
   - 前端向导提交 manifest
   - Node 调 Python 生成总包
   - Node 再调用 `bundle_to_czml.py`
   - 双文件落盘到 `.generated-simulations/<scenarioId>/`

2. 导入现有场景
   - 用户上传一对 `render.czml + bundle.json`
   - Node 校验后写入 `.generated-simulations/<scenarioId>/`
   - SQLite 写入场景记录

### 第 4 步：前端运行时读取

前端启动后：

1. [runtimeScenarioCatalog.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/runtimeScenarioCatalog.js) 拉取 `/api/scenarios`
2. 主屏和副屏根据场景 ID 获取：
   - `/api/scenarios/:id/render.czml`
   - `/api/scenarios/:id/bundle.json`
3. [loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js) 同时加载这两个文件
4. `render.czml` 交给 Cesium `CzmlDataSource`
5. `bundle.json` 用来恢复 topology、route、覆盖波束、蜂窝和业务指标

## 4. 当前主屏运行逻辑

主屏入口：`src/views/OperationsView.vue`

主屏主要做这些事：

1. 创建 Cesium Viewer
2. 从场景库选择当前场景
3. 调用 `loadSatsimScenario.js` 加载双文件
4. 在播放过程中按当前时刻推进：
   - `topology_events`
   - `route_events`
   - 当前活跃节点状态
   - 覆盖波束和蜂窝显示

当前实现重点：

1. 卫星点使用 `PointPrimitiveCollection`
2. 链路线使用 `PolylineCollection`
3. route 和 topology 拆成独立 primitive 池
4. 卫星模型采用近景池化
5. 波束只对当前接入链路对应的卫星显示

## 5. 当前副屏运行逻辑

副屏入口：`src/views/MetricsScreenView.vue`

副屏数据分三类：

1. 小地图
   - 仍复用 `loadSatsimScenario.js`
   - 只是在 `miniMode` 下关闭大部分覆盖和标签
2. 场景摘要卡片
   - 来自 `bundle.json`
3. 折线图和统计图
   - 通过 [bundleRouteMetrics.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/bundleRouteMetrics.js) 从 `bundle.json` 提取

副屏主要依赖 `bundle.json`，因为图表、链路指标和业务统计不适合直接塞进 CZML。

## 6. 现在如何新增场景

### 方案 A：正式推荐，导入服务端场景库

1. Python 生成：
   - `simulation_bundle_xxx.json`
2. 运行转换：
   - `simulation_bundle_xxx.render.czml`
   - `simulation_bundle_xxx.bundle.json`
3. 打开“导入现有场景”页面
4. 上传这一对双文件
5. 导入成功后，前端统一从 `/api/scenarios/:id/*` 读取

### 方案 B：开发期本地测试

也可以先把双文件放在 `E:\Projects\satellite\data` 做人工检查，但这不属于正式运行链路，不要再把它们塞回 `public/data/satsim`。

## 7. 如果 Python 输出 schema 变化，前端要改哪里

这是后续维护最重要的一条。

### 7.1 如果只是新增字段

例如新增：

1. `route.xxx`
2. `topology_events.xxx`
3. `metadata.xxx`

通常不会影响现有渲染，只需要在需要展示这些字段的前端位置补消费逻辑。

优先检查：

1. [bundleRouteMetrics.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/bundleRouteMetrics.js)
2. [loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js)
3. [MetricsScreenView.vue](/E:/Projects/satellite/frontend/satellite-communication/src/views/MetricsScreenView.vue)

### 7.2 如果字段名或结构变化

例如：

1. `effective_bandwidth_mbps` 改名
2. `packet_loss_rate` 改名
3. `node_tracks` 结构变化

这时需要同步修改前端消费逻辑。

重点位置：

1. 主屏链路、覆盖、点击信息：[loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js)
2. 副屏图表指标：[bundleRouteMetrics.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/bundleRouteMetrics.js)
3. 副屏卡片展示：[MetricsScreenView.vue](/E:/Projects/satellite/frontend/satellite-communication/src/views/MetricsScreenView.vue)

### 7.3 如果轨迹采样格式变化

例如 `lat_deg / lon_deg / alt_km / relative_time_s` 结构变化，需要同时看：

1. Python 侧 [bundle_to_czml.py](/E:/Projects/satellite/satsim/tools/bundle_to_czml.py)
2. 前端侧 [loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js)

## 8. 为什么当前不能只靠 render.czml

原因很简单：

1. `render.czml` 适合描述位置、轨迹、模型、时间轴
2. `topology_events`、`route_events`、图表指标、动态链路颜色、接入统计这些业务逻辑不适合全部硬塞进 CZML

所以当前仍然采用：

1. `render.czml` 负责“看见”
2. `bundle.json` 负责“理解”

这是当前阶段维护成本最低、职责最清晰的方案。

## 9. 当前性能结论

如果只问“现在主要瓶颈在哪里”，结论是：

1. 首屏阶段：`render.czml + bundle.json` 的下载、解压和 JSON 解析开销不小
2. 播放阶段：链路、覆盖、标签和模型切换是主要运行时开销

当前已经明确的优化方向：

1. 尽量用 primitive 池增量更新，而不是每帧重建大量 Entity
2. 路线、拓扑、覆盖分层处理
3. 减少同屏高成本对象数量

## 10. 接手时最该先看的文件

建议按这个顺序看：

1. [runtimeScenarioCatalog.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/runtimeScenarioCatalog.js)
2. [loadSatsimScenario.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/loadSatsimScenario.js)
3. [bundleRouteMetrics.js](/E:/Projects/satellite/frontend/satellite-communication/src/lib/bundleRouteMetrics.js)
4. [server/index.mjs](/E:/Projects/satellite/frontend/satellite-communication/server/index.mjs)
