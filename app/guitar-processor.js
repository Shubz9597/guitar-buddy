/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

// Keep capture on the audio clock. No timers, React work, or output audio run here.
class GuitarProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;
    this.hop = Math.round(sampleRate * 0.005);
    this.rings = [];
    this.position = 0;
    this.samples = 0;
    this.untilHop = this.hop;
    this.channel = 0;
    this.real = new Float64Array(this.size);
    this.imaginary = new Float64Array(this.size);
    this.previousSpectrum = new Float64Array(this.size / 2);
    this.currentSpectrum = new Float64Array(this.size / 2);
    this.window = Float64Array.from(
      { length: this.size },
      (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.size - 1)),
    );
    this.reversed = new Uint16Array(this.size);
    for (let i = 0; i < this.size; i += 1) {
      let value = i;
      for (let bit = 0; bit < 10; bit += 1) {
        this.reversed[i] = (this.reversed[i] << 1) | (value & 1);
        value >>= 1;
      }
    }
    this.mean = 0;
    this.deviation = 0;
    this.before = 0;
    this.previous = null;
    this.frames = [];
    this.sensitivity = 7;
    this.mode = "rhythm";
    this.lastOnsetMs = -Infinity;
    this.generation = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "settings") {
        this.sensitivity = Math.max(1, Math.min(10, data.sensitivity));
        this.mode = data.mode === "pick" ? "pick" : "rhythm";
      }
      if (data.type === "reset") {
        this.generation = data.generation;
        this.lastOnsetMs = -Infinity;
        this.frames = [];
        this.previous = null;
        this.before = 0;
      }
    };
  }

  spectrum() {
    const { real, imaginary, size } = this;
    for (let span = 2; span <= size; span *= 2) {
      const angle = -2 * Math.PI / span;
      const stepReal = Math.cos(angle);
      const stepImaginary = Math.sin(angle);
      for (let start = 0; start < size; start += span) {
        let twiddleReal = 1;
        let twiddleImaginary = 0;
        for (let offset = 0; offset < span / 2; offset += 1) {
          const left = start + offset;
          const right = left + span / 2;
          const r = real[right] * twiddleReal - imaginary[right] * twiddleImaginary;
          const im = real[right] * twiddleImaginary + imaginary[right] * twiddleReal;
          real[right] = real[left] - r;
          imaginary[right] = imaginary[left] - im;
          real[left] += r;
          imaginary[left] += im;
          const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
          twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
          twiddleReal = nextReal;
        }
      }
    }
  }

  analyse(endFrame) {
    // Select a physical channel, rather than summing L/R (which can cancel).
    let bestChannel = this.channel;
    let bestEnergy = 0;
    let currentEnergy = 0;
    for (let channel = 0; channel < this.rings.length; channel += 1) {
      let energy = 0;
      for (const value of this.rings[channel]) energy += value * value;
      if (channel === this.channel) currentEnergy = energy;
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestChannel = channel;
      }
    }
    const changedChannel = bestChannel !== this.channel && bestEnergy > currentEnergy * 4;
    if (changedChannel) {
      this.channel = bestChannel;
      if (this.previous) this.previous.flux = 0;
      this.previousSpectrum.fill(0);
    }
    const ring = this.rings[this.channel];
    let energy = 0;
    for (let i = 0; i < this.size; i += 1) {
      const value = ring[(this.position + i) % this.size];
      energy += value * value;
      this.real[this.reversed[i]] = value * this.window[i];
      this.imaginary[i] = 0;
    }
    this.spectrum();
    let flux = 0;
    const firstBin = Math.max(1, Math.floor(60 * this.size / sampleRate));
    const lastBin = Math.min(this.size / 2 - 1, Math.ceil(6500 * this.size / sampleRate));
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const magnitude = Math.hypot(this.real[bin], this.imaginary[bin]) / this.size;
      // Log compression preserves quiet picks without clipping loud interface inputs.
      const compressed = Math.log1p(magnitude / 0.00005);
      this.currentSpectrum[bin] = compressed;
      // Compare against the previous bin neighbourhood. Sustained harmonics
      // and vibrato move energy between neighbouring FFT bins without a pick.
      const previous = Math.max(
        this.previousSpectrum[bin - 1],
        this.previousSpectrum[bin],
        this.previousSpectrum[bin + 1] ?? 0,
      );
      flux += Math.max(0, compressed - previous - 0.1);
    }
    this.previousSpectrum.set(this.currentSpectrum);
    flux /= lastBin - firstBin + 1;
    if (changedChannel) flux = 0;
    const rms = Math.sqrt(energy / this.size);
    const threshold = this.mean + this.deviation * (2.4 - this.sensitivity * 0.2) + 0.02;
    const previousMean = this.mean;
    this.mean += 0.025 * (flux - this.mean);
    this.deviation += 0.025 * (Math.abs(flux - previousMean) - this.deviation);
    const minimumRms = 0.00004 * (11 - this.sensitivity);
    // Timestamp the window centre. Peak confirmation arrives a hop later but
    // never changes the original capture time.
    const timeMs = (endFrame - this.size / 2) * 1000 / sampleRate;
    const frame = {
      timeMs,
      rms,
      envelope: rms >= minimumRms ? flux : 0,
      onset: false,
      channel: this.channel + 1,
    };
    const previous = this.previous;
    if (previous && previous.flux > this.before && previous.flux >= flux &&
        previous.flux > previous.threshold && previous.rms >= minimumRms &&
        previous.timeMs - this.lastOnsetMs >= (this.mode === "rhythm" ? 55 : 35)) {
      previous.frame.onset = true;
      this.lastOnsetMs = previous.timeMs;
    }
    // Hold one frame for peak confirmation before posting it.
    if (previous) this.frames.push(previous.frame);
    this.before = previous?.flux ?? 0;
    this.previous = { flux, threshold, rms, timeMs, frame };
    if (this.frames.length >= 16) {
      this.port.postMessage({
        frames: this.frames,
        sampleIntervalMs: this.hop * 1000 / sampleRate,
        generation: this.generation,
      });
      this.frames = [];
    }
  }

  process(inputs, outputs = []) {
    const channels = inputs[0] ?? [];
    const blockLength = channels[0]?.length ?? outputs[0]?.[0]?.length ?? 0;
    const channelCount = channels.length || this.rings.length || 1;
    if (this.rings.length !== channelCount) {
      this.rings = Array.from({ length: channelCount }, () => new Float32Array(this.size));
      this.channel = 0;
      if (this.previous) this.previous.flux = 0;
      this.previousSpectrum.fill(0);
    }
    for (let i = 0; i < blockLength; i += 1) {
      for (let channel = 0; channel < this.rings.length; channel += 1) {
        this.rings[channel][this.position] = channels[channel]?.[i] ?? 0;
      }
      this.position = (this.position + 1) % this.size;
      this.samples += 1;
      this.untilHop -= 1;
      if (this.untilHop === 0) {
        this.untilHop = this.hop;
        if (this.samples >= this.size) this.analyse(currentFrame + i + 1);
      }
    }
    // Output is deliberately silent; the guitar is only analysed.
    return true;
  }
}

registerProcessor("pickpulse-guitar", GuitarProcessor);
