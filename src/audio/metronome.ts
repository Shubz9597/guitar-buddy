/** 0 = muted, 1 = normal, 2 = accent. */
export type StepAccent = 0 | 1 | 2;

export interface MetronomeSettings {
  bpm: number;
  beatsPerBar: number;
  clicksPerBeat: number;
  pattern: StepAccent[];
  /** 0..1 */
  volume: number;
}

export interface Grid {
  /** Audio-clock time of a beat, in ms. */
  originMs: number;
  beatMs: number;
}

export interface ScheduledClick {
  time: number;
  step: number;
}

export const MIN_BPM = 30;
export const MAX_BPM = 260;

export function clampBpm(bpm: number) {
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
}

export function defaultPattern(beatsPerBar: number, clicksPerBeat: number): StepAccent[] {
  return Array.from({ length: beatsPerBar * clicksPerBeat }, (_, step) => (step === 0 ? 2 : 1));
}

export function nextAccent(accent: StepAccent): StepAccent {
  return accent === 1 ? 2 : accent === 2 ? 0 : 1;
}

const LOOKAHEAD_S = 0.15;
const START_DELAY_S = 0.12;

// Timers on the page are throttled when the window is hidden (for example
// behind a DAW). A worker's timer is not, so it drives the scheduler.
const TICKER_SOURCE = `let id;onmessage=(e)=>{clearInterval(id);if(e.data)id=setInterval(()=>postMessage(0),e.data)}`;

function synthClick(context: AudioContext, frequency: number) {
  const rate = context.sampleRate;
  const length = Math.round(rate * 0.06);
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let seed = 1;
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 0x80000000 - 1;
    const body =
      Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / 0.014) +
      0.4 * Math.sin(2 * Math.PI * frequency * 2.37 * t) * Math.exp(-t / 0.006);
    const knock = noise * Math.exp(-t / 0.0015) * 0.5;
    data[i] = 0.6 * (body + knock) * (1 - Math.exp(-t / 0.0004));
  }
  return buffer;
}

/** Sample-accurate click scheduled ahead on the audio clock. */
export class Metronome {
  onGridChange: ((grid: Grid) => void) | null = null;
  readonly scheduled: ScheduledClick[] = [];

  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly sounds: Record<1 | 2, AudioBuffer>;
  private settings: MetronomeSettings;
  private ticker: Worker | null = null;
  private originTime = 0;
  private nextIndex = 0;
  private running = false;

  constructor(context: AudioContext, settings: MetronomeSettings) {
    this.context = context;
    this.settings = settings;
    this.bus = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;
    this.bus.connect(this.limiter);
    this.limiter.connect(context.destination);
    this.sounds = { 1: synthClick(context, 1250), 2: synthClick(context, 1850) };
    this.applyVolume();
  }

  get isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.rebase(this.context.currentTime + START_DELAY_S);
    const url = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: "text/javascript" }));
    this.ticker = new Worker(url);
    URL.revokeObjectURL(url);
    this.ticker.onmessage = () => this.schedule();
    this.ticker.postMessage(25);
    this.schedule();
  }

  stop() {
    this.running = false;
    this.ticker?.terminate();
    this.ticker = null;
    this.scheduled.length = 0;
  }

  dispose() {
    this.stop();
    this.bus.disconnect();
    this.limiter.disconnect();
  }

  update(settings: MetronomeSettings) {
    const previous = this.settings;
    this.settings = settings;
    this.applyVolume();
    if (!this.running) return;
    if (settings.bpm !== previous.bpm) {
      this.rebase(this.timeOf(this.nextIndex, previous));
    } else if (
      settings.clicksPerBeat !== previous.clicksPerBeat ||
      settings.beatsPerBar !== previous.beatsPerBar
    ) {
      // Restart the bar on the next beat; the beat grid itself is unchanged.
      const beat = 60 / previous.bpm;
      const next = this.timeOf(this.nextIndex, previous);
      this.rebase(this.originTime + Math.ceil((next - this.originTime) / beat - 1e-6) * beat);
    }
  }

  private rebase(time: number) {
    this.originTime = time;
    this.nextIndex = 0;
    this.onGridChange?.({ originMs: time * 1000, beatMs: 60000 / this.settings.bpm });
  }

  private applyVolume() {
    // Squared for a natural-feeling fader; above 1 the limiter keeps it clean.
    this.bus.gain.setTargetAtTime(this.settings.volume ** 2 * 1.8, this.context.currentTime, 0.01);
  }

  private timeOf(index: number, settings = this.settings) {
    return this.originTime + (index * 60) / (settings.bpm * settings.clicksPerBeat);
  }

  private schedule() {
    if (!this.running) return;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    const { pattern } = this.settings;
    for (let time = this.timeOf(this.nextIndex); time < horizon; time = this.timeOf(this.nextIndex)) {
      const step = this.nextIndex % pattern.length;
      const accent = pattern[step] ?? 1;
      if (accent !== 0) {
        const source = this.context.createBufferSource();
        source.buffer = this.sounds[accent];
        source.connect(this.bus);
        source.start(time);
      }
      this.scheduled.push({ time, step });
      this.nextIndex += 1;
    }
    const keepAfter = this.context.currentTime - 1;
    while (this.scheduled.length > 0 && this.scheduled[0].time < keepAfter) this.scheduled.shift();
  }
}
