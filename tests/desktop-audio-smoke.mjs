// Run after build:desktop. This exercises Chromium's real AudioWorklet loader
// from the same file:// origin and sandbox settings as the desktop application.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

app.setPath("userData", path.resolve(testDirectory, "../outputs/electron-audio-smoke"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const timeout = setTimeout(() => {
    console.error("Desktop audio smoke test timed out");
    app.exit(1);
  }, 15000);
  try {
    const asset = fs.readdirSync(path.resolve(testDirectory, "../desktop-dist/assets"))
      .find((name) => /^guitar-processor-.*\.js$/.test(name));
    assert.ok(asset, "Built AudioWorklet asset is missing");
    await window.loadFile(path.resolve(testDirectory, "../desktop-dist/index.html"));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      await context.audioWorklet.addModule(${JSON.stringify(`./assets/${asset}`)});
      const processor = new AudioWorkletNode(context, "pickpulse-guitar", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: "max",
      });
      processor.port.postMessage({ type: "settings", sensitivity: 7, mode: "pick" });
      const frames = [];
      processor.port.onmessage = ({ data }) => frames.push(...data.frames);
      const outputMeter = context.createAnalyser();
      processor.connect(outputMeter);
      outputMeter.connect(context.destination);
      const buffer = context.createBuffer(2, 48000 * 5, 48000);
      const right = buffer.getChannelData(1);
      const times = [];
      for (let time = 0.3; time < 4.5; time += 0.3) {
        times.push(time * 1000);
        const start = Math.round(time * 48000);
        for (let i = 0; i < 10000; i += 1) {
          const t = i / 48000;
          const envelope = (1 - Math.exp(-t / 0.001)) * Math.exp(-t / 0.05);
          for (let h = 1; h <= 8; h += 1) {
            right[start + i] += 0.1 * envelope * Math.sin(2 * Math.PI * 82.41 * h * t) / h;
          }
        }
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(processor);
      const origin = context.currentTime + 0.1;
      source.start(origin);
      await context.resume();
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const output = new Float32Array(outputMeter.fftSize);
      outputMeter.getFloatTimeDomainData(output);
      const inputActive = frames.slice(-16).some((frame) => frame.rms > 0.0001);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      processor.disconnect();
      processor.port.close();
      await context.close();
      return {
        onsets: frames.filter((frame) => frame.onset).map((frame) => frame.timeMs - origin * 1000),
        times,
        channels: [...new Set(frames.filter((frame) => frame.onset).map((frame) => frame.channel))],
        spacing: frames.slice(1).every((frame, i) => Math.abs(frame.timeMs - frames[i].timeMs - 5) < 0.0001),
        gaps: frames.slice(1).map((frame, i) => frame.timeMs - frames[i].timeMs)
          .filter((gap) => Math.abs(gap - 5) > 0.0001),
        outputSilent: output.every((value) => value === 0),
        inputActive,
      };
    })()`, true);
    assert.equal(result.onsets.length, result.times.length, JSON.stringify(result));
    result.onsets.forEach((time, i) => assert.ok(Math.abs(time - result.times[i]) < 22));
    assert.deepEqual(result.channels, [2]);
    assert.equal(result.spacing, true, JSON.stringify(result));
    assert.equal(result.outputSilent, true);
    assert.equal(result.inputActive, true);
    console.log("Desktop audio smoke passed: file:// worklet, right-channel capture, 5 ms sample clock, silent output.");
    clearTimeout(timeout);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    window.destroy();
    app.exit(1);
  }
});
