from __future__ import annotations

import unittest
from collections import Counter

import numpy as np

from satellite_sim.core.l2_access import AccessLayer
from satellite_sim.core.l3_routing import RoutingEngine
from satellite_sim.core.l4_performance import PerformanceLayer
from satellite_sim.models import Edge, Node, RoutePlan, TrafficDemand
from satellite_sim.utils.coord_utils import lla_to_ecef_km


def _node(
    node_id: str,
    node_type: str,
    lat: float,
    lon: float,
    alt: float,
) -> Node:
    return Node(
        id=node_id,
        node_type=node_type,
        lat=lat,
        lon=lon,
        alt=alt,
        ecef=np.asarray(lla_to_ecef_km(lat, lon, alt), dtype=float),
    )


class MultiGeoRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.geo_nodes = [
            _node("sat_geo_1", "satellite", 0.0, -135.0, 35786.0),
            _node("sat_geo_2", "satellite", 0.0, -45.0, 35786.0),
            _node("sat_geo_3", "satellite", 0.0, 45.0, 35786.0),
            _node("sat_geo_4", "satellite", 0.0, 135.0, 35786.0),
        ]
        self.aircraft = _node("AC_1", "aircraft", 0.0, -135.0, 10.0)
        self.ground_station = _node("GS_1", "ground_station", 0.0, 45.0, 0.0)
        self.nodes = [*self.geo_nodes, self.aircraft, self.ground_station]
        self.demand = TrafficDemand(source="AC_1", target="GS_1", rate_mbps=25.0)

    def test_visible_access_uses_different_geo_satellites(self) -> None:
        access = AccessLayer(
            sat_antenna_angle=35.0,
            bw_gsl=150.0,
            geo_sat_antenna_angle=8.0,
            bw_geo_gsl=400.0,
        )

        self.assertEqual(access._gsl_bandwidth("sat_1_1"), 150.0)
        self.assertEqual(access._gsl_bandwidth("sat_geo_1"), 400.0)

        gsl_edges = access.compute(self.nodes, [self.demand])
        edge_keys = {edge.key() for edge in gsl_edges}

        self.assertEqual(
            edge_keys,
            {
                tuple(sorted(("AC_1", "sat_geo_1"))),
                tuple(sorted(("GS_1", "sat_geo_3"))),
            },
        )
        self.assertTrue(all(edge.edge_type == "GSL" for edge in gsl_edges))
        self.assertTrue(all(edge.capacity == 400.0 for edge in gsl_edges))

    def test_geo_relay_route_respects_neighbor_and_link_limits(self) -> None:
        access = AccessLayer(
            sat_antenna_angle=35.0,
            bw_gsl=150.0,
            geo_sat_antenna_angle=8.0,
            bw_geo_gsl=400.0,
        )
        gsl_edges = access.compute(self.nodes, [self.demand])

        routing = RoutingEngine(
            satellite_ids=[node.id for node in self.geo_nodes],
            bw_isl=200.0,
            geo_isl_neighbor_count=2,
            isl_require_los=True,
        )
        routes, isl_edges = routing.compute(self.nodes, gsl_edges, [self.demand])

        neighbor_counts: Counter[str] = Counter()
        for edge in isl_edges:
            neighbor_counts[edge.source] += 1
            neighbor_counts[edge.target] += 1

        self.assertTrue(all(count <= 2 for count in neighbor_counts.values()))
        self.assertTrue(all(edge.edge_type == "ISL" for edge in isl_edges))
        self.assertTrue(all(edge.capacity == 200.0 for edge in isl_edges))
        self.assertNotIn(
            tuple(sorted(("sat_geo_1", "sat_geo_3"))),
            {edge.key() for edge in isl_edges},
        )

        route = routes[0]
        self.assertTrue(route.connected)
        self.assertEqual(route.path[0:2], ["AC_1", "sat_geo_1"])
        self.assertEqual(route.path[-2:], ["sat_geo_3", "GS_1"])
        self.assertGreaterEqual(len(route.path), 5)

        performance = PerformanceLayer(rain_fade_intensity=0.15)
        used_edges, metrics = performance.compute(
            routes,
            gsl_edges,
            isl_edges,
            nodes=self.nodes,
        )
        used_edge_map = {edge.key(): edge for edge in used_edges}

        for source, target in zip(route.path, route.path[1:]):
            edge = used_edge_map[tuple(sorted((source, target)))]
            self.assertEqual(edge.traffic, self.demand.rate_mbps)
            if edge.edge_type == "GSL":
                self.assertEqual(edge.capacity, 400.0)
            else:
                self.assertEqual(edge.capacity, 200.0)

        self.assertEqual(metrics[0].path, route.path)
        self.assertGreater(metrics[0].latency_ms, 0.0)
        self.assertGreaterEqual(metrics[0].packet_loss_rate, 0.0)
        self.assertLessEqual(metrics[0].packet_loss_rate, 1.0)

    def test_geo_neighbor_setting_is_hard_capped_at_two(self) -> None:
        routing = RoutingEngine(
            satellite_ids=[node.id for node in self.geo_nodes],
            bw_isl=500.0,
            geo_isl_neighbor_count=99,
            isl_require_los=False,
        )

        _, isl_edges = routing.compute(self.geo_nodes, [], [])
        neighbor_counts: Counter[str] = Counter()
        for edge in isl_edges:
            neighbor_counts[edge.source] += 1
            neighbor_counts[edge.target] += 1

        self.assertEqual(routing.geo_isl_neighbor_count, 2)
        self.assertTrue(all(count <= 2 for count in neighbor_counts.values()))

    def test_geo_distance_limit_filters_unreachable_neighbors(self) -> None:
        routing = RoutingEngine(
            satellite_ids=[node.id for node in self.geo_nodes],
            bw_isl=500.0,
            geo_isl_max_distance_km=1000.0,
            geo_isl_neighbor_count=2,
            isl_require_los=True,
        )

        _, isl_edges = routing.compute(self.geo_nodes, [], [])

        self.assertEqual(isl_edges, [])

    def test_static_isl_applies_distance_and_line_of_sight_limits(self) -> None:
        nearby_nodes = [
            _node("sat_1_1", "satellite", 0.0, 0.0, 1000.0),
            _node("sat_1_2", "satellite", 0.0, 10.0, 1000.0),
        ]
        distance_limited = RoutingEngine(
            satellite_ids=[node.id for node in nearby_nodes],
            bw_isl=500.0,
            isl_mode="static-grid",
            isl_max_distance_km=100.0,
            isl_require_los=True,
        )

        _, distance_limited_edges = distance_limited.compute(nearby_nodes, [], [])
        self.assertEqual(distance_limited_edges, [])

        earth_blocked_nodes = [
            _node("sat_1_1", "satellite", 0.0, 0.0, 1000.0),
            _node("sat_1_2", "satellite", 0.0, 180.0, 1000.0),
        ]
        los_limited = RoutingEngine(
            satellite_ids=[node.id for node in earth_blocked_nodes],
            bw_isl=500.0,
            isl_mode="static-grid",
            isl_max_distance_km=None,
            isl_require_los=True,
        )

        _, los_limited_edges = los_limited.compute(earth_blocked_nodes, [], [])
        self.assertEqual(los_limited_edges, [])

    def test_route_weight_prefers_available_capacity_over_short_overload(self) -> None:
        routing = RoutingEngine(
            satellite_ids=[],
            bw_isl=500.0,
        )
        weight = routing._edge_weight_with_switching_cost(
            previous_edge_keys=set(),
            demand_rate_mbps=25.0,
        )

        overloaded_short_weight = weight(
            "A",
            "B",
            {
                "distance": 100.0,
                "capacity": 10.0,
                "reserved_traffic_mbps": 0.0,
                "edge_type": "ISL",
            },
        )
        available_long_weight = weight(
            "A",
            "C",
            {
                "distance": 1000.0,
                "capacity": 100.0,
                "reserved_traffic_mbps": 0.0,
                "edge_type": "ISL",
            },
        )

        self.assertLess(available_long_weight, overloaded_short_weight)

    def test_effective_bandwidth_includes_isl_congestion(self) -> None:
        nodes = [
            _node("AC_1", "aircraft", 0.0, 0.0, 10.0),
            _node("sat_1_1", "satellite", 0.0, 0.0, 1000.0),
            _node("sat_1_2", "satellite", 0.0, 10.0, 1000.0),
            _node("GS_1", "ground_station", 0.0, 10.0, 0.0),
        ]
        gsl_edges = [
            Edge("AC_1", "sat_1_1", "GSL", 1000.0, 300.0),
            Edge("sat_1_2", "GS_1", "GSL", 1000.0, 300.0),
        ]
        isl_edges = [
            Edge("sat_1_1", "sat_1_2", "ISL", 2000.0, 10.0),
        ]
        routes = [
            RoutePlan(
                source="AC_1",
                target="GS_1",
                rate_mbps=25.0,
                path=["AC_1", "sat_1_1", "sat_1_2", "GS_1"],
                connected=True,
            )
        ]

        _, metrics = PerformanceLayer(rain_fade_intensity=0.15).compute(
            routes,
            gsl_edges,
            isl_edges,
            nodes=nodes,
        )

        self.assertAlmostEqual(metrics[0].effective_bandwidth_mbps, 10.0)


if __name__ == "__main__":
    unittest.main()
