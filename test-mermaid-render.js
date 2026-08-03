// End-to-end regression harness for mermaid diagram rendering and geometry.
// Run with: npm run test:mermaid
//
// Two things are guarded here, and they fail in different ways.
//
// 1. Rendering. mermaid was upgraded 10 -> 11, which is a major version with a
//    different renderer and a different emitted DOM. A failure here is loud in
//    the app but silent in every other suite, because nothing else opens a real
//    document. So: open real markdown as a real tab and assert each fenced
//    diagram became an SVG with the right labels and no error marker.
//
// 2. Geometry. The diagram config in mermaid-config.js was chosen by measuring
//    box-vs-text fill ratio and canvas area across diagram types; the whole
//    point was that diagrams drew large shapes around small text. Those values
//    are easy to "tidy up" later without realising they were measured, so the
//    floors below lock in the outcome rather than the numbers - they sit well
//    under what the chosen config achieves, and well above mermaid's defaults.
//
// 3. Appearance. Sections 1 and 2 are both blind to colour and to layout
//    accidents: they once passed at full green while every diagram rendered
//    white-on-dark and unreadable. Section 6 asserts theme-correct contrast and
//    section 7 asserts the diagrams are actually visible - on screen, not
//    collapsed, not covered, not clipped. A screenshot is also written to
//    screenshots/ every run as a debugging artifact; nothing asserts on it.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { VISUAL_PROBE_SOURCE, inspectVisual, captureScreenshot } = require("./test-visual-utils");

require("./main.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-mermaid-"));
const fileM = path.join(dir, "diagrams.md");
const jsM = JSON.stringify(fileM);
// A deliberately diagram-free document. Section 6 needs a state where the
// viewer contains zero .mermaid elements while the app is still running.
const filePlain = path.join(dir, "plain.md");
const jsPlain = JSON.stringify(filePlain);
const DOC_PLAIN = "# Plain\n\nNo diagrams here at all.\n";

const DOC = `# Diagrams

A flowchart:

\`\`\`mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Do the thing]
  B -->|No| D[Stop]
\`\`\`

A sequence diagram:

\`\`\`mermaid
sequenceDiagram
  User->>App: open document
  App-->>User: rendered view
\`\`\`

A class diagram:

\`\`\`mermaid
classDiagram
  class User {
    +String name
    +login()
  }
  User <|-- Admin
\`\`\`
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

function writeReport(summary) {
  const lines = results.map(
    (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`,
  );
  lines.push(summary);
  try {
    fs.writeFileSync(path.join(__dirname, "test-mermaid-results.txt"), lines.join("\n") + "\n");
  } catch (e) {
    console.log("could not write test-mermaid-results.txt: " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a page-side condition instead of guessing with a fixed sleep.
 *
 * Fixed sleeps make the suite speed-sensitive: a reviewer demonstrated that
 * delaying mermaid.run by 5s left the 4s wait observing {blocks:1, svgs:0} and
 * the assertions then measured a page that had not finished rendering. Polling
 * keeps the fast path fast and the slow path correct.
 */
async function waitFor(exec, label, expression, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label} (last value: ${JSON.stringify(last)})`,
  );
}

// Every diagram in the fixture has rendered when each .mermaid block owns a
// non-empty <svg>. Anything less means the page is still settling.
const DIAGRAMS_READY = `
  (() => {
    const blocks = [...document.querySelectorAll('#viewer .mermaid')];
    if (blocks.length === 0) return false;
    return blocks.every(b => {
      const svg = b.querySelector('svg');
      return svg && svg.getBoundingClientRect().height > 1;
    });
  })()
`;

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  fs.writeFileSync(fileM, DOC, "utf8");
  fs.writeFileSync(filePlain, DOC_PLAIN, "utf8");

  await exec(`
    localStorage.clear();
    window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
    window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
    null;
  `);

  // Pin the theme before anything renders.
  //
  // Without this the suite inherits whatever theme the machine last persisted,
  // and section 6 can pass vacuously: if the app boots dark, the SVG cache is
  // populated with dark diagrams, so the "toggle to dark while no diagram is on
  // screen" regression produces dark diagrams even with the bug present. Force
  // light through the app's own theme path so the cache is deterministically
  // populated with light entries and the later flip to dark is meaningful.
  await exec(`
    (async () => {
      document.body.classList.remove('dark-mode');
      localStorage.setItem('darkMode', 'disabled');
      localStorage.setItem('themeMode', 'light');
      await updateMermaidTheme(false);
      return document.body.classList.contains('dark-mode');
    })()
  `);

  await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsM}, window.fs.readFileSync(${jsM}, 'utf8'));
      return t.id;
    })()
  `);

  // Diagram rendering is async and happens after the markdown is inserted.
  await waitFor(exec, "all diagrams to render", DIAGRAMS_READY);

  // --- 1. The library itself is the version we vendored --------------------
  // mermaid 11 dropped the `version()` helper, so ask the vendored bundle what
  // it is (that file is what actually ships) and assert the runtime is live.
  const vendored = JSON.parse(
    fs.readFileSync(path.join(__dirname, "libs", "vendor", "VERSIONS.json"), "utf8"),
  ).versions;
  check(
    "vendored mermaid is version 11",
    /^11\./.test(String(vendored.mermaid)),
    JSON.stringify(vendored),
  );
  const api = await exec(
    `(() => { try { return typeof mermaid + ':' + typeof mermaid.run + ':' + typeof mermaid.render + ':' + typeof mermaid.initialize; } catch (e) { return 'ERR:' + e.message; } })()`,
  );
  check(
    "the mermaid runtime exposes the API the renderer uses",
    api === "object:function:function:function",
    String(api),
  );

  // --- 2. Every fenced diagram actually rendered ---------------------------
  const render = await exec(`
    (() => {
      const blocks = [...document.querySelectorAll('#viewer .mermaid')];
      return {
        blocks: blocks.length,
        svgs: blocks.filter(b => b.querySelector('svg')).length,
        errored: blocks.filter(b =>
          b.querySelector('svg [class*="error"]') ||
          /syntax error/i.test(b.textContent || '')
        ).length,
        emptySvgs: blocks.filter(b => {
          const s = b.querySelector('svg');
          if (!s) return true;
          const r = s.getBoundingClientRect();
          return r.width < 10 || r.height < 10;
        }).length,
      };
    })()
  `);
  check("all three diagrams are present in the document", render.blocks === 3, JSON.stringify(render));
  check("every diagram produced an SVG", render.blocks > 0 && render.svgs === render.blocks, JSON.stringify(render));
  check("no diagram rendered an error", render.errored === 0, JSON.stringify(render));
  check("no diagram rendered an empty SVG", render.emptySvgs === 0, JSON.stringify(render));

  // --- 3. The labels survived ---------------------------------------------
  // A diagram can render a perfectly valid SVG with the wrong or missing text,
  // which is exactly what an escaping bug looks like.
  const labels = await exec(
    `[...document.querySelectorAll('#viewer .mermaid svg')].map(s => (s.textContent || '').replace(/\\s+/g, ' ').trim()).join(' | ')`,
  );
  for (const want of ["Decision", "Do the thing", "open document", "login()"]) {
    check(
      `diagram label "${want}" is rendered`,
      typeof labels === "string" && labels.includes(want),
      String(labels).slice(0, 200),
    );
  }

  // --- 4. Geometry: the measured config is actually in effect --------------
  const geo = await exec(`
    (() => {
      const rectOf = (n) => { try { const r = n.getBoundingClientRect(); return (r.width && r.height) ? r : null; } catch (e) { return null; } };
      const perDiagram = [];
      for (const svg of document.querySelectorAll('#viewer .mermaid svg')) {
        const shapes = [...svg.querySelectorAll('g.node'), ...svg.querySelectorAll('rect.actor, rect.actor-top')];
        const labelEls = [...svg.querySelectorAll('span.nodeLabel, text.actor, text.actor-box, text.nodeLabel')];
        const labels = labelEls.map(l => ({ r: rectOf(l) })).filter(x => x.r && x.r.width > 1 && x.r.height > 1);
        const out = [];
        for (const s of shapes) {
          const sb = rectOf(s);
          if (!sb || sb.width < 20 || sb.height < 16) continue;
          const inside = labels.filter(l => {
            const cx = l.r.left + l.r.width / 2, cy = l.r.top + l.r.height / 2;
            return cx >= sb.left && cx <= sb.right && cy >= sb.top && cy <= sb.bottom;
          });
          if (!inside.length) continue;
          const left = Math.min(...inside.map(l => l.r.left));
          const right = Math.max(...inside.map(l => l.r.right));
          const top = Math.min(...inside.map(l => l.r.top));
          const bottom = Math.max(...inside.map(l => l.r.bottom));
          const labW = right - left, labH = bottom - top;
          out.push({
            fill: (labW * labH) / (sb.width * sb.height),
            overflow: (labW > sb.width + 1) || (labH > sb.height + 1),
          });
        }
        perDiagram.push({
          role: svg.getAttribute('aria-roledescription') || 'unknown',
          shapes: out.length,
          fill: out.length ? out.reduce((a, b) => a + b.fill, 0) / out.length : 0,
          overflows: out.filter(o => o.overflow).length,
        });
      }
      const fonts = [...document.querySelectorAll('#viewer .mermaid svg span.nodeLabel, #viewer .mermaid svg text')]
        .map(t => parseFloat(getComputedStyle(t).fontSize)).filter(n => n > 0);
      return {
        perDiagram,
        totalShapes: perDiagram.reduce((a, d) => a + d.shapes, 0),
        overflows: perDiagram.reduce((a, d) => a + d.overflows, 0),
        minFont: fonts.length ? Math.min(...fonts) : 0,
      };
    })()
  `);

  // Non-vacuity: a geometry assertion over zero shapes always "passes".
  check("geometry probe found node shapes to measure", geo.totalShapes >= 5, JSON.stringify(geo));

  // mermaid's own default is 13px here and the measured config sets 14px. A
  // floor of 14 catches the config being dropped or overridden by CSS.
  check(
    "diagram label text is at least 14px",
    geo.minFont >= 14,
    JSON.stringify(geo),
  );

  // Per diagram type, not pooled: sequence actors are a fixed-size box around a
  // short name, so they are structurally low-fill and averaging them with
  // flowchart nodes hides a real regression in either direction.
  //
  // Measured, mermaid defaults -> chosen config, on mermaid 11.16:
  //   flowchart  15.8% -> 45.0%   floor 33%    discriminating
  //   sequence    9.0% ->  9.3%   floor 7.5%   NOT discriminating
  //   class      36.5% -> 37.6%   floor 30%    NOT discriminating
  //
  // Only the flowchart floor (and the font-size assertion above) actually fails
  // when the tuning is reverted - confirmed by reverting mermaid-config.js to
  // mermaid's defaults and re-running. That is the honest picture: the padding
  // and spacing tuning moves flowcharts a lot and the other two barely at all,
  // because their box sizes are driven by fixed geometry rather than padding.
  // The sequence and class floors are kept as one-way ratchets against a future
  // change making them worse, not as proof of this one.
  // Keyed by mermaid's own aria-roledescription rather than document order, so
  // reordering the fixture cannot silently make each floor check a different
  // diagram than its name claims.
  const FLOORS = [
    ["flowchart", "flowchart-v2", 0.33],
    ["sequence", "sequence", 0.075],
    ["class", "class", 0.3],
  ];
  FLOORS.forEach(([name, role, floor]) => {
    const d = geo.perDiagram.find((x) => x.role === role);
    check(
      `${name} node boxes are reasonably filled by their labels`,
      !!d && d.shapes > 0 && d.fill >= floor,
      JSON.stringify(d || { role, missing: true, saw: geo.perDiagram.map((x) => x.role) }) +
        ` floor=${floor}`,
    );
  });

  check("no label overflows its node box", geo.overflows === 0, JSON.stringify(geo));

  // --- 5. Diagrams stay inside the reading column --------------------------
  // useMaxWidth is deliberately left on so a wide diagram scales down instead
  // of forcing the page to scroll sideways.
  const overflow = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      const vw = viewer.getBoundingClientRect().width;
      const wide = [...viewer.querySelectorAll('.mermaid svg')]
        .filter(s => s.getBoundingClientRect().width > vw + 2).length;
      return { vw: Math.round(vw), wide };
    })()
  `);
  check(
    "no diagram is wider than the reading column",
    overflow.wide === 0,
    JSON.stringify(overflow),
  );

  // --- 6. Diagram colours track the active theme ---------------------------
  // Sections 1-5 are all geometry. They passed at full green while the
  // diagrams were visually unreadable: white node boxes carrying the app's
  // light-on-dark label colour. Geometry cannot see contrast, so measure it.
  //
  // The ratio is the WCAG relative-luminance contrast between a node's fill
  // and its own label colour. 4.5 is the AA threshold for normal-size text.
  const MEASURE = `
    (() => {
      const lum = (c) => {
        const m = String(c).match(/[\\d.]+/g);
        if (!m || m.length < 3) return null;
        if (m.length > 3 && Number(m[3]) === 0) return null;
        const v = m.slice(0, 3).map(Number).map(x => {
          x = x / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      const ratio = (a, b) => {
        const la = lum(a), lb = lum(b);
        if (la === null || lb === null) return null;
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };

      const viewer = document.getElementById('viewer');
      const pairs = [];
      viewer.querySelectorAll('.mermaid g.node').forEach(n => {
        const shape = n.querySelector('rect, path, polygon, circle');
        const label = n.querySelector('span.nodeLabel, .nodeLabel, text');
        if (!shape || !label) return;
        const fill = getComputedStyle(shape).fill;
        const color = getComputedStyle(label).color;
        const r = ratio(fill, color);
        if (r === null) return;
        pairs.push({
          text: (label.textContent || '').trim().slice(0, 20),
          fill: fill,
          color: color,
          fillLum: Math.round(lum(fill) * 1000) / 1000,
          ratio: Math.round(r * 100) / 100
        });
      });

      const worst = pairs.reduce((a, p) => (a === null || p.ratio < a.ratio ? p : a), null);
      return {
        bodyDark: document.body.classList.contains('dark-mode'),
        mermaidBlocks: viewer.querySelectorAll('.mermaid').length,
        measured: pairs.length,
        worst: worst,
        worstRatio: worst ? worst.ratio : null
      };
    })()
  `;

  const c1 = await exec(MEASURE);
  check(
    "contrast probe found node/label pairs to measure",
    c1.measured >= 3,
    JSON.stringify(c1),
  );
  // Honest note on what this does and does not catch: it did NOT discriminate
  // the wrong-theme bug, because light-theme boxes carry light-theme labels and
  // measured a perfectly healthy 13.14. It is kept as a one-way ratchet against
  // a future theme edit that puts low-contrast text on a box - something the
  // fill/luminance check below would happily allow.
  check(
    "diagram labels are readable against their node fill",
    c1.worstRatio !== null && c1.worstRatio >= 4.5,
    JSON.stringify(c1),
  );
  // This is the assertion that actually catches a wrong-theme render. Note it
  // is only as strong as the theme the app happens to boot into here; the
  // deterministic light->dark transition is exercised further down.
  check(
    "node fill matches the active theme (dark app => dark boxes)",
    c1.worst !== null && (c1.bodyDark ? c1.worst.fillLum < 0.5 : c1.worst.fillLum > 0.5),
    JSON.stringify(c1),
  );

  // Regression: toggling the theme while no diagram is on screen must still
  // re-configure mermaid. The theme toggle used to skip the mermaid re-init
  // whenever the viewer happened to contain zero .mermaid elements, so the
  // next document opened rendered with the previous theme's colours. That is
  // the ordinary startup path: the theme is resolved before any file is open.
  await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsPlain}, window.fs.readFileSync(${jsPlain}, 'utf8'));
      window.CustomTabs.switchToTab(t.id);
      return t.id;
    })()
  `);
  await waitFor(
    exec,
    "the diagram-free document to replace the diagrams",
    `document.getElementById('viewer').querySelectorAll('.mermaid').length === 0`,
  );

  const emptied = await exec(
    `document.getElementById('viewer').querySelectorAll('.mermaid').length`,
  );
  check(
    "a diagram-free document leaves no .mermaid elements on screen",
    emptied === 0,
    String(emptied),
  );

  // Flip to dark while the viewer holds no diagram at all - the exact state the
  // bug needed. The light starting point was pinned at the top of the run, so
  // this transition is always light -> dark and always meaningful.
  const toggled = await exec(`
    (() => {
      const wasDark = document.body.classList.contains('dark-mode');
      document.getElementById('darkModeToggle').click();
      return { startedLight: wasDark === false, nowDark: document.body.classList.contains('dark-mode') };
    })()
  `);
  check(
    "theme starts light and toggles to dark with no diagram on screen",
    toggled.startedLight === true && toggled.nowDark === true,
    JSON.stringify(toggled),
  );

  await exec(`
    (() => {
      const t = window.CustomTabs.getTabs().find(t => t.filePath === ${jsM});
      window.CustomTabs.switchToTab(t.id);
      return t.id;
    })()
  `);
  await waitFor(exec, "diagrams to re-render after the theme toggle", DIAGRAMS_READY);

  const c2 = await exec(MEASURE);
  check(
    "diagrams still render after a theme toggle",
    c2.measured >= 3,
    JSON.stringify(c2),
  );
  check(
    "labels stay readable after toggling the theme with no diagram on screen",
    c2.worstRatio !== null && c2.worstRatio >= 4.5,
    JSON.stringify(c2),
  );
  check(
    "node fill follows the theme toggled while no diagram was on screen",
    c2.worst !== null && (c2.bodyDark ? c2.worst.fillLum < 0.5 : c2.worst.fillLum > 0.5),
    JSON.stringify(c2),
  );

  // --- 7. The diagrams are actually visible --------------------------------
  // Everything above measures a diagram the code believes it rendered. None of
  // it would notice the diagram being scrolled off screen, collapsed to zero
  // height, covered by a floating toolbar, or clipped by the reading column.
  // Those are the failures a human spots instantly in a screenshot, so assert
  // them directly instead of relying on someone looking.
  for (const [name, sel] of [
    ["diagram containers", ".mermaid"],
    ["diagram SVGs", ".mermaid svg"],
  ]) {
    await exec(VISUAL_PROBE_SOURCE);
    await exec(`window.__mdvVisual.reveal(${JSON.stringify(sel)})`);
    await sleep(300);
    const vis = await inspectVisual(win, sel, { minWidth: 40, minHeight: 40 });
    check(
      `${name} are rendered, on screen, unoccluded and unclipped`,
      vis.count >= 1 && vis.soundCount === vis.count,
      JSON.stringify({ count: vis.count, unsound: vis.unsound }),
    );
  }

  // Artifact, not an assertion: something to look at when the above fails.
  await captureScreenshot(win, "mermaid-render");

  // --- 8. PDF export must re-theme the diagrams, not just the body ---------
  // mermaid bakes colours into the emitted SVG, so dropping the .dark-mode
  // class for a light export left dark diagrams on a light page. The handshake
  // is drivable straight over IPC, so this needs no native save dialog: main
  // sends prepare-for-pdf-export and must not print until the renderer answers
  // pdf-export-ready - by which time the diagrams have to be light already.
  const ready = new Promise((resolve) =>
    ipcMain.once("pdf-export-ready", () => resolve(true)),
  );
  win.webContents.send("prepare-for-pdf-export");
  const readyFired = await Promise.race([
    ready,
    sleep(20000).then(() => false),
  ]);
  check("the renderer answers pdf-export-ready", readyFired === true, "timed out");

  const exportState = await exec(MEASURE);
  check(
    "PDF export drops dark mode on the body",
    exportState.bodyDark === false,
    JSON.stringify(exportState),
  );
  // The real assertion: light page, light diagrams. Before the fix this
  // reported fillLum 0.02 (rgb(36,36,36)) against bodyDark false.
  check(
    "PDF export re-themes the diagrams to match the light page",
    exportState.worst !== null && exportState.worst.fillLum > 0.5,
    JSON.stringify(exportState),
  );
  check(
    "diagram labels stay readable in the PDF export theme",
    exportState.worstRatio !== null && exportState.worstRatio >= 4.5,
    JSON.stringify(exportState),
  );

  // --- 9. Concurrent theme changes are serialised -------------------------
  // Two rapid toggles used to produce two overlapping mermaid.run() calls over
  // the same nodes and the same cache; a reviewer measured maxActive=2. The
  // danger is not just a garbled render: an older call finishing last writes
  // its wrong-theme SVGs into mermaidSvgCache *after* the newer call cleared
  // it, which is the very bug this whole section exists to prevent.
  await exec(`
    (() => {
      window.__runProbe = { active: 0, maxActive: 0, calls: 0 };
      const original = mermaid.run.bind(mermaid);
      window.__runProbeRestore = () => { mermaid.run = original; };
      mermaid.run = async function (...args) {
        window.__runProbe.calls++;
        window.__runProbe.active++;
        window.__runProbe.maxActive = Math.max(window.__runProbe.maxActive, window.__runProbe.active);
        try { return await original(...args); }
        finally { window.__runProbe.active--; }
      };
      return true;
    })()
  `);

  await exec(`
    (() => {
      const btn = document.getElementById('darkModeToggle');
      btn.click();
      btn.click();
      btn.click();
      return true;
    })()
  `);
  await waitFor(
    exec,
    "the queued theme updates to drain",
    `window.__runProbe.active === 0 && window.__runProbe.calls > 0`,
  );
  await waitFor(exec, "diagrams to settle after rapid toggles", DIAGRAMS_READY);

  const runProbe = await exec(`window.__runProbe`);
  check(
    "rapid theme toggles never run mermaid concurrently",
    runProbe.maxActive === 1,
    JSON.stringify(runProbe),
  );

  const afterRace = await exec(MEASURE);
  // Honest note: this one passed even with serialisation removed (maxActive=3),
  // so it is a one-way ratchet, not the discriminating assertion — maxActive
  // above is. It is kept because the failure mode it guards (stale-theme SVGs
  // written back into the cache by a superseded call) is timing-dependent and
  // would otherwise go unwatched.
  check(
    "the final theme wins after rapid toggles",
    afterRace.worst !== null &&
      (afterRace.bodyDark ? afterRace.worst.fillLum < 0.5 : afterRace.worst.fillLum > 0.5),
    JSON.stringify(afterRace),
  );

  // Section 9 is currently last, but leaving mermaid.run wrapped would silently
  // contaminate any section added after it.
  await exec(`window.__runProbeRestore(), true`);
}

app.whenReady().then(async () => {
  if (!BrowserWindow.getAllWindows().length) {
    console.log(
      "FAIL  no window at ready - another instance is probably holding the " +
        "single-instance lock. Close any running Markdown Viewer / stray " +
        "electron.exe and re-run.",
    );
  }

  const watchdog = setTimeout(() => {
    const summary = "=== timed out after 180s ===";
    console.log(summary);
    writeReport(summary);
    app.exit(1);
  }, 180000);

  const win = BrowserWindow.getAllWindows()[0];
  try {
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once("did-finish-load", r));
    }
    await run(win);
  } catch (e) {
    check("harness completed without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  const passed = results.filter((r) => r.ok).length;
  // On failure the last thing anyone wants is to re-run the suite by hand just
  // to see what the screen looked like. Capture it now, while the app is still
  // in the failing state.
  if (passed !== results.length && win) {
    const shot = await captureScreenshot(win, "mermaid-render-FAILED");
    if (shot) console.log("failure screenshot: " + shot);
  }
  const summary = `=== ${passed}/${results.length} passed ===`;
  console.log(summary);
  writeReport(summary);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
  app.exit(passed === results.length ? 0 : 1);
});
