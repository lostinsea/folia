// Captures the frozen theme baseline used by test/test-theme.js.
//
// THIS IS OPT-IN AND MUST NEVER BE CALLED FROM A TEST RUN.
//   npx electron scripts/capture-theme-golden.js
//
// The reason is the whole value of the artifact. The baseline records what the
// two default schemes ACTUALLY LOOKED LIKE before the theme system existed. If
// the suite regenerated it, then changing a colour would rewrite the file the
// suite reads and the assertion could never fail - the revert would come back
// VACUOUS and the guard would be decorative. So the golden is committed literal
// data, produced here, by hand, deliberately.
//
// It records the FULL VISUAL TUPLE, not just colour. That is not caution, it is
// a measured requirement: `entity` is distinguished from `operator` only by its
// background and cursor, and `namespace` from `tag` only by opacity. A
// colour-only baseline lets both regress green. The code-box properties
// (padding, margin, radius, tab-size, white-space...) are recorded for the same
// reason - they come from the vendored Solarized stylesheet and BOTH modes
// depend on them, so dropping that <link> without porting them would silently
// degrade dark mode too.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("../test/test-userdata-isolation");
require("../src/main.js");

const {
  GOLDEN_PATH,
  waitForWindow,
  captureBothModes,
} = require("../test/theme-census");

// PROVENANCE IS MEASURED, NOT DECLARED. This used to read
// `process.env.FOLIA_GOLDEN_COMMIT || "unknown"`, which had two failures at
// once: the documented command above sets no such variable, so it wrote
// "unknown" and produced a golden the suite rejects; and because the value was
// self-declared, a golden regenerated from the CHANGED tree could be stamped
// with the baseline commit and every revert would silently go VACUOUS.
//
// Deriving it here does not fully close that (someone can still check out the
// baseline, apply changes and capture), which is why the suite ALSO gates on an
// intrinsic property of the data itself - see the "baked colour" check in
// test/test-theme.js. Refusing a dirty tree is what makes the recorded commit
// actually describe the code that was measured.
function provenance() {
  const git = (args) =>
    execFileSync("git", args, { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim();
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--", "src", "libs"]);
  if (dirty) {
    console.error(
      "REFUSING TO CAPTURE: src/ or libs/ has uncommitted changes, so the\n" +
        "recorded commit would not describe what was measured. Stash them first.\n\n" +
        dirty,
    );
    app.exit(2);
    return null;
  }
  return head;
}

app.whenReady().then(async () => {
  try {
    const head = provenance();
    if (!head) return;
    const win = await waitForWindow(BrowserWindow);
    const captured = await captureBothModes(win);

    const golden = {
      // Recorded so a future reader can tell whether the baseline predates the
      // theme refactor, which is the only state in which it is authoritative.
      capturedFromCommit: head,
      note:
        "Frozen pre-theme-system appearance. Regenerate ONLY by hand via " +
        "scripts/capture-theme-golden.js, never from a test run.",
      ...captured,
    };

    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n");
    console.log(
      "wrote " +
        path.relative(process.cwd(), GOLDEN_PATH) +
        " from " +
        head.slice(0, 12) +
        " (" +
        Object.keys(captured.light.tokens).length +
        " light token keys, " +
        Object.keys(captured.dark.tokens).length +
        " dark)",
    );
    app.exit(0);
  } catch (e) {
    console.error("capture failed:", e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
