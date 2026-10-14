const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame &&
    process.argv.includes("--folia-test-pdf-restore")) {
  const phases = new Set([
    "reload-start", "reload-helper-enter", "reload-helper-exit",
    "reload-source-positive", "reload-release", "rollback-throw", "rollback-replay",
  ]);
  const diagnostics = Object.freeze({
    mark(phase, localGeneration = null) {
      if (!phases.has(phase) || (localGeneration !== null &&
          (!Number.isSafeInteger(localGeneration) || localGeneration <= 0))) return false;
      ipcRenderer.send("test-document-control-phase", { phase, localGeneration });
      return true;
    },
  });
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("__foliaTestDocumentControl", diagnostics);
  } else {
    globalThis.__foliaTestDocumentControl = diagnostics;
  }
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
