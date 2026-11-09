"""YourMT3+ (YPTF.MoE+Multi, noPS) note transcription, used by run.py for riffs.

YourMT3+ (Chang et al. 2024, https://huggingface.co/spaces/mimbres/YourMT3) is a multi-instrument model; on
distorted rhythm guitar it beats Basic Pitch clearly (Grand Conjuration vs the official tab: 61% / 64% / 72%
found / real / string+fret vs 56% / 41% / 62%), but it labels sustained lead guitar as strings, so solos keep
Basic Pitch. Its code and checkpoint are not in this repo: get-yourmt3.sh downloads them to
/srv/guitar-buddy/models/yourmt3 (GB_YMT3_DIR). Runs on CPU in ~1 s per second of audio.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

YMT3_DIR = Path(os.environ.get("GB_YMT3_DIR", "/srv/guitar-buddy/models/yourmt3"))
EXP = "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops"
GUITAR_PROGRAMS = set(range(24, 32))  # General MIDI guitars
_model = None


def available() -> bool:
    return (YMT3_DIR / "amt" / "logs" / "2024" / EXP / "checkpoints" / "last.ckpt").exists()


def _load():
    global _model
    if _model is None:
        import torch

        sys.path[:0] = [str(YMT3_DIR), str(YMT3_DIR / "amt" / "src")]  # model_helper.py + its amt/src package
        from model_helper import load_model_checkpoint

        dev = "cuda" if torch.cuda.is_available() else "cpu"
        args = [f"{EXP}@last.ckpt", "-p", "2024", "-tk", "mc13_full_plus_256", "-dec", "multi-t5", "-nl", "26",
                "-enc", "perceiver-tf", "-sqr", "1", "-ff", "moe", "-wf", "4", "-nmoe", "8", "-kmoe", "2",
                "-act", "silu", "-epe", "rope", "-rp", "1", "-ac", "spec", "-hop", "300", "-atc", "1",
                "-pr", "16" if dev == "cuda" else "32"]
        cwd = os.getcwd()
        os.chdir(YMT3_DIR)  # the checkpoint path is relative: amt/logs/2024/...
        try:
            _model = load_model_checkpoint(args=args, device="cpu").to(dev)
        finally:
            os.chdir(cwd)
    return _model


def transcribe(wav: Path) -> list[dict]:
    """All notes of every instrument: t, end (s from file start), midi, amp, program, drum."""
    import torch
    import torchaudio

    model = _load()  # also puts YourMT3's source folder on sys.path for the imports below
    from utils.audio import slice_padded_array
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    from utils.note2event import mix_notes

    dev = next(model.parameters()).device
    audio, sr = torchaudio.load(str(wav))
    audio = torchaudio.functional.resample(torch.mean(audio, dim=0).unsqueeze(0), sr, model.audio_cfg["sample_rate"])
    segs = slice_padded_array(audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"])
    segs = torch.from_numpy(segs.astype("float32")).to(dev).unsqueeze(1)
    with torch.no_grad():
        pred, _ = model.inference_file(bsz=8, audio_segments=segs)
    starts = [model.audio_cfg["input_frames"] * i / model.audio_cfg["sample_rate"] for i in range(segs.shape[0])]
    per_channel = []
    for ch in range(model.task_manager.num_decoding_channels):
        zipped, _, _ = model.task_manager.detokenize_list_batches([a[:, ch, :] for a in pred], starts, return_events=True)
        notes_ch, _ = merge_zipped_note_events_and_ties_to_notes(zipped)
        per_channel.append(notes_ch)
    rows = [{"t": round(float(x.onset), 4), "end": round(float(x.offset), 4), "midi": int(x.pitch),
             # YourMT3+ predicts note on/off only (velocity is always 1), so there is no loudness: use a
             # neutral 0.8 so the "quiet" check does not flag every note.
             "amp": round(int(x.velocity) / 127, 3) if x.velocity and x.velocity > 1 else 0.8, "program": int(x.program),
             "drum": bool(x.is_drum)} for x in mix_notes(per_channel)]
    rows.sort(key=lambda r: (r["t"], r["midi"]))
    return rows
