// Regression harness for PERF-01: heavy optional modules must not be required
// during startup.
//
// PERF-AUDIT.md measured require("html-to-docx") at 370.1ms and
// require("electron-updater") at 174.7ms — 544.8ms of main-thread work before
// the window could even be created, paid by every launch regardless of whether
// the session ever exported a DOCX or checked for an update. html-to-docx has
// since been removed outright along with Word export, which retires the larger
// of the two costs by deletion rather than by deferral; electron-updater is now
// the only production dependency, and the lazy-load property still has to hold
// for it.
//
// This harness IS the Electron main script. It requires ./main.js, so main.js
// runs in this very process and shares this process's module registry. That
// makes require.cache a direct, non-vacuous observation of what startup loaded
// — not a grep over source text, which would pass the moment someone moved the
// require behind an alias.
//
// The module must remain genuinely loadable, otherwise "not in the cache" would
// be trivially satisfiable by deleting the dependency — which is exactly what
// happened to html-to-docx, and is why that pair of assertions was removed
// together rather than leaving a load check standing over a deleted package.
// Section 2 loads it explicitly and checks the shape the call sites depend on.

const { app } = require("electron");
const { ipcMain } = require("electron");
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

  // --- 1. The heavy module is not loaded by startup ------------------------
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

  // --- 2. The module is still loadable and still the right shape -----------
  // Guards against "optimising" startup by breaking the feature outright.
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

  // --- 3. Requiring it really is expensive --------------------------------
  // Not an optimisation check — it is the evidence that section 1 is worth
  // asserting at all. It is in the cache now, so this measures a warm
  // re-require and is deliberately NOT compared against a threshold; the
  // number is recorded for the reader.
  const t0 = Date.now();
  require("electron-updater");
  results.push(`INFO  warm re-require of electron-updater: ${Date.now() - t0}ms`);

  // --- 4. The update check must not carry a persistent identifier ----------
  // electron-updater mints a random UUID, persists it to userData/.updaterId
  // and sends it as `x-user-staging-id` on every check. It is for staged
  // rollouts, which this project does not use, and it makes every check from
  // one machine linkable to every other one. main.js blanks it in
  // configureAutoUpdater().
  //
  // The oracle is the WIRE, not the source and not the configured object: a
  // real HTTP server stands in for the feed and reports the headers as
  // received. A source regex would pass the moment the assignment moved, and
  // reading `requestHeaders` back would only confirm the value was stored,
  // not that it reached the request. R169 proves it fails when reverted.
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/yaml" });
    res.end("version: 99.0.0\npath: x.exe\nsha512: aaa\nreleaseDate: '2026-01-01'\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // Drives the real product path: this handler calls getAutoUpdater(), which
  // is what runs configureAutoUpdater() exactly once.
  ipcMain.emit("check-for-updates");

  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = null;
  autoUpdater.forceDevUpdateConfig = true; // dev builds have no app-update.yml
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  let checkDetail = "";
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    checkDetail = e.message.slice(0, 120);
  }
  server.close();

  // Vacuity guard: an empty header set proves nothing if no request was made.
  check(
    "the update check really reached the stand-in feed",
    seen.length > 0,
    `${seen.length} requests; ${checkDetail}`,
  );

  const stagingIds = seen.map((h) => h["x-user-staging-id"]);
  check(
    "no update request carries a staging-id value",
    seen.length > 0 && stagingIds.every((v) => !v),
    JSON.stringify(stagingIds),
  );

  // The identifier is the payload; a bare empty header name is inert. Recorded
  // rather than asserted absent, because `computeFinalHeaders` can only
  // override the value and not remove the key.
  results.push(
    `INFO  update request headers: user-agent=${seen[0] ? seen[0]["user-agent"] : "n/a"}, ` +
      `x-user-staging-id present=${seen[0] ? "x-user-staging-id" in seen[0] : "n/a"}`,
  );

  clearTimeout(watchdog);
  finish();
});
