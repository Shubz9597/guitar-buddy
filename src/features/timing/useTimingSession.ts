import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "../../audio/engine";
import {
  clampBpm,
  defaultPattern,
  Metronome,
  type Grid,
  type MetronomeSettings,
  type StepAccent,
} from "../../audio/metronome";
import type { PlayingStyle } from "../../audio/onset-detector";
import { usePersistentState } from "../../lib/usePersistentState";
import {
  currentPhrase,
  dropGhosts,
  ghostWindowMs,
  estimateTempo,
  gridErrorMs,
  median,
  summarizeHits,
  type OnsetPoint,
  type Subdivision,
  type SubdivisionSetting,
} from "./analysis";
import { cleanStreak, resizeRiff, riffShift, riffTempo, scoreRiff, STEPS_PER_BEAT, tapTempo, type BarResult } from "./riff";

export interface RiffSettings {
  /** Check each bar against the riff instead of the nearest grid line. */
  enabled: boolean;
  /** Sixteenth steps of one bar that are played. */
  steps: boolean[];
  /** "riff" clicks the riff's own rhythm (plus every beat), to hear how it goes. */
  click: "beat" | "riff";
}

export interface TrainerSettings {
  enabled: boolean;
  from: number;
  to: number;
  /** BPM added each time the goal is met. */
  step: number;
  /** Clean bars in a row (riff on), or bars played (riff off), before speeding up. */
  bars: number;
}

export interface TimingSettings {
  bpm: number;
  beatsPerBar: number;
  clicksPerBeat: Subdivision;
  pattern: StepAccent[];
  volume: number;
  playing: SubdivisionSetting;
  style: PlayingStyle;
  sensitivity: number;
  inputDeviceId: string;
  outputDeviceId: string;
  /** Measured by calibration (or set by hand) on top of the reported latency. */
  latencyOffsetMs: number;
  riff: RiffSettings;
  trainer: TrainerSettings;
}

// Straight eighths: a sensible start that most riffs are edited from.
const DEFAULT_RIFF_STEPS = Array.from({ length: 4 * STEPS_PER_BEAT }, (_, i) => i % 2 === 0);

const DEFAULTS: TimingSettings = {
  bpm: 90,
  beatsPerBar: 4,
  clicksPerBeat: 1,
  pattern: defaultPattern(4, 1),
  volume: 0.8,
  playing: "auto",
  style: "pick",
  sensitivity: 7,
  inputDeviceId: "",
  outputDeviceId: "",
  latencyOffsetMs: 0,
  riff: { enabled: false, steps: DEFAULT_RIFF_STEPS, click: "beat" },
  trainer: { enabled: false, from: 100, to: 140, step: 5, bars: 4 },
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  Math.max(min, Math.min(max, Math.round(Number(value)) || fallback));

function sanitizeRiff(value: unknown, beatsPerBar: number): RiffSettings {
  const riff = (value && typeof value === "object" ? value : {}) as Partial<RiffSettings>;
  const steps = Array.isArray(riff.steps) ? riff.steps.map((s) => s === true) : DEFAULT_RIFF_STEPS;
  return {
    enabled: riff.enabled === true,
    steps: resizeRiff(steps, beatsPerBar),
    click: riff.click === "riff" ? "riff" : "beat",
  };
}

function sanitizeTrainer(value: unknown): TrainerSettings {
  const t = (value && typeof value === "object" ? value : {}) as Partial<TrainerSettings>;
  const d = DEFAULTS.trainer;
  return {
    enabled: t.enabled === true,
    from: clampBpm(Number(t.from) || d.from),
    to: clampBpm(Number(t.to) || d.to),
    step: clampInt(t.step, 1, 20, d.step),
    bars: clampInt(t.bars, 1, 16, d.bars),
  };
}

export function sanitizeSettings(value: unknown): TimingSettings {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<TimingSettings>;
  const merged = { ...DEFAULTS, ...stored };
  const beatsPerBar = Math.max(1, Math.min(12, Math.round(Number(merged.beatsPerBar) || 4)));
  const clicksPerBeat = ([1, 2, 3, 4] as const).find((value) => value === merged.clicksPerBeat) ?? 1;
  const pattern =
    Array.isArray(merged.pattern) && merged.pattern.length === beatsPerBar * clicksPerBeat
      ? merged.pattern.map((step) => (step === 0 || step === 2 ? step : 1) as StepAccent)
      : defaultPattern(beatsPerBar, clicksPerBeat);
  return {
    ...merged,
    bpm: clampBpm(Number(merged.bpm) || DEFAULTS.bpm),
    beatsPerBar,
    clicksPerBeat,
    pattern,
    volume: Math.max(0, Math.min(1, Number(merged.volume) || 0)),
    playing: merged.playing === "auto" || [1, 2, 3, 4].includes(merged.playing as number) ? merged.playing : "auto",
    style: merged.style === "strum" ? "strum" : "pick",
    sensitivity: Math.max(1, Math.min(10, Math.round(Number(merged.sensitivity) || 7))),
    latencyOffsetMs: Math.max(-150, Math.min(400, Math.round(Number(merged.latencyOffsetMs) || 0))),
    riff: sanitizeRiff(stored.riff, beatsPerBar),
    trainer: sanitizeTrainer(stored.trainer),
  };
}

/** The click for the riff: every beat, plus the riff's notes between beats. */
export function riffPattern(steps: readonly boolean[]): StepAccent[] {
  return steps.map((on, i) => (i === 0 ? 2 : i % STEPS_PER_BEAT === 0 || on ? 1 : 0));
}

export type InputStatus = "off" | "starting" | "live" | "error";

export interface InputState {
  status: InputStatus;
  message: string;
  label: string;
  reportedLatencyMs: number;
}

export type Calibration =
  | { phase: "idle" }
  | { phase: "listening"; collected: number }
  | { phase: "done"; offsetMs: number; spreadMs: number }
  | { phase: "failed"; reason: string };

export interface Hit {
  timeMs: number;
  errorMs: number;
  /** Grid slot counted from beat 1 of the first bar; see countName(). */
  slot: number;
}

const CALIBRATION_HITS = 12;
// About 50 bars of sixteenths: enough history for the bar list and note stats.
const MAX_ONSETS = 800;

function describeInputError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Audio input access is blocked. Allow it in your browser or system settings.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError")
      return "The selected input isn't available. Choose another one in Settings.";
  }
  return "Couldn't open the guitar input.";
}

export function useTimingSession() {
  const [settings, setSettings] = usePersistentState("guitar-buddy.timing", DEFAULTS, sanitizeSettings);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState<InputState>({ status: "off", message: "", label: "", reportedLatencyMs: 0 });
  // Every detected attack with its strength; `onsets` below is the cleaned list of notes.
  const [rawOnsets, setOnsets] = useState<OnsetPoint[]>([]);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [clockMs, setClockMs] = useState(0);
  const [calibration, setCalibration] = useState<Calibration>({ phase: "idle" });
  const metronomeRef = useRef<Metronome | null>(null);
  const settingsRef = useRef(settings);
  const gridRef = useRef<Grid | null>(null);
  const latencyRef = useRef(0);
  const calibrationRef = useRef<number[] | null>(null);
  const tapsRef = useRef<number[]>([]);
  const steppedGridRef = useRef<Grid | null>(null);
  const [trainerDone, setTrainerDone] = useState(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    latencyRef.current = input.reportedLatencyMs;
  }, [input.reportedLatencyMs]);

  const riffClick = settings.riff.enabled && settings.riff.click === "riff";
  const metronomeSettings: MetronomeSettings = useMemo(
    () => ({
      bpm: settings.bpm,
      beatsPerBar: settings.beatsPerBar,
      clicksPerBeat: riffClick ? STEPS_PER_BEAT : settings.clicksPerBeat,
      pattern: riffClick ? riffPattern(settings.riff.steps) : settings.pattern,
      volume: settings.volume,
    }),
    [settings.bpm, settings.beatsPerBar, settings.clicksPerBeat, settings.pattern, settings.volume, riffClick, settings.riff.steps],
  );
  const metronomeSettingsRef = useRef(metronomeSettings);
  useEffect(() => {
    metronomeSettingsRef.current = metronomeSettings;
  }, [metronomeSettings]);

  useEffect(() => {
    metronomeRef.current?.update(metronomeSettings);
  }, [metronomeSettings]);

  useEffect(() => {
    audioEngine.configure({ style: settings.style, sensitivity: settings.sensitivity });
  }, [settings.style, settings.sensitivity]);

  useEffect(() => {
    void audioEngine.setOutputDevice(settings.outputDeviceId);
  }, [settings.outputDeviceId]);

  // Calibration: one note on every click. The median offset becomes the
  // latency correction, covering interface, driver and speaker delay.
  const calibrate = useCallback(
    (onsetMs: number) => {
      const errors = calibrationRef.current;
      const grid = gridRef.current;
      if (!errors || !grid) return;
      const timeMs = onsetMs - latencyRef.current;
      if (timeMs < grid.originMs + grid.beatMs) return;
      errors.push(gridErrorMs(timeMs, grid.originMs, grid.beatMs / settingsRef.current.clicksPerBeat));
      if (errors.length < CALIBRATION_HITS) {
        setCalibration({ phase: "listening", collected: errors.length });
        return;
      }
      calibrationRef.current = null;
      setOnsets([]);
      const offsetMs = Math.round(median(errors));
      const spreadMs = Math.round(median(errors.map((error) => Math.abs(error - offsetMs))) * 1.48);
      if (spreadMs > 30) {
        setCalibration({ phase: "failed", reason: "The notes were too uneven to measure. Try again with single, clear notes." });
        return;
      }
      setSettings((current) => ({ ...current, latencyOffsetMs: Math.max(-150, Math.min(400, offsetMs)) }));
      setCalibration({ phase: "done", offsetMs, spreadMs });
    },
    [setSettings],
  );

  useEffect(
    () =>
      audioEngine.subscribe((message) => {
        if (message.type !== "onset") return;
        if (calibrationRef.current) calibrate(message.timeMs);
        else setOnsets((current) => [...current.slice(-(MAX_ONSETS - 1)), { timeMs: message.timeMs, strength: message.strength }]);
      }),
    [calibrate],
  );

  useEffect(() => {
    audioEngine.onInputLost = () =>
      setInput((current) => ({ ...current, status: "error", message: "The guitar input was disconnected." }));
    return () => {
      audioEngine.onInputLost = null;
    };
  }, []);

  const openInput = useCallback(async (deviceId: string) => {
    setInput((current) => ({ ...current, status: "starting", message: "" }));
    try {
      const { style, sensitivity } = settingsRef.current;
      const info = await audioEngine.startInput(deviceId, { style, sensitivity });
      setInput({ status: "live", message: "", label: info.label, reportedLatencyMs: info.reportedLatencyMs });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setInput((current) => ({ ...current, status: "error", message: describeInputError(error) }));
    }
  }, []);

  const start = useCallback(async () => {
    if (metronomeRef.current) return;
    const context = await audioEngine.getContext();
    // The speed trainer always starts from its first tempo.
    const { trainer } = settingsRef.current;
    const bpm = trainer.enabled ? trainer.from : settingsRef.current.bpm;
    if (trainer.enabled) setSettings((current) => ({ ...current, bpm }));
    setTrainerDone(false);
    const metronome = new Metronome(context, { ...metronomeSettingsRef.current, bpm });
    metronome.onGridChange = (next) => {
      // A new tempo starts a new measurement; a new bar length keeps the beat
      // grid, except for riffs, whose bars must line up with the click's.
      if (gridRef.current?.beatMs !== next.beatMs || settingsRef.current.riff.enabled) setOnsets([]);
      gridRef.current = next;
      setGrid(next);
    };
    metronomeRef.current = metronome;
    gridRef.current = null;
    setOnsets([]);
    metronome.start();
    setRunning(true);
    await openInput(settingsRef.current.inputDeviceId);
  }, [openInput, setSettings]);

  const stop = useCallback(() => {
    metronomeRef.current?.dispose();
    metronomeRef.current = null;
    audioEngine.stopInput();
    setRunning(false);
    setInput((current) => ({ ...current, status: "off", message: "" }));
    if (calibrationRef.current) {
      calibrationRef.current = null;
      setCalibration({ phase: "idle" });
    }
  }, []);

  useEffect(() => stop, [stop]);

  const update = useCallback(
    (patch: Partial<TimingSettings>) => {
      setSettings((current) => {
        const next = { ...current, ...patch };
        if (patch.bpm !== undefined) next.bpm = clampBpm(patch.bpm);
        if ((patch.beatsPerBar !== undefined || patch.clicksPerBeat !== undefined) && patch.pattern === undefined) {
          next.pattern = defaultPattern(next.beatsPerBar, next.clicksPerBeat);
        }
        if (patch.beatsPerBar !== undefined) next.riff = { ...next.riff, steps: resizeRiff(next.riff.steps, next.beatsPerBar) };
        // Switching the trainer on starts it from its first tempo.
        if (patch.trainer?.enabled && !current.trainer.enabled && patch.bpm === undefined) next.bpm = patch.trainer.from;
        return next;
      });
      if (patch.inputDeviceId !== undefined && metronomeRef.current) void openInput(patch.inputDeviceId);
      if (patch.trainer) setTrainerDone(false);
    },
    [setSettings, openInput],
  );

  const clear = useCallback(() => setOnsets([]), []);

  // Audio-clock "now", for noticing that playing has stopped.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setClockMs(audioEngine.currentTimeMs), 250);
    return () => window.clearInterval(id);
  }, [running]);

  const compensationMs = input.reportedLatencyMs + settings.latencyOffsetMs;
  const beatMs = grid?.beatMs ?? 60000 / settings.bpm;
  const onsets = useMemo(() => dropGhosts(rawOnsets, ghostWindowMs(beatMs)).map((o) => o.timeMs), [rawOnsets, beatMs]);

  const riffOn = settings.riff.enabled;
  const freeTempo = useMemo(
    () => estimateTempo(currentPhrase(onsets, beatMs), beatMs, riffOn ? 4 : settings.playing, settings.clicksPerBeat),
    [onsets, beatMs, riffOn, settings.playing, settings.clicksPerBeat],
  );

  // Riff mode: every bar checked note by note against the riff.
  const riffBars: BarResult[] = useMemo(() => {
    if (!riffOn || !grid || calibration.phase === "listening") return [];
    const played = onsets.map((raw) => raw - compensationMs);
    return scoreRiff(played, grid, settings.riff.steps, (running ? clockMs : (onsets.at(-1) ?? 0) + 5000) - compensationMs);
  }, [riffOn, grid, calibration.phase, onsets, compensationMs, settings.riff.steps, clockMs, running]);

  // Mostly messy bars may just be the riff started on the wrong beat; check
  // only then, since it re-scores every possible starting step.
  const riffMessy = useMemo(() => {
    const complete = riffBars.filter((b) => b.complete && !b.empty);
    return complete.length >= 2 && complete.filter((b) => b.clean).length < complete.length / 2;
  }, [riffBars]);
  const riffStart = useMemo(() => {
    if (!riffMessy || !grid) return 0;
    const played = onsets.map((raw) => raw - compensationMs);
    return riffShift(played, grid, settings.riff.steps, (onsets.at(-1) ?? 0) - compensationMs + 1);
  }, [riffMessy, grid, onsets, compensationMs, settings.riff.steps]);

  // Too uneven for the free estimate: with a riff, read the tempo from its
  // notes' places in the bar instead (fine while the player stays near the click).
  const tempo = useMemo(() => {
    if (!riffOn || freeTempo?.followsClick) return freeTempo;
    // A free reading that disagrees with the click is a wrong pulse here, not a tempo.
    const fromRiff = riffTempo(riffBars, settings.riff.steps.length);
    if (!fromRiff) return null;
    return { bpm: fromRiff.bpm, subdivision: 4 as Subdivision, spreadMs: fromRiff.spreadMs, followsClick: true, attacks: fromRiff.notes };
  }, [riffOn, riffBars, settings.riff.steps.length, freeTempo]);

  const lastOnset = onsets.length > 0 ? onsets[onsets.length - 1] : null;
  const playingNow = lastOnset !== null && (!running || clockMs - lastOnset < Math.max(2500, beatMs * 3));

  const subdivision: Subdivision = riffOn
    ? 4
    : tempo?.followsClick
      ? tempo.subdivision
      : settings.playing !== "auto"
        ? settings.playing
        : settings.clicksPerBeat;

  const hits: Hit[] = useMemo(() => {
    if (!grid || calibration.phase === "listening") return [];
    if (riffOn) {
      // Errors against the riff's own notes, so a late "&" is late, not an early "a".
      const perBar = settings.riff.steps.length;
      return riffBars
        .flatMap((bar) =>
          bar.notes.flatMap((note) =>
            note.timeMs !== null && typeof note.errorMs === "number"
              ? [{ timeMs: note.timeMs, errorMs: note.errorMs, slot: bar.bar * perBar + note.step }]
              : [],
          ),
        )
        .slice(-128);
    }
    const slotMs = grid.beatMs / subdivision;
    return onsets
      .map((raw) => raw - compensationMs)
      .filter((timeMs) => timeMs >= grid.originMs - slotMs / 2)
      .slice(-128)
      .map((timeMs) => {
        const errorMs = gridErrorMs(timeMs, grid.originMs, slotMs);
        return { timeMs, errorMs, slot: Math.round((timeMs - errorMs - grid.originMs) / slotMs) };
      });
  }, [onsets, grid, subdivision, compensationMs, calibration.phase, riffOn, riffBars, settings.riff.steps.length]);

  // Speed trainer: up a step after enough clean bars (riff) or bars played.
  const barMs = beatMs * settings.beatsPerBar;
  const barsPlayed = grid && running ? Math.max(0, Math.floor((clockMs - compensationMs - grid.originMs) / barMs)) : 0;
  const trainerProgress = riffOn ? cleanStreak(riffBars) : barsPlayed;
  const { trainer } = settings;
  useEffect(() => {
    if (!running || !trainer.enabled || trainerDone || trainerProgress < trainer.bars) return;
    // Progress belongs to one grid; after a step it is stale until the new tempo starts.
    if (grid === steppedGridRef.current) return;
    steppedGridRef.current = grid;
    if (settings.bpm >= trainer.to) setTrainerDone(true);
    else setSettings((current) => ({ ...current, bpm: clampBpm(Math.min(trainer.to, current.bpm + trainer.step)) }));
  }, [running, trainer, trainerDone, trainerProgress, settings.bpm, setSettings, grid]);

  const tap = useCallback(() => {
    const now = performance.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 8000), now];
    const bpm = tapTempo(tapsRef.current);
    if (bpm !== null) setSettings((current) => ({ ...current, bpm: clampBpm(bpm) }));
    return tapsRef.current.length;
  }, [setSettings]);

  const summary = useMemo(() => summarizeHits(hits.map((hit) => hit.errorMs)), [hits]);

  const startCalibration = useCallback(async () => {
    calibrationRef.current = [];
    setCalibration({ phase: "listening", collected: 0 });
    setOnsets([]);
    if (!metronomeRef.current) await start();
  }, [start]);

  const cancelCalibration = useCallback(() => {
    calibrationRef.current = null;
    setCalibration({ phase: "idle" });
  }, []);

  return {
    settings,
    update,
    running,
    start,
    stop,
    clear,
    input,
    metronome: metronomeRef,
    tempo: playingNow ? tempo : null,
    subdivision,
    hits,
    summary,
    compensationMs,
    calibration,
    startCalibration,
    cancelCalibration,
    riffBars,
    /** Step the player seems to start the riff on, when it is not beat 1 (else 0). */
    riffStart,
    tap,
    trainer: {
      ...trainer,
      active: running && trainer.enabled,
      progress: Math.min(trainerProgress, trainer.bars),
      done: trainerDone,
      clean: riffOn,
    },
  };
}

export type TimingSession = ReturnType<typeof useTimingSession>;
