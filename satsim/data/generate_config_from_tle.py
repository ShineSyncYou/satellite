# Example: .venv/Scripts/python.exe data/generate_config_from_tle.py data/GW-2_polar_20x20_1175km_offset0.5deg_3GEO.tle --output data/sample_config_gw2_400sat_5ac_1gs_3GEO.json
from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any


# Paths
DEFAULT_OUTPUT_PATH = ""

# Simulation timing
DEFAULT_START_TIME = "2026-04-03T00:00:00Z"
DEFAULT_DURATION_S = 600
DEFAULT_TIME_STEP_S = 30
DEFAULT_EVENT_SAMPLING_ENABLED = True
DEFAULT_EVENT_SAMPLING_MIN_STEP_S = 5.0

# Access and ISL
DEFAULT_SAT_ANTENNA_ANGLE_DEG = 35.0
DEFAULT_BW_GSL_MBPS = 150.0
DEFAULT_GEO_SAT_ANTENNA_ANGLE_DEG = 8.0
DEFAULT_BW_GEO_GSL_MBPS = 300.0
DEFAULT_BW_ISL_MBPS = 500.0
DEFAULT_GEO_ISL_MAX_DISTANCE_KM = 75000.0
DEFAULT_GEO_ISL_NEIGHBOR_COUNT = 2
DEFAULT_ISL_MODE = "static-grid"
DEFAULT_ISL_MAX_DISTANCE_KM = 2500.0
DEFAULT_ISL_GLOBAL_NEIGHBOR_COUNT = 4
DEFAULT_ISL_SAME_PLANE_NEIGHBOR_COUNT = 2
DEFAULT_ISL_ADJACENT_PLANE_NEIGHBOR_COUNT = 1
DEFAULT_ISL_REQUIRE_LOS = True
DEFAULT_ISL_CROSS_PLANE_HIGH_LATITUDE_LIMIT_DEG: float | None = 70.0
DEFAULT_ISL_BLOCK_SEAM_CROSS_PLANE = True
DEFAULT_ROUTING_SWITCHING_COST_KM = 0.0

# Link and endpoint performance
DEFAULT_RAIN_FADE_INTENSITY = 0.15
DEFAULT_PACKET_SIZE_BITS = 12000
DEFAULT_SIGNAL_SPEED_KM_S = 299792.458
DEFAULT_ENDPOINT_PROCESSING_DELAY_MS = 2.0
DEFAULT_SATELLITE_PROCESSING_DELAY_MS = 3.0
DEFAULT_GSL_ACCESS_DELAY_MS = 8.0
DEFAULT_ISL_PROCESSING_DELAY_MS = 1.5

# Handover penalties
DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_DURATION_S = 10.0
DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_EXTRA_LATENCY_MS = 15.0
DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_EXTRA_LOSS_RATE = 0.01
DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_DURATION_S = 6.0
DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_EXTRA_LATENCY_MS = 8.0
DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_EXTRA_LOSS_RATE = 0.004

# Default scenario content
DEFAULT_AIRCRAFT_TRAJECTORIES: list[dict[str, Any]] = [
    {
        "id": "AC_1",
        "points": [
            {"time_s": 0, "lat": 39.9, "lon": 116.4, "alt": 10.6},
            {"time_s": 300, "lat": 37.87, "lon": 112.55, "alt": 10.8},
            {"time_s": 600, "lat": 34.34, "lon": 108.94, "alt": 10.6},
        ],
    },
    {
        "id": "AC_2",
        "points": [
            {"time_s": 0, "lat": 31.23, "lon": 121.47, "alt": 10.7},
            {"time_s": 300, "lat": 32.06, "lon": 118.79, "alt": 10.9},
            {"time_s": 600, "lat": 30.27, "lon": 120.15, "alt": 10.7},
        ],
    },
    {
        "id": "AC_3",
        "points": [
            {"time_s": 0, "lat": 48.86, "lon": 2.35, "alt": 10.4},
            {"time_s": 300, "lat": 49.25, "lon": 3.15, "alt": 10.7},
            {"time_s": 600, "lat": 49.64, "lon": 3.96, "alt": 10.4},
        ],
    },
    {
        "id": "AC_4",
        "points": [
            {"time_s": 0, "lat": 40.71, "lon": -74.01, "alt": 10.2},
            {"time_s": 300, "lat": 40.96, "lon": -73.35, "alt": 10.5},
            {"time_s": 600, "lat": 41.2, "lon": -72.7, "alt": 10.2},
        ],
    },
    {
        "id": "AC_5",
        "points": [
            {"time_s": 0, "lat": 25.0, "lon": -160.0, "alt": 10.9},
            {"time_s": 300, "lat": 25.2, "lon": -159.25, "alt": 11.0},
            {"time_s": 600, "lat": 25.4, "lon": -158.5, "alt": 10.9},
        ],
    }
]
DEFAULT_GROUND_STATIONS: list[dict[str, Any]] = [
    {"id": "GS_1", "lat": 39.9042, "lon": 116.4074, "alt": 0.05}
]
DEFAULT_TRAFFIC_DEMANDS: list[dict[str, Any]] = [
    {"source": "AC_1", "target": "GS_1", "rate_mbps": 25.0},
    {"source": "AC_2", "target": "GS_1", "rate_mbps": 20.0},
    {"source": "AC_3", "target": "GS_1", "rate_mbps": 30.0},
    {"source": "AC_4", "target": "GS_1", "rate_mbps": 18.0},
    {"source": "AC_5", "target": "GS_1", "rate_mbps": 22.0},
]


PLANE_SLOT_PATTERN = re.compile(r"(?:^|[_-])(\d+)[_-](\d+)$")
GEO_NAME_PATTERN = re.compile(r"(?:^|[_-])GEO(?:[_-]?\d+)?$", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a simulation config JSON from a TLE file")
    parser.add_argument("tle_file", help="Path to the input TLE file")
    parser.add_argument("--output", help="Optional output JSON path")
    return parser.parse_args()


def read_tle_names(tle_path: Path) -> list[str]:
    lines = [line.strip() for line in tle_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) % 3 != 0:
        raise ValueError(f"Invalid TLE file: expected groups of 3 lines, got {len(lines)} lines.")
    return [lines[index] for index in range(0, len(lines), 3)]


def parse_plane_slot(name: str) -> tuple[int, int] | None:
    if name.startswith("sat_"):
        parts = name.split("_")
        if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
            return int(parts[1]), int(parts[2])

    match = PLANE_SLOT_PATTERN.search(name)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def is_geo_name(name: str) -> bool:
    return bool(GEO_NAME_PATTERN.search(name))


def build_sat_mapping(names: list[str]) -> dict[str, str]:
    parsed: list[tuple[str, int, int]] = []
    geo_names: list[str] = []
    for name in names:
        if is_geo_name(name):
            geo_names.append(name)
            continue

        plane_slot = parse_plane_slot(name)
        if plane_slot is None:
            raise ValueError(
                "Failed to infer sat_mapping from TLE name "
                f"{name!r}. Expected names like WALKER-1-1, GW2_1_1, SIM_SAT_1_1, sat_1_1, or GW2_GEO."
            )
        plane, slot = plane_slot
        parsed.append((name, plane, slot))

    duplicates = {(plane, slot) for _, plane, slot in parsed if sum(1 for _, p, s in parsed if p == plane and s == slot) > 1}
    if duplicates:
        raise ValueError(f"Duplicate plane/slot identifiers found in TLE names: {sorted(duplicates)}")

    sat_mapping = {
        name: f"sat_{plane}_{slot}"
        for name, plane, slot in sorted(parsed, key=lambda item: (item[1], item[2], item[0]))
    }
    for index, name in enumerate(geo_names, start=1):
        sat_mapping[name] = f"sat_geo_{index}"
    return sat_mapping


def build_output_path(tle_path: Path, raw_output: str | None) -> Path:
    configured_output = raw_output or DEFAULT_OUTPUT_PATH
    if configured_output:
        return Path(configured_output).resolve()
    return tle_path.with_name(f"{tle_path.stem}_config.json")


def build_config(tle_path: Path, sat_mapping: dict[str, str]) -> dict[str, Any]:
    return {
        "start_time": DEFAULT_START_TIME,
        "duration": DEFAULT_DURATION_S,
        "time_step": DEFAULT_TIME_STEP_S,
        "event_sampling_enabled": DEFAULT_EVENT_SAMPLING_ENABLED,
        "event_sampling_min_step": DEFAULT_EVENT_SAMPLING_MIN_STEP_S,
        "tle_file": tle_path.name,
        "sat_mapping": sat_mapping,
        "aircraft_traj": deepcopy(DEFAULT_AIRCRAFT_TRAJECTORIES),
        "ground_stations": deepcopy(DEFAULT_GROUND_STATIONS),
        "sat_antenna_angle": DEFAULT_SAT_ANTENNA_ANGLE_DEG,
        "bw_gsl": DEFAULT_BW_GSL_MBPS,
        "geo_sat_antenna_angle": DEFAULT_GEO_SAT_ANTENNA_ANGLE_DEG,
        "bw_geo_gsl": DEFAULT_BW_GEO_GSL_MBPS,
        "bw_isl": DEFAULT_BW_ISL_MBPS,
        "geo_isl_max_distance_km": DEFAULT_GEO_ISL_MAX_DISTANCE_KM,
        "geo_isl_neighbor_count": DEFAULT_GEO_ISL_NEIGHBOR_COUNT,
        "isl_mode": DEFAULT_ISL_MODE,
        "isl_max_distance_km": DEFAULT_ISL_MAX_DISTANCE_KM,
        "isl_global_neighbor_count": DEFAULT_ISL_GLOBAL_NEIGHBOR_COUNT,
        "isl_same_plane_neighbor_count": DEFAULT_ISL_SAME_PLANE_NEIGHBOR_COUNT,
        "isl_adjacent_plane_neighbor_count": DEFAULT_ISL_ADJACENT_PLANE_NEIGHBOR_COUNT,
        "isl_require_los": DEFAULT_ISL_REQUIRE_LOS,
        "isl_cross_plane_high_latitude_limit_deg": DEFAULT_ISL_CROSS_PLANE_HIGH_LATITUDE_LIMIT_DEG,
        "isl_block_seam_cross_plane": DEFAULT_ISL_BLOCK_SEAM_CROSS_PLANE,
        "routing_switching_cost_km": DEFAULT_ROUTING_SWITCHING_COST_KM,
        "rain_fade_intensity": DEFAULT_RAIN_FADE_INTENSITY,
        "packet_size_bits": DEFAULT_PACKET_SIZE_BITS,
        "signal_speed_km_s": DEFAULT_SIGNAL_SPEED_KM_S,
        "endpoint_processing_delay_ms": DEFAULT_ENDPOINT_PROCESSING_DELAY_MS,
        "satellite_processing_delay_ms": DEFAULT_SATELLITE_PROCESSING_DELAY_MS,
        "gsl_access_delay_ms": DEFAULT_GSL_ACCESS_DELAY_MS,
        "isl_processing_delay_ms": DEFAULT_ISL_PROCESSING_DELAY_MS,
        "aircraft_satellite_handover_duration_s": DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_DURATION_S,
        "aircraft_satellite_handover_extra_latency_ms": DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_EXTRA_LATENCY_MS,
        "aircraft_satellite_handover_extra_loss_rate": DEFAULT_AIRCRAFT_SATELLITE_HANDOVER_EXTRA_LOSS_RATE,
        "ground_station_satellite_handover_duration_s": DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_DURATION_S,
        "ground_station_satellite_handover_extra_latency_ms": DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_EXTRA_LATENCY_MS,
        "ground_station_satellite_handover_extra_loss_rate": DEFAULT_GROUND_STATION_SATELLITE_HANDOVER_EXTRA_LOSS_RATE,
        "traffic_demands": deepcopy(DEFAULT_TRAFFIC_DEMANDS),
    }


def main() -> None:
    args = parse_args()
    tle_path = Path(args.tle_file).resolve()
    if not tle_path.exists():
        raise FileNotFoundError(f"TLE file not found: {tle_path}")

    tle_names = read_tle_names(tle_path)
    sat_mapping = build_sat_mapping(tle_names)
    output_path = build_output_path(tle_path, args.output)
    config = build_config(tle_path, sat_mapping)

    output_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote config to {output_path}")
    print(f"Mapped {len(sat_mapping)} satellites from {tle_path.name}")


if __name__ == "__main__":
    main()
