# 卫星星座通信仿真系统 - 后端详细设计文档（SDD）

## 1. 工程架构与设计原则

### 1.1 当前目录结构

```text
satsim/
├── satellite_sim/
│   ├── main.py                  # 仿真主控程序，负责采样、事件补点与总包输出
│   ├── config.py                # 配置解析、TLE 映射、轨迹插值准备
│   ├── models.py                # Node、Edge、TrafficDemand、RoutePlan、EndToEndMetric
│   ├── core/
│   │   ├── l1_space.py          # 物理空间层
│   │   ├── l2_access.py         # 链路接入层
│   │   ├── l3_routing.py        # 网络路由层
│   │   └── l4_performance.py    # 传输性能层
│   └── utils/
│       ├── coord_utils.py       # 坐标转换工具
│       └── math_utils.py        # 距离、夹角、颜色映射等工具
├── result_player/
│   └── playback_3d.py           # 独立消费方，可读取旧帧格式和新总包格式
├── schemas/
│   └── simulation_output_bundle.schema.json
├── data/
│   ├── sample_config_*.json
│   ├── *.tle
│   └── simulation_bundle_*.json
├── PRD.md
└── SDD.md
```

### 1.2 设计原则

1. 时间系统
   系统内部统一使用相对时间 relative_time_s，单位秒，支持浮点时间点。
2. 卫星编号规则
   所有卫星在进入系统后统一转换为 sat_P_S 编号，以支撑拓扑规则和轨道面解析。
3. 输出协议优先
   主程序的最终职责是输出符合 schema 的总包 JSON，而不是耦合某个播放引擎。
4. 消费方解耦
   result_player 作为独立消费者，可以重建播放帧，但不影响主输出协议。

## 2. 核心运行时数据模型

### 2.1 Node

```python
@dataclass(slots=True)
class Node:
    id: str
    node_type: str
    lat: float
    lon: float
    alt: float
    ecef: np.ndarray
```

说明：

1. ecef 用于几何计算，不直接输出到 JSON。
2. to_dict 仅输出 id、type、lat、lon、alt。

### 2.2 Edge

```python
@dataclass(slots=True)
class Edge:
    source: str
    target: str
    edge_type: str
    distance: float
    capacity: float
    traffic: float = 0.0
    utilization: float = 0.0
    color: str = ""
```

当前 to_dict 输出字段：

1. source
2. target
3. type
4. distance_km
5. bandwidth_mbps
6. tx_rate_mbps
7. utilization
8. color

### 2.3 TrafficDemand

```python
@dataclass(slots=True)
class TrafficDemand:
    source: str
    target: str
    rate_mbps: float
```

### 2.4 RoutePlan

```python
@dataclass(slots=True)
class RoutePlan:
    source: str
    target: str
    rate_mbps: float
    path: list[str] = field(default_factory=list)
    connected: bool = False
```

### 2.5 EndToEndMetric

```python
@dataclass(slots=True)
class EndToEndMetric:
    source: str
    target: str
    path: list[str]
    latency_ms: float
    packet_loss_rate: float
    ber: float
```

当前 to_dict 输出字段：

1. source
2. target
3. connected
4. path
5. hop_count
6. latency_ms
7. packet_loss_rate
8. ber

## 3. 总包输出数据模型

标准结构见 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json)。

### 3.1 metadata
记录总包元信息、单位、采样策略和星座规模。

### 3.2 node_tracks
按节点组织位置样本序列，而不是按时间帧组织全量节点列表。

### 3.3 topology_events
按时间表达链路快照和链路增删事件，链路状态包含：

1. source
2. target
3. type
4. distance_km
5. bandwidth_mbps
6. tx_rate_mbps
7. utilization
8. color

### 3.4 route_events
按时间表达路径快照和路径变化事件，路径状态包含：

1. source
2. target
3. connected
4. path
5. hop_count
6. latency_ms
7. packet_loss_rate
8. ber

## 4. 模块详细设计

### 模块 0：配置与映射解析（config.py）

核心职责：

1. 解析 JSON 配置。
2. 加载 TLE 文件并完成 sat_mapping 映射。
3. 为飞机轨迹建立插值函数。
4. 为地面站建立静态 Node。

当前配置结构除基础参数外，还支持：

1. isl_mode
2. isl_max_distance_km
3. isl_global_neighbor_count
4. isl_same_plane_neighbor_count
5. isl_adjacent_plane_neighbor_count
6. isl_require_los
7. event_sampling_enabled
8. event_sampling_min_step
9. packet_size_bits
10. signal_speed_km_s
11. endpoint_processing_delay_ms
12. satellite_processing_delay_ms
13. gsl_access_delay_ms
14. isl_processing_delay_ms
15. aircraft_satellite_handover_duration_s
16. aircraft_satellite_handover_extra_latency_ms
17. aircraft_satellite_handover_extra_loss_rate
18. ground_station_satellite_handover_duration_s
19. ground_station_satellite_handover_extra_latency_ms
20. ground_station_satellite_handover_extra_loss_rate

关键函数：

1. load_simulation_config
2. load_mapped_satellites
3. build_aircraft_trajectory_functions
4. build_ground_station_nodes
5. prepare_simulation_assets

### 模块 1：L1 物理空间层（core/l1_space.py）

核心职责：

1. 在任意相对时间 t 下输出全部节点位置。
2. 支持浮点秒输入，以配合事件补点机制。

关键逻辑：

1. utc_time = start_time + timedelta(seconds=float(t))
2. 卫星位置通过 Skyfield 计算。
3. 飞机位置通过插值函数计算。
4. 地面站直接复用静态节点副本。

关键约束：

1. 物理层不得把事件补点时间强制截断为整数秒。
2. 输出 Node 列表必须包含 satellite、aircraft、ground_station 三类节点。

### 模块 2：L2 链路接入层（core/l2_access.py）

核心职责：

1. 计算飞机/地面站与卫星的 GSL 接入。
2. 使用向量化方法计算距离、仰角和覆盖角。

当前接入策略：

1. visible_mask：仰角大于 0。
2. coverage_mask：覆盖角不大于 sat_antenna_angle。
3. 对候选卫星取距离最小者建立单条 GSL。

### 模块 3：L3 网络路由层（core/l3_routing.py）

核心职责：

1. 生成当前时刻的 ISL。
2. 将 ISL 与 GSL 组合为图模型。
3. 对每条业务执行最短路径计算。

当前支持三种模式：

1. static-grid
   使用 sat_P_S 编号规则建立固定网格拓扑。
2. dynamic-nearest
   每帧计算卫星距离矩阵与 LoS 矩阵，在同轨和相邻轨邻域内选近邻。
3. global-nearest
   每帧计算卫星距离矩阵与 LoS 矩阵，按全局最近邻选链路。

关键设计点：

1. _compute_satellite_geometry 计算卫星距离矩阵和 LoS 矩阵。
2. _build_dynamic_isl_edges 支持同轨和相邻轨近邻限制。
3. _build_global_isl_edges 支持全局近邻限制。
4. compute 内部调用 networkx.shortest_path。
5. 无路由时返回 path=[]，connected=False。

### 模块 4：L4 传输性能层（core/l4_performance.py）

核心职责：

1. 将业务速率叠加到链路上。
2. 计算链路利用率和颜色。
3. 计算端到端时延、丢包率和 BER。

关键逻辑：

1. GSL 和 ISL 汇总为 edge_map。
2. route.path 上的边累加 traffic。
3. utilization = traffic / capacity。
4. color 由 math_utils.color_for_utilization 决定。
5. 端到端时延由传播、串行化、排队、链路附加开销、端系统处理和中间卫星处理时延组成。
6. GSL BER 受距离和 rain_fade_intensity 影响。
7. route 不连通时输出 latency_ms=-1.0、packet_loss_rate=1.0、ber=1.0。
8. main.py 在生成 snapshot 后会识别 source/target 两端的 GSL 接入卫星是否发生切换，并按 aircraft 或 ground_station 的配置叠加瞬态惩罚。
9. 瞬态惩罚会写入 steady_* 字段和 transient 字段，最终 latency_ms 与 packet_loss_rate 为叠加惩罚后的结果。

### 模块 5：仿真主控与总包输出（main.py）

核心职责：

1. 驱动时间轴。
2. 在需要时插入事件补点。
3. 把内部快照转换成总包 JSON。

当前结构分为两阶段：

1. _collect_snapshots
   负责生成内部时间快照。快照仍包含 relative_time_s、sample_type、nodes、edges、end_to_end_metrics。
2. _build_output_bundle
   负责将快照压缩成 metadata、node_tracks、topology_events、route_events。

事件补点逻辑：

1. 常规采样点来自 range(0, duration + 1, time_step)。
2. 对相邻常规点，比较 _snapshot_signature。
3. 若签名变化且区间仍大于 event_sampling_min_step，则递归二分取中点。
4. 中间点 sample_type 记为 event。

总包构建逻辑：

1. _build_node_tracks
   只从 regular 快照提取节点位置序列。
2. _build_topology_events
   第一帧输出 snapshot，后续只输出 links_upsert 和 links_remove 的 delta。
3. _build_route_events
   第一帧输出 snapshot，后续只输出路径变化的 delta。
4. save_json
   最终保存单个总包对象。

### 模块 6：独立播放消费方（result_player/playback_3d.py）

该模块不属于后端输出职责，但当前实现已兼容新旧两种输入格式。

1. 旧格式：直接读取帧数组。
2. 新格式：自动识别总包对象。
3. 播放器通过 node_tracks 插值重建节点位置。
4. 播放器按 topology_events 和 route_events 逐时刻回放链路和路径变化。

## 5. 关键算法与约束

### 5.1 relative_time_s

1. 对外输出必须统一使用 relative_time_s。
2. 该值允许是浮点数。
3. 常规采样点通常为整数秒或 time_step 的整数倍。
4. 事件补点可能产生 3.75、7.5、11.25 这类中间值。

### 5.2 ISL 建链约束

1. static-grid：按编号关系建链。
2. dynamic-nearest：按同轨/相邻轨近邻建链。
3. global-nearest：按全局近邻建链。
4. dynamic-nearest 和 global-nearest 均可叠加 LoS 和最大距离限制。

### 5.3 输出压缩原则

1. 节点位置不再放入每个事件点的全量快照中。
2. 链路变化以事件形式表达。
3. 路径变化以事件形式表达。
4. 这是一种针对动画消费方优化后的协议设计，用于控制文件体积。

## 6. 给 AI Agent 的开发指令

1. 输出协议必须以 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json) 为准，不再以旧版逐帧快照结构为准。
2. 修改输出字段时，必须同步考虑主程序、schema 和消费方兼容性。
3. relative_time_s 必须贯穿全链路，不允许混用绝对时间戳作为主时间字段。
4. parse_sat_id 仍然必须保留容错处理。
5. 路由断链时必须输出 connected=false、path=[]、latency_ms=-1.0、packet_loss_rate=1.0、ber=1.0。
6. 若扩展新的动画消费方，优先新增独立适配器，不要反向破坏总包输出协议。

## 7. 当前版本总结

当前系统已经从“后端逐帧快照生成器”升级为“后端总包输出器 + 独立播放消费者”的架构：

1. main.py 输出总包 JSON。
2. schema 文件定义正式协议。
3. result_player 负责兼容性验证和可视化回放。
4. 后端与动画系统的模块边界已经清晰分离。