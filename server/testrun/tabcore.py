"""Pure-Python core of the test run: note cleanup, fret mapping (Viterbi), ASCII tab, scoring.

Standard library only, so it can be unit-tested without the ML stack
(`python3 -m unittest discover server/testrun`).

A note is a dict:
    t, end     absolute song time in seconds
    midi       MIDI pitch (int)
    amp        Basic Pitch amplitude 0..1
    flags      list of strings; anything in UNCERTAIN marks the note with "?" in the tab
    bend_to    MIDI pitch the note is bent up to (from pYIN), or None
    string, fret   filled in by the fret mapper (string 0 = lowest string)
"""

from __future__ import annotations

import bisect
import itertools
import re
import statistics

UNCERTAIN = {"pyin-unvoiced", "pitch-disagree", "octave?", "quiet", "grid-collision"}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLAT = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}

# Low string first.
TUNINGS = {
    "standard": ["E2", "A2", "D3", "G3", "B3", "E4"],
    "eb-standard": ["D#2", "G#2", "C#3", "F#3", "A#3", "D#4"],
    "drop-d": ["D2", "A2", "D3", "G3", "B3", "E4"],
    "d-standard": ["D2", "G2", "C3", "F3", "A3", "D4"],
    "drop-c": ["C2", "G2", "C3", "F3", "A3", "D4"],
}


def note_to_midi(name: str) -> int:
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d)", name.strip())
    if not m:
        raise ValueError(f"bad note name: {name!r}")
    letter = m.group(1).upper() + m.group(2)
    letter = _FLAT.get(letter, letter)
    return NOTE_NAMES.index(letter) + 12 * (int(m.group(3)) + 1)


def midi_to_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def parse_tuning(spec: str) -> list[int]:
    """'standard', 'drop-d', ... or six note names low to high: 'D2 A2 D3 G3 B3 E4'."""
    names = TUNINGS.get(spec.strip().lower()) or spec.replace(",", " ").split()
    midis = [note_to_midi(n) for n in names]
    if midis != sorted(midis):
        raise ValueError(f"tuning must go low string to high string: {spec!r}")
    return midis


def parse_time(value) -> float:
    """'2:05', '2:05.5', '125', 125.0 -> seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    parts = str(value).strip().split(":")
    seconds = 0.0
    for p in parts:
        seconds = seconds * 60 + float(p)
    return seconds


def fmt_time(seconds: float) -> str:
    m, s = divmod(max(seconds, 0.0), 60)
    return f"{int(m)}:{s:04.1f}"


# ---------------------------------------------------------------- note cleanup


def group_notes(notes: list[dict], window: float = 0.035) -> list[list[dict]]:
    """Notes whose onsets fall within `window` seconds of the group's first note sound together."""
    groups: list[list[dict]] = []
    for n in sorted(notes, key=lambda n: (n["t"], n["midi"])):
        if groups and n["t"] - groups[-1][0]["t"] <= window:
            if all(o["midi"] != n["midi"] for o in groups[-1]):
                groups[-1].append(n)
            continue
        groups.append([n])
    return groups


def lead_filter(notes: list[dict]) -> tuple[list[dict], dict]:
    """Lead mode: keep the solo line out of a guitar stem that also holds rhythm parts and bass bleed.

    1. Merge back-to-back notes of the same pitch (gap < 15 ms): Basic Pitch re-triggers held notes
       with vibrato; real repeated picks leave a gap.
    2. Skyline: drop a note if a note >= 3 semitones higher covers >= 50% of it (accompaniment under the lead).
    3. Register: drop notes more than an octave below the lead's median pitch that are also quieter
       than 70% of the lead's median amplitude (rhythm parts while the lead rests).
    Returns (kept, counts).
    """
    counts = {"merged": 0, "under_lead": 0, "below_register": 0}
    by_pitch: dict[int, dict] = {}
    merged = []
    for n in sorted(notes, key=lambda n: n["t"]):
        prev = by_pitch.get(n["midi"])
        if prev is not None and 0 <= n["t"] - prev["end"] < 0.015:
            prev["end"] = max(prev["end"], n["end"])
            prev["amp"] = max(prev["amp"], n["amp"])
            counts["merged"] += 1
            continue
        merged.append(n)
        by_pitch[n["midi"]] = n

    def covered(low):
        dur = low["end"] - low["t"]
        over = 0.0
        for hi in merged:
            if hi["midi"] >= low["midi"] + 3 and hi["t"] < low["end"] and hi["end"] > low["t"]:
                over += min(hi["end"], low["end"]) - max(hi["t"], low["t"])
        return dur > 0 and over / dur >= 0.5

    top = [n for n in merged if not covered(n)]
    counts["under_lead"] = len(merged) - len(top)
    if not top:
        return top, counts
    med_pitch = statistics.median(n["midi"] for n in top)
    med_amp = statistics.median(n["amp"] for n in top)
    kept = [n for n in top if not (n["midi"] < med_pitch - 12 and n["amp"] < 0.7 * med_amp)]
    counts["below_register"] = len(top) - len(kept)
    return kept, counts


def reconcile_with_pyin(groups, f0_times, f0_midi, voiced_prob, quiet_amp=0.3, min_prob=0.0):
    """Cross-check single notes against the pYIN pitch track and estimate bends.

    f0_midi entries are float MIDI or None (unvoiced). A frame counts as voiced when pYIN's own HMM
    decision gave it a pitch; its voiced_prob is tiny on busy stems (median ~0.01 on Shesmovedon), so
    min_prob defaults to 0. Chords are not checked (pYIN only follows one pitch). Mutates the notes,
    returns per-note stats.
    """
    stats = {"checked": 0, "agree": 0}
    for group in groups:
        for n in group:
            if n["amp"] < quiet_amp:
                n["flags"].append("quiet")
        if len(group) != 1:
            continue
        n = group[0]
        lo = bisect.bisect_left(f0_times, n["t"] + 0.02)
        hi = bisect.bisect_right(f0_times, max(n["end"] - 0.01, n["t"] + 0.03))
        frames = [(f0_midi[i], voiced_prob[i]) for i in range(lo, hi)]
        if not frames:
            continue
        voiced = [m for m, p in frames if m is not None and p >= min_prob]
        stats["checked"] += 1
        if len(voiced) < 0.3 * len(frames) or len(voiced) < 2:
            n["flags"].append("pyin-unvoiced")
            continue
        head = voiced[: max(2, len(voiced) // 4)]
        start_pitch = statistics.median(head)
        n["pyin_midi"] = round(start_pitch, 2)
        diff = start_pitch - n["midi"]
        if abs(diff) >= 11.5 and abs(diff - 12 * round(diff / 12)) < 0.6:
            n["flags"].append("octave?")
        elif abs(diff) >= 0.6:
            n["flags"].append("pitch-disagree")
        else:
            stats["agree"] += 1
        peak = max(voiced)
        if peak - start_pitch >= 0.8 and round(peak) > n["midi"]:
            n["bend_to"] = int(round(peak))
            n["flags"].append("bend")
    return stats


# ---------------------------------------------------------------- fret mapping


def note_positions(midi: int, tuning: list[int], max_fret: int) -> list[tuple[int, int]]:
    return [(s, midi - open_) for s, open_ in enumerate(tuning) if 0 <= midi - open_ <= max_fret]


def group_states(group, tuning, max_fret, max_span=5):
    """Every way to put the group's notes on distinct strings within a playable fret span."""
    options = [note_positions(n["midi"], tuning, max_fret) for n in group]
    states = []
    for combo in itertools.product(*options):
        strings = [s for s, _ in combo]
        if len(set(strings)) != len(strings):
            continue
        fretted = [f for _, f in combo if f > 0]
        if fretted and max(fretted) - min(fretted) > max_span:
            continue
        states.append(combo)
    return states


def _hand_pos(state):
    fretted = [f for _, f in state if f > 0]
    return sum(fretted) / len(fretted) if fretted else None


def _state_cost(state, kind):
    cost = 0.0
    fretted = [f for _, f in state if f > 0]
    if fretted:
        cost += 0.3 * (max(fretted) - min(fretted))
    for _, f in state:
        if f == 0 and kind == "lead":
            cost += 2.0  # leads are mostly fretted; riffs use open strings freely
        if f > 17:
            cost += 0.1 * (f - 17)
    return cost


def _move_cost(a, b, gap, kind):
    pa, pb = _hand_pos(a), _hand_pos(b)
    cost = 0.0
    if pa is not None and pb is not None:
        jump = abs(pa - pb)
        cost += jump / (1.0 + 2.0 * max(gap, 0.0))  # more time between notes = shifts are easier
        if jump > 4:
            cost += 1.5
    cost += 0.1 * abs(a[0][0] - b[0][0])
    if kind == "lead" and len(a) == 1 and len(b) == 1 and a[0][0] == b[0][0]:
        cost -= 0.1  # small pull towards staying on a string for runs
    return cost


def map_frets(groups, tuning, kind="lead", max_fret=22):
    """Viterbi over chord groups. Fills note['string'], note['fret'].

    Returns (mapped_groups, dropped_notes): notes with no position on this tuning
    (e.g. below the lowest open string) are dropped and flagged 'out-of-range';
    if a chord cannot be fingered, its quietest notes are dropped ('no-position').
    """
    dropped = []
    usable = []
    for group in groups:
        group = list(group)
        for n in list(group):
            if not note_positions(n["midi"], tuning, max_fret):
                n["flags"].append("out-of-range")
                dropped.append(n)
                group.remove(n)
        states = group_states(group, tuning, max_fret) if group else []
        while group and not states:
            quietest = min(group, key=lambda n: n["amp"])
            quietest["flags"].append("no-position")
            dropped.append(quietest)
            group.remove(quietest)
            states = group_states(group, tuning, max_fret) if group else []
        if group:
            usable.append((group, states))
    if not usable:
        return [], dropped

    # Viterbi
    first_group, first_states = usable[0]
    costs = [_state_cost(s, kind) for s in first_states]
    back = [[None] * len(first_states)]
    for idx in range(1, len(usable)):
        prev_group, prev_states = usable[idx - 1]
        group, states = usable[idx]
        gap = group[0]["t"] - max(n["end"] for n in prev_group)
        new_costs, pointers = [], []
        for s in states:
            best, best_j = None, 0
            for j, ps in enumerate(prev_states):
                c = costs[j] + _move_cost(ps, s, gap, kind)
                if best is None or c < best:
                    best, best_j = c, j
            new_costs.append(best + _state_cost(s, kind))
            pointers.append(best_j)
        costs = new_costs
        back.append(pointers)

    j = min(range(len(costs)), key=costs.__getitem__)
    for idx in range(len(usable) - 1, -1, -1):
        group, states = usable[idx]
        for n, (s, f) in zip(group, states[j]):
            n["string"], n["fret"] = s, f
        if idx:
            j = back[idx][j]
    return [g for g, _ in usable], dropped


# ---------------------------------------------------------------- tab layout


def sixteenth_grid(beat_times, start, end):
    """16th-note slot times covering [start, end] from beat times (extended with the median beat gap).

    Slot 0 sits on the last beat at or before `start`; bar lines assume 4/4 with that beat as beat 1
    (beat tracking does not find downbeats).
    """
    beats = sorted(beat_times)
    if len(beats) >= 2:
        ibi = statistics.median(b - a for a, b in zip(beats, beats[1:]))
    else:
        ibi = 0.5
    if not beats:
        beats = [start]
    while beats[0] > start:
        beats.insert(0, beats[0] - ibi)
    while beats[-1] < end + ibi:
        beats.append(beats[-1] + ibi)
    i0 = bisect.bisect_right(beats, start + 1e-6) - 1
    beats = beats[i0:]
    slots = []
    for a, b in zip(beats, beats[1:]):
        slots.extend(a + (b - a) * k / 4 for k in range(4))
        if a > end:
            break
    return slots, 60.0 / ibi


def place_on_grid(groups, slots):
    """Map each group to the nearest free 16th slot. Returns {slot: group}."""
    placed: dict[int, list[dict]] = {}
    for group in groups:
        t = group[0]["t"]
        i = bisect.bisect_left(slots, t)
        candidates = [k for k in (i - 1, i) if 0 <= k < len(slots)]
        nearest = min(candidates, key=lambda k: abs(slots[k] - t))
        if nearest not in placed:
            placed[nearest] = group
            continue
        for k in (nearest + 1, nearest - 1):
            if 0 <= k < len(slots) and k not in placed:
                placed[k] = group
                break
        else:
            for n in group:
                n["flags"].append("grid-collision")
            placed[nearest] = placed[nearest] + [
                n for n in group if n.get("string") not in {o.get("string") for o in placed[nearest]}
            ]
    return placed


def _token(n):
    tok = str(n["fret"])
    if n.get("bend_to") is not None:
        tok += f"b{n['fret'] + n['bend_to'] - n['midi']}"
    return tok


def string_labels(tuning):
    names = [NOTE_NAMES[m % 12] for m in tuning]
    names[-1] = names[-1].lower()
    width = max(len(x) for x in names)
    return [x.ljust(width) for x in names]


def render_tab(placed, slots, tuning, bars_per_line=2, slots_per_bar=16):
    """ASCII tab, high string on top. A '?' row under each system marks uncertain notes."""
    labels = string_labels(tuning)
    n_strings = len(tuning)
    if not placed:
        return "(no notes)\n"
    last = max(placed)
    n_bars = last // slots_per_bar + 1
    out = []
    for line_start in range(0, n_bars, bars_per_line):
        rows = [labels[s] + "|" for s in range(n_strings)]
        marks = " " * (len(labels[0]) + 1)
        header = " " * (len(labels[0]) + 1)
        for bar in range(line_start, min(line_start + bars_per_line, n_bars)):
            bar_slot = bar * slots_per_bar
            stamp = fmt_time(slots[bar_slot]) if bar_slot < len(slots) else ""
            bar_cells = []
            for k in range(bar_slot, bar_slot + slots_per_bar):
                group = placed.get(k, [])
                toks = {n["string"]: _token(n) for n in group}
                width = max([len(t) for t in toks.values()] + [1]) + 1
                cell = [toks.get(s, "").ljust(width, "-") for s in range(n_strings)]
                unsure = any(f in UNCERTAIN for n in group for f in n["flags"])
                bar_cells.append((cell, ("?" if unsure else "").ljust(width)))
            bar_width = sum(len(c[0][0]) for c in bar_cells) + 1
            header += stamp.ljust(bar_width)
            for s in range(n_strings):
                rows[s] += "".join(c[0][s] for c in bar_cells) + "|"
            marks += "".join(c[1] for c in bar_cells) + " "
        out.append(header.rstrip())
        out.extend(reversed(rows))
        if marks.strip():
            out.append(marks.rstrip())
        out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------- reference tab + scoring

_TAB_LINE = re.compile(r"^\s*([A-Ga-g][#b]?)\s*[|:](.*)$")


def parse_ascii_tab(text: str, tuning: list[int]):
    """Read a plain ASCII tab (6-line systems, high string on top).

    Returns a list of notes in playing order: dicts with midi, string, fret.
    '15b17' / '15r13' count as one note (fret 15). '5h7', '7p5', '5/7', '7\\5' count as two.
    Ignores x, ~, and other symbols; parentheses (ghost notes) are kept.
    """
    lines = text.splitlines()
    n = len(tuning)
    events = []  # (system, column, string, fret)
    i, system = 0, 0
    while i <= len(lines) - n:
        block = [_TAB_LINE.match(lines[i + k]) for k in range(n)]
        if all(block):
            for row, m in enumerate(block):
                string = n - 1 - row
                body = m.group(2)
                offset = m.start(2)
                prev = ""
                for tok in re.finditer(r"\d+|[^\d]", body):
                    s = tok.group(0)
                    if s.isdigit():
                        if prev not in ("b", "r"):
                            events.append((system, offset + tok.start(), string, int(s)))
                        prev = "#"
                    else:
                        prev = s.lower() if s.lower() in "bhpr/\\s" else ""
            system += 1
            i += n
        else:
            i += 1
    events.sort(key=lambda e: (e[0], e[1], -e[2]))
    notes = []
    for _, _, string, fret in events:
        notes.append({"midi": tuning[string] + fret, "string": string, "fret": fret})
    return notes


def lcs_pairs(a, b):
    """Index pairs of a longest common subsequence of two sequences."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def score_against_reference(ref_notes, our_notes):
    """Align by pitch order (LCS). recall = share of reference notes we got, in order."""
    ref = [r["midi"] for r in ref_notes]
    ours = [o["midi"] for o in our_notes]
    pairs = lcs_pairs(ref, ours)
    same_pos = sum(
        1 for i, j in pairs
        if (ref_notes[i]["string"], ref_notes[i]["fret"]) == (our_notes[j].get("string"), our_notes[j].get("fret"))
    )
    return {
        "reference_notes": len(ref),
        "our_notes": len(ours),
        "matched": len(pairs),
        "recall": len(pairs) / len(ref) if ref else 0.0,
        "precision": len(pairs) / len(ours) if ours else 0.0,
        "same_string_fret": same_pos / len(pairs) if pairs else 0.0,
    }
