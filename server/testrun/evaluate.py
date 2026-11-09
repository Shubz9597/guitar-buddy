#!/usr/bin/env python3
"""Score every test song that has a reference tab against the goal. Stdlib only, runs on the host in ~1 s.

    python3 server/testrun/evaluate.py            # table + goal check
    python3 server/testrun/evaluate.py --misses   # also list missed / extra notes per song

It reruns only the note-to-tab step (tabcore.transcribe) from the cached stage outputs in
<work>/<song>/ (03_basicpitch.json or 03_yourmt3.json, 04_pyin.csv), so run.py must have run for the song first.
Reference tabs live in <work>/<song>/reference.txt (copyrighted: never commit them).

The goal: a draft tab close to the owner's screenshot. Every fix must move these numbers on all songs,
not just one (no per-song tuning of the algorithm).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tabcore as tc  # noqa: E402

WORK_DIR = Path(os.environ.get("GB_WORK_DIR", "/srv/guitar-buddy/work"))

# Of the reference notes, share we found in order / of our notes, share that are real /
# of the found notes, share on the same string and fret as the reference.
GOAL = {"recall": 0.80, "precision": 0.70, "same_string_fret": 0.80}


def load_pyin(path: Path):
    times, midi, prob = [], [], []
    with path.open() as fh:
        for row in csv.DictReader(fh):
            times.append(float(row["time"]))
            midi.append(float(row["midi"]) if row["midi"] else None)
            prob.append(float(row["voiced_prob"]))
    return times, midi, prob


def evaluate(song: str, cfg: dict, work: Path):
    out = work / song
    ref_path = out / "reference.txt"
    notes_json = out / tc.NOTES_FILES[tc.pick_transcriber(cfg.get("kind", "lead"), cfg.get("transcriber", "auto"))]
    if not ref_path.exists() or not notes_json.exists():
        return None
    seg_start, seg_end = tc.parse_time(cfg["start"]), tc.parse_time(cfg["end"])
    tuning = tc.parse_tuning(cfg.get("tuning", "standard"))
    raw = [n for n in json.loads(notes_json.read_text()) if seg_start <= n["t"] < seg_end]
    f0_times, f0_midi, prob = load_pyin(out / "04_pyin.csv")
    mapped, _, _ = tc.transcribe(raw, f0_times, f0_midi, prob, tuning, kind=cfg.get("kind", "lead"))
    ours = tc.playing_order(mapped)
    ref_text = ref_path.read_text()
    ref_spec = tc.reference_tuning(ref_text)
    ref = tc.parse_ascii_tab(ref_text, tc.parse_tuning(ref_spec) if ref_spec else tuning)
    return tc.score_against_reference(ref, ours), ref, ours


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--misses", action="store_true")
    ap.add_argument("--work-dir", type=Path, default=WORK_DIR)
    a = ap.parse_args()
    songs = json.loads((HERE / "songs.json").read_text())
    rows, met_all = [], True
    for song, cfg in songs.items():
        if song.startswith("_"):
            continue
        res = evaluate(song, cfg, a.work_dir)
        if res is None:
            continue
        s, ref, ours = res
        met = {k: s[k] >= v for k, v in GOAL.items()}
        met_all &= all(met.values())
        rows.append((song, s, met))
        if a.misses:
            pairs = tc.lcs_pairs([r["midi"] for r in ref], [o["midi"] for o in ours])
            hit_ref = {i for i, _ in pairs}
            hit_ours = {j for _, j in pairs}
            print(f"\n{song}: missed " + " ".join(
                f"{tc.midi_to_name(r['midi'])}" for i, r in enumerate(ref) if i not in hit_ref))
            print(f"{song}: extra  " + " ".join(
                f"{tc.midi_to_name(o['midi'])}@{tc.fmt_time(o['t'])}" for j, o in enumerate(ours) if j not in hit_ours))
    if not rows:
        sys.exit("no song has both a reference.txt and cached stage outputs")
    print(f"\n{'song':20} {'notes found':>12} {'real':>6} {'string+fret':>12}   goal {GOAL['recall']:.0%} / "
          f"{GOAL['precision']:.0%} / {GOAL['same_string_fret']:.0%}")
    for song, s, met in rows:
        cells = [f"{s[k]:.0%}{'' if met[k] else ' x'}" for k in ("recall", "precision", "same_string_fret")]
        print(f"{song:20} {cells[0]:>12} {cells[1]:>6} {cells[2]:>12}   ({s['matched']}/{s['reference_notes']} ref notes,"
              f" {s['our_notes']} ours)")
    print("\nGOAL MET" if met_all else "\ngoal not met yet (x = below goal)")


if __name__ == "__main__":
    main()
