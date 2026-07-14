from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True, frozen=True)
class HandoverPenaltyPolicy:
    duration_s: float
    extra_latency_ms: float
    extra_packet_loss_rate: float
    cause: str

    @property
    def enabled(self) -> bool:
        return self.duration_s > 0.0 and (self.extra_latency_ms > 0.0 or self.extra_packet_loss_rate > 0.0)


@dataclass(slots=True)
class ActiveHandoverPenalty:
    cause: str
    active_until_s: float
    extra_latency_ms: float
    extra_packet_loss_rate: float

    def remaining_s(self, current_time_s: float) -> float:
        return max(0.0, self.active_until_s - current_time_s)

    def is_active(self, current_time_s: float) -> bool:
        return self.remaining_s(current_time_s) > 1e-9


class AccessHandoverPenaltyTracker:
    def __init__(
        self,
        aircraft_policy: HandoverPenaltyPolicy,
        ground_station_policy: HandoverPenaltyPolicy,
    ) -> None:
        self.aircraft_policy = aircraft_policy
        self.ground_station_policy = ground_station_policy
        self.previous_access_satellites: dict[tuple[str, str, str], str | None] = {}
        self.active_penalties: dict[tuple[str, str], dict[str, ActiveHandoverPenalty]] = {}

    def apply_to_snapshot(self, snapshot: dict[str, Any]) -> set[float]:
        current_time_s = float(snapshot.get("relative_time_s", 0.0))
        node_types = {
            str(node["id"]): str(node.get("type", ""))
            for node in snapshot.get("nodes", [])
        }
        scheduled_boundary_times: set[float] = set()

        for metric in snapshot.get("end_to_end_metrics", []):
            source = str(metric.get("source", ""))
            target = str(metric.get("target", ""))
            if not source or not target:
                continue

            route_key = (source, target)
            source_type = node_types.get(source, "")
            target_type = node_types.get(target, "")
            source_access_sat = self._extract_access_satellite(metric, side="source", endpoint_type=source_type)
            target_access_sat = self._extract_access_satellite(metric, side="target", endpoint_type=target_type)

            self._update_penalty(route_key, "source", source_type, source_access_sat, current_time_s)
            self._update_penalty(route_key, "target", target_type, target_access_sat, current_time_s)

            active_penalties = self._active_penalties_for_route(route_key, current_time_s)
            self._annotate_metric(metric, active_penalties, current_time_s)

            for penalty in active_penalties:
                if penalty.is_active(current_time_s):
                    scheduled_boundary_times.add(round(penalty.active_until_s, 6))

        return scheduled_boundary_times

    def _policy_for_endpoint_type(self, endpoint_type: str) -> HandoverPenaltyPolicy | None:
        if endpoint_type == "aircraft":
            return self.aircraft_policy
        if endpoint_type == "ground_station":
            return self.ground_station_policy
        return None

    def _extract_access_satellite(self, metric: dict[str, Any], side: str, endpoint_type: str) -> str | None:
        if endpoint_type not in {"aircraft", "ground_station"}:
            return None

        path = [str(node_id) for node_id in metric.get("path", [])]
        if len(path) < 2:
            return None

        candidate = path[1] if side == "source" else path[-2]
        if not candidate.startswith("sat_"):
            return None
        return candidate

    def _update_penalty(
        self,
        route_key: tuple[str, str],
        side: str,
        endpoint_type: str,
        current_access_sat: str | None,
        current_time_s: float,
    ) -> None:
        previous_key = (route_key[0], route_key[1], side)
        previous_access_sat = self.previous_access_satellites.get(previous_key)
        policy = self._policy_for_endpoint_type(endpoint_type)

        if (
            policy is not None
            and policy.enabled
            and previous_access_sat is not None
            and current_access_sat is not None
            and previous_access_sat != current_access_sat
        ):
            route_penalties = self.active_penalties.setdefault(route_key, {})
            route_penalties[side] = ActiveHandoverPenalty(
                cause=policy.cause,
                active_until_s=current_time_s + policy.duration_s,
                extra_latency_ms=policy.extra_latency_ms,
                extra_packet_loss_rate=policy.extra_packet_loss_rate,
            )

        self.previous_access_satellites[previous_key] = current_access_sat

    def _active_penalties_for_route(
        self,
        route_key: tuple[str, str],
        current_time_s: float,
    ) -> list[ActiveHandoverPenalty]:
        route_penalties = self.active_penalties.get(route_key)
        if not route_penalties:
            return []

        active_penalties: list[ActiveHandoverPenalty] = []
        expired_sides: list[str] = []
        for side, penalty in route_penalties.items():
            if penalty.is_active(current_time_s):
                active_penalties.append(penalty)
            else:
                expired_sides.append(side)

        for side in expired_sides:
            route_penalties.pop(side, None)

        if not route_penalties:
            self.active_penalties.pop(route_key, None)

        return sorted(active_penalties, key=lambda item: item.cause)

    def _annotate_metric(
        self,
        metric: dict[str, Any],
        active_penalties: list[ActiveHandoverPenalty],
        current_time_s: float,
    ) -> None:
        steady_latency_ms = float(metric.get("steady_latency_ms", metric.get("latency_ms", -1.0)))
        steady_packet_loss_rate = float(metric.get("steady_packet_loss_rate", metric.get("packet_loss_rate", 1.0)))
        steady_ber = float(metric.get("steady_ber", metric.get("ber", 1.0)))
        steady_effective_bandwidth_mbps = float(
            metric.get("steady_effective_bandwidth_mbps", metric.get("effective_bandwidth_mbps", 0.0))
        )
        connected = bool(metric.get("connected", metric.get("path", [])))

        metric["steady_latency_ms"] = round(steady_latency_ms, 6)
        metric["steady_packet_loss_rate"] = round(steady_packet_loss_rate, 12)
        metric["steady_ber"] = round(steady_ber, 12)
        metric["steady_effective_bandwidth_mbps"] = round(steady_effective_bandwidth_mbps, 6)

        if not connected or not active_penalties:
            metric["latency_ms"] = round(steady_latency_ms, 6)
            metric["packet_loss_rate"] = round(steady_packet_loss_rate, 12)
            metric["effective_bandwidth_mbps"] = round(steady_effective_bandwidth_mbps, 6)
            metric["transient"] = {
                "active": False,
                "causes": [],
                "extra_latency_ms": 0.0,
                "extra_packet_loss_rate": 0.0,
                "remaining_s": 0.0,
            }
            return

        total_extra_latency_ms = sum(penalty.extra_latency_ms for penalty in active_penalties)
        extra_success_rate = 1.0
        for penalty in active_penalties:
            extra_success_rate *= max(0.0, 1.0 - penalty.extra_packet_loss_rate)
        extra_packet_loss_rate = 1.0 - extra_success_rate

        end_to_end_success_rate = max(0.0, 1.0 - steady_packet_loss_rate) * extra_success_rate
        metric["latency_ms"] = round(steady_latency_ms + total_extra_latency_ms, 6)
        metric["packet_loss_rate"] = round(1.0 - end_to_end_success_rate, 12)
        metric["effective_bandwidth_mbps"] = round(steady_effective_bandwidth_mbps * extra_success_rate, 6)
        metric["transient"] = {
            "active": True,
            "causes": [penalty.cause for penalty in active_penalties],
            "extra_latency_ms": round(total_extra_latency_ms, 6),
            "extra_packet_loss_rate": round(extra_packet_loss_rate, 12),
            "remaining_s": round(max(penalty.remaining_s(current_time_s) for penalty in active_penalties), 6),
        }