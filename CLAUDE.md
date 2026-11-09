# Guitar Buddy

A practice app for one guitarist (the owner), who is learning guitar. Electron desktop app on their Windows PC, plus (new) a processing server on their homeserver laptop.

## Where things run

- **Windows PC**: runs the Electron app and is where the owner plays and tests with a real guitar and audio interface. They `git pull` and `npm run desktop` there when they have time.
- **Homeserver laptop** (Fedora 44, GTX 1650 4 GB, 16 GB RAM, always on, reachable over Tailscale as `homeserver`): the repo lives at `/srv/guitar-buddy/guitar-buddy` (cloned one level below `/srv/guitar-buddy`). Claude Code sessions run here in tmux and do the development. Heavy audio jobs will run here too.

### Audio paths on the homeserver

- **Song files (read-only):** `/mnt/workspace/music-server/downloads/complete/<Album (Year)>/<Artist - Album - NN - Title>.flac`. Never move, rename or write anything there; the music server owns it and downloads land there while we work. Read from it only.
- **Outputs:** `/srv/guitar-buddy/work/<song>/` (outside the repo; `work/` is also in `.gitignore`). Stems, clips, pitch tracks, tabs, reports. Owner-supplied reference tabs go here too (copyrighted: never commit them).
- `server/testrun/run.py` takes `GB_MUSIC_DIR` / `GB_WORK_DIR` (or `--music-dir` / `--work-dir`) and refuses to write inside the music folder.
- **GitHub** (`Shubz9597/guitar-buddy`, branch `main`) is the sync point between the two. Commit and push finished, tested work so the owner can pull it.

The app cannot be tested with a guitar on the server. Test with `npm test` (synthetic guitar PCM in `src/test/synth-guitar.ts`), and for real-world checks decode the owner's recordings and replay them through the detector in a node script.

## Commands

```bash
npm install
npm test          # vitest
npm run lint      # eslint
npx tsc --noEmit -p .
npm run build     # renderer into dist/
npm run desktop   # build + open Electron (Windows PC)
```

Run test, lint, tsc and build before every commit.

## Layout

```
electron/main.cjs, preload.cjs   Electron shell; IPC for tone research (Z.ai calls, page fetch with private-host block)
src/audio/                       engine, AudioWorklet onset detector (spectral flux), metronome with per-step accents
src/features/timing/             Timing/Practice tool
  analysis.ts                    tempo estimate, hit grading (TIGHT/LOOSE ms), ghost-onset removal
  riff.ts                        riff count parsing ("1 & 2 & 3 e & a"), bar-by-bar scoring on a 16th grid, riffTempo, tapTempo
  useTimingSession.ts            session state: metronome, calibration, riff check, speed trainer
  Practice.tsx, RiffView.tsx     riff card, trainer card, presets, bar-by-bar view
src/features/tone/               Tone tool: GLM research of a song's guitar tone -> plugin recipe
  research.ts                    tool-calling loop (search_web, read_page), facts checklist, follow-up round, fix runs
  recipe.ts, catalog.ts          recipe schema, owner's plugin catalog + PLUGIN_NOTES
  jobs.ts, history.ts            background jobs, history
recipes/                         saved recipes
scripts/                         tone-cli.ts, zai-smoke.ts (need ZAI_API_KEY in .env)
docs/product-spec.md             the owner's product spec (written without knowing the app's state; see decisions below)
server/testrun/                  Python test run (see "Next step"): run.py pipeline, tabcore.py (stdlib: Viterbi frets,
                                 ASCII tab, tab parser, scoring), test_tabcore.py, songs.json (files + segments),
                                 sections.py (whole-song stems -> where vocals/guitar are loud -> solo/riff candidates),
                                 Dockerfile + docker-run.sh (how it runs on the homeserver)
server/requirements-testrun.txt  Python pins (torch 2.8 cu126, demucs 4.0.1, basic-pitch 0.4.0)
```

Python tests: `python3 -m unittest discover -s server/testrun` (tabcore is stdlib-only, so any Python 3 works).

Model for tone research: Z.ai `glm-5.3-flash`, key in `.env` (`ZAI_API_KEY`, never commit it).

## Decisions so far (Nov 2026)

These override `docs/product-spec.md` where they differ.

- **PC only for now.** No phone or web client.
- **Tabs are drafts, not perfect.** Goal: a tab that is mostly right, marks the notes it is unsure of, lets the owner fix notes (fixes are locked), and can be re-transcribed later with better models while keeping locked notes. Both lead solos and rhythm riffs.
- **Most useful piece regardless of tab accuracy:** the isolated lead/guitar stem, slowed down without pitch change, with phrase looping.
- **Tuning:** look it up with the GLM research (a new fact topic with sources, like players/guitars/amps) and cross-check against the audio (notes below E2 mean not standard). Flag disagreements rather than trusting either.
- **Dropped or later:** training our own model (the correction log is kept so the option stays open), lead/rhythm split, hammer-on/pull-off detection, most theory extras (keep key display + out-of-key flags).
- **Ask the owner before adding any paid API or service.** Audio only from files the owner provides; no downloading from streaming sites.

## Server plan

- Python 3.11 or 3.12 in a venv or Docker (not the newest Python: torch/Demucs/Basic Pitch lag). Code goes in `server/` in this repo.
- GPU: GTX 1650 4 GB. Demucs `htdemucs_6s` with `--segment 7` (drop to 5 on out-of-memory); `--shifts` costs time, not memory. On CUDA out-of-memory, retry the stage on CPU. Everything else (Basic Pitch, pYIN, beat tracking, fret mapping, Rubber Band) is fine on CPU. One job at a time; every stage writes its output and is skipped on rerun.
- Docker with GPU needs the NVIDIA Container Toolkit; check before relying on it.

### Server state (checked 2026-11-08)

- OK: Node 24.21 / npm 11.19 (`npm test` 91/91 pass), Docker 29.7 (user in `docker` group), ffmpeg, librubberband libs, 347 GB free on `/`.
- Host Python is 3.14 only. **Python work runs in Docker** (`python:3.11-slim-bookworm`, image `guitar-buddy-testrun`): the session user has no passwordless sudo, so dnf installs need the owner, and GitHub downloads (uv's Python builds) returned 504 from this host. PyPI, download.pytorch.org, Docker Hub and dl.fbaipublicfiles.com (Demucs weights) work.
- Installed by the owner 2026-11-09: `akmod-nvidia` + `xorg-x11-drv-nvidia-cuda` 615.71.09 (kmod built and signed by the local akmods key for 7.2.7 and 7.2.15), `rubberband` CLI. The akmods key is queued with `mokutil --import`; **the GPU works only after the owner approves it at the laptop on the next reboot** (blue MOK screen: Enroll MOK -> Continue -> Yes -> password). Until then nouveau stays loaded and everything runs on CPU. Check with `modinfo -F signer nvidia`, `lsmod | grep nvidia`, `nvidia-smi`.
- Still missing: NVIDIA Container Toolkit (NVIDIA's own repo; not in Fedora/RPM Fusion) for `--gpus all`. `docker-run.sh` switches to the GPU by itself once `nvidia-ctk` and `nvidia-smi` work.
- **Suspend**: the GDM login screen has its own power settings (suspend after 15 min idle) and suspended the server at 01:16 on 2026-11-09 while nobody was logged in at the seat, freezing SSH sessions. Fixed: `sleep/suspend/hibernate/hybrid-sleep.target` are masked. The lid is ignored via `/etc/systemd/logind.conf.d/server.conf`; the two header-less lines in `/etc/systemd/logind.conf` are ignored by logind and harmless.
- sudo needs the owner's password: hand them exact commands, one at a time (pasted blocks get eaten by dnf's `[y/N]` prompt).
- **SELinux is enforcing** and the music folder carries the music server's container label (`container_file_t:s0:c72,c523`). Never mount it with `:z`/`:Z` (relabels it, can break the music server). `docker-run.sh` uses `--security-opt label=disable` and mounts it `:ro`.
- **Secure Boot is on**: the akmod-built NVIDIA module must be signed and its key enrolled with `mokutil` at a reboot (needs a keyboard and screen at the laptop), or Secure Boot turned off in firmware. Until then the GPU is unusable and Demucs runs on CPU.
- No separate CUDA toolkit needed: the PyTorch cu126 wheels bundle the CUDA runtime and only need the driver.
- RAM was tight at check time (~4 GB free, swap nearly full; desktop apps running). Demucs on a 45 s clip is fine; full songs on CPU may swap.

### Next step: a test run before building the server

A throwaway script (no FastAPI yet): Demucs -> guitar stem -> Basic Pitch + pYIN on a marked segment -> fret mapping (Viterbi) -> ASCII tab, then judge how rough the draft is and which stage fails. Test songs (the owner supplies the audio files and the solo/riff start-end times):

1. Pink Floyd, "Comfortably Numb", first solo: accurate official tabs exist, so it can be scored (% notes right).
2. Porcupine Tree, "Shesmovedon" (Lightbulb Sun), solo: the real target; ~400 ms delay on the lead, no tab exists.
3. Opeth, ~~"Ghost of Perdition"~~ **"The Grand Conjuration"** (Ghost Reveries; owner's switch, 2026-11-08), opening riff: tests rhythm riffs.

Status: script written and run on all three (`server/testrun/run.py`, settings per song in `songs.json`). Comfortably Numb 2:05-2:35 (owner confirmed). Shesmovedon and Grand Conjuration times are provisional, picked by `sections.py`; the owner should confirm by ear. Run:

```bash
server/testrun/docker-run.sh --build                       # once, or after changing requirements
server/testrun/docker-run.sh comfortably-numb [--reference /srv/guitar-buddy/work/comfortably-numb/reference.txt]
server/testrun/docker-run.sh --sections shesmovedon        # whole-song stems + vocal/guitar timeline
server/testrun/docker-run.sh grand-conjuration --channel right   # one side of a wide (two-guitar) stem
```

Quick tuning loop without Docker: the note-to-tab step is `tabcore.transcribe()` (stdlib only), so a few lines of host Python can rerun it from the cached `03_basicpitch.json` / `04_pyin.csv` and score it in well under a second.

It clips segment ±5 s (separating the clip, not the whole song, keeps it fast on a 4 GB GPU or CPU), separates with Demucs (OOM: segment 7 -> 5 -> CPU), runs Basic Pitch + pYIN, maps frets, and writes `06_tab.txt` and `07_report.md` (unsure %, pYIN agreement, notes below the lowest string, whether vocals are loud in the segment, and a score against a pasted ASCII reference tab).

#### First results (2026-11-08, CPU, ~1.5 min per song)

| Song (segment) | Tab notes | Unsure | pYIN agrees with Basic Pitch |
|---|---|---|---|
| Comfortably Numb (2:05-2:40) | 71 | 46% | 35/68 |
| Comfortably Numb (2:05-2:35, seeded, scored) | 60 | 37% | see score below |
| Shesmovedon (3:26-4:25, provisional) | 179 | 87% | 12/167, 53 octave mismatches |
| Grand Conjuration (0:00-0:25, provisional) | 145 | 50% | 25/96 |
| **After round 2 (2026-11-09)** | | | |
| Comfortably Numb (2:05-2:35) | 51 | 39% | 26/45; score below |
| Shesmovedon (3:26-4:25) | 177 | 85% | 16/165 |
| Grand Conjuration (0:00-0:25, left channel) | 123 | 43% | 28/79 |

Which stage fails:
- **Separation is the main limit.** htdemucs_6s `guitar` holds lead + rhythm guitars + some bass bleed. Without a filter the Comfortably Numb "solo" was mostly D3/A2 rhythm notes. `tabcore.lead_filter` (lead mode, on by default) fixes most of it: merge back-to-back same-pitch notes (Basic Pitch re-triggers held/vibrato notes), drop notes under a higher note, drop quiet notes > 1 octave below the lead. 282 -> 63 notes on CN; the result sits in the expected 14-19 box.
- **pYIN only half-works on these stems** (polyphonic). Use its HMM voiced decision, not `voiced_prob` (median 0.01-0.18 here; a 0.5 cutoff made every note "unvoiced").
- **Shesmovedon is still bad (85% unsure), and the delay is not the main reason.** The echo filter (`find_echo_delay` + `echo_filter`) finds the delay at 0.42 s (owner: ~400 ms) and drops 17 echoes, but the big problem is that the guitar stem holds ~3.4 notes at once (rhythm guitars and the lead in the same register, both centred, L/R correlation 0.88), and pYIN follows the rhythm parts (median ~E3). Limiting pYIN to the lead's range only moved agreement 12 -> 16 of 165. Needs a lead/rhythm split that Demucs does not give (ideas: a lead-guitar separation model, or the owner's chord progression to subtract rhythm notes). Checked 2:35-3:05 as an alternative segment: vocals plus a repeated figure, not the solo.
- **Grand Conjuration vs the OFFICIAL tab** (Ultimate Guitar official, aPIRATEwithADD; owner bought UG to get it, 2026-11-10): tuning **drop D** (D A D G B E), 220 bpm, bars 1-32 typed into `work/grand-conjuration/reference.txt` (160 notes; tied notes left out). Earlier guesses DADFAE and open D (a fan tab) were wrong. Segment is now 0:00-0:38 (bar 5's Eb chord sits at ~7.1 s). Two guitars panned hard L/R (correlation 0.06). Right channel scores best overall: **56% notes found, precision 41%, same string+fret 62%** (left 52/41/63, both 54/36/55). By section: **power chords (bars 5-32) 80% found, 68% string+fret**; **intro double-stops (bars 1-4) only 10-18%** on any channel. The intro guitar is as loud as later (0.65 of the mix), so the likely cause is Basic Pitch merging fast repeated same-pitch double-stops (10/7 10/7) into one long note under distortion. Next: more onset-sensitive settings for riffs (lower onset_threshold, or re-split long notes at amplitude/onset peaks). Tunings can be given as letters (`DADGBE`, `DADF#AD`); a reference tab can declare its own tuning with `# tuning: ...`.
- **The vocals check works**: on CN, vocals come back at 2:34.8, so the solo ends ~2:35, not 2:40.
- **Score, CN solo 1 (2:05-2:35) vs a fan tab** (Ultimate Guitar, redwing_suck, 4.6/199; typed in from the owner's screenshots into `work/comfortably-numb/reference.txt`, 58 notes): **60% of reference notes found in order, precision 58%, same string+fret 34%.** Misses: bends come out as extra notes (`e14b(15)r(14)` -> F#5 G5 F#5), the fast run `D14/12-11-9-7`, and the last phrase on the D string (A3-C4), which sits in the rhythm guitars' register. 
- **Round 2 (2026-11-09): recall 60%, precision 69%, same string+fret 77%** (from 58% / 34%). What changed, all generic:
  - Bend merge (`merge_bends`): back-to-back notes 1-3 semitones apart become one bent note only when pYIN shows a continuous glide (>= 2 frames in between); a hammer-on jumps. Gives `14b15r14`. pYIN's tuning offset (+0.1 on The Wall) is measured and corrected first.
  - Bends from pYIN follow the track only while it moves smoothly and are capped at 3 semitones (this was the riff-mode `2b10` bug).
  - Fret mapper tracks a hand position (index finger fret, 4-fret box, stretch costs, shifts cost a fixed amount plus distance) and penalises high frets on the low E/A strings in solos (A17 -> D12).
  - Remaining misses: the fast run `D14/12-11-9-7` and the last D-string phrase (A3-C4), both lost under the rhythm guitars; the second half sits in a 12th-fret box where the tab uses the 7th (both are playable).
- Demucs applies a random time offset per shift even with `shifts=1`, so unseeded reruns gave different stems, notes and fret choices (string+fret match swung 3% <-> 54%). `stage_separate` now seeds `random`/`torch`; two reruns give identical notes.
- CN's end is 2:35 (owner confirmed; vocals return at 2:34.8).
- Image is 13 GB because basic-pitch pulled full TensorFlow; switching it to its ONNX backend would shrink it.

## Other open work

- **Later (owner, 2026-11-09):** use the vocals and the rhythm/chord progression too, not just the lead: e.g. vocal timing for sections, chords under the solo (would also help tell lead from rhythm notes and pick the key).
- Timing pass 2 (only when asked): muted bars with drift measurement while the click is silent; practice timer and session summary.
- Tone: per-artist memory of confirmed facts; a 5-6 song test set graded from the research logs (`%APPDATA%\Guitar Buddy\tone-research` on the PC).

## About the owner

- Learning guitar; currently Megadeth "Kill the King" intro riff (palm-muted, 1 & 2 & 3 e & a 4 e & a, target 140 BPM, practising around 100). Listens to Pink Floyd, Porcupine Tree, Opeth.
- Cares most about sounding like the record (tone) and getting notes in the right place (timing). Wants fixes that make the app better for every song, not one-off patches.
- Prefers plain explanations; is fine with strict riff scoring.
