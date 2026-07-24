from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from scipy.interpolate import interp1d
from skyfield.api import EarthSatellite, load

from .models import Node, TrafficDemand
from .utils.coord_utils import lla_to_ecef_km

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class AircraftTrajectory:
    id: str
    points: list[dict[str, float]]


@dataclass(slots=True)
class AircraftTrajectoryFunctions:
    lat: Callable[[float], Any]
    lon: Callable[[float], Any]
    alt: Callable[[float], Any]


@dataclass(slots=True)
class SimulationConfig:
    start_time: datetime
    duration: int
    time_step: int
    tle_file: Path
    sat_mapping: dict[str, str]
    aircraft_traj: list[AircraftTrajectory]
    ground_stations: list[dict[str, Any]]
    sat_antenna_angle: float
    bw_gsl: float
    bw_isl: float
    rain_fade_intensity: float
    traffic_demands: list[TrafficDemand]
    geo_sat_antenna_angle: float | None = None
    bw_geo_gsl: float | None = None
    geo_isl_max_distance_km: float | None = None
    geo_isl_neighbor_count: int = 2
    isl_mode: str = "static-grid"
    isl_max_distance_km: float | None = None
    isl_global_neighbor_count: int = 4
    isl_same_plane_neighbor_count: int = 2
    isl_adjacent_plane_neighbor_count: int = 1
    isl_require_los: bool = True
    isl_cross_plane_high_latitude_limit_deg: float | None = None
    isl_block_seam_cross_plane: bool = False
    routing_switching_cost_km: float = 0.0
    packet_size_bits: int = 12000
    signal_speed_km_s: float = 299792.458
    endpoint_processing_delay_ms: float = 2.0
    satellite_processing_delay_ms: float = 3.0
    gsl_access_delay_ms: float = 8.0
    isl_processing_delay_ms: float = 1.5
    aircraft_satellite_handover_duration_s: float = 10.0
    aircraft_satellite_handover_extra_latency_ms: float = 15.0
    aircraft_satellite_handover_extra_loss_rate: float = 0.01
    ground_station_satellite_handover_duration_s: float = 6.0
    ground_station_satellite_handover_extra_latency_ms: float = 8.0
    ground_station_satellite_handover_extra_loss_rate: float = 0.004
    event_sampling_enabled: bool = False
    event_sampling_min_step: float = 5.0


@dataclass(slots=True)
class PreparedSimulationAssets:
    satellites: dict[str, EarthSatellite]
    aircraft_traj_funcs: dict[str, AircraftTrajectoryFunctions]
    ground_stations: list[Node]


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _resolve_path(base_dir: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return (base_dir / path).resolve()


def _constant_interp(value: float) -> Callable[[float], np.ndarray]:
    def _func(x: float) -> np.ndarray:
        arr = np.asarray(x, dtype=float)
        return np.full_like(arr, fill_value=value, dtype=float)

    return _func


def _build_interp(times: np.ndarray, values: np.ndarray) -> Callable[[float], Any]:
    if len(times) == 1:
        return _constant_interp(float(values[0]))
    return interp1d(times, values, kind="linear", bounds_error=False, fill_value="extrapolate")


def _parse_aircraft_traj(raw_value: Any) -> list[AircraftTrajectory]:
    if isinstance(raw_value, dict):
        trajectories: list[AircraftTrajectory] = []
        for aircraft_id, points in raw_value.items():
            trajectories.append(AircraftTrajectory(id=aircraft_id, points=list(points)))
        return trajectories

    trajectories = []
    for item in raw_value or []:
        aircraft_id = item["id"]
        points = list(item.get("points", []))
        trajectories.append(AircraftTrajectory(id=aircraft_id, points=points))
    return trajectories


def _parse_demands(raw_value: Any) -> list[TrafficDemand]:
    demands = []
    for item in raw_value or []:
        rate = item.get("rate_mbps", item.get("tx_rate_mbps", 0.0))
        demands.append(
            TrafficDemand(
                source=item["source"],
                target=item["target"],
                rate_mbps=float(rate),
            )
        )
    return demands


def load_simulation_config(config_path: str | Path) -> SimulationConfig:
    path = Path(config_path).resolve()
    raw = json.loads(path.read_text(encoding="utf-8"))
    return SimulationConfig(
        start_time=_parse_datetime(raw["start_time"]),
        duration=int(raw["duration"]),
        time_step=int(raw["time_step"]),
        tle_file=_resolve_path(path.parent, raw["tle_file"]),
        sat_mapping={str(key): str(value) for key, value in raw["sat_mapping"].items()},
        aircraft_traj=_parse_aircraft_traj(raw.get("aircraft_traj", [])),
        ground_stations=list(raw.get("ground_stations", [])),
        sat_antenna_angle=float(raw["sat_antenna_angle"]),
        bw_gsl=float(raw["bw_gsl"]),
        geo_sat_antenna_angle=(
            float(raw["geo_sat_antenna_angle"])
            if raw.get("geo_sat_antenna_angle") is not None
            else None
        ),
        bw_geo_gsl=(
            float(raw["bw_geo_gsl"])
            if raw.get("bw_geo_gsl") is not None
            else None
        ),
        geo_isl_max_distance_km=(
            float(raw["geo_isl_max_distance_km"])
            if raw.get("geo_isl_max_distance_km") is not None
            else None
        ),
        geo_isl_neighbor_count=int(raw.get("geo_isl_neighbor_count", 2)),
        bw_isl=float(raw["bw_isl"]),
        isl_mode=str(raw.get("isl_mode", "static-grid")),
        isl_max_distance_km=(float(raw["isl_max_distance_km"]) if raw.get("isl_max_distance_km") is not None else None),
        isl_global_neighbor_count=int(raw.get("isl_global_neighbor_count", 4)),
        isl_same_plane_neighbor_count=int(raw.get("isl_same_plane_neighbor_count", 2)),
        isl_adjacent_plane_neighbor_count=int(raw.get("isl_adjacent_plane_neighbor_count", 1)),
        isl_require_los=bool(raw.get("isl_require_los", True)),
        isl_cross_plane_high_latitude_limit_deg=(
            float(raw["isl_cross_plane_high_latitude_limit_deg"])
            if raw.get("isl_cross_plane_high_latitude_limit_deg") is not None
            else None
        ),
        isl_block_seam_cross_plane=bool(raw.get("isl_block_seam_cross_plane", False)),
        routing_switching_cost_km=float(raw.get("routing_switching_cost_km", 0.0)),
        rain_fade_intensity=float(raw.get("rain_fade_intensity", 0.0)),
        traffic_demands=_parse_demands(raw.get("traffic_demands", [])),
        packet_size_bits=int(raw.get("packet_size_bits", 12000)),
        signal_speed_km_s=float(raw.get("signal_speed_km_s", 299792.458)),
        endpoint_processing_delay_ms=float(raw.get("endpoint_processing_delay_ms", 2.0)),
        satellite_processing_delay_ms=float(raw.get("satellite_processing_delay_ms", 3.0)),
        gsl_access_delay_ms=float(raw.get("gsl_access_delay_ms", 8.0)),
        isl_processing_delay_ms=float(raw.get("isl_processing_delay_ms", 1.5)),
        aircraft_satellite_handover_duration_s=float(raw.get("aircraft_satellite_handover_duration_s", 10.0)),
        aircraft_satellite_handover_extra_latency_ms=float(raw.get("aircraft_satellite_handover_extra_latency_ms", 15.0)),
        aircraft_satellite_handover_extra_loss_rate=float(raw.get("aircraft_satellite_handover_extra_loss_rate", 0.01)),
        ground_station_satellite_handover_duration_s=float(raw.get("ground_station_satellite_handover_duration_s", 6.0)),
        ground_station_satellite_handover_extra_latency_ms=float(raw.get("ground_station_satellite_handover_extra_latency_ms", 8.0)),
        ground_station_satellite_handover_extra_loss_rate=float(raw.get("ground_station_satellite_handover_extra_loss_rate", 0.004)),
        event_sampling_enabled=bool(raw.get("event_sampling_enabled", False)),
        event_sampling_min_step=float(raw.get("event_sampling_min_step", 5.0)),
    )


def load_mapped_satellites(tle_file: str | Path, sat_mapping: dict[str, str]) -> dict[str, EarthSatellite]:
    tle_path = Path(tle_file).resolve()
    loaded_satellites = load.tle_file(str(tle_path))
    mapped: dict[str, EarthSatellite] = {}

    for satellite in loaded_satellites:
        candidate_keys = [satellite.name, str(satellite.model.satnum)]
        mapped_id = next((sat_mapping[key] for key in candidate_keys if key in sat_mapping), None)
        if mapped_id is None:
            continue
        mapped[mapped_id] = satellite

    missing = sorted(set(sat_mapping.values()) - set(mapped.keys()))
    if missing:
        LOGGER.warning("Missing TLE entries for mapped satellites: %s", ", ".join(missing))
    if not mapped:
        raise ValueError("No satellites were loaded from the provided TLE file and sat_mapping.")
    return mapped


def build_aircraft_trajectory_functions(aircraft_traj: list[AircraftTrajectory]) -> dict[str, AircraftTrajectoryFunctions]:
    functions: dict[str, AircraftTrajectoryFunctions] = {}
    for aircraft in aircraft_traj:
        if not aircraft.points:
            LOGGER.warning("Aircraft %s has no trajectory points and will be ignored.", aircraft.id)
            continue

        ordered_points = sorted(aircraft.points, key=lambda item: float(item["time_s"]))
        times = np.asarray([float(point["time_s"]) for point in ordered_points], dtype=float)
        latitudes = np.asarray([float(point["lat"]) for point in ordered_points], dtype=float)
        longitudes = np.asarray([float(point["lon"]) for point in ordered_points], dtype=float)
        altitudes = np.asarray([float(point["alt"]) for point in ordered_points], dtype=float)

        functions[aircraft.id] = AircraftTrajectoryFunctions(
            lat=_build_interp(times, latitudes),
            lon=_build_interp(times, longitudes),
            alt=_build_interp(times, altitudes),
        )

    return functions


def build_ground_station_nodes(ground_stations: list[dict[str, Any]]) -> list[Node]:
    nodes: list[Node] = []
    for station in ground_stations:
        lat = float(station["lat"])
        lon = float(station["lon"])
        alt = float(station.get("alt", 0.0))
        ecef = np.asarray(lla_to_ecef_km(lat, lon, alt), dtype=float)
        nodes.append(
            Node(
                id=str(station["id"]),
                node_type="ground_station",
                lat=lat,
                lon=lon,
                alt=alt,
                ecef=ecef,
            )
        )
    return nodes


def prepare_simulation_assets(config: SimulationConfig) -> PreparedSimulationAssets:
    return PreparedSimulationAssets(
        satellites=load_mapped_satellites(config.tle_file, config.sat_mapping),
        aircraft_traj_funcs=build_aircraft_trajectory_functions(config.aircraft_traj),
        ground_stations=build_ground_station_nodes(config.ground_stations),
    )
