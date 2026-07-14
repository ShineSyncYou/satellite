from __future__ import annotations

import math

from ..models import Edge, EndToEndMetric, Node, RoutePlan
from ..utils.math_utils import color_for_utilization


def _edge_key(source: str, target: str) -> tuple[str, str]:
    return tuple(sorted((source, target)))


def _link_ber(edge: Edge, rain_fade_intensity: float, node_types: dict[str, str]) -> float:
    if edge.edge_type == "GSL" and "ground_station" in {node_types.get(edge.source), node_types.get(edge.target)}:
        return min(1.0, 1e-7 * math.exp(edge.distance * rain_fade_intensity / 1000.0))
    if edge.edge_type == "GSL":
        return 1e-7
    return 1e-9


def _congestion_loss(utilization: float) -> float:
    if utilization >= 1.0:
        return 1.0 - (1.0 / max(utilization, 1.0))
    return 0.0


class PerformanceLayer:
    def __init__(
        self,
        rain_fade_intensity: float,
        packet_size_bits: int = 12000,
        signal_speed_km_s: float = 299792.458,
        endpoint_processing_delay_ms: float = 2.0,
        satellite_processing_delay_ms: float = 3.0,
        gsl_access_delay_ms: float = 8.0,
        isl_processing_delay_ms: float = 1.5,
    ) -> None:
        self.rain_fade_intensity = rain_fade_intensity
        self.packet_size_bits = packet_size_bits
        self.signal_speed_km_s = max(1.0, signal_speed_km_s)
        self.endpoint_processing_delay_ms = max(0.0, endpoint_processing_delay_ms)
        self.satellite_processing_delay_ms = max(0.0, satellite_processing_delay_ms)
        self.gsl_access_delay_ms = max(0.0, gsl_access_delay_ms)
        self.isl_processing_delay_ms = max(0.0, isl_processing_delay_ms)

    def compute(
        self,
        routes: list[RoutePlan],
        gsl_edges: list[Edge],
        isl_edges: list[Edge],
        nodes: list[Node] | None = None,
    ) -> tuple[list[Edge], list[EndToEndMetric]]:
        edge_map = {_edge_key(edge.source, edge.target): edge for edge in [*gsl_edges, *isl_edges]}
        node_types = {node.id: node.node_type for node in nodes or []}

        for route in routes:
            if not route.connected:
                continue
            for idx in range(len(route.path) - 1):
                key = _edge_key(route.path[idx], route.path[idx + 1])
                edge = edge_map.get(key)
                if edge is not None:
                    edge.traffic += route.rate_mbps

        for edge in edge_map.values():
            edge.utilization = edge.traffic / edge.capacity if edge.capacity > 0.0 else 0.0
            edge.color = color_for_utilization(edge.utilization)

        metrics: list[EndToEndMetric] = []
        for route in routes:
            if not route.connected:
                metrics.append(
                    EndToEndMetric(
                        source=route.source,
                        target=route.target,
                        path=[],
                        latency_ms=-1.0,
                        packet_loss_rate=1.0,
                        ber=1.0,
                    )
                )
                continue

            propagation_delay_s = 0.0
            transmission_delay_s = 0.0
            queue_delay_s = 0.0
            link_overhead_delay_s = 0.0
            end_to_end_success = 1.0
            end_to_end_clean_bits = 1.0
            access_queue_success = 1.0

            for idx in range(len(route.path) - 1):
                key = _edge_key(route.path[idx], route.path[idx + 1])
                edge = edge_map[key]
                utilization = edge.utilization
                ber = _link_ber(edge, self.rain_fade_intensity, node_types)
                service_time_s = self.packet_size_bits / max(1.0, edge.capacity * 1e6)
                propagation_delay_s += edge.distance / self.signal_speed_km_s
                transmission_delay_s += service_time_s

                if utilization >= 1.0:
                    queue_delay_s += 1.0
                    congestion_loss = _congestion_loss(utilization)
                else:
                    queue_delay_s += service_time_s * (utilization / max(0.01, 1.0 - utilization))
                    congestion_loss = _congestion_loss(utilization)

                if edge.edge_type == "GSL":
                    link_overhead_delay_s += self.gsl_access_delay_ms / 1000.0
                    access_queue_success *= max(0.0, 1.0 - congestion_loss)
                else:
                    link_overhead_delay_s += self.isl_processing_delay_ms / 1000.0

                physical_loss = 1.0 - math.pow(max(0.0, 1.0 - ber), self.packet_size_bits)
                link_loss = 1.0 - ((1.0 - physical_loss) * (1.0 - congestion_loss))
                end_to_end_success *= max(0.0, 1.0 - link_loss)
                end_to_end_clean_bits *= max(0.0, 1.0 - ber)

            intermediate_satellite_count = max(0, len(route.path) - 2)
            endpoint_processing_delay_s = 2.0 * (self.endpoint_processing_delay_ms / 1000.0)
            satellite_processing_delay_s = intermediate_satellite_count * (self.satellite_processing_delay_ms / 1000.0)
            total_latency_ms = (
                propagation_delay_s
                + transmission_delay_s
                + queue_delay_s
                + link_overhead_delay_s
                + endpoint_processing_delay_s
                + satellite_processing_delay_s
            ) * 1000.0
            effective_bandwidth_mbps = route.rate_mbps * access_queue_success
            metrics.append(
                EndToEndMetric(
                    source=route.source,
                    target=route.target,
                    path=route.path,
                    latency_ms=total_latency_ms,
                    packet_loss_rate=1.0 - end_to_end_success,
                    ber=1.0 - end_to_end_clean_bits,
                    effective_bandwidth_mbps=effective_bandwidth_mbps,
                )
            )

        return list(edge_map.values()), metrics
