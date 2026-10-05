// Test-only capability for the transition away from renderer require().
// contextBridge cannot run while the main window still has contextIsolation: false.
const { ipcRenderer } = require("electron");

globalThis.__foliaTestPdfRestore = Object.freeze({
  signal(token) {
    if (typeof token !== "string") return false;
    ipcRenderer.send("pdf-restore-observed", token);
    return true;
  },
});
