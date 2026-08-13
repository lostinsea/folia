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
  } catch (e) {
    expect("selfcheck ran without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  done();
});
