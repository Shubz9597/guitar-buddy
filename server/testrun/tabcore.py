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
    "dadgad": ["D2", "A2", "D3", "G3", "A3", "D4"],
    "open-d": ["D2", "A2", "D3", "F#3", "A3", "D4"],  # The Grand Conjuration (UG tab; UG calls it "Drop D")
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


STANDARD = [40, 45, 50, 55, 59, 64]


def _letters_to_midi(spec: str) -> list[int] | None:
    """'DADFAE', 'dadgad', 'D A D F A E', 'Eb Ab Db Gb Bb Eb' (letters only, low string first) -> MIDI.

    Each string gets the octave closest to the same string in standard tuning (ties go down, since
    altered tunings are mostly lower): DADFAE -> D2 A2 D3 F3 A3 E4. A 'b' right after a letter is a
    flat when that leaves six strings ('EbAbDbGbBbEb'); otherwise it is the note B.
    """
    compact = spec.replace(",", " ").replace(" ", "")
    if not compact or any(ch.isdigit() for ch in compact):
        return None
    for flat_ok in (True, False):
        pat = r"([A-Ga-g])([#b]?)" if flat_ok else r"([A-Ga-g])(#?)"
        toks = re.findall(pat, compact)
        if "".join(a + b for a, b in toks) == compact and len(toks) == len(STANDARD):
            break
    else:
        return None
    midis = []
    for (letter, acc), ref in zip(toks, STANDARD):
        name = letter.upper() + acc
        pc = NOTE_NAMES.index(_FLAT.get(name, name))
        cands = [pc + 12 * k for k in range(1, 8)]
        midis.append(min(cands, key=lambda m: (abs(m - ref), m > ref)))
    return midis


def parse_tuning(spec: str) -> list[int]:
    """Low string to high string: 'standard', 'drop-d', ... (TUNINGS), letters 'DADFAE' / 'dadgad',
    or note names with octaves 'D2 A2 D3 F3 A3 E4'."""
    named = TUNINGS.get(spec.strip().lower())
    letters = None if named else _letters_to_midi(spec)
    if letters is not None:
        return letters
    names = named or spec.replace(",", " ").split()
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
    1b. If the notes show a delay pedal (find_echo_delay), drop the quieter repeats (echo_filter).
    2. Skyline: drop a note if a note >= 3 semitones higher covers >= 50% of it (accompaniment under the lead).
    3. Register: drop notes more than an octave below the lead's median pitch that are also quieter
       than 70% of the lead's median amplitude (rhythm parts while the lead rests).
    Returns (kept, counts); counts also carries echo_delay (seconds or None) and echoes (dropped).
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

    # Delay echoes go before the skyline: an echo of a high note overlapping the next, lower, real note
    # would otherwise hide that real note as "under the lead".
    counts["echo_delay"] = find_echo_delay(merged)
    counts["echoes"] = 0
    if counts["echo_delay"] is not None:
        merged, counts["echoes"] = echo_filter(merged, counts["echo_delay"])

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


MAX_BEND = 3  # semitones; real bends are 1-2, rarely 3. A bigger "bend" is another note or a pitch-track jump.


def _track(f0_times, f0_midi, t0, t1, offset=0.0):
    """pYIN frames in [t0, t1] as a list of pitch-or-None, shifted by the tuning offset."""
    lo, hi = bisect.bisect_left(f0_times, t0), bisect.bisect_right(f0_times, t1)
    return [None if f0_midi[i] is None else f0_midi[i] - offset for i in range(lo, hi)]


def pyin_offset(notes, f0_times, f0_midi):
    """How far pYIN reads sharp/flat of the equal-tempered notes (the band's tuning, ~+0.2 on The Wall).

    Median of (pYIN pitch - note pitch) over notes where the two roughly agree; 0 without evidence.
    """
    diffs = []
    for n in notes:
        mid = [m for m in _track(f0_times, f0_midi, n["t"] + 0.03, n["end"] - 0.02) if m is not None]
        if len(mid) >= 3:
            d = statistics.median(mid) - n["midi"]
            if abs(d) < 0.5:
                diffs.append(d)
    return max(-0.5, min(0.5, statistics.median(diffs))) if len(diffs) >= 5 else 0.0


def is_glide(f0_times, f0_midi, t0, t1, a, b, offset=0.0):
    """The pYIN track in [t0, t1] slides between pitches a and b instead of stepping.

    A bend passes through the pitches in between (several frames at 11.6 ms); a hammer-on, pull-off or
    new pick jumps straight from one pitch to the next (at most one frame in between).
    """
    lo, hi = min(a, b), max(a, b)
    track = [m for m in _track(f0_times, f0_midi, t0, t1, offset) if m is not None]
    between = sum(1 for m in track if lo + 0.25 < m < hi - 0.25)
    near = sum(1 for m in track if lo - 0.5 < m < hi + 0.5)
    return between >= 2 and near >= 0.6 * len(track)


def merge_bends(notes, f0_times, f0_midi, offset=0.0, max_gap=0.05):
    """Lead mode: fold the pieces of a bend back into one note.

    Basic Pitch writes a bend-and-release (14b15r14) as three notes F#5 G5 F#5 back to back. When the next
    note starts right as the previous one ends, sits 1..MAX_BEND semitones above the bent note, and pYIN
    shows a continuous glide between them, it becomes part of the earlier note: bend_to = highest pitch
    reached, release_to = pitch it came back down to. Returns (notes, number_merged).
    """
    out: list[dict] = []
    merged = 0
    for n in sorted(notes, key=lambda n: n["t"]):
        cur = out[-1] if out else None
        if cur is not None and -0.05 <= n["t"] - cur["end"] <= max_gap:
            now = cur.get("release_to") or cur.get("bend_to") or cur["midi"]
            in_range = cur["midi"] <= n["midi"] <= cur["midi"] + MAX_BEND and n["midi"] != now
            if in_range and is_glide(f0_times, f0_midi, n["t"] - 0.12, n["t"] + 0.12, now, n["midi"], offset):
                if n["midi"] > now:
                    cur["bend_to"] = max(cur.get("bend_to") or cur["midi"], n["midi"])
                    cur.pop("release_to", None)
                else:
                    cur["release_to"] = n["midi"]
                cur["end"] = max(cur["end"], n["end"])
                cur["amp"] = max(cur["amp"], n["amp"])
                if "bend" not in cur["flags"]:
                    cur["flags"].append("bend")
                merged += 1
                continue
        out.append(n)
    return out, merged


def find_echo_delay(notes, lo=0.2, hi=0.8, tol=0.02):
    """Delay-pedal repeat time in seconds, or None.

    With a delay every note comes back quieter at the same pitch D later, and again at 2D. Take the notes in
    the upper half of the pitch range (the lead; rhythm parts below drown the pattern), collect the time from
    each note to later, quieter notes of the same pitch, and look for a D in [lo, hi] where both D and 2D are
    clearly more common than chance. Beat patterns rarely give that pair at a non-beat time. On Shesmovedon
    this finds ~0.40 s (the owner reports a ~400 ms delay); on Comfortably Numb it finds nothing.
    """
    if len(notes) < 20:
        return None
    med = statistics.median(n["midi"] for n in notes)
    top = sorted((n for n in notes if n["midi"] >= med), key=lambda n: n["t"])
    far = 2 * hi + tol
    diffs = []
    for i, a in enumerate(top):
        for b in top[i + 1:]:
            dt = b["t"] - a["t"]
            if dt > far:
                break
            if dt >= lo - tol and b["midi"] == a["midi"] and b["amp"] < a["amp"]:
                diffs.append(dt)
    if len(diffs) < 20:
        return None
    chance = len(diffs) * 2 * tol / (far - lo + tol)  # expected count in a +-tol window if times were random

    def near(c):
        return [d for d in diffs if abs(d - c) <= tol]

    best, best_score = None, 0.0
    c = lo
    while c <= hi:
        one, two = len(near(c)), len(near(2 * c))
        if one >= max(6, 1.6 * chance) and two >= 1.3 * chance and one + two > best_score:
            best, best_score = c, one + two
        c += 0.005
    if best is None:
        return None
    pts = near(best) + [d / 2 for d in near(2 * best)]
    return statistics.median(pts)


def echo_filter(notes, delay, tol=0.03, max_ratio=0.9):
    """Drop notes that are a delay repeat of an earlier note: same pitch, `delay` (or 2x) later, quieter."""
    srt = sorted(notes, key=lambda n: n["t"])
    starts = [n["t"] for n in srt]
    kept, dropped = [], 0
    for n in srt:
        echo = False
        for mult in (1, 2):
            t0 = n["t"] - mult * delay
            for j in range(bisect.bisect_left(starts, t0 - tol), bisect.bisect_right(starts, t0 + tol)):
                src = srt[j]
                if src is not n and src["midi"] == n["midi"] and n["amp"] <= max_ratio * src["amp"]:
                    echo = True
                    break
            if echo:
                break
        if echo:
            dropped += 1
        else:
            kept.append(n)
    return kept, dropped


def reconcile_with_pyin(groups, f0_times, f0_midi, voiced_prob, quiet_amp=0.3, min_prob=0.0, offset=0.0):
    """Cross-check single notes against the pYIN pitch track and estimate bends.

    f0_midi entries are float MIDI or None (unvoiced). A frame counts as voiced when pYIN's own HMM
    decision gave it a pitch; its voiced_prob is tiny on busy stems (median ~0.01 on Shesmovedon), so
    min_prob defaults to 0. `offset` is the band's tuning offset from pyin_offset(). Chords are not
    checked (pYIN only follows one pitch). Mutates the notes, returns per-note stats.
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
        frames = [(None if f0_midi[i] is None else f0_midi[i] - offset, voiced_prob[i]) for i in range(lo, hi)]
        if not frames:
            continue
        voiced = [m for m, p in frames if m is not None and p >= min_prob]
        stats["checked"] += 1
        if len(voiced) < 0.3 * len(frames) or len(voiced) < 2:
            n["flags"].append("pyin-unvoiced")
            continue
        head = voiced[: max(2, min(len(voiced) // 4, 8))]
        start_pitch = statistics.median(head)
        n["pyin_midi"] = round(start_pitch, 2)
        diff = start_pitch - n["midi"]
        if abs(diff) >= 11.5 and abs(diff - 12 * round(diff / 12)) < 0.6:
            n["flags"].append("octave?")
            continue
        if abs(diff) >= 0.6:
            n["flags"].append("pitch-disagree")
            continue
        stats["agree"] += 1
        if n.get("bend_to") is not None:
            continue  # already set by merge_bends
        # Bend: follow the track from the start while it moves smoothly (no frame-to-frame jump), so a
        # later note, another guitar or an octave slip cannot pass for a bend (that gave "2b10").
        peak = prev = start_pitch
        started = False
        for m, p in frames:
            if m is None or p < min_prob:
                if started:
                    break
                continue
            if not started:
                started = abs(m - start_pitch) < 0.5
                prev = m
                continue
            if abs(m - prev) > 0.45:
                break
            peak, prev = max(peak, m), m
        bend = round(peak - start_pitch)
        if peak - start_pitch >= 0.8 and 1 <= bend <= MAX_BEND:
            n["bend_to"] = n["midi"] + bend
            n["flags"].append("bend")
    return stats


def transcribe(notes, f0_times, f0_midi, voiced_prob, tuning, kind="lead", use_lead_filter=True):
    """The whole note-to-fret step: cleanup, bends, pYIN check, fret mapping.

    `notes` are Basic Pitch notes of the segment (dicts with t, end, midi, amp). Returns
    (mapped_groups, dropped_notes, info) where info holds counts for the report.
    """
    notes = [dict(n, flags=list(n.get("flags", [])), bend_to=n.get("bend_to")) for n in notes]
    info = {"raw": len(notes), "lead_filter": None, "echo_delay": None, "echoes": 0, "bends_merged": 0}
    offset = pyin_offset(notes, f0_times, f0_midi)
    info["pyin_offset"] = round(offset, 2)
    if kind == "lead" and use_lead_filter:
        notes, info["lead_filter"] = lead_filter(notes)
        info["echo_delay"] = info["lead_filter"]["echo_delay"]
        info["echoes"] = info["lead_filter"]["echoes"]
        notes, info["bends_merged"] = merge_bends(notes, f0_times, f0_midi, offset)
    info["notes"] = len(notes)
    groups = group_notes(notes)
    info["groups"] = len(groups)
    info["pyin"] = reconcile_with_pyin(groups, f0_times, f0_midi, voiced_prob, offset=offset)
    mapped, dropped = map_frets(groups, tuning, kind=kind)
    return mapped, dropped, info


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


def hand_positions(state, max_fret):
    """Hand positions (fret under the index finger) that can play `state`.

    Fingers cover p..p+3; p-1 and p+4 are reachable with a stretch. Open strings fit any position, so an
    open note keeps the hand where it was instead of resetting it.
    """
    fretted = [f for _, f in state if f > 0]
    if not fretted:
        return list(range(1, max_fret - 2))
    lo, hi = min(fretted), max(fretted)
    return [p for p in range(max(1, hi - 4), lo + 2) if p <= max_fret - 3]


def _state_cost(state, pos, kind):
    cost = 0.02 * pos  # tie-break: of two equal shapes, the lower one on the neck
    fretted = [f for _, f in state if f > 0]
    if fretted:
        cost += 0.15 * (max(fretted) - min(fretted))
    for s, f in state:
        if f == 0:
            if kind == "lead":
                cost += 2.0  # leads are mostly fretted; riffs use open strings freely
            continue
        if f < pos or f > pos + 3:
            cost += 0.4  # stretch
        if f > 17:
            cost += 0.1 * (f - 17)
        if kind == "lead" and s <= 2 and f > 12:
            # High up on the wound strings is rare in solos; the same note sits lower on a higher string.
            # Mostly true for the low E and A strings; the D string still gets used up to ~14.
            cost += (0.25 if s <= 1 else 0.1) * (f - 12)
    return cost


def _move_cost(a, pa, b, pb, gap, kind):
    """Cost of going from shape a at hand position pa to shape b at pb, `gap` seconds apart."""
    cost = 0.0
    shift = abs(pa - pb)
    if shift:
        ease = 1.0 + 2.0 * max(gap, 0.0)  # more time between notes = shifts are easier
        cost += 0.5 + 0.4 * shift / ease
        if shift > 4 and gap < 0.25:
            cost += 1.0  # big jump with no time to make it
    cost += 0.1 * abs(a[0][0] - b[0][0])
    if kind == "lead" and len(a) == 1 and len(b) == 1 and a[0][0] == b[0][0]:
        cost -= 0.1  # small pull towards staying on a string for runs
    return cost


def map_frets(groups, tuning, kind="lead", max_fret=22):
    """Viterbi over chord groups and hand positions. Fills note['string'], note['fret'].

    A state is (shape, hand position). Staying in one position is free, notes outside the four-fret box
    cost a stretch, and moving the hand costs a fixed amount plus the distance (cheaper after a rest).
    This keeps a phrase in one box instead of flipping between equal-pitch spots (e14 vs B19).

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
            usable.append((group, [(s, p) for s in states for p in hand_positions(s, max_fret)]))
    if not usable:
        return [], dropped

    # Viterbi
    first_group, first_states = usable[0]
    costs = [_state_cost(s, p, kind) for s, p in first_states]
    back = [[None] * len(first_states)]
    for idx in range(1, len(usable)):
        prev_group, prev_states = usable[idx - 1]
        group, states = usable[idx]
        gap = group[0]["t"] - max(n["end"] for n in prev_group)
        new_costs, pointers = [], []
        for s, p in states:
            best, best_j = None, 0
            for j, (ps, pp) in enumerate(prev_states):
                c = costs[j] + _move_cost(ps, pp, s, p, gap, kind)
                if best is None or c < best:
                    best, best_j = c, j
            new_costs.append(best + _state_cost(s, p, kind))
            pointers.append(best_j)
        costs = new_costs
        back.append(pointers)

    j = min(range(len(costs)), key=costs.__getitem__)
    for idx in range(len(usable) - 1, -1, -1):
        group, states = usable[idx]
        for n, (s, f) in zip(group, states[j][0]):
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
        if n.get("release_to") is not None:
            tok += f"r{n['fret'] + n['release_to'] - n['midi']}"
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

    Returns a list of notes in playing order (notes in one column low to high): dicts with midi, string, fret.
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
                    if s in "()":
                        continue  # brackets are transparent: 14b(15)r(14) is one note, (12) a ghost note
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
    events.sort(key=lambda e: (e[0], e[1], tuning[e[2]] + e[3]))  # notes in one column: low to high
    notes = []
    for _, _, string, fret in events:
        notes.append({"midi": tuning[string] + fret, "string": string, "fret": fret})
    return notes


def reference_tuning(text: str) -> str | None:
    """A reference tab can declare the tuning it is written in with a line '# tuning: DADF#AD'."""
    m = re.search(r"^\s*#\s*tuning:\s*(\S.*?)\s*$", text, re.M | re.I)
    return m.group(1) if m else None


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


def playing_order(groups):
    """Our notes in the order the scorer compares them: group by group, low to high inside a chord
    (the same order parse_ascii_tab gives the reference)."""
    return [n for g in groups for n in sorted(g, key=lambda n: n["midi"])]


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
