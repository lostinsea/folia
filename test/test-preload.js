const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame &&
    process.argv.includes("--folia-test-pdf-restore")) {
  const capability = "__foliaTestPdfRestore";
  const api = Object.freeze({
    signal(token) {
      if (typeof token !== "string") return false;
      ipcRenderer.send("pdf-restore-observed", token);
      return true;
    },
  });
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld(capability, api);
  } else {
    globalThis[capability] = api;
  }
}
