"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  estimateTempo,
  nearestTimingErrorMs,
  subdivisionIntervalMs,
} from "./tempo-engine";

type InputStatus = "idle" | "starting" | "listening" | "error";
type TimingHit = { id: number; errorMs: number };

const subdivisions = [
  { value: 1, label: "1/4" },
  { value: 2, label: "1/8" },
  { value: 4, label: "1/16" },
];

const clampBpm = (value: number) =>
  Math.max(30, Math.min(240, Math.round(value)));

export default function Home() {
  const [targetBpm, setTargetBpm] = useState(100);
  const [attacksPerBeat, setAttacksPerBeat] = useState(2);
  const [clickVolume, setClickVolume] = useState(100);
  const [sensitivity, setSensitivity] = useState(7);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [inputStatus, setInputStatus] = useState<InputStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [detectedBpm, setDetectedBpm] = useState<number | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [attackCount, setAttackCount] = useState(0);
  const [timingHits, setTimingHits] = useState<TimingHit[]>([]);
  const [latestError, setLatestError] = useState<number | null>(null);
  const [activeBeat, setActiveBeat] = useState(-1);

  const audioContextRef = useRef<AudioContext | null>(null);
  const clickBufferRef = useRef<AudioBuffer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const schedulerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseTimersRef = useRef<Set<number>>(new Set());
  const nextClickTimeRef = useRef(0);
  const beatIndexRef = useRef(0);
  const gridOriginMsRef = useRef<number | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const lastOnsetRef = useRef<number | null>(null);
  const lastDetectedAtRef = useRef(0);
  const targetBpmRef = useRef(targetBpm);
  const attacksPerBeatRef = useRef(attacksPerBeat);
  const clickVolumeRef = useRef(clickVolume / 100);
  const sensitivityRef = useRef(sensitivity);
  const sessionRunningRef = useRef(false);
  const hitIdRef = useRef(0);

  const resetMeasurements = useCallback(() => {
    intervalsRef.current = [];
    lastOnsetRef.current = null;
    lastDetectedAtRef.current = 0;
    hitIdRef.current = 0;
    setDetectedBpm(null);
    setConfidence(0);
    setAttackCount(0);
    setTimingHits([]);
    setLatestError(null);
  }, []);

  useEffect(() => {
    targetBpmRef.current = targetBpm;
    attacksPerBeatRef.current = attacksPerBeat;

    const estimate = estimateTempo(intervalsRef.current, attacksPerBeat);
    if (estimate) {
      setDetectedBpm(estimate.bpm);
      setConfidence(estimate.confidence);
    }

    const context = audioContextRef.current;
    if (sessionRunningRef.current && context) {
      const restartAt = context.currentTime + 0.12;
      nextClickTimeRef.current = restartAt;
      gridOriginMsRef.current = restartAt * 1000;
      beatIndexRef.current = 0;
      setActiveBeat(-1);
      setTimingHits([]);
      setLatestError(null);
    }
  }, [attacksPerBeat, targetBpm]);

  useEffect(() => {
    clickVolumeRef.current = clickVolume / 100;
  }, [clickVolume]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const registerOnset = useCallback((timeMs: number) => {
    const expectedInterval = subdivisionIntervalMs(
      targetBpmRef.current,
      attacksPerBeatRef.current,
    );
    const refractoryMs = Math.max(42, Math.min(90, expectedInterval * 0.42));

    if (timeMs - lastDetectedAtRef.current < refractoryMs) return;
    lastDetectedAtRef.current = timeMs;
    setAttackCount((count) => count + 1);

    const gridOriginMs = gridOriginMsRef.current;
    if (sessionRunningRef.current && gridOriginMs !== null) {
      const errorMs = nearestTimingErrorMs(
        timeMs,
        gridOriginMs,
        targetBpmRef.current,
        attacksPerBeatRef.current,
      );
      const hit = { id: ++hitIdRef.current, errorMs };
      setLatestError(errorMs);
      setTimingHits((hits) => [...hits, hit].slice(-28));
    }

    const previousOnset = lastOnsetRef.current;
    lastOnsetRef.current = timeMs;
    if (previousOnset === null) return;

    const interval = timeMs - previousOnset;
    if (interval > 3000) {
      intervalsRef.current = [];
      setDetectedBpm(null);
      setConfidence(0);
      return;
    }

    if (interval < 35) return;
    intervalsRef.current = [...intervalsRef.current, interval].slice(-14);
    const estimate = estimateTempo(
      intervalsRef.current,
      attacksPerBeatRef.current,
    );
    if (estimate) {
      setDetectedBpm(estimate.bpm);
      setConfidence(estimate.confidence);
    }
  }, []);

  const scheduleClick = useCallback(
    (context: AudioContext, time: number, beat: number) => {
      const buffer = clickBufferRef.current;
      if (!buffer) return;

      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const oscillator = context.createOscillator();
      const oscillatorGain = context.createGain();
      const accent = beat === 0;
      const volume = clickVolumeRef.current;

      source.buffer = buffer;
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(accent ? 3600 : 2600, time);
      filter.Q.setValueAtTime(0.8, time);
      gain.gain.setValueAtTime(Math.max(0.0001, volume * 0.92), time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);

      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(accent ? 1850 : 1320, time);
      oscillatorGain.gain.setValueAtTime(
        Math.max(0.0001, volume * (accent ? 0.5 : 0.36)),
        time,
      );
      oscillatorGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      oscillator.connect(oscillatorGain);
      oscillatorGain.connect(context.destination);

      source.start(time);
      source.stop(time + 0.06);
      oscillator.start(time);
      oscillator.stop(time + 0.05);

      const delay = Math.max(0, (time - context.currentTime) * 1000);
      const timer = window.setTimeout(() => {
        setActiveBeat(beat);
        pulseTimersRef.current.delete(timer);
      }, delay);
      pulseTimersRef.current.add(timer);
    },
    [],
  );

  const runScheduler = useCallback(() => {
    const context = audioContextRef.current;
    if (!context || !sessionRunningRef.current) return;

    while (nextClickTimeRef.current < context.currentTime + 0.12) {
      scheduleClick(
        context,
        nextClickTimeRef.current,
        beatIndexRef.current,
      );
      nextClickTimeRef.current += 60 / targetBpmRef.current;
      beatIndexRef.current = (beatIndexRef.current + 1) % 4;
    }
  }, [scheduleClick]);

  const stopSession = useCallback(() => {
    sessionRunningRef.current = false;

    if (schedulerRef.current) {
      clearInterval(schedulerRef.current);
      schedulerRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    pulseTimersRef.current.forEach((timer) => clearTimeout(timer));
    pulseTimersRef.current.clear();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;
    clickBufferRef.current = null;
    if (context && context.state !== "closed") void context.close();

    gridOriginMsRef.current = null;
    setSessionRunning(false);
    setInputStatus("idle");
    setInputLevel(0);
    setActiveBeat(-1);
  }, []);

  const startInputAnalysis = useCallback(
    async (context: AudioContext) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Audio input is not available in this browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      if (!sessionRunningRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const source = context.createMediaStreamSource(stream);
      const highPass = context.createBiquadFilter();
      const analyser = context.createAnalyser();

      highPass.type = "highpass";
      highPass.frequency.value = 75;
      highPass.Q.value = 0.7;
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.08;
      source.connect(highPass);
      highPass.connect(analyser);
      streamRef.current = stream;

      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      const previousSpectrum = new Uint8Array(analyser.frequencyBinCount);
      const waveform = new Float32Array(analyser.fftSize);
      const binWidth = context.sampleRate / analyser.fftSize;
      const firstBin = Math.max(1, Math.floor(80 / binWidth));
      const lastBin = Math.min(
        analyser.frequencyBinCount - 1,
        Math.ceil(5000 / binWidth),
      );
      const startedAt = context.currentTime;
      let hasPreviousFrame = false;
      let fluxMean = 0;
      let fluxDeviation = 0;
      let nextMeterUpdate = 0;

      const analyse = () => {
        if (
          audioContextRef.current !== context ||
          !sessionRunningRef.current
        ) {
          return;
        }

        analyser.getByteFrequencyData(spectrum);
        analyser.getFloatTimeDomainData(waveform);

        let energy = 0;
        for (let index = 0; index < waveform.length; index += 1) {
          energy += waveform[index] * waveform[index];
        }
        const rms = Math.sqrt(energy / waveform.length);

        let spectralFlux = 0;
        if (hasPreviousFrame) {
          for (let index = firstBin; index <= lastBin; index += 1) {
            const increase = spectrum[index] - previousSpectrum[index];
            if (increase > 0) spectralFlux += increase;
          }
          spectralFlux /= lastBin - firstBin + 1;
        } else {
          hasPreviousFrame = true;
        }
        previousSpectrum.set(spectrum);

        const previousMean = fluxMean;
        fluxMean = fluxMean * 0.92 + spectralFlux * 0.08;
        fluxDeviation =
          fluxDeviation * 0.92 +
          Math.abs(spectralFlux - previousMean) * 0.08;

        const nowMs = context.currentTime * 1000;
        if (nowMs >= nextMeterUpdate) {
          const db = 20 * Math.log10(Math.max(rms, 0.00001));
          setInputLevel(Math.max(0, Math.min(1, (db + 58) / 43)));
          nextMeterUpdate = nowMs + 65;
        }

        const currentSensitivity = sensitivityRef.current;
        const fluxThreshold =
          fluxMean +
          fluxDeviation * (3.45 - currentSensitivity * 0.22) +
          0.18;
        const minimumRms = 0.0025 + (10 - currentSensitivity) * 0.0012;

        if (
          context.currentTime - startedAt > 0.55 &&
          spectralFlux > fluxThreshold &&
          rms > minimumRms
        ) {
          registerOnset(nowMs);
        }

        animationFrameRef.current = requestAnimationFrame(analyse);
      };

      setInputStatus("listening");
      animationFrameRef.current = requestAnimationFrame(analyse);
    },
    [registerOnset],
  );

  const startSession = useCallback(async () => {
    setErrorMessage("");
    setInputStatus("starting");
    resetMeasurements();

    const context = new AudioContext({ latencyHint: "interactive" });
    audioContextRef.current = context;
    await context.resume();

    const bufferLength = Math.floor(context.sampleRate * 0.055);
    const clickBuffer = context.createBuffer(1, bufferLength, context.sampleRate);
    const clickData = clickBuffer.getChannelData(0);
    for (let index = 0; index < bufferLength; index += 1) {
      const decay = Math.pow(1 - index / bufferLength, 4);
      clickData[index] = (Math.random() * 2 - 1) * decay;
    }
    clickBufferRef.current = clickBuffer;

    sessionRunningRef.current = true;
    setSessionRunning(true);
    const firstClickAt = context.currentTime + 0.16;
    nextClickTimeRef.current = firstClickAt;
    gridOriginMsRef.current = firstClickAt * 1000;
    beatIndexRef.current = 0;
    runScheduler();
    schedulerRef.current = setInterval(runScheduler, 25);

    try {
      await startInputAnalysis(context);
    } catch (error) {
      setInputStatus("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setErrorMessage(
          "Microphone access is blocked. The metronome still works; allow microphone access to measure the guitar.",
        );
      } else {
        setErrorMessage(
          "No guitar input was found. The metronome is still running.",
        );
      }
    }
  }, [resetMeasurements, runScheduler, startInputAnalysis]);

  useEffect(
    () => () => {
      stopSession();
    },
    [stopSession],
  );

  const timingStats = useMemo(() => {
    if (timingHits.length === 0) return null;
    const errors = timingHits.map((hit) => hit.errorMs);
    const averageAbsolute =
      errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length;
    const bias = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    const onTime = Math.round(
      (errors.filter((value) => Math.abs(value) <= 30).length / errors.length) *
        100,
    );
    return { averageAbsolute, bias, onTime };
  }, [timingHits]);

  const timingWord =
    latestError === null
      ? "Waiting"
      : Math.abs(latestError) <= 12
        ? "On time"
        : latestError < 0
          ? "Early"
          : "Late";
  const statusLabel =
    inputStatus === "listening"
      ? "Guitar input live"
      : inputStatus === "starting"
        ? "Connecting input"
        : inputStatus === "error"
          ? "Metronome only"
          : "Stopped";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-pulse" />
          PICKPULSE
        </div>
        <div className={`input-status ${inputStatus}`}>
          <span />
          {statusLabel}
        </div>
      </header>

      <section className="transport" aria-label="Metronome controls">
        <div className="bpm-control">
          <span className="control-label">METRONOME</span>
          <div className="bpm-stepper">
            <button
              type="button"
              onClick={() => setTargetBpm((value) => clampBpm(value - 1))}
              aria-label="Decrease BPM"
            >
              −
            </button>
            <label>
              <input
                type="number"
                min="30"
                max="240"
                value={targetBpm}
                onChange={(event) =>
                  setTargetBpm(clampBpm(Number(event.target.value) || 30))
                }
                aria-label="Metronome BPM"
              />
              <small>BPM</small>
            </label>
            <button
              type="button"
              onClick={() => setTargetBpm((value) => clampBpm(value + 1))}
              aria-label="Increase BPM"
            >
              +
            </button>
          </div>
        </div>

        <div className="subdivision-control">
          <span className="control-label">YOU PLAY</span>
          <div className="segments">
            {subdivisions.map((item) => (
              <button
                key={item.value}
                type="button"
                className={attacksPerBeat === item.value ? "selected" : ""}
                aria-pressed={attacksPerBeat === item.value}
                onClick={() => setAttacksPerBeat(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="volume-control">
          <div>
            <span className="control-label">CLICK VOLUME</span>
            <output>{clickVolume === 100 ? "MAX" : `${clickVolume}%`}</output>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={clickVolume}
            onChange={(event) => setClickVolume(Number(event.target.value))}
            aria-label="Metronome click volume"
          />
        </div>

        <button
          type="button"
          className={`session-button ${sessionRunning ? "stop" : ""}`}
          onClick={sessionRunning ? stopSession : startSession}
        >
          <span>{sessionRunning ? "■" : "▶"}</span>
          {sessionRunning ? "STOP" : "START"}
        </button>
      </section>

      <section className="beat-row" aria-label="Four beat metronome">
        {[0, 1, 2, 3].map((beat) => (
          <span
            key={beat}
            className={`${activeBeat === beat ? "active" : ""} ${
              beat === 0 ? "accent" : ""
            }`}
          />
        ))}
      </section>

      <section className="readouts">
        <article className="readout-card">
          <span className="control-label">YOUR PLAYING</span>
          <div className="primary-number">
            {detectedBpm === null ? "—" : detectedBpm.toFixed(1)}
            <small>BPM</small>
          </div>
          <p>
            {detectedBpm === null
              ? "Play four steady notes"
              : `${confidence}% confidence · ${attackCount} picks`}
          </p>
        </article>

        <article className={`readout-card timing ${timingWord.toLowerCase().replace(" ", "-")}`}>
          <span className="control-label">LATEST HIT</span>
          <div className="primary-number">
            {latestError === null
              ? "—"
              : `${latestError > 0 ? "+" : ""}${Math.round(latestError)}`}
            <small>MS</small>
          </div>
          <p>{timingWord}</p>
        </article>
      </section>

      <section className="error-panel" aria-label="Early and late timing graph">
        <div className="error-heading">
          <div>
            <span className="control-label">TIMING ERROR</span>
            <h1>EARLY / LATE</h1>
          </div>
          <div className="input-meter">
            <span>INPUT</span>
            <i>
              <b style={{ width: `${inputLevel * 100}%` }} />
            </i>
          </div>
        </div>

        <div className="error-scale">
          <span>−100 ms</span>
          <span>−50</span>
          <span className="zero">0</span>
          <span>+50</span>
          <span>+100 ms</span>
        </div>
        <div className="error-lane">
          <div className="perfect-zone" />
          <div className="center-line" />
          {timingHits.map((hit, index) => {
            const position =
              50 + Math.max(-1, Math.min(1, hit.errorMs / 100)) * 50;
            const age = timingHits.length - 1 - index;
            return (
              <span
                key={hit.id}
                className="hit-marker"
                style={{
                  left: `${position}%`,
                  opacity: Math.max(0.18, 1 - age * 0.035),
                  height: `${age === 0 ? 58 : 36}px`,
                }}
                title={`${Math.round(hit.errorMs)} ms`}
              />
            );
          })}
          {timingHits.length === 0 && (
            <p>Hits will appear here when you play</p>
          )}
        </div>

        <div className="stats-row">
          <div>
            <span>AVG ERROR</span>
            <strong>
              {timingStats ? `${Math.round(timingStats.averageAbsolute)} ms` : "—"}
            </strong>
          </div>
          <div>
            <span>BIAS</span>
            <strong>
              {timingStats
                ? `${timingStats.bias > 0 ? "+" : ""}${Math.round(
                    timingStats.bias,
                  )} ms`
                : "—"}
            </strong>
          </div>
          <div>
            <span>WITHIN ±30 MS</span>
            <strong>{timingStats ? `${timingStats.onTime}%` : "—"}</strong>
          </div>
          <button type="button" onClick={resetMeasurements}>
            CLEAR
          </button>
        </div>
      </section>

      <section className="utility-row">
        <label>
          <span>SENSITIVITY</span>
          <input
            type="range"
            min="1"
            max="10"
            value={sensitivity}
            onChange={(event) => setSensitivity(Number(event.target.value))}
          />
          <output>{sensitivity}</output>
        </label>
        <p>Use headphones or a direct guitar input so the mic does not hear the click.</p>
        <p className="privacy">Audio never leaves your device.</p>
      </section>

      {errorMessage && (
        <div className="error-message" role="alert">
          {errorMessage}
        </div>
      )}
    </main>
  );
}
