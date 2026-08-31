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
        allocated_rates, directional_traffic = self._allocate_route_rates(routes, edge_map)
        directional_utilization: dict[tuple[str, str], float] = {}

        for edge in edge_map.values():
            forward_key = (edge.source, edge.target)
            reverse_key = (edge.target, edge.source)
            forward_traffic = directional_traffic.get(forward_key, 0.0)
            reverse_traffic = directional_traffic.get(reverse_key, 0.0)
            edge.traffic = forward_traffic + reverse_traffic
            forward_utilization = forward_traffic / edge.capacity if edge.capacity > 0.0 else 0.0
            reverse_utilization = reverse_traffic / edge.capacity if edge.capacity > 0.0 else 0.0
            directional_utilization[forward_key] = forward_utilization
            directional_utilization[reverse_key] = reverse_utilization
            edge.utilization = max(forward_utilization, reverse_utilization)
            edge.color = color_for_utilization(edge.utilization)

        metrics: list[EndToEndMetric] = []
        for route_index, route in enumerate(routes):
            requested_bandwidth_mbps = max(0.0, route.rate_mbps)
            actual_tx_bandwidth_mbps = allocated_rates[route_index]
            dropped_bandwidth_mbps = max(0.0, requested_bandwidth_mbps - actual_tx_bandwidth_mbps)
            if not route.connected:
                metrics.append(
                    EndToEndMetric(
                        source=route.source,
                        target=route.target,
                        path=[],
                        latency_ms=-1.0,
                        packet_loss_rate=1.0,
                        ber=1.0,
                        requested_bandwidth_mbps=requested_bandwidth_mbps,
                        actual_tx_bandwidth_mbps=0.0,
                        dropped_bandwidth_mbps=requested_bandwidth_mbps,
                    )
                )
                continue

            propagation_delay_s = 0.0
            transmission_delay_s = 0.0
            queue_delay_s = 0.0
            link_overhead_delay_s = 0.0
            end_to_end_success = 1.0
            end_to_end_clean_bits = 1.0

            for idx in range(len(route.path) - 1):
                key = _edge_key(route.path[idx], route.path[idx + 1])
                edge = edge_map[key]
                utilization = directional_utilization[(route.path[idx], route.path[idx + 1])]
                ber = _link_ber(edge, self.rain_fade_intensity, node_types)
                service_time_s = self.packet_size_bits / max(1.0, edge.capacity * 1e6)
                propagation_delay_s += edge.distance / self.signal_speed_km_s
                transmission_delay_s += service_time_s
                queue_utilization = min(max(0.0, utilization), 0.99)
                queue_delay_s += service_time_s * (queue_utilization / max(0.01, 1.0 - queue_utilization))

                if edge.edge_type == "GSL":
                    link_overhead_delay_s += self.gsl_access_delay_ms / 1000.0
                else:
                    link_overhead_delay_s += self.isl_processing_delay_ms / 1000.0
                physical_loss = 1.0 - math.pow(max(0.0, 1.0 - ber), self.packet_size_bits)
                end_to_end_success *= max(0.0, 1.0 - physical_loss)
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
            effective_bandwidth_mbps = actual_tx_bandwidth_mbps * end_to_end_success
            metrics.append(
                EndToEndMetric(
                    source=route.source,
                    target=route.target,
                    path=route.path,
                    latency_ms=total_latency_ms,
                    packet_loss_rate=1.0 - end_to_end_success,
                    ber=1.0 - end_to_end_clean_bits,
                    requested_bandwidth_mbps=requested_bandwidth_mbps,
                    actual_tx_bandwidth_mbps=actual_tx_bandwidth_mbps,
                    dropped_bandwidth_mbps=dropped_bandwidth_mbps,
                    effective_bandwidth_mbps=effective_bandwidth_mbps,
                )
            )

        return list(edge_map.values()), metrics

    @staticmethod
    def _allocate_route_rates(
        routes: list[RoutePlan],
        edge_map: dict[tuple[str, str], Edge],
    ) -> tuple[list[float], dict[tuple[str, str], float]]:
        """按链路方向进行最大最小公平分配，返回每条路由实际发送速率。"""
        allocations = [0.0 for _ in routes]
        remaining_demands = [max(0.0, route.rate_mbps) for route in routes]
        route_resources: list[set[tuple[str, str]]] = []
        resource_capacity: dict[tuple[str, str], float] = {}

        for route in routes:
            resources: set[tuple[str, str]] = set()
            if route.connected:
                for index in range(len(route.path) - 1):
                    source = str(route.path[index])
                    target = str(route.path[index + 1])
                    edge = edge_map.get(_edge_key(source, target))
                    if edge is None:
                        continue
                    resources.add((source, target))
                    resource_capacity[(source, target)] = max(0.0, edge.capacity)
            route_resources.append(resources)

        active_routes = {
            index
            for index, route in enumerate(routes)
            if route.connected and remaining_demands[index] > 1e-9 and route_resources[index]
        }
        residual_capacity = dict(resource_capacity)

        while active_routes:
            routes_by_resource: dict[tuple[str, str], set[int]] = {}
            for route_index in active_routes:
                for resource in route_resources[route_index]:
                    routes_by_resource.setdefault(resource, set()).add(route_index)

            demand_step = min(remaining_demands[index] for index in active_routes)
            capacity_step = min(
                (
                    residual_capacity[resource] / len(route_indexes)
                    for resource, route_indexes in routes_by_resource.items()
                ),
                default=0.0,
            )
            increment = min(demand_step, capacity_step)
            if increment <= 1e-9:
                saturated_resources = {
                    resource
                    for resource, route_indexes in routes_by_resource.items()
                    if residual_capacity[resource] <= 1e-9 and route_indexes
                }
                active_routes = {
                    route_index
                    for route_index in active_routes
                    if not (route_resources[route_index] & saturated_resources)
                }
                continue

            for route_index in active_routes:
                allocations[route_index] += increment
                remaining_demands[route_index] = max(0.0, remaining_demands[route_index] - increment)
            for resource, route_indexes in routes_by_resource.items():
                residual_capacity[resource] = max(
                    0.0,
                    residual_capacity[resource] - (increment * len(route_indexes)),
                )

            saturated_resources = {
                resource
                for resource, route_indexes in routes_by_resource.items()
                if residual_capacity[resource] <= 1e-9 and route_indexes
            }
            active_routes = {
                route_index
                for route_index in active_routes
                if remaining_demands[route_index] > 1e-9
                and not (route_resources[route_index] & saturated_resources)
            }

        directional_traffic: dict[tuple[str, str], float] = {}
        for route_index, resources in enumerate(route_resources):
            for resource in resources:
                directional_traffic[resource] = directional_traffic.get(resource, 0.0) + allocations[route_index]

        return allocations, directional_traffic
