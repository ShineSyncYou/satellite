from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass(slots=True)
class Node:
    id: str
    node_type: str
    lat: float
    lon: float
    alt: float
    ecef: np.ndarray

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.node_type,
            "lat": self.lat,
            "lon": self.lon,
            "alt": self.alt,
        }


@dataclass(slots=True)
class Edge:
    source: str
    target: str
    edge_type: str
    distance: float
    capacity: float
    traffic: float = 0.0
    utilization: float = 0.0
    color: str = ""

    def key(self) -> tuple[str, str]:
        return tuple(sorted((self.source, self.target)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "type": self.edge_type,
            "distance_km": self.distance,
            "bandwidth_mbps": self.capacity,
            "tx_rate_mbps": self.traffic,
            "utilization": self.utilization,
            "color": self.color,
        }


@dataclass(slots=True)
class TrafficDemand:
    source: str
    target: str
    rate_mbps: float


@dataclass(slots=True)
class RoutePlan:
    source: str
    target: str
    rate_mbps: float
    path: list[str] = field(default_factory=list)
    connected: bool = False


@dataclass(slots=True)
class EndToEndMetric:
    source: str
    target: str
    path: list[str]
    latency_ms: float
    packet_loss_rate: float
    ber: float
    requested_bandwidth_mbps: float = 0.0
    actual_tx_bandwidth_mbps: float = 0.0
    dropped_bandwidth_mbps: float = 0.0
    effective_bandwidth_mbps: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        connected = bool(self.path)
        return {
            "source": self.source,
            "target": self.target,
            "connected": connected,
            "path": self.path,
            "hop_count": max(0, len(self.path) - 1),
            "latency_ms": self.latency_ms,
            "packet_loss_rate": self.packet_loss_rate,
            "ber": self.ber,
            "requested_bandwidth_mbps": self.requested_bandwidth_mbps,
            "actual_tx_bandwidth_mbps": self.actual_tx_bandwidth_mbps,
            "dropped_bandwidth_mbps": self.dropped_bandwidth_mbps,
            "effective_bandwidth_mbps": self.effective_bandwidth_mbps,
        }
