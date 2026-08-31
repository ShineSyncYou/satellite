from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import PreparedSimulationAssets, SimulationConfig, load_simulation_config, prepare_simulation_assets
from .core import AccessLayer, PerformanceLayer, PhysicalSpaceEngine, RoutingEngine
from .core.handover_penalty import AccessHandoverPenaltyTracker, HandoverPenaltyPolicy

SCHEMA_VERSION = "1.4.0"


def _normalize_relative_time(value: float) -> int | float:
    rounded = round(float(value), 6)
    if abs(rounded - round(rounded)) < 1e-9:
        return int(round(rounded))
    return rounded


def _snapshot_signature(snapshot: dict[str, Any]) -> tuple[Any, Any]:
    edge_signature = tuple(
        sorted(
            (
                str(edge["type"]),
                min(str(edge["source"]), str(edge["target"])),
                max(str(edge["source"]), str(edge["target"])),
            )
            for edge in snapshot["edges"]
        )
    )
    metric_signature = tuple(
        (
            str(metric["source"]),
            str(metric["target"]),
            tuple(str(node_id) for node_id in metric.get("path", [])),
        )
        for metric in snapshot["end_to_end_metrics"]
    )
    return edge_signature, metric_signature


def _isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _round_float(value: Any, digits: int = 12) -> float:
    return round(float(value), digits)


def _link_identity(link: dict[str, Any]) -> tuple[str, str, str]:
    return str(link["source"]), str(link["target"]), str(link["type"])


def _link_state(link: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": str(link["source"]),
        "target": str(link["target"]),
        "type": str(link["type"]),
        "distance_km": _round_float(link.get("distance_km", 0.0), 6),
        "bandwidth_mbps": _round_float(link.get("bandwidth_mbps", 0.0), 6),
        "tx_rate_mbps": _round_float(link.get("tx_rate_mbps", 0.0), 6),
        "utilization": _round_float(link.get("utilization", 0.0), 12),
        "color": str(link.get("color", "")),
    }


def _link_state_signature(link: dict[str, Any]) -> tuple[Any, ...]:
    return (
        _round_float(link.get("bandwidth_mbps", 0.0), 6),
        _round_float(link.get("tx_rate_mbps", 0.0), 6),
        _round_float(link.get("utilization", 0.0), 12),
        str(link.get("color", "")),
    )


def _route_identity(route: dict[str, Any]) -> tuple[str, str]:
    return str(route["source"]), str(route["target"])


def _route_state(route: dict[str, Any]) -> dict[str, Any]:
    path = [str(node_id) for node_id in route.get("path", [])]
    connected = bool(route.get("connected", path))
    transient = route.get("transient") or {}
    return {
        "source": str(route["source"]),
        "target": str(route["target"]),
        "connected": connected,
        "path": path,
        "hop_count": int(route.get("hop_count", max(0, len(path) - 1))),
        "steady_latency_ms": _round_float(route.get("steady_latency_ms", route.get("latency_ms", -1.0)), 6),
        "steady_packet_loss_rate": _round_float(route.get("steady_packet_loss_rate", route.get("packet_loss_rate", 1.0)), 12),
        "steady_ber": _round_float(route.get("steady_ber", route.get("ber", 1.0)), 12),
        "requested_bandwidth_mbps": _round_float(route.get("requested_bandwidth_mbps", 0.0), 6),
        "actual_tx_bandwidth_mbps": _round_float(route.get("actual_tx_bandwidth_mbps", 0.0), 6),
        "dropped_bandwidth_mbps": _round_float(route.get("dropped_bandwidth_mbps", 0.0), 6),
        "effective_bandwidth_mbps": _round_float(route.get("effective_bandwidth_mbps", 0.0), 6),
        "latency_ms": _round_float(route.get("latency_ms", -1.0), 6),
        "packet_loss_rate": _round_float(route.get("packet_loss_rate", 1.0), 12),
        "ber": _round_float(route.get("ber", 1.0), 12),
        "transient": {
            "active": bool(transient.get("active", False)),
            "causes": [str(cause) for cause in transient.get("causes", [])],
            "extra_latency_ms": _round_float(transient.get("extra_latency_ms", 0.0), 6),
            "extra_packet_loss_rate": _round_float(transient.get("extra_packet_loss_rate", 0.0), 12),
            "remaining_s": _round_float(transient.get("remaining_s", 0.0), 6),
        },
    }


def _route_state_signature(route: dict[str, Any]) -> tuple[Any, ...]:
    transient = route.get("transient") or {}
    return (
        bool(route["connected"]),
        tuple(route["path"]),
        _round_float(route.get("requested_bandwidth_mbps", 0.0), 6),
        _round_float(route.get("actual_tx_bandwidth_mbps", 0.0), 6),
        _round_float(route.get("dropped_bandwidth_mbps", 0.0), 6),
        _round_float(route.get("effective_bandwidth_mbps", 0.0), 6),
        _round_float(route.get("latency_ms", -1.0), 6),
        _round_float(route.get("packet_loss_rate", 1.0), 12),
        _round_float(route.get("ber", 1.0), 12),
        bool(transient.get("active", False)),
        tuple(str(cause) for cause in transient.get("causes", [])),
        _round_float(transient.get("extra_latency_ms", 0.0), 6),
        _round_float(transient.get("extra_packet_loss_rate", 0.0), 12),
    )


def _route_has_active_transient(route: dict[str, Any] | None) -> bool:
    if not route:
        return False
    transient = route.get("transient") or {}
    return bool(transient.get("active", False))


def _route_event_reason(
    changed_routes: list[dict[str, Any]],
    previous_routes: dict[tuple[str, str], dict[str, Any]],
) -> str:
    saw_path_change = False
    saw_metric_change = False
    for route in changed_routes:
        previous_route = previous_routes.get(_route_identity(route))
        previous_active = _route_has_active_transient(previous_route)
        current_active = _route_has_active_transient(route)
        if previous_active != current_active:
            return "access_handover_penalty"
        if current_active or previous_active:
            return "access_handover_penalty"
        if previous_route is None or tuple(previous_route.get("path", [])) != tuple(route.get("path", [])):
            saw_path_change = True
        else:
            saw_metric_change = True
    if saw_path_change:
        return "route_change"
    if saw_metric_change:
        return "route_metric_change"
    return "route_change"


def _build_penalty_model_metadata(config: SimulationConfig) -> dict[str, Any]:
    return {
        "enabled": any(
            value > 0.0
            for value in [
                config.aircraft_satellite_handover_duration_s,
                config.aircraft_satellite_handover_extra_latency_ms,
                config.aircraft_satellite_handover_extra_loss_rate,
                config.ground_station_satellite_handover_duration_s,
                config.ground_station_satellite_handover_extra_latency_ms,
                config.ground_station_satellite_handover_extra_loss_rate,
            ]
        ),
        "aircraft_satellite_handover": {
            "duration_s": _round_float(config.aircraft_satellite_handover_duration_s, 6),
            "extra_latency_ms": _round_float(config.aircraft_satellite_handover_extra_latency_ms, 6),
            "extra_packet_loss_rate": _round_float(config.aircraft_satellite_handover_extra_loss_rate, 12),
        },
        "ground_station_satellite_handover": {
            "duration_s": _round_float(config.ground_station_satellite_handover_duration_s, 6),
            "extra_latency_ms": _round_float(config.ground_station_satellite_handover_extra_latency_ms, 6),
            "extra_packet_loss_rate": _round_float(config.ground_station_satellite_handover_extra_loss_rate, 12),
        },
    }


def _build_metadata(config: SimulationConfig, assets: PreparedSimulationAssets) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "output_mode": "bundle",
        "generated_at": _isoformat_utc(datetime.now(timezone.utc)),
        "start_time": _isoformat_utc(config.start_time),
        "duration_s": config.duration,
        "base_time_step_s": config.time_step,
        "event_sampling_enabled": config.event_sampling_enabled,
        "event_sampling_min_step_s": (config.event_sampling_min_step if config.event_sampling_enabled else None),
        "penalty_model": _build_penalty_model_metadata(config),
        "beam": {
            "sat_antenna_angle_deg": _round_float(config.sat_antenna_angle, 6),
            "geo_sat_antenna_angle_deg": _round_float(
                config.geo_sat_antenna_angle
                if config.geo_sat_antenna_angle is not None
                else config.sat_antenna_angle,
                6,
            ),
        },
        "constellation": {
            "tle_file": config.tle_file.name,
            "isl_mode": config.isl_mode,
            "satellite_count": len(assets.satellites),
            "aircraft_count": len(assets.aircraft_traj_funcs),
            "ground_station_count": len(assets.ground_stations),
        },
        "units": {
            "relative_time_s": "s",
            "lat_deg": "deg",
            "lon_deg": "deg",
            "alt_km": "km",
            "distance_km": "km",
            "bandwidth_mbps": "Mbps",
            "tx_rate_mbps": "Mbps",
            "requested_bandwidth_mbps": "Mbps",
            "actual_tx_bandwidth_mbps": "Mbps",
            "dropped_bandwidth_mbps": "Mbps",
            "effective_bandwidth_mbps": "Mbps",
            "utilization": "ratio",
            "latency_ms": "ms",
            "packet_loss_rate": "ratio",
            "ber": "ratio",
        },
    }


def _build_node_tracks(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    regular_snapshots = [snapshot for snapshot in snapshots if snapshot.get("sample_type") == "regular"]
    source_snapshots = regular_snapshots or snapshots
    tracks_by_id: dict[str, dict[str, Any]] = {}

    for snapshot in source_snapshots:
        relative_time_s = snapshot["relative_time_s"]
        for node in snapshot["nodes"]:
            node_id = str(node["id"])
            track = tracks_by_id.setdefault(
                node_id,
                {
                    "id": node_id,
                    "type": str(node["type"]),
                    "samples": [],
                },
            )
            track["samples"].append(
                {
                    "relative_time_s": relative_time_s,
                    "lat_deg": _round_float(node["lat"], 6),
                    "lon_deg": _round_float(node["lon"], 6),
                    "alt_km": _round_float(node["alt"], 6),
                }
            )

    return [tracks_by_id[node_id] for node_id in sorted(tracks_by_id)]


def _build_topology_events(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    previous_signatures: dict[tuple[str, str, str], tuple[Any, ...]] = {}
    previous_keys: set[tuple[str, str, str]] = set()

    for index, snapshot in enumerate(snapshots):
        current_links = {_link_identity(link): _link_state(link) for link in snapshot["edges"]}
        current_keys = set(current_links)
        current_signatures = {
            link_id: _link_state_signature(link_state)
            for link_id, link_state in current_links.items()
        }

        if index == 0:
            events.append(
                {
                    "relative_time_s": snapshot["relative_time_s"],
                    "event_kind": "snapshot",
                    "reason": "initial_snapshot",
                    "links_upsert": [current_links[link_id] for link_id in sorted(current_links)],
                    "links_remove": [],
                }
            )
        else:
            links_upsert = [
                current_links[link_id]
                for link_id in sorted(current_links)
                if previous_signatures.get(link_id) != current_signatures[link_id]
            ]
            removed_keys = sorted(previous_keys - current_keys)
            if links_upsert or removed_keys:
                event_reason = "topology_change" if removed_keys or (current_keys != previous_keys) else "link_state_change"
                events.append(
                    {
                        "relative_time_s": snapshot["relative_time_s"],
                        "event_kind": "delta",
                        "reason": event_reason,
                        "links_upsert": links_upsert,
                        "links_remove": [
                            {
                                "source": source,
                                "target": target,
                                "type": edge_type,
                            }
                            for source, target, edge_type in removed_keys
                        ],
                    }
                )

        previous_signatures = current_signatures
        previous_keys = current_keys

    return events


def _build_route_events(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    previous_signatures: dict[tuple[str, str], tuple[Any, ...]] = {}
    previous_routes: dict[tuple[str, str], dict[str, Any]] = {}

    for index, snapshot in enumerate(snapshots):
        current_routes = {_route_identity(route): _route_state(route) for route in snapshot["end_to_end_metrics"]}
        current_signatures = {
            route_id: _route_state_signature(route_state)
            for route_id, route_state in current_routes.items()
        }

        if index == 0:
            events.append(
                {
                    "relative_time_s": snapshot["relative_time_s"],
                    "event_kind": "snapshot",
                    "reason": "initial_snapshot",
                    "routes": [current_routes[route_id] for route_id in sorted(current_routes)],
                }
            )
        else:
            changed_routes = [
                current_routes[route_id]
                for route_id in sorted(current_routes)
                if previous_signatures.get(route_id) != current_signatures[route_id]
            ]
            if changed_routes:
                events.append(
                    {
                        "relative_time_s": snapshot["relative_time_s"],
                        "event_kind": "delta",
                        "reason": _route_event_reason(changed_routes, previous_routes),
                        "routes": changed_routes,
                    }
                )

        previous_signatures = current_signatures
        previous_routes = current_routes

    return events


def _build_output_bundle(
    config: SimulationConfig,
    assets: PreparedSimulationAssets,
    snapshots: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "metadata": _build_metadata(config, assets),
        "node_tracks": _build_node_tracks(snapshots),
        "topology_events": _build_topology_events(snapshots),
        "route_events": _build_route_events(snapshots),
    }


def _build_snapshot(
    t: float,
    l1_space: PhysicalSpaceEngine,
    l2_access: AccessLayer,
    l3_routing: RoutingEngine,
    l4_performance: PerformanceLayer,
    config: SimulationConfig,
    sample_type: str,
    previous_route_paths: dict[tuple[str, str], list[str]] | None = None,
) -> dict[str, Any]:
    nodes = l1_space.compute(t)
    gsl_edges = l2_access.compute(nodes, config.traffic_demands)
    routes, isl_edges = l3_routing.compute(
        nodes,
        gsl_edges,
        config.traffic_demands,
        previous_route_paths=previous_route_paths,
    )
    final_edges, metrics = l4_performance.compute(routes, gsl_edges, isl_edges, nodes)
    return {
        "relative_time_s": _normalize_relative_time(t),
        "sample_type": sample_type,
        "nodes": [node.to_dict() for node in nodes],
        "edges": [edge.to_dict() for edge in final_edges],
        "end_to_end_metrics": [metric.to_dict() for metric in metrics],
    }


def _build_handover_penalty_tracker(config: SimulationConfig) -> AccessHandoverPenaltyTracker:
    return AccessHandoverPenaltyTracker(
        aircraft_policy=HandoverPenaltyPolicy(
            duration_s=max(0.0, config.aircraft_satellite_handover_duration_s),
            extra_latency_ms=max(0.0, config.aircraft_satellite_handover_extra_latency_ms),
            extra_packet_loss_rate=min(max(0.0, config.aircraft_satellite_handover_extra_loss_rate), 1.0),
            cause="aircraft_satellite_handover",
        ),
        ground_station_policy=HandoverPenaltyPolicy(
            duration_s=max(0.0, config.ground_station_satellite_handover_duration_s),
            extra_latency_ms=max(0.0, config.ground_station_satellite_handover_extra_latency_ms),
            extra_packet_loss_rate=min(max(0.0, config.ground_station_satellite_handover_extra_loss_rate), 1.0),
            cause="ground_station_satellite_handover",
        ),
    )


def _apply_access_handover_penalties(
    snapshots: list[dict[str, Any]],
    get_snapshot: Any,
    config: SimulationConfig,
) -> list[dict[str, Any]]:
    if not snapshots:
        return snapshots

    ordered_snapshots = sorted(snapshots, key=lambda item: float(item["relative_time_s"]))
    existing_times = {round(float(snapshot["relative_time_s"]), 6) for snapshot in ordered_snapshots}
    tracker = _build_handover_penalty_tracker(config)
    boundary_times: set[float] = set()

    for snapshot in ordered_snapshots:
        for boundary_time in tracker.apply_to_snapshot(snapshot):
            if 0.0 < boundary_time < float(config.duration) and boundary_time not in existing_times:
                boundary_times.add(boundary_time)

    if boundary_times:
        for boundary_time in sorted(boundary_times):
            previous_snapshot = next(
                snapshot
                for snapshot in reversed(ordered_snapshots)
                if float(snapshot["relative_time_s"]) < float(boundary_time)
            )
            extra_snapshot, _, _ = get_snapshot(
                float(boundary_time),
                "event",
                _snapshot_route_paths(previous_snapshot),
            )
            ordered_snapshots.append(extra_snapshot)
        ordered_snapshots.sort(key=lambda item: float(item["relative_time_s"]))

    tracker = _build_handover_penalty_tracker(config)
    for snapshot in ordered_snapshots:
        tracker.apply_to_snapshot(snapshot)

    return ordered_snapshots


def _snapshot_route_paths(snapshot: dict[str, Any]) -> dict[tuple[str, str], list[str]]:
    return {
        (str(metric["source"]), str(metric["target"])): [str(node_id) for node_id in metric.get("path", [])]
        for metric in snapshot["end_to_end_metrics"]
    }


def _collect_snapshots(config: SimulationConfig, assets: PreparedSimulationAssets) -> list[dict[str, Any]]:
    l1_space = PhysicalSpaceEngine(
        start_time=config.start_time,
        satellites=assets.satellites,
        aircraft_traj_funcs=assets.aircraft_traj_funcs,
        ground_stations=assets.ground_stations,
    )
    l2_access = AccessLayer(
        config.sat_antenna_angle,
        config.bw_gsl,
        geo_sat_antenna_angle=config.geo_sat_antenna_angle,
        bw_geo_gsl=config.bw_geo_gsl,
    )
    l3_routing = RoutingEngine(
        satellite_ids=assets.satellites.keys(),
        bw_isl=config.bw_isl,
        isl_mode=config.isl_mode,
        isl_max_distance_km=config.isl_max_distance_km,
        isl_global_neighbor_count=config.isl_global_neighbor_count,
        isl_same_plane_neighbor_count=config.isl_same_plane_neighbor_count,
        isl_adjacent_plane_neighbor_count=config.isl_adjacent_plane_neighbor_count,
        geo_isl_max_distance_km=config.geo_isl_max_distance_km,
        geo_isl_neighbor_count=config.geo_isl_neighbor_count,
        isl_require_los=config.isl_require_los,
        isl_cross_plane_high_latitude_limit_deg=config.isl_cross_plane_high_latitude_limit_deg,
        isl_block_seam_cross_plane=config.isl_block_seam_cross_plane,
        routing_switching_cost_km=config.routing_switching_cost_km,
        packet_size_bits=config.packet_size_bits,
        signal_speed_km_s=config.signal_speed_km_s,
        gsl_access_delay_ms=config.gsl_access_delay_ms,
        isl_processing_delay_ms=config.isl_processing_delay_ms,
    )
    l4_performance = PerformanceLayer(
        config.rain_fade_intensity,
        config.packet_size_bits,
        signal_speed_km_s=config.signal_speed_km_s,
        endpoint_processing_delay_ms=config.endpoint_processing_delay_ms,
        satellite_processing_delay_ms=config.satellite_processing_delay_ms,
        gsl_access_delay_ms=config.gsl_access_delay_ms,
        isl_processing_delay_ms=config.isl_processing_delay_ms,
    )

    def get_snapshot(
        t: float,
        sample_type: str,
        previous_route_paths: dict[tuple[str, str], list[str]],
    ) -> tuple[dict[str, Any], tuple[Any, Any], dict[tuple[str, str], list[str]]]:
        snapshot = _build_snapshot(
            t=float(round(float(t), 6)),
            l1_space=l1_space,
            l2_access=l2_access,
            l3_routing=l3_routing,
            l4_performance=l4_performance,
            config=config,
            sample_type=sample_type,
            previous_route_paths=previous_route_paths,
        )
        return snapshot, _snapshot_signature(snapshot), _snapshot_route_paths(snapshot)

    def refine_interval(
        start_t: float,
        start_signature: tuple[Any, Any],
        start_route_paths: dict[tuple[str, str], list[str]],
        end_t: float,
        end_sample_type: str,
    ) -> tuple[list[dict[str, Any]], tuple[Any, Any], dict[tuple[str, str], list[str]]]:
        end_snapshot, end_signature, end_route_paths = get_snapshot(end_t, end_sample_type, start_route_paths)
        if not config.event_sampling_enabled or start_signature == end_signature:
            return [end_snapshot], end_signature, end_route_paths

        interval = float(end_t - start_t)
        if interval <= max(config.event_sampling_min_step, 1e-3):
            return [end_snapshot], end_signature, end_route_paths

        mid_t = round((start_t + end_t) / 2.0, 6)
        if mid_t <= start_t or mid_t >= end_t:
            return [end_snapshot], end_signature, end_route_paths

        mid_snapshot, mid_signature, mid_route_paths = get_snapshot(mid_t, "event", start_route_paths)
        results: list[dict[str, Any]] = []

        if mid_signature != start_signature:
            left_results, mid_signature, mid_route_paths = refine_interval(
                start_t,
                start_signature,
                start_route_paths,
                mid_t,
                "event",
            )
            results.extend(left_results)
        else:
            mid_route_paths = _snapshot_route_paths(mid_snapshot)

        right_results, end_signature, end_route_paths = refine_interval(
            mid_t,
            mid_signature,
            mid_route_paths,
            end_t,
            end_sample_type,
        )
        results.extend(right_results)
        return results, end_signature, end_route_paths

    snapshots: list[dict[str, Any]] = []
    base_times = [float(t) for t in range(0, config.duration + 1, config.time_step)]
    if not base_times:
        return snapshots

    previous_time = base_times[0]
    previous_snapshot, previous_signature, previous_route_paths = get_snapshot(previous_time, "regular", {})
    snapshots.append(previous_snapshot)

    for current_time in base_times[1:]:
        refined_snapshots, current_signature, current_route_paths = refine_interval(
            previous_time,
            previous_signature,
            previous_route_paths,
            current_time,
            "regular",
        )
        snapshots.extend(refined_snapshots)
        previous_time = current_time
        previous_signature = current_signature
        previous_route_paths = current_route_paths

    return _apply_access_handover_penalties(snapshots, get_snapshot, config)


def run_simulation(config: SimulationConfig, assets: PreparedSimulationAssets) -> dict[str, Any]:
    snapshots = _collect_snapshots(config, assets)
    return _build_output_bundle(config, assets, snapshots)


def save_json(data: dict[str, Any], output_path: str | Path) -> None:
    path = Path(output_path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Satellite constellation communication simulation backend")
    parser.add_argument("--config", required=True, help="Path to the simulation configuration JSON file")
    parser.add_argument("--output", default="simulation_results.json", help="Output JSON path")
    return parser


def main() -> None:
    parser = build_argument_parser()
    args = parser.parse_args()
    config = load_simulation_config(args.config)
    assets = prepare_simulation_assets(config)
    output_bundle = run_simulation(config, assets)
    save_json(output_bundle, args.output)


if __name__ == "__main__":
    main()
