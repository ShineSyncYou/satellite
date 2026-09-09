from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from data.generatetle import TLEEntry, generate_tle
from data.normalize_tle_names import NormalizationSettings, normalize_records, parse_tle_records


EPOCH = datetime(2026, 8, 26, 23, 0, tzinfo=timezone.utc)


def make_tle(
    name: str,
    satnum: int,
    raan_deg: float,
    mean_anomaly_deg: float,
    mean_motion: float = 13.51,
) -> str:
    return generate_tle(
        TLEEntry(
            name=name,
            sat_num=satnum,
            inclination_deg=89.0,
            raan_deg=raan_deg,
            eccentricity=0.0005,
            arg_perigee_deg=0.0,
            mean_anomaly_deg=mean_anomaly_deg,
            mean_motion_rev_per_day=mean_motion,
            epoch=EPOCH,
            international_designator=f"26001{satnum % 10}A",
        )
    )


def parse_content(content: str):
    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "input.tle"
        path.write_text(content + "\n", encoding="utf-8")
        return parse_tle_records(path)


class NormalizeTLENamesTests(unittest.TestCase):
    def test_filters_other_shell_and_assigns_phase_ordered_names(self) -> None:
        blocks = []
        satnum = 91001
        for raan in (10.0, 30.0):
            for anomaly in (270.0, 0.0, 180.0, 90.0):
                blocks.append(make_tle(f"RAW-{satnum}", satnum, raan, anomaly))
                satnum += 1
        blocks.append(make_tle("RAISING", satnum, 10.0, 45.0, mean_motion=14.2))

        result = normalize_records(
            parse_content("\n".join(blocks)),
            NormalizationSettings(
                name_prefix="TEST",
                reference_time=EPOCH,
                max_abs_bstar=None,
                mean_motion_tolerance=0.08,
                altitude_tolerance_km=None,
                plane_cluster_gap_deg=5.0,
            ),
        )

        self.assertEqual(len(result.retained), 8)
        self.assertEqual(len(result.excluded), 1)
        self.assertIn("outside_dominant_mean_motion_shell", result.excluded[0].exclusion_reasons)
        self.assertEqual(
            [record.new_name for record in result.retained[:4]],
            ["TEST_1_1", "TEST_1_2", "TEST_1_3", "TEST_1_4"],
        )
        for plane in (1, 2):
            phases = [record.phase_deg for record in result.retained if record.plane == plane]
            self.assertEqual(phases, sorted(phases))

    def test_plane_numbering_starts_after_largest_raan_gap(self) -> None:
        raan_values = (270, 290, 310, 330, 350, 10, 30, 50, 70)
        blocks = [
            make_tle(f"RAW-{index}", 92000 + index, float(raan), 0.0)
            for index, raan in enumerate(raan_values, start=1)
        ]
        result = normalize_records(
            parse_content("\n".join(blocks)),
            NormalizationSettings(
                name_prefix="TEST",
                reference_time=EPOCH,
                max_abs_bstar=None,
                mean_motion_tolerance=None,
                altitude_tolerance_km=None,
                plane_cluster_gap_deg=5.0,
            ),
        )

        rounded_centers = [round(value) for value in result.plane_centers_deg]
        self.assertEqual(rounded_centers, list(raan_values))

    def test_excludes_sparse_orbital_plane(self) -> None:
        blocks = [
            make_tle(f"FULL-{index}", 93000 + index, 10.0, index * 60.0)
            for index in range(6)
        ]
        blocks.extend(
            make_tle(f"SPARSE-{index}", 93100 + index, 40.0, index * 180.0)
            for index in range(2)
        )
        result = normalize_records(
            parse_content("\n".join(blocks)),
            NormalizationSettings(
                name_prefix="TEST",
                reference_time=EPOCH,
                max_abs_bstar=None,
                mean_motion_tolerance=None,
                altitude_tolerance_km=None,
                plane_cluster_gap_deg=5.0,
                min_plane_size=3,
            ),
        )

        self.assertEqual(len(result.retained), 6)
        self.assertEqual(len(result.excluded), 2)
        self.assertTrue(
            all("sparse_orbital_plane" in record.exclusion_reasons for record in result.excluded)
        )


    def test_preserves_valid_name(self) -> None:
        records = parse_content("\n".join([
            make_tle("KEEP_ME_7_3", 94001, 10.0, 0.0),
            make_tle("RAW-NAME", 94002, 10.0, 180.0),
        ]))
        result = normalize_records(records, NormalizationSettings(
            name_prefix="NEW",
            reference_time=EPOCH,
            max_abs_bstar=None,
            mean_motion_tolerance=None,
            altitude_tolerance_km=None,
        ))
        by_name = {record.original_name: record for record in result.retained}
        self.assertEqual(by_name["KEEP_ME_7_3"].new_name, "KEEP_ME_7_3")
        self.assertEqual((by_name["KEEP_ME_7_3"].plane, by_name["KEEP_ME_7_3"].slot), (7, 3))
        self.assertRegex(by_name["RAW-NAME"].new_name or "", r"^NEW_7_\d+$")
        self.assertNotEqual(by_name["RAW-NAME"].new_name, "NEW_7_3")


if __name__ == "__main__":
    unittest.main()
