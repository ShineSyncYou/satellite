from __future__ import annotations

from typing import Tuple

from pyproj import Transformer

_LLA_TO_ECEF = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
_ECEF_TO_LLA = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)


def lla_to_ecef_km(lat_deg: float, lon_deg: float, alt_km: float) -> Tuple[float, float, float]:
    x_m, y_m, z_m = _LLA_TO_ECEF.transform(lon_deg, lat_deg, alt_km * 1000.0)
    return x_m / 1000.0, y_m / 1000.0, z_m / 1000.0


def ecef_to_lla_km(x_km: float, y_km: float, z_km: float) -> Tuple[float, float, float]:
    lon_deg, lat_deg, alt_m = _ECEF_TO_LLA.transform(x_km * 1000.0, y_km * 1000.0, z_km * 1000.0)
    return lat_deg, lon_deg, alt_m / 1000.0