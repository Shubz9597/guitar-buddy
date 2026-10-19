# PickPulse

**A guitar timing trainer with a live BPM detector, metronome, and early/late feedback.**

PickPulse helps you practise picking and strumming against a click. Connect your guitar through an audio interface, USB guitar cable, or line input, select its recording device, and see your playing tempo and how each attack lines up with the practice grid.

This repository is named **guitar-buddy**; the application is called **PickPulse**. It includes a web app and an Electron desktop app for Windows.

## Features

- Live guitar BPM estimation with quarter-note, eighth-note, triplet, and sixteenth-note subdivisions.
- Separate **Pick Notes** and **Strum Rhythm** modes.
- A metronome with adjustable tempo, volume, beats per bar, and click subdivision.
- Editable click patterns: normal, accent, or muted steps.
- Signed early/late timing feedback and a recent-hit graph.
- Separate guitar input and metronome output device selection; VoiceMeeter is optional.
- AudioWorklet analysis on the audio sample clock, with automatic selection of the stronger stereo input channel.
- Sensitivity adjustment and additional DAW latency compensation.

PickPulse analyses the guitar input without sending it to the speakers. Use your interface or DAW for guitar monitoring.

## Using PickPulse

1. Connect your guitar and select its device under **Guitar Input**. Use **Scan Devices** if device names are missing, and allow audio-input access when prompted.
2. Choose **Pick Notes** for individual attacks or **Strum Rhythm** for chord sweeps.
3. Under **You Play**, choose the subdivision you intend to play. This determines how the detected attack pulse is converted to BPM.
4. Set the practice BPM and select the **Click Output**. Adjust the rhythm pattern and click volume as needed.
5. Press **Start** and play steadily for roughly **3–8 seconds** to acquire a tempo. Check **Your Playing** and the timing graph; negative timing errors are early and positive errors are late.
6. Adjust **Sensitivity** if quiet notes are missed. If a DAW adds a consistent delay, use **Extra DAW Latency** to compensate the timing graph; this setting does not change measured BPM.

For the clearest results, use an isolated guitar input with sufficient gain and avoid clipping. Strong delay repeats, other instruments, and mixed subdivisions can make the intended pulse ambiguous. BPM depends on the selected subdivision; arbitrary rhythms do not always have one unambiguous tempo. See [audio detection notes](AUDIO-DETECTION.md) for tested scenarios, timing limits, and hardware-calibration considerations.

## Run locally

You need **Node.js 22.13.0 or newer**, npm, and a browser with AudioWorklet and audio-input support. For browser capture, use localhost during development or HTTPS when hosting.

```sh
git clone https://github.com/Shubz9597/guitar-buddy.git
cd guitar-buddy
npm ci
npm run dev
```

Open the local URL printed in the terminal.

To build and serve the production web app:

```sh
npm run build
npm start
```

The web app uses React, TypeScript, and vinext/Vite. The current timing trainer does not require a database or sign-in.

## Windows desktop app

After installing dependencies, build the renderer and launch Electron:

```sh
npm run build:desktop
npx electron .
```

Build a Windows x64 installer or portable executable:

```sh
npm run package:installer
npm run package:windows
```

Generated files are written to `release/`:

- `PickPulse-Setup-<version>.exe` — Windows installer.
- `PickPulse-<version>-portable.exe` — portable application.

Build outputs and installers are excluded from Git. Packaging may download Electron and installer build tools.

## Tests and checks

| Command | Purpose |
| --- | --- |
| `npm test` | Build the web app, then run rendering, tempo-engine, and generated-audio regression tests. |
| `npm run test:audio` | Run tempo and generated-audio tests without a web build. |
| `npm run test:desktop-audio` | Build the desktop renderer and test the bundled AudioWorklet in a hidden Electron window using synthetic stereo audio. No microphone is accessed. |
| `npm run lint` | Run the repository ESLint checks. |

Audio regression tests cover quiet low notes, palm muting, fast picking, chord strums, timing jitter, rests, stereo inputs, silence, hum, hiss, sustained notes, and vibrato. Generated-audio tests complement live checks with a real guitar and interface.

Existing repository-wide lint findings and missing Cloudflare worker types are documented in [AUDIO-DETECTION.md](AUDIO-DETECTION.md).

## Code layout

| Path | Purpose |
| --- | --- |
| `app/page.tsx` | Practice interface, audio routing, and metronome scheduling. |
| `app/guitar-processor.js` | AudioWorklet capture, channel selection, and guitar-attack detection. |
| `app/pulse-tracker.js` | Tempo tracking, attack corroboration, smoothing, and stale-reading expiry. |
| `app/tempo-engine.js` | Tempo estimation, subdivision, and timing-grid helpers. |
| `desktop/` | Electron entry point and desktop renderer. |
| `tests/` | Rendering, tempo, generated-audio, and desktop audio checks. |
| `AUDIO-DETECTION.md` | Detection audit, verification details, and practical limits. |
