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

    def test_pick_transcriber(self):
        self.assertEqual(tc.pick_transcriber("lead", muscriptor_ok=True), "muscriptor")
        self.assertEqual(tc.pick_transcriber("riff"), "yourmt3")
        self.assertEqual(tc.pick_transcriber("lead"), "basicpitch")
        self.assertEqual(tc.pick_transcriber("riff", "basicpitch"), "basicpitch")
        with self.assertRaises(ValueError):
            tc.pick_transcriber("lead", "mt3")

    def test_muscriptor_events_and_lead_class(self):
        ev = [{"type": "start", "index": 0, "pitch": 55, "start_time": 1.0, "instrument": "acoustic_guitar"},
              {"type": "start", "index": 1, "pitch": 76, "start_time": 1.0, "instrument": "distorted_electric_guitar"},
              {"type": "end", "start_event_index": 0, "end_time": 1.5},
              {"type": "start", "index": 2, "pitch": 36, "start_time": 1.2, "instrument": "drums"}]
        notes = tc.muscriptor_events_to_notes(ev)
        self.assertEqual([(n["midi"], n["end"]) for n in notes], [(55, 1.5), (76, 1.25), (36, 1.45)])
        rhythm = [dict(n, midi=55 + i % 5, t=i * 0.1) for i, n in enumerate([notes[0]] * 30)]
        lead = [dict(notes[1], midi=74 + i % 5, t=i * 0.2) for i in range(12)]
        got, _ = tc.pick_guitar_notes(rhythm + lead + [notes[2]], "lead")
        self.assertEqual({n["instrument"] for n in got}, {"distorted_electric_guitar"})
        got, _ = tc.pick_guitar_notes(rhythm + lead + [notes[2]], "riff")
        self.assertEqual(len(got), 42)  # every guitar note, no drums

    def test_tuning_letters(self):
        dadfae = [38, 45, 50, 53, 57, 64]  # D2 A2 D3 F3 A3 E4
        self.assertEqual(tc.parse_tuning("DADFAE"), dadfae)
        self.assertEqual(tc.parse_tuning("dadfae"), dadfae)
        self.assertEqual(tc.parse_tuning("D A D F A E"), dadfae)
        self.assertEqual(tc.parse_tuning("DADGAD"), [38, 45, 50, 55, 57, 62])
        self.assertEqual(tc.parse_tuning("EADGBE"), tc.parse_tuning("standard"))
        self.assertEqual(tc.parse_tuning("Eb Ab Db Gb Bb Eb"), tc.parse_tuning("eb-standard"))
        self.assertEqual(tc.parse_tuning("EbAbDbGbBbEb"), tc.parse_tuning("eb-standard"))  # 'b' after a letter = flat
        self.assertEqual(tc.parse_tuning("CGCFAD"), tc.parse_tuning("drop-c"))

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
        self.assertEqual(counts, {"merged": 2, "under_lead": 1, "below_register": 1, "echo_delay": None, "echoes": 0})

    def test_delay_echoes(self):
        # A phrase through a 380 ms delay: every note comes back at 60% volume (and again at 2x).
        line = [(0.0, 74), (0.5, 76), (0.9, 78), (1.6, 76), (2.0, 74), (2.7, 71), (3.1, 74), (3.6, 76), (4.3, 78),
                (4.8, 79), (5.5, 78), (6.0, 76)]
        played = [note(t, m, dur=0.3, amp=0.8) for t, m in line]
        echoes = [note(t + k * 0.38, m, dur=0.3, amp=0.8 * 0.6 ** k) for t, m in line for k in (1, 2)]
        delay = tc.find_echo_delay(played + echoes)
        self.assertIsNotNone(delay)
        self.assertAlmostEqual(delay, 0.38, delta=0.015)
        kept, dropped = tc.echo_filter(played + echoes, delay)
        self.assertEqual(sorted((round(n["t"], 2), n["midi"]) for n in kept), sorted((t, m) for t, m in line))
        self.assertEqual(dropped, len(echoes))
        # Plain playing with no delay: nothing found.
        self.assertIsNone(tc.find_echo_delay(played))


class Bends(unittest.TestCase):
    HOP = 0.0116

    def track(self, segments, end):
        """Piecewise pYIN track: [(t_from, pitch_or_callable)], sampled every 11.6 ms."""
        times, f0 = [], []
        t = 0.0
        while t < end:
            val = None
            for t0, v in segments:
                if t >= t0:
                    val = v(t) if callable(v) else v
            times.append(t)
            f0.append(val)
            t += self.HOP
        return times, f0

    def test_bend_release_folds_into_one_note(self):
        # 14b15r14 on the e string: Basic Pitch writes F#5 G5 F#5; pYIN glides 78 -> 79 -> 78.
        notes = [note(1.0, 78, dur=0.3), note(1.3, 79, dur=0.3), note(1.6, 78, dur=0.3)]
        times, f0 = self.track([(0.0, 78.0), (1.22, lambda t: 78 + (t - 1.22) / 0.12), (1.34, 79.0),
                                (1.52, lambda t: 79 - (t - 1.52) / 0.12), (1.64, 78.0)], 2.0)
        out, merged = tc.merge_bends(notes, times, f0)
        self.assertEqual(merged, 2)
        self.assertEqual(len(out), 1)
        n = out[0]
        self.assertEqual((n["midi"], n["bend_to"], n["release_to"]), (78, 79, 78))
        self.assertAlmostEqual(n["end"], 1.9)
        n.update(string=5, fret=14)
        self.assertEqual(tc._token(n), "14b15r14")

    def test_hammer_on_stays_two_notes(self):
        # 14h16: the pitch jumps, no glide through 79.
        notes = [note(1.0, 78, dur=0.3), note(1.3, 80, dur=0.3)]
        times, f0 = self.track([(0.0, 78.0), (1.3, 80.0)], 2.0)
        out, merged = tc.merge_bends(notes, times, f0)
        self.assertEqual((merged, len(out)), (0, 2))

    def test_offset_and_no_wild_bends(self):
        # Band tuned 0.2 sharp; a later note 8 semitones up must not turn into "b10".
        notes = [note(0.2 + 0.4 * i, 64, dur=0.3) for i in range(6)]
        times, f0 = self.track([(0.0, 64.2)], 3.0)
        self.assertAlmostEqual(tc.pyin_offset(notes, times, f0), 0.2, places=2)
        n = note(1.0, 40, dur=0.6)
        times, f0 = self.track([(0.0, 40.1), (1.3, 48.1)], 2.0)
        tc.reconcile_with_pyin([[n]], times, f0, [0.9] * len(times), offset=0.1)
        self.assertIsNone(n["bend_to"])


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

    def test_phrase_stays_in_one_box(self):
        # F#5 can be e14 or B19. In a phrase around frets 10-15 it must be e14, and each pitch keeps one spot.
        pitches = [74, 78, 74, 69, 78, 74]
        groups = tc.group_notes([note(0.2 * i, p, dur=0.15) for i, p in enumerate(pitches)])
        mapped, _ = tc.map_frets(groups, self.STD, kind="lead")
        notes = [g[0] for g in mapped]
        self.assertEqual({(n["string"], n["fret"]) for n in notes if n["midi"] == 78}, {(5, 14)})
        same_pitch_spots = {n["midi"]: set() for n in notes}
        for n in notes:
            same_pitch_spots[n["midi"]].add((n["string"], n["fret"]))
        self.assertTrue(all(len(v) == 1 for v in same_pitch_spots.values()), same_pitch_spots)
        frets = [n["fret"] for n in notes]
        self.assertLessEqual(max(frets) - min(frets), 5, frets)

    def test_low_strings_not_high_up_in_a_solo(self):
        # D4 after B15/e14: D12 (or G7), never A17.
        groups = tc.group_notes([note(0.0, 74), note(0.3, 78), note(0.6, 64), note(0.9, 62)])
        mapped, _ = tc.map_frets(groups, self.STD, kind="lead")
        last = mapped[-1][0]
        self.assertNotEqual(last["string"], 1)
        self.assertLessEqual(last["fret"], 12)

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
        times, f0, prob = self.track(lambda t: 74.0 if t < 0.3 else min(76.0, 74.0 + (t - 0.3) * 20))  # glide up
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

    def test_parse_bracketed_bends(self):
        # Ultimate Guitar style: bend targets in brackets, a pull-off after the release, a ghost-note pre-bend.
        tab = """
e|-x--14b(15)r(14)p12----------------|
B|--------------------15b(17)~~~-----|
G|---------------------------(11)b(12)|
D|-----------------------------------|
A|-----------------------------------|
E|-----------------------------------|
"""
        notes = tc.parse_ascii_tab(tab, self.STD)
        self.assertEqual([(n["string"], n["fret"]) for n in notes], [(5, 14), (5, 12), (4, 15), (3, 11)])

    def test_reference_tuning_line(self):
        self.assertEqual(tc.reference_tuning("# Source: x\n# tuning: DADF#AD\nD |--0--|"), "DADF#AD")
        self.assertIsNone(tc.reference_tuning("e|--0--|"))
        self.assertEqual(tc.parse_tuning("open-d"), tc.parse_tuning("DADF#AD"))

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
