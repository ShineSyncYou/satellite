from __future__ import annotations

import unittest

from result_player.playback_3d import build_arg_parser, load_bundle_beam_angles


class PlaybackBeamMetadataTests(unittest.TestCase):
    def test_reads_distinct_leo_and_geo_angles_from_bundle(self) -> None:
        bundle = {
            "metadata": {
                "beam": {
                    "sat_antenna_angle_deg": 35.0,
                    "geo_sat_antenna_angle_deg": 8.0,
                }
            }
        }

        beam_angles = load_bundle_beam_angles(bundle)

        self.assertEqual(beam_angles.for_satellite("sat_1_1"), 35.0)
        self.assertEqual(beam_angles.for_satellite("sat_geo_1"), 8.0)

    def test_missing_beam_metadata_requires_bundle_regeneration(self) -> None:
        with self.assertRaisesRegex(ValueError, "metadata.beam is missing"):
            load_bundle_beam_angles({"metadata": {}})

    def test_rejects_invalid_beam_angle(self) -> None:
        bundle = {
            "metadata": {
                "beam": {
                    "sat_antenna_angle_deg": 90.0,
                    "geo_sat_antenna_angle_deg": 8.0,
                }
            }
        }

        with self.assertRaisesRegex(ValueError, r"within \[0, 90\)"):
            load_bundle_beam_angles(bundle)

    def test_command_line_no_longer_accepts_cone_angle(self) -> None:
        parser = build_arg_parser()
        argument_names = {action.dest for action in parser._actions}

        self.assertNotIn("cone_angle_deg", argument_names)
        self.assertIn("frame_interval", argument_names)


if __name__ == "__main__":
    unittest.main()
