// Preload for the image, OmniWare and mermaid popup windows.
//
// Those windows used to run with nodeIntegration, which meant that any HTML
// injection in the documents the main process builds for them was immediate
// remote code execution (SEC-05/06/07, amplified by SEC-08). They are now
// created with `nodeIntegration: false, contextIsolation: true` and under a
// nonce CSP, and this file is the entire privileged surface they get.
//
// Deliberately narrow: fixed channels, no channel name accepted from the page,
// no arbitrary IPC, no `require`. Adding a passthrough like
// `send(channel, args)` here would give back most of what was removed.
//
// Each window is additionally given only the one API it needs. The popups all
// share this preload, so without that split a script that executes in the
// mermaid popup could drive the image popup's write-to-disk path.
const { contextBridge, ipcRenderer } = require("electron");

const KIND = (process.argv.find((a) => a.startsWith("--popup-kind=")) || "")
  .split("=")[1];

const API = {
  mermaid: {
    // Ask the main process to print this window to PDF.
    exportMermaidPdf(onResult) {
      ipcRenderer.once("mermaid-pdf-result", (_event, result) =>
        onResult(result),
      );
      ipcRenderer.send("mermaid-export-pdf");
    },
  },

  omniware: {
    // Same, but this document consumes no result channel.
    exportOmniwarePdf() {
      ipcRenderer.send("omniware-export-pdf");
    },
  },

  image: {
    // Hand back a rendered data URL to be written to disk. The main process
    // re-validates that this really is a PNG/JPEG data URL before writing.
    saveImage(dataUrl, format, onResult) {
      ipcRenderer.once("image-popup-save-result", (_event, result) =>
        onResult(result),
      );
      ipcRenderer.send("image-popup-save", { dataUrl, format });
    },
  },
};

// An unrecognised or absent kind gets an empty bridge rather than everything.
contextBridge.exposeInMainWorld("popupBridge", API[KIND] || {});
