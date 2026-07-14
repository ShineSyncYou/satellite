from __future__ import annotations

import numpy as np


def distances_from(origin: np.ndarray, targets: np.ndarray) -> np.ndarray:
    return np.linalg.norm(targets - origin, axis=1)


def angle_between_deg(vec_a: np.ndarray, vec_b: np.ndarray) -> np.ndarray:
    numerator = np.sum(vec_a * vec_b, axis=-1)
    denom = np.linalg.norm(vec_a, axis=-1) * np.linalg.norm(vec_b, axis=-1)
    safe = np.clip(np.divide(numerator, denom, out=np.zeros_like(numerator, dtype=float), where=denom > 0.0), -1.0, 1.0)
    return np.degrees(np.arccos(safe))


def elevation_angles_deg(observer_ecef: np.ndarray, targets_ecef: np.ndarray) -> np.ndarray:
    line_of_sight = targets_ecef - observer_ecef
    los_norm = np.linalg.norm(line_of_sight, axis=1, keepdims=True)
    los_unit = np.divide(line_of_sight, los_norm, out=np.zeros_like(line_of_sight), where=los_norm > 0.0)
    observer_norm = np.linalg.norm(observer_ecef)
    observer_up = observer_ecef / max(observer_norm, 1e-9)
    projection = np.clip(np.sum(los_unit * observer_up, axis=1), -1.0, 1.0)
    return np.degrees(np.arcsin(projection))


def color_for_utilization(utilization: float) -> str:
    if utilization < 0.5:
        return "green"
    if utilization <= 0.8:
        return "yellow"
    return "red"