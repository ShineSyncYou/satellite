# 卫星星座通信仿真系统（后端）PRD

## 1. 产品概述

### 1.1 编写目的
本文档用于描述当前“卫星星座通信仿真系统”后端的产品需求、输入输出协议和模块边界。当前后端的核心职责是：读取星座、飞机、地面站和业务配置，完成空间位置、接入、路由和传输性能计算，并输出一个统一的 JSON 总包结果，供下游动画或分析模块消费。

### 1.2 产品边界
当前系统边界明确如下：

1. 后端负责生成仿真 JSON 总包。
2. 下游模块负责消费该 JSON 总包，并实现 Cesium、PyVista 或其他可视化效果。
3. 仓库中的 result_player 仅作为独立验证工具，不属于后端输出协议本身。

### 1.3 核心对象定义

1. 节点（Node）
     卫星：固定编号为 sat_P_S，其中 P 为轨道面编号，S 为轨道面内编号。
     飞机：编号为 AC_X。
     地面站：编号为 GS_X。
2. 链路（Link）
     GSL：飞机/地面站与卫星之间的接入链路。
     ISL：卫星与卫星之间的星间链路。
3. 路径（Route）
     指从飞机到地面站的端到端节点序列。
4. 总包输出（Bundle Output）
     指当前后端唯一标准输出格式，一个 JSON 文件内包含 metadata、node_tracks、topology_events、route_events 四部分。

## 2. 系统架构

系统采用自底向上的分层仿真，并在最上层统一封装为总包输出：

1. L1 物理空间层
     计算卫星、飞机、地面站在相对时间轴上的三维位置。
2. L2 链路接入层
     基于视距、仰角和卫星天线半张角，计算 GSL 接入关系。
3. L3 网络路由层
     构建当前时刻的 ISL 与 GSL 图模型，并计算端到端路由。
4. L4 传输性能层
     对链路和路径进行流量叠加，输出带宽占用、颜色、时延、丢包率和误码率。
5. Bundle 输出层
     将常规采样和事件补点结果压缩为总包 JSON，而不是导出全量时间帧数组。

## 3. 输入参数

### 3.1 全局控制参数

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| start_time | Datetime | 仿真绝对起始时间，UTC |
| duration | Integer | 仿真总时长，单位秒 |
| time_step | Integer | 常规采样时间步长，单位秒 |
| event_sampling_enabled | Boolean | 是否启用事件驱动中间补点 |
| event_sampling_min_step | Float | 事件补点的最小递归间隔，单位秒 |

### 3.2 节点与轨道输入

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| tle_file | Text/File | TLE 轨道文件 |
| sat_mapping | JSON/Dict | TLE 卫星名或编号到 sat_P_S 的映射表 |
| aircraft_traj | JSON/CSV | 飞机轨迹点列表，包含相对时间、经纬高 |
| ground_stations | JSON/CSV | 地面站静态位置 |

### 3.3 通信与路由参数

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| sat_antenna_angle | Float | 卫星覆盖锥半张角，单位度 |
| bw_gsl | Float | 单条 GSL 最大带宽，单位 Mbps |
| bw_isl | Float | 单条 ISL 最大带宽，单位 Mbps |
| isl_mode | String | ISL 组网模式，支持 static-grid、dynamic-nearest、global-nearest |
| isl_max_distance_km | Float/Null | ISL 最大建链距离限制 |
| isl_global_neighbor_count | Integer | global-nearest 模式下的全局近邻数量 |
| isl_same_plane_neighbor_count | Integer | dynamic-nearest 模式下同轨近邻数量 |
| isl_adjacent_plane_neighbor_count | Integer | dynamic-nearest 模式下相邻轨近邻数量 |
| isl_require_los | Boolean | ISL 是否要求地球遮挡意义下的视距 |
| rain_fade_intensity | Float | GSL 云雨衰落强度因子 |
| packet_size_bits | Integer | 用于排队时延和 BER 计算的包长 |
| signal_speed_km_s | Float | 信号传播速度，默认按真空光速近似 |
| endpoint_processing_delay_ms | Float | 端系统发送和接收处理时延 |
| satellite_processing_delay_ms | Float | 中间卫星逐跳转发处理时延 |
| gsl_access_delay_ms | Float | 每条 GSL 额外接入与调度时延 |
| isl_processing_delay_ms | Float | 每条 ISL 额外交换与转发时延 |
| aircraft_satellite_handover_duration_s | Float | 飞机接入卫星切换惩罚持续时间 |
| aircraft_satellite_handover_extra_latency_ms | Float | 飞机接入卫星切换的额外时延惩罚 |
| aircraft_satellite_handover_extra_loss_rate | Float | 飞机接入卫星切换的额外丢包惩罚 |
| ground_station_satellite_handover_duration_s | Float | 地面站接入卫星切换惩罚持续时间 |
| ground_station_satellite_handover_extra_latency_ms | Float | 地面站接入卫星切换的额外时延惩罚 |
| ground_station_satellite_handover_extra_loss_rate | Float | 地面站接入卫星切换的额外丢包惩罚 |

### 3.4 业务需求参数

| 参数名 | 类型 | 说明 |
| :--- | :--- | :--- |
| traffic_demands | JSON | 业务列表，包含 source、target、rate_mbps |

## 4. 输出数据

### 4.1 输出原则
当前标准输出不再是逐帧全量快照数组，而是一个总包 JSON。原因如下：

1. 常规位置采样适合做轨迹插值。
2. 链路和路径切换更适合表达为事件流。
3. 这种结构更适合下游动画系统和通信分析模块消费。

标准 schema 定义见 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json)。

### 4.2 总包结构

```json
{
    "metadata": {},
    "node_tracks": [],
    "topology_events": [],
    "route_events": []
}
```

### 4.3 metadata
metadata 描述仿真全局信息，至少包括：

1. schema_version
2. output_mode，固定为 bundle
3. generated_at
4. start_time
5. duration_s
6. base_time_step_s
7. event_sampling_enabled
8. event_sampling_min_step_s
9. constellation 信息
10. units 信息

### 4.4 node_tracks
node_tracks 存储节点位置采样序列，用于下游轨迹插值。

```json
{
    "id": "sat_1_1",
    "type": "satellite",
    "samples": [
        {"relative_time_s": 0, "lat_deg": 45.1, "lon_deg": 110.2, "alt_km": 550.0},
        {"relative_time_s": 30, "lat_deg": 45.4, "lon_deg": 111.0, "alt_km": 550.1}
    ]
}
```

### 4.5 topology_events
topology_events 表示链路快照和链路变化事件，包含链路通信状态字段。

```json
{
    "relative_time_s": 120,
    "event_kind": "delta",
    "reason": "topology_change",
    "links_upsert": [
        {
            "source": "AC_1",
            "target": "sat_15_16",
            "type": "GSL",
            "distance_km": 1891.860883,
            "bandwidth_mbps": 150.0,
            "tx_rate_mbps": 25.0,
            "utilization": 0.166666666667,
            "color": "green"
        }
    ],
    "links_remove": [
        {
            "source": "AC_1",
            "target": "sat_14_16",
            "type": "GSL"
        }
    ]
}
```

链路信息必须包含以下字段：

1. source
2. target
3. type
4. bandwidth_mbps
5. tx_rate_mbps
6. utilization
7. color

distance_km 为推荐字段，当前实现中也会输出。

### 4.6 route_events
route_events 表示路径快照和路径切换事件，包含端到端通信参数。

```json
{
    "relative_time_s": 120,
    "event_kind": "delta",
    "reason": "route_change",
    "routes": [
        {
            "source": "AC_1",
            "target": "GS_1",
            "connected": true,
            "path": ["AC_1", "sat_15_16", "GS_1"],
            "hop_count": 2,
            "latency_ms": 10.96467,
            "packet_loss_rate": 0.002903301354,
            "ber": 2.42293646e-07
        }
    ]
}
```

路径信息必须包含以下字段：

1. source
2. target
3. connected
4. path
5. latency_ms
6. packet_loss_rate
7. ber

hop_count 为推荐字段，当前实现中也会输出。

当启用切换惩罚模型时，route 还会包含 steady_latency_ms、steady_packet_loss_rate、steady_ber 和 transient。前者表示未叠加切换惩罚时的稳态结果，transient 描述当前是否处于飞机到卫星或地面站到卫星切换惩罚窗口中。

## 5. 核心功能需求

### 5.1 L1 物理空间层

1. 相对时间轴使用秒，支持浮点时间点。
2. 卫星位置使用 TLE 和 UTC 时间计算。
3. 飞机位置使用轨迹插值函数计算。
4. 地面站为静态节点。

### 5.2 L2 链路接入层

1. 对地面站和飞机执行仰角与覆盖锥约束。
2. 仅在可见且落入卫星覆盖锥时允许接入。
3. 多颗卫星可接入时，选择距离最近的卫星建立 GSL。

### 5.3 L3 网络路由层

当前系统必须支持以下三种 ISL 生成模式：

1. static-grid
     基于 sat_P_S 固定拓扑生成同轨和跨轨链路。
2. dynamic-nearest
     每帧根据卫星几何位置计算距离矩阵，在同轨和相邻轨约束下选近邻建链。
3. global-nearest
     每帧根据卫星几何位置计算全局近邻，满足视距和距离阈值后建链。

所有模式都需要与当前时刻 GSL 一起构建图模型，并执行最短路径计算。

### 5.4 L4 传输性能层

1. 将业务流量叠加到路径经过的链路上。
2. 计算链路利用率。
3. 按利用率输出链路颜色。
4. 输出端到端时延、丢包率和 BER。

### 5.5 事件补点功能

当前系统支持事件驱动补点，用于减少链路切换在动画侧的时间量化误差。

1. 常规采样步长由 time_step 控制。
2. 如果相邻常规采样点之间链路拓扑或路径发生变化，则递归插入中间采样点。
3. 递归终止阈值由 event_sampling_min_step 控制。
4. 最终对外仍输出总包，而不是中间全量帧数组。

## 6. 技术栈

1. Python 3.9+
2. skyfield：TLE 解析和卫星轨道位置计算
3. pyproj：LLA 与 ECEF 坐标转换
4. numpy：距离矩阵与向量化计算
5. scipy：飞机轨迹插值
6. networkx：最短路径路由
7. json：总包输出

result_player 使用 pyvista 作为独立验证工具，但不属于后端输出协议的一部分。

## 7. 非功能性要求

1. 输出协议必须稳定，并与 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json) 保持一致。
2. 后端优先保证输出 JSON 的正确性和可消费性，而不是耦合具体渲染引擎。
3. 链路和路径变化应以事件方式输出，避免全量帧重复导致文件体积失控。
4. 节点位置与链路事件分离，以便下游做插值与切换控制。

## 8. 当前版本结论

当前版本的产品形态已经从“逐帧快照输出”演进为“标准化总包输出”。后端的核心交付物是 schema 约束下的 JSON 总包，后续 Cesium、PyVista 或其他动画系统均应作为该总包的消费者实现。