// ============================================
// IMPORTS
// ============================================
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Menu,
  autoUpdater: electronAutoUpdater,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { pathToFileURL, fileURLToPath } = require("url");

// ============================================
// DEVELOPMENT PROFILE ISOLATION
// ============================================
// A development run (`npm start`, i.e. `electron .`) and an INSTALLED Folia
// share an application name, so Electron hands them the same userData
// directory - and that directory is not merely storage. MEASURED with two
// concurrent Electron processes: requestSingleInstanceLock() is keyed on
// userData (same profile -> the second process is refused and forwards its
// argv to the first; different profiles -> both are granted). So without this,
// launching the dev build while the installed build is running does not start
// a second app at all: it hands the file to the installed one and exits. The
// two also share the tab session, window bounds, recent files and debug.log,
// so each overwrites the other's state.
//
// Guarded on !app.isPackaged, so a shipped build is untouched and keeps the
// exact profile it has always used.
//
// ORDERING IS LOAD-BEARING. app.setPath("userData", ...) is silently ignored
// once the app is ready, and two things below CAPTURE the profile path into
// module-scope constants - WINDOW_STATE_FILE and logFilePath. This must stay
// above both of them;
// (A third module-scope read, the log("User data path:", ...) line, only
// REPORTS the path rather than capturing it, so it is not part of this
// invariant. The claim is deliberately about capture, not about reads: "reads"
// is falsifiable by one grep and would rot the moment another report is added.)
// test/test-packaging.js asserts that statically because "it did not move" is
// an absence check and absence checks fail open.
const DEV_PROFILE_SUFFIX = "-dev";

// Pure, and separated from the application of it on purpose: a decision that is
// only observable by booting Electron and looking at where files landed can
// only be tested end to end, whereas this can be driven directly against a stub
// (test/test-dev-profile.js does exactly that).
function devProfileDecision(app) {
  if (app.isPackaged) return { target: null, reason: "packaged" };

  const appData = app.getPath("appData");
  const name = app.getName();
  const standard = path.join(appData, name);

  // Something has ALREADY relocated the profile - test/test-userdata-isolation.js
  // gives every suite its own directory, and Chromium's --user-data-dir switch
  // does the same from the command line. Overriding that here would silently
  // undo it, which in the harness's case means eight suites sharing one profile
  // again: precisely the contamination that module exists to prevent, and it
  // would not fail - it would just quietly stop being isolated.
  if (path.resolve(app.getPath("userData")) !== path.resolve(standard)) {
    return { target: null, reason: "already-relocated" };
  }

  return {
    target: path.join(appData, name + DEV_PROFILE_SUFFIX),
    reason: "dev",
  };
}

function applyDevProfile() {
  const decision = devProfileDecision(app);
  if (!decision.target) return decision;

  app.setPath("userData", decision.target);

  // setPath fails OPEN, so read it back rather than trusting the call. A warning
  // rather than a throw: an exception raised while the main process is loading
  // becomes dialog.showErrorBox - a modal owned by the process that is failing -
  // and this is a developer-convenience path, not a correctness one.
  if (path.resolve(app.getPath("userData")) !== path.resolve(decision.target)) {
    console.warn(
      "dev profile not applied - userData is still " +
        app.getPath("userData") +
        "; a development run will share the installed app's profile.",
    );
    return { target: null, reason: "setpath-ignored" };
  }
  return decision;
}
// MEASURED END TO END, because no suite can do it: every windowed suite
// relocates userData before requiring this file, so the redirect correctly
// DECLINES there and its positive half is unobservable from inside the harness.
// Hand-run once, on the real product invocation (`electron .`), 2026-08-28:
// <appData>\Folia-dev was created and received window-state.json and debug.log,
// while <appData>\Folia's mtime did not move at all. So a development run
// genuinely lands in the sibling and genuinely leaves an installed Folia's
// profile untouched.
applyDevProfile();

// ============================================
// DEVTOOLS EXPOSURE
// ============================================

// The renderer runs with nodeIntegration: true, so the DevTools console is a
// Node REPL with the user's full filesystem rights. In a SHIPPED build that is
// the classic self-XSS route - "open this file, press F12, paste this" - and
// nothing about it requires a bug in Folia to exploit, only a person at the
// keyboard following instructions.
//
// Source runs keep DevTools unconditionally, because that is what it is for. A
// packaged build requires an explicit environment opt-in, which is the point:
// an environment variable cannot be set by talking someone through a keystroke,
// so the social-engineering route closes while the maintainer's route stays
// open. Note this is the INTERIM control - the durable fix is SEC-08
// (contextIsolation plus a preload bridge), after which a console in the
// renderer is no longer a console in Node.
function devToolsAllowed() {
  return !app.isPackaged || process.env.FOLIA_DEVTOOLS === "1";
}

// Electron installs a DEFAULT application menu - File/Edit/View/Window - when
// nothing calls Menu.setApplicationMenu. MEASURED: it is present, and its
// View submenu carries Toggle Developer Tools on Ctrl+Shift+I.
//
// Every window this app creates already calls setMenu(null), which was measured
// (with a positive control) to suppress that accelerator, so the default menu
// is displayed nowhere and reachable nowhere. That makes removing it globally
// inert TODAY and valuable tomorrow: a window added later that forgets
// setMenu(null) would otherwise inherit a Node-privileged console on a stock
// keystroke, which is precisely the kind of omission nobody would notice.
//
// Windows-only fork, so the usual macOS caveat does not apply: Chromium handles
// clipboard and selection shortcuts natively here, and it must, because no
// window has used the application menu for them at any point.
function suppressDefaultApplicationMenu() {
  Menu.setApplicationMenu(null);
}

// ============================================
// POPUP DOCUMENT ESCAPING
//
// The image, mermaid and table popups are built by concatenating
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

/**
 * Write a generated popup document to a private temp directory.
 *
 * SEC-20 — the previous paths were fixed and guessable
 * (`os.tmpdir()/omnicore-temp-<kind>.html`). On Linux and macOS `os.tmpdir()`
 * is the world-writable `/tmp`, so an unprivileged local process can pre-create
 * that exact path as a symlink; `fs.writeFileSync` follows symlinks, which
 * turns opening a popup into an arbitrary file write as the user.
 * `mkdtempSync` creates a fresh directory with an unpredictable name and 0700
 * permissions, and `flag: "wx"` refuses to write at all if anything is already
 * sitting at the target.
 *
 * It also fixes a plain functional bug that had nothing to do with security:
 * one fixed filename *per popup kind* meant a second mermaid diagram
 * overwrote the first one's file, and whichever popup closed first deleted the
 * file out from under the other.
 *
 * @returns {{dir: string, file: string}} pass to removePopupDocument() on close
 */
function writePopupDocument(kind, htmlContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folia-"));
  const file = path.join(dir, `${kind}.html`);
  fs.writeFileSync(file, htmlContent, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { dir, file };
}

/**
 * Remove a popup's temp directory and everything in it.
 *
 * The whole directory goes, not just the file: it is ours alone, and leaving
 * empty directories behind on every popup close is its own slow leak.
 */
function removePopupDocument(tmp) {
  if (!tmp || !tmp.dir) return;
  try {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  } catch (err) {
    console.error("Error cleaning up popup temp directory:", err);
  }
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
const { execFile } = require("child_process");

// Helper modules
const {
  isMermaidFile,
  wrapMermaidContent,
  removeBOM,
  readMarkdownFile,
  isLargeDocument,
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
// Gate opening the sink, not just writes: even an empty file leaks that logging
// was enabled and opening an existing log must require the same explicit opt-in.
const diagnosticLoggingEnabled = process.env.FOLIA_DIAGNOSTIC_LOG === "1";
const logStream = diagnosticLoggingEnabled
  ? fs.createWriteStream(logFilePath, { flags: "a" })
  : null;
if (logStream) {
  logStream.on("error", (err) => {
    console.error("Diagnostic file logging failed:", err);
  });
}

function log(...args) {
  // Only log in development mode to improve performance
  if (!app.isPackaged) {
    console.log(...args);
  }

  if (!logStream || logStream.destroyed) return;

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
if (logStream) {
  log("Diagnostic log requested:", logFilePath);
} else {
  log("Diagnostic file logging is disabled.");
}

// ============================================
// APPLICATION STATE
// ============================================
let mainWindow = null;
let fileToOpen = null;

// File watching state
let fileWatcher = null;
let fileWatcherKind = null;
let fileWatcherRearmPending = false;
let watchedFilePath = null;
let watchedFileKey = null;
// Set while the renderer has asked us to stop reporting external changes
// (unsaved edits in progress). Tab switches must not silently undo it.
let watchingPaused = false;
// Modification evidence belongs to a document, not to whichever path happens
// to own the one live OS watcher. Keeping it by canonical identity means a
// paused dirty tab can move into the background and come back without losing
// the mtime against which its eventual resume must be checked.
const documentModifiedTimes = new Map();
const documentVersions = new Map();
const documentsWithUnadoptedChanges = new Set();
const pathsWithUnadoptedChanges = new Set();
const deletionOverflowDocumentMarkerRefs = new Map();
const deletionOverflowPathMarkerRefs = new Map();
const deletedDocuments = new Set();
const pathOnlyDeletionEvidence = new Map();
const pathOnlyDeletionByPathKey = new Map();
const documentDeletionTombstones = new Map();
const deletionTombstonesBySpelling = new Map();
const deletionTombstonesByPathKey = new Map();
const deletionTombstonesById = new Map();
const filePathAliases = new Map();

// WHO A DELETION IS FOR, AND WHETHER THEY HEARD IT.
//
// An external deletion used to be marked "reported" the moment it was sent.
// The renderer, correctly, refuses a report that names a document other than
// the one on screen - so a file deleted while its tab sat in the background was
// announced to nobody, and the flag said it had been announced. Returning to
// that tab never warned, and a save then recreated the file and cleared the
// evidence that it had ever been deleted.
//
// A report is therefore a DELIVERY with an owner and an acknowledgement. The
// owner is the document selection that held the watcher when the deletion was
// observed - a page session and a tab, not a path, because a closed tab and a
// new tab opened on the same path are not the tab that was reading the file.
// The delivery stays open until its owner says it consumed it, and selecting
// that owner again replays it exactly once per selection.
let watchedOwner = null;
let watchedWatcherGeneration = 0;
let latestWatcherSelectionGeneration = 0;
let nextDeletionDeliveryId = 0;
const deletionDeliveries = new Map();
const DELETION_DELIVERY_ACK_TIMEOUT_MS = 4000;
const DELETION_DELIVERY_RETRY_DELAY_MS = 100;
const DELETION_DELIVERY_MAX_RETRY_DELAY_MS = 4000;
const MAX_DELETION_DELIVERIES = 256;
// Owner tombstones are the durable facts. Only their retry/delivery records are
// capacity-bounded against MAX_DELETION_DELIVERIES; compacting a delivery must
// never forget the underlying owner-specific deletion.
//
// RETAINED DELETION EVIDENCE LIVES ONLY IN THIS PROCESS, AND ITS BUDGET IS
// FIRM. One total allowance covers every unit of it:
//   - an owner tombstone (documentDeletionTombstones, and the BySpelling,
//     ByPathKey and ById indexes, which alias those same records),
//   - a path-only (spelling, pathKey) pair (pathOnlyDeletionEvidence and
//     pathOnlyDeletionByPathKey are two views of the same pair set),
//   - an overflow evidence record (deletionOverflowEvidence, whose marker
//     reference maps hold at most one entry per record).
// deletionDeliveries only ever holds tombstone records, so it is bounded by
// the same allowance as well as by MAX_DELETION_DELIVERIES.
//
// Evidence is NEVER evicted to make room. Evicting it is precisely how a later
// Save silently recreates a document the reader deleted. When a new unit
// cannot be reserved, this process LATCHES CLOSED FIRST and only then drops
// the evidence: from that moment every Save is refused - including saves for
// paths that have nothing to do with the dropped evidence - until Folia is
// restarted. Nothing releases the latch. Adoption and retirement free
// capacity, but they do not, and must not, re-open saving: the one fact that
// was lost cannot be recovered by the arrival of unrelated facts.
const MAX_DELETION_EVIDENCE = 100;
let deletionEvidenceCapacityLatched = false;
let deletionEvidenceCapacityLatchWhy = null;
// THE LATCH IS SHARED, SO THE CAUSE TRAVELS WITH IT. Deletion evidence was
// the first fact whose loss had to stop every write; the stale-owner fence is
// the second. Both close the SAME one-way door - one flag, one set of refusal
// sites, nothing to miss - and these three slots carry which fact was lost so
// a refusal never tells the reader about deletions when a document generation
// was what went missing.
let saveAuthorityLatchReason = "deletion-evidence-capacity";
let deletionEvidenceCapacityDropCount = 0;
let deletionEvidenceCapacityRefusalCount = 0;
// ONE notice for the whole latched session. A download has no result channel
// to settle, so the only way to tell the reader is out of band - and a notice
// per blocked download would be exactly the unbounded queue the latch's own
// logging deliberately avoids.
let deletionEvidenceCapacityDownloadNoticeShown = false;
const deletionOverflowEvidence = new Map();
let deletionEvidenceOverflowCount = 0;
let deletionEvidenceRevision = 0;
// Observability for the close/retire handshake: a refusal the reader has to be
// asked about again, and a retirement that arrived describing an older event
// for the same document than the one main now holds.
let deletionRetirementUnacknowledgedCount = 0;
let deletionRetirementEventDriftCount = 0;
const knownDocumentOwners = new Map();
const ownerDocumentBaselines = new Map();
const quarantinedDocumentOwners = new Set();
// SUPERSEDED, BUT NOT DISCARDED. A tab that moves to a new document generation
// deauthorizes its previous owner immediately - that owner may never authorize
// another save, watcher change or quarantine. It is a separate question whether
// its FACTS may be dropped: a baseline that still pins a deletion the reader
// has not answered, a quarantine, a grant or a save still settling all have to
// outlive the supersession. Owners whose facts are still pinned stay in
// `knownDocumentOwners` and are listed here instead, which is what keeps the
// recognition table a superset of the other owner tables while denying the
// stale owner any authority.
const supersededDocumentOwners = new Set();
const notifiedExternalVersionsByOwner = new Map();
const pendingDiskAdoptions = new Map();
const committedDiskAdoptions = new Map();
const MAX_PENDING_DISK_ADOPTIONS = 128;
const DISK_ADOPTION_CAPABILITY_MS = 60000;
const MAX_KNOWN_DOCUMENT_OWNERS = 256;
// THE STALE-OWNER FENCE IS EVIDENCE, AND NOTHING CAN REBUILD IT. For one tab
// the fence is a single fact - "this tab has moved past generation N" - and
// the only place it is written down is the owner table itself: the NEWEST
// entry a tab has in `knownDocumentOwners` is what `canRememberDocumentOwner`
// compares a late arrival against. An older entry, superseded or not, adds
// nothing while a newer one is present, and its marker adds nothing either:
// anything the older entry would refuse, the newer one refuses too, because
// a tab's entries always carry DISTINCT document generations (a second entry
// at the same generation is exactly what the newer-owner test refuses). So
// dropping a COVERED entry is free, and dropping a tab's newest entry is the
// one eviction that cannot be undone - after it, a delayed registration for a
// generation the tab has already left reads as a first-ever registration and
// would be admitted with a fresh baseline and full authority.
//
// The table is bounded, so a session with more live tabs than slots has to
// give up one of the two. This process keeps the BOUND and gives up the
// fence - but never silently, and never in a way a stale owner can use.
// Before an eviction drops a tab's newest entry the save-authority latch
// below is closed, so from that moment every write this process would make on
// the reader's behalf is refused until Folia is restarted; and this counter
// seals `canRememberDocumentOwner` against every owner it does not already
// know, so the generation that lost its fence is never readmitted at all.
let documentOwnerFenceDropCount = 0;
// THE SEALED TABLE HAS NO RESULT CHANNEL EITHER. `register-document-owner` is
// fire-and-forget: nothing waits on it and there is nothing to answer, so a
// registration the seal refuses is invisible to the renderer. The tab it
// belonged to stays on screen looking ordinary while it can no longer be
// saved, is not watched, and cannot answer the close prompt's deletion query -
// and NOTHING IN THIS PROCESS CAN TAKE IT AWAY: no main->renderer channel
// closes, disables or quarantines a tab, and the ones that could be bent into
// the shape of one (`file-open-result` settles a navigation token;
// `file-deleted` would fabricate a deletion and retain a tombstone for it)
// would have to lie to do it. So the reader is told ONCE, out of band, and
// every later refusal is counted rather than announced: the seal is a one-way
// door, and a message per refused registration is exactly the unbounded queue
// the latch's own logging deliberately avoids.
//
// WHAT THIS DOES AND DOES NOT ANNOUNCE, EXACTLY. The counter and the notice
// cover the BACKGROUND REGISTRATION refusal and nothing else, because that is
// the only seal refusal with no way back to the renderer. The drop itself is
// not announced here: it happens inside `rememberDocumentOwner`, which the
// foreground open and the disk-adoption completion both sit on, and a dialog
// raised there would land in the middle of an adoption - and it needs no
// announcement of its own, because the latch it closes answers the reader
// through the Save and export result channels they already await. The other
// seal refusals - adoption admission, watcher authority - each return a
// machine-readable reason the renderer surfaces itself.
let documentOwnerSealRegistrationRefusalCount = 0;
let documentOwnerSealNoticeShown = false;
// ANNOUNCED ONCE, COUNTED FOREVER. The two refusals below are the only ones a
// caller can drive without limit: once a fence has been dropped the table
// refuses EVERY owner it does not already know, and a table that is full with
// every entry pinned refuses EVERY insertion, so both answer the same way for
// the rest of the session however often they are asked. A line per attempt
// would let a repeated - or hostile - registration grow this process's log
// without bound, which is the same unbounded queue the seal's reader notice
// already refuses to be. Each condition is therefore logged in FULL the first
// time it is reached and counted after that, with the counters saturating
// rather than wrapping and reported in the diagnostics snapshot. Nothing else
// is quietened: supersession, a newer sibling and a malformed envelope all
// still log per refusal, because none of them is a session-long verdict. The
// pinned refusal is announced once per CALLER, for the reason given with it.
let documentOwnerSealAdmissionRefusalCount = 0;
let documentOwnerSealAdmissionRefusalLogged = false;
let documentOwnerTablePinnedRefusalCount = 0;
let documentOwnerRegistrationTablePinnedRefusalLogged = false;
let documentOwnerAdoptionTablePinnedRefusalLogged = false;
// DELIBERATELY NOT "DID THE COUNTER MOVE". A caller that needs to know whether
// the refusal it just took was the exhausted table cannot read that off the
// count above: the count SATURATES, so once it stops moving a genuine refusal
// and no refusal at all look identical, and the suppression this drives would
// silently come undone at exactly the point it matters most. This flag is set
// by every pinned refusal and cleared by the caller immediately before the
// call it is asking about, so it carries one synchronous answer and no history.
let lastDocumentOwnerRefusalWasTablePinned = false;
const invalidatedSaveScopes = new WeakSet();
const quarantinedSaveScopes = new WeakSet();

function normaliseDocumentIdentity(
  owner,
  filePath,
  { useCurrentPathIdentity = false, forAdoption = false } = {},
) {
  if (!owner || typeof owner !== "object") return null;
  if (
    typeof owner.pageSession !== "string" ||
    owner.pageSession.length === 0 ||
    owner.pageSession.length > 128 ||
    !Number.isSafeInteger(owner.rendererGeneration) ||
    owner.rendererGeneration <= 0 ||
    !Number.isSafeInteger(owner.tabId) ||
    owner.tabId <= 0 ||
    !Number.isSafeInteger(owner.documentGeneration) ||
    owner.documentGeneration <= 0 ||
    typeof owner.pathKey !== "string" ||
    owner.pathKey.length === 0 ||
    owner.pathKey.includes("\0")
  ) {
    return null;
  }
  const admittedTabKey = [
    owner.pageSession, owner.rendererGeneration, owner.tabId,
  ].join("\0");
  const spelling = filePathSpellingKey(filePath);
  const admission = owner.documentRef === undefined
    ? null : admittedDocumentReference(owner.documentRef, owner, filePath, forAdoption);
  if ((owner.documentRef !== undefined && !admission) ||
      (admittedOwnerTabs.has(admittedTabKey) && !admission)) return null;
  if (!admission && retiredAdmissionScope ===
      `${owner.pageSession}\0${owner.rendererGeneration}` &&
      owner.tabId <= retiredAdmissionTabFloor) {
    const knownKey = documentOwnerKey({ ...owner, spelling });
    const known = knownDocumentOwners.get(knownKey);
    const provisionalAdoption = forAdoption && Array.from(knownDocumentOwners).some(
      ([key, candidate]) => !candidate.documentRef &&
        !supersededDocumentOwners.has(key) &&
        candidate.pageSession === owner.pageSession &&
        candidate.rendererGeneration === owner.rendererGeneration &&
        candidate.tabId === owner.tabId && candidate.pathKey === owner.pathKey);
    if (!provisionalAdoption && (!known || known.documentRef ||
        supersededDocumentOwners.has(knownKey))) return null;
  }
  const pathKey = useCurrentPathIdentity
    ? resolveCanonicalFileKey(filePath) || spelling
    : canonicalFileKey(filePath);
  if (!spelling || !pathKey || owner.pathKey !== pathKey) return null;
  return Object.freeze({
    pageSession: owner.pageSession,
    rendererGeneration: owner.rendererGeneration,
    tabId: owner.tabId,
    documentGeneration: owner.documentGeneration,
    pathKey,
    spelling,
    ...(admission ? { documentRef: owner.documentRef } : {}),
  });
}

function normaliseDocumentOwner(owner, filePath, options = {}) {
  const identity = normaliseDocumentIdentity(owner, filePath, options);
  if (
    !identity ||
    !Number.isSafeInteger(owner.selectionGeneration) ||
    owner.selectionGeneration <= 0
  ) {
    return null;
  }
  return Object.freeze({
    ...identity,
    selectionGeneration: owner.selectionGeneration,
  });
}

function documentOwnerKey(owner) {
  return owner
    ? [
        owner.pageSession,
        owner.rendererGeneration,
        owner.tabId,
        owner.documentGeneration,
        owner.pathKey,
        owner.spelling,
      ].join("\0")
    : null;
}

function sameDocumentOwner(left, right) {
  return (
    !!left &&
    !!right &&
    left.pageSession === right.pageSession &&
    left.rendererGeneration === right.rendererGeneration &&
    left.tabId === right.tabId &&
    left.documentGeneration === right.documentGeneration &&
    left.pathKey === right.pathKey &&
    left.spelling === right.spelling
  );
}

function sameDocumentGeneration(left, right) {
  return (
    !!left &&
    !!right &&
    left.pageSession === right.pageSession &&
    left.rendererGeneration === right.rendererGeneration &&
    left.tabId === right.tabId &&
    left.documentGeneration === right.documentGeneration &&
    left.spelling === right.spelling
  );
}

function sameDocumentSelectionOwner(left, right) {
  return (
    sameDocumentOwner(left, right) &&
    left.selectionGeneration === right.selectionGeneration
  );
}

// An owner with a save in flight is the authority that save's result is
// checked against. Evicting it to make room turns a completed disk write into
// a settlement-only failure for a document that really was written, so the
// oldest FORGETTABLE owner is taken instead of the oldest owner. A pinned
// owner is one whose loss would cost a settlement, a grant, a quarantine, the
// watch, or a deletion the reader has not answered, and capacity is never
// allowed to buy room with any of those - when nothing is forgettable the new
// registration is refused instead, so the cap itself still holds.
function documentOwnerHasActiveSave(ownerKey) {
  if (!ownerKey) return false;
  for (const scope of activeSaveCorrelations.values()) {
    if (documentOwnerKey(scope.owner) === ownerKey) return true;
  }
  for (const record of pendingSaveOutcomeDeliveries.values()) {
    if (documentOwnerKey(record.scope.owner) === ownerKey) return true;
  }
  return false;
}

// AN OWNER IS ONE UNIT ACROSS SIX TABLES. Dropping the recognition entry on
// its own leaves the baseline, the quarantine flag and the external-version
// notice with nothing left to reach them - the supersession sweep below walks
// `knownDocumentOwners`, so an owner missing from it is never revisited when
// its tab moves on. Those orphans are not just memory: a surviving baseline
// answers "this owner is still live" forever, which is the test that keeps a
// tombstone from being retired and makes the sibling checks stat a document
// that is gone. Keeping the tables in step is what makes the baseline table's
// keys a subset of the recognition table's.
function forgetDocumentOwnerAliases(ownerKey) {
  knownDocumentOwners.delete(ownerKey);
  ownerDocumentBaselines.delete(ownerKey);
  quarantinedDocumentOwners.delete(ownerKey);
  supersededDocumentOwners.delete(ownerKey);
  notifiedExternalVersionsByOwner.delete(ownerKey);
  latestAcceptedSaveSequenceByDocument.delete(ownerKey);
}

// `consumedCapability` names a COMMITTED grant whose holder is about to spend
// it, so the pin it contributes is about to disappear. Only the committed map
// is allowed to honour it, and a Map holds at most one entry per key, so the
// discount can skip exactly the one grant the caller is consuming and nothing
// else. Pending grants are never discounted: a capability leaves
// `pendingDiskAdoptions` before it is committed, so a pending entry under that
// string is a DIFFERENT grant and still pins its owners.
function documentOwnerHasDiskAdoptionGrant(ownerKey, consumedCapability = null) {
  for (const grant of pendingDiskAdoptions.values()) {
    if (
      grant.oldOwnerKey === ownerKey ||
      grant.proposedOwnerKey === ownerKey
    ) return true;
  }
  for (const [capability, grant] of committedDiskAdoptions) {
    if (capability === consumedCapability) continue;
    if (
      grant.oldOwnerKey === ownerKey ||
      grant.proposedOwnerKey === ownerKey
    ) return true;
  }
  return false;
}

// Evidence is never retired to make room. An owner named by a tombstone, an
// open report, or any path-only or overflow record for its path is pinned in
// the tables instead, so a capacity decision can never be the thing that
// discards a deletion the reader has not answered yet. The spelling arms are
// deliberately wider than the path-key ones and are NOT redundant with them:
// an owner whose path key has since been retargeted still has to be able to
// answer `query-document-deletion-state`, which needs its baseline, and that
// query reports path-only evidence by SPELLING. Forgetting such an owner would
// leave a live document with deletion evidence it can no longer be told about.
// The cost is that one retained record pins every owner sharing its path or
// spelling; that is the side to err on when the alternative is silence.
function documentOwnerHasRetainedEvidence(ownerKey, owner) {
  if (
    documentDeletionTombstones.has(ownerKey) ||
    deletionDeliveries.has(ownerKey) ||
    deletedDocuments.has(owner.pathKey) ||
    pathKeyHasDeletionEvidence(owner.pathKey) ||
    pathOnlyDeletionEvidence.has(owner.spelling) ||
    deletionTombstonesBySpelling.has(owner.spelling)
  ) return true;
  for (const record of deletionOverflowEvidence.values()) {
    if (
      record.ownerKey === ownerKey ||
      record.pathKey === owner.pathKey ||
      record.spelling === owner.spelling
    ) return true;
  }
  return false;
}

function documentOwnerCanBeForgotten(ownerKey, consumedCapability = null) {
  const owner = knownDocumentOwners.get(ownerKey);
  if (!owner) return false;
  return (
    !documentOwnerHasActiveSave(ownerKey) &&
    !quarantinedDocumentOwners.has(ownerKey) &&
    !sameDocumentOwner(owner, watchedOwner) &&
    !documentOwnerHasDiskAdoptionGrant(ownerKey, consumedCapability) &&
    !documentOwnerHasRetainedEvidence(ownerKey, owner)
  );
}

// A TAB'S FENCE IS CARRIED BY EXACTLY ONE ROW. Two entries for the same tab
// can never share a document generation - the newer-owner test in
// `canRememberDocumentOwner` refuses a second owner at the same generation,
// whatever its path or spelling - so the entries of a tab are totally ordered
// by generation, and the newest one refuses everything the older ones would,
// including their own keys. An entry with a strictly newer sibling in the
// table is therefore COVERED: forgetting it, and the supersession marker that
// travels with it, changes no admission decision. An entry with no such
// sibling is the tab's high-water mark and is the fence itself.
//
// This is deliberately computed from the table rather than kept alongside it.
// A separate high-water map would have to hold one entry per tab with nothing
// bounding the tab count, which is the unbounded growth the owner cap exists
// to prevent; the scratch map built here lives for one call and is bounded by
// the table it is read from.
function documentOwnerTabKey(owner) {
  return owner
    ? [owner.pageSession, owner.rendererGeneration, owner.tabId].join("\0")
    : null;
}

function newestDocumentGenerationByTab() {
  const newest = new Map();
  for (const knownOwner of knownDocumentOwners.values()) {
    const tabKey = documentOwnerTabKey(knownOwner);
    const seen = newest.get(tabKey);
    if (seen === undefined || knownOwner.documentGeneration > seen) {
      newest.set(tabKey, knownOwner.documentGeneration);
    }
  }
  return newest;
}

// `requireCoveredFence` asks for an eviction that costs NOTHING beyond the
// entry itself. Callers that cannot pay the fence use it first and fall back
// only after latching.
function oldestForgettableDocumentOwnerKey(
  consumedCapability = null,
  { requireCoveredFence = false } = {},
) {
  const newestByTab = requireCoveredFence
    ? newestDocumentGenerationByTab()
    : null;
  for (const [knownKey, knownOwner] of knownDocumentOwners) {
    if (
      newestByTab &&
      !(
        newestByTab.get(documentOwnerTabKey(knownOwner)) >
        knownOwner.documentGeneration
      )
    ) continue;
    if (documentOwnerCanBeForgotten(knownKey, consumedCapability)) {
      return knownKey;
    }
  }
  return null;
}

// LATCH FIRST, DROP SECOND, AND SEAL THE TABLE BEHIND BOTH. Once this returns
// the fence for one tab is gone: nothing is left that can tell a delayed
// registration naming a generation that tab has already left from a first
// registration. Two things make that survivable. The latch is closed before
// the evidence disappears, so this process refuses every write until it is
// restarted; and the drop counter this bumps seals `canRememberDocumentOwner`
// against any owner not already on record, so the stale owner is never
// admitted in the first place rather than merely kept away from the disk.
// Owners already in the table keep their marker and their newer siblings, so
// live tabs are untouched. The counter is also the record that it happened,
// and it is bumped on EVERY drop, including ones after the latch is shut.
function dropDocumentOwnerFenceEvidence() {
  documentOwnerFenceDropCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    documentOwnerFenceDropCount + 1,
  );
  latchSaveAuthority({
    why: "document-owner-fence-capacity",
    reason: "document-owner-fence",
    summary:
      `Document owner capacity exhausted at ${MAX_KNOWN_DOCUMENT_OWNERS} ` +
      "owners with every forgettable entry holding the newest generation of " +
      "its tab, so a stale-owner fence had to be dropped",
    writeError: DOCUMENT_OWNER_FENCE_WRITE_ERROR,
    saveError: DOCUMENT_OWNER_FENCE_SAVE_ERROR,
  });
}

function noteDocumentOwnerSealAdmissionRefusal() {
  documentOwnerSealAdmissionRefusalCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    documentOwnerSealAdmissionRefusalCount + 1,
  );
  if (documentOwnerSealAdmissionRefusalLogged) return;
  documentOwnerSealAdmissionRefusalLogged = true;
  console.error(
    "Refusing an unknown document owner: a stale-owner fence has been " +
      "dropped, so this process can no longer prove the owner is current. " +
      "Every later unknown owner is refused the same way and counted in " +
      "documentOwnerSealAdmissionRefusalCount rather than logged again.",
  );
}

// ONE SHOT PER CALLER, ONE COUNT FOR THE CONDITION. The exhausted table is a
// single fact, but WHICH door it closed is worth knowing - a registration
// refused for capacity and an adoption refused for capacity are abused, and
// diagnosed, differently - so each of the two callers announces itself once
// and both are counted together. The adoption callers also answer their
// renderer with a machine-readable reason, so a counted refusal is never an
// invisible one.
function noteDocumentOwnerTablePinnedRefusal(kind) {
  documentOwnerTablePinnedRefusalCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    documentOwnerTablePinnedRefusalCount + 1,
  );
  lastDocumentOwnerRefusalWasTablePinned = true;
  // "adoption" names the two disk-adoption doors; the registration drain is
  // the only other caller and is the default.
  const forAdoption = kind === "adoption";
  if (forAdoption) {
    if (documentOwnerAdoptionTablePinnedRefusalLogged) return;
    documentOwnerAdoptionTablePinnedRefusalLogged = true;
  } else {
    if (documentOwnerRegistrationTablePinnedRefusalLogged) return;
    documentOwnerRegistrationTablePinnedRefusalLogged = true;
  }
  console.error(
    `Refusing ${forAdoption ? "a disk adoption" : "a document owner"}: the ` +
      "owner table is full and every owner in it is pinned. Every later " +
      "refusal for this reason is counted in " +
      "documentOwnerTablePinnedRefusalCount rather than logged again.",
  );
}

function canRememberDocumentOwner(owner) {
  const key = documentOwnerKey(owner);
  if (!key) return false;
  // SUPERSESSION IS TERMINAL FOR THE KEY IT NAMES, and the marker outlives
  // every eviction that could make it matter. It is cleared only by
  // `forgetDocumentOwnerAliases`, and capacity reaches that only for an entry
  // its tab's high-water still COVERS - in which case the generation test
  // below refuses everything this marker would have - or, when no covered
  // entry is left, after `dropDocumentOwnerFenceEvidence` has already latched
  // every write closed. So an owner reaching here is refused by the marker, by
  // a newer sibling, or on a machine that can no longer write at all.
  if (supersededDocumentOwners.has(key)) {
    console.error("Refusing to re-register a superseded document owner");
    return false;
  }
  // AND ONCE A FENCE HAS ACTUALLY BEEN SPENT, THE TABLE IS SEALED. The latch
  // that `dropDocumentOwnerFenceEvidence` closes stops this process writing,
  // but writing is not the only authority an owner carries - it can arm the
  // watch, quarantine a document and answer for deletion evidence - and the
  // requirement is that a stale owner is never ADMITTED, not merely that it
  // cannot save. After a drop there is one tab for which this function can no
  // longer tell a first registration from a replay, and nothing left to tell
  // them apart with, so every owner this process does not ALREADY know is
  // refused. Owners already on record are unaffected: their keys are still
  // fenced by the marker above and the generation test below, so live tabs go
  // on working exactly as before, on a machine that has already declared
  // itself unable to write. This is the closed side of a door that only opens
  // at 256 simultaneously live owners, and only after every cheaper eviction
  // has been spent.
  if (documentOwnerFenceDropCount > 0 && !knownDocumentOwners.has(key)) {
    // Bounded announcement: the verdict is session-long, so it is logged once
    // and counted after that.
    noteDocumentOwnerSealAdmissionRefusal();
    return false;
  }
  for (const knownOwner of knownDocumentOwners.values()) {
    if (
      knownOwner.pageSession === owner.pageSession &&
      knownOwner.rendererGeneration === owner.rendererGeneration &&
      knownOwner.tabId === owner.tabId &&
      (knownOwner.documentGeneration > owner.documentGeneration ||
        (knownOwner.documentGeneration === owner.documentGeneration &&
          (knownOwner.pathKey !== owner.pathKey ||
            knownOwner.spelling !== owner.spelling ||
            knownOwner.selectionGeneration > owner.selectionGeneration)))
    ) {
      console.error("Refusing to replace a newer document owner");
      return false;
    }
  }
  return true;
}

// THE CAP IS ENFORCED AT REGISTRATION, AND ONE CALLER CANNOT SURVIVE A
// REFUSAL THERE. `completeDocumentDiskAdoption` spends its capability and
// retires the reader's unanswered deletion evidence, and a capacity refusal
// for the adopting owner after that point would discard a deletion warning
// nobody has seen, burn a grant that cannot be reissued, and leave the
// PREVIOUS owner still watched, still known and so still able to save - with
// the evidence that would have stopped it gone. That completion asks the same
// question here first, while a refusal is still free, and then admits the
// owner itself rather than leaving it to a later message.
//
// The answer is conservative by construction. Between the question and the
// registration a completion only REMOVES the things that pin an owner - the
// grant discounted below, and the evidence it retires - and never registers
// another owner nor adds a pin, so room proven here is still room at the
// registration that follows. Discounting the one committed grant is exact
// rather than speculative: if the completion refuses, nothing irreversible
// has run and the grant simply stays; if it succeeds, the grant is gone
// before the registration looks. Without that discount a predecessor pinned
// ONLY by the capability this adoption is about to consume would read as a
// dead end of our own making.
function documentOwnerTableHasRoomFor(owner, consumedCapability = null) {
  const key = documentOwnerKey(owner);
  if (!key) return false;
  if (knownDocumentOwners.has(key)) return true;
  if (knownDocumentOwners.size < MAX_KNOWN_DOCUMENT_OWNERS) return true;
  // One forgettable owner is enough: the drain removes entries one at a time
  // and the table is never over its cap, so a single eviction makes the room
  // the insertion needs. Forgetting one owner cannot pin another - the
  // forgettable test reads only that owner's own saves, quarantine, watch,
  // grants and evidence - so the sweep that precedes the drain cannot take
  // this candidate away either.
  //
  // DELIBERATELY BLIND TO THE FENCE. The drain can always make this room, and
  // when the only way left is to spend a tab's high-water mark it latches
  // every write closed before doing so. Answering "no room" here instead
  // would refuse the adoption - and adoption is the one caller that cannot be
  // refused for capacity at all, because by the time the question is asked
  // again it has spent a grant and retired evidence. The latch is the price,
  // and it is paid identically whichever caller reaches the drain first.
  return oldestForgettableDocumentOwnerKey(consumedCapability) !== null;
}

function rememberDocumentOwner(
  owner,
  {
    diskVersion = null,
    modifiedTime = null,
    adopted = false,
    readPath = null,
    acceptedReadTarget = null,
  } = {},
) {
  if (!owner || typeof owner !== "object") return false;
  const admittedTabKey = [
    owner.pageSession, owner.rendererGeneration, owner.tabId,
  ].join("\0");
  if (owner.documentRef && !admittedOwnerTabs.has(admittedTabKey)) {
    pruneAdmissionScopeFences();
  }
  if (!canRememberDocumentOwner(owner)) return false;
  const admission = owner.documentRef
    ? admittedDocumentReference(owner.documentRef, owner, readPath, adopted)
    : null;
  const suppliedAdmissionVersion = normaliseDiskVersion(diskVersion);
  if (owner.documentRef && (!admission ||
      (!acceptedReadTarget && suppliedAdmissionVersion &&
        !sameDiskVersion(admission.snapshotVersion, suppliedAdmissionVersion)) ||
      (!acceptedReadTarget && !knownDocumentOwners.has(documentOwnerKey(owner)) &&
        !suppliedAdmissionVersion))) return false;
  const key = documentOwnerKey(owner);
  const previousReadTarget = knownDocumentOwners.get(key)?.readTarget;
  const resolvedReadTarget = readPath && (adopted || !previousReadTarget)
    ? acceptedReadTarget || admission?.descriptor.readTarget ||
      resolveCanonicalFilePath(readPath)
    : null;
  const readTarget = resolvedReadTarget &&
    canonicalKeyFromPath(resolvedReadTarget) === owner.pathKey
    ? resolvedReadTarget
    : null;
  // SUPERSESSION DEAUTHORIZES, BUT ONLY ONCE THE REPLACEMENT IS ADMITTED, AND
  // IT FORGETS ONLY WHAT IT MAY. An older generation in this tab that nothing
  // is holding is collected here: "forgettable" already means no save is
  // settling against it, it is not quarantined, it is not watched, it holds no
  // grant and it names no unanswered deletion, so dropping it cannot cost a
  // fact even if the admission below refuses. Everything else is RETAINED -
  // its baseline is the only thing keeping an unanswered deletion from looking
  // historical - and is deauthorized by being listed as superseded, which the
  // next sweep and the capacity drain both revisit once the pin clears.
  //
  // THE SWEEP COSTS NO FENCE. `canRememberDocumentOwner` has already refused
  // this owner if any same-tab entry is newer, so every entry this loop
  // touches sits at a STRICTLY older generation than the one about to be
  // admitted - and the drain below cannot refuse after the sweep collected
  // something, because collecting anything puts the table under its cap and
  // the drain's loop never runs. Whatever is forgotten here is covered by the
  // replacement before control leaves this function.
  const supersededKeys = new Set();
  for (const [knownKey, knownOwner] of knownDocumentOwners) {
    if (
      knownKey !== key &&
      knownOwner.pageSession === owner.pageSession &&
      knownOwner.rendererGeneration === owner.rendererGeneration &&
      knownOwner.tabId === owner.tabId
    ) {
      if (documentOwnerCanBeForgotten(knownKey)) {
        forgetDocumentOwnerAliases(knownKey);
      } else {
        supersededKeys.add(knownKey);
      }
    }
  }
  if (!knownDocumentOwners.has(key)) {
    // DRAIN, NOT ONE-FOR-ONE. When every candidate was pinned the table can
    // already be at its cap, and evicting a single owner per insertion would
    // hold it there for the rest of the session instead of letting it settle
    // once the pins clear. Each pass removes an entry that is certainly
    // present, so the loop strictly shrinks the table.
    //
    // AND THE CAP IS HARD. When nothing may be forgotten the registration is
    // REFUSED rather than admitted over the cap: admitting it would let a
    // renderer that keeps every owner pinned grow this table, and the owner,
    // baseline, quarantine and evidence state hanging off it, without bound.
    // Refusing is the closed side - the caller has no owner, so its watcher is
    // not armed and `captureSaveScope` rejects its saves - and it is visible,
    // unlike an eviction that silently costs somebody a settlement. NOTHING
    // THE TAB STILL NEEDS HAS BEEN TOUCHED WHEN THIS RETURNS: a refusal is
    // only reachable when the sweep above collected nothing, so the pinned
    // predecessor keeps its authority rather than being left deauthorized
    // behind a replacement that was never admitted.
    //
    // COVERED ENTRIES FIRST, AND THE FENCE ONLY AS A LAST RESORT. Taking the
    // oldest forgettable entry outright would happily evict a tab's newest
    // owner while an older, already-superseded entry for the same tab sat
    // untouched - the exact churn that leaves nothing to compare a delayed
    // registration against. Every covered entry is drained before any
    // high-water mark is considered, so the newest generation of each tab is
    // the LAST thing this loop is willing to spend, and spending it closes
    // the save-authority latch first.
    while (knownDocumentOwners.size >= MAX_KNOWN_DOCUMENT_OWNERS) {
      const coveredKey = oldestForgettableDocumentOwnerKey(null, {
        requireCoveredFence: true,
      });
      if (coveredKey) {
        forgetDocumentOwnerAliases(coveredKey);
        continue;
      }
      const forgettableKey = oldestForgettableDocumentOwnerKey();
      if (!forgettableKey) {
        noteDocumentOwnerTablePinnedRefusal("registration");
        return false;
      }
      dropDocumentOwnerFenceEvidence();
      forgetDocumentOwnerAliases(forgettableKey);
    }
  }
  for (const supersededKey of supersededKeys) {
    supersededDocumentOwners.add(supersededKey);
  }
  // A save still settling against a superseded owner is reported as replaced
  // rather than dropped. Only retained owners can have one: a forgettable
  // owner has no save in flight by definition.
  for (const scope of activeSaveCorrelations.values()) {
    if (supersededKeys.has(documentOwnerKey(scope.owner))) {
      invalidatedSaveScopes.add(scope);
    }
  }
  // A renderer registration is not main-issued path authority. Retain the
  // physical target it first named rather than letting a case-only sibling
  // or a later registration with the same folded key silently rebind it.
  knownDocumentOwners.set(key, Object.freeze({
    ...owner,
    readTarget: adopted ? readTarget : previousReadTarget || readTarget,
  }));
  if (admission) {
    const previousAdmission = admittedOwnerTabs.get(admittedTabKey);
    if (previousAdmission && previousAdmission !== admission) {
      previousAdmission.retired = true;
      previousAdmission.ticketUsed = true;
    }
    admission.tabId = owner.tabId;
    admission.documentGeneration = owner.documentGeneration;
    admission.deliveredRestore = false;
    admittedOwnerTabs.set(admittedTabKey, admission);
    if (adopted) {
      admission.snapshotVersion = normaliseDiskVersion(diskVersion);
      admission.descriptor = Object.freeze({
        ...admission.descriptor, readTarget, pathKey: owner.pathKey,
      });
    }
  }
  const suppliedVersion = normaliseDiskVersion(diskVersion);
  const previousBaseline = ownerDocumentBaselines.get(key);
  if (!previousBaseline || adopted) {
    ownerDocumentBaselines.set(key, Object.freeze({
      owner,
      version: suppliedVersion,
      modifiedTime: suppliedVersion
        ? suppliedVersion.mtimeMs
        : Number.isFinite(modifiedTime) ? modifiedTime : null,
    }));
    if (adopted) notifiedExternalVersionsByOwner.delete(key);
  }
  return true;
}

function isKnownDocumentOwner(owner) {
  const key = documentOwnerKey(owner);
  if (!key || supersededDocumentOwners.has(key)) return false;
  const known = knownDocumentOwners.get(key);
  return sameDocumentSelectionOwner(known, owner);
}

function indexDeletionTombstone(index, key, record) {
  let records = index.get(key);
  if (!records) {
    records = new Set();
    index.set(key, records);
  }
  records.add(record);
}

function unindexDeletionTombstone(index, key, record) {
  const records = index.get(key);
  if (!records) return;
  records.delete(record);
  if (records.size === 0) index.delete(key);
}

function retainDeletionTombstone(record) {
  documentDeletionTombstones.set(record.key, record);
  indexDeletionTombstone(deletionTombstonesBySpelling, record.spelling, record);
  indexDeletionTombstone(deletionTombstonesByPathKey, record.pathKey, record);
  deletionTombstonesById.set(record.id, record);
}

function removeDeletionTombstone(record) {
  if (documentDeletionTombstones.get(record.key) !== record) return false;
  documentDeletionTombstones.delete(record.key);
  unindexDeletionTombstone(deletionTombstonesBySpelling, record.spelling, record);
  unindexDeletionTombstone(deletionTombstonesByPathKey, record.pathKey, record);
  deletionTombstonesById.delete(record.id);
  return true;
}

function deletionTombstonesForPath(filePath, owner = null) {
  const spelling = filePathSpellingKey(filePath);
  if (!spelling) return [];
  const ownerKey = documentOwnerKey(owner);
  const records = deletionTombstonesBySpelling.get(spelling);
  return records
    ? Array.from(records).filter(
        (record) => !ownerKey || record.key === ownerKey,
      )
    : [];
}

function pathHasDeletionTombstone(filePath, owner = null) {
  return deletionTombstonesForPath(filePath, owner).length > 0;
}

function pathOnlyDeletionForSpelling(filePath) {
  return pathOnlyDeletionEvidence.has(filePathSpellingKey(filePath));
}

function pathKeyHasDeletionEvidence(key) {
  return deletionTombstonesByPathKey.has(key) ||
    pathOnlyDeletionByPathKey.has(key);
}

// EVERY RETAINED UNIT, COUNTED ONCE. The two path-only maps describe the same
// (spelling, pathKey) pairs and the tombstone indexes alias the tombstone
// records, so counting pairs and owner tombstones once bounds all of them.
function deletionEvidenceFootprint() {
  let pathOnlyPairs = 0;
  for (const keys of pathOnlyDeletionEvidence.values()) {
    pathOnlyPairs += keys.size;
  }
  return (
    documentDeletionTombstones.size +
    pathOnlyPairs +
    deletionOverflowEvidence.size
  );
}

function latchSaveAuthority({ why, reason, summary, writeError, saveError }) {
  if (deletionEvidenceCapacityLatched) return;
  deletionEvidenceCapacityLatched = true;
  deletionEvidenceCapacityLatchWhy = why;
  saveAuthorityLatchReason = reason;
  saveAuthorityLatchWriteError = writeError;
  saveAuthorityLatchSaveError = saveError;
  // A shutdown answer taken against the pre-latch picture described a machine
  // that could still save. Bumping the revision fails its commit closed rather
  // than letting it discard documents on the strength of a stale question.
  noteDeletionEvidenceMutation();
  // ONCE. The latch is a one-way door, so a per-drop log would be an unbounded
  // queue by another name; the drop and refusal counters carry the rest.
  console.error(
    `${summary}. Saving is now refused for every document until Folia is ` +
      "restarted.",
  );
}

function latchDeletionEvidenceCapacity(why) {
  latchSaveAuthority({
    why,
    reason: "deletion-evidence-capacity",
    summary:
      `Deletion evidence capacity exhausted at ${MAX_DELETION_EVIDENCE} ` +
      `retained units (${why})`,
    writeError: DELETION_EVIDENCE_CAPACITY_WRITE_ERROR,
    saveError: DELETION_EVIDENCE_CAPACITY_SAVE_ERROR,
  });
}

// ROOM FOR ONE NEW UNIT. Callers must reserve BEFORE they mutate anything and
// must record nothing at all when this refuses: a half-recorded unit is
// evidence the retire paths cannot find. Mutations that add no unit - re-arming
// an existing tombstone, re-asserting a known path-only pair, replacing an
// overflow record under its own key - never consult this and stay legal after
// the latch, because a duplicate cannot exhaust anything.
function reserveDeletionEvidenceCapacity(why) {
  if (
    !deletionEvidenceCapacityLatched &&
    deletionEvidenceFootprint() < MAX_DELETION_EVIDENCE
  ) {
    return true;
  }
  latchDeletionEvidenceCapacity(why);
  deletionEvidenceCapacityDropCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    deletionEvidenceCapacityDropCount + 1,
  );
  return false;
}

// EVERY WRITE THIS PROCESS MAKES ON THE READER'S BEHALF, not only the markdown
// Save. The latch's promise is "Folia refuses to write any file until it is
// restarted", and a PDF export, an image export or a table download that still
// lands on disk breaks that promise in the most visible way available: it
// creates a file at a destination the reader has just chosen, in a session the
// app has already declared unable to prove what was deleted. These paths carry
// no document identity and no save correlation, so they are refused with the
// same machine-readable reason and counted on the same counter, and nothing
// here fabricates an id that the existing protocol never had.
const DELETION_EVIDENCE_CAPACITY_WRITE_ERROR =
  "Folia can no longer prove which documents were deleted - its in-memory " +
  "record of deletions is full - so it refuses to write any file, including " +
  "exports and downloads to newly chosen destinations, until Folia is " +
  "restarted.";

// THE SAME PROMISE, THE OTHER FACT. When the stale-owner fence is what was
// lost, telling the reader their deletion record is full would be a lie about
// the one thing the latch exists to be honest about. The refusal, the stage
// and the counters are identical; only the sentence differs.
const DOCUMENT_OWNER_FENCE_WRITE_ERROR =
  "Folia can no longer prove which document each of its tabs has moved on " +
  "to - its in-memory record of replaced documents is full - so it refuses " +
  "to write any file, including exports and downloads to newly chosen " +
  "destinations, until Folia is restarted.";

let saveAuthorityLatchWriteError = DELETION_EVIDENCE_CAPACITY_WRITE_ERROR;
// A download cannot be told anything - `will-download` can only cancel it - so
// this is the only channel left. Shown at most ONCE per latched session by its
// single caller, non-blocking, and inert if the dialog cannot be raised: a
// notice that failed to appear must not take the app down with it.
function notifyDeletionEvidenceCapacityDownloadBlocked() {
  try {
    const win =
      BrowserWindow.getFocusedWindow() ||
      (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    const options = {
      type: "warning",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      title: "Saving is blocked",
      message: "Folia stopped writing files and cannot resume until it restarts.",
      detail:
        saveAuthorityLatchWriteError +
        "\n\nThe download you just started was cancelled. Further downloads " +
        "stay blocked without another message.",
    };
    const shown = win
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options);
    shown.catch(() => {});
  } catch {
    // Nothing else to try; the refusal counter still records it.
  }
}

// DELIBERATELY NOT `saveAuthorityLatchWriteError`. The latch keeps the FIRST
// cause that closed it, so a session whose deletion evidence filled up before
// a fence was ever dropped still describes deletions there - while the seal
// this notice is about is driven by `documentOwnerFenceDropCount` alone and
// can arrive second. Only a sentence written for the seal itself is true in
// both orders.
const DOCUMENT_OWNER_SEAL_NOTICE_SUMMARY =
  "Folia stopped tracking documents and cannot resume until it restarts. " +
  "Any document it is asked to record from now on is refused: that tab " +
  "cannot be saved and will not prompt about unsaved work when it is " +
  "closed - copy any edits out of it by hand, then restart Folia.";
const DOCUMENT_OWNER_SEAL_NOTICE_DETAIL =
  "Folia can no longer prove which document each of its tabs has moved on " +
  "to, so it has stopped writing files and refuses every document it is " +
  "asked to record from now on.\n\nA document Folia could not record still " +
  "appears in a tab, but it cannot be saved or exported, it is not watched " +
  "for changes on disk, and closing it will not prompt about unsaved work. " +
  "Copy any edits you still need out of those tabs by hand, then restart " +
  "Folia. Tabs Folia had already recorded keep working, but nothing in this " +
  "session can be saved. There will be no further message.";

// `show-error` is an established main->renderer notice channel - the renderer
// answers it with an in-app message - and this sender is the approval
// renderer that owns the tab in question, so it is the best-aimed way in.
// It is a transient toast, which is why it is the fallback for a dialog that
// could not be raised and never the notice itself: a terminal, session-long
// condition must not be announced by something that disappears on its own.
function sendDocumentOwnerSealToast(sender) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send("show-error", DOCUMENT_OWNER_SEAL_NOTICE_SUMMARY);
      return true;
    }
  } catch {
    // Nothing else to try; the refusal counter still records it.
  }
  return false;
}

// The reader-facing half of the seal, raised at most ONCE per session by its
// single caller. Returns whether the notice was dispatched: one that could
// not be raised at all leaves the one shot UNSPENT rather than counting
// itself delivered.
function notifyDocumentOwnerSealRefusal(sender) {
  // A frozen shutdown commit is the one place this must not land. The window
  // is mid-close, the reader has already answered for their unsaved work, and
  // a dialog raised now would sit squarely on that critical path. The notice
  // stays owed instead, so a shutdown that is cancelled still gets it at the
  // next refused registration.
  if (shutdownCommitIngressBlocked) return false;
  try {
    const win =
      BrowserWindow.getFocusedWindow() ||
      (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    const options = {
      type: "warning",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      title: "Folia must be restarted",
      message:
        "Folia stopped tracking documents and cannot resume until it restarts.",
      detail: DOCUMENT_OWNER_SEAL_NOTICE_DETAIL,
    };
    const shown = win
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options);
    // A DIALOG CAN ALSO FAIL LATE. `showMessageBox` resolves asynchronously,
    // so a rejection arrives after the one shot has already been spent, and
    // re-opening it here would risk a SECOND dialog for the same condition.
    // The toast is dispatched instead: one notice attempt, still exactly one
    // message, and the reader is not left with silence because the dialog
    // failed a turn later than the `catch` below can see.
    shown.catch(() => {
      sendDocumentOwnerSealToast(sender);
    });
    return true;
  } catch {
    return sendDocumentOwnerSealToast(sender);
  }
}

function noteDocumentOwnerSealRefusal(sender) {
  documentOwnerSealRegistrationRefusalCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    documentOwnerSealRegistrationRefusalCount + 1,
  );
  if (documentOwnerSealNoticeShown) return;
  if (!notifyDocumentOwnerSealRefusal(sender)) return;
  documentOwnerSealNoticeShown = true;
  console.error(
    "Refused a background document registration after a stale-owner fence " +
      "was dropped: " + DOCUMENT_OWNER_SEAL_NOTICE_SUMMARY,
  );
}

function noteDeletionEvidenceCapacityRefusal() {
  deletionEvidenceCapacityRefusalCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    deletionEvidenceCapacityRefusalCount + 1,
  );
}

// `stage` is "ingress" when the request is refused before it opens a dialog or
// renders anything, and "before-write" when the latch tripped while a dialog
// or a print was awaiting and the bytes would otherwise go out now.
function deletionEvidenceCapacityWriteRefusal(stage, extra = {}) {
  noteDeletionEvidenceCapacityRefusal();
  return {
    ...extra,
    success: false,
    saveBlocked: saveAuthorityLatchReason,
    saveBlockedStage: stage,
    saveBlockedWhy: deletionEvidenceCapacityLatchWhy,
    error: saveAuthorityLatchWriteError,
  };
}

function rememberPathOnlyDeletion(filePath, pathKey) {
  const spelling = filePathSpellingKey(filePath);
  if (!spelling || !pathKey) return;
  const knownKeys = pathOnlyDeletionEvidence.get(spelling);
  if (
    !knownKeys?.has(pathKey) &&
    !reserveDeletionEvidenceCapacity("path-only-deletion")
  ) {
    return;
  }
  let keys = knownKeys;
  if (!keys) {
    keys = new Set();
    pathOnlyDeletionEvidence.set(spelling, keys);
  }
  if (!keys.has(pathKey)) {
    keys.add(pathKey);
    let spellings = pathOnlyDeletionByPathKey.get(pathKey);
    if (!spellings) {
      spellings = new Set();
      pathOnlyDeletionByPathKey.set(pathKey, spellings);
    }
    spellings.add(spelling);
    noteDeletionEvidenceMutation();
  }
  deletedDocuments.add(pathKey);
  addDocumentUnadoptedChange(pathKey);
  addPathUnadoptedChange(spelling);
}

function retirePathOnlyDeletion(filePath, pathKey) {
  const spelling = filePathSpellingKey(filePath);
  const keys = pathOnlyDeletionEvidence.get(spelling);
  if (!keys || !keys.delete(pathKey)) return false;
  if (keys.size === 0) pathOnlyDeletionEvidence.delete(spelling);
  const spellings = pathOnlyDeletionByPathKey.get(pathKey);
  spellings.delete(spelling);
  if (spellings.size === 0) pathOnlyDeletionByPathKey.delete(pathKey);
  noteDeletionEvidenceMutation();
  return true;
}

function orphanedDeletionForSpelling(filePath, owner = null) {
  const records = deletionTombstonesBySpelling.get(
    filePathSpellingKey(filePath),
  );
  return !!records && Array.from(records).some(
    (record) =>
      record.owner.pageSession !== approvalRendererPageSession ||
      record.owner.rendererGeneration !== approvalRendererGeneration ||
      (!!owner &&
        record.owner.pageSession === owner.pageSession &&
        record.owner.rendererGeneration === owner.rendererGeneration &&
        record.owner.tabId === owner.tabId &&
        record.owner.documentGeneration !== owner.documentGeneration),
  );
}

function noteDeletionEvidenceMutation() {
  deletionEvidenceRevision =
    deletionEvidenceRevision === Number.MAX_SAFE_INTEGER
      ? 1
      : deletionEvidenceRevision + 1;
}

function addUnadoptedMarker(markerSet, referenceMap, key, overflow = false) {
  if (!key) return false;
  let reference = referenceMap.get(key);
  if (overflow) {
    if (!reference) {
      reference = {
        count: 0,
        independent: markerSet.has(key),
      };
      referenceMap.set(key, reference);
    }
    reference.count += 1;
  } else if (reference) {
    reference.independent = true;
  }
  markerSet.add(key);
  return true;
}

function deleteUnadoptedMarker(markerSet, referenceMap, key) {
  if (!key) return false;
  const deleted = markerSet.delete(key);
  const reference = referenceMap.get(key);
  if (reference) {
    reference.independent = false;
    if (reference.count > 0) markerSet.add(key);
  }
  return deleted;
}

function addDocumentUnadoptedChange(key, { overflow = false } = {}) {
  return addUnadoptedMarker(
    documentsWithUnadoptedChanges,
    deletionOverflowDocumentMarkerRefs,
    key,
    overflow,
  );
}

function deleteDocumentUnadoptedChange(key) {
  return deleteUnadoptedMarker(
    documentsWithUnadoptedChanges,
    deletionOverflowDocumentMarkerRefs,
    key,
  );
}

function addPathUnadoptedChange(spelling, { overflow = false } = {}) {
  return addUnadoptedMarker(
    pathsWithUnadoptedChanges,
    deletionOverflowPathMarkerRefs,
    spelling,
    overflow,
  );
}

function deletePathUnadoptedChange(spelling) {
  return deleteUnadoptedMarker(
    pathsWithUnadoptedChanges,
    deletionOverflowPathMarkerRefs,
    spelling,
  );
}

function deletionOverflowEvidenceKey(filePath, owner = null) {
  const ownerKey = documentOwnerKey(owner);
  if (ownerKey) return `owner\0${ownerKey}`;
  const spelling = filePathSpellingKey(filePath);
  return spelling ? `path\0${spelling}` : null;
}

function releaseDeletionOverflowMarker(
  markerSet,
  referenceMap,
  key,
  stillCovered,
) {
  const reference = referenceMap.get(key);
  if (!reference) return;
  reference.count = Math.max(0, reference.count - 1);
  if (reference.count > 0) return;
  referenceMap.delete(key);
  if (!reference.independent && !stillCovered) markerSet.delete(key);
}

function releaseDeletionOverflowEvidence(key) {
  const record = deletionOverflowEvidence.get(key);
  if (!record || !deletionOverflowEvidence.delete(key)) return null;
  releaseDeletionOverflowMarker(
    documentsWithUnadoptedChanges,
    deletionOverflowDocumentMarkerRefs,
    record.pathKey,
    deletedDocuments.has(record.pathKey) ||
      deletionTombstonesByPathKey.has(record.pathKey),
  );
  releaseDeletionOverflowMarker(
    pathsWithUnadoptedChanges,
    deletionOverflowPathMarkerRefs,
    record.spelling,
    deletionTombstonesBySpelling.has(record.spelling) ||
      deletionTombstonesByPathKey.has(record.pathKey),
  );
  return record;
}

function rememberDeletionOverflowEvidence(filePath, owner = null) {
  const key = deletionOverflowEvidenceKey(filePath, owner);
  const spelling = filePathSpellingKey(filePath);
  const pathKey = canonicalFileKey(filePath);
  if (!key || !spelling || !pathKey) return false;
  // Replacing a record already held under this key costs no new unit; only a
  // key this process has never retained does.
  if (
    !deletionOverflowEvidence.has(key) &&
    !reserveDeletionEvidenceCapacity("deletion-overflow-evidence")
  ) {
    return false;
  }
  releaseDeletionOverflowEvidence(key);
  deletionOverflowEvidence.set(
    key,
    Object.freeze({
      owner,
      ownerKey: documentOwnerKey(owner),
      spelling,
      pathKey,
    }),
  );
  addDocumentUnadoptedChange(pathKey, { overflow: true });
  addPathUnadoptedChange(spelling, { overflow: true });
  deletionEvidenceOverflowCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    deletionEvidenceOverflowCount + 1,
  );
  noteDeletionEvidenceMutation();
  return true;
}

function hasDeletionOverflowEvidence(filePath, owner = null) {
  const identity = normaliseDocumentIdentity(owner, filePath);
  const ownerKey = documentOwnerKey(identity);
  const spelling = filePathSpellingKey(filePath);
  const pathKey = canonicalFileKey(filePath);
  return Array.from(deletionOverflowEvidence.values()).some(
    (record) =>
      (!!ownerKey && record.ownerKey === ownerKey) ||
      (!record.ownerKey &&
        ((!!spelling && record.spelling === spelling) ||
          (!!pathKey && record.pathKey === pathKey))),
  );
}

function clearDeletionDeliveryAttempt(record) {
  if (!record) return;
  if (record.ackTimeout) clearTimeout(record.ackTimeout);
  if (record.retryTimeout) clearTimeout(record.retryTimeout);
  record.ackTimeout = null;
  record.retryTimeout = null;
  record.retryDelayMs = 0;
  record.inFlight = false;
}

function releaseDeletionDelivery(record) {
  if (!record) return false;
  clearDeletionDeliveryAttempt(record);
  if (!deletionDeliveries.delete(record.key)) return false;
  return true;
}

function compactDeletionDeliveryCapacity() {
  while (deletionDeliveries.size >= MAX_DELETION_DELIVERIES) {
    let candidate = null;
    for (const record of deletionDeliveries.values()) {
      if (
        record.consumed ||
        !sameDocumentOwner(record.owner, watchedOwner)
      ) {
        candidate = record;
        break;
      }
    }
    if (!candidate) {
      candidate = deletionDeliveries.values().next().value || null;
    }
    if (!candidate) break;
    releaseDeletionDelivery(candidate);
    candidate.parked = true;
    candidate.compacted = true;
    candidate.sends = 0;
    candidate.retryDelayMs = 0;
    candidate.backoffMs = DELETION_DELIVERY_RETRY_DELAY_MS;
    candidate.consecutiveSendFailures = 0;
    candidate.lastSendError = null;
    candidate.physicalVersion = null;
    candidate.recreationVersion = null;
    deletionEvidenceOverflowCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      deletionEvidenceOverflowCount + 1,
    );
  }
}

function activateDeletionDelivery(record) {
  if (!record || record.consumed) return false;
  if (!deletionDeliveries.has(record.key)) {
    compactDeletionDeliveryCapacity();
    deletionDeliveries.set(record.key, record);
  }
  record.compacted = false;
  return true;
}

function retireDeletionOwnerEvidence(record) {
  if (!record) return false;
  let retired = false;
  if (removeDeletionTombstone(record)) retired = true;
  if (releaseDeletionDelivery(record)) retired = true;
  const overflowKey = deletionOverflowEvidenceKey(record.path, record.owner);
  if (overflowKey && releaseDeletionOverflowEvidence(overflowKey)) {
    retired = true;
  }
  const samePhysicalEvidence =
    deletionTombstonesByPathKey.has(record.pathKey);
  const samePathEvidence = deletionTombstonesBySpelling.has(record.spelling);
  const samePhysicalOverflow = Array.from(
    deletionOverflowEvidence.values(),
  ).some((candidate) => candidate.pathKey === record.pathKey);
  const samePathOverflow = Array.from(
    deletionOverflowEvidence.values(),
  ).some((candidate) => candidate.spelling === record.spelling);
  if (
    !samePhysicalEvidence &&
    !samePhysicalOverflow &&
    !pathOnlyDeletionByPathKey.has(record.pathKey)
  ) {
    deletedDocuments.delete(record.pathKey);
    deleteDocumentUnadoptedChange(record.pathKey);
  }
  if (
    !samePathEvidence &&
    !samePathOverflow &&
    !pathOnlyDeletionEvidence.has(record.spelling)
  ) {
    deletePathUnadoptedChange(record.spelling);
  }
  if (retired) noteDeletionEvidenceMutation();
  return retired;
}

// An episode is over only when disk content is explicitly adopted, or when the
// owning document explicitly adopts a replacement from disk.
// The evidence and the delivery are released together - keeping one without the
// other would either warn about a deletion that has been dealt with, or leave a
// conflict nothing can clear.
function clearDeletionEvidenceForAdoption(
  filePath,
  owner = null,
  {
    allowPathReplacement = false,
    priorPathKey = null,
    retireOrphanedOwners = false,
    retirePathOnlyKey = null,
    allowedOverflowKeys = null,
    evidencePathKey = null,
  } = {},
) {
  const spelling = filePathSpellingKey(filePath);
  const key = spelling &&
    (filePathAliases.get(spelling) ||
      resolveCanonicalFileKey(filePath) ||
      spelling);
  if (!spelling || !key) return false;
  const adoptedOwner = owner
    ? typeof owner.spelling === "string" && owner.spelling === spelling
      ? owner
      : normaliseDocumentIdentity(owner, filePath, {
          useCurrentPathIdentity: allowPathReplacement,
        })
    : null;
  if (owner && !adoptedOwner) return false;
  const adoptedOwnerKey = documentOwnerKey(adoptedOwner);
  const pathOnlyKeys =
    retirePathOnlyKey && adoptedOwner
      ? [retirePathOnlyKey]
      : [];
  const affectedKeys = new Set(
    [key, priorPathKey].filter(
      (candidate) =>
        typeof candidate === "string" && candidate.length > 0,
    ),
  );
  let cleared = false;
  const relatedTombstones = new Set([
    ...(deletionTombstonesBySpelling.get(spelling) || []),
    ...(deletionTombstonesByPathKey.get(key) || []),
  ]);
  for (const record of relatedTombstones) {
    if (evidencePathKey && record.pathKey !== evidencePathKey) {
      continue;
    }
    const orphanedOwner =
      retireOrphanedOwners &&
      record.spelling === spelling &&
      (record.owner.pageSession !== approvalRendererPageSession ||
        record.owner.rendererGeneration !== approvalRendererGeneration ||
        (adoptedOwner &&
          record.owner.tabId === adoptedOwner.tabId &&
          record.owner.documentGeneration !==
            adoptedOwner.documentGeneration));
    if (
      adoptedOwnerKey &&
      !allowPathReplacement &&
      record.key !== adoptedOwnerKey &&
      !orphanedOwner
    ) {
      continue;
    }
    if (
      adoptedOwner &&
      allowPathReplacement &&
      !orphanedOwner &&
      !sameDocumentGeneration(record.owner, adoptedOwner)
    ) {
      continue;
    }
    if (record.spelling !== spelling && record.pathKey !== key) continue;
    removeDeletionTombstone(record);
    affectedKeys.add(record.pathKey);
    releaseDeletionDelivery(record);
    cleared = true;
  }
  for (const [overflowKey, record] of deletionOverflowEvidence) {
    if (
      !allowedOverflowKeys ||
      !allowedOverflowKeys.includes(overflowKey) ||
      record.spelling !== spelling
    ) continue;
    if (
      adoptedOwnerKey &&
      !allowPathReplacement &&
      record.ownerKey &&
      record.ownerKey !== adoptedOwnerKey
    ) {
      continue;
    }
    if (
      adoptedOwner &&
      record.owner &&
      allowPathReplacement &&
      !retireOrphanedOwners &&
      !sameDocumentGeneration(record.owner, adoptedOwner)
    ) {
      continue;
    }
    if (record.spelling !== spelling && record.pathKey !== key) continue;
    releaseDeletionOverflowEvidence(overflowKey);
    affectedKeys.add(record.pathKey);
    cleared = true;
  }
  if (
    pathOnlyKeys.length &&
    retirePathOnlyDeletion(filePath, pathOnlyKeys[0])
  ) {
    for (const pathOnlyKey of pathOnlyKeys) affectedKeys.add(pathOnlyKey);
    cleared = true;
  }
  for (const candidateKey of affectedKeys) {
    const stillDeleted = pathKeyHasDeletionEvidence(candidateKey) ||
      Array.from(deletionOverflowEvidence.values()).some(
        (record) => record.pathKey === candidateKey,
      );
    if (stillDeleted) continue;
    if (deletedDocuments.delete(candidateKey)) cleared = true;
    deleteDocumentUnadoptedChange(candidateKey);
    if (
      candidateKey !== key &&
      !Array.from(ownerDocumentBaselines.values()).some(
        (baseline) => baseline.owner.pathKey === candidateKey,
      )
    ) {
      documentModifiedTimes.delete(candidateKey);
      documentVersions.delete(candidateKey);
    }
  }
  if (
    !deletionTombstonesBySpelling.has(spelling) &&
    !pathOnlyDeletionEvidence.has(spelling) &&
    !Array.from(deletionOverflowEvidence.values()).some(
      (record) => record.spelling === spelling,
    )
  ) {
    deletePathUnadoptedChange(spelling);
  }
  if (cleared) noteDeletionEvidenceMutation();
  return cleared;
}

function documentDeletionUnresolved(filePath, owner) {
  const identity = normaliseDocumentIdentity(owner, filePath);
  const ownerKey = documentOwnerKey(identity);
  const pathKey = canonicalFileKey(filePath);
  return (
    (!!ownerKey && documentDeletionTombstones.has(ownerKey)) ||
    pathHasDeletionTombstone(filePath, identity) ||
    orphanedDeletionForSpelling(filePath, identity) ||
    pathOnlyDeletionForSpelling(filePath) ||
    (!ownerKey && !!pathKey && deletedDocuments.has(pathKey)) ||
    hasDeletionOverflowEvidence(filePath, identity)
  );
}

function normaliseFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const resolved = path.normalize(path.resolve(filePath));
  return Object.freeze({
    resolved,
    spelling: process.platform === "win32" ? resolved.toLowerCase() : resolved,
  });
}

function resolveCanonicalFilePath(filePath) {
  const normalised = normaliseFilePath(filePath);
  if (!normalised) return null;
  try {
    return fs.realpathSync.native(normalised.resolved);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      console.error("Error resolving canonical file path:", error);
    }
    return null;
  }
}

function canonicalKeyFromPath(canonical) {
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function resolveCanonicalFileKey(filePath) {
  const canonical = resolveCanonicalFilePath(filePath);
  return canonical ? canonicalKeyFromPath(canonical) : null;
}

// A path spelling keeps the physical target it adopted. Re-resolving and
// overwriting this association on every lookup makes a symlink retarget while
// watching is paused look like a brand-new document with no baseline. The next
// save would then overwrite the new target without reporting the retarget.
function canonicalFileKey(filePath) {
  const normalised = normaliseFilePath(filePath);
  if (!normalised) return null;
  if (filePathAliases.has(normalised.spelling)) {
    return filePathAliases.get(normalised.spelling);
  }
  const key = resolveCanonicalFileKey(normalised.resolved);
  if (key) filePathAliases.set(normalised.spelling, key);
  return key || normalised.spelling;
}

// Only an explicit disk adoption may move a spelling to a new physical target.
function rebindCanonicalFileKey(filePath) {
  const normalised = normaliseFilePath(filePath);
  if (!normalised) return null;
  const key =
    resolveCanonicalFileKey(normalised.resolved) || normalised.spelling;
  filePathAliases.set(normalised.spelling, key);
  if (
    !pathOnlyDeletionEvidence.has(normalised.spelling) &&
    !deletionTombstonesBySpelling.has(normalised.spelling)
  ) {
    deletePathUnadoptedChange(normalised.spelling);
  }
  return key;
}

function filePathSpellingKey(filePath) {
  const normalised = normaliseFilePath(filePath);
  return normalised ? normalised.spelling : null;
}

function sameFilePath(a, b) {
  const left = canonicalFileKey(a);
  const right = canonicalFileKey(b);
  return !!left && left === right;
}

function rememberDocumentModifiedTime(
  filePath,
  modifiedTime,
  { replace = true } = {},
) {
  const key = canonicalFileKey(filePath);
  if (!key || !Number.isFinite(modifiedTime)) return null;
  if (replace || !documentModifiedTimes.has(key)) {
    documentModifiedTimes.set(key, modifiedTime);
  }
  return key;
}

function diskVersionFromStats(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function normaliseDiskVersion(value) {
  if (
    !value ||
    !Number.isFinite(value.dev) ||
    !Number.isFinite(value.ino) ||
    !Number.isFinite(value.size) ||
    !Number.isFinite(value.mtimeMs) ||
    !Number.isFinite(value.ctimeMs)
  ) {
    return null;
  }
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

function rememberDocumentVersion(filePath, stats) {
  const expectedKey = canonicalFileKey(filePath);
  if (!expectedKey || !stats) return null;
  const version = diskVersionFromStats(stats);
  const currentKey = resolveCanonicalFileKey(filePath);
  const currentStats = currentKey
    ? readDocumentStats(filePath, "while recording a document version")
    : null;
  const currentVersion = currentStats
    ? diskVersionFromStats(currentStats)
    : null;
  const diskChangedBeforeAdoption =
    !!currentVersion && diskVersionChanged(version, currentVersion);
  let key = expectedKey;
  if (diskChangedBeforeAdoption && currentKey !== expectedKey) {
    const spelling = filePathSpellingKey(filePath);
    if (spelling) addPathUnadoptedChange(spelling);
  } else if (diskChangedBeforeAdoption) {
    addDocumentUnadoptedChange(expectedKey);
  } else if (currentKey) {
    key = rebindCanonicalFileKey(filePath);
  }
  documentVersions.set(key, version);
  documentModifiedTimes.set(key, version.mtimeMs);
  if (!diskChangedBeforeAdoption && !pathKeyHasDeletionEvidence(key)) {
    deleteDocumentUnadoptedChange(key);
  }
  return key;
}

function rememberVerifiedSaveVersion(filePath, stats, expectedKey, owner = null) {
  if (!stats || !expectedKey) return null;
  const currentKey = resolveCanonicalFileKey(filePath);
  if (!currentKey || currentKey !== expectedKey) {
    const spelling = filePathSpellingKey(filePath);
    if (spelling) addPathUnadoptedChange(spelling);
    return null;
  }
  const key = rebindCanonicalFileKey(filePath);
  if (key !== expectedKey) return null;
  const version = diskVersionFromStats(stats);
  documentVersions.set(key, version);
  documentModifiedTimes.set(key, version.mtimeMs);
  if (!pathKeyHasDeletionEvidence(key)) deleteDocumentUnadoptedChange(key);
  const ownerKey = documentOwnerKey(owner);
  const baseline = ownerDocumentBaselines.get(ownerKey);
  if (baseline) {
    ownerDocumentBaselines.set(ownerKey, Object.freeze({
      owner: baseline.owner,
      version,
      modifiedTime: version.mtimeMs,
    }));
    notifiedExternalVersionsByOwner.delete(ownerKey);
  }
  const admission = owner?.documentRef
    ? admittedDocumentReference(owner.documentRef, owner, filePath) : null;
  if (admission) admission.snapshotVersion = version;
  return key;
}

function markDocumentChangedExternally(filePath) {
  const key = canonicalFileKey(filePath);
  const currentKey = resolveCanonicalFileKey(filePath);
  const spelling = filePathSpellingKey(filePath);
  if (key && currentKey && key !== currentKey) {
    if (spelling) addPathUnadoptedChange(spelling);
  } else if (currentKey || !spelling) {
    if (key) addDocumentUnadoptedChange(key);
  } else {
    // A missing path may later be recreated or retargeted. Keep the conflict
    // attached to the spelling rather than guessing which physical identity
    // the path will name when save is retried.
    addPathUnadoptedChange(spelling);
  }
  return key;
}

function adoptDocumentBaseline(
  filePath,
  modifiedTime,
  operation,
  suppliedVersion = null,
  outcome = null,
  expectedPhysicalKey = null,
  markConflictOnFailure = true,
) {
  if (outcome) outcome.accepted = false;
  if (!Number.isFinite(modifiedTime)) return null;
  const expectedKey = canonicalFileKey(filePath);
  if (!expectedKey) return null;
  const adoptedVersion = normaliseDiskVersion(suppliedVersion);
  if (
    suppliedVersion != null &&
    (!adoptedVersion || adoptedVersion.mtimeMs !== modifiedTime)
  ) {
    console.error("Refusing incoherent supplied disk version:", filePath);
    if (markConflictOnFailure) markDocumentChangedExternally(filePath);
    return null;
  }
  const stats = readDocumentStats(filePath, operation);
  const currentVersion = stats ? diskVersionFromStats(stats) : null;
  const currentKey = resolveCanonicalFileKey(filePath);
  if (
    !currentKey ||
    !currentVersion ||
    (expectedPhysicalKey && currentKey !== expectedPhysicalKey) ||
    currentVersion.mtimeMs !== modifiedTime ||
    (adoptedVersion && diskVersionChanged(adoptedVersion, currentVersion)) ||
    (!adoptedVersion && currentKey !== expectedKey)
  ) {
    if (markConflictOnFailure) markDocumentChangedExternally(filePath);
    return null;
  }
  const verifiedStats = readDocumentStats(
    filePath,
    "while verifying disk adoption",
  );
  const verifiedKey = resolveCanonicalFileKey(filePath);
  if (
    !verifiedStats ||
    verifiedKey !== currentKey ||
    (expectedPhysicalKey && verifiedKey !== expectedPhysicalKey) ||
    diskVersionChanged(currentVersion, diskVersionFromStats(verifiedStats))
  ) {
    if (markConflictOnFailure) markDocumentChangedExternally(filePath);
    return null;
  }
  const finalStats = readDocumentStats(
    filePath,
    "while finalizing disk adoption",
  );
  if (
    resolveCanonicalFileKey(filePath) !== verifiedKey ||
    !finalStats ||
    diskVersionChanged(currentVersion, diskVersionFromStats(finalStats))
  ) {
    if (markConflictOnFailure) markDocumentChangedExternally(filePath);
    return null;
  }
  const spelling = filePathSpellingKey(filePath);
  filePathAliases.set(spelling, verifiedKey);
  if (
    !pathOnlyDeletionEvidence.has(spelling) &&
    !deletionTombstonesBySpelling.has(spelling)
  ) {
    deletePathUnadoptedChange(spelling);
  }
  const key = verifiedKey;
  documentVersions.set(key, currentVersion);
  documentModifiedTimes.set(key, modifiedTime);
  if (!pathKeyHasDeletionEvidence(key)) deleteDocumentUnadoptedChange(key);
  // An mtime-only assertion can establish an ordinary watcher baseline, but
  // cannot retire a deletion or prove an externally replaced file's bytes.
  if (outcome) outcome.accepted = !!adoptedVersion;
  return key;
}

function diskVersionChanged(left, right) {
  // Windows ctime can drift without changed bytes. Ignoring it also misses
  // same-size edits with restored mtime (docs/PLANNED-WORK.md: ctime-byte-witness).
  return (
    !Number.isFinite(left.ctimeMs) ||
    !Number.isFinite(right.ctimeMs) ||
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.size !== right.size ||
    left.mtimeMs !== right.mtimeMs
  );
}

function saveCompletionOwnershipOrSizeChanged(written, observed) {
  return (
    written.dev !== observed.dev ||
    written.ino !== observed.ino ||
    written.size !== observed.size
  );
}

function readDocumentStats(filePath, operation) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    console.error(`Error getting file stats ${operation}:`, error);
    return null;
  }
}

function readDocumentModifiedTime(filePath, operation) {
  const stats = readDocumentStats(filePath, operation);
  return stats ? stats.mtimeMs : null;
}

const MAX_STABLE_FILE_READ_ATTEMPTS = 3;

// Permission survives closing a Save owner; a live reference does not survive
// its frame. The manifest contains entry IDs, never live capabilities.
const documentAdmissions = new Map();
const admittedOwnerTabs = new Map();
const privateSessionBootstraps = new WeakMap();
const unavailableSessionEntries = new Set();
const protectedSessionEntries = new Set();
const MAX_SESSION_DOCUMENTS = 512;
const nativeDocumentOpenTickets = new Map();
let documentSessionManifest = null;
let documentSessionFailure = null;
let retiredAdmissionTabFloor = 0;
let retiredAdmissionScope = null;
let pendingLiveSessionWrite = null;
let liveSessionWriteRunning = false;

function deliverNativeDocumentIntent(target, filePath, provenance = "native-open") {
  if (!target || target.isDestroyed()) return false;
  for (const [ticket, record] of nativeDocumentOpenTickets) {
    if (record.sender.isDestroyed() || record.generation !== approvalRendererGeneration ||
        Date.now() - record.createdAt > 60000) nativeDocumentOpenTickets.delete(ticket);
  }
  if (nativeDocumentOpenTickets.size >= MAX_SESSION_DOCUMENTS) return false;
  const ticket = crypto.randomBytes(32).toString("hex");
  nativeDocumentOpenTickets.set(ticket, {
    sender: target, frameTreeNodeId: target.mainFrame.frameTreeNodeId,
    generation: approvalRendererGeneration, filePath, provenance,
    createdAt: Date.now(),
    pageSession: approvalRendererPageSession,
    delivered: approvalRendererState === "ready",
  });
  if (approvalRendererState === "ready") {
    target.send("external-file-open-request", { filePath, documentOpenTicket: ticket });
  }
  return true;
}

function takeNativeDocumentTicket(event, ticket) {
  if (!isApprovalSender(event) || approvalRendererState !== "ready") return null;
  const record = nativeDocumentOpenTickets.get(ticket);
  if (!record || record.sender !== event.sender ||
      record.frameTreeNodeId !== event.senderFrame.frameTreeNodeId ||
      record.generation !== approvalRendererGeneration ||
      (record.pageSession !== null && record.pageSession !== approvalRendererPageSession) ||
      Date.now() - record.createdAt > 60000) return null;
  nativeDocumentOpenTickets.delete(ticket);
  return record;
}

ipcMain.handle("accept-native-document-ticket", (event, data) => {
  const record = takeNativeDocumentTicket(event, data?.ticket);
  if (!record) return false;
  openFile(record.filePath, {
    sender: event.sender, rendererGeneration: record.generation,
    provenance: record.provenance,
  });
  return true;
});

ipcMain.handle("cancel-native-document-ticket", (event, data) =>
  !!takeNativeDocumentTicket(event, data?.ticket));

ipcMain.handle("open-admitted-readme", (event) => {
  if (!isApprovalSender(event) || approvalRendererState !== "ready") return false;
  openFile(getReadmePath(), {
    sender: event.sender, rendererGeneration: approvalRendererGeneration,
    provenance: "native-open",
  });
  return true;
});

// This is the existing local-link policy, applied only to private trusted
// gestures. Native All Files selection deliberately has no extension policy.
const TRUSTED_LINK_EXECUTABLE_EXTS = new Set([
  ".exe", ".msi", ".msix", ".msixbundle", ".appx", ".appxbundle", ".bat",
  ".cmd", ".com", ".scr", ".pif", ".hta", ".cpl", ".lnk", ".url", ".reg",
  ".msc", ".msp", ".gadget", ".inf", ".dll", ".ocx", ".sys", ".chm", ".xll",
  ".ws", ".sct", ".jnlp", ".website", ".scf",
  ".iso", ".img", ".vhd", ".vhdx", ".wim", ".diagcab",
  ".settingcontent-ms", ".library-ms", ".search-ms", ".searchconnector-ms",
  ".theme", ".themepack", ".deskthemepack",
  ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".wsf", ".wsh", ".js", ".jse",
  ".mjs", ".cjs", ".py", ".pyw", ".rb", ".pl", ".php", ".jar",
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".run", ".bin", ".out",
  ".command", ".app", ".desktop", ".appimage", ".deb", ".rpm", ".pkg", ".dmg",
  ".terminal", ".workflow",
  ".docm", ".xlsm", ".pptm", ".dotm", ".xltm", ".potm", ".xlam", ".ppam",
]);
const TRUSTED_LINK_SAFE_EXTS = new Set([
  ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".xml", ".yml", ".yaml",
  ".ini", ".toml", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif",
  ".tiff", ".ico", ".avif", ".heic", ".mp3", ".wav", ".flac", ".ogg", ".m4a",
  ".mp4", ".webm", ".mov", ".mkv",
]);
const TRUSTED_LINK_MARKDOWN_EXTS = new Set([".md", ".markdown", ".mmd", ".mermaid", ".ow"]);
const TRUSTED_DROP_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mmd", ".mermaid"]);
const isTrustedNetworkPath = value => /^(\\\\|\/\/)/.test(value);

ipcMain.handle("private-trusted-document-gesture", async (event, data) => {
  const bootstrap = privateSessionBootstraps.get(event.sender);
  if (!isApprovalSender(event) || approvalRendererState !== "ready" ||
      !bootstrap?.used || data?.nonce !== bootstrap.nonce ||
      event.senderFrame.url !== pathToFileURL(path.join(__dirname, "index.html")).href) {
    return false;
  }
  try {
    if (data.kind === "drop") {
      if (typeof data.filePath !== "string" || data.filePath.includes("\0") ||
          isTrustedNetworkPath(data.filePath) || !path.isAbsolute(data.filePath)) return false;
      if (!TRUSTED_DROP_EXTS.has(path.extname(data.filePath).toLowerCase())) {
        throw new Error(`Dropped file type is not supported: ${path.basename(data.filePath)}`);
      }
      return deliverNativeDocumentIntent(event.sender, data.filePath);
    }
    const admission = admittedDocumentReference(data.documentRef, watchedOwner,
      watchedFilePath);
    if (data.kind !== "link" || !admission || typeof data.href !== "string" ||
        !data.href || data.href.length > 65536 || data.href.includes("\0") ||
        data.href.startsWith("#")) return false;
    const href = data.href;
    if (isTrustedNetworkPath(href)) throw new Error("Network file paths are blocked");
    if (/^https?:\/\//i.test(href)) {
      await shell.openExternal(href);
      return true;
    }
    let logicalPath;
    if (path.isAbsolute(href) && !/^file:/i.test(href)) {
      logicalPath = path.normalize(href);
    } else {
      const url = new URL(href, admission.descriptor.documentUrl);
      if (url.protocol !== "file:" || url.hostname) {
        throw new Error("Network or unsupported file links are blocked");
      }
      logicalPath = fileURLToPath(url);
    }
    if (isTrustedNetworkPath(logicalPath)) throw new Error("Network file paths are blocked");
    const readTarget = fs.realpathSync.native(logicalPath);
    if (isTrustedNetworkPath(readTarget)) throw new Error("Network file paths are blocked");
    const stats = fs.statSync(readTarget);
    const ext = path.extname(readTarget).toLowerCase();
    if (TRUSTED_LINK_EXECUTABLE_EXTS.has(ext) ||
        (!stats.isDirectory() && !ext && process.platform !== "win32" &&
          (stats.mode & 0o111) !== 0)) {
      throw new Error(`Executable links are blocked: ${path.basename(readTarget)}`);
    }
    if (TRUSTED_LINK_MARKDOWN_EXTS.has(ext)) {
      return deliverNativeDocumentIntent(event.sender, logicalPath);
    }
    if (!stats.isDirectory() && !TRUSTED_LINK_SAFE_EXTS.has(ext)) {
      const decision = await dialog.showMessageBox(mainWindow, {
        type: "question", title: "Open external file",
        message: `Open "${path.basename(readTarget)}" with its system application?`,
        buttons: ["Cancel", "Open"], defaultId: 0, cancelId: 0,
      });
      if (decision.response !== 1 || !isApprovalSender(event) ||
          !admittedDocumentReference(data.documentRef, watchedOwner, watchedFilePath)) {
        return false;
      }
    }
    const error = await shell.openPath(readTarget);
    if (error) throw new Error(error);
    return true;
  } catch (error) {
    event.sender.send("show-error", error.message);
    return false;
  }
});

function documentSessionFiles() {
  const profile = app.getPath("userData");
  return {
    manifest: path.join(profile, "document-session.json"),
    marker: path.join(profile, "document-session-import.json"),
  };
}

function writeDocumentSessionImportMarker(status, error = null, exclusive = false) {
  const fd = fs.openSync(documentSessionFiles().marker, exclusive ? "wx" : "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({
      version: 1, status, ...(error === null ? {} : { error }),
    }), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeDocumentSession() {
  if (!documentSessionManifest || documentSessionFailure) {
    throw new Error(documentSessionFailure || "Document session is unavailable");
  }
  const file = documentSessionFiles().manifest;
  const next = `${file}.${crypto.randomBytes(16).toString("hex")}.next`;
  let fd;
  try {
    fd = fs.openSync(next, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(documentSessionManifest), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(next, file);
  } finally {
    if (fd !== null && fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(next)) fs.unlinkSync(next);
  }
}

function persistLiveDocumentSession() {
  const text = JSON.stringify(documentSessionManifest);
  const promise = new Promise((resolve, reject) => {
    if (pendingLiveSessionWrite) {
      pendingLiveSessionWrite.text = text;
      pendingLiveSessionWrite.waiters.push({ resolve, reject });
    } else {
      pendingLiveSessionWrite = { text, waiters: [{ resolve, reject }] };
    }
  });
  if (!liveSessionWriteRunning) {
    liveSessionWriteRunning = true;
    Promise.resolve().then(async () => {
      while (pendingLiveSessionWrite) {
        const write = pendingLiveSessionWrite;
        pendingLiveSessionWrite = null;
        const file = documentSessionFiles().manifest;
        const next = `${file}.${crypto.randomBytes(16).toString("hex")}.next`;
        let handle;
        try {
          handle = await fs.promises.open(next, "wx", 0o600);
          await handle.writeFile(write.text, "utf8");
          await handle.sync();
          await handle.close();
          handle = null;
          await fs.promises.rename(next, file);
          write.waiters.forEach(waiter => waiter.resolve(true));
        } catch (error) {
          write.waiters.forEach(waiter => waiter.reject(error));
        } finally {
          if (handle) await handle.close().catch(() => {});
          await fs.promises.unlink(next).catch(error => {
            if (error.code !== "ENOENT") console.error("Session write cleanup failed:", error);
          });
        }
      }
      liveSessionWriteRunning = false;
    }).catch(error => {
      liveSessionWriteRunning = false;
      console.error("Session persistence worker failed:", error);
    });
  }
  return promise;
}

function validSessionEntry(entry) {
  return entry && /^[a-f0-9]{32}$/.test(entry.id) &&
    typeof entry.filePath === "string" && !entry.filePath.includes("\0") &&
    path.isAbsolute(entry.filePath) &&
    typeof entry.provenance === "string" &&
    ["native-open", "native-dialog", "legacy-profile"].includes(entry.provenance) &&
    Number.isFinite(entry.scrollPosition) && entry.scrollPosition >= 0 &&
    validSessionAnchor(entry.anchor);
}

function validSessionAnchor(anchor) {
  return anchor === null || (anchor && typeof anchor === "object" &&
    !Array.isArray(anchor) && Number.isFinite(anchor.scrollTop) &&
    anchor.scrollTop >= 0 &&
    (anchor.text === null || (typeof anchor.text === "string" &&
      anchor.text.length <= 1024 * 1024)) &&
    Number.isSafeInteger(anchor.ordinal) && anchor.ordinal >= 0 &&
    Number.isFinite(anchor.delta));
}

function copySessionAnchor(anchor) {
  return anchor === null ? null : {
    scrollTop: anchor.scrollTop, text: anchor.text,
    ordinal: anchor.ordinal, delta: anchor.delta,
  };
}

function bootstrapDocumentSession(legacy) {
  if (documentSessionManifest || documentSessionFailure) return;
  const files = documentSessionFiles();
  let importAttemptStarted = false;
  try {
    if (fs.existsSync(files.manifest)) {
      if (!fs.existsSync(files.marker)) {
        writeDocumentSessionImportMarker("attempted", null, true);
        importAttemptStarted = true;
      }
      const saved = JSON.parse(fs.readFileSync(files.manifest, "utf8"));
      if (saved?.version !== 1 || saved.importStatus !== "completed" ||
          !Array.isArray(saved.entries) || saved.entries.length > MAX_SESSION_DOCUMENTS ||
          !saved.entries.every(validSessionEntry) ||
          new Set(saved.entries.map(entry => entry.id)).size !== saved.entries.length ||
          !Array.isArray(saved.approvedEntries) ||
          saved.approvedEntries.length > MAX_SESSION_DOCUMENTS ||
          !saved.approvedEntries.every(validSessionEntry) ||
          new Set(saved.approvedEntries.map(entry => entry.id)).size !== saved.approvedEntries.length ||
          !saved.entries.every(entry => saved.approvedEntries.some(approved =>
            approved.id === entry.id && approved.filePath === entry.filePath &&
            approved.provenance === entry.provenance)) ||
          (saved.activeEntryId !== null &&
            !saved.entries.some(entry => entry.id === saved.activeEntryId))) {
        throw new Error("Invalid main-owned document session");
      }
      if (importAttemptStarted) writeDocumentSessionImportMarker("completed");
      documentSessionManifest = saved;
      for (const entry of saved.entries) protectedSessionEntries.add(entry.id);
      return;
    }
    if (fs.existsSync(files.marker)) {
      throw new Error("Document session import was already attempted; its state is missing");
    }
    // Durable before parsing: a corrupt or interrupted import must never
    // reinterpret later page-written localStorage as historical permission.
    writeDocumentSessionImportMarker("attempted", null, true);
    importAttemptStarted = true;
    if (legacy.captureError) throw new Error(`Legacy session capture failed: ${legacy.captureError}`);
    const source = legacy.openTabs === null ? [] : JSON.parse(legacy.openTabs);
    if (!Array.isArray(source) || source.length > MAX_SESSION_DOCUMENTS ||
        !source.every(entry => entry && typeof entry.filePath === "string" &&
          !entry.filePath.includes("\0") && path.isAbsolute(entry.filePath) &&
          (entry.scrollPosition === undefined ||
            (Number.isFinite(entry.scrollPosition) && entry.scrollPosition >= 0)) &&
          validSessionAnchor(entry.anchor == null ? null : entry.anchor))) {
      throw new Error("Legacy document session is corrupt");
    }
    const entries = source.map(entry => ({
      id: crypto.randomBytes(16).toString("hex"),
      filePath: path.normalize(entry.filePath),
      provenance: "legacy-profile",
      scrollPosition: entry.scrollPosition || 0,
      anchor: copySessionAnchor(entry.anchor || null),
    }));
    documentSessionManifest = {
      version: 1, importStatus: "completed", entries, approvedEntries: entries.slice(),
      activeEntryId: entries.find(entry =>
        filePathSpellingKey(entry.filePath) ===
          filePathSpellingKey(legacy.activeTabPath))?.id || null,
    };
    writeDocumentSession();
    writeDocumentSessionImportMarker("completed");
    for (const entry of entries) protectedSessionEntries.add(entry.id);
  } catch (error) {
    documentSessionManifest = null;
    documentSessionFailure = error.message;
    try {
      if (importAttemptStarted) {
        writeDocumentSessionImportMarker("failed-corrupt", error.message);
      }
    } catch (markerError) {
      console.error("Could not persist the failed session import marker:", markerError);
    }
    console.error("Could not restore the main-owned document session:", error);
  }
}

ipcMain.on("bootstrap-legacy-document-session", (event, data) => {
  // sendSync replies immediately, so an initial default would mask the verdict.
  const bootstrap = privateSessionBootstraps.get(event.sender);
  if (!bootstrap || bootstrap.used || data?.nonce !== bootstrap.nonce ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== pathToFileURL(path.join(__dirname, "index.html")).href) {
    event.returnValue = false;
    return;
  }
  bootstrap.used = true;
  if (![data.openTabs, data.activeTabPath].every(value =>
        value === null || (typeof value === "string" && value.length <= 1024 * 1024)) ||
      (data.captureError !== undefined &&
        (typeof data.captureError !== "string" || data.captureError.length > 1024))) {
    bootstrapDocumentSession({
      openTabs: null, activeTabPath: null,
      captureError: "Legacy document session is corrupt or exceeds capture limits",
    });
    event.returnValue = false;
    return;
  }
  bootstrapDocumentSession(data);
  event.returnValue = true;
});

function admissionScopeIsCurrent(record) {
  if (!record || record.sender.isDestroyed() ||
      !mainWindow || mainWindow.webContents !== record.sender ||
      record.rendererGeneration !== approvalRendererGeneration) return false;
  const frame = record.sender.mainFrame;
  return frame && !frame.isDestroyed() &&
    frame.frameTreeNodeId === record.frameTreeNodeId &&
    (record.pageSession === null ||
      record.pageSession === approvalRendererPageSession);
}

function admissionIsCurrent(record) {
  return !record?.retired && admissionScopeIsCurrent(record);
}

function pruneAdmissionScopeFences() {
  const scope = `${approvalRendererPageSession}\0${approvalRendererGeneration}`;
  if (retiredAdmissionScope !== scope) {
    retiredAdmissionScope = scope;
    retiredAdmissionTabFloor = 0;
  }
  // Retirement must not let the same page remove its ref and regain the
  // provisional path route. Only a dead frame/session can release this fence.
  for (const [key, record] of admittedOwnerTabs) {
    if (!admissionScopeIsCurrent(record)) admittedOwnerTabs.delete(key);
    else if (record.retired) {
      retiredAdmissionTabFloor = Math.max(retiredAdmissionTabFloor, record.tabId);
      admittedOwnerTabs.delete(key);
    }
  }
}

function admittedDocumentReference(ref, owner = null, filePath = null, forAdoption = false) {
  const record = typeof ref === "string" ? documentAdmissions.get(ref) : null;
  if (!admissionIsCurrent(record) || approvalRendererState !== "ready") return null;
  if (record.pageSession === null) record.pageSession = approvalRendererPageSession;
  const committedReplacement = owner && !forAdoption &&
    (record.tabId === null || record.tabId === owner.tabId) &&
    record.documentGeneration !== owner.documentGeneration &&
    Array.from(committedDiskAdoptions.values()).some(
    grant => grant.proposedOwner.documentRef === ref &&
      grant.proposedOwner.tabId === owner.tabId &&
      grant.proposedOwner.documentGeneration === owner.documentGeneration &&
      grant.proposedOwner.pathKey === owner.pathKey &&
      grant.pageSession === record.pageSession &&
      grant.rendererGeneration === record.rendererGeneration &&
      Date.now() - grant.acceptedAt <= DISK_ADOPTION_CAPABILITY_MS,
  );
  const fence = owner && admittedOwnerTabs.get([
    owner.pageSession, owner.rendererGeneration, owner.tabId,
  ].join("\0"));
  if (fence && fence !== record &&
      !(record.tabId === null && (forAdoption || committedReplacement))) return null;
  if (owner && (owner.pageSession !== record.pageSession ||
      owner.rendererGeneration !== record.rendererGeneration ||
      (record.tabId !== null && (record.tabId !== owner.tabId ||
        (!forAdoption && !committedReplacement &&
          record.documentGeneration !== owner.documentGeneration))))) {
    return null;
  }
  if (filePath && normaliseFilePath(filePath)?.resolved !== record.descriptor.logicalPath) {
    return null;
  }
  return record;
}

function sweepRevokedAdmissionOwners() {
  for (const [key, owner] of knownDocumentOwners) {
    if (owner.documentRef &&
        !admissionIsCurrent(documentAdmissions.get(owner.documentRef)) &&
        documentOwnerCanBeForgotten(key)) forgetDocumentOwnerAliases(key);
  }
}

function pinnedAdoptionAdmissionReferences() {
  const pinnedReferences = new Set();
  for (const grants of [pendingDiskAdoptions, committedDiskAdoptions]) {
    for (const grant of grants.values()) {
      if (grant.proposedOwner?.documentRef) pinnedReferences.add(grant.proposedOwner.documentRef);
      if (grant.currentOwner?.documentRef) pinnedReferences.add(grant.currentOwner.documentRef);
    }
  }
  return pinnedReferences;
}

function issueDocumentAdmission(target, filePath, diskVersion, physical, provenance, entryId = null) {
  pruneAdmissionScopeFences();
  sweepRevokedAdmissionOwners();
  const pinnedReferences = pinnedAdoptionAdmissionReferences();
  for (const [ref, record] of documentAdmissions) {
    if (!admissionIsCurrent(record) ||
        (!pinnedReferences.has(ref) && !record.deliveredRestore && record.tabId === null &&
          (record.openEpoch !== fileOpenDeliveryEpoch ||
          record.descriptor.logicalPath === path.normalize(path.resolve(filePath))))) {
      record.retired = true;
      documentAdmissions.delete(ref);
    }
  }
  const replacingLiveAdmission = documentAdmissions.size === MAX_SESSION_DOCUMENTS &&
    Array.from(documentAdmissions.values()).some(record => record.tabId !== null &&
      record.descriptor.logicalPath === path.normalize(path.resolve(filePath)));
  // A full delivered batch still needs a transient ref to reopen one of its
  // entries. It is not permission to admit another distinct document.
  const replacingDeliveredAdmission = documentAdmissions.size < MAX_SESSION_DOCUMENTS * 2 &&
    Array.from(documentAdmissions.values()).some(record =>
      record.deliveredRestore && record.tabId === null &&
      record.descriptor.logicalPath === path.normalize(path.resolve(filePath)));
  if (documentAdmissions.size >= MAX_SESSION_DOCUMENTS &&
      !replacingLiveAdmission && !replacingDeliveredAdmission) {
    throw new Error("Document admission capacity exhausted");
  }
  const frame = target.mainFrame;
  if (!frame || frame.isDestroyed()) throw new Error("Document frame unavailable");
  let entry = documentSessionManifest?.approvedEntries.find(candidate =>
    entryId ? candidate.id === entryId :
      candidate.filePath === path.normalize(path.resolve(filePath)));
  if (entry && entryId === null && !documentSessionFailure) {
    documentSessionManifest = { ...documentSessionManifest,
      approvedEntries: documentSessionManifest.approvedEntries
        .filter(candidate => candidate.id !== entry.id).concat(entry) };
  }
  if (!entry) {
    entry = {
      id: crypto.randomBytes(16).toString("hex"),
      filePath: path.normalize(path.resolve(filePath)), provenance,
      scrollPosition: 0, anchor: null,
    };
    if (documentSessionManifest && !documentSessionFailure) {
      if (documentSessionManifest.approvedEntries.length >= MAX_SESSION_DOCUMENTS) {
        const retained = new Set([
          ...documentSessionManifest.entries.map(item => item.id),
          ...unavailableSessionEntries, ...protectedSessionEntries,
          ...Array.from(documentAdmissions.values())
            .filter(admissionIsCurrent).map(record => record.descriptor.entryId),
        ]);
        const oldest = documentSessionManifest.approvedEntries.find(item =>
          !retained.has(item.id) && !Array.from(knownDocumentOwners).some(([key, owner]) =>
            owner.spelling === filePathSpellingKey(item.filePath) &&
              !documentOwnerCanBeForgotten(key)));
        if (!oldest) throw new Error("Document session capacity exhausted");
        documentSessionManifest = { ...documentSessionManifest,
          approvedEntries: documentSessionManifest.approvedEntries.filter(item =>
            item.id !== oldest.id) };
      }
      const previous = documentSessionManifest;
      documentSessionManifest = {
        ...previous, entries: previous.entries.concat(entry),
        approvedEntries: previous.approvedEntries.concat(entry),
      };
      persistLiveDocumentSession().catch(error => {
        console.error("Could not persist native document admission:", error);
        if (!target.isDestroyed()) target.send("show-error", "The document session could not be saved.");
      });
    }
  }
  unavailableSessionEntries.delete(entry.id);
  const ref = crypto.randomBytes(32).toString("hex");
  const descriptor = Object.freeze({
    ref, entryId: entry.id, logicalPath: entry.filePath,
    spellingKey: filePathSpellingKey(entry.filePath),
    readTarget: physical.readTarget, pathKey: physical.pathKey,
    documentUrl: pathToFileURL(entry.filePath).href,
  });
  documentAdmissions.set(ref, {
    sender: target, frameTreeNodeId: frame.frameTreeNodeId,
    rendererGeneration: approvalRendererGeneration,
    pageSession: approvalRendererPageSession, descriptor,
    snapshotVersion: diskVersion, tabId: null, documentGeneration: null,
    openEpoch: fileOpenDeliveryEpoch,
    openTicket: crypto.randomBytes(32).toString("hex"),
    ticketUsed: false,
  });
  return Object.freeze({
    ...descriptor, openTicket: documentAdmissions.get(ref).openTicket,
  });
}

ipcMain.handle("restore-document-session", async (event) => {
  if (!isApprovalSender(event) || approvalRendererState !== "ready") return null;
  if (documentSessionFailure || !documentSessionManifest) {
    return { entries: [], activeEntryId: null,
      error: documentSessionFailure || "Private session bootstrap did not complete" };
  }
  // A delivered batch may still be queued in the renderer when another native
  // open advances the epoch. Only a new restore supersedes its unused refs.
  const pinnedReferences = pinnedAdoptionAdmissionReferences();
  for (const [ref, record] of documentAdmissions) {
    if (record.deliveredRestore && record.tabId === null &&
        record.sender === event.sender && !pinnedReferences.has(ref)) {
      record.retired = true;
      documentAdmissions.delete(ref);
    }
  }
  const generation = approvalRendererGeneration;
  const pageSession = approvalRendererPageSession;
  const openEpoch = fileOpenDeliveryEpoch;
  const current = () => isApprovalSender(event) &&
    generation === approvalRendererGeneration &&
    pageSession === approvalRendererPageSession &&
    openEpoch === fileOpenDeliveryEpoch;
  const entries = [];
  const saved = documentSessionManifest.entries.slice();
  for (const entry of saved) protectedSessionEntries.add(entry.id);
  for (const entry of saved) {
    if (!current()) return { entries: [], activeEntryId: null, superseded: true };
    try {
      const snapshot = await markdownSnapshotPromise(entry.filePath);
      if (!current()) return { entries: [], activeEntryId: null, superseded: true };
      const document = issueDocumentAdmission(event.sender, entry.filePath,
        snapshot.diskVersion, snapshot.physical, entry.provenance, entry.id);
      entries.push({ ...entry, ...snapshot, physical: undefined, document });
    } catch (error) {
      if (!current()) return { entries: [], activeEntryId: null, superseded: true };
      unavailableSessionEntries.add(entry.id);
      entries.push({ ...entry, error: error.message });
    }
  }
  for (const entry of entries) {
    const record = documentAdmissions.get(entry.document?.ref);
    if (record) record.deliveredRestore = true;
  }
  return { entries, activeEntryId: documentSessionManifest.activeEntryId };
});

ipcMain.handle("save-document-session-layout", async (event, data) => {
  if (!isApprovalSender(event) || approvalRendererState !== "ready" ||
      documentSessionFailure || !documentSessionManifest ||
      !Array.isArray(data?.entries) || data.entries.length > MAX_SESSION_DOCUMENTS) {
    throw new Error("Document layout refused");
  }
  const known = new Map(documentSessionManifest.approvedEntries.map(entry => [entry.id, entry]));
  const seen = new Set();
  const entries = data.entries.map(layout => {
    const entry = known.get(layout?.id);
    const admission = admittedDocumentReference(layout?.documentRef);
    if (!entry || !admission || admission.sender !== event.sender ||
        admission.descriptor.entryId !== entry.id ||
        seen.has(entry.id) || !Number.isFinite(layout.scrollPosition) ||
        layout.scrollPosition < 0 || !validSessionAnchor(layout.anchor)) {
      throw new Error("Document layout contains an unknown or invalid entry");
    }
    seen.add(entry.id);
    return { ...entry, scrollPosition: layout.scrollPosition,
      anchor: copySessionAnchor(layout.anchor) };
  });
  if (data.activeEntryId !== null && !seen.has(data.activeEntryId)) {
    throw new Error("Document layout has an unknown active entry");
  }
  // An unavailable or overtaken restore must not disappear on the next
  // ordinary save of the visible tab layout.
  documentSessionManifest.entries.forEach((entry, index) => {
    if (!seen.has(entry.id) && (unavailableSessionEntries.has(entry.id) ||
        protectedSessionEntries.has(entry.id))) {
      entries.splice(Math.min(index, entries.length), 0, entry);
    }
  });
  const previous = documentSessionManifest;
  documentSessionManifest = { ...previous, entries, activeEntryId: data.activeEntryId };
  // A live submitted reference proves this restore entry was consumed. Waiting
  // for disk before releasing protection resurrects a tab closed during I/O.
  for (const id of seen) {
    protectedSessionEntries.delete(id);
    unavailableSessionEntries.delete(id);
  }
  await persistLiveDocumentSession();
  if (!isApprovalSender(event)) {
    throw new Error("Document layout sender changed during persistence");
  }
  return true;
});

function sameDiskVersion(before, after) {
  return !diskVersionChanged(before, after);
}

// Pair renderer bytes with the mtime that describes those exact bytes. A
// separate stat after an unconstrained read can observe a later external write
// and make stale content look current, suppressing the watcher notification.
function readMarkdownSnapshot(filePath, callback) {
  markdownSnapshotPromise(filePath).then(snapshot =>
    callback(null, snapshot.content, snapshot.modifiedTime,
      snapshot.diskVersion, snapshot.physical),
  error => callback(error, null, null, null, null));
}

async function markdownSnapshotPromise(filePath, expectedTarget = null) {
  for (let attempt = 0; attempt < MAX_STABLE_FILE_READ_ATTEMPTS; attempt += 1) {
    const readTarget = resolveCanonicalFilePath(filePath);
    if (!readTarget || (expectedTarget && readTarget !== expectedTarget)) {
      throw new Error("Document target moved before reading");
    }
    let handle;
    try {
      handle = await fs.promises.open(filePath, "r");
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("Document target is not a regular file");
      const raw = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      const pathStats = await fs.promises.stat(filePath);
      const targetStats = filePath === readTarget
        ? pathStats : await fs.promises.stat(readTarget);
      if (resolveCanonicalFilePath(filePath) === readTarget &&
          after.isFile() && pathStats.isFile() && targetStats.isFile() &&
          sameDiskVersion(before, after) && sameDiskVersion(before, pathStats) &&
          sameDiskVersion(before, targetStats)) {
        return Object.freeze({
          content: wrapMermaidContent(removeBOM(raw), filePath),
          modifiedTime: after.mtimeMs,
          diskVersion: diskVersionFromStats(after),
          physical: Object.freeze({
            readTarget, pathKey: canonicalKeyFromPath(readTarget),
          }),
        });
      }
    } finally {
      if (handle) await handle.close();
    }
  }
  throw new Error(`File changed repeatedly while being read: ${filePath}`);
}

// ============================================
// WINDOW MANAGEMENT
// ============================================

let testPreloadRegistered = false;

function createWindow() {
  const privateBootstrapNonce = crypto.randomBytes(32).toString("hex");
  const savedState = loadWindowState();
  const testPreloadPreferences =
    !app.isPackaged && process.argv.includes("--folia-test-preload")
      ? { preload: path.join(__dirname, "../test/test-preload.js") }
      : {};
  if (
    testPreloadPreferences.preload &&
    !fs.existsSync(testPreloadPreferences.preload)
  ) {
    fs.writeSync(2, `Missing test preload: ${testPreloadPreferences.preload}\n`);
    process.exit(1);
  }
  if (testPreloadPreferences.preload && !testPreloadRegistered) {
    session.defaultSession.registerPreloadScript({
      type: "frame",
      filePath: testPreloadPreferences.preload,
    });
    testPreloadRegistered = true;
  }

  mainWindow = new BrowserWindow({
    // Restore saved position/size; fall back to 1200×800 centred on first run
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    width: savedState ? savedState.width : 1200,
    height: savedState ? savedState.height : 800,
    show: false, // Don't show until ready
    title: "Folia",
    backgroundColor: "#f5f5f5",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, "main-preload.js"),
      additionalArguments: [
        `--folia-session-bootstrap=${privateBootstrapNonce}`,
        ...(testPreloadPreferences.preload ? ["--folia-test-pdf-restore"] : []),
      ],
      enableRemoteModule: true,
      backgroundThrottling: true, // Throttle background renderers to save CPU
    },
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });
  privateSessionBootstraps.set(mainWindow.webContents, {
    nonce: privateBootstrapNonce, used: false,
  });

  // The main window runs with nodeIntegration: true, so a navigation away from
  // index.html hands `require` to whatever loads next. Nothing in the app ever
  // navigates the top frame - index.html is loaded once by loadFile below,
  // which does not fire will-navigate - so every event reaching this handler
  // is one we did not initiate.
  //
  // Reachable without this: <map><area href>, <meta http-equiv="refresh">,
  // window.open, and location assignment from inside an @@@html frame. The
  // renderer's click handler covers only the link-shaped ones. (SEC-11)
  //
  // <form action="https://…"> USED TO HEAD THAT LIST and no longer belongs on
  // it. The claim was "DOMPurify allows form and action by default", which was
  // true when this comment was written and was closed by the same SEC-11 work:
  // renderer.js SANITIZE_CONFIG now carries FORBID_TAGS: ['form'] and
  // FORBID_ATTR: ['action', …], both frozen, so a form never survives
  // sanitization to be submitted. Corrected rather than deleted because the
  // stale version overstated what this handler is still needed FOR, and a
  // reader who removed FORBID_TAGS on the strength of it would reopen the hole
  // in the one layer that is not this one.
  //
  // BUT THIS LAYER HAS A MEASURED HOLE, AND THE COMMENT ABOVE USED TO IMPLY IT
  // DID NOT. A navigation target Chromium cannot PARSE - `HTTPS://host:PORT/p`,
  // the shape a mis-templated port produces - fires NO cancellable event at
  // all: will-navigate, will-redirect and will-frame-navigate were all observed
  // silent for it, and Chromium commits its own `about:blank#blocked` page over
  // this document. Every open tab and unsaved edit goes with it.
  //
  // AND NOTHING IN THE MAIN PROCESS EVER LEARNS WHAT THE TARGET WAS. An earlier
  // draft said "only the non-cancellable did-start-navigation sees it", which
  // implied an observability layer that does not exist. Measured with a
  // did-start-navigation witness attached (test-render-security.js, the N11
  // block): for a PARSEABLE target the witness reports the real URL
  // (`http://probe.invalid/page`) even though will-navigate already denied it,
  // but for the unparseable one it reports `about:blank#blocked` - the page
  // Chromium substituted AFTERWARDS. So there is nothing to preventDefault and
  // nothing to log either; the offending URL is never surfaced to any
  // main-process event at all.
  //
  // So this is a real second layer for every URL that PARSES, and no layer at
  // all for one that does not. What actually closes the unparseable case is the
  // renderer's click delegation being TOTAL (renderer.js, the catch-all arm),
  // plus the capture-phase preventDefault on the table-insert preview, which is
  // the one sanitized-HTML surface outside #viewer. Tracked as N15; do not
  // weaken either of those on the strength of this handler. (SEC-11/N15)
  //
  // Attached before loadFile, matching registerPopup(): loadFile does not fire
  // will-navigate so the order cannot matter today, but "guard, then load" is
  // the order that stays correct if that ever changes.
  // The `url` positional this used to read is @deprecated in Electron's own
  // typings (electron.d.ts, the will-navigate/will-redirect overloads); the
  // details object is the first argument and carries `.url`. preventDefault()
  // would survive the positional being dropped, so the app would keep denying -
  // but the log line would print `undefined`, and that log line is not
  // decorative: it is the only evidence a reader or a probe has that the deny
  // fired at all, and it is what established that the denies were SILENT for
  // the unparseable URL described above. will-frame-navigate below already
  // reads `event.url`, so this also makes the three handlers agree.
  const denyMainNavigation = (event) => {
    event.preventDefault();
    console.warn(`Blocked main-window navigation to: ${event.url}`);
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

  // path.join(__dirname, ...) rather than the bare "index.html" this used to
  // pass. loadFile resolves a relative path against app.getAppPath(), which
  // Electron derives from the directory of the ENTRY SCRIPT - so the app booted
  // correctly only when whatever required this file happened to sit beside
  // index.html. That made the harness layout a load-bearing part of the
  // product: `electron bench/run.js` looked for bench/index.html, got
  // ERR_FILE_NOT_FOUND, and left a blank window in which every renderer symbol
  // was undefined. Silent from the main process, so it cost a full 900s
  // watchdog timeout to diagnose, and it is why every suite had to live at the
  // repo root and why bench.js existed as a one-line shim.
  //
  // __dirname is where main.js actually is, which is what "index.html next to
  // main.js" means. The app now boots the same from any entry point.
  //
  // Attached BEFORE loadFile, matching the navigation guards above: the initial
  // load is the first main-frame navigation this window makes, and the shutdown
  // guards key their "which renderer am I talking to" generation off exactly
  // that event. Attaching afterwards would leave the first generation
  // unaccounted for. (F22)
  attachShutdownGuards(mainWindow);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Hide the menu bar.
  //
  // THIS LINE IS A SECURITY CONTROL, not tidying. Electron installs a DEFAULT
  // application menu when nothing calls Menu.setApplicationMenu, and that menu
  // carries View > Toggle Developer Tools on Ctrl+Shift+I. With
  // nodeIntegration: true that shortcut is a Node-privileged console in a
  // shipped build. MEASURED, with a positive control: an identical window
  // WITHOUT this call opens DevTools on a synthesised Ctrl+Shift+I, and this
  // one does not - so setMenu(null) suppresses the accelerator, and deleting
  // the line as dead UI code would silently restore it.
  //
  // suppressDefaultApplicationMenu() below is the belt to this pair of braces:
  // it removes the default menu once, for every window, so a window added
  // later that forgets this call cannot inherit the accelerator either.
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
      openFile(fileToOpen, {
        sender: mainWindow.webContents,
        rendererGeneration: approvalRendererGeneration,
        provenance: "native-open",
      });
      fileToOpen = null;
    }
  });

  // Open DevTools in development (F12 to toggle)
  // mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    watchingPaused = false;
    stopFileWatching();
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
        // Ctrl+Q used to call app.quit() directly, which discarded every
        // unsaved tab without a word. It now asks the same question the window
        // close button asks, through the same state machine, so the two cannot
        // drift apart. (F22)
        requestShutdown("ctrl-q", quitApprovedApp);
      }
    }

    // DevTools is a Node-privileged console here (see devToolsAllowed). The
    // gate is checked before preventDefault rather than after, so when it is
    // shut F12 is an inert key rather than a swallowed one - with no menu bar
    // there is no default action to suppress in the first place.
    if (input.key === "F12" && input.type === "keyDown") {
      if (devToolsAllowed()) {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
      }
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

function closeCurrentFileWatcher() {
  clearTimeout(fileChangeDebounce);
  fileChangeDebounce = null;
  fileWatcherRearmPending = false;

  if (!fileWatcher) return false;
  if (typeof fileWatcher.close === "function") {
    try {
      fileWatcher.close();
    } catch (error) {
      console.error("Error closing file watcher:", error);
    }
  } else {
    clearInterval(fileWatcher);
  }
  fileWatcher = null;
  fileWatcherKind = null;
  return true;
}

function clearWatchedDocument({ clearBaseline = false } = {}) {
  const hadWatchingState =
    closeCurrentFileWatcher() || !!watchedFilePath || !!watchedFileKey;
  if (clearBaseline && watchedFileKey) {
    documentModifiedTimes.delete(watchedFileKey);
    documentVersions.delete(watchedFileKey);
    deleteDocumentUnadoptedChange(watchedFileKey);
    const spelling = filePathSpellingKey(watchedFilePath);
    if (spelling) deletePathUnadoptedChange(spelling);
  }
  watchedFilePath = null;
  watchedFileKey = null;
  watchedOwner = null;
  if (hadWatchingState) console.log("Stopped file watching");
}

function scheduleDeletionDeliveryRetry(
  record,
  delay = null,
) {
  if (
    !record ||
    record.consumed ||
    record.inFlight ||
    record.retryTimeout ||
    deletionDeliveries.get(record.key) !== record
  ) {
    return false;
  }
  const requestedDelay =
    Number.isFinite(delay) && delay > 0
      ? delay
      : DELETION_DELIVERY_RETRY_DELAY_MS *
        (2 ** Math.max(0, record.attempt - 1));
  const boundedDelay = Math.max(
    DELETION_DELIVERY_RETRY_DELAY_MS,
    Math.min(DELETION_DELIVERY_MAX_RETRY_DELAY_MS, requestedDelay),
  );
  record.retryDelayMs = boundedDelay;
  record.retryTimeout = setTimeout(() => {
    record.retryTimeout = null;
    record.retryDelayMs = 0;
    if (
      record.consumed ||
      deletionDeliveries.get(record.key) !== record ||
      !sameDocumentOwner(record.owner, watchedOwner)
    ) {
      return;
    }
    deliverDeletionReport(record, watchedOwner);
  }, boundedDelay);
  record.retryTimeout.unref?.();
  return true;
}

// Send a deletion report to its owner. An unanswered attempt is retired by a
// timeout, and a later attempt keeps the same event ID while being stamped with
// the exact current selection and watcher generations.
function deliverDeletionReport(record, selectionOwner = watchedOwner) {
  // While retry is armed, duplicate watcher production waits so attempts, timers, and ACKs cannot overlap or reuse stale backoff.
  if (!record || record.consumed || record.inFlight || record.retryTimeout) return false;
  if (!sameDocumentOwner(record.owner, selectionOwner)) return false;
  if (
    approvalRendererState !== "ready" ||
    record.owner.rendererGeneration !== approvalRendererGeneration ||
    record.owner.pageSession !== approvalRendererPageSession
  ) {
    return false;
  }
  const target =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!target || target.isDestroyed()) return false;
  record.inFlight = true;
  record.sends += 1;
  record.attempt += 1;
  record.selectionGeneration = selectionOwner.selectionGeneration;
  record.watcherGeneration = watchedWatcherGeneration;
  record.parked = false;
  const attempt = record.attempt;
  try {
    target.send("file-deleted", {
      path: record.path,
      delivery: Object.freeze({
        eventId: record.id,
        pageSession: record.owner.pageSession,
        rendererGeneration: record.owner.rendererGeneration,
        owner: Object.freeze({
          pageSession: record.owner.pageSession,
          rendererGeneration: record.owner.rendererGeneration,
          tabId: record.owner.tabId,
          documentGeneration: record.owner.documentGeneration,
          pathKey: record.owner.pathKey,
        }),
        selectionGeneration: selectionOwner.selectionGeneration,
        watcherGeneration: watchedWatcherGeneration,
        attempt,
      }),
    });
  } catch (error) {
    if (
      deletionDeliveries.get(record.key) !== record ||
      record.consumed
    ) {
      return true;
    }
    record.inFlight = false;
    record.consecutiveSendFailures += 1;
    record.lastSendError =
      error && error.message ? error.message : String(error);
    const retryDelay =
      DELETION_DELIVERY_RETRY_DELAY_MS *
      (2 ** Math.max(0, record.attempt - 1));
    record.backoffMs = Math.min(
      DELETION_DELIVERY_MAX_RETRY_DELAY_MS,
      retryDelay,
    );
    scheduleDeletionDeliveryRetry(record, retryDelay);
    return false;
  }
  if (
    deletionDeliveries.get(record.key) !== record ||
    record.consumed ||
    !record.inFlight ||
    record.attempt !== attempt
  ) {
    return true;
  }
  record.consecutiveSendFailures = 0;
  record.backoffMs = DELETION_DELIVERY_RETRY_DELAY_MS;
  record.lastSendError = null;
  record.ackTimeout = setTimeout(() => {
    if (
      deletionDeliveries.get(record.key) !== record ||
      record.consumed ||
      !record.inFlight ||
      record.attempt !== attempt
    ) {
      return;
    }
    record.ackTimeout = null;
    record.inFlight = false;
    scheduleDeletionDeliveryRetry(record);
  }, DELETION_DELIVERY_ACK_TIMEOUT_MS);
  record.ackTimeout.unref?.();
  return true;
}

function openDeletionDelivery(filePath, owner) {
  const ownerKey = documentOwnerKey(owner);
  if (!ownerKey) {
    const pathKey = canonicalFileKey(filePath);
    if (pathKey) rememberPathOnlyDeletion(filePath, pathKey);
    return null;
  }
  const existing = documentDeletionTombstones.get(ownerKey);
  if (existing) {
    activateDeletionDelivery(existing);
    deliverDeletionReport(existing);
    return existing;
  }
  const pathKey = owner.pathKey;
  if (!pathKey) return null;
  // A NEW owner tombstone, so a new retained unit. Reserved before the id is
  // minted and before any map is touched: if the budget is gone, this deletion
  // goes unrecorded and the latch above has already made every Save refuse,
  // which is the only safe reading of "we may have forgotten a deletion".
  if (!reserveDeletionEvidenceCapacity("owner-tombstone")) return null;
  do {
    nextDeletionDeliveryId =
      nextDeletionDeliveryId === Number.MAX_SAFE_INTEGER
        ? 1
        : nextDeletionDeliveryId + 1;
  } while (findDeletionTombstoneById(nextDeletionDeliveryId));
  const record = {
    id: nextDeletionDeliveryId,
    key: ownerKey,
    pathKey,
    spelling: owner.spelling,
    path: filePath,
    owner,
    consumed: false,
    inFlight: false,
    sends: 0,
    attempt: 0,
    ackTimeout: null,
    retryTimeout: null,
    retryDelayMs: 0,
    backoffMs: DELETION_DELIVERY_RETRY_DELAY_MS,
    consecutiveSendFailures: 0,
    lastSendError: null,
    parked: false,
    compacted: false,
    selectionGeneration: 0,
    watcherGeneration: 0,
    deletionWatcherGeneration: watchedWatcherGeneration,
    physicalVersion: documentVersions.get(pathKey) || null,
    recreationReported: false,
    recreationVersion: null,
  };
  retainDeletionTombstone(record);
  compactDeletionDeliveryCapacity();
  deletionDeliveries.set(ownerKey, record);
  deletedDocuments.add(pathKey);
  addDocumentUnadoptedChange(pathKey);
  noteDeletionEvidenceMutation();
  deliverDeletionReport(record);
  return record;
}

function findDeletionDeliveryById(deliveryId) {
  for (const record of deletionDeliveries.values()) {
    if (record.id === deliveryId) return record;
  }
  return null;
}

function findDeletionTombstoneById(deliveryId) {
  return deletionTombstonesById.get(deliveryId) || null;
}

function deletionDeliverySummaries() {
  return Object.freeze(
    Array.from(deletionDeliveries.values(), (record) =>
      Object.freeze({
        eventId: record.id,
        owner: Object.freeze({
          pageSession: record.owner.pageSession,
          rendererGeneration: record.owner.rendererGeneration,
          tabId: record.owner.tabId,
          documentGeneration: record.owner.documentGeneration,
          pathKey: record.owner.pathKey,
        }),
        attempt: record.attempt,
        sends: record.sends,
        inFlight: record.inFlight,
        parked: record.parked,
        compacted: record.compacted === true,
        ackTimerActive: record.ackTimeout !== null,
        retryTimerActive: record.retryTimeout !== null,
        retryDelayMs: record.retryDelayMs,
        backoffMs: record.backoffMs,
        consecutiveSendFailures: record.consecutiveSendFailures,
        lastSendError: record.lastSendError,
        watcherGeneration: record.watcherGeneration,
        selectionGeneration: record.selectionGeneration,
      }),
    ),
  );
}

// Re-offer a pending report when its owner is selected again. This is the half
// that was missing: the first send is rejected by a renderer showing another
// document, and without a replay the owner never hears about it at all.
function replayDeletionForOwner(filePath) {
  const ownerKey = documentOwnerKey(watchedOwner);
  if (!ownerKey) return false;
  const record =
    deletionDeliveries.get(ownerKey) ||
    documentDeletionTombstones.get(ownerKey);
  if (!record) return false;
  if (record.consumed) return false;
  if (!sameDocumentOwner(record.owner, watchedOwner)) {
    return false;
  }
  if (
    record.selectionGeneration === watchedOwner.selectionGeneration &&
    (record.inFlight || record.retryTimeout || record.parked)
  ) {
    return false;
  }
  activateDeletionDelivery(record);
  clearDeletionDeliveryAttempt(record);
  record.parked = false;
  if (!deliverDeletionReport(record, watchedOwner)) return false;
  return true;
}

// A navigation replaces the page: its tabs, and the sessions that named them,
// are gone, so no report addressed to them can ever be answered. The DELETION
// EVIDENCE stays - the files are still missing, and the next selection reopens
// a report for whoever owns the path then.
function releaseDeletionDeliveriesForPage() {
  for (const record of Array.from(deletionDeliveries.values())) {
    releaseDeletionDelivery(record);
  }
  watchedOwner = null;
  knownDocumentOwners.clear();
  ownerDocumentBaselines.clear();
  quarantinedDocumentOwners.clear();
  supersededDocumentOwners.clear();
  notifiedExternalVersionsByOwner.clear();
  pendingDiskAdoptions.clear();
  committedDiskAdoptions.clear();
  latestAcceptedSaveSequenceByDocument.clear();
}

function reportWatchedFileDeleted() {
  if (!watchedFilePath) return;
  const deletedPath = watchedFilePath;
  const deletedKey = watchedFileKey || canonicalFileKey(deletedPath);
  openDeletionDelivery(deletedPath, watchedOwner);
  for (const baseline of ownerDocumentBaselines.values()) {
    const owner = baseline.owner;
    if (
      owner.pathKey === deletedKey &&
      owner.pageSession === approvalRendererPageSession &&
      owner.rendererGeneration === approvalRendererGeneration &&
      !sameDocumentOwner(owner, watchedOwner)
    ) {
      try {
        fs.statSync(owner.spelling);
        if (resolveCanonicalFileKey(owner.spelling) !== owner.pathKey) {
          addPathUnadoptedChange(owner.spelling);
        }
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          openDeletionDelivery(owner.spelling, owner);
        } else {
          console.error("Could not check a sibling deletion owner:", error);
          addPathUnadoptedChange(owner.spelling);
        }
      }
    }
  }
  const alreadyPollingMissingPath = fileWatcherKind === "poll";
  if (!alreadyPollingMissingPath) closeCurrentFileWatcher();
  if (!watchingPaused && !alreadyPollingMissingPath) {
    // Keep lightweight ownership of the missing path. A later recreation must
    // be reported against the retained pre-deletion baseline rather than being
    // silently adopted as a brand-new document.
    fileWatcher = setInterval(() => checkFileChanges(), 2000);
    fileWatcherKind = "poll";
  }
}

function settleRenameEvent(filePath, watcher, attemptsRemaining = 4) {
  if (
    watchingPaused ||
    fileWatcher !== watcher ||
    !sameFilePath(watchedFilePath, filePath)
  ) {
    return;
  }
  if (fs.existsSync(filePath)) {
    startFileWatching(filePath);
    return;
  }
  if (attemptsRemaining > 0) {
    fileChangeDebounce = setTimeout(
      () => settleRenameEvent(filePath, watcher, attemptsRemaining - 1),
      50,
    );
    return;
  }
  reportWatchedFileDeleted();
}

function selectWatchedDocument(
  filePath,
  {
    adoptBaseline = false,
    modifiedTime = null,
    diskVersion = null,
    owner = undefined,
    ownerUsesCurrentPathIdentity = false,
    verifySelection = null,
    verifiedOwner = null,
    verifiedKey = null,
  } = {},
) {
  if ((verifiedOwner === null) !== (verifiedKey === null)) return false;
  const suppliedVersion = diskVersion === null
    ? null
    : normaliseDiskVersion(diskVersion);
  if (
    diskVersion !== null &&
    (!suppliedVersion ||
      (Number.isFinite(modifiedTime) &&
        suppliedVersion.mtimeMs !== modifiedTime))
  ) {
    console.error("Refusing watcher selection with incoherent disk version");
    return false;
  }
  const normalisedOwner =
    owner === undefined
      ? null
      : verifiedOwner || normaliseDocumentOwner(owner, filePath, {
          useCurrentPathIdentity: ownerUsesCurrentPathIdentity,
        });
  if (
    owner !== undefined &&
    (!normalisedOwner ||
      (verifiedOwner &&
        (!sameDocumentSelectionOwner(owner, verifiedOwner) ||
          verifiedOwner.pathKey !== verifiedKey)) ||
      !canRememberDocumentOwner(normalisedOwner))
  ) return false;
  const previousOwnerBaseline = ownerDocumentBaselines.get(
    documentOwnerKey(normalisedOwner),
  );
  if (
    adoptBaseline &&
    previousOwnerBaseline &&
    previousOwnerBaseline.version &&
    suppliedVersion &&
    diskVersionChanged(previousOwnerBaseline.version, suppliedVersion)
  ) {
    console.error("Refusing to replace an owner's baseline without disk adoption");
    return false;
  }
  if (verifySelection && !verifySelection()) return false;
  let key;
  let verifiedAdoption = false;
  let missingOwnedDocument = false;
  if (adoptBaseline) {
    try {
      fs.statSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        console.error("Could not check selected document:", error);
        return false;
      }
      if (
        !normalisedOwner ||
        !documentHasSaveBaseline(filePath, normalisedOwner)
      ) {
        console.error("Refusing missing document without a prior owner baseline");
        return false;
      }
      missingOwnedDocument = true;
    }
    const adoption = {};
    const adoptedTime = Number.isFinite(modifiedTime)
      ? modifiedTime
      : readDocumentModifiedTime(filePath, "while adopting disk content");
    key = missingOwnedDocument
      ? normalisedOwner.pathKey
      : Number.isFinite(adoptedTime)
      ? adoptDocumentBaseline(
          filePath,
          adoptedTime,
          "while adopting disk content",
          diskVersion,
          adoption,
        )
      : null;
    if (!key) return false;
    verifiedAdoption = adoption.accepted === true;
  } else {
    key = verifiedKey || canonicalFileKey(filePath);
  }
  if (!key) return false;

  if (owner !== undefined &&
      !rememberDocumentOwner(normalisedOwner, {
        diskVersion: suppliedVersion,
        modifiedTime,
        adopted: verifiedAdoption,
        readPath: filePath,
      })) return false;
  const changedSpelling = watchedFilePath !== filePath;
  const changedDocument = watchedFileKey !== key;
  if (changedSpelling || changedDocument) closeCurrentFileWatcher();
  watchedFilePath = filePath;
  watchedFileKey = key;
  if (owner !== undefined) {
    watchedOwner = normalisedOwner;
    if (missingOwnedDocument) {
      openDeletionDelivery(filePath, normalisedOwner);
    }
  } else if (changedSpelling || changedDocument) {
    // Re-arming the watcher for the SAME document keeps whoever asked for it.
    // A selection that names a different document and no owner cannot speak
    // for the previous one, so the seat is left empty rather than inherited.
    watchedOwner = null;
  }

  if (!adoptBaseline && !documentModifiedTimes.has(key)) {
    const initialStats = readDocumentStats(
      filePath,
      "while establishing an initial watcher baseline",
    );
    if (initialStats) {
      rememberDocumentVersion(filePath, initialStats);
    }
  }
  return true;
}

function startFileWatching(filePath, options = {}) {
  if (!selectWatchedDocument(filePath, options)) return;
  watchedWatcherGeneration += 1;

  // Explicitly arming the watcher for a file clears any earlier pause, so a
  // stale paused flag cannot leave the selected clean file silently unwatched.
  watchingPaused = false;

  if (!fs.existsSync(filePath)) {
    if (
      documentHasSaveBaseline(filePath) ||
      pathHasDeletionTombstone(filePath, watchedOwner)
    ) {
      reportWatchedFileDeleted();
    }
    return;
  }

  closeCurrentFileWatcher();

  // Use OS-level fs.watch for instant detection
  try {
    const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (watchingPaused || fileWatcher !== watcher) return;

      if (eventType === "rename") {
        // A rename event also covers atomic-save replacement. If the path
        // is transiently absent, give the replacement time to land before
        // declaring a true deletion. Then recreate the watcher because the old
        // one may remain attached to the displaced inode.
        clearTimeout(fileChangeDebounce);
        settleRenameEvent(filePath, watcher);
        return;
      }
      // Debounce 'change' events (editors may fire multiple events rapidly)
      clearTimeout(fileChangeDebounce);
      fileChangeDebounce = setTimeout(() => checkFileChanges(), 150);
    });
    fileWatcher = watcher;
    fileWatcherKind = "fs";

    watcher.on("error", (err) => {
      if (fileWatcher !== watcher) return;
      console.error("fs.watch error, falling back to polling:", err.message);
      fileWatcher = null;
      fileWatcherKind = null;
      if (watchingPaused) return;
      // Fallback to polling every 2 seconds (faster than before)
      fileWatcher = setInterval(() => checkFileChanges(), 2000);
      fileWatcherKind = "poll";
    });

    console.log("Started watching file (OS-level):", filePath);
  } catch (err) {
    console.error("fs.watch not available, using polling:", err.message);
    // Fallback to polling every 2 seconds
    fileWatcher = setInterval(() => checkFileChanges(), 2000);
    fileWatcherKind = "poll";
    console.log("Started watching file (polling):", filePath);
  }

  if (options.skipInitialCheck !== true) checkFileChanges();
}

function scheduleWatcherRearmAfterRecreation(filePath, owner) {
  if (fileWatcherRearmPending || fileWatcherKind !== "poll") return false;
  fileWatcherRearmPending = true;
  setImmediate(() => {
    if (!fileWatcherRearmPending) return;
    fileWatcherRearmPending = false;
    const currentOwner = watchedOwner;
    if (
      watchingPaused ||
      !sameFilePath(watchedFilePath, filePath) ||
      !sameDocumentOwner(currentOwner, owner) ||
      !fs.existsSync(filePath) ||
      !pathHasDeletionTombstone(filePath, owner)
    ) {
      return;
    }
    startFileWatching(filePath, {
      owner: currentOwner,
      skipInitialCheck: true,
    });
  });
  return true;
}

function sendAuthorisedWatcherEvent(channel, filePath, data = {}) {
  const owner = watchedOwner;
  const target =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (
    !target ||
    target.isDestroyed() ||
    !owner ||
    owner.pageSession !== approvalRendererPageSession ||
    owner.rendererGeneration !== approvalRendererGeneration
  ) {
    return false;
  }
  try {
    target.send(channel, {
      ...data,
      path: filePath,
      watcher: Object.freeze({
        pageSession: owner.pageSession,
        rendererGeneration: owner.rendererGeneration,
        owner: Object.freeze({
          pageSession: owner.pageSession,
          rendererGeneration: owner.rendererGeneration,
          tabId: owner.tabId,
          documentGeneration: owner.documentGeneration,
          pathKey: owner.pathKey,
        }),
        selectionGeneration: owner.selectionGeneration,
        watcherGeneration: watchedWatcherGeneration,
      }),
    });
    return true;
  } catch (error) {
    console.error(`Error delivering ${channel}:`, error);
    return false;
  }
}

function checkFileChanges() {
  if (watchingPaused) return;

  if (!watchedFilePath || !fs.existsSync(watchedFilePath)) {
    if (watchedFilePath && !fs.existsSync(watchedFilePath)) {
      reportWatchedFileDeleted();
    }
    return;
  }

  try {
    const stats = fs.statSync(watchedFilePath);
    const currentVersion = diskVersionFromStats(stats);
    const currentModTime = currentVersion.mtimeMs;
    const ownerKey = documentOwnerKey(watchedOwner);
    const selectedBaseline = ownerDocumentBaselines.get(ownerKey);
    const baseline = selectedBaseline &&
      Number.isFinite(selectedBaseline.modifiedTime)
      ? selectedBaseline.modifiedTime
      : watchedFileKey
        ? documentModifiedTimes.get(watchedFileKey)
        : undefined;
    const baselineVersion = selectedBaseline && selectedBaseline.version
      ? selectedBaseline.version
      : watchedFileKey
        ? documentVersions.get(watchedFileKey)
        : undefined;
    const currentFileKey = resolveCanonicalFileKey(watchedFilePath);
    const spelling = filePathSpellingKey(watchedFilePath);
    const targetChanged =
      !!watchedFileKey &&
      !!currentFileKey &&
      watchedFileKey !== currentFileKey;
    const targetChangeAlreadyReported =
      !!spelling && pathsWithUnadoptedChanges.has(spelling);
    const wasDeleted =
      pathHasDeletionTombstone(watchedFilePath, watchedOwner) ||
      (!watchedOwner &&
        !!watchedFileKey &&
        deletedDocuments.has(watchedFileKey));

    if (wasDeleted) {
      const tombstones = deletionTombstonesForPath(
        watchedFilePath,
        watchedOwner,
      );
      const firstRecreationReport = tombstones.some(
        (record) => !record.recreationReported,
      );
      for (const record of tombstones) {
        record.recreationReported = true;
        record.recreationVersion = currentVersion;
      }
      addDocumentUnadoptedChange(watchedFileKey);
      if (
        firstRecreationReport &&
        mainWindow &&
        mainWindow.webContents
      ) {
        console.log("Deleted file recreated externally:", watchedFilePath);
        sendAuthorisedWatcherEvent(
          "file-changed-externally",
          watchedFilePath,
          {
          modifiedTime: currentModTime,
          },
        );
      }
      scheduleWatcherRearmAfterRecreation(watchedFilePath, watchedOwner);
      return;
    }

    if (targetChanged || targetChangeAlreadyReported) {
      if (targetChanged && spelling) {
        addPathUnadoptedChange(spelling);
      }
      if (
        targetChanged &&
        !targetChangeAlreadyReported &&
        mainWindow &&
        mainWindow.webContents
      ) {
        console.log("File target changed externally:", watchedFilePath);
        sendAuthorisedWatcherEvent(
          "file-changed-externally",
          watchedFilePath,
          {
          modifiedTime: currentModTime,
          },
        );
      }
      return;
    }

    const activeSave = watchedFileKey
      ? activeSaveVerifications.get(watchedFileKey)
      : null;
    if (activeSave) {
      // An in-place write event does not identify its writer. Before sync there
      // is no final self-version to compare with, so prompting here would turn
      // every ordinary save into a false external-change notification. Defer
      // instead to the save's stable post-write read and post-adoption version
      // checks below. Once sync has produced a version, suppress events that
      // still describe the same object and size. Windows may finalize times
      // when the handle closes; the stable content read detects a same-size
      // external write that survives our write. It cannot prove that another
      // writer was not completely overwritten before the final snapshot; the
      // direct-handle API offers no atomic compare-and-write primitive for
      // that remaining race.
      if (
        !activeSave.writtenVersion ||
        !saveCompletionOwnershipOrSizeChanged(
          activeSave.writtenVersion,
          currentVersion,
        )
      ) {
        return;
      }
    }

    if (!Number.isFinite(baseline)) {
      if (watchedFileKey) {
        documentModifiedTimes.set(watchedFileKey, currentModTime);
        documentVersions.set(watchedFileKey, currentVersion);
      }
      return;
    }

    if (
      wasDeleted ||
      currentModTime !== baseline ||
      (baselineVersion &&
        diskVersionChanged(baselineVersion, currentVersion))
    ) {
      const previouslyNotified = notifiedExternalVersionsByOwner.get(
        ownerKey,
      );
      const alreadyNotified = !!previouslyNotified &&
        sameDiskVersion(previouslyNotified, currentVersion);
      documentModifiedTimes.set(watchedFileKey, currentModTime);
      documentVersions.set(watchedFileKey, currentVersion);
      addDocumentUnadoptedChange(watchedFileKey);
      if (alreadyNotified) return;
      // ONLY AGAINST AN OWNER THE TABLES STILL HOLD. `watchedOwner` is not
      // cleared when its own tab supersedes it, so this is the one writer that
      // could name an owner `forgetDocumentOwnerAliases` has already collected
      // - and the entry would then be unreachable for the rest of the session
      // while suppressing nothing, because no live owner reads that key. Not
      // recording it only risks repeating a notice, which is the safe side.
      if (ownerKey && knownDocumentOwners.has(ownerKey)) {
        notifiedExternalVersionsByOwner.set(ownerKey, currentVersion);
      }
      console.log("File modified externally:", watchedFilePath);

      // Notify renderer about file change
      if (mainWindow && mainWindow.webContents) {
        sendAuthorisedWatcherEvent(
          "file-changed-externally",
          watchedFilePath,
          {
          modifiedTime: currentModTime,
          },
        );
      }
    }
  } catch (err) {
    console.error("Error checking file changes:", err);
  }
}

function stopFileWatching({ clearBaselines = true } = {}) {
  clearWatchedDocument();
  if (clearBaselines) {
    documentModifiedTimes.clear();
    documentVersions.clear();
    for (const key of Array.from(documentsWithUnadoptedChanges)) {
      if (!deletedDocuments.has(key)) {
        deleteDocumentUnadoptedChange(key);
      }
    }
    for (const spelling of Array.from(pathsWithUnadoptedChanges)) {
      if (
        !pathOnlyDeletionEvidence.has(spelling) &&
        !deletionTombstonesBySpelling.has(spelling)
      ) {
        deletePathUnadoptedChange(spelling);
      }
    }
    releaseDeletionDeliveriesForPage();
    filePathAliases.clear();
  }
}

function pauseFileWatching() {
  if (closeCurrentFileWatcher()) {
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

/**
 * The one place the large-document wording lives, so the dialog the main
 * process shows on open and the one the renderer requests on tab switch
 * cannot drift apart.
 * @returns {boolean} true if rendering should proceed
 */
function askAboutLargeDocument(name, seconds) {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    buttons: ["Open anyway", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Large document",
    message: `"${name}" may take about ${seconds} seconds to display.`,
    detail:
      "The window will be unresponsive while it renders. This is an estimate " +
      "based on the document's structure, not just its size - documents with " +
      "large tables take much longer than plain text of the same length.",
  });
  return choice === 0;
}

/**
 * A document the cost model predicts will take a long time to become readable
 * gets the reader a choice rather than a frozen window.
 *
 * The prediction is deliberately CHEAP and deliberately CONSERVATIVE: it is an
 * O(n) character scan costing ~0.2% of the render it is gating, and it errs
 * toward warning early (measured, it never under-predicts a real render by
 * more than 1.01x). See file-helpers.js and bench/BASELINE.md.
 *
 * This is a WARNING, not a refusal. The reader knows things the estimator does
 * not - that the file is the one they need, that they will wait. Refusing
 * outright would make a large document unopenable in the only tool that opens
 * it, so the default button opens it anyway.
 *
 * @param {string} content - Raw markdown
 * @param {string} filePath - Shown to the reader so they know which file
 * @returns {boolean} true if rendering should proceed
 */
function confirmLargeDocument(content, filePath) {
  const { large, estimatedMs } = isLargeDocument(content);
  if (!large) return true;

  const seconds = Math.round(estimatedMs / 1000);
  const name = path.basename(filePath);
  log(`Large document: ${name} predicted at ~${seconds}s to render`);

  if (!askAboutLargeDocument(name, seconds)) {
    log(`Large document open cancelled by user: ${name}`);
    return false;
  }
  return true;
}

// Tabs render lazily, so a file that arrived by multi-select or session
// restore reaches its first render on a tab CLICK, in the renderer, long after
// main.js's open-time guard has had its say. The renderer does its own
// estimate (it loads the same file-helpers) and asks here only to put the
// dialog on the main process, where dialogs belong. Sending the estimate
// rather than the document keeps megabytes off the sync IPC channel.
ipcMain.on("confirm-large-render", (event, data) => {
  const name = data && typeof data.name === "string" ? data.name : "This document";
  const seconds = data && Number.isFinite(data.seconds) ? data.seconds : 0;
  event.returnValue = askAboutLargeDocument(name, seconds);
});

function safeSendFileOpen(target, channel, data, rendererGeneration = null) {
  if (!target || target.isDestroyed()) return false;
  if (
    rendererGeneration !== null &&
    (rendererGeneration !== approvalRendererGeneration ||
      !mainWindow ||
      mainWindow.webContents !== target)
  ) {
    return false;
  }
  if (
    (channel === "file-opened" || channel === "file-open-result") &&
    shutdownCommitIngressBlocked
  ) {
    log("File open refused while a shutdown commit is frozen:", data.path);
    try {
      target.send(
        "show-error",
        `File open was refused while closing: ${safeFileLabel(
          path.basename(data.path),
        )}. Retry after closing is cancelled.`,
      );
    } catch (error) {
      log("Could not report refused file open:", error);
    }
    return false;
  }
  try {
    target.send(channel, data);
    return true;
  } catch {
    return false;
  }
}

function sendFileOpenFailure(
  target,
  filePath,
  openRequest,
  reason,
  message,
  rendererGeneration = null,
) {
  // Only tokenized navigation owns this result channel. A legacy failure is
  // intentionally uncorrelated and must not be allowed to retire a newer
  // pending navigation request in the renderer.
  if (openRequest) {
    safeSendFileOpen(target, "file-open-result", {
      success: false,
      path: filePath,
      openRequest,
      reason,
      message: typeof message === "string" ? message : null,
    }, rendererGeneration);
  }
  if (message && !openRequest) {
    safeSendFileOpen(target, "show-error", message, rendererGeneration);
  }
}

let fileOpenDeliveryEpoch = 0;
let activeDialogExtraBatch = null;

function dialogExtraBatchIsCurrent(batch, event) {
  return activeDialogExtraBatch === batch &&
    isApprovalSender(event) &&
    approvalRendererState === "ready" &&
    event.sender === batch.sender &&
    event.senderFrame.frameTreeNodeId === batch.frameTreeNodeId &&
    batch.pageSession === approvalRendererPageSession &&
    batch.rendererGeneration === approvalRendererGeneration;
}

ipcMain.handle("read-dialog-extra", (event, data) => {
  const batch = activeDialogExtraBatch;
  if (
    !batch ||
    !data ||
    typeof data.grant !== "string" ||
    data.pageSession !== batch.pageSession ||
    data.rendererGeneration !== batch.rendererGeneration ||
    !dialogExtraBatchIsCurrent(batch, event)
  ) {
    throw new Error("Dialog extra read refused: invalid document session");
  }
  const filePath = batch.grants.get(data.grant);
  if (!filePath) {
    throw new Error("Dialog extra read refused: unknown or used grant");
  }
  // Consume before the asynchronous read so a concurrent replay cannot start.
  batch.grants.delete(data.grant);
  return new Promise((resolve, reject) => {
    readMarkdownSnapshot(filePath, (error, content, modifiedTime, diskVersion, physical) => {
      if (!dialogExtraBatchIsCurrent(batch, event)) {
        reject(new Error("Dialog extra read refused: batch no longer active"));
      } else if (error) {
        console.error("Error reading dialog extra:", error);
        reject(error);
      } else {
        try {
          const document = issueDocumentAdmission(event.sender, filePath,
            diskVersion, physical, "native-dialog");
          resolve({ path: filePath, content, modifiedTime, diskVersion, document });
        } catch (admissionError) {
          reject(admissionError);
        }
      }
    });
  });
});

function openFile(filePath, options = {}) {
  const deliveryEpoch = ++fileOpenDeliveryEpoch;
  const openRequest = options.openRequest || null;
  const requestedSender = options.sender || null;
  const rendererGeneration = Number.isSafeInteger(options.rendererGeneration)
    ? options.rendererGeneration
    : null;
  log("Attempting to open file:", filePath);

  if (typeof filePath !== "string" || !fs.existsSync(filePath)) {
    log("ERROR: File not found:", filePath);
    const target =
      requestedSender ||
      (mainWindow && mainWindow.webContents
        ? mainWindow.webContents
        : null);
    if (!openRequest) {
      safeSendFileOpen(
        target,
        "file-not-found",
        { path: filePath },
        rendererGeneration,
      );
    }
    sendFileOpenFailure(
      target,
      filePath,
      openRequest,
      "file-not-found",
      openRequest ? `File not found: ${filePath}` : null,
      rendererGeneration,
    );
    return;
  }

  // Ensure window is ready
  if (
    !mainWindow ||
    !mainWindow.webContents ||
    mainWindow.webContents.isDestroyed()
  ) {
    log("ERROR: Window not ready");
    sendFileOpenFailure(
      requestedSender,
      filePath,
      openRequest,
      "window-unavailable",
      null,
      rendererGeneration,
    );
    return;
  }
  const target = requestedSender || mainWindow.webContents;

  // Use helper function for reading markdown files
  readMarkdownSnapshot(filePath, (err, data, modifiedTime, diskVersion, physical) => {
    if (deliveryEpoch !== fileOpenDeliveryEpoch) {
      sendFileOpenFailure(
        target,
        filePath,
        openRequest,
        "superseded-open",
        null,
        rendererGeneration,
      );
      return;
    }
    if (err) {
      log("ERROR: Error reading file:", err);
      sendFileOpenFailure(
        target,
        filePath,
        openRequest,
        "read-failed",
        `Error reading file: ${err.message}`,
        rendererGeneration,
      );
      return;
    }

    log("File read successfully, sending to renderer");
    if (!confirmLargeDocument(data, filePath)) {
      sendFileOpenFailure(
        target,
        filePath,
        openRequest,
        "large-declined",
        null,
        rendererGeneration,
      );
      return;
    }
    rememberDocumentModifiedTime(filePath, modifiedTime, { replace: false });
    let document;
    if (options.provenance) {
      try {
        document = issueDocumentAdmission(target, filePath, diskVersion,
          physical, options.provenance);
      } catch (error) {
        sendFileOpenFailure(target, filePath, openRequest, "admission-refused",
          error.message, rendererGeneration);
        return;
      }
    }
    const sent = safeSendFileOpen(
      target,
      "file-opened",
      {
        content: data,
        path: filePath,
        allPaths: [filePath],
        openRequest,
        modifiedTime,
        diskVersion,
        ...(document ? { document } : {}),
      },
      rendererGeneration,
    );
    if (!sent) return;
    activeDialogExtraBatch = null;
  });
}

function openFileDialog() {
  const target =
    mainWindow && mainWindow.webContents ? mainWindow.webContents : null;
  const rendererGeneration = approvalRendererGeneration;
  dialog
    .showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Markdown Files",
          extensions: ["md", "markdown", "mdown", "mkd", "mkdn"],
        },
        { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    .then((result) => {
      if (!result.canceled && result.filePaths.length > 0) {
        const deliveryEpoch = ++fileOpenDeliveryEpoch;
        const filePaths = result.filePaths;
        const firstFilePath = filePaths[0];

        // Use helper function for reading markdown files
        readMarkdownSnapshot(
          firstFilePath,
          (err, data, modifiedTime, diskVersion, physical) => {
            if (deliveryEpoch !== fileOpenDeliveryEpoch) return;
            if (err) {
              console.error("Error reading file:", err);
              return;
            }

            // Send first file content and all selected paths. Extra paths stay
            // in main; the renderer can read only the dialog's one-use grants.
            if (!confirmLargeDocument(data, firstFilePath)) return;
            rememberDocumentModifiedTime(firstFilePath, modifiedTime, {
              replace: false,
            });
            const frame = target && !target.isDestroyed()
              ? target.mainFrame
              : null;
            if (!frame || frame.isDestroyed()) {
              console.error("Could not deliver dialog extras: main frame unavailable");
            }
            const grants = new Map();
            const extraReadGrants = filePaths.slice(1).map((extraPath) => {
              const grant = crypto.randomBytes(32).toString("hex");
              grants.set(grant, extraPath);
              return grant;
            });
            const batch = {
              sender: target,
              frameTreeNodeId: frame && !frame.isDestroyed()
                ? frame.frameTreeNodeId
                : null,
              rendererGeneration,
              pageSession: approvalRendererPageSession,
              grants,
            };
            let document;
            try {
              document = issueDocumentAdmission(target, firstFilePath,
                diskVersion, physical, "native-dialog");
            } catch (error) {
              console.error("Could not admit the selected document:", error);
              return;
            }
            const sent = safeSendFileOpen(
              target,
              "file-opened",
              {
                content: data,
                path: firstFilePath,
                allPaths: filePaths,
                extraReadGrants,
                modifiedTime,
                diskVersion,
                document,
              },
              rendererGeneration,
            );
            if (sent) activeDialogExtraBatch = batch;
          },
        );
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

// Handle direct file path open request from renderer (for markdown links and
// tokenized back/forward navigation). Metadata is echoed but never supplies
// filesystem authority: only the top-level filePath is opened.
ipcMain.on("open-file-path", (event, payload) => {
  if (!isApprovalSender(event)) return;
  const structured =
    payload && typeof payload === "object" && !Array.isArray(payload);
  const filePath = structured ? payload.filePath : payload;
  const openRequest = structured ? payload.openRequest || null : null;
  const approvedHistory = typeof filePath === "string" &&
    documentSessionManifest?.approvedEntries.find(entry =>
      entry.filePath === path.normalize(path.resolve(filePath)));
  openFile(filePath, {
    sender: event.sender,
    openRequest,
    rendererGeneration: approvalRendererGeneration,
    ...(approvedHistory ? { provenance: approvedHistory.provenance } : {}),
  });
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
// SEC-22: `exec` runs its argument through a shell, where a path containing
// `$(...)`, backticks or a backslash escape is interpreted rather than treated
// as text - the surrounding double quotes do not neutralise any of those. The
// path comes from a save dialog, so exploiting it needs the user's own
// cooperation, but there is no reason to accept the risk: `execFile` passes the
// argument vector to the process directly and never constructs a command line
// for a shell to re-parse.
function openFileAfterExport(filePath) {
  if (process.platform === "linux") {
    // In WSL2, use wslpath to get the Windows UNC path, then open with explorer.exe
    execFile("wslpath", ["-w", filePath], (err, winPath) => {
      if (!err && winPath && winPath.trim()) {
        execFile("explorer.exe", [winPath.trim()], (err2) => {
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

ipcMain.on("export-pdf", async (event, data) => {
  try {
    const { currentFileName } = data;

    // INGRESS. Refused before a destination is even chosen, so the latch never
    // lets the reader pick a path Folia is going to refuse to write anyway.
    // This protocol carries no request id, so none is invented here: the
    // renderer correlates the result exactly as it always has.
    if (deletionEvidenceCapacityLatched) {
      mainWindow.webContents.send(
        "pdf-export-result",
        deletionEvidenceCapacityWriteRefusal("ingress"),
      );
      return;
    }

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

    // BEFORE THE WRITE. The save dialog, the light-mode handshake and
    // printToPDF are all awaits: the latch can trip inside any of them, and
    // the destination now in hand is a file that does not exist yet.
    if (deletionEvidenceCapacityLatched) {
      mainWindow.webContents.send(
        "pdf-export-result",
        deletionEvidenceCapacityWriteRefusal("before-write", {
          path: result.filePath,
        }),
      );
      return;
    }

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

// Handle markdown file save request from renderer
// Writes to the same file are serialized. Two saves dispatched close together
// (Ctrl+S twice, or Save then Ctrl+S) otherwise run as concurrent
// open-truncate-write sequences against one path, and which one lands last is
// decided by the OS - measured leaving the OLDER content on disk while the
// renderer had correctly adopted the newer one. Chaining per path makes the
// last write issued the last write applied, which is the only ordering a user
// can reason about.
const saveQueues = new Map();
const saveTargetRevisions = new Map();

function saveTargetRevision(key) {
  let state = saveTargetRevisions.get(key);
  if (!state) {
    state = { revision: 0, readers: 0 };
    saveTargetRevisions.set(key, state);
  }
  return state;
}

function releaseSaveTargetRevision(key, state) {
  if (!state.readers && !saveQueues.has(key) &&
      saveTargetRevisions.get(key) === state) saveTargetRevisions.delete(key);
}
// WHICH LIFECYCLE A QUEUED SAVE BELONGS TO. `__shutdown.reset` tears the
// machine down and, last of all, re-opens the deletion-evidence latch - but
// `saveQueues` can still hold a Save that was accepted BEFORE the latch tripped
// and is parked behind a prior write or a gate hold, and `knownDocumentOwners`
// is deliberately retained, so every identity check that save makes would still
// pass. Clearing the latch would then let a save the previous scenario had
// already stopped wake up and create or truncate a file in the next one.
// A monotonic epoch fails those scopes CLOSED: a save carries the epoch it was
// accepted under, and every stage that could still write re-checks it. Nothing
// releases an expired scope - like the latch it invalidates against, it is a
// one-way door for the save that holds it.
let saveLifecycleEpoch = 1;
const activeSaveRunsByKey = new Map();
const activeSaveVerifications = new Map();
const activeSaveCorrelations = new Map();
const pendingSaveOutcomeDeliveries = new Map();
const latestAcceptedSaveSequenceByDocument = new Map();
const MAX_ACTIVE_SAVE_CORRELATIONS = 128;
const SAVE_OUTCOME_ACK_TIMEOUT_MS = 4000;
const SAVE_OUTCOME_RETRY_DELAY_MS = 100;
const SAVE_OUTCOME_MAX_RETRY_DELAY_MS = 4000;
// Monotonic diagnostics. Tests can compare two snapshots without replacing
// fs methods or changing the write path merely to make serialization visible.
let saveQueueEnqueuedCount = 0;
let saveQueueStartedCount = 0;
let saveQueueCompletedCount = 0;
let saveQueuePendingCount = 0;
let saveQueueOverlapCount = 0;
let saveQueueMaxActiveForSinglePath = 0;

// Test-only: no renderer IPC or test-supplied scope can enter this gate.
// A matching, authenticated save pauses inside its existing per-path queue.
const liveSaveGate = app.isPackaged ? null : (() => {
  const MAX_MS = 30000;
  let nextToken = 0;
  let armed = null;
  let claimed = null;
  let held = null;
  let waiter = null;
  let lastEnd = null;
  let unclaimedRefusal = null;
  const failedClaims = new Map();
  const refusedScopes = new Set();

  function milliseconds(value, name, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MS) {
      throw new Error(`Save gate ${name} must be 1-${MAX_MS} milliseconds`);
    }
    return value;
  }

  function selector(value, name) {
    if (value === undefined) return null;
    if (typeof value !== "string" || !value || value.includes("\0")) {
      throw new Error(`Save gate ${name} must be a nonempty string without NUL`);
    }
    return value;
  }

  function summary(item) {
    if (!item) return null;
    const scope = item.scope;
    return Object.freeze({
      token: item.token,
      path: scope.path,
      pathKey: scope.owner.pathKey,
      requestId: scope.requestId,
      pageSession: scope.pageSession,
      rendererGeneration: scope.rendererGeneration,
      tabId: scope.owner.tabId,
      documentGeneration: scope.owner.documentGeneration,
      selectionGeneration: scope.owner.selectionGeneration,
      sequence: scope.sequence,
    });
  }

  function notifyWaiter(error, value) {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve(value);
  }

  function disarm(reason) {
    if (!armed) return;
    const target = armed;
    clearTimeout(target.timer);
    const token = target.token;
    armed = null;
    if (claimed) {
      const scope = claimed.scope;
      failedClaims.set(scope, reason);
      if (activeSaveCorrelations.get(scope.correlationKey) === scope) {
        refusedScopes.add(scope);
      }
      claimed = null;
    } else {
      // A Save IPC may already be in flight even though main has not seen it.
      // No finite grace period can prove that such an IPC will never arrive.
      // Keep one epoch-scoped refusal until a new ready renderer generation
      // makes every request from this page fail captureSaveScope().
      unclaimedRefusal = Object.freeze({
        token,
        reason,
        path: target.path,
        pathKey: target.pathKey,
        requestId: target.requestId,
        pageSession: target.pageSession,
        rendererGeneration: target.rendererGeneration,
        epochGeneration: target.epochGeneration,
        epochPageSession: target.epochPageSession,
      });
    }
    lastEnd = Object.freeze({ token, reason });
    notifyWaiter(new Error(`Save gate ${reason}`));
  }

  function finish(reason) {
    if (!held) return null;
    const current = held;
    held = null;
    clearTimeout(current.timer);
    lastEnd = Object.freeze({ token: current.token, reason });
    if (reason === "released") {
      current.resolve();
    } else {
      if (
        activeSaveCorrelations.get(current.scope.correlationKey) ===
        current.scope
      ) {
        refusedScopes.add(current.scope);
      }
      current.reject(new Error(`Save gate ${reason}; the save was not written`));
    }
    return summary(current);
  }

  function arm(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Save gate arm requires options");
    }
    if (unclaimedRefusal) {
      throw new Error(
        "Save gate has an unclaimed refusal; retire it after a new ready renderer generation",
      );
    }
    if (armed || claimed || held) {
      throw new Error("Save gate is already armed or held");
    }
    if (
      approvalRendererState !== "ready" ||
      !Number.isSafeInteger(approvalRendererGeneration) ||
      approvalRendererGeneration < 1 ||
      typeof approvalRendererPageSession !== "string" ||
      !approvalRendererPageSession
    ) {
      throw new Error("Save gate requires a ready renderer page");
    }
    const path = selector(options.path, "path");
    const pathKey = selector(options.pathKey, "pathKey");
    if (!path && !pathKey) {
      throw new Error("Save gate requires path or pathKey");
    }
    const pageSession = selector(options.pageSession, "pageSession");
    const requestId = options.requestId;
    if (requestId !== undefined && !validSaveRequestId(requestId)) {
      throw new Error("Save gate requestId is invalid");
    }
    const rendererGeneration = options.rendererGeneration;
    if (
      rendererGeneration !== undefined &&
      (!Number.isSafeInteger(rendererGeneration) || rendererGeneration < 1)
    ) {
      throw new Error("Save gate rendererGeneration is invalid");
    }
    if (
      (pageSession !== null &&
        pageSession !== approvalRendererPageSession) ||
      (rendererGeneration !== undefined &&
        rendererGeneration !== approvalRendererGeneration)
    ) {
      throw new Error("Save gate selectors must name the current renderer page");
    }
    const armMs = milliseconds(options.armMs, "armMs", 10000);
    const holdMs = milliseconds(options.holdMs, "holdMs", 10000);
    const token = ++nextToken;
    const entry = {
      token, path, pathKey, pageSession, requestId, rendererGeneration,
      epochGeneration: approvalRendererGeneration,
      epochPageSession: approvalRendererPageSession,
      holdMs, timer: null,
    };
    armed = entry;
    entry.timer = setTimeout(() => {
      if (armed === entry) disarm("arm timed out");
    }, armMs);
    entry.timer.unref?.();
    return token;
  }

  function waitForHold(token, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return Promise.reject(new Error("Save gate wait requires options"));
    }
    let timeoutMs;
    try {
      timeoutMs = milliseconds(options.timeoutMs, "timeoutMs", 10000);
    } catch (error) {
      return Promise.reject(error);
    }
    if (held && held.token === token) return Promise.resolve(summary(held));
    if (!armed || armed.token !== token) {
      const reason = lastEnd && lastEnd.token === token
        ? lastEnd.reason
        : "token is not armed";
      return Promise.reject(new Error(`Save gate ${reason}`));
    }
    if (waiter) return Promise.reject(new Error("Save gate already has a waiter"));
    return new Promise((resolve, reject) => {
      const current = { resolve, reject, timer: null };
      waiter = current;
      current.timer = setTimeout(() => {
        if (waiter === current) disarm("wait timed out");
      }, timeoutMs);
      current.timer.unref?.();
    });
  }

  function matches(target, scope) {
    return !!scope &&
      activeSaveCorrelations.get(scope.correlationKey) === scope &&
      target.epochGeneration === scope.rendererGeneration &&
      target.epochPageSession === scope.pageSession &&
      (target.path === null || target.path === scope.path) &&
      (target.pathKey === null || target.pathKey === scope.owner.pathKey) &&
      (target.requestId === undefined ||
        target.requestId === scope.requestId) &&
      (target.pageSession === null ||
        target.pageSession === scope.pageSession) &&
      (target.rendererGeneration === undefined ||
        target.rendererGeneration === scope.rendererGeneration);
  }

  // Bind the target before queueing; only enter() pauses it. An expired arm
  // cannot let a previously accepted, still-queued Save write unobserved.
  function claim(scope) {
    if (unclaimedRefusal && matches(unclaimedRefusal, scope)) {
      failedClaims.set(scope, unclaimedRefusal.reason);
      refusedScopes.add(scope);
      return;
    }
    if (!armed || claimed || !matches(armed, scope)) return;
    const target = armed;
    claimed = { token: target.token, scope };
  }

  function enter(scope) {
    if (failedClaims.has(scope)) {
      const reason = failedClaims.get(scope);
      failedClaims.delete(scope);
      throw new Error(`Save gate ${reason}; the save was not written`);
    }
    if (!claimed || claimed.scope !== scope) return null;
    const target = armed;
    claimed = null;
    if (!target) {
      throw new Error("Save gate expired before its queued save could run");
    }
    clearTimeout(target.timer);
    armed = null;
    const promise = new Promise((resolve, reject) => {
      held = {
        token: target.token, scope, resolve, reject, timer: null,
      };
    });
    const current = held;
    current.timer = setTimeout(() => {
      if (held === current) finish("hold timed out");
    }, target.holdMs);
    current.timer.unref?.();
    notifyWaiter(null, summary(current));
    return promise;
  }

  function release(token) {
    if (!held || held.token !== token) {
      throw new Error("Save gate release token is not held");
    }
    return finish("released");
  }

  function cancel(token) {
    if (armed && armed.token === token) {
      disarm("cancelled");
      return;
    }
    if (held && held.token === token) {
      finish("cancelled");
      return;
    }
    throw new Error("Save gate cancel token is not active");
  }

  function dispose() {
    disarm("reset");
    finish("reset");
  }

  function retire(token) {
    if (!unclaimedRefusal || unclaimedRefusal.token !== token) {
      throw new Error("Save gate has no matching unclaimed refusal to retire");
    }
    if (
      approvalRendererState !== "ready" ||
      approvalRendererGeneration === unclaimedRefusal.epochGeneration ||
      typeof approvalRendererPageSession !== "string" ||
      !approvalRendererPageSession
    ) {
      throw new Error(
        "Save gate refusal cannot retire until a new renderer generation is ready",
      );
    }
    unclaimedRefusal = null;
    return true;
  }

  function stillCorrelated(scope) {
    const key = scope.correlationKey;
    const delivery = pendingSaveOutcomeDeliveries.get(key);
    return activeSaveCorrelations.get(key) === scope &&
      (!delivery || delivery.scope === scope);
  }

  function correlatedRefusals() {
    const result = [];
    for (const scope of refusedScopes) {
      if (!stillCorrelated(scope)) {
        refusedScopes.delete(scope);
        continue;
      }
      result.push({
        key: scope.correlationKey,
        scope,
        delivery: pendingSaveOutcomeDeliveries.get(scope.correlationKey),
      });
    }
    return result;
  }

  return Object.freeze({
    arm, waitForHold, release, cancel, retire, claim, enter, dispose,
    correlatedRefusals,
    forget: (scope) => {
      if (claimed && claimed.scope === scope) disarm("save abandoned");
      failedClaims.delete(scope);
      refusedScopes.delete(scope);
    },
    refused: (scope) => refusedScopes.has(scope),
    state: () => Object.freeze({
      armedToken: armed ? armed.token : null,
      claimed: claimed ? summary(claimed) : null,
      held: summary(held),
      lastEnd,
      unclaimedRefusal,
      refusedOutcomeCount: Array.from(refusedScopes).filter(stillCorrelated).length,
    }),
  });
})();

function validSaveRequestId(value) {
  return (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      !value.includes("\0"))
  );
}

function saveCorrelationKey(owner, requestId) {
  return owner
    ? `${documentOwnerKey(owner)}\0${typeof requestId}:${String(requestId)}`
    : null;
}

function clearSaveOutcomeDeliveryAttempt(record) {
  if (!record) return;
  if (record.ackTimeout) clearTimeout(record.ackTimeout);
  if (record.retryTimeout) clearTimeout(record.retryTimeout);
  record.ackTimeout = null;
  record.retryTimeout = null;
  record.inFlight = false;
}

function releaseSaveOutcomeDelivery(record) {
  if (!record) return false;
  clearSaveOutcomeDeliveryAttempt(record);
  pendingSaveOutcomeDeliveries.delete(record.key);
  activeSaveCorrelations.delete(record.key);
  liveSaveGate?.forget(record.scope);
  return true;
}

function scheduleSaveOutcomeRetry(record, delay = null) {
  if (
    !record ||
    record.inFlight ||
    record.retryTimeout ||
    pendingSaveOutcomeDeliveries.get(record.key) !== record
  ) {
    return false;
  }
  const requestedDelay =
    Number.isFinite(delay) && delay > 0
      ? delay
      : SAVE_OUTCOME_RETRY_DELAY_MS *
        (2 ** Math.max(0, record.attempt - 1));
  const boundedDelay = Math.max(
    SAVE_OUTCOME_RETRY_DELAY_MS,
    Math.min(SAVE_OUTCOME_MAX_RETRY_DELAY_MS, requestedDelay),
  );
  record.retryTimeout = setTimeout(() => {
    record.retryTimeout = null;
    deliverSaveOutcome(record);
  }, boundedDelay);
  record.retryTimeout.unref?.();
  return true;
}

function deliverSaveOutcome(record) {
  if (
    !record ||
    record.inFlight ||
    pendingSaveOutcomeDeliveries.get(record.key) !== record
  ) {
    return false;
  }
  // The payload was already shaped against the scope state when it was queued.
  // The only question left here is whether the page it is addressed to can
  // still be reached; a page that can be reached is one that is still waiting.
  if (saveScopeUnreachableWhy(record.scope)) {
    releaseSaveOutcomeDelivery(record);
    return false;
  }
  if (record.payload.success === true &&
      saveScopeQuarantined(record.scope)) {
    record.payload = Object.freeze({
      ...record.payload,
      success: false,
      conflict: true,
      settlementOnly: false,
      error:
        "The document was quarantined before its Save result was delivered. Review the conflict before saving.",
    });
  }
  if (shutdownCommitIngressBlocked) {
    scheduleSaveOutcomeRetry(record);
    return false;
  }
  const target = record.scope.sender;
  record.inFlight = true;
  record.attempt += 1;
  const attempt = record.attempt;
  try {
    target.send("save-markdown-result", {
      ...record.payload,
      saveResultAttempt: attempt,
    });
  } catch (error) {
    if (pendingSaveOutcomeDeliveries.get(record.key) !== record) {
      return true;
    }
    record.inFlight = false;
    record.lastSendError =
      error && error.message ? error.message : String(error);
    scheduleSaveOutcomeRetry(record);
    return false;
  }
  if (
    pendingSaveOutcomeDeliveries.get(record.key) !== record ||
    !record.inFlight ||
    record.attempt !== attempt
  ) {
    return true;
  }
  record.lastSendError = null;
  record.ackTimeout = setTimeout(() => {
    if (
      pendingSaveOutcomeDeliveries.get(record.key) !== record ||
      !record.inFlight ||
      record.attempt !== attempt
    ) {
      return;
    }
    record.ackTimeout = null;
    record.inFlight = false;
    scheduleSaveOutcomeRetry(record);
  }, SAVE_OUTCOME_ACK_TIMEOUT_MS);
  record.ackTimeout.unref?.();
  return true;
}

function queueSaveOutcomeDelivery(scope, payload) {
  if (!scope || !scope.correlationKey) return false;
  let record = pendingSaveOutcomeDeliveries.get(scope.correlationKey);
  if (!record) {
    record = {
      key: scope.correlationKey,
      scope,
      payload: Object.freeze({ ...payload }),
      attempt: 0,
      inFlight: false,
      ackTimeout: null,
      retryTimeout: null,
      lastSendError: null,
    };
    pendingSaveOutcomeDeliveries.set(scope.correlationKey, record);
  }
  deliverSaveOutcome(record);
  return true;
}

function captureSaveScope(event, data, filePath) {
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data !== "object" ||
    data.saveRequestSession !== approvalRendererPageSession
  ) {
    return null;
  }
  const request = data.saveRequest;
  const owner = normaliseDocumentOwner(request, filePath);
  if (
    !owner ||
    owner.pageSession !== data.saveRequestSession ||
    owner.rendererGeneration !== approvalRendererGeneration ||
    !validSaveRequestId(data.requestId) ||
    request.requestId !== data.requestId ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence <= 0 ||
    !sameDocumentSelectionOwner(owner, watchedOwner) ||
    !isKnownDocumentOwner(owner)
  ) {
    return null;
  }
  const sender = event.sender;
  const frame = event.senderFrame;
  if (
    !frame ||
    !Number.isSafeInteger(frame.frameTreeNodeId) ||
    frame.frameTreeNodeId <= 0
  ) {
    return null;
  }
  return Object.freeze({
    sender,
    frame,
    frameTreeNodeId: frame.frameTreeNodeId,
    rendererGeneration: approvalRendererGeneration,
    pageSession: approvalRendererPageSession,
    owner,
    requestId: data.requestId,
    sequence: request.sequence,
    path: filePath,
    correlationKey: saveCorrelationKey(owner, data.requestId),
    lifecycleEpoch: saveLifecycleEpoch,
  });
}

// WHETHER THE PAGE CAN STILL BE TOLD. That is a different question from
// whether it may still be trusted to authorize new work, and conflating the
// two is what strands a renderer.
//
// `approvalRendererState` is demoted to "unusable" for a page that is still
// loaded, still owns the window, still has its listener attached and is still
// holding a promise for every save it sent. `invalidatedSaveScopes` likewise
// marks a save whose DOCUMENT generation was replaced by an ordinary reload -
// the page issuing it never went anywhere. Dropping a terminal result in
// either case leaves that promise unsettled for the life of the page, which
// blocks close and quit, holds watching off, and eventually exhausts the
// correlation table. Only a destroyed sender, a replaced page session or
// generation, a replaced window or a replaced frame actually removes the
// listener the result is addressed to.
function saveScopeUnreachableWhy(scope) {
  if (!scope || !scope.sender) return "renderer-replaced";
  if (scope.sender.isDestroyed()) return "sender-destroyed";
  if (
    approvalRendererGeneration !== scope.rendererGeneration ||
    approvalRendererPageSession !== scope.pageSession
  ) {
    return "renderer-replaced";
  }
  const owner = shutdownOwnerWindow();
  if (!owner || owner.webContents !== scope.sender) return "window-replaced";
  try {
    const mainFrame = scope.sender.mainFrame;
    if (
      !scope.frame ||
      scope.frame.isDestroyed() ||
      !mainFrame ||
      mainFrame.isDestroyed() ||
      (mainFrame !== scope.frame &&
        mainFrame.frameTreeNodeId !== scope.frameTreeNodeId)
    ) {
      return "frame-replaced";
    }
  } catch {
    return "frame-replaced";
  }
  return null;
}

function saveScopeQuarantined(scope) {
  return quarantinedSaveScopes.has(scope) ||
    quarantinedDocumentOwners.has(documentOwnerKey(scope.owner));
}

// DELIBERATELY NOT PART OF `saveScopeState`. `sendSaveResult` consults that
// function to shape a payload for delivery, and `__shutdown.reset` retains the
// gate's refused correlations precisely so their refusal - which settles on a
// later microtask, after reset has returned - still reaches the renderer with
// the words the gate gave it. Folding the epoch in there would rewrite those
// refusals into generic staleness. The epoch's job is narrower and harder:
// stop a queued save from WRITING, which is what the stages below check.
function saveScopeLifecycleExpired(scope) {
  return !scope || scope.lifecycleEpoch !== saveLifecycleEpoch;
}

function saveScopeState(scope, { allowMissingPath = false } = {}) {
  const unreachableWhy = saveScopeUnreachableWhy(scope);
  if (unreachableWhy) return unreachableWhy;
  if (
    approvalRendererState !== "ready" ||
    !validSaveRequestId(scope.requestId) ||
    !Number.isSafeInteger(scope.sequence) ||
    scope.sequence <= 0
  ) {
    return "renderer-replaced";
  }
  // A reload replaced the document this save was issued for. The page is still
  // there and still waiting, so this is the same class of failure as an owner
  // replaced in the table below: reported as a settlement, never dropped.
  if (saveScopeQuarantined(scope)) return "document-quarantined";
  if (invalidatedSaveScopes.has(scope)) return "document-replaced";
  const currentOwnerKey = documentOwnerKey(scope.owner);
  const currentOwner = knownDocumentOwners.get(currentOwnerKey);
  if (
    !currentOwner ||
    // Retained past its supersession so its facts survive, but no longer the
    // authority for anything. Read exactly like an owner that was collected.
    supersededDocumentOwners.has(currentOwnerKey) ||
    !sameDocumentOwner(currentOwner, scope.owner) ||
    currentOwner.rendererGeneration !== approvalRendererGeneration ||
    currentOwner.pageSession !== approvalRendererPageSession
  ) {
    return "document-replaced";
  }
  const currentKey = resolveCanonicalFileKey(scope.path);
  if (!currentKey) {
    try {
      if (fs.lstatSync(scope.path).isSymbolicLink()) return null;
    } catch {
      // The save path validation below owns the missing-path decision.
    }
    if (allowMissingPath) return null;
    return "path-replaced";
  }
  if (currentKey !== scope.owner.pathKey) {
    return "path-replaced";
  }
  return null;
}

async function openedHandleMatchesPath(filePath, handle) {
  try {
    const [pathStats, handleStats] = await Promise.all([
      fs.promises.stat(filePath),
      handle.stat(),
    ]);
    return !!(
      pathStats.isFile() &&
      handleStats.isFile() &&
      pathStats.dev === handleStats.dev &&
      pathStats.ino === handleStats.ino
    );
  } catch {
    return false;
  }
}

function queueSave(filePath, run) {
  const saveKey = canonicalFileKey(filePath) || filePath;
  const targetRevision = saveTargetRevision(saveKey);
  targetRevision.revision += 1;
  const prior = saveQueues.get(saveKey) || Promise.resolve();
  saveQueueEnqueuedCount += 1;
  saveQueuePendingCount += 1;
  const execute = async () => {
    const activeForKey = (activeSaveRunsByKey.get(saveKey) || 0) + 1;
    activeSaveRunsByKey.set(saveKey, activeForKey);
    saveQueueStartedCount += 1;
    saveQueueMaxActiveForSinglePath = Math.max(
      saveQueueMaxActiveForSinglePath,
      activeForKey,
    );
    if (activeForKey > 1) saveQueueOverlapCount += 1;
    try {
      return await run(saveKey);
    } finally {
      targetRevision.revision += 1;
      const remaining = (activeSaveRunsByKey.get(saveKey) || 1) - 1;
      if (remaining > 0) activeSaveRunsByKey.set(saveKey, remaining);
      else activeSaveRunsByKey.delete(saveKey);
      saveQueueCompletedCount += 1;
      saveQueuePendingCount -= 1;
      if (saveQueuePendingCount === 0) {
        reconsiderShutdownAfterSaveSettlement();
      }
    }
  };
  const next = prior.then(execute, execute);
  saveQueues.set(saveKey, next);
  next.finally(() => {
    if (saveQueues.get(saveKey) === next) saveQueues.delete(saveKey);
    releaseSaveTargetRevision(saveKey, targetRevision);
  });
  return next;
}

ipcMain.handle("read-open-ticket-snapshot", async (event, data) => {
  if (!isApprovalSender(event) || approvalRendererState !== "ready" ||
      typeof data?.openTicket !== "string") return null;
  const record = Array.from(documentAdmissions.values()).find(candidate =>
    candidate.openTicket === data.openTicket);
  if (!record || record.ticketUsed || !admissionIsCurrent(record) ||
      record.sender !== event.sender ||
      record.frameTreeNodeId !== event.senderFrame.frameTreeNodeId) return null;
  record.ticketUsed = true;
  const current = () => admissionIsCurrent(record) &&
    record.openEpoch === fileOpenDeliveryEpoch &&
    approvalRendererState === "ready";
  const key = record.descriptor.pathKey;
  const targetRevision = saveTargetRevision(key);
  targetRevision.readers += 1;
  try {
  for (let attempt = 0; attempt < MAX_STABLE_FILE_READ_ATTEMPTS; attempt += 1) {
    if (!current()) return null;
    const tail = saveQueues.get(key);
    if (tail) await tail;
    if (!current()) return null;
    const nextTail = saveQueues.get(key);
    if (nextTail && nextTail !== tail) continue;
    const revision = targetRevision.revision;
    const snapshot = await markdownSnapshotPromise(
      record.descriptor.logicalPath, record.descriptor.readTarget,
    );
    if (!current()) return null;
    if (saveQueues.get(key) || revision !== targetRevision.revision) continue;
    record.snapshotVersion = snapshot.diskVersion;
    return { content: snapshot.content, modifiedTime: snapshot.modifiedTime,
      diskVersion: snapshot.diskVersion, document: record.descriptor };
  }
  return null;
  } finally {
    targetRevision.readers -= 1;
    releaseSaveTargetRevision(key, targetRevision);
  }
});

function reconsiderShutdownAfterSaveSettlement() {
  setImmediate(() => {
    const record = pendingShutdown;
    if (
      !record ||
      record.asked ||
      !record.waitingForPendingSaves ||
      saveQueuePendingCount !== 0
    ) {
      return;
    }
    if (record.fallbackCause) {
      record.waitingForPendingSaves = false;
      askFallbackApproval(record, record.fallbackCause);
      return;
    }
    if (approvalRendererState === "ready") {
      record.waitingForPendingSaves = false;
      dispatchShutdownRequest(record);
      return;
    }
    record.waitingForPendingSaves = false;
    askFallbackApproval(record, "unresponsive");
  });
}

function conflictsWithDocumentBaseline(
  filePath,
  stats,
  { missing = false, owner = null } = {},
) {
  const spelling = filePathSpellingKey(filePath);
  const key = canonicalFileKey(filePath);
  if (!key) return true;
  if (quarantinedDocumentOwners.has(documentOwnerKey(owner))) return true;
  if (missing) return false;
  const currentKey = resolveCanonicalFileKey(filePath);
  if (!currentKey || currentKey !== key) {
    if (spelling) addPathUnadoptedChange(spelling);
    return true;
  }
  const ownerBaseline = ownerDocumentBaselines.get(documentOwnerKey(owner));
  if (owner && !ownerBaseline) return true;
  if (ownerBaseline) {
    if (ownerBaseline.owner.pathKey !== key || !stats) return true;
    if (ownerBaseline.version) {
      // A different tab may have changed the shared watcher baseline. Its
      // newer version cannot stand in for this owner's older cached bytes.
      return diskVersionChanged(
        ownerBaseline.version,
        diskVersionFromStats(stats),
      );
    }
    if (!Number.isFinite(ownerBaseline.modifiedTime)) return true;
    if (
      documentsWithUnadoptedChanges.has(key) ||
      (spelling && pathsWithUnadoptedChanges.has(spelling))
    ) return true;
    return stats.mtimeMs !== ownerBaseline.modifiedTime;
  }
  if (
    documentsWithUnadoptedChanges.has(key) ||
    (spelling && pathsWithUnadoptedChanges.has(spelling))
  ) return true;
  const modifiedTime = documentModifiedTimes.get(key);
  if (!Number.isFinite(modifiedTime)) return false;
  if (!stats || stats.mtimeMs !== modifiedTime) return true;
  const version = documentVersions.get(key);
  return !!version && diskVersionChanged(version, diskVersionFromStats(stats));
}

class SaveConflictError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = "SaveConflictError";
    if (cause) this.cause = cause;
  }
}

function danglingSymlinkSaveError(filePath) {
  return new SaveConflictError(
    `Cannot save through a symbolic link whose target is missing: ${filePath}`,
  );
}

function savePathRaceError(cause = null) {
  return new SaveConflictError(
    "The file changed while the save was starting. Reload or reopen it before saving.",
    cause,
  );
}

function saveCompletionConflictError(cause = null) {
  return new SaveConflictError(
    "The file changed while the save was completing. Reload or reopen it before saving again.",
    cause,
  );
}

// A KNOWN DELETION IS NOT AN EMPTY SLOT. Recreating a file that something
// outside Folia deleted is a decision, not a detail of writing: the write also
// clears the only evidence that the deletion ever happened, so a reader who
// never saw the warning ends up with a resurrected file and nothing to say it
// was gone. Refused here rather than after the handle exists - `wx+` CREATES
// the file, so a refusal any later would leave an empty one behind.
function deletedDocumentSaveError(filePath) {
  const error = new SaveConflictError(
    `The file was deleted outside Folia and has not been restored: ${filePath}`,
  );
  error.deletedDocument = true;
  return error;
}

function documentHasSaveBaseline(filePath, owner = null) {
  const key = canonicalFileKey(filePath);
  const ownerBaseline = ownerDocumentBaselines.get(documentOwnerKey(owner));
  return !!(
    key &&
    ((ownerBaseline &&
      (ownerBaseline.version ||
        Number.isFinite(ownerBaseline.modifiedTime))) ||
      documentModifiedTimes.has(key) ||
      documentVersions.has(key) ||
      documentsWithUnadoptedChanges.has(key) ||
      pathKeyHasDeletionEvidence(key))
  );
}

async function openDocumentForSave(filePath, { allowCreate = true } = {}) {
  try {
    return {
      handle: await fs.promises.open(filePath, "r+"),
      created: false,
    };
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }

  let pathStats = null;
  try {
    pathStats = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  if (pathStats) {
    if (pathStats.isSymbolicLink()) {
      throw danglingSymlinkSaveError(filePath);
    }
    throw savePathRaceError();
  }

  if (!allowCreate) throw deletedDocumentSaveError(filePath);

  let handle;
  try {
    // No event-loop turn between the latch check and the exclusive create.
    if (deletionEvidenceCapacityLatched) throw savePathRaceError();
    const fd = fs.openSync(filePath, "wx+");
    handle = {
      fd,
      stat: async () => fs.fstatSync(fd),
      close: async () => fs.closeSync(fd),
    };
  } catch (error) {
    if (error.code === "EEXIST") {
      let racedStats = null;
      try {
        racedStats = await fs.promises.lstat(filePath);
      } catch (lstatError) {
        if (lstatError.code !== "ENOENT" && lstatError.code !== "ENOTDIR") {
          throw savePathRaceError(lstatError);
        }
      }
      if (racedStats && racedStats.isSymbolicLink()) {
        throw danglingSymlinkSaveError(filePath);
      }
      throw savePathRaceError(error);
    }
    throw error;
  }

  try {
    const finalStats = await fs.promises.lstat(filePath);
    const openedStats = await handle.stat();
    if (
      !finalStats.isFile() ||
      !openedStats.isFile() ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino
    ) {
      if (finalStats.isSymbolicLink()) {
        throw danglingSymlinkSaveError(filePath);
      }
      throw savePathRaceError();
    }
    if (deletionEvidenceCapacityLatched) throw savePathRaceError();
    return {
      handle,
      created: true,
    };
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      console.error("Error closing rejected file after save open:", closeError);
    }
    if (error instanceof SaveConflictError) throw error;
    throw savePathRaceError(error);
  }
}

async function readStableRawSnapshot(filePath) {
  for (let attempt = 1; attempt <= MAX_STABLE_FILE_READ_ATTEMPTS; attempt += 1) {
    try {
      const before = await fs.promises.stat(filePath);
      if (!before.isFile()) {
        throw saveCompletionConflictError();
      }
      const content = await fs.promises.readFile(filePath, "utf8");
      const after = await fs.promises.stat(filePath);
      if (!after.isFile()) {
        throw saveCompletionConflictError();
      }
      if (sameDiskVersion(before, after)) {
        return Object.freeze({
          content,
          stats: after,
        });
      }
    } catch (error) {
      if (error instanceof SaveConflictError) throw error;
      throw saveCompletionConflictError(error);
    }
  }
  throw saveCompletionConflictError();
}

// WHAT THE LATCH OWES THE READER. A Save refused because deletion evidence was
// lost is correlated to the exact request that asked for it and is shaped as an
// ordinary Save FAILURE - never a success, never a settlement-only drop the
// renderer would swallow. The renderer keeps its in-memory copy, marks the
// document failed and conflicted, and shows this text; the machine-readable
// `saveBlocked` reason names the cause for anything reading the payload.
const DELETION_EVIDENCE_CAPACITY_SAVE_ERROR =
  "Folia can no longer prove which documents were deleted - its in-memory " +
  "record of deletions is full - so it refuses to write any file rather " +
  "than risk recreating a document you deleted. Saving stays blocked for " +
  "every document until Folia is restarted. Copy your unsaved changes " +
  "somewhere else before closing this window.";

// The stale-owner fence's version of the same refusal. Named for what was
// actually lost, so the reader is not told a deletion record filled up when
// the fact that went missing was which document their tab has moved on to.
const DOCUMENT_OWNER_FENCE_SAVE_ERROR =
  "Folia can no longer prove which document this tab has moved on to - its " +
  "in-memory record of replaced documents is full - so it refuses to write " +
  "any file rather than risk writing an older version of a document over a " +
  "newer one. Saving stays blocked for every document until Folia is " +
  "restarted. Copy your unsaved changes somewhere else before closing this " +
  "window.";

let saveAuthorityLatchSaveError = DELETION_EVIDENCE_CAPACITY_SAVE_ERROR;

function refuseSaveForDeletionEvidenceCapacity(
  sendSaveResult,
  filePath,
  requestId,
  stage,
) {
  noteDeletionEvidenceCapacityRefusal();
  sendSaveResult({
    success: false,
    conflict: true,
    saveBlocked: saveAuthorityLatchReason,
    saveBlockedStage: stage,
    saveBlockedWhy: deletionEvidenceCapacityLatchWhy,
    error: saveAuthorityLatchSaveError,
    path: filePath,
    requestId,
  });
}

ipcMain.on("save-markdown-file", (event, data) => {
  if (!isApprovalSender(event)) return;
  const replyTarget = event.sender;
  const saveRequestSession = data && data.saveRequestSession;
  const saveRequest = data && data.saveRequest;
  let saveScope = null;
  const sendSaveResult = (result) => {
    let outgoing = result;
    if (saveScope) {
      // THE ONLY REASON TO DROP A TERMINAL RESULT is that there is nobody left
      // to hand it to. Every other failure - a distrusted renderer, a replaced
      // document generation, an evicted owner - still has a page waiting on a
      // promise, and that page is told.
      if (saveScopeUnreachableWhy(saveScope)) return false;
      const staleWhy = saveScopeState(saveScope, {
        allowMissingPath: result && result.deleted === true,
      });
      if (staleWhy) {
        if (staleWhy === "path-replaced") {
          if (result && result.conflict === true) {
            outgoing = {
              ...result,
              pathReplaced: true,
              originalPathKey: saveScope.owner.pathKey,
            };
          } else {
            const { settlementOnly: _settlementOnly, ...authorisedResult } =
              result;
            outgoing = {
              ...authorisedResult,
              success: false,
              conflict: true,
              pathReplaced: true,
              originalPathKey: saveScope.owner.pathKey,
              error:
                "The file path identity changed before the save result was delivered. Reload or reopen it before saving.",
            };
          }
        } else if (staleWhy === "document-quarantined") {
          outgoing = {
            ...result,
            success: false,
            conflict: true,
            settlementOnly: false,
            error:
              "The document was quarantined during Save. Its in-memory copy was kept; review the conflict before saving.",
          };
        } else {
          outgoing = {
            ...result,
            success: false,
            settlementOnly: true,
            error: `Save result became stale before delivery (${staleWhy})`,
          };
        }
        if (liveSaveGate?.refused(saveScope) && result.success === false) {
          outgoing = {
            ...outgoing,
            error: `${result.error}; ${outgoing.error}`,
          };
        }
      }
    }
    const payload = {
      ...outgoing,
      saveRequestSession,
      saveRequest,
    };
    if (
      saveScope &&
      saveScope.correlationKey &&
      activeSaveCorrelations.get(saveScope.correlationKey) === saveScope
    ) {
      return queueSaveOutcomeDelivery(saveScope, payload);
    }
    if (!replyTarget || replyTarget.isDestroyed()) return false;
    try {
      replyTarget.send("save-markdown-result", {
        ...outgoing,
        saveRequestSession,
        saveRequest,
      });
      return true;
    } catch (error) {
      console.error("Error delivering save result:", error);
      return false;
    }
  };
  const sendSaveScopeFailure = (why, stage, filePath, requestId) => {
    if (why === "document-quarantined") {
      sendSaveResult({
        success: false,
        conflict: true,
        error:
          `The document was quarantined ${stage}. Review its conflict before saving.`,
        path: filePath, requestId,
      });
      return;
    }
    if (why === "path-replaced") {
      sendSaveResult({
        success: false,
        conflict: true,
        pathReplaced: true,
        originalPathKey: saveScope.owner.pathKey,
        error: `The file path identity changed ${stage}. Reload or reopen it before saving.`,
        path: filePath,
        requestId,
      });
      return;
    }
    sendSaveResult({
      success: false,
      settlementOnly: true,
      error: `Save authorization expired ${stage} (${why})`,
      path: filePath,
      requestId,
    });
  };
  try {
    const { filePath, content, requestId } = data;
    // Writes are asynchronous and several can be in flight at once, so every
    // reply - including the failures - has to carry enough identity for the
    // renderer to match it to the request that produced it. Without this the
    // renderer cannot tell which document was written, and a save for a
    // background tab gets applied to whatever the user is looking at now.

    if (
      typeof filePath !== "string" ||
      filePath.length === 0 ||
      filePath.includes("\0")
    ) {
      sendSaveResult({
        success: false,
        error: "Invalid file path",
        path: typeof filePath === "string" ? filePath : null,
        requestId: requestId,
      });
      return;
    }
    saveScope = captureSaveScope(event, data, filePath);
    const saveOwner = saveScope && saveScope.owner;
    if (
      typeof content !== "string" ||
      !saveScope
    ) {
      sendSaveResult({
        success: false,
        settlementOnly: true,
        error: "Save request identity is invalid",
        path: filePath,
        requestId,
      });
      return;
    }
    if (
      !saveScope.correlationKey ||
      activeSaveCorrelations.has(saveScope.correlationKey)
    ) {
      return;
    }
    // INGRESS. Refused before the sequence is accepted, before the correlation
    // is registered and before the gate is claimed, so a blocked Save consumes
    // nothing the reader's next attempt would need. The refusal carries this
    // request's requestId, saveRequestSession, saveRequest and path, so the
    // renderer settles the promise it is actually holding.
    if (deletionEvidenceCapacityLatched) {
      refuseSaveForDeletionEvidenceCapacity(
        sendSaveResult,
        filePath,
        requestId,
        "ingress",
      );
      return;
    }
    const saveDocumentKey = documentOwnerKey(saveOwner);
    const latestAcceptedSequence =
      latestAcceptedSaveSequenceByDocument.get(saveDocumentKey) || 0;
    if (saveScope.sequence <= latestAcceptedSequence) {
      sendSaveResult({
        success: false,
        settlementOnly: true,
        error: "Save request sequence is stale",
        path: filePath,
        requestId,
      });
      return;
    }
    if (activeSaveCorrelations.size >= MAX_ACTIVE_SAVE_CORRELATIONS) {
      sendSaveResult({
        success: false,
        error: "Too many save requests are awaiting settlement",
        path: filePath,
        requestId,
      });
      return;
    }
    latestAcceptedSaveSequenceByDocument.set(
      saveDocumentKey,
      saveScope.sequence,
    );
    activeSaveCorrelations.set(saveScope.correlationKey, saveScope);
    liveSaveGate?.claim(saveScope);

    // Open first, then compare the opened object to the document baseline.
    // Atomic replacement after the open moves the path to a different inode;
    // this handle writes only the displaced object, and the post-write stable
    // read below reports the replacement as a conflict instead of overwriting
    // it through a second path lookup.
    queueSave(filePath, async (queuedSaveKey) => {
      let opened;
      let verification = null;
      try {
        if (liveSaveGate) {
          const hold = liveSaveGate.enter(saveScope);
          if (hold) await hold;
        }
        const queuedIdentityFailure = saveScopeState(saveScope, {
          allowMissingPath: true,
        });
        if (queuedIdentityFailure) {
          sendSaveScopeFailure(
            queuedIdentityFailure,
            "while queued",
            filePath,
            requestId,
          );
          return;
        }
        // BEFORE ANYTHING TOUCHES THE FILESYSTEM. The save was accepted in a
        // lifecycle that has since been torn down, so it may not act on the
        // state that replaced it.
        if (saveScopeLifecycleExpired(saveScope)) {
          sendSaveScopeFailure(
            "lifecycle-reset",
            "while queued",
            filePath,
            requestId,
          );
          return;
        }
        const currentSaveKey = canonicalFileKey(filePath) || filePath;
        if (currentSaveKey !== queuedSaveKey) {
          markDocumentChangedExternally(filePath);
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file target changed while the save was queued. Reload or reopen it before saving.",
            path: filePath,
            requestId: requestId,
          });
          return;
        }
        const hadBaseline = documentHasSaveBaseline(filePath, saveOwner);
        if (documentDeletionUnresolved(filePath, saveOwner)) {
          throw deletedDocumentSaveError(filePath);
        }
        let missingBeforeOpen = false;
        try {
          await fs.promises.lstat(filePath);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          missingBeforeOpen = true;
        }
        if (missingBeforeOpen && hadBaseline) {
          if (saveOwner) openDeletionDelivery(filePath, saveOwner);
          throw deletedDocumentSaveError(filePath);
        }
        const preOpenIdentityFailure = saveScopeState(saveScope, {
          allowMissingPath: true,
        });
        if (preOpenIdentityFailure) {
          sendSaveScopeFailure(
            preOpenIdentityFailure,
            "before open",
            filePath,
            requestId,
          );
          return;
        }
        if (documentDeletionUnresolved(filePath, saveOwner)) {
          throw deletedDocumentSaveError(filePath);
        }
        // BEFORE THE OPEN. `openDocumentForSave` may CREATE the file when this
        // document has no baseline, which is itself a write; a latch that
        // tripped while this save sat in the queue must stop it here.
        if (deletionEvidenceCapacityLatched) {
          refuseSaveForDeletionEvidenceCapacity(
            sendSaveResult,
            filePath,
            requestId,
            "before-open",
          );
          return;
        }
        if (saveScopeLifecycleExpired(saveScope)) {
          sendSaveScopeFailure(
            "lifecycle-reset",
            "before open",
            filePath,
            requestId,
          );
          return;
        }
        try {
          opened = await openDocumentForSave(filePath, {
            allowCreate: !hadBaseline,
          });
        } catch (error) {
          if (saveOwner && error && error.deletedDocument === true) {
            openDeletionDelivery(filePath, saveOwner);
          }
          throw error;
        }
        const beforeWrite = await opened.handle.stat();
        if (
          conflictsWithDocumentBaseline(filePath, beforeWrite, {
            missing: opened.created,
            owner: saveOwner,
          })
        ) {
          markDocumentChangedExternally(filePath);
          console.warn(
            "Refusing to overwrite externally changed file:",
            filePath,
          );
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file changed on disk. Reload or reopen it before saving.",
            path: filePath,
            requestId: requestId,
          });
          return;
        }

        const readyToWrite = await opened.handle.stat();
        if (diskVersionChanged(beforeWrite, readyToWrite)) {
          markDocumentChangedExternally(filePath);
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file changed while the save was starting. Reload or reopen it before saving.",
            path: filePath,
            requestId: requestId,
          });
          return;
        }
        const preWriteIdentityFailure = saveScopeState(saveScope);
        if (preWriteIdentityFailure) {
          sendSaveScopeFailure(
            preWriteIdentityFailure,
            "before write",
            filePath,
            requestId,
          );
          return;
        }
        if (documentDeletionUnresolved(filePath, saveOwner)) {
          throw deletedDocumentSaveError(filePath);
        }
        if (!(await openedHandleMatchesPath(filePath, opened.handle))) {
          markDocumentChangedExternally(filePath);
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file path no longer names the opened file. Reload or reopen it before saving.",
            path: filePath,
            requestId,
          });
          return;
        }
        if (documentDeletionUnresolved(filePath, saveOwner)) {
          throw deletedDocumentSaveError(filePath);
        }

        const finalIdentityFailure = saveScopeState(saveScope);
        if (finalIdentityFailure) {
          sendSaveScopeFailure(
            finalIdentityFailure, "at the write boundary", filePath, requestId,
          );
          return;
        }
        const handleStats = fs.fstatSync(opened.handle.fd);
        const pathStats = fs.statSync(filePath);
        if (
          !handleStats.isFile() ||
          !pathStats.isFile() ||
          handleStats.dev !== pathStats.dev ||
          handleStats.ino !== pathStats.ino ||
          resolveCanonicalFileKey(filePath) !== saveOwner.pathKey ||
          diskVersionChanged(beforeWrite, diskVersionFromStats(handleStats)) ||
          diskVersionChanged(beforeWrite, diskVersionFromStats(pathStats)) ||
          conflictsWithDocumentBaseline(filePath, handleStats, {
            missing: opened.created,
            owner: saveOwner,
          })
        ) {
          markDocumentChangedExternally(filePath);
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file changed at the write boundary. Reload or reopen it before saving.",
            path: filePath,
            requestId,
          });
          return;
        }

        // THE LAST LOOK, with no yield left before the bytes go. An exclusive
        // create admitted before the latch may leave an empty file if the
        // latch closes during subsequent checks; it must not be removed by
        // pathname, which another writer could have replaced.
        if (deletionEvidenceCapacityLatched) {
          refuseSaveForDeletionEvidenceCapacity(
            sendSaveResult,
            filePath,
            requestId,
            "before-write",
          );
          return;
        }
        // THE LAST LOOK AT THE LIFECYCLE TOO, for the same reason and in the
        // same place: after this line the file is truncated.
        if (saveScopeLifecycleExpired(saveScope)) {
          sendSaveScopeFailure(
            "lifecycle-reset",
            "before write",
            filePath,
            requestId,
          );
          return;
        }

        const saveKey = canonicalFileKey(filePath) || filePath;
        verification = {
          key: saveKey,
          writtenVersion: null,
        };
        activeSaveVerifications.set(saveKey, verification);

        // Do not yield after the final owner/path/version check: a quarantine
        // received between truncation and the write cannot undo lost bytes.
        fs.ftruncateSync(opened.handle.fd, 0);
        fs.writeFileSync(opened.handle.fd, content, "utf8");
        fs.fsyncSync(opened.handle.fd);
        verification.writtenVersion = diskVersionFromStats(
          await opened.handle.stat(),
        );
        await opened.handle.close();
        opened = null;

        const savedSnapshot = await readStableRawSnapshot(filePath);
        const savedVersion = diskVersionFromStats(savedSnapshot.stats);
        if (
          savedSnapshot.content !== content ||
          saveCompletionOwnershipOrSizeChanged(
            verification.writtenVersion,
            savedVersion,
          )
        ) {
          markDocumentChangedExternally(filePath);
          console.warn("File changed while save was completing:", filePath);
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file changed while the save was completing. Reload or reopen it before saving again.",
            path: filePath,
            requestId: requestId,
          });
          return;
        }

        const completionIdentityFailure = saveScopeState(saveScope);
        if (completionIdentityFailure) {
          sendSaveScopeFailure(
            completionIdentityFailure, "while finalizing Save",
            filePath, requestId,
          );
          return;
        }
        const rememberedKey = rememberVerifiedSaveVersion(
          filePath,
          savedSnapshot.stats,
          verification.key,
          saveOwner,
        );
        if (!rememberedKey) {
          markDocumentChangedExternally(filePath);
          console.warn(
            "File changed while save baseline was being adopted:",
            filePath,
          );
          sendSaveResult({
            success: false,
            conflict: true,
            error:
              "The file changed while the save was being finalized. Reload or reopen it before saving again.",
            path: filePath,
            requestId: requestId,
          });
          return;
        }
        console.log("File saved successfully:", filePath);
        console.log(
          "Updated document baseline after save:",
          savedSnapshot.stats.mtimeMs,
        );

        sendSaveResult({
          success: true,
          path: filePath,
          requestId: requestId,
          savedContent: content,
          modifiedTime: savedSnapshot.stats.mtimeMs,
          diskVersion: savedVersion,
        });
      } catch (error) {
        console.error("Error saving file:", error);
        if (deletionEvidenceCapacityLatched) {
          refuseSaveForDeletionEvidenceCapacity(
            sendSaveResult, filePath, requestId, "save-error",
          );
          return;
        }
        const conflict = error instanceof SaveConflictError;
        const deleted = conflict && error.deletedDocument === true;
        if (conflict && !deleted) markDocumentChangedExternally(filePath);
        sendSaveResult({
          success: false,
          ...(conflict ? { conflict: true } : {}),
          // Distinguish the durable tombstone from an ordinary content race.
          ...(deleted ? { deleted: true } : {}),
          error: error.message,
          path: filePath,
          requestId: requestId,
        });
      } finally {
        if (opened) {
          try {
            await opened.handle.close();
          } catch (closeError) {
            console.error("Error closing file after save:", closeError);
          }
        }
        if (
          verification &&
          activeSaveVerifications.get(verification.key) === verification
        ) {
          activeSaveVerifications.delete(verification.key);
          if (
            !watchingPaused &&
            watchedFileKey === verification.key
          ) {
            checkFileChanges();
          }
        }
        if (
          !pendingSaveOutcomeDeliveries.has(saveScope.correlationKey)
        ) {
          activeSaveCorrelations.delete(saveScope.correlationKey);
          liveSaveGate?.forget(saveScope);
        }
      }
    });
  } catch (error) {
    console.error("Error in save handler:", error);
    sendSaveResult({
      success: false,
      error: error.message,
      path: (data && data.filePath) || null,
      requestId: data && data.requestId,
    });
    if (
      saveScope &&
      saveScope.correlationKey &&
      !pendingSaveOutcomeDeliveries.has(saveScope.correlationKey)
    ) {
      activeSaveCorrelations.delete(saveScope.correlationKey);
      liveSaveGate?.forget(saveScope);
    }
  }
});

ipcMain.handle("save-markdown-result-ack", (event, data) => {
  if (
    !isApprovalSender(event) ||
    !data ||
    typeof data !== "object" ||
    typeof data.saveRequestSession !== "string" ||
    !validSaveRequestId(data.requestId) ||
    !Number.isSafeInteger(data.saveResultAttempt) ||
    data.saveResultAttempt <= 0
  ) {
    return false;
  }
  const request = data.saveRequest;
  const spelling = filePathSpellingKey(data.path);
  const record = Array.from(pendingSaveOutcomeDeliveries.values()).find(
    (candidate) =>
      candidate.scope.requestId === data.requestId &&
      candidate.scope.pageSession === data.saveRequestSession,
  );
  if (
    !record ||
    !request ||
    spelling !== record.scope.owner.spelling ||
    data.saveResultAttempt !== record.attempt ||
    data.requestId !== record.scope.requestId ||
    data.saveRequestSession !== record.scope.pageSession ||
    request.sequence !== record.scope.sequence ||
    request.requestId !== record.scope.requestId ||
    request.pageSession !== record.scope.owner.pageSession ||
    request.rendererGeneration !== record.scope.owner.rendererGeneration ||
    request.tabId !== record.scope.owner.tabId ||
    request.documentGeneration !==
      record.scope.owner.documentGeneration ||
    request.pathKey !== record.scope.owner.pathKey ||
    request.selectionGeneration !==
      record.scope.owner.selectionGeneration
  ) {
    return false;
  }
  releaseSaveOutcomeDelivery(record);
  return true;
});

// ============================================
// IPC HANDLERS - File Watching
// ============================================

function authorisedWatcherEnvelope(
  event,
  data,
  {
    requireKnownOwner = false,
    requireWatchedOwner = false,
    rejectStaleSelection = false,
    allowCurrentPathIdentity = false,
  } = {},
) {
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data !== "object" ||
    typeof data.filePath !== "string" ||
    data.filePath.length === 0 ||
    data.filePath.includes("\0") ||
    data.pageSession !== approvalRendererPageSession ||
    !Number.isSafeInteger(data.rendererGeneration) ||
    data.rendererGeneration !== approvalRendererGeneration
  ) {
    return null;
  }
  const owner = normaliseDocumentOwner(data.owner, data.filePath, {
    useCurrentPathIdentity: allowCurrentPathIdentity,
  });
  if (
    !owner ||
    owner.pageSession !== data.pageSession ||
    owner.rendererGeneration !== data.rendererGeneration ||
    // A superseded owner is retained so its facts survive, never so it can
    // still be obeyed. `watchedOwner` is deliberately not cleared when its own
    // tab moves on, so the watched-owner arm below would otherwise let a
    // replaced generation go on pausing, resuming, stopping and quarantining
    // the watch.
    supersededDocumentOwners.has(documentOwnerKey(owner)) ||
    (rejectStaleSelection &&
      owner.selectionGeneration < latestWatcherSelectionGeneration) ||
    (requireKnownOwner && !isKnownDocumentOwner(owner)) ||
    (requireWatchedOwner &&
      !sameDocumentSelectionOwner(owner, watchedOwner))
  ) {
    return null;
  }
  return Object.freeze({
    filePath: data.filePath,
    owner,
  });
}

// A background tab need not own the active watcher. Its retained owner, not
// the watch or the adoption baseline, is the authority to read its own file.
function authorisedTabDiskRead(event, data) {
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data !== "object" ||
    typeof data.filePath !== "string" ||
    !data.filePath ||
    data.filePath.includes("\0") ||
    data.pageSession !== approvalRendererPageSession ||
    !Number.isSafeInteger(data.rendererGeneration) ||
    data.rendererGeneration !== approvalRendererGeneration
  ) return null;
  const identity = normaliseDocumentIdentity(data.owner, data.filePath, {
    useCurrentPathIdentity: true,
  });
  const owner = identity && knownDocumentOwners.get(documentOwnerKey(identity));
  return owner &&
    identity.pageSession === data.pageSession &&
    identity.rendererGeneration === data.rendererGeneration &&
    sameDocumentOwner(owner, identity) &&
    isKnownDocumentOwner(owner) &&
    owner.readTarget &&
    resolveCanonicalFilePath(data.filePath) === owner.readTarget
    ? owner
    : null;
}

async function readOwnedTabDiskSnapshot(owner, filePath, event, data) {
  for (let attempt = 1; attempt <= MAX_STABLE_FILE_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const currentOwner = authorisedTabDiskRead(event, data);
      if (
        !sameDocumentOwner(owner, currentOwner) ||
        owner.readTarget !== currentOwner.readTarget
      ) return null;
    }
    let handle;
    try {
      // Follow the logical spelling once, then check the opened descriptor
      // against both that spelling and the owner's registered physical target.
      // A symlink that goes A -> B -> A during the read cannot bless B's bytes.
      handle = await fs.promises.open(filePath, "r");
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error(`Owned tab target is not a file: ${filePath}`);
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      const pathStats = await fs.promises.stat(filePath);
      const targetStats = filePath === owner.readTarget
        ? pathStats
        : await fs.promises.stat(owner.readTarget);
      if (
        before.dev !== pathStats.dev ||
        before.ino !== pathStats.ino ||
        before.dev !== targetStats.dev ||
        before.ino !== targetStats.ino
      ) {
        // An editor may atomically replace the authorised path while its old
        // descriptor is being read. Retry only when both authorised spellings
        // now name that same regular replacement and the request still owns it.
        if (
          !pathStats.isFile() ||
          !targetStats.isFile() ||
          pathStats.dev !== targetStats.dev ||
          pathStats.ino !== targetStats.ino
        ) return null;
        if (attempt < MAX_STABLE_FILE_READ_ATTEMPTS) {
          const currentOwner = authorisedTabDiskRead(event, data);
          if (
            !sameDocumentOwner(owner, currentOwner) ||
            owner.readTarget !== currentOwner.readTarget
          ) return null;
          continue;
        }
      }
      if (
        after.isFile() &&
        pathStats.isFile() &&
        targetStats.isFile() &&
        sameDiskVersion(before, after) &&
        sameDiskVersion(before, pathStats) &&
        sameDiskVersion(before, targetStats)
      ) {
        return Object.freeze({
          content: wrapMermaidContent(removeBOM(raw), filePath),
          modifiedTime: after.mtimeMs,
          diskVersion: diskVersionFromStats(after),
        });
      }
    } finally {
      if (handle) await handle.close();
    }
  }
  throw new Error(`File changed repeatedly while being read: ${filePath}`);
}

ipcMain.handle("read-owned-tab-disk-snapshot", async (event, data) => {
  const owner = authorisedTabDiskRead(event, data);
  if (!owner) return null;
  try {
    const snapshot = await readOwnedTabDiskSnapshot(
      owner,
      data.filePath,
      event,
      data,
    );
    const currentOwner = authorisedTabDiskRead(event, data);
    return sameDocumentOwner(owner, currentOwner) &&
      owner.readTarget === currentOwner.readTarget
      ? snapshot
      : null;
  } catch (error) {
    const currentOwner = authorisedTabDiskRead(event, data);
    // A failure after the request lost its owner or path is a refusal, not an
    // I/O error belonging to the document that now occupies that spelling.
    if (
      !sameDocumentOwner(owner, currentOwner) ||
      owner.readTarget !== currentOwner.readTarget
    ) return null;
    throw error;
  }
});

ipcMain.on("register-document-owner", (event, data) => {
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration
  ) return;
  const owner = normaliseDocumentOwner(data.owner, data.filePath);
  const version = normaliseDiskVersion(data.diskVersion);
  if (
    !owner ||
    owner.pageSession !== data.pageSession ||
    owner.rendererGeneration !== data.rendererGeneration ||
    !version ||
    data.modifiedTime !== version.mtimeMs ||
    Array.from(knownDocumentOwners.values()).some((known) =>
      known.pageSession === owner.pageSession &&
      known.rendererGeneration === owner.rendererGeneration &&
      known.tabId === owner.tabId &&
      known.documentGeneration > owner.documentGeneration)
  ) {
    console.error("Refusing background document owner registration");
    return;
  }
  // WHICH REFUSAL THIS WOULD BE, DECIDED WHILE IT IS STILL DECIDABLE.
  // `canRememberDocumentOwner` tests the supersession marker FIRST and the
  // seal second, so an owner that is neither marked nor already on record is
  // refused BY THE SEAL once a fence has been dropped - the newer-owner test
  // below it never runs, and the capacity refusal past it is reachable only
  // when the seal let the owner through. Read after the call the same three
  // facts would be worthless: a registration that SUCCEEDS puts this key in
  // the table, and the eviction drain inside it can forget a marker, so the
  // reason has to be taken before anything moves.
  //
  // The message this arms is about the SESSION, never about this document,
  // and that is what makes it honest: after a drop this process genuinely
  // cannot tell a first registration from a replay of one a tab has left, so
  // it says only what is true either way - that nothing opened from now on is
  // recorded, and that the work has to be carried out by hand.
  const ownerKey = documentOwnerKey(owner);
  const sealRefused =
    documentOwnerFenceDropCount > 0 &&
    !knownDocumentOwners.has(ownerKey) &&
    !supersededDocumentOwners.has(ownerKey);
  // Cleared immediately before the call it is asked about, so it answers for
  // THIS registration and nothing earlier.
  lastDocumentOwnerRefusalWasTablePinned = false;
  if (!rememberDocumentOwner(owner, {
    diskVersion: version,
    modifiedTime: version.mtimeMs,
    readPath: data.filePath,
  })) {
    if (sealRefused) {
      // The seal already announced itself once inside the admission test and
      // tells the reader once here; a line per refusal would be the unbounded
      // log both of those exist to avoid.
      noteDocumentOwnerSealRefusal(event.sender);
    } else if (!lastDocumentOwnerRefusalWasTablePinned) {
      // Supersession, a newer sibling, a stale envelope: none of them is a
      // session-long verdict, so each is still reported on its own.
      console.error("Refusing stale background document registration");
    }
  }
});

ipcMain.on("start-file-watching", (event, data) => {
  const authorised = authorisedWatcherEnvelope(event, data, {
    rejectStaleSelection: true,
    allowCurrentPathIdentity: data && data.adoptPathIdentity === true,
  });
  if (!authorised) return;
  const {
    modifiedTime,
    diskVersion,
  } = data;
  startFileWatching(authorised.filePath, {
    adoptBaseline: data.adoptBaseline === true,
    modifiedTime,
    diskVersion,
    owner: authorised.owner,
    ownerUsesCurrentPathIdentity: data.adoptPathIdentity === true,
  });
  latestWatcherSelectionGeneration = Math.max(
    latestWatcherSelectionGeneration,
    authorised.owner.selectionGeneration,
  );
});

ipcMain.on("pause-file-watching", (event, data) => {
  if (
    !authorisedWatcherEnvelope(event, data, {
      rejectStaleSelection: true,
    })
  ) {
    return;
  }
  watchingPaused = true;
  pauseFileWatching();
});

ipcMain.on("resume-file-watching", (event, data) => {
  if (
    !authorisedWatcherEnvelope(event, data, {
      requireWatchedOwner: true,
    })
  ) {
    return;
  }
  watchingPaused = false;
  resumeFileWatching();
});

ipcMain.on("stop-file-watching", (event, data) => {
  if (
    !authorisedWatcherEnvelope(event, data, {
      requireWatchedOwner: true,
    })
  ) {
    return;
  }
  watchingPaused = false;
  stopFileWatching();
});

// Selection and tracking intent are separate messages so the renderer can
// order them safely: pause before selecting a dirty target; select before
// resuming a clean one. Only a committed exact-owner grant can retire evidence
// as part of a foreground selection.
function selectActiveFileFromRenderer(
  authorised, data, {
    resumeTracking = false,
    verifySelection = null,
    verifiedOwner = null,
    verifiedKey = null,
  } = {},
) {
  const filePath = authorised.filePath;
  const wasPaused = watchingPaused;
  const requestedTrackingActive = data.trackingActive === true;
  if (!requestedTrackingActive) {
    watchingPaused = true;
    pauseFileWatching();
  }
  const wasWatching = requestedTrackingActive && !watchingPaused;
  const selected = selectWatchedDocument(filePath, {
    adoptBaseline: data.adoptBaseline === true,
    modifiedTime: data.modifiedTime,
    diskVersion: data.diskVersion,
    owner: authorised.owner,
    ownerUsesCurrentPathIdentity: data.adoptPathIdentity === true,
    verifySelection,
    verifiedOwner,
    verifiedKey,
  });
  if (!selected) {
    if (!wasPaused && watchingPaused) {
      watchingPaused = false;
      resumeFileWatching();
    }
    return false;
  }
  latestWatcherSelectionGeneration = Math.max(
    latestWatcherSelectionGeneration,
    authorised.owner.selectionGeneration,
  );
  if (wasWatching && !fileWatcher) {
    startFileWatching(filePath);
  }
  if (resumeTracking && requestedTrackingActive && watchingPaused) {
    watchingPaused = false;
    resumeFileWatching();
  }
  // Selecting a document is the moment its owner can hear about it again. A
  // deletion reported while another tab was on screen is still open, and this
  // is the replay: it is refused unless this selection is that report's own
  // owner, and it sends at most once per selection.
  replayDeletionForOwner(filePath);
  return true;
}

ipcMain.on("set-active-file", (event, data) => {
  const authorised = authorisedWatcherEnvelope(event, data, {
    rejectStaleSelection: true,
    allowCurrentPathIdentity: data && data.adoptPathIdentity === true,
  });
  if (!authorised) return;
  selectActiveFileFromRenderer(authorised, data);
});

ipcMain.on("select-file-tracking", (event, data) => {
  const authorised = authorisedWatcherEnvelope(event, data, {
    rejectStaleSelection: true,
    allowCurrentPathIdentity: data && data.adoptPathIdentity === true,
  });
  if (!authorised) {
    event.returnValue = Object.freeze({
      accepted: false, mayHaveMoved: false,
      why: "invalid-tracking-owner",
    });
    return;
  }
  const expected = data.adoptBaseline === true
    ? normaliseDiskVersion(data.diskVersion)
    : null;
  if (data.adoptBaseline === true && !expected) {
    console.error("Refusing watcher selection without a valid disk version");
    event.returnValue = Object.freeze({
      accepted: false, mayHaveMoved: false,
      why: "invalid-selection-disk-version",
    });
    return;
  }
  const verifySelection = expected
    ? () => {
        const observed = readDocumentStats(
          authorised.filePath, "while selecting the file tracking owner",
        );
        if (
          observed &&
          resolveCanonicalFileKey(authorised.filePath) ===
            authorised.owner.pathKey &&
          !diskVersionChanged(expected, diskVersionFromStats(observed)) &&
          (data.adoption ||
            !documentDeletionUnresolved(authorised.filePath, authorised.owner))
        ) return true;
        if (!data.adoption) {
          markDocumentChangedExternally(authorised.filePath);
        }
        return false;
      }
    : null;
  if (verifySelection && !verifySelection()) {
    event.returnValue = Object.freeze({
      accepted: false, mayHaveMoved: true,
      why: "disk-or-deletion-moved-before-selection",
    });
    return;
  }
  if (data.adoption) {
    const grant = committedDiskAdoptions.get(data.adoption.capability);
    if (
      data.adoptBaseline !== true ||
      data.adoptPathIdentity !== true ||
      !expected ||
      data.modifiedTime !== expected.mtimeMs ||
      !grant ||
      grant.sourcePath !== data.adoption.sourceFilePath ||
      grant.ownerPath !== authorised.filePath ||
      grant.ownerPath !== data.adoption.ownerFilePath ||
      grant.proposedOwnerKey !== documentOwnerKey(authorised.owner) ||
      grant.revision !== data.adoption.revision ||
      grant.contentDigest !== data.adoption.contentDigest ||
      diskVersionChanged(grant.version, expected)
    ) {
      event.returnValue = Object.freeze({
        accepted: false, mayHaveMoved: false,
        why: "invalid-selection-adoption",
      });
      return;
    }
    if (!canRememberDocumentOwner(authorised.owner)) {
      event.returnValue = Object.freeze({
        accepted: false, mayHaveMoved: false,
        why: "stale-selection-owner",
      });
      return;
    }
    // The completion below asks both of these questions again, for every
    // caller, and admits the owner itself. They are kept here so a foreground
    // refusal keeps its own reason and is answered before the completion
    // touches the filesystem at all; the two answers cannot disagree, because
    // nothing between them mutates the owner table.
    if (!documentOwnerTableHasRoomFor(
      authorised.owner, data.adoption.capability,
    )) {
      noteDocumentOwnerTablePinnedRefusal("adoption");
      event.returnValue = Object.freeze({
        accepted: false, mayHaveMoved: false,
        why: "selection-owner-table-full",
      });
      return;
    }
    const completion = completeDocumentDiskAdoption({
      capability: data.adoption.capability,
      pageSession: data.pageSession,
      rendererGeneration: data.rendererGeneration,
      filePath: data.adoption.sourceFilePath,
      ownerFilePath: data.adoption.ownerFilePath,
      actualOwner: data.owner,
      revision: data.adoption.revision,
    });
    if (!completion.completed) {
      event.returnValue = Object.freeze({
        accepted: false, mayHaveMoved: true,
        why: completion.why,
      });
      return;
    }
    // Completion has established the exact baseline. Selecting it without
    // re-adopting avoids a second filesystem check after the commit boundary.
    const selected = selectActiveFileFromRenderer(
      authorised, {
        ...data,
        adoptBaseline: false,
        trackingActive: completion.unresolvedEvidence === true
          ? false
          : data.trackingActive,
      },
      {
        resumeTracking: true,
        verifiedOwner: authorised.owner,
        verifiedKey: grant.versionPathKey,
      },
    );
    if (!selected) {
      // The completion has now ADMITTED this owner, which makes the two ways
      // the selection below could still refuse it - a stale-owner test and a
      // capacity refusal - unreachable, and this is what happens if that ever
      // stops being true. The completion has already retired this path's
      // deletion evidence, so the owner that held the watch cannot be left
      // able to come back for it: `captureSaveScope` authorises a save on
      // a matching `watchedOwner`, and the warning that would have refused
      // that save no longer exists. Vacating the seat is not enough on its
      // own, because the renderer's refusal path restores its previous
      // selection and would simply re-select the same owner into the empty
      // seat. So the seat is vacated AND the owners that could claim it for
      // this episode - the one holding the watch, and the one the grant
      // replaced - are deauthorized the way supersession already does it:
      // listed, so their facts survive for anything still reading them, but
      // never obeyed again. Saves still settling against them are reported as
      // replaced, which is what they are. The adopting owner is deliberately
      // NOT deauthorized with them: it is the one owner here whose baseline
      // is the disk's, it holds no watch, and refusing it too would strand a
      // tab that has already taken the adopted bytes. Finally the path is
      // recorded as changed underneath, so a later selection has to
      // re-establish a baseline rather than inherit the one just adopted.
      console.error("Completed disk adoption could not select its verified owner");
      const staleOwnerKeys = new Set();
      for (const staleKey of [documentOwnerKey(watchedOwner), grant.oldOwnerKey]) {
        if (staleKey && knownDocumentOwners.has(staleKey)) {
          supersededDocumentOwners.add(staleKey);
          staleOwnerKeys.add(staleKey);
        }
      }
      for (const scope of activeSaveCorrelations.values()) {
        if (staleOwnerKeys.has(documentOwnerKey(scope.owner))) {
          invalidatedSaveScopes.add(scope);
        }
      }
      markDocumentChangedExternally(authorised.filePath);
      watchingPaused = true;
      clearWatchedDocument();
      event.returnValue = Object.freeze({
        accepted: false, mayHaveMoved: true,
        why: "completed-adoption-selection-invariant",
      });
      return;
    }
    const selectedStats = readDocumentStats(
      authorised.filePath, "after selecting the disk adoption owner",
    );
    const trackingConflict =
      !selectedStats ||
      resolveCanonicalFileKey(authorised.filePath) !== grant.versionPathKey ||
      diskVersionChanged(
        grant.version, diskVersionFromStats(selectedStats),
      );
    if (trackingConflict) {
      markDocumentChangedExternally(authorised.filePath);
      watchingPaused = true;
      pauseFileWatching();
    }
    event.returnValue = Object.freeze({
      accepted: true,
      trackingActive:
        data.trackingActive === true &&
        completion.unresolvedEvidence !== true &&
        !trackingConflict,
      completedAdoption: data.adoption.capability,
      approvedOwner: authorised.owner,
      approvedPathKey: grant.versionPathKey,
      approvedDiskVersion: grant.version,
      approvedSourceFilePath: grant.sourcePath,
      approvedOwnerFilePath: grant.ownerPath,
      unresolvedEvidence: completion.unresolvedEvidence === true,
      trackingConflict,
    });
    return;
  }
  if (!selectActiveFileFromRenderer(
    authorised, data, { resumeTracking: true, verifySelection },
  )) {
    event.returnValue = Object.freeze({
      accepted: false, mayHaveMoved: data.adoptBaseline === true,
      why: "selection-refused",
    });
    return;
  }
  event.returnValue = Object.freeze({
    accepted: true,
    trackingActive: data.trackingActive === true,
  });
});

ipcMain.on("quarantine-selected-file-tracking", (event, data) => {
  const background = data && data.background === true;
  const authorised = authorisedWatcherEnvelope(event, data, {
    requireKnownOwner: background,
    requireWatchedOwner: !background,
  });
  const ownerKey = authorised && documentOwnerKey(authorised.owner);
  const baseline = ownerKey && ownerDocumentBaselines.get(ownerKey);
  const requestedVersion = normaliseDiskVersion(
    data && data.approvedDiskVersion,
  );
  if (
    !authorised ||
    !baseline ||
    !baseline.version ||
    !requestedVersion ||
    data.approvedPathKey !== authorised.owner.pathKey ||
    (!background && watchedFileKey !== data.approvedPathKey) ||
    !sameDiskVersion(baseline.version, requestedVersion)
  ) {
    console.error("Refusing quarantine without the selected disk owner");
    event.returnValue = Object.freeze({
      quarantined: false, why: "selected-owner-moved",
    });
    return;
  }
  quarantinedDocumentOwners.add(ownerKey);
  for (const scope of activeSaveCorrelations.values()) {
    if (documentOwnerKey(scope.owner) === ownerKey) {
      quarantinedSaveScopes.add(scope);
    }
  }
  for (const record of pendingSaveOutcomeDeliveries.values()) {
    if (
      documentOwnerKey(record.scope.owner) === ownerKey &&
      record.payload.success === true
    ) {
      record.payload = Object.freeze({
        ...record.payload,
        success: false,
        conflict: true,
        settlementOnly: false,
        error:
          "The document was quarantined before its Save result settled. Review the conflict before saving.",
      });
    }
  }
  if (sameDocumentSelectionOwner(authorised.owner, watchedOwner)) {
    watchingPaused = true;
    pauseFileWatching();
  }
  event.returnValue = Object.freeze({
    quarantined: true,
    owner: authorised.owner,
    pathKey: authorised.owner.pathKey,
    diskVersion: baseline.version,
  });
});

// The renderer answers every deletion report: consumed, or refused with the
// reason it could not be. A refusal keeps the report open so the owning
// document is warned when it is selected again; only an owner that can never
// return releases it, because holding a report for a page or a tab that is gone
// would make the next deletion of that path unreportable.
ipcMain.on("file-deleted-ack", (event, data) => {
  if (!isApprovalSender(event)) return;
  const deliveryId = data && data.eventId;
  if (!Number.isSafeInteger(deliveryId)) return;
  const record = findDeletionDeliveryById(deliveryId);
  if (!record) return;
  if (
    !data ||
    data.pageSession !== record.owner.pageSession ||
    data.tabId !== record.owner.tabId ||
    data.documentGeneration !== record.owner.documentGeneration ||
    data.pathKey !== record.owner.pathKey ||
    data.rendererGeneration !== record.owner.rendererGeneration ||
    data.selectionGeneration !== record.selectionGeneration ||
    data.watcherGeneration !== record.watcherGeneration ||
    data.attempt !== record.attempt
  ) {
    return;
  }
  clearDeletionDeliveryAttempt(record);
  const why = (data && data.why) || null;
  if (data.consumed === true) {
    record.consumed = true;
    releaseDeletionDelivery(record);
    return;
  }
  if (
    why === "owner-closed" ||
    why === "foreign-session" ||
    why === "replacement-owner" ||
    why === "owner-path-moved"
  ) {
    releaseDeletionDelivery(record);
  } else if (why === "frozen") {
    record.parked = true;
  } else if (sameDocumentOwner(record.owner, watchedOwner)) {
    scheduleDeletionDeliveryRetry(
      record,
      why === "stale-selection"
        ? null
        : DELETION_DELIVERY_ACK_TIMEOUT_MS,
    );
  }
});

// The identity a closing document speaks with. Both the deletion-state query
// and the retirement below authenticate the same envelope, so they agree by
// construction about which owner is being asked about.
function closingDocumentOwnerFromEnvelope(event, data) {
  if (
    !isApprovalSender(event) ||
    !data ||
    typeof data !== "object" ||
    typeof data.filePath !== "string" ||
    data.filePath.length === 0 ||
    data.filePath.includes("\0") ||
    typeof data.pageSession !== "string" ||
    data.pageSession.length === 0 ||
    data.pageSession !== approvalRendererPageSession ||
    !Number.isSafeInteger(data.rendererGeneration) ||
    data.rendererGeneration <= 0 ||
    data.rendererGeneration !== approvalRendererGeneration ||
    !Number.isSafeInteger(data.tabId) ||
    data.tabId <= 0 ||
    !Number.isSafeInteger(data.documentGeneration) ||
    data.documentGeneration <= 0 ||
    typeof data.pathKey !== "string" ||
    data.pathKey.length === 0 ||
    data.pathKey.includes("\0")
  ) {
    return null;
  }
  const admittedTabKey = [
    data.pageSession, data.rendererGeneration, data.tabId,
  ].join("\0");
  const spelling = filePathSpellingKey(data.filePath);
  const admission = data.documentRef === undefined ? null :
    admittedDocumentReference(data.documentRef, data, data.filePath);
  if ((data.documentRef !== undefined && !admission) ||
      (admittedOwnerTabs.has(admittedTabKey) && !admission)) return null;
  if (!admission && retiredAdmissionScope ===
      `${data.pageSession}\0${data.rendererGeneration}` &&
      data.tabId <= retiredAdmissionTabFloor) {
    const knownKey = documentOwnerKey({ ...data, spelling });
    const known = knownDocumentOwners.get(knownKey);
    if (!known || known.documentRef ||
        supersededDocumentOwners.has(knownKey)) return null;
  }
  if (!spelling) return null;
  return Object.freeze({
    pageSession: data.pageSession,
    rendererGeneration: data.rendererGeneration,
    tabId: data.tabId,
    documentGeneration: data.documentGeneration,
    pathKey: data.pathKey,
    spelling,
    ...(admission ? { documentRef: data.documentRef } : {}),
  });
}

// Owner-scoped, and authoritative because it is read out of the records that
// refuse the save rather than out of whatever the renderer happens to have
// been told. A report that was parked, compacted, refused or never delivered
// is invisible to the renderer's own tombstone, so a close that consults only
// the renderer closes a deleted document with no warning at all.
function describeDocumentDeletionState(owner, filePath) {
  const ownerKey = documentOwnerKey(owner);
  const baseline = ownerDocumentBaselines.get(ownerKey);
  let unreadable = false;
  if (baseline && sameDocumentOwner(baseline.owner, owner)) {
    try {
      fs.statSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        openDeletionDelivery(filePath, owner);
      } else {
        console.error("Could not check closing document path:", error);
        unreadable = true;
      }
    }
  }
  const tombstone = ownerKey
    ? documentDeletionTombstones.get(ownerKey) || null
    : null;
  const orphaned = orphanedDeletionForSpelling(filePath, owner);
  return Object.freeze({
    known: true,
    // Monotonic marker for the deletion evidence this answer describes. Carried
    // back in a refusal too, so a caller - or a test - can see that live state
    // moved between the question and the retirement rather than inferring it.
    revision: deletionEvidenceRevision,
    ownDeletion: !!tombstone,
    orphaned,
    pathOnly: pathOnlyDeletionForSpelling(filePath),
    unreadable,
    // An in-memory copy is about to be closed over a file that is not there:
    // this document's own unresolved report, or a path that is missing for
    // whoever owns it. Either way the reader has something to be told.
    unresolved:
      !!tombstone ||
      unreadable ||
      orphaned ||
      pathOnlyDeletionForSpelling(filePath) ||
      hasDeletionOverflowEvidence(filePath, owner),
  });
}

function prunePendingDiskAdoptions() {
  const now = Date.now();
  for (const [nonce, grant] of pendingDiskAdoptions) {
    if (now - grant.createdAt > DISK_ADOPTION_CAPABILITY_MS) {
      pendingDiskAdoptions.delete(nonce);
    }
  }
  for (const [nonce, grant] of committedDiskAdoptions) {
    if (now - grant.acceptedAt > DISK_ADOPTION_CAPABILITY_MS) {
      committedDiskAdoptions.delete(nonce);
    }
  }
}

function adoptionOverflowKeys(spelling, oldOwner, proposedOwner, pathKey) {
  const oldKey = documentOwnerKey(oldOwner);
  const matches = [];
  for (const [key, record] of deletionOverflowEvidence) {
    if (record.spelling !== spelling) continue;
    if (
      (oldKey && record.ownerKey === oldKey) ||
      (!record.ownerKey &&
        (record.pathKey === pathKey ||
          (oldOwner && record.pathKey === oldOwner.pathKey))) ||
      (record.owner &&
        (record.owner.pageSession !== approvalRendererPageSession ||
          record.owner.rendererGeneration !== approvalRendererGeneration ||
          (proposedOwner &&
            record.owner.tabId === proposedOwner.tabId &&
            record.owner.documentGeneration !==
              proposedOwner.documentGeneration)))
    ) {
      matches.push(key);
    }
  }
  return Object.freeze(matches);
}

function adoptionEvidencePathKeys(spelling, oldOwner, proposedOwner) {
  const oldKey = documentOwnerKey(oldOwner);
  const keys = new Set();
  for (const record of deletionTombstonesBySpelling.get(spelling) || []) {
    if (
      record.key === oldKey ||
      record.owner.pageSession !== approvalRendererPageSession ||
      record.owner.rendererGeneration !== approvalRendererGeneration ||
      (proposedOwner &&
        record.owner.tabId === proposedOwner.tabId &&
        record.owner.documentGeneration !==
          proposedOwner.documentGeneration)
    ) {
      keys.add(record.pathKey);
    }
  }
  return keys;
}

function historicalEpisodeCanBeRetired(
  spelling, pathKey, oldOwner,
) {
  if (
    (oldOwner && oldOwner.pathKey === pathKey) ||
    deletionEvidenceHasDependentSibling(null, pathKey)
  ) return false;
  if (Array.from(
    deletionTombstonesBySpelling.get(spelling) || [],
  ).some((record) =>
    record.pathKey === pathKey &&
    !ownerDocumentBaselines.has(record.key))) return true;
  if (pathOnlyDeletionEvidence.get(spelling)?.has(pathKey)) return true;
  return Array.from(deletionOverflowEvidence.values()).some(
    (record) => record.spelling === spelling &&
      record.pathKey === pathKey &&
      (!record.ownerKey ||
        !ownerDocumentBaselines.has(record.ownerKey)),
  );
}

function sharedDeletionEvidenceNeedsSiblingCheck(
  spelling, pathKey, oldOwner, pathOnlyKey, overflowKeys,
) {
  if (!pathKey) return false;
  if (pathOnlyKey === pathKey) return true;
  if (overflowKeys.some((key) => {
    const record = deletionOverflowEvidence.get(key);
    return record && !record.ownerKey && record.pathKey === pathKey;
  })) return true;
  const oldKey = documentOwnerKey(oldOwner);
  return Array.from(
    deletionTombstonesBySpelling.get(spelling) || [],
  ).some((record) =>
    record.pathKey === pathKey &&
    record.key !== oldKey &&
    (record.owner.pageSession !== approvalRendererPageSession ||
      record.owner.rendererGeneration !== approvalRendererGeneration ||
      !ownerDocumentBaselines.has(record.key)));
}

function deletionEvidenceHasDependentSibling(
  ownerKey, evidencePathKey,
) {
  for (const baseline of ownerDocumentBaselines.values()) {
    const sibling = baseline.owner;
    if (
      documentOwnerKey(sibling) === ownerKey ||
      sibling.pathKey !== evidencePathKey
    ) continue;
    try {
      const stats = fs.statSync(sibling.spelling);
      if (
        resolveCanonicalFileKey(sibling.spelling) !== sibling.pathKey ||
        (baseline.version &&
          diskVersionChanged(
            baseline.version, diskVersionFromStats(stats),
          )) ||
        (Number.isFinite(baseline.modifiedTime) &&
          baseline.modifiedTime !== stats.mtimeMs)
      ) return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        console.error("Could not check a deletion sibling:", error);
      }
      return true;
    }
  }
  return false;
}

function matchedOwnerHasDeletionEvidence(owner, filePath) {
  if (!owner) return false;
  const key = documentOwnerKey(owner);
  return documentDeletionTombstones.has(key) ||
    pathOnlyDeletionForSpelling(filePath) ||
    orphanedDeletionForSpelling(filePath, owner) ||
    hasDeletionOverflowEvidence(filePath, owner);
}

function unreachablePhysicalDeletionSpellings(pathKey, incomingSpelling) {
  const spellings = new Set();
  for (const record of deletionTombstonesByPathKey.get(pathKey) || []) {
    if (
      record.spelling !== incomingSpelling &&
      !ownerDocumentBaselines.has(record.key)
    ) spellings.add(record.spelling);
  }
  for (const record of deletionOverflowEvidence.values()) {
    if (
      record.pathKey === pathKey &&
      record.spelling !== incomingSpelling &&
      (!record.ownerKey ||
        !ownerDocumentBaselines.has(record.ownerKey))
    ) spellings.add(record.spelling);
  }
  for (const [spelling, keys] of pathOnlyDeletionEvidence) {
    if (spelling === incomingSpelling || !keys.has(pathKey)) continue;
    const live = Array.from(ownerDocumentBaselines.values()).some(
      (baseline) => baseline.owner.spelling === spelling &&
        baseline.owner.pathKey === pathKey,
    );
    if (!live) spellings.add(spelling);
  }
  return Object.freeze(Array.from(spellings).sort());
}

ipcMain.on("query-document-disk-adoption-state", (event, data) => {
  const unknown = Object.freeze({ known: false });
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data.filePath !== "string" ||
    !data.filePath ||
    data.filePath.includes("\0") ||
    typeof data.ownerFilePath !== "string" ||
    !data.ownerFilePath ||
    data.ownerFilePath.includes("\0") ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration
  ) {
    event.returnValue = unknown;
    return;
  }
  const owner = data.tabId === null
    ? null
    : closingDocumentOwnerFromEnvelope(event, {
        ...data,
        filePath: data.ownerFilePath,
      });
  if (data.tabId !== null && !owner) {
    event.returnValue = unknown;
    return;
  }
  const ownDeletion = !!(
    owner && documentDeletionTombstones.has(documentOwnerKey(owner))
  );
  const spelling = filePathSpellingKey(data.filePath);
  const version = normaliseDiskVersion(data.diskVersion);
  const first = version && Number.isFinite(data.modifiedTime) &&
    version.mtimeMs === data.modifiedTime
    ? readDocumentStats(data.filePath, "while checking disk adoption")
    : null;
  const firstKey = first ? resolveCanonicalFileKey(data.filePath) : null;
  const second = firstKey
    ? readDocumentStats(data.filePath, "while verifying disk adoption query")
    : null;
  const secondKey = second ? resolveCanonicalFileKey(data.filePath) : null;
  const versionMatches = !!(
    spelling &&
    version &&
    firstKey &&
    secondKey === firstKey &&
    first &&
    second &&
    !diskVersionChanged(version, diskVersionFromStats(first)) &&
    !diskVersionChanged(version, diskVersionFromStats(second))
  );
  event.returnValue = Object.freeze({
    known: true,
    revision: deletionEvidenceRevision,
    ownDeletion,
    orphaned: orphanedDeletionForSpelling(data.filePath, owner),
    pathOnly: pathOnlyDeletionForSpelling(data.filePath),
    overflow: hasDeletionOverflowEvidence(data.filePath, owner),
    pathKey: firstKey,
    versionMatches,
  });
});

ipcMain.handle("prepare-document-disk-adoption", async (event, data) => {
  const refuse = (why) => Object.freeze({ known: false, why });
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data.filePath !== "string" ||
    !data.filePath ||
    data.filePath.includes("\0") ||
    typeof data.ownerFilePath !== "string" ||
    !data.ownerFilePath ||
    data.ownerFilePath.includes("\0") ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration
  ) return refuse("invalid-adoption-sender");

  const owner = data.tabId === null
    ? null
    : closingDocumentOwnerFromEnvelope(event, {
        ...data, filePath: data.ownerFilePath,
      });
  const proposed = normaliseDocumentIdentity(
    data.proposedOwner,
    data.ownerFilePath,
    { useCurrentPathIdentity: true, forAdoption: true },
  );
  const version = normaliseDiskVersion(data.diskVersion);
  const pathKey = resolveCanonicalFileKey(data.filePath);
  const spelling = filePathSpellingKey(data.filePath);
  const matchedSpelling = filePathSpellingKey(data.ownerFilePath);
  const oldKey = documentOwnerKey(owner);
  if (
    (data.tabId !== null && !owner) ||
    !proposed ||
    !version ||
    !pathKey ||
    proposed.pathKey !== pathKey ||
    resolveCanonicalFileKey(data.ownerFilePath) !== pathKey ||
    version.mtimeMs !== data.modifiedTime ||
    !spelling ||
    !/^[a-f0-9]{64}$/.test(data.contentDigest) ||
    (owner && (
      owner.tabId !== proposed.tabId ||
      (data.replaceDocument === true
        ? owner.documentGeneration === proposed.documentGeneration
        : owner.documentGeneration !== proposed.documentGeneration) ||
      (!ownerDocumentBaselines.has(oldKey) &&
        !documentDeletionTombstones.has(oldKey))
    ))
  ) return refuse("invalid-adoption-identity");
  const revision = deletionEvidenceRevision;
  const acceptedReadTarget = resolveCanonicalFilePath(data.filePath);

  let handle;
  try {
    handle = await fs.promises.open(data.filePath, "r");
    const before = await handle.stat();
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    const pathStats = await fs.promises.stat(data.filePath);
    const targetStats = acceptedReadTarget
      ? await fs.promises.stat(acceptedReadTarget) : null;
    const content = wrapMermaidContent(
      removeBOM(raw), data.filePath,
    );
    const digest = Buffer.from(await crypto.webcrypto.subtle.digest(
      "SHA-256", Buffer.from(content, "utf8"),
    )).toString("hex");
    if (
      !before.isFile() ||
      !targetStats || !targetStats.isFile() ||
      resolveCanonicalFilePath(data.filePath) !== acceptedReadTarget ||
      diskVersionChanged(version, diskVersionFromStats(targetStats)) ||
      resolveCanonicalFileKey(data.filePath) !== pathKey ||
      diskVersionChanged(version, diskVersionFromStats(before)) ||
      diskVersionChanged(version, diskVersionFromStats(after)) ||
      diskVersionChanged(version, diskVersionFromStats(pathStats)) ||
      digest !== data.contentDigest
    ) return refuse("disk-bytes-or-target-moved");
  } catch (error) {
    console.error("Could not attest disk adoption:", error);
    return refuse("disk-read-failed");
  } finally {
    if (handle) await handle.close();
  }
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration ||
    revision !== deletionEvidenceRevision ||
    resolveCanonicalFileKey(data.filePath) !== pathKey
  ) return refuse("adoption-moved-during-read");
  if (
    owner &&
    matchedSpelling !== spelling &&
    matchedOwnerHasDeletionEvidence(owner, data.ownerFilePath)
  ) return refuse("matched-owner-deletion-evidence");

  prunePendingDiskAdoptions();
  const pathOnlyKeys = pathOnlyDeletionEvidence.get(spelling);
  const overflowKeys = adoptionOverflowKeys(
    spelling, owner, proposed, pathKey,
  );
  const evidenceKeys = adoptionEvidencePathKeys(
    spelling, owner, proposed,
  );
  if (pathOnlyKeys) {
    for (const key of pathOnlyKeys) evidenceKeys.add(key);
  }
  for (const key of overflowKeys) {
    const record = deletionOverflowEvidence.get(key);
    if (
      !record ||
      typeof record.pathKey !== "string" ||
      !record.pathKey
    ) return refuse("invalid-overflow-provenance");
    evidenceKeys.add(record.pathKey);
  }
  const resolutionOnly = evidenceKeys.size > 1;
  const evidencePathKey = resolutionOnly
    ? Array.from(evidenceKeys).sort().find((key) =>
        historicalEpisodeCanBeRetired(spelling, key, owner)) || null
    : evidenceKeys.values().next().value || null;
  if (resolutionOnly && !evidencePathKey) {
    return refuse("ambiguous-multiple-physical-deletions");
  }
  const pathOnlyKey = pathOnlyKeys
    ? resolutionOnly
      ? pathOnlyKeys.has(evidencePathKey) ? evidencePathKey : null
      : pathOnlyKeys.values().next().value
    : null;
  const selectedOverflowKeys = resolutionOnly
    ? Object.freeze(overflowKeys.filter((key) =>
        deletionOverflowEvidence.get(key)?.pathKey === evidencePathKey))
    : overflowKeys;
  const relatedOrphanSpellings = unreachablePhysicalDeletionSpellings(
    pathKey, spelling,
  );
  const dependentSibling =
    sharedDeletionEvidenceNeedsSiblingCheck(
      spelling, evidencePathKey, owner, pathOnlyKey,
      selectedOverflowKeys,
    ) &&
    deletionEvidenceHasDependentSibling(oldKey, evidencePathKey);
  if (
    (!resolutionOnly && pathOnlyKeys && pathOnlyKeys.size > 1) ||
    dependentSibling ||
    pendingDiskAdoptions.size + committedDiskAdoptions.size >=
      MAX_PENDING_DISK_ADOPTIONS
  ) return refuse(dependentSibling
    ? "live-sibling-deletion-evidence"
    : "ambiguous-or-full-adoption-capacity");
  let capability;
  do {
    capability = crypto.randomBytes(16).toString("hex");
  } while (pendingDiskAdoptions.has(capability));
  pendingDiskAdoptions.set(capability, Object.freeze({
    createdAt: Date.now(),
    pageSession: data.pageSession,
    rendererGeneration: data.rendererGeneration,
    incomingSpelling: spelling,
    ownerSpelling: filePathSpellingKey(data.ownerFilePath),
    sourcePath: data.filePath,
    ownerPath: data.ownerFilePath,
    oldOwnerKey: oldKey,
    proposedOwnerKey: documentOwnerKey(proposed),
    oldOwner: owner,
    proposedOwner: proposed,
    versionPathKey: pathKey,
    acceptedReadTarget,
    version,
    contentDigest: data.contentDigest,
    revision,
    replaceDocument: data.replaceDocument === true,
    pathOnlyKey,
    evidencePathKey,
    overflowKeys: selectedOverflowKeys,
    resolutionOnly,
    relatedOrphanSpellings,
  }));
  if (resolutionOnly) {
    return Object.freeze({
      known: false,
      why: "resolve-historical-episode",
      capability,
      revision,
      pathKey,
      remainingPhysicalEpisodes: evidenceKeys.size,
    });
  }
  return Object.freeze({
    known: true,
    pathKey,
    revision,
    versionMatches: true,
    capability,
    ownDeletion: !!(owner &&
      documentDeletionTombstones.has(oldKey)),
    orphaned: orphanedDeletionForSpelling(data.filePath, owner),
    pathOnly: !!pathOnlyKeys,
    overflow: overflowKeys.length > 0,
    relatedOrphanCount: relatedOrphanSpellings.length,
  });
});

ipcMain.on("commit-document-disk-adoption", (event, data) => {
  const refuse = (why) => {
    event.returnValue = Object.freeze({ accepted: false, why });
  };
  if (
    !isApprovalSender(event) ||
    approvalRendererState !== "ready" ||
    !data ||
    typeof data.capability !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.capability) ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration
  ) {
    refuse("stale-adoption-identity");
    return;
  }
  const grant = pendingDiskAdoptions.get(data.capability);
  if (!grant) {
    refuse("unknown-or-used-adoption-capability");
    return;
  }
  pendingDiskAdoptions.delete(data.capability);
  if (
    Date.now() - grant.createdAt > DISK_ADOPTION_CAPABILITY_MS ||
    grant.pageSession !== data.pageSession ||
    grant.rendererGeneration !== data.rendererGeneration ||
    grant.revision !== deletionEvidenceRevision ||
    data.revision !== grant.revision ||
    data.filePath !== grant.sourcePath ||
    data.ownerFilePath !== grant.ownerPath ||
    data.replaceDocument !== grant.replaceDocument ||
    data.contentDigest !== grant.contentDigest
  ) {
    refuse("stale-or-replayed-adoption-capability");
    return;
  }
  const version = normaliseDiskVersion(data.diskVersion);
  const currentKey = resolveCanonicalFileKey(data.filePath);
  const proposedOwner = normaliseDocumentIdentity(
    data.proposedOwner,
    data.ownerFilePath,
    { useCurrentPathIdentity: true, forAdoption: true },
  );
  const oldOwner = data.oldOwner
    ? closingDocumentOwnerFromEnvelope(event, {
        ...data.oldOwner,
        filePath: data.ownerFilePath,
      })
    : null;
  if (
    !version ||
    diskVersionChanged(version, grant.version) ||
    version.mtimeMs !== data.modifiedTime ||
    !currentKey ||
    currentKey !== grant.proposedOwner.pathKey ||
    resolveCanonicalFileKey(data.ownerFilePath) !== currentKey ||
    !proposedOwner ||
    proposedOwner.documentRef !== grant.proposedOwner.documentRef ||
    documentOwnerKey(proposedOwner) !== grant.proposedOwnerKey ||
    documentOwnerKey(oldOwner) !== grant.oldOwnerKey ||
    (data.oldOwner && !oldOwner) ||
    (oldOwner &&
      (oldOwner.tabId !== proposedOwner.tabId ||
        (!ownerDocumentBaselines.has(documentOwnerKey(oldOwner)) &&
          !documentDeletionTombstones.has(documentOwnerKey(oldOwner))))) ||
    filePathSpellingKey(data.filePath) !== grant.incomingSpelling ||
    filePathSpellingKey(data.ownerFilePath) !== grant.ownerSpelling
  ) {
    refuse("capability-target-mismatch");
    return;
  }
  if (
    oldOwner &&
    grant.ownerSpelling !== grant.incomingSpelling &&
    matchedOwnerHasDeletionEvidence(oldOwner, grant.ownerPath)
  ) {
    refuse("matched-owner-deletion-evidence");
    return;
  }
  const relatedOrphans = unreachablePhysicalDeletionSpellings(
    currentKey, grant.incomingSpelling,
  );
  if (
    relatedOrphans.length !== grant.relatedOrphanSpellings.length ||
    relatedOrphans.some((spelling, index) =>
      spelling !== grant.relatedOrphanSpellings[index])
  ) {
    refuse("physical-orphan-evidence-changed");
    return;
  }
  const ownDeletion = !!(
    oldOwner &&
    documentDeletionTombstones.has(documentOwnerKey(oldOwner))
  );
  const overflowKeys = adoptionOverflowKeys(
    grant.incomingSpelling, oldOwner, proposedOwner, currentKey,
  );
  const evidenceKeys = adoptionEvidencePathKeys(
    grant.incomingSpelling, oldOwner, proposedOwner,
  );
  const livePathOnlyKeys = pathOnlyDeletionEvidence.get(
    grant.incomingSpelling,
  );
  if (livePathOnlyKeys) {
    for (const key of livePathOnlyKeys) evidenceKeys.add(key);
  }
  for (const key of overflowKeys) {
    const record = deletionOverflowEvidence.get(key);
    if (!record || !record.pathKey) {
      refuse("invalid-overflow-provenance");
      return;
    }
    evidenceKeys.add(record.pathKey);
  }
  if (grant.resolutionOnly) {
    const selectedOverflow = overflowKeys.filter((key) =>
      deletionOverflowEvidence.get(key)?.pathKey ===
        grant.evidencePathKey);
    if (
      evidenceKeys.size < 2 ||
      !evidenceKeys.has(grant.evidencePathKey) ||
      !historicalEpisodeCanBeRetired(
        grant.incomingSpelling, grant.evidencePathKey, oldOwner,
      ) ||
      selectedOverflow.length !== grant.overflowKeys.length ||
      selectedOverflow.some((key) =>
        !grant.overflowKeys.includes(key)) ||
      (grant.pathOnlyKey !== null &&
        !livePathOnlyKeys?.has(grant.pathOnlyKey))
    ) {
      refuse("historical-episode-moved");
      return;
    }
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : null;
    if (!win) {
      refuse("approval-window-unavailable");
      return;
    }
    let choice;
    try {
      choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Retire this older copy", "Keep it"],
        defaultId: 1,
        cancelId: 1,
        title: "Earlier deleted document",
        message: `"${safeFileLabel(path.basename(data.filePath))}" has an older unresolved file target.`,
        detail: `Former target: ${safeFileLabel(grant.evidencePathKey)}\n\nThis confirmation retires only that older copy. Other open copies remain protected.`,
      });
    } catch (error) {
      console.error("Could not ask about an older document:", error);
      refuse("approval-dialog-failed");
      return;
    }
    if (choice !== 0) {
      refuse("historical-episode-kept");
      return;
    }
    const currentStats = readDocumentStats(
      data.filePath, "while retiring a historical episode",
    );
    if (
      grant.revision !== deletionEvidenceRevision ||
      !currentStats ||
      resolveCanonicalFileKey(data.filePath) !== currentKey ||
      diskVersionChanged(
        grant.version, diskVersionFromStats(currentStats),
      )
    ) {
      refuse("historical-episode-changed");
      return;
    }
    clearDeletionEvidenceForAdoption(data.filePath, proposedOwner, {
      allowPathReplacement: true,
      priorPathKey: grant.evidencePathKey,
      retireOrphanedOwners: true,
      retirePathOnlyKey: grant.pathOnlyKey,
      allowedOverflowKeys: grant.overflowKeys,
      evidencePathKey: grant.evidencePathKey,
    });
    if (
      adoptionEvidencePathKeys(
        grant.incomingSpelling, oldOwner, proposedOwner,
      ).has(grant.evidencePathKey) ||
      pathOnlyDeletionEvidence.get(grant.incomingSpelling)
        ?.has(grant.evidencePathKey) ||
      grant.overflowKeys.some((key) =>
        deletionOverflowEvidence.has(key))
    ) {
      refuse("historical-episode-remains");
      return;
    }
    event.returnValue = Object.freeze({
      accepted: false,
      why: "resolved-historical-episode",
      revision: deletionEvidenceRevision,
      remainingPhysicalEpisodes: evidenceKeys.size - 1,
    });
    return;
  }
  const deletionNeedsConsent =
    ownDeletion ||
    orphanedDeletionForSpelling(data.filePath, proposedOwner) ||
    pathOnlyDeletionForSpelling(data.filePath) ||
    overflowKeys.length > 0;
  if (
    overflowKeys.length !== grant.overflowKeys.length ||
    overflowKeys.some((key) => !grant.overflowKeys.includes(key)) ||
    evidenceKeys.size !== (grant.evidencePathKey ? 1 : 0) ||
    (grant.evidencePathKey &&
      !evidenceKeys.has(grant.evidencePathKey)) ||
    (pathOnlyDeletionEvidence.get(grant.incomingSpelling)
      ? pathOnlyDeletionEvidence.get(grant.incomingSpelling).size !== 1 ||
        !pathOnlyDeletionEvidence.get(grant.incomingSpelling)
          .has(grant.pathOnlyKey)
      : grant.pathOnlyKey !== null)
  ) {
    refuse("adoption-evidence-changed");
    return;
  }
  if (
    sharedDeletionEvidenceNeedsSiblingCheck(
      grant.incomingSpelling, grant.evidencePathKey,
      oldOwner, grant.pathOnlyKey, grant.overflowKeys,
    ) &&
    deletionEvidenceHasDependentSibling(
      grant.oldOwnerKey, grant.evidencePathKey,
    )
  ) {
    refuse("live-sibling-deletion-evidence");
    return;
  }
  if (
    deletionNeedsConsent &&
    grant.ownerSpelling !== grant.incomingSpelling
  ) {
    refuse("cross-spelling-deletion-adoption");
    return;
  }
  const confirmationRequired =
    deletionNeedsConsent ||
    relatedOrphans.length > 0 ||
    !!(oldOwner && oldOwner.pathKey !== currentKey);
  if (confirmationRequired) {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : null;
    if (!win) {
      refuse("approval-window-unavailable");
      return;
    }
    let choice;
    try {
      choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Replace from disk", "Keep in-memory copy"],
        defaultId: 1,
        cancelId: 1,
        title: "Confirm document replacement",
        message: relatedOrphans.length > 0 && !deletionNeedsConsent
          ? `"${safeFileLabel(path.basename(data.filePath))}" shares a file with an unresolved older copy.`
          : `"${safeFileLabel(path.basename(data.ownerFilePath))}" has an unresolved deletion or a changed file target.`,
        detail: relatedOrphans.length > 0 && !deletionNeedsConsent
          ? "The earlier copy stays protected. Opening this file does not retire its deletion evidence."
          : "Replacing it with the current disk file discards the earlier in-memory copy.",
      });
    } catch (error) {
      console.error("Could not ask about disk adoption:", error);
      refuse("approval-dialog-failed");
      return;
    }
    if (choice !== 0) {
      refuse("adoption-declined");
      return;
    }
  }
  if (grant.revision !== deletionEvidenceRevision ||
      grant.pageSession !== approvalRendererPageSession ||
      grant.rendererGeneration !== approvalRendererGeneration) {
    refuse("adoption-moved-during-confirmation");
    return;
  }
  const before = readDocumentStats(
    data.filePath, "while committing disk adoption",
  );
  const after = before && readDocumentStats(
    data.filePath, "while confirming disk adoption",
  );
  if (
    !before ||
    !after ||
    resolveCanonicalFileKey(data.filePath) !== currentKey ||
    diskVersionChanged(version, diskVersionFromStats(before)) ||
    diskVersionChanged(version, diskVersionFromStats(after))
  ) {
    refuse("disk-version-or-target-moved");
    return;
  }
  committedDiskAdoptions.set(data.capability, Object.freeze({
    ...grant,
    acceptedAt: Date.now(),
    priorPathKey: oldOwner
      ? oldOwner.pathKey
      : filePathAliases.get(filePathSpellingKey(data.filePath)) ||
        filePathSpellingKey(data.filePath),
    deletionNeedsConsent,
  }));
  event.returnValue = Object.freeze({
    accepted: true,
    capability: data.capability,
    incomingSpelling: grant.incomingSpelling,
    ownerSpelling: grant.ownerSpelling,
    tabId: proposedOwner.tabId,
    documentGeneration: proposedOwner.documentGeneration,
    version,
    contentDigest: grant.contentDigest,
    confirmed: confirmationRequired,
    pathKey: currentKey,
    revision: deletionEvidenceRevision,
  });
});

function completeDocumentDiskAdoption(data) {
  const refused = (why) => Object.freeze({ completed: false, why });
  if (
    !data ||
    typeof data.capability !== "string" ||
    data.pageSession !== approvalRendererPageSession ||
    data.rendererGeneration !== approvalRendererGeneration
  ) {
    return refused("invalid-adoption-completion");
  }
  const grant = committedDiskAdoptions.get(data.capability);
  if (!grant) {
    return refused("unknown-or-used-adoption-capability");
  }
  const owner = normaliseDocumentIdentity(
    data.actualOwner,
    grant.ownerPath,
    { useCurrentPathIdentity: true, forAdoption: true },
  );
  const stats = readDocumentStats(
    grant.sourcePath,
    "while completing disk adoption",
  );
  if (
    !owner ||
    owner.documentRef !== grant.proposedOwner.documentRef ||
    documentOwnerKey(owner) !== grant.proposedOwnerKey ||
    data.filePath !== grant.sourcePath ||
    data.ownerFilePath !== grant.ownerPath ||
    data.revision !== grant.revision ||
    grant.revision !== deletionEvidenceRevision ||
    Date.now() - grant.acceptedAt > DISK_ADOPTION_CAPABILITY_MS ||
    !stats ||
    resolveCanonicalFileKey(grant.sourcePath) !== grant.versionPathKey ||
    diskVersionChanged(grant.version, diskVersionFromStats(stats))
  ) {
    return refused("adoption-moved-before-completion");
  }
  if (grant.deletionNeedsConsent) {
    const evidenceKeys = adoptionEvidencePathKeys(
      grant.incomingSpelling, grant.oldOwner, grant.proposedOwner,
    );
    const pathOnlyKeys = pathOnlyDeletionEvidence.get(
      grant.incomingSpelling,
    );
    if (pathOnlyKeys) {
      for (const key of pathOnlyKeys) evidenceKeys.add(key);
    }
    const overflowKeys = adoptionOverflowKeys(
      grant.incomingSpelling, grant.oldOwner,
      grant.proposedOwner, grant.versionPathKey,
    );
    for (const key of overflowKeys) {
      const record = deletionOverflowEvidence.get(key);
      if (record) evidenceKeys.add(record.pathKey);
    }
    if (
      evidenceKeys.size !== 1 ||
      !evidenceKeys.has(grant.evidencePathKey) ||
      (pathOnlyKeys
        ? pathOnlyKeys.size !== 1 ||
          !pathOnlyKeys.has(grant.pathOnlyKey)
        : grant.pathOnlyKey !== null) ||
      overflowKeys.length !== grant.overflowKeys.length ||
      overflowKeys.some((key) => !grant.overflowKeys.includes(key)) ||
      (grant.pathOnlyKey &&
        !pathOnlyDeletionByPathKey.get(grant.pathOnlyKey)
          ?.has(grant.incomingSpelling)) ||
      grant.overflowKeys.some((key) => {
        const record = deletionOverflowEvidence.get(key);
        return !record ||
          record.spelling !== grant.incomingSpelling ||
          record.pathKey !== grant.evidencePathKey;
      }) ||
      (sharedDeletionEvidenceNeedsSiblingCheck(
        grant.incomingSpelling, grant.evidencePathKey,
        grant.oldOwner, grant.pathOnlyKey, grant.overflowKeys,
      ) && deletionEvidenceHasDependentSibling(
        grant.oldOwnerKey, grant.evidencePathKey,
      ))
    ) {
      return refused("deletion-evidence-moved-before-completion");
    }
    // Clearing is irreversible (including queued deletion deliveries). Prove
    // the one episode is retireable before changing the alias or its baseline.
    const records = deletionTombstonesBySpelling.get(
      grant.incomingSpelling,
    );
    if (records && Array.from(records).some((record) => {
      const relevant =
        record.key === grant.oldOwnerKey ||
        record.owner.pageSession !== approvalRendererPageSession ||
        record.owner.rendererGeneration !== approvalRendererGeneration ||
        (record.owner.tabId === owner.tabId &&
          record.owner.documentGeneration !== owner.documentGeneration);
      if (!relevant) return false;
      const orphaned =
        record.owner.pageSession !== approvalRendererPageSession ||
        record.owner.rendererGeneration !== approvalRendererGeneration ||
        (record.owner.tabId === owner.tabId &&
          record.owner.documentGeneration !== owner.documentGeneration);
      return record.pathKey !== grant.evidencePathKey ||
        documentDeletionTombstones.get(record.key) !== record ||
        (!orphaned && !sameDocumentGeneration(record.owner, owner));
    })) {
      return refused("deletion-episode-cannot-be-retired");
    }
  }
  // ADMISSION IS PART OF THE ADOPTION, NOT A MESSAGE THAT FOLLOWS IT. Every
  // caller arrives here - the foreground selection, and the background,
  // owner-bound and independent tabs that complete straight over IPC - but
  // only the foreground one asked whether the adopting owner could still be
  // admitted. For the others the owner was offered afterwards, in a separate
  // fire-and-forget `register-document-owner` that nobody waits on and that
  // the hard owner-table cap may refuse outright. By then this function has
  // spent a capability that cannot be reissued and retired deletion evidence
  // the reader never saw, for a document whose owner is not on record: the
  // previous owner is still known, still watched and so still able to save,
  // with the warning that would have stopped it gone. So the owner is
  // admitted HERE, in the same synchronous step that retires the evidence,
  // and the admission is proved possible before anything irreversible runs.
  // The registration those callers still send afterwards then re-states a
  // fact rather than establishing one.
  //
  // THE IDENTITY IS THE ONE ALREADY VALIDATED ABOVE, never a second reading
  // of the request: `owner` has been checked against the grant's proposed
  // owner key, so reusing it verbatim keeps the admitted owner and the
  // adopted grant the same document by construction. Only the selection
  // generation is taken from the envelope, under the same predicate
  // `normaliseDocumentOwner` applies to it - and deliberately NOT by
  // re-normalising, which would resolve this path a second time and could
  // report "no generation supplied" for a path that merely moved between the
  // two resolutions, silently admitting a foreground owner at generation 1.
  const suppliedSelection =
    Number.isSafeInteger(data.actualOwner.selectionGeneration) &&
    data.actualOwner.selectionGeneration > 0
      ? data.actualOwner.selectionGeneration
      : null;
  const registeredSelection = knownDocumentOwners.get(
    grant.proposedOwnerKey,
  );
  const selectionOwner = Object.freeze({
    ...owner,
    // A completion that carries no selection generation - the background
    // callers build their envelope from a bare identity - is admitted with
    // the least authority that is legal, which is exactly what the background
    // registration it stands in for would have used. An owner already on
    // record keeps its own, so re-admitting it can never read as a downgrade
    // to `canRememberDocumentOwner` and refuse a completion that used to
    // succeed. A supplied generation confers nothing the same renderer could
    // not already register directly: the watcher handlers read the generation
    // they are given, not the one on record, and admission alone is not a
    // watch.
    selectionGeneration: suppliedSelection !== null
      ? suppliedSelection
      : registeredSelection
        ? registeredSelection.selectionGeneration
        : 1,
  });
  if (!canRememberDocumentOwner(selectionOwner)) {
    return refused("adoption-owner-cannot-be-admitted");
  }
  // Asked while a refusal is still free: nothing has been spent, the grant
  // stays committed and the deletion evidence stays unread, so the renderer
  // can retry with both intact. The answer still holds at the registration
  // below because a completion is ONE synchronous step - no other IPC message
  // can interleave - and because everything done in between only removes pins
  // (the capability it spends, the evidence it retires) or adds the very
  // owner this is proving room for.
  if (!documentOwnerTableHasRoomFor(selectionOwner, data.capability)) {
    noteDocumentOwnerTablePinnedRefusal("adoption");
    return refused("adoption-owner-table-full");
  }
  const adoption = {};
  const adoptedKey = adoptDocumentBaseline(
    grant.sourcePath,
    grant.version.mtimeMs,
    "while completing disk adoption",
    grant.version,
    adoption,
    grant.versionPathKey,
    false,
  );
  if (
    !adoptedKey ||
    !adoption.accepted ||
    adoptedKey !== grant.versionPathKey
  ) {
    return refused("disk-version-moved-before-completion");
  }
  // The capability is spent FIRST so the pin it contributes is really gone:
  // the room proved above discounted exactly this grant, and the drain inside
  // `rememberDocumentOwner` cannot know which capability is being consumed.
  // Admission is unreachable as a failure here, and this is what happens if
  // that ever stops being true. The capability goes back and the evidence is
  // never touched, but `adoptDocumentBaseline` has already run and cannot be
  // undone - it has bound the alias, taken the disk version as the baseline
  // and CLEARED this path's changed-underneath markers, while the renderer
  // keeps the copy it already had. So the markers are put back: a refusal
  // must not be the thing that lets the next save overwrite a file main has
  // quietly adopted for nobody.
  committedDiskAdoptions.delete(data.capability);
  if (!rememberDocumentOwner(selectionOwner, {
    diskVersion: grant.version,
    modifiedTime: grant.version.mtimeMs,
    adopted: true,
    readPath: grant.sourcePath,
    acceptedReadTarget: grant.acceptedReadTarget,
  })) {
    committedDiskAdoptions.set(data.capability, grant);
    markDocumentChangedExternally(grant.sourcePath);
    console.error("Refusing a disk adoption: its owner could not be admitted");
    return refused("adoption-owner-not-admitted");
  }
  let unresolvedEvidence = false;
  if (grant.deletionNeedsConsent) {
    clearDeletionEvidenceForAdoption(grant.sourcePath, owner, {
      allowPathReplacement: true,
      priorPathKey: grant.priorPathKey,
      retireOrphanedOwners: true,
      retirePathOnlyKey: grant.pathOnlyKey,
      allowedOverflowKeys: grant.overflowKeys,
      evidencePathKey: grant.evidencePathKey,
    });
    if (
      (grant.pathOnlyKey &&
        pathOnlyDeletionEvidence.get(grant.incomingSpelling)
          ?.has(grant.pathOnlyKey)) ||
      orphanedDeletionForSpelling(grant.sourcePath, owner) ||
      (grant.oldOwnerKey &&
        documentDeletionTombstones.has(grant.oldOwnerKey)) ||
      grant.overflowKeys.some((key) =>
        deletionOverflowEvidence.has(key))
    ) {
      console.error("Disk adoption left deletion evidence for its owner");
      unresolvedEvidence = true;
    }
  }
  if (grant.ownerSpelling !== grant.incomingSpelling) {
    filePathAliases.set(grant.ownerSpelling, grant.versionPathKey);
  }
  // The adopting owner's baseline is not refreshed here any more: the
  // admission above registered it as an ADOPTED baseline carrying this
  // grant's version, which is the same write this block used to make and
  // which now also happens for an owner that was not already on record.
  return Object.freeze({
    completed: true,
    capability: data.capability,
    revision: deletionEvidenceRevision,
    unresolvedEvidence,
  });
}

ipcMain.on("complete-document-disk-adoption", (event, data) => {
  event.returnValue = isApprovalSender(event)
    ? completeDocumentDiskAdoption(data)
    : Object.freeze({
        completed: false, why: "invalid-adoption-sender",
      });
});

ipcMain.on("abandon-document-disk-adoption", (event, data) => {
  if (!isApprovalSender(event) || !data ||
      data.pageSession !== approvalRendererPageSession ||
      data.rendererGeneration !== approvalRendererGeneration) return;
  committedDiskAdoptions.delete(data.capability);
  pendingDiskAdoptions.delete(data.capability);
});

ipcMain.on("query-document-deletion-state", (event, data) => {
  const owner = closingDocumentOwnerFromEnvelope(event, data);
  const ownerKey = documentOwnerKey(owner);
  event.returnValue = owner &&
    (ownerDocumentBaselines.has(ownerKey) ||
      documentDeletionTombstones.has(ownerKey))
    ? describeDocumentDeletionState(owner, data.filePath)
    : Object.freeze({ known: false });
});

ipcMain.on("report-adoption-tracking-conflict", (event, data) => {
  const owner = data && closingDocumentOwnerFromEnvelope(event, {
    ...data.owner,
    filePath: data.filePath,
  });
  if (
    !owner ||
    data.pageSession !== owner.pageSession ||
    data.rendererGeneration !== owner.rendererGeneration ||
    !ownerDocumentBaselines.has(documentOwnerKey(owner))
  ) return;
  try {
    fs.statSync(data.filePath);
    markDocumentChangedExternally(data.filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      openDeletionDelivery(data.filePath, owner);
    } else {
      console.error("Could not check rejected file tracking:", error);
      addPathUnadoptedChange(owner.spelling);
    }
  }
});

function retirementRefusal(why, state = null) {
  return Object.freeze({
    retired: false,
    why,
    revision: deletionEvidenceRevision,
    // `null` where the caller could not be authenticated, which is not the
    // same claim as "nothing is deleted".
    unresolved: state ? state.unresolved : null,
  });
}

function retireDeletedDocumentOwner(event, data) {
  const closingOwner = closingDocumentOwnerFromEnvelope(event, data);
  if (!closingOwner) return retirementRefusal("invalid-identity");
  const closingOwnerKey = documentOwnerKey(closingOwner);
  if (!closingOwnerKey) return retirementRefusal("invalid-identity");
  // The tombstone table is keyed by owner, so this lookup is owner-scoped by
  // construction: it can never reach another tab's record.
  const record = documentDeletionTombstones.get(closingOwnerKey) || null;
  const state = describeDocumentDeletionState(closingOwner, data.filePath);

  if (state.unreadable) {
    return retirementRefusal("deletion-state-unreadable", state);
  }
  if (
    state.unresolved &&
    !record &&
    !ownerDocumentBaselines.has(closingOwnerKey)
  ) {
    return retirementRefusal("owner-not-registered", state);
  }
  // VALIDATED BEFORE ANYTHING IS MUTATED. Deauthorizing the owner and then
  // refusing left a still-open tab with no save authority and no way to get it
  // back, which is a worse outcome than the refusal was protecting against.
  if (state.unresolved && data.acknowledgedDeletion !== true) {
    // Evidence the reader was never shown. Refuse without touching anything,
    // so the close can consult again, warn, and come back.
    deletionRetirementUnacknowledgedCount += 1;
    return retirementRefusal("deletion-unacknowledged", state);
  }

  // MUTABLE DRIFT IS NOT A MISMATCH. `attempt`, `selectionGeneration` and
  // `watcherGeneration` are rewritten on every delivery attempt, so a token
  // the renderer read a moment ago is stale by design and comparing it
  // manufactured refusals. A newer event id for the SAME owner is the same
  // fact about the same document. What authorises the retirement is the
  // authenticated owner plus the reader's explicit confirmation, evaluated
  // against live state above - not a snapshot token.
  if (
    record &&
    Number.isSafeInteger(data.eventId) &&
    data.eventId !== record.id
  ) {
    deletionRetirementEventDriftCount += 1;
  }

  forgetDocumentOwnerAliases(closingOwnerKey);
  sweepRevokedAdmissionOwners();
  const retiredEvidence = record ? retireDeletionOwnerEvidence(record) : false;
  let retiredPathOnly = false;
  if (
    data.acknowledgedDeletion === true &&
    pathOnlyDeletionForSpelling(data.filePath)
  ) {
    const spelling = filePathSpellingKey(data.filePath);
    const keys = pathOnlyDeletionEvidence.get(spelling);
    const pathOnlyKey = keys.has(closingOwner.pathKey)
      ? closingOwner.pathKey
      : keys.size === 1
        ? keys.values().next().value
        : null;
    const siblingDependsOnDeletion =
      !!pathOnlyKey &&
      Array.from(ownerDocumentBaselines.values()).some((baseline) => {
        const sibling = baseline.owner;
        if (sibling.spelling === spelling &&
            sibling.pathKey === pathOnlyKey) return true;
        if (sibling.pathKey !== pathOnlyKey) return false;
        try {
          const stats = fs.statSync(sibling.spelling);
          return (
            resolveCanonicalFileKey(sibling.spelling) !== sibling.pathKey ||
            (!!baseline.version &&
              diskVersionChanged(
                baseline.version,
                diskVersionFromStats(stats),
              )) ||
            (Number.isFinite(baseline.modifiedTime) &&
              stats.mtimeMs !== baseline.modifiedTime)
          );
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") {
            return true;
          }
          console.error("Could not verify a closing deletion sibling:", error);
          return true;
        }
      });
    if (pathOnlyKey && !siblingDependsOnDeletion) {
      retiredPathOnly = retirePathOnlyDeletion(data.filePath, pathOnlyKey);
      for (const key of [pathOnlyKey]) {
        if (
          pathKeyHasDeletionEvidence(key) ||
          Array.from(deletionOverflowEvidence.values()).some(
            (candidate) => candidate.pathKey === key,
          )
        ) continue;
        deletedDocuments.delete(key);
        deleteDocumentUnadoptedChange(key);
        if (!Array.from(ownerDocumentBaselines.values()).some(
          (baseline) => baseline.owner.pathKey === key,
        )) {
          documentModifiedTimes.delete(key);
          documentVersions.delete(key);
        }
      }
      if (
        !pathOnlyDeletionEvidence.has(spelling) &&
        !deletionTombstonesBySpelling.has(spelling)
      ) {
        deletePathUnadoptedChange(spelling);
      }
    }
  }
  const remainingUnresolved =
    describeDocumentDeletionState(closingOwner, data.filePath).unresolved;
  // Retiring this tab is also the authenticated close boundary for its
  // watcher, including when an earlier failed selection left it inactive.
  if (sameDocumentOwner(closingOwner, watchedOwner)) {
    watchingPaused = false;
    stopFileWatching({ clearBaselines: false });
  }
  const admission = closingOwner.documentRef
    ? documentAdmissions.get(closingOwner.documentRef) : null;
  if (admission) {
    admission.retired = true;
    protectedSessionEntries.delete(admission.descriptor.entryId);
    unavailableSessionEntries.delete(admission.descriptor.entryId);
  }
  return Object.freeze({
    retired: true,
    why: record || retiredPathOnly ? "retired" : "no-evidence",
    revision: deletionEvidenceRevision,
    retiredEvidence: retiredEvidence || retiredPathOnly,
    // Read back AFTER the retirement. Closing one owner does not resolve a
    // path that another owner still has an open report for, and reporting a
    // flat `false` here would claim otherwise.
    unresolved: remainingUnresolved,
  });
}

ipcMain.on("retire-deleted-document-owner", (event, data) => {
  event.returnValue = retireDeletedDocumentOwner(event, data);
});

let reloadRequestEpoch = 0;
let staleReloadReplyDropCount = 0;
const staleReloadReplyDropsByReason = new Map();
let lastReloadRequestSession = null;
let backgroundReloadWatcherBaselineSkipCount = 0;

function recordStaleReloadReply(reason) {
  staleReloadReplyDropCount += 1;
  staleReloadReplyDropsByReason.set(
    reason,
    (staleReloadReplyDropsByReason.get(reason) || 0) + 1,
  );
}

function reloadReplyScopeState(scope) {
  if (!scope.sender || scope.sender.isDestroyed()) return "destroyed";
  if (approvalRendererGeneration !== scope.generation) return "navigation";
  const owner = shutdownOwnerWindow();
  if (!owner || owner.webContents !== scope.sender) return "owner";
  let mainFrame;
  try {
    mainFrame = scope.sender.mainFrame;
    if (!mainFrame || mainFrame.isDestroyed()) return "frame";
    if (
      mainFrame !== scope.frame &&
      mainFrame.frameTreeNodeId !== scope.frameTreeNodeId
    ) {
      return "frame";
    }
  } catch {
    return "frame";
  }
  return null;
}

function safeSendReloadResult(scope, success, data) {
  const staleWhy = reloadReplyScopeState(scope);
  if (staleWhy) {
    recordStaleReloadReply(staleWhy);
    return false;
  }
  if (shutdownCommitIngressBlocked) {
    recordStaleReloadReply("shutdown-frozen");
    log("Reload refused while a shutdown commit is frozen:", data.path);
    try {
      scope.sender.send(
        "show-error",
        `File reload was refused while closing: ${safeFileLabel(
          path.basename(data.path || "unknown file"),
        )}. Retry after closing is cancelled.`,
      );
    } catch (error) {
      log("Could not report refused file reload:", error);
    }
    return false;
  }
  try {
    sendIPCResult(scope.sender, "file-reload-result", success, {
      ...data,
      reloadSession: scope.session,
    });
    return true;
  } catch {
    recordStaleReloadReply("send-race");
    return false;
  }
}

// Handle file reload request
//
// DELIBERATELY NOT SIZE-GUARDED. This path refreshes a document that is
// already open, which means the reader has already been asked about its cost
// once and said yes. It is also the single most-repeated action in this fork -
// the tabbed refresh workflow exists precisely so that files being rewritten
// underneath you can be re-read constantly - so a confirmation here would fire
// dozens of times in a session for a document the reader already committed to.
// The guard belongs on the paths that OPEN something new, not on the ones that
// re-read something chosen.
ipcMain.on("reload-file", (event, data) => {
  if (!isApprovalSender(event)) {
    recordStaleReloadReply("untrusted-request");
    return;
  }
  const sender = event.sender;
  const frame = event.senderFrame;
  const scope = {
    sender,
    frame,
    generation: approvalRendererGeneration,
    frameTreeNodeId: frame.frameTreeNodeId,
    session: Object.freeze({
      epoch: ++reloadRequestEpoch,
      rendererGeneration: approvalRendererGeneration,
      pageSession: data && data.reloadRequestSession,
    }),
  };
  lastReloadRequestSession = scope.session;
  const requestedPath = data && data.filePath;
  const reloadRequest = Object.freeze({
    sequence: data && data.reloadRequestSequence,
    path: data && data.reloadRequestPath,
    snapshot: data && data.reloadRequestSnapshot,
    session: data && data.reloadRequestSession,
    tabId: data && data.reloadRequestTabId,
    documentGeneration:
      data && data.reloadRequestDocumentGeneration,
    pathKey: data && data.reloadRequestDocumentPathKey,
    rendererGeneration:
      data && data.reloadRequestRendererGeneration,
    selectionGeneration:
      data && data.reloadRequestSelectionGeneration,
  });
  if (
    !Number.isSafeInteger(reloadRequest.sequence) ||
    reloadRequest.sequence <= 0 ||
    typeof reloadRequest.path !== "string" ||
    reloadRequest.path.length === 0 ||
    typeof reloadRequest.snapshot !== "string" ||
    typeof reloadRequest.session !== "string" ||
    reloadRequest.session.length === 0 ||
    !Number.isSafeInteger(reloadRequest.tabId) ||
    reloadRequest.tabId <= 0 ||
    !Number.isSafeInteger(reloadRequest.documentGeneration) ||
    reloadRequest.documentGeneration <= 0 ||
    typeof reloadRequest.pathKey !== "string" ||
    reloadRequest.pathKey.length === 0
  ) {
    safeSendReloadResult(scope, false, {
      error: "Invalid reload request identity",
      reloadRequest,
    });
    return;
  }
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    safeSendReloadResult(scope, false, {
      error: "Invalid file path",
      reloadRequest,
    });
    return;
  }
  // This canonical path alone is filesystem authority. The request metadata is
  // echoed opaquely so the renderer can prove that the document has not moved
  // since send; it is never substituted into the disk read.
  const filePath = path.resolve(requestedPath);

  if (!fs.existsSync(filePath)) {
    if (sameFilePath(watchedFilePath, filePath) && watchedOwner) {
      openDeletionDelivery(filePath, watchedOwner);
    }
    safeSendReloadResult(scope, false, {
      error: "File not found",
      path: filePath,
      reloadRequest,
    });
    return;
  }

  // Use helper function for reading markdown files
  readMarkdownSnapshot(filePath, (err, content, modifiedTime, diskVersion) => {
    const staleWhy = reloadReplyScopeState(scope);
    if (staleWhy) {
      recordStaleReloadReply(staleWhy);
      return;
    }
    if (err) {
      console.error("Error reloading file:", err);
      safeSendReloadResult(scope, false, {
        error: err.message,
        path: filePath,
        reloadRequest,
      });
    } else {
      if (!sameFilePath(watchedFilePath, filePath)) {
        backgroundReloadWatcherBaselineSkipCount += 1;
      }

      safeSendReloadResult(scope, true, {
        content,
        path: filePath,
        modifiedTime,
        diskVersion,
        reloadRequest,
      });
    }
  });
});

// ============================================
// IPC HANDLERS - Popups
// ============================================

ipcMain.on("open-mermaid-popup", (event, data) => {
  const { svgContent, isDarkMode } = data;

  // Create popup window
  const popupWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: isDarkMode ? "#1a1a1a" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: popupWebPreferences("mermaid"),
    title: "Mermaid Diagram - Zoom with mouse wheel, Pan by dragging",
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "mermaid");

  popupWindow.setMenu(null);

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
            /* No will-change here, deliberately. Promoting the viewport to its
               own composited layer makes Chromium rasterize the SVG ONCE and
               then scale that bitmap: measured at 600% zoom, glyph edges went
               from crisp vector outlines to a visibly soft upscale. Without the
               hint the transform is still composited, it just re-rasterizes at
               the new scale, which is the whole point of a vector pop-out. */
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
  const tmpDoc = writePopupDocument("mermaid", htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tmpDoc.file);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
  });

  // Handle PDF export request from this popup window
  const mermaidPdfHandler = async (ev) => {
    if (BrowserWindow.fromWebContents(ev.sender) !== popupWindow) return;
    try {
      // INGRESS. Refused before the render and before a destination is chosen.
      if (deletionEvidenceCapacityLatched) {
        popupWindow.webContents.send(
          "mermaid-pdf-result",
          deletionEvidenceCapacityWriteRefusal("ingress"),
        );
        return;
      }
      const printOptions = {
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
        // BEFORE THE WRITE. printToPDF and the dialog are both awaits, so the
        // latch may have tripped since the ingress check above.
        if (deletionEvidenceCapacityLatched) {
          popupWindow.webContents.send(
            "mermaid-pdf-result",
            deletionEvidenceCapacityWriteRefusal("before-write"),
          );
          return;
        }
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
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "image");

  popupWindow.setMenu(null);

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
      /* will-change is deliberately absent here too - see the mermaid popup for
         the measurement. This viewport is NOT raster-only: safeImageSrc() admits
         data:image/svg+xml and .svg paths, so it carries vector content that
         blurs in exactly the same way. */
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

  const tmpDoc = writePopupDocument("image", htmlContent);
  popupWindow.loadFile(tmpDoc.file);
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
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

  // INGRESS, after the payload is judged and before any dialog. Ordered as the
  // markdown Save orders it: an unreadable request is unreadable whatever the
  // latch says, and a legible one is refused before it can choose a path.
  if (deletionEvidenceCapacityLatched) {
    event.reply(
      "image-popup-save-result",
      deletionEvidenceCapacityWriteRefusal("ingress"),
    );
    return;
  }

  try {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `image.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    });

    if (result.canceled) {
      event.reply("image-popup-save-result", { canceled: true });
      return;
    }

    // BEFORE THE WRITE. The dialog is an await, and the destination in hand is
    // a file that does not exist yet. The chosen path is NOT echoed back: this
    // protocol has never carried one, and the image popup is not a surface to
    // start disclosing filesystem paths to.
    if (deletionEvidenceCapacityLatched) {
      event.reply(
        "image-popup-save-result",
        deletionEvidenceCapacityWriteRefusal("before-write"),
      );
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

// ============================================================================
// THE TABLE-POPUP TRUST BOUNDARY.
//
// `tableData` arrives over IPC from a renderer that built it out of a markdown
// document, so both its VALUES and its SHAPE are hostile. The shape matters as
// much as the values, which is not obvious: Tabulator resolves a column
// definition against its own option surface, so keys the SENDER chooses can
// switch off the escaping this boundary would otherwise rely on. Measured in
// the vendored 6.5.2 bundle:
//   - mapDefinitions() fills a key only where the column left it undefined,
//     and formatHeader() tests truthiness. So titleFormatter: "html" - whose
//     formatter is literally "return e.getValue()" - or "" or null defeats any
//     titleFormatter default, without raising a warning.
//   - formatter: "html" switches off CELL escaping the same way. Cells are
//     escaped only because an unset formatter defaults to plaintext ->
//     sanitizeHTML, which is the entire reason SEC-06 passes; a sender-chosen
//     formatter takes that default away. SEC-06's fixture now carries
//     formatter: "html" so this claim is MEASURED - before that, dropping
//     `formatter` from the allow-list would have broken nothing visible.
//     Revert R504.
//   - headerTooltip: true - a BOOLEAN, carrying no markup whatsoever - makes
//     loadTooltip run s.innerHTML = definition.title. No amount of value
//     scrubbing can close that one; only refusing the key can. Tooltip
//     .initializeColumn subscribes to column-mousemove ONLY when some column
//     definition carries headerTooltip, so dropping the key means the sink is
//     never even wired - which is why the suite also FORCES it back on via
//     updateDefinition and proves the escaped title is still inert there.
// So this emits a FRESH object with an allow-listed shape, and drops anything
// the sender added rather than validating it. A deny-list would fail the day a
// Tabulator upgrade adds a key nobody here has read.
//
// WHAT ACTUALLY REACHES HERE FROM A DOCUMENT, measured rather than assumed:
// literal markup in a header does NOT survive the producer. DOMPurify strips
// the dangerous attributes, and extractTableData() then reads the header's
// textContent, which drops any surviving element outright. What DOES arrive is
// markup written as ENTITIES, because that is text at every earlier layer and
// only becomes markup again if something assigns it through innerHTML - which
// is exactly what Tabulator does with a column title. So this boundary is the
// layer that matters for the realistic payload, not a redundant third copy of
// the sanitizer.
//
// TITLES ARE ESCAPED HERE RATHER THAN FORMATTED DOWNSTREAM, and that is the
// architecture rather than an implementation detail. definition.title has at
// least three innerHTML readers in 6.5.2 - the header
// (_formatColumnHeaderTitle), the responsive-collapse panel
// (formatCollapsedData) and the tooltip (loadTooltip) - and a titleFormatter
// reaches only the first. Storing ALREADY-ESCAPED text in `title` closes every
// reader REACHABLE UNDER THIS ALLOW-LISTED SHAPE, because each of them assigns
// through innerHTML and innerHTML renders the escaped bytes back as the
// original characters.
//
// That is a narrower claim than "closes every reader", and the difference
// matters. The bundle also has TEXT-CONTEXT readers, which would paint a
// literal "&lt;" at the user: editableTitle's input.value = definition.title,
// the group-header aria-title setAttribute, and the clipboard-paste header
// matcher's string comparison. Those are out of reach because the ALLOW-LIST
// excludes them, not because of innerHTML. So widening the allow-list later -
// editableTitle, headerTooltip, nested `columns` - regresses this to
// entity-visible headers, and no test would fail. Widen it only together with
// a reader audit.
//
// The raw text goes into `titleDownload`. That is a registered column option
// (registerColumnOption("titleDownload"), so no unknown-option warning) and it
// is what the CSV exporter prefers: generateExportList sets colVisPropAttach
// to "Download" and processColumnGroup reads
// definition["title" + attach] || definition.title. So an exported header
// keeps its original characters while every rendered copy is inert. The JSON
// exporter is unaffected either way - it keys on getTitleDownload(), and
// Column.titleDownload is initialised to null and never assigned from the
// definition, so JSON has always keyed on `field`.
// ============================================================================
function normaliseTablePayload(tableData) {
  const src = tableData && typeof tableData === "object" ? tableData : {};
  const rawColumns = Array.isArray(src.columns) ? src.columns : [];
  const rawRows = Array.isArray(src.data) ? src.data : [];
  const columns = [];
  // The sender's own field names, kept ONLY as lookup keys into its own rows.
  // They never reach Tabulator.
  const lookups = [];
  for (let i = 0; i < rawColumns.length; i++) {
    const c =
      rawColumns[i] && typeof rawColumns[i] === "object" ? rawColumns[i] : {};
    const rawTitle = c.title == null ? "" : String(c.title);
    // U+00A0 for an empty title, and it has to become something non-empty for
    // two measured reasons: _buildColumnHeaderTitle renders title || "&nbsp;"
    // as HTML, and generateCollapsedRowData gates on
    // if (definition.title && field), so an empty title vanishes from the
    // collapse panel altogether. Deliberately NOT the producer's own
    // "Column N": an assertion naming that text would be satisfied by
    // extractTableData OR by this line, which measures a disjunction instead
    // of this boundary. U+00A0 passes through escapeHtml untouched and renders
    // as the blank header a reader already expects.
    const title = rawTitle.trim() === "" ? "\u00A0" : rawTitle;
    lookups.push(
      typeof c.field === "string" || typeof c.field === "number" ? c.field : i,
    );
    columns.push({
      title: escapeHtml(title),
      // The RAW original, not the U+00A0-substituted render title: the
      // substitution exists only so the header and the collapse panel have
      // something to paint, and exporting a non-breaking space where the
      // document had an empty header would be a data change. Falls back to
      // `title` only when rawTitle is "", because processColumnGroup reads
      // definition.titleDownload || definition.title and an empty string is
      // falsy - so "" would silently reach the escaped title anyway.
      //
      // LATENT, deliberately recorded: downloaders.html feeds this raw value
      // to generateHeaderElement, which does th.innerHTML = value. Nothing
      // reaches it today - the popup calls download("csv") and
      // download("json") only - but an "Export HTML" button would turn this
      // field back into live markup inside a file on disk.
      titleDownload: rawTitle || title,
      // Re-keyed by INDEX. Validating the incoming name would only have
      // narrowed a class of problems rather than removing it: a "." is a
      // nested-field lookup, duplicates silently collide, and a name matching
      // no row key blanks the column. The producer already emits col0..colN,
      // so this is a no-op in production.
      field: "col" + i,
      headerFilter: "input",
      headerFilterPlaceholder: "Filter...",
    });
  }
  const data = [];
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || typeof row !== "object") continue;
    // Rebuilt key by key rather than copied, so nothing off the sender's
    // prototype chain and no "__proto__"-shaped key survives into the
    // document. Coercing every value to a string additionally removes the
    // object branches from Tabulator's CSV and clipboard paths, which makes
    // exports deterministic.
    const out = {};
    for (let i = 0; i < columns.length; i++) {
      const key = lookups[i];
      const v = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : "";
      out["col" + i] = v == null ? "" : String(v);
    }
    data.push(out);
  }
  return { columns, data };
}

// Handle Table popup request
ipcMain.on("open-table-popup", (event, data) => {
  const { tableData, isDarkMode } = data || {};
  const safeTableData = normaliseTablePayload(tableData);

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
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
  });

  registerPopup(popupWindow, "table");

  popupWindow.setMenu(null);

  // Read Tabulator files from local directory. `libs/` is a SIBLING of src/,
  // not a child: it holds vendored third-party code with its own LICENSE and
  // .gitattributes pins, so it does not belong inside our own source tree.
  const tabulatorJsPath = path.join(
    __dirname,
    "..",
    "libs",
    "tabulator",
    "tabulator.min.js",
  );
  const tabulatorCssPath = path.join(
    __dirname,
    "..",
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
        const tableData = ${toJsonLiteral(safeTableData)};

        const table = new Tabulator("#data-table", {
            data: tableData.data,
            columns: tableData.columns,
            // NOTE FOR EDITORS: this comment is inside a template literal that
            // builds the popup HTML. Never write a backtick or a dollar-brace
            // interpolation opener in here - either one terminates the literal
            // and the file stops parsing.
            //
            // Column titles arrive ALREADY HTML-ESCAPED from
            // normaliseTablePayload, with the original text preserved in
            // titleDownload for the CSV export. That is why no titleFormatter
            // is configured here.
            //
            // There WAS a columnDefaults: { titleFormatter: "plaintext" } on
            // this line, and it was removed deliberately rather than
            // forgotten. It closed only ONE of the three innerHTML readers of
            // definition.title in 6.5.2 - the header - leaving the
            // responsive-collapse panel and the header tooltip live, both of
            // which were measured injecting markup and applying CSS with that
            // option in force. It was also defeatable from the payload itself,
            // since a per-column titleFormatter outranks a default. Escaping
            // at the boundary closes every reader at once, and re-adding a
            // formatter now would DOUBLE-escape and render entities to the
            // reader.
            //
            // Fields are col0..colN by construction, so nested lookups can
            // never be wanted; turning the separator off also skips a split()
            // per column in setField.
            nestedFieldSeparator: false,
            layout: "fitColumns",
            pagination: true,
            paginationSize: 50,
            paginationSizeSelector: [25, 50, 100, 200, true],
            paginationCounter: "rows",
            movableColumns: true,
            // No resizableColumns option: it is a Tabulator 4.x spelling and
            // is not recognised by 6.x, which validates constructor options and
            // logs a warning for unknown ones. Column resizing is on by default
            // via the per-column "resizable" default, so the option was a no-op
            // that bought a console warning. The 6.x spellings, if ever needed,
            // are resizableColumnFit and resizableColumnGuide.
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
  const tmpDoc = writePopupDocument("table", htmlContent);

  // Load the HTML file
  popupWindow.loadFile(tmpDoc.file);

  // Clean up temp file after window closes
  popupWindow.on("closed", () => {
    removePopupDocument(tmpDoc);
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
        deliverNativeDocumentIntent(mainWindow.webContents, filePath);
      });
    } else {
      deliverNativeDocumentIntent(mainWindow.webContents, filePath);
    }
  } else {
    // App not ready yet — store for did-finish-load
    fileToOpen = filePath;
  }
});

ipcMain.on("request-open-file", (event, data) => {
  const { filePath } = data;
  if (filePath && fs.existsSync(filePath)) {
    openFile(filePath, {
      sender: event.sender,
      rendererGeneration: approvalRendererGeneration,
    });
  }
});

// ============================================
// SINGLE INSTANCE LOCK & APP LIFECYCLE
// ============================================

// Windows identifies an application by its AppUserModelID, not by its window
// title. Without one set explicitly, a dev run groups under Electron's default
// id and a packaged run relies on the shortcut the installer wrote - so
// taskbar grouping, jump lists, pinning and toast attribution can all name
// something other than Folia even though the title bar reads correctly. Read
// from package.json rather than repeated as a literal, because electron-builder
// writes that same appId into the installer and the shortcut: any drift here
// silently splits one app into two taskbar identities.
//
// Windows-only by design - the call is a documented no-op elsewhere, but
// guarding it keeps the intent legible.
if (process.platform === "win32") {
  try {
    const { appId } = require("../package.json").build;
    if (appId) app.setAppUserModelId(appId);
  } catch {
    // Packaged asar layouts always contain package.json; a failure here must
    // never be the reason the app does not start.
  }
}

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
            deliverNativeDocumentIntent(mainWindow.webContents, fileToOpen);
            fileToOpen = null;
          });
        } else {
          log("Sending external-file-open-request immediately");
          deliverNativeDocumentIntent(mainWindow.webContents, fileToOpen);
          fileToOpen = null;
        }
      } else {
        log("No valid file found in command line arguments");
      }
    }
  });

  app.whenReady().then(() => {
    // Before any window exists, so no window can ever see the default menu.
    suppressDefaultApplicationMenu();

    // Set dock icon on macOS (applies in dev mode where the .icns bundle isn't used)
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setIcon(path.join(__dirname, "..", "assets", "app-icon.png"));
      } catch (e) {
        // Non-fatal: window still opens even if icon file is missing
      }
    }

    // SEC-30 layer 1 (defence in depth): deny every download except the app's
    // own in-memory exports.
    //
    // A download is NOT a navigation, so it is invisible to the will-navigate /
    // will-redirect / will-frame-navigate / setWindowOpenHandler denies in
    // createWindow(), and CSP has no directive that governs one. Measured: an
    // <a download href="http://..."> rendered into #tableInsertPreview - which
    // sits outside #viewer and so is not covered by the renderer's click
    // delegation - issued a live outbound request and fired will-download,
    // while a plain anchor in the same click batch was blocked by will-navigate.
    // This handler runs only once the response has begun, so it stops the file
    // drop, not the request; stripping the download attribute in the sanitizer
    // (renderer.js FORBID_ATTR) is what prevents the request itself.
    //
    // The allow-list is blob: only. The app's sole legitimate download through
    // a webContents session is Tabulator's table export (exportCSV/exportJSON),
    // measured at will-download as blob:file:///<uuid> with mime text/csv and
    // no network. (The auto-updater also downloads, but electron-updater uses
    // its own HTTP stack rather than a session, so it never reaches this
    // handler and is unaffected.)
    //
    // Precise about who can mint a blob: URL, because "document content cannot"
    // is FALSE: an @@@html block runs attacker-authored script, and it can call
    // URL.createObjectURL. What it cannot do is DOWNLOAD one - those frames are
    // pinned to sandbox="allow-scripts" with no allow-downloads, and their
    // opaque origin means a blob they mint is not loadable by the top frame
    // either. The top frame itself runs no document-authored script, so no
    // untrusted blob: URL can reach a download here.
    //
    // No data: allowance is needed: DOMPurify's default ALLOWED_URI_REGEXP does
    // not admit data: on an <a href>, so such an anchor loses its href.
    //
    // defaultSession is the complete surface: main.js creates no partitions and
    // passes no custom session to any of its four BrowserWindow sites, so this
    // one handler covers the main window, all three popups and anything added
    // later. Registered here rather than in createWindow() so a second
    // createWindow() (macOS activate) cannot stack duplicate listeners.
    session.defaultSession.on("will-download", (event, item) => {
      const url = item.getURL();
      if (!isDownloadAllowed(url)) {
        console.warn("Blocked download from document content:", url);
        event.preventDefault();
        return;
      }
      // THE LATCH COVERS THE TABLE EXPORT TOO. This is the one allowed write
      // that never passes through the Save handler, and it lands at a
      // destination the reader has just chosen. A download has no result
      // channel to settle - `will-download` can only cancel - so the refusal
      // is made observable ONCE per latched session and counted thereafter.
      // Neither the notice nor a log is emitted per download: the latch is a
      // one-way door and a per-download message is an unbounded queue by
      // another name.
      if (deletionEvidenceCapacityLatched) {
        noteDeletionEvidenceCapacityRefusal();
        event.preventDefault();
        if (!deletionEvidenceCapacityDownloadNoticeShown) {
          deletionEvidenceCapacityDownloadNoticeShown = true;
          console.error(
            "Blocked a download: " + saveAuthorityLatchWriteError,
          );
          notifyDeletionEvidenceCapacityDownloadBlocked();
        }
      }
    });

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
// SHUTDOWN APPROVAL PROTOCOL (F22)
// ============================================
//
// MEASURED DEFECT: the native window X and Ctrl+Q discarded every unsaved tab
// without asking. `mainWindow.on("close", saveWindowState)` had no guard at
// all, Ctrl+Q called `app.quit()` directly, and `install-update` ran
// `quitAndInstall` (or spawned the portable installer) the instant the button
// was pressed. Only the per-tab close button asked anything, and it asks about
// ONE tab. Four ways out of the app, three of which were silent.
//
// The question can only be answered in the RENDERER: main holds no document
// state at all, and `saveTabs()` (custom-tabs.js) persists paths and scroll
// anchors, never content - so anything unsaved exists nowhere but in that one
// renderer process. And it cannot be asked synchronously: `ipcMain` has no
// synchronous send TO a renderer (the app's one sendSync runs the other way,
// custom-tabs.js -> "confirm-large-render"). So the only correct shape is:
// preventDefault the native gesture, ask over async IPC, and continue when the
// answer arrives. That is what this section is.
//
// WHAT IS DELIBERATE HERE, because each of these was a live defect in an
// earlier draft of this change:
//
//  - NO TIMEOUT. A timeout that approves is a data-loss bug with a delay on
//    it. If the renderer is alive we wait for it, forever if need be; if it is
//    gone we ask in the main process instead. Nothing here polls.
//  - THE APPROVAL IS NOT A STICKY GLOBAL. It is granted per continuation and
//    withdrawn again the moment a continuation reports that it did NOT start a
//    shutdown - otherwise a failed portable-update spawn, an updater that
//    declines to install, or a macOS window recreated through `activate`
//    leaves a latch permanently on, and every later close discards unsaved
//    work in silence. That is the original defect, restored by the fix.
//  - AN ID ALREADY SENT TO THE RENDERER NEVER CHANGES MEANING. A second,
//    stronger intent arriving mid-question is QUEUED and run after the first,
//    never swapped into the pending record: the id is the consent token, and
//    rewriting what it authorises turns "close this window" into "launch an
//    installer" (a confused deputy, and one the user cannot see).
//  - THE DIALOG LIVES IN MAIN, not in the renderer. `window.confirm` would
//    freeze the renderer thread while the question is up (so it could not
//    answer anything else), and it is unavailable in exactly the case that
//    matters most - a renderer that has crashed. One dialog, one wording, both
//    paths, and ESC cancels rather than approving (`cancelId`).
//
// AND ONE FACT THAT MAKES THE ORDINARY QUIT PATH LOAD-BEARING RATHER THAN
// TIDY: where `autoInstallOnAppQuit` is enabled, electron-updater registers its
// own quit handler and installs a downloaded update however the app was asked
// to quit. Windows installed builds deliberately disable that hook because
// Folia's owned NSIS launcher is the only verified install route there;
// portable builds never used it. Other installed platforms retain it, so every
// route out still passes through this approval protocol.
const QUIT_APPROVAL_REQUEST = "quit-approval-request";
const QUIT_APPROVAL_RESPONSE = "quit-approval-response";
const QUIT_APPROVAL_READY = "quit-approval-ready";
const QUIT_APPROVAL_GENERATION = "quit-approval-generation";
const QUIT_APPROVAL_RETRY = "quit-approval-retry";
// Phase two. See commitThenRun(): the answer names a document revision, and the
// renderer is asked to commit against it before anything acts on the answer.
const QUIT_APPROVAL_COMMIT = "quit-approval-commit";
const QUIT_APPROVAL_COMMITTED = "quit-approval-committed";
const QUIT_APPROVAL_VERIFY = "quit-approval-verify";
const QUIT_APPROVAL_VERIFIED = "quit-approval-verified";
const QUIT_APPROVAL_THAW = "quit-approval-thaw";
const NEWLINE_ALIGNMENT_DIAGNOSTICS_ENABLED =
  "newline-alignment-diagnostics-enabled";
const NEWLINE_ALIGNMENT_WITNESS = "newline-alignment-witness";
const MAX_NEWLINE_ALIGNMENT_WITNESSES = 32;
// A continuation can own an asynchronous hand-off without having failed or
// completed. `false` means "nothing started" and thaws; this sentinel means
// "the final revision-bound approval is committed, keep its freeze while the
// hand-off establishes a positive result."
const SHUTDOWN_CONTINUATION_PENDING = Symbol(
  "shutdown-continuation-pending",
);

// Monotonic, so a reply can be matched to the question that provoked it and
// every earlier one is recognisably stale on both sides.
let shutdownRequestSeq = 0;
// { id, reason, continuation, dispatchedTo, dispatchToken } while a question
// is outstanding.
let pendingShutdown = null;
// At most one superseded intent, held until the pending one settles.
let queuedShutdown = null;
// A user-origin close/quit absorbed by a pending updater is not weaker forever:
// if that updater is cancelled, the prevented native gesture must be asked
// again. Kept outside queuedShutdown so updater approval can never authorize it.
let absorbedUserShutdown = null;
let absorbedUserShutdownSeq = 0;
// Granted per continuation; see runApprovedContinuations().
let shutdownAuthorized = false;
let shutdownAuthorizationOwnerId = 0;
let shutdownAuthorizationGeneration = 0;
let shutdownAuthorizationCapacityLatched = false;
// "loading" - a renderer exists but has not announced itself yet, so a request
//             waits for it rather than being answered without it.
// "ready"   - the tab overlay is listening and can be asked.
// "unusable"- crashed, or finished loading without the overlay ever appearing.
let approvalRendererState = "loading";
// Bumped on every main-frame navigation and window creation, so a request
// dispatched to a renderer that has since been replaced can be recognised and
// re-sent to its successor instead of waiting forever.
let approvalRendererGeneration = 0;
// Bound document IPC to the page instance that announced readiness. A
// webContents survives navigation; its page session does not.
let approvalRendererPageSession = null;
// Why the renderer was last declared unusable. Diagnostic only: "the fallback
// dialog appeared" is not a diagnosis on its own, and the four routes into it
// are indistinguishable after the fact.
let lastRendererUnusableReason = null;
// A probe is owned by the document generation that started it. Its promise can
// settle after a navigation and must then be unable to clear a successor's
// probe or declare the successor unusable.
let overlayProbeOwner = null;
let overlayProbeSeq = 0;
let shutdownDispatchSeq = 0;
let lastShutdownDispatchToken = 0;
let shutdownRedispatchCount = 0;
let staleShutdownResponseCount = 0;
let invalidShutdownRevisionCount = 0;
let lastInvalidShutdownRevisionWhy = null;
let staleShutdownReadyCount = 0;
let staleOverlayProbeCompletionCount = 0;
let shutdownSendFailureCount = 0;
// The commit attempt in flight, if any. See commitThenRun().
let pendingShutdownCommit = null;
let shutdownCommitIngressBlocked = false;
let shutdownCommitSeq = 0;
let shutdownCommitRefusedCount = 0;
let shutdownCommitTimeoutCount = 0;
let staleShutdownCommitTimeoutCount = 0;
// Why the last commit attempt was refused. Several distinct controls end in
// the same "asking again" behaviour - a moved revision, a renderer that went
// away, a newer intent - and a counter alone cannot say which one a test
// actually measured.
let lastShutdownCommitRefusedWhy = null;
let staleShutdownCommitCount = 0;
let supersededContinuationCount = 0;
let staleShutdownDialogCompletionCount = 0;
let newlineAlignmentCallCount = 0;
let newlineAlignmentRestoredSpanCount = 0;
let newlineAlignmentBytesScanned = 0;
const newlineAlignmentWitnesses = [];
let navigationInvalidatedShutdownCount = 0;
// A renderer becoming unusable invalidates continuations that have been
// authorized but have not reached their setImmediate turn yet. It deliberately
// does not revoke a continuation that is already running: doing that from the
// renderer teardown caused by app.quit() would intercept a clean shutdown.
let shutdownContinuationEpoch = 0;
let rendererInvalidatedContinuationCount = 0;
// Updater failures and document-window teardown invalidate only updater
// continuations that have not started yet. Keeping this separate from the
// renderer epoch preserves an unrelated ordinary close already in flight.
let updaterContinuationEpoch = 0;
let updaterInvalidatedContinuationCount = 0;
let lastUpdaterShutdownCancelWhy = null;
let shutdownPendingContinuationCount = 0;
// How the last question was settled. Diagnostic only, and the same reasoning
// as lastRendererUnusableReason: several independent controls end in the same
// dialog, and "a dialog appeared" cannot tell them apart afterwards - which
// makes a test that only counts dialogs unable to say which control it
// measured.
let lastShutdownSettleWhy = null;
// Opt-in, source-build-only timing for attributing the real shutdown path.
// Null keeps the production path to a branch and avoids per-request storage.
const SHUTDOWN_TIMING_COMPLETED_LIMIT = 256;
let shutdownTimingRecords = null;
let shutdownTimingCompletedCount = 0;
// One accepted or in-flight attempt per download; failure paths that are known
// retryable clear it explicitly.
let updateInstallStarted = false;
// How long the portable hand-off waits for the batch to say that it started
// the installer, and how often it looks. THE TIMEOUT IS NOT A LICENCE TO QUIT:
// it expires into a cancelled hand-off with the app still running, because the
// only thing this deadline can be wrong about is how long a spawned cmd.exe
// takes to reach one `start` - and the cost of being wrong in the other
// direction is the reader's unsaved documents.
const PORTABLE_HANDOFF_TIMEOUT_MS = 5000;
const PORTABLE_HANDOFF_POLL_MS = 50;
// A renderer can remain responsive at the process level while dropping the
// phase-two commit message. The document is frozen during that phase, so an
// unbounded wait is both a shutdown hang and a permanently read-only editor.
// Expiry refuses the commit, thaws, re-raises, and moves that fresh question to
// the existing main-process fallback rather than treating silence as consent.
const SHUTDOWN_COMMIT_TIMEOUT_MS = 5000;
// THE PARKED BATCH'S LIVENESS LEASE. A PID is not an identity: Windows reuses
// process ids freely, so "a process with that number exists" can be true again
// minutes after the app that parked the batch died, and the batch would then
// wait on a gate nobody is going to open for as long as the imposter lives.
//
// So the app leaves a lease behind and keeps extending it - one appended byte
// per beat - for exactly as long as the hand-off is parked. The batch does not
// read the lease's CONTENT: it reads the SIZE cmd itself reports for the file,
// so nothing that could be written into that file can be parsed as script. A
// size that stops changing is a parent that has stopped beating, whatever the
// PID table says.
//
// The threshold is deliberately generous. This must tolerate a reader who
// leaves the confirmation on screen, and a main process briefly blocked by the
// multi-second synchronous render this app documents; being early here aborts
// a legitimate update, which is why it is many beats rather than one. It is
// still BOUNDED, which is the whole point: a machine that sleeps, or an app
// that is killed, is not a batch that waits forever.
const PORTABLE_LEASE_BEAT_MS = 1000;
const PORTABLE_LEASE_STALE_POLLS = 15;
// The non-Windows BaseUpdater completion boundary. In electron-updater 6.8.9,
// BaseUpdater queues one setImmediate only after install() succeeds; that
// callback emits before-quit-for-update and calls app.quit synchronously. The
// event carries no attempt id, so one process-lifetime listener assigns it to
// the newest eligible updater-owned attempt. Windows NSIS instead uses
// Folia's positive process-start proof; MacUpdater cannot provide either
// protocol and is rejected explicitly in performUpdateInstall().
let pendingUpdaterInstallCommit = null;
let activeUpdaterInstallAttempt = null;
let updaterInstallAttemptSeq = 0;
const updaterInstallAttempts = new Map();
let lastUpdaterInstallAttemptState = null;
// Set only while a before-quit-for-update event is handing off to the app.quit
// that belongs to the SAME updater attempt. It is consumed by before-quit,
// preventing an errored updater's already-scheduled quit without affecting a
// user-origin quit on either side of that exact boundary.
let updaterQuitBoundary = null;
electronAutoUpdater.on("before-quit-for-update", claimUpdaterQuitBoundary);

function enableShutdownTiming() {
  shutdownTimingRecords = new Map();
  shutdownTimingCompletedCount = 0;
}

function disableShutdownTiming() {
  shutdownTimingRecords = null;
  shutdownTimingCompletedCount = 0;
}

function resetShutdownTiming() {
  if (shutdownTimingRecords) shutdownTimingRecords.clear();
  shutdownTimingCompletedCount = 0;
}

function beginShutdownTiming(id, reason) {
  if (!shutdownTimingRecords) return;
  shutdownTimingRecords.set(id, {
    active: true,
    id,
    reason,
    rendererDispatchedAt: null,
    rendererResponseAt: null,
    rendererLateResponseAt: null,
    fallbackAt: null,
    fallbackCause: null,
    settledAt: null,
    continuationInvokedAt: null,
  });
}

function markShutdownTiming(id, mark) {
  if (!shutdownTimingRecords) return;
  const timing = shutdownTimingRecords.get(id);
  if (timing && timing[mark] === null) timing[mark] = performance.now();
}

function markShutdownFallbackTiming(id, cause) {
  if (!shutdownTimingRecords) return;
  const timing = shutdownTimingRecords.get(id);
  if (!timing || timing.fallbackAt !== null) return;
  timing.fallbackAt = performance.now();
  timing.fallbackCause = cause;
}

function markShutdownLateResponseTiming(id) {
  if (!shutdownTimingRecords) return;
  const timing = shutdownTimingRecords.get(id);
  if (
    timing &&
    timing.fallbackAt !== null &&
    timing.rendererLateResponseAt === null
  ) {
    timing.rendererLateResponseAt = performance.now();
  }
}

function completeShutdownTiming(id) {
  if (!shutdownTimingRecords) return;
  const timing = shutdownTimingRecords.get(id);
  if (!timing || !timing.active) return;
  timing.active = false;
  shutdownTimingCompletedCount += 1;
  if (shutdownTimingCompletedCount <= SHUTDOWN_TIMING_COMPLETED_LIMIT) return;

  // Map iteration follows request insertion order. Remove the oldest completed
  // request other than the one that just completed, and never an active one.
  for (const [recordId, record] of shutdownTimingRecords) {
    if (recordId === id || record.active) continue;
    shutdownTimingRecords.delete(recordId);
    shutdownTimingCompletedCount -= 1;
    break;
  }
}

function shutdownTimingState() {
  if (!shutdownTimingRecords) return { enabled: false, requests: [] };
  return {
    enabled: true,
    requests: Array.from(
      shutdownTimingRecords.values(),
      ({
        id,
        reason,
        rendererDispatchedAt,
        rendererResponseAt,
        rendererLateResponseAt,
        fallbackAt,
        fallbackCause,
        settledAt,
        continuationInvokedAt,
      }) => ({
        id,
        reason,
        rendererDispatchedAt,
        rendererResponseAt,
        rendererLateResponseAt,
        fallbackAt,
        fallbackCause,
        settledAt,
        continuationInvokedAt,
      }),
    ),
  };
}

function newestLiveUpdaterInstallAttempt(updater = null) {
  let newest = null;
  for (const [id, attempt] of updaterInstallAttempts) {
    if (
      attempt.retired ||
      attempt.boundaryClaimed ||
      attempt.launchOwner !== "electron-updater" ||
      (updater && attempt.updater !== updater)
    ) {
      continue;
    }
    if (!newest || id > newest.id) newest = attempt;
  }
  return newest;
}

function newestOwnedUpdaterInstallAttempt(updater = null) {
  let newest = null;
  for (const [id, attempt] of updaterInstallAttempts) {
    if (attempt.retired || (updater && attempt.updater !== updater)) continue;
    if (!newest || id > newest.id) newest = attempt;
  }
  return newest;
}

function recordUpdaterInstallAttemptState(attempt) {
  if (!attempt) return;
  lastUpdaterInstallAttemptState = Object.freeze({
    id: attempt.id,
    launchOwner: attempt.launchOwner,
    launchMethod: attempt.launchMethod,
    launchPhase: attempt.launchPhase,
    positiveLaunchObserved: attempt.positiveLaunchObserved,
    retrySafe: attempt.retrySafe,
    failureWhy: attempt.failureWhy,
    launchPid: attempt.launchPid || 0,
    launchChildUnrefed: attempt.launchChildUnrefed,
    finalApprovalCommitted: attempt.finalApprovalCommitted,
  });
}

function finishFailedUpdaterInstallAttempt(attempt) {
  if (!attempt || attempt.retired) return false;
  if (attempt.poisonExpiry !== null && attempt.poisonExpiry !== undefined) {
    clearImmediate(attempt.poisonExpiry);
    attempt.poisonExpiry = null;
  }
  if (updaterQuitBoundary && updaterQuitBoundary.attempt === attempt) {
    if (updaterQuitBoundary.expiry !== null) {
      clearImmediate(updaterQuitBoundary.expiry);
    }
    updaterQuitBoundary = null;
  }
  // Retirement removes every way the failed attempt can participate in a
  // future boundary. Identity checks on every shared slot are load-bearing:
  // a stale expiry or error callback must not clear a newer attempt.
  const owned =
    activeUpdaterInstallAttempt === attempt ||
    pendingUpdaterInstallCommit === attempt;
  attempt.failed = true;
  attempt.launchPhase = "failed";
  recordUpdaterInstallAttemptState(attempt);
  attempt.retired = true;
  updaterInstallAttempts.delete(attempt.id);
  if (pendingUpdaterInstallCommit === attempt) {
    pendingUpdaterInstallCommit = null;
  }
  if (activeUpdaterInstallAttempt === attempt) {
    activeUpdaterInstallAttempt = null;
  }
  if (owned) updateInstallStarted = false;
  // BaseUpdater leaves this protected latch set when doInstall returned true,
  // even if its child emitted an error before the scheduled quit. Once that
  // exact quit has been consumed (or proved impossible), clearing the latch is
  // what permits a later, independent Install press to be a real attempt. Only
  // for an attempt that still owns the hand-off: the latch is the updater's,
  // not this attempt's, and a superseded one must not lower it under the
  // attempt that replaced it.
  if (
    owned &&
    attempt.ownsUpdaterQuitLatch &&
    attempt.updater &&
    typeof attempt.updater.quitAndInstallCalled === "boolean"
  ) {
    attempt.updater.quitAndInstallCalled = false;
    attempt.ownsUpdaterQuitLatch = false;
  }
  return owned;
}

function finishCommittedUpdaterInstallAttempt(attempt) {
  if (!attempt || attempt.retired) return false;
  if (attempt.poisonExpiry !== null && attempt.poisonExpiry !== undefined) {
    clearImmediate(attempt.poisonExpiry);
    attempt.poisonExpiry = null;
  }
  if (pendingUpdaterInstallCommit === attempt) {
    pendingUpdaterInstallCommit = null;
  }
  attempt.quitBoundaryConsumed = true;
  attempt.launchPhase = "installer-started";
  recordUpdaterInstallAttemptState(attempt);
  // The installer has started. Keep both install latches raised so a declined
  // final quit cannot launch a second installer alongside it. The attempt also
  // stays owned until process exit so a later proven installer-spawn error can
  // retire it and release retry without being mistaken for an unrelated check
  // or download failure.
  return true;
}

function poisonUpdaterInstallAttempt(updater, why) {
  const attempt = newestOwnedUpdaterInstallAttempt(updater);
  if (!attempt) return null;
  attempt.failed = true;
  attempt.poisoned = true;
  attempt.failureWhy = why;
  return attempt;
}

function armUpdaterQuitBoundary(attempt) {
  const boundary = {
    attempt,
    expiry: null,
  };
  updaterQuitBoundary = boundary;
  // before-quit-for-update and the updater-owned app.quit are synchronous
  // neighbours in BaseUpdater. Expire the classification afterwards so a
  // missing app.quit can never consume an unrelated user quit later.
  boundary.expiry = setImmediate(() => {
    if (updaterQuitBoundary !== boundary) return;
    updaterQuitBoundary = null;
    if (attempt.poisoned) {
      log(
        `Updater install attempt #${attempt.id} failed without a following app.quit`,
      );
      finishFailedUpdaterInstallAttempt(attempt);
    } else if (!attempt.retired) {
      // before-quit-for-update is only a promise to hand off. Without its
      // immediately paired app.quit no installed updater was committed, so
      // every authorization and latch owned by this attempt must be
      // withdrawn and any user quit it absorbed must be replayed.
      cancelUpdateOriginShutdownState(
        "updater-boundary-without-app-quit",
        attempt.updater,
      );
      finishFailedUpdaterInstallAttempt(attempt);
    }
  });
  if (typeof boundary.expiry.unref === "function") boundary.expiry.unref();
}

// A failed attempt remains eligible for exactly one check-phase turn. This is
// a bounded quarantine for a boundary already queued by the updater: if the
// pair arrives, the process listener binds both events to this poisoned
// attempt and blocks its app.quit. If it does not arrive, BaseUpdater 6.8.9
// cannot emit it later: install() returned false or errored, so no lifecycle
// setImmediate was queued. The attempt is then retired completely before a
// retry is admitted; no listener or tombstone survives to steal the retry's
// boundary.
function armPoisonedUpdaterAttemptExpiry(attempt) {
  if (attempt.retired || attempt.poisonExpiry !== null) return;
  attempt.poisonExpiry = setImmediate(() => {
    attempt.poisonExpiry = null;
    // The pair arrived after all. The boundary owns this attempt now, and
    // blocking its app.quit is what retires it.
    if (attempt.boundaryObserved) return;
    log(
      `Updater install attempt #${attempt.id} failed before any quit boundary (${attempt.failureWhy})`,
    );
    finishFailedUpdaterInstallAttempt(attempt);
  });
  if (typeof attempt.poisonExpiry.unref === "function") {
    attempt.poisonExpiry.unref();
  }
}

function invalidateDeferredUpdaterContinuations(why) {
  updaterContinuationEpoch += 1;
  lastUpdaterShutdownCancelWhy = why;
}

function cancelUpdateOriginShutdownState(why, updater = null) {
  // Keep a failed installed attempt live for one check phase so an already
  // queued lifecycle pair can still be claimed and blocked. After that bounded
  // quarantine it is retired completely; BaseUpdater does not emit a late
  // boundary when install() failed.
  const poisonedAttempt = updater
    ? poisonUpdaterInstallAttempt(updater, why)
    : null;
  let cancelledInstallCommit = !!poisonedAttempt;
  if (!poisonedAttempt && pendingUpdaterInstallCommit) {
    const pendingAttempt = pendingUpdaterInstallCommit;
    pendingAttempt.failureWhy = why;
    cancelledInstallCommit =
      finishFailedUpdaterInstallAttempt(pendingAttempt) ||
      cancelledInstallCommit;
  }
  invalidateDeferredUpdaterContinuations(why);

  let cancelledState = cancelledInstallCommit;
  if (queuedShutdown && isUpdaterShutdownReason(queuedShutdown.reason)) {
    const intent = queuedShutdown;
    queuedShutdown = null;
    declineIntent(intent, why);
    cancelledState = true;
  }

  if (pendingShutdown && isUpdaterShutdownReason(pendingShutdown.reason)) {
    const record = pendingShutdown;
    cancelledState = true;
    settleShutdown(record, false, why);
  }

  const attempt = pendingShutdownCommit;
  if (attempt) {
    const ordinaryContinuations = [];
    const updaterContinuations = [];
    for (const intent of attempt.continuations) {
      (isUpdaterShutdownReason(intent.reason)
        ? updaterContinuations
        : ordinaryContinuations
      ).push(intent);
    }
    if (updaterContinuations.length > 0) {
      cancelledState = true;
      attempt.continuations = ordinaryContinuations;
      for (const intent of updaterContinuations) {
        declineIntent(intent, why);
      }
      // A commit whose question itself came from an updater cannot be retained
      // as authority for an ordinary intent. Refuse it, clear its timer and
      // re-raise only the unrelated ordinary continuations.
      if (
        isUpdaterShutdownReason(attempt.reason) ||
        ordinaryContinuations.length === 0
      ) {
        finishShutdownCommit(attempt, false, why, {
          reraise: ordinaryContinuations.length > 0,
        });
      }
    }
  }

  if (cancelledState || updateInstallStarted) {
    revokeShutdownAuthorization();
  }

  if (poisonedAttempt) {
    const boundaryArmedForAttempt =
      !!updaterQuitBoundary && updaterQuitBoundary.attempt === poisonedAttempt;
    if (!boundaryArmedForAttempt && !poisonedAttempt.boundaryObserved) {
      armPoisonedUpdaterAttemptExpiry(poisonedAttempt);
    } else if (!boundaryArmedForAttempt) {
      finishFailedUpdaterInstallAttempt(poisonedAttempt);
    }
  }
  replayAbsorbedUserShutdownAfterUpdaterCancel(why);
}

function isSameShutdownDocumentSession(
  ownerId,
  rendererGeneration,
  reason = null,
) {
  const currentOwner = shutdownOwnerWindow();
  if (!currentOwner) return NO_WINDOW_APPROVABLE.has(reason);
  return (
    currentOwner.webContents.id === ownerId &&
    approvalRendererGeneration === rendererGeneration
  );
}

function watchUpdaterInstallCommit(updater) {
  // Attempts carry immutable ids and live in one ownership table. The single
  // process listener chooses the greatest live id for each anonymous updater
  // boundary, so listener registration order cannot let an older attempt steal
  // a retry's event.
  const id = ++updaterInstallAttemptSeq;
  const attempt = {
    updater,
    committed: false,
    failed: false,
    poisoned: false,
    failureWhy: null,
    boundaryObserved: false,
    boundaryClaimed: false,
    quitBoundaryConsumed: false,
    launchOwner: "electron-updater",
    launchMethod: null,
    launchPhase: "awaiting-updater-boundary",
    positiveLaunchObserved: false,
    retrySafe: false,
    ownsUpdaterQuitLatch: false,
    launchPid: 0,
    launchChildUnrefed: false,
    finalApprovalCommitted: false,
    retired: false,
    poisonExpiry: null,
  };
  Object.defineProperty(attempt, "id", {
    value: id,
    enumerable: true,
  });
  updaterInstallAttempts.set(id, attempt);
  activeUpdaterInstallAttempt = attempt;
  pendingUpdaterInstallCommit = attempt;
  recordUpdaterInstallAttemptState(attempt);
  return attempt;
}

function claimUpdaterQuitBoundary() {
  // BaseUpdater emits the boundary and calls app.quit in the same callback.
  // Until that app.quit is consumed, a second anonymous boundary has no
  // provable owner and must not overwrite the first one's binding.
  if (updaterQuitBoundary) {
    log(
      `Ignoring updater quit boundary while attempt #${updaterQuitBoundary.attempt.id} owns the paired app.quit`,
    );
    return;
  }

  const attempt = newestLiveUpdaterInstallAttempt();
  if (!attempt) {
    log("Updater quit boundary had no live explicit install attempt");
    return;
  }

  attempt.boundaryObserved = true;
  attempt.boundaryClaimed = true;
  attempt.launchPhase = "updater-boundary-claimed";
  recordUpdaterInstallAttemptState(attempt);
  if (pendingUpdaterInstallCommit === attempt) {
    pendingUpdaterInstallCommit = null;
  }
  armUpdaterQuitBoundary(attempt);

  if (
    attempt.poisoned ||
    attempt.failed ||
    activeUpdaterInstallAttempt !== attempt
  ) {
    attempt.failed = true;
    attempt.poisoned = true;
    if (!attempt.failureWhy) {
      attempt.failureWhy = "stale-or-unowned-updater-boundary";
    }
    log(
      `Ignoring updater quit boundary for failed attempt #${attempt.id} (${attempt.failureWhy})`,
    );
    return;
  }

  attempt.committed = true;
  attempt.positiveLaunchObserved = true;
  attempt.launchPhase = "installer-started";
  recordUpdaterInstallAttemptState(attempt);
  // The first approval permits entering quitAndInstall(), not the updater's
  // later quit. Always ask a distinct question at the public commit boundary:
  // even an immediate commit can race edits or a replacement document.
  revokeShutdownAuthorization();
  log("Installed update: hand-off requires fresh shutdown approval");
  requestShutdown("update-install", quitApprovedUpdateApp, {
    forceFresh: true,
  });
}

// Ordering between intents, used only to decide which of two intents survives
// when they overlap. Quitting the app subsumes closing its window; installing
// an update subsumes both.
const SHUTDOWN_RANK = {
  "window-close": 0,
  "ctrl-q": 1,
  "app-quit": 1,
  "update-install": 2,
};

function shutdownRank(reason) {
  return Object.prototype.hasOwnProperty.call(SHUTDOWN_RANK, reason)
    ? SHUTDOWN_RANK[reason]
    : 0;
}

// AN INTENT THAT REWRITES THE MACHINE IS NOT ANSWERED BY AN EMPTY SCREEN.
//
// "No document window" is an argument about DATA: the window took its documents
// with it, so a close or a quit has nothing left to lose and may finish
// silently. Installing an update is a different act entirely - it replaces the
// application on disk and relaunches it - and the reader was never asked about
// THAT; they were asked whether their documents could be discarded, and then
// the thing that would have asked disappeared. Approving it here would turn a
// window closing into consent to install, which is exactly the substitution
// this whole protocol exists to prevent.
//
// So the auto-approval is restricted BY REASON rather than by circumstance, and
// an updater intent that reaches an empty screen fails closed: declined, which
// carries a cancel back to a parked hand-off through onDeclined.
const NO_WINDOW_APPROVABLE = new Set(["window-close", "ctrl-q", "app-quit"]);

function isUpdaterShutdownReason(reason) {
  return !NO_WINDOW_APPROVABLE.has(reason);
}

function isFoliaInstalledUpdateLaunchPending() {
  const attempt = activeUpdaterInstallAttempt;
  return !!(
    attempt &&
    !attempt.retired &&
    attempt.launchOwner === "folia" &&
    !attempt.positiveLaunchObserved &&
    (attempt.launchPhase === "starting-installer" ||
      attempt.launchPhase === "starting-elevation-helper" ||
      attempt.launchPhase === "awaiting-elevation-result")
  );
}

function quitAfterFrozenUpdaterDocumentLoss(why) {
  const attempt = activeUpdaterInstallAttempt;
  if (!foliaUpdaterAttemptRetainsFreeze() || !attempt) return false;
  attempt.committed = true;
  attempt.launchPhase = "quitting-after-document-loss";
  attempt.failureWhy = why;
  recordUpdaterInstallAttemptState(attempt);
  log(
    `Installed update: document session ended during protected hand-off (${why}); quitting under committed approval`,
  );
  grantShutdownAuthorization();
  quitApprovedUpdateApp();
  return true;
}

function cancelAbsorbedUserShutdown(why) {
  const intent = absorbedUserShutdown;
  if (!intent) return false;
  absorbedUserShutdown = null;
  declineIntent(intent, why);
  return true;
}

function holdAbsorbedUserShutdown(intent) {
  if (!intent || isUpdaterShutdownReason(intent.reason)) return false;
  const owner = shutdownOwnerWindow();
  if (!intent.absorbedId) {
    intent.absorbedId = ++absorbedUserShutdownSeq;
    intent.arrivalOrder = intent.absorbedId;
    intent.ownerId = owner ? owner.webContents.id : 0;
  }
  intent.replayScheduled = false;

  if (absorbedUserShutdown) {
    if (
      shutdownRank(absorbedUserShutdown.reason) >=
      shutdownRank(intent.reason)
    ) {
      declineIntent(intent, "absorbed");
      return true;
    }
    declineIntent(absorbedUserShutdown, "superseded");
  }
  absorbedUserShutdown = intent;
  log(
    `Held user shutdown intent #${intent.absorbedId} (${intent.reason}) behind updater approval`,
  );
  return true;
}

function replayAbsorbedUserShutdownAfterUpdaterCancel(why) {
  const intent = absorbedUserShutdown;
  if (!intent || intent.replayScheduled) return false;
  intent.replayScheduled = true;
  setImmediate(() => {
    if (absorbedUserShutdown !== intent || !intent.replayScheduled) return;
    intent.replayScheduled = false;
    absorbedUserShutdown = null;
    const owner = shutdownOwnerWindow();
    if (!owner || owner.webContents.id !== intent.ownerId) {
      declineIntent(intent, "window-gone");
      return;
    }
    revokeShutdownAuthorization();
    log(
      `Replaying user shutdown intent #${intent.absorbedId} (${intent.reason}) after updater cancellation (${why})`,
    );
    requestShutdown(intent.reason, intent.continuation, {
      forceFresh: true,
      onDeclined: intent.onDeclined,
      absorbedUserIntent: intent,
    });
  });
  return true;
}

// The single decision for "there is no window to ask". Both callers - the
// dispatcher and the main-process question - used to settle this TRUE for any
// reason at all.
function settleWithoutWindow(record) {
  if (!isUpdaterShutdownReason(record.reason)) {
    settleShutdown(record, true, "no-window");
    return;
  }
  log(
    `Shutdown approval #${record.id} (${record.reason}) refused: no document window remains to ask`,
  );
  settleShutdown(record, false, "no-window-updater");
}

// The one window that owns documents. Popups never do - they carry a rendered
// diagram, image or table and hold nothing unsaved - so they are not consulted
// and their own close path is untouched by any of this.
function shutdownOwnerWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function revokeShutdownAuthorization() {
  shutdownAuthorized = false;
  shutdownAuthorizationOwnerId = 0;
  shutdownAuthorizationGeneration = 0;
  shutdownAuthorizationCapacityLatched = false;
}

function grantShutdownAuthorization() {
  const owner = shutdownOwnerWindow();
  shutdownAuthorized = true;
  shutdownAuthorizationOwnerId = owner ? owner.webContents.id : 0;
  shutdownAuthorizationGeneration = owner ? approvalRendererGeneration : 0;
  shutdownAuthorizationCapacityLatched = deletionEvidenceCapacityLatched;
}

function hasCurrentShutdownAuthorization() {
  if (!shutdownAuthorized) return false;
  const owner = shutdownOwnerWindow();
  if (!owner && (!deletionEvidenceCapacityLatched ||
      shutdownAuthorizationCapacityLatched)) return true;
  const current =
    !!owner &&
    owner.webContents.id === shutdownAuthorizationOwnerId &&
    approvalRendererGeneration === shutdownAuthorizationGeneration &&
    (!deletionEvidenceCapacityLatched ||
      shutdownAuthorizationCapacityLatched);
  if (!current) revokeShutdownAuthorization();
  return current;
}

function shutdownDocumentSession() {
  const owner = shutdownOwnerWindow();
  return Object.freeze({
    ownerId: owner ? owner.webContents.id : 0,
    rendererGeneration: approvalRendererGeneration,
  });
}

// Every message in this protocol must come from the document window's MAIN
// FRAME and from nothing else.
//
// Identity is compared by webContents id rather than by object, matching
// isPopupOfKind() above. The FRAME test is deliberately belt and braces:
// `senderFrame === webContents.mainFrame` is the strict check, but Electron's
// own typings state that two distinct WebFrameMain instances can refer to the
// same underlying frame (they share a routingId), so identity alone can be
// false for a legitimate sender - and a rejected legitimate answer is not a
// harmless false negative here, it leaves the request outstanding with nothing
// to resolve it. `frameTreeNodeId` is the stable identifier for the same frame
// across such instances, and `parent === null` is the documented main-frame
// predicate; a sender must satisfy both the identity-or-same-node test and the
// main-frame test. `senderFrame` is nullable and a destroyed frame throws on
// property access, so both are checked before anything is read.
function isApprovalSender(event) {
  const win = shutdownOwnerWindow();
  if (!win) return false;
  const wc = event.sender;
  if (!wc || wc.isDestroyed()) return false;
  if (wc.id !== win.webContents.id) return false;
  const frame = event.senderFrame;
  if (!frame || frame.isDestroyed()) return false;
  const main = wc.mainFrame;
  if (!main || main.isDestroyed()) return false;
  if (frame !== main && frame.frameTreeNodeId !== main.frameTreeNodeId) {
    return false;
  }
  return frame.parent === null;
}

function addDiagnosticCount(current, increment) {
  return current > Number.MAX_SAFE_INTEGER - increment
    ? Number.MAX_SAFE_INTEGER
    : current + increment;
}

function newlineAlignmentWitnessSummaries() {
  return Object.freeze(
    newlineAlignmentWitnesses.map((witness) =>
      Object.freeze({ ...witness }),
    ),
  );
}

if (!app.isPackaged) {
  ipcMain.handle(
    NEWLINE_ALIGNMENT_DIAGNOSTICS_ENABLED,
    (event) => isApprovalSender(event),
  );

  ipcMain.on(NEWLINE_ALIGNMENT_WITNESS, (event, data) => {
    if (!isApprovalSender(event) || !data || typeof data !== "object") {
      return;
    }
    const {
      callId,
      callCount = 1,
      restoredSpans,
      bytesScanned,
      degradedCount = 0,
      ambiguousBoundaries = 0,
      mode,
    } = data;
    if (
      !Number.isSafeInteger(callId) ||
      callId <= 0 ||
      !Number.isSafeInteger(callCount) ||
      callCount <= 0 ||
      !Number.isSafeInteger(restoredSpans) ||
      restoredSpans < 0 ||
      !Number.isSafeInteger(bytesScanned) ||
      bytesScanned <= 0 ||
      !Number.isSafeInteger(degradedCount) ||
      degradedCount < 0 ||
      !Number.isSafeInteger(ambiguousBoundaries) ||
      ambiguousBoundaries < 0 ||
      ![
        "uniform",
        "positional",
        "myers",
        "trimmed-myers",
        "content-consensus",
        "mixed",
        "mixed-degraded",
      ].includes(mode) ||
      !Number.isSafeInteger(approvalRendererGeneration) ||
      approvalRendererGeneration <= 0 ||
      typeof approvalRendererPageSession !== "string" ||
      approvalRendererPageSession.length === 0
    ) {
      return;
    }
    newlineAlignmentCallCount = addDiagnosticCount(
      newlineAlignmentCallCount,
      callCount,
    );
    newlineAlignmentRestoredSpanCount = addDiagnosticCount(
      newlineAlignmentRestoredSpanCount,
      restoredSpans,
    );
    newlineAlignmentBytesScanned = addDiagnosticCount(
      newlineAlignmentBytesScanned,
      bytesScanned,
    );
    newlineAlignmentWitnesses.push(
      Object.freeze({
        callId,
        callCount,
        restoredSpans,
        bytesScanned,
        degradedCount,
        ambiguousBoundaries,
        mode,
        rendererGeneration: approvalRendererGeneration,
        pageSession: approvalRendererPageSession,
      }),
    );
    if (newlineAlignmentWitnesses.length > MAX_NEWLINE_ALIGNMENT_WITNESSES) {
      newlineAlignmentWitnesses.shift();
    }
  });
}

/**
 * Ask before shutting down, then run `continuation` if the answer is yes.
 *
 * @param {string} reason - one of the SHUTDOWN_RANK keys; identifies the
 *   gesture, and orders it against a competing one.
 * @param {() => boolean} continuation - performs the shutdown. Returns false
 *   unless shutdown is already committed; an asynchronous hand-off must
 *   re-authorize itself only from its success event.
 * @param {{
 *   forceFresh?: boolean,
 *   onDeclined?: (why: string) => void,
 *   absorbedUserIntent?: object
 * }} [options]
 *   onDeclined is called exactly once if - and only if - `continuation` will
 *   never run: the reader said no, or a stronger intent absorbed this one. See
 *   declineIntent().
 */
function requestShutdown(reason, continuation, options = {}) {
  const forceFresh = options.forceFresh === true;
  const fallbackCause =
    typeof options.fallbackCause === "string" ? options.fallbackCause : null;
  const onDeclined =
    typeof options.onDeclined === "function" ? options.onDeclined : null;
  if (
    isFoliaInstalledUpdateLaunchPending() &&
    !isUpdaterShutdownReason(reason)
  ) {
    holdAbsorbedUserShutdown({
      reason,
      continuation,
      forceFresh,
      onDeclined,
    });
    return;
  }
  if (
    absorbedUserShutdown &&
    !isUpdaterShutdownReason(reason) &&
    options.absorbedUserIntent !== absorbedUserShutdown
  ) {
    const replayWasScheduled = absorbedUserShutdown.replayScheduled;
    const intent = { reason, continuation, forceFresh, onDeclined };
    holdAbsorbedUserShutdown(intent);
    if (replayWasScheduled && absorbedUserShutdown === intent) {
      replayAbsorbedUserShutdownAfterUpdaterCancel(
        "superseded-absorbed-user-intent",
      );
    }
    return;
  }
  // A NEW INTENT CROSSING AN IN-FLIGHT COMMIT INVALIDATES IT. The commit is
  // confirming an answer about a document state that this new gesture is about
  // to ask about again; letting both proceed races an old answer against a new
  // question, and the reader is looking at the new one. The commit is cancelled
  // and thawed FIRST - which re-raises its own intents as fresh requests - and
  // only then does this one dispatch, so it queues behind them through the
  // ordinary ranking rather than overtaking them.
  if (pendingShutdownCommit) {
    finishShutdownCommit(
      pendingShutdownCommit,
      false,
      "superseded-by-new-intent",
    );
  }
  if (!forceFresh && hasCurrentShutdownAuthorization()) {
    // The user has already agreed to lose whatever is unsaved, and the app is
    // on its way down. Running the new continuation rather than dropping it is
    // what keeps Ctrl+Q from becoming a silent no-op if the close it follows
    // did not complete.
    runApprovedContinuations(
      [{ reason, continuation, onDeclined }],
      0,
      shutdownDocumentSession(),
    );
    return;
  }
  if (forceFresh) revokeShutdownAuthorization();
  if (pendingShutdown) {
    queueShutdown(
      reason,
      continuation,
      forceFresh,
      onDeclined,
      options.absorbedUserIntent || null,
    );
    return;
  }
  pendingShutdown = {
    id: ++shutdownRequestSeq,
    reason,
    continuation,
    onDeclined,
    absorbedUserIntentId: options.absorbedUserIntent
      ? options.absorbedUserIntent.absorbedId
      : 0,
    absorbedUserArrivalOrder: options.absorbedUserIntent
      ? options.absorbedUserIntent.arrivalOrder
      : 0,
    dispatchedTo: 0,
    dispatchToken: 0,
    dispatchCount: 0,
    asked: false,
    dialogAbortController: null,
    waitingForPendingSaves: false,
    responseGeneration: null,
    fallbackCause,
    forceFresh,
  };
  beginShutdownTiming(pendingShutdown.id, reason);
  log(`Shutdown approval #${pendingShutdown.id} requested by ${reason}`);
  if (fallbackCause) {
    askFallbackApproval(pendingShutdown, fallbackCause);
  } else {
    dispatchShutdownRequest(pendingShutdown);
  }
}

// EVERY INTENT EITHER RUNS ITS CONTINUATION OR IS TOLD THAT IT NEVER WILL.
// An asynchronous hand-off parks real resources on the answer - the portable
// installer parks a live child process, a private temp directory and the
// in-flight install latch - and silence is not an answer it can act on. Before
// this existed, an intent that the reader declined, or that a stronger one
// absorbed, simply evaporated: the continuation was dropped, nothing told the
// hand-off, and the child sat waiting on a gate that would never be written
// for the rest of the session.
//
// Called at most once per intent, and never for one that ran: `onDeclined` is
// cleared as it fires, so a decline followed by a queue sweep cannot cancel
// the same hand-off twice.
function declineIntent(intent, why) {
  const onDeclined = intent && intent.onDeclined;
  if (typeof onDeclined !== "function") return;
  intent.onDeclined = null;
  try {
    onDeclined(why);
  } catch (error) {
    log(
      "Shutdown decline handler failed:",
      error && error.stack ? error.stack : error,
    );
  }
}

// A second gesture while a question is up must never raise a second question.
// Ordinarily a duplicate or weaker one is absorbed outright and only a
// STRONGER intent is queued. A prevented USER gesture behind an updater is
// different: it is held outside the updater's authority and replayed as a
// fresh request only if that updater is cancelled.
function queueShutdown(
  reason,
  continuation,
  forceFresh = false,
  onDeclined = null,
  absorbedUserIntent = null,
) {
  const intent = absorbedUserIntent || {
    reason,
    continuation,
    forceFresh,
    onDeclined,
  };
  intent.reason = reason;
  intent.continuation = continuation;
  intent.forceFresh = forceFresh;
  intent.onDeclined = onDeclined;
  if (
    isUpdaterShutdownReason(pendingShutdown.reason) &&
    !isUpdaterShutdownReason(reason)
  ) {
    holdAbsorbedUserShutdown(intent);
    return;
  }
  if (
    !forceFresh &&
    shutdownRank(reason) <= shutdownRank(pendingShutdown.reason)
  ) {
    declineIntent(intent, "absorbed");
    return;
  }
  if (queuedShutdown) {
    if (queuedShutdown.forceFresh && !forceFresh) {
      declineIntent(intent, "absorbed");
      return;
    }
    if (
      queuedShutdown.forceFresh === forceFresh &&
      shutdownRank(queuedShutdown.reason) >= shutdownRank(reason)
    ) {
      declineIntent(intent, "absorbed");
      return;
    }
    // Only one intent can be held, so the one being displaced is not merely
    // forgotten - it is told, and can stand its own hand-off down.
    declineIntent(queuedShutdown, "superseded");
  }
  queuedShutdown = intent;
}

function dispatchShutdownRequest(record) {
  const win = shutdownOwnerWindow();
  if (!win) {
    // No document window exists - the single-instance-lock quit before any
    // window is made, or a window already gone. Nothing is on screen, so a
    // close or a quit has nothing left to lose; an updater intent is refused,
    // because an empty screen is not permission to replace the application.
    settleWithoutWindow(record);
    return;
  }
  const wc = win.webContents;
  // A window that still exists but whose renderer does not is the case that
  // must NEVER be inferred either way: its documents may have been unsaved and
  // there is nobody left to say. It is asked in the main process, whatever the
  // readiness state happens to say - a renderer destroyed mid-load would
  // otherwise be held as "still coming".
  if (!wc || wc.isDestroyed() || wc.isCrashed()) {
    askFallbackApproval(record, "unresponsive");
    return;
  }
  if (approvalRendererState === "ready") {
    const generation = approvalRendererGeneration;
    const dispatchToken = ++shutdownDispatchSeq;
    try {
      record.waitingForPendingSaves = false;
      wc.send(QUIT_APPROVAL_REQUEST, {
        id: record.id,
        reason: record.reason,
        gen: generation,
        retainFreeze: foliaUpdaterAttemptRetainsFreeze(),
      });
    } catch (error) {
      if (pendingShutdown !== record) return;
      record.dispatchedTo = 0;
      record.dispatchToken = 0;
      shutdownSendFailureCount += 1;
      markRendererUnusable(
        "shutdown request could not be sent: " + error.message,
        generation,
      );
      return;
    }
    if (pendingShutdown !== record) return;
    if (record.dispatchCount > 0) shutdownRedispatchCount += 1;
    record.dispatchCount += 1;
    record.dispatchedTo = generation;
    record.dispatchToken = dispatchToken;
    lastShutdownDispatchToken = dispatchToken;
    markShutdownTiming(record.id, "rendererDispatchedAt");
    return;
  }
  // Held, not answered. The renderer is on its way up and the readiness
  // handshake dispatches this the moment it can be asked. No timer, no
  // polling.
  //
  // "Still loading" is NOT tested with isLoading() alone, and that was
  // measured rather than assumed: a page can finish loading a beat before its
  // announcement is delivered, and treating that gap as "nothing is coming"
  // sent a close that the renderer was about to answer to the main-process
  // dialog instead. What resolves the ambiguity is asking the page itself.
  if (approvalRendererState === "loading") {
    if (!wc.isLoading()) probeForApprovalOverlay(wc);
    return;
  }
  askFallbackApproval(record, "unresponsive");
}

// The page is not loading and has not announced itself. That is EITHER an
// announcement still in flight - the renderer's IPC and the browser process's
// navigation notifications travel separate paths, so their order is not a fact
// to be inferred - OR a document with no overlay in it, which will never
// answer anything. Ask the page which, rather than guessing; an overlay that
// exists has already sent its announcement, because that is the last statement
// of its setup.
function probeForApprovalOverlay(wc) {
  if (overlayProbeOwner || !wc || wc.isDestroyed()) return;
  const owner = {
    generation: approvalRendererGeneration,
    token: ++overlayProbeSeq,
  };
  overlayProbeOwner = owner;

  let probe;
  try {
    probe = wc.executeJavaScript(
      "typeof window.CustomTabs === 'object' && window.CustomTabs !== null",
    );
  } catch (error) {
    finishOverlayProbe(owner, false, error);
    return;
  }
  Promise.resolve(probe).then(
    (hasOverlay) => finishOverlayProbe(owner, hasOverlay, null),
    (error) => finishOverlayProbe(owner, false, error),
  );
}

function finishOverlayProbe(owner, hasOverlay, error) {
  if (overlayProbeOwner !== owner) {
    staleOverlayProbeCompletionCount += 1;
    return;
  }
  overlayProbeOwner = null;
  if (
    owner.generation !== approvalRendererGeneration ||
    approvalRendererState !== "loading"
  ) {
    staleOverlayProbeCompletionCount += 1;
    return;
  }
  if (error) {
    markRendererUnusable(
      "page could not be inspected: " + error.message,
      owner.generation,
    );
    return;
  }
  if (!hasOverlay) {
    markRendererUnusable("loaded without the tab overlay", owner.generation);
  }
}

// One place to record that the renderer can no longer answer, and to resolve
// whatever was waiting on it. Both halves matter: a request already held is
// stranded otherwise.
function markRendererUnusable(
  why,
  generation = approvalRendererGeneration,
  fallbackCause = "unresponsive",
) {
  if (generation !== approvalRendererGeneration) return;
  const newlyUnusable = approvalRendererState !== "unusable";
  approvalRendererState = "unusable";
  if (newlyUnusable) shutdownContinuationEpoch += 1;
  lastRendererUnusableReason = why;
  log("Shutdown approval renderer unusable:", why);
  // Nobody is left to confirm a commit, so it is refused rather than left
  // hanging: the intents behind it are raised again and reach the fallback
  // dialog, which is where an unanswerable document belongs.
  finishShutdownCommit(pendingShutdownCommit, false, "renderer-unusable");
  if (pendingShutdown) askFallbackApproval(pendingShutdown, fallbackCause);
}

function settleShutdown(record, approved, why) {
  if (pendingShutdown !== record) return; // superseded; its answer is stale
  markShutdownTiming(record.id, "settledAt");
  pendingShutdown = null;
  if (record.dialogAbortController) {
    const controller = record.dialogAbortController;
    record.dialogAbortController = null;
    controller.abort();
  }
  lastShutdownSettleWhy = why;
  const continuation = record.continuation;
  record.continuation = null; // release: the record must outlive nothing
  const queued = queuedShutdown;
  queuedShutdown = null;
  if (!approved) {
    completeShutdownTiming(record.id);
    log(`Shutdown approval #${record.id} declined (${why})`);
    // The app is staying up, so nothing may still be holding the document
    // read-only on behalf of a shutdown that is not happening.
    releaseShutdownFreeze();
    declineIntent(record, `declined-${why}`);
    // A STRONGER intent that arrived mid-question is not answered by this
    // decision: "do not close my window" is not "do not install the update".
    // It is asked again as a FRESH request with its own id rather than being
    // dropped, and rather than being substituted into a question the user has
    // already been shown.
    if (queued) {
      log(`Re-raising the queued ${queued.reason} intent as its own request`);
      requestShutdown(queued.reason, queued.continuation, {
        forceFresh: queued.forceFresh,
        onDeclined: queued.onDeclined,
      });
    }
    if (isUpdaterShutdownReason(record.reason)) {
      replayAbsorbedUserShutdownAfterUpdaterCancel(why);
    }
    return;
  }
  log(`Shutdown approval #${record.id} granted (${why})`);
  if (queued && queued.forceFresh) {
    completeShutdownTiming(record.id);
    // This record was approved, but a force-fresh intent supersedes it: its
    // continuation is not going to run, so anything waiting on that answer is
    // told rather than left holding a resource nobody will ever release.
    declineIntent(record, "superseded-by-queued");
    requestShutdown(queued.reason, queued.continuation, {
      forceFresh: true,
      onDeclined: queued.onDeclined,
    });
    return;
  }
  const continuations = [
    { reason: record.reason, continuation, onDeclined: record.onDeclined },
  ];
  if (queued) continuations.push(queued);
  commitThenRun(record, continuations, shutdownDocumentSession());
}

// PHASE TWO. `settleShutdown` has an ANSWER; this turns it into a COMMIT.
//
// The answer described the document at one instant. Between it and the
// continuation - which runs on a later turn of the loop by design, so it is not
// re-entering the lifecycle handler it just prevented - the reader can type.
// Re-checking the document generation cannot see that: the same document with
// new text in it is the same generation. So the renderer is asked to commit
// against the exact REVISION its answer named. That commit re-runs the fold,
// which really does re-read the textarea or the live copy, and refuses if
// anything moved; on success it FREEZES the document so nothing further can be
// typed into a document that is about to go away.
//
// Only an answer that came FROM the renderer can be committed this way. A
// main-process fallback dialog, a settled "no-window" or a window that has gone
// have no renderer to ask, and there is correspondingly nothing left to lose -
// those run directly, as before.
function commitThenRun(record, continuations, approvedSession) {
  // CAPTURED AT COMMIT START AND NEVER RECOMPUTED. The epoch that authorises
  // these continuations is the one in force when the commit began, not the one
  // in force when it happens to finish - reading it later means a request that
  // arrived DURING the commit has already moved the baseline the check is made
  // against, so the very intent that should invalidate this one silently
  // legitimises it.
  const authorisedSeq = shutdownRequestSeq;
  if (record.revision === null || record.revision === undefined) {
    // No renderer answer underlies this approval - a main-process fallback
    // dialog, a settled "no-window", a window that has gone. There is no
    // revision to commit against and no renderer to ask, and correspondingly
    // nothing left to lose, so these run as they always did.
    runApprovedContinuations(
      continuations,
      record.id,
      approvedSession,
      authorisedSeq,
    );
    return;
  }
  // A revision is local to one renderer document and can restart at the same
  // number after navigation. Never compare an old response's revision against
  // a replacement document merely because the integers happen to collide.
  if (
    !Number.isSafeInteger(record.responseGeneration) ||
    record.responseGeneration !== approvalRendererGeneration
  ) {
    revokeShutdownAuthorization();
    releaseShutdownFreeze();
    for (const intent of continuations) {
      requestShutdown(intent.reason, intent.continuation, {
        forceFresh: true,
        onDeclined: intent.onDeclined,
      });
    }
    return;
  }
  const attempt = {
    id: record.id,
    reason: record.reason,
    revision: record.revision,
    generation: record.responseGeneration,
    sequence: ++shutdownCommitSeq,
    continuations,
    approvedSession,
    authorisedSeq,
    deletionEvidenceRevision: record.deletionEvidenceRevision,
    settled: false,
    awaitingVerification: false,
    deadlineTimer: null,
  };
  // ONE COMMIT AT A TIME. requestShutdown() already stands an in-flight commit
  // down before it raises anything new, so this should be unreachable - but
  // overwriting the slot would strand the previous attempt with no event able
  // to settle it, and every intent behind it with it. Belt and braces on the
  // one invariant this phase must not break.
  if (pendingShutdownCommit) {
    finishShutdownCommit(pendingShutdownCommit, false, "superseded-by-commit");
  }
  pendingShutdownCommit = attempt;
  const win = shutdownOwnerWindow();
  const wc = win ? win.webContents : null;
  // A REVISION-BEARING APPROVAL COMMITS OR FAILS CLOSED - it never runs on the
  // strength of the answer alone. This used to fall through to the
  // continuation when the renderer had gone unready since it answered, which
  // is precisely the case where the answer is least trustworthy: the document
  // that produced it is unreachable, so nothing can confirm it still describes
  // anything. Refused instead, which re-raises the intent and reaches the
  // explicit main-process question.
  if (!wc || wc.isDestroyed() || wc.isCrashed() || approvalRendererState !== "ready") {
    finishShutdownCommit(attempt, false, "renderer-unavailable-at-commit");
    return;
  }
  attempt.deadlineTimer = setTimeout(() => {
    // Timer callbacks already queued by the event loop can still run after
    // clearTimeout(). Identity, generation and both monotonic sequences must
    // all still name the exact commit that installed this deadline.
    if (
      pendingShutdownCommit !== attempt ||
      attempt.settled ||
      attempt.sequence !== shutdownCommitSeq ||
      attempt.generation !== approvalRendererGeneration ||
      attempt.authorisedSeq !== shutdownRequestSeq
    ) {
      staleShutdownCommitTimeoutCount += 1;
      return;
    }
    shutdownCommitTimeoutCount += 1;
    log(`Shutdown commit #${attempt.id} timed out; asking in the main process`);
    finishShutdownCommit(attempt, false, "commit-timeout", {
      fallbackCause: "unresponsive",
    });
  }, SHUTDOWN_COMMIT_TIMEOUT_MS);
  if (typeof attempt.deadlineTimer.unref === "function") {
    attempt.deadlineTimer.unref();
  }
  try {
    shutdownCommitIngressBlocked = true;
    wc.send(QUIT_APPROVAL_COMMIT, {
      id: record.id,
      gen: attempt.generation,
      revision: record.revision,
    });
  } catch (error) {
    // The renderer cannot be reached to commit. That is not permission: it is
    // the same "nobody can answer" case the request path already handles, and
    // it is resolved the same way - by asking again rather than by acting.
    finishShutdownCommit(attempt, false, "commit-send-failed", {
      fallbackCause: "unresponsive",
    });
  }
}

// One settlement per commit attempt, from whichever of the four routes arrives
// first: the renderer's answer, a renderer that dies, a navigation, or a send
// that threw. A commit that is neither confirmed nor refused would strand every
// continuation behind it, which is the one failure this phase must not add.
//
// A refusal normally RE-RAISES the intents behind it: the answer is stale, so
// the question is asked again. `reraise: false` is for the two places that are
// tearing the session down rather than continuing it - a replaced window and
// the test seam's reset - where raising a fresh question against a document
// that no longer exists would leave a phantom request outstanding in a machine
// that was just cleared. Those intents are DECLINED instead, so an
// asynchronous hand-off parked on one is still stood down.
function finishShutdownCommit(attempt, committed, why, options = {}) {
  if (!attempt || attempt.settled) return;
  attempt.settled = true;
  if (attempt.deadlineTimer !== null) {
    clearTimeout(attempt.deadlineTimer);
    attempt.deadlineTimer = null;
  }
  if (pendingShutdownCommit === attempt) pendingShutdownCommit = null;
  // A NEWER INTENT INVALIDATES A CONFIRMED COMMIT TOO. The renderer may have
  // said yes about a document state the reader has since been asked about
  // again; acting on it now would run an old answer alongside a new question.
  // Compared against the epoch this attempt STARTED with, which is the only
  // baseline a later request cannot have moved.
  if (committed && shutdownRequestSeq > attempt.authorisedSeq) {
    committed = false;
    why = "superseded-during-commit";
  }
  if (
    committed &&
    deletionEvidenceRevision !== attempt.deletionEvidenceRevision
  ) {
    committed = false;
    why = "deletion-evidence-changed-during-commit";
  }
  if (committed) {
    log(`Shutdown commit #${attempt.id} confirmed at revision ${attempt.revision}`);
    runApprovedContinuations(
      attempt.continuations,
      attempt.id,
      attempt.approvedSession,
      attempt.authorisedSeq,
    );
    return;
  }
  // The document moved, or nobody could say. Either way the answer in hand
  // describes a state that no longer exists, so it is not acted on - the
  // intents are raised again as fresh questions about the document as it now
  // stands. `forceFresh` is what stops the stale authorization being reused.
  shutdownCommitRefusedCount += 1;
  lastShutdownCommitRefusedWhy = why;
  log(`Shutdown commit #${attempt.id} refused (${why}); asking again`);
  revokeShutdownAuthorization();
  releaseShutdownFreeze();
  const reraise = options.reraise !== false;
  for (const intent of attempt.continuations) {
    if (!reraise || !intent || typeof intent.continuation !== "function") {
      declineIntent(intent, `commit-refused-${why}`);
      continue;
    }
    requestShutdown(intent.reason, intent.continuation, {
      forceFresh: true,
      onDeclined: intent.onDeclined,
      fallbackCause: options.fallbackCause,
    });
  }
}

function foliaUpdaterAttemptRetainsFreeze() {
  const attempt = activeUpdaterInstallAttempt;
  return !!(
    attempt &&
    !attempt.retired &&
    attempt.launchOwner === "folia" &&
    !attempt.retrySafe
  );
}

// Tell the renderer it may accept edits again. A Folia-owned installer handoff
// is the exception: after phase two commits, its freeze is the protection
// against NSIS killing a document that changed during UAC/process startup.
// Generic cancellation/navigation paths cannot thaw it. Only a retry-safe
// launcher failure retires the attempt first, or the test seam forces reset.
function releaseShutdownFreeze(options = {}) {
  if (!options.force && foliaUpdaterAttemptRetainsFreeze()) return;
  shutdownCommitIngressBlocked = false;
  const win = shutdownOwnerWindow();
  const wc = win ? win.webContents : null;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(QUIT_APPROVAL_THAW);
  } catch (error) {
    // The renderer is gone, so there is no freeze left to release.
  }
}

ipcMain.on(QUIT_APPROVAL_COMMITTED, (event, data) => {
  if (!isApprovalSender(event)) return;
  const attempt = pendingShutdownCommit;
  // A reply to a commit that has already been settled by another route - a
  // newer intent invalidating it, a renderer that went away, the seam's reset.
  // COUNTED, not silently dropped: "the late reply did nothing" is otherwise
  // indistinguishable from "the reply never arrived", and those are the two
  // halves a test of this race has to tell apart.
  if (!attempt) {
    staleShutdownCommitCount += 1;
    return;
  }
  if (attempt.awaitingVerification) {
    staleShutdownCommitCount += 1;
    return;
  }
  if (
    !data ||
    data.id !== attempt.id ||
    !Number.isSafeInteger(data.gen) ||
    data.gen !== attempt.generation ||
    attempt.generation !== approvalRendererGeneration
  ) {
    // An answer to a commit this is not waiting for. Dropped rather than
    // believed; the attempt stays open for its own reply or for the renderer
    // dying, both of which settle it.
    staleShutdownCommitCount += 1;
    return;
  }
  // AN ACKNOWLEDGEMENT NAMES THE DOCUMENT IT ACKNOWLEDGES. The commit asked
  // about ONE revision, and the whole point of phase two is that the answer
  // was taken against that exact document state - so a "yes" that cannot say
  // which revision it is agreeing to, or that names a different one, proves
  // nothing about the document this shutdown is about to discard. Identity and
  // generation are already current here, so this is not a stale reply to be
  // ignored: it is a live acknowledgement that fails closed, down the same
  // refusal path as any other moved revision - thaw, ask again, never
  // authorize. Counted with the phase-one revision diagnostics, because "the
  // renderer answered something unusable" is otherwise invisible.
  //
  // Only a "yes" is checked this way. An explicit "no" is a refusal already,
  // and its own reason is the useful one; re-labelling it here would hide
  // which control actually settled the commit.
  if (data.committed === true) {
    const revision = data.revision;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision !== attempt.revision
    ) {
      const invalidWhy =
        revision === undefined
          ? "missing"
          : !Number.isSafeInteger(revision)
            ? "not-a-safe-integer"
            : revision < 0
              ? "negative"
              : "mismatch";
      invalidShutdownRevisionCount += 1;
      lastInvalidShutdownRevisionWhy = invalidWhy;
      finishShutdownCommit(attempt, false, `commit-revision-${invalidWhy}`);
      return;
    }
  }
  if (data.committed !== true) {
    finishShutdownCommit(attempt, false, data.why || "renderer",
      data.why === "session-layout-persistence-failed"
        ? { fallbackCause: "session-persistence" } : {});
    return;
  }
  attempt.awaitingVerification = true;
  const win = shutdownOwnerWindow();
  try {
    if (!win || win.webContents.isDestroyed()) {
      throw new Error("approval window disappeared before verification");
    }
    win.webContents.send(QUIT_APPROVAL_VERIFY, {
      id: attempt.id,
      gen: attempt.generation,
      revision: attempt.revision,
    });
  } catch (error) {
    log("Shutdown verification could not be sent:", error);
    finishShutdownCommit(attempt, false, "verification-send-failed", {
      fallbackCause: "unresponsive",
    });
  }
});

ipcMain.on(QUIT_APPROVAL_VERIFIED, (event, data) => {
  if (!isApprovalSender(event)) return;
  const attempt = pendingShutdownCommit;
  if (
    !attempt ||
    !attempt.awaitingVerification ||
    !data ||
    data.id !== attempt.id ||
    data.gen !== attempt.generation ||
    data.revision !== attempt.revision
  ) {
    staleShutdownCommitCount += 1;
    return;
  }
  finishShutdownCommit(
    attempt,
    data.valid === true,
    data.valid === true ? "renderer-verified" : "verification-refused",
    data.valid === true ? {} : { fallbackCause: "unreadable" },
  );
});

ipcMain.on("quit-approval-overflow", (event, data) => {
  if (
    !isApprovalSender(event) ||
    !data ||
    data.gen !== approvalRendererGeneration
  ) return;
  const attempt = pendingShutdownCommit;
  if (attempt && attempt.id === data.id) {
    finishShutdownCommit(attempt, false, "deferred-operation-overflow", {
      fallbackCause: "unreadable",
    });
    return;
  }
  // An ACK alone is not authorization: a queued continuation checks this
  // epoch before entering any irreversible callback.
  shutdownContinuationEpoch += 1;
  revokeShutdownAuthorization();
  releaseShutdownFreeze();
  log("Shutdown approval invalidated by deferred operation overflow");
});

// Continuations run on a fresh turn of the loop, never inside the lifecycle
// handler that just called preventDefault() on the very event they are about
// to re-raise.
//
// Each is authorized individually and immediately before it runs. Returning
// false means nothing started: the speculative grant is removed and the
// renderer is thawed. SHUTDOWN_CONTINUATION_PENDING removes the grant too, but
// retains the revision-bound freeze while an asynchronous hand-off is still
// capable of starting an installer. Its callback must later either fail
// retry-safe and thaw, remain conservatively frozen in an ambiguous state, or
// positively start and quit under the already-committed approval.
//
// EVERY CONTINUATION IS BOUND TO THE EPOCH THAT AUTHORISED IT. A newer intent
// arriving while this is queued means the world has moved on: acting on the old
// answer then races the new question, and the new one is the one the reader is
// looking at. The old intent is declined rather than dropped, so an
// asynchronous hand-off parked on it is stood down.
//
// The catch is narrow and has a defined recovery: quitAndInstall() is a
// third-party call across a spawn boundary, and rethrowing out of a
// setImmediate would make an uncaught exception - the main process dying,
// taking the unsaved documents this whole section exists to protect - the
// outcome of a failed shutdown. Withdrawing the authorization instead leaves
// the app running and asking again next time, which is the safe direction.
function runApprovedContinuations(
  continuations,
  requestId = 0,
  approvedSession = shutdownDocumentSession(),
  authorisedSeq = shutdownRequestSeq,
  continuationEpoch = shutdownContinuationEpoch,
  updaterEpoch = updaterContinuationEpoch,
  approvedWithBlockedSaves = deletionEvidenceCapacityLatched,
) {
  setImmediate(() => {
    for (const intent of continuations) {
      const continuation = intent && intent.continuation;
      if (typeof continuation !== "function") {
        declineIntent(intent, "no-continuation");
        if (intent && isUpdaterShutdownReason(intent.reason)) {
          replayAbsorbedUserShutdownAfterUpdaterCancel("no-continuation");
        }
        continue;
      }
      if (!approvedWithBlockedSaves && deletionEvidenceCapacityLatched) {
        revokeShutdownAuthorization();
        releaseShutdownFreeze();
        requestShutdown(intent.reason, continuation, {
          forceFresh: true,
          onDeclined: intent.onDeclined,
        });
        continue;
      }
      if (
        isUpdaterShutdownReason(intent.reason) &&
        updaterEpoch !== updaterContinuationEpoch
      ) {
        updaterInvalidatedContinuationCount += 1;
        log(
          `Updater shutdown continuation for #${requestId} invalidated before execution`,
        );
        revokeShutdownAuthorization();
        releaseShutdownFreeze();
        declineIntent(intent, "updater-invalidated");
        continue;
      }
      if (shutdownRequestSeq > authorisedSeq) {
        supersededContinuationCount += 1;
        log(
          `Shutdown continuation for #${requestId} superseded by request #${shutdownRequestSeq}`,
        );
        revokeShutdownAuthorization();
        declineIntent(intent, "superseded-by-newer-request");
        if (isUpdaterShutdownReason(intent.reason)) {
          replayAbsorbedUserShutdownAfterUpdaterCancel(
            "superseded-by-newer-request",
          );
        }
        continue;
      }
      if (continuationEpoch !== shutdownContinuationEpoch) {
        rendererInvalidatedContinuationCount += 1;
        log(
          `Shutdown continuation for #${requestId} invalidated by renderer loss`,
        );
        revokeShutdownAuthorization();
        releaseShutdownFreeze();
        requestShutdown(intent.reason, continuation, {
          forceFresh: true,
          onDeclined: intent.onDeclined,
        });
        continue;
      }
      if (
        !isSameShutdownDocumentSession(
          approvedSession.ownerId,
          approvedSession.rendererGeneration,
          intent.reason,
        )
      ) {
        revokeShutdownAuthorization();
        releaseShutdownFreeze();
        if (isUpdaterShutdownReason(intent.reason)) {
          updaterInvalidatedContinuationCount += 1;
          declineIntent(intent, "approved-document-session-ended");
          replayAbsorbedUserShutdownAfterUpdaterCancel(
            "approved-document-session-ended",
          );
          continue;
        }
        requestShutdown(intent.reason, continuation, {
          forceFresh: true,
          onDeclined: intent.onDeclined,
        });
        continue;
      }
      grantShutdownAuthorization();
      let started;
      try {
        markShutdownTiming(requestId, "continuationInvokedAt");
        started = continuation();
      } catch (error) {
        log("Shutdown continuation failed:", error && error.stack ? error.stack : error);
        started = false;
        if (isUpdaterShutdownReason(intent.reason)) {
          replayAbsorbedUserShutdownAfterUpdaterCancel(
            "continuation-failed",
          );
        }
      }
      if (started === SHUTDOWN_CONTINUATION_PENDING) {
        shutdownPendingContinuationCount += 1;
        revokeShutdownAuthorization();
        log(
          `Shutdown continuation for #${requestId} owns a pending asynchronous hand-off`,
        );
      } else if (started === false) {
        revokeShutdownAuthorization();
        // Nothing started, so the app is staying up and the document must be
        // editable again. A freeze taken for a shutdown that did not happen is
        // a read-only editor with no way back.
        releaseShutdownFreeze();
      }
    }
    completeShutdownTiming(requestId);
  });
}

// Filenames come from the document set, so the list is bounded and each entry
// is flattened: a path containing a newline would otherwise forge dialog text,
// and an absurdly long one would push the buttons off screen. Applied to the
// single-file wording too - that is the common case, and it is the one that
// puts a name in the dialog's MESSAGE line.
function safeFileLabel(name) {
  return String(name).replace(/\s+/g, " ").slice(0, 120);
}

function describeDirtyFiles(files) {
  const shown = files.slice(0, 5).map((name) => "\u2022 " + safeFileLabel(name));
  if (files.length > shown.length) {
    shown.push(`\u2022 and ${files.length - shown.length} more`);
  }
  return shown.join("\n");
}

// `defaultId` and `cancelId` both point at Cancel: this dialog is the last
// thing between the reader and losing work, so both Enter and ESC must keep
// the app alive. A `.catch` that CANCELS rather than approves for the same
// reason - a dialog that failed to appear has not been answered.
//
// `record.asked` is what keeps ONE gesture to ONE question. Three sites can
// reach this for the same record (the renderer's answer, a renderer that dies
// while the answer is on screen, a load that finishes without the overlay),
// and without the flag the reader would be answering two modals about one
// close.
function askShutdownQuestion(record, options) {
  if (record.asked) return;
  const win = shutdownOwnerWindow();
  if (!win) {
    // The window went while this question was being routed to it. Same rule as
    // the dispatcher: nothing left to lose for a close or a quit, and no
    // consent at all for an installer.
    settleWithoutWindow(record);
    return;
  }
  record.asked = true;
  const askedBeforeSavesBlocked = !deletionEvidenceCapacityLatched;
  const abortController = new AbortController();
  record.dialogAbortController = abortController;
  dialog
    .showMessageBox(win, {
      type: "warning",
      buttons: [options.confirmLabel, "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: options.title,
      message: options.message,
      detail: options.detail,
      signal: abortController.signal,
    })
    .then((result) => {
      if (record.dialogAbortController === abortController) {
        record.dialogAbortController = null;
      }
      // Navigation replaces the document this dialog described and reissues
      // the intent under a new id. Abort normally resolves as Cancel, but the
      // native promise may settle later; identity makes either result inert.
      if (pendingShutdown !== record) {
        staleShutdownDialogCompletionCount += 1;
        return;
      }
      if (
        result.response === 0 &&
        askedBeforeSavesBlocked &&
        deletionEvidenceCapacityLatched
      ) {
        record.asked = false;
        record.deletionEvidenceRevision = deletionEvidenceRevision;
        askDeletionEvidenceCapacityApproval(
          record,
          deletionEvidenceTombstoneFileLabels(),
          record.fallbackCause,
        );
        return;
      }
      settleShutdown(record, result.response === 0, options.why);
    })
    .catch((error) => {
      if (record.dialogAbortController === abortController) {
        record.dialogAbortController = null;
      }
      if (pendingShutdown !== record) {
        staleShutdownDialogCompletionCount += 1;
        return;
      }
      log("Shutdown dialog failed:", error.message);
      settleShutdown(record, false, "dialog-failed");
    });
}

function askDiscardApproval(record, files) {
  askShutdownQuestion(record, {
    confirmLabel: "Discard changes",
    title: "Unsaved changes",
    message:
      files.length === 1
        ? `"${safeFileLabel(files[0])}" has unsaved changes.`
        : `${files.length} open documents have unsaved changes.`,
    detail: "Closing now discards them.\n\n" + describeDirtyFiles(files),
    why: "user",
  });
}

// The renderer could not be asked, or could not answer. Approving silently
// here would reintroduce the whole defect for the one case where the app has
// least idea what it is about to throw away, so it asks instead.
function askFallbackApproval(record, cause) {
  // RECORDED BEFORE THE DEFERRAL, not after the dialog. Both resumption routes
  // - the save-queue drain and the renderer's explicit retry - decide which
  // question to re-ask by reading this field, and a deferral that left it null
  // resumed by dispatching an ORDINARY approval to a renderer that had already
  // been found unreadable or unresponsive. The question a deferral defers is
  // the question it must come back with.
  record.fallbackCause = cause;
  if (saveQueuePendingCount > 0) {
    record.waitingForPendingSaves = true;
    log(
      `Shutdown approval #${record.id} held until active saves settle`,
    );
    return;
  }
  if (!record.asked) markShutdownFallbackTiming(record.id, cause);
  // THE LATCH OUTRANKS THIS QUESTION TOO. The response path already prefers
  // the dedicated warning, but every route that never gets an answer -
  // an unresponsive renderer, a renderer declared unusable, an invalid
  // revision, a commit timeout - landed here instead and told the reader that
  // Folia "cannot confirm whether anything is unsaved", when what it actually
  // knows is far more specific: it stopped writing files. The cause is kept on
  // the record (both resumption routes read it) and reported in `why`, so the
  // deferral, timing and revision semantics above are unchanged - only the
  // wording the reader sees is corrected.
  if (deletionEvidenceCapacityLatched) {
    askDeletionEvidenceCapacityApproval(
      record,
      deletionEvidenceTombstoneFileLabels(),
      cause,
    );
    return;
  }
  if (cause === "session-persistence") {
    askShutdownQuestion(record, {
      confirmLabel: "Close anyway",
      title: "Open tabs could not be saved",
      message: "Folia could not save the open-tab layout.",
      detail: "Your open tabs may not be restored next time. Closing now also " +
        "discards any unsaved changes made since the previous confirmation. " +
        "Cancel to keep working and retry.",
      why: "fallback-session-persistence",
    });
    return;
  }
  askShutdownQuestion(record, {
    confirmLabel: "Close anyway",
    title: "Unsaved changes cannot be checked",
    message: "Folia cannot confirm whether anything is unsaved.",
    detail:
      (cause === "unreadable"
        ? "The document view could not check the open documents."
        : "The document view is not responding.") +
      "\n\nClosing now may discard unsaved changes.",
    why: "fallback-" + cause,
  });
}

// SAVING IS OFF, AND THE READER HAS NOT BEEN TOLD. This is a separate question
// from "are there unsaved changes": the renderer can be perfectly clean and
// still be sitting in front of a window whose every Save since the latch was
// refused. Asked whatever the renderer answered, because what is at risk is
// not only what the renderer calls dirty - a document whose Save was refused
// may look settled to it and exist nowhere but here.
//
// THE LATCH IS SHARED, SO THE SENTENCE EXPLAINING IT HAS TO FOLLOW THE CAUSE.
// Telling the reader their record of deleted documents filled up, when what
// this process actually lost was which document a tab had moved on to, is the
// same confidently-wrong answer the fallback wording above was corrected to
// stop giving. The question, its deferral, its timing and its revision
// semantics are identical either way - only the explanation and the recorded
// `why` follow `saveAuthorityLatchReason`.
const SAVE_AUTHORITY_LATCH_SHUTDOWN_DETAIL = Object.freeze({
  "deletion-evidence-capacity":
    "Its in-memory record of deleted documents filled up, so every Save " +
    "since then has been refused rather than risk recreating a document " +
    "you deleted.",
  "document-owner-fence":
    "Its in-memory record of replaced documents filled up, so every Save " +
    "since then has been refused rather than risk writing an older version " +
    "of a document over a newer one.",
});

function askDeletionEvidenceCapacityApproval(record, files, fallbackCause = null) {
  askShutdownQuestion(record, {
    confirmLabel: "Close anyway",
    title: "Saving is blocked",
    message: "Folia stopped writing files and cannot resume until it restarts.",
    detail:
      (SAVE_AUTHORITY_LATCH_SHUTDOWN_DETAIL[saveAuthorityLatchReason] ||
        SAVE_AUTHORITY_LATCH_SHUTDOWN_DETAIL["deletion-evidence-capacity"]) +
      " Anything written since exists only in this window and closing now " +
      "discards it.\n\nCopy what you need somewhere else first." +
      (fallbackCause
        ? "\n\n" +
          (fallbackCause === "unreadable"
            ? "The document view could not check the open documents either."
            : "The document view is not responding either.")
        : "") +
      (files.length ? "\n\n" + describeDirtyFiles(files) : ""),
    why: fallbackCause
      ? saveAuthorityLatchReason + "-fallback-" + fallbackCause
      : saveAuthorityLatchReason,
  });
}

// The deleted documents this process still holds evidence for, named the way
// the reader sees them. Shared by both questions that have to list them.
function deletionEvidenceTombstoneFileLabels() {
  return Array.from(
    new Set(
      Array.from(
        documentDeletionTombstones.values(),
        (tombstone) => path.basename(tombstone.path),
      ),
    ),
  );
}

ipcMain.handle(QUIT_APPROVAL_GENERATION, (event) => {
  if (!isApprovalSender(event)) {
    throw new Error("untrusted shutdown approval renderer");
  }
  return approvalRendererGeneration;
});

ipcMain.on(QUIT_APPROVAL_READY, (event, data) => {
  if (!isApprovalSender(event)) return;
  const generation = data && data.gen;
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    generation !== approvalRendererGeneration
  ) {
    staleShutdownReadyCount += 1;
    return;
  }
  if (
    typeof data.pageSession !== "string" ||
    data.pageSession.length === 0 ||
    data.pageSession.length > 128 ||
    (approvalRendererPageSession &&
      approvalRendererPageSession !== data.pageSession)
  ) {
    staleShutdownReadyCount += 1;
    return;
  }
  approvalRendererPageSession = data.pageSession;
  approvalRendererState = "ready";
  for (const [ticket, record] of nativeDocumentOpenTickets) {
    if (!record.delivered && record.sender === event.sender &&
        record.generation === generation &&
        record.frameTreeNodeId === event.senderFrame.frameTreeNodeId) {
      record.delivered = true;
      record.pageSession = data.pageSession;
      event.sender.send("external-file-open-request", {
        filePath: record.filePath, documentOpenTicket: ticket,
      });
    }
  }
  if (activeDialogExtraBatch) {
    const batch = activeDialogExtraBatch;
    if (
      batch.sender !== event.sender ||
      batch.rendererGeneration !== generation ||
      batch.frameTreeNodeId !== event.senderFrame.frameTreeNodeId ||
      (batch.pageSession !== null &&
        batch.pageSession !== data.pageSession)
    ) {
      activeDialogExtraBatch = null;
    } else {
      // A dialog delivered before the ownership handshake belongs to this
      // page; queued file-opened events resume only after the handshake.
      batch.pageSession = data.pageSession;
    }
  }
  if (
    overlayProbeOwner &&
    overlayProbeOwner.generation === approvalRendererGeneration
  ) {
    overlayProbeOwner = null;
  }
  // A request that was held for this renderer - or dispatched to the one it
  // replaced - is asked now. Comparing generations rather than resending
  // unconditionally keeps a ready renderer from being asked the same question
  // twice, and `asked` keeps a question that is already on screen from being
  // duplicated by a renderer that arrived late.
  if (
    pendingShutdown &&
    !pendingShutdown.asked &&
    pendingShutdown.dispatchedTo !== approvalRendererGeneration
  ) {
    dispatchShutdownRequest(pendingShutdown);
  }
});

ipcMain.on(QUIT_APPROVAL_RESPONSE, (event, data) => {
  if (!isApprovalSender(event)) return;
  const record = pendingShutdown;
  if (!record) {
    staleShutdownResponseCount += 1;
    return;
  }
  const matchesRequest =
    !!data && Number.isSafeInteger(data.id) && data.id === record.id;
  const matchesGeneration =
    !!data &&
    Number.isSafeInteger(data.gen) &&
    data.gen === approvalRendererGeneration &&
    record.dispatchedTo === approvalRendererGeneration;
  // A question is already on screen for this record - the renderer hung and
  // the main process took over, or its process died mid-answer. The reader's
  // answer to the modal in front of them decides; a late reply must not settle
  // the request behind it and leave an orphaned dialog over a closing window.
  if (record.asked) {
    if (matchesRequest && matchesGeneration) {
      markShutdownLateResponseTiming(record.id);
    } else {
      staleShutdownResponseCount += 1;
    }
    return;
  }
  if (!matchesRequest || !matchesGeneration) {
    staleShutdownResponseCount += 1;
    log("Ignoring a shutdown answer that does not match the open question");
    return;
  }
  markShutdownTiming(record.id, "rendererResponseAt");
  const revision = data.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    invalidShutdownRevisionCount += 1;
    lastInvalidShutdownRevisionWhy =
      revision === undefined
        ? "missing"
        : Number.isSafeInteger(revision)
          ? "negative"
          : "not-a-safe-integer";
    // A renderer that cannot speak the phase-two protocol cannot safely
    // authorize phase one. Declare it unusable so this request and subsequent
    // ones take the established explicit fallback path rather than allowing a
    // legacy or malformed clean answer to become consent.
    markRendererUnusable(
      `invalid shutdown approval revision (${lastInvalidShutdownRevisionWhy})`,
      approvalRendererGeneration,
      "unreadable",
    );
    return;
  }
  if (data.pendingSaves === true) {
    if (data.dirtyFiles !== null) {
      askFallbackApproval(record, "unreadable");
      return;
    }
    record.revision = null;
    record.responseGeneration = null;
    record.waitingForPendingSaves = true;
    record.dispatchedTo = 0;
    record.dispatchToken = 0;
    log(
      `Shutdown approval #${record.id} deferred while an open-tab save settles`,
    );
    return;
  }
  // THE REVISION THIS ANSWER DESCRIBES. Kept on the record so the commit phase
  // can hand it back and the renderer can refuse an answer the document has
  // since moved past. Only a non-negative safe integer reaches this point:
  // absence or malformed legacy data is an unreadable renderer response, not
  // a main-process approval that may bypass the commit.
  record.revision = revision;
  record.responseGeneration = data.gen;
  record.deletionEvidenceRevision = deletionEvidenceRevision;
  // EVERY entry must be a string, not merely the ones that happen to be. A
  // filter would turn a malformed answer - [null], [123] - into an empty list,
  // which reads as "nothing is unsaved" and closes the window. A malformed
  // answer is an unknown answer.
  const files =
    Array.isArray(data.dirtyFiles) &&
    data.dirtyFiles.every((name) => typeof name === "string")
      ? data.dirtyFiles
      : null;
  if (!files) {
    // The renderer said explicitly that it could not tell, or answered in a
    // shape this cannot read. Neither is an approval.
    askFallbackApproval(record, "unreadable");
    return;
  }
  const deletionFiles = deletionEvidenceTombstoneFileLabels();
  const representedDeletionKeys = new Set(
    Array.from(
      documentDeletionTombstones.values(),
      (tombstone) => tombstone.pathKey,
    ),
  );
  // THE LATCH OUTRANKS EVERY OTHER READING OF THIS ANSWER, including the
  // fallback below. It is the one fact the renderer cannot know and cannot
  // report, it is true whether or not anything looks dirty, and it names the
  // real risk - so it is asked with its own words rather than borrowing the
  // "cannot be checked" question, which would tell the reader the wrong thing
  // about why their window will not close quietly.
  if (deletionEvidenceCapacityLatched) {
    askDeletionEvidenceCapacityApproval(
      record,
      Array.from(new Set([...files, ...deletionFiles])),
    );
    return;
  }
  if (
    deletionOverflowEvidence.size > 0 ||
    Array.from(deletedDocuments).some(
      (key) => !representedDeletionKeys.has(key),
    )
  ) {
    askFallbackApproval(record, "unreadable");
    return;
  }
  const blockingFiles = Array.from(new Set([...files, ...deletionFiles]));
  if (blockingFiles.length === 0) {
    settleShutdown(record, true, "clean");
    return;
  }
  askDiscardApproval(record, blockingFiles);
});

ipcMain.on(QUIT_APPROVAL_RETRY, (event, data) => {
  if (!isApprovalSender(event)) return;
  const record = pendingShutdown;
  if (
    !record ||
    record.asked ||
    !record.waitingForPendingSaves ||
    !data ||
    data.id !== record.id ||
    !Number.isSafeInteger(data.gen) ||
    data.gen !== approvalRendererGeneration
  ) {
    staleShutdownResponseCount += 1;
    return;
  }
  record.waitingForPendingSaves = false;
  // Same rule as reconsiderShutdownAfterSaveSettlement: a record that reached
  // the fallback path resumes with THE SAME QUESTION. The renderer telling us
  // its own saves have settled does not make it readable again, so dispatching
  // an ordinary approval here would ask a renderer that has already been found
  // unable to answer.
  if (record.fallbackCause) {
    askFallbackApproval(record, record.fallbackCause);
    return;
  }
  dispatchShutdownRequest(record);
});

function quitApprovedApp() {
  app.quit();
  return true;
}

function quitApprovedUpdateApp() {
  app.quit();
  cancelAbsorbedUserShutdown("update-succeeded");
  return true;
}

function closeApprovedWindow(win) {
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
}

function restartPendingShutdownAfterNavigation(record) {
  if (!record || pendingShutdown !== record) return;

  const queued = queuedShutdown;
  pendingShutdown = null;
  queuedShutdown = null;
  markShutdownTiming(record.id, "settledAt");
  completeShutdownTiming(record.id);
  lastShutdownSettleWhy = "navigated";
  navigationInvalidatedShutdownCount += 1;

  // Abort closes the old native dialog where the platform supports it. The
  // promise is still treated as hostile: its eventual result is ignored by
  // the record-identity check in askShutdownQuestion.
  if (record.dialogAbortController) {
    const controller = record.dialogAbortController;
    record.dialogAbortController = null;
    controller.abort();
  }

  const continuation = record.continuation;
  record.continuation = null;
  log(
    `Shutdown approval #${record.id} invalidated by navigation; asking the replacement document`,
  );
  releaseShutdownFreeze();
  requestShutdown(record.reason, continuation, {
    forceFresh: true,
    onDeclined: record.onDeclined,
  });

  // Preserve a distinct stronger intent rather than folding it into the old
  // consent token. queueShutdown applies the same ranking and exactly-once
  // decline rules it used before the navigation.
  if (queued) {
    queueShutdown(
      queued.reason,
      queued.continuation,
      queued.forceFresh,
      queued.onDeclined,
    );
  }
}

function attachShutdownGuards(win) {
  // A new document window is a new session. On macOS `activate` builds one
  // after every window has closed, and an authorization granted to the last
  // one must not silently cover this one's tabs.
  revokeShutdownAuthorization();
  activeDialogExtraBatch = null;
  // Dropping these two slots is what makes the new window a fresh session, but
  // an intent that is dropped without being told is exactly the leak
  // declineIntent exists to prevent: a portable hand-off parked on one of them
  // would keep its child, its private directory and the in-flight latch for
  // the rest of the session with nothing left to release them.
  declineIntent(pendingShutdown, "window-replaced");
  declineIntent(queuedShutdown, "window-replaced");
  cancelAbsorbedUserShutdown("window-replaced");
  pendingShutdown = null;
  queuedShutdown = null;
  // A commit attempt belongs to the window it was taken against. Abandoned
  // rather than re-raised: the document it was confirming is gone, so there is
  // nothing left to ask about, and a fresh question raised here would outlive
  // the session that has just been cleared.
  finishShutdownCommit(pendingShutdownCommit, false, "window-replaced", {
    reraise: false,
  });
  approvalRendererState = "loading";
  approvalRendererGeneration += 1;
  approvalRendererPageSession = null;
  knownDocumentOwners.clear();
  latestAcceptedSaveSequenceByDocument.clear();
  latestWatcherSelectionGeneration = 0;
  overlayProbeOwner = null;
  // The tabs a deletion report was addressed to belong to the window being
  // replaced, so nothing left open can ever be answered. The deletion evidence
  // itself survives.
  releaseDeletionDeliveriesForPage();

  const wc = win.webContents;

  // NOT did-start-loading, which is the webContents' AGGREGATE loading state:
  // the @@@html sandbox frames get a fresh srcdoc on every render that
  // contains one, so a load-state signal would disarm the renderer path on an
  // ordinary document and never re-arm - every close from then on would fall
  // through to the main-process dialog, which cannot name a single file.
  //
  // AND NOT did-start-navigation EITHER, which is the same trap one layer
  // down and is MEASURED in this repo: test-render-security.js (the N11
  // block) records that a main-frame navigation the will-navigate deny above
  // CANCELS still fires did-start-navigation. The document survives, so
  // nothing afterwards announces readiness and nothing finishes loading - the
  // state would sit in "loading" after a denied navigation and route the next
  // close through an unnecessary main-process fallback question.
  // did-navigate fires on COMMIT, so a cancelled or failed navigation never
  // reaches it, and it still lands before the new document's scripts run.
  wc.on("did-navigate", () => {
    const pendingAtNavigation = pendingShutdown;
    revokeShutdownAuthorization();
    activeDialogExtraBatch = null;
    approvalRendererState = "loading";
    approvalRendererGeneration += 1;
    approvalRendererPageSession = null;
    knownDocumentOwners.clear();
    latestAcceptedSaveSequenceByDocument.clear();
    latestWatcherSelectionGeneration = 0;
    overlayProbeOwner = null;
    // Same rule as window replacement above: a new document owns no tab the
    // open reports were addressed to.
    releaseDeletionDeliveriesForPage();
    // A committed Windows update freeze belonged to the document that was
    // just replaced. The replacement has not run scripts and cannot yet hold
    // edits, so quit now under that committed approval rather than exposing a
    // new editable document while NSIS may still start.
    if (quitAfterFrozenUpdaterDocumentLoss("navigated")) return;
    // A commit in flight belonged to the document that has just been replaced,
    // and the freeze it may have taken went with that document. Refused, so the
    // replacement is asked its own question.
    finishShutdownCommit(pendingShutdownCommit, false, "navigated");
    // A request or native discard dialog is also an answer about the replaced
    // document. Settle it fail-closed, dismiss it where possible, and issue a
    // new request id for the replacement; resetting only `dispatchedTo` left
    // an old dialog able to approve a new session at a colliding revision.
    restartPendingShutdownAfterNavigation(pendingAtNavigation);
  });

  // The page finished loading and the tab overlay has not announced itself.
  // The probe below is what tells "still in flight" apart from "there is no
  // overlay and nothing will ever answer" - the only escape from "loading"
  // that is not an announcement, and an answer rather than a timer.
  wc.on("did-finish-load", () => {
    if (approvalRendererState !== "loading") return;
    probeForApprovalOverlay(wc);
  });

  wc.on("did-fail-load", (event, errorCode, errorDescription, url, isMainFrame) => {
    if (!isMainFrame) return;
    // ERR_ABORTED (-3) is not a failure: it is what Chromium reports for a
    // navigation that was SUPERSEDED or cancelled - a reload issued over one
    // already in flight, which is exactly what recovering a crashed renderer
    // does. The navigation that replaced it will report its own outcome, so
    // treating this as "the renderer can no longer answer" declares a page
    // dead while it is still loading, and sends a close that could have been
    // answered properly to the main-process dialog instead. Measured as a
    // flake in test/test-tab-refresh.js before this exclusion.
    if (errorCode === -3) return;
    markRendererUnusable(`load failed (${errorCode} ${errorDescription})`);
  });

  wc.on("render-process-gone", (event, details) => {
    if (quitAfterFrozenUpdaterDocumentLoss("renderer-process-gone")) return;
    markRendererUnusable(
      "renderer process gone: " + ((details && details.reason) || "unknown"),
    );
  });

  // The webContents itself going away is the other half of "there is nobody to
  // ask": a request held for a renderer that no longer exists has no event
  // left to release it otherwise.
  wc.on("destroyed", () => {
    if (quitAfterFrozenUpdaterDocumentLoss("webcontents-destroyed")) return;
    markRendererUnusable("webContents destroyed");
  });

  // A renderer that is alive and listening but WEDGED - a long synchronous
  // render, which this app documents as taking seconds on a large document -
  // would leave an outstanding question unanswerable with nothing else to
  // report it. Chromium's own hang detection is the event for that. It does
  // NOT approve anything and does NOT change the readiness state, so a
  // renderer that comes back is still the one that answers the next question;
  // it only moves THIS question to where it can still be answered.
  win.on("unresponsive", () => {
    // A COMMIT IN FLIGHT IS WAITING ON A RENDERER THAT CANNOT ANSWER IT. Left
    // alone it strands - the commit reply never comes, and no other event
    // fires for a renderer that is merely wedged rather than gone. It is
    // refused first, which thaws the document and re-raises its intents as
    // fresh questions, so the fallback below asks about the CURRENT question
    // rather than one the refusal has already superseded.
    if (pendingShutdownCommit) {
      log("Renderer unresponsive with a shutdown commit in flight");
      finishShutdownCommit(
        pendingShutdownCommit,
        false,
        "unresponsive-during-commit",
        { fallbackCause: "unresponsive" },
      );
    }
    if (!pendingShutdown || pendingShutdown.asked) return;
    log("Renderer unresponsive with a shutdown question outstanding");
    askFallbackApproval(pendingShutdown, "unresponsive");
  });

  // The guard. preventDefault holds the window open while the question is
  // outstanding; the approved continuation calls close() again, and this
  // handler lets that second close through exactly once rather than starting
  // over.
  win.on("close", (event) => {
    if (hasCurrentShutdownAuthorization()) return;
    event.preventDefault();
    requestShutdown("window-close", () => closeApprovedWindow(win));
  });

  // TEARDOWN. The window is gone and nothing here may turn its disappearance
  // into consent for anything. Three separate leaks used to run out of this
  // handler, and each of them ended in an installer:
  //
  //  1. The commit refusal defaulted to RE-RAISING its intents. A re-raised
  //     update-install then reached the dispatcher with no window, which
  //     approved it - so a window closing installed an update.
  //  2. Settling the pending window-close APPROVED it, and settleShutdown
  //     carries the QUEUED intent with it: a force-fresh update-install queued
  //     behind that close was re-raised into the same no-window approval.
  //  3. A stronger pending intent was re-dispatched directly into it.
  //
  // So teardown now does the opposite of resolving: it ABANDONS. The commit is
  // abandoned without re-raising, the queued intent is declined, and the only
  // thing settled is the fact that the close this window was asked about has
  // already happened - without running its continuation, because there is no
  // longer a window to close and running it would grant an authorization over a
  // session that no longer exists. Every updater intent is declined, which is
  // what carries a cancel back to a parked portable child: its gate is
  // cancelled, its private directory removed and its in-flight latch cleared.
  win.on("closed", () => {
    // setImmediate continuations are not in pendingShutdown or the commit
    // slot anymore. Invalidate updater work that was approved by this session
    // before any ordinary close settlement can make the empty screen visible.
    invalidateDeferredUpdaterContinuations("window-closed");
    activeDialogExtraBatch = null;
    approvalRendererState = "unusable";
    lastRendererUnusableReason = "the document window closed";
    // Abandoned, NOT re-raised: a fresh question about a document that no
    // longer exists can only be answered by a rule, and the only rule that
    // could answer it is the no-window one this must not reach.
    finishShutdownCommit(pendingShutdownCommit, false, "window-closed", {
      reraise: false,
    });
    pendingShutdownCommit = null;
    // A queued intent was waiting for a document window to come back to. It
    // will not, so it is told rather than dropped - and told BEFORE the pending
    // record is settled, so no settlement can pick it up and re-raise it.
    if (queuedShutdown) {
      declineIntent(queuedShutdown, "window-gone");
      queuedShutdown = null;
    }
    cancelAbsorbedUserShutdown("window-gone");
    const record = pendingShutdown;
    if (!record) return;
    // THE WINDOW DISAPPEARING ANSWERS EXACTLY ONE QUESTION: "may this window
    // close?" - and it does not answer it so much as report it. The close has
    // happened; there is nothing left for the continuation to do, and running
    // it would grant an authorization for a session that is over.
    if (record.reason === "window-close") {
      settleShutdown(record, false, "window-gone-already-closed");
      return;
    }
    // Anything else is refused. `settleWithoutWindow` is deliberately NOT used
    // here: this is a teardown, not a dispatch, and an ordinary quit intent
    // outstanding at this instant has already lost the window it was raised
    // against - the lifecycle raises its own quit right afterwards, through the
    // ordinary guard, with no window to intercept it.
    settleShutdown(
      record,
      false,
      isUpdaterShutdownReason(record.reason)
        ? "window-gone-updater"
        : "window-gone-unowned",
    );
  });
}

// Registered after the single-instance block above, so the `app.quit()` a
// second instance issues before any window exists is not intercepted on its
// way out. It would be handled correctly anyway - no window means nothing to
// ask about - but not preventing that quit at all is one less moving part
// during startup.
app.on("before-quit", (event) => {
  const boundary = updaterQuitBoundary;
  if (boundary) {
    updaterQuitBoundary = null;
    if (boundary.expiry !== null) clearImmediate(boundary.expiry);
    // The updater calls app.quit immediately after before-quit-for-update.
    // That first quit is only a lifecycle notification: the real update quit
    // is re-issued after the fresh document approval above. If the attempt was
    // poisoned by an error, it is never re-issued at all. This check precedes
    // both authorization and the no-window shortcut so a failed updater cannot
    // escape through either route.
    event.preventDefault();
    if (boundary.attempt.poisoned) {
      log(
        `Blocked app.quit from failed updater attempt #${boundary.attempt.id}`,
      );
      finishFailedUpdaterInstallAttempt(boundary.attempt);
    } else {
      log(
        `Held app.quit from updater attempt #${boundary.attempt.id} for fresh approval`,
      );
      finishCommittedUpdaterInstallAttempt(boundary.attempt);
    }
    return;
  }
  if (hasCurrentShutdownAuthorization()) return;
  if (!shutdownOwnerWindow()) return; // no document window: nothing to lose
  event.preventDefault();
  requestShutdown("app-quit", quitApprovedApp);
});

// ============================================
// Auto-Updater Configuration
// ============================================

// Only configure auto-updater if it's available
// Portable .exe detection: electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
let downloadedUpdatePath = null; // path to downloaded installer, set in update-downloaded event
let updaterDownloadInFlight = false;

// Called once by getAutoUpdater() on first use. These handlers used to be
// attached at module load; deferring them is safe because nothing can emit
// before the module they belong to has been required.
function configureAutoUpdater(autoUpdater) {
  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't download automatically, let user decide
  // Windows NSIS installation is owned by performWindowsInstalledUpdate().
  // Leaving this enabled would let BaseUpdater's ordinary quit hook call its
  // unverified NsisUpdater.install path, bypassing Folia's positive process-
  // start proof and reviving the ENOENT/openPath false hand-off. Portable
  // builds have never used it. Other installed platforms retain their prior
  // behavior, including macOS where explicit Install remains fail-closed.
  autoUpdater.autoInstallOnAppQuit =
    !isPortable && process.platform !== "win32";

  // PRIVACY: electron-updater mints a random UUID, persists it to
  // userData/.updaterId and sends it as `x-user-staging-id` on EVERY update
  // check (AppUpdater.js getUpdateInfoAndProvider / getOrCreateStagingUserId).
  // It exists for staged percentage rollouts, which this project does not use,
  // and it is a stable pseudonymous identifier: it makes every check from this
  // machine linkable to every other one, forever. `computeFinalHeaders` merges
  // `requestHeaders` OVER its own, so overriding it here blanks the value.
  // Measured: it must be "" and not undefined -- undefined reaches
  // setHeader() and throws `value` required, which kills the check outright.
  autoUpdater.requestHeaders = { "x-user-staging-id": "" };

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
    // This event is inside executeDownload's `done` callback, before its final
    // blockmap/path bookkeeping. Keep updaterDownloadInFlight raised until the
    // downloadUpdate promise settles; this event alone is not completion.
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

  autoUpdater.on("error", (err, context) => {
    // Silently log errors - don't show to user
    // Common errors: no release on GitHub, network issues, etc.
    log("Auto-updater error (silent):", err.message);
    // The updater's error channel is shared by checks, downloads and explicit
    // installation. Only the last of those owns shutdown state. Check errors
    // identify themselves in the second argument; download errors arrive while
    // the download promise is live. Neither may cancel an unrelated install
    // approval or poison a healthy installer attempt.
    const isCheckError =
      typeof context === "string" &&
      context.startsWith("Cannot check for updates:");
    const installAttempt = newestOwnedUpdaterInstallAttempt(autoUpdater);
    if (
      isCheckError ||
      updaterDownloadInFlight ||
      !installAttempt ||
      installAttempt.launchOwner === "folia"
    ) {
      return;
    }
    // An install we had already started has failed asynchronously, so the app
    // is staying up: take back the standing permission to shut down, or the
    // next window close discards unsaved documents without asking. (F22)
    //
    // Cancel every update-origin state: the public hand-off listener, a fresh
    // approval, its commit/timer, and any confirmed continuation waiting for
    // its setImmediate turn. Ordinary close intents remain owned by the
    // ordinary shutdown state machine.
    cancelUpdateOriginShutdownState("updater-error", autoUpdater);
    // A failed explicit install is quarantined for one check phase, then
    // retired completely. BaseUpdater 6.8.9 queues no lifecycle pair when
    // install() errors or returns false, so there is no valid late boundary
    // for a retired attempt to claim from a retry.
  });
}

// Return current app version to renderer
ipcMain.handle("get-version", () => app.getVersion());

// SEC-09 — RESOLVED BY REMOVAL.
//
// This used to be a "translate-text" IPC handler that sent the reader's
// document, in pieces, to Google's unauthenticated translate_a/single
// endpoint. It was originally moved into the main process so the renderer's
// CSP could be connect-src 'none'; the feature has since been removed
// outright, so no process in this app now makes an outbound request carrying
// document content.

// Return app root path so renderer can construct paths like README.md
ipcMain.handle("get-app-path", () => app.getAppPath());

// Return README.md path — works in dev (next to main.js) and packaged (extraResources)
function getReadmePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "README.md");
  }
  return path.join(__dirname, "..", "README.md");
}
ipcMain.handle("get-readme-path", getReadmePath);

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
    // Without a `.catch()` this rejects unhandled if the feed cannot be
    // reached - a network failure, or a repository with no published release
    // yet, which returns 404. Route it through the same status channel the
    // renderer already handles instead of leaving an unhandled rejection.
    Promise.resolve(updater.checkForUpdates()).catch((err) => {
      log("Manual update check failed:", err.message);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("update-status", {
          status: "error",
          error: err.message,
        });
      }
    });
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
  if (!updater || updaterDownloadInFlight || updateInstallStarted) return;
  updaterDownloadInFlight = true;
  try {
    Promise.resolve(updater.downloadUpdate())
      .catch((err) => {
        // update-downloaded is emitted before executeDownload's final cache
        // bookkeeping. A rejected tail means the download as a whole did not
        // complete, even if that earlier event supplied a path.
        downloadedUpdatePath = null;
        log("Download update failed:", err.message);
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send("update-status", {
            status: "error",
            error: err.message,
          });
        }
      })
      .finally(() => {
        updaterDownloadInFlight = false;
      });
  } catch (err) {
    updaterDownloadInFlight = false;
    downloadedUpdatePath = null;
    log("Download update failed:", err.message);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "error",
        error: err.message,
      });
    }
  }
});

// Installing an update is a shutdown: it quits the app, either through
// electron-updater's own restart or through the portable installer this
// spawns. It therefore asks the same question, through the same state machine,
// as the window's close button - and NOTHING here runs before that question is
// answered.
//
// The preflight happens BEFORE the request rather than inside the
// continuation, so a press that could not have installed anything (no updater
// module, or a portable build with nothing downloaded) does not put a
// discard-your-changes dialog on screen for an action that was never going to
// happen. (F22)
ipcMain.on("install-update", (event) => {
  if (!isApprovalSender(event)) return;
  log("Install update requested");
  const updater = getAutoUpdater();
  if (!updater) return;
  if (updaterDownloadInFlight) {
    log("Install update requested before the download promise settled");
    return;
  }
  // Nothing has been downloaded, so nothing can be installed - by either build
  // type. Asking the reader to discard their unsaved work for an action that
  // would then no-op is the worst of both outcomes, and an installer branch
  // that no-ops while reporting success is what leaves a shutdown authorized
  // in an app that is still running.
  if (!downloadedUpdatePath) {
    log("Install update requested with nothing downloaded");
    return;
  }
  if (updateInstallStarted) {
    log("Install update requested while an install attempt is already active");
    return;
  }
  requestShutdown("update-install", () => performUpdateInstall(updater), {
    forceFresh: true,
  });
});

function isExistingRegularFile(filePath) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0") ||
    !path.isAbsolute(filePath)
  ) {
    return false;
  }
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function windowsInstalledUpdateLaunchPlan(updater) {
  if (
    !updater ||
    typeof updater.quitAndInstallCalled !== "boolean"
  ) {
    throw new Error("the updater duplicate-install latch is unavailable");
  }
  const helper = updater && updater.downloadedUpdateHelper;
  const downloadedFileInfo = helper && helper.downloadedFileInfo;
  const installerPath = updater && updater.installerPath;
  if (!helper || !downloadedFileInfo) {
    throw new Error("verified updater download metadata is unavailable");
  }
  if (!isExistingRegularFile(installerPath)) {
    throw new Error("the downloaded installer is missing");
  }

  const args = ["--updated"];
  if (updater.autoRunAppAfterInstall) args.push("--force-run");
  if (typeof updater.installDirectory === "string" && updater.installDirectory) {
    // NSIS requires /D= to be the final, unquoted command-line token.
    // Node's normal argv quoting cannot express that invariant for every path,
    // and elevate.exe 1.3.0 forwards the raw command-line remainder. Do not
    // leave a latent malformed install-directory path in the verified route.
    throw new Error(
      "custom NSIS install directories are unsupported by the verified launcher",
    );
  }
  const packagePath = helper.packageFile;
  if (packagePath != null) {
    throw new Error(
      "NSIS web-installer packages are unsupported by the verified launcher",
    );
  }

  return {
    installerPath,
    args,
    requiresElevation: downloadedFileInfo.isAdminRightsRequired === true,
    elevatePath: path.join(process.resourcesPath, "elevate.exe"),
  };
}

function reportInstalledUpdateLaunchFailure(attempt, why, retrySafe) {
  if (
    !attempt ||
    attempt.retired ||
    attempt.committed ||
    activeUpdaterInstallAttempt !== attempt
  ) {
    return false;
  }

  attempt.failed = true;
  attempt.failureWhy = why;
  attempt.retrySafe = retrySafe;
  attempt.launchPhase = retrySafe ? "failed" : "ambiguous";
  recordUpdaterInstallAttemptState(attempt);
  if (pendingUpdaterInstallCommit === attempt) {
    pendingUpdaterInstallCommit = null;
  }

  if (retrySafe) {
    finishFailedUpdaterInstallAttempt(attempt);
  } else if (
    attempt.updater &&
    typeof attempt.updater.quitAndInstallCalled === "boolean"
  ) {
    // The launcher may have created the installer before it disappeared. Keep
    // electron-updater's ordinary-quit hook from starting a duplicate.
    attempt.updater.quitAndInstallCalled = true;
    attempt.ownsUpdaterQuitLatch = true;
  }

  log(
    `Installed update launch failed (${retrySafe ? "retry-safe" : "ambiguous"}):`,
    why,
  );
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("update-status", {
      status: "error",
      error: retrySafe
        ? "The update installer could not be started. You can try again."
        : "Folia could not verify whether the update installer started. Restart Folia before trying again.",
    });
  }
  if (!retrySafe) {
    // A child/helper that disappeared ambiguously may have created NSIS. Keep
    // the attempt, duplicate-install latch and committed document freeze. It
    // is unsafe both to retry and to make the document editable while an
    // installer may still execute its process-kill phase.
    revokeShutdownAuthorization();
    return;
  }
  cancelUpdateOriginShutdownState(why);
  releaseShutdownFreeze();
}

function commitWindowsInstalledUpdateLaunch(attempt, child, method) {
  if (
    !attempt ||
    attempt.retired ||
    activeUpdaterInstallAttempt !== attempt ||
    attempt.committed
  ) {
    return;
  }

  attempt.committed = true;
  attempt.positiveLaunchObserved = true;
  attempt.launchMethod = method;
  attempt.retrySafe = false;
  attempt.launchPid =
    child && Number.isSafeInteger(child.pid) ? child.pid : 0;
  attempt.launchPhase = "quitting-after-installer-start";
  recordUpdaterInstallAttemptState(attempt);
  if (pendingUpdaterInstallCommit === attempt) {
    pendingUpdaterInstallCommit = null;
  }
  if (
    attempt.updater &&
    typeof attempt.updater.quitAndInstallCalled === "boolean"
  ) {
    // Keep electron-updater's duplicate-install latch aligned with Folia's
    // launcher. Windows autoInstallOnAppQuit is disabled globally, but this
    // also prevents any direct updater call from starting beside the installer.
    attempt.updater.quitAndInstallCalled = true;
    attempt.ownsUpdaterQuitLatch = true;
  }

  log(
    `Installed update: ${method} launcher positively started; quitting under committed approval`,
  );
  // Phase two already committed and froze the exact document revision before
  // any process launch. Re-authorize only this quit and execute it immediately:
  // asking again after NSIS starts is too late because --updated can kill
  // Folia before another renderer round-trip completes.
  grantShutdownAuthorization();
  quitApprovedUpdateApp();
}

function spawnElevatedWindowsInstaller(attempt, plan) {
  if (
    !attempt ||
    attempt.retired ||
    activeUpdaterInstallAttempt !== attempt
  ) {
    return false;
  }
  if (!isExistingRegularFile(plan.elevatePath)) {
    reportInstalledUpdateLaunchFailure(
      attempt,
      "the packaged elevation helper is missing",
      true,
    );
    return false;
  }

  attempt.launchMethod = "elevated";
  attempt.launchPhase = "starting-elevation-helper";
  recordUpdaterInstallAttemptState(attempt);
  let child;
  try {
    const { spawn } = require("child_process");
    child = spawn(
      plan.elevatePath,
      [plan.installerPath, ...plan.args],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch (err) {
    reportInstalledUpdateLaunchFailure(
      attempt,
      "elevation helper threw before start: " + err.message,
      true,
    );
    return false;
  }

  let settled = false;
  let helperStarted = false;
  child.once("spawn", () => {
    if (
      attempt.retired ||
      attempt.committed ||
      activeUpdaterInstallAttempt !== attempt
    ) {
      return;
    }
    helperStarted = true;
    attempt.launchPhase = "awaiting-elevation-result";
    recordUpdaterInstallAttemptState(attempt);
  });
  child.once("error", (err) => {
    if (settled) return;
    settled = true;
    reportInstalledUpdateLaunchFailure(
      attempt,
      "elevation helper could not start: " + err.message,
      !helperStarted,
    );
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    // electron-builder's bundled elevate.exe returns zero only after
    // ShellExecuteEx supplied a real process handle. A normal nonzero exit is
    // therefore proof that UAC/launch failed before the installer existed.
    if (signal === null && code === 0) {
      commitWindowsInstalledUpdateLaunch(attempt, child, "elevated");
      return;
    }
    reportInstalledUpdateLaunchFailure(
      attempt,
      signal
        ? `elevation helper ended by signal ${signal}`
        : `elevation helper exited with code ${code}`,
      signal === null && Number.isInteger(code),
    );
  });
  // Detached is not enough: a referenced ChildProcess object still contributes
  // its handle to Electron's event loop. Listeners are installed first so the
  // UAC result remains observable while the app is alive; unref then ensures a
  // prompt or helper that never exits cannot hold an already-approved teardown
  // open. The attempt/latches remain in JS state and still block duplicates if
  // the application continues running.
  child.unref();
  attempt.launchChildUnrefed = true;
  recordUpdaterInstallAttemptState(attempt);
  return true;
}

function performWindowsInstalledUpdate(updater) {
  if (updater.quitAndInstallCalled === true) {
    log("Installed update: updater already has an install attempt");
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "updater-install-already-started",
    );
    return false;
  }

  let plan;
  try {
    plan = windowsInstalledUpdateLaunchPlan(updater);
  } catch (err) {
    log("Installed update preflight failed:", err.message);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "error",
        error: "The downloaded update is incomplete. Download it again.",
      });
    }
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "installed-update-preflight-failed",
    );
    return false;
  }

  const attempt = watchUpdaterInstallCommit(updater);
  attempt.launchOwner = "folia";
  attempt.launchPhase = "starting-installer";
  attempt.finalApprovalCommitted = true;
  recordUpdaterInstallAttemptState(attempt);
  updateInstallStarted = true;
  revokeShutdownAuthorization();

  // Own the updater's duplicate-install latch from the moment any child launch
  // is attempted. Windows autoInstallOnAppQuit is disabled, and this also
  // blocks any direct updater call beside Folia's launcher. Retry-safe failure
  // releases it; an ambiguous outcome deliberately keeps it raised.
  if (typeof updater.quitAndInstallCalled === "boolean") {
    updater.quitAndInstallCalled = true;
    attempt.ownsUpdaterQuitLatch = true;
  }

  if (plan.requiresElevation) {
    if (!spawnElevatedWindowsInstaller(attempt, plan)) return false;
    return SHUTDOWN_CONTINUATION_PENDING;
  }

  attempt.launchMethod = "direct";
  recordUpdaterInstallAttemptState(attempt);
  let child;
  try {
    const { spawn } = require("child_process");
    child = spawn(plan.installerPath, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    reportInstalledUpdateLaunchFailure(
      attempt,
      "installer launch threw before start: " + err.message,
      true,
    );
    return false;
  }

  let settled = false;
  let installerStarted = false;
  child.once("spawn", () => {
    if (settled) return;
    settled = true;
    installerStarted = true;
    commitWindowsInstalledUpdateLaunch(attempt, child, "direct");
  });
  child.once("error", (err) => {
    if (settled) return;
    settled = true;
    if (err && (err.code === "EACCES" || err.code === "UNKNOWN")) {
      spawnElevatedWindowsInstaller(attempt, plan);
      return;
    }
    reportInstalledUpdateLaunchFailure(
      attempt,
      "installer could not start: " + err.message,
      !installerStarted,
    );
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    reportInstalledUpdateLaunchFailure(
      attempt,
      signal
        ? `installer launch ended by signal ${signal} before start`
        : `installer launch closed with code ${code} before start`,
      false,
    );
  });
  // Keep direct and elevated detached launchers consistent. Positive hand-off
  // still requires the spawn event; unref only removes the child handle as a
  // reason for the parent process to stay alive.
  child.unref();
  attempt.launchChildUnrefed = true;
  recordUpdaterInstallAttemptState(attempt);
  return SHUTDOWN_CONTINUATION_PENDING;
}

/**
 * @returns {boolean|symbol} true only when shutdown committed synchronously;
 *   false when nothing started; SHUTDOWN_CONTINUATION_PENDING when the final
 *   approval is committed and an asynchronous Windows hand-off owns its freeze.
 *
 * Windows NSIS uses Folia's own launcher and treats only a child `spawn` event,
 * or elevate.exe's successful ShellExecuteEx result, as positive hand-off
 * proof. Other BaseUpdater platforms retain their public lifecycle boundary.
 */
function performUpdateInstall(updater) {
  // Re-entry. Either the installer is already going (in which case the process
  // is about to end and the answer does not matter) or the first attempt
  // failed (in which case the honest answer is "nothing started").
  if (updateInstallStarted) return false;
  if (updaterDownloadInFlight) {
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "download-still-finalizing",
    );
    return false;
  }
  // Re-checked rather than assumed from the preflight: this runs later, on a
  // different turn of the loop, and a continuation that cannot install must
  // say so rather than report a shutdown it did not start.
  if (!downloadedUpdatePath) {
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "download-missing-before-install",
    );
    return false;
  }

  if (isPortable) {
    // Portable .exe: quitAndInstall() doesn't work.
    // Launch one batch process, but keep it behind a release file until the
    // reader has been asked again about the document AS IT STANDS AT THE
    // COMMIT - and do not quit until the batch has reported that it actually
    // started the installer.
    let batchDir = null;
    // Hoisted out of the try so the outer catch can stop a heartbeat that was
    // already running when something later in the setup threw. A beat left
    // running against a directory that is about to be removed is exactly the
    // residue this hand-off is not allowed to leave.
    let stopLeaseHeartbeat = null;
    try {
      // SEC-20: this used to be a fixed path in the shared temp directory,
      // written and then executed - a local process that wins that race gets
      // code execution as the user. mkdtempSync gives an unpredictable 0700
      // directory, and "wx" refuses to write if anything is already there.
      batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "folia-update-"));
      const batchPath = path.join(batchDir, "update.bat");
      const releasePath = path.join(batchDir, "release");
      const cancelPath = path.join(batchDir, "cancel");
      const ackPath = path.join(batchDir, "ack");
      const failedPath = path.join(batchDir, "failed");
      const leasePath = path.join(batchDir, "lease");
      // THE ACKNOWLEDGEMENT IS A SECRET, NOT A FILENAME. A marker file that
      // only had to EXIST could be planted by any local process that guessed
      // the private directory, and "the installer started" is the one claim
      // this path quits on. The batch echoes this value back and nothing else
      // is accepted, so a forged or stale marker fails closed into the timeout
      // below rather than into an app that has quit for nothing.
      const handoffToken = crypto.randomBytes(32).toString("hex");
      // THE BATCH MUST NOT OUTLIVE THE APP THAT PARKED IT. It waits for a
      // release file that only this process writes, so if Electron dies first -
      // crash, Task Manager, a signal - nothing will ever write one and the
      // loop spins in the user's temp directory until the machine is rebooted,
      // holding its private directory open with it.
      //
      // TWO INDEPENDENT LIVENESS TESTS, and deliberately NOT a timer: a reader
      // who leaves the confirmation dialog on screen over lunch must still get
      // their update, so nothing here may expire a decision that is simply
      // taking a long time.
      //
      // The LEASE is the authoritative one. `for %%F ... %%~zF` is cmd's own
      // report of the file's size, so the lease's contents are never parsed as
      // script and a planted file cannot forge anything except a number. The
      // app appends one byte per beat while - and only while - the hand-off is
      // parked, so a size that stops changing is a parent that stopped beating.
      // That is what a reused PID cannot fake.
      //
      // The PID test is kept as the FAST one: a parent that is simply gone is
      // detected on the next poll instead of after the staleness window.
      // `tasklist /FI "PID eq <pid>"` with `/NH` prints the process line when
      // it exists and a "no tasks" banner when it does not; `find` on the PID
      // string is what turns that into an errorlevel. The PID is a number this
      // process just read from itself, so it cannot carry a quote or a
      // metacharacter, and it is quoted anyway.
      const parentPid = String(process.pid);
      const batch =
        [
          "@echo off",
          // Seeded to a value no size can equal, so the first poll always
          // registers as a beat rather than as a miss.
          'set "FOLIA_HB=x"',
          'set "FOLIA_LAST=x"',
          "set FOLIA_MISS=0",
          ":wait_for_release",
          `if exist "${cancelPath}" goto cleanup`,
          `if exist "${releasePath}" goto install`,
          `for %%F in ("${leasePath}") do set "FOLIA_HB=%%~zF"`,
          'if not "%FOLIA_HB%"=="%FOLIA_LAST%" goto beat',
          "set /a FOLIA_MISS=FOLIA_MISS+1",
          `if %FOLIA_MISS% GEQ ${PORTABLE_LEASE_STALE_POLLS} goto orphaned`,
          "goto parent_check",
          ":beat",
          'set "FOLIA_LAST=%FOLIA_HB%"',
          "set FOLIA_MISS=0",
          ":parent_check",
          // The app that would release this gate is gone, so the gate will
          // never open. Clean up rather than spin forever.
          `tasklist /FI "PID eq ${parentPid}" /NH 2>nul | find "${parentPid}" >nul`,
          "if errorlevel 1 goto orphaned",
          "ping 127.0.0.1 -n 2 > nul",
          "goto wait_for_release",
          ":orphaned",
          `> "${failedPath}" echo ${handoffToken}`,
          "goto cleanup",
          ":install",
          // A DOWNLOAD THAT IS NO LONGER THERE IS NOT AN INSTALL. The file was
          // fetched at some earlier point in the session and can have been
          // swept by a temp cleaner, an antivirus quarantine or the reader,
          // and `start` on a missing path launches nothing while the app has
          // already quit for it.
          `if not exist "${downloadedUpdatePath}" goto failed`,
          // `ver` is the cheapest way to put ERRORLEVEL back to 0: `start`
          // sets it only on failure, so testing it without a known-good
          // starting value reads whatever the previous command left behind.
          "ver > nul",
          `start "" "${downloadedUpdatePath}"`,
          "if errorlevel 1 goto failed",
          `> "${ackPath}" echo ${handoffToken}`,
          "goto settle",
          ":failed",
          `> "${failedPath}" echo ${handoffToken}`,
          ":settle",
          // Hold the private directory open long enough for the app to read
          // the outcome above before the self-delete below removes it. The app
          // gives up well inside this window, so the only cost of the wait is
          // how long one temp directory survives.
          "ping 127.0.0.1 -n 16 > nul",
          ":cleanup",
          // Step out of the directory before removing it, then use the
          // self-deleting-batch idiom: `(goto) 2>nul` makes cmd release its
          // handle on the script so the whole private directory can go, rather
          // than leaving one behind on every portable update.
          'cd /d "%TEMP%"',
          `(goto) 2>nul & rmdir /s /q "${batchDir}"`,
        ].join("\r\n") + "\r\n";
      fs.writeFileSync(batchPath, batch, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // THE FIRST BEAT, BEFORE THE CHILD EXISTS. The batch reads this file on
      // its very first poll, and a lease that only appeared after the script
      // started would read as an already-stale parent for the polls in
      // between. "wx" for the same reason as the script itself: anything
      // already sitting at this path in the private directory is not ours.
      fs.writeFileSync(leasePath, ".", { flag: "wx", mode: 0o600 });
      // spawn with an argument array rather than exec with an interpolated
      // command string: the path never passes through a shell that could
      // re-parse a quote in it. detached + windowsHide replaces `start /min`,
      // so the updater outlives the app.quit() below without a console window.
      const { spawn } = require("child_process");
      // Latch BEFORE spawn(): until its event arrives this is an in-flight
      // attempt, and a second Install request must not launch another child.
      const owner = shutdownOwnerWindow();
      const ownerId = owner ? owner.webContents.id : 0;
      const rendererGeneration = approvalRendererGeneration;
      const handoffDir = batchDir;
      updateInstallStarted = true;
      revokeShutdownAuthorization();
      const child = spawn("cmd.exe", ["/c", batchPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      let released = false;
      let committed = false;
      let cancelled = false;
      let childTerminal = false;
      let childClosed = false;
      let retryLatchReleased = false;
      let handoffTimer = null;
      let leaseTimer = null;

      const stopAwaitingHandoff = () => {
        if (handoffTimer === null) return;
        clearTimeout(handoffTimer);
        handoffTimer = null;
      };

      // THE LEASE IS EXTENDED FOR EXACTLY AS LONG AS THE HAND-OFF IS PARKED.
      // Stopped on every terminal path below, so the timer cannot outlive the
      // attempt that owns it, and a file that has gone with its directory
      // cannot be recreated by a beat that arrives afterwards.
      //
      // unref'd: a pending beat must never be the reason the process stays
      // alive - this whole path exists to let the app quit.
      stopLeaseHeartbeat = () => {
        if (leaseTimer === null) return;
        clearInterval(leaseTimer);
        leaseTimer = null;
      };
      leaseTimer = setInterval(() => {
        try {
          fs.appendFileSync(leasePath, ".");
        } catch (err) {
          // The lease cannot be extended - the directory is gone, or the disk
          // refused. Stop rather than retry: the batch will see a size that
          // has stopped moving and stand itself down, which is the same
          // outcome, reached without a beat that throws every second.
          stopLeaseHeartbeat();
          log("Portable update lease could not be extended:", err.message);
        }
      }, PORTABLE_LEASE_BEAT_MS);
      if (typeof leaseTimer.unref === "function") leaseTimer.unref();

      // The private directory is production residue, not a test artefact: only
      // the batch itself ever removed it, so every path on which the batch
      // never ran - a spawn that failed, a write that threw, a hand-off the
      // reader declined - left the script and its gates in the user's temp
      // directory for good. Removed after the child has CLOSED, so cmd is not
      // still holding the file it is executing.
      const removeBatchDir = () => {
        try {
          fs.rmSync(handoffDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        } catch (err) {
          log("Portable update batch directory could not be removed:", err.message);
        }
      };

      const childHasTerminalStatus = () =>
        childTerminal ||
        typeof child.exitCode === "number" ||
        typeof child.signalCode === "string";

      const cancelPortableHandoff = (message, options = {}) => {
        if (committed || cancelled) return;
        cancelled = true;
        stopAwaitingHandoff();
        stopLeaseHeartbeat();
        revokeShutdownAuthorization();
        // What a cancel can still achieve depends on whether the gate was
        // already open: before release it stops the installer outright, after
        // it only stops the QUIT, because an installer that has already been
        // started cannot be recalled. Saying which is the difference between a
        // diagnosable log line and a puzzle.
        log(
          message,
          released ? "(gate already released)" : "(gate not released)",
        );
        try {
          fs.writeFileSync(cancelPath, "", { flag: "wx" });
        } catch (err) {
          log("Portable update gate could not be cancelled:", err.message);
        }
        // CLEARING THE LATCH IS PERMISSION TO LAUNCH ANOTHER INSTALLER, and it
        // is only safe when this attempt provably started none. Before the
        // gate is released the batch cannot have reached its `start`, and the
        // batch's own failure marker is a statement that it did not - both are
        // sound retry boundaries. So is a child that DIED before the gate was
        // released: a `cmd.exe` that is gone without ever seeing a release file
        // cannot have run `start`, and holding the latch for it would block
        // every later attempt for the rest of the session over an installer
        // that provably never existed. An expired deadline is none of those: it
        // cannot tell "the installer never started" from "the installer started
        // and the acknowledgement is slow", and clearing on that guess is how a
        // second press launches a second installer over the first.
        const startedNothing =
          !released || options.installerDidNotStart === true;
        const releaseRetryLatch = () => {
          if (!startedNothing || retryLatchReleased) return;
          retryLatchReleased = true;
          updateInstallStarted = false;
        };
        const releaseAfterClose = () => {
          releaseRetryLatch();
          removeBatchDir();
        };
        // A typed terminal status proves that this child can no longer consume
        // a gate, so a pre-release attempt is retryable immediately. It does
        // NOT prove that stdio/process handles have closed: only `close` is the
        // filesystem-cleanup boundary. Keeping those facts separate also
        // prevents attempt A's delayed close from clearing attempt B's latch.
        if (childHasTerminalStatus()) releaseRetryLatch();
        if (childClosed) releaseAfterClose();
        else child.once("close", releaseAfterClose);
        try {
          child.kill();
        } catch (err) {
          log("Portable update batch could not be stopped:", err.message);
        }
        cancelUpdateOriginShutdownState(message);
      };

      // THE CHILD CAN DIE ON ITS OWN, AND SILENCE IS NOT AN OUTCOME. `cmd.exe`
      // can be killed from Task Manager, swept by security software, or simply
      // fail - and until this existed the hand-off had no state for it: a
      // release written afterwards would open a gate nobody was waiting at, the
      // acknowledgement would never come, and the deadline would then keep the
      // in-flight latch standing for the rest of the session over an installer
      // that could not possibly have started. Recording the close is what lets
      // both of those be decided correctly.
      child.once("exit", () => {
        childTerminal = true;
        if (committed || cancelled) return;
        cancelPortableHandoff(
          "Portable update: the batch process exited before the hand-off",
          { installerDidNotStart: !released },
        );
      });
      child.once("close", () => {
        childTerminal = true;
        childClosed = true;
        if (committed || cancelled) return;
        // Nothing has been released yet, so nothing can have been installed:
        // this attempt is over, it started nothing, and a later press must be
        // allowed to try again.
        cancelPortableHandoff(
          "Portable update: the batch process ended before the hand-off",
          { installerDidNotStart: !released },
        );
      });

      const commitPortableHandoff = () => {
        if (committed || cancelled) return;
        committed = true;
        stopAwaitingHandoff();
        stopLeaseHeartbeat();
        child.unref();
        // THE INSTALLER IS RUNNING AND CANNOT BE RECALLED, so what is left is
        // not whether to install but whether it is safe to QUIT - and the only
        // thing that can settle that is an answer taken against the document as
        // it stands RIGHT NOW.
        //
        // This used to quit outright whenever the document generation was
        // unchanged and no other question was open. That test cannot see the
        // case it most needs to: the approval which opened the gate was given
        // before a process was spawned, before a batch polled for the gate,
        // before `start` launched an installer and before an acknowledgement
        // was written back - and every one of those is time in which the reader
        // can type. The same document with new text in it is the SAME
        // generation, so an edit made in that window was discarded silently by
        // a quit that believed it had consent. Comparing generations answers
        // "is this the same document?"; the question here is "is this the same
        // document STATE?", and only the renderer can answer that.
        //
        // A CLEAN DOCUMENT IS ASKED NOTHING. The renderer replies "nothing
        // unsaved" and the request settles silently, so an ordinary portable
        // update still shows no dialog at all; only an edit made inside this
        // window raises one. This is exactly what the installed updater's
        // public commit boundary does (watchUpdaterInstallCommit), so both
        // update paths now confirm at the same point for the same reason.
        //
        // THE CONTINUATION IS QUIT AND NOTHING ELSE. The hand-off is over:
        // re-entering performUpdateInstall would spawn a second batch, and
        // re-releasing an open gate is meaningless. `committed` is latched
        // above before any of this runs, so no later timer, event or answer can
        // restart the hand-off, write another gate, or kill the child.
        revokeShutdownAuthorization();
        log("Portable update: installer hand-off acknowledged, confirming shutdown");
        requestShutdown("update-install", quitApprovedUpdateApp, {
          forceFresh: true,
          // A "no" here cannot un-launch the installer, so it does not cancel
          // anything - it declines the QUIT. The app stays up with its
          // documents intact and unauthorized, and stays LATCHED: an installer
          // that is already running must not be joined by a second one, which
          // is the same boundary a post-release timeout takes. The child is
          // already unreferenced and its batch removes its own private
          // directory, so there is nothing left here to clean up either.
          onDeclined: (why) =>
            log(
              "Portable update: the shutdown after an acknowledged hand-off was not approved",
              why,
              "- the installer is already running",
            ),
        });
      };

      // Absent, unreadable, empty or half-written all reduce to the same
      // thing: not this hand-off's marker. Only an exact token match is an
      // answer, so a torn read costs one more poll rather than a wrong verdict.
      const markerIsOurs = (file) => {
        try {
          return fs.readFileSync(file, "utf8").trim() === handoffToken;
        } catch (err) {
          return false;
        }
      };

      // A SPAWNED cmd.exe IS NOT A STARTED INSTALLER. The 'spawn' event proves
      // only that the interpreter began; the reader's documents are discarded
      // by the quit that used to follow it, while the batch could still find
      // nothing to run. So the quit waits for the batch's own statement that it
      // launched the installer, and the absence of that statement - a missing
      // download, a refused `start`, a batch that died, a machine too busy to
      // answer inside the deadline - keeps the app running with its documents
      // intact. Fail-closed here means "do not quit", which is the only
      // direction that cannot lose work.
      const awaitPortableHandoff = (deadline) => {
        handoffTimer = setTimeout(() => {
          handoffTimer = null;
          if (committed || cancelled) return;
          if (markerIsOurs(ackPath)) {
            commitPortableHandoff();
            return;
          }
          if (markerIsOurs(failedPath)) {
            cancelPortableHandoff(
              "Portable update: the batch reported that it could not start the installer",
              { installerDidNotStart: true },
            );
            return;
          }
          if (Date.now() >= deadline) {
            cancelPortableHandoff(
              "Portable update: the installer hand-off was never acknowledged",
            );
            return;
          }
          awaitPortableHandoff(deadline);
        }, PORTABLE_HANDOFF_POLL_MS);
      };

      const releasePortableGate = () => {
        if (committed || cancelled) return false;
        // A GATE OPENED AT A CHILD THAT IS ALREADY GONE OPENS NOTHING. The
        // release file would sit unread, the acknowledgement would never come,
        // and the deadline would then hold the retry latch for the rest of the
        // session over an installer that provably never started.
        if (childHasTerminalStatus()) {
          cancelPortableHandoff(
            "Portable update: the batch process ended before the gate could be released",
            { installerDidNotStart: true },
          );
          return false;
        }
        // NOTHING MAY HAVE ANSWERED BEFORE THE QUESTION WAS ASKED. The batch
        // cannot write either marker until this gate exists, so a marker that
        // is already there was put there by something else - and believing it
        // would quit the app for an installer that has not started. The
        // directory is minted fresh, so this cannot be our own residue.
        if (fs.existsSync(ackPath) || fs.existsSync(failedPath)) {
          cancelPortableHandoff(
            "Portable update: a hand-off marker existed before the gate was released",
          );
          return false;
        }
        try {
          fs.writeFileSync(releasePath, "", { flag: "wx" });
        } catch (err) {
          cancelPortableHandoff(
            "Portable update gate could not be released: " + err.message,
          );
          return false;
        }
        released = true;
        awaitPortableHandoff(Date.now() + PORTABLE_HANDOFF_TIMEOUT_MS);
        // Released is not committed: the acknowledgement above is what quits.
        return false;
      };

      child.once("spawn", () => {
        if (committed || cancelled) return;
        if (
          !isSameShutdownDocumentSession(
            ownerId,
            rendererGeneration,
            "update-install",
          )
        ) {
          cancelPortableHandoff(
            "Portable update: document state changed before hand-off",
          );
          return;
        }
        // THE APPROVAL IS RE-TAKEN AT THE ACTUAL COMMIT, exactly as the
        // installed updater's public commit boundary does. The first approval
        // covered pressing Install; spawning a process is asynchronous, and an
        // edit made in the gap belongs to a document nobody has been asked
        // about. Revalidating the document GENERATION is not enough - the same
        // document with new text in it is the same generation - so this asks
        // the question again rather than inferring the answer.
        //
        // The gate is released only from the approved continuation, so a
        // decline still stops an installer that has not started. `onDeclined`
        // is what carries a "no" back to a parked child; without it the child,
        // its private directory and the in-flight latch would outlive the
        // answer.
        requestShutdown("update-install", releasePortableGate, {
          forceFresh: true,
          onDeclined: (why) =>
            cancelPortableHandoff(
              `Portable update: the commit approval was not given (${why})`,
            ),
        });
      });
      child.on("error", (err) => {
        // Guarded like every other terminal path: an error emitted after the
        // hand-off has already committed would otherwise take back an
        // authorization the quit is standing on, and turn a shutdown that is
        // already under way back into a question.
        if (committed || cancelled) return;
        // An 'error' event is not a child-lifecycle boundary. In particular,
        // clearing the install latch or deleting the script here can race a
        // still-live cmd.exe and a later 'close'. Use the ordinary cancellation
        // path so cleanup waits for close; after release, keep the latch set
        // because the error cannot prove that `start` did not launch.
        cancelPortableHandoff(
          "Portable update installer process error: " + err.message,
        );
      });
      // spawn() returning a ChildProcess is not a successful hand-off. Revoke
      // the speculative authorization now; only an acknowledged installer
      // hand-off can restore it and proceed to quit.
      return false;
    } catch (err) {
      // The installer never started, so the app is still here and the
      // authorization must not survive. Neither must the private directory:
      // mkdtemp may already have created it before the write or the spawn
      // threw, and nothing else will ever come back for it.
      log("Portable update batch failed:", err.message);
      if (stopLeaseHeartbeat) stopLeaseHeartbeat();
      updateInstallStarted = false;
      revokeShutdownAuthorization();
      if (batchDir) {
        try {
          fs.rmSync(batchDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log(
            "Portable update batch directory could not be removed:",
            cleanupError.message,
          );
        }
      }
      replayAbsorbedUserShutdownAfterUpdaterCancel(
        "portable-handoff-setup-failed",
      );
      return false;
    }
  }

  if (process.platform === "win32") {
    return performWindowsInstalledUpdate(updater);
  }

  // electron-updater's MacUpdater does not use BaseUpdater's synchronous
  // success-only before-quit-for-update/app.quit pair. Its native Squirrel
  // hand-off may instead wait on a later update-downloaded event, which carries
  // no explicit-install attempt identity. This state machine cannot safely
  // bind that delayed quit to the approval that entered quitAndInstall(), so
  // the shipped DMG path fails closed rather than pretending it installed.
  // Ordinary approved quits still retain autoInstallOnAppQuit behavior.
  if (process.platform === "darwin") {
    const error =
      "Explicit update installation is unavailable on macOS because the updater quit cannot be attributed safely.";
    log(
      "Installed update:",
      error,
    );
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("update-status", {
        status: "error",
        error,
      });
    }
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "unsupported-macos-explicit-install",
    );
    return false;
  }

  // BaseUpdater.install() silently returns false when this protected latch is
  // already set; quitAndInstall() erases that result by returning void.
  if (updater.quitAndInstallCalled === true) {
    log("Installed update: updater already has an install attempt");
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "updater-install-already-started",
    );
    return false;
  }

  const attempt = watchUpdaterInstallCommit(updater);
  updateInstallStarted = true;
  // The approval covered entering the updater, not an unobservable void call.
  // The public commit event below must re-authorize the actual lifecycle.
  revokeShutdownAuthorization();
  try {
    updater.quitAndInstall(false, true);
  } catch (err) {
    log("quitAndInstall threw:", err.message);
    finishFailedUpdaterInstallAttempt(attempt);
    replayAbsorbedUserShutdownAfterUpdaterCancel("quit-and-install-threw");
    return false;
  }
  attempt.ownsUpdaterQuitLatch = updater.quitAndInstallCalled === true;

  // A synchronous error can run our error handler while quitAndInstall is on
  // the stack. Preserve its one-check-phase quarantine even though BaseUpdater
  // has reset the latch by the time this call returns.
  if (attempt.failed) return false;

  // BaseUpdater resets its latch before returning from a synchronous refusal
  // and queues no lifecycle callback, so the attempt can retire immediately.
  if (updater.quitAndInstallCalled === false) {
    finishFailedUpdaterInstallAttempt(attempt);
    replayAbsorbedUserShutdownAfterUpdaterCancel(
      "quit-and-install-refused",
    );
    return false;
  }

  // Usually false: BaseUpdater emits on its preserved setImmediate turn. The
  // caller withdraws authorization for that gap; the process-lifetime boundary
  // listener starts the mandatory fresh approval for the final app.quit().
  return attempt.committed;
}

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

// SEC-30 download policy, split out from the will-download listener above so
// the RULE can be asserted directly. Proving the listener end-to-end needs a
// real responding server - will-download only fires once a response has begun,
// so an unresolvable probe host (which is what the suites deliberately use)
// never reaches it. A pure predicate is testable without that, and a listener
// that merely exists is not evidence its policy is right.
//
// blob: only. The app's sole legitimate download through a webContents session
// is Tabulator's table export, measured at will-download as blob:file:///<uuid>,
// text/csv, no network. (electron-updater downloads over its own HTTP stack, not
// a session, so it never reaches the listener.) Untrusted content cannot reach
// this with a blob: URL: the only place document-authored script runs is an
// @@@html frame, which is sandboxed without allow-downloads and has an opaque
// origin, so a blob it mints is neither downloadable by it nor loadable by the
// top frame. Anything else, notably http(s):, is a fetch of remote bytes onto
// the user's disk initiated by document content.
function isDownloadAllowed(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

module.exports = {
  isDownloadAllowed,
  // TEST SEAM, and the same convention as custom-tabs.js's `__getScroller`:
  // assert on the real state machine, never on a re-implementation of it.
  //
  // It exists because the authorization above is one-way WITHIN a session by
  // design - a granted shutdown normally ends with the process gone, so
  // production never needs to take it back - while a live Electron suite has
  // to drive a dozen shutdown scenarios inside ONE process, with the
  // continuations stubbed so the window survives to be tested again. `reset`
  // is what puts the machine back to its start state between scenarios;
  // `state` is what lets a test assert that a stale answer left the question
  // OPEN rather than trusting an absence.
  //
  // Withheld from a packaged build. `reset()` clears the authorization latch,
  // which is a control rather than an accessor, and a shipped app has no use
  // for it: the suites all run from source.
  ...(app.isPackaged
    ? {}
    : {
        __shutdown: {
          documentAdmissionIsCurrent: ref => !!admittedDocumentReference(ref),
          documentOwnerGuards: (owner, filePath) => ({
            identity: !!normaliseDocumentIdentity(owner, filePath),
            closing: !!closingDocumentOwnerFromEnvelope({
              sender: mainWindow.webContents,
              senderFrame: mainWindow.webContents.mainFrame,
            }, { ...owner, filePath }),
            retirementFloor: retiredAdmissionTabFloor,
          }),
          seedDocumentSessionLayout: async (layout) => {
            const known = new Map(documentSessionManifest.approvedEntries.map(entry =>
              [entry.id, entry]));
            const entries = layout.entries.map(item => {
              const entry = known.get(item.id);
              if (!entry || !validSessionAnchor(item.anchor)) {
                throw new Error("Invalid approved session fixture");
              }
              return { ...entry, scrollPosition: item.scrollPosition,
                anchor: copySessionAnchor(item.anchor) };
            });
            documentSessionManifest = { ...documentSessionManifest,
              entries, activeEntryId: layout.activeEntryId };
            protectedSessionEntries.clear();
            unavailableSessionEntries.clear();
            entries.forEach(entry => protectedSessionEntries.add(entry.id));
            return persistLiveDocumentSession();
          },
          documentSessionState: () => ({
            admissions: documentAdmissions.size,
            fences: admittedOwnerTabs.size,
            protectedEntries: Array.from(protectedSessionEntries),
            owners: Array.from(knownDocumentOwners.values()).map(owner => ({ ...owner })),
            history: documentSessionManifest?.approvedEntries.map(entry => ({ ...entry })),
            entries: documentSessionManifest?.entries.map(entry => ({ ...entry })),
            activeEntryId: documentSessionManifest?.activeEntryId,
          }),
          state: () =>
            Object.freeze({
              pendingId: pendingShutdown ? pendingShutdown.id : 0,
              pendingReason: pendingShutdown ? pendingShutdown.reason : null,
              pendingAbsorbedUserIntentId: pendingShutdown
                ? pendingShutdown.absorbedUserIntentId || 0
                : 0,
              pendingAbsorbedUserArrivalOrder: pendingShutdown
                ? pendingShutdown.absorbedUserArrivalOrder || 0
                : 0,
              pendingDispatchedTo: pendingShutdown
                ? pendingShutdown.dispatchedTo
                : 0,
              pendingDispatchToken: pendingShutdown
                ? pendingShutdown.dispatchToken
                : 0,
              queuedReason: queuedShutdown ? queuedShutdown.reason : null,
              absorbedUserIntentId: absorbedUserShutdown
                ? absorbedUserShutdown.absorbedId
                : 0,
              absorbedUserReason: absorbedUserShutdown
                ? absorbedUserShutdown.reason
                : null,
              absorbedUserArrivalOrder: absorbedUserShutdown
                ? absorbedUserShutdown.arrivalOrder
                : 0,
              absorbedUserReplayScheduled: !!(
                absorbedUserShutdown &&
                absorbedUserShutdown.replayScheduled
              ),
              authorized: hasCurrentShutdownAuthorization(),
              authorizationGeneration: shutdownAuthorizationGeneration,
              renderer: approvalRendererState,
              rendererGeneration: approvalRendererGeneration,
              rendererPageSession: approvalRendererPageSession,
              rendererUnusableReason: lastRendererUnusableReason,
              probeOwnerGeneration: overlayProbeOwner
                ? overlayProbeOwner.generation
                : 0,
              probeOwnerToken: overlayProbeOwner
                ? overlayProbeOwner.token
                : 0,
              lastDispatchToken: lastShutdownDispatchToken,
              redispatchCount: shutdownRedispatchCount,
              staleResponseCount: staleShutdownResponseCount,
              invalidRevisionCount: invalidShutdownRevisionCount,
              invalidRevisionWhy: lastInvalidShutdownRevisionWhy,
              staleReadyCount: staleShutdownReadyCount,
              staleProbeCompletionCount:
                staleOverlayProbeCompletionCount,
              sendFailureCount: shutdownSendFailureCount,
              commitPendingId: pendingShutdownCommit
                ? pendingShutdownCommit.id
                : 0,
              commitSequence: pendingShutdownCommit
                ? pendingShutdownCommit.sequence
                : 0,
              commitAuthorisedSeq: pendingShutdownCommit
                ? pendingShutdownCommit.authorisedSeq
                : 0,
              commitRefusedCount: shutdownCommitRefusedCount,
              commitTimeoutCount: shutdownCommitTimeoutCount,
              staleCommitTimeoutCount: staleShutdownCommitTimeoutCount,
              commitRefusedWhy: lastShutdownCommitRefusedWhy,
              staleCommitCount: staleShutdownCommitCount,
              supersededContinuationCount,
              staleShutdownDialogCompletionCount,
              navigationInvalidatedShutdownCount,
              rendererInvalidatedContinuationCount,
              continuationEpoch: shutdownContinuationEpoch,
              updaterContinuationEpoch,
              updaterInvalidatedContinuationCount,
              updaterShutdownCancelWhy: lastUpdaterShutdownCancelWhy,
              shutdownPendingContinuationCount,
              updaterFreezeRetained: foliaUpdaterAttemptRetainsFreeze(),
              reloadRequestEpoch,
              reloadRequestSession: lastReloadRequestSession,
              backgroundReloadWatcherBaselineSkipCount,
              staleReloadReplyDropCount,
              staleReloadReplyDropsByReason: Object.fromEntries(
                staleReloadReplyDropsByReason,
              ),
              saveQueueEnqueuedCount,
              saveQueueStartedCount,
              saveQueueCompletedCount,
              saveQueuePendingCount,
              saveQueueOverlapCount,
              saveQueueMaxActiveForSinglePath,
              saveLifecycleEpoch,
              saveQueueActivePathCount: activeSaveRunsByKey.size,
              saveVerificationCount: activeSaveVerifications.size,
              saveCorrelationCount: activeSaveCorrelations.size,
              saveCorrelationLimit: MAX_ACTIVE_SAVE_CORRELATIONS,
              saveOutcomeDeliveryCount:
                pendingSaveOutcomeDeliveries.size,
              knownDocumentOwnerCount: knownDocumentOwners.size,
              knownDocumentOwnerLimit: MAX_KNOWN_DOCUMENT_OWNERS,
              supersededDocumentOwnerCount: supersededDocumentOwners.size,
              documentOwnerFenceDropCount,
              documentOwnerSealRegistrationRefusalCount,
              documentOwnerSealNoticeShown,
              documentOwnerSealAdmissionRefusalCount,
              documentOwnerSealAdmissionRefusalLogged,
              documentOwnerTablePinnedRefusalCount,
              documentOwnerRegistrationTablePinnedRefusalLogged,
              documentOwnerAdoptionTablePinnedRefusalLogged,
              saveAuthorityLatchReason,
              deletionTombstoneCount: documentDeletionTombstones.size,
              deletionTombstoneLimit: null,
              deletionEvidenceOverflowed:
                deletionOverflowEvidence.size > 0,
              deletionOverflowEvidenceCount:
                deletionOverflowEvidence.size,
              deletionOverflowEvidenceLimit: null,
              deletionEvidenceLimit: MAX_DELETION_EVIDENCE,
              deletionEvidenceFootprint: deletionEvidenceFootprint(),
              deletionEvidenceCapacityLatched,
              deletionEvidenceCapacityLatchWhy,
              deletionEvidenceCapacityDropCount,
              deletionEvidenceCapacityRefusalCount,
              deletionEvidenceCapacityDownloadNoticeShown,
              deletionEvidenceOverflowCount,
              deletionEvidenceRevision,
              deletionRetirementUnacknowledgedCount,
              deletionRetirementEventDriftCount,
              deletionDeliveryCount: deletionDeliveries.size,
              deletionDeliveryLimit: MAX_DELETION_DELIVERIES,
              deletionDeliverySummaries: deletionDeliverySummaries(),
              newlineAlignmentCallCount,
              newlineAlignmentRestoredSpanCount,
              newlineAlignmentBytesScanned,
              newlineAlignmentWitnessCount:
                newlineAlignmentWitnesses.length,
              newlineAlignmentWitnessLimit:
                MAX_NEWLINE_ALIGNMENT_WITNESSES,
              newlineAlignmentWitnesses:
                newlineAlignmentWitnessSummaries(),
              settleWhy: lastShutdownSettleWhy,
              lastRequestId: shutdownRequestSeq,
              updateInstallStarted,
              updaterDownloadInFlight,
              updaterAutoInstallOnAppQuit:
                autoUpdater && typeof autoUpdater.autoInstallOnAppQuit === "boolean"
                  ? autoUpdater.autoInstallOnAppQuit
                  : null,
              updaterPendingCommitAttemptId: pendingUpdaterInstallCommit
                ? pendingUpdaterInstallCommit.id
                : 0,
              updaterInstallAttemptId: activeUpdaterInstallAttempt
                ? activeUpdaterInstallAttempt.id
                : 0,
              updaterInstallAttemptPoisoned: !!(
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.poisoned
              ),
              updaterInstallAttemptExpiryAttemptId:
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.poisonExpiry !== null
                  ? activeUpdaterInstallAttempt.id
                  : 0,
              updaterInstallAttemptLaunchOwner: activeUpdaterInstallAttempt
                ? activeUpdaterInstallAttempt.launchOwner
                : null,
              updaterInstallAttemptLaunchMethod: activeUpdaterInstallAttempt
                ? activeUpdaterInstallAttempt.launchMethod
                : null,
              updaterInstallAttemptLaunchPhase: activeUpdaterInstallAttempt
                ? activeUpdaterInstallAttempt.launchPhase
                : null,
              updaterInstallAttemptPositiveLaunchObserved: !!(
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.positiveLaunchObserved
              ),
              updaterInstallAttemptRetrySafe: !!(
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.retrySafe
              ),
              updaterInstallAttemptLaunchChildUnrefed: !!(
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.launchChildUnrefed
              ),
              updaterInstallAttemptFinalApprovalCommitted: !!(
                activeUpdaterInstallAttempt &&
                activeUpdaterInstallAttempt.finalApprovalCommitted
              ),
              updaterInstallAttemptFailureWhy: activeUpdaterInstallAttempt
                ? activeUpdaterInstallAttempt.failureWhy
                : null,
              updaterLastInstallAttempt: lastUpdaterInstallAttemptState,
              updaterLiveAttemptIds: Array.from(updaterInstallAttempts.keys()),
              updaterQuitBoundaryAttemptId: updaterQuitBoundary
                ? updaterQuitBoundary.attempt.id
                : 0,
            }),
          timing: {
            enable: enableShutdownTiming,
            disable: disableShutdownTiming,
            state: shutdownTimingState,
          },
          // Arm by path/pathKey, trigger the actual renderer Save, await the
          // returned token's hold, then release it after authenticated
          // quarantine. Await the Save result and its ACK before reset. An
          // unclaimed expiry/reset needs a new ready page and retire(token):
          // reset alone cannot prove an old Save IPC is no longer in flight.
          saveGate: Object.freeze({
            arm: liveSaveGate.arm,
            waitForHold: liveSaveGate.waitForHold,
            release: liveSaveGate.release,
            cancel: liveSaveGate.cancel,
            retire: liveSaveGate.retire,
            state: liveSaveGate.state,
          }),
          reset: () => {
            liveSaveGate.dispose();
            // Declined, not merely dropped - the seam has to leave the machine
            // in a state production could actually be in, and a parked
            // asynchronous hand-off that is never told its intent died would
            // carry a child process and a temp directory into the next
            // scenario. Same invariant as attachShutdownGuards.
            declineIntent(pendingShutdown, "reset");
            declineIntent(queuedShutdown, "reset");
            cancelAbsorbedUserShutdown("reset");
            pendingShutdown = null;
            queuedShutdown = null;
            // A commit attempt and any freeze it took belong to the scenario
            // being torn down, not to the next one. Abandoned rather than
            // re-raised: a refusal that asked again would leave the NEXT
            // scenario starting with a question outstanding.
            finishShutdownCommit(pendingShutdownCommit, false, "reset", {
              reraise: false,
            });
            pendingShutdownCommit = null;
            revokeShutdownAuthorization();
            for (const attempt of Array.from(updaterInstallAttempts.values())) {
              finishFailedUpdaterInstallAttempt(attempt);
            }
            if (updaterQuitBoundary) {
              if (updaterQuitBoundary.expiry !== null) {
                clearImmediate(updaterQuitBoundary.expiry);
              }
              updaterQuitBoundary = null;
            }
            updateInstallStarted = false;
            releaseShutdownFreeze({ force: true });
            lastUpdaterInstallAttemptState = null;
            invalidateDeferredUpdaterContinuations("reset");
            // The diagnostics go too. An assertion that names the route a
            // question took would otherwise be able to read the PREVIOUS
            // scenario's route and pass on it.
            lastShutdownSettleWhy = null;
            lastRendererUnusableReason = null;
            lastShutdownDispatchToken = 0;
            shutdownRedispatchCount = 0;
            staleShutdownResponseCount = 0;
            invalidShutdownRevisionCount = 0;
            lastInvalidShutdownRevisionWhy = null;
            staleShutdownReadyCount = 0;
            staleOverlayProbeCompletionCount = 0;
            shutdownSendFailureCount = 0;
            shutdownCommitRefusedCount = 0;
            shutdownCommitTimeoutCount = 0;
            staleShutdownCommitTimeoutCount = 0;
            lastShutdownCommitRefusedWhy = null;
            staleShutdownCommitCount = 0;
            supersededContinuationCount = 0;
            staleShutdownDialogCompletionCount = 0;
            navigationInvalidatedShutdownCount = 0;
            rendererInvalidatedContinuationCount = 0;
            updaterInvalidatedContinuationCount = 0;
            lastUpdaterShutdownCancelWhy = null;
            shutdownPendingContinuationCount = 0;
            staleReloadReplyDropCount = 0;
            staleReloadReplyDropsByReason.clear();
            lastReloadRequestSession = null;
            backgroundReloadWatcherBaselineSkipCount = 0;
            for (const record of deletionDeliveries.values()) {
              clearDeletionDeliveryAttempt(record);
            }
            deletionDeliveries.clear();
            documentDeletionTombstones.clear();
            pathOnlyDeletionEvidence.clear();
            pathOnlyDeletionByPathKey.clear();
            ownerDocumentBaselines.clear();
            quarantinedDocumentOwners.clear();
            supersededDocumentOwners.clear();
            notifiedExternalVersionsByOwner.clear();
            pendingDiskAdoptions.clear();
            committedDiskAdoptions.clear();
            deletionTombstonesBySpelling.clear();
            deletionTombstonesByPathKey.clear();
            deletionTombstonesById.clear();
            deletedDocuments.clear();
            for (const overflowKey of Array.from(
              deletionOverflowEvidence.keys(),
            )) {
              releaseDeletionOverflowEvidence(overflowKey);
            }
            deletionOverflowDocumentMarkerRefs.clear();
            deletionOverflowPathMarkerRefs.clear();
            nextDeletionDeliveryId = 0;
            deletionEvidenceOverflowCount = 0;
            deletionEvidenceRevision = 0;
            deletionRetirementUnacknowledgedCount = 0;
            deletionRetirementEventDriftCount = 0;
            newlineAlignmentCallCount = 0;
            newlineAlignmentRestoredSpanCount = 0;
            newlineAlignmentBytesScanned = 0;
            newlineAlignmentWitnesses.length = 0;
            // BEFORE THE LATCH COMES OFF, AND BEFORE THE REFUSALS ARE
            // RE-REGISTERED BELOW. Every save accepted in the scenario being
            // torn down is now expired: `saveQueues` may still hold one parked
            // behind a prior write, `knownDocumentOwners` is deliberately
            // retained so its identity checks would still pass, and the latch
            // that was refusing it is about to be cleared. The epoch is what
            // makes those saves fail closed instead of waking up and writing
            // into the next scenario. Silently clearing the latch with queued
            // work outstanding is exactly the hole this closes.
            saveLifecycleEpoch =
              saveLifecycleEpoch === Number.MAX_SAFE_INTEGER
                ? 1
                : saveLifecycleEpoch + 1;
            // Refused gated saves settle on the next microtask. Keep only
            // their exact correlations until the renderer ACKs the failure.
            const refused = liveSaveGate.correlatedRefusals();
            const deliveries = new Set(refused.map((entry) => entry.delivery));
            for (const record of pendingSaveOutcomeDeliveries.values()) {
              if (!deliveries.has(record)) {
                clearSaveOutcomeDeliveryAttempt(record);
              }
            }
            pendingSaveOutcomeDeliveries.clear();
            activeSaveCorrelations.clear();
            latestAcceptedSaveSequenceByDocument.clear();
            for (const entry of refused) {
              activeSaveCorrelations.set(entry.key, entry.scope);
              if (entry.delivery) {
                pendingSaveOutcomeDeliveries.set(entry.key, entry.delivery);
              }
            }
            // LAST, AND ONLY HERE. In production the latch is a one-way door;
            // the test seam may re-open it, but not before the saves it was
            // refusing and the evidence it was protecting have both been torn
            // down above. Clearing it any earlier would let a scenario start
            // saving again with the previous scenario's state still standing.
            deletionEvidenceCapacityLatched = false;
            deletionEvidenceCapacityLatchWhy = null;
            deletionEvidenceCapacityDropCount = 0;
            deletionEvidenceCapacityRefusalCount = 0;
            deletionEvidenceCapacityDownloadNoticeShown = false;
            documentOwnerFenceDropCount = 0;
            documentOwnerSealRegistrationRefusalCount = 0;
            documentOwnerSealNoticeShown = false;
            // One-shot logs are per session, so a scenario that spent them
            // would otherwise silence the next one.
            documentOwnerSealAdmissionRefusalCount = 0;
            documentOwnerSealAdmissionRefusalLogged = false;
            documentOwnerTablePinnedRefusalCount = 0;
            documentOwnerRegistrationTablePinnedRefusalLogged = false;
            documentOwnerAdoptionTablePinnedRefusalLogged = false;
            lastDocumentOwnerRefusalWasTablePinned = false;
            saveAuthorityLatchReason = "deletion-evidence-capacity";
            saveAuthorityLatchWriteError =
              DELETION_EVIDENCE_CAPACITY_WRITE_ERROR;
            saveAuthorityLatchSaveError =
              DELETION_EVIDENCE_CAPACITY_SAVE_ERROR;
            resetShutdownTiming();
          },
        },
      }),
};
