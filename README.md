# Guitar Buddy

Practice tools for guitarists. The first tool is **Timing**: a metronome that listens to your guitar and shows, note by note, whether you are early, late or on the click, plus the tempo you are actually playing.

## Timing

1. Open **Settings** and choose the input that carries your guitar (audio interface, DI, USB cable, or a VoiceMeeter bus). Use a dry signal: a microphone also hears the click, and delay or reverb adds extra notes.
2. Press **Start** (or Space) and play along.
3. **Calibrate** latency once per setup (Settings → Latency) so "on time" really means on time.

What you get:

- **Your tempo**: measured from your notes. The subdivision (1/4, 1/8, 1/12, 1/16) is detected automatically, or you can set it under *You play*.
- **Last note**: the signed offset of your most recent note from the click grid.
- **On time**: the share of notes within ±20 ms, your average lean (early/late) and spread.
- An editable click pattern (accents, mutes, beats per bar, click subdivision).

## How detection works

- An AudioWorklet analyses every sample on the audio clock (`src/audio/onset-detector.ts`). Attacks are found with log-spectral flux, then pinned to ~1 ms in the time domain, where the pick transient starts.
- Tempo is measured relative to the click (`src/features/timing/analysis.ts`). Each subdivision is searched within ±12% of the click tempo, and the coarsest one that explains the gaps between notes is chosen. This prevents half- and double-tempo readings. A line fit over all notes gives the final BPM, so rests and drift are handled.

## Development

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm test           # detector + analysis tests (synthetic guitar PCM)
npm run lint
npm run build      # static site in dist/
npm run desktop    # build and open in Electron
npm run package:windows   # portable Windows build in release/
```

Source layout:

```
src/
  audio/            shared audio engine, onset detector, worklet, metronome
  components/       UI primitives
  features/timing/  the Timing tool
  App.tsx           app shell; register new tools in TOOLS
```
