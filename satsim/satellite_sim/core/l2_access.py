from __future__ import annotations

from typing import Sequence

import numpy as np

from ..models import Edge, Node, TrafficDemand
from ..utils.math_utils import angle_between_deg, distances_from, elevation_angles_deg


def is_geo_satellite_id(satellite_id: str) -> bool:
    return satellite_id.startswith("sat_geo_")


class AccessLayer:
    def __init__(
        self,
        sat_antenna_angle: float,
        bw_gsl: float,
        geo_sat_antenna_angle: float | None = None,
        bw_geo_gsl: float | None = None,
    ) -> None:
        self.sat_antenna_angle = sat_antenna_angle
        self.bw_gsl = bw_gsl
        self.geo_sat_antenna_angle = geo_sat_antenna_angle if geo_sat_antenna_angle is not None else sat_antenna_angle
        self.bw_geo_gsl = bw_geo_gsl if bw_geo_gsl is not None else bw_gsl

    def _satellite_antenna_angle(self, satellite_id: str) -> float:
        if is_geo_satellite_id(satellite_id):
            return self.geo_sat_antenna_angle
        return self.sat_antenna_angle

    def _gsl_bandwidth(self, satellite_id: str) -> float:
        if is_geo_satellite_id(satellite_id):
            return self.bw_geo_gsl
        return self.bw_gsl

    def _best_candidate_index(
        self,
        candidate_indices: np.ndarray,
        distances: np.ndarray,
        elevations: np.ndarray,
        coverage_angles: np.ndarray,
        antenna_angles: np.ndarray,
    ) -> int | None:
        if candidate_indices.size == 0:
            return None

        visible_mask = elevations[candidate_indices] > 0.0
        coverage_mask = coverage_angles[candidate_indices] <= antenna_angles[candidate_indices]
        valid_indices = candidate_indices[visible_mask & coverage_mask]
        if valid_indices.size == 0:
            return None

        return int(valid_indices[np.argmin(distances[valid_indices])])

    def compute(self, nodes: Sequence[Node], demands: Sequence[TrafficDemand] | None = None) -> list[Edge]:
        satellites = [node for node in nodes if node.node_type == "satellite"]
        clients = [node for node in nodes if node.node_type in {"aircraft", "ground_station"}]
        if not satellites or not clients:
            return []

        sat_positions = np.vstack([satellite.ecef for satellite in satellites])
        leo_indices = np.asarray(
            [index for index, satellite in enumerate(satellites) if not is_geo_satellite_id(satellite.id)],
            dtype=int,
        )
        geo_indices = np.asarray(
            [index for index, satellite in enumerate(satellites) if is_geo_satellite_id(satellite.id)],
            dtype=int,
        )
        edges: list[Edge] = []
        access_by_client: dict[str, tuple[int | None, int | None]] = {}

        for client in clients:
            distances = distances_from(client.ecef, sat_positions)
            elevations = elevation_angles_deg(client.ecef, sat_positions)
            client_vectors = sat_positions - client.ecef
            nadir_vectors = -sat_positions
            coverage_angles = angle_between_deg(nadir_vectors, -client_vectors)
            antenna_angles = np.asarray(
                [self._satellite_antenna_angle(satellite.id) for satellite in satellites],
                dtype=float,
            )

            best_leo_idx = self._best_candidate_index(
                leo_indices,
                distances,
                elevations,
                coverage_angles,
                antenna_angles,
            )
            best_geo_idx = self._best_candidate_index(
                geo_indices,
                distances,
                elevations,
                coverage_angles,
                antenna_angles,
            )
            access_by_client[client.id] = (best_leo_idx, best_geo_idx)

        fallback_geo_clients: set[str] = set()
        if demands:
            for demand in demands:
                source_access = access_by_client.get(demand.source)
                target_access = access_by_client.get(demand.target)
                source_has_leo = source_access is not None and source_access[0] is not None
                target_has_leo = target_access is not None and target_access[0] is not None
                if not source_has_leo or not target_has_leo:
                    fallback_geo_clients.update((demand.source, demand.target))
        else:
            fallback_geo_clients = {
                client_id
                for client_id, (best_leo_idx, _) in access_by_client.items()
                if best_leo_idx is None
            }

        for client in clients:
            best_leo_idx, best_geo_idx = access_by_client.get(client.id, (None, None))
            selected_indices: list[int] = []
            if best_leo_idx is not None:
                selected_indices.append(best_leo_idx)
            if best_geo_idx is not None and (best_leo_idx is None or client.id in fallback_geo_clients):
                selected_indices.append(best_geo_idx)

            for selected_idx in selected_indices:
                selected_satellite = satellites[selected_idx]
                capacity = self._gsl_bandwidth(selected_satellite.id)
                edges.append(
                    Edge(
                        source=client.id,
                        target=selected_satellite.id,
                        edge_type="GSL",
                        distance=float(np.linalg.norm(client.ecef - selected_satellite.ecef)),
                        capacity=capacity,
                    )
                )

        return edges
