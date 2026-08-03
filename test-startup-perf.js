// Regression harness for PERF-01: heavy optional modules must not be required
// during startup.
//
// PERF-AUDIT.md measured require("html-to-docx") at 370.1ms and
// require("electron-updater") at 174.7ms — 544.8ms of main-thread work before
// the window can even be created, paid by every launch regardless of whether
// the session ever exports a DOCX or checks for an update.
//
// This harness IS the Electron main script. It requires ./main.js, so main.js
// runs in this very process and shares this process's module registry. That
// makes require.cache a direct, non-vacuous observation of what startup loaded
// — not a grep over source text, which would pass the moment someone moved the
// require behind an alias.
//
// Both modules must remain genuinely loadable, otherwise "not in the cache"
// would be trivially satisfiable by deleting the dependency. Section 2 loads
// each one explicitly and checks the shape the call sites actually depend on.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const results = [];
let failed = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  -> " + detail}`);
}

function cachedModulePaths(needle) {
  return Object.keys(require.cache).filter((p) =>
    p.split(path.sep).includes(needle),
  );
}

function finish() {
  results.push(`=== ${results.length - failed}/${results.length} passed ===`);
  const text = results.join("\n") + "\n";
  // Electron drops buffered stdout on app.exit() when redirected, so the file
  // is the authoritative record; the console copy is a convenience only.
  fs.writeFileSync(path.join(__dirname, "test-startup-perf-results.txt"), text);
  console.log(text);
  app.exit(failed === 0 ? 0 : 1);
}

const watchdog = setTimeout(() => {
  check("harness completed within 120s", false, "watchdog fired");
  finish();
}, 120000);

// Loading main.js starts the real application in this process.
require("./main.js");

app.whenReady().then(async () => {
  // Let the ready handlers, window creation and any deferred startup work run.
  // checkForUpdatesOnStartup() is on app.on("ready"); if it ever regressed to
  // loading electron-updater eagerly in dev, it would have done so by now.
  await new Promise((r) => setTimeout(r, 3000));

  // --- 1. Neither heavy module is loaded by startup ------------------------
  const docxCached = cachedModulePaths("html-to-docx");
  check(
    "html-to-docx is not required during startup",
    docxCached.length === 0,
    JSON.stringify(docxCached.slice(0, 3)),
  );

  const updaterCached = cachedModulePaths("electron-updater");
  check(
    "electron-updater is not required during startup",
    updaterCached.length === 0,
    JSON.stringify(updaterCached.slice(0, 3)),
  );

  // Sanity: the probe can see modules that ARE loaded, so a zero above means
  // "absent", not "the probe is broken".
  check(
    "the require.cache probe detects a module that is loaded",
    cachedModulePaths("marked").length > 0 ||
      Object.keys(require.cache).some((p) => p.endsWith("main.js")),
    String(Object.keys(require.cache).length),
  );

  // --- 2. Both modules are still loadable and still the right shape --------
  // Guards against "optimising" startup by breaking the feature outright.
  let docxOk = false;
  let docxDetail = "";
  try {
    const HTMLtoDOCX = require("html-to-docx");
    // Call sites do: await HTMLtoDOCX(html, null, options)
    docxOk = typeof HTMLtoDOCX === "function";
    docxDetail = typeof HTMLtoDOCX;
  } catch (e) {
    docxDetail = e.message;
  }
  check("html-to-docx still loads and is callable", docxOk, docxDetail);

  let updaterOk = false;
  let updaterDetail = "";
  try {
    const { autoUpdater } = require("electron-updater");
    // Call sites use .on/.checkForUpdates/.downloadUpdate/.quitAndInstall
    updaterOk =
      autoUpdater &&
      typeof autoUpdater.on === "function" &&
      typeof autoUpdater.checkForUpdates === "function" &&
      typeof autoUpdater.downloadUpdate === "function" &&
      typeof autoUpdater.quitAndInstall === "function";
    updaterDetail = autoUpdater ? Object.keys(autoUpdater).length + " keys" : "null";
  } catch (e) {
    updaterDetail = e.message;
  }
  check(
    "electron-updater still loads and exposes the used API",
    updaterOk,
    updaterDetail,
  );

  // --- 3. Requiring them really is expensive ------------------------------
  // Not an optimisation check — it is the evidence that section 1 is worth
  // asserting at all. Both are in the cache now, so this measures a warm
  // re-require and is deliberately NOT compared against a threshold; the
  // number is recorded for the reader.
  const t0 = Date.now();
  require("html-to-docx");
  require("electron-updater");
  results.push(`INFO  warm re-require of both modules: ${Date.now() - t0}ms`);

  clearTimeout(watchdog);
  finish();
});
