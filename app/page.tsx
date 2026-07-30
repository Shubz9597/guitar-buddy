"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { estimateTempo } from "./tempo-engine";

type ListenStatus = "idle" | "starting" | "listening" | "error";

const subdivisions = [
  { value: 1, label: "Quarter", count: "1 pick / beat" },
  { value: 2, label: "Eighth", count: "2 picks / beat" },
  { value: 4, label: "Sixteenth", count: "4 picks / beat" },
];

const meterSegments = Array.from({ length: 16 }, (_, index) => index);
const emptyTimingBars = Array.from({ length: 9 }, () => 0);

export default function Home() {
  const [status, setStatus] = useState<ListenStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [bpm, setBpm] = useState<number | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [attackCount, setAttackCount] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [sensitivity, setSensitivity] = useState(7);
  const [attacksPerBeat, setAttacksPerBeat] = useState(2);
  const [targetBpm, setTargetBpm] = useState(100);
  const [timingOffsets, setTimingOffsets] =
    useState<number[]>(emptyTimingBars);
  const [attackFlash, setAttackFlash] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const lastOnsetRef = useRef<number | null>(null);
  const lastDetectedAtRef = useRef(0);
  const attacksPerBeatRef = useRef(attacksPerBeat);
  const sensitivityRef = useRef(sensitivity);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    attacksPerBeatRef.current = attacksPerBeat;
    const estimate = estimateTempo(intervalsRef.current, attacksPerBeat);
    if (estimate) {
      setBpm(estimate.bpm);
      setConfidence(estimate.confidence);
      setTimingOffsets(estimate.offsets);
    }
  }, [attacksPerBeat]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const resetSession = useCallback(() => {
    intervalsRef.current = [];
    lastOnsetRef.current = null;
    lastDetectedAtRef.current = 0;
    setBpm(null);
    setConfidence(0);
    setAttackCount(0);
    setTimingOffsets(emptyTimingBars);
  }, []);

  const registerOnset = useCallback((timeMs: number) => {
    if (timeMs - lastDetectedAtRef.current < 75) return;
    lastDetectedAtRef.current = timeMs;

    setAttackCount((count) => count + 1);
    setAttackFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setAttackFlash(false), 90);

    const previousOnset = lastOnsetRef.current;
    lastOnsetRef.current = timeMs;

    if (previousOnset === null) return;

    const interval = timeMs - previousOnset;
    if (interval > 3000) {
      intervalsRef.current = [];
      setBpm(null);
      setConfidence(0);
      setTimingOffsets(emptyTimingBars);
      return;
    }

    if (interval < 60) return;

    intervalsRef.current = [...intervalsRef.current, interval].slice(-12);
    const estimate = estimateTempo(
      intervalsRef.current,
      attacksPerBeatRef.current,
    );

    if (estimate) {
      setBpm(estimate.bpm);
      setConfidence(estimate.confidence);
      setTimingOffsets(estimate.offsets);
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close();
    }

    setInputLevel(0);
  }, []);

  const stopListening = useCallback(() => {
    stopAudio();
    setStatus("idle");
  }, [stopAudio]);

  const startListening = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage(
        "This browser cannot access an audio input. Try a current version of Chrome, Edge, or Safari.",
      );
      return;
    }

    setStatus("starting");
    setErrorMessage("");
    resetSession();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();

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
      audioContextRef.current = context;
      setStatus("listening");

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
        if (audioContextRef.current !== context) return;

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
        const deviationMultiplier = 3.45 - currentSensitivity * 0.22;
        const fluxThreshold =
          fluxMean + fluxDeviation * deviationMultiplier + 0.18;
        const minimumRms = 0.0025 + (10 - currentSensitivity) * 0.0012;
        const isCalibrated = context.currentTime - startedAt > 0.65;

        if (
          isCalibrated &&
          spectralFlux > fluxThreshold &&
          rms > minimumRms &&
          nowMs - lastDetectedAtRef.current > 75
        ) {
          registerOnset(nowMs);
        }

        animationFrameRef.current = requestAnimationFrame(analyse);
      };

      animationFrameRef.current = requestAnimationFrame(analyse);
    } catch (error) {
      stopAudio();
      setStatus("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setErrorMessage(
          "Microphone access was blocked. Allow it in your browser, then try again.",
        );
      } else {
        setErrorMessage(
          "I could not start the audio input. Check that your microphone or interface is connected.",
        );
      }
    }
  }, [registerOnset, resetSession, stopAudio]);

  useEffect(
    () => () => {
      stopAudio();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [stopAudio],
  );

  const bpmDelta = bpm === null ? null : bpm - targetBpm;
  const roundedDelta = bpmDelta === null ? 0 : Math.round(Math.abs(bpmDelta));
  const tempoPosition =
    bpm === null ? 0 : Math.max(0, Math.min(100, ((bpm - 40) / 180) * 100));
  const selectedSubdivision =
    subdivisions.find((item) => item.value === attacksPerBeat) ??
    subdivisions[1];
  const statusCopy =
    status === "starting"
      ? "Connecting input…"
      : status === "listening"
        ? "Listening live"
        : status === "error"
          ? "Input needs attention"
          : bpm === null
            ? "Ready when you are"
            : "Last measured phrase";
  const paceLabel =
    bpmDelta === null
      ? "Play at least four even notes"
      : Math.abs(bpmDelta) < 1.5
        ? "Right on target"
        : `${roundedDelta} BPM ${bpmDelta > 0 ? "fast" : "slow"}`;
  const coachingCopy =
    bpmDelta === null
      ? "Keep the pick attack clean and leave a little space between notes."
      : Math.abs(bpmDelta) < 1.5
        ? "Your pulse is sitting comfortably on the target."
        : bpmDelta > 0
          ? "Relax your picking hand and let a little more time open up."
          : "Bring the next pick forward slightly without tensing up.";

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="PickPulse home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>PICKPULSE</span>
        </a>
        <div className="header-note">
          <span className="privacy-dot" />
          Audio stays on this device
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">REAL-TIME PICK ANALYSIS</p>
          <h1>
            Find the tempo
            <span>hiding in your hands.</span>
          </h1>
          <p className="hero-intro">
            Play a steady phrase and PickPulse turns each guitar attack into a
            clear BPM reading. It is already set for your eighth-note practice
            at 100 BPM.
          </p>
          <div className="hero-facts">
            <span>
              <strong>01</strong> Plug in or use your mic
            </span>
            <span>
              <strong>02</strong> Pick evenly
            </span>
            <span>
              <strong>03</strong> Read your tempo
            </span>
          </div>
        </div>

        <section
          className={`tempo-console ${attackFlash ? "attack-flash" : ""}`}
          aria-live="polite"
          aria-label="Live tempo reading"
        >
          <div className="console-topline">
            <div className="live-state">
              <span className={status === "listening" ? "live-dot" : ""} />
              {statusCopy}
            </div>
            <label className="target-control">
              <span>Target</span>
              <input
                type="number"
                min="40"
                max="220"
                value={targetBpm}
                onChange={(event) =>
                  setTargetBpm(
                    Math.max(40, Math.min(220, Number(event.target.value) || 40)),
                  )
                }
                aria-label="Target BPM"
              />
              <span>BPM</span>
            </label>
          </div>

          <div className="tempo-readout">
            <div className="bpm-value">
              {bpm === null ? <span className="waiting-mark">—</span> : bpm.toFixed(1)}
            </div>
            <div className="bpm-unit">BPM</div>
          </div>

          <div className="tempo-ruler" aria-hidden="true">
            <div className="ruler-track">
              <span
                className={`tempo-needle ${bpm === null ? "needle-hidden" : ""}`}
                style={{ left: `${tempoPosition}%` }}
              />
            </div>
            <div className="ruler-labels">
              <span>40</span>
              <span>100</span>
              <span>160</span>
              <span>220</span>
            </div>
          </div>

          <div className="coaching-row">
            <div>
              <p className="pace-label">{paceLabel}</p>
              <p>{coachingCopy}</p>
            </div>
            <div className="confidence">
              <span>{bpm === null ? "—" : `${confidence}%`}</span>
              confidence
            </div>
          </div>

          <div className="timing-strip" aria-label="Recent timing consistency">
            {(timingOffsets.length > 0 ? timingOffsets : emptyTimingBars).map(
              (offset, index) => (
                <span
                  key={`${index}-${offset}`}
                  className={bpm === null ? "timing-bar muted" : "timing-bar"}
                  style={{
                    height: `${24 + (index % 3) * 8}px`,
                    transform: `translateY(${offset * 13}px)`,
                  }}
                />
              ),
            )}
            <i className="timing-center" />
          </div>
        </section>
      </section>

      <section className="control-deck" id="setup">
        <div className="control-block subdivision-control">
          <div className="control-heading">
            <span className="control-number">A</span>
            <div>
              <p>What are you playing?</p>
              <small>This tells the app how picks relate to the beat.</small>
            </div>
          </div>
          <div className="segmented-control" aria-label="Note subdivision">
            {subdivisions.map((item) => (
              <button
                key={item.value}
                type="button"
                className={attacksPerBeat === item.value ? "selected" : ""}
                aria-pressed={attacksPerBeat === item.value}
                onClick={() => setAttacksPerBeat(item.value)}
              >
                <span>{item.label}</span>
                <small>{item.count}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="control-block sensitivity-control">
          <div className="control-heading">
            <span className="control-number">B</span>
            <div>
              <p>Input sensitivity</p>
              <small>Raise it for quiet picking; lower it in a noisy room.</small>
            </div>
          </div>
          <div className="slider-row">
            <span>Less</span>
            <input
              type="range"
              min="1"
              max="10"
              value={sensitivity}
              onChange={(event) => setSensitivity(Number(event.target.value))}
              aria-label="Input sensitivity"
            />
            <output>{sensitivity}</output>
          </div>
          <div className="input-meter" aria-label="Input signal level">
            {meterSegments.map((segment) => (
              <span
                key={segment}
                className={
                  segment / meterSegments.length < inputLevel ? "active" : ""
                }
              />
            ))}
          </div>
          <div className="meter-caption">
            <span>Input signal</span>
            <span>{attackCount} attacks found</span>
          </div>
        </div>

        <div className="action-block">
          <button
            type="button"
            className={
              status === "listening" ? "listen-button stop" : "listen-button"
            }
            onClick={
              status === "listening" || status === "starting"
                ? stopListening
                : startListening
            }
            disabled={status === "starting"}
          >
            <span className="button-icon" aria-hidden="true">
              {status === "listening" ? "■" : "●"}
            </span>
            {status === "starting"
              ? "Connecting…"
              : status === "listening"
                ? "Stop listening"
                : "Start listening"}
          </button>
          <button
            type="button"
            className="tap-button"
            onClick={() => registerOnset(performance.now())}
          >
            Tap test
          </button>
          <p>
            Current mode: <strong>{selectedSubdivision.label} notes</strong>
          </p>
        </div>
      </section>

      {errorMessage && (
        <div className="error-message" role="alert">
          <span>!</span>
          <p>{errorMessage}</p>
        </div>
      )}

      <section className="explanation">
        <div className="explanation-title">
          <p className="eyebrow">THE IMPORTANT BIT</p>
          <h2>BPM needs musical context.</h2>
        </div>
        <div className="explanation-copy">
          <p>
            A microphone can hear the time between picks, but it cannot know
            whether each pick is a quarter, eighth, or sixteenth note. That is
            why the subdivision setting matters.
          </p>
          <div className="math-card">
            <span>At 100 BPM</span>
            <strong>eighth notes land every 300 ms</strong>
            <small>2 picks per beat · 200 pick attacks per minute</small>
          </div>
        </div>
      </section>

      <section className="practice-notes">
        <article>
          <span>01</span>
          <h3>Give it four clean picks</h3>
          <p>
            The first few attacks establish the pulse. The reading becomes
            steadier as you keep playing.
          </p>
        </article>
        <article>
          <span>02</span>
          <h3>Mute unwanted string noise</h3>
          <p>
            Extra knocks and ringing strings can look like new notes. Clean
            muting gives a cleaner result.
          </p>
        </article>
        <article>
          <span>03</span>
          <h3>Use a direct input if possible</h3>
          <p>
            An audio interface gives the detector a clearer attack than a room
            microphone, though either can work.
          </p>
        </article>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top">
          PICKPULSE
        </a>
        <p>No recording. No upload. Just your timing.</p>
        <button type="button" onClick={resetSession}>
          Reset session
        </button>
      </footer>
    </main>
  );
}
