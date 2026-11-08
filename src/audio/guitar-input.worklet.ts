// Runs on the audio rendering thread. Messages carry sample-clock times, so a
// busy UI thread never affects measured timing.
import { OnsetDetector, type DetectorSettings } from "./onset-detector";

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

export type WorkletMessage =
  | { type: "onset"; timeMs: number; strength: number }
  | { type: "level"; rms: number; peak: number };

export type WorkletCommand = { type: "configure"; settings: Partial<DetectorSettings> };

class GuitarInputProcessor extends AudioWorkletProcessor {
  private readonly detector = new OnsetDetector(sampleRate);

  constructor() {
    super();
    this.detector.onOnset = (onset) => this.port.postMessage({ type: "onset", ...onset } satisfies WorkletMessage);
    this.detector.onLevel = (level) => this.port.postMessage({ type: "level", ...level } satisfies WorkletMessage);
    this.port.onmessage = ({ data }: MessageEvent<WorkletCommand>) => {
      if (data.type === "configure") this.detector.configure(data.settings);
    };
  }

  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    if (channels && channels.length > 0) this.detector.process(channels, currentFrame);
    // Outputs stay silent: the guitar is analysed, never monitored.
    return true;
  }
}

registerProcessor("guitar-input", GuitarInputProcessor);
