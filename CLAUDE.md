# Guitar Buddy

A practice app for one guitarist (the owner), who is learning guitar. Electron desktop app on their Windows PC, plus (new) a processing server on their homeserver laptop.

## Where things run

- **Windows PC**: runs the Electron app and is where the owner plays and tests with a real guitar and audio interface. They `git pull` and `npm run desktop` there when they have time.
- **Homeserver laptop** (Linux, GTX 1650 4 GB, always on, reachable over Tailscale as `homeserver`): the repo lives at `/srv/guitar-buddy`. Claude Code sessions run here in tmux and do the development. Heavy audio jobs will run here too.
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
```

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

### Next step: a test run before building the server

A throwaway script (no FastAPI yet): Demucs -> guitar stem -> Basic Pitch + pYIN on a marked segment -> fret mapping (Viterbi) -> ASCII tab, then judge how rough the draft is and which stage fails. Test songs (the owner supplies the audio files and the solo/riff start-end times):

1. Pink Floyd, "Comfortably Numb", first solo: accurate official tabs exist, so it can be scored (% notes right).
2. Porcupine Tree, "Shesmovedon" (Lightbulb Sun), solo: the real target; ~400 ms delay on the lead, no tab exists.
3. Opeth, "Ghost of Perdition", opening riff: tests rhythm riffs.

## Other open work

- Timing pass 2 (only when asked): muted bars with drift measurement while the click is silent; practice timer and session summary.
- Tone: per-artist memory of confirmed facts; a 5-6 song test set graded from the research logs (`%APPDATA%\Guitar Buddy\tone-research` on the PC).

## About the owner

- Learning guitar; currently Megadeth "Kill the King" intro riff (palm-muted, 1 & 2 & 3 e & a 4 e & a, target 140 BPM, practising around 100). Listens to Pink Floyd, Porcupine Tree, Opeth.
- Cares most about sounding like the record (tone) and getting notes in the right place (timing). Wants fixes that make the app better for every song, not one-off patches.
- Prefers plain explanations; is fine with strict riff scoring.
