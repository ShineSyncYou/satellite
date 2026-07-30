from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

EARTH_MU_KM3_S2 = 398600.4418
EARTH_RADIUS_KM = 6378.137


@dataclass(slots=True)
class TLEEntry:
    name: str
    sat_num: int
    inclination_deg: float
    raan_deg: float
    eccentricity: float
    arg_perigee_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_per_day: float
    epoch: datetime
    international_designator: str
    classification: str = "U"
    element_set_number: int = 999
    revolution_number: int = 1


def calculate_checksum(line: str) -> int:
    body = line[:68]
    checksum = sum(int(char) if char.isdigit() else (1 if char == "-" else 0) for char in body)
    return checksum % 10


def normalize_angle_deg(value: float) -> float:
    return value % 360.0


def eccentricity_to_tle(value: float) -> str:
    if not 0.0 <= value < 1.0:
        raise ValueError("eccentricity must be in [0, 1).")
    return f"{int(round(value * 1e7)):07d}"


def mean_motion_from_altitude_km(altitude_km: float) -> float:
    semi_major_axis_km = EARTH_RADIUS_KM + altitude_km
    mean_motion_rad_per_s = math.sqrt(EARTH_MU_KM3_S2 / (semi_major_axis_km ** 3))
    return mean_motion_rad_per_s * 86400.0 / (2.0 * math.pi)


def parse_epoch(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_epoch(epoch: datetime) -> str:
    epoch = epoch.astimezone(timezone.utc)
    year = epoch.year % 100
    day_of_year = epoch.timetuple().tm_yday
    seconds_since_midnight = (
        epoch.hour * 3600
        + epoch.minute * 60
        + epoch.second
        + (epoch.microsecond / 1_000_000.0)
    )
    fractional_day = seconds_since_midnight / 86400.0
    fractional_text = f"{fractional_day:.8f}".split(".", maxsplit=1)[1]
    return f"{year:02d}{day_of_year:03d}.{fractional_text}"


def piece_code(index: int) -> str:
    if index < 0:
        raise ValueError("piece code index must be non-negative.")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result = ""
    current = index
    while True:
        current, remainder = divmod(current, 26)
        result = alphabet[remainder] + result
        if current == 0:
            break
        current -= 1
    return result


def build_international_designator(prefix: str, sequence_index: int) -> str:
    value = f"{prefix}{piece_code(sequence_index)}"
    return value[:8].ljust(8)


def generate_tle(entry: TLEEntry) -> str:
    line1 = (
        f"1 {entry.sat_num:05d}{entry.classification} {entry.international_designator[:8]:<8} "
        f"{format_epoch(entry.epoch)}  .00000000  00000-0  00000-0 0 {entry.element_set_number:4d}"
    )
    line1 = f"{line1[:68]}{calculate_checksum(line1)}"

    line2 = (
        f"2 {entry.sat_num:05d}"
        f" {normalize_angle_deg(entry.inclination_deg):8.4f}"
        f" {normalize_angle_deg(entry.raan_deg):8.4f}"
        f" {eccentricity_to_tle(entry.eccentricity)}"
        f" {normalize_angle_deg(entry.arg_perigee_deg):8.4f}"
        f" {normalize_angle_deg(entry.mean_anomaly_deg):8.4f}"
        f" {entry.mean_motion_rev_per_day:11.8f}"
        f"{entry.revolution_number:5d}"
    )
    line2 = f"{line2[:68]}{calculate_checksum(line2)}"
    return f"{entry.name}\n{line1}\n{line2}"


def build_single_entry(args: argparse.Namespace) -> TLEEntry:
    mean_motion = args.mean_motion
    if mean_motion is None:
        mean_motion = mean_motion_from_altitude_km(args.altitude_km)

    epoch = parse_epoch(args.epoch)
    int_des = (args.international_designator[:8].ljust(8) if args.international_designator else build_international_designator(args.intl_designator_prefix, 0))
    return TLEEntry(
        name=args.name,
        sat_num=args.sat_num,
        inclination_deg=args.inclination_deg,
        raan_deg=args.raan_deg,
        eccentricity=args.eccentricity,
        arg_perigee_deg=args.arg_perigee_deg,
        mean_anomaly_deg=args.mean_anomaly_deg,
        mean_motion_rev_per_day=mean_motion,
        epoch=epoch,
        international_designator=int_des,
        element_set_number=args.element_set_number,
        revolution_number=args.revolution_number,
    )


def build_walker_entries(args: argparse.Namespace) -> list[TLEEntry]:
    mean_motion = args.mean_motion
    if mean_motion is None:
        mean_motion = mean_motion_from_altitude_km(args.altitude_km)

    epoch = parse_epoch(args.epoch)
    total_satellites = args.planes * args.sats_per_plane
    entries: list[TLEEntry] = []

    for plane_index in range(args.planes):
        plane_number = plane_index + 1
        raan_deg = args.base_raan_deg + (plane_index * (args.raan_span_deg / args.planes))
        if args.inter_plane_slot_offset_deg is not None:
            phase_shift_deg = plane_index * args.inter_plane_slot_offset_deg
        else:
            phase_shift_deg = plane_index * args.phase_factor * (360.0 / total_satellites)

        for slot_index in range(args.sats_per_plane):
            slot_number = slot_index + 1
            sat_num = args.start_sat_num + plane_index * args.sats_per_plane + slot_index
            mean_anomaly_deg = args.base_mean_anomaly_deg + slot_index * (360.0 / args.sats_per_plane) + phase_shift_deg
            name = args.name_pattern.format(plane=plane_number, slot=slot_number, sat=sat_num)
            int_des = build_international_designator(args.intl_designator_prefix, plane_index * args.sats_per_plane + slot_index)

            entries.append(
                TLEEntry(
                    name=name,
                    sat_num=sat_num,
                    inclination_deg=args.inclination_deg,
                    raan_deg=raan_deg,
                    eccentricity=args.eccentricity,
                    arg_perigee_deg=args.arg_perigee_deg,
                    mean_anomaly_deg=mean_anomaly_deg,
                    mean_motion_rev_per_day=mean_motion,
                    epoch=epoch,
                    international_designator=int_des,
                    element_set_number=args.element_set_number,
                    revolution_number=plane_index * args.sats_per_plane + slot_number,
                )
            )

    return entries


def write_output(entries: list[TLEEntry], output_path: str | None) -> None:
    content = "\n".join(generate_tle(entry) for entry in entries)
    if output_path:
        Path(output_path).write_text(content + "\n", encoding="utf-8")
        print(f"Wrote {len(entries)} TLE entries to {output_path}")
        return
    print(content)


def add_common_orbital_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--epoch", default="2026-04-03T00:00:00Z", help="Epoch in ISO-8601 format, for example 2026-04-03T00:00:00Z")
    parser.add_argument("--inclination-deg", type=float, required=True, help="Orbital inclination in degrees")
    parser.add_argument("--eccentricity", type=float, default=0.0, help="Orbital eccentricity in [0, 1)")
    parser.add_argument("--arg-perigee-deg", type=float, default=0.0, help="Argument of perigee in degrees")
    parser.add_argument("--element-set-number", type=int, default=999, help="TLE element set number")

    mean_motion_group = parser.add_mutually_exclusive_group(required=True)
    mean_motion_group.add_argument("--mean-motion", type=float, help="Mean motion in revolutions per day")
    mean_motion_group.add_argument("--altitude-km", type=float, help="Approximate circular-orbit altitude in km; mean motion will be derived")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Parameterized TLE generator for single satellites and Walker constellations")
    subparsers = parser.add_subparsers(dest="mode", required=True)

    single_parser = subparsers.add_parser("single", help="Generate a TLE for a single satellite")
    single_parser.add_argument("--name", required=True, help="Satellite name")
    single_parser.add_argument("--sat-num", type=int, required=True, help="Satellite catalog number")
    single_parser.add_argument("--raan-deg", type=float, required=True, help="Right ascension of ascending node in degrees")
    single_parser.add_argument("--mean-anomaly-deg", type=float, default=0.0, help="Mean anomaly in degrees")
    single_parser.add_argument("--international-designator", help="International designator, up to 8 characters")
    single_parser.add_argument("--intl-designator-prefix", default="26001", help="Prefix used when no explicit international designator is provided")
    single_parser.add_argument("--revolution-number", type=int, default=1, help="Revolution number at epoch")
    single_parser.add_argument("--output", help="Optional output path for the generated TLE file")
    add_common_orbital_args(single_parser)

    walker_parser = subparsers.add_parser("walker", help="Generate a Walker-style constellation TLE set")
    walker_parser.add_argument("--planes", type=int, required=True, help="Number of orbital planes")
    walker_parser.add_argument("--sats-per-plane", type=int, required=True, help="Satellites per plane")
    walker_parser.add_argument("--start-sat-num", type=int, default=91001, help="Starting satellite catalog number")
    walker_parser.add_argument("--raan-span-deg", type=float, default=360.0, help="RAAN span across all planes in degrees")
    walker_parser.add_argument("--base-raan-deg", type=float, default=0.0, help="Starting RAAN in degrees")
    walker_parser.add_argument("--base-mean-anomaly-deg", type=float, default=0.0, help="Base mean anomaly in degrees")
    walker_parser.add_argument("--phase-factor", type=float, default=1.0, help="Walker phase factor")
    walker_parser.add_argument("--inter-plane-slot-offset-deg", type=float, help="Direct mean-anomaly offset in degrees between adjacent planes for the same slot index")
    walker_parser.add_argument("--name-pattern", default="SIM_SAT_{plane}_{slot}", help="Satellite naming pattern using {plane}, {slot}, {sat}")
    walker_parser.add_argument("--intl-designator-prefix", default="26001", help="International designator prefix")
    walker_parser.add_argument("--output", help="Optional output path for the generated TLE file")
    add_common_orbital_args(walker_parser)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.mode == "single":
        write_output([build_single_entry(args)], args.output)
        return
    if args.mode == "walker":
        write_output(build_walker_entries(args), args.output)
        return
    raise ValueError(f"Unsupported mode: {args.mode}")


if __name__ == "__main__":
    main()