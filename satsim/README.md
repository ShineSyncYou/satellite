# 卫星星座通信仿真系统

这是一个基于 Python 的卫星星座通信仿真项目，包含三类核心能力：

1. 星座与轨道数据生成
   使用 data/generatetle.py 生成单星或 Walker 星座 TLE。
2. 后端仿真计算
   使用 satellite_sim 主程序读取配置，完成空间位置、接入、路由和通信性能计算，并输出单个总包 JSON。
3. 结果播放验证
   使用 result_player/playback_3d.py 读取仿真结果，在交互式 3D 窗口中播放。

当前项目已经将后端输出统一为总包 JSON，标准协议定义见 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json)。

## 目录说明

```text
satsim/
├── satellite_sim/                         # 仿真主程序与核心算法
├── data/                                  # 配置文件、TLE 文件、仿真输出、TLE 生成器
├── result_player/                         # 3D 播放器
├── schemas/                               # 输出 JSON Schema
├── PRD.md                                 # 产品需求文档
├── SDD.md                                 # 详细设计文档
├── requirements.txt                       # 主仿真依赖
└── README.md                              # 项目总说明
```

## 环境准备

建议使用当前项目虚拟环境。

安装主仿真依赖：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe -m pip install -r requirements.txt
```

安装播放器依赖：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe -m pip install -r result_player/requirements.txt
```

## 推荐工作流

推荐按以下顺序使用项目：

1. 用 data/generatetle.py 生成需要的 TLE 星座文件。
2. 准备仿真配置 JSON。
3. 用 satellite_sim 主程序生成总包输出 JSON。
4. 用 result_player/playback_3d.py 播放结果，做本地验证。

## 1. satellite_sim 用法

主仿真入口是模块方式运行：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe -m satellite_sim.main --config data/sample_config_56sat_5ac_1gs_30s.json --output data/simulation_bundle_56sat_5ac_1gs_30s.json
```

GW2 800 星场景示例：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe -m satellite_sim.main --config data/sample_config_gw2_800sat_5ac_1gs_30s.json --output data/simulation_bundle_gw2_800sat_5ac_1gs_30s.json
```

### 输入

主程序当前真正生效的配置字段如下。

基础控制：

1. start_time
2. duration
3. time_step
4. event_sampling_enabled
5. event_sampling_min_step

场景输入：

1. tle_file
2. sat_mapping
3. aircraft_traj
4. ground_stations
5. traffic_demands

接入与星间链路：

1. sat_antenna_angle
2. bw_gsl
3. bw_isl
4. isl_max_distance_km
5. isl_require_los
6. isl_cross_plane_high_latitude_limit_deg
7. isl_block_seam_cross_plane
8. routing_switching_cost_km

传输性能：

1. rain_fade_intensity
2. packet_size_bits
3. signal_speed_km_s
4. endpoint_processing_delay_ms
5. satellite_processing_delay_ms
6. gsl_access_delay_ms
7. isl_processing_delay_ms

切换惩罚：

1. aircraft_satellite_handover_duration_s
2. aircraft_satellite_handover_extra_latency_ms
3. aircraft_satellite_handover_extra_loss_rate
4. ground_station_satellite_handover_duration_s
5. ground_station_satellite_handover_extra_latency_ms
6. ground_station_satellite_handover_extra_loss_rate

以下旧字段已经从样例配置中移除，因为当前代码不再用它们改变行为：

1. isl_mode
2. isl_global_neighbor_count
3. isl_same_plane_neighbor_count
4. isl_adjacent_plane_neighbor_count

### 输出

当前输出是单个总包 JSON，而不是旧版逐帧快照数组。

顶层结构固定为：

```json
{
  "metadata": {},
  "node_tracks": [],
  "topology_events": [],
  "route_events": []
}
```

其中 metadata.penalty_model 描述当前启用的切换惩罚参数，route_events.routes 中会额外输出 steady_latency_ms、steady_packet_loss_rate、steady_ber 和 transient，用于区分稳态指标与切换瞬态惩罚后的最终指标。

其中：

1. metadata：记录仿真元信息、单位、采样参数和星座规模。
2. node_tracks：记录节点位置采样序列。
3. topology_events：记录链路快照和链路变化，包含带宽、流量、利用率和颜色。
4. route_events：记录路径快照和路径变化，包含端到端时延、丢包率和 BER。

协议约束见 [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json)。

## 2. generatetle 用法

TLE 生成器位于 [data/generatetle.py](data/generatetle.py)，支持两种模式：

1. single
   生成单颗卫星的 TLE。
2. walker
   生成 Walker 风格星座的整套 TLE。

### 单星示例

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe data/generatetle.py single --name TEST_SAT --sat-num 99001 --raan-deg 0 --mean-anomaly-deg 0 --inclination-deg 53.0 --altitude-km 550 --output data/test_single.tle
```

### Walker 星座示例

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe data/generatetle.py walker --planes 7 --sats-per-plane 8 --inclination-deg 53.0 --altitude-km 550 --start-sat-num 92001 --name-pattern WALKER_{plane}_{slot} --output data/walker_7x8_56_test.tle
```

### GW2 20×40 示例

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe data/generatetle.py walker --planes 20 --sats-per-plane 40 --inclination-deg 86.5 --mean-motion 13.2255 --raan-span-deg 180 --start-sat-num 93001 --name-pattern GW2_{plane}_{slot} --inter-plane-slot-offset-deg 0.5 --output data/GW-2_polar_20x40_1175km_offset0.5deg.tle
```

### 常用参数

single 和 walker 共用的一些轨道参数：

1. --epoch
2. --inclination-deg
3. --eccentricity
4. --arg-perigee-deg
5. --mean-motion 或 --altitude-km
6. --element-set-number

walker 模式附加参数：

1. --planes
2. --sats-per-plane
3. --start-sat-num
4. --raan-span-deg
5. --base-raan-deg
6. --base-mean-anomaly-deg
7. --phase-factor
8. --inter-plane-slot-offset-deg
9. --name-pattern
10. --intl-designator-prefix

## 3. playback 用法

播放器入口在 [result_player/playback_3d.py](result_player/playback_3d.py)。

### 播放新版总包结果

56 星场景：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe result_player/playback_3d.py --input data/simulation_bundle_56sat_5ac_1gs_30s.json --cone-angle-deg 70
```

GW2 800 星场景：

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe result_player/playback_3d.py --input data/simulation_bundle_gw2_800sat_5ac_1gs_30s.json --cone-angle-deg 35
```

### 播放旧版逐帧结果

```powershell
c:/Users/miao/Desktop/satsim/.venv/Scripts/python.exe result_player/playback_3d.py --input data/simulation_results_56sat_5ac_1gs_30s_10min.json --cone-angle-deg 70
```

### 参数说明

1. --input
   输入 JSON 文件路径，支持旧版逐帧快照格式和新版总包格式。
2. --cone-angle-deg
   覆盖椎体半张角，单位度。该值不在输出 JSON 中，需要手动提供。
3. --frame-interval
   播放器在 1x 速度下的单帧显示时长，单位秒。

### 键位说明

1. Space：播放 / 暂停
2. Right：下一帧
3. Left：上一帧
4. Up：加快播放速度
5. Down：减慢播放速度
6. R：重置视角
7. C：切换覆盖椎体显示
8. P：切换业务路径显示
9. I：切换 ISL 显示

## 配置与数据文件示例

当前仓库中常见的示例文件包括：

1. [data/sample_config_56sat_5ac_1gs_30s.json](data/sample_config_56sat_5ac_1gs_30s.json)
2. [data/sample_config_gw2_800sat_5ac_1gs_30s.json](data/sample_config_gw2_800sat_5ac_1gs_30s.json)
3. [data/walker_7x8_56_test.tle](data/walker_7x8_56_test.tle)
4. [data/GW-2_polar_20x40_1175km_offset0.5deg.tle](data/GW-2_polar_20x40_1175km_offset0.5deg.tle)
5. [data/simulation_bundle_56sat_5ac_1gs_30s.json](data/simulation_bundle_56sat_5ac_1gs_30s.json)
6. [data/simulation_bundle_gw2_800sat_5ac_1gs_30s.json](data/simulation_bundle_gw2_800sat_5ac_1gs_30s.json)

## 文档入口

如果需要了解协议和设计细节，可继续阅读：

1. [PRD.md](PRD.md)
2. [SDD.md](SDD.md)
3. [schemas/simulation_output_bundle.schema.json](schemas/simulation_output_bundle.schema.json)
4. [result_player/README.md](result_player/README.md)

## 当前状态说明

当前项目已经完成以下演进：

1. 主仿真输出从旧版逐帧快照升级为总包 JSON。
2. 输出协议已经通过 schema 固化。
3. 播放器已兼容新旧两种输入格式。
4. GW2 800 星场景可以直接生成总包并进行播放验证。