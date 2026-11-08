# Guitar Buddy — Product & Build Spec

Nov 8, 2026 · @Shubham

## Product vision

Guitar Buddy turns any song I upload into a complete practice kit: the right tone, the right tempo, a backing track without the part I'm learning, and an accurate tab for that part. Accuracy matters more than speed; a job may take hours or a day.

Reference song for every decision: **Porcupine Tree, "Shesmovedon" (Lightbulb Sun version), guitar solo.** No accurate tab for this solo exists online, so it is the acceptance test for the whole product.

The end-to-end flow:

1. I upload the song's audio file (a file I own).
2. The server separates the instruments, finds the tempo and beat grid, and locates the solo.
3. It removes the lead guitar to make a backing track, and transcribes the lead into a tab.
4. The Tone page shows the plugin chain for this song's tone.
5. The Practice page loads the backing track at the song's BPM, lets me slow it down, and tells me if I'm ahead of or behind the beat.
6. The Tabs page shows the generated tab, synced to the audio, at any speed.
7. I ramp up the tempo until I can play the solo at full speed over the original backing track.

## App structure

The app has three pages that all read from one **Song** record, so choosing a song once sets up everything.

| Page | What it does | Status |
| --- | --- | --- |
| Tone | Shows the plugin chain (amp, cab, effects, settings) that matches the song's guitar tone. | Plugin finder exists |
| Practice | Backing track + metronome at the song's detected BPM, slowdown, looping, timing feedback. | Metronome exists; backing track is new |
| Tabs | Generated tab synced to the audio, playable at any speed, with verification tools. | New |

The Song record holds: title, artist, version (e.g. Lightbulb Sun), detected BPM and beat grid, key, section markers (intro, verse, solo), paths to each audio stem, the generated tab, and the tone preset. When a song finishes processing, the Practice page's tempo is set from the detected BPM automatically.

## System architecture

All heavy audio work runs as background jobs on my homeserver laptop; the app only uploads, polls, and plays results. Time per job is not a constraint, so the server favors the most accurate (slowest) model settings.

- **App (client):** the existing Guitar Buddy app. Uploads audio, shows job progress, plays stems and tabs. Playback, slowdown, and looping run in the client so practice works without waiting on the server.
- **API server:** Python + FastAPI. Python because every audio ML library needed (Demucs, Basic Pitch, librosa) is Python-first.
- **Job worker:** a separate process that pulls jobs from a queue (SQLite-backed or Redis + RQ) and runs the pipeline one song at a time. Uses the GPU if the laptop has one; CPU otherwise.
- **Storage:** one folder per song (`songs/<id>/original.wav`, `stems/`, `analysis.json`, `tab.json`) plus a SQLite database for Song records and job status.
- **Remote access:** Tailscale (or similar) so the phone can reach the homeserver from outside the home network without opening ports.

Every pipeline stage writes its output to disk and is skipped on rerun if that output exists. A crash at hour 3 then resumes from the last finished stage instead of starting over.

## Processing pipeline

Notes are detected directly from the isolated guitar audio; the song's key is only a helper for fixing uncertain notes, not the starting point. Each step below is one stage of the job, with its tool and its output file.

1. **Normalize input.** Convert the upload to 44.1 kHz stereo WAV with ffmpeg. Output: `original.wav`.
2. **Separate stems.** Run Demucs `htdemucs_6s` (vocals, drums, bass, guitar, piano, other) with a high `--shifts` value, since slower means cleaner. Mix every stem except guitar into the backing track. Output: `stems/*.wav`, `backing_no_guitar.wav`.
   - v2: split the guitar stem into lead and rhythm (music.ai API, or an open community model), then add rhythm back into the backing track. Output: `backing_no_lead.wav`.
3. **Tempo and beat grid.** Beat-track the drums stem (librosa or madmom). Store every beat time, not just one BPM, because live-feel songs drift. Detect the key from the full mix as a helper. Output: `analysis.json`.
4. **Locate the solo.** v1: I mark solo start and end on a waveform in the app. v2: auto-suggest sections where the vocals stem is quiet and the guitar stem is loud.
5. **Detect pitches.** Run Basic Pitch on the solo segment of the guitar stem for note events. Also run a monophonic pitch tracker (CREPE or pYIN) for a continuous pitch curve. Where the two disagree, mark the note low-confidence. Light noise and reverb reduction before this step improves results.
6. **Quantize rhythm.** Snap note starts to the beat grid (16ths and triplets), keeping the raw times as well so nothing is lost.
7. **Assign strings and frets.** For each note, list every playable string/fret position in the configured tuning, then pick the sequence with the lowest total cost using dynamic programming (Viterbi). Costs: fret jumps, string changes, stretches over 4 frets, and leaving the current hand position.
8. **Detect techniques.** Read them from the continuous pitch curve: bend (pitch rises within one note without a new attack), release, vibrato (pitch wobbling about 4 to 7 times per second), slide (smooth glide between two notes), hammer-on and pull-off (pitch change with a weak attack).
9. **Write the tab.** Save `tab.json` as the master format: per note, its time, beat, string, fret, technique, and confidence. Export to Guitar Pro and ASCII tab from it.

Useful starting points for Claude Code:

- [gtrsnipe](https://github.com/scottvr/gtrsnipe): an open-source tool that already chains Demucs separation, noise and reverb reduction, Basic Pitch, and a fret mapper into ASCII tab. Study its mapper costs (barre, stretch, open-string preferences) before writing step 7.
- [FretNet](https://github.com/cwitkowitz/guitar-transcription-continuous): a research model that outputs continuous pitch per string, which suits bends and vibrato. A v3 candidate for steps 5 to 8.
- [Robust guitar tabs](https://github.com/robust-guitar-tabs/code): research code for transcribing electric guitar with amp tones and effects, trained with DadaGP tab data. Relevant once I fine-tune a model.

## Verification tools

I can't yet hear a wrong note reliably, so the Tabs page must let me check the tab with tools that don't need a trained ear. These are core features, not extras.

- **A/B playback:** play a phrase from the isolated lead, then the same phrase synthesized from the tab, back to back, at any speed. Differences are easy to hear even for a beginner.
- **Confidence colors:** every note shows its confidence from steps 5 and 7. Low-confidence notes are red so I know where to look first.
- **Pitch overlay:** draw the detected pitch curve under the tab, aligned in time. Bends, slides, and vibrato show up as visible curves.
- **Easy correction:** tap a note to change its fret, string, or technique, or to delete it. Moving a note to another string keeps its pitch by default.
- **Correction log:** save every edit as before/after pairs with the audio timestamp. These become training data for fine-tuning a model later.

Render tabs with alphaTab (an open-source JavaScript tab renderer with built-in playback and cursor sync) rather than building a renderer from scratch.

### Theory assist

The Tabs page also teaches the theory behind each note, so fixing the tab doubles as ear and theory training. It builds on the key found in step 3.

- **Key per section:** detect the key for the solo segment on its own, not only for the whole song, since a solo can sit in a different key or mode. Show it at the top of the tab, editable if I disagree.
- **Scale degrees:** under each tab note, show its degree in the key (1, b3, 4, 5, b7 and so on), toggled on or off.
- **Scale box highlighting:** label which scale shape and neck position each phrase uses, e.g. minor pentatonic box at the 12th fret, with a small fretboard diagram of that box.
- **Out-of-key flags:** mark notes outside the detected scale as "check this" in a different color from low-confidence red. They are often deliberate passing tones, bends, or borrowed notes, so never auto-correct them.
- **Suggested fixes:** for a low-confidence note, offer the nearest in-scale alternatives on the same string so I can A/B each one against the original audio.
- **Theory notes in the correction log:** when I change a note, record its old and new scale degree, so I can later review which notes I tend to mishear.

## Practice features

The Practice page gets me from slow and careful to full speed over the real backing track.

- **Slowdown without pitch change:** pre-render the backing track and isolated lead at 50, 60, 70, 80, 90, and 100% speed on the server with the Rubber Band library. Pre-rendering gives better quality than live stretching, and processing time is free.
- **Loop a section:** loop any span (one phrase or the whole solo), with a one-bar count-in from the metronome before each loop.
- **Tempo ramp:** start at a chosen speed and step up 5% after a set number of loops, until 100%.
- **Metronome sync:** the existing metronome follows the song's beat grid, not just a fixed BPM, so clicks stay on the drums when the tempo drifts.
- **Timing feedback:** listen to my guitar through the audio interface, detect each note's attack, and compare it with the nearest beat or tab note. Show whether I'm early, late, or on time, in milliseconds, plus a running score per loop.
- **Latency calibration:** a one-time test where I play along to clicks, so the app subtracts my setup's delay before judging timing. Without it, every note will look late.

## Build phases

Build in this order, one phase at a time; each phase must pass its test with Shesmovedon before the next starts.

| Phase | Build | Done when |
| --- | --- | --- |
| 0. Server skeleton | FastAPI, job queue, upload endpoint, job status, per-song folders | I upload a file from the app and see the job go from queued to done |
| 1. Backing track | Steps 1 to 3, slowdown renders, Practice page playback with metronome on the beat grid | Shesmovedon plays without guitar at 60% speed, metronome clicks land on the snare |
| 2. First tab | Steps 4 to 7 and 9, solo marking, alphaTab rendering synced to audio | The solo shows as a tab whose cursor follows the isolated lead |
| 3. Verification | A/B playback, confidence colors, pitch overlay, note editing, correction log, theory assist | I can find and fix a wrong note without guessing |
| 4. Techniques | Step 8: bends, releases, vibrato, slides, hammer-ons, pull-offs | The solo's main bends appear in the tab with the right target pitch |
| 5. Timing feedback | Note-attack detection from my input, latency calibration, early/late display | Playing on the beat reads within 20 ms of on time |
| 6. Full backing track | Lead/rhythm split (step 2, v2), auto solo detection | The backing track keeps rhythm guitar under the solo |
| 7. Own model | Fine-tune a transcription model on my correction log and public tab data | Fewer red notes on a new song than Phase 2 produced |

## Risks, open questions, and notes for Claude Code

The biggest accuracy risk is effects on the lead itself, so plan for it from Phase 2.

**Risks**

- **Delay echoes become fake notes.** The Shesmovedon lead uses a delay of roughly 400 ms. Each repeat can be detected as a new note. Filter notes that repeat the same pitch at the delay interval and at lower volume.
- **Keyboards leak into the guitar stem.** Lightbulb Sun has keyboard parts that Demucs may put in the guitar stem, adding stray notes. Confidence flags and A/B playback are the defense.
- **Lead/rhythm separation varies by mix.** Commercial options exist (Moises and its developer platform [music.ai](https://music.ai/modules/stem-separation) offer lead and rhythm guitar stems), but quality on this song is unknown until tested.
- **Laptop limits.** Long jobs heat a laptop. Run one job at a time and keep stages resumable.

**Open questions**

- What is the app built with (web, React Native, Flutter, native)? This decides the audio playback and tab rendering libraries.
- Does the homeserver laptop have an NVIDIA GPU? Demucs is several times faster with one.
- What tuning is the solo played in? Keep tuning configurable per song; default to standard.

**Instructions for Claude Code**

- Read this whole spec first, then build one phase at a time and stop for my check after each.
- Keep `tab.json` as the single source of truth; every view and export reads from it.
- Write unit tests for the fret-assignment step with small hand-made note sequences.
- Audio comes only from files I upload; don't add downloading from streaming sites.
- Ask before adding any paid API or service.
