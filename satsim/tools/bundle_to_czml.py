from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SATELLITE_POINT_RGBA = [255, 227, 110, 255]
AIRCRAFT_POINT_RGBA = [94, 234, 212, 255]
GROUND_STATION_POINT_RGBA = [255, 140, 105, 255]
SATELLITE_PATH_RGBA = [255, 227, 110, 190]
AIRCRAFT_PATH_RGBA = [125, 211, 252, 255]
GROUND_STATION_OUTLINE_RGBA = [15, 23, 42, 255]

SATELLITE_MODEL_URI = "/tdrs.glb"
AIRCRAFT_MODEL_URI = "/Airplane.glb"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a satsim simulation bundle to CZML and bundle JSON.")
    parser.add_argument("--bundle", required=True, help="Input simulation bundle JSON path")
    parser.add_argument("--czml", required=True, help="Output CZML file path")
    parser.add_argument("--bundle-json", help="Optional output bundle JSON path for topology/route metrics payload")
    parser.add_argument("--js", help="Optional output JS module path that exports the CZML array")
    parser.add_argument(
        "--multiplier",
        type=float,
        default=18.0,
        help="Clock multiplier for the generated CZML document packet",
    )
    return parser.parse_args()


def load_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def packet_interval(start_time: datetime, duration_s: float) -> tuple[str, str]:
    stop_time = start_time + timedelta(seconds=float(duration_s))
    interval = f"{isoformat_utc(start_time)}/{isoformat_utc(stop_time)}"
    return interval, isoformat_utc(stop_time)


def node_visuals(node_type: str) -> dict[str, Any]:
    if node_type == "satellite":
        return {
            "point": {
                "color": {"rgba": SATELLITE_POINT_RGBA},
                "pixelSize": 5,
                "outlineColor": {"rgba": [0, 0, 0, 180]},
                "outlineWidth": 1,
            },
            "path": {
                "material": {
                    "polylineGlow": {
                        "color": {"rgba": SATELLITE_PATH_RGBA},
                        "glowPower": 0.18,
                    }
                },
                "width": 1,
                "show": True,
                "leadTime": 240,
                "trailTime": 900,
                "resolution": 60,
            },
            "model": {
                "gltf": SATELLITE_MODEL_URI,
                "scale": 0.22,
                "minimumPixelSize": 12,
                "maximumScale": 2500,
            },
            "label": {
                "fillColor": {"rgba": SATELLITE_POINT_RGBA},
                "outlineColor": {"rgba": [0, 0, 0, 255]},
                "outlineWidth": 3,
                "font": "16px Segoe UI",
                "style": "FILL_AND_OUTLINE",
                "pixelOffset": {"cartesian2": [0, -36]},
                "showBackground": False,
            },
        }

    if node_type == "aircraft":
        return {
            "point": {
                "color": {"rgba": AIRCRAFT_POINT_RGBA},
                "pixelSize": 8,
                "outlineColor": {"rgba": [255, 255, 255, 255]},
                "outlineWidth": 1,
            },
            "path": {
                "material": {
                    "polylineGlow": {
                        "color": {"rgba": AIRCRAFT_PATH_RGBA},
                        "glowPower": 0.25,
                    }
                },
                "width": 2,
                "show": True,
                "leadTime": 120,
                "trailTime": 500,
                "resolution": 30,
            },
            "model": {
                "gltf": AIRCRAFT_MODEL_URI,
                "scale": 120,
                "minimumPixelSize": 180,
                "maximumScale": 120000,
            },
            "label": {
                "fillColor": {"rgba": [255, 255, 255, 255]},
                "outlineColor": {"rgba": [0, 0, 0, 255]},
                "outlineWidth": 3,
                "font": "14px Segoe UI",
                "style": "FILL_AND_OUTLINE",
                "pixelOffset": {"cartesian2": [0, -45]},
                "showBackground": False,
            },
        }

    return {
        "point": {
            "color": {"rgba": GROUND_STATION_POINT_RGBA},
            "pixelSize": 12,
            "outlineColor": {"rgba": GROUND_STATION_OUTLINE_RGBA},
            "outlineWidth": 2,
        },
        "label": {
            "fillColor": {"rgba": [255, 255, 255, 255]},
            "outlineColor": {"rgba": [0, 0, 0, 255]},
            "outlineWidth": 3,
            "font": "13px Segoe UI",
            "style": "FILL_AND_OUTLINE",
            "pixelOffset": {"cartesian2": [0, -34]},
            "showBackground": False,
        },
    }


def build_document_packet(metadata: dict[str, Any], multiplier: float) -> dict[str, Any]:
    start_time = parse_datetime(metadata["start_time"])
    duration_s = float(metadata["duration_s"])
    interval, stop_time = packet_interval(start_time, duration_s)
    return {
        "id": "document",
        "name": "satsim bundle",
        "version": "1.0",
        "clock": {
            "interval": interval,
            "currentTime": isoformat_utc(start_time),
            "multiplier": multiplier,
            "range": "LOOP_STOP",
            "step": "SYSTEM_CLOCK_MULTIPLIER",
        },
        "properties": {
            "schemaVersion": metadata.get("schema_version"),
            "outputMode": metadata.get("output_mode"),
            "bundleEndTime": stop_time,
        },
    }


def build_position_samples(samples: list[dict[str, Any]]) -> list[float]:
    values: list[float] = []
    for sample in samples:
        values.extend(
            [
                float(sample["relative_time_s"]),
                float(sample["lon_deg"]),
                float(sample["lat_deg"]),
                float(sample["alt_km"]) * 1000.0,
            ]
        )
    return values


def build_node_packet(track: dict[str, Any], interval: str) -> dict[str, Any]:
    node_id = str(track["id"])
    node_type = str(track["type"])
    visuals = node_visuals(node_type)
    packet: dict[str, Any] = {
        "id": node_id,
        "name": node_id,
        "availability": interval,
        "properties": {
            "nodeType": node_type,
        },
        "position": {
            "interpolationAlgorithm": "LAGRANGE",
            "interpolationDegree": 1,
            "epoch": interval.split("/", maxsplit=1)[0],
            "cartographicDegrees": build_position_samples(list(track.get("samples", []))),
        },
        "label": {
            **visuals["label"],
            "text": node_id,
        },
        "point": visuals["point"],
    }

    if "path" in visuals:
        packet["path"] = visuals["path"]
    if "model" in visuals:
        packet["model"] = visuals["model"]
    return packet


def build_czml(bundle: dict[str, Any], multiplier: float) -> list[dict[str, Any]]:
    metadata = dict(bundle["metadata"])
    start_time = parse_datetime(metadata["start_time"])
    duration_s = float(metadata["duration_s"])
    interval, _ = packet_interval(start_time, duration_s)

    packets = [build_document_packet(metadata, multiplier)]
    for track in bundle.get("node_tracks", []):
        packets.append(build_node_packet(dict(track), interval))
    return packets


def ensure_parent(path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def js_identifier_from_path(path: str | Path) -> str:
    raw = Path(path).stem
    normalized = re.sub(r"[^0-9A-Za-z_]+", "_", raw)
    if not normalized:
        normalized = "satsimCzml"
    if normalized[0].isdigit():
        normalized = f"czml_{normalized}"
    return normalized


def write_json(path: str | Path, data: Any) -> None:
    ensure_parent(path)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_js_module(path: str | Path, data: Any) -> None:
    ensure_parent(path)
    identifier = js_identifier_from_path(path)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    content = (
        f"export const {identifier} = {payload};\n\n"
        f"export default {identifier};\n"
    )
    Path(path).write_text(content, encoding="utf-8")


def main() -> None:
    args = parse_args()
    bundle = load_json(args.bundle)
    czml = build_czml(bundle, multiplier=float(args.multiplier))
    write_json(args.czml, czml)
    if args.bundle_json:
        write_json(args.bundle_json, bundle)
    if args.js:
        write_js_module(args.js, czml)


if __name__ == "__main__":
    main()
