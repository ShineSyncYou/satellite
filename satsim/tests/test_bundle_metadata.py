from __future__ import annotations

import json
import unittest
from dataclasses import replace
from pathlib import Path

from satellite_sim.config import PreparedSimulationAssets, load_simulation_config
from satellite_sim.main import SCHEMA_VERSION, _build_metadata


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "data" / "sample_config_gw2_400sat_5ac_1gs_3GEO.json"
SCHEMA_PATH = ROOT / "schemas" / "simulation_output_bundle.schema.json"


class BundleMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_simulation_config(CONFIG_PATH)
        self.assets = PreparedSimulationAssets(
            satellites={},
            aircraft_traj_funcs={},
            ground_stations=[],
        )

    def test_metadata_contains_effective_beam_angles(self) -> None:
        metadata = _build_metadata(self.config, self.assets)

        self.assertEqual(SCHEMA_VERSION, "1.5.0")
        self.assertEqual(
            metadata["beam"],
            {
                "sat_antenna_angle_deg": 35.0,
                "geo_sat_antenna_angle_deg": 8.0,
            },
        )

    def test_geo_beam_angle_falls_back_to_leo_angle(self) -> None:
        config_without_geo_angle = replace(
            self.config,
            geo_sat_antenna_angle=None,
        )

        metadata = _build_metadata(config_without_geo_angle, self.assets)

        self.assertEqual(
            metadata["beam"]["geo_sat_antenna_angle_deg"],
            metadata["beam"]["sat_antenna_angle_deg"],
        )

    def test_bundle_schema_requires_beam_metadata(self) -> None:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        metadata_schema = schema["$defs"]["Metadata"]
        beam_schema = schema["$defs"]["BeamConfig"]

        self.assertIn("beam", metadata_schema["required"])
        self.assertEqual(
            set(beam_schema["required"]),
            {"sat_antenna_angle_deg", "geo_sat_antenna_angle_deg"},
        )


if __name__ == "__main__":
    unittest.main()
