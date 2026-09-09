from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Iterable

import numpy as np
from skyfield.api import EarthSatellite, load, wgs84


PLANE_SLOT_NAME_PATTERN = re.compile(r"^.+[_-](\d+)[_-](\d+)$")


@dataclass(slots=True)
class TLERecord:
    original_name: str
    line1: str
    line2: str
    input_index: int
    satnum: int
    epoch: datetime
    inclination_deg: float
    raan_deg: float
    mean_motion_rev_per_day: float
    bstar: float
    altitude_km: float | None = None
    phase_deg: float | None = None
    exclusion_reasons: list[str] = field(default_factory=list)
    new_name: str | None = None
    plane: int | None = None
    slot: int | None = None


@dataclass(frozen=True, slots=True)
class NormalizationSettings:
    name_prefix: str = "SAT"
    reference_time: datetime | None = None
    max_abs_bstar: float | None = 0.1
    mean_motion_tolerance: float | None = 0.08
    altitude_tolerance_km: float | None = 100.0
    plane_cluster_gap_deg: float = 5.0
    min_plane_size: int = 1


@dataclass(slots=True)
class NormalizationResult:
    records: list[TLERecord]
    retained: list[TLERecord]
    excluded: list[TLERecord]
    reference_time: datetime
    shell_center_mean_motion: float | None
    shell_center_altitude_km: float | None
    plane_centers_deg: list[float]


def tle_checksum(line: str) -> int:
    return sum(int(c) if c.isdigit() else 1 if c == "-" else 0 for c in line[:68]) % 10


def has_valid_checksum(line: str) -> bool:
    return len(line) >= 69 and line[68].isdigit() and tle_checksum(line) == int(line[68])


def parse_tle_epoch(line1: str) -> datetime:
    short_year = int(line1[18:20])
    year = 2000 + short_year if short_year < 57 else 1900 + short_year
    day_of_year = float(line1[20:32])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1.0)


def parse_implied_decimal_exponent(raw_value: str) -> float:
    match = re.fullmatch(r"([ +\-])(\d{5})([+\-]\d)", raw_value.rstrip("\r\n"))
    if match is None:
        raise ValueError(f"Invalid implied-decimal TLE value: {raw_value!r}")
    sign = -1.0 if match.group(1) == "-" else 1.0
    return sign * float(f"0.{match.group(2)}") * (10.0 ** int(match.group(3)))


def parse_tle_records(input_path: str | Path) -> list[TLERecord]:
    lines = [
        line.rstrip("\r\n")
        for line in Path(input_path).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if len(lines) % 3 != 0:
        raise ValueError(f"Expected 3-line TLE groups, got {len(lines)} non-empty lines")

    records: list[TLERecord] = []
    for index in range(0, len(lines), 3):
        name, line1, line2 = lines[index : index + 3]
        reasons: list[str] = []
        if not line1.startswith("1 ") or not line2.startswith("2 "):
            reasons.append("invalid_line_prefix")
        if not has_valid_checksum(line1) or not has_valid_checksum(line2):
            reasons.append("checksum_failure")
        try:
            records.append(
                TLERecord(
                    original_name=name.strip(),
                    line1=line1,
                    line2=line2,
                    input_index=index // 3,
                    satnum=int(line1[2:7]),
                    epoch=parse_tle_epoch(line1),
                    inclination_deg=float(line2[8:16]),
                    raan_deg=float(line2[17:25]) % 360.0,
                    mean_motion_rev_per_day=float(line2[52:63]),
                    bstar=parse_implied_decimal_exponent(line1[53:61]),
                    exclusion_reasons=reasons,
                )
            )
        except (ValueError, IndexError) as exc:
            raise ValueError(f"Cannot parse record {index // 3 + 1} ({name!r}): {exc}") from exc
    return records


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def phase_from_position(record: TLERecord, position_km: np.ndarray) -> float:
    raan = math.radians(record.raan_deg)
    inclination = math.radians(record.inclination_deg)
    node_axis = np.asarray([math.cos(raan), math.sin(raan), 0.0])
    quadrature_axis = np.asarray(
        [-math.sin(raan) * math.cos(inclination), math.cos(raan) * math.cos(inclination), math.sin(inclination)]
    )
    x_value = float(np.dot(position_km, node_axis))
    y_value = float(np.dot(position_km, quadrature_axis))
    return math.degrees(math.atan2(y_value, x_value)) % 360.0


def propagate_records(records: Iterable[TLERecord], reference_time: datetime) -> None:
    timescale = load.timescale(builtin=True)
    skyfield_time = timescale.from_datetime(reference_time)
    for record in records:
        if record.exclusion_reasons:
            continue
        satellite = EarthSatellite(record.line1, record.line2, record.original_name, timescale)
        geocentric = satellite.at(skyfield_time)
        if geocentric.message:
            record.exclusion_reasons.append(f"sgp4_error:{geocentric.message}")
            continue
        position = np.asarray(geocentric.position.km, dtype=float)
        altitude = float(wgs84.height_of(geocentric).km)
        if not np.all(np.isfinite(position)) or not math.isfinite(altitude):
            record.exclusion_reasons.append("non_finite_propagation")
            continue
        record.altitude_km = altitude
        record.phase_deg = phase_from_position(record, position)


def densest_window_center(values: list[float], tolerance: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("Cannot determine a dominant shell from no values")
    left = best_left = best_right = 0
    for right, value in enumerate(ordered):
        while value - ordered[left] > 2.0 * tolerance:
            left += 1
        if right - left > best_right - best_left:
            best_left, best_right = left, right
    return float(median(ordered[best_left : best_right + 1]))


def filter_problem_records(
    records: list[TLERecord], settings: NormalizationSettings
) -> tuple[float | None, float | None]:
    if settings.max_abs_bstar is not None:
        for record in records:
            if not record.exclusion_reasons and abs(record.bstar) > settings.max_abs_bstar:
                record.exclusion_reasons.append("bstar_outlier")

    available = [record for record in records if not record.exclusion_reasons]
    motion_center: float | None = None
    if settings.mean_motion_tolerance is not None and available:
        motion_center = densest_window_center(
            [record.mean_motion_rev_per_day for record in available],
            settings.mean_motion_tolerance,
        )
        for record in available:
            if abs(record.mean_motion_rev_per_day - motion_center) > settings.mean_motion_tolerance:
                record.exclusion_reasons.append("outside_dominant_mean_motion_shell")

    available = [record for record in records if not record.exclusion_reasons]
    altitude_center: float | None = None
    if settings.altitude_tolerance_km is not None and available:
        altitudes = [record.altitude_km for record in available if record.altitude_km is not None]
        if altitudes:
            altitude_center = float(median(altitudes))
            for record in available:
                if record.altitude_km is None or abs(record.altitude_km - altitude_center) > settings.altitude_tolerance_km:
                    record.exclusion_reasons.append("outside_dominant_altitude_shell")
    return motion_center, altitude_center


def circular_mean_deg(values: Iterable[float]) -> float:
    angles = [math.radians(value) for value in values]
    x_value = sum(math.cos(value) for value in angles)
    y_value = sum(math.sin(value) for value in angles)
    return math.degrees(math.atan2(y_value, x_value)) % 360.0


def parse_existing_plane_slot(name: str) -> tuple[int, int] | None:
    match = PLANE_SLOT_NAME_PATTERN.fullmatch(name.strip())
    if match is None:
        return None
    plane, slot = int(match.group(1)), int(match.group(2))
    if plane < 1 or slot < 1:
        return None
    return plane, slot


def cluster_orbital_planes(
    records: list[TLERecord], max_gap_deg: float
) -> list[list[TLERecord]]:
    if not 0.0 < max_gap_deg < 180.0:
        raise ValueError("plane_cluster_gap_deg must be in (0, 180)")
    if not records:
        return []

    ordered = sorted(records, key=lambda record: (record.raan_deg, record.satnum))
    clusters: list[list[TLERecord]] = [[ordered[0]]]
    for record in ordered[1:]:
        if record.raan_deg - clusters[-1][-1].raan_deg <= max_gap_deg:
            clusters[-1].append(record)
        else:
            clusters.append([record])

    if len(clusters) > 1:
        wrap_gap = clusters[0][0].raan_deg + 360.0 - clusters[-1][-1].raan_deg
        if wrap_gap <= max_gap_deg:
            clusters = [clusters[-1] + clusters[0], *clusters[1:-1]]

    centers = [circular_mean_deg(record.raan_deg for record in cluster) for cluster in clusters]
    order = sorted(range(len(clusters)), key=lambda index: centers[index])
    clusters = [clusters[index] for index in order]
    centers = [centers[index] for index in order]

    if len(clusters) > 1:
        gaps = [
            ((centers[(index + 1) % len(centers)] - centers[index]) % 360.0, index)
            for index in range(len(centers))
        ]
        _, largest_gap_index = max(gaps)
        start = (largest_gap_index + 1) % len(clusters)
        clusters = clusters[start:] + clusters[:start]
    return clusters


def assign_plane_slot_names(
    clusters: list[list[TLERecord]], prefix: str
) -> list[float]:
    clean_prefix = prefix.strip().rstrip("_-")
    if not clean_prefix:
        raise ValueError("name_prefix must not be empty")

    centers = [
        circular_mean_deg(record.raan_deg for record in cluster)
        for cluster in clusters
    ]
    used_plane_slots: set[tuple[int, int]] = set()
    anchored_planes: list[set[int]] = []
    for cluster in clusters:
        cluster_anchors: set[int] = set()
        for record in cluster:
            existing = parse_existing_plane_slot(record.original_name)
            if existing is None:
                continue
            record.plane, record.slot = existing
            record.new_name = record.original_name
            used_plane_slots.add(existing)
            cluster_anchors.add(existing[0])
        anchored_planes.append(cluster_anchors)

    reserved_plane_numbers = set().union(*anchored_planes) if anchored_planes else set()
    generated_plane_numbers: set[int] = set()
    for inferred_plane, (cluster, cluster_anchors) in enumerate(
        zip(clusters, anchored_planes), start=1
    ):
        if len(cluster_anchors) == 1:
            target_plane = next(iter(cluster_anchors))
        else:
            target_plane = inferred_plane
            while (
                target_plane in reserved_plane_numbers
                or target_plane in generated_plane_numbers
            ):
                target_plane += 1
            generated_plane_numbers.add(target_plane)

        ordered = sorted(
            cluster,
            key=lambda record: (
                record.phase_deg if record.phase_deg is not None else math.inf,
                record.satnum,
            ),
        )
        for inferred_slot, record in enumerate(ordered, start=1):
            if record.new_name is not None:
                continue
            slot = inferred_slot
            while (target_plane, slot) in used_plane_slots:
                slot += 1
            record.plane = target_plane
            record.slot = slot
            record.new_name = f"{clean_prefix}_{target_plane}_{slot}"
            used_plane_slots.add((target_plane, slot))
    return centers


def normalize_records(
    records: list[TLERecord], settings: NormalizationSettings
) -> NormalizationResult:
    if not records:
        raise ValueError("No TLE records were found")
    reference_time = (
        settings.reference_time or max(record.epoch for record in records)
    ).astimezone(timezone.utc)
    propagate_records(records, reference_time)
    motion_center, altitude_center = filter_problem_records(records, settings)
    retained = [record for record in records if not record.exclusion_reasons]
    if not retained:
        raise ValueError("All records were excluded; relax filter settings and retry")
    clusters = cluster_orbital_planes(retained, settings.plane_cluster_gap_deg)
    if settings.min_plane_size < 1:
        raise ValueError("min_plane_size must be at least 1")
    if settings.min_plane_size > 1:
        for cluster in clusters:
            if len(cluster) < settings.min_plane_size:
                for record in cluster:
                    record.exclusion_reasons.append("sparse_orbital_plane")
        retained = [record for record in retained if not record.exclusion_reasons]
        if not retained:
            raise ValueError("All records were excluded by min_plane_size")
        clusters = cluster_orbital_planes(retained, settings.plane_cluster_gap_deg)

    seen_existing_slots: set[tuple[int, int]] = set()
    for record in sorted(retained, key=lambda item: item.input_index):
        existing = parse_existing_plane_slot(record.original_name)
        if existing is None:
            continue
        if existing in seen_existing_slots:
            record.exclusion_reasons.append("duplicate_existing_plane_slot")
        else:
            seen_existing_slots.add(existing)
    retained = [record for record in retained if not record.exclusion_reasons]
    if not retained:
        raise ValueError("All records were excluded by duplicate plane/slot identifiers")
    clusters = cluster_orbital_planes(retained, settings.plane_cluster_gap_deg)
    centers = assign_plane_slot_names(clusters, settings.name_prefix)
    retained.sort(key=lambda record: (record.plane or 0, record.slot or 0))
    excluded = sorted(
        (record for record in records if record.exclusion_reasons),
        key=lambda record: record.input_index,
    )
    return NormalizationResult(
        records=records,
        retained=retained,
        excluded=excluded,
        reference_time=reference_time,
        shell_center_mean_motion=motion_center,
        shell_center_altitude_km=altitude_center,
        plane_centers_deg=centers,
    )


def write_normalized_tle(
    result: NormalizationResult, output_path: str | Path
) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    blocks = [
        f"{record.new_name}\n{record.line1}\n{record.line2}"
        for record in result.retained
    ]
    output.write_text("\n".join(blocks) + "\n", encoding="utf-8")


def record_details(record: TLERecord) -> dict[str, object]:
    return {
        "original_name": record.original_name,
        "satnum": record.satnum,
        "raan_deg": round(record.raan_deg, 6),
        "mean_motion_rev_per_day": round(record.mean_motion_rev_per_day, 9),
        "altitude_km_at_reference": (
            round(record.altitude_km, 3)
            if record.altitude_km is not None
            else None
        ),
        "bstar": record.bstar,
    }


def build_report(
    result: NormalizationResult,
    settings: NormalizationSettings,
    input_path: Path,
    output_path: Path,
) -> dict[str, object]:
    plane_sizes: dict[str, int] = {}
    for record in result.retained:
        key = str(record.plane)
        plane_sizes[key] = plane_sizes.get(key, 0) + 1
    return {
        "input_file": str(input_path.resolve()),
        "output_file": str(output_path.resolve()),
        "reference_time": format_utc(result.reference_time),
        "settings": {
            "name_prefix": settings.name_prefix,
            "max_abs_bstar": settings.max_abs_bstar,
            "mean_motion_tolerance_rev_per_day": settings.mean_motion_tolerance,
            "altitude_tolerance_km": settings.altitude_tolerance_km,
            "plane_cluster_gap_deg": settings.plane_cluster_gap_deg,
            "min_plane_size": settings.min_plane_size,
            "preserve_existing_plane_slot_names": True,
        },
        "summary": {
            "input_satellites": len(result.records),
            "retained_satellites": len(result.retained),
            "excluded_satellites": len(result.excluded),
            "plane_count": len(result.plane_centers_deg),
            "plane_sizes": plane_sizes,
            "plane_centers_raan_deg": [
                round(value, 6) for value in result.plane_centers_deg
            ],
            "dominant_shell_mean_motion_rev_per_day": result.shell_center_mean_motion,
            "dominant_shell_altitude_km": result.shell_center_altitude_km,
        },
        "renames": [
            {
                **record_details(record),
                "new_name": record.new_name,
                "plane": record.plane,
                "slot": record.slot,
                "phase_deg_at_reference": round(record.phase_deg or 0.0, 6),
            }
            for record in result.retained
        ],
        "exclusions": [
            {
                **record_details(record),
                "reasons": record.exclusion_reasons,
            }
            for record in result.excluded
        ],
    }


def parse_reference_time(raw_value: str | None) -> datetime | None:
    if raw_value is None:
        return None
    parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def optional_nonnegative_float(raw_value: str) -> float | None:
    value = float(raw_value)
    return None if value < 0.0 else value


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Filter and rename a 3-line TLE catalog as "
            "PREFIX_plane_slot at a common epoch"
        )
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--name-prefix", default="SAT")
    parser.add_argument(
        "--reference-time",
        help="ISO-8601 time; default is the latest TLE epoch",
    )
    parser.add_argument(
        "--max-abs-bstar",
        type=optional_nonnegative_float,
        default=0.1,
        help="Exclude |B*| above this value; negative disables",
    )
    parser.add_argument(
        "--mean-motion-tolerance",
        type=optional_nonnegative_float,
        default=0.08,
        help="Keep the densest shell within this +/- rev/day; negative disables",
    )
    parser.add_argument(
        "--altitude-tolerance-km",
        type=optional_nonnegative_float,
        default=100.0,
        help="Keep satellites this close to shell median; negative disables",
    )
    parser.add_argument(
        "--plane-cluster-gap-deg",
        type=float,
        default=5.0,
        help="Maximum circular RAAN separation inside one plane",
    )
    parser.add_argument(
        "--min-plane-size",
        type=int,
        default=1,
        help="Exclude an orbital plane with fewer satellites than this (default: 1)",
    )
    return parser


def main() -> None:
    args = build_argument_parser().parse_args()
    input_path = args.input.resolve()
    output_path = args.output.resolve()
    report_path = (
        args.report.resolve()
        if args.report is not None
        else output_path.with_name(f"{output_path.stem}_report.json")
    )
    settings = NormalizationSettings(
        name_prefix=args.name_prefix,
        reference_time=parse_reference_time(args.reference_time),
        max_abs_bstar=args.max_abs_bstar,
        mean_motion_tolerance=args.mean_motion_tolerance,
        altitude_tolerance_km=args.altitude_tolerance_km,
        plane_cluster_gap_deg=args.plane_cluster_gap_deg,
        min_plane_size=args.min_plane_size,
    )
    result = normalize_records(parse_tle_records(input_path), settings)
    write_normalized_tle(result, output_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(
            build_report(result, settings, input_path, output_path),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Input satellites: {len(result.records)}")
    print(f"Retained satellites: {len(result.retained)}")
    print(f"Excluded satellites: {len(result.excluded)}")
    print(f"Detected planes: {len(result.plane_centers_deg)}")
    print(f"Reference time: {format_utc(result.reference_time)}")
    print(f"Wrote normalized TLE: {output_path}")
    print(f"Wrote audit report: {report_path}")


if __name__ == "__main__":
    main()
