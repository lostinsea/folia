// Give every Electron test suite its own userData directory, wiped on entry.
//
// WHY THIS EXISTS
// ---------------
// The suites used to run against the developer's REAL profile
// (%APPDATA%/Folia). That profile is where custom-tabs.js persists the open-tab
// session (saveTabs -> localStorage "openTabs"), so the harness both INHERITED
// and CONTAMINATED whatever the developer had open. Measured consequences:
//
//   * test-startup-perf.js is the one suite that requires ../src/main.js, so it
//     is the one suite where main.js's ipcMain "confirm-large-render" handler is
//     registered. main.js opens a real window; the renderer restores the saved
//     session; a restored tab holding an EXPENSIVE document reaches
//     confirmLargeTab() -> sendSync -> askAboutLargeDocument() ->
//     dialog.showMessageBoxSync(). That dialog is modal IN THE MAIN PROCESS, so
//     nothing in a test can dismiss it - the process that would run the stub is
//     the process that is blocked. The suite stalls until a human clicks.
//     A/B measured: seeded profile = hang with zero assertions; empty profile =
//     7/7 in 8s. Same command, same tree.
//
//   * One killed run planted that landmine for every LATER run: a tab is
//     persisted by saveTabs() the moment it is created, long before the
//     scenario's cleanup closes it.
//
//   * The leak ran the other way too - a packaged smoke-test path of mine was
//     found sitting in the developer's real session.
//
// This is the fourth instance of the same disease in this project (window
// bounds, splitter ratio, an mdv-probe temp dir resolving a relative <img>).
// Each previous one was fixed by seeding the specific state the suite needed.
// This fixes the CLASS: a suite can no longer read, or write, anything the
// developer's app owns.
//
// WHY IT WIPES RATHER THAN JUST REDIRECTS
// ---------------------------------------
// Isolation alone would still let a crashed run poison its own next run, which
// is exactly the failure above with a smaller blast radius. Starting from an
// empty directory makes every suite's session state a function of that suite,
// not of its history.
//
// ORDERING IS LOAD-BEARING, SO IT FAILS LOUD
// ------------------------------------------
// app.setPath("userData", ...) only relocates the profile if it runs before the
// app is ready. Called too late it is silently ignored - an absence assertion
// that fails open, the exact class of defect this project keeps finding. So
// this module THROWS if it is required after app.isReady(), and throws again if
// the path did not actually move.

const fs = require("fs");
const os = require("os");
const path = require("path");

let electron = null;
try {
  electron = require("electron");
} catch {
  electron = null;
}

// Under plain `node` (test-packaging.js, test-userdata-migration.js) requiring
// "electron" yields the path to the binary, not the module. Those suites own no
// profile, so there is nothing to isolate.
const app = electron && typeof electron === "object" ? electron.app : null;

function suiteName() {
  const script = process.argv.find(
    (a, i) => i > 0 && typeof a === "string" && a.toLowerCase().endsWith(".js"),
  );
  return script ? path.basename(script, path.extname(script)) : "unknown-suite";
}

let USER_DATA_DIR = null;
let REAL_USER_DATA = null;
let POST_WIPE_ENTRIES = null;

if (app) {
  if (app.isReady()) {
    throw new Error(
      "test-userdata-isolation must be required BEFORE the Electron app is " +
        "ready - app.setPath('userData') is ignored afterwards, which would " +
        "silently run the suite against the developer's real profile.",
    );
  }

  USER_DATA_DIR = path.join(os.tmpdir(), "folia-test-userdata", suiteName());

  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  // Observed AFTER the wipe, so it is the profile the suite actually boots
  // from. With the wipe removed this is non-zero on any machine that has run
  // the suite before, which is what makes the "started clean" assertion bite
  // rather than restate its own implementation.
  POST_WIPE_ENTRIES = fs.readdirSync(USER_DATA_DIR).length;

  REAL_USER_DATA = app.getPath("userData");
  app.setPath("userData", USER_DATA_DIR);

  const now = app.getPath("userData");
  if (path.resolve(now) !== path.resolve(USER_DATA_DIR)) {
    throw new Error(
      `test-userdata-isolation failed to relocate userData: wanted ` +
        `${USER_DATA_DIR}, got ${now}`,
    );
  }
  if (path.resolve(now) === path.resolve(REAL_USER_DATA)) {
    throw new Error(
      "test-userdata-isolation resolved to the real profile - the suite would " +
        "read and write the developer's session.",
    );
  }

  // Read by the packaging suite's coverage assertion and available to any suite
  // that wants to assert on its own isolation.
  global.__foliaTestUserData = USER_DATA_DIR;
}

module.exports = {
  USER_DATA_DIR,
  REAL_USER_DATA,
  POST_WIPE_ENTRIES,
  suiteName,
};
