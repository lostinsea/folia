// Self-check for test-visual-utils' probe: proves it actually detects each
// failure mode it claims to. A visual assertion that cannot fail is worse than
// no assertion, because it reads as coverage. Run with: npm run test:visual
// Isolate this suite's userData profile before the app is ready. See
// test-userdata-isolation.js.
require("./test-userdata-isolation");

const { app, BrowserWindow } = require("electron");
const {
  inspectVisual,
  captureScreenshot,
  mergeDisabledFeatures,
  DISABLED_FEATURES,
} = require("./test-visual-utils");

const PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<html><body style="margin:0">
<div id="wrap" style="width:300px;overflow-x:hidden;position:relative">
  <div class="t" id="ok"      style="width:200px;height:100px;background:#3a3"></div>
  <div class="t" id="hidden"  style="width:200px;height:100px;background:#3a3;display:none"></div>
  <div class="t" id="flat"    style="width:200px;height:0px;background:#3a3"></div>
  <div class="t" id="wide"    style="width:600px;height:100px;background:#3a3"></div>
  <div class="t" id="covered" style="width:200px;height:100px;background:#3a3"></div>
  <div id="lid" style="position:absolute;left:0;top:200px;width:400px;height:400px;background:#a33"></div>
</div>
<div class="t" id="offedge" style="position:fixed;left:-190px;top:10px;width:200px;height:100px;background:#3a3"></div>
<div class="t" id="haschild" style="position:relative;width:200px;height:100px;background:#3a3">
  <span style="position:absolute;inset:0">content of its own</span>
</div>
</body></html>`);

const results = [];
const lines = [];
const expect = (name, ok, detail) => {
  results.push(ok);
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`;
  lines.push(line);
  console.log(line);
};

app.whenReady().then(async () => {
  const done = (code) => {
    const passed = results.filter(Boolean).length;
    const line = `=== ${passed}/${results.length} passed ===`;
    console.log(line);
    require("fs").writeFileSync("test-visual-results.txt", lines.concat(line).join("\n") + "\n");
    app.exit(code !== undefined ? code : passed === results.length ? 0 : 1);
  };
  const watchdog = setTimeout(() => {
    console.log("TIMED OUT");
    lines.push("TIMED OUT");
    done(1);
  }, 90000);

  try {
    // ---------------------------------------------------------------------
    // The occlusion switches. Every geometric suite depends on these: with
    // native occlusion active, a covered window's page stops laying out and
    // its own width readings freeze, which surfaces as geometric assertions
    // failing while naming the CONTENT rather than the window.
    //
    // Two distinct things are proven here, because they fail differently.
    // ---------------------------------------------------------------------

    // 1. The switch is actually live in this process. Asserted against the
    //    command line Chromium was given, not against the source text - a
    //    source grep would still pass if the block were moved after app ready,
    //    where appendSwitch is silently too late to matter.
    const live = app.commandLine.getSwitchValue("disable-features");
    expect(
      "native window occlusion is disabled for this process",
      DISABLED_FEATURES.every((f) => live.split(",").includes(f)),
      `disable-features=${JSON.stringify(live)}`,
    );
    expect(
      "occluded-window and renderer backgrounding are disabled too",
      app.commandLine.hasSwitch("disable-backgrounding-occluded-windows") &&
        app.commandLine.hasSwitch("disable-renderer-backgrounding"),
      `occluded=${app.commandLine.hasSwitch("disable-backgrounding-occluded-windows")} ` +
        `renderer=${app.commandLine.hasSwitch("disable-renderer-backgrounding")}`,
    );

    // 2. The merge preserves a pre-existing value. appendSwitch REPLACES the
    //    value of `disable-features` rather than adding to it (measured:
    //    appendSwitch(X) then appendSwitch(Y) leaves Y alone), so a naive
    //    second caller anywhere in the process would silently switch occlusion
    //    back on. This is the half that has no visible symptom until a
    //    geometric suite starts failing for no stated reason.
    expect(
      "merging preserves features an earlier caller already disabled",
      mergeDisabledFeatures("SomeOtherFeature", ["CalculateNativeWinOcclusion"]) ===
        "SomeOtherFeature,CalculateNativeWinOcclusion",
      mergeDisabledFeatures("SomeOtherFeature", ["CalculateNativeWinOcclusion"]),
    );
    expect(
      "merging does not duplicate a feature that is already disabled",
      mergeDisabledFeatures("CalculateNativeWinOcclusion", [
        "CalculateNativeWinOcclusion",
      ]) === "CalculateNativeWinOcclusion",
      mergeDisabledFeatures("CalculateNativeWinOcclusion", [
        "CalculateNativeWinOcclusion",
      ]),
    );

    const win = new BrowserWindow({ show: false, width: 900, height: 900 });
    await win.loadURL(PAGE);

    const v = await inspectVisual(win, ".t", { minWidth: 2, minHeight: 2 });
    const by = {};
    const ids = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.t')].map(e => e.id)`,
      true,
    );
    v.records.forEach((r, i) => (by[ids[i]] = r));

    expect("the sound element is reported sound", by.ok && by.ok.sound === true, JSON.stringify(by.ok));
    expect(
      "display:none is caught (rendered=false)",
      by.hidden && by.hidden.rendered === false && by.hidden.sound === false,
      JSON.stringify(by.hidden),
    );
    expect(
      "a collapsed element is caught (bigEnough=false)",
      by.flat && by.flat.bigEnough === false && by.flat.sound === false,
      JSON.stringify(by.flat),
    );
    expect(
      "horizontal clipping by an ancestor is caught",
      by.wide && by.wide.clippedX === true && by.wide.sound === false,
      JSON.stringify(by.wide),
    );
    expect(
      "being covered by another element is caught",
      by.covered && by.covered.occluded > 0 && by.covered.sound === false,
      JSON.stringify(by.covered),
    );
    expect(
      "an element straddling the viewport edge cannot pass unsampled",
      by.offedge && by.offedge.sampled === 0 && by.offedge.sound === false,
      JSON.stringify(by.offedge),
    );
    // Pin the intended semantics, so nobody "fixes" it into a false-failure
    // machine later. A hit on a DESCENDANT means the element is showing its own
    // content, which is the normal and desirable case - .mermaid is covered by
    // its own <svg>, #viewer by its own markdown. Treating that as occlusion
    // would fail on every healthy container. A reviewer flagged that this also
    // means a descendant acting as an opaque overlay reads as sound; that is a
    // real blind spot, and the deliberate answer is that content-level
    // assertions (labels present, non-empty SVG, geometry) cover it instead.
    expect(
      "an element covered by its own child content still counts as sound",
      by.haschild && by.haschild.occluded === 0 && by.haschild.sound === true,
      JSON.stringify(by.haschild),
    );
    expect(
      "the summary counts only sound elements",
      v.count === 7 && v.soundCount === 2,
      JSON.stringify({ count: v.count, soundCount: v.soundCount }),
    );

    // captureScreenshot() must never leave the PREVIOUS run's image behind when
    // this run failed to capture. That is not a hypothetical tidiness rule: a
    // real UnknownVizError was swallowed, a months-old PNG stayed at the
    // destination, and it was indistinguishable from a fresh capture - which in
    // a project where reviewing screenshots is a primary verification step is a
    // confident wrong answer rather than a missing one. Proven here with a
    // destroyed window, the one failure mode that cannot succeed on retry.
    const fs = require("fs");
    const path = require("path");
    const stalePath = path.join(
      __dirname,
      "..",
      "screenshots",
      "selfcheck-stale-artifact.png",
    );
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, Buffer.from("not a real png, but it is a file"));
    const staleBefore = fs.existsSync(stalePath);
    const dead = new BrowserWindow({ show: false });
    dead.destroy();
    const shot = await captureScreenshot(dead, "selfcheck-stale-artifact");
    expect(
      "the stale-artifact case really started with a file on disk",
      staleBefore === true,
      String(staleBefore),
    );
    expect(
      "a failed capture returns null instead of throwing",
      shot === null,
      String(shot),
    );
    expect(
      "a failed capture deletes the stale artifact rather than leaving it to be misread",
      fs.existsSync(stalePath) === false,
      "file still present at " + stalePath,
    );

    // A failed deletion is not equivalent to no screenshot. The file can still
    // look like current visual evidence, so captureScreenshot must reject
    // rather than swallow the EPERM and claim it removed the stale image.
    // Inject through unlinkSync for a deterministic cross-platform lock error,
    // and restore both globals before cleaning up the planted artifact.
    fs.writeFileSync(stalePath, Buffer.from("stale evidence that cannot be removed"));
    const realUnlink = fs.unlinkSync;
    const realLog = console.log;
    const removalLogs = [];
    let removalFailure = null;
    let staleSurvivedBlockedRemoval = false;
    try {
      fs.unlinkSync = (target, ...rest) => {
        if (path.resolve(String(target)) === path.resolve(stalePath)) {
          const error = new Error("controlled stale screenshot removal failure");
          error.code = "EPERM";
          throw error;
        }
        return realUnlink(target, ...rest);
      };
      console.log = (...args) => {
        removalLogs.push(args.join(" "));
        realLog(...args);
      };
      try {
        await captureScreenshot(dead, "selfcheck-stale-artifact");
      } catch (error) {
        removalFailure = error;
      }
      staleSurvivedBlockedRemoval = fs.existsSync(stalePath);
    } finally {
      fs.unlinkSync = realUnlink;
      console.log = realLog;
      if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
    }
    expect(
      "a locked stale screenshot fails visual evidence instead of claiming deletion succeeded",
      removalFailure &&
        removalFailure.code === "EPERM" &&
        /could not remove stale screenshot/.test(removalFailure.message) &&
        /controlled stale screenshot removal failure/.test(removalFailure.message) &&
        staleSurvivedBlockedRemoval &&
        !removalLogs.some((line) => line.includes("removed any stale")),
      `error=${removalFailure && removalFailure.message} ` +
        `staleSurvived=${staleSurvivedBlockedRemoval} logs=${JSON.stringify(removalLogs)}`,
    );
    expect(
      "the stale-screenshot failure injection restores deletion state and cleans its artifact",
      fs.unlinkSync === realUnlink && console.log === realLog && !fs.existsSync(stalePath),
      `unlinkRestored=${fs.unlinkSync === realUnlink} logRestored=${console.log === realLog} ` +
        `staleExists=${fs.existsSync(stalePath)}`,
    );

    // FRAME FRESHNESS. capturePage() returns the last frame the compositor
    // produced, not necessarily one that reflects the DOM as it stands - so a
    // screenshot taken right after a change can silently show the state
    // BEFORE it. That is the same disease as the stale artifact above wearing
    // a different coat, and it is worse: the file is fresh, so nothing about
    // it looks wrong. MEASURED at ~27% of captures before settleFrame() was
    // added (8 of 30 focused, 8 of 30 with another window on top), and 0 of 60
    // after. Screenshots are a primary verification step in this project, and
    // several defects here were found by looking at one; a 1-in-4 chance of
    // being shown the previous frame undermines every one of those findings.
    //
    // The oracle READS THE PNG BACK rather than trusting the capture call,
    // because what is being defended is the content of the file a human ends
    // up looking at.
    //
    // THE PAGE SHAPE IS LOAD-BEARING AND WAS CHOSEN BY MEASUREMENT. The first
    // version of this section used a 400x300 solid colour and R256 came back
    // VACUOUS: a trivial page composites faster than the capture round-trip,
    // so it is never stale and the assertion could not fail. Measured stale
    // rates with the settle removed, 24 samples each: 400x300 plain 0/24,
    // 1200x900 plain 1/24, 1200x900 blurred 15/24, and 1200x900 blurred over a
    // re-rastering layer 23/24. The last is what is used here - anything
    // cheaper turns this back into decoration.
    const { nativeImage } = require("electron");
    const HEAVY_CELLS = 4000;
    const freshWin = new BrowserWindow({ show: false, width: 1200, height: 900 });
    await freshWin.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<html><body style="margin:0">` +
            `<div id="p" style="position:fixed;inset:0;background:red;filter:blur(12px)"></div>` +
            `<div id="h" style="position:fixed;inset:0;opacity:0.02">` +
            Array.from(
              { length: HEAVY_CELLS },
              (_, i) =>
                `<div style="display:inline-block;width:9px;height:9px;background:hsl(${i % 360},50%,50%)"></div>`,
            ).join("") +
            `</div></body></html>`,
        ),
    );
    // Visible, because a hidden window composites nothing - but deliberately
    // NOT focused, so running the suite does not steal the reader's keyboard.
    freshWin.showInactive();
    await new Promise((r) => setTimeout(r, 500));

    const FRESH_N = 24;
    let captured = 0;
    let staleFrames = 0;
    let otherWrong = 0;
    const observed = [];
    for (let i = 0; i < FRESH_N; i++) {
      const colour = i % 2 === 0 ? "red" : "blue";
      const want = i % 2 === 0 ? "RED" : "BLUE";
      const previous = i === 0 ? null : i % 2 === 0 ? "BLUE" : "RED";
      await freshWin.webContents.executeJavaScript(
        `document.getElementById('p').style.background = '${colour}';` +
          `document.getElementById('h').style.transform = 'translateZ(0) rotate(${i}deg)';` +
          ` true`,
        true,
      );
      const shotFile = await captureScreenshot(freshWin, "selfcheck-frame-freshness");
      if (!shotFile) continue;
      captured++;
      const img = nativeImage.createFromPath(shotFile);
      const size = img.getSize();
      const bits = img
        .crop({
          x: Math.floor(size.width / 2),
          y: Math.floor(size.height / 2),
          width: 1,
          height: 1,
        })
        .toBitmap(); // BGRA
      const got =
        bits[2] > 180 && bits[1] < 80 && bits[0] < 80
          ? "RED"
          : bits[0] > 180 && bits[2] < 80 && bits[1] < 80
            ? "BLUE"
            : `other(${bits[2]},${bits[1]},${bits[0]})`;
      observed.push(got);
      if (got !== want) {
        if (got === previous) staleFrames++;
        else otherWrong++;
      }
    }
    freshWin.destroy();

    // Vacuity guard: with no captures at all, "no stale frames" is true for
    // the worst possible reason.
    expect(
      "the frame-freshness probe really captured every frame it asked for",
      captured === FRESH_N,
      `captured ${captured} of ${FRESH_N}`,
    );
    expect(
      "a screenshot shows the frame as it is now, not the one before it",
      staleFrames === 0,
      `${staleFrames} of ${captured} captures showed the PREVIOUS frame: ${observed.join(",")}`,
    );
    // Kept separate: a colour that is neither the current nor the previous one
    // is a broken probe (wrong sample point, scaling, colour space), not the
    // staleness this section exists to catch, and diagnosing it as staleness
    // would send the next reader in the wrong direction.
    expect(
      "the frame-freshness probe read colours it understands",
      otherWrong === 0,
      `unrecognised frames: ${observed.join(",")}`,
    );

    // ---------------------------------------------------------------------
    // The exit-time temp-dir sweep.
    //
    // The claim being defended is "a registered temp dir is gone after the
    // suite ends, whichever exit path it takes" - and the exit path that
    // matters is app.exit(), which unwinds nothing (probe C in
    // test-visual-utils.js), so a try/finally cannot do this and the whole
    // registry exists for that reason.
    //
    // "No temp dirs remain" is an ABSENCE check and fails open, so the
    // mechanics below are asserted positively - the directory must be
    // observed to EXIST and to be REGISTERED before anything claims it was
    // removed.
    const fsx = require("fs");
    const pathx = require("path");
    const osx = require("os");
    const { spawnSync } = require("child_process");
    const {
      tempDir,
      releaseTempDir,
      sweepTempDirs,
      TEMP_SWEEP,
      REGISTERED_TEMP_DIRS,
    } = require("./test-visual-utils");

    const madeDir = tempDir("mdv-selfcheck-");
    expect(
      "tempDir creates the directory and registers it for the exit sweep",
      fsx.existsSync(madeDir) &&
        REGISTERED_TEMP_DIRS.has(madeDir) &&
        pathx.basename(madeDir).startsWith("mdv-selfcheck-") &&
        pathx.resolve(pathx.dirname(madeDir)) === pathx.resolve(osx.tmpdir()),
      `dir=${madeDir} exists=${fsx.existsSync(madeDir)} registered=${REGISTERED_TEMP_DIRS.has(madeDir)}`,
    );

    releaseTempDir(madeDir);
    expect(
      "releaseTempDir removes the directory and de-registers it",
      !fsx.existsSync(madeDir) && !REGISTERED_TEMP_DIRS.has(madeDir),
      `exists=${fsx.existsSync(madeDir)} registered=${REGISTERED_TEMP_DIRS.has(madeDir)}`,
    );

    // The positive control for TEMP_SWEEP: without it, every assertion about
    // the sweep is satisfied by a sweep that never ran. The tree is nested and
    // non-empty on purpose - the claim is a RECURSIVE removal, and an empty
    // rmdir would pass a shallower test.
    const sweptDir = tempDir("mdv-selfcheck-sweep-");
    fsx.mkdirSync(pathx.join(sweptDir, "a", "b"), { recursive: true });
    fsx.writeFileSync(pathx.join(sweptDir, "a", "b", "f.bin"), Buffer.alloc(65536));
    const sweptBefore = TEMP_SWEEP.swept;
    sweepTempDirs();
    expect(
      "the sweep removes a registered tree and reports the work it did",
      TEMP_SWEEP.ran === true &&
        TEMP_SWEEP.swept === sweptBefore + 1 &&
        TEMP_SWEEP.failed.length === 0 &&
        !fsx.existsSync(sweptDir) &&
        !REGISTERED_TEMP_DIRS.has(sweptDir),
      `ran=${TEMP_SWEEP.ran} swept=${sweptBefore}->${TEMP_SWEEP.swept} ` +
        `failed=${JSON.stringify(TEMP_SWEEP.failed)} exists=${fsx.existsSync(sweptDir)}`,
    );

    // A FAILED REMOVAL MUST STAY OWNED. The sweep used to clear() the whole
    // registry at the end, which discarded the failures with everything else -
    // so the second sweep (the app.exit wrapper and the process-exit hook are
    // both wired to the same function) had nothing left to retry, and a
    // directory that could not be removed was silently orphaned. The failure is
    // injected through rmSync itself rather than by locking a real handle, so
    // the case is deterministic on every platform.
    const stubbornDir = tempDir("mdv-selfcheck-stubborn-");
    fsx.mkdirSync(pathx.join(stubbornDir, "sub"), { recursive: true });
    const realRm = fsx.rmSync;
    const failedBefore = TEMP_SWEEP.failed.length;
    const sweptBeforeStubborn = TEMP_SWEEP.swept;
    let retryRemoved = false;
    try {
      fsx.rmSync = (target, ...rest) => {
        if (pathx.resolve(String(target)) === pathx.resolve(stubbornDir)) {
          const error = new Error("controlled sweep removal failure");
          error.code = "EPERM";
          throw error;
        }
        return realRm(target, ...rest);
      };
      sweepTempDirs();
    } finally {
      fsx.rmSync = realRm;
    }
    const stillRegistered = REGISTERED_TEMP_DIRS.has(stubbornDir);
    const reported = TEMP_SWEEP.failed
      .slice(failedBefore)
      .some((entry) => entry.startsWith(stubbornDir + ": EPERM"));
    // Sampled BEFORE the retry: a failure that still counted as swept would be
    // invisible once the retry has legitimately incremented the counter.
    const sweptAfterFailure = TEMP_SWEEP.swept;
    // The retry is the point: with the injection removed, the very next sweep
    // has to be able to finish the job it was previously told to forget.
    sweepTempDirs();
    retryRemoved =
      !fsx.existsSync(stubbornDir) && !REGISTERED_TEMP_DIRS.has(stubbornDir);
    expect(
      "a removal the sweep could not complete stays registered, is reported, and is retried by the next sweep",
      stillRegistered &&
        reported &&
        sweptAfterFailure === sweptBeforeStubborn &&
        retryRemoved &&
        TEMP_SWEEP.swept === sweptBeforeStubborn + 1,
      `stillRegistered=${stillRegistered} reported=${reported} ` +
        `swept=${sweptBeforeStubborn}->${sweptAfterFailure}->${TEMP_SWEEP.swept} ` +
        `retryRemoved=${retryRemoved} ` +
        `failed=${JSON.stringify(TEMP_SWEEP.failed.slice(failedBefore))}`,
    );

    // NESTED REGISTRATIONS MUST NOT BECOME FALSE FAILURES. A parent and a child
    // can both be registered - the F22 companions do exactly this - and
    // whichever is swept first takes the other with it. The second removal then
    // finds nothing, and with the re-read introduced above that has to read as
    // "gone" rather than as an unremovable directory that stays registered
    // forever.
    const nestedParent = tempDir("mdv-selfcheck-nested-");
    const nestedChild = pathx.join(nestedParent, "inner");
    fsx.mkdirSync(nestedChild, { recursive: true });
    fsx.writeFileSync(pathx.join(nestedChild, "f.txt"), "x");
    REGISTERED_TEMP_DIRS.add(nestedChild);
    const sweptBeforeNested = TEMP_SWEEP.swept;
    const failedBeforeNested = TEMP_SWEEP.failed.length;
    sweepTempDirs();
    expect(
      "a registered directory nested inside another registered one sweeps cleanly rather than reporting a failure",
      !fsx.existsSync(nestedParent) &&
        !REGISTERED_TEMP_DIRS.has(nestedParent) &&
        !REGISTERED_TEMP_DIRS.has(nestedChild) &&
        TEMP_SWEEP.failed.length === failedBeforeNested &&
        TEMP_SWEEP.swept === sweptBeforeNested + 2,
      `parentExists=${fsx.existsSync(nestedParent)} ` +
        `parentRegistered=${REGISTERED_TEMP_DIRS.has(nestedParent)} ` +
        `childRegistered=${REGISTERED_TEMP_DIRS.has(nestedChild)} ` +
        `swept=${sweptBeforeNested}->${TEMP_SWEEP.swept} ` +
        `failed=${JSON.stringify(TEMP_SWEEP.failed.slice(failedBeforeNested))}`,
    );

    // releaseTempDir has the same ownership rule and the same injection proves
    // it: a removal that throws must leave the directory registered so the exit
    // sweep still owns it, rather than de-registering first and losing it.
    const heldDir = tempDir("mdv-selfcheck-held-");
    let heldStillRegistered = false;
    try {
      fsx.rmSync = (target, ...rest) => {
        if (pathx.resolve(String(target)) === pathx.resolve(heldDir)) {
          const error = new Error("controlled release failure");
          error.code = "EBUSY";
          throw error;
        }
        return realRm(target, ...rest);
      };
      releaseTempDir(heldDir);
      heldStillRegistered = REGISTERED_TEMP_DIRS.has(heldDir);
    } finally {
      fsx.rmSync = realRm;
    }
    releaseTempDir(heldDir);
    expect(
      "releaseTempDir keeps a directory it could not remove registered for the exit sweep",
      heldStillRegistered &&
        !fsx.existsSync(heldDir) &&
        !REGISTERED_TEMP_DIRS.has(heldDir),
      `heldStillRegistered=${heldStillRegistered} exists=${fsx.existsSync(heldDir)} ` +
        `registered=${REGISTERED_TEMP_DIRS.has(heldDir)}`,
    );

    // ---------------------------------------------------------------------
    // The end-to-end half, which cannot be observed in-process: this suite is
    // still running, so its own exit sweep has not happened yet, and the one
    // above was called by hand. A CHILD Electron process that ends the way
    // every windowed suite ends - app.exit() - is the only way to measure
    // that the sweep really fires on that path. This makes probes A and B from
    // test-visual-utils.js permanent instead of one-off.
    //
    // THE CHILD REGISTERS TWO EXIT HANDLERS AND THE ORDER IS THE WHOLE POINT.
    // Two independent mechanisms remove the directory - the app.exit wrapper
    // and the process.on("exit") hook - so "the dir is gone" is a DISJUNCTION
    // and cannot say which one did the work. Handlers run in registration
    // order, so a handler registered BEFORE the utils require runs before the
    // hook's sweep: if it already sees TEMP_SWEEP.ran, the wrapper did it.
    const childHome = tempDir("mdv-selfcheck-child-");
    // Stable basename: test-userdata-isolation derives the child's profile
    // directory from the script name, so a randomised name would leak a fresh
    // profile under folia-test-userdata on every run - the same class of leak
    // this section exists to close.
    const childScript = pathx.join(childHome, "folia-temp-sweep-child.js");
    const childReport = pathx.join(childHome, "report.json");
    // NOTE FOR EDITORS: assembled line by line rather than as a template
    // literal. A backtick or a dollar-brace inside a nested literal terminates
    // the outer one, which has bitten this project repeatedly.
    fsx.writeFileSync(
      childScript,
      [
        'const fs = require("fs");',
        'const path = require("path");',
        "const report = process.argv[process.argv.length - 1];",
        "let utils = null;",
        "let kept = null;",
        "let released = null;",
        "let early = null;",
        "// Registered BEFORE the utils require, so it runs BEFORE the",
        "// registry's own sweep hook: what it sees is the wrapper's work.",
        'process.on("exit", () => {',
        "  const s = utils && utils.TEMP_SWEEP;",
        "  early = {",
        "    ran: !!(s && s.ran),",
        "    swept: s ? s.swept : -1,",
        "    keptGone: !!(kept && !fs.existsSync(kept)),",
        "  };",
        "});",
        'const { app } = require("electron");',
        "utils = require(" +
          JSON.stringify(pathx.join(__dirname, "test-visual-utils.js")) +
          ");",
        "// Registered AFTER the require, so it runs AFTER the hook's sweep and",
        "// reports the final state whichever mechanism did the work.",
        'process.on("exit", () => {',
        "  try {",
        "    fs.writeFileSync(",
        "      report,",
        "      JSON.stringify({",
        "        kept: kept,",
        "        released: released,",
        "        early: early,",
        "        sweep: utils.TEMP_SWEEP,",
        "        keptGone: !fs.existsSync(kept),",
        "        releasedGone: !fs.existsSync(released),",
        "      }),",
        "    );",
        "  } catch (e) {",
        "    /* the parent treats a missing report as a failure */",
        "  }",
        "});",
        "app.whenReady().then(() => {",
        '  kept = utils.tempDir("mdv-sweepchild-keep-");',
        '  released = utils.tempDir("mdv-sweepchild-rel-");',
        '  fs.mkdirSync(path.join(kept, "a", "b"), { recursive: true });',
        '  fs.writeFileSync(path.join(kept, "a", "b", "f.bin"), Buffer.alloc(65536));',
        "  utils.releaseTempDir(released);",
        "  // setImmediate, not a bare app.exit(): a bare call stays inside the",
        "  // ready event's own dispatch, where exit handlers do not run at all",
        "  // (measured 0/5) and where Electron's teardown intermittently faults",
        "  // with 0xC0000005. This is the shape every real windowed suite has.",
        "  setImmediate(() => app.exit(0));",
        "});",
        "",
      ].join("\n"),
    );

    const childEnv = Object.assign({}, process.env);
    // Would turn the Electron binary into a plain node, so app would be
    // undefined and the child could not exercise the app.exit() path at all.
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(process.execPath, [childScript, childReport], {
      env: childEnv,
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
    });

    let childReported = null;
    try {
      childReported = JSON.parse(fsx.readFileSync(childReport, "utf8"));
    } catch (e) {
      childReported = null;
    }
    // Vacuity guard: every assertion below is about what the child observed,
    // so a child that never ran would leave them all unfalsifiable.
    expect(
      "the child suite really ran to its exit handler and reported back",
      child.status === 0 &&
        childReported !== null &&
        childReported.sweep &&
        childReported.sweep.ran === true &&
        typeof childReported.kept === "string",
      `status=${child.status} report=${JSON.stringify(childReported)} ` +
        `stderr=${String(child.stderr || "").slice(-400)}`,
    );

    const keptPath = childReported && childReported.kept;
    expect(
      "a registered temp dir is removed even when the suite ends with app.exit()",
      !!keptPath &&
        childReported.keptGone === true &&
        !fsx.existsSync(keptPath) &&
        childReported.sweep.failed.length === 0,
      `kept=${keptPath} childSaw=${childReported && childReported.keptGone} ` +
        `stillOnDisk=${keptPath ? fsx.existsSync(keptPath) : "n/a"} ` +
        `failed=${JSON.stringify(childReported && childReported.sweep && childReported.sweep.failed)}`,
    );

    // The counter is what stops "the sweep ran" being satisfied by a sweep
    // that found nothing, and it also pins that an early release does not get
    // counted as work the exit sweep did.
    expect(
      "the exit sweep counts exactly the dirs still registered when it runs",
      !!childReported &&
        childReported.sweep.swept === 1 &&
        childReported.releasedGone === true &&
        !fsx.existsSync(childReported.released),
      `swept=${childReported && childReported.sweep && childReported.sweep.swept} ` +
        `releasedGone=${childReported && childReported.releasedGone}`,
    );

    // THE CAUSE, ASSERTED SEPARATELY FROM THE CONSEQUENCE. The two assertions
    // above are satisfied by EITHER mechanism, so on their own they say only
    // "something cleaned up". This one reads the snapshot taken by the child's
    // FIRST exit handler - registered before the utils require, so it runs
    // before the registry's own hook - and requires the work to be already
    // done at that instant. Nothing but the app.exit wrapper can have done it.
    // It is also the only assertion here that covers a suite whose app.exit()
    // is reached inside the ready event's own dispatch, where the hook is
    // measured not to run at all.
    const early = childReported && childReported.early;
    expect(
      "the sweep runs inside app.exit(), before any process exit handler",
      !!early &&
        early.ran === true &&
        early.swept === 1 &&
        early.keptGone === true,
      `early=${JSON.stringify(early)}`,
    );

    // ---------------------------------------------------------------------
    // THE OTHER TIER, AND THE ONLY PATH THE WRAPPER STRUCTURALLY CANNOT
    // COVER. Everything above ends with app.exit(), so with the wrapper live
    // the hook is never the mechanism that does the work - neutralising it
    // would leave every assertion above green, i.e. the hook would be pinned
    // by nothing. A plain-node child (ELECTRON_RUN_AS_NODE=1, no window, no
    // app.exit - it just returns from its main module) has no app to wrap, so
    // the hook is the only thing that can clean up after it. Its report writer
    // is registered AFTER the utils require on purpose, the mirror image of
    // the discriminator above: here the hook must have run FIRST.
    const nodeHome = tempDir("mdv-selfcheck-node-");
    const nodeScript = pathx.join(nodeHome, "folia-temp-sweep-node.js");
    const nodeReport = pathx.join(nodeHome, "report.json");
    // NOTE FOR EDITORS: no backtick and no dollar-brace inside this array.
    fsx.writeFileSync(
      nodeScript,
      [
        'const fs = require("fs");',
        'const path = require("path");',
        "const report = process.argv[process.argv.length - 1];",
        "const utils = require(" +
          JSON.stringify(pathx.join(__dirname, "test-visual-utils.js")) +
          ");",
        'const kept = utils.tempDir("mdv-sweepnode-keep-");',
        'fs.mkdirSync(path.join(kept, "a"), { recursive: true });',
        'fs.writeFileSync(path.join(kept, "a", "f.bin"), Buffer.alloc(4096));',
        "// Registered AFTER the require, so the registry's own hook has already",
        "// swept by the time this runs: what it reports is the hook's work.",
        'process.on("exit", () => {',
        "  try {",
        "    fs.writeFileSync(",
        "      report,",
        "      JSON.stringify({",
        "        kept: kept,",
        "        sweep: utils.TEMP_SWEEP,",
        "        keptGone: !fs.existsSync(kept),",
        "      }),",
        "    );",
        "  } catch (e) {",
        "    /* the parent treats a missing report as a failure */",
        "  }",
        "});",
        "// No app.exit() and no explicit process.exit(): this tier ends by",
        "// returning from its main module, which is the whole point.",
        "",
      ].join("\n"),
    );

    const nodeEnv = Object.assign({}, process.env);
    nodeEnv.ELECTRON_RUN_AS_NODE = "1";
    const nodeChild = spawnSync(process.execPath, [nodeScript, nodeReport], {
      env: nodeEnv,
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
    });

    let nodeReported = null;
    try {
      nodeReported = JSON.parse(fsx.readFileSync(nodeReport, "utf8"));
    } catch (e) {
      nodeReported = null;
    }
    expect(
      "the plain-node child really ran and reported back",
      nodeChild.status === 0 &&
        nodeReported !== null &&
        typeof nodeReported.kept === "string",
      `status=${nodeChild.status} report=${JSON.stringify(nodeReported)} ` +
        `stderr=${String(nodeChild.stderr || "").slice(-400)}`,
    );
    expect(
      "the process exit hook sweeps a plain-node run that never calls app.exit",
      !!nodeReported &&
        nodeReported.sweep &&
        nodeReported.sweep.ran === true &&
        nodeReported.sweep.swept === 1 &&
        nodeReported.keptGone === true &&
        !fsx.existsSync(nodeReported.kept),
      `sweep=${JSON.stringify(nodeReported && nodeReported.sweep)} ` +
        `keptGone=${nodeReported && nodeReported.keptGone} ` +
        `stillOnDisk=${nodeReported && nodeReported.kept ? fsx.existsSync(nodeReported.kept) : "n/a"}`,
    );

    // A cleanup error cannot be demoted to an informational array after the
    // suite exits. This child keeps its registered directory undeletable and
    // proves the exit hook turns that failure into a non-zero process status.
    const failedSweepHome = tempDir("mdv-selfcheck-failed-sweep-");
    const failedSweepScript = pathx.join(
      failedSweepHome,
      "folia-temp-sweep-failure-child.js",
    );
    const failedSweepReport = pathx.join(failedSweepHome, "report.json");
    fsx.writeFileSync(
      failedSweepScript,
      [
        'const fs = require("fs");',
        "const report = process.argv[process.argv.length - 1];",
        "const utils = require(" +
          JSON.stringify(pathx.join(__dirname, "test-visual-utils.js")) +
          ");",
        'const kept = utils.tempDir("mdv-sweep-failure-");',
        "const realRm = fs.rmSync;",
        "fs.rmSync = (target, ...rest) => {",
        "  if (String(target) === kept) {",
        '    const error = new Error("controlled exit-sweep failure");',
        '    error.code = "EPERM";',
        "    throw error;",
        "  }",
        "  return realRm(target, ...rest);",
        "};",
        'process.on("exit", () => {',
        "  try {",
        "    fs.writeFileSync(report, JSON.stringify({",
        "      kept: kept,",
        "      stillThere: fs.existsSync(kept),",
        "      sweep: utils.TEMP_SWEEP,",
        "    }));",
        "  } catch (e) {}",
        "});",
        "",
      ].join("\n"),
    );
    const failedSweepChild = spawnSync(
      process.execPath,
      [failedSweepScript, failedSweepReport],
      { env: nodeEnv, encoding: "utf8", timeout: 60000, windowsHide: true },
    );
    let failedSweepReported = null;
    try {
      failedSweepReported = JSON.parse(fsx.readFileSync(failedSweepReport, "utf8"));
    } catch (e) {
      failedSweepReported = null;
    }
    expect(
      "a failed exit sweep changes suite status instead of producing green evidence",
      failedSweepChild.status === 1 &&
        failedSweepReported !== null &&
        failedSweepReported.stillThere === true &&
        Array.isArray(failedSweepReported.sweep.failed) &&
        failedSweepReported.sweep.failed.some((entry) =>
          entry.includes("EPERM"),
        ),
      `status=${failedSweepChild.status} report=${JSON.stringify(failedSweepReported)} ` +
        `stderr=${String(failedSweepChild.stderr || "").slice(-400)}`,
    );
    if (failedSweepReported && failedSweepReported.kept) {
      fsx.rmSync(failedSweepReported.kept, { recursive: true, force: true });
    }

    const nodeHomeReleased = releaseTempDir(nodeHome);
    const childHomeReleased = releaseTempDir(childHome);
    const failedSweepHomeReleased = releaseTempDir(failedSweepHome);
    const finalSweepFailures = sweepTempDirs();
    expect(
      "the selfcheck completes its registered temp-directory cleanup before its definitive footer",
      nodeHomeReleased === true &&
        childHomeReleased === true &&
      failedSweepHomeReleased === true &&
        finalSweepFailures.length === 0 &&
        REGISTERED_TEMP_DIRS.size === 0,
      `nodeHomeReleased=${nodeHomeReleased} childHomeReleased=${childHomeReleased} ` +
        `failedSweepHomeReleased=${failedSweepHomeReleased} ` +
        `sweepFailures=${JSON.stringify(finalSweepFailures)} ` +
        `remaining=${JSON.stringify([...REGISTERED_TEMP_DIRS])}`,
    );
  } catch (e) {
    expect("selfcheck ran without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  done();
});
