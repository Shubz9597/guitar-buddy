"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clickIntervalSeconds,
  clampBpm,
  createClickPattern,
  cycleStepState,
  estimateTempo,
  isLikelyEffectRepeat,
  minimumAttackSpacingMs,
  nearestTimingErrorMs,
  parseBpmDraft,
  subdivisionIntervalMs,
} from "./tempo-engine";

type InputStatus = "idle" | "starting" | "listening" | "error";
type TimingHit = { id: number; errorMs: number };
type StepState = 0 | 1 | 2;
type AudioRouteDevice = { deviceId: string; label: string };

type OutputSelectableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

async function routeContextOutput(
  context: AudioContext,
  deviceId: string,
) {
  const selectableContext = context as OutputSelectableAudioContext;
  if (typeof selectableContext.setSinkId !== "function") {
    return deviceId === "";
  }

  await selectableContext.setSinkId(deviceId);
  return true;
}

const subdivisions = [
  { value: 1, label: "1/4" },
  { value: 2, label: "1/8" },
  { value: 3, label: "1/3" },
  { value: 4, label: "1/16" },
];

const clickDivisions = [
  { value: 1, label: "1/4" },
  { value: 2, label: "1/8" },
  { value: 3, label: "1/8T" },
  { value: 4, label: "1/16" },
];

const bpmCountLabels: Record<number, string> = {
  1: "pick",
  2: "2nd pick",
  3: "3rd pick",
  4: "4th pick",
};

export default function Home() {
  const [targetBpm, setTargetBpm] = useState(100);
  const [bpmDraft, setBpmDraft] = useState("100");
  const [attacksPerBeat, setAttacksPerBeat] = useState(2);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [clicksPerBeat, setClicksPerBeat] = useState(1);
  const [clickPattern, setClickPattern] = useState<StepState[]>(
    () => createClickPattern(4, 1) as StepState[],
  );
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
  const [activeStep, setActiveStep] = useState(-1);
  const [latencyCompensationMs, setLatencyCompensationMs] = useState(0);
  const [audioInputs, setAudioInputs] = useState<AudioRouteDevice[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<AudioRouteDevice[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [routingMessage, setRoutingMessage] = useState(
    "Pick any Windows recording input. VoiceMeeter is optional.",
  );

  const audioContextRef = useRef<AudioContext | null>(null);
  const clickBufferRef = useRef<AudioBuffer | null>(null);
  const clickOutputRef = useRef<AudioNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const schedulerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseTimersRef = useRef<Set<number>>(new Set());
  const nextClickTimeRef = useRef(0);
  const stepIndexRef = useRef(0);
  const gridOriginMsRef = useRef<number | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const lastOnsetRef = useRef<number | null>(null);
  const lastOnsetStrengthRef = useRef(0);
  const lastDetectedAtRef = useRef(0);
  const analysisRunRef = useRef(0);
  const targetBpmRef = useRef(targetBpm);
  const attacksPerBeatRef = useRef(attacksPerBeat);
  const clicksPerBeatRef = useRef(clicksPerBeat);
  const clickPatternRef = useRef<StepState[]>(clickPattern);
  const clickVolumeRef = useRef(clickVolume / 100);
  const sensitivityRef = useRef(sensitivity);
  const sessionRunningRef = useRef(false);
  const hitIdRef = useRef(0);
  const latencyCompensationMsRef = useRef(0);
  const inputDeviceIdRef = useRef("");
  const outputDeviceIdRef = useRef("");

  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const makeOptions = (
        kind: MediaDeviceKind,
        fallbackName: string,
      ): AudioRouteDevice[] => {
        const seen = new Set<string>();
        return devices
          .filter(
            (device) =>
              device.kind === kind &&
              device.deviceId !== "default" &&
              device.deviceId !== "communications" &&
              !seen.has(device.deviceId),
          )
          .map((device, index) => {
            seen.add(device.deviceId);
            return {
              deviceId: device.deviceId,
              label: device.label || `${fallbackName} ${index + 1}`,
            };
          });
      };

      const inputs = makeOptions("audioinput", "Audio input");
      const outputs = makeOptions("audiooutput", "Audio output");
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      setInputDeviceId((current) => {
        const next =
          current === "" || inputs.some((device) => device.deviceId === current)
            ? current
            : "";
        inputDeviceIdRef.current = next;
        return next;
      });
      setOutputDeviceId((current) => {
        const next =
          current === "" || outputs.some((device) => device.deviceId === current)
            ? current
            : "";
        outputDeviceIdRef.current = next;
        return next;
      });
    } catch {
      setRoutingMessage("Audio device list is unavailable on this system.");
    }
  }, []);

  const resetMeasurements = useCallback(() => {
    intervalsRef.current = [];
    lastOnsetRef.current = null;
    lastOnsetStrengthRef.current = 0;
    lastDetectedAtRef.current = 0;
    hitIdRef.current = 0;
    setDetectedBpm(null);
    setConfidence(0);
    setAttackCount(0);
    setTimingHits([]);
    setLatestError(null);
  }, []);

  const commitBpmDraft = useCallback(() => {
    const nextBpm = parseBpmDraft(bpmDraft, targetBpm);
    setTargetBpm(nextBpm);
    setBpmDraft(String(nextBpm));
  }, [bpmDraft, targetBpm]);

  const stepBpm = useCallback(
    (amount: number) => {
      const nextBpm = clampBpm(targetBpm + amount);
      setTargetBpm(nextBpm);
      setBpmDraft(String(nextBpm));
    },
    [targetBpm],
  );

  useEffect(() => {
    targetBpmRef.current = targetBpm;
    attacksPerBeatRef.current = attacksPerBeat;

    const estimate = estimateTempo(
      intervalsRef.current,
      attacksPerBeat,
      targetBpm,
    );
    if (estimate) {
      setDetectedBpm(estimate.bpm);
      setConfidence(estimate.confidence);
    }

    const context = audioContextRef.current;
    if (sessionRunningRef.current && context) {
      const restartAt = context.currentTime + 0.12;
      nextClickTimeRef.current = restartAt;
      gridOriginMsRef.current = restartAt * 1000;
      stepIndexRef.current = 0;
      setActiveStep(-1);
      setTimingHits([]);
      setLatestError(null);
    }
  }, [attacksPerBeat, targetBpm]);

  useEffect(() => {
    clicksPerBeatRef.current = clicksPerBeat;
    const nextPattern = createClickPattern(
      beatsPerBar,
      clicksPerBeat,
    ) as StepState[];
    clickPatternRef.current = nextPattern;
    setClickPattern(nextPattern);

    const context = audioContextRef.current;
    if (sessionRunningRef.current && context) {
      const restartAt = context.currentTime + 0.12;
      nextClickTimeRef.current = restartAt;
      gridOriginMsRef.current = restartAt * 1000;
      stepIndexRef.current = 0;
      setActiveStep(-1);
    }
  }, [beatsPerBar, clicksPerBeat]);

  useEffect(() => {
    clickVolumeRef.current = clickVolume / 100;
  }, [clickVolume]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    inputDeviceIdRef.current = inputDeviceId;
  }, [inputDeviceId]);

  useEffect(() => {
    outputDeviceIdRef.current = outputDeviceId;
  }, [outputDeviceId]);

  useEffect(() => {
    void refreshAudioDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;

    const handleDeviceChange = () => void refreshAudioDevices();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () =>
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshAudioDevices]);

  const registerOnset = useCallback((timeMs: number, strength: number) => {
    const expectedInterval = subdivisionIntervalMs(
      targetBpmRef.current,
      attacksPerBeatRef.current,
    );
    const refractoryMs = Math.max(42, Math.min(90, expectedInterval * 0.42));

    if (timeMs - lastDetectedAtRef.current < refractoryMs) return;
    lastDetectedAtRef.current = timeMs;

    const previousOnset = lastOnsetRef.current;
    const duplicateWindowMs = minimumAttackSpacingMs(
      targetBpmRef.current,
      attacksPerBeatRef.current,
    );
    if (
      previousOnset !== null &&
      timeMs - previousOnset < duplicateWindowMs
    ) {
      return;
    }
    if (
      previousOnset !== null &&
      isLikelyEffectRepeat(
        timeMs - previousOnset,
        expectedInterval,
        strength,
        lastOnsetStrengthRef.current,
      )
    ) {
      return;
    }

    setAttackCount((count) => count + 1);

    const gridOriginMs = gridOriginMsRef.current;
    if (sessionRunningRef.current && gridOriginMs !== null) {
      const errorMs = nearestTimingErrorMs(
        timeMs - latencyCompensationMsRef.current,
        gridOriginMs,
        targetBpmRef.current,
        attacksPerBeatRef.current,
      );
      const hit = { id: ++hitIdRef.current, errorMs };
      setLatestError(errorMs);
      setTimingHits((hits) => [...hits, hit].slice(-28));
    }

    lastOnsetRef.current = timeMs;
    lastOnsetStrengthRef.current = strength;
    if (previousOnset === null) return;

    const interval = timeMs - previousOnset;
    if (interval > 3000) {
      intervalsRef.current = [];
      setDetectedBpm(null);
      setConfidence(0);
      return;
    }

    if (interval < 35) return;
    intervalsRef.current = [...intervalsRef.current, interval].slice(-24);
    const estimate = estimateTempo(
      intervalsRef.current,
      attacksPerBeatRef.current,
      targetBpmRef.current,
    );
    if (estimate) {
      setDetectedBpm(estimate.bpm);
      setConfidence(estimate.confidence);
    }
  }, []);

  const scheduleClick = useCallback(
    (
      context: AudioContext,
      time: number,
      step: number,
      stepState: StepState,
    ) => {
      const buffer = clickBufferRef.current;
      if (!buffer) return;
      const clickOutput = clickOutputRef.current ?? context.destination;

      if (stepState !== 0) {
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const gain = context.createGain();
        const oscillator = context.createOscillator();
        const oscillatorGain = context.createGain();
        const accent = stepState === 2;
        const volume = clickVolumeRef.current;

        source.buffer = buffer;
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(accent ? 4300 : 3100, time);
        filter.Q.setValueAtTime(0.7, time);
        gain.gain.setValueAtTime(
          Math.max(0.0001, volume * (accent ? 1.05 : 0.82)),
          time,
        );
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.065);

        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(accent ? 2350 : 1650, time);
        oscillatorGain.gain.setValueAtTime(
          Math.max(0.0001, volume * (accent ? 0.68 : 0.45)),
          time,
        );
        oscillatorGain.gain.exponentialRampToValueAtTime(
          0.0001,
          time + 0.045,
        );

        source.connect(filter);
        filter.connect(gain);
        gain.connect(clickOutput);
        oscillator.connect(oscillatorGain);
        oscillatorGain.connect(clickOutput);

        source.start(time);
        source.stop(time + 0.07);
        oscillator.start(time);
        oscillator.stop(time + 0.05);
      }

      const delay = Math.max(0, (time - context.currentTime) * 1000);
      const timer = window.setTimeout(() => {
        setActiveStep(step);
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
      const pattern = clickPatternRef.current;
      const step = stepIndexRef.current % pattern.length;
      scheduleClick(
        context,
        nextClickTimeRef.current,
        step,
        pattern[step],
      );
      nextClickTimeRef.current +=
        clickIntervalSeconds(
          targetBpmRef.current,
          clicksPerBeatRef.current,
        );
      stepIndexRef.current = (step + 1) % pattern.length;
    }
  }, [scheduleClick]);

  const stopInputAnalysis = useCallback(() => {
    analysisRunRef.current += 1;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setInputLevel(0);
  }, []);

  const stopSession = useCallback(() => {
    sessionRunningRef.current = false;

    if (schedulerRef.current) {
      clearInterval(schedulerRef.current);
      schedulerRef.current = null;
    }
    stopInputAnalysis();
    pulseTimersRef.current.forEach((timer) => clearTimeout(timer));
    pulseTimersRef.current.clear();

    const context = audioContextRef.current;
    audioContextRef.current = null;
    clickBufferRef.current = null;
    clickOutputRef.current = null;
    if (context && context.state !== "closed") void context.close();

    gridOriginMsRef.current = null;
    setSessionRunning(false);
    setInputStatus("idle");
    setActiveStep(-1);
  }, [stopInputAnalysis]);

  const startInputAnalysis = useCallback(
    async (context: AudioContext, requestedDeviceId = inputDeviceIdRef.current) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Audio input is not available on this system.");
      }

      stopInputAnalysis();
      const analysisRun = analysisRunRef.current;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          channelCount: 1,
          deviceId: requestedDeviceId
            ? { exact: requestedDeviceId }
            : undefined,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      if (
        analysisRun !== analysisRunRef.current ||
        !sessionRunningRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const source = context.createMediaStreamSource(stream);
      const highPass = context.createBiquadFilter();
      const analyser = context.createAnalyser();

      highPass.type = "highpass";
      highPass.frequency.value = 120;
      highPass.Q.value = 0.7;
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.08;
      source.connect(highPass);
      highPass.connect(analyser);
      streamRef.current = stream;
      const activeTrack = stream.getAudioTracks()[0];
      setRoutingMessage(
        `Guitar input: ${activeTrack?.label || "Windows default input"}`,
      );
      void refreshAudioDevices();

      const trackSettings = stream.getAudioTracks()[0]?.getSettings() as
        | (MediaTrackSettings & { latency?: number })
        | undefined;
      const reportedInputLatency = trackSettings?.latency;
      const inputLatency =
        Number.isFinite(reportedInputLatency) && reportedInputLatency! > 0
          ? reportedInputLatency!
          : 0;
      const contextWithOutputLatency = context as AudioContext & {
        outputLatency?: number;
      };
      const reportedOutputLatency = contextWithOutputLatency.outputLatency;
      const outputLatency =
        Number.isFinite(reportedOutputLatency) && reportedOutputLatency! > 0
          ? reportedOutputLatency!
          : Math.max(0, context.baseLatency || 0);
      const analyserLatency = analyser.fftSize / context.sampleRate / 4;
      const frameLatency = 0.008;
      const measuredLatencyMs = Math.round(
        Math.max(
          0,
          Math.min(
            120,
            (inputLatency + outputLatency + analyserLatency + frameLatency) *
              1000,
          ),
        ),
      );
      latencyCompensationMsRef.current = measuredLatencyMs;
      setLatencyCompensationMs(measuredLatencyMs);

      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      const previousSpectrum = new Uint8Array(analyser.frequencyBinCount);
      const waveform = new Float32Array(analyser.fftSize);
      const binWidth = context.sampleRate / analyser.fftSize;
      const firstBin = Math.max(1, Math.floor(450 / binWidth));
      const lastBin = Math.min(
        analyser.frequencyBinCount - 1,
        Math.ceil(6500 / binWidth),
      );
      const startedAt = context.currentTime;
      let hasPreviousFrame = false;
      let fluxMean = 0;
      let fluxDeviation = 0;
      let nextMeterUpdate = 0;

      const analyse = () => {
        if (
          audioContextRef.current !== context ||
          analysisRun !== analysisRunRef.current ||
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
          const onsetStrength =
            spectralFlux * Math.sqrt(Math.max(rms, 0.00001));
          registerOnset(nowMs, onsetStrength);
        }

        animationFrameRef.current = requestAnimationFrame(analyse);
      };

      setInputStatus("listening");
      animationFrameRef.current = requestAnimationFrame(analyse);
    },
    [refreshAudioDevices, registerOnset, stopInputAnalysis],
  );

  const startSession = useCallback(async () => {
    setErrorMessage("");
    setInputStatus("starting");
    resetMeasurements();

    const context = new AudioContext({ latencyHint: "interactive" });
    audioContextRef.current = context;
    await context.resume();

    try {
      const routed = await routeContextOutput(
        context,
        outputDeviceIdRef.current,
      );
      if (!routed) {
        setRoutingMessage(
          "This Windows audio engine cannot switch output; using the system default.",
        );
      }
    } catch {
      setRoutingMessage(
        "Selected click output is unavailable; using the system default.",
      );
    }

    const clickBus = context.createGain();
    const clickLimiter = context.createDynamicsCompressor();
    const clickMakeup = context.createGain();
    clickBus.gain.value = 1.45;
    clickLimiter.threshold.value = -5;
    clickLimiter.knee.value = 0;
    clickLimiter.ratio.value = 20;
    clickLimiter.attack.value = 0.001;
    clickLimiter.release.value = 0.055;
    clickMakeup.gain.value = 1.08;
    clickBus.connect(clickLimiter);
    clickLimiter.connect(clickMakeup);
    clickMakeup.connect(context.destination);
    clickOutputRef.current = clickBus;

    latencyCompensationMsRef.current = 0;
    setLatencyCompensationMs(0);

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
    stepIndexRef.current = 0;
    runScheduler();
    schedulerRef.current = setInterval(runScheduler, 25);

    try {
      await startInputAnalysis(context, inputDeviceIdRef.current);
    } catch (error) {
      setInputStatus("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setErrorMessage(
          "Audio input access is blocked. The metronome still works; allow input access to measure the guitar.",
        );
      } else {
        setErrorMessage(
          "The selected guitar input is unavailable. The metronome is still running.",
        );
      }
    }
  }, [resetMeasurements, runScheduler, startInputAnalysis]);

  const selectInputDevice = useCallback(
    async (deviceId: string) => {
      setInputDeviceId(deviceId);
      inputDeviceIdRef.current = deviceId;
      const context = audioContextRef.current;
      if (!sessionRunningRef.current || !context) {
        setRoutingMessage(
          deviceId
            ? "Selected guitar input will be used when you press Start."
            : "Windows default recording input will be used when you press Start.",
        );
        return;
      }

      setInputStatus("starting");
      setErrorMessage("");
      resetMeasurements();
      try {
        await startInputAnalysis(context, deviceId);
      } catch {
        setInputStatus("error");
        setErrorMessage("Could not open the selected guitar input.");
      }
    },
    [resetMeasurements, startInputAnalysis],
  );

  const selectOutputDevice = useCallback(async (deviceId: string) => {
    setOutputDeviceId(deviceId);
    outputDeviceIdRef.current = deviceId;
    const context = audioContextRef.current;
    if (!context) {
      setRoutingMessage(
        deviceId
          ? "Selected click output will be used when you press Start."
          : "The click will use the Windows default output.",
      );
      return;
    }

    try {
      const routed = await routeContextOutput(context, deviceId);
      setRoutingMessage(
        routed
          ? "Metronome click output changed."
          : "Output switching is unavailable; using the Windows default.",
      );
    } catch {
      setRoutingMessage(
        "Could not open that click output; the previous output remains active.",
      );
    }
  }, []);

  const scanAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    setRoutingMessage("Scanning Windows and VoiceMeeter audio endpoints...");
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      permissionStream.getTracks().forEach((track) => track.stop());
      await refreshAudioDevices();
      setRoutingMessage(
        "Devices refreshed. Choose the Windows input carrying only your guitar.",
      );
    } catch {
      setRoutingMessage("Audio input permission is required to show device names.");
    }
  }, [refreshAudioDevices]);

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

  const cyclePatternStep = (index: number) => {
    setClickPattern((current) => {
      const next = [...current] as StepState[];
      next[index] = cycleStepState(next[index]) as StepState;
      clickPatternRef.current = next;
      return next;
    });
  };

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
              onClick={() => stepBpm(-1)}
              aria-label="Decrease BPM"
            >
              −
            </button>
            <label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                value={bpmDraft}
                onChange={(event) => {
                  const nextDraft = event.target.value;
                  if (/^\d{0,3}$/.test(nextDraft)) setBpmDraft(nextDraft);
                }}
                onBlur={commitBpmDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitBpmDraft();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setBpmDraft(String(targetBpm));
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Metronome BPM"
              />
              <small>BPM</small>
            </label>
            <button
              type="button"
              onClick={() => stepBpm(1)}
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
          <small className="subdivision-hint">
            BPM counts every {bpmCountLabels[attacksPerBeat]} -{" "}
            {Math.round(
              subdivisionIntervalMs(targetBpm, attacksPerBeat),
            )}{" "}
            ms apart
          </small>
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

      <section className="audio-routing" aria-label="Audio input and output routing">
        <div className="routing-heading">
          <div>
            <span className="control-label">AUDIO ROUTING</span>
            <strong>WINDOWS AUDIO DEVICES</strong>
          </div>
          <button type="button" onClick={scanAudioDevices}>
            SCAN DEVICES
          </button>
        </div>

        <div className="routing-controls">
          <label>
            <span>GUITAR INPUT</span>
            <select
              value={inputDeviceId}
              onChange={(event) => void selectInputDevice(event.target.value)}
              aria-label="Guitar input device"
            >
              <option value="">Windows default input</option>
              {audioInputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <small>
              USB interface, USB guitar cable, line input, or VoiceMeeter bus.
            </small>
          </label>

          <label>
            <span>CLICK OUTPUT</span>
            <select
              value={outputDeviceId}
              onChange={(event) => void selectOutputDevice(event.target.value)}
              aria-label="Metronome output device"
            >
              <option value="">Windows default output</option>
              {audioOutputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <small>The guitar is not monitored through PickPulse.</small>
          </label>
        </div>

        <p>{routingMessage}</p>
      </section>

      <section className="pattern-panel" aria-label="Metronome rhythm pattern">
        <div className="pattern-toolbar">
          <div>
            <span className="control-label">RHYTHM PATTERN</span>
            <strong>
              {beatsPerBar} beats · {clickPattern.length} steps
            </strong>
          </div>

          <div className="beats-control">
            <span>BEATS / BAR</span>
            <button
              type="button"
              onClick={() =>
                setBeatsPerBar((value) => Math.max(1, value - 1))
              }
              aria-label="Remove one beat from the bar"
            >
              −
            </button>
            <output>{beatsPerBar}</output>
            <button
              type="button"
              onClick={() =>
                setBeatsPerBar((value) => Math.min(12, value + 1))
              }
              aria-label="Add one beat to the bar"
            >
              +
            </button>
          </div>

          <div className="click-grid-control">
            <span>CLICK GRID</span>
            <div>
              {clickDivisions.map((division) => (
                <button
                  key={division.value}
                  type="button"
                  className={
                    clicksPerBeat === division.value ? "selected" : ""
                  }
                  aria-pressed={clicksPerBeat === division.value}
                  onClick={() => setClicksPerBeat(division.value)}
                >
                  {division.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="pattern-scroll">
          <div
            className="pattern-grid"
            style={{
              gridTemplateColumns: `repeat(${clickPattern.length}, minmax(34px, 1fr))`,
            }}
          >
            {clickPattern.map((stepState, index) => {
              const stateName =
                stepState === 2
                  ? "accent"
                  : stepState === 0
                    ? "muted"
                    : "normal";
              const isBeatStart = index % clicksPerBeat === 0;
              return (
                <button
                  key={index}
                  type="button"
                  className={`${stateName} ${
                    activeStep === index ? "active" : ""
                  } ${isBeatStart ? "beat-start" : ""}`}
                  onClick={() => cyclePatternStep(index)}
                  aria-label={`Step ${index + 1}, ${stateName}. Click to change.`}
                >
                  <span>
                    {stepState === 2 ? "A" : stepState === 0 ? "×" : "•"}
                  </span>
                  <small>
                    {isBeatStart ? Math.floor(index / clicksPerBeat) + 1 : "·"}
                  </small>
                </button>
              );
            })}
          </div>
        </div>

        <div className="pattern-help">
          <p>
            {clicksPerBeat} {clicksPerBeat === 1 ? "click" : "clicks"} / beat
            - {Math.round(clickIntervalSeconds(targetBpm, clicksPerBeat) * 1000)}
            ms apart - click any step to cycle
          </p>
          <span className="normal">● Normal</span>
          <span className="accent">● Accent</span>
          <span className="muted">× Mute</span>
        </div>
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
        <p>
          Use headphones. A dry/direct guitar signal is most accurate; FX repeat
          guard is automatic.
        </p>
        <p className="privacy">
          Latency correction: âˆ’{latencyCompensationMs} ms Â· Audio never leaves
          your device.
        </p>
      </section>

      {errorMessage && (
        <div className="error-message" role="alert">
          {errorMessage}
        </div>
      )}
    </main>
  );
}
