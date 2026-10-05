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
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { VISUAL_PROBE_SOURCE, inspectVisual, captureScreenshot, startErrorSentinel, proveSentinelAlive, LIVENESS_MUTE_REASON, trapExternalOpens, waitForExternalTrap, tempDir, releaseTempDir } = require("./test-visual-utils");

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const TEST_PRELOAD_MARKER = "--folia-test-preload";
if (!process.argv.includes(TEST_PRELOAD_MARKER)) {
  process.argv.push(TEST_PRELOAD_MARKER);
}
const PDF_RESTORE_TOKEN = randomUUID();

require("../src/main.js");

const dir = tempDir("mdv-mermaid-");
const fileM = path.join(dir, "diagrams.md");
const jsM = JSON.stringify(fileM);
// A deliberately diagram-free document. Section 6 needs a state where the
// viewer contains zero .mermaid elements while the app is still running.
const filePlain = path.join(dir, "plain.md");
const jsPlain = JSON.stringify(filePlain);
const DOC_PLAIN = "# Plain\n\nNo diagrams here at all.\n";

// Section 11 needs a document tall enough to actually scroll, and a diagram the
// SVG cache has never seen (a cache hit would leave toRender empty and the
// render would never reach ensureMermaid at all - a vacuous pass).
const fileLong = path.join(dir, "long.md");
const jsLong = JSON.stringify(fileLong);
const DOC_LONG = "# Long\n\n" + "Filler paragraph so the document scrolls.\n\n".repeat(400);
const fileRace = path.join(dir, "race.md");
const jsRace = JSON.stringify(fileRace);
const DOC_RACE = "# Race\n\n```mermaid\ngraph LR\n  RaceOnly1 --> RaceOnly2\n```\n";
const fileRace2 = path.join(dir, "race2.md");
const jsRace2 = JSON.stringify(fileRace2);
const DOC_RACE2 = "# Race2\n\n```mermaid\ngraph LR\n  RaceTwo1 --> RaceTwo2\n```\n";

// One good diagram followed by one unparseable one, in that order. The order is
// the whole point: it puts a diagram that DID render before the failure, so the
// post-render passes can be asked whether they still ran for it.
const fileMixed = path.join(dir, "mixed.md");
const jsMixed = JSON.stringify(fileMixed);
const DOC_MIXED =
  "# Mixed\n\n" +
  "```mermaid\ngraph LR\n  MixedGood1[Good one] --> MixedGood2[Good two]\n```\n\n" +
  "```mermaid\nnotADiagramTypeAtAll\n  x --> y\n```\n";

// The same failure, but with markup in the diagram source. mermaid's
// "no diagram type detected" message quotes the source text back, so this
// measures whether document content can reach an innerHTML sink through the
// error path.
const fileInject = path.join(dir, "inject.md");
const jsInject = JSON.stringify(fileInject);
const DOC_INJECT =
  "# Inject\n\n" +
  '```mermaid\nnotADiagramTypeAtAll <i id="mermaid-inject-probe">probe</i>\n```\n';

// A sequence diagram on its own, for the actor-lifeline measurement.
const fileSeq = path.join(dir, "sequence.md");
const jsSeq = JSON.stringify(fileSeq);
const DOC_SEQ =
  "# Sequence\n\n" +
  "```mermaid\nsequenceDiagram\n  Alice->>Bob: first\n  Bob-->>Alice: second\n  Alice->>Bob: third\n```\n";

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

function everyMeasuredFillDark(state) {
  return (
    state.nodeCount >= 3 &&
    state.nodeFillLuminances.length === state.nodeCount &&
    state.nodeFillLuminances.every((fillLum) => fillLum < 0.5)
  );
}

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  // Watches the whole suite, not just the moments a screenshot is taken. See
  // startErrorSentinel() for why: a red mermaid error graphic that appears and
  // is then repainted over leaves no trace in an end-of-run screenshot.
  const sentinel = startErrorSentinel(win, { label: "mermaid" });
  // No suite may reach the user's browser. See trapExternalOpens().
  await trapExternalOpens(win);

  fs.writeFileSync(fileM, DOC, "utf8");
  fs.writeFileSync(filePlain, DOC_PLAIN, "utf8");
  fs.writeFileSync(fileLong, DOC_LONG, "utf8");
  fs.writeFileSync(fileRace, DOC_RACE, "utf8");
  fs.writeFileSync(fileRace2, DOC_RACE2, "utf8");
  fs.writeFileSync(fileMixed, DOC_MIXED, "utf8");
  fs.writeFileSync(fileInject, DOC_INJECT, "utf8");
  fs.writeFileSync(fileSeq, DOC_SEQ, "utf8");

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
    fs.readFileSync(path.join(__dirname, "..", "libs", "vendor", "VERSIONS.json"), "utf8"),
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
  // Measured, mermaid defaults -> chosen config, on mermaid 11.16 WHEN WRITTEN:
  //   flowchart  15.8% -> 45.0%   floor 33%    discriminating
  //   sequence    9.0% ->  9.3%   floor 7.5%   NOT discriminating
  //   class      36.5% -> 37.6%   floor 30%    NOT discriminating
  //
  // CORRECTED 11.17.0 BUMP - THE TUNED COLUMN ABOVE IS STALE. Re-measured on
  // the current tree: flowchart 36.0%, sequence 10.2%, class 37.7%. The class
  // figure still matches; flowchart and sequence do not. The drift is NOT the
  // mermaid bump - proven by a controlled A/B with the SAME probe and the SAME
  // fixture, installing 11.16.0, re-vendoring (bytes back to 3565102 /
  // 74D7C46D) and re-running:
  //
  //   11.16.0  flowchart 0.360  sequence 0.102  class 0.377
  //   11.17.0  flowchart 0.360  sequence 0.102  class 0.377   <- identical
  //
  // So the two versions are geometrically indistinguishable here and the whole
  // delta predates the bump. These are ratios over laid-out text, so they move
  // with anything that moves text metrics - and several such things have landed
  // since (marked 9 -> 18, the theme/token rewrite, and the display scaling
  // going 150% -> 125%, which is what broke the theme border goldens). NOT
  // chased further: every floor still clears, and attributing it is a separate
  // question from taking this bump.
  //
  // THE FLOORS ARE DELIBERATELY NOT RE-FITTED to these numbers. Re-baselining a
  // detector onto the population it currently sees is how it decays into a
  // description of the status quo. Flowchart now clears by 3 points rather than
  // 12, but that headroom is against measurement drift, not against the defect
  // the floor guards: reverting the tuning takes it to ~15.8%, less than half
  // the floor. NOT re-confirmed in this pass - that claim is inherited.
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
  //
  // The id is mermaid's REGISTERED DIAGRAM ID, written into the attribute by
  // its own setA11yDiagramInfo(), so it is an upstream contract that can move
  // under a bump - and it did: 11.16.0 emitted "class" for a class diagram,
  // 11.17.0 emits "classDiagram". MEASURED, not assumed: the same fixture on
  // the same suite reported role "classDiagram" the moment mermaid changed,
  // and the vendored bundle registers "classDiagram" while no diagram declares
  // a bare "class" roledescription any more.
  //
  // Each floor therefore accepts a LIST of ids rather than a single string.
  // Deliberately not relaxed to "any diagram": the whole point of keying on the
  // role is that the floor named "class" measures the class diagram. An
  // unrecognised id still fails loudly with `missing: true` plus the ids it
  // saw, which is exactly how this rename surfaced.
  const FLOORS = [
    ["flowchart", ["flowchart-v2"], 0.33],
    ["sequence", ["sequence"], 0.075],
    ["class", ["class", "classDiagram"], 0.3],
  ];
  FLOORS.forEach(([name, roles, floor]) => {
    const d = geo.perDiagram.find((x) => roles.indexOf(x.role) !== -1);
    check(
      `${name} node boxes are reasonably filled by their labels`,
      !!d && d.shapes > 0 && d.fill >= floor,
      JSON.stringify(d || { roles, missing: true, saw: geo.perDiagram.map((x) => x.role) }) +
        ` floor=${floor}`,
    );
  });

  // A floor that passes silently is a floor nobody has read. check() discards
  // evidence on PASS, so these three cleared their bars for a long time without
  // ever printing the numbers - the same magic-number disease as the licence
  // guard's `> 200` against a real 220. Printed permanently, so a bump that
  // degrades a fill while still clearing its floor is visible in the log rather
  // than only when it finally crosses. Not a check(): it must not move the
  // assertion count, which name-set reconciliation depends on.
  console.log(
    "note: mermaid geometry " +
      JSON.stringify({
        mermaid: vendored.mermaid,
        perDiagram: geo.perDiagram.map((d) => ({
          role: d.role,
          shapes: d.shapes,
          fill: Number(d.fill.toFixed(3)),
          overflows: d.overflows,
        })),
        minFont: geo.minFont,
      }),
  );

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
      const nodeFillLuminances = [];
      let nodeCount = 0;
      viewer.querySelectorAll('.mermaid g.node').forEach(n => {
        nodeCount++;
        const shape = n.querySelector('rect, path, polygon, circle');
        const label = n.querySelector('span.nodeLabel, .nodeLabel, text');
        if (shape) {
          const fillLum = lum(getComputedStyle(shape).fill);
          if (fillLum !== null) {
            nodeFillLuminances.push(Math.round(fillLum * 1000) / 1000);
          }
        }
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
        fillLuminances: pairs.map(p => p.fillLum),
        nodeCount,
        nodeFillLuminances,
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
  // The earlier legacy-toggle regression deliberately clicks the old toggle,
  // which changes darkMode but leaves themeMode at its initial light value.
  // PDF restoration reads themeMode first, so make this fixture's intended
  // dark preference explicit only after that legacy coverage has finished.
  const pdfRestoreFixture = await exec(`(() => {
    localStorage.setItem('themeMode', 'dark');
    return {
      mode: resolveStoredMode(),
      resolvesDark: resolveDarkPreference(),
      bodyDark: document.body.classList.contains('dark-mode')
    };
  })()`);
  const pdfRestoreFixtureTheme = await exec(MEASURE);
  check(
    "the PDF restore fixture persists a dark effective preference and dark diagrams",
    pdfRestoreFixture.mode === "dark" &&
      pdfRestoreFixture.resolvesDark === true &&
      pdfRestoreFixture.bodyDark === true &&
      everyMeasuredFillDark(pdfRestoreFixtureTheme),
    JSON.stringify({ fixture: pdfRestoreFixture, theme: pdfRestoreFixtureTheme }),
  );
  const mixedFillControl = {
    ...pdfRestoreFixtureTheme,
    nodeFillLuminances: [
      ...pdfRestoreFixtureTheme.nodeFillLuminances.slice(0, -1),
      1,
    ],
  };
  check(
    "the PDF dark-diagram probe rejects a mixed-fill control",
    !everyMeasuredFillDark(mixedFillControl),
    JSON.stringify(mixedFillControl),
  );

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

  // Complete the handshake. main.js replies on this channel from EVERY branch
  // including its failure ones, so a `prepare` without a `result` is not a
  // state the product can reach - but driving only half of it here left the
  // renderer's export hold raised for the rest of the suite, which silently
  // disabled the theme menu and surfaced two sections later as an unrelated
  // failure. The assertion below turns that discovery into a guard: a
  // completed PDF export must leave nothing held.
  {
    const bridgeAvailable = await exec(
      `typeof globalThis.__foliaTestPdfRestore?.signal`,
    );
    check(
      "the marked test-only PDF restore preload exposes its PDF restore capability",
      bridgeAvailable === "function",
      bridgeAvailable,
    );

    const pdfResultName = `suite-pdf-handshake-${PDF_RESTORE_TOKEN}.pdf`;
    const notificationProbeInstalled = await exec(`(() => {
      const original = window.showNotification;
      if (typeof original !== 'function') return false;
      window.__pdfResultNotificationProbe = { original, observation: null };
      window.showNotification = function(message, ...args) {
        if (String(message).includes(${JSON.stringify(pdfResultName)})) {
          window.__pdfResultNotificationProbe.observation = {
            hold: (typeof exportThemeHold === 'number' ? exportThemeHold : -1),
            theme: ${MEASURE}
          };
        }
        return original.call(this, message, ...args);
      };
      return true;
    })()`);
    check(
      "the PDF notification witness patches the real notifier",
      notificationProbeInstalled === true,
      String(notificationProbeInstalled),
    );
    const beforeResult = await exec(`(() => ({
      hold: (typeof exportThemeHold === 'number' ? exportThemeHold : -1),
      bodyDark: document.body.classList.contains('dark-mode'),
      notification: document.getElementById('notificationMessage').textContent
    }))()`);
    check(
      "the PDF restore witness sees prepare force light with its hold raised and fresh result notification absent",
      beforeResult.bodyDark === false &&
        beforeResult.hold > 0 &&
        !beforeResult.notification.includes(pdfResultName),
      JSON.stringify(beforeResult),
    );

    let resolveFreshWitness;
    const freshWitnessDelivery = new Promise((resolve) => {
      resolveFreshWitness = resolve;
    });
    const onRestoreObserved = (event, token) => {
      if (event.sender === win.webContents && token === PDF_RESTORE_TOKEN) {
        resolveFreshWitness({ kind: "fresh-bridge-signal" });
      }
    };
    ipcMain.on("pdf-restore-observed", onRestoreObserved);

    let freshWitness = { kind: "capability-unavailable" };
    let resultRestored = { kind: "not-sent" };
    let notificationAfterRestore = false;
    try {
      win.webContents.send("pdf-export-result", {
        success: true,
        path: "C:\\\\tmp\\\\" + pdfResultName,
      });
      try {
        await waitFor(
          exec,
          "the PDF result notification after its theme restore",
          `document.getElementById('notificationMessage').textContent.includes(${JSON.stringify(pdfResultName)})`,
          8000,
        );
        const restoredHold = await exec(`(() => ({
          hold: (typeof exportThemeHold === 'number' ? exportThemeHold : -1),
          bodyDark: document.body.classList.contains('dark-mode'),
          notification: document.getElementById('notificationMessage').textContent,
          notificationObservation: window.__pdfResultNotificationProbe &&
            window.__pdfResultNotificationProbe.observation
        }))()`);
        resultRestored = {
          ...restoredHold,
          theme: await exec(MEASURE),
        };
      } catch (error) {
        resultRestored = {
          kind: "timeout",
          error: String(error && error.message ? error.message : error),
        };
      }
      notificationAfterRestore =
        notificationProbeInstalled === true &&
        resultRestored.notificationObservation &&
        resultRestored.notificationObservation.hold === 0 &&
        everyMeasuredFillDark(resultRestored.notificationObservation.theme);

      if (
        bridgeAvailable === "function" &&
        notificationAfterRestore &&
        resultRestored.hold === 0
      ) {
        const signalSent = await exec(
          `globalThis.__foliaTestPdfRestore.signal(${JSON.stringify(PDF_RESTORE_TOKEN)})`,
        );
        freshWitness = await Promise.race([
          freshWitnessDelivery,
          sleep(8000).then(() => ({
            kind: "timeout",
          })),
        ]);
        freshWitness.signalSent = signalSent;
      }
    } finally {
      ipcMain.removeListener("pdf-restore-observed", onRestoreObserved);
      await exec(`(() => {
        const probe = window.__pdfResultNotificationProbe;
        if (probe) {
          window.showNotification = probe.original;
          delete window.__pdfResultNotificationProbe;
        }
        return true;
      })()`).catch(() => {});
    }
    check(
      "the PDF success notification is emitted only after dark diagrams and hold restoration",
      notificationAfterRestore,
      JSON.stringify(resultRestored.notificationObservation),
    );
    check(
      "the PDF result notification follows restored dark theme and export hold",
      resultRestored.hold === 0 &&
        resultRestored.bodyDark === true &&
        resultRestored.theme &&
        everyMeasuredFillDark(resultRestored.theme) &&
        typeof resultRestored.notification === "string" &&
        resultRestored.notification.includes(pdfResultName),
      JSON.stringify(resultRestored),
    );
    check(
      "the completed PDF export delivers its fresh bridge token after restoration",
      freshWitness.kind === "fresh-bridge-signal" &&
        freshWitness.signalSent === true,
      JSON.stringify(freshWitness),
    );
    const held = await exec(
      `(typeof exportThemeHold === 'number' ? exportThemeHold : -1)`,
    );
    check(
      "a completed PDF export leaves no theme hold behind",
      held === 0,
      `exportThemeHold=${held}`,
    );
  }

  // Shared drivers for the export handshake, used by 8c and 8e below. main.js
  // sends prepare-for-pdf-export, waits for the renderer to answer
  // pdf-export-ready, runs printToPDF, and replies on pdf-export-result from
  // every branch including its failure ones. Driving that sequence directly
  // needs no native save dialog and, unlike a click, makes the in-flight
  // window EXPLICIT: it opens when ready fires and closes only when this file
  // chooses to send the result.
  const beginExport = async () => {
    const ready = new Promise((resolve) =>
      ipcMain.once("pdf-export-ready", () => resolve(true)),
    );
    win.webContents.send("prepare-for-pdf-export");
    return await Promise.race([ready, sleep(20000).then(() => false)]);
  };
  const finishExport = async (name) => {
    win.webContents.send("pdf-export-result", {
      success: true,
      path: "C:\\\\tmp\\\\" + name,
    });
    await waitFor(
      exec,
      `the ${name} export result to be handled`,
      `document.getElementById('notificationMessage').textContent.includes(${JSON.stringify(name)})`,
    );
  };
  // A faithful stand-in for the app's own theme toggle, which writes the
  // PREFERENCE as well as the class (custom-theme.js). That matters here: an
  // export restores from resolveDarkPreference(), not from a snapshot of the
  // class taken before it started, so a simulation that moved only the class
  // would leave the export with nothing to restore to and would fail for a
  // reason belonging to the test rather than to the product.
  const setThemePref = async (dark) => {
    await exec(`(async () => {
      localStorage.setItem('themeMode', ${dark ? "'dark'" : "'light'"});
      document.body.classList.${dark ? "add" : "remove"}('dark-mode');
      await updateMermaidTheme(${dark});
      return true;
    })()`);
    await sleep(1500);
  };
  // Section 8 learned this the hard way: a section that throws between prepare
  // and result leaves the export hold raised, which silently disables the
  // theme menu and surfaces two sections later as an unrelated failure. Every
  // section that opens a hold drains it on the way out.
  const drainExportHolds = async () =>
    await exec(`(() => {
      let n = 0;
      while (typeof exportThemeHold === 'number' && exportThemeHold > 0 && n < 10) {
        endExportThemeHold();
        n++;
      }
      return n;
    })()`);

  // --- 8c. A theme change made DURING an export ---------------------------
  // An export is not instantaneous, and the window stays live and responsive
  // for the whole of it, so the reader can change the theme in the middle.
  // Two independent things have to hold, and they pull in opposite
  // directions:
  //
  //   1. The export must not UNDO their change. Restoring from a snapshot
  //      taken before the export started puts the reader back into the theme
  //      they had just left.
  //   2. Their change must not REACH the export. Picking Dark re-themes every
  //      diagram in place, and printToPDF captures the LIVE document - so a
  //      change that lands before main prints is baked into the PDF, which is
  //      the defect section 8 exists for, arriving by a different route.
  //
  // The oracle is the live DOM (the shared MEASURE probe) rather than a
  // rasterised PNG, because the live DOM is precisely what printToPDF
  // captures. This section was originally written against the Word export,
  // whose in-flight window could only be inferred from timing; an early
  // version of it measured nothing at all, because the one-diagram document
  // had finished exporting inside the 500 ms the test waited before flipping
  // the theme. The IPC handshake removes that whole class of hazard.
  {
    const holdDoc = path.join(dir, "hold.md");
    fs.writeFileSync(
      holdDoc,
      "# Hold\n\n```mermaid\ngraph TD\n  H1[Hold One] --> H2[Hold Two]\n" +
        "  H2 --> H3[Hold Three]\n```\n",
      "utf8",
    );

    try {
      await exec(
        `(() => { const t = window.CustomTabs.createTab(${JSON.stringify(holdDoc)}, window.fs.readFileSync(${JSON.stringify(holdDoc)}, 'utf8')); return t.id; })()`,
      );
      await waitFor(exec, "the 8c theme-hold fixture to finish drawing", DIAGRAMS_READY);
      await exec(`window.alert = () => {}; true`);

      // 1. The export must not undo a change made while it ran. Start dark,
      // move the preference to light while the export is open, and require
      // the release to honour the NEWER preference.
      await setThemePref(true);
      const readyFlip = await beginExport();
      const duringFlip = await exec(MEASURE);
      await exec(`localStorage.setItem('themeMode', 'light'); true`);
      await finishExport("hold-flip.pdf");
      await sleep(1500);
      const afterFlip = await exec(`document.body.classList.contains('dark-mode')`);
      // Diagnosed separately from the assertion below. If the handshake never
      // opened, the theme assertion would fail naming the theme - a misleading
      // diagnosis for an export that never started.
      check(
        "8c the mid-export preference flip really reached a completed export",
        readyFlip === true && duringFlip.bodyDark === false,
        `ready=${readyFlip} bodyDarkDuringExport=${duringFlip.bodyDark}`,
      );
      check(
        "a theme change made during a PDF export is not undone when it finishes",
        afterFlip === false && readyFlip === true,
        `ready=${readyFlip} after=${afterFlip}`,
      );

      // 2. The reader's change must not reach the export. The export has
      // forced the document light and main is about to print; the reader picks
      // Dark from the theme menu. That is not a preference write - it goes
      // through custom-theme.js, which clicks the real toggle, which re-themes
      // every diagram in place. Driven through the REAL menu option rather
      // than a hand-rolled simulation, because the defect lives in the
      // coupling between the menu, the hidden toggle and the export hold: a
      // simulation that wrote themeMode and stopped there would exercise none
      // of it. Measured at the moment printToPDF would run, on the document
      // that call would capture.
      await setThemePref(false);
      const readyDark = await beginExport();
      const midDark = await exec(`(() => {
        const opt = document.querySelector('.custom-theme-option[data-mode="dark"]');
        if (opt) opt.click();
        return { clicked: !!opt, bodyDark: document.body.classList.contains('dark-mode') };
      })()`);
      await sleep(2000);
      const atPrintTime = await exec(MEASURE);
      check(
        "8c the mid-export dark toggle really reached an open export",
        readyDark === true && midDark.clicked === true && atPrintTime.measured > 0,
        `ready=${readyDark} clicked=${midDark && midDark.clicked} measured=${atPrintTime.measured}`,
      );
      check(
        "a theme change made during a PDF export cannot re-theme the diagrams it is exporting",
        atPrintTime.bodyDark === false &&
          atPrintTime.worst !== null &&
          atPrintTime.worst.fillLum > 0.5,
        JSON.stringify(atPrintTime),
      );
      await finishExport("hold-dark.pdf");
      await sleep(1500);
      const darkAfterMid = await exec(`document.body.classList.contains('dark-mode')`);
      // The other direction of the pair, and the reason the pair is needed:
      // on its own, "the document is still light" would also be satisfied by a
      // release that did nothing whatsoever. This one requires the release to
      // act, and to act on the preference the reader chose mid-export.
      check(
        "the theme the reader picked during the export is applied once it finishes",
        darkAfterMid === true && midDark.clicked === true,
        `clicked=${midDark && midDark.clicked} after=${darkAfterMid}`,
      );

      // Recording a DECISION, not guarding a defect - raised in review as a
      // "footgun worth fixing at source". It must not be fixed at source.
      //
      // The legacy #darkModeToggle handler writes only the legacy 'darkMode'
      // key and deliberately never 'themeMode'. custom-theme.js owns the
      // preference: it writes it - and the value may be 'desktop' - and only
      // then delegates to this button for the mermaid side effects. A handler
      // that also wrote 'themeMode' would immediately overwrite "Follow
      // Desktop" with the concrete theme it had just resolved, and the app
      // would stop following the OS from that click onward.
      const desktop = await exec(`(() => {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        // Start on the OPPOSITE side so applyTheme('desktop') is forced to
        // delegate; without this the click is skipped and nothing is proven.
        document.body.classList.toggle('dark-mode', !prefersDark);
        const opt = document.querySelector('.custom-theme-option[data-mode="desktop"]');
        if (!opt) return { found: false };
        opt.click();
        return {
          found: true,
          mode: localStorage.getItem('themeMode'),
          delegated: document.body.classList.contains('dark-mode') === prefersDark,
          prefersDark,
          hold: (typeof exportThemeHold === 'number' ? exportThemeHold : 'n/a'),
        };
      })()`);
      check(
        "choosing Follow Desktop survives the toggle it delegates to",
        desktop.found === true && desktop.delegated === true && desktop.mode === "desktop",
        `found=${desktop.found} delegated=${desktop.delegated} mode=${desktop.mode} prefersDark=${desktop.prefersDark} hold=${desktop.hold}`,
      );
    } finally {
      await drainExportHolds();
      await exec(`(async () => {
        localStorage.removeItem('themeMode');
        document.body.classList.remove('dark-mode');
        await updateMermaidTheme(false);
        return true;
      })()`);
      // Hand the suite back the document it was running on. Leaving this
      // section's single-diagram tab active starved section 9, whose measure
      // needs the multi-diagram document, and it failed with measured:0 - a
      // failure that named section 9 but belonged to this one.
      await exec(`(() => {
        const held = window.CustomTabs.getTabs().find(t => t.filePath === ${JSON.stringify(holdDoc)});
        const home = window.CustomTabs.getTabs().find(t => t.filePath === ${jsM});
        if (home) window.CustomTabs.switchToTab(home.id);
        if (held) window.CustomTabs.closeTab(held.id);
        return true;
      })()`);
      await waitFor(exec, "the suite's own document to come back after the 8c exports", DIAGRAMS_READY);
    }
  }

  // --- 8e. Two exports must not overlap -----------------------------------
  // Reachable with two clicks: start an Export as PDF and, while main is
  // printing, reopen the File menu and choose it again. main.js's export-pdf
  // handler has NO re-entrancy guard, and the renderer window stays live and
  // responsive for the whole time main spends in showSaveDialog and
  // printToPDF, so nothing in the product stops the second export starting.
  //
  // Both exports force the document light and then read the page, so whichever
  // one finishes first must NOT restore the reader's theme underneath the one
  // still running - or main prints a dark page for an export that asked for a
  // light one, which is the defect section 8 exists for, reintroduced through
  // the back door. That is the whole reason the renderer COUNTS its export
  // holds rather than keeping a boolean: only the last export out may restore.
  //
  // Driven with the REAL IPC messages main.js sends, in main.js's own order.
  // The fixture is deliberately large and the document is scrolled to the
  // bottom: PERF-07 re-themes the diagrams the reader can SEE and defers the
  // rest to idle chunks, so this keeps the deferred tail non-empty at the
  // moment of measurement instead of letting one screenful of eager work stand
  // in for the whole document.
  {
    const overlapDoc = path.join(dir, "overlap.md");
    fs.writeFileSync(
      overlapDoc,
      "# Overlap\n\n" +
        Array.from(
          { length: 30 },
          (_, i) =>
            `## Part ${i}\n\n` +
            "```mermaid\ngraph TD\n" +
            `  O${i}A[Over ${i} A] --> O${i}B[Over ${i} B]\n` +
            "```\n\n" +
            "filler\n\n".repeat(10),
        ).join(""),
      "utf8",
    );

    try {
      await exec(
        `(() => { const t = window.CustomTabs.createTab(${JSON.stringify(overlapDoc)}, window.fs.readFileSync(${JSON.stringify(overlapDoc)}, 'utf8')); return t.id; })()`,
      );
      await waitFor(exec, "the 8e overlap fixture to finish drawing", DIAGRAMS_READY);
      await exec(`window.alert = () => {}; true`);

      await setThemePref(true);
      await exec(`(() => {
        const w = document.querySelector('.content-wrapper');
        w.scrollTop = w.scrollHeight;
        return w.scrollTop;
      })()`);
      await sleep(1500);

      // Count mermaid.run across BOTH prepares separately. The second export
      // asks for a theme the first has already forced, so it has no rendering
      // work to do - but applyMermaidTheme() has no "already this theme" early
      // return, and renderMermaidBatch writes data-mermaid-src back
      // SYNCHRONOUSLY before awaiting mermaid.run. Without the guard in
      // setExportTheme() the second prepare therefore wipes every visible
      // diagram to raw source text with no <svg> at all, while main may be part
      // way through printToPDF over the live page for export #1.
      //
      // The old section 8f measured that wipe from a renderer task and recorded
      // it as unobservable. That result does NOT transfer to this scenario:
      // printToPDF is driven from the main process and captures painted output,
      // not whatever a renderer microtask can catch between two awaits. So the
      // invariant is pinned structurally instead of by timing - the redundant
      // re-render must not be issued at all, which is both stronger and
      // deterministic.
      await exec(`(() => {
        window.__prep = { calls: 0 };
        const original = mermaid.run.bind(mermaid);
        window.__prepRestore = () => { mermaid.run = original; };
        mermaid.run = async function (...args) {
          window.__prep.calls++;
          return await original(...args);
        };
        return true;
      })()`);

      const ready1 = await beginExport();
      const prep1Calls = await exec(`window.__prep.calls`);
      const ready2 = await beginExport();
      const prep2Calls = (await exec(`window.__prep.calls`)) - prep1Calls;
      await exec(`window.__prepRestore(), true`);
      // The counter IS the overlap: two opens and no release yet. Read BEFORE
      // either result is sent, so it stays a valid witness under any change to
      // the result handler - which matters, because the fix R166 pins lives in
      // that handler.
      const heldBoth = await exec(
        `(typeof exportThemeHold === 'number' ? exportThemeHold : -1)`,
      );

      // The first export finishes while the second is still capturing.
      await finishExport("overlap.pdf");
      await sleep(2000);
      const mid = await exec(MEASURE);

      check(
        "8e the overlapping PDF export really ran to completion",
        ready1 === true && ready2 === true,
        `ready1=${ready1} ready2=${ready2} holds=${heldBoth}`,
      );
      check(
        "8e the two exports genuinely overlapped",
        heldBoth === 2 && mid.measured > 0,
        `holds after both prepares=${heldBoth} measured=${mid.measured} of ${mid.mermaidBlocks} block(s)`,
      );
      // Vacuity guard for the assertion below: if the FIRST prepare had no
      // mermaid work either, "the second issued none" would be satisfied by an
      // export path that never re-themes anything at all.
      check(
        "8e the first export really did have diagrams to re-theme (vacuity guard)",
        prep1Calls > 0,
        `mermaid.run calls during the first export's prepare=${prep1Calls}`,
      );
      check(
        "an export starting on top of another does not re-render diagrams that are already in the export theme",
        prep2Calls === 0,
        `first prepare=${prep1Calls} call(s), second prepare=${prep2Calls} call(s) - the second export asked for the theme the first had already forced, so it must issue no mermaid work at all`,
      );
      check(
        "a concurrent export cannot re-theme the diagrams the export it overlaps is still reading",
        mid.bodyDark === false && mid.worst !== null && mid.worst.fillLum > 0.5,
        JSON.stringify(mid),
      );

      // With two exports of the same kind the two orderings are the same
      // scenario, so the mirror arm the Word-versus-PDF version of this
      // section needed no longer exists as a distinct case. What still needs
      // saying is the other end of the counter: it has to reach zero and
      // actually restore, or "stays light" above would be satisfied by a
      // release that never restores anything at all.
      await finishExport("overlap2.pdf");
      await sleep(2000);
      check(
        "the reader's theme comes back once the last export has finished",
        (await exec(`document.body.classList.contains('dark-mode')`)) === true,
        "both exports are done, so the held preference must have been applied",
      );
      check(
        "two overlapping exports leave no theme hold behind",
        (await exec(`(typeof exportThemeHold === 'number' ? exportThemeHold : -1)`)) === 0,
        "the counter must come back to zero rather than stick or go negative",
      );
    } finally {
      await drainExportHolds();
      await exec(`(async () => {
        localStorage.removeItem('themeMode');
        document.body.classList.remove('dark-mode');
        await updateMermaidTheme(false);
        return true;
      })()`);
      await exec(`(() => {
        const ov = window.CustomTabs.getTabs().find(t => t.filePath === ${JSON.stringify(overlapDoc)});
        const home = window.CustomTabs.getTabs().find(t => t.filePath === ${jsM});
        if (home) window.CustomTabs.switchToTab(home.id);
        if (ov) window.CustomTabs.closeTab(ov.id);
        return true;
      })()`);
      await waitFor(exec, "the suite's own document to come back after the 8e overlap", DIAGRAMS_READY);
    }
  }


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

  // --- 10. Mermaid is loaded lazily, not on every launch -------------------
  // PERF-03: the 3.5MB bundle cost about 128ms of every startup even for
  // documents with no diagrams, which is most of them. It is now injected on
  // first actual need. The saving is only real if it genuinely stays unloaded,
  // and the app is only correct if it genuinely arrives when a diagram appears -
  // so assert both halves.
  //
  // A reload is used to get a clean JS realm: by this point in the suite mermaid
  // has obviously been loaded, and `window.mermaid` is sticky for the lifetime
  // of the page. Clearing the saved tabs first stops the restored session from
  // rendering a diagram during boot and loading it before we can look.
  await exec(`
    (() => {
      window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
      localStorage.clear();
      return true;
    })()
  `);
  await new Promise((resolve) => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.reload();
  });
  // Wait for the app to be genuinely ready rather than guessing. A fixed sleep
  // here would turn any future startup slowdown into a false pass: the
  // "mermaid is not loaded" assertions below are trivially true on a page that
  // has not finished booting.
  await waitFor(
    exec,
    "the reloaded window to finish booting",
    `typeof renderMarkdown === 'function' && !!document.getElementById('viewer')`,
  );

  // A reload rebuilds the JS realm AND its require('electron') module
  // instance, so the external-open trap installed at the top of this suite is
  // destroyed by the line above. MEASURED across this exact reload:
  //   before { flag: true,  openExternalPatched: true  }
  //   after  { flag: false, openExternalPatched: false }
  // Everything after this point used to run with the real opener live, one
  // clicked http link away from launching the user's browser. The trap re-arms
  // itself on did-finish-load; this is the only place in the whole harness
  // where that can be observed, so it is asserted here rather than trusted.
  // Polled, not read once: our re-arm and the suite's own did-finish-load
  // handler fire on the same event, so a single read would be a race.
  const rearmed = await waitForExternalTrap(win);
  check(
    "the external-open trap re-arms itself after a reload, so the rest of the suite still cannot reach the browser",
    rearmed === true,
    String(rearmed),
  );
  const rearmedPatched = await exec(`
    (() => {
      const { shell } = require('electron');
      return {
        openExternal: !/\\[native code\\]/.test(String(shell.openExternal)),
        openPath: !/\\[native code\\]/.test(String(shell.openPath)),
      };
    })()
  `);
  // The marker alone would be a weak oracle - it is set by the same code it is
  // meant to describe. Look at the functions themselves: a native
  // [native code] body means the real shell is back.
  check(
    "the re-armed trap really replaced the shell functions, not just its own marker",
    rearmedPatched.openExternal === true && rearmedPatched.openPath === true,
    JSON.stringify(rearmedPatched),
  );

  const atBoot = await exec(`
    ({ mermaidLoaded: typeof window.mermaid !== 'undefined',
       mermaidLibraryScripts: [...document.querySelectorAll('script[src]')]
         .filter(s => /(?:^|\\/)mermaid\\.min\\.js(?:[?#]|$)/.test(s.src)).length,
       mermaidNamedScripts: [...document.querySelectorAll('script[src]')]
         .map(s => new URL(s.src).pathname.split('/').pop())
         .filter(name => /mermaid/.test(name)).sort(),
       ensureExists: typeof ensureMermaid === 'function' })
  `);
  check(
    "mermaid is not loaded at startup",
    atBoot.mermaidLoaded === false &&
      atBoot.mermaidLibraryScripts === 0 &&
      JSON.stringify(atBoot.mermaidNamedScripts) === JSON.stringify(["mermaid-config.js"]),
    JSON.stringify(atBoot),
  );
  check(
    "the lazy loader is present to fetch it later",
    atBoot.ensureExists === true,
    JSON.stringify(atBoot),
  );

  // A document with no diagrams must not drag it in either. Wait for the render
  // to actually complete before concluding mermaid stayed away - a fixed sleep
  // that expired mid-render would pass for the wrong reason.
  await exec(`renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full')`);
  await waitFor(
    exec,
    "the plain document to finish rendering",
    `document.getElementById('viewer').textContent.trim().startsWith('Plain')`,
  );
  check(
    "a document with no diagrams does not load mermaid",
    (await exec(`typeof window.mermaid !== 'undefined'`)) === false,
    "mermaid was loaded while rendering a plain markdown document",
  );

  // A document WITH a diagram must load it, initialise it, and draw.
  await exec(`renderMarkdown(window.fs.readFileSync(${jsM}, 'utf8'), 'full')`);
  await waitFor(exec, "the lazily loaded mermaid to draw", DIAGRAMS_READY);
  const afterDiagram = await exec(`
    ({ loaded: typeof window.mermaid !== 'undefined',
       api: typeof window.mermaid === 'undefined' ? null : typeof mermaid.run,
       svgs: document.querySelectorAll('#viewer .mermaid svg').length })
  `);
  check(
    "opening a document with a diagram loads mermaid on demand and renders it",
    afterDiagram.loaded === true &&
      afterDiagram.api === "function" &&
      afterDiagram.svgs > 0,
    JSON.stringify(afterDiagram),
  );

  // --- 11. A superseded render must not resume and edit the new document ----
  // Making the bundle lazy inserted a new suspension point into
  // renderMarkdownFull: `await ensureMermaid()`. The previous stale-render check
  // sits above it, so a render that loses the race while parked there used to
  // wake up and run the rest of the function - TOC build, collapsible headers,
  // image zoom setup, and a scroll reset - against whatever document had since
  // won. Measured before the fix: the user's scroll position was slammed from
  // 400 back to 0 and the table of contents was rebuilt a second time.
  //
  // The eager build had no such window: it entered the mermaid mutex
  // synchronously right after patchViewerDOM, so there was nothing to lose a
  // race to. This is a regression introduced by PERF-03 and it is why the two
  // generation checks around the mermaid block exist.
  //
  // ensureMermaid is parked on a deferred rather than raced against a real
  // 3.5MB fetch, so the test is deterministic instead of timing-dependent.
  const realTypes = await exec(`
    (() => {
      window.__saved = { ensure: window.ensureMermaid, mermaid: window.mermaid,
                         toc: window.buildTableOfContents };
      window.__parked = false;
      window.__tocCalls = [];
      window.ensureMermaid = () => {
        window.__parked = true;
        return new Promise(res => { window.__release = res; });
      };
      window.buildTableOfContents = function () {
        window.__tocCalls.push(1);
        return window.__saved.toc.apply(this, arguments);
      };
      // Counted separately from the TOC: the check immediately after
      // ensureMermaid exists specifically to stop a losing render from driving
      // the mermaid engine over nodes that patchViewerDOM has already detached.
      // Without its own assertion, the later check would mask it and the first
      // one could be deleted with the suite still green.
      window.__runCalls = 0;
      window.__saved.run = window.mermaid.run;
      window.mermaid.run = function (...a) {
        window.__runCalls++;
        return window.__saved.run.apply(this, a);
      };
      return { ensure: typeof window.__saved.ensure, toc: typeof window.__saved.toc,
               run: typeof window.__saved.run };
    })()
  `);
  check(
    "the race probe patched real functions, not undefined",
    realTypes.ensure === "function" &&
      realTypes.toc === "function" &&
      realTypes.run === "function",
    JSON.stringify(realTypes) + " - if any is undefined the section below " +
      "cannot fail and is vacuous",
  );

  // Render A: a diagram document, which parks inside the stubbed ensureMermaid.
  exec(`renderMarkdown(window.fs.readFileSync(${jsRace}, 'utf8'), 'full')`).catch(() => {});
  await waitFor(exec, "the losing render to park inside ensureMermaid", `window.__parked === true`);

  // Render B supersedes it, and the user scrolls down in that new document.
  await exec(`renderMarkdown(window.fs.readFileSync(${jsLong}, 'utf8'), 'full')`);
  await waitFor(
    exec,
    "the winning render to settle",
    `document.getElementById('viewer').textContent.trim().startsWith('Long')`,
  );
  const staged = await exec(`
    (() => {
      const sc = document.getElementById('viewer').parentElement;
      sc.scrollTop = 400;
      return { scrollTop: sc.scrollTop, tocCalls: window.__tocCalls.length,
               runCalls: window.__runCalls };
    })()
  `);
  check(
    "the race fixture actually scrolled, so a reset would be detectable",
    staged.scrollTop > 0,
    JSON.stringify(staged) + " - the long fixture did not produce a scrollbar",
  );

  await exec(`window.__release(); null`);
  await sleep(1500);
  const afterStale = await exec(`
    ({ scrollTop: document.getElementById('viewer').parentElement.scrollTop,
       tocCalls: window.__tocCalls.length,
       runCalls: window.__runCalls,
       text: document.getElementById('viewer').textContent.trim().slice(0, 4) })
  `);
  check(
    "a superseded render does not drive mermaid over its detached nodes",
    afterStale.runCalls === staged.runCalls,
    JSON.stringify({ staged, afterStale }),
  );
  check(
    "a superseded render does not reset the winning document's scroll position",
    afterStale.scrollTop === staged.scrollTop,
    JSON.stringify({ staged, afterStale }),
  );
  check(
    "a superseded render does not rebuild the winning document's contents",
    afterStale.tocCalls === staged.tocCalls,
    JSON.stringify({ staged, afterStale }),
  );

  await exec(`
    (() => {
      window.ensureMermaid = window.__saved.ensure;
      window.mermaid = window.__saved.mermaid;
      window.mermaid.run = window.__saved.run;
      window.buildTableOfContents = window.__saved.toc;
      return true;
    })()
  `);

  // --- 11b. The same race, but lost inside mermaid.run --------------------
  // Once the bundle is loaded, ensureMermaid resolves immediately and the check
  // above it cannot fire. The remaining exposure is the mutex plus the draw
  // itself, which is where the time actually goes on a diagram-heavy document.
  // This scenario supersedes the render there instead, so the second generation
  // check has coverage of its own; without it the first check masks it entirely
  // and it could be deleted with the suite still green.
  const race2Ready = await exec(`
    (() => {
      window.__parked2 = false;
      window.__tocCalls2 = 0;
      window.__savedRun2 = window.mermaid.run;
      window.__savedToc2 = window.buildTableOfContents;
      window.mermaid.run = function (...a) {
        window.__parked2 = true;
        // Resolves without drawing rather than deferring to the real engine.
        // Drawing detached nodes throws, and the guard in the catch block would
        // then be what stops the damage - masking the check this scenario is
        // meant to cover. A successful draw whose render simply lost the race
        // is also the more faithful case.
        return new Promise(res => { window.__release2 = () => res(); });
      };
      window.buildTableOfContents = function () {
        window.__tocCalls2++;
        return window.__savedToc2.apply(this, arguments);
      };
      return typeof window.__savedRun2 === 'function' &&
             typeof window.__savedToc2 === 'function';
    })()
  `);
  check(
    "the second race probe patched real functions, not undefined",
    race2Ready === true,
    "mermaid.run or buildTableOfContents was not a function; the section " +
      "below would be vacuous",
  );

  exec(`renderMarkdown(window.fs.readFileSync(${jsRace2}, 'utf8'), 'full')`).catch(() => {});
  await waitFor(exec, "the losing render to park inside mermaid.run", `window.__parked2 === true`);

  await exec(`renderMarkdown(window.fs.readFileSync(${jsLong}, 'utf8'), 'full')`);
  await waitFor(
    exec,
    "the winning render to settle",
    `document.getElementById('viewer').textContent.trim().startsWith('Long')`,
  );
  const staged2 = await exec(`
    (() => {
      const sc = document.getElementById('viewer').parentElement;
      sc.scrollTop = 400;
      return { scrollTop: sc.scrollTop, tocCalls: window.__tocCalls2 };
    })()
  `);
  check(
    "the second race fixture actually scrolled, so a reset would be detectable",
    staged2.scrollTop > 0,
    JSON.stringify(staged2),
  );

  await exec(`window.__release2(); null`);
  await sleep(1500);
  const afterStale2 = await exec(`
    ({ scrollTop: document.getElementById('viewer').parentElement.scrollTop,
       tocCalls: window.__tocCalls2 })
  `);
  check(
    "a render superseded while drawing does not reset the new scroll position",
    afterStale2.scrollTop === staged2.scrollTop,
    JSON.stringify({ staged2, afterStale2 }),
  );
  check(
    "a render superseded while drawing does not rebuild the new contents",
    afterStale2.tocCalls === staged2.tocCalls,
    JSON.stringify({ staged2, afterStale2 }),
  );

  await exec(`
    (() => {
      window.mermaid.run = window.__savedRun2;
      window.buildTableOfContents = window.__savedToc2;
      return true;
    })()
  `);

  // --- 11c. A stale render must not paint its failure over the winner ------
  // The catch block rewrites every .mermaid element that has no <svg> yet with a
  // red error card. Those elements belong to whatever document is on screen now,
  // not to the render that failed - so a losing render that throws (a missing
  // bundle, a draw over nodes patchViewerDOM already detached) used to deface
  // the winning document's diagrams while they were still being drawn.
  //
  // Staging that needs the winner's diagrams on screen but not yet drawn. The
  // mermaid mutex provides exactly that: the winner patches its DOM, then
  // queues behind the loser's parked draw, so its .mermaid blocks sit there
  // empty and defaceable for as long as the loser is stuck.
  const race3Ready = await exec(`
    (() => {
      window.__parkedA = false;
      window.__parkedB = false;
      window.__savedRun3 = window.mermaid.run;
      window.mermaid.run = function (...a) {
        if (!window.__parkedA) {
          window.__parkedA = true;
          return new Promise((res, rej) => {
            window.__failA = () => rej(new Error('stale draw failed'));
          });
        }
        if (!window.__parkedB) {
          window.__parkedB = true;
          return new Promise((res) => {
            window.__finishB = () => res(window.__savedRun3.apply(window.mermaid, a));
          });
        }
        return window.__savedRun3.apply(window.mermaid, a);
      };
      // Both fixtures must actually reach the engine; a cache hit would leave
      // toRender empty, skip mermaid.run entirely and never park.
      mermaidSvgCache.clear();
      return typeof window.__savedRun3 === 'function';
    })()
  `);
  check(
    "the third race probe patched a real mermaid.run",
    race3Ready === true,
    "mermaid.run was not a function; the section below would be vacuous",
  );

  // This section makes a render fail on purpose, so the "stale draw failed"
  // console error below is the scenario working. Muted narrowly rather than
  // added to the sentinel's ignore list: an ignore pattern would hide that
  // message for the whole suite, including the places it would be a real bug.
  await sentinel.mute("deliberate stale-draw failure (race probe 3)");

  exec(`renderMarkdown(window.fs.readFileSync(${jsRace}, 'utf8'), 'full')`).catch(() => {});
  await waitFor(exec, "the losing render to park in its draw", `window.__parkedA === true`);
  exec(`renderMarkdown(window.fs.readFileSync(${jsRace2}, 'utf8'), 'full')`).catch(() => {});
  await waitFor(
    exec,
    "the winning render's undrawn diagrams to reach the DOM",
    `(() => {
       const v = document.getElementById('viewer');
       // Keyed on the WINNER's own heading. Waiting only for "a .mermaid with
       // no svg" is satisfied immediately by the loser's own parked diagram,
       // so the loser's catch then defaces its own element and the winner's
       // patchViewerDOM overwrites the evidence - the bug stays invisible.
       if (!v.textContent.includes('Race2')) return false;
       const b = [...v.querySelectorAll('.mermaid')];
       return b.length > 0 && b.every(x => !x.querySelector('svg'));
     })()`,
  );

  // Failing A is what releases the mutex, so B can only park after this point -
  // waiting for __parkedB before failing A would hang forever. Parking B is what
  // makes the ordering deterministic: without it, B's draw and A's catch race,
  // and when B wins it fills in the <svg> that makes A's catch skip the element.
  // The bug then hides behind a coin flip.
  await exec(`window.__failA(); null`);
  await waitFor(exec, "the winner's draw to start while its diagram is undrawn", `window.__parkedB === true`);
  const beforeFail = await exec(`
    ({ blocks: document.querySelectorAll('#viewer .mermaid').length,
       drawn: [...document.querySelectorAll('#viewer .mermaid')].filter(x => x.querySelector('svg')).length })
  `);
  check(
    "the winner has undrawn diagrams on screen, so defacing them is possible",
    beforeFail.blocks > 0 && beforeFail.drawn === 0,
    JSON.stringify(beforeFail) + " - nothing defaceable, section is vacuous",
  );

  await exec(`window.__finishB(); null`);
  await waitFor(exec, "the winning diagram to finish drawing", DIAGRAMS_READY);
  // Asserting on the winner's actual diagram content rather than on the error
  // card. Measured without the guard: the stale render replaced the winner's
  // diagram source with its red error card, the winner's own draw then choked
  // on that HTML ("No diagram type detected matching given configuration for
  // text: <div style='color: red...'>") and mermaid substituted its own error
  // graphic - which removes the card again. Counting cards therefore reports
  // clean on a document whose diagram has been destroyed.
  const afterFail = await exec(`
    (() => {
      const svg = document.querySelector('#viewer .mermaid svg');
      return { text: svg ? svg.textContent : null,
               cards: document.body.innerHTML.split('Mermaid Rendering Error').length - 1 };
    })()
  `);
  check(
    "a failed stale render does not corrupt the winner's diagram",
    afterFail.cards === 0 &&
      typeof afterFail.text === "string" &&
      afterFail.text.includes("RaceTwo1") &&
      afterFail.text.includes("RaceTwo2"),
    JSON.stringify({ beforeFail, afterFail }),
  );
  await sentinel.unmute();
  await exec(`window.mermaid.run = window.__savedRun3; true`);

  // ==========================================================================
  // PERF-07 - a theme toggle must not block on diagrams the user cannot see
  //
  // The old code re-themed every diagram in one synchronous batch (431.6ms on
  // 20 diagrams, all of it before the first repaint). It now renders the
  // on-screen ones, resolves, and catches the rest up during idle time.
  //
  // These assertions are about *correctness of the split*, not speed: the
  // visible ones must be right when the toggle resolves, and every one of them
  // must be right once whenMermaidSettled() resolves. A timing assertion would
  // be flaky on shared CI; a wrong-colour diagram never is.
  // ==========================================================================
  const perfDoc =
    "# PerfSeven\n\n" +
    Array.from({ length: 14 }, (_, i) =>
      `## Section ${i}\n\n` +
      "```mermaid\ngraph TD\n" +
      `  P${i}A[Perf ${i} A] --> P${i}B[Perf ${i} B]\n` +
      "```\n\n" +
      "filler\n\n".repeat(12),
    ).join("");
  const jsPerf = JSON.stringify(path.join(dir, "perf07.md"));
  fs.writeFileSync(JSON.parse(jsPerf), perfDoc, "utf8");

  // Start from a known light state and the top of the document.
  await exec(`
    (async () => {
      if (document.body.classList.contains('dark-mode')) {
        document.getElementById('darkModeToggle').click();
      }
      await window.renderMarkdown(window.fs.readFileSync(${jsPerf}, 'utf8'), 'full');
      document.querySelector('.content-wrapper').scrollTop = 0;
      return null;
    })()
  `);
  await waitFor(exec, "the PERF-07 fixture to finish drawing", DIAGRAMS_READY);
  await exec(`whenMermaidSettled(); null`);

  // Per-block fill luminance: dark theme means a dark node box.
  const FILLS = `
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
      const wrapper = document.querySelector('.content-wrapper');
      const out = [];
      document.querySelectorAll('#viewer .mermaid').forEach((b, i) => {
        const shape = b.querySelector('g.node rect, g.node path, g.node polygon');
        const r = b.getBoundingClientRect();
        out.push({
          i: i,
          onScreen: r.bottom > 0 && r.top < window.innerHeight,
          drawn: !!b.querySelector('svg'),
          lum: shape ? lum(getComputedStyle(shape).fill) : null
        });
      });
      return { blocks: out.length, scrollTop: wrapper.scrollTop, items: out };
    })()
  `;

  const perfBefore = await exec(FILLS);
  check(
    "PERF-07 fixture has enough off-screen diagrams for the split to matter",
    perfBefore.blocks >= 10 &&
      perfBefore.items.filter((x) => x.onScreen).length < perfBefore.blocks &&
      perfBefore.items.every((x) => x.drawn),
    JSON.stringify({
      blocks: perfBefore.blocks,
      onScreen: perfBefore.items.filter((x) => x.onScreen).length,
      undrawn: perfBefore.items.filter((x) => !x.drawn).length,
    }),
  );

  // Toggle to dark and inspect the moment updateMermaidTheme() resolves.
  const atResolve = await exec(`
    (async () => {
      document.body.classList.add('dark-mode');
      await updateMermaidTheme(true);
      return (${FILLS});
    })()
  `);
  const visAtResolve = atResolve.items.filter((x) => x.onScreen);
  check(
    "PERF-07 on-screen diagrams are already re-themed when the toggle resolves",
    visAtResolve.length > 0 && visAtResolve.every((x) => x.lum !== null && x.lum < 0.3),
    JSON.stringify(visAtResolve),
  );

  await exec(`whenMermaidSettled()`);
  const afterSettle = await exec(FILLS);
  check(
    "PERF-07 every diagram is re-themed once whenMermaidSettled() resolves",
    afterSettle.items.length === perfBefore.blocks &&
      afterSettle.items.every((x) => x.drawn && x.lum !== null && x.lum < 0.3),
    JSON.stringify(afterSettle.items.filter((x) => !(x.lum !== null && x.lum < 0.3))),
  );

  // A second toggle while the catch-up chain is mid-flight must abandon it.
  // Without the generation check the stale chain would keep painting dark
  // diagrams into a light document.
  await exec(`
    (async () => {
      document.body.classList.add('dark-mode');
      updateMermaidTheme(true);
      document.body.classList.remove('dark-mode');
      await updateMermaidTheme(false);
      return null;
    })()
  `);
  await exec(`whenMermaidSettled()`);
  await sleep(1500); // let any abandoned chunk chain do its worst
  const afterSupersede = await exec(FILLS);
  check(
    "PERF-07 a superseded catch-up pass leaves no wrong-theme diagram behind",
    afterSupersede.items.length === perfBefore.blocks &&
      afterSupersede.items.every((x) => x.drawn && x.lum !== null && x.lum > 0.6),
    JSON.stringify(
      afterSupersede.items.filter((x) => !(x.lum !== null && x.lum > 0.6)),
    ),
  );

  // And the cache must agree with what is on screen, or the next render of the
  // same document would repaint the abandoned theme from cache.
  const cacheOk = await exec(`
    (() => {
      const svgs = [...mermaidSvgCache.values()];
      return {
        entries: svgs.length,
        darkish: svgs.filter(s => /#1f2020|#0b0b0b|rgb\\(31, ?32, ?32\\)/i.test(s)).length
      };
    })()
  `);
  check(
    "PERF-07 the SVG cache holds no diagrams from the abandoned dark pass",
    cacheOk.entries > 0 && cacheOk.darkish === 0,
    JSON.stringify(cacheOk),
  );

  // The end-to-end supersede case above is guarded twice over: scheduleMermaid-
  // CatchUp() cancels the pending idle callback, which hides whether the
  // generation token works at all. The token covers the window the cancel
  // cannot - a chunk already queued on the mermaid mutex, whose .then() would
  // otherwise re-arm the abandoned chain and clobber the live one's handle.
  // That window is timing-dependent end to end, so it is tested directly.
  const staleRun = await exec(`
    (async () => {
      const nodes = [...document.querySelectorAll('#viewer .mermaid')];
      const before = nodes.map(n => n.innerHTML);
      // Hand the scheduler a generation that has already been superseded.
      scheduleMermaidCatchUp(mermaidRunSeq - 1, nodes.slice());
      await new Promise(r => setTimeout(r, 1500));
      return {
        count: nodes.length,
        changed: nodes.filter((n, i) => n.innerHTML !== before[i]).length
      };
    })()
  `);
  check(
    "PERF-07 a catch-up pass from a superseded generation renders nothing",
    staleRun.count > 0 && staleRun.changed === 0,
    JSON.stringify(staleRun),
  );

  // --- 8d. An export must wait for the deferred tail, not just the fold ----
  // Lives here rather than beside the other export sections because it needs
  // PERF-07's fixture: 10+ diagrams with some off screen. Sections 8b and 8c
  // each hold a single visible diagram, so neither can see this failure, and
  // both stayed green while it was live - it was found in independent review.
  //
  // PERF-07 deliberately re-themes only what the reader can see and defers the
  // rest to idle chunks, so updateMermaidTheme() resolving means "the visible
  // ones are done". An export reads the WHOLE document. Without a settle wait
  // it captures a MIXTURE: the diagrams above the fold in the export theme,
  // the ones below still wearing the reader's.
  //
  // The oracle is the real export entry point (setExportTheme, now reached only
  // from the PDF handler's two halves), measured at the instant it
  // resolves - not after an extra sleep, which would let the catch-up finish
  // on its own and make the assertion pass for the wrong reason.
  {
    await exec(`
      (async () => {
        document.getElementById('viewer').parentElement.scrollTop = 0;
        document.body.classList.add('dark-mode');
        await updateMermaidTheme(true);
        await whenMermaidSettled();
        return null;
      })()
    `);
    const allDark = await exec(FILLS);
    check(
      "8d the fixture really is all-dark and has diagrams below the fold",
      allDark.items.length >= 10 &&
        allDark.items.filter((x) => !x.onScreen).length > 0 &&
        allDark.items.every((x) => x.lum !== null && x.lum < 0.3),
      JSON.stringify({
        blocks: allDark.items.length,
        offScreen: allDark.items.filter((x) => !x.onScreen).length,
        notDark: allDark.items.filter((x) => !(x.lum !== null && x.lum < 0.3)).length,
      }),
    );

    const atExportReady = await exec(`
      (async () => {
        await setExportTheme(false);
        return (${FILLS});
      })()
    `);
    const stale = atExportReady.items.filter((x) => !(x.lum !== null && x.lum > 0.6));
    check(
      "every diagram below the fold is re-themed before an export reads it",
      atExportReady.items.length === allDark.items.length && stale.length === 0,
      `${stale.length} of ${atExportReady.items.length} still on the reader's theme when the ` +
        `export was told the document was ready: ${JSON.stringify(stale)}`,
    );

    await exec(`
      (async () => {
        document.body.classList.remove('dark-mode');
        await updateMermaidTheme(false);
        await whenMermaidSettled();
        return null;
      })()
    `);
  }

  // --- 13. Upstream 03b5423: batch resilience, error sink, lifelines --------
  // Three independent claims from that commit, measured against THIS fork
  // before any of it is ported. The fork is on mermaid 11.16.0 while the commit
  // was written against 10.6.1, so redundancy is a real possibility and is
  // checked rather than assumed.

  // (a) One unparseable diagram must not cost a VALID diagram its pop-out
  //     button. The maximize-button loop runs after mermaid.run(), so a throw
  //     there skips it for every diagram in the document, not just the bad one.
  await sentinel.mute("13a: document deliberately contains an invalid diagram");
  let mixed;
  try {
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsMixed}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    // No DIAGRAMS_READY wait: by construction one block never produces an SVG.
    await exec(`whenMermaidSettled(); null`).catch(() => {});
    await sleep(1200);
    mixed = await exec(`
      (() => {
        const blocks = [...document.querySelectorAll('#viewer .mermaid')];
        return {
          blocks: blocks.length,
          items: blocks.map(b => ({
            good: /MixedGood/.test(b.textContent) || /MixedGood/.test(b.innerHTML),
            hasSvg: !!b.querySelector('svg'),
            inContainer: !!b.closest('.mermaid-container'),
            hasMaxBtn: !!(b.closest('.mermaid-container') &&
                          b.closest('.mermaid-container').querySelector('.mermaid-maximize-btn'))
          }))
        };
      })()
    `);
    // Clear the deliberate failure off the screen INSIDE the mute. The error
    // graphic lives in the DOM until the next render, so unmuting first would
    // hand the sentinel a genuine finding it was never opened for.
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  const goodBlocks = (mixed.items || []).filter((x) => x.good && x.hasSvg);
  check(
    "13a fixture really does mix one rendered diagram with one failure",
    mixed.blocks === 2 && goodBlocks.length === 1,
    JSON.stringify(mixed),
  );
  check(
    "a diagram that rendered keeps its pop-out button when a sibling fails",
    goodBlocks.length === 1 && goodBlocks[0].inContainer && goodBlocks[0].hasMaxBtn,
    JSON.stringify(mixed),
  );

  // (b) The failure path writes error.message into innerHTML, and mermaid's
  //     "no diagram type detected" message quotes the diagram SOURCE back. That
  //     makes document content an HTML sink in the Node-privileged renderer.
  await sentinel.mute("13b: document deliberately contains an invalid diagram");
  let inject;
  try {
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsInject}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await exec(`whenMermaidSettled(); null`).catch(() => {});
    await sleep(1200);
    inject = await exec(`
      (() => {
        const probe = document.getElementById('mermaid-inject-probe');
        const blocks = [...document.querySelectorAll('#viewer .mermaid')];
        return {
          injected: !!probe,
          // The literal source must still be VISIBLE to the reader as text -
          // escaping it must not silently delete the diagnostic.
          textShown: blocks.some(b => b.textContent.includes('mermaid-inject-probe')),
          reported: blocks.some(b => /error/i.test(b.textContent))
        };
      })()
    `);
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    "a failed diagram cannot inject markup from its own source into the page",
    inject.injected === false,
    JSON.stringify(inject),
  );
  check(
    "a failed diagram still reports the failure to the reader",
    inject.reported === true,
    JSON.stringify(inject),
  );

  // (b2) The natural failure above never reaches renderer.js's own error banner,
  //      because mermaid draws an error SVG for the block and the banner only
  //      fills blocks that have none. That makes the banner's sink easy to leave
  //      untested and easy to reintroduce, so it is driven directly: force
  //      mermaid.run to throw a message carrying markup - exactly the shape
  //      mermaid produces when it quotes a diagram's source back - and check
  //      what the banner does with it.
  await sentinel.mute("13b2: mermaid.run forced to throw");
  let banner;
  try {
    banner = await exec(`
      (async () => {
        const realRun = mermaid.run;
        window.__realMermaidRun = realRun;
        mermaid.run = async () => {
          throw new Error('boom <i id="mermaid-banner-probe">injected</i> boom');
        };
        try {
          await window.renderMarkdown(window.fs.readFileSync(${jsRace}, 'utf8'), 'full');
        } catch (e) {
        } finally {
          mermaid.run = realRun;
          delete window.__realMermaidRun;
        }
        await new Promise(r => setTimeout(r, 600));
        const blocks = [...document.querySelectorAll('#viewer .mermaid')];
        const box = document.querySelector('#viewer .mermaid .mermaid-error');
        const strong = box ? box.querySelector('strong') : null;
        const out = {
          blocks: blocks.length,
          injected: !!document.getElementById('mermaid-banner-probe'),
          // The reader must still see the diagnostic, markup and all, as text.
          textShown: blocks.some(b => b.textContent.includes('mermaid-banner-probe')),
          labelled: blocks.some(b => /Mermaid Rendering Error/.test(b.textContent)),
          // N13. The banner is built from nodes and styled from a class - the
          // five box.style.* assignments it replaces were a fixed red on a
          // fixed light pink, unreadable on the three dark themes.
          box: !!box,
          // It REPLACED the diagram's contents rather than being appended
          // beside the source text mermaid failed to draw.
          parentIsMermaid: box ? box.parentElement.classList.contains('mermaid') : null,
          parentNodes: box ? box.parentElement.childNodes.length : -1,
          role: box ? box.getAttribute('role') : null,
          label: strong ? strong.textContent : null,
          // Exactly <strong> and <br>. Anything the message spelled would show
          // up here as a third element.
          boxChildren: box ? box.children.length : -1,
          elementsFromMessage: box ? box.querySelectorAll('i, img, script').length : -1,
          // Nothing is left on the style attribute. This is the conjunct the
          // CSSOM assignments would fail; every other one above is equally
          // satisfied by the old hardcoded version.
          inlineStyle: box ? box.getAttribute('style') : 'NO-ELEMENT'
        };

        // Theming, read under two schemes. try/finally rather than straight
        // line: a throw in a read would otherwise leave data-theme on
        // 'clarity' for every scenario appended after this one.
        const themeBefore = document.body.getAttribute('data-theme');
        const readColours = () => {
          if (!box) return null;
          const cs = getComputedStyle(box);
          return {
            fg: cs.color,
            // Non-vacuity control: a misspelt var() is invalid at
            // computed-value time and the element INHERITS, and the inherited
            // colour also differs between themes - so "fg differs across
            // themes" alone would still pass. The parent <pre class="mermaid">
            // is also the surface whose --surface-raised background this
            // banner's contrast was measured against.
            inherited: getComputedStyle(box.parentElement).color,
            // No fill, deliberately and measurably: a tinted fill was swept on
            // THIS backdrop and A=0 is the maximum (see the rule's comment in
            // styles.css). Nothing else observes the absence.
            bg: cs.backgroundColor,
            // The panel the banner is pasted onto. The old pink was an opaque
            // #ffe6e6 and measured 11.6-13.8 against this on the dark themes.
            panel: getComputedStyle(box.parentElement).backgroundColor,
            // Width and style, never border-top-COLOR: its initial value is
            // currentcolor, so a deleted border declaration still reports the
            // element's own colour and the conjunct could only fail once the
            // colour check already had. Width is device-snapped, so it is only
            // pinned non-zero.
            borderW: parseFloat(cs.borderTopWidth),
            borderS: cs.borderTopStyle
          };
        };
        try {
          document.body.setAttribute('data-theme', 'abyss');
          out.abyss = readColours();
          document.body.setAttribute('data-theme', 'clarity');
          out.clarity = readColours();
        } finally {
          if (themeBefore === null) {
            document.body.removeAttribute('data-theme');
          } else {
            document.body.setAttribute('data-theme', themeBefore);
          }
        }
        out.themeRestored = document.body.getAttribute('data-theme') === themeBefore;
        return out;
      })()
    `);
    await exec(`
      (async () => {
        // Belt and braces for the monkey-patch above: the in-page try/finally
        // only runs if the IIFE itself starts. If exec() rejects before that,
        // mermaid.run would stay patched for every later scenario.
        if (window.__realMermaidRun) { mermaid.run = window.__realMermaidRun; delete window.__realMermaidRun; }
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    "13b2 the forced throw really reached the error banner",
    banner.blocks > 0 && banner.labelled === true,
    JSON.stringify(banner),
  );
  check(
    "the error banner renders a hostile message as text, not as markup",
    banner.injected === false && banner.textShown === true,
    JSON.stringify(banner),
  );
  // N13. The five box.style.* assignments this replaces satisfied every
  // conjunct above - the escaping half was already done. What they could not
  // satisfy is inlineStyle === null, which is why it is here.
  check(
    "N13 the mermaid failure banner replaces the diagram, built from nodes and styled from a class",
    banner.box === true &&
      banner.parentIsMermaid === true &&
      banner.parentNodes === 1 &&
      banner.role === "alert" &&
      banner.label === "Mermaid Rendering Error:" &&
      banner.boxChildren === 2 &&
      banner.elementsFromMessage === 0 &&
      banner.inlineStyle === null,
    JSON.stringify(banner),
  );
  // The defect itself. `red` on `#ffe6e6` measured a flat 3.37 in every theme
  // - opaque, so backdrop-independent - against 3.66/3.60/5.03/5.55/6.19/5.57
  // for --danger-fg on the --surface-raised panel this banner is pasted onto.
  // The pink measured 11.6-13.8 against that panel on the three dark themes.
  //
  // `fg !== inherited` is the load-bearing conjunct: a misspelt var() is
  // invalid at computed-value time, so the element would INHERIT, and the
  // inherited colour differs per theme too - "the two themes disagree" alone
  // would still pass.
  check(
    "N13 the mermaid failure banner is themed, and tracks the active theme",
    !!banner.abyss &&
      !!banner.clarity &&
      banner.abyss.fg !== "rgb(255, 0, 0)" &&
      banner.clarity.fg !== "rgb(255, 0, 0)" &&
      banner.abyss.fg !== banner.abyss.inherited &&
      banner.clarity.fg !== banner.clarity.inherited &&
      banner.abyss.fg !== banner.clarity.fg &&
      banner.abyss.bg === "rgba(0, 0, 0, 0)" &&
      banner.clarity.bg === "rgba(0, 0, 0, 0)" &&
      banner.abyss.panel !== banner.clarity.panel &&
      banner.abyss.borderW > 0 &&
      banner.abyss.borderS === "solid" &&
      banner.themeRestored === true,
    JSON.stringify(banner),
  );

  // (d) The theme path has the same batch shape, and a worse failure: its catch
  //     falls back to a FULL document re-render. With suppressErrors:false, one
  //     invalid diagram therefore makes every dark/light toggle re-render the
  //     whole document for as long as that diagram is in the file.
  await sentinel.mute("13d: document deliberately contains an invalid diagram");
  let themed;
  try {
    await exec(`
      (async () => {
        if (document.body.classList.contains('dark-mode')) {
          document.body.classList.remove('dark-mode');
        }
        const src = window.fs.readFileSync(${jsMixed}, 'utf8');
        await window.renderMarkdown(src, 'full');
        // The fallback re-render is guarded by originalMarkdown, and calling
        // renderMarkdown() directly never sets it. Without this line the
        // guard is falsy, the fallback cannot fire, and the assertion below
        // passes with the defect present - measured, it did exactly that.
        window.originalMarkdown = src;
        return null;
      })()
    `).catch(() => {});
    await exec(`whenMermaidSettled(); null`).catch(() => {});
    await sleep(800);
    themed = await exec(`
      (async () => {
        const lum = (c) => {
          const m = String(c).match(/[\\d.]+/g);
          if (!m || m.length < 3) return null;
          const v = m.slice(0, 3).map(Number).map(x => {
            x = x / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        };
        // renderGeneration is the observable, NOT a patched window.renderMarkdown:
        // renderMarkdown() does ++renderGeneration as its first statement, so the
        // delta is exact and synchronous. A patched window.renderMarkdown was
        // tried first and counted 0 even with the defect present, so it is not
        // trustworthy here.
        //
        // The fixture above must also seed originalMarkdown - see the comment
        // there. Both facts were established by instrumenting the real path
        // (console.warn fired, mermaid.run threw) rather than by reading code.
        const genBefore = renderGeneration;
        document.body.classList.add('dark-mode');
        await updateMermaidTheme(true);
        await whenMermaidSettled();
        await new Promise(r => setTimeout(r, 300));
        const fullRenders = renderGeneration - genBefore;
        // The observable is only exact while the increment really is the first
        // statement. If a refactor moves anything in front of it - especially
        // anything awaited - this scenario silently becomes a race that always
        // reads 0 and therefore always passes.
        const observableIsSynchronous =
          /^[^{]*\\{\\s*(\\/\\/[^\\n]*\\n\\s*)*(const|let|var)\\s+\\w+\\s*=\\s*\\+\\+renderGeneration/.test(
            String(window.renderMarkdown)
          );
        const good = [...document.querySelectorAll('#viewer .mermaid')]
          .find(b => /MixedGood/.test(b.innerHTML));
        const shape = good && good.querySelector('g.node rect, g.node path, g.node polygon');
        return {
          fullRenders,
          observableIsSynchronous,
          goodFound: !!good,
          goodLum: shape ? lum(getComputedStyle(shape).fill) : null
        };
      })()
    `);
    await exec(`
      (async () => {
        document.body.classList.remove('dark-mode');
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    "13d's render observable is still the synchronous first statement",
    themed.observableIsSynchronous === true,
    JSON.stringify(themed),
  );
  check(
    "a theme toggle does not re-render the whole document just because a diagram is invalid",
    themed.fullRenders === 0,
    JSON.stringify(themed),
  );
  check(
    "a valid diagram is still re-themed when an invalid sibling is present",
    themed.goodFound === true && themed.goodLum !== null && themed.goodLum < 0.3,
    JSON.stringify(themed),
  );

  // (c) Sequence-diagram actor lifelines. Upstream carries an id-based
  //     !important override as a stated workaround for a mermaid 10.6.1 bug
  //     (.attr("class","actor-line") overwritten by .attr("class","200")).
  //     Whether that bug still exists on 11.16.0 decides whether the override
  //     is a fix or an unnecessary hard-coded colour fighting the theme.
  await exec(`
    (async () => {
      await window.renderMarkdown(window.fs.readFileSync(${jsSeq}, 'utf8'), 'full');
      return null;
    })()
  `);
  await waitFor(exec, "the sequence fixture to draw", DIAGRAMS_READY);
  await exec(`whenMermaidSettled(); null`);
  const lifelines = await exec(`
    (() => {
      const svg = document.querySelector('#viewer .mermaid svg');
      if (!svg) return { svg: false };
      const byId = [...svg.querySelectorAll('line[id^="actor"]')];
      const byClass = [...svg.querySelectorAll('line.actor-line')];
      const geom = byId.map(l => {
        const cs = getComputedStyle(l);
        const r = l.getBoundingClientRect();
        return {
          cls: l.getAttribute('class'),
          stroke: cs.stroke,
          strokeWidth: cs.strokeWidth,
          opacity: cs.opacity,
          height: Math.round(r.height)
        };
      });
      // ORACLE, and it is deliberately NOT ours: mermaid injects its own
      // <style> into the SVG carrying the theme's actorLineColor. Comparing the
      // COMPUTED stroke against mermaid's own DECLARED stroke is what makes the
      // rejection of upstream's rule observable - a hard-coded
      // "stroke: #888 !important" wins the cascade and the two stop agreeing,
      // while every "is it drawn at all" assertion carries on passing.
      const styleText = [...svg.querySelectorAll('style')].map(s => s.textContent).join('\\n');
      const m = /\\.actor-line\\s*\\{[^}]*?stroke\\s*:\\s*([^;}]+)/.exec(styleText);
      const declaredRaw = m ? m[1].trim() : null;
      let declared = null;
      if (declaredRaw) {
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        probe.style.stroke = declaredRaw;
        svg.appendChild(probe);
        declared = getComputedStyle(probe).stroke;
        probe.remove();
      }
      return { svg: true, byId: byId.length, byClass: byClass.length, geom, declaredRaw, declared };
    })()
  `);
  check(
    "the sequence fixture produced actor lifelines to measure",
    lifelines.svg === true && lifelines.byId >= 2,
    JSON.stringify(lifelines),
  );
  check(
    "mermaid 11 sets the actor-line class correctly (10.6.1 workaround not needed)",
    lifelines.byClass === lifelines.byId && lifelines.byId >= 2,
    JSON.stringify(lifelines),
  );
  check(
    "actor lifelines are actually drawn: visible stroke and real height",
    (lifelines.geom || []).length >= 2 &&
      lifelines.geom.every(
        (g) =>
          g.height > 10 &&
          g.opacity !== "0" &&
          g.stroke !== "none" &&
          parseFloat(g.strokeWidth) > 0,
      ),
    JSON.stringify(lifelines),
  );
  // This is the assertion that PINS THE REJECTION. The three above it are all
  // satisfied by upstream's rule too - it paints the lifelines a perfectly
  // visible grey - so on their own they record no decision at all. What the
  // rejection actually claims is that the lifeline colour must keep tracking
  // themeVariables.actorLineColor instead of being frozen to #888/#777, and
  // that is only observable by comparing against what mermaid itself declared.
  check(
    "lifeline colour still follows the mermaid theme, not a hard-coded override",
    !!lifelines.declared &&
      (lifelines.geom || []).length >= 2 &&
      lifelines.geom.every((g) => g.stroke === lifelines.declared),
    JSON.stringify(lifelines),
  );

  // (e) The THIRD mermaid.run call site: renderMermaidInDOM(), which draws the
  //     one diagram typed into the insert/edit dialog. It keeps
  //     suppressErrors:false deliberately, and until now nothing measured that
  //     decision or the sink in its catch. Both are covered here, because they
  //     are the same event: the throw is what runs the catch, and the catch is
  //     what both re-attaches the element and writes the banner.
  await sentinel.mute("13e: single-diagram insert path given an invalid diagram");
  let inDom;
  try {
    inDom = await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        await window.renderMermaidInDOM(
          'notADiagramTypeAtAll <b id="mermaid-indom-probe">probe</b>',
          'insert',
          null
        );
        await new Promise(r => setTimeout(r, 400));
        const container = document.querySelector('#viewer .mermaid-container');
        const el = container ? container.querySelector('.mermaid') : null;
        return {
          container: !!container,
          // The catch re-attaches the node mermaid detaches on failure. If the
          // throw were suppressed the catch would never run and this would be
          // an empty container with no diagram to edit or delete.
          reattached: !!el && el.isConnected && el.parentElement === container,
          injected: !!document.getElementById('mermaid-indom-probe'),
          labelled: !!el && /Mermaid Rendering Error/.test(el.textContent),
          textShown: !!el && el.textContent.includes('mermaid-indom-probe')
        };
      })()
    `);
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    // Split from the banner assertion deliberately: the container is created
    // before the try/catch, so it stays true under every revert. Keeping the two
    // halves separate means R110's failure log names which one flipped instead
    // of requiring the JSON payload to be read.
    "13e the invalid diagram really reached the single-diagram render path",
    inDom.container === true,
    JSON.stringify(inDom),
  );
  check(
    "13e the invalid diagram really reached the single-diagram error path",
    inDom.labelled === true,
    JSON.stringify(inDom),
  );
  check(
    // NOT pinned by a revert, deliberately: neutralising the re-attach fails
    // nothing on mermaid 11 (R110b was tried and came back VACUOUS), because
    // mermaid 11 no longer detaches the node. Kept as a plain invariant so a
    // future engine that starts detaching again is caught here.
    "a failed single diagram stays attached so it can still be edited or deleted",
    inDom.reattached === true,
    JSON.stringify(inDom),
  );
  check(
    "the single-diagram error path renders a hostile message as text, not markup",
    inDom.injected === false && inDom.textShown === true,
    JSON.stringify(inDom),
  );

  // (e2) 13e drives renderMermaidInDOM() DIRECTLY, which is the only way to
  //      reach it with parse-invalid source - the real dialog validates with
  //      mermaid.render() first and returns early. Both reviewers pointed out
  //      that this leaves the PRODUCT path unmeasured, and they were right: the
  //      reachable failure there is "render() succeeds, run() then throws"
  //      (post-parse layout faults, an engine upgrade changing behaviour between
  //      the two calls, the mutex losing a race). This scenario drives the real
  //      button path end-to-end with exactly that shape: VALID source, so
  //      validation passes and the dialog closes, and mermaid.run patched to
  //      throw a message carrying markup. It is what R110 is pinned to.
  await sentinel.mute("13e2: dialog insert with mermaid.run forced to throw");
  let dialogRun;
  try {
    dialogRun = await exec(`
      (async () => {
        const plain = window.fs.readFileSync(${jsPlain}, 'utf8');
        await window.renderMarkdown(plain, 'full');
        const ta = document.getElementById('mermaidTemplateCode');
        const overlay = document.getElementById('mermaidTemplateOverlay');
        if (!ta || !overlay) return { wired: false };
        // renderMarkdown() does NOT set originalMarkdown - it only draws. So
        // without this seed the insert below edits whatever the PREVIOUS
        // scenario left in the store (13d assigns DOC_MIXED), and this scenario
        // would be quietly mutating a document that is not the one on screen.
        // Both reviewers caught that independently.
        const beforeMd = window.originalMarkdown;
        const beforeEditor = window.markdownEditor ? window.markdownEditor.value : null;
        // historyPush() clears the redo stack as well as appending, so nothing
        // short of a full snapshot puts the undo/redo state back.
        const beforeHistory = window.historySnapshot();
        window.originalMarkdown = plain;
        // hasUnsavedChanges is a module-scope 'let' with NO window binding (the
        // getter/setter pair exists for originalMarkdown and currentFilePath but
        // not for this one), so assigning window.hasUnsavedChanges would silently
        // write to a junk property and restore nothing. setUnsavedState() is the
        // real setter the renderer exposes. The flag is not readable either, so
        // capture its ONE observable - the indicator the renderer paints from it
        // - and restore to THAT, rather than to a hard false. Forcing false on
        // the way out would silently launder a dirty document clean for every
        // scenario that runs after this one.
        window.updateUnsavedIndicator();
        const beforeDirty =
          document.getElementById('unsavedIndicator').style.display === 'inline';
        window.setUnsavedState(false);
        const containersBefore =
          document.querySelectorAll('#viewer .mermaid-container').length;
        // Open the dialog FOR REAL. Asserting "the dialog is now closed" without
        // this is vacuous - it was never open, so deleting the close call on the
        // success path would still leave the assertion green.
        // Signature is (code, mode) - NOT (mode, code). Passing them the wrong
        // way round sets the code to the string 'insert' and the mode to null,
        // which still "opens" the dialog and would have made the assertion
        // below pass while measuring the wrong thing entirely.
        window.openMermaidTemplateDialog(null, 'insert');
        const dialogOpened = overlay.classList.contains('visible');
        // VALID source: mermaid.render() must accept it, so the dialog gets
        // past validation and actually reaches renderMermaidInDOM().
        ta.value = 'graph TD\\n  A[Start] --> B[End]';
        const realRun = mermaid.run;
        window.__realMermaidRun = realRun;
        mermaid.run = async () => {
          throw new Error('layout <i id="mermaid-dialog-probe">injected</i> fault');
        };
        let validationRejected = false;
        try {
          await window.insertMermaidFromDialog();
          const pv = document.getElementById('mermaidTemplatePreview');
          validationRejected = !!(pv && pv.querySelector('.mermaid-preview-error'));
          // Wait on the mermaid mutex rather than a fixed sleep: this flow goes
          // through queueMermaidWork(), so under contention with an earlier
          // scenario's cleanup the banner can land after a 400ms nap - and then
          // it lands OUTSIDE the mute and is recorded as a real error.
          if (window.whenMermaidSettled) await window.whenMermaidSettled();
          await new Promise(r => setTimeout(r, 300));
        } finally {
          mermaid.run = realRun;
          delete window.__realMermaidRun;
        }
        const containers = document.querySelectorAll('#viewer .mermaid-container');
        const container = containers[containers.length - 1] || null;
        const el = container ? container.querySelector('.mermaid') : null;
        // Read the dirty flag through its only observable: the indicator the
        // renderer paints from it. The view-mode insert branch does not call
        // updateUnsavedIndicator() itself, so drive it here.
        window.updateUnsavedIndicator();
        const dirtyAfter =
          document.getElementById('unsavedIndicator').style.display === 'inline';
        const out = {
          wired: true,
          dialogOpened,
          // Vacuity guards. If validation had rejected, the dialog would have
          // returned early and renderMermaidInDOM would never have been called -
          // the scenario would then be measuring 13f a second time. And if the
          // container count did not grow, the banner we are about to inspect is
          // a leftover from an earlier scenario rather than this one's.
          validationRejected,
          dialogClosed: !overlay.classList.contains('visible'),
          containerAdded:
            document.querySelectorAll('#viewer .mermaid-container').length ===
            containersBefore + 1,
          // The insert really has to have edited the store, or the "real product
          // path" claim is false.
          storeGrew:
            typeof window.originalMarkdown === 'string' &&
            window.originalMarkdown.length > plain.length &&
            window.originalMarkdown.indexOf(
              String.fromCharCode(96, 96, 96) + 'mermaid'
            ) >= 0,
          dirtyAfter,
          container: !!container,
          reattached: !!el && el.isConnected && el.parentElement === container,
          labelled: !!el && /Mermaid Rendering Error/.test(el.textContent),
          injected: !!document.getElementById('mermaid-dialog-probe'),
          textShown: !!el && el.textContent.includes('mermaid-dialog-probe')
        };
        // Full restore, not a partial one: the insert mutates the store, the
        // dirty flag, the undo/redo stacks and the editor mirror.
        window.originalMarkdown = beforeMd;
        window.historyRestore(beforeHistory);
        window.setUnsavedState(beforeDirty);
        if (window.markdownEditor && beforeEditor !== null) {
          window.markdownEditor.value = beforeEditor;
        }
        ta.value = '';
        // The dialog's preview pane still holds this scenario's error banner.
        // Leaving it there means 13f, which asserts on that same pane, could be
        // reading OUR banner instead of its own and would stay green even if the
        // dialog stopped rendering one at all.
        const pvEl = document.getElementById('mermaidTemplatePreview');
        if (pvEl) pvEl.replaceChildren();
        return out;
      })()
    `);
    await exec(`
      (async () => {
        if (window.__realMermaidRun) { mermaid.run = window.__realMermaidRun; delete window.__realMermaidRun; }
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    "13e2 the real dialog path reached the single-diagram error banner",
    dialogRun.wired === true &&
      dialogRun.dialogOpened === true &&
      dialogRun.validationRejected === false &&
      dialogRun.dialogClosed === true &&
      dialogRun.containerAdded === true &&
      dialogRun.storeGrew === true &&
      dialogRun.container === true &&
      dialogRun.labelled === true,
    JSON.stringify(dialogRun),
  );
  check(
    // The real insert must mark the document dirty - it edited the store. This
    // is also the only readable observable for a flag that has no window
    // binding, so it doubles as proof that the cleanup below can restore it.
    "a dialog insert marks the document unsaved even when the diagram fails",
    dialogRun.dirtyAfter === true,
    JSON.stringify(dialogRun),
  );
  check(
    "the dialog insert error path renders a hostile message as text, not markup",
    dialogRun.injected === false && dialogRun.textShown === true,
    JSON.stringify(dialogRun),
  );
  // 13d and 13e2 both seed the document store through `window.originalMarkdown`,
  // and R104 only proves anything because that seed reaches the module-scope
  // binding the renderer itself reads. Both reviewers independently doubted it
  // did - a top-level `let` in a classic script is NOT a window property - and
  // both missed the getter/setter pair at renderer.js:9515 that bridges it.
  // Rather than settle that by reading the code, pin the bridge: if the
  // defineProperty is ever removed, several scenarios and R104 go vacuous, and
  // this is the assertion that says so instead of them silently passing.
  const bridge = await exec(`
    (() => {
      const before = window.originalMarkdown;
      const probe = 'BRIDGE_PROBE_' + Date.now();
      window.originalMarkdown = probe;
      // getActiveMarkdown() reads the module-scope binding, not window.
      const seen = window.getActiveMarkdown ? window.getActiveMarkdown() : null;
      window.originalMarkdown = before;
      return {
        seen: seen === probe,
        restored: window.originalMarkdown === before,
        // STRUCTURAL pin, alongside the semantic one above. The two reviewers
        // split on whether the semantic probe alone is enough: one held that
        // renderer.js:1899's bare 'originalMarkdown' guard is the SAME lexical
        // binding getActiveMarkdown() reads, so breaking the bridge fails both
        // together and the probe already covers it - which is correct. The other
        // constructed a two-step refactor that defeats it anyway: delete the
        // defineProperty AND change getActiveMarkdown() to read
        // window.originalMarkdown, and the semantic probe stays green while the
        // bare-binding guard is dead. Asserting the accessor still EXISTS costs
        // nothing and closes that, because a plain assignment leaves a data
        // property with no setter.
        bridged:
          typeof Object.getOwnPropertyDescriptor(window, 'originalMarkdown')
            .set === 'function'
      };
    })()
  `);
  check(
    "window.originalMarkdown really writes through to the renderer's own binding",
    bridge.seen === true &&
      bridge.restored === true &&
      bridge.bridged === true,
    JSON.stringify(bridge),
  );

  // (e3) THE UNDRAWN DIAGRAM: its context-menu target, and its source rewrite.
  //
  // A `.mermaid` is only wrapped in a `.mermaid-container` once it has DRAWN -
  // the wrap loop in renderMarkdownFull tests for an <svg>. Three shapes reach
  // the reader undrawn: an EMPTY fence (no source, so the render path skips
  // it), any diagram on the light-format path (which never runs mermaid), and
  // a source-less element left behind by a failed render. None of them has a
  // container, so both context-menu handlers used to fall back to
  // `mermaidEl.parentElement`. Under a heading that is the enclosing
  // `.collapsible-section` - i.e. the whole rest of the section; with no
  // heading it is #viewer ITSELF, and Edit then handed #viewer to
  // renderMermaidInDOM('replace'), which calls
  // replaceTarget.parentElement.replaceChild(), while Delete handed it to
  // removeChild(). Either DETACHES THE WHOLE DOCUMENT: the module-level
  // `viewer` const goes on pointing at the orphan, so the app looks blank until
  // it is restarted, with nothing in the console to say why.
  //
  // The fixture is the empty fence because it is the one an ordinary author can
  // type, and it is written WITHOUT a heading deliberately, to reach the
  // catastrophic parent rather than the merely bad one. MEASURED: with a
  // leading `# Doc` the probe reports parentIsViewer false.
  //
  // The probe REPAIRS a detached viewer and records that it did, so a future
  // revert of the DELETE site reports as its own assertion failing rather than
  // as every later assertion in this suite failing against an orphan. (R535
  // reverts the EDIT site, which resolves the target but never acts on it, so
  // the repair cannot fire there.)
  const EMPTY_FENCE_DOC = "Empty diagram below.\n\n```mermaid\n```\n";
  // The second leg's fixture: a SOURCED undrawn diagram, reached through the
  // light-format path, which never runs mermaid and never wraps. Rewriting the
  // markdown is the half of Edit that the empty fence cannot see - its own
  // `oldCode` is empty either way.
  const LF_WARM_DOC = "warm text\n";
  const LF_DIAGRAM = "graph TD\n  A[Old] --> B[Source]";
  const LF_NEW_CODE = "graph TD\n  C[New] --> D[Source]";
  const LF_DOC = "light text\n\n```mermaid\n" + LF_DIAGRAM + "\n```\n";
  const undrawn = await exec(`
    (async () => {
      const savedSource = window.originalMarkdown;
      const savedUndo = undoHistory.slice();
      const savedRedo = redoHistory.slice();
      const savedDirty = hasUnsavedChanges;
      const v = document.getElementById('viewer');
      const out = {};
      try {
      await window.renderMarkdown(${JSON.stringify(EMPTY_FENCE_DOC)}, 'full');
      await new Promise(r => setTimeout(r, 500));
      const el = v.querySelector('.mermaid');
      out.found = !!el;
      out.undrawn = !!el && !el.querySelector('svg');
      out.unwrapped = !!el && !el.closest('.mermaid-container');
      out.parentIsViewer = !!el && el.parentElement === v;
      if (!el) return out;

      // EDIT, through the real menu handler rather than by calling the
      // resolution expression the test would have to copy.
      rightClickTarget = el;
      document.getElementById('ctxEditMermaid').click();
      out.editTargetIsViewer = editingMermaidContainer === v;
      out.editTargetIsDiagram = editingMermaidContainer === el;
      closeMermaidTemplateDialog();
      editingMermaidContainer = null;
      // closeMermaidTemplateDialog() only drops the overlay's class; the mode
      // the click set is the dialog's own state and has to be put back, or the
      // next caller of insertMermaidFromDialog() in this suite takes the edit
      // branch with a null target.
      mermaidDialogMode = 'insert';
      rightClickTarget = null;

      // DELETE, through the handler's own function. The source holds exactly
      // one fence, so the product takes its single-block path and no text
      // scoring is involved.
      window.originalMarkdown = ${JSON.stringify(EMPTY_FENCE_DOC)};
      window.deleteMermaidFromSource([], el);
      out.viewerStillAttached = v.isConnected;
      out.diagramRemoved = !v.contains(el);
      if (!v.isConnected) {
        // Put the document back so the rest of this probe has a page to run
        // against. Recorded, so a green run can never be a repaired one.
        document.querySelector('.content-wrapper').appendChild(v);
        out.repairedAfterDelete = true;
      }

      // ---- leg B: the SOURCE half of Edit, on a sourced undrawn diagram ----
      await window.renderMarkdown(${JSON.stringify(LF_WARM_DOC)}, 'full');
      await new Promise(r => setTimeout(r, 300));
      await window.renderMarkdown(${JSON.stringify(LF_DOC)}, 'light-format');
      await new Promise(r => setTimeout(r, 300));
      const el2 = v.querySelector('.mermaid');
      out.lfFound = !!el2;
      out.lfUndrawn = !!el2 && !el2.querySelector('svg');
      out.lfUnwrapped = !!el2 && !el2.closest('.mermaid-container');
      out.lfSourced = !!el2 && el2.dataset.mermaidSrc === ${JSON.stringify(LF_DIAGRAM)};
      if (el2) {
        window.originalMarkdown = ${JSON.stringify(LF_DOC)};
        rightClickTarget = el2;
        document.getElementById('ctxEditMermaid').click();
        document.getElementById('mermaidTemplateCode').value = ${JSON.stringify(LF_NEW_CODE)};
        await window.insertMermaidFromDialog();
        await new Promise(r => setTimeout(r, 600));
        const after = window.originalMarkdown;
        out.lfSourceRewritten = after.indexOf(${JSON.stringify(LF_NEW_CODE)}) !== -1;
        out.lfOldSourceGone = after.indexOf(${JSON.stringify(LF_DIAGRAM)}) === -1;
        out.lfDialogClosed = !document.getElementById('mermaidTemplateOverlay')
          .classList.contains('visible');
        rightClickTarget = null;
      }
      return out;
      } finally {
        // Everything this probe is allowed to move, put back - it rewrites the
        // document source, pushes undo entries and marks the page dirty.
        window.originalMarkdown = savedSource;
        undoHistory.length = 0;
        for (const h of savedUndo) undoHistory.push(h);
        redoHistory.length = 0;
        for (const h of savedRedo) redoHistory.push(h);
        hasUnsavedChanges = savedDirty;
        updateUnsavedIndicator();
        closeMermaidTemplateDialog();
        mermaidDialogMode = 'insert';
        editingMermaidContainer = null;
        rightClickTarget = null;
        // LAST, and it covers leg B as well as the delete leg: the edit path
        // ends in renderMermaidInDOM('replace', target), so a regression in
        // WHICH element is targeted detaches #viewer here rather than at the
        // delete call. Repairing it keeps the rest of the suite meaningful, and
        // the flag keeps the repair visible.
        if (!v.isConnected) {
          document.querySelector('.content-wrapper').appendChild(v);
          out.repairedAtExit = true;
        }
      }
    })()
  `);
  // POSITIVE CONTROL. "The viewer survived" is trivially true of a fixture that
  // never produced the shape the defect needs, so the shape is asserted first
  // and separately: found, not drawn, not wrapped, sitting in #viewer.
  check(
    "an empty mermaid fence really reaches the reader as an undrawn, unwrapped diagram",
    undrawn.found === true &&
      undrawn.undrawn === true &&
      undrawn.unwrapped === true &&
      undrawn.parentIsViewer === true,
    JSON.stringify(undrawn),
  );
  check(
    "the Edit Diagram target for an undrawn diagram is the diagram, never the viewer",
    undrawn.editTargetIsDiagram === true && undrawn.editTargetIsViewer === false,
    JSON.stringify(undrawn),
  );
  check(
    "deleting an undrawn diagram removes the diagram and leaves the viewer attached",
    undrawn.diagramRemoved === true &&
      undrawn.viewerStillAttached === true &&
      undrawn.repairedAfterDelete === undefined,
    JSON.stringify(undrawn),
  );
  // The SECOND positive control, for leg B. Its assertion is about the markdown
  // being rewritten, and a leg that never produced a sourced, undrawn, unwrapped
  // diagram would leave that unprovable rather than false.
  check(
    "the light-format path really leaves a sourced but undrawn, unwrapped diagram",
    undrawn.lfFound === true &&
      undrawn.lfUndrawn === true &&
      undrawn.lfUnwrapped === true &&
      undrawn.lfSourced === true,
    JSON.stringify(undrawn),
  );
  check(
    "editing an undrawn diagram rewrites the markdown, not just the picture",
    undrawn.lfSourceRewritten === true &&
      undrawn.lfOldSourceGone === true &&
      undrawn.lfDialogClosed === true,
    JSON.stringify(undrawn),
  );
  // The probe repairs a detached #viewer on its way out so that the rest of the
  // suite still has a page; this is what stops that repair being silent. It is
  // a separate assertion rather than a conjunct of the two above because it has
  // a different subject - not what was edited or deleted, but whether the
  // DOCUMENT survived being edited or deleted at all.
  check(
    "the undrawn-diagram probe left the viewer attached to the page",
    undrawn.repairedAtExit === undefined,
    JSON.stringify(undrawn),
  );

  // (e5) THE EDIT REFUSES RATHER THAN DIVERGING.
  //
  // insertMermaidFromDialog() rewrites the FIRST fence whose body matches the
  // diagram's own, and it used to replace the on-screen diagram whether or not
  // that rewrite happened. Four ordinary documents made the picture and the
  // FILE disagree, silently - the reader saw the new diagram, the document was
  // marked unsaved, and the file kept the old text, so the edit vanished at the
  // next full render and a save wrote the unedited source:
  //
  //   an EMPTY fence, which has no body to match;
  //   a body carrying an emoji SHORTCODE, because parseEmojis() runs before the
  //     fences are lifted out, so the body read back has the glyph where the
  //     file has :star:;
  //   a raw-HTML <pre class="mermaid">, which is not a fence at all;
  //   TWO fences sharing a body, where "the first match" is not the one the
  //     reader clicked.
  //
  // Requiring exactly one match answers all four the same way: refuse, out
  // loud, with nothing moved. The oracle is therefore the MARKDOWN plus the
  // unsaved flag and the undo depth - a DOM check would have passed throughout,
  // which is exactly how this survived so long.
  //
  // Both render paths are exercised: the light path never draws, so its
  // diagrams are unwrapped, and the full path's are wrapped in a container -
  // the two reach the handler by different routes.
  const REF_A = "graph TD\n  A[Same] --> B[Body]";
  const REF_OTHER = "graph TD\n  Z[Other] --> Y[Block]";
  const REF_NEW = "graph TD\n  N[Edited] --> M[Body]";
  const REF_EMOJI = "graph TD\n  E[:star: star] --> F[Done]";
  const REF_DUP_DOC =
    "dup text\n\n```mermaid\n" + REF_A + "\n```\n\nmiddle\n\n```mermaid\n" + REF_A + "\n```\n";
  const REF_EMPTY_DOC =
    "empty text\n\n```mermaid\n```\n\ntail\n\n```mermaid\n" + REF_OTHER + "\n```\n";
  const REF_EMOJI_DOC = "emoji text\n\n```mermaid\n" + REF_EMOJI + "\n```\n";
  const REF_UNIQUE_DOC = "unique text\n\n```mermaid\n" + REF_OTHER + "\n```\n";
  // One real fence and one hand-written <pre class="mermaid"> carrying the SAME
  // body. Sanitization admits it (measured elsewhere in this work), and
  // restoreMermaidSourceAttributes() gives it the same data-mermaid-src, so on
  // a source match alone the decoy is indistinguishable from the fence.
  const REF_RAW_DOC =
    "raw text\n\n```mermaid\n" + REF_A + "\n```\n\n<pre class=\"mermaid\">" + REF_A + "</pre>\n";
  // A second document for the stale-dialog leg. Its diagram body is the SAME as
  // REF_UNIQUE_DOC's, deliberately: patchViewerDOM keys mermaid blocks by their
  // source, so the old node is REUSED and stays connected, uniquely sourced and
  // in the viewer. Every check except the document revision therefore still
  // passes - which is precisely the case a revision check has to catch, and the
  // reason a fixture with a different body would have proved nothing.
  const REF_OTHER_DOC = "other text\n\n```mermaid\n" + REF_OTHER + "\n```\n";
  // Two DISTINCT diagrams, for the async-race leg: the submission is opened
  // against the first and the dialog is then reopened on the second, so a
  // commit against the wrong target is visible as the wrong body being
  // rewritten, and an unintended insert as a third fence appearing.
  const REF_TWO_DOC =
    "two text\n\n```mermaid\n" + REF_A + "\n```\n\nbetween\n\n```mermaid\n" + REF_OTHER + "\n```\n";
  const refuse = await exec(`
    (async () => {
      const savedSource = window.originalMarkdown;
      const savedUndo = undoHistory.slice();
      const savedRedo = redoHistory.slice();
      const savedDirty = hasUnsavedChanges;
      const v = document.getElementById('viewer');
      const out = {};
      // One leg: render the document, click Edit on the nth diagram, type the
      // new body, and report what happened to the MARKDOWN - not to the page.
      const leg = async (doc, mode, nth, code) => {
        if (mode === 'light-format') {
          await window.renderMarkdown('warm text\\n', 'full');
          await new Promise(r => setTimeout(r, 250));
        }
        await window.renderMarkdown(doc, mode);
        await new Promise(r => setTimeout(r, mode === 'full' ? 900 : 350));
        window.originalMarkdown = doc;
        hasUnsavedChanges = false;
        undoHistory.length = 0;
        const el = v.querySelectorAll('.mermaid')[nth];
        if (!el) return { found: false };
        // SETUP EVIDENCE, CAPTURED BEFORE THE CLICK. The submission can detach
        // or replace nodes, so counting afterwards measures the aftermath and
        // not the fixture - which is exactly how the first sweep reported
        // "nodes: 1" for a two-node decoy document.
        const mySrc = normalizeMermaidCode(el.dataset.mermaidSrc);
        const sameSourceBefore = Array.from(v.querySelectorAll('.mermaid')).filter(
          (n) => normalizeMermaidCode(n.dataset.mermaidSrc) === mySrc).length;
        rightClickTarget = el;
        document.getElementById('ctxEditMermaid').click();
        document.getElementById('mermaidTemplateCode').value = code;
        await window.insertMermaidFromDialog();
        await new Promise(r => setTimeout(r, 500));
        rightClickTarget = null;
        return {
          found: true,
          sameSourceBefore: sameSourceBefore,
          unchanged: window.originalMarkdown === doc,
          holdsNew: window.originalMarkdown.indexOf(code) !== -1,
          dirty: hasUnsavedChanges,
          undoDepth: undoHistory.length,
        };
      };
      try {
        out.dupFull = await leg(${JSON.stringify(REF_DUP_DOC)}, 'full', 1, ${JSON.stringify(REF_NEW)});
        out.dupLight = await leg(${JSON.stringify(REF_DUP_DOC)}, 'light-format', 1, ${JSON.stringify(REF_NEW)});
        out.emptyFull = await leg(${JSON.stringify(REF_EMPTY_DOC)}, 'full', 0, ${JSON.stringify(REF_NEW)});
        out.emojiFull = await leg(${JSON.stringify(REF_EMOJI_DOC)}, 'full', 0, ${JSON.stringify(REF_NEW)});
        // THE POSITIVE CONTROL, and the whole pair is worthless without it: a
        // document with exactly one matching fence must still be edited, on
        // both paths, or "nothing was rewritten" is just a description of an
        // edit path that no longer works at all.
        out.uniqueFull = await leg(${JSON.stringify(REF_UNIQUE_DOC)}, 'full', 0, ${JSON.stringify(REF_NEW)});
        out.uniqueLight = await leg(${JSON.stringify(REF_UNIQUE_DOC)}, 'light-format', 0, ${JSON.stringify(REF_NEW)});

        // RAW-HTML REDIRECTION. One fence and one hand-written
        // <pre class="mermaid"> carrying the SAME body. A source match alone
        // finds exactly one fence, so clicking the decoy used to rewrite the
        // author's real block - a document editing itself. Two nodes on screen
        // now share that source, so neither is editable.
        out.rawDecoyOnRaw = await leg(${JSON.stringify(REF_RAW_DOC)}, 'full', 1, ${JSON.stringify(REF_NEW)});
        out.rawDecoyOnFence = await leg(${JSON.stringify(REF_RAW_DOC)}, 'full', 0, ${JSON.stringify(REF_NEW)});

        // A STALE DIALOG. Edit is opened against one document; another is
        // rendered under it; the dialog is then submitted. Node reuse can make
        // the old target still look perfectly valid, so the document REVISION
        // is what has to be checked.
        await window.renderMarkdown(${JSON.stringify(REF_UNIQUE_DOC)}, 'full');
        await new Promise(r => setTimeout(r, 900));
        window.originalMarkdown = ${JSON.stringify(REF_UNIQUE_DOC)};
        const staleEl = v.querySelectorAll('.mermaid')[0];
        rightClickTarget = staleEl;
        document.getElementById('ctxEditMermaid').click();
        const genAtOpen = renderGeneration;
        // The document underneath changes while the dialog is open.
        await window.renderMarkdown(${JSON.stringify(REF_OTHER_DOC)}, 'full');
        await new Promise(r => setTimeout(r, 900));
        window.originalMarkdown = ${JSON.stringify(REF_OTHER_DOC)};
        hasUnsavedChanges = false;
        undoHistory.length = 0;
        out.staleGenerationMoved = renderGeneration !== genAtOpen;
        // EVERY OTHER GUARD, MEASURED BEFORE THE SUBMISSION. The point of this
        // fixture is that only the REVISION check can refuse: the same-source
        // node is reused, so it is still the current one, still connected,
        // still in the viewer, still unique on screen and still matched by
        // exactly one fence. Recorded here so a revert of the revision check
        // fails for that reason and no other.
        const nowEl = v.querySelectorAll('.mermaid')[0];
        const staleSrc = normalizeMermaidCode(staleEl.dataset.mermaidSrc);
        const staleRe = /\`\`\`mermaid[^\\S\\r\\n]*[\\r\\n]+([\\s\\S]*?)\`\`\`/g;
        let staleMatches = 0;
        let sm;
        while ((sm = staleRe.exec(window.originalMarkdown)) !== null) {
          if (normalizeMermaidCode(sm[1]) === staleSrc) staleMatches += 1;
        }
        out.staleControl = {
          sameNode: nowEl === staleEl,
          connected: staleEl.isConnected,
          contained: v.contains(staleEl),
          domCount: Array.from(v.querySelectorAll('.mermaid')).filter(
            (n) => normalizeMermaidCode(n.dataset.mermaidSrc) === staleSrc).length,
          srcMatches: staleMatches,
        };
        document.getElementById('mermaidTemplateCode').value = ${JSON.stringify(REF_NEW)};
        await window.insertMermaidFromDialog();
        await new Promise(r => setTimeout(r, 500));
        rightClickTarget = null;
        out.stale = {
          unchanged: window.originalMarkdown === ${JSON.stringify(REF_OTHER_DOC)},
          holdsNew: window.originalMarkdown.indexOf(${JSON.stringify(REF_NEW)}) !== -1,
          dirty: hasUnsavedChanges,
          undoDepth: undoHistory.length,
        };

        // AN ASYNC SUBMISSION THAT OUTLIVES ITS DIALOG. mermaid.render() is
        // replaced with a stub this probe resolves BY HAND, so the race is
        // deterministic rather than timing-dependent: submit against diagram
        // ONE, then close and reopen the dialog on diagram TWO, then let the
        // first validation finish.
        //
        // THE STUB HAS TO TELL ITS TWO CALLERS APART, and a stub that did not
        // was this leg's own nondeterminism. openMermaidTemplateDialog() calls
        // updateMermaidPreview() on EVERY open - including the reopen this leg
        // performs on purpose - and the preview draws through the same
        // mermaid.render(). A stub that parked every call let a PREVIEW
        // overwrite the single shared resolver, so releasing it resumed a
        // preview and left the submission parked for ever: whether "await
        // parked" returned or hung came down to microtask ordering inside
        // ensureMermaid(). The callers are distinguishable by the id they pass -
        // insertMermaidFromDialog() uses 'mermaid-validate-<ts>' and
        // updateMermaidPreview() uses 'mermaid-tpl-prev-<n>' - so ONLY the
        // submission's validation is parked and every other call is handed
        // straight to the real renderer, which is also what keeps the reopened
        // dialog behaving exactly as it does in production.
        await window.renderMarkdown(${JSON.stringify(REF_TWO_DOC)}, 'full');
        await new Promise(r => setTimeout(r, 900));
        window.originalMarkdown = ${JSON.stringify(REF_TWO_DOC)};
        hasUnsavedChanges = false;
        undoHistory.length = 0;
        const nodes = v.querySelectorAll('.mermaid');
        out.raceSetup = { nodes: nodes.length };
        const realRender = window.mermaid.render;
        // DECLARED OUTSIDE THE try SO THE finally CAN REACH IT. Restoring the
        // stub is only half of the poisoning surface: insertMermaidFromDialog()
        // latches mermaidDialogSubmitting BEFORE its first await and clears it
        // only when validation resumes, so a submission left parked by a throw
        // between the submit and the release would latch that flag for the rest
        // of the window and make every LATER dialog submission in this file
        // return silently - an unrelated cascade, which is exactly what this
        // leg's restore exists to prevent.
        let releaseValidation = null;
        let validationCalls = 0;
        try {
          window.mermaid.render = function (id) {
            if (typeof id === 'string' && id.indexOf('mermaid-validate-') === 0) {
              validationCalls += 1;
              // Only the FIRST submission is parked. A second validation would
              // mean this is no longer the race it claims to be, so it is
              // COUNTED and resolved immediately rather than parked: the count
              // fails the fixture assertion out loud, and nothing can deadlock
              // waiting on a resolver this leg never releases.
              if (releaseValidation) return Promise.resolve({ svg: '<svg></svg>' });
              return new Promise((res) => { releaseValidation = () => res({ svg: '<svg></svg>' }); });
            }
            return realRender.apply(this, arguments);
          };
          rightClickTarget = nodes[0];
          document.getElementById('ctxEditMermaid').click();
          const firstTarget = editingMermaidContainer;
          out.raceOpenedOnFirst =
            firstTarget !== null &&
            firstTarget === (nodes[0].closest('.mermaid-container') || nodes[0]);
          document.getElementById('mermaidTemplateCode').value = ${JSON.stringify(REF_NEW)};
          // Never allowed to reject on its own. A rejection has to arrive as a
          // recorded outcome below, not as an unhandled rejection that skips
          // past the stub restore.
          const parked = window.insertMermaidFromDialog().then(
            () => 'settled',
            (e) => 'rejected: ' + ((e && e.message) || e),
          );
          // WAIT FOR THE PARK, do not guess at it. A fixed sleep is a bet on how
          // many microtasks ensureMermaid() costs; this waits for the
          // submission's own validation call to arrive, so the close and reopen
          // below are guaranteed to happen WHILE it is parked - which is the
          // whole production race.
          const parkDeadline = Date.now() + 4000;
          while (releaseValidation === null && Date.now() < parkDeadline) {
            await new Promise(r => setTimeout(r, 20));
          }
          out.raceParked = releaseValidation !== null;
          // The reader gives up on the first diagram and opens the second.
          closeMermaidTemplateDialog();
          const secondNode = v.querySelectorAll('.mermaid')[1];
          const secondTarget = secondNode &&
            (secondNode.closest('.mermaid-container') || secondNode);
          rightClickTarget = secondNode;
          document.getElementById('ctxEditMermaid').click();
          // NOT a bare non-null test, which is what this used to read and which
          // could never have been false: closeMermaidTemplateDialog() clears the
          // generation and bumps the session but deliberately leaves
          // editingMermaidContainer alone, so it has been non-null since the
          // FIRST open. A reopen that silently no-opped - the handler bailing
          // out because it resolved no .mermaid element, say - would still have
          // read true, and the fixture would have claimed a reopen that never
          // happened while only the CLOSE half of the session bump was actually
          // exercised. The identity of the target is what says the dialog really
          // moved to diagram TWO.
          out.raceReopened =
            editingMermaidContainer !== null &&
            editingMermaidContainer !== firstTarget &&
            editingMermaidContainer === secondTarget;
          // Now let the first submission finish validating.
          if (releaseValidation) releaseValidation();
          // BOUNDED. If releasing ever fails to resume the submission this leg
          // reports 'timeout' and the assertions fail with a diagnosis, instead
          // of hanging the suite with none.
          out.raceOutcome = await Promise.race([
            parked,
            new Promise(r => setTimeout(() => r('timeout'), 4000)),
          ]);
          await new Promise(r => setTimeout(r, 400));
          closeMermaidTemplateDialog();
          rightClickTarget = null;
          out.race = {
            entered: validationCalls > 0,
            validationCalls: validationCalls,
            unchanged: window.originalMarkdown === ${JSON.stringify(REF_TWO_DOC)},
            holdsNew: window.originalMarkdown.indexOf(${JSON.stringify(REF_NEW)}) !== -1,
            fenceCount: (window.originalMarkdown.match(/\`\`\`mermaid/g) || []).length,
            dirty: hasUnsavedChanges,
            undoDepth: undoHistory.length,
          };
        } finally {
          // ALL THREE, ON EVERY PATH. The stub, because one left installed by a
          // throw or by an await that never returned answers every later
          // mermaid.render() in this file. The parked resolver, because a
          // submission still waiting on it never resumes and never clears the
          // submit latch. And the latch itself, for the case where the release
          // above cannot reach the submission at all - it parked in
          // ensureMermaid() rather than in render(), so there is no resolver to
          // call. On the normal path all three are already no-ops.
          window.mermaid.render = realRender;
          if (releaseValidation) releaseValidation();
          mermaidDialogSubmitting = false;
        }
        return out;
      } finally {
        window.originalMarkdown = savedSource;
        undoHistory.length = 0;
        for (const h of savedUndo) undoHistory.push(h);
        redoHistory.length = 0;
        for (const h of savedRedo) redoHistory.push(h);
        hasUnsavedChanges = savedDirty;
        updateUnsavedIndicator();
        closeMermaidTemplateDialog();
        mermaidDialogMode = 'insert';
        editingMermaidContainer = null;
        rightClickTarget = null;
        if (!v.isConnected) {
          document.querySelector('.content-wrapper').appendChild(v);
          out.repairedAtExit = true;
        }
      }
    })()
  `);
  check(
    "a uniquely identified diagram is still edited, on both render paths",
    refuse.uniqueFull.found === true &&
      refuse.uniqueFull.holdsNew === true &&
      refuse.uniqueFull.dirty === true &&
      refuse.uniqueLight.found === true &&
      refuse.uniqueLight.holdsNew === true &&
      refuse.uniqueLight.dirty === true &&
      refuse.repairedAtExit === undefined,
    JSON.stringify(refuse),
  );
  check(
    // Three conjuncts per leg, because "the markdown is unchanged" alone is
    // satisfied by an edit that also left the undo stack and the unsaved flag
    // dirty - which is the half-applied state this refusal exists to prevent.
    "an ambiguous diagram is refused: the markdown, the undo stack and the unsaved flag are all left alone",
    refuse.dupFull.unchanged === true &&
      refuse.dupFull.dirty === false &&
      refuse.dupFull.undoDepth === 0 &&
      refuse.dupLight.unchanged === true &&
      refuse.dupLight.dirty === false &&
      refuse.dupLight.undoDepth === 0,
    JSON.stringify({ dupFull: refuse.dupFull, dupLight: refuse.dupLight }),
  );
  check(
    // SPLIT FROM THE EMPTY CASE BY MEASUREMENT, not by taste. The authorized
    // sweep showed the two are owned by DIFFERENT conditions: an empty body
    // makes the DOM-cardinality set empty, so condition (2) refuses it, while
    // an emoji shortcode leaves exactly one node on screen and is refused by
    // condition (3) when no fence matches. Conjoined, neither could be named
    // by a revert without dragging the other in.
    "an emoji-bearing diagram is refused rather than half-applied",
    refuse.emojiFull.unchanged === true &&
      refuse.emojiFull.dirty === false &&
      refuse.emojiFull.undoDepth === 0,
    JSON.stringify(refuse.emojiFull),
  );
  check(
    "an empty fence is refused rather than half-applied",
    refuse.emptyFull.unchanged === true &&
      refuse.emptyFull.dirty === false &&
      refuse.emptyFull.undoDepth === 0,
    JSON.stringify(refuse.emptyFull),
  );
  check(
    // The decoy and the real fence BOTH refuse, and both halves are asserted:
    // the first is the security property, the second is its honest cost, and a
    // future change that quietly re-enabled the fence would be re-enabling the
    // decoy with it.
    //
    // THE SETUP EVIDENCE IS CAPTURED BEFORE EACH CLICK, per leg, on a freshly
    // rendered fixture. The first authorized sweep counted the nodes AFTER both
    // legs had run and reported "nodes: 1" - the aftermath of a mutation, not
    // the shape of the document - which is exactly the way a setup check fails
    // open.
    "a same-source raw-HTML diagram cannot redirect an edit at a real fence",
    refuse.rawDecoyOnRaw.sameSourceBefore === 2 &&
      refuse.rawDecoyOnFence.sameSourceBefore === 2 &&
      refuse.rawDecoyOnRaw.unchanged === true &&
      refuse.rawDecoyOnRaw.dirty === false &&
      refuse.rawDecoyOnRaw.undoDepth === 0 &&
      refuse.rawDecoyOnFence.unchanged === true &&
      refuse.rawDecoyOnFence.dirty === false &&
      refuse.rawDecoyOnFence.undoDepth === 0,
    JSON.stringify({ onRaw: refuse.rawDecoyOnRaw, onFence: refuse.rawDecoyOnFence }),
  );
  check(
    // THE STALE FIXTURE'S OWN SHAPE, asserted separately so the refusal below
    // can only be credited to the revision check. Every other condition is
    // shown to PASS: the node was reused, so it is the current one, connected,
    // in the viewer, unique on screen and matched by exactly one fence.
    "the stale-dialog fixture reuses the same node, so only the revision check can refuse it",
    refuse.staleGenerationMoved === true &&
      refuse.staleControl.sameNode === true &&
      refuse.staleControl.connected === true &&
      refuse.staleControl.contained === true &&
      refuse.staleControl.domCount === 1 &&
      refuse.staleControl.srcMatches === 1,
    JSON.stringify(refuse.staleControl),
  );
  check(
    "an edit dialog left open across a re-render is refused, not applied to the new document",
    refuse.stale.unchanged === true &&
      refuse.stale.holdsNew === false &&
      refuse.stale.dirty === false &&
      refuse.stale.undoDepth === 0,
    JSON.stringify(refuse.stale),
  );
  check(
    // The race's own setup, and every conjunct here is one way the leg could
    // otherwise pass while nothing raced: two diagrams on screen; the dialog
    // opened against diagram ONE; the stubbed validation entered exactly once
    // and by the SUBMISSION rather than by a dialog preview; the submission
    // demonstrably parked when the second dialog was opened; the second dialog
    // really about diagram TWO; and the release really resuming the submission
    // rather than timing out.
    "the dialog-race fixture really parked a submission and reopened on another diagram",
    refuse.raceSetup.nodes === 2 &&
      refuse.race.entered === true &&
      refuse.race.validationCalls === 1 &&
      refuse.raceOpenedOnFirst === true &&
      refuse.raceParked === true &&
      refuse.raceOutcome === "settled" &&
      refuse.raceReopened === true,
    JSON.stringify({
      setup: refuse.raceSetup,
      openedOnFirst: refuse.raceOpenedOnFirst,
      parked: refuse.raceParked,
      reopened: refuse.raceReopened,
      outcome: refuse.raceOutcome,
      race: refuse.race,
    }),
  );
  check(
    // Both failure modes at once: committing against the REOPENED dialog's
    // target (the wrong diagram would be rewritten) and committing as an
    // INSERT (a third fence would appear). fenceCount pins the second.
    "a submission parked in validation cannot commit after its dialog is closed and reopened",
    refuse.race.unchanged === true &&
      refuse.race.holdsNew === false &&
      refuse.race.fenceCount === 2 &&
      refuse.race.dirty === false &&
      refuse.race.undoDepth === 0,
    JSON.stringify(refuse.race),
  );

  // (f) The dialog's own validate-before-insert preview. Same sink class again:
  //     on Edit the dialog is pre-filled with the DOCUMENT's diagram source, and
  //     mermaid.render() quotes that source back when it rejects.
  await sentinel.mute("13f: dialog validation given an invalid diagram");
  let preview;
  try {
    preview = await exec(`
      (async () => {
        const ta = document.getElementById('mermaidTemplateCode');
        const pv = document.getElementById('mermaidTemplatePreview');
        if (!ta || !pv) return { wired: false };
        ta.value = 'notADiagramTypeAtAll <b id="mermaid-preview-probe">probe</b>';
        await window.insertMermaidFromDialog();
        await new Promise(r => setTimeout(r, 300));
        const out = {
          wired: true,
          injected: !!document.getElementById('mermaid-preview-probe'),
          shown: /notADiagramTypeAtAll/.test(pv.textContent),
          nonEmpty: pv.textContent.trim().length > 0,
          // The banner is a specific artifact, not just "some text": assert the
          // class the stylesheet targets and the warning prefix, so a future
          // refactor that drops the styled span (leaving a bare unreadable
          // stack trace in the preview) fails here rather than passing on
          // textContent alone.
          errorClass: !!pv.querySelector('.mermaid-preview-error'),
          prefixed: /^\\u26a0\\s/.test(
            (pv.querySelector('.mermaid-preview-error') || {}).textContent || ''
          ),
          childKinds: Array.from(pv.childNodes).map(
            n => n.nodeType === 1 ? n.tagName + '.' + n.className : 'text'
          )
        };
        // Clear the deliberate failure INSIDE the mute. mermaid.render() leaves
        // its own error graphic parked in the body when it rejects, and both it
        // and the preview banner outlive this scenario otherwise - the sentinel
        // would then attribute them to whatever ran next.
        pv.replaceChildren();
        ta.value = '';
        document
          .querySelectorAll('[id^="dmermaid-validate"], [id^="mermaid-validate"]')
          .forEach(n => n.remove());
        return out;
      })()
    `);
    await exec(`
      (async () => {
        await window.renderMarkdown(window.fs.readFileSync(${jsPlain}, 'utf8'), 'full');
        return null;
      })()
    `).catch(() => {});
    await sleep(400);
  } finally {
    await sentinel.unmute();
  }
  check(
    "13f the dialog validation path really rejected and reported",
    preview.wired === true && preview.nonEmpty === true,
    JSON.stringify(preview),
  );
  check(
    "the dialog preview renders a hostile message as text, not markup",
    preview.injected === false && preview.shown === true,
    JSON.stringify(preview),
  );
  check(
    "the dialog preview error is the styled warning span, not a bare string",
    preview.errorClass === true && preview.prefixed === true,
    JSON.stringify(preview),
  );

  // Everything above ran with the sentinel watching. This is the assertion the
  // end-of-run screenshot could never make: nothing visibly broke at any point
  // during the suite, not merely at the moments we happened to look.
  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const sentinelReport = await sentinel.stop();
  check(
    "nothing rendered a visible error at any point during the suite",
    sentinelReport.hits.length === 0,
    JSON.stringify(sentinelReport.hits),
  );
  // A mute is the sentinel's only blind spot, so its extent is asserted too.
  // Only *test-opened* mutes are counted (proveSentinelAlive opens its own,
  // subtracted by reason rather than by loosening this to a >= count), and each
  // must have actually caught the failure it was opened for - otherwise a
  // deliberate-failure scenario stopped failing and went vacuous without saying
  // so.
  const testMutes = sentinelReport.mutes.filter(
    (m) => m.reason !== LIVENESS_MUTE_REASON,
  );
  // Keyed by reason, not by position, and each entry names a SIGNATURE the
  // suppressed set must contain. `suppressed.length > 0` was measurably weaker:
  // ANY transient message during a 1200-1600ms mute window satisfies it, so a
  // scenario whose deliberate failure quietly stopped failing - a future mermaid
  // that accepts `notADiagramTypeAtAll`, say - would go vacuous while this
  // assertion carried on passing. That is the exact failure mode this assertion
  // exists to catch, so it has to look at what was caught, not how much.
  //
  // The signatures are the PHRASES THE SENTINEL ACTUALLY EMITS (see the closed
  // `phrases` list and the `mermaid-error-graphic` push in test-visual-utils),
  // not loose topic words. A first attempt used /mermaid|diagram|syntax|parse/i
  // and both reviewers called it decorative, correctly: a future mermaid that
  // logs any benign `console.error('Mermaid: rendered diagram X')` would satisfy
  // it even though nothing failed, which is precisely the regression this is
  // supposed to detect.
  //
  // Matched against `kind + " " + detail`, NOT `detail || kind`: the
  // mermaid-error-graphic entry carries its identity in the KIND and a bare
  // "top x1" in the detail, so a detail-first fallback can never see it. That
  // matters if mermaid ever stops writing text into the body and only paints
  // the icon - the icon would then be the only evidence left.
  //
  // 13f carries signature `null` deliberately: its failure lives in a CLOSED
  // dialog, so there is usually nothing on screen for the sentinel to see and
  // whether it catches mermaid's transient temp element depends on where the
  // poll lands. Its presence is still required.
  const MERMAID_FAILURE_SIGNATURE =
    /Syntax error in text|No diagram type detected|Mermaid Rendering Error|mermaid-error-graphic/;
  const MUTE_SIGNATURES = [
    ["stale draw failure", /stale-draw/, /stale draw failed/],
    ["13a", /^13a:/, MERMAID_FAILURE_SIGNATURE],
    ["13b", /^13b:/, MERMAID_FAILURE_SIGNATURE],
    // Forced throws: the banner is the only artifact, and it carries the
    // scenario's own token, so these can be pinned harder than the parse cases.
    ["13b2", /^13b2:/, /Mermaid Rendering Error|boom/],
    ["13d", /^13d:/, MERMAID_FAILURE_SIGNATURE],
    ["13e", /^13e:/, MERMAID_FAILURE_SIGNATURE],
    ["13e2", /^13e2:/, /Mermaid Rendering Error|layout|fault/],
    ["13f", /^13f:/, null],
  ];
  const muteAudit = MUTE_SIGNATURES.map(([name, reasonRe, sigRe]) => {
    const m = testMutes.find((x) => reasonRe.test(x.reason));
    const text = (s) => String(s.kind || "") + " " + String(s.detail || "");
    const matched = m
      ? m.suppressed.filter((s) => sigRe === null || sigRe.test(text(s))).length
      : 0;
    return {
      name,
      found: !!m,
      suppressed: m ? m.suppressed.length : 0,
      matched,
      ok: !!m && (sigRe === null || matched > 0),
    };
  });
  check(
    "every deliberate-failure mute caught the failure it was opened for",
    testMutes.length === MUTE_SIGNATURES.length &&
      muteAudit.every((a) => a.ok),
    JSON.stringify({
      audit: muteAudit,
      all: sentinelReport.mutes.map((m) => ({
        reason: m.reason,
        suppressed: m.suppressed.map((s) => s.kind + ": " + String(s.detail).slice(0, 80)),
      })),
    }),
  );
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
    check("harness completed without throwing", false, String((e && e.stack) || (e && e.message) || require("util").inspect(e)));
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
    releaseTempDir(dir);
  } catch (e) {}
  app.exit(passed === results.length ? 0 : 1);
});
