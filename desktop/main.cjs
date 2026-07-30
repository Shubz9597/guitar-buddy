const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

function createWindow() {
  const window = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 720,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#0b0c0e",
    title: "PickPulse",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, "..", "desktop-dist", "index.html"));
}

app.whenReady().then(() => {
  const allowedPermissions = new Set(["media"]);

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

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
