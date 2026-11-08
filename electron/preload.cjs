// Exposes the tone-search bridge to the sandboxed page. Every call goes to a
// handler in main.cjs; the page never sees the API key or raw file access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guitarBuddy", {
  tone: {
    status: () => ipcRenderer.invoke("tone:status"),
    readPluginIni: () => ipcRenderer.invoke("tone:read-plugin-ini"),
    readProbe: () => ipcRenderer.invoke("tone:read-probe"),
    zai: (apiPath, body) => ipcRenderer.invoke("tone:zai", apiPath, body),
    runScript: (name, lua, reportFile) => ipcRenderer.invoke("tone:run-script", name, lua, reportFile),
    saveDialog: (defaultName, ext) => ipcRenderer.invoke("tone:save-dialog", defaultName, ext),
    writeFile: (filePath, content) => ipcRenderer.invoke("tone:write-file", filePath, content),
    recipes: {
      list: () => ipcRenderer.invoke("tone:recipes-list"),
      load: (id) => ipcRenderer.invoke("tone:recipes-load", id),
      save: (id, json) => ipcRenderer.invoke("tone:recipes-save", id, json),
      remove: (id) => ipcRenderer.invoke("tone:recipes-delete", id),
    },
    research: {
      save: (name, json) => ipcRenderer.invoke("tone:research-save", name, json),
      latest: (savedId) => ipcRenderer.invoke("tone:research-latest", savedId),
      openFolder: () => ipcRenderer.invoke("tone:research-open-folder"),
    },
    findSongs: (term) => ipcRenderer.invoke("tone:find-songs", term),
    fetchPage: (url) => ipcRenderer.invoke("tone:fetch-page", url),
    openExternal: (url) => ipcRenderer.invoke("tone:open-external", url),
  },
});
