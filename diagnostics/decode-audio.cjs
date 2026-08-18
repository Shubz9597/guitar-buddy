const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const inputPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);
const metadataPath = `${outputPath}.json`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  await window.loadURL("about:blank");
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const fs = window.require("node:fs");
      const input = fs.readFileSync(${JSON.stringify(inputPath)});
      const bytes = input.buffer.slice(
        input.byteOffset,
        input.byteOffset + input.byteLength,
      );
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(bytes);
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = 0; index < data.length; index += 1) {
          mono[index] += data[index] / decoded.numberOfChannels;
        }
      }
      const output = Buffer.from(
        mono.buffer,
        mono.byteOffset,
        mono.byteLength,
      );
      fs.writeFileSync(${JSON.stringify(outputPath)}, output);
      const metadata = {
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        frames: decoded.length,
        durationSeconds: decoded.duration,
      };
      fs.writeFileSync(
        ${JSON.stringify(metadataPath)},
        JSON.stringify(metadata, null, 2),
      );
      await context.close();
      return metadata;
    })()
  `);

  process.stdout.write(`${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
});

app.on("window-all-closed", () => app.quit());
