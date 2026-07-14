from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Iterable

import numpy as np
from skyfield.api import EarthSatellite, load, wgs84
from skyfield.framelib import itrs

from ..config import AircraftTrajectoryFunctions
from ..models import Node
from ..utils.coord_utils import lla_to_ecef_km


def _scalar(value: object) -> float:
    return float(np.asarray(value, dtype=float).squeeze())


class PhysicalSpaceEngine:
    def __init__(
        self,
        start_time: datetime,
        satellites: dict[str, EarthSatellite],
        aircraft_traj_funcs: dict[str, AircraftTrajectoryFunctions],
        ground_stations: Iterable[Node],
    ) -> None:
        self.start_time = start_time
        self.satellites = satellites
        self.aircraft_traj_funcs = aircraft_traj_funcs
        self.ground_stations = list(ground_stations)
        self.timescale = load.timescale(builtin=True)


    def compute(self, t: float) -> list[Node]:
        utc_time = self.start_time + timedelta(seconds=float(t))
        sf_time = self.timescale.from_datetime(utc_time)
        nodes: list[Node] = []

        for sat_id, satellite in self.satellites.items():
            geocentric = satellite.at(sf_time)
            lat, lon = wgs84.latlon_of(geocentric)
            alt = wgs84.height_of(geocentric).km
            ecef = geocentric.frame_xyz(itrs).km
            nodes.append(
                Node(
                    id=sat_id,
                    node_type="satellite",
                    lat=lat.degrees,
                    lon=lon.degrees,
                    alt=alt,
                    ecef=np.asarray(ecef, dtype=float),
                )
            )

        for aircraft_id, funcs in self.aircraft_traj_funcs.items():
            lat = _scalar(funcs.lat(t))
            lon = _scalar(funcs.lon(t))
            alt = _scalar(funcs.alt(t))
            ecef = np.asarray(lla_to_ecef_km(lat, lon, alt), dtype=float)
            nodes.append(
                Node(
                    id=aircraft_id,
                    node_type="aircraft",
                    lat=lat,
                    lon=lon,
                    alt=alt,
                    ecef=ecef,
                )
            )

        for station in self.ground_stations:
            nodes.append(deepcopy(station))

        return nodes