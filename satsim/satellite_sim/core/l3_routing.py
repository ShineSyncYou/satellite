from __future__ import annotations

import logging
import re
from typing import Iterable

import networkx as nx
import numpy as np

from ..models import Edge, Node, RoutePlan, TrafficDemand

LOGGER = logging.getLogger(__name__)
SAT_ID_PATTERN = re.compile(r"^sat_(\d+)_(\d+)$")
GEO_SAT_ID_PATTERN = re.compile(r"^sat_geo_\d+$")
EARTH_RADIUS_KM = 6378.137
MAX_GEO_ISL_NEIGHBORS = 2


def is_geo_satellite_id(sat_id: str) -> bool:
    return bool(GEO_SAT_ID_PATTERN.match(sat_id))


def parse_sat_id(sat_id: str) -> tuple[int, int] | None:
    if is_geo_satellite_id(sat_id):
        return None
    match = SAT_ID_PATTERN.match(sat_id)
    if match is None:
        LOGGER.warning("Skipping invalid satellite id: %s", sat_id)
        return None
    return int(match.group(1)), int(match.group(2))


def _edge_distance(node_lookup: dict[str, Node], source: str, target: str) -> float:
    source_node = node_lookup[source]
    target_node = node_lookup[target]
    return float(np.linalg.norm(source_node.ecef - target_node.ecef))


def _has_line_of_sight(source_ecef: np.ndarray, target_ecef: np.ndarray) -> bool:
    segment = target_ecef - source_ecef
    denom = float(np.dot(segment, segment))
    if denom <= 0.0:
        return False

    t = -float(np.dot(source_ecef, segment)) / denom
    t = min(1.0, max(0.0, t))
    closest = source_ecef + (t * segment)
    return float(np.linalg.norm(closest)) > EARTH_RADIUS_KM


class RoutingEngine:
    def __init__(
        self,
        satellite_ids: Iterable[str],
        bw_isl: float,
        isl_mode: str = "static-grid",
        isl_max_distance_km: float | None = None,
        isl_global_neighbor_count: int = 4,
        isl_same_plane_neighbor_count: int = 2,
        isl_adjacent_plane_neighbor_count: int = 1,
        geo_isl_max_distance_km: float | None = None,
        geo_isl_neighbor_count: int = MAX_GEO_ISL_NEIGHBORS,
        isl_require_los: bool = True,
        isl_cross_plane_high_latitude_limit_deg: float | None = None,
        isl_block_seam_cross_plane: bool = False,
        routing_switching_cost_km: float = 0.0,
        packet_size_bits: int = 12000,
        signal_speed_km_s: float = 299792.458,
        gsl_access_delay_ms: float = 8.0,
        isl_processing_delay_ms: float = 1.5,
    ) -> None:
        self.bw_isl = bw_isl
        self.satellite_ids = sorted(satellite_ids)
        self.isl_mode = isl_mode
        self.isl_max_distance_km = isl_max_distance_km
        self.isl_global_neighbor_count = max(0, isl_global_neighbor_count)
        self.isl_same_plane_neighbor_count = max(0, isl_same_plane_neighbor_count)
        self.isl_adjacent_plane_neighbor_count = max(0, isl_adjacent_plane_neighbor_count)
        self.geo_isl_max_distance_km = (
            max(0.0, float(geo_isl_max_distance_km))
            if geo_isl_max_distance_km is not None
            else None
        )
        self.geo_isl_neighbor_count = min(
            MAX_GEO_ISL_NEIGHBORS,
            max(0, int(geo_isl_neighbor_count)),
        )
        self.isl_require_los = isl_require_los
        self.isl_cross_plane_high_latitude_limit_deg = (
            abs(float(isl_cross_plane_high_latitude_limit_deg))
            if isl_cross_plane_high_latitude_limit_deg is not None
            else None
        )
        self.isl_block_seam_cross_plane = bool(isl_block_seam_cross_plane)
        self.routing_switching_cost_km = max(0.0, float(routing_switching_cost_km))
        self.packet_size_bits = max(1, int(packet_size_bits))
        self.signal_speed_km_s = max(1.0, float(signal_speed_km_s))
        self.gsl_access_delay_ms = max(0.0, float(gsl_access_delay_ms))
        self.isl_processing_delay_ms = max(0.0, float(isl_processing_delay_ms))
        self.static_isl_pairs = self._build_isl_pairs(self.satellite_ids)
        self.last_satellite_ids: list[str] = []
        self.last_satellite_distance_matrix: np.ndarray | None = None

    def _route_identity(self, demand: TrafficDemand) -> tuple[str, str]:
        return str(demand.source), str(demand.target)

    def _path_edge_keys(self, path: list[str]) -> set[tuple[str, str]]:
        return {
            tuple(sorted((str(path[index]), str(path[index + 1]))))
            for index in range(len(path) - 1)
        }

    def _edge_weight_with_switching_cost(
        self,
        previous_edge_keys: set[tuple[str, str]],
        demand_rate_mbps: float,
    ):
        def _weight(source: str, target: str, attrs: dict[str, object]) -> float:
            distance = float(attrs.get("distance", attrs.get("weight", 0.0)))
            capacity = float(attrs.get("capacity", 0.0))
            if capacity <= 0.0:
                return float("inf")

            reserved_traffic = float(attrs.get("reserved_traffic_mbps", 0.0))
            projected_utilization = (reserved_traffic + max(0.0, demand_rate_mbps)) / capacity
            service_time_ms = self.packet_size_bits / (capacity * 1e6) * 1000.0
            propagation_time_ms = distance / self.signal_speed_km_s * 1000.0
            if projected_utilization >= 1.0:
                queue_time_ms = 1000.0
            else:
                queue_time_ms = service_time_ms * (
                    projected_utilization / max(0.01, 1.0 - projected_utilization)
                )

            edge_type = str(attrs.get("edge_type", ""))
            link_overhead_ms = (
                self.gsl_access_delay_ms
                if edge_type == "GSL"
                else self.isl_processing_delay_ms
            )

            edge_key = tuple(sorted((str(source), str(target))))
            switching_time_ms = 0.0
            if edge_key not in previous_edge_keys:
                switching_time_ms = (
                    self.routing_switching_cost_km
                    / self.signal_speed_km_s
                    * 1000.0
                )

            return (
                propagation_time_ms
                + service_time_ms
                + queue_time_ms
                + link_overhead_ms
                + switching_time_ms
            )

        return _weight

    def _plane_delta(self, source_plane: int, target_plane: int, max_plane: int) -> int:
        direct_delta = abs(source_plane - target_plane)
        return min(direct_delta, max_plane - direct_delta)

    def _is_seam_plane_pair(self, source_plane: int, target_plane: int, max_plane: int) -> bool:
        return {source_plane, target_plane} == {1, max_plane}

    def _allow_cross_plane_link(
        self,
        node_lookup: dict[str, Node],
        source: str,
        target: str,
        source_meta: tuple[int, int] | None,
        target_meta: tuple[int, int] | None,
        max_plane: int,
    ) -> bool:
        if source_meta is None or target_meta is None:
            return False

        source_plane, _ = source_meta
        target_plane, _ = target_meta
        if source_plane == target_plane:
            return True

        if self.isl_block_seam_cross_plane and self._is_seam_plane_pair(source_plane, target_plane, max_plane):
            return False

        if self.isl_cross_plane_high_latitude_limit_deg is not None:
            source_lat = abs(float(node_lookup[source].lat))
            target_lat = abs(float(node_lookup[target].lat))
            if max(source_lat, target_lat) >= self.isl_cross_plane_high_latitude_limit_deg:
                return False

        return True

    def _build_isl_pairs(self, satellite_ids: list[str]) -> list[tuple[str, str]]:
        parsed_ids = [(sat_id, parse_sat_id(sat_id)) for sat_id in satellite_ids]
        valid_ids = [(sat_id, parsed) for sat_id, parsed in parsed_ids if parsed is not None]
        if not valid_ids:
            return []

        max_plane = max(parsed[0] for _, parsed in valid_ids)
        max_slot = max(parsed[1] for _, parsed in valid_ids)
        id_set = set(satellite_ids)
        pairs: set[tuple[str, str]] = set()

        for sat_id, (plane, slot) in valid_ids:
            same_plane_neighbors = [
                f"sat_{plane}_{((slot - 2) % max_slot) + 1}",
                f"sat_{plane}_{(slot % max_slot) + 1}",
            ]
            cross_plane_neighbors = [
                f"sat_{((plane - 2) % max_plane) + 1}_{slot}",
                f"sat_{(plane % max_plane) + 1}_{slot}",
            ]

            for neighbor in same_plane_neighbors + cross_plane_neighbors:
                if neighbor in id_set and neighbor != sat_id:
                    pairs.add(tuple(sorted((sat_id, neighbor))))

        return sorted(pairs)

    def _compute_satellite_geometry(
        self,
        satellites: list[Node],
    ) -> tuple[list[str], np.ndarray, np.ndarray]:
        satellite_ids = [node.id for node in satellites]
        positions = np.vstack([node.ecef for node in satellites])
        diff = positions[:, None, :] - positions[None, :, :]
        distance_matrix = np.linalg.norm(diff, axis=-1)
        np.fill_diagonal(distance_matrix, np.inf)

        if not self.isl_require_los:
            los_matrix = np.ones_like(distance_matrix, dtype=bool)
            np.fill_diagonal(los_matrix, False)
            return satellite_ids, distance_matrix, los_matrix

        start = positions[:, None, :]
        end = positions[None, :, :]
        segment = end - start
        denom = np.sum(segment * segment, axis=-1)
        t = np.divide(-np.sum(start * segment, axis=-1), denom, out=np.zeros_like(denom), where=denom > 0.0)
        t = np.clip(t, 0.0, 1.0)
        closest = start + (t[..., None] * segment)
        clearance = np.linalg.norm(closest, axis=-1)
        los_matrix = clearance > EARTH_RADIUS_KM
        np.fill_diagonal(los_matrix, False)
        return satellite_ids, distance_matrix, los_matrix

    def _select_neighbors(
        self,
        candidate_indices: list[int],
        distance_row: np.ndarray,
        limit: int,
    ) -> list[int]:
        if limit <= 0 or not candidate_indices:
            return []
        ordered = sorted(candidate_indices, key=lambda index: float(distance_row[index]))
        return ordered[:limit]

    def _build_dynamic_isl_edges(self, node_lookup: dict[str, Node]) -> list[Edge]:
        satellites = [node_lookup[sat_id] for sat_id in self.satellite_ids if sat_id in node_lookup]
        if not satellites:
            self.last_satellite_ids = []
            self.last_satellite_distance_matrix = None
            return []

        satellite_ids, distance_matrix, los_matrix = self._compute_satellite_geometry(satellites)
        self.last_satellite_ids = satellite_ids
        self.last_satellite_distance_matrix = distance_matrix.copy()

        parsed_lookup = {sat_id: parse_sat_id(sat_id) for sat_id in satellite_ids}
        valid_planes = sorted({parsed[0] for parsed in parsed_lookup.values() if parsed is not None})
        if not valid_planes:
            return []

        max_plane = max(valid_planes)
        pair_keys: set[tuple[str, str]] = set()

        for row_index, sat_id in enumerate(satellite_ids):
            parsed = parsed_lookup.get(sat_id)
            if parsed is None:
                continue

            plane, _ = parsed
            distance_row = distance_matrix[row_index]
            visibility_mask = los_matrix[row_index].copy()
            if self.isl_max_distance_km is not None:
                visibility_mask &= distance_row <= self.isl_max_distance_km

            same_plane_candidates: list[int] = []
            adjacent_plane_candidates: dict[int, list[int]] = {
                ((plane - 2) % max_plane) + 1: [],
                (plane % max_plane) + 1: [],
            }

            for candidate_index, candidate_id in enumerate(satellite_ids):
                if not visibility_mask[candidate_index]:
                    continue
                candidate_meta = parsed_lookup.get(candidate_id)
                if candidate_meta is None:
                    continue

                if not self._allow_cross_plane_link(node_lookup, sat_id, candidate_id, parsed, candidate_meta, max_plane):
                    continue

                candidate_plane, _ = candidate_meta
                if candidate_plane == plane:
                    same_plane_candidates.append(candidate_index)
                elif candidate_plane in adjacent_plane_candidates:
                    adjacent_plane_candidates[candidate_plane].append(candidate_index)

            chosen_indices = self._select_neighbors(
                same_plane_candidates,
                distance_row,
                self.isl_same_plane_neighbor_count,
            )
            for adjacent_candidates in adjacent_plane_candidates.values():
                chosen_indices.extend(
                    self._select_neighbors(
                        adjacent_candidates,
                        distance_row,
                        self.isl_adjacent_plane_neighbor_count,
                    )
                )

            for candidate_index in chosen_indices:
                source = sat_id
                target = satellite_ids[candidate_index]
                if source == target:
                    continue
                pair_keys.add(tuple(sorted((source, target))))

        id_to_index = {sat_id: index for index, sat_id in enumerate(satellite_ids)}
        edges: list[Edge] = []
        for source, target in sorted(pair_keys):
            source_index = id_to_index[source]
            target_index = id_to_index[target]
            edges.append(
                Edge(
                    source=source,
                    target=target,
                    edge_type="ISL",
                    distance=float(distance_matrix[source_index, target_index]),
                    capacity=self.bw_isl,
                )
            )
        return edges

    def _build_global_isl_edges(self, node_lookup: dict[str, Node]) -> list[Edge]:
        satellites = [node_lookup[sat_id] for sat_id in self.satellite_ids if sat_id in node_lookup]
        if not satellites:
            self.last_satellite_ids = []
            self.last_satellite_distance_matrix = None
            return []

        satellite_ids, distance_matrix, los_matrix = self._compute_satellite_geometry(satellites)
        self.last_satellite_ids = satellite_ids
        self.last_satellite_distance_matrix = distance_matrix.copy()
        parsed_lookup = {sat_id: parse_sat_id(sat_id) for sat_id in satellite_ids}
        valid_planes = sorted({parsed[0] for parsed in parsed_lookup.values() if parsed is not None})
        if not valid_planes:
            return []

        max_plane = max(valid_planes)
        pair_keys: set[tuple[str, str]] = set()

        for row_index, sat_id in enumerate(satellite_ids):
            distance_row = distance_matrix[row_index]
            visibility_mask = los_matrix[row_index].copy()
            if self.isl_max_distance_km is not None:
                visibility_mask &= distance_row <= self.isl_max_distance_km

            candidate_indices = [
                candidate_index
                for candidate_index in range(len(satellite_ids))
                if visibility_mask[candidate_index]
                and self._allow_cross_plane_link(
                    node_lookup,
                    sat_id,
                    satellite_ids[candidate_index],
                    parsed_lookup.get(sat_id),
                    parsed_lookup.get(satellite_ids[candidate_index]),
                    max_plane,
                )
            ]
            chosen_indices = self._select_neighbors(
                candidate_indices,
                distance_row,
                self.isl_global_neighbor_count,
            )

            for candidate_index in chosen_indices:
                source = sat_id
                target = satellite_ids[candidate_index]
                if source == target:
                    continue
                pair_keys.add(tuple(sorted((source, target))))

        id_to_index = {sat_id: index for index, sat_id in enumerate(satellite_ids)}
        edges: list[Edge] = []
        for source, target in sorted(pair_keys):
            source_index = id_to_index[source]
            target_index = id_to_index[target]
            edges.append(
                Edge(
                    source=source,
                    target=target,
                    edge_type="ISL",
                    distance=float(distance_matrix[source_index, target_index]),
                    capacity=self.bw_isl,
                )
            )
        return edges

    def _build_static_isl_edges(self, node_lookup: dict[str, Node]) -> list[Edge]:
        parsed_lookup = {sat_id: parse_sat_id(sat_id) for sat_id in self.satellite_ids}
        valid_planes = sorted({parsed[0] for parsed in parsed_lookup.values() if parsed is not None})
        max_plane = max(valid_planes) if valid_planes else 0
        frame_isl_edges: list[Edge] = []
        for source, target in self.static_isl_pairs:
            if source not in node_lookup or target not in node_lookup:
                continue
            if max_plane > 0 and not self._allow_cross_plane_link(
                node_lookup,
                source,
                target,
                parsed_lookup.get(source),
                parsed_lookup.get(target),
                max_plane,
            ):
                continue
            distance = _edge_distance(node_lookup, source, target)
            if self.isl_max_distance_km is not None and distance > self.isl_max_distance_km:
                continue
            if self.isl_require_los and not _has_line_of_sight(
                node_lookup[source].ecef,
                node_lookup[target].ecef,
            ):
                continue
            frame_isl_edges.append(
                Edge(
                    source=source,
                    target=target,
                    edge_type="ISL",
                    distance=distance,
                    capacity=self.bw_isl,
                )
            )
        self.last_satellite_ids = []
        self.last_satellite_distance_matrix = None
        return frame_isl_edges

    def _build_geo_isl_edges(self, node_lookup: dict[str, Node]) -> list[Edge]:
        geo_satellite_ids = sorted(
            sat_id
            for sat_id in self.satellite_ids
            if is_geo_satellite_id(sat_id) and sat_id in node_lookup
        )
        if len(geo_satellite_ids) < 2 or self.geo_isl_neighbor_count <= 0:
            return []

        candidate_pairs: list[tuple[float, str, str]] = []
        for source_index, source in enumerate(geo_satellite_ids):
            for target in geo_satellite_ids[source_index + 1:]:
                source_node = node_lookup[source]
                target_node = node_lookup[target]
                if self.isl_require_los and not _has_line_of_sight(source_node.ecef, target_node.ecef):
                    continue

                distance = _edge_distance(node_lookup, source, target)
                if (
                    self.geo_isl_max_distance_km is not None
                    and distance > self.geo_isl_max_distance_km
                ):
                    continue
                candidate_pairs.append(
                    (
                        distance,
                        source,
                        target,
                    )
                )

        neighbor_counts = {sat_id: 0 for sat_id in geo_satellite_ids}
        edges: list[Edge] = []
        for distance, source, target in sorted(candidate_pairs):
            if neighbor_counts[source] >= self.geo_isl_neighbor_count:
                continue
            if neighbor_counts[target] >= self.geo_isl_neighbor_count:
                continue

            neighbor_counts[source] += 1
            neighbor_counts[target] += 1
            edges.append(
                Edge(
                    source=source,
                    target=target,
                    edge_type="ISL",
                    distance=distance,
                    capacity=self.bw_isl,
                )
            )

        return edges

    def _build_frame_graph(self, frame_isl_edges: list[Edge], gsl_edges: list[Edge]) -> nx.Graph:
        graph = nx.Graph()
        graph.add_nodes_from(self.satellite_ids)
        for edge in [*frame_isl_edges, *gsl_edges]:
            graph.add_edge(
                edge.source,
                edge.target,
                edge_type=edge.edge_type,
                capacity=edge.capacity,
                distance=edge.distance,
                weight=edge.distance,
                reserved_traffic_mbps=0.0,
            )
        return graph

    def compute(
        self,
        nodes: list[Node],
        gsl_edges: list[Edge],
        demands: list[TrafficDemand],
        previous_route_paths: dict[tuple[str, str], list[str]] | None = None,
    ) -> tuple[list[RoutePlan], list[Edge]]:
        node_lookup = {node.id: node for node in nodes}
        if self.isl_mode == "global-nearest":
            frame_isl_edges = self._build_global_isl_edges(node_lookup)
        elif self.isl_mode == "dynamic-nearest":
            frame_isl_edges = self._build_dynamic_isl_edges(node_lookup)
        else:
            frame_isl_edges = self._build_static_isl_edges(node_lookup)
        frame_isl_edges.extend(self._build_geo_isl_edges(node_lookup))

        graph = self._build_frame_graph(frame_isl_edges, gsl_edges)

        routes: list[RoutePlan] = []
        previous_route_paths = previous_route_paths or {}
        for demand in demands:
            try:
                previous_path = list(previous_route_paths.get(self._route_identity(demand), []))
                previous_edge_keys = self._path_edge_keys(previous_path)
                path = nx.shortest_path(
                    graph,
                    demand.source,
                    demand.target,
                    weight=self._edge_weight_with_switching_cost(
                        previous_edge_keys,
                        demand.rate_mbps,
                    ),
                )
                for source, target in zip(path, path[1:]):
                    graph[source][target]["reserved_traffic_mbps"] += demand.rate_mbps
                routes.append(
                    RoutePlan(
                        source=demand.source,
                        target=demand.target,
                        rate_mbps=demand.rate_mbps,
                        path=list(path),
                        connected=True,
                    )
                )
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                routes.append(
                    RoutePlan(
                        source=demand.source,
                        target=demand.target,
                        rate_mbps=demand.rate_mbps,
                        path=[],
                        connected=False,
                    )
                )

        return routes, frame_isl_edges
