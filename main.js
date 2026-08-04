// ============================================
// IMPORTS
// ============================================
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// ============================================
// POPUP DOCUMENT ESCAPING
//
// The image, OmniWare, mermaid and table popups are built by concatenating
// markdown-derived values into a fresh HTML document that is then loaded into a
// real window. That document is parsed as a full document, so an injected
// <script> executes - these helpers are what stops markdown from reaching it
// (SEC-05/06/07). The popups additionally run without Node integration and
// under a nonce CSP, so an escape that is ever missed is contained rather than
// fatal.
// ============================================

// For text and quoted attribute values in the generated markup.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// For values embedded inside a <script> element. JSON alone is not enough: the
// HTML tokenizer ends a script block at the first `</script`, whatever the
// JavaScript string context, which is exactly how the old template-literal
// escaping was defeated. Escaping `<` as \u003c removes that sequence, and the
// U+2028/U+2029 escapes keep the result a valid JavaScript literal.
function toScriptLiteral(value) {
  return JSON.stringify(String(value == null ? "" : value))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Same problem for a whole object rather than a single string. `<` can only
// occur inside a JSON string, so escaping it as \u003c after stringifying
// keeps the result valid JSON and valid JavaScript while making `</script`
// unrepresentable.
function toJsonLiteral(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// A CSP nonce for the scripts this file generates itself. Regenerated per
// document so a value cannot be predicted and reused by injected markup.
function makeNonce() {
  return crypto.randomBytes(16).toString("base64");
}

// Content-Security-Policy for the generated popup documents.
//
// This, not the regex filtering below, is the real control. These documents are
// loaded from a temp file, so they run with a file:// origin - and a file://
// document in Electron can read other local files: `fetch('file:///C:/Windows/
// win.ini')` from one of these popups returns 200 with the file body, and an
// outbound POST to an arbitrary host succeeds. So any markup injection that
// executes script is local-file theft plus exfiltration, whether or not Node
// integration is on.
//
// `script-src 'nonce-...'` means only the scripts generated here run: injected
// <script> elements, injected inline handlers such as `<img onerror=...>` and
// `javascript:` URLs are all refused by the browser regardless of whether the
// string filtering below happened to catch them. `connect-src 'none'` stops the
// fetch/XHR read-and-exfiltrate path outright. All four verified by probe.
function popupCsp(nonce, extraImgSrc) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `img-src data: file:${extraImgSrc ? " " + extraImgSrc : ""}`,
    "font-src file: data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    // No frame-ancestors: it is ignored when the policy is delivered in a
    // <meta> element, and Chromium logs an error for it every time one of
    // these popups opens. It bought nothing anyway - these are top-level
    // Electron windows that nothing can embed, and frame-src 'none' above
    // already stops them embedding anything themselves.
    "object-src 'none'",
  ].join("; ");
}

// Local @font-face rules for OmniWare's two hand-drawn fonts.
//
// OmniWare's embedded stylesheet used to `@import` these from
// fonts.googleapis.com. The popup CSP allows no remote stylesheet, so the
// import was refused and every wireframe rendered in generic `cursive` - a
// visibly broken feature that produced only a console message nobody was
// watching. The fonts are vendored by scripts/vendor-libs.js; see the comment
// there for why vendoring rather than allowing the domain.
//
// These popups are written to a temp directory, so the URL has to be absolute.
// pathToFileURL, not string concatenation: an installation path containing a
// space or a '#' silently produces a URL that resolves to nothing.
function omniwareFontFaceCss() {
  const url = (file) =>
    require("url").pathToFileURL(path.join(__dirname, "fonts", file)).href;
  return `
@font-face {
  font-family: 'Architects Daughter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${url("architects-daughter-latin-400-normal.woff2")}') format('woff2');
}
@font-face {
  font-family: 'Patrick Hand';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${url("patrick-hand-latin-400-normal.woff2")}') format('woff2');
}`;
}

// Defence in depth for the mermaid popup, which has to interpolate real SVG
// markup and so cannot simply escape it. The primary controls for that window
// are the CSP above and the absence of Node integration; this removes the
// obvious script vectors from a diagram that mermaid's own sanitizer may have
// let through.
function stripActiveSvgContent(svg) {
  // The parser decodes character references at attribute-value time, so
  // `javascript&#58;alert(1)` and `javascript&colon;alert(1)` would both survive
  // a raw `javascript:` match and still execute. Decode the references this
  // filter cares about first.
  const decoded = String(svg == null ? "" : svg)
    .replace(/&colon;/gi, ":")
    .replace(/&#(x)?([0-9a-f]+);?/gi, (match, hex, code) => {
      const n = hex ? parseInt(code, 16) : parseInt(code, 10);
      return n === 58 || n === 9 || n === 10 || n === 13 ? String.fromCharCode(n) : match;
    });
  return decoded
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[\s\S]*?>/gi, "")
    // `<meta http-equiv="refresh">` relocates the popup. The navigation guard in
    // registerPopup() is the control that actually stops it; this keeps the
    // element out of the document in the first place.
    .replace(/<meta[\s\S]*?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, "");
}

// Only local files, `data:image/*` and http(s) sources make sense in the image
// popup. Anything else - notably `javascript:` - is dropped.
//
// Remote share forms are rejected before anything else. On Windows an <img>
// pointing at `\\host\share\x.png`, `//host/share/x.png` or `file://host/...`
// makes Chromium perform an automatic SMB fetch with no user interaction,
// handing the current user's NTLM hash to a host the markdown author chose.
// The renderer's sanitizer hook already strips these, but this helper exists
// precisely so the popup does not depend on that hook being correct.
function safeImageSrc(value) {
  const src = String(value == null ? "" : value).trim();
  if (!src) return "";
  if (/^[\\/]{2}/.test(src)) return ""; // \\host\share and //host/share
  if (/^\\\\\?\\/.test(src)) return ""; // \\?\UNC\... extended form
  if (/^file:\/\/(?!\/)/i.test(src)) return ""; // file://host/share
  if (/^file:\/{4,}/i.test(src)) return ""; // file:////host/share
  // Checked before the scheme rejection below: a bare Windows path such as
  // "C:\pics\a.png" otherwise looks like a URL with the scheme "C:" and was
  // silently dropped.
  if (/^[a-zA-Z]:[\\/]/.test(src)) return src;
  if (/^(?:https?:|file:|data:image\/)/i.test(src)) return src;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return "";
  return src; // relative path
}

// Applied to every popup window so they cannot drift apart again.
//
// `popupKind` is passed through as a process argument so the preload can expose
// only the one API that window legitimately needs: without it every popup gets
// every bridge method, and script that executes in (say) the mermaid popup can
// drive the image popup's save-to-disk path.
const POPUP_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, "popup-preload.js"),
};

// webContents.id -> popup kind, so IPC handlers can verify that a message came
// from the kind of window that is allowed to send it.
const popupKinds = new Map();

function popupWebPreferences(kind) {
  return {
    ...POPUP_WEB_PREFERENCES,
    additionalArguments: [`--popup-kind=${kind}`],
  };
}

// Registers a popup and locks it to the document the main process gave it.
//
// The CSP governs what a document may execute and connect to; it says nothing
// about that document being *replaced*. Attacker-controlled markup can carry
// `<meta http-equiv="refresh">` - directly, or tucked inside an SVG
// <foreignObject> - and relocate the whole popup to a remote page. Chromium has
// no CSP directive for this (`navigate-to` was never implemented), so it has to
// be denied in the main process. It matters more than it looks: the preload
// survives a navigation, so without this the attacker's page inherits
// `popupBridge` and, on the image popup, its write-to-disk method.
//
// `will-navigate` does not fire for the initial `loadFile`/`loadURL`, so every
// navigation reaching this handler is one we did not initiate.
function registerPopup(win, kind) {
  const id = win.webContents.id;
  popupKinds.set(id, kind);
  win.on("closed", () => popupKinds.delete(id));

  const denyNavigation = (event, url) => {
    event.preventDefault();
    console.warn(`Blocked navigation from ${kind} popup to: ${url}`);
  };
  win.webContents.on("will-navigate", denyNavigation);
  win.webContents.on("will-redirect", denyNavigation);
  win.webContents.on("will-frame-navigate", denyNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`Blocked window.open from ${kind} popup to: ${url}`);
    return { action: "deny" };
  });

  return win;
}

function isPopupOfKind(webContents, kind) {
  return !!webContents && popupKinds.get(webContents.id) === kind;
}

// ============================================
// WINDOW STATE PERSISTENCE
// Saves/restores window bounds and maximised state between launches.
// File lives in the Electron userData directory so it survives app updates.
// ============================================
const WINDOW_STATE_FILE = path.join(
  app.getPath("userData"),
  "window-state.json",
);

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

let _saveStateTimer = null;
function saveWindowState() {
  if (!mainWindow) return;
  clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(() => {
    try {
      const bounds = mainWindow.getNormalBounds();
      fs.writeFileSync(
        WINDOW_STATE_FILE,
        JSON.stringify({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: mainWindow.isMaximized(),
        }),
      );
    } catch (_) {
      // non-fatal
    }
  }, 400);
}
const { exec } = require("child_process");

// PERF-01: html-to-docx costs ~370ms to require and is only needed by the two
// DOCX export handlers, which most sessions never invoke. Loaded on first use.
let _HTMLtoDOCX = null;
function getHTMLtoDOCX() {
  if (!_HTMLtoDOCX) _HTMLtoDOCX = require("html-to-docx");
  return _HTMLtoDOCX;
}

// Helper modules
const {
  isMermaidFile,
  wrapMermaidContent,
  removeBOM,
  readMarkdownFile,
  sendIPCResult,
} = require("./file-helpers");

// ============================================
// CONDITIONAL IMPORTS
// ============================================
// PERF-01: electron-updater costs ~175ms to require. It is only reachable in
// packaged builds (see checkForUpdatesOnStartup) and via explicit user action,
// so it is loaded on first use rather than at startup. getAutoUpdater() returns
// null if the module is unavailable, preserving the previous truthiness checks.
let autoUpdater = null;
let autoUpdaterInitialized = false;

function getAutoUpdater() {
  if (autoUpdaterInitialized) return autoUpdater;
  autoUpdaterInitialized = true;
  try {
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (err) {
    console.log("electron-updater not available:", err.message);
    return null;
  }
  configureAutoUpdater(autoUpdater);
  return autoUpdater;
}

// ============================================
// LOGGING
// ============================================
const logFilePath = path.join(app.getPath("userData"), "debug.log");
const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

function log(...args) {
  // Only log in development mode to improve performance
  if (!app.isPackaged) {
    console.log(...args);
  }

  // Always write to file for troubleshooting
  const message = args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg),
    )
    .join(" ");
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  logStream.write(logMessage);
}

log("=== Application started ===");
log("User data path:", app.getPath("userData"));
log("Log file:", logFilePath);

// ============================================
// APPLICATION STATE
// ============================================
let mainWindow = null;
let fileToOpen = null;

// File watching state
let fileWatcher = null;
let watchedFilePath = null;
// Set while the renderer has asked us to stop reporting external changes
// (unsaved edits in progress). Tab switches must not silently undo it.
let watchingPaused = false;
let lastModifiedTime = null;

// ============================================
// WINDOW MANAGEMENT
// ============================================

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    // Restore saved position/size; fall back to 1200×800 centred on first run
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    width: savedState ? savedState.width : 1200,
    height: savedState ? savedState.height : 800,
    show: false, // Don't show until ready
    title: "Markdown Viewer",
    backgroundColor: "#f5f5f5",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: true, // Throttle background renderers to save CPU
    },
    icon: path.join(__dirname, "markdown_viewer_icon.png"),
  });

  // The main window runs with nodeIntegration: true, so a navigation away from
  // index.html hands `require` to whatever loads next. Nothing in the app ever
  // navigates the top frame - index.html is loaded once by loadFile below,
  // which does not fire will-navigate - so every event reaching this handler
  // is one we did not initiate.
  //
  // Reachable without this: <form action="https://…"> (DOMPurify allows form
  // and action by default), <map><area href>, <meta http-equiv="refresh">,
  // window.open, and location assignment from inside an @@@html frame. The
  // renderer's click handler covers only the link-shaped ones. (SEC-11)
  //
  // Attached before loadFile, matching registerPopup(): loadFile does not fire
  // will-navigate so the order cannot matter today, but "guard, then load" is
  // the order that stays correct if that ever changes.
  const denyMainNavigation = (event, url) => {
    event.preventDefault();
    console.warn(`Blocked main-window navigation to: ${url}`);
  };
  mainWindow.webContents.on("will-navigate", denyMainNavigation);
  mainWindow.webContents.on("will-redirect", denyMainNavigation);
  // Subframes are the @@@html sandbox iframes. They are loaded from srcdoc,
  // which does not fire this event, so anything that does is the frame trying
  // to relocate itself - to a remote page it could then beacon from, or to a
  // local file it could read. The frames have no allow-same-origin and so are
  // already origin-opaque; this closes the exfiltration half.
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return; // handled by will-navigate above
    event.preventDefault();
    console.warn(`Blocked main-window subframe navigation to: ${event.url}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`Blocked window.open from the main window to: ${url}`);
    return { action: "deny" };
  });

  mainWindow.loadFile("index.html");

  // Hide the menu bar
  mainWindow.setMenu(null);

  // Show window only when content is ready (prevents flicker)
  mainWindow.once("ready-to-show", () => {
    if (savedState && savedState.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  // Persist bounds/maximised state on every move, resize, and close
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);

  // Performance: notify renderer when window is hidden/minimized/restored
  mainWindow.on("hide", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: false,
      });
  });
  mainWindow.on("show", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: true,
      });
  });
  mainWindow.on("minimize", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: false,
      });
  });
  mainWindow.on("restore", () => {
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send("window-visibility-changed", {
        visible: true,
      });
  });

  // Load file from command line after window loads
  mainWindow.webContents.on("did-finish-load", () => {
    log("Window finished loading. fileToOpen:", fileToOpen);

    if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    }
  });

  // Open DevTools in development (F12 to toggle)
  // mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Check for file changes when window regains focus
  mainWindow.on("focus", () => {
    if (watchedFilePath) {
      checkFileChanges();
    }
  });

  // Register keyboard shortcuts
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control || input.meta) {
      if (input.key === "o" && input.type === "keyDown" && !input.shift) {
        event.preventDefault();
        openFileDialog();
      } else if (input.key === "q" && input.type === "keyDown") {
        event.preventDefault();
        app.quit();
      } else if (input.key === "O" && input.type === "keyDown" && input.shift) {
        // Ctrl+Shift+O → Corporate mode toggle (forwarded to renderer)
        event.preventDefault();
        mainWindow.webContents.send("toggle-corporate-mode");
      }
    }

    if (input.key === "F12" && input.type === "keyDown") {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    } else if (input.key === "F11" && input.type === "keyDown") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (input.key === "Escape" && input.type === "keyDown") {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
    }
  });
}

// ============================================
// FILE WATCHING
// ============================================

// Debounce helper for file change events
let fileChangeDebounce = null;

function startFileWatching(filePath) {
  // Stop any existing watcher
  stopFileWatching();

  // Explicitly arming the watcher for a file clears any earlier pause, so a
  // stale paused flag cannot leave the new file silently unwatched.
  watchingPaused = false;

  if (!fs.existsSync(filePath)) {
    console.error("Cannot watch non-existent file:", filePath);
    return;
  }

  watchedFilePath = filePath;

  // Get initial modification time
  try {
    const stats = fs.statSync(filePath);
    lastModifiedTime = stats.mtimeMs;
  } catch (err) {
    console.error("Error getting file stats:", err);
    return;
  }

  // Use OS-level fs.watch for instant detection
  try {
    fileWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === "rename") {
        // File renamed or deleted
        if (!fs.existsSync(filePath)) {
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send("file-deleted", { path: filePath });
          }
          stopFileWatching();
        }
        return;
      }
      // Debounce 'change' events (editors may fire multiple events rapidly)
      clearTimeout(fileChangeDebounce);
      fileChangeDebounce = setTimeout(() => checkFileChanges(), 150);
    });

    fileWatcher.on("error", (err) => {
      console.error("fs.watch error, falling back to polling:", err.message);
      fileWatcher = null;
      // Fallback to polling every 2 seconds (faster than before)
      fileWatcher = setInterval(() => checkFileChanges(), 2000);
    });

    console.log("Started watching file (OS-level):", filePath);
  } catch (err) {
    console.error("fs.watch not available, using polling:", err.message);
    // Fallback to polling every 2 seconds
    fileWatcher = setInterval(() => checkFileChanges(), 2000);
    console.log("Started watching file (polling):", filePath);
  }
}

function checkFileChanges() {
  if (!watchedFilePath || !fs.existsSync(watchedFilePath)) {
    if (watchedFilePath && !fs.existsSync(watchedFilePath)) {
      // File was deleted
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("file-deleted", { path: watchedFilePath });
      }
      stopFileWatching();
    }
    return;
  }

  try {
    const stats = fs.statSync(watchedFilePath);
    const currentModTime = stats.mtimeMs;

    // Check if file has been modified
    if (currentModTime > lastModifiedTime) {
      console.log("File modified externally:", watchedFilePath);
      lastModifiedTime = currentModTime;

      // Notify renderer about file change
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("file-changed-externally", {
          path: watchedFilePath,
          modifiedTime: currentModTime,
        });
      }
    }
  } catch (err) {
    console.error("Error checking file changes:", err);
  }
}

function stopFileWatching() {
  if (fileWatcher) {
    if (typeof fileWatcher.close === "function") {
      // fs.watch FSWatcher
      try {
        fileWatcher.close();
      } catch (e) {
        /* ignore */
      }
    } else {
      // setInterval fallback
      clearInterval(fileWatcher);
    }
    fileWatcher = null;
    watchedFilePath = null;
    lastModifiedTime = null;
    clearTimeout(fileChangeDebounce);
    fileChangeDebounce = null;
    console.log("Stopped file watching");
  }
}

function pauseFileWatching() {
  if (fileWatcher) {
    if (typeof fileWatcher.close === "function") {
      try {
        fileWatcher.close();
      } catch (e) {
        /* ignore */
      }
    } else {
      clearInterval(fileWatcher);
    }
    fileWatcher = null;
    console.log("Paused file watching");
  }
}

function resumeFileWatching() {
  if (watchedFilePath && !fileWatcher) {
    startFileWatching(watchedFilePath);
    console.log("Resumed file watching");
  }
}

// ============================================
// FILE OPERATIONS
// ============================================

function openFile(filePath) {
  log("Attempting to open file:", filePath);

  if (!fs.existsSync(filePath)) {
    log("ERROR: File not found:", filePath);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("show-error", `File not found: ${filePath}`);
    }
    return;
  }

  // Ensure window is ready
  if (!mainWindow || !mainWindow.webContents) {
    log("ERROR: Window not ready");
    return;
  }

  // Use helper function for reading markdown files
  readMarkdownFile(filePath, (err, data) => {
    if (err) {
      log("ERROR: Error reading file:", err);
      mainWindow.webContents.send(
        "show-error",
        `Error reading file: ${err.message}`,
      );
      return;
    }

    log("File read successfully, sending to renderer");
    mainWindow.webContents.send("file-opened", {
      content: data,
      path: filePath,
      allPaths: [filePath],
    });

    // Start watching the file for external changes
    startFileWatching(filePath);
  });
}

function openFileDialog() {
  dialog
    .showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Markdown Files",
          extensions: ["md", "markdown", "mdown", "mkd", "mkdn"],
        },
        { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
        { name: "OmniWare Files", extensions: ["ow"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    .then((result) => {
      if (!result.canceled && result.filePaths.length > 0) {
        const filePaths = result.filePaths;
        const firstFilePath = filePaths[0];

        // Use helper function for reading markdown files
        readMarkdownFile(firstFilePath, (err, data) => {
          if (err) {
            console.error("Error reading file:", err);
            return;
          }

          // Send first file content and all selected paths
          mainWindow.webContents.send("file-opened", {
            content: data,
            path: firstFilePath,
            allPaths: filePaths,
          });

          // Start watching the first file for external changes
          startFileWatching(firstFilePath);
        });
      }
    })
    .catch((err) => {
      console.error("Error opening file:", err);
    });
}

// ============================================
// IPC HANDLERS - File Operations
// ============================================

ipcMain.on("open-file-dialog", () => {
  openFileDialog();
});

// Handle image insert dialog
ipcMain.on("open-image-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Image",
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
      },
    ],
    properties: ["openFile"],
  });

  if (result.canceled || result.filePaths.length === 0) return;

  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const fileName = path.basename(filePath);

  const mimeTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  };
  const mimeType = mimeTypes[ext] || "image/png";

  try {
    const data = fs.readFileSync(filePath);
    const base64 = data.toString("base64");
    mainWindow.webContents.send("image-selected", {
      base64,
      mimeType,
      fileName,
    });
  } catch (err) {
    console.error("Image read error:", err);
    mainWindow.webContents.send("image-selected", { error: err.message });
  }
});

// Handle direct file path open request from renderer (for markdown links)
ipcMain.on("open-file-path", (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    openFile(filePath);
  } else if (filePath) {
    // File doesn't exist - notify renderer to update recent files
    mainWindow.webContents.send("file-not-found", { path: filePath });
  }
});

// Handle open folder in file explorer request
ipcMain.on("open-folder-in-explorer", (event, filePath) => {
  if (filePath) {
    // shell.showItemInFolder will open the folder and select the file
    shell.showItemInFolder(filePath);
  }
});

// ============================================
// IPC HANDLERS - Export
// ============================================

// Open a file with the system default app; handles WSL2 by converting to Windows path
function openFileAfterExport(filePath) {
  if (process.platform === "linux") {
    // In WSL2, use wslpath to get the Windows UNC path, then open with explorer.exe
    exec(`wslpath -w "${filePath}"`, (err, winPath) => {
      if (!err && winPath && winPath.trim()) {
        exec(`explorer.exe "${winPath.trim()}"`, (err2) => {
          if (err2) shell.showItemInFolder(filePath);
        });
      } else {
        // Not WSL2 or wslpath unavailable, fall back to xdg-open
        shell.openPath(filePath).then((errMsg) => {
          if (errMsg) shell.showItemInFolder(filePath);
        });
      }
    });
  } else {
    shell.openPath(filePath).then((errMsg) => {
      if (errMsg) shell.showItemInFolder(filePath);
    });
  }
}

// Build corporate letterhead header/footer templates for printToPDF
function buildCorporateTemplates(label) {
  const logoPath = path.join(__dirname, "omnicore-letterhead-logo.png");
  let logoDataUri = "";
  try {
    const logoData = fs.readFileSync(logoPath);
    logoDataUri = "data:image/png;base64," + logoData.toString("base64");
  } catch (e) {
    console.warn("Corporate logo not found:", logoPath);
  }
  const headerTemplate = `<div style="-webkit-print-color-adjust:exact;color-adjust:exact;width:100%;padding:5px 36px 0 31px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:flex-start;">
    <div style="-webkit-print-color-adjust:exact;color-adjust:exact;height:26px;width:115px;background-image:url('${logoDataUri}');background-size:contain;background-repeat:no-repeat;background-position:left center;flex-shrink:0;"></div>
    <span style="font-size:9px;color:#999999;font-family:Arial,sans-serif;padding-top:4px;">${label || ""}</span>
  </div>`;
  const footerTemplate = `<div style="-webkit-print-color-adjust:exact;color-adjust:exact;width:100%;height:100%;padding:4px 0 0 36px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:flex-end;font-family:Arial,sans-serif;overflow:visible;">
    <div style="line-height:1.5;">
      <div style="font-size:7px;font-weight:bold;font-style:italic;color:#279EA7;">OMNICORE STRATEJİK TEKNOLOJİLER LİMİTED ŞİRKETİ</div>
      <div style="font-size:6px;color:#1F3244;">KÜÇÜKBAKKALKÖY MAH. SELVİLİ SK. NO: 4 İÇ KAPI NO: 20 ATAŞEHİR</div>
      <div style="font-size:6px;color:#1F3244;">1074342 / 0642108183700001</div>
      <div style="font-size:6px;color:#279EA7;">www.omnicore.com.tr</div>
    </div>
    <div style="display:flex;align-items:flex-end;gap:22px;overflow:visible;align-self:stretch;">
      <div style="display:flex;gap:3px;height:70%;align-self:flex-end;margin-bottom:-20px;overflow:visible;">
        <div style="width:1px;background:#279EA7;"></div>
        <div style="width:1px;background:#279EA7;"></div>
        <div style="width:1px;background:#279EA7;"></div>
      </div>
      <span class="pageNumber" style="font-size:20px;font-weight:300;color:#1F3244;padding-right:28px;"></span>
    </div>
  </div>`;
  return { headerTemplate, footerTemplate };
}

// Handle corporate PDF export (with letterhead)
ipcMain.on("export-pdf-corporate", async (event, data) => {
  try {
    const { currentFileName } = data;

    let defaultFilename = "document-corporate.pdf";
    if (currentFileName) {
      const nameWithoutExt = currentFileName.replace(/\.[^/.]+$/, "");
      defaultFilename = `${nameWithoutExt}-corporate.pdf`;
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export to PDF (Corporate)",
      defaultPath: defaultFilename,
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });

    if (result.canceled || !result.filePath) return;

    // Ask renderer to switch to light mode so PDF is always captured in light theme
    mainWindow.webContents.send("prepare-for-pdf-export");
    await new Promise((resolve) => ipcMain.once("pdf-export-ready", resolve));

    // Build corporate letterhead templates (header/footer appear on every page via Chromium)
    const { headerTemplate, footerTemplate } =
      buildCorporateTemplates(currentFileName);

    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: "A4",
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margins: { top: 1.2, bottom: 1.0, left: 0.8, right: 0.8 },
    });

    fs.writeFile(result.filePath, pdfData, (err) => {
      if (err) {
        mainWindow.webContents.send("pdf-export-result", {
          success: false,
          error: err.message,
        });
      } else {
        openFileAfterExport(result.filePath);
        mainWindow.webContents.send("pdf-export-result", {
          success: true,
          path: result.filePath,
        });
      }
    });
  } catch (error) {
    mainWindow.webContents.send("pdf-export-result", {
      success: false,
      error: error.message,
    });
  }
});

ipcMain.on("export-pdf", async (event, data) => {
  try {
    const { currentFileName } = data;

    // Determine default filename
    let defaultFilename = "document.pdf";
    if (currentFileName) {
      const nameWithoutExt = currentFileName.replace(/\.[^/.]+$/, "");
      defaultFilename = `${nameWithoutExt}.pdf`;
    }

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export to PDF",
      defaultPath: defaultFilename,
      filters: [
        { name: "PDF Files", extensions: ["pdf"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    // Ask renderer to switch to light mode so PDF is always captured in light theme
    mainWindow.webContents.send("prepare-for-pdf-export");
    await new Promise((resolve) => ipcMain.once("pdf-export-ready", resolve));

    // Generate PDF from current page
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      marginsType: 1, // Minimum margins
      pageSize: "A4",
      preferCSSPageSize: false,
    });

    // Write PDF to file
    fs.writeFile(result.filePath, pdfData, (err) => {
      if (err) {
        console.error("Error saving PDF:", err);
        mainWindow.webContents.send("pdf-export-result", {
          success: false,
          error: err.message,
        });
      } else {
        console.log("PDF saved successfully:", result.filePath);
        openFileAfterExport(result.filePath);
        mainWindow.webContents.send("pdf-export-result", {
          success: true,
          path: result.filePath,
        });
      }
    });
  } catch (error) {
    console.error("Error exporting PDF:", error);
    mainWindow.webContents.send("pdf-export-result", {
      success: false,
      error: error.message,
    });
  }
});

// Handle Word export request from renderer
ipcMain.on("export-word", async (event, data) => {
  console.log("Received export-word request");
  try {
    const { currentFileName, htmlContent } = data;
    console.log(
      "Processing Word export for:",
      currentFileName,
      "HTML length:",
      htmlContent?.length,
    );

    // Determine default filename
    let defaultFilename = "document.docx";
    if (currentFileName) {
      const nameWithoutExt = currentFileName.replace(/\.[^/.]+$/, "");
      defaultFilename = `${nameWithoutExt}.docx`;
    }

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export to Word",
      defaultPath: defaultFilename,
      filters: [
        { name: "Word Documents", extensions: ["docx"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    // Create a complete HTML document with styling
    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Calibri', 'Arial', sans-serif; font-size: 11pt; line-height: 1.6; color: #333; }
          h1 { font-size: 24pt; color: #1F3244; margin-top: 24pt; margin-bottom: 12pt; }
          h2 { font-size: 18pt; color: #1F3244; margin-top: 18pt; margin-bottom: 10pt; }
          h3 { font-size: 14pt; color: #1F3244; margin-top: 14pt; margin-bottom: 8pt; }
          h4, h5, h6 { font-size: 12pt; color: #1F3244; margin-top: 12pt; margin-bottom: 6pt; }
          p { margin-bottom: 10pt; }
          code { font-family: 'Consolas', 'Courier New', monospace; background-color: #f5f5f5; padding: 2pt 4pt; font-size: 10pt; }
          pre { font-family: 'Consolas', 'Courier New', monospace; background-color: #f5f5f5; padding: 10pt; font-size: 10pt; border: 1pt solid #ddd; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 12pt; }
          th, td { border: 1pt solid #ddd; padding: 8pt; text-align: left; }
          th { background-color: #1F3244; color: white; }
          blockquote { border-left: 3pt solid #279EA7; padding-left: 12pt; margin-left: 0; color: #666; }
          a { color: #279EA7; }
          ul, ol { margin-bottom: 10pt; }
          li { margin-bottom: 4pt; }
          img { max-width: 100%; height: auto; }
        </style>
      </head>
      <body>
        ${htmlContent}
      </body>
      </html>
    `;

    // Convert HTML to DOCX
    const docxBuffer = await getHTMLtoDOCX()(fullHtml, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
      font: "Calibri",
      fontSize: 22, // In half-points (22 = 11pt)
      margins: {
        top: 1440, // 1 inch in twips
        right: 1440,
        bottom: 1440,
        left: 1440,
        header: 720, // 0.5 inch
        footer: 720, // 0.5 inch
        gutter: 0,
      },
    });

    // Write DOCX to file
    fs.writeFile(result.filePath, docxBuffer, (err) => {
      if (err) {
        console.error("Error saving Word document:", err);
        mainWindow.webContents.send("word-export-result", {
          success: false,
          error: err.message,
        });
      } else {
        console.log("Word document saved successfully:", result.filePath);
        mainWindow.webContents.send("word-export-result", {
          success: true,
          path: result.filePath,
        });
      }
    });
  } catch (error) {
    console.error("Error exporting Word document:", error);
    mainWindow.webContents.send("word-export-result", {
      success: false,
      error: error.message,
    });
  }
});

// Handle corporate Word export (with letterhead)
ipcMain.on("export-word-corporate", async (event, data) => {
  try {
    const { currentFileName, htmlContent } = data;

    let defaultFilename = "document-corporate.docx";
    if (currentFileName) {
      const nameWithoutExt = currentFileName.replace(/\.[^/.]+$/, "");
      defaultFilename = `${nameWithoutExt}-corporate.docx`;
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export to Word (Corporate)",
      defaultPath: defaultFilename,
      filters: [{ name: "Word Documents", extensions: ["docx"] }],
    });

    if (result.canceled || !result.filePath) return;

    // Corporate letterhead HTML wrapper
    const corporateHeader = `
      <div style="border-bottom: 3pt solid #279EA7; padding-bottom: 8pt; margin-bottom: 16pt;">
        <p style="font-size: 10pt; color: #279EA7; font-weight: bold; letter-spacing: 2pt; margin: 0;">OMNICORE</p>
      </div>
    `;
    const corporateFooter = `
      <div style="border-top: 2pt solid #279EA7; padding-top: 8pt; margin-top: 32pt;">
        <p style="font-size: 9pt; color: #666; text-align: center; letter-spacing: 2pt; margin: 0;">CONFIDENTIAL &mdash; OMNICORE DOCUMENT</p>
      </div>
    `;

    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Calibri', 'Arial', sans-serif; font-size: 11pt; line-height: 1.6; color: #333; }
          h1 { font-size: 24pt; color: #1F3244; margin-top: 24pt; margin-bottom: 12pt; }
          h2 { font-size: 18pt; color: #1F3244; margin-top: 18pt; margin-bottom: 10pt; }
          h3 { font-size: 14pt; color: #1F3244; margin-top: 14pt; margin-bottom: 8pt; }
          h4, h5, h6 { font-size: 12pt; color: #1F3244; margin-top: 12pt; margin-bottom: 6pt; }
          p { margin-bottom: 10pt; }
          code { font-family: 'Consolas', 'Courier New', monospace; background-color: #f5f5f5; padding: 2pt 4pt; font-size: 10pt; }
          pre { font-family: 'Consolas', 'Courier New', monospace; background-color: #f5f5f5; padding: 10pt; font-size: 10pt; border: 1pt solid #ddd; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 12pt; }
          th, td { border: 1pt solid #ddd; padding: 8pt; text-align: left; }
          th { background-color: #1F3244; color: white; }
          blockquote { border-left: 3pt solid #279EA7; padding-left: 12pt; margin-left: 0; color: #666; }
          a { color: #279EA7; }
          ul, ol { margin-bottom: 10pt; }
          li { margin-bottom: 4pt; }
          img { max-width: 100%; height: auto; }
        </style>
      </head>
      <body>
        ${corporateHeader}
        ${htmlContent}
        ${corporateFooter}
      </body>
      </html>
    `;

    const docxBuffer = await getHTMLtoDOCX()(fullHtml, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
      font: "Calibri",
      fontSize: 22,
      margins: {
        top: 1440,
        right: 1440,
        bottom: 1440,
        left: 1440,
        header: 720,
        footer: 720,
        gutter: 0,
      },
    });

    fs.writeFile(result.filePath, docxBuffer, (err) => {
      if (err) {
        mainWindow.webContents.send("word-export-result", {
          success: false,
          error: err.message,
        });
      } else {
        mainWindow.webContents.send("word-export-result", {
          success: true,
          path: result.filePath,
        });
      }
    });
  } catch (error) {
    mainWindow.webContents.send("word-export-result", {
      success: false,
      error: error.message,
    });
  }
});

// Handle markdown file save request from renderer
ipcMain.on("save-markdown-file", (event, data) => {
  try {
    const { filePath, content } = data;

    if (!filePath) {
      mainWindow.webContents.send("save-markdown-result", {
        success: false,
        error: "No file path provided",
      });
      return;
    }

    // Write file to disk
    fs.writeFile(filePath, content, "utf8", (err) => {
      if (err) {
        console.error("Error saving file:", err);
        mainWindow.webContents.send("save-markdown-result", {
          success: false,
          error: err.message,
        });
      } else {
        console.log("File saved successfully:", filePath);

        // Update lastModifiedTime to prevent false "external change" detection
        if (watchedFilePath === filePath) {
          try {
            const stats = fs.statSync(filePath);
            lastModifiedTime = stats.mtimeMs;
            console.log(
              "Updated lastModifiedTime after save:",
              lastModifiedTime,
            );
          } catch (statErr) {
            console.error("Error updating file stats after save:", statErr);
          }
        }

        mainWindow.webContents.send("save-markdown-result", {
          success: true,
          path: filePath,
        });
      }
    });
  } catch (error) {
    console.error("Error in save handler:", error);
    mainWindow.webContents.send("save-markdown-result", {
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// IPC HANDLERS - File Watching
// ============================================

ipcMain.on("start-file-watching", (event, data) => {
  const { filePath } = data;
  startFileWatching(filePath);
});

ipcMain.on("pause-file-watching", () => {
  watchingPaused = true;
  pauseFileWatching();
});

ipcMain.on("resume-file-watching", () => {
  watchingPaused = false;
  resumeFileWatching();
});

ipcMain.on("stop-file-watching", () => {
  watchingPaused = false;
  stopFileWatching();
});

// The tab overlay (custom-tabs.js) sends this on every tab switch. Without a
// handler the watcher stays pinned to whichever file was opened last, so
// external changes to any other open tab are never reported.
ipcMain.on("set-active-file", (event, filePath) => {
  if (!filePath || watchedFilePath === filePath) {
    return;
  }
  if (watchingPaused) {
    // The renderer paused watching because of unsaved edits. Remember the new
    // target so resume-file-watching arms the right file, but do not re-arm
    // here - that would undo the pause the renderer explicitly asked for.
    watchedFilePath = filePath;
    return;
  }
  startFileWatching(filePath);
});

// Handle file reload request
ipcMain.on("reload-file", (event, data) => {
  const { filePath } = data;

  if (!fs.existsSync(filePath)) {
    sendIPCResult(mainWindow.webContents, "file-reload-result", false, {
      error: "File not found",
    });
    return;
  }

  // Use helper function for reading markdown files
  readMarkdownFile(filePath, (err, content) => {
    if (err) {
      console.error("Error reloading file:", err);
      sendIPCResult(mainWindow.webContents, "file-reload-result", false, {
        error: err.message,
      });
    } else {
      // Update the last modified time after successful reload
      try {
        const stats = fs.statSync(filePath);
        lastModifiedTime = stats.mtimeMs;
      } catch (statErr) {
        console.error("Error updating file stats:", statErr);
      }

      sendIPCResult(mainWindow.webContents, "file-reload-result", true, {
        content,
        path: filePath,
      });
    }
  });
});

// ============================================
// IPC HANDLERS - Popups
// ============================================

ipcMain.on("open-mermaid-popup", (event, data) => {
  const { svgContent, isDarkMode, isCorporateMode } = data;

  // Create popup window
  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("mermaid"),
    title: "Mermaid Diagram - Zoom with mouse wheel, Pan by dragging",
    icon: path.join(__dirname, "markdown_viewer_icon.png"),
  });

  registerPopup(popupWindow, "mermaid");

  popupWindow.setMenu(null);

  // Write a temporary HTML file in system temp directory
  const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-mermaid.html");

  // Create HTML with pan/zoom using matrix transform approach
  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce)}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mermaid Diagram</title>
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: ${isDarkMode ? "#1a1a1a" : "#f0f0f0"};
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        .ui-overlay {
            position: absolute;
            top: 20px;
            left: 20px;
            background: ${isDarkMode ? "#2d2d2d" : "white"};
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            pointer-events: auto;
            z-index: 10;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
        }
        h1 {
            margin: 0 0 10px 0;
            font-size: 16px;
            color: ${isDarkMode ? "#3DBDC6" : "#333"};
        }
        p {
            margin: 0 0 10px 0;
            font-size: 12px;
            color: ${isDarkMode ? "#a0a0a0" : "#666"};
        }
        button {
            padding: 8px 12px;
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            transition: background 0.2s;
            width: 100%;
            margin-bottom: 8px;
        }
        button:last-child {
            margin-bottom: 0;
        }
        button:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
        }
        button:disabled {
            background-color: ${isDarkMode ? "#555" : "#ccc"};
            cursor: not-allowed;
        }
        #svg-container-wrapper {
            cursor: grab;
            overflow: hidden;
        }
        #svg-container-wrapper:active {
            cursor: grabbing;
        }
        #viewport {
            will-change: transform;
        }
    </style>
</head>
<body>
    <div class="ui-overlay">
        <h1>Mermaid Diagram</h1>
        <p>• Scroll to Zoom (at cursor)<br>• Click & Drag to Pan</p>
        <button id="resetBtn">Reset View</button>
        <button id="pdfBtn">Save as PDF</button>
    </div>
    <div id="svg-container-wrapper" style="width: 100%; height: 100%; position: relative;">
        <div id="viewport" style="transform-origin: 0 0;">
            ${stripActiveSvgContent(svgContent)}
        </div>
    </div>
    <script nonce="${nonce}">
        const svgWrapper = document.getElementById('svg-container-wrapper');
        const viewport = document.getElementById('viewport');
        const mermaidSvg = viewport.querySelector('svg');

        // Don't extract children - keep the Mermaid SVG intact so styles work
        if (mermaidSvg) {
            mermaidSvg.style.display = 'block';
            mermaidSvg.style.maxWidth = '100%';
            mermaidSvg.style.height = 'auto';
        }
        const svg = svgWrapper; // Treat wrapper as pan/zoom container
        let state = {
            scale: 1,
            panning: false,
            pointX: 0,
            pointY: 0,
            startX: 0,
            startY: 0
        };
        const config = {
            minScale: 0.01,
            maxScale: 10,
            zoomSpeed: 0.1
        };

        // Initial fit to screen
        if (mermaidSvg) {
            const svgRect = mermaidSvg.getBoundingClientRect();
            const wrapperRect = svgWrapper.getBoundingClientRect();
            const scaleX = (wrapperRect.width * 0.9) / svgRect.width;
            const scaleY = (wrapperRect.height * 0.9) / svgRect.height;
            const initialScale = Math.min(scaleX, scaleY, 1);
            state.scale = initialScale;
            state.pointX = (wrapperRect.width - svgRect.width * initialScale) / 2;
            state.pointY = (wrapperRect.height - svgRect.height * initialScale) / 2;
            updateTransform();
        }

        // Mouse wheel zoom
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const delta = -Math.sign(e.deltaY);
            const zoomFactor = 1 + (config.zoomSpeed * delta);
            let newScale = state.scale * zoomFactor;

            if (newScale < config.minScale) newScale = config.minScale;
            if (newScale > config.maxScale) newScale = config.maxScale;

            const ratio = newScale / state.scale;
            state.pointX = mouseX - (mouseX - state.pointX) * ratio;
            state.pointY = mouseY - (mouseY - state.pointY) * ratio;
            state.scale = newScale;

            updateTransform();
        }, { passive: false });

        // Pan with left mouse button
        function startPan(e) {
            if (e.button !== 0) return;
            e.preventDefault();
            state.panning = true;
            state.startX = e.clientX - state.pointX;
            state.startY = e.clientY - state.pointY;
            svg.style.cursor = 'grabbing';
        }

        function pan(e) {
            if (!state.panning) return;
            e.preventDefault();
            state.pointX = e.clientX - state.startX;
            state.pointY = e.clientY - state.startY;
            updateTransform();
        }

        function endPan(e) {
            state.panning = false;
            svg.style.cursor = 'grab';
        }

        svg.addEventListener('mousedown', startPan);
        window.addEventListener('mousemove', pan);
        window.addEventListener('mouseup', endPan);
        svg.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                state.panning = true;
                state.startX = e.touches[0].clientX - state.pointX;
                state.startY = e.touches[0].clientY - state.pointY;
            }
        }, {passive: false});
        window.addEventListener('touchmove', (e) => {
            if (!state.panning || e.touches.length !== 1) return;
            e.preventDefault();
            state.pointX = e.touches[0].clientX - state.startX;
            state.pointY = e.touches[0].clientY - state.startY;
            updateTransform();
        }, {passive: false});
        window.addEventListener('touchend', endPan);

        function updateTransform() {
            viewport.style.transform = \`translate(\${state.pointX}px, \${state.pointY}px) scale(\${state.scale})\`;
        }
        window.resetView = function() {
            state = {
                scale: 1,
                panning: false,
                pointX: 0,
                pointY: 0,
                startX: 0,
                startY: 0
            };
            updateTransform();
        }

        window.savePDF = async function() {
            const pdfBtn = document.getElementById('pdfBtn');
            const originalText = pdfBtn.textContent;
            pdfBtn.textContent = 'Saving...';
            pdfBtn.disabled = true;

            // Hide UI overlay for PDF
            const overlay = document.querySelector('.ui-overlay');
            overlay.style.display = 'none';

            // Hide the normal view
            svgWrapper.style.display = 'none';

            // Create a clean PDF container with the SVG at proper size
            const pdfContainer = document.createElement('div');
            pdfContainer.id = 'pdf-export-container';
            pdfContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${isDarkMode ? "#1a1a1a" : "#f0f0f0"};';

            // Clone the SVG
            const svgClone = mermaidSvg.cloneNode(true);

            // Get viewport dimensions
            const pageWidth = window.innerWidth;
            const pageHeight = window.innerHeight;

            // Get SVG natural dimensions
            const viewBox = mermaidSvg.viewBox?.baseVal;
            const naturalWidth = viewBox?.width || parseFloat(mermaidSvg.getAttribute('width')) || 800;
            const naturalHeight = viewBox?.height || parseFloat(mermaidSvg.getAttribute('height')) || 600;

            // Calculate size to fit 85% of page while maintaining aspect ratio
            const maxWidth = pageWidth * 0.85;
            const maxHeight = pageHeight * 0.85;
            const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);

            const finalWidth = naturalWidth * scale;
            const finalHeight = naturalHeight * scale;

            // Set SVG to calculated size (not using CSS transform)
            svgClone.setAttribute('width', finalWidth);
            svgClone.setAttribute('height', finalHeight);
            svgClone.style.maxWidth = 'none';
            svgClone.style.width = finalWidth + 'px';
            svgClone.style.height = finalHeight + 'px';

            pdfContainer.appendChild(svgClone);
            document.body.appendChild(pdfContainer);

            // Small delay to ensure rendering
            await new Promise(resolve => setTimeout(resolve, 200));

            // Request PDF export from main process
            popupBridge.exportMermaidPdf((result) => {
                // Remove PDF container and restore normal view
                pdfContainer.remove();
                svgWrapper.style.display = '';
                overlay.style.display = 'block';

                if (result.success) {
                    pdfBtn.textContent = 'Saved!';
                } else if (result.canceled) {
                    pdfBtn.textContent = originalText;
                    pdfBtn.disabled = false;
                    return;
                } else {
                    pdfBtn.textContent = 'Error!';
                }
                setTimeout(() => {
                    pdfBtn.textContent = originalText;
                    pdfBtn.disabled = false;
                }, 1500);
            });
        }

        // Wired here rather than with inline onclick attributes: the document's
        // CSP allows only nonce-carrying scripts, and an inline handler counts
        // as script the browser cannot verify, so it would never fire.
        document.getElementById('resetBtn').addEventListener('click', () => window.resetView());
        document.getElementById('pdfBtn').addEventListener('click', () => window.savePDF());
    </script>
</body>
</html>`;

  // Write temp HTML file
  fs.writeFileSync(tempHtmlPath, htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tempHtmlPath);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    try {
      if (fs.existsSync(tempHtmlPath)) {
        fs.unlinkSync(tempHtmlPath);
      }
    } catch (err) {
      console.error("Error cleaning up temp file:", err);
    }
  });

  // Handle PDF export request from this popup window
  const mermaidPdfHandler = async (ev) => {
    if (BrowserWindow.fromWebContents(ev.sender) !== popupWindow) return;
    try {
      const printOptions = isCorporateMode
        ? {
            printBackground: true,
            landscape: true,
            pageSize: "A4",
            displayHeaderFooter: true,
            ...buildCorporateTemplates("mermaid-diagram.pdf"),
            margins: { top: 1.2, bottom: 1.0, left: 0.8, right: 0.8 },
          }
        : {
            printBackground: true,
            landscape: true,
            pageSize: "A4",
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          };

      const pdfData = await popupWindow.webContents.printToPDF(printOptions);

      const result = await dialog.showSaveDialog(popupWindow, {
        title: "Save Mermaid Diagram as PDF",
        defaultPath: path.join(os.homedir(), "mermaid-diagram.pdf"),
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });

      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, pdfData);
        openFileAfterExport(result.filePath);
        popupWindow.webContents.send("mermaid-pdf-result", { success: true });
      } else {
        popupWindow.webContents.send("mermaid-pdf-result", { canceled: true });
      }
    } catch (err) {
      console.error("Mermaid PDF export error:", err);
      popupWindow.webContents.send("mermaid-pdf-result", {
        success: false,
        error: err.message,
      });
    }
  };
  ipcMain.on("mermaid-export-pdf", mermaidPdfHandler);

  popupWindow.on("closed", () => {
    ipcMain.removeListener("mermaid-export-pdf", mermaidPdfHandler);
  });
});

// Handle OmniWare wireframe popup request
ipcMain.on("open-omniware-popup", (event, data) => {
  const { dslCode, isDarkMode, isCorporateMode } = data;

  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#f8f6f1",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("omniware"),
    title: "OmniWare Wireframe",
    icon: path.join(__dirname, "markdown_viewer_icon.png"),
  });

  registerPopup(popupWindow, "omniware");

  popupWindow.setMenu(null);

  // Read the OmniWare library
  const omniwareJsPath = path.join(__dirname, "omniwire", "omniware.js");
  const omniwareJs = fs.readFileSync(omniwareJsPath, "utf8");

  // Dark mode CSS overrides
  const { getOmniWareDarkCSS } = require("./omniware-config");
  const darkCSS = isDarkMode
    ? `<style>${getOmniWareDarkCSS(true)}</style>`
    : "";

  // JSON-encoded, with `<` escaped, so the value cannot terminate the script
  // element it lives in. The previous escaping protected the JavaScript
  // template literal but not the surrounding <script> (SEC-06).
  const dslLiteral = toScriptLiteral(dslCode);

  const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-omniware.html");
  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce)}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OmniWare Wireframe</title>
    <style>${omniwareFontFaceCss()}</style>
    <style>
        body, html {
            margin: 0;
            padding: 20px;
            background-color: ${isDarkMode ? "#2d2d2d" : "#f0ede6"};
            min-height: 100vh;
        }
        .toolbar {
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 1000;
            display: flex;
            gap: 8px;
        }
        .toolbar button {
            padding: 6px 14px;
            border: 1px solid ${isDarkMode ? "#555" : "#ccc"};
            background: ${isDarkMode ? "#333" : "#fff"};
            color: ${isDarkMode ? "#e0e0e0" : "#333"};
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .toolbar button:hover {
            background: ${isDarkMode ? "#444" : "#eee"};
        }
    </style>
    ${darkCSS}
</head>
<body>
    <div class="toolbar">
        <button id="exportPdfBtn">Export PDF</button>
    </div>
    <div id="render-target"></div>

    <script nonce="${nonce}">${omniwareJs}</script>
    <script nonce="${nonce}">
        const dsl = ${dslLiteral};
        OmniWare.render(dsl, document.getElementById('render-target'));

        // Listener rather than an inline onclick: the CSP on this document
        // permits only nonce-carrying script.
        document.getElementById('exportPdfBtn').addEventListener('click', () => {
            popupBridge.exportOmniwarePdf();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') window.close();
        });
    </script>
</body>
</html>`;

  fs.writeFileSync(tempHtmlPath, htmlContent, "utf8");
  popupWindow.loadFile(tempHtmlPath);

  // Handle PDF export from popup
  const omniwarePdfHandler = async (event) => {
    // Only handle events coming from this specific popup window
    if (BrowserWindow.fromWebContents(event.sender) !== popupWindow) return;
    try {
      const saveResult = await dialog.showSaveDialog(popupWindow, {
        title: "Export Wireframe as PDF",
        defaultPath: "wireframe.pdf",
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (!saveResult.canceled && saveResult.filePath) {
        const printOptions = isCorporateMode
          ? {
              landscape: false,
              printBackground: true,
              pageSize: "A4",
              displayHeaderFooter: true,
              ...buildCorporateTemplates("wireframe.pdf"),
              margins: { top: 1.2, bottom: 1.0, left: 0.8, right: 0.8 },
            }
          : {
              landscape: false,
              printBackground: true,
              margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
            };
        const pdfData = await popupWindow.webContents.printToPDF(printOptions);
        fs.writeFileSync(saveResult.filePath, pdfData);
        openFileAfterExport(saveResult.filePath);
      }
    } catch (err) {
      console.error("OmniWare PDF export error:", err);
    }
  };
  ipcMain.on("omniware-export-pdf", omniwarePdfHandler);

  // Clean up temp file and listener on close
  popupWindow.on("closed", () => {
    ipcMain.removeListener("omniware-export-pdf", omniwarePdfHandler);
    try {
      fs.unlinkSync(tempHtmlPath);
    } catch (e) {
      /* ignore */
    }
  });
});

// Handle Image popup request
ipcMain.on("open-image-popup", (event, data) => {
  const { src, alt, isDarkMode } = data;

  const title = alt ? `Image — ${alt}` : "Image Viewer";
  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#f0f0f0",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("image"),
    title,
    icon: path.join(__dirname, "markdown_viewer_icon.png"),
  });

  registerPopup(popupWindow, "image");

  popupWindow.setMenu(null);

  const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-image.html");
  const bg = isDarkMode ? "#1a1a1a" : "#f0f0f0";
  const uiBg = isDarkMode ? "#2d2d2d" : "#ffffff";
  const uiBorder = isDarkMode ? "#404040" : "transparent";
  const textColor = isDarkMode ? "#e0e0e0" : "#333";
  const accentColor = isDarkMode ? "#3DBDC6" : "#279EA7";
  const accentHover = isDarkMode ? "#4FCDD6" : "#1f8089";
  const subTextColor = isDarkMode ? "#a0a0a0" : "#666";

  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce, "https: http: blob:")}">
  <title>${escapeHtml(alt || "Image Viewer")}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: ${bg};
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    #canvas {
      width: 100%; height: 100%;
      cursor: grab;
      overflow: hidden;
      position: relative;
      display: flex; align-items: center; justify-content: center;
    }
    #canvas:active { cursor: grabbing; }
    #viewport {
      will-change: transform;
      transform-origin: 0 0;
    }
    #viewport img {
      display: block;
      max-width: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    .ui-overlay {
      position: absolute;
      top: 20px; left: 20px;
      background: ${uiBg};
      border: 1px solid ${uiBorder};
      padding: 14px 16px;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,${isDarkMode ? "0.4" : "0.12"});
      z-index: 10;
      min-width: 160px;
    }
    .ui-overlay h1 {
      font-size: 14px;
      font-weight: 600;
      color: ${accentColor};
      margin-bottom: 6px;
    }
    .ui-overlay p {
      font-size: 11px;
      color: ${subTextColor};
      margin-bottom: 10px;
      line-height: 1.5;
    }
    .ui-overlay button {
      display: block;
      width: 100%;
      padding: 7px 10px;
      margin-bottom: 6px;
      background: ${accentColor};
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.18s;
    }
    .ui-overlay button:last-child { margin-bottom: 0; }
    .ui-overlay button:hover { background: ${accentHover}; }
    .ui-overlay button:disabled { opacity: 0.55; cursor: not-allowed; background: ${accentColor}; }
    #zoom-label {
      display: block;
      text-align: center;
      font-size: 12px;
      color: ${textColor};
      margin-bottom: 8px;
      font-weight: 500;
    }
    .btn-secondary {
      background: ${isDarkMode ? "#3a3a3a" : "#e8e8e8"} !important;
      color: ${isDarkMode ? "#e0e0e0" : "#444"} !important;
    }
    .btn-secondary:hover { background: ${isDarkMode ? "#4a4a4a" : "#d4d4d4"} !important; }
    .divider {
      border: none;
      border-top: 1px solid ${isDarkMode ? "#404040" : "#e0e0e0"};
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div class="ui-overlay">
    <h1>Image Viewer</h1>
    <p>• Scroll to zoom (at cursor)<br>• Drag to pan</p>
    <span id="zoom-label">100%</span>
    <button id="resetBtn">Reset View</button>
    <hr class="divider">
    <button id="btn-png" class="btn-secondary">⬇ Save as PNG</button>
    <button id="btn-jpg" class="btn-secondary">⬇ Save as JPG</button>
  </div>
  <div id="canvas">
    <div id="viewport">
      <img id="the-img" src="${escapeHtml(safeImageSrc(src))}" alt="${escapeHtml(alt || "")}">
    </div>
  </div>
  <script nonce="${nonce}">
    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('viewport');
    const theImg = document.getElementById('the-img');
    const zoomLabel = document.getElementById('zoom-label');

    let state = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };
    const MIN_SCALE = 0.05, MAX_SCALE = 20, ZOOM_SPEED = 0.12;

    function updateTransform() {
      viewport.style.transform = \`translate(\${state.pointX}px, \${state.pointY}px) scale(\${state.scale})\`;
      zoomLabel.textContent = Math.round(state.scale * 100) + '%';
    }

    // Fit image to window on load
    theImg.onload = function() {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const iw = theImg.naturalWidth, ih = theImg.naturalHeight;
      const scale = Math.min(cw * 0.9 / iw, ch * 0.9 / ih, 1);
      state.scale = scale;
      state.pointX = (cw - iw * scale) / 2;
      state.pointY = (ch - ih * scale) / 2;
      updateTransform();
    };

    // Wheel zoom toward cursor
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const delta = -Math.sign(e.deltaY);
      const factor = 1 + ZOOM_SPEED * delta;
      let newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
      const ratio = newScale / state.scale;
      state.pointX = mouseX - (mouseX - state.pointX) * ratio;
      state.pointY = mouseY - (mouseY - state.pointY) * ratio;
      state.scale = newScale;
      updateTransform();
    }, { passive: false });

    // Pan
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.panning = true;
      state.startX = e.clientX - state.pointX;
      state.startY = e.clientY - state.pointY;
    });
    window.addEventListener('mousemove', e => {
      if (!state.panning) return;
      e.preventDefault();
      state.pointX = e.clientX - state.startX;
      state.pointY = e.clientY - state.startY;
      updateTransform();
    });
    window.addEventListener('mouseup', () => { state.panning = false; });

    window.resetView = function() {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const iw = theImg.naturalWidth, ih = theImg.naturalHeight;
      const scale = Math.min(cw * 0.9 / iw, ch * 0.9 / ih, 1);
      state = { scale, panning: false, pointX: (cw - iw * scale) / 2, pointY: (ch - ih * scale) / 2, startX: 0, startY: 0 };
      updateTransform();
    };

    window.saveImage = function(format) {
      const btnId = format === 'jpeg' ? 'btn-jpg' : 'btn-png';
      const btn = document.getElementById(btnId);
      const origText = btn.textContent;
      btn.textContent = 'Saving…';
      btn.disabled = true;

      const offscreen = document.createElement('canvas');
      offscreen.width = theImg.naturalWidth;
      offscreen.height = theImg.naturalHeight;
      const ctx = offscreen.getContext('2d');
      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, offscreen.width, offscreen.height);
      }
      ctx.drawImage(theImg, 0, 0);
      const dataUrl = offscreen.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.95);

      popupBridge.saveImage(dataUrl, format, (result) => {
        if (result.success) {
          btn.textContent = 'Saved!';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        } else if (result.canceled) {
          btn.textContent = origText;
          btn.disabled = false;
        } else {
          btn.textContent = 'Error!';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        }
      });
    };

    // Listeners rather than inline onclick attributes, which the document's
    // nonce CSP would refuse to run.
    document.getElementById('resetBtn').addEventListener('click', () => window.resetView());
    document.getElementById('btn-png').addEventListener('click', () => window.saveImage('png'));
    document.getElementById('btn-jpg').addEventListener('click', () => window.saveImage('jpeg'));
  </script>
</body>
</html>`;

  fs.writeFileSync(tempHtmlPath, htmlContent, "utf8");
  popupWindow.loadFile(tempHtmlPath);
  popupWindow.on("closed", () => {
    try {
      fs.unlinkSync(tempHtmlPath);
    } catch (e) {
      /* ignore */
    }
  });
});

// Handle image save request from image popup
// Largest data URL the image popup may hand back. A rendered image of a
// realistic screenshot is well under this; the cap stops a hostile page from
// making the main process buffer an unbounded string before writing it.
const MAX_IMAGE_DATA_URL_BYTES = 64 * 1024 * 1024;

ipcMain.on("image-popup-save", async (event, { dataUrl, format }) => {
  // Only the image popup may drive this. Without the check any popup that runs
  // script can open a save dialog and write bytes of its choosing.
  if (!isPopupOfKind(event.sender, "image")) return;

  // The payload must be an image data URL produced by canvas.toDataURL, not an
  // arbitrary string: the bytes are decoded and written to disk verbatim.
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
    event.reply("image-popup-save-result", {
      success: false,
      error: "Unsupported image data",
    });
    return;
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) {
    event.reply("image-popup-save-result", {
      success: false,
      error: "Unsupported image data",
    });
    return;
  }

  const format2 = format === "jpeg" ? "jpeg" : "png";
  const ext = format2 === "jpeg" ? "jpg" : "png";
  const filterName = format2 === "jpeg" ? "JPEG Image" : "PNG Image";
  const win = BrowserWindow.fromWebContents(event.sender);

  try {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `image.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    });

    if (result.canceled) {
      event.reply("image-popup-save-result", { canceled: true });
      return;
    }

    const buffer = Buffer.from(match[2], "base64");
    // Async: the payload may be up to MAX_IMAGE_DATA_URL_BYTES, and a
    // synchronous write of that size stalls every window in the app.
    await fs.promises.writeFile(result.filePath, buffer);
    event.reply("image-popup-save-result", { success: true });
  } catch (err) {
    event.reply("image-popup-save-result", {
      success: false,
      error: err.message,
    });
  }
});

// Handle Table popup request
ipcMain.on("open-table-popup", (event, data) => {
  const { tableData, isDarkMode } = data;

  // Create popup window
  const popupWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Interactive Table - Sort, Filter, Export",
    icon: path.join(__dirname, "markdown_viewer_icon.png"),
  });

  registerPopup(popupWindow, "table");

  popupWindow.setMenu(null);

  // Write a temporary HTML file in system temp directory
  const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-table.html");

  // Read Tabulator files from local directory
  const tabulatorJsPath = path.join(
    __dirname,
    "libs",
    "tabulator",
    "tabulator.min.js",
  );
  const tabulatorCssPath = path.join(
    __dirname,
    "libs",
    "tabulator",
    "tabulator.min.css",
  );

  const tabulatorJs = fs.readFileSync(tabulatorJsPath, "utf8");
  const tabulatorCss = fs.readFileSync(tabulatorCssPath, "utf8");

  // Create HTML with embedded Tabulator
  const nonce = makeNonce();
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${popupCsp(nonce, "blob:")}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interactive Table</title>
    <style>
        ${tabulatorCss}

        /* Custom theme to match app colors */
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: ${isDarkMode ? "#1a1a1a" : "#f5f5f5"};
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }

        .header {
            background: ${isDarkMode ? "#2d2d2d" : "white"};
            padding: 20px;
            border-radius: 8px 8px 0 0;
            box-shadow: 0 2px 4px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
            border-bottom: none;
        }

        h1 {
            margin: 0;
            font-size: 20px;
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
        }

        .controls {
            display: flex;
            gap: 10px;
        }

        button {
            padding: 10px 16px;
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        button:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(${isDarkMode ? "61, 189, 198" : "39, 158, 167"}, 0.3);
        }

        button:active {
            transform: translateY(0);
        }

        .table-wrapper {
            flex: 1;
            background: ${isDarkMode ? "#242424" : "white"};
            border-radius: 0 0 8px 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,${isDarkMode ? "0.3" : "0.1"});
            overflow: hidden;
            display: flex;
            flex-direction: column;
            border: 1px solid ${isDarkMode ? "#404040" : "transparent"};
            border-top: none;
        }

        #data-table {
            flex: 1;
        }

        .info {
            padding: 12px 20px;
            background: ${isDarkMode ? "#2d2d2d" : "#e8e8e8"};
            color: ${isDarkMode ? "#a0a0a0" : "#5a6b7d"};
            font-size: 13px;
            border-bottom: 1px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
        }

        /* Tabulator theme customization */
        .tabulator {
            font-size: 13px;
            border: none;
            background-color: ${isDarkMode ? "#242424" : "white"};
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
        }

        .tabulator .tabulator-header {
            background-color: #1F3244;
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            border: none;
        }

        .tabulator .tabulator-header .tabulator-col {
            background-color: #1F3244;
            border-right: 1px solid #3a4a5c;
        }

        .tabulator .tabulator-header .tabulator-col .tabulator-col-content {
            padding: 12px;
        }

        .tabulator .tabulator-header .tabulator-col .tabulator-col-title {
            color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            font-weight: 600;
        }

        .tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover {
            background-color: #2a3a4c;
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row {
            background-color: ${isDarkMode ? "#242424" : "white"};
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
            border-bottom: 1px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row:hover {
            background-color: ${isDarkMode ? "#2d2d2d" : "#f5f5f5"};
        }

        .tabulator .tabulator-tableholder .tabulator-table .tabulator-row .tabulator-cell {
            padding: 10px 12px;
            border-right: 1px solid ${isDarkMode ? "#404040" : "#e8e8e8"};
        }

        .tabulator .tabulator-footer {
            background-color: ${isDarkMode ? "#2d2d2d" : "#f5f5f5"};
            border-top: 2px solid ${isDarkMode ? "#404040" : "#d0d0d0"};
            padding: 8px;
            color: ${isDarkMode ? "#e8e8e8" : "#1F3244"};
        }

        .tabulator .tabulator-footer .tabulator-page {
            background-color: ${isDarkMode ? "#3DBDC6" : "#279EA7"};
            color: white;
            border: none;
        }

        .tabulator .tabulator-footer .tabulator-page:hover {
            background-color: ${isDarkMode ? "#4FCDD6" : "#1f8089"};
        }

        .tabulator .tabulator-footer .tabulator-page.active {
            background-color: #1F3244;
        }

        /* Header filter styling */
        .tabulator .tabulator-header-filter input {
            border: 1px solid #d0d0d0;
            padding: 4px 8px;
            border-radius: 4px;
            background: white;
            color: #1F3244;
        }

        .tabulator .tabulator-header-filter input:focus {
            border-color: #279EA7;
            outline: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Interactive Table Viewer</h1>
            <div class="controls">
                <button id="clearFiltersBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                    Clear Filters
                </button>
                <button id="exportCsvBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Export CSV
                </button>
                <button id="exportJsonBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Export JSON
                </button>
            </div>
        </div>
        <div class="table-wrapper">
            <div class="info">
                <strong>Tips:</strong> Click column headers to sort • Type in filter boxes to search • Use pagination at bottom • Export filtered data
            </div>
            <div id="data-table"></div>
        </div>
    </div>

    <script nonce="${nonce}">
        ${tabulatorJs}

        // Initialize Tabulator. toJsonLiteral, not JSON.stringify: table cells
        // come from the markdown document, and JSON.stringify leaves the
        // less-than character untouched, so a cell containing a closing script
        // tag ended this element and everything after it was parsed as markup
        // (the SEC-06 class of bug, in a window that can read local files
        // because it runs from file://).
        const tableData = ${toJsonLiteral(tableData)};

        const table = new Tabulator("#data-table", {
            data: tableData.data,
            columns: tableData.columns,
            layout: "fitColumns",
            pagination: true,
            paginationSize: 50,
            paginationSizeSelector: [25, 50, 100, 200, true],
            paginationCounter: "rows",
            movableColumns: true,
            resizableColumns: true,
            responsiveLayout: "collapse",
            headerFilterLiveFilterDelay: 300,
            initialSort: [],
            height: "100%"
        });

        // Export functions
        function exportCSV() {
            table.download("csv", "table-export.csv", {bom: true});
        }

        function exportJSON() {
            table.download("json", "table-export.json");
        }

        function clearFilters() {
            table.clearHeaderFilter();
        }

        // Listeners rather than inline onclick attributes, which this
        // document's nonce CSP would refuse to run.
        document.getElementById('clearFiltersBtn').addEventListener('click', clearFilters);
        document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
        document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);

        // Keyboard shortcut
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                window.close();
            }
        });
    </script>
</body>
</html>`;

  // Write temp HTML file
  fs.writeFileSync(tempHtmlPath, htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tempHtmlPath);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    try {
      if (fs.existsSync(tempHtmlPath)) {
        fs.unlinkSync(tempHtmlPath);
      }
    } catch (err) {
      console.error("Error cleaning up temp file:", err);
    }
  });
});

// ============================================
// COMMAND LINE HANDLING
// ============================================

function handleFileArgument(argv) {
  log("handleFileArgument called with argv:", argv);
  log("app.isPackaged:", app.isPackaged);

  // Find the file path in argv - it should be a .md file
  // Skip the executable path and any electron/chromium flags
  let filePath = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    // Skip flags (starting with --)
    if (arg.startsWith("--")) {
      continue;
    }
    // Skip '.' (dev mode current directory)
    if (arg === ".") {
      continue;
    }
    // Check if it's a file path
    if (fs.existsSync(arg)) {
      const ext = path.extname(arg).toLowerCase();
      if (
        [
          ".md",
          ".markdown",
          ".mdown",
          ".mkd",
          ".mkdn",
          ".mmd",
          ".mermaid",
          ".ow",
        ].includes(ext)
      ) {
        filePath = arg;
        break;
      }
    }
  }

  log("Extracted file path:", filePath);

  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    log("File extension:", ext);
    fileToOpen = filePath;
    log("Valid markdown file, setting fileToOpen:", fileToOpen);
    return true;
  } else {
    log("No valid markdown file found in arguments");
  }
  return false;
}

// Check for file argument on first launch
log("Initial process.argv:", process.argv);
handleFileArgument(process.argv);

// macOS: handle file open via Finder / double-click / "Open With"
// Must be registered before app is ready so early open-file events are caught.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  log("open-file event received:", filePath);
  if (!filePath) return;

  if (mainWindow && mainWindow.webContents) {
    // App already running — send directly to renderer (respects unsaved-changes check)
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow.webContents.send("external-file-open-request", { filePath });
      });
    } else {
      mainWindow.webContents.send("external-file-open-request", { filePath });
    }
  } else {
    // App not ready yet — store for did-finish-load
    fileToOpen = filePath;
  }
});

ipcMain.on("request-open-file", (event, data) => {
  const { filePath } = data;
  if (filePath && fs.existsSync(filePath)) {
    openFile(filePath);
  }
});

// ============================================
// SINGLE INSTANCE LOCK & APP LIFECYCLE
// ============================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // User opened a file while app is running
    log("Second instance detected, commandLine:", commandLine);

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Handle the file from second instance - send to renderer for unsaved changes check
      if (handleFileArgument(commandLine)) {
        log("File to open from second instance:", fileToOpen);

        // Ensure webContents is ready before sending IPC
        if (mainWindow.webContents.isLoading()) {
          log("WebContents is loading, waiting for did-finish-load");
          mainWindow.webContents.once("did-finish-load", () => {
            log("Sending external-file-open-request after load");
            mainWindow.webContents.send("external-file-open-request", {
              filePath: fileToOpen,
            });
            fileToOpen = null;
          });
        } else {
          log("Sending external-file-open-request immediately");
          mainWindow.webContents.send("external-file-open-request", {
            filePath: fileToOpen,
          });
          fileToOpen = null;
        }
      } else {
        log("No valid file found in command line arguments");
      }
    }
  });

  app.whenReady().then(() => {
    // Set dock icon on macOS (applies in dev mode where the .icns bundle isn't used)
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setIcon(path.join(__dirname, "markdown_viewer_icon.png"));
      } catch (e) {
        // Non-fatal: window still opens even if icon file is missing
      }
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ============================================
// Auto-Updater Configuration
// ============================================

// Only configure auto-updater if it's available
// Portable .exe detection: electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
let downloadedUpdatePath = null; // path to downloaded installer, set in update-downloaded event

// Called once by getAutoUpdater() on first use. These handlers used to be
// attached at module load; deferring them is safe because nothing can emit
// before the module they belong to has been required.
function configureAutoUpdater(autoUpdater) {
  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't download automatically, let user decide
  autoUpdater.autoInstallOnAppQuit = !isPortable; // Pointless for portable builds

  // Auto-updater event handlers
  autoUpdater.on("checking-for-update", () => {
    log("Auto-updater: Checking for updates...");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", { status: "checking" });
    }
  });

  autoUpdater.on("update-available", (info) => {
    log(
      "Auto-updater: Update available:",
      info.version,
      isPortable ? "(portable)" : "(installer)",
    );
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "available",
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    log(
      "Auto-updater: No updates available. Current version:",
      app.getVersion(),
    );
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "not-available",
        currentVersion: app.getVersion(),
      });
    }
  });

  autoUpdater.on("download-progress", (progressObj) => {
    log(`Auto-updater: Download progress: ${progressObj.percent.toFixed(1)}%`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "downloading",
        percent: progressObj.percent,
        bytesPerSecond: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(
      "Auto-updater: Update downloaded:",
      info.version,
      info.downloadedFile || "",
    );
    downloadedUpdatePath = info.downloadedFile || null;
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "downloaded",
        version: info.version,
      });
    }
  });

  autoUpdater.on("error", (err) => {
    // Silently log errors - don't show to user
    // Common errors: no release on GitHub, network issues, etc.
    log("Auto-updater error (silent):", err.message);
  });
}

// Return current app version to renderer
ipcMain.handle("get-version", () => app.getVersion());

// SEC-09 — translation runs here, not in the renderer.
//
// This was the renderer's ONLY outbound request, and the sole reason its CSP
// had to name a remote host in connect-src. Performing it in the main process
// lets the renderer's policy be `connect-src 'none'`: no fetch, XHR, WebSocket,
// EventSource or sendBeacon destination at all, so injected script has no
// egress channel of that shape left to reach for.
//
// Honesty about what this does and does not buy, so nobody over-reads it: the
// main window still runs with nodeIntegration (SEC-08), and script running
// there can `require('https')` and ignore CSP entirely. So this is
// defence-in-depth and a prerequisite for SEC-08 — not containment on its own.
// It is worth doing regardless because it costs one IPC hop and permanently
// removes a remote-origin exception from the policy.
const TRANSLATE_LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const TRANSLATE_MAX_CHARS = 20000;

ipcMain.handle("translate-text", async (event, payload) => {
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  const targetLang =
    payload && typeof payload.targetLang === "string" ? payload.targetLang : "";
  // The language code goes straight into the URL, so it is validated against a
  // shape rather than escaped - anything that is not a language tag is a bug or
  // an injection attempt, and there is no legitimate third case.
  if (!TRANSLATE_LANG_RE.test(targetLang)) {
    throw new Error(`Unsupported target language: ${String(targetLang).slice(0, 20)}`);
  }
  if (!text.trim()) return text;
  if (text.length > TRANSLATE_MAX_CHARS) {
    throw new Error(`Translation payload too large: ${text.length} chars`);
  }

  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto" +
    `&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Translation API error: ${response.status}`);
  const data = await response.json();
  const segments = data && data[0];
  // The API has returned something unexpected; the caller's contract is to keep
  // the original text rather than surface a partial translation.
  if (!segments || !Array.isArray(segments)) return text;
  return segments.map((s) => (s && s[0]) || "").join("");
});

// Return app root path so renderer can construct paths like README.md
ipcMain.handle("get-app-path", () => app.getAppPath());

// Return README.md path — works in dev (next to main.js) and packaged (extraResources)
ipcMain.handle("get-readme-path", () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "README.md");
  }
  return path.join(__dirname, "README.md");
});

// IPC handlers for update actions
ipcMain.on("check-for-updates", () => {
  log("Manual update check requested");
  const updater = getAutoUpdater();
  if (!updater) {
    log("Auto-updater not available");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "error",
        error: "Auto-updater not available",
      });
    }
    return;
  }
  if (app.isPackaged) {
    updater.checkForUpdates();
  } else {
    log("Skipping update check in development mode");
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "dev-mode",
        message: "Update check is disabled in development mode",
      });
    }
  }
});

ipcMain.on("download-update", () => {
  log("Download update requested");
  const updater = getAutoUpdater();
  if (updater) {
    updater.downloadUpdate();
  }
});

ipcMain.on("install-update", () => {
  log("Install update requested");
  const updater = getAutoUpdater();
  if (!updater) return;

  if (isPortable && downloadedUpdatePath) {
    // Portable .exe: quitAndInstall() doesn't work.
    // Launch the downloaded NSIS installer via a temp batch script (waits for app to exit first).
    try {
      const batchPath = path.join(os.tmpdir(), "omnicore-update.bat");
      const batch =
        [
          "@echo off",
          "timeout /t 2 /nobreak > nul",
          `start "" "${downloadedUpdatePath}"`,
          'del "%~f0"',
        ].join("\r\n") + "\r\n";
      fs.writeFileSync(batchPath, batch, "utf8");
      const { exec } = require("child_process");
      exec(`start /min "" cmd /c "${batchPath}"`);
      log("Portable update: batch script launched, quitting app");
      app.quit();
    } catch (err) {
      log("Portable update batch failed:", err.message);
    }
  } else if (!isPortable) {
    updater.quitAndInstall(false, true);
  }
});

// Check for updates after app is ready (only in production)
function checkForUpdatesOnStartup() {
  if (!app.isPackaged) return;
  const updater = getAutoUpdater();
  if (updater) {
    // Wait a few seconds after app starts before checking for updates
    setTimeout(() => {
      log("Checking for updates on startup...");
      updater.checkForUpdates().catch((err) => {
        log("Error checking for updates:", err.message);
      });
    }, 5000);
  }
}

// Call update check after window is ready
app.on("ready", () => {
  checkForUpdatesOnStartup();
});
