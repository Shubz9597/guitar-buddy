const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#0d0e10",
    title: "Guitar Buddy",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

// ---------- Tone search: REAPER, Z.ai and files ----------
// The renderer builds recipes and scripts; this side only does what a
// sandboxed page cannot: hold the API key, touch files and start REAPER.

const reaperDir = () => path.join(app.getPath("appData"), "REAPER");
const scriptDir = () => path.join(reaperDir(), "Scripts", "GuitarBuddy");
const recipeDir = () => path.join(app.getPath("userData"), "tone-recipes");
const researchDir = () => path.join(app.getPath("userData"), "tone-research");
const REPORTS = new Set(["last-build.txt", "last-probe.txt"]);
const ZAI_PATHS = new Set(["/chat/completions", "/web_search"]);

// Key from the environment, the project's .env (development) or
// %APPDATA%/Guitar Buddy/.env (installed app). Never sent to the renderer.
function zaiKey() {
  if (process.env.ZAI_API_KEY?.trim()) return process.env.ZAI_API_KEY.trim();
  for (const file of [path.join(__dirname, "..", ".env"), path.join(app.getPath("userData"), ".env")]) {
    try {
      const match = /^ZAI_API_KEY=(.*)$/m.exec(fs.readFileSync(file, "utf8"));
      if (match?.[1].trim()) return match[1].trim();
    } catch {
      // Missing file: try the next one.
    }
  }
  return "";
}

function findReaper() {
  const candidates = [];
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\REAPER", "/ve"], { encoding: "utf8", windowsHide: true });
    const match = /REG_SZ\s+(.+)/.exec(out);
    if (match) candidates.push(path.join(match[1].trim(), "reaper.exe"));
  } catch {
    // Not in the registry: fall back to the default install folders.
  }
  candidates.push("C:\\Program Files\\REAPER (x64)\\reaper.exe", "C:\\Program Files\\REAPER\\reaper.exe");
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/** localhost, LAN and link-local addresses, which a web page link must never reach. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return host === "::1" || /^(fc|fd|fe80)/.test(host);
}

const safeName = (name) => String(name).replace(/[^\w\- ]+/g, "").trim().slice(0, 120) || "untitled";

async function mtime(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

// Paths the user picked in a save dialog; the renderer may only write there.
const pickedPaths = new Set();

function registerToneIpc() {
  ipcMain.handle("tone:status", () => ({ hasKey: zaiKey() !== "", reaper: findReaper() }));

  ipcMain.handle("tone:read-plugin-ini", () =>
    fsp.readFile(path.join(reaperDir(), "reaper-vstplugins64.ini"), "utf8"),
  );

  ipcMain.handle("tone:read-probe", async () => {
    try {
      return await fsp.readFile(path.join(scriptDir(), "param-probe.json"), "utf8");
    } catch {
      return null;
    }
  });

  ipcMain.handle("tone:zai", async (_event, apiPath, body) => {
    if (!ZAI_PATHS.has(apiPath)) throw new Error(`Unsupported Z.ai path ${apiPath}`);
    const key = zaiKey();
    if (!key) throw new Error("No Z.ai key: add ZAI_API_KEY=... to the .env file");
    const response = await fetch(`https://api.z.ai/api/paas/v4${apiPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Z.ai ${apiPath} HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  });

  // Saves a script to REAPER's Scripts/GuitarBuddy folder, runs it in the open
  // REAPER (starting REAPER if needed) and returns the report it writes.
  ipcMain.handle("tone:run-script", async (_event, name, lua, reportFile) => {
    if (!REPORTS.has(reportFile)) throw new Error(`Unknown report ${reportFile}`);
    const exe = findReaper();
    if (!exe) throw new Error("REAPER was not found in Program Files");
    await fsp.mkdir(scriptDir(), { recursive: true });
    const script = path.join(scriptDir(), `${safeName(name)}.lua`);
    await fsp.writeFile(script, lua);
    const report = path.join(scriptDir(), reportFile);
    const before = await mtime(report);
    spawn(exe, ["-nonewinst", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if ((await mtime(report)) !== before) {
        await new Promise((resolve) => setTimeout(resolve, 200)); // let the write finish
        return { script, report: await fsp.readFile(report, "utf8") };
      }
    }
    throw new Error(`REAPER did not run the script within 2 minutes. You can run it yourself: ${script}`);
  });

  ipcMain.handle("tone:save-dialog", async (event, defaultName, ext) => {
    const filters = {
      rpp: { name: "REAPER project", extensions: ["rpp"] },
      lua: { name: "REAPER script", extensions: ["lua"] },
      json: { name: "Tone recipe", extensions: ["json"] },
    };
    if (!filters[ext]) throw new Error(`Unknown file type ${ext}`);
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      defaultPath: path.join(app.getPath("documents"), `${safeName(defaultName)}.${ext}`),
      filters: [filters[ext]],
    });
    if (result.canceled || !result.filePath) return null;
    pickedPaths.add(result.filePath);
    return result.filePath;
  });

  ipcMain.handle("tone:write-file", async (_event, filePath, content) => {
    if (!pickedPaths.has(filePath)) throw new Error("Can only write to a file chosen in a save dialog");
    await fsp.writeFile(filePath, content);
  });

  ipcMain.handle("tone:recipes-list", async () => {
    await fsp.mkdir(recipeDir(), { recursive: true });
    const files = (await fsp.readdir(recipeDir())).filter((f) => f.endsWith(".json"));
    const items = await Promise.all(
      files.map(async (file) => {
        const full = path.join(recipeDir(), file);
        let song;
        let artist;
        try {
          ({ song, artist } = JSON.parse(await fsp.readFile(full, "utf8")));
        } catch {
          // Unreadable file: list it by its name.
        }
        return { id: file.slice(0, -5), savedAt: await mtime(full), song, artist };
      }),
    );
    return items.sort((a, b) => b.savedAt - a.savedAt);
  });

  ipcMain.handle("tone:recipes-load", (_event, id) =>
    fsp.readFile(path.join(recipeDir(), `${safeName(id)}.json`), "utf8"),
  );

  ipcMain.handle("tone:recipes-save", async (_event, id, json) => {
    await fsp.mkdir(recipeDir(), { recursive: true });
    await fsp.writeFile(path.join(recipeDir(), `${safeName(id)}.json`), json);
    return safeName(id);
  });

  ipcMain.handle("tone:recipes-delete", (_event, id) =>
    fsp.rm(path.join(recipeDir(), `${safeName(id)}.json`), { force: true }),
  );

  // Song lookup for the search list: iTunes Search API, free and keyless.
  ipcMain.handle("tone:find-songs", async (_event, term) => {
    const q = String(term).trim().slice(0, 100);
    if (!q) return { results: [] };
    const params = new URLSearchParams({ term: q, media: "music", entity: "song", limit: "40" });
    const response = await fetch(`https://itunes.apple.com/search?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`song lookup HTTP ${response.status}`);
    return response.json();
  });

  // Research logs: every search GLM ran, what came back and what it replied,
  // one file per run (including failed and stopped ones), for checking its work.
  ipcMain.handle("tone:research-save", async (_event, name, json) => {
    await fsp.mkdir(researchDir(), { recursive: true });
    const file = `${safeName(name)}.json`;
    await fsp.writeFile(path.join(researchDir(), file), json);
    return file;
  });

  ipcMain.handle("tone:research-latest", async (_event, savedId) => {
    let files;
    try {
      files = (await fsp.readdir(researchDir())).filter((f) => f.endsWith(".json")).sort().reverse();
    } catch {
      return null;
    }
    // Names start with a sortable timestamp, so newest comes first.
    for (const file of files) {
      try {
        const json = await fsp.readFile(path.join(researchDir(), file), "utf8");
        if (JSON.parse(json).savedId === savedId) return json;
      } catch {
        // Skip unreadable logs.
      }
    }
    return null;
  });

  ipcMain.handle("tone:research-open-folder", async () => {
    await fsp.mkdir(researchDir(), { recursive: true });
    await shell.openPath(researchDir());
  });

  // Pages the researcher reads in full. The renderer only asks for links its
  // searches returned; this side still refuses anything but public web pages.
  ipcMain.handle("tone:fetch-page", async (_event, url) => {
    const target = new URL(String(url));
    if (!/^https?:$/.test(target.protocol)) throw new Error("only web pages can be read");
    if (isPrivateHost(target.hostname)) throw new Error("only public web pages can be read");
    const response = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        "Accept-Language": "en",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (isPrivateHost(new URL(response.url).hostname)) throw new Error("only public web pages can be read");
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain/i.test(type)) throw new Error(`not a web page (${type.split(";")[0]})`);
    // Read at most 3 MB; the article is near the top of any page that size.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 3_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString("utf8");
  });

  ipcMain.handle("tone:open-external", (_event, url) => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url));
  });
}

app.whenReady().then(() => {
  const allowedPermissions = new Set(["media", "speaker-selection"]);

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => allowedPermissions.has(permission),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    },
  );

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
  });

  registerToneIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
