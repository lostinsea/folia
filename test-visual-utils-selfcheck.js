// Self-check for test-visual-utils' probe: proves it actually detects each
// failure mode it claims to. A visual assertion that cannot fail is worse than
// no assertion, because it reads as coverage. Run with: npm run test:visual
const { app, BrowserWindow } = require("electron");
const { inspectVisual, captureScreenshot } = require("./test-visual-utils");

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
  }, 30000);

  try {
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
  } catch (e) {
    expect("selfcheck ran without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  done();
});
