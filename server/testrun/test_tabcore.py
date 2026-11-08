"""Run: python3 -m unittest discover -s server/testrun -v   (stdlib only)"""

import unittest

import tabcore as tc


def note(t, midi, dur=0.2, amp=0.8):
    return {"t": t, "end": t + dur, "midi": midi, "amp": amp, "flags": [], "bend_to": None}


class Basics(unittest.TestCase):
    def test_note_names(self):
        self.assertEqual(tc.note_to_midi("E2"), 40)
        self.assertEqual(tc.note_to_midi("e4"), 64)
        self.assertEqual(tc.note_to_midi("Bb3"), 58)
        self.assertEqual(tc.midi_to_name(64), "E4")

    def test_tuning(self):
        self.assertEqual(tc.parse_tuning("standard"), [40, 45, 50, 55, 59, 64])
        self.assertEqual(tc.parse_tuning("D2 A2 D3 G3 B3 E4")[0], 38)
        with self.assertRaises(ValueError):
            tc.parse_tuning("E4 B3 G3 D3 A2 E2")

    def test_time(self):
        self.assertEqual(tc.parse_time("2:05"), 125.0)
        self.assertEqual(tc.parse_time("1:02:03.5"), 3723.5)
        self.assertEqual(tc.parse_time(42), 42.0)
        self.assertEqual(tc.fmt_time(125.25), "2:05.2")

    def test_grouping(self):
        groups = tc.group_notes([note(1.0, 40), note(1.02, 47), note(1.5, 52), note(1.01, 40)])
        self.assertEqual([[n["midi"] for n in g] for g in groups], [[40, 47], [52]])


class LeadFilter(unittest.TestCase):
    def test_merges_retriggers_and_drops_accompaniment(self):
        def n(t, end, midi, amp):
            return {"t": t, "end": end, "midi": midi, "amp": amp, "flags": [], "bend_to": None}

        notes = [
            n(1.00, 1.50, 78, 0.74), n(1.50, 1.67, 78, 0.75), n(1.67, 2.00, 78, 0.70),  # held F#5 re-triggered
            n(1.20, 1.60, 50, 0.40),                                                    # D3 under the lead
            n(2.10, 2.30, 76, 0.70), n(2.35, 2.55, 76, 0.72),                           # real repeated pick
            n(2.60, 2.70, 74, 0.65), n(2.80, 3.00, 79, 0.70),
            n(3.20, 3.60, 45, 0.33),                                                    # A2 while the lead rests
            n(3.70, 3.90, 64, 0.70),                                                    # low but loud: kept
        ]
        kept, counts = tc.lead_filter(notes)
        self.assertEqual([(x["midi"], round(x["end"], 2)) for x in kept],
                         [(78, 2.0), (76, 2.3), (76, 2.55), (74, 2.7), (79, 3.0), (64, 3.9)])
        self.assertEqual(counts, {"merged": 2, "under_lead": 1, "below_register": 1})


class FretMapping(unittest.TestCase):
    STD = tc.parse_tuning("standard")

    def test_pitch_preserved_and_stays_in_position(self):
        # A bluesy B-minor phrase high on the neck (B4 D5 E5 F#5 E5 D5 B4 A4 B4).
        pitches = [71, 74, 76, 78, 76, 74, 71, 69, 71]
        groups = tc.group_notes([note(0.25 * i, p) for i, p in enumerate(pitches)])
        mapped, dropped = tc.map_frets(groups, self.STD, kind="lead")
        self.assertEqual(dropped, [])
        notes = [g[0] for g in mapped]
        for n in notes:
            self.assertEqual(self.STD[n["string"]] + n["fret"], n["midi"])
        frets = [n["fret"] for n in notes]
        self.assertLessEqual(max(frets) - min(frets), 5, frets)

    def test_below_lowest_string_is_flagged(self):
        groups = tc.group_notes([note(0, 38), note(0.5, 45)])
        mapped, dropped = tc.map_frets(groups, self.STD)
        self.assertEqual([n["midi"] for n in dropped], [38])
        self.assertIn("out-of-range", dropped[0]["flags"])
        mapped, dropped = tc.map_frets(tc.group_notes([note(0, 38)]), tc.parse_tuning("drop-d"))
        self.assertEqual((mapped[0][0]["string"], mapped[0][0]["fret"]), (0, 0))

    def test_power_chord_on_distinct_strings(self):
        groups = tc.group_notes([note(0, 40), note(0.01, 47), note(0.02, 52)])
        mapped, _ = tc.map_frets(groups, self.STD, kind="riff")
        strings = [n["string"] for n in mapped[0]]
        self.assertEqual(len(set(strings)), 3)
        self.assertEqual([(n["string"], n["fret"]) for n in mapped[0]], [(0, 0), (1, 2), (2, 2)])


class PyinCheck(unittest.TestCase):
    def track(self, pitch_fn, start=0.0, end=1.0, hop=0.01):
        times = [start + i * hop for i in range(int((end - start) / hop))]
        return times, [pitch_fn(t) for t in times], [0.9] * len(times)

    def test_agree_and_bend(self):
        groups = [[note(0.1, 74, dur=0.5)]]
        times, f0, prob = self.track(lambda t: 74.0 if t < 0.3 else 76.0)
        stats = tc.reconcile_with_pyin(groups, times, f0, prob)
        n = groups[0][0]
        self.assertEqual(stats["agree"], 1)
        self.assertEqual(n["bend_to"], 76)
        self.assertNotIn("pitch-disagree", n["flags"])

    def test_octave_and_unvoiced(self):
        a, b = [note(0.1, 62, dur=0.3)], [note(0.6, 70, dur=0.3)]
        times, f0, prob = self.track(lambda t: 74.0 if t < 0.5 else None)
        tc.reconcile_with_pyin([a, b], times, f0, prob)
        self.assertIn("octave?", a[0]["flags"])
        self.assertIn("pyin-unvoiced", b[0]["flags"])


class TabLayout(unittest.TestCase):
    STD = tc.parse_tuning("standard")

    def test_grid(self):
        slots, bpm = tc.sixteenth_grid([0.5 * i for i in range(20)], 2.1, 4.0)
        self.assertAlmostEqual(bpm, 120.0)
        self.assertAlmostEqual(slots[0], 2.0)
        self.assertAlmostEqual(slots[1] - slots[0], 0.125)
        self.assertGreaterEqual(slots[-1], 4.0)

    def test_render_and_parse_back(self):
        pitches = [71, 74, 76, 78, 76, 74, 71, 69]
        notes = [note(2.0 + 0.25 * i, p) for i, p in enumerate(pitches)]
        notes[2]["bend_to"] = 78
        notes[5]["flags"].append("pitch-disagree")
        mapped, _ = tc.map_frets(tc.group_notes(notes), self.STD)
        slots, _ = tc.sixteenth_grid([0.5 * i for i in range(20)], 2.0, 4.0)
        placed = tc.place_on_grid(mapped, slots)
        text = tc.render_tab(placed, slots, self.STD)
        lines = text.splitlines()
        self.assertTrue(lines[1].startswith("e|"))
        self.assertTrue(lines[6].startswith("E|"))
        self.assertIn("b", text)
        self.assertIn("?", lines[7])
        back = tc.parse_ascii_tab(text, self.STD)
        self.assertEqual([(n["string"], n["fret"]) for n in back],
                         [(n["string"], n["fret"]) for g in mapped for n in g])


class Reference(unittest.TestCase):
    STD = tc.parse_tuning("standard")

    def test_parse_symbols(self):
        tab = """
e|-------------------|
B|--15b17--15r13-----|
G|--------------14h16|
D|-------------------|
A|-------------------|
E|-------------------|
"""
        notes = tc.parse_ascii_tab(tab, self.STD)
        self.assertEqual([(n["string"], n["fret"]) for n in notes], [(4, 15), (4, 15), (3, 14), (3, 16)])

    def test_score(self):
        ref = [{"midi": m, "string": 4, "fret": m - 59} for m in [74, 76, 78, 76, 74]]
        ours = [dict(r) for r in ref]
        ours.insert(2, {"midi": 60, "string": 4, "fret": 1})  # one extra note
        ours[-1] = {"midi": 74, "string": 3, "fret": 19}  # right pitch, other string
        s = tc.score_against_reference(ref, ours)
        self.assertEqual(s["matched"], 5)
        self.assertAlmostEqual(s["recall"], 1.0)
        self.assertAlmostEqual(s["precision"], 5 / 6)
        self.assertAlmostEqual(s["same_string_fret"], 4 / 5)


if __name__ == "__main__":
    unittest.main()
