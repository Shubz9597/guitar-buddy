# PickPulse audio detection audit — 1.2.7

The selected Windows recording endpoint supplies unprocessed audio (automatic
gain, echo cancellation, and noise suppression are disabled). The detector
selects the strongest physical channel with hysteresis instead of downmixing
stereo, so a right-only guitar or opposite-polarity L/R signal is preserved.

## Problems corrected

- The previous 8 ms UI timer repeatedly read overlapping analyser snapshots.
  Actual timer gaps were replaced with their average for autocorrelation. Busy
  rendering and background timer throttling could therefore distort tempo and
  hit timestamps. A bundled AudioWorklet now analyses every audio sample at
  fixed hops of approximately 5 ms, using the audio sample clock. Messages are
  batched; their delivery time has no influence on measured timing.
- The previous detector excluded frequencies below 450 Hz and used a relatively
  high fixed input gate. The new windowed FFT includes low guitar fundamentals
  and uses logarithmic magnitudes to retain quiet notes. Comparing neighbouring
  spectral bins suppresses false attacks from sustained harmonics and vibrato.
- Rejected candidates previously extended a 90 ms strum burst indefinitely,
  while an amplitude-only echo heuristic could reject intentional quiet notes.
  Local spectral peaks now use a short guard measured from the last accepted
  attack (35 ms picking, 55 ms rhythm), independent of the practice target.
- Autocorrelation alone could favour a repeating phrase over its individual
  notes when playing included timing jitter and rests. Consistent attack gaps
  now corroborate the pulse. BPM uses the full attack timestamp span to avoid
  rounding bias at fast speeds.
- Old BPM readings persisted through silence or an input failure. They now
  expire after 2.5 observed attack periods (at least 1.6 seconds). A new signal
  acquires over roughly 3–8 seconds, depending on tempo and consistency.
- Input replacement and processor failures release streams, nodes, and ports.
  Generation checks reject obsolete input sessions and queued pre-reset audio.
  The worklet emits silence and never monitors the guitar to the speakers.
- Hit timestamps already account for the analysis window centre; estimated
  analyser and timer delays are no longer subtracted a second time. Reported
  hardware input/output latency and the existing manual DAW correction remain.

## Verification

- `npm test`: production web build, server rendering, tempo helpers, and PCM
  regression tests.
- `npm run test:audio`: the tempo and PCM tests without rebuilding the website.
- `npm run test:desktop-audio`: builds the desktop renderer and opens a hidden
  sandboxed Electron window. Synthetic stereo audio checks the actual bundled
  `file://` AudioWorklet, right-channel selection, sample clock continuity,
  attack timestamps, and silent output. No microphone is accessed.
- PCM tests cover 44.1/48 kHz, quarter/eighth/triplet/sixteenth notes, 30–240 BPM
  scenarios, quiet low E, palm muting, alternating dynamics, six-string strums,
  jitter/rests, stereo polarity, variable render block sizes, silence, mains
  hum, hiss, sustained notes, and vibrato. Tested steady scenarios require BPM
  within 3% and attack times within 22 ms of generated ground truth.

The application/desktop TypeScript check passes. The repository-wide TypeScript
check still lacks the pre-existing Cloudflare worker globals (`Fetcher`,
`D1Database`, and `cloudflare:workers`). Full lint also reports the pre-existing
`react-hooks/set-state-in-effect` findings in `app/page.tsx` for click-pattern
initialisation and device discovery. New audio modules and tests pass ESLint.

## Practical limits

These tests use generated audio, not a recording from the user's guitar and
interface. A live hardware check is still needed for gain, routing, and timing
calibration. Hardware latency reports are estimates; the existing manual DAW
correction may still be necessary.

BPM is the detected repeat pulse divided by the selected attacks per beat. A
quarter-note pulse and a slower beat with eighth notes can sound identical:
the intended subdivision must still be selected. Mixed rhythms can be judged
against the timing grid, but do not always define one unambiguous BPM. Picking
closer than 35 ms or strumming closer than 55 ms is grouped by design. Strong
delay repeats, clipping, another instrument on the same endpoint, or a louder
microphone on another channel can still affect detection. Prefer a direct,
isolated guitar input for timing practice.

The audio-thread clock and channel handling follow the
[Web Audio specification](https://www.w3.org/TR/webaudio-1.0/#AudioWorkletProcessor).
