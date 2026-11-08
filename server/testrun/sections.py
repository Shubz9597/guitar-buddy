#!/usr/bin/env python3
"""Find likely solo / riff sections: separate the whole song, then print where vocals and guitar are loud.

    server/testrun/docker-run.sh --sections shesmovedon      (via docker-run.sh, see there)
    python sections.py --file "Album/Song.flac" --name my-song

Writes <work-dir>/<song>/full/ (whole-song mix + stems, cached) and full/sections.txt.
Candidates = stretches of >= 8 s where the guitar stem is loud and the vocals stem is quiet.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run  # noqa: E402
import tabcore as tc  # noqa: E402

WIN = 1.0


def levels(path: Path):
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(1)
    n = int(WIN * sr)
    frames = len(y) // n
    return np.sqrt((y[: frames * n].reshape(frames, n) ** 2).mean(1) + 1e-12)


def main():
    songs = json.loads((HERE / "songs.json").read_text())
    ap = argparse.ArgumentParser()
    ap.add_argument("song", nargs="?")
    ap.add_argument("--file")
    ap.add_argument("--name")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--segment", type=float, default=7.0)
    ap.add_argument("--music-dir", type=Path, default=run.MUSIC_DIR)
    ap.add_argument("--work-dir", type=Path, default=run.WORK_DIR)
    a = ap.parse_args()

    file = a.file or songs.get(a.song, {}).get("file")
    name = a.name or a.song
    if not file or not name:
        ap.error("need a song from songs.json with a file, or --file and --name")
    music = a.music_dir.resolve()
    src = Path(file)
    src = (src if src.is_absolute() else music / src).resolve()
    out = (a.work_dir / name / "full").resolve()
    if out == music or music in out.parents:
        sys.exit(f"refusing to write inside the music folder: {out}")
    out.mkdir(parents=True, exist_ok=True)

    import soundfile as sf

    duration = sf.info(str(src)).duration
    st = run.Stages(out, None)
    mix, stems = out / "01_mix.wav", out / "02_stems"
    s = src.stat()
    if st.need("clip", {"src": str(src), "size": s.st_size, "mtime": int(s.st_mtime), "full": True}, [mix]):
        run.stage_clip(src, 0.0, duration + 1.0, mix)
        st.finish()
    if st.need("separate", {"segment": a.segment, "shifts": 1}, [stems / "guitar.wav", stems / "vocals.wav"]):
        st.finish(run.stage_separate(mix, stems, a.device, a.segment, 1))

    m, v, g = levels(mix), levels(stems / "vocals.wav"), levels(stems / "guitar.wav")
    n = min(len(m), len(v), len(g))
    vr, gr = v[:n] / m[:n], g[:n] / m[:n]
    loud = m[:n] > 0.02 * m.max()
    singing = (vr > 0.25) & loud
    guitar_on = (gr > 0.35) & loud

    def bar(x, width=10):
        return ("#" * int(round(min(x, 1.0) * width))).ljust(width, ".")

    lines = [f"# {name}: {src.name} ({tc.fmt_time(duration)})",
             "# every 5 s: vocals share | guitar share of the mix (stems from htdemucs_6s)", ""]
    for i in range(0, n, 5):
        sl = slice(i, i + 5)
        lines.append(f"{tc.fmt_time(i):>7}  V {bar(vr[sl].mean())}  G {bar(gr[sl].mean())}")

    cands, start = [], None
    for i in range(n + 1):
        ok = i < n and guitar_on[i] and not singing[i]
        if ok and start is None:
            start = i
        if not ok and start is not None:
            # allow 1 s dropouts
            if i < n - 1 and guitar_on[i + 1] and not singing[i + 1]:
                continue
            if i - start >= 8:
                cands.append((start, i))
            start = None
    lines += ["", "Candidates (guitar loud, no vocals, >= 8 s):"]
    lines += [f"  {tc.fmt_time(a_)}-{tc.fmt_time(b_)}  ({b_ - a_} s, guitar share {gr[a_:b_].mean():.2f})"
              for a_, b_ in cands] or ["  none"]
    text = "\n".join(lines) + "\n"
    (out / "sections.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
