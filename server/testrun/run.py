#!/usr/bin/env python3
"""Throwaway test run: song segment -> Demucs guitar stem -> Basic Pitch + pYIN -> Viterbi frets -> ASCII tab.

    server/.venv/bin/python server/testrun/run.py comfortably-numb
    server/.venv/bin/python server/testrun/run.py comfortably-numb --reference ref-tab.txt
    server/.venv/bin/python server/testrun/run.py --file "Album/Song.flac" --start 1:10 --end 1:40 --kind riff --name my-song

Songs and their segments live in songs.json. The music folder is only ever read.
Outputs go to <work-dir>/<song>/ (default /srv/guitar-buddy/work):

    01_mix.wav           the segment plus padding, 44.1 kHz stereo        (cached)
    02_stems/*.wav       Demucs htdemucs_6s stems (guitar.wav = the useful one) (cached)
    03_basicpitch.json   raw Basic Pitch notes                             (cached)
    04_pyin.csv          pYIN pitch track of the guitar stem               (cached)
    05_beats.json        tempo + beat times from the drums stem            (cached)
    06_notes.csv         final notes: time, pitch, string, fret, flags     (rebuilt every run)
    06_tab.txt, 06_tab.mid
    07_report.md         stats, vocal check, score against a reference tab (rebuilt every run)

Cached stages rerun when their inputs or settings change, or with --force-from <stage>.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tabcore as tc  # noqa: E402

MUSIC_DIR = Path(os.environ.get("GB_MUSIC_DIR", "/mnt/workspace/music-server/downloads/complete"))
WORK_DIR = Path(os.environ.get("GB_WORK_DIR", "/srv/guitar-buddy/work"))
CACHED_STAGES = ["clip", "separate", "pitch", "pyin", "beats"]
SR = 44100


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- stage cache


class Stages:
    """Remembers the settings each cached stage ran with; a change reruns it and everything after."""

    def __init__(self, out: Path, force_from: str | None):
        self.path = out / "stages.json"
        self.done = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.dirty = False
        self.force_from = force_from
        self.timings = {}

    def need(self, stage, params, outputs):
        key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()
        if stage == self.force_from:
            self.dirty = True
        if self.dirty or self.done.get(stage) != key or not all(p.exists() for p in outputs):
            self.dirty = True
            self.done.pop(stage, None)
            self._pending = (stage, key, time.time())
            return True
        log(f"{stage}: cached")
        return False

    def finish(self, extra=None):
        stage, key, t0 = self._pending
        self.done[stage] = key
        self.timings[stage] = round(time.time() - t0, 1)
        if extra:
            self.done[f"{stage}_info"] = extra
        self.path.write_text(json.dumps(self.done, indent=2))
        log(f"{stage}: done in {self.timings[stage]} s")

    def info(self, stage):
        return self.done.get(f"{stage}_info", {})


# ---------------------------------------------------------------- stages


def stage_clip(src: Path, clip_start: float, clip_len: float, out: Path):
    tmp = out.with_suffix(".tmp.wav")
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-y",
        "-ss", f"{clip_start:.3f}", "-t", f"{clip_len:.3f}", "-i", str(src),
        "-map", "0:a:0", "-ac", "2", "-ar", str(SR), "-c:a", "pcm_f32le", str(tmp),
    ]
    subprocess.run(cmd, check=True)
    tmp.replace(out)


def stage_separate(mix: Path, stems_dir: Path, device: str, segment: float, shifts: int):
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs_6s")
    model.eval()
    wav, sr = sf.read(str(mix), dtype="float32", always_2d=True)
    assert sr == model.samplerate, (sr, model.samplerate)
    x = torch.from_numpy(np.ascontiguousarray(wav.T))
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (x - mean) / std

    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    attempts = [("cuda", segment), ("cuda", min(segment, 5)), ("cpu", segment)] if device == "cuda" else [("cpu", segment)]
    seen = set()
    for dev, seg in attempts:
        if (dev, seg) in seen:
            continue
        seen.add((dev, seg))
        log(f"separate: demucs htdemucs_6s on {dev}, segment {seg}, shifts {shifts}")
        # Demucs picks a random time offset per shift (even shifts=1); seed it so reruns give the same stem.
        random.seed(0)
        torch.manual_seed(0)
        try:
            with torch.no_grad():
                out = apply_model(model, x[None], device=dev, shifts=shifts, split=True,
                                  overlap=0.25, progress=True, segment=seg)[0]
            break
        except RuntimeError as e:  # torch.cuda.OutOfMemoryError is a RuntimeError
            if "out of memory" not in str(e).lower():
                raise
            log(f"separate: out of memory on {dev} with segment {seg}, trying the next setting")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
    else:
        raise RuntimeError("Demucs failed on every device/segment setting")

    out = out * std + mean
    tmp = stems_dir.with_name(stems_dir.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    for name, src in zip(model.sources, out):
        sf.write(str(tmp / f"{name}.wav"), src.cpu().numpy().T, sr, subtype="FLOAT")
    shutil.rmtree(stems_dir, ignore_errors=True)
    tmp.replace(stems_dir)
    return {"device": dev, "segment": seg}


def channel_wav(guitar: Path, channel: str) -> Path:
    """The guitar stem as-is ('both'), or one side of it as a mono file next to it ('left'/'right').

    Bands often record two guitars panned hard left and right (Opeth: two different parts at once); one side
    then holds one part, which transcribes far cleaner than both mixed together.
    """
    if channel == "both":
        return guitar
    import soundfile as sf

    side = guitar.with_name(f"guitar_{channel}.wav")
    if not side.exists() or side.stat().st_mtime < guitar.stat().st_mtime:
        y, sr = sf.read(str(guitar), dtype="float32", always_2d=True)
        sf.write(str(side), y[:, 0 if channel == "left" else 1], sr, subtype="FLOAT")
    return side


def stereo_correlation(guitar: Path, clip_start: float, seg_start: float, seg_end: float) -> float | None:
    """L/R correlation of the guitar stem over the segment: ~1 = one centred guitar, ~0 = two different
    guitars panned apart."""
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(guitar), dtype="float32", always_2d=True)
    y = y[max(int((seg_start - clip_start) * sr), 0):max(int((seg_end - clip_start) * sr), 0)]
    if y.shape[1] < 2 or len(y) < sr:
        return None
    return float(np.corrcoef(y[:, 0], y[:, 1])[0, 1])


def stage_pitch(guitar: Path, clip_start: float, out: Path):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, midi_data, events = predict(
        str(guitar), ICASSP_2022_MODEL_PATH,
        onset_threshold=0.5, frame_threshold=0.3,
        minimum_note_length=80,          # ms; default 127 drops fast licks
        minimum_frequency=60, maximum_frequency=1500,  # keep notes below E2 so tuning problems show up
        melodia_trick=True,
    )
    notes = [
        {"t": round(s + clip_start, 4), "end": round(e + clip_start, 4), "midi": int(p), "amp": round(float(a), 3)}
        for s, e, p, a, *_ in events
    ]
    notes.sort(key=lambda n: (n["t"], n["midi"]))
    out.write_text(json.dumps(notes, indent=1))
    midi_data.write(str(out.with_suffix(".mid")))


def stage_pyin(guitar: Path, clip_start: float, seg_start: float, seg_end: float, out: Path,
               midi_range: tuple[int, int] | None = None):
    """pYIN pitch track of the guitar stem. midi_range limits it to the lead's register so it cannot
    latch onto rhythm guitars in the same stem (on Shesmovedon it followed the rhythm parts at ~E3)."""
    import librosa
    import numpy as np

    offset = max(seg_start - 0.5 - clip_start, 0.0)
    y, sr = librosa.load(str(guitar), sr=22050, mono=True, offset=offset, duration=seg_end - seg_start + 1.0)
    hop = 256
    fmin, fmax = (60.0, 1500.0) if midi_range is None else (float(librosa.midi_to_hz(midi_range[0])),
                                                             float(librosa.midi_to_hz(midi_range[1])))
    f0, _, prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048, hop_length=hop)
    times = librosa.times_like(f0, sr=sr, hop_length=hop) + clip_start + offset
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time", "f0_hz", "midi", "voiced_prob"])
        for t, f, p in zip(times, f0, prob):
            ok = f is not None and not np.isnan(f)
            w.writerow([f"{t:.4f}", f"{f:.2f}" if ok else "", f"{librosa.hz_to_midi(f):.3f}" if ok else "", f"{p:.3f}"])


def lead_pitch_range(basicpitch_json: Path, seg_start: float, seg_end: float):
    """MIDI range for pYIN in lead mode: the lead line's 5th-95th percentile, 3 semitones below
    (slides) and 4 above (bends). None if there are too few notes to tell."""
    raw = json.loads(basicpitch_json.read_text())
    notes = [dict(n, flags=[], bend_to=None) for n in raw if seg_start <= n["t"] < seg_end]
    kept, _ = tc.lead_filter(notes)
    if len(kept) < 10:
        return None
    ps = sorted(n["midi"] for n in kept)
    return [ps[len(ps) // 20] - 3, ps[-(len(ps) // 20) - 1] + 4]


def stage_beats(drums: Path, mix: Path, clip_start: float, out: Path):
    import librosa
    import numpy as np

    y, sr = librosa.load(str(drums), sr=22050, mono=True)
    source = "drums stem"
    m, _ = librosa.load(str(mix), sr=22050, mono=True)
    if np.sqrt(np.mean(y ** 2)) < 0.05 * np.sqrt(np.mean(m ** 2)):
        y, source = m, "full mix (drums stem nearly silent)"
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    out.write_text(json.dumps({"tempo": tempo, "source": source,
                               "beats": [round(float(b) + clip_start, 4) for b in beats]}, indent=1))


# ---------------------------------------------------------------- tab + report


def load_pyin(path: Path):
    times, midi, prob = [], [], []
    with path.open() as fh:
        for row in csv.DictReader(fh):
            times.append(float(row["time"]))
            midi.append(float(row["midi"]) if row["midi"] else None)
            prob.append(float(row["voiced_prob"]))
    return times, midi, prob


def rms_windows(path: Path, clip_start: float, start: float, end: float, win=0.25):
    import soundfile as sf
    import numpy as np

    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(1)
    res = []
    t = start
    while t < end:
        a, b = int((t - clip_start) * sr), int((min(t + win, end) - clip_start) * sr)
        seg = y[max(a, 0):max(b, 0)]
        res.append((t, float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0))
        t += win
    return res


def spans(times_flags, win):
    """[(t, bool)] -> [(start, end)] of the True runs."""
    out, cur = [], None
    for t, on in times_flags:
        if on and cur is None:
            cur = t
        if not on and cur is not None:
            out.append((cur, t))
            cur = None
    if cur is not None:
        out.append((cur, times_flags[-1][0] + win))
    return out


def build_tab(out: Path, seg_start, seg_end, kind, tuning, clip_start, stems: Path, mix: Path, reference: Path | None,
              use_lead_filter: bool = True, channel: str = "both"):
    raw = json.loads((out / "03_basicpitch.json").read_text())
    f0_times, f0_midi, prob = load_pyin(out / "04_pyin.csv")
    seg_notes = [n for n in raw if seg_start <= n["t"] < seg_end]
    mapped, dropped, info = tc.transcribe(seg_notes, f0_times, f0_midi, prob, tuning, kind=kind,
                                          use_lead_filter=use_lead_filter)
    n_raw, lf_counts, pyin_stats = info["raw"], info["lead_filter"], info["pyin"]
    beats = json.loads((out / "05_beats.json").read_text())
    slots, grid_bpm = tc.sixteenth_grid(beats["beats"], seg_start, seg_end)
    placed = tc.place_on_grid(mapped, slots)
    tab_text = tc.render_tab(placed, slots, tuning)
    final = [n for g in mapped for n in g]

    side = "" if channel == "both" else f", {channel} channel only"
    header = (f"# {out.name}: {tc.fmt_time(seg_start)}-{tc.fmt_time(seg_end)}, {kind}{side}, tuning "
              f"{' '.join(tc.midi_to_name(m) for m in tuning)}, ~{grid_bpm:.0f} BPM grid\n"
              f"# DRAFT. '?' under a note = unsure. Bar lines assume 4/4 starting on the beat at the segment start.\n\n")
    (out / "06_tab.txt").write_text(header + tab_text)

    with (out / "06_notes.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time", "dur", "note", "midi", "string", "fret", "bend_to", "amp", "pyin_midi", "flags"])
        for n in sorted(final + dropped, key=lambda n: n["t"]):
            w.writerow([tc.fmt_time(n["t"]), round(n["end"] - n["t"], 3), tc.midi_to_name(n["midi"]), n["midi"],
                        n.get("string", ""), n.get("fret", ""), n.get("bend_to") or "", n["amp"],
                        n.get("pyin_midi", ""), " ".join(n["flags"])])

    try:
        import pretty_midi

        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(program=29, name="guitar draft")
        for n in final:
            inst.notes.append(pretty_midi.Note(velocity=int(40 + 80 * min(n["amp"], 1.0)), pitch=n["midi"],
                                               start=n["t"] - seg_start, end=n["end"] - seg_start))
        pm.instruments.append(inst)
        pm.write(str(out / "06_tab.mid"))
    except ImportError:
        pass

    # Report
    flag_counts = {}
    for n in final + dropped:
        for f in n["flags"]:
            flag_counts[f] = flag_counts.get(f, 0) + 1
    unsure = sum(1 for n in final if any(f in tc.UNCERTAIN for f in n["flags"]))
    below = [n for n in raw if seg_start <= n["t"] < seg_end and n["midi"] < tuning[0]]

    vocal = rms_windows(stems / "vocals.wav", clip_start, seg_start, seg_end)
    mixw = rms_windows(mix, clip_start, seg_start, seg_end)
    guitar = rms_windows(stems / "guitar.wav", clip_start, seg_start, seg_end)
    vocal_spans = spans([(t, v > 0.2 * m and m > 1e-4) for (t, v), (_, m) in zip(vocal, mixw)], 0.25)
    gshare = sum(g for _, g in guitar) / max(sum(m for _, m in mixw), 1e-9)

    lines = [
        f"# Test run: {out.name}",
        "",
        f"Segment {tc.fmt_time(seg_start)}-{tc.fmt_time(seg_end)} ({seg_end - seg_start:.1f} s), kind `{kind}`, "
        f"tuning {' '.join(tc.midi_to_name(m) for m in tuning)}.",
        "",
        "## Stages",
        "",
        f"- Separation: {json.dumps(STAGE_INFO.get('separate', {}))}",
        f"- Stage times this run (s): {json.dumps(STAGE_TIMES) if STAGE_TIMES else 'all cached'}",
        f"- Beats from {beats['source']}: librosa tempo {beats['tempo']:.1f} BPM, grid {grid_bpm:.1f} BPM "
        "(halve/double errors are common; check by ear)",
        "",
        "## Notes",
        "",
        f"- Basic Pitch notes in segment: {n_raw}",
        (f"- Lead filter: merged {lf_counts['merged']} re-triggered held notes, dropped {lf_counts['under_lead']} under "
         f"the lead and {lf_counts['below_register']} quiet low notes" if lf_counts is not None
         else "- Lead filter: off"),
        (f"- Delay echoes: repeat every {info['echo_delay'] * 1000:.0f} ms found, {info['echoes']} echo notes dropped"
         if info["echo_delay"] else "- Delay echoes: no delay pattern found"),
        f"- Bends: {info['bends_merged']} bend/release pieces folded into their bent note",
        f"- pYIN reads {info['pyin_offset']:+.2f} semitones off equal temperament (band tuning); corrected for",
        f"- Notes after cleanup: {info['notes']}; onsets after grouping chords: {info['groups']}",
        f"- In the tab: {len(final)} notes, {unsure} marked unsure ({100 * unsure / max(len(final), 1):.0f}%)",
        f"- Dropped (no fret position on this tuning): {len(dropped)}",
        f"- pYIN agreed with Basic Pitch on {pyin_stats['agree']} of {pyin_stats['checked']} single notes checked",
        f"- Flags: {json.dumps(flag_counts) if flag_counts else 'none'}",
        "",
        "## Checks",
        "",
    ]
    if below:
        lines.append(f"- **{len(below)} notes below the lowest string ({tc.midi_to_name(tuning[0])})**: "
                     f"lowest {tc.midi_to_name(min(n['midi'] for n in below))}. Either the tuning is lower than "
                     "assumed or Basic Pitch picked up bass bleed / octave errors.")
    else:
        lines.append(f"- No notes below {tc.midi_to_name(tuning[0])}: consistent with the assumed tuning.")
    if vocal_spans:
        txt = ", ".join(f"{tc.fmt_time(a)}-{tc.fmt_time(b)}" for a, b in vocal_spans)
        lines.append(f"- Vocals stem is loud during: {txt}. If this is a solo, the start/end times may be off "
                     "(or it is bleed).")
    else:
        lines.append("- Vocals stem is quiet for the whole segment (good for a solo).")
    lines.append(f"- Guitar stem level vs mix: {gshare:.2f} (near 0 = Demucs did not find the guitar).")
    corr = stereo_correlation(stems / "guitar.wav", clip_start, seg_start, seg_end)
    if corr is not None:
        if corr < 0.5:
            lines.append(f"- **Guitar stem is wide (L/R correlation {corr:.2f})**: probably two guitars panned apart, "
                         f"maybe playing different parts. This tab used: {channel}. "
                         "Try `--channel left` and `--channel right` to get one part each.")
        else:
            lines.append(f"- Guitar stem L/R correlation {corr:.2f}: mostly one centred guitar sound "
                         f"(this tab used: {channel}).")

    if reference:
        ref_text = reference.read_text()
        ref_spec = tc.reference_tuning(ref_text)
        ref_tuning = tc.parse_tuning(ref_spec) if ref_spec else tuning
        ref_notes = tc.parse_ascii_tab(ref_text, ref_tuning)
        s = tc.score_against_reference(ref_notes, tc.playing_order(mapped))
        lines += [
            "",
            f"## Score against {reference.name}",
            "",
            f"- Reference notes: {s['reference_notes']}, ours: {s['our_notes']}, matched in order: {s['matched']}",
            f"- **Notes right (recall): {100 * s['recall']:.0f}%**, precision {100 * s['precision']:.0f}%",
            f"- Of the matched notes, same string+fret as the reference: {100 * s['same_string_fret']:.0f}%",
            "- Matching is by pitch order only (timing ignored); bends count as the fretted note.",
        ]
        if ref_tuning != tuning:
            lines.append(f"- The reference is written in {' '.join(tc.midi_to_name(m) for m in ref_tuning)}, not this "
                         "tab's tuning, so string+fret matches mean little; the notes-right numbers still hold.")
    lines += ["", "## Tab", "", "```", header + tab_text, "```", ""]
    (out / "07_report.md").write_text("\n".join(lines))
    return tab_text


STAGE_INFO: dict = {}
STAGE_TIMES: dict = {}


# ---------------------------------------------------------------- main


def main():
    songs = json.loads((HERE / "songs.json").read_text())
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("song", nargs="?", help=f"one of: {', '.join(k for k in songs if not k.startswith('_'))}")
    ap.add_argument("--file", help="audio file, relative to the music dir (or absolute)")
    ap.add_argument("--name", help="work folder name when using --file")
    ap.add_argument("--start", help="segment start, m:ss")
    ap.add_argument("--end", help="segment end, m:ss")
    ap.add_argument("--kind", choices=["lead", "riff"])
    ap.add_argument("--tuning", help="standard, eb-standard, drop-d, d-standard, drop-c, or 'D2 A2 D3 G3 B3 E4'")
    ap.add_argument("--pad", type=float, default=5.0, help="seconds of context around the segment for separation")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--segment", type=float, default=7.0, help="Demucs segment length (drop to 5 on OOM)")
    ap.add_argument("--shifts", type=int, default=1, help="Demucs shifts (more = slower, slightly better)")
    ap.add_argument("--reference", type=Path, help="ASCII tab of the segment to score against")
    ap.add_argument("--no-lead-filter", action="store_true", help="lead mode: keep every Basic Pitch note")
    ap.add_argument("--channel", choices=["both", "left", "right"],
                    help="transcribe both sides of the guitar stem (default) or one side (two guitars panned apart)")
    ap.add_argument("--force-from", choices=CACHED_STAGES)
    ap.add_argument("--music-dir", type=Path, default=MUSIC_DIR)
    ap.add_argument("--work-dir", type=Path, default=WORK_DIR)
    a = ap.parse_args()

    cfg = dict(songs.get(a.song, {})) if a.song else {}
    if a.song and a.song not in songs:
        ap.error(f"unknown song {a.song!r}")
    for key in ("file", "start", "end", "kind", "tuning", "channel"):
        if getattr(a, key):
            cfg[key] = getattr(a, key)
    cfg.setdefault("kind", "lead")
    cfg.setdefault("tuning", "standard")
    cfg.setdefault("channel", "both")
    name = a.name or a.song
    missing = [k for k in ("file", "start", "end") if not cfg.get(k)]
    if missing or not name:
        ap.error(f"need {', '.join(missing) or '--name'} (set it in songs.json or on the command line)")

    music = a.music_dir.resolve()
    src = Path(cfg["file"])
    src = (src if src.is_absolute() else music / src).resolve()
    out = (a.work_dir / name).resolve()
    if out == music or music in out.parents:
        sys.exit(f"refusing to write inside the music folder: {out}")
    if not src.is_file():
        sys.exit(f"audio file not found: {src}")

    seg_start, seg_end = tc.parse_time(cfg["start"]), tc.parse_time(cfg["end"])
    if seg_end <= seg_start:
        sys.exit("end must be after start")
    tuning = tc.parse_tuning(cfg["tuning"])
    clip_start = max(seg_start - a.pad, 0.0)
    clip_len = seg_end + a.pad - clip_start
    out.mkdir(parents=True, exist_ok=True)
    log(f"{name}: {src.name} {tc.fmt_time(seg_start)}-{tc.fmt_time(seg_end)} -> {out}")

    st = Stages(out, a.force_from)
    mix, stems = out / "01_mix.wav", out / "02_stems"
    guitar = stems / "guitar.wav"
    src_stat = src.stat()
    base = {"src": str(src), "size": src_stat.st_size, "mtime": int(src_stat.st_mtime),
            "clip_start": clip_start, "clip_len": clip_len}

    if st.need("clip", base, [mix]):
        stage_clip(src, clip_start, clip_len, mix)
        st.finish()
    if st.need("separate", {"segment": a.segment, "shifts": a.shifts, "seed": 0}, [guitar, stems / "drums.wav", stems / "vocals.wav"]):
        st.finish(stage_separate(mix, stems, a.device, a.segment, a.shifts))
    source = channel_wav(guitar, cfg["channel"])
    pitch_params = {"v": 1} if cfg["channel"] == "both" else {"v": 1, "channel": cfg["channel"]}
    if st.need("pitch", pitch_params, [out / "03_basicpitch.json"]):
        stage_pitch(source, clip_start, out / "03_basicpitch.json")
        st.finish()
    midi_range = None
    if cfg["kind"] == "lead" and not a.no_lead_filter:
        midi_range = lead_pitch_range(out / "03_basicpitch.json", seg_start, seg_end)
    if st.need("pyin", {"seg": [seg_start, seg_end], "midi_range": midi_range}, [out / "04_pyin.csv"]):
        stage_pyin(source, clip_start, seg_start, seg_end, out / "04_pyin.csv", midi_range)
        st.finish()
    if st.need("beats", {"v": 1}, [out / "05_beats.json"]):
        stage_beats(stems / "drums.wav", mix, clip_start, out / "05_beats.json")
        st.finish()

    STAGE_INFO["separate"] = st.info("separate")
    STAGE_TIMES.update(st.timings)
    tab = build_tab(out, seg_start, seg_end, cfg["kind"], tuning, clip_start, stems, mix, a.reference,
                    use_lead_filter=not a.no_lead_filter, channel=cfg["channel"])
    print("\n" + tab)
    log(f"report: {out / '07_report.md'}")
    log(f"guitar stem: {guitar}")


if __name__ == "__main__":
    main()
