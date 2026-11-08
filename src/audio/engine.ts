import type { DetectorSettings } from "./onset-detector";
import type { WorkletCommand, WorkletMessage } from "./guitar-input.worklet";
import workletUrl from "./guitar-input.worklet.ts?worker&url";

export interface InputInfo {
  label: string;
  /** Input + output latency reported by the browser, in ms. */
  reportedLatencyMs: number;
}

type Listener = (message: WorkletMessage) => void;
type SinkContext = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };

export const canSelectOutput = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

/** Owns the shared AudioContext, the guitar input and the click output device. */
class AudioEngine {
  private context: AudioContext | null = null;
  private workletLoaded: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private outputDeviceId = "";
  private inputRun = 0;
  private readonly listeners = new Set<Listener>();
  onInputLost: (() => void) | null = null;

  async getContext(): Promise<AudioContext> {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.workletLoaded = null;
      await this.applyOutputDevice();
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  /** Returns false when the device could not be selected (the default output stays in use). */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDeviceId = deviceId;
    return this.context ? this.applyOutputDevice() : true;
  }

  private async applyOutputDevice() {
    const context = this.context as SinkContext | null;
    if (!context?.setSinkId) return this.outputDeviceId === "";
    try {
      await context.setSinkId(this.outputDeviceId);
      return true;
    } catch {
      return false;
    }
  }

  async startInput(deviceId: string, settings: DetectorSettings): Promise<InputInfo> {
    this.stopInput();
    const run = this.inputRun;
    const context = await this.getContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Processing meant for voice calls smears and gates guitar attacks.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    const release = () => stream.getTracks().forEach((track) => track.stop());
    if (run !== this.inputRun) {
      release();
      throw new DOMException("Input was replaced", "AbortError");
    }

    this.workletLoaded ??= context.audioWorklet.addModule(workletUrl);
    try {
      await this.workletLoaded;
    } catch (error) {
      this.workletLoaded = null;
      release();
      throw error;
    }
    if (run !== this.inputRun) {
      release();
      throw new DOMException("Input was replaced", "AbortError");
    }

    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "guitar-input", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: "max",
    });
    node.port.onmessage = ({ data }: MessageEvent<WorkletMessage>) => {
      for (const listener of this.listeners) listener(data);
    };
    this.post(node, { type: "configure", settings });
    source.connect(node);
    // The node must be pulled by the graph to run; its output is silent.
    node.connect(context.destination);
    this.stream = stream;
    this.source = source;
    this.node = node;

    const track = stream.getAudioTracks()[0];
    track?.addEventListener(
      "ended",
      () => {
        if (run !== this.inputRun) return;
        this.stopInput();
        this.onInputLost?.();
      },
      { once: true },
    );
    return { label: track?.label ?? "", reportedLatencyMs: this.reportedLatencyMs(context, track) };
  }

  private reportedLatencyMs(context: AudioContext, track: MediaStreamTrack | undefined) {
    const input = (track?.getSettings() as MediaTrackSettings & { latency?: number })?.latency;
    const output = context.outputLatency || context.baseLatency;
    const seconds = (Number.isFinite(input) && input! > 0 ? input! : 0) + (Number.isFinite(output) ? output : 0);
    return Math.round(Math.min(0.2, Math.max(0, seconds)) * 1000);
  }

  configure(settings: Partial<DetectorSettings>) {
    if (this.node) this.post(this.node, { type: "configure", settings });
  }

  private post(node: AudioWorkletNode, command: WorkletCommand) {
    node.port.postMessage(command);
  }

  stopInput() {
    this.inputRun += 1;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get currentTimeMs() {
    return this.context ? this.context.currentTime * 1000 : 0;
  }

  /** Output latency in seconds, for lining visuals up with the audible click. */
  get outputLatency() {
    return this.context ? this.context.outputLatency || this.context.baseLatency || 0 : 0;
  }
}

export const audioEngine = new AudioEngine();
