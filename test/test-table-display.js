// Regression harness for in-document table display.
// Run with: npm run test:tables
//
// Two defects are guarded here, and the second is the interesting one.
//
// Defect 1 - equal column widths. `.markdown-body table` carried
// `table-layout: fixed`, which splits the available width equally between
// columns and ignores their contents entirely. Measured on a 4-column table
// whose last column held 93.2% of the text, every column got exactly 25.0%:
// the description column had 1.21px per character while its neighbour had
// 71.67px per character, and rows were 236px tall with three nearly empty
// cells beside a wall of wrapped text. Switching to `auto` gave that column
// 84.2% of the width and dropped the tallest row to 95px.
//
// Defect 2 - the one measurements could not see. Under `auto`, the cells'
// `word-break: break-word` offers a break opportunity inside every word, which
// drops a column's min-content width to a single character. The short columns
// duly collapsed and rendered their headers vertically: "Fl/ag", "E/n/v",
// "Own/er". Every width number looked excellent while the table was
// unreadable; it was found by looking at a screenshot. `overflow-wrap:
// break-word` keeps min-content at the longest word, so a header still breaks
// only if the word itself does not fit. Assertion 4 below is that screenshot
// finding turned into something that can never need a screenshot again: a
// header cell must not be taller than a single line of its own text.
//
// Deliberately not asserted: exact pixel widths. They depend on the font, the
// window size and the platform. Every assertion here is a ratio, an ordering
// or a "does not overflow", which is what the design actually promises.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

require("../src/main.js");

const { captureScreenshot, startErrorSentinel, proveSentinelAlive, trapExternalOpens } = require("./test-visual-utils");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Armed at module scope, NOT inside app.whenReady(). When another Electron
// instance holds the single-instance lock, `whenReady` never fires at all, so
// a watchdog installed inside it is never armed and the run hangs forever with
// no output. This one fires regardless of how far startup got. It is not
// unref'd: an unref'd timer would let the process exit silently in exactly the
// stuck state it exists to report.
const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  const summary =
    "=== timed out after 240s (is another Electron instance holding the lock? check for stray electron.exe) ===";
  console.log(summary);
  try {
    writeReport(summary);
  } catch {
    /* the report is a convenience, never a reason to stay stuck */
  }
  app.exit(1);
}, WATCHDOG_MS);

const LONG =
  "This column carries the actual explanation and is the only one anybody needs to read carefully, which is why squeezing it into a quarter of the width makes the table hard to use.";

// 3 short columns + 1 long one: the shape the user reported.
let MIXED = "| Flag | Env | Owner | Description |\n|---|---|---|---|\n";
for (let i = 0; i < 3; i++) MIXED += `| Yes | dev | teamalpha | ${LONG} |\n`;

// Columns that really are uniform. `auto` must not disturb these.
let UNIFORM = "| Alpha | Beta | Gamma |\n|---|---|---|\n";
for (let r = 0; r < 3; r++) UNIFORM += `| value ${r}a | value ${r}b | value ${r}c |\n`;

// 8 columns with real content: wide enough to be clipped inside the reading
// column, which is what used to produce a horizontal scrollbar.
let WIDE = "| " + Array.from({ length: 8 }, (_, i) => `Column ${i + 1}`).join(" | ") + " |\n";
WIDE += "|" + "---|".repeat(8) + "\n";
for (let r = 0; r < 3; r++) {
  WIDE +=
    "| " +
    Array.from({ length: 8 }, (_, i) =>
      i % 4 === 3 ? "a considerably longer descriptive value here" : `value-${r}-${i}`,
    ).join(" | ") +
    " |\n";
}

// A token with no break opportunity at all. `auto` must not let it push the
// table past its container - this is the case `overflow-wrap` still handles.
const UNBREAKABLE =
  "| Key | Token | Note |\n|---|---|---|\n| a | " + "x".repeat(200) + " | short |\n";

// Wide enough that the breakout width computed for the whole window is larger
// than the viewer pane in split view. The 8-column sample above is not: in
// split view #viewer becomes `width: 50%; max-width: none`, so that table
// simply fits and never exercises a stale breakout. Without a sample this wide,
// "recalculate when the available width changes" cannot be proven at all.
let HUGE = "| " + Array.from({ length: 16 }, (_, i) => `Field ${i + 1}`).join(" | ") + " |\n";
HUGE += "|" + "---|".repeat(16) + "\n";
for (let r = 0; r < 3; r++) {
  HUGE +=
    "| " + Array.from({ length: 16 }, (_, i) => `some-value-${r}-${i}`).join(" | ") + " |\n";
}

// 6 columns - one past the `columnCount > 5` threshold that adds
// `compact-table` - with five short columns and one long explanation. This is
// the user's reported shape again, but on the other side of that threshold,
// where `white-space: nowrap` used to force the table to the width of the
// longest sentence and hand back a horizontal scrollbar.
let COMPACT = "| ID | Env | Owner | Tier | State | Description |\n|---|---|---|---|---|---|\n";
for (let r = 0; r < 3; r++) {
  COMPACT += `| id-${r} | dev | teamalpha | gold | active | ${LONG} |\n`;
}

// Eight short identifier columns plus one long explanation. The short columns
// alone nearly fill the reading column, so the table must be widened - and once
// it is, the width the explanation column ends up with IS the reading-measure
// cap. That makes this the only sample where the cap is observable in the
// render rather than only inside the function that computes it: every other
// table either fits (so the cap never reaches the layout) or has no column long
// enough to reach it.
let PROSE_WIDE =
  "| " + Array.from({ length: 8 }, (_, i) => `Key ${i + 1}`).join(" | ") + " | Explanation |\n";
PROSE_WIDE += "|" + "---|".repeat(9) + "\n";
for (let r = 0; r < 3; r++) {
  PROSE_WIDE +=
    "| " + Array.from({ length: 8 }, (_, i) => `ident-${r}-${i}`).join(" | ") + ` | ${LONG} |\n`;
}

// Two tables of identical markdown shape and identical class, differing only in
// inherited typography. `style` and `class` both survive sanitisation (see
// SANITIZE_CONFIG in renderer.js), so this is a document a reader can really
// have. The column cap is measured with a probe that is inserted INTO the
// container and cloned FROM the cell, so it is sensitive to both - and a memo
// keyed on the table's class alone would let the first table seed a cap the
// second reuses, silently giving one of them the wrong reading measure.
//
// Deliberately a THREE-column table, so it does not become a `.compact-table`.
// Compact cells set `font-size: 11px` absolutely, which overrides inheritance
// and makes the wrapper irrelevant - the first version of this sample used the
// 9-column PROSE_WIDE and measured 11px on both sides, proving nothing. Plain
// cells set no font-size at all (styles.css `.markdown-body th`/`td`), so they
// inherit, which is what puts the two tables in genuinely different fonts.
const SMALL_PROSE =
  "| Key | Env | Explanation |\n| --- | --- | --- |\n" +
  `| k-0 | dev | ${LONG} |\n| k-1 | dev | ${LONG} |\n`;
const FONT_CONTEXT =
  "# Font Context\n\n" +
  '<div style="font-size:60%">\n\n' + SMALL_PROSE + "\n</div>\n\n" +
  SMALL_PROSE;

const DOC =
  "# Tables\n\n## Mixed\n\n" + MIXED +  "\n## Uniform\n\n" + UNIFORM +
  "\n## Wide\n\n" + WIDE +
  "\n## Unbreakable\n\n" + UNBREAKABLE +
  "\n## Huge\n\n" + HUGE +
  "\n## Compact\n\n" + COMPACT +
  "\n## Prose Wide\n\n" + PROSE_WIDE;

// Reports one entry per table, in document order.
const MEASURE = `
  (() => {
    // scrollWidth>clientWidth only catches a box clipping its OWN content. A
    // breakout table is centred with translateX(-50%), so it extends past both
    // edges of its parent and is clipped by whichever ANCESTOR has a non-visible
    // overflow - invisible to the self-clip check. The screenshot caught this;
    // this turns it into an assertion.
    const ancestorClip = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const pr = node.getBoundingClientRect();
          if (r.left < pr.left - 1 || r.right > pr.right + 1) {
            return {
              by: (node.id ? '#' + node.id : '') + '.' + (node.className || node.tagName),
              overflowX: cs.overflowX,
              leftBy: Math.round(pr.left - r.left),
              rightBy: Math.round(r.right - pr.right),
            };
          }
        }
        node = node.parentElement;
      }
      return null;
    };
    const out = [];
    document.querySelectorAll('#viewer table').forEach((t) => {
      const cont = t.closest('.table-container');
      const headRow = t.querySelectorAll('tr')[0];
      const cols = [...headRow.children].map((th, ci) => {
        const cells = [...t.querySelectorAll('tr')].map(r => r.children[ci]).filter(Boolean);
        const lens = cells.map(c => (c.textContent || '').trim().length);
        const cs = getComputedStyle(th);
        return {
          header: (th.textContent || '').trim(),
          width: th.getBoundingClientRect().width,
          height: th.getBoundingClientRect().height,
          lineHeight: parseFloat(cs.lineHeight) || 0,
          padTop: parseFloat(cs.paddingTop) || 0,
          padBottom: parseFloat(cs.paddingBottom) || 0,
          maxChars: Math.max.apply(null, lens),
        };
      });
      const rows = [...t.querySelectorAll('tr')].slice(1);
      out.push({
        layout: getComputedStyle(t).tableLayout,
        tableWidth: t.getBoundingClientRect().width,
        containerWidth: cont ? cont.getBoundingClientRect().width : null,
        breakout: cont ? cont.classList.contains('table-breakout') : false,
        clipped: cont ? cont.scrollWidth > cont.clientWidth + 1 : false,
        ancestorClip: ancestorClip(cont),
        tallestRow: rows.length ? Math.max.apply(null, rows.map(r => r.getBoundingClientRect().height)) : 0,
        cols,
      });
    });
    return JSON.stringify({
      tables: out,
      viewerWidth: document.getElementById('viewer').getBoundingClientRect().width,
      wrapperWidth: document.querySelector('.content-wrapper').getBoundingClientRect().width,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    });
  })()
`;

async function run(win) {
  const sentinel = startErrorSentinel(win, { label: "tables" });
  const exec = (c) => win.webContents.executeJavaScript(c, true);
  // No suite may reach the user's browser. See trapExternalOpens().
  await trapExternalOpens(win);

  // A geometric suite must never GUESS when a resize has landed.
  //
  // `win.setBounds()` is asynchronous with respect to the renderer: the OS
  // resizes the frame, the compositor re-lays-out, and only then does
  // window.innerWidth report the new value. A fixed sleep is a bet on machine
  // load, and it lost - during a 32-revert harness run (32 back-to-back
  // Electron launches) the narrow-window section measured windowWidth=1988
  // after asking for 1000. That surfaced as R72 failing on its VACUITY GUARD
  // instead of its own assertion, i.e. the guard doing exactly its job; had the
  // guard not been there, a measurement taken at the wrong window size would
  // have been recorded as a real result.
  //
  // So: set the bounds, then wait for the RENDERER to agree - poll until
  // innerWidth has actually moved and then held still. A no-op resize is
  // detected up front, because "wait for it to change" would otherwise never
  // be satisfied.
  //
  // Two hardenings after a full-suite run (10 back-to-back Electron launches)
  // left this section measuring 1988 after asking for 1000, failing five
  // assertions that passed when the suite ran alone:
  //   - unmaximize before EVERY resize, not once at the top. Windows silently
  //     ignores setBounds on a maximized window, so a single unmaximize at the
  //     start is not enough if anything re-maximizes later - and an ignored
  //     resize is indistinguishable from a slow one.
  //   - re-issue setBounds while polling instead of asking once and waiting.
  //     A dropped request then costs 500ms rather than the whole section.
  // Neither can turn a real failure green: if the window still never settles
  // the warning is printed and the vacuity guards below fail as before.
  // "Has the resize actually landed?" is decided WITHOUT any chrome constant.
  //
  // This was a hard-coded 40px outer-vs-inner overhead, then a measured-and-
  // cached one. Both were wrong in kind, not just in value: any cached constant
  // can be sampled during the unmaximize transition and poisoned, and both
  // poisoning directions are silent. Measured with a deliberate re-maximize, the
  // first sample read outer=2000 against inner=4288 (delta -2288); the one-shot
  // version cached Math.max(0, -2288) + 8 = 8, which sets the target inner width
  // to 1992 on a window whose real inner width tops out at 1988, so no resize
  // could ever count as arrived. A stability+plausibility guard fixed that case
  // but not the class: a wrong-but-stable delta that still falls inside the
  // plausible range would be cached just as happily.
  //
  // So use the signal Electron already provides exactly. MEASURED on this box:
  //     settled 1200 window : inner 1188, contentBounds 1188, bounds 1200
  //     maximized           : inner 2752, contentBounds 2752, bounds 2766
  //     25ms into a resize  : inner 1188, contentBounds 1988, bounds 2000
  // getContentBounds() reports the content size the window is MOVING TO and
  // innerWidth reports what the page has actually laid out at, so they are equal
  // exactly when the page has caught up, at any DPR, theme or scrollbar width.
  // getBounds() is the unreliable one - it reported the requested 2000 while the
  // page was still at 1188 - so it is used only to confirm the window accepted
  // the request at all (a setBounds swallowed by a maximized window leaves it at
  // the old value, which is how an ignored resize is told apart from a slow one).
  const contentWidth = () => win.getContentBounds().width;

  async function resizeWindow(bounds) {
    const read = () =>
      exec("window.innerWidth + 'x' + window.innerHeight").then(String);
    const innerWidth = (s) => parseInt(String(s).split("x")[0], 10) || 0;
    // "Arrived" = the page's own width agrees with the window's content width.
    // Compared with a 1px tolerance rather than strictly: at fractional DPR
    // (1.25, 1.5) the main process and the renderer can round the same CSS
    // rectangle differently and sit 1px apart forever.
    const arrived = (s) => Math.abs(contentWidth() - innerWidth(s)) <= 1;
    // Separately, confirm the window ACCEPTED the request. A setBounds swallowed
    // by a maximized window leaves getBounds at its old value, and without this
    // an ignored resize would look identical to a settled one - the page and the
    // content bounds would agree perfectly, just at the wrong size.
    const accepted = () =>
      bounds.width === undefined || win.getBounds().width === bounds.width;

    const cur = win.getBounds();
    const same = ["x", "y", "width", "height"].every(
      (k) => bounds[k] === undefined || bounds[k] === cur[k],
    );
    // The early-out used to trust getBounds() alone. It reports the size that
    // was REQUESTED, which under full-suite load can be true while the page is
    // still laid out at the previous size - measured: getBounds said 2000 while
    // window.innerWidth was still 988, and the section went on to record six
    // geometric failures that named tables rather than the window. Confirm
    // against the page before believing it.
    if (same && arrived(await read())) {
      await sleep(150);
      return;
    }
    const before = await read();
    if (win.isMaximized()) win.unmaximize();
    win.setBounds(bounds);
    let last = before;
    let stable = 0;
    for (let i = 0; i < 240; i++) {
      await sleep(25);
      const now = await read();
      // Both halves are needed and neither is sufficient. getContentBounds()
      // reports what the main process last heard from the OS, so it can already
      // read the new size while the renderer is still laying out; requiring the
      // page's own reading to stop moving as well is what makes this a settled
      // condition rather than a snapshot of one side of the handover.
      stable = accepted() && arrived(now) && now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 3) return;
      if (i > 0 && i % 20 === 0 && !(accepted() && arrived(last))) {
        if (win.isMaximized()) win.unmaximize();
        win.setBounds(bounds);
        // A page that Chromium has marked occluded stops laying out, so it will
        // never agree with the window no matter how many times the bounds are
        // re-issued (measured: innerWidth frozen at 988 for six seconds while
        // contentWidth tracked every request). test-visual-utils.js disables
        // native occlusion detection, which should prevent this outright; this
        // is the second line of defence, because a switch name is an
        // implementation detail of the Electron version and this is not.
        try {
          const hidden = await exec("document.hidden");
          if (hidden) {
            win.showInactive();
            win.moveTop();
          }
        } catch {
          /* the page may be mid-navigation; the next iteration retries */
        }
      }
    }
    // Fail loud and name the cause. Letting this through means every geometric
    // assertion below is measured against the wrong window, and the failures it
    // produces point at the tables instead of at the resize that never happened.
    //
    // The detail is deliberately rich. Twice now this has failed only under
    // full-suite load, where the cheap fields (requested vs innerSize) said
    // "stuck" without saying why, and the diagnosis cost a full run each time.
    // Everything below is read only on the failure path, so it costs nothing
    // when the resize works.
    let pageDiag = "{}";
    try {
      pageDiag = await exec(
        "JSON.stringify({dpr:devicePixelRatio," +
          "docClient:document.documentElement.clientWidth," +
          "vv:(window.visualViewport?Math.round(window.visualViewport.width):null)," +
          "vvScale:(window.visualViewport?window.visualViewport.scale:null)," +
          "outer:window.outerWidth," +
          "htmlZoom:getComputedStyle(document.documentElement).zoom," +
          "bodyZoom:getComputedStyle(document.body).zoom," +
          "hidden:document.hidden,vis:document.visibilityState})",
      );
    } catch (e) {
      pageDiag = "exec failed: " + e.message;
    }
    check(
      "the window reached the size this section measures at",
      false,
      JSON.stringify({
        requested: bounds,
        innerSize: last,
        contentWidth: contentWidth(),
        outerWidth: win.getBounds().width,
        accepted: accepted(),
        // Which window are we actually driving? A second BrowserWindow left
        // open by an earlier section would make every measurement below
        // describe a popup rather than the document.
        windowCount: BrowserWindow.getAllWindows().length,
        isTarget: BrowserWindow.getAllWindows()[0] === win,
        flags: {
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          maximized: win.isMaximized(),
          fullScreen: win.isFullScreen(),
          resizable: win.isResizable(),
          focused: win.isFocused(),
        },
        min: win.getMinimumSize(),
        max: win.getMaximumSize(),
        zoomFactor: win.webContents.getZoomFactor(),
        page: pageDiag,
      }),
    );
  }

  // Every assertion in this suite is geometric - how much room a table has to
  // widen into - and main.js persists window bounds on every resize, move and
  // close (main.js:485-488). Sections below deliberately shrink the window, so
  // without pinning it here the NEXT run starts at whatever size the last one
  // happened to leave behind, and assertions pass or fail on history rather
  // than on behaviour. This was not theoretical: it silently changed the result
  // of the unbreakable-token and context-menu assertions between runs.
  win.unmaximize();
  await resizeWindow({ x: 40, y: 40, width: 2000, height: 1100 });

  await exec("localStorage.clear(); null");
  await exec(`renderMarkdown(${JSON.stringify(DOC)}, "full")`);
  await sleep(1800);

  const m = JSON.parse(await exec(MEASURE));
  const [mixed, uniform, wide, unbreakable, huge] = m.tables;
  check("all seven sample tables rendered", m.tables.length === 7, m.tables.length);

  // --- 0. The app's own typeface is really loaded -------------------------
  // 'Fira Code Local' is not decorative and this is not a cosmetic assertion.
  // styles.css uses it for the whole UI (194, 271, 511, 536) and for every code
  // block, and THIS SUITE MEASURES IN IT: measureTextColumnCap() sizes a prose
  // column by rendering 66 zeros in the real cell's resolved font. A silent
  // fallback to Segoe UI would move every geometric number below while every
  // assertion still reported PASS.
  //
  // It can fail silently for an entirely ordinary reason: the TTFs live in the
  // gitignored fonts/ BUILD OUTPUT, copied there by scripts/vendor-libs.js from
  // the tracked assets/fonts/. If that copy ever stops happening the @font-face
  // rules simply never match and the app quietly drops to a fallback. Nothing
  // else in the suite would notice.
  //
  // document.fonts.check() ALONE IS VACUOUS - it answers "can this spec be
  // rendered", and fallback always can, so it returns true for a family nobody
  // defined. So this instead (a) loads each weight the stylesheet declares,
  // (b) requires a real FontFace registered as 'loaded' for each, and
  // (c) requires the glyphs to measure differently from a deliberately absent
  // family, which is the part that cannot be satisfied by fallback.
  const cssText = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  // Pin the exact {weight, file} pairs, not just "some weights". Deriving the
  // expectation from the stylesheet keeps it self-maintaining, but a loose
  // derivation can SHRINK SILENTLY: extracting only /font-weight:\s*(\d+)/ and
  // then .filter(Boolean) would quietly drop a face that switched to `bold`,
  // `normal` or a variable range like `400 700`, and the suite would go on
  // reporting PASS while covering one fewer weight. So parse the weight
  // permissively, normalise the keywords, and require one weight per face.
  const faceBlocks = [...cssText.matchAll(/@font-face\s*{[^}]*}/gi)].filter(
    (b) => /FiraCode-[^'")]+\.ttf/i.test(b[0]),
  );
  const WEIGHT_KEYWORDS = { normal: "400", bold: "700" };
  const declaredFaces = faceBlocks.map((b) => {
    const raw = (b[0].match(/font-weight:\s*([^;}]+)/i) || [])[1];
    const first = raw ? String(raw).trim().split(/\s+/)[0].toLowerCase() : "";
    return {
      file: (b[0].match(/FiraCode-[^'")]+\.ttf/i) || [])[0],
      weight: WEIGHT_KEYWORDS[first] || first,
    };
  });
  const declaredWeights = [...new Set(declaredFaces.map((f) => f.weight))];
  check(
    "styles.css declares Fira Code faces for this assertion to verify",
    faceBlocks.length > 0,
    `${faceBlocks.length} face(s)`,
  );
  // Guards the derivation itself: if the weight parse ever returns nothing for
  // a face, that face silently stops being covered by the assertion below.
  check(
    "every declared Fira Code face yielded a usable weight and file",
    declaredFaces.length === faceBlocks.length &&
      declaredFaces.every((f) => /^\d+$/.test(f.weight) && f.file),
    JSON.stringify(declaredFaces),
  );
  // The files must also actually be vendored - styles.css can name a face whose
  // TTF was never copied into the gitignored fonts/ build output.
  const missingFiles = declaredFaces
    .map((f) => f.file)
    .filter((f) => f && !fs.existsSync(path.join(__dirname, "..", "fonts", f)));
  check(
    "every Fira Code file styles.css names exists in the vendored fonts/ output",
    missingFiles.length === 0,
    JSON.stringify(missingFiles),
  );

  const fira = JSON.parse(
    await exec(`(async () => {
      const weights = ${JSON.stringify(declaredWeights)};
      for (const w of weights) {
        try { await document.fonts.load(w + ' 16px "Fira Code Local"'); } catch (e) {}
      }
      const norm = (s) => String(s).replace(/^['"]|['"]$/g, '');
      const faces = [...document.fonts].filter((f) => norm(f.family) === 'Fira Code Local');
      const ctx = document.createElement('canvas').getContext('2d');
      const sample = 'MMMiiill 0O1lI wwwmmm';
      const widthOf = (fam) => {
        ctx.font = '40px "' + fam + '", monospace';
        return ctx.measureText(sample).width;
      };
      const absent = widthOf('Mdv Deliberately Absent Family');
      return JSON.stringify({
        loaded: faces.filter((f) => f.status === 'loaded').map((f) => String(f.weight)),
        distinct: Math.abs(widthOf('Fira Code Local') - absent) > 1,
        uiFamily: getComputedStyle(document.body).fontFamily,
      });
    })()`),
  );
  const missingWeights = declaredWeights.filter((w) => !fira.loaded.includes(w));
  check(
    "every Fira Code weight the stylesheet declares is really loaded",
    missingWeights.length === 0,
    `missing ${JSON.stringify(missingWeights)} of ${JSON.stringify(declaredWeights)}; loaded=${JSON.stringify(fira.loaded)}`,
  );
  // The non-vacuous half: fallback can satisfy .check(), it cannot satisfy this.
  check(
    "Fira Code glyphs measure differently from an undefined family, so the face is in use",
    fira.distinct === true,
    JSON.stringify(fira),
  );
  check(
    "the app UI actually asks for Fira Code Local first",
    /^['"]?Fira Code Local/.test(fira.uiFamily),
    fira.uiFamily,
  );

  // --- 1. Column widths follow content -----------------------------------
  check(
    "tables use content-aware layout, not an equal split",
    mixed.layout === "auto",
    mixed.layout,
  );
  const desc = mixed.cols[3];
  const descShare = desc.width / mixed.tableWidth;
  check(
    "the column holding most of the text gets most of the width",
    descShare > 0.6,
    `description column has ${(descShare * 100).toFixed(1)}% of the table width`,
  );
  // The direct expression of the reported bug: under `fixed` every column had
  // the same width, so this ratio was exactly 1.
  const widest = Math.max(...mixed.cols.map((c) => c.width));
  const narrowest = Math.min(...mixed.cols.map((c) => c.width));
  check(
    "columns are not all the same width when their contents differ",
    widest / narrowest > 3,
    `widest/narrowest = ${(widest / narrowest).toFixed(2)}`,
  );

  // --- 2. Uniform tables are left alone ----------------------------------
  const uw = uniform.cols.map((c) => c.width);
  const spread = (Math.max(...uw) - Math.min(...uw)) / Math.max(...uw);
  check(
    "columns with equivalent content keep equal widths",
    spread < 0.05,
    `spread ${(spread * 100).toFixed(1)}% across ${JSON.stringify(uw.map(Math.round))}`,
  );

  // --- 3. Reading column is preserved unless the table needs more ---------
  check(
    "a table that fits is not widened beyond the reading column",
    mixed.breakout === false && Math.round(mixed.tableWidth) <= Math.round(m.viewerWidth),
    `breakout=${mixed.breakout} tableWidth=${Math.round(mixed.tableWidth)} viewer=${Math.round(m.viewerWidth)}`,
  );
  check(
    "a uniform table that fits is not widened either",
    uniform.breakout === false,
    uniform.breakout,
  );

  // --- 4. The screenshot finding, as an assertion -------------------------
  // A header that is taller than one line of its own text is wrapping, and for
  // these single-word headers that means it has been broken mid-word.
  for (const c of mixed.cols) {
    const contentHeight = c.height - c.padTop - c.padBottom;
    const lines = c.lineHeight > 0 ? contentHeight / c.lineHeight : 0;
    check(
      `header "${c.header}" is not broken across lines`,
      lines < 1.5,
      `content height ${contentHeight.toFixed(1)}px = ${lines.toFixed(2)} lines of ${c.lineHeight}px`,
    );
  }

  // The header assertions above are now *double*-protected: markShortColumns()
  // pins short columns to `nowrap`, which hides a mid-word break even if the
  // cause comes back. So assert the cause directly. `word-break: break-word`
  // offers a break opportunity inside every word, collapsing a cell's
  // min-content width to one character; `overflow-wrap: break-word` leaves
  // min-content at the longest word. Measured on real cells so the live
  // stylesheet - not a copy of it - is what answers, and separately for th and
  // td because they are separate rules that can drift apart.
  const mc = JSON.parse(
    await win.webContents.executeJavaScript(`
      (() => {
        const host = document.querySelector('#viewer .markdown-body') || document.getElementById('viewer');
        const measure = (tag) => {
          const probe = document.createElement('table');
          // min-width:0 overrides the stylesheet's min-width:100% on
          // .markdown-body table, which otherwise pins any probe to the full
          // reading column and makes the measurement insensitive to everything.
          probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;min-width:0;';
          const cell = document.createElement(tag);
          cell.textContent = 'Unbreakablewordxyz';
          const tr = document.createElement('tr');
          tr.appendChild(cell);
          probe.appendChild(tr);
          host.appendChild(probe);
          // Sized on the TABLE, not the cell: a cell's own width property is
          // only a suggestion to the table layout algorithm, so setting
          // min-content on the cell leaves it at max-content and the probe
          // reads the same both ways. The table's own min-content width IS the
          // cell's contribution.
          probe.style.width = 'min-content';
          const min = probe.getBoundingClientRect().width;
          probe.style.width = 'max-content';
          const max = probe.getBoundingClientRect().width;
          probe.remove();
          return { min, max };
        };
        return JSON.stringify({ th: measure('th'), td: measure('td') });
      })()
    `),
  );
  for (const [tag, r] of [['header', mc.th], ['body', mc.td]]) {
    check(
      `a ${tag} cell's min-content width is the longest word, not a single character`,
      r.min > r.max * 0.6,
      `min-content=${r.min.toFixed(1)}px max-content=${r.max.toFixed(1)}px (ratio ${(r.min / r.max).toFixed(2)})`,
    );
  }

  // --- 5. Wide tables use the space beside the column instead of clipping --
  check(
    "a table too wide for the reading column is widened",
    wide.breakout === true,
    `breakout=${wide.breakout} containerWidth=${Math.round(wide.containerWidth)}`,
  );
  check(
    "the widened table is no longer clipped",
    wide.clipped === false,
    `clipped=${wide.clipped}`,
  );
  check(
    "the widened table is not clipped by an ancestor either",
    wide.ancestorClip === null,
    JSON.stringify(wide.ancestorClip),
  );
  check(
    "widening never exceeds the space actually available",
    wide.containerWidth <= m.wrapperWidth,
    `container ${Math.round(wide.containerWidth)} vs wrapper ${Math.round(m.wrapperWidth)}`,
  );
  check(
    "widening a table does not make the page scroll sideways",
    m.pageOverflow === false,
    m.pageOverflow,
  );

  // #viewer's overflow was changed to make breakout possible. Vertical
  // scrolling must still work, and it must still be .content-wrapper that
  // scrolls - otherwise every scroll-position feature in the app silently
  // starts reading the wrong element.
  const scroll = JSON.parse(
    await exec(`(() => {
      const w = document.querySelector('.content-wrapper');
      const v = document.getElementById('viewer');
      w.scrollTop = 0;
      w.scrollTop = 250;
      const moved = w.scrollTop;
      w.scrollTop = 0;
      return JSON.stringify({
        wrapperScrolls: w.scrollHeight > w.clientHeight + 1,
        wrapperMoved: moved,
        viewerScrolls: v.scrollHeight > v.clientHeight + 1,
      });
    })()`),
  );
  check(
    "the content wrapper is still the vertical scroller",
    scroll.wrapperScrolls === true && scroll.wrapperMoved > 200,
    JSON.stringify(scroll),
  );
  check(
    "the viewer itself does not scroll",
    scroll.viewerScrolls === false,
    JSON.stringify(scroll),
  );

  // --- 6c. Short values in a dense table stay on one line -----------------
  // Found by looking at a screenshot: after the blanket `white-space: nowrap`
  // was removed, the 16-column table broke `some-value-0-10` after the hyphen,
  // so every row was two lines tall for no reading benefit. Wrapping is a
  // per-column decision, and this is that finding as an assertion.
  const dense = JSON.parse(
    await exec(`(() => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const t = c.querySelector('table');
      const cells = Array.from(t.querySelectorAll('tbody td'));
      const lines = cells.map(td => {
        const cs = getComputedStyle(td);
        const lh = parseFloat(cs.lineHeight);
        // Padding is part of the border box but not of the text, so dividing
        // the raw height by the line height reports 1.67 lines for a cell that
        // plainly holds one. Measure the content box.
        const content =
          td.getBoundingClientRect().height -
          parseFloat(cs.paddingTop) -
          parseFloat(cs.paddingBottom) -
          parseFloat(cs.borderTopWidth) -
          parseFloat(cs.borderBottomWidth);
        return content / lh;
      });
      return JSON.stringify({
        cells: cells.length,
        nowrapCells: cells.filter(td => td.classList.contains('nowrap-col')).length,
        maxLines: Math.max(...lines),
        scrolls: c.scrollWidth > c.clientWidth + 1,
        containerWidth: c.getBoundingClientRect().width,
        tableWidth: t.getBoundingClientRect().width,
      });
    })()`),
  );
  check(
    "every column of the dense table is recognised as holding short values",
    dense.cells === 48 && dense.nowrapCells === 48,
    JSON.stringify(dense),
  );
  check(
    "short values in a dense table are not broken across lines",
    dense.maxLines < 1.6,
    JSON.stringify(dense),
  );
  check(
    "a dense table that fits the window does not keep a horizontal scrollbar",
    dense.scrolls === false,
    JSON.stringify(dense),
  );

  // --- 6d. A narrow window must wrap rather than scroll -------------------
  // The window can be smaller than the table's preferred width, and then there
  // is nothing left to widen into. Wrapping the short columns is the lesser
  // evil at that point: a horizontal scrollbar is exactly what this redesign
  // set out to remove. This is also the only path that exercises wrap-anyway,
  // so without it that rule would ship unproven.
  const originalBounds = win.getBounds();
  await resizeWindow({ ...originalBounds, width: 1000 });
  await exec(`applyTableBreakout(); null;`);
  await sleep(300);
  const narrow = JSON.parse(
    await exec(`(() => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const t = c.querySelector('table');
      const cells = Array.from(t.querySelectorAll('tbody td'));
      const lines = cells.map(td => {
        const cs = getComputedStyle(td);
        return (
          td.getBoundingClientRect().height -
          parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) -
          parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)
        ) / parseFloat(cs.lineHeight);
      });
      return JSON.stringify({
        windowWidth: window.innerWidth,
        wrapAnyway: t.classList.contains('wrap-anyway'),
        scrolls: c.scrollWidth > c.clientWidth + 1,
        offWindow:
          c.getBoundingClientRect().left < -1 ||
          c.getBoundingClientRect().right > window.innerWidth + 1,
        maxLines: Math.max(...lines),
      });
    })()`),
  );
  await resizeWindow(originalBounds);
  await exec(`applyTableBreakout(); null;`);
  await sleep(300);
  check(
    "the narrow-window case really narrowed the window",
    narrow.windowWidth < 1050,
    JSON.stringify(narrow),
  );
  check(
    "a table too wide even for a narrow window wraps instead of scrolling",
    narrow.wrapAnyway === true && narrow.scrolls === false,
    JSON.stringify(narrow),
  );
  check(
    "a table in a narrow window still does not leave the window",
    narrow.offWindow === false,
    JSON.stringify(narrow),
  );

  // The narrow split pane needs its own wrap decision, rather than inheriting
  // the normal viewer's choice or dropping wrapping with breakout.
  await resizeWindow({ ...originalBounds, width: 1000 });
  await exec(`applyTableBreakout(); null;`);
  await sleep(200);
  const strandedWrap = JSON.parse(
    await exec(`(async () => {
      const t = document.querySelectorAll('#viewer .table-container')[4].querySelector('table');
      const before = t.classList.contains('wrap-anyway');
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      const inSplit = document.querySelector('.content-wrapper').classList.contains('split-view');
      const after = t.classList.contains('wrap-anyway');
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      return JSON.stringify({ before, inSplit, after });
    })()`),
  );
  await resizeWindow(originalBounds);
  await exec(`applyTableBreakout(); null;`);
  await sleep(300);
  check(
    "the stranded-wrap case really started with wrap-anyway set, in split view",
    strandedWrap.before === true && strandedWrap.inSplit === true,
    JSON.stringify(strandedWrap),
  );
  check(
    "wrap-anyway is recomputed for a narrow split pane",
    strandedWrap.after === true,
    JSON.stringify(strandedWrap),
  );

  // --- 7. Breakout must survive being recalculated ------------------------
  // A widened container measures as "fits" precisely because it was widened,
  // so an implementation that does not reset first can neither drop a breakout
  // that is no longer wanted nor resize one whose budget has changed.
  const repeat = JSON.parse(
    await exec(`(() => {
      const c = document.querySelectorAll('#viewer .table-container')[2];
      // Sampled after EVERY call, not only after the last.
      //
      // Reading just the end state makes the result depend on the PARITY of
      // the number of recalculations: an implementation that oscillates
      // (add, remove, add, ...) lands on a correct-looking final state whenever
      // the count happens to be odd. That is not a hypothetical - R57, the
      // revert that installs exactly that oscillation, flipped between PROVEN
      // and WRONG-GUARD between two runs of this suite, because a debounced
      // ResizeObserver recalculation landed at a different moment and changed
      // the parity. Idempotence is the property actually being claimed here, so
      // measure every step of it.
      //
      // Sampling every step does not merely tolerate that flake, it removes the
      // dependency: the samples alternate whatever the starting state is, so a
      // single add/remove flip fails the assertion regardless of how many
      // recalculations happened to precede it.
      const seq = [];
      for (let i = 0; i < 3; i++) {
        applyTableBreakout();
        seq.push({
          broken: c.classList.contains('table-breakout'),
          width: c.getBoundingClientRect().width,
        });
      }
      return JSON.stringify({
        seq,
        stillBroken: seq.every(s => s.broken),
        sameWidth: seq.every(s => Math.abs(s.width - seq[0].width) < 2),
        width: seq[seq.length - 1].width,
      });
    })()`),
  );
  check(
    "breakout survives repeated recalculation",
    repeat.stillBroken === true,
    JSON.stringify(repeat),
  );
  check(
    "every recalculation lands on the same width, not just the last one",
    repeat.sameWidth === true,
    JSON.stringify(repeat),
  );
  check(
    "repeated recalculation does not change the widened width",
    Math.abs(repeat.width - wide.containerWidth) < 2,
    `${Math.round(repeat.width)} vs ${Math.round(wide.containerWidth)}`,
  );

  // --- 8. Split view halves the space; breakout must follow ---------------
  // Driven through the real toggle, not by setting the class, so this covers
  // the wiring too: entering edit mode does not fire `resize`, so nothing
  // recalculates unless that code path asks for it. The HUGE table is the
  // subject because its full-window breakout is wider than the split-view
  // pane - the 8-column one simply fits and would prove nothing.
  const split = JSON.parse(
    await exec(`(async () => {
      const w = document.querySelector('.content-wrapper');
      const v = document.getElementById('viewer');
      const c = document.querySelectorAll('#viewer .table-container')[4];
      // A breakout was once observed surviving into split view in a single run
      // that has not reproduced since. Rather than loosen the assertion, every
      // class change on the container is recorded with the split-view state at
      // that instant, so a recurrence reports which transition re-applied it
      // instead of just failing with a boolean.
      const mutations = [];
      const mo = new MutationObserver(() => {
        mutations.push({
          t: Math.round(performance.now()),
          cls: c.className,
          split: w.classList.contains('split-view'),
        });
      });
      mo.observe(c, { attributes: true, attributeFilter: ['class', 'style'] });
      // Vacuity guard for the two synchronous reads below: the table must be
      // widened BEFORE the click, or "not widened after it" is satisfied by a
      // scenario in which nothing ever happened.
      const preEnter = {
        broken: c.classList.contains('table-breakout'),
        width: c.getBoundingClientRect().width,
      };
      document.getElementById('toggleEdit').click();
      // Read SYNCHRONOUSLY, before yielding. No task boundary has occurred, so
      // the 120ms debounce provably cannot have run: whatever is true here was
      // done by the transition handler itself. getBoundingClientRect() forces
      // layout, and nothing in the split-view rules transitions, so this is the
      // final geometry rather than a frame mid-animation.
      //
      // PRECONDITION, and it is worth knowing before editing the handler: this
      // oracle depends on toggleEditBtn's click handler reaching
      // applyTableBreakout() before its FIRST await. It has one today, guarded
      // on an in-flight save (renderer.js), which this scenario never has. If
      // an await is ever added ahead of the recalculation, click() will return
      // before it runs and these two assertions fail on healthy code - loudly,
      // on the clean tree, not silently.
      const syncEnter = {
        broken: c.classList.contains('table-breakout'),
        width: c.getBoundingClientRect().width,
      };
      await new Promise(r => setTimeout(r, 500));
      const inSplitView = w.classList.contains('split-view');
      const tr = c.getBoundingClientRect();
      const er = document.getElementById('editorPanel').getBoundingClientRect();
      // Whatever the layout does to widths, the user must still be able to
      // reach the bottom of the document while editing. Note that setting
      // scrollTop by hand proves nothing: an "overflow: hidden" box is still
      // programmatically scrollable, it just offers the user no scrollbar and
      // no wheel response. So this looks for an ancestor whose COMPUTED
      // overflow-y actually invites scrolling.
      let scroller = null;
      for (let n = c; n && n !== document.documentElement; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
          scroller = (n.id ? '#' + n.id : '') + '.' + (n.className || n.tagName);
          break;
        }
      }
      const contentTaller =
        Math.max(v.scrollHeight, w.scrollHeight) > w.clientHeight + 1;
      const stillBroken = c.classList.contains('table-breakout');
      const liveNow = document.querySelectorAll('#viewer .table-container')[4];
      const diag = {
        sameNode: liveNow === c,
        connected: c.isConnected,
        clientWidth: c.clientWidth,
        liveBroken: liveNow ? liveNow.classList.contains('table-breakout') : null,
        hiddenBySection: !!(c.closest('.collapsible-section') || {}).classList
          && c.closest('.collapsible-section').classList.contains('collapsed'),
      };
      document.getElementById('toggleEdit').click();
      const syncExitWidth = c.getBoundingClientRect().width;
      await new Promise(r => setTimeout(r, 500));
      const restored = c.getBoundingClientRect().width;
      mo.disconnect();
      return JSON.stringify({
        inSplitView,
        preEnter,
        syncEnter,
        syncExitWidth,
        inSplit: tr.width,
        editorWidth: er.width,
        // The invariant that actually matters, measured independently of how
        // the implementation computes its budget.
        overlapsEditor: tr.left < er.right - 1 && tr.right > er.left + 1,
        offWindow: tr.left < -1 || tr.right > window.innerWidth + 1,
        contentTaller,
        scroller,
        stillBroken,
        diag,
        mutations,
        restored,
      });
    })()`),
  );
  check(
    "clicking edit really entered split view",
    split.inSplitView === true && split.editorWidth > 100,
    JSON.stringify(split),
  );
  check(
    "the split-view sample document is actually taller than the window",
    split.contentTaller === true,
    JSON.stringify(split),
  );
  check(
    "the preview offers the user a way to scroll in split view",
    split.scroller !== null,
    JSON.stringify(split),
  );
  check(
    "breakout is stood down in split view, where the reading column does not apply",
    split.stillBroken === false,
    JSON.stringify(split),
  );
  check(
    "a widened table never overlaps the editor pane in split view",
    split.overlapsEditor === false,
    JSON.stringify(split),
  );
  check(
    "a widened table stays inside the window in split view",
    split.offWindow === false,
    JSON.stringify(split),
  );
  check(
    "leaving split view restores the full widened width",
    Math.abs(split.restored - huge.containerWidth) < 2,
    JSON.stringify(split) + ` expected ${Math.round(huge.containerWidth)}`,
  );

  // --- 8a0. The transition recalculates AT the transition, not 120ms later --
  //
  // MEASURED, because reverting the two explicit applyTableBreakout() calls in
  // the edit-mode handlers left every assertion above green - which would have
  // made them look like dead code. Instrumenting applyTableBreakout with a
  // stack trace across a real toggle showed what actually happens:
  //   enter: t+1ms   from renderer.js (the transition handler)
  //          t+141ms from a timer, no caller frames
  //   exit:  t+1225ms from renderer.js
  //          t+1364ms from a timer, no caller frames
  // The timer is the 120ms debounce, and the thing that schedules it is the
  // ResizeObserver on .content-wrapper - added later, for the ToC drawer. That
  // attribution is MEASURED, not inferred from "what else could it be": a
  // second probe attached its own ResizeObserver to .content-wrapper and a
  // listener to window resize across the same toggle. The observer fired with
  // contentRect.width changing 1972 <-> 1988, and window resize fired ZERO
  // times. #viewer becomes its own scroller in split view, so .content-wrapper
  // loses its 16px scrollbar. Note the BORDER-BOX width never moves at all,
  // which is why this had to be measured rather than reasoned about - reading
  // the code, or even getBoundingClientRect(), says nothing changed.
  //
  // So the explicit calls are not redundant, and the observer is not useless:
  // the observer is a backstop that arrives ~140ms late, and the explicit call
  // is what stops the user seeing a table at the wrong width for that long -
  // widened tables clipped inside the half-width pane on the way in, and a
  // narrow table in a full-width window on the way out.
  //
  // The assertions above could not see any of this because they settle for
  // 500ms first, by which time the backstop has cleaned up. These two read the
  // state synchronously, before any task boundary, where only the transition
  // handler can have acted.
  check(
    "the split-view scenario starts from a widened table",
    split.preEnter.broken === true && split.preEnter.width > split.inSplit + 1,
    JSON.stringify(split.preEnter) + ` vs inSplit ${Math.round(split.inSplit)}`,
  );
  check(
    "entering split view stands the breakout down at the transition, not 140ms later when the observer catches up",
    split.syncEnter.broken === false,
    JSON.stringify(split.syncEnter),
  );
  check(
    // Baselined against this scenario's OWN settled width rather than against
    // huge.containerWidth, which was captured before section 6d resized the
    // window to 1000 and back. Two independent resize/re-measure cycles can
    // differ by more than the 2px tolerance on a different DPI without
    // anything being wrong. What is claimed here is that the transition lands
    // on the final width immediately; that the final width is CORRECT is the
    // separate settled assertion above, which R56 lists in mustPass.
    "leaving split view restores the widened width at the transition, not 140ms later",
    Math.abs(split.syncExitWidth - split.restored) < 2,
    `${Math.round(split.syncExitWidth)} at the transition vs ${Math.round(split.restored)} once settled`,
  );

  // --- 8b0. The per-call cap memo must actually memoise -------------------
  // measureTextColumnCap inserts a probe table, forces a layout and removes it.
  // Doing that once per table is pure waste when a document's tables share a
  // shape, so the cap is memoised for the lifetime of a single
  // applyTableBreakout() call. "It is memoised" is easy to believe and easy to
  // get wrong, so it is measured rather than assumed: a MutationObserver counts
  // the probe tables actually inserted into #viewer during one call.
  //
  // Deliberately a per-CALL memo, never a persistent cache. The stylesheet's
  // min() budget clamp catches a cached width that has gone too WIDE (that is
  // what 8d/R70 prove) but nothing catches one that has gone too NARROW - and a
  // too-narrow cap renders as a cramped table, which is the original complaint.
  // A memo that is created and discarded inside one call cannot go stale at all.
  const memoised = JSON.parse(
    await exec(`(async () => {
      const probes = [];
      const collect = (records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeName === 'TABLE' && n.style.visibility === 'hidden') probes.push(n.className);
          }
        }
      };
      const obs = new MutationObserver(collect);
      obs.observe(viewer, { childList: true, subtree: true });
      applyTableBreakout();
      // Drain synchronously. MutationObserver callbacks fire at the microtask
      // checkpoint, and disconnect() throws the pending queue away - so reading
      // the counter after disconnect() would report zero probes and this test
      // would "pass" having observed nothing.
      collect(obs.takeRecords());
      obs.disconnect();
      const containers = [...document.querySelectorAll('#viewer .table-container')]
        .filter((c) => c.clientWidth > 0);
      return JSON.stringify({
        containers: containers.length,
        probes: probes.length,
        shapes: [...new Set(probes)].length,
      });
    })()`),
  );
  check(
    "the memo test really has several tables to measure",
    memoised.containers >= 5,
    JSON.stringify(memoised),
  );
  check(
    "the column-cap probe runs once per table SHAPE, not once per table",
    memoised.probes > 0 && memoised.probes < memoised.containers,
    JSON.stringify(memoised) + " (className is only a coarse proxy here; 8b1 is the real test)",
  );

  // --- 8b1. The memo must not conflate tables that only LOOK alike ---------
  // Found by review, not by measurement, and it was real. The probe is inserted
  // INTO the container and cloned FROM the cell, so its result depends on
  // inherited typography and on the cell's own class/style - none of which the
  // table's className describes. Two tables of identical markdown and identical
  // class, one inside `<div style="font-size:60%">`, must therefore be measured
  // SEPARATELY. Keyed on className alone, the first seeded a cap the second
  // reused, and one of the two silently got the wrong reading measure - the
  // cramped-column bug this whole redesign exists to remove, reintroduced by
  // its own optimisation.
  //
  // The promise being checked is the one the design actually makes: a prose
  // column is capped at a number of CHARACTERS, not a number of pixels. So the
  // two tables must land on the same character measure precisely BECAUSE their
  // pixel caps differ.
  const conflate = JSON.parse(
    await exec(`(async () => {
      await renderMarkdown(${JSON.stringify(FONT_CONTEXT)}, "full");
      await new Promise(r => setTimeout(r, 400));
      const probes = [];
      const collect = (records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeName === 'TABLE' && n.style.visibility === 'hidden') probes.push(1);
          }
        }
      };
      const obs = new MutationObserver(collect);
      obs.observe(viewer, { childList: true, subtree: true });
      applyTableBreakout();
      collect(obs.takeRecords());
      obs.disconnect();
      await new Promise(r => setTimeout(r, 200));

      const measure = (c) => {
        const cells = c.querySelectorAll('tbody tr')[0].cells;
        const cell = cells[cells.length - 1];
        const p = document.createElement('span');
        p.style.cssText = 'position:absolute;white-space:pre;visibility:hidden;';
        p.textContent = '0'.repeat(50);
        cell.appendChild(p);
        const ch = p.getBoundingClientRect().width / 50;
        p.remove();
        const table = c.querySelector('table');
        const head = table.querySelector('tr').cells[0];
        // memo omitted deliberately: this must be a fresh, uncached probe.
        const cap = measureTextColumnCap(c, table, head);
        return {
          fontSize: getComputedStyle(cell).fontSize,
          cap,
          capChars: cap / ch,
        };
      };
      const cs = [...document.querySelectorAll('#viewer .table-container')];
      return JSON.stringify({
        containers: cs.length,
        probes: probes.length,
        small: measure(cs[0]),
        normal: measure(cs[1]),
      });
    })()`),
  );
  check(
    "the two same-class tables really do render at different font sizes",
    conflate.containers === 2 &&
      parseFloat(conflate.small.fontSize) < parseFloat(conflate.normal.fontSize) - 1,
    JSON.stringify(conflate),
  );
  check(
    "a table in a smaller-font context is measured on its own, not handed a cached cap",
    conflate.probes === 2,
    JSON.stringify(conflate),
  );
  check(
    "each table's cap is its own font's reading measure, not the other table's pixels",
    conflate.small.cap < conflate.normal.cap - 20 &&
      Math.abs(conflate.small.capChars - conflate.normal.capChars) < 6,
    JSON.stringify(conflate),
  );
  await exec(`(async () => {
    await renderMarkdown(${JSON.stringify(DOC)}, "full");
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);

  // --- 8b. A breakout inside a collapsed section must not be lost ---------------
  // A hidden container measures zero, so a recalculation that treats it like
  // any other would strip the breakout it cannot recompute. Expanding the
  // section would then reveal the table squeezed back into the reading column -
  // the very bug this work set out to fix.
  const collapsed = JSON.parse(
    await exec(`(async () => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const section = c.closest('.collapsible-section');
      const before = c.getBoundingClientRect().width;
      section.classList.add('collapsed');
      applyTableBreakout();
      const whileHidden = c.classList.contains('table-breakout');
      section.classList.remove('collapsed');
      await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({
        hasSection: !!section,
        before,
        whileHidden,
        afterExpand: c.getBoundingClientRect().width,
        stillBroken: c.classList.contains('table-breakout'),
      });
    })()`),
  );
  check(
    "the sample table really is inside a collapsible section",
    collapsed.hasSection === true,
    JSON.stringify(collapsed),
  );
  check(
    "recalculating while a section is collapsed does not strip its breakout",
    collapsed.whileHidden === true,
    JSON.stringify(collapsed),
  );
  check(
    "a table expanded back into view keeps its widened width",
    collapsed.stillBroken === true && Math.abs(collapsed.afterExpand - collapsed.before) < 2,
    JSON.stringify(collapsed),
  );

  // --- 8c. The render pipeline must measure AFTER collapse state is applied ---
  // Ordering, made observable. makeHeadersCollapsible() wraps headings into
  // sections and re-applies the reader's restored collapse state; until it has
  // run, the document is transiently FLAT and every table is visible. Measuring
  // in that window hands a width to tables the reader is about to have hidden -
  // a width computed against a layout that never reaches the screen, i.e. stale
  // by construction, and stale widths are what R70/8d exist to contain.
  //
  // So: seed the collapse state, then render the document FRESH (from a
  // placeholder that has no tables at all, so the container is built new rather
  // than reused). The table inside the collapsed section must come out of the
  // pipeline with no breakout width at all. With the measurement running before
  // makeHeadersCollapsible() it comes out carrying one, because at that instant
  // the section does not exist and the table is visible.
  //
  // Rendering fresh is load-bearing. patchViewerDOM reuses nodes, and the reset
  // pass deliberately leaves hidden containers alone (see 8b/R62), so a
  // re-render of the SAME document leaves the width from when the table was
  // last visible - which would read as a failure here while being exactly the
  // behaviour 8b requires. Only a container that has never been visible in this
  // render isolates the ordering.
  //
  // Checked on BOTH render paths - the incremental one and the "full" one have
  // separate call sites, so a single check would leave one of them unguarded.
  for (const mode of ["full", "incremental"]) {
    const renderCall =
      mode === "full"
        ? `renderMarkdown(DOCTEXT, "full")`
        : `renderMarkdown(DOCTEXT)`;
    const ordering = JSON.parse(
      await exec(`(async () => {
      const DOCTEXT = ${JSON.stringify(DOC)};
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const header = c.closest('.collapsible-section').previousElementSibling;
      if (!header || !/^H[1-6]$/.test(header.tagName)) return JSON.stringify({ noHeader: true });
      const headerId = header.id;

      // Wipe the document to something with no tables, so nothing is reused.
      await renderMarkdown("# Placeholder\\n\\nNothing here.\\n", "full");
      await new Promise(r => setTimeout(r, 200));
      const wiped = document.querySelectorAll('#viewer .table-container').length;

      // Heading ids are content slugs, so the same heading gets the same id
      // when the document comes back - which is what makes seeding possible.
      collapsedHeaders.set(_collapseKey(headerId), true);
      await ${renderCall};
      await new Promise(r => setTimeout(r, 400));

      const again = document.querySelectorAll('#viewer .table-container')[4];
      const sec = again && again.closest('.collapsible-section');
      const out = {
        mode: ${JSON.stringify(mode)},
        wiped,
        found: !!again,
        reCollapsed: !!sec && sec.classList.contains('collapsed'),
        hidden: !!again && again.clientWidth === 0,
        declared: again ? again.style.getPropertyValue('--table-breakout-width') : null,
        broken: !!again && again.classList.contains('table-breakout'),
      };
      // Leave the document as it was found for the assertions that follow.
      collapsedHeaders.set(_collapseKey(headerId), false);
      await renderMarkdown(DOCTEXT, "full");
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify(out);
    })()`),
    );
    check(
      `the ${mode} re-render really did build the table fresh inside a restored collapse`,
      ordering.found === true &&
        ordering.wiped === 0 &&
        ordering.reCollapsed === true &&
        ordering.hidden === true,
      JSON.stringify(ordering),
    );
    check(
      `a table hidden by restored collapse state is never measured in the transient flat layout (${mode})`,
      ordering.declared === "" && ordering.broken === false,
      JSON.stringify(ordering),
    );
  }

  // --- 8d. Collapse, resize, expand: the stale-width case ------------------
  // 8b deliberately preserves the breakout of a container it cannot measure.
  // That is right, but it means the preserved width describes a window that no
  // longer exists once the user resizes while the section is shut. Two separate
  // mechanisms have to hold, and they are proven separately because they fail
  // in opposite directions.
  //
  // (i) The stylesheet clamps every breakout to --mv-breakout-budget, which is
  // published on #viewer whether or not any container can be measured. Expanding
  // WITHOUT letting JS recompute must therefore still be inside the window.
  const staleBounds = win.getBounds();
  await exec(`(() => {
    const c = document.querySelectorAll('#viewer .table-container')[4];
    c.closest('.collapsible-section').classList.add('collapsed');
    applyTableBreakout();
    return true;
  })()`);
  await resizeWindow({ ...staleBounds, width: 900 });
  await exec(`applyTableBreakout(); null;`);
  await sleep(200);
  const staleShrink = JSON.parse(
    await exec(`(async () => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const section = c.closest('.collapsible-section');
      const declared = parseFloat(c.style.getPropertyValue('--table-breakout-width'));
      // Expanded by hand, with no recompute, so only the CSS clamp is in play.
      // The heading's own collapsed class is cleared alongside the section's:
      // the delegated click handler derives the section state by toggling the
      // HEADING, so leaving the two out of step would make the next click
      // collapse rather than expand.
      section.classList.remove('collapsed');
      const h = document.getElementById(section.dataset.forHeader);
      if (h) h.classList.remove('collapsed');
      await new Promise(r => setTimeout(r, 150));
      const r = c.getBoundingClientRect();
      return JSON.stringify({
        stillBroken: c.classList.contains('table-breakout'),
        declared,
        windowWidth: window.innerWidth,
        left: Math.round(r.left),
        right: Math.round(r.right),
        offWindow: r.left < -1 || r.right > window.innerWidth + 1,
      });
    })()`),
  );
  check(
    "the stale-width case really is stale (a width wider than the window survived)",
    staleShrink.stillBroken === true && staleShrink.declared > staleShrink.windowWidth,
    JSON.stringify(staleShrink),
  );
  check(
    "a stale breakout revealed by expanding is clamped inside the window by CSS alone",
    staleShrink.offWindow === false,
    JSON.stringify(staleShrink),
  );

  // (ii) Clamping keeps it on screen but leaves it too NARROW if the window grew
  // while the section was shut. Only a recompute fixes that, and it has to be
  // triggered by the real expand path - a delegated click on the heading.
  await exec(`(() => {
    const c = document.querySelectorAll('#viewer .table-container')[4];
    const section = c.closest('.collapsible-section');
    // Recomputed while still visible at the NARROW width, so the width carried
    // into the collapse is genuinely the small one. Without this the container
    // still holds the wide value and the grow case cannot tell a recompute from
    // a no-op.
    applyTableBreakout();
    section.classList.add('collapsed');
    // Kept in step with the section so the click below expands rather than
    // collapsing a second time - the handler toggles the heading, not the
    // section.
    const h = document.getElementById(section.dataset.forHeader);
    if (h) h.classList.add('collapsed');
    applyTableBreakout();
    return true;
  })()`);
  await resizeWindow(staleBounds);
  await exec(`applyTableBreakout(); null;`);
  await sleep(200);
  const staleGrow = JSON.parse(
    await exec(`(async () => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const section = c.closest('.collapsible-section');
      const before = parseFloat(c.style.getPropertyValue('--table-breakout-width'));
      const header = document.getElementById(section.dataset.forHeader);
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const r = c.getBoundingClientRect();
      return JSON.stringify({
        clickedRealHeader: !!header,
        expanded: !section.classList.contains('collapsed'),
        before,
        after: parseFloat(c.style.getPropertyValue('--table-breakout-width')),
        width: Math.round(r.width),
        windowWidth: window.innerWidth,
        offWindow: r.left < -1 || r.right > window.innerWidth + 1,
      });
    })()`),
  );
  check(
    "the grow case drove the real heading-click expand path",
    staleGrow.clickedRealHeader === true && staleGrow.expanded === true,
    JSON.stringify(staleGrow),
  );
  check(
    "expanding after the window grew re-measures instead of keeping the stale narrow width",
    staleGrow.after > staleGrow.before + 1 && staleGrow.width > staleGrow.before + 1,
    JSON.stringify(staleGrow),
  );
  check(
    "the re-measured table is still inside the window",
    staleGrow.offWindow === false,
    JSON.stringify(staleGrow),
  );

  // --- 8c. A >5-column table with one long column stays readable ---------
  // `compact-table` (added at >5 columns) used to also set
  // `white-space: nowrap`, which forced the table to the width of its longest
  // sentence. The equal-width complaint became an unbounded-width one: the
  // description ran off to the right and everything scrolled.
  const compact = JSON.parse(
    await exec(`(() => {
      const c = document.querySelectorAll('#viewer .table-container')[5];
      const t = c.querySelector('table');
      const cells = Array.from(t.querySelectorAll('tbody tr:first-child td'));
      const widths = cells.map(td => td.getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);
      const rowHeight = t.querySelector('tbody tr').getBoundingClientRect().height;
      return JSON.stringify({
        isCompact: t.classList.contains('compact-table'),
        columns: cells.length,
        shortWhiteSpace: getComputedStyle(cells[0]).whiteSpace,
        longWhiteSpace: getComputedStyle(cells[cells.length - 1]).whiteSpace,
        shortLines: Math.round(
          cells[0].getBoundingClientRect().height /
            parseFloat(getComputedStyle(cells[0]).lineHeight),
        ),
        descShare: total ? widths[widths.length - 1] / total : 0,
        scrolls: c.scrollWidth > c.clientWidth + 1,
        rowHeight,
        viewportHeight: window.innerHeight,
      });
    })()`),
  );
  check(
    "the 6-column sample really is treated as a compact table",
    compact.isCompact === true && compact.columns === 6,
    JSON.stringify(compact),
  );
  check(
    "the long column of a compact table wraps instead of running off to the right",
    compact.longWhiteSpace !== "nowrap",
    JSON.stringify(compact),
  );
  check(
    "short columns of a compact table keep their values on one line",
    compact.shortWhiteSpace === "nowrap",
    JSON.stringify(compact),
  );
  check(
    "a compact table with one long column does not scroll horizontally",
    compact.scrolls === false,
    JSON.stringify(compact),
  );
  check(
    "the long column of a compact table gets most of the width",
    compact.descShare > 0.5,
    JSON.stringify(compact),
  );
  check(
    "a compact row does not grow taller than the window",
    compact.rowHeight < compact.viewportHeight,
    JSON.stringify(compact),
  );

  // --- 9. The maximize button lives inside a transformed container --------
  // `transform` makes an element the containing block for its absolutely
  // positioned descendants. The button is pinned to the container's top-right,
  // so if breakout ever moved that reference it would drift off the table.
  const btn = JSON.parse(
    await exec(`(() => {
      const c = document.querySelectorAll('#viewer .table-container')[2];
      const b = c.querySelector('.table-maximize-btn');
      if (!b) return JSON.stringify({ missing: true });
      b.style.opacity = '1';
      const br = b.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      return JSON.stringify({
        missing: false,
        insideRight: br.right <= cr.right + 1 && br.right > cr.right - 60,
        insideTop: br.top >= cr.top - 1 && br.top < cr.top + 60,
        offScreen: br.left < 0 || br.right > window.innerWidth,
      });
    })()`),
  );
  check(
    "the maximize button stays pinned inside a widened table",
    btn.missing === false && btn.insideRight === true && btn.insideTop === true,
    JSON.stringify(btn),
  );
  check(
    "the maximize button is not pushed off screen by the breakout transform",
    btn.offScreen === false,
    JSON.stringify(btn),
  );

  // --- 10. Incremental re-render must not lose the breakout ---------------
  // patchViewerDOM reuses block wrappers, and .table-container is one of them.
  // Adding a class and an inline custom property to a reused wrapper must not
  // confuse the diff, and the breakout must still be there afterwards.
  const patched = JSON.parse(
    await exec(`(async () => {
      const before = document.querySelectorAll('#viewer table').length;
      renderMarkdown(${JSON.stringify(DOC)} + "\\n\\nA trailing paragraph.\\n", "full");
      await new Promise(r => setTimeout(r, 1500));
      const c = document.querySelectorAll('#viewer .table-container')[2];
      return JSON.stringify({
        before,
        after: document.querySelectorAll('#viewer table').length,
        containers: document.querySelectorAll('#viewer .table-container').length,
        stillBroken: c ? c.classList.contains('table-breakout') : null,
        width: c ? c.getBoundingClientRect().width : null,
      });
    })()`),
  );
  check(
    "an incremental re-render does not duplicate tables",
    patched.after === patched.before && patched.containers === patched.before,
    JSON.stringify(patched),
  );
  check(
    "breakout survives an incremental re-render",
    patched.stillBroken === true && Math.abs(patched.width - wide.containerWidth) < 2,
    JSON.stringify(patched),
  );

  // --- 11. Print / PDF export must not inherit a screen-sized breakout ----
  // The widened width is measured from the window and centred by shifting the
  // table half its own width left. On paper #viewer is already full width, so
  // leaving that in place pushes the table off the sheet.
  let printed = null;
  try {
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
    printed = JSON.parse(
      await exec(`(() => {
        const c = document.querySelectorAll('#viewer .table-container')[4];
        const v = document.getElementById('viewer');
        const cs = getComputedStyle(c);
        const vs = getComputedStyle(v);
        const r = c.getBoundingClientRect();
        const vr = v.getBoundingClientRect();
        return JSON.stringify({
          transform: cs.transform,
          marginLeft: cs.marginLeft,
          // How far the container is displaced from where the surrounding
          // content starts. Breakout deliberately makes this non-zero on
          // screen; on paper it must be zero or the table hangs off the sheet.
          offsetFromContent: r.left - (vr.left + parseFloat(vs.paddingLeft)),
          widerThanViewer: r.width > vr.width + 1,
        });
      })()`),
    );
  } finally {
    try {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
      win.webContents.debugger.detach();
    } catch (e) {
      /* nothing to detach */
    }
  }
  check(
    "print media neutralises the breakout transform",
    printed && printed.transform === "none" && parseFloat(printed.marginLeft) === 0,
    JSON.stringify(printed),
  );
  check(
    "a printed table is not displaced from where the content starts",
    printed && Math.abs(printed.offsetFromContent) < 2,
    JSON.stringify(printed),
  );
  check(
    "a printed table is not wider than the page column",
    printed && printed.widerThanViewer === false,
    JSON.stringify(printed),
  );

  // --- 6. An unbreakable token still cannot burst the layout --------------
  check(
    "an unbreakable token does not overflow its table",
    unbreakable.clipped === false,
    `clipped=${unbreakable.clipped} container=${Math.round(unbreakable.containerWidth)} table=${Math.round(unbreakable.tableWidth)} breakout=${unbreakable.breakout} viewer=${Math.round(m.viewerWidth)} wrapper=${Math.round(m.wrapperWidth)}`,
  );
  check(
    "the unbreakable-token table is not clipped by an ancestor",
    unbreakable.ancestorClip === null,
    JSON.stringify(unbreakable.ancestorClip),
  );

  // --- 6b. A very wide table is widened as far as it can be, then scrolls --
  // Past the point where breakout can help, the residual overflow must stay
  // inside the table's own scroller and never leak onto the page.
  check(
    "a very wide table is widened",
    huge.breakout === true,
    `breakout=${huge.breakout} containerWidth=${Math.round(huge.containerWidth)}`,
  );
  check(
    "a very wide table is not clipped by an ancestor",
    huge.ancestorClip === null,
    JSON.stringify(huge.ancestorClip),
  );
  check(
    "a very wide table is wider than the reading column",
    huge.containerWidth > m.viewerWidth,
    `${Math.round(huge.containerWidth)} vs viewer ${Math.round(m.viewerWidth)}`,
  );

  // --- 12. Zoom changes how much window a table can occupy ---------------
  // #viewer is scaled with CSS `zoom`, so a width written onto a descendant is
  // in zoomed pixels while the available space is measured outside the zoomed
  // subtree. Driven through the real zoom button so the wiring is covered too.
  const zoomed = JSON.parse(
    await exec(`(async () => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const out = [];
      const zoomBtn = document.getElementById('zoomIn');
      for (let i = 0; i < 6; i++) {
        zoomBtn.click();
        await new Promise(r => setTimeout(r, 120));
        const r = c.getBoundingClientRect();
        out.push({
          level: document.getElementById('zoomReset').textContent,
          left: Math.round(r.left),
          right: Math.round(r.right),
          overflows: r.left < -1 || r.right > window.innerWidth + 1,
        });
      }
      document.getElementById('zoomReset').click();
      await new Promise(r => setTimeout(r, 200));
      return JSON.stringify(out);
    })()`),
  );
  check(
    "zooming actually changed the zoom level",
    zoomed.length === 6 && zoomed[5].level !== zoomed[0].level,
    JSON.stringify(zoomed.map((z) => z.level)),
  );
  check(
    "a widened table never leaves the window at any zoom level",
    zoomed.every((z) => z.overflows === false),
    JSON.stringify(zoomed.filter((z) => z.overflows)),
  );

  // --- 12b. Zoom coalesces the per-table remeasure, and stays correct ------
  // MEASURED before this was split: one zoom step on a 248 KB / 150-table
  // document cost 250-276ms, of which applyTableBreakout was 235-264ms (~95%,
  // ~1.6ms per table). A held key or a repeated click throws all but the last
  // of those away. The remeasure is therefore coalesced - but the CSS budget
  // clamp, which is the half correctness depends on, is published on EVERY
  // step, so nothing can run off the window while a remeasure is pending.
  //
  // Both assertions are STRUCTURAL. A timing assertion ("a zoom step takes
  // under Nms") is how this suite becomes flaky on a loaded machine, and it
  // would not say what broke.
  const coalesce = JSON.parse(
    await exec(`(async () => {
      const c = document.querySelectorAll('#viewer .table-container')[4];
      const real = window.applyTableBreakout;
      let calls = 0;
      window.applyTableBreakout = function () { calls++; return real.apply(this, arguments); };
      const zoomBtn = document.getElementById('zoomIn');
      const startLevel = document.getElementById('zoomReset').textContent;

      // A burst: six steps with no task boundary between them, which is what a
      // held key produces. The rect is read SYNCHRONOUSLY after the last click,
      // so no timer can have run - only what updateZoom() itself did is visible.
      for (let i = 0; i < 6; i++) zoomBtn.click();
      const burstCalls = calls;
      const rSync = c.getBoundingClientRect();
      const sync = {
        left: Math.round(rSync.left),
        right: Math.round(rSync.right),
        width: Math.round(rSync.width),
        overflows: rSync.left < -1 || rSync.right > window.innerWidth + 1,
        brokenOut: c.classList.contains('table-breakout'),
        budget: getComputedStyle(document.getElementById('viewer')).getPropertyValue('--mv-breakout-budget').trim(),
      };

      // Let the coalesced remeasure land.
      await new Promise(r => setTimeout(r, 400));
      const settledCalls = calls;
      const settledWidth = Math.round(c.getBoundingClientRect().width);

      // The coalesced run must leave FINAL geometry, not an approximation:
      // forcing another full pass may not move anything.
      real();
      await new Promise(r => setTimeout(r, 60));
      const forcedWidth = Math.round(c.getBoundingClientRect().width);

      window.applyTableBreakout = real;
      const endLevel = document.getElementById('zoomReset').textContent;
      document.getElementById('zoomReset').click();
      await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({
        burstCalls, settledCalls, sync, settledWidth, forcedWidth,
        startLevel, endLevel,
        viewportWidth: window.innerWidth,
      });
    })()`),
  );
  // Vacuity guards. Without these, "few remeasures" is satisfied by a burst
  // that never zoomed, and "does not overflow" by a table that never widened.
  check(
    "the zoom burst really moved the zoom level",
    coalesce.startLevel !== coalesce.endLevel,
    JSON.stringify([coalesce.startLevel, coalesce.endLevel]),
  );
  check(
    "the burst table really is broken out of the reading column",
    coalesce.sync.brokenOut === true && coalesce.sync.width > 0,
    JSON.stringify(coalesce.sync),
  );
  check(
    "the coalesced remeasure really ran",
    coalesce.settledCalls >= 1,
    `burst=${coalesce.burstCalls} settled=${coalesce.settledCalls}`,
  );
  // The fix itself: six steps must not buy six full per-table remeasures.
  check(
    "a burst of six zoom steps does not remeasure every table six times",
    coalesce.burstCalls === 0 && coalesce.settledCalls >= 1 && coalesce.settledCalls <= 2,
    `burst=${coalesce.burstCalls} settled=${coalesce.settledCalls} (expected 0, then 1)`,
  );
  // The correctness half, and the reason the remeasure MAY be deferred: the
  // budget is published synchronously, so CSS clamps every stale width in the
  // same frame the zoom lands. Read with no task boundary, so no timer has run.
  check(
    "a table does not leave the window in the frame a zoom burst lands",
    coalesce.sync.overflows === false && coalesce.sync.budget !== "",
    JSON.stringify(coalesce.sync) + ` viewport=${coalesce.viewportWidth}`,
  );
  check(
    "the coalesced remeasure leaves final geometry, not an approximation",
    Math.abs(coalesce.settledWidth - coalesce.forcedWidth) <= 1,
    `settled=${coalesce.settledWidth} forced=${coalesce.forcedWidth}`,
  );

  // --- 13. The reading measure is typographic, not a distance -------------
  // The prose cap exists to stop one long column stretching a line past the
  // point where it is comfortable to read - a property of CHARACTERS, not of
  // pixels. Encoded as a constant it was wrong wherever the font differed from
  // the one it was chosen against: a compact table sets an 11px cell font
  // against the body's 13px, so the same 520px was ~79 characters there and
  // ~62 in a normal table, and inside the `zoom`-scaled subtree it tightened to
  // ~34 characters at 200%. These assert the cap MOVES with the font.
  const capMeasure = JSON.parse(
    await exec(`(() => {
      const chOf = (cell) => {
        const p = document.createElement('span');
        p.style.cssText = 'position:absolute;white-space:pre;visibility:hidden;';
        p.textContent = '0'.repeat(50);
        cell.appendChild(p);
        const w = p.getBoundingClientRect().width / 50;
        p.remove();
        return w;
      };
      const capOf = (i) => {
        const c = document.querySelectorAll('#viewer .table-container')[i];
        const t = c.querySelector('table');
        const cell = t.querySelector('tr').cells[0];
        return { cap: measureTextColumnCap(c, t, cell), ch: chOf(cell), compact: t.classList.contains('compact-table') };
      };
      const normal = capOf(0);
      const compact = capOf(5);
      // The user-facing invariant, measured independently of the cap: the prose
      // column of the reported 4-column case must land inside a readable measure.
      const mixed = document.querySelectorAll('#viewer .table-container')[0];
      const proseCell = mixed.querySelectorAll('tbody td')[3];
      const cs = getComputedStyle(proseCell);
      const proseText =
        proseCell.getBoundingClientRect().width -
        parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return JSON.stringify({
        normal, compact,
        proseChars: proseText / chOf(proseCell),
      });
    })()`),
  );
  check(
    "the compact and normal tables really do render at different font sizes",
    capMeasure.compact.compact === true &&
      capMeasure.compact.ch > 0 &&
      capMeasure.compact.ch < capMeasure.normal.ch - 0.3,
    JSON.stringify(capMeasure),
  );
  check(
    "the prose cap tracks the cell font instead of being a fixed distance",
    capMeasure.compact.cap < capMeasure.normal.cap - 20,
    JSON.stringify(capMeasure),
  );
  check(
    "both tables are capped at the same number of characters, not the same width",
    Math.abs(
      (capMeasure.normal.cap / capMeasure.normal.ch) -
        (capMeasure.compact.cap / capMeasure.compact.ch),
    ) < 8,
    JSON.stringify(capMeasure),
  );
  check(
    "a prose column renders inside the classic 45-80 character measure",
    capMeasure.proseChars > 40 && capMeasure.proseChars < 85,
    JSON.stringify(capMeasure),
  );

  // The same cap, measured inside the zoomed subtree. A constant cannot do this:
  // every rect here is zoom-scaled, so a fixed 520 halves in character terms at
  // 200% zoom while a font-resolved cap doubles alongside the text.
  const capZoom = JSON.parse(
    await exec(`(async () => {
      const capNow = () => {
        const c = document.querySelectorAll('#viewer .table-container')[0];
        const t = c.querySelector('table');
        return measureTextColumnCap(c, t, t.querySelector('tr').cells[0]);
      };
      const at100 = capNow();
      const zoomBtn = document.getElementById('zoomIn');
      for (let i = 0; i < 4; i++) { zoomBtn.click(); await new Promise(r => setTimeout(r, 90)); }
      const level = document.getElementById('zoomReset').textContent;
      const zoomFactor = parseFloat(getComputedStyle(document.getElementById('viewer')).zoom) || 1;
      const zoomed = capNow();
      document.getElementById('zoomReset').click();
      await new Promise(r => setTimeout(r, 250));
      return JSON.stringify({ at100, zoomed, level, zoomFactor, ratio: zoomed / at100 });
    })()`),
  );
  check(
    "the zoom leg actually zoomed",
    capZoom.zoomFactor > 1.2,
    JSON.stringify(capZoom),
  );
  check(
    "the prose cap scales with zoom, so the character measure is unchanged",
    Math.abs(capZoom.ratio - capZoom.zoomFactor) < 0.12,
    JSON.stringify(capZoom),
  );

  // The assertions above measure the helper. This one measures the RESULT: how
  // many characters a prose column actually renders once the cap has been fed
  // through preferredTableWidth into a real breakout width. A fixed pixel cap
  // is a fixed number of SCREEN pixels, so at 200% zoom it buys half as many
  // characters - about 36 instead of 66 - and the column visibly narrows as the
  // user zooms in, which is the opposite of what zooming is for.
  const zoomProse = JSON.parse(
    await exec(`(async () => {
      const measure = () => {
        const c = document.querySelectorAll('#viewer .table-container')[6];
        const cells = c.querySelectorAll('tbody tr')[0].cells;
        const cell = cells[cells.length - 1];
        const p = document.createElement('span');
        p.style.cssText = 'position:absolute;white-space:pre;visibility:hidden;';
        p.textContent = '0'.repeat(50);
        cell.appendChild(p);
        const ch = p.getBoundingClientRect().width / 50;
        p.remove();
        return {
          breakout: c.classList.contains('table-breakout'),
          cellChars: cell.getBoundingClientRect().width / ch,
        };
      };
      const at100 = measure();
      const zoomBtn = document.getElementById('zoomIn');
      for (let i = 0; i < 4; i++) { zoomBtn.click(); await new Promise(r => setTimeout(r, 90)); }
      await new Promise(r => setTimeout(r, 400));
      const zoomFactor = parseFloat(getComputedStyle(document.getElementById('viewer')).zoom) || 1;
      const zoomed = measure();
      document.getElementById('zoomReset').click();
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify({ at100, zoomed, zoomFactor });
    })()`),
  );
  check(
    "the prose-cap sample is actually widened, so the cap reaches the layout",
    zoomProse.at100.breakout === true,
    JSON.stringify(zoomProse),
  );
  check(
    "an explanation column is given a readable measure, not an arbitrary width",
    zoomProse.at100.cellChars > 45 && zoomProse.at100.cellChars < 76,
    JSON.stringify(zoomProse),
  );
  check(
    "a prose column keeps a readable character measure when zoomed in",
    zoomProse.zoomFactor > 1.2 &&
      zoomProse.zoomed.cellChars > 45 &&
      zoomProse.zoomed.cellChars < 95,
    JSON.stringify(zoomProse),
  );

  // --- 14. Tables built outside the render pipeline ------------------------
  // renderTableInDOM backs the right-click Insert/Edit Table commands. It builds
  // its own container rather than going through addTableMaximizeButtons, so it
  // was the one path that never applied breakout: a table inserted from the
  // context menu was the only kind that still got a horizontal scrollbar.
  const inserted = JSON.parse(
    await exec(`(async () => {
      const md = ['| ' + Array.from({length: 14}, (_, i) => 'Column Header ' + i).join(' | ') + ' |',
                  '|' + Array.from({length: 14}, () => '---').join('|') + '|',
                  '| ' + Array.from({length: 14}, (_, i) => 'value-number-' + i).join(' | ') + ' |'].join('\\n');
      const before = new Set(document.querySelectorAll('#viewer .table-container'));
      renderTableInDOM(md, 'insert');
      await new Promise(r => setTimeout(r, 250));
      const all = [...document.querySelectorAll('#viewer .table-container')];
      // Identified by identity, not by position: renderTableInDOM inserts after
      // the right-click anchor when there is one, so the new container is not
      // necessarily last and "last" silently measured a different table.
      const c = all.find(x => !before.has(x));
      if (!c) return JSON.stringify({ added: false });
      const r = c.getBoundingClientRect();
      const out = {
        added: all.length === before.size + 1,
        hasBreakout: c.classList.contains('table-breakout'),
        containerWidth: Math.round(r.width),
        viewerWidth: Math.round(document.getElementById('viewer').clientWidth),
        preferred: Math.round(preferredTableWidth(c)),
        budget: document.getElementById('viewer').style.getPropertyValue('--mv-breakout-budget'),
        scrolls: c.scrollWidth > c.clientWidth + 1,
        offWindow: r.left < -1 || r.right > window.innerWidth + 1,
      };
      c.remove();
      return JSON.stringify(out);
    })()`),
  );
  check(
    "the context-menu table path really inserted a table",
    inserted.added === true,
    JSON.stringify(inserted),
  );
  check(
    "a table inserted from the context menu is widened like any other",
    inserted.hasBreakout === true && inserted.containerWidth > inserted.viewerWidth,
    JSON.stringify(inserted),
  );
  check(
    "a table inserted from the context menu does not scroll sideways",
    inserted.scrolls === false && inserted.offWindow === false,
    JSON.stringify(inserted),
  );

  await captureScreenshot(win, "table-display");

  // --- 15. The table of contents must not cover the document scrollbar -----
  // Reported by the user: with the ToC open there was no way to scroll the
  // document. Keep the left drawer beside the reading pane, and hit-test the
  // scrollbar as well as measuring their boxes.
  //
  // Run in both view modes because the scroller differs (.content-wrapper
  // normally, #viewer in split view) and the panel covered both.
  const tocGutter = JSON.parse(
    await exec(`(async () => {
      const out = { modes: {} };
      const wrapper = document.querySelector('.content-wrapper');
      const panel = document.getElementById('indexPanel');

      async function measure() {
        // Ask the engine which element actually scrolls rather than inferring
        // it from the split-view class - the same mistake custom-tabs.js made.
        let scroller = null;
        const viewer = document.getElementById('viewer');
        for (const n of [viewer, wrapper]) {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
            scroller = n;
            break;
          }
        }
        if (!scroller) return { scroller: null };
        const r = scroller.getBoundingClientRect();
        const gutter = Math.round(r.width) - scroller.clientWidth;
        // Mid-height of the gutter, one pixel inside the scroller's right edge.
        const x = Math.round(r.right - Math.max(gutter, 1) / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          scroller: scroller.id ? '#' + scroller.id : '.' + scroller.className.split(' ')[0],
          gutter,
          scrollable: scroller.scrollHeight > scroller.clientHeight + 1,
          hitInsidePanel: !!(hit && panel.contains(hit)),
          hitId: hit ? (hit.id || hit.className || hit.tagName) : null,
          panelRight: Math.round(panel.getBoundingClientRect().right),
          scrollerLeft: Math.round(r.left),
        };
      }

      // Closed first, as the control: if the gutter is already unreachable with
      // the panel shut then this is measuring something else entirely.
      panel.classList.remove('visible');
      await new Promise(r => setTimeout(r, 450));
      out.modes.normalClosed = await measure();

      document.getElementById('toggleIndex').click();
      await new Promise(r => setTimeout(r, 450));
      out.tocVisible = panel.classList.contains('visible');
      out.modes.normalOpen = await measure();
      // A breakout table sized for the full window must not be left hanging
      // under the drawer once the scroller narrows. .content-wrapper is
      // overflow-x: hidden, so the failure is silent clipping, not a scrollbar.
      const widest = [...document.querySelectorAll('#viewer .table-container')]
        .filter(c => c.classList.contains('table-breakout'))
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      out.breakoutSampled = !!widest;
      if (widest) {
        const tr = widest.getBoundingClientRect();
        out.breakoutLeft = Math.round(tr.left);
        out.breakoutUnderPanel = tr.left < panel.getBoundingClientRect().right - 1;
      }

      // Same again in split view, where #viewer owns the scrollbar.
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      out.inSplitView = wrapper.classList.contains('split-view');
      out.modes.splitOpen = await measure();

      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      document.getElementById('closeIndex').click();
      await new Promise(r => setTimeout(r, 450));
      out.closedAfter = !panel.classList.contains('visible');
      return JSON.stringify(out);
    })()`),
  );
  check(
    "the ToC toggle really opened the panel and split view really engaged",
    tocGutter.tocVisible === true &&
      tocGutter.inSplitView === true &&
      tocGutter.closedAfter === true,
    JSON.stringify(tocGutter),
  );
  // Vacuity guard: with no scrollbar there is nothing for the panel to cover,
  // and every assertion below would pass against any layout at all.
  check(
    "each measured mode really has a scrollable, scrollbar-bearing scroller",
    ["normalClosed", "normalOpen", "splitOpen"].every(
      (k) =>
        tocGutter.modes[k] &&
        tocGutter.modes[k].scrollable === true &&
        tocGutter.modes[k].gutter > 0,
    ),
    JSON.stringify(tocGutter.modes),
  );
  check(
    "the scrollbar gutter is reachable with the ToC closed (the control)",
    tocGutter.modes.normalClosed.hitInsidePanel === false,
    JSON.stringify(tocGutter.modes.normalClosed),
  );
  check(
    "the ToC does not paint over the document scrollbar in normal view",
    tocGutter.modes.normalOpen.hitInsidePanel === false,
    JSON.stringify(tocGutter.modes.normalOpen),
  );
  check(
    "the ToC does not paint over the document scrollbar in split view",
    tocGutter.modes.splitOpen.hitInsidePanel === false,
    JSON.stringify(tocGutter.modes.splitOpen),
  );
  check(
    "the scroller starts at or after the ToC panel rather than under it",
    tocGutter.modes.normalOpen.scrollerLeft >=
      tocGutter.modes.normalOpen.panelRight - 1,
    JSON.stringify(tocGutter.modes.normalOpen),
  );
  check(
    "a widened table was on screen to be squeezed by the drawer",
    tocGutter.breakoutSampled === true,
    JSON.stringify(tocGutter),
  );
  check(
    "opening the ToC re-measures breakout tables instead of clipping them under it",
    tocGutter.breakoutUnderPanel === false,
    JSON.stringify(tocGutter),
  );

  // Measurements say the gutter is reachable; only a picture says the result
  // reads correctly. Re-opened after the measurement block so the capture is of
  // the settled layout, not of a pane mid-transition.
  await win.webContents.executeJavaScript(
    `(() => {
      document.getElementById('toggleIndex').click();
      const t = document.querySelectorAll('.markdown-body .table-container')[2];
      if (t) t.scrollIntoView({ block: 'center' });
      return true;
    })()`,
    true,
  );
  await sleep(700);
  await captureScreenshot(win, "toc-open-scrollbar");
  await win.webContents.executeJavaScript(
    `(() => { document.getElementById('closeIndex').click(); return true; })()`,
    true,
  );
  await sleep(500);
  // view and capture it on its own: breakout uses a transform, which changes
  // the containing block of the absolutely-positioned maximize button, and no
  // measurement covers that.
  await win.webContents.executeJavaScript(
    `(() => {
      const t = document.querySelectorAll('.markdown-body .table-container')[2];
      if (t) t.scrollIntoView({ block: 'center' });
      return true;
    })()`,
    true,
  );
  await sleep(600);
  await captureScreenshot(win, "table-display-wide");

  await win.webContents.executeJavaScript(
    `(() => {
      const t = document.querySelectorAll('.markdown-body .table-container')[4];
      if (t) t.scrollIntoView({ block: 'center' });
      return true;
    })()`,
    true,
  );
  await sleep(600);
  await captureScreenshot(win, "table-display-huge");

  // The prose-wide sample: 8 short identifier columns plus one explanation.
  // It is the only shape where the table must widen AND the explanation column
  // lands exactly on the reading-measure cap, so it is the one worth looking at
  // to judge whether the cap reads well.
  await win.webContents.executeJavaScript(
    `(() => {
      const t = document.querySelectorAll('.markdown-body .table-container')[6];
      if (t) t.scrollIntoView({ block: 'center' });
      return true;
    })()`,
    true,
  );
  await sleep(600);
  await captureScreenshot(win, "table-display-prose-wide");

  // --- 16. Dialogs must stay usable in a short window ---------------------
  // Ported from upstream ef81474 (corner-resizable dialogs), taken only after
  // measuring that this fork has the defect the other half of that change
  // fixes. `.note-dialog-overlay` is position:fixed with overflow visible and
  // centres its child, so a dialog taller than the viewport spills off BOTH
  // edges with nothing to scroll: measured at a 390px viewport, the mermaid
  // template dialog was 492px tall, top -51, and its Insert button sat at
  // bottom 441 - openable but unusable.
  // resize:both is the ergonomic half, and it is only safe BECAUSE of the cap:
  // without one, a reader could drag the dialog past the screen edge and
  // recreate the same trap by hand.
  {
    const dialogBounds = win.getBounds();
    const openDialog = (overlayId) => `
      (async () => {
        const overlay = document.getElementById(${JSON.stringify(overlayId)});
        const dlg = overlay.querySelector('.note-dialog');
        dlg.style.width = ''; dlg.style.height = '';
        overlay.classList.add('visible');
        await new Promise(r => setTimeout(r, 400));
        const r = dlg.getBoundingClientRect();
        const hdr = dlg.querySelector('.note-dialog-header').getBoundingClientRect();
        const btn = dlg.querySelector('.note-dialog-btn.primary');
        const br = btn.getBoundingClientRect();
        const hitEl = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        const body = dlg.querySelector('.note-dialog-body');
        const out = {
          viewportH: window.innerHeight,
          dialogH: Math.round(r.height),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          headerReachable: hdr.top >= 0,
          primaryReachable: br.top >= 0 && br.bottom <= window.innerHeight,
          primaryHit: !!(hitEl && (hitEl === btn || btn.contains(hitEl))),
          bodyCanScroll: getComputedStyle(body).overflowY === 'auto' || getComputedStyle(body).overflowY === 'scroll',
          resize: getComputedStyle(dlg).resize,
          // The resize grabber is drawn in the bottom-right corner of the
          // dialog's own box. If a footer button reaches into that corner the
          // reader cannot press it without starting a resize.
          grabberClearOfButtons: Array.from(dlg.querySelectorAll('.note-dialog-btn')).every((b) => {
            const q = b.getBoundingClientRect();
            return !(q.right > r.right - 17 && q.bottom > r.bottom - 17);
          }),
        };
        overlay.classList.remove('visible');
        return JSON.stringify(out);
      })()
    `;

    // 420px outer is a window a reader can produce by dragging an edge - there
    // is no minHeight on the BrowserWindow - and it is under every dialog's
    // natural height, which is what makes it the interesting size.
    await resizeWindow({ ...dialogBounds, width: 1200, height: 420 });
    for (const [name, id] of [
      ["the mermaid template dialog", "mermaidTemplateOverlay"],
      ["the insert-table dialog", "tableInsertOverlay"],
    ]) {
      const d = JSON.parse(await exec(openDialog(id)));
      check(
        `${name} fits inside a short window instead of spilling off it`,
        d.top >= 0 && d.bottom <= d.viewportH,
        JSON.stringify(d),
      );
      check(
        `${name}'s title bar is still on screen in a short window`,
        d.headerReachable === true,
        JSON.stringify(d),
      );
      check(
        `${name}'s primary button can actually be pressed in a short window`,
        d.primaryReachable === true && d.primaryHit === true,
        JSON.stringify(d),
      );
      check(
        `${name} scrolls its own body rather than hiding content off screen`,
        d.bodyCanScroll === true,
        JSON.stringify(d),
      );
      // Vacuity guard: if the window were not actually short, every assertion
      // above would pass on a dialog that never needed clamping.
      check(
        `${name} was measured in a window shorter than its natural height`,
        d.viewportH < 400,
        JSON.stringify(d),
      );
    }

    await resizeWindow({ ...dialogBounds, width: 1400, height: 1000 });
    for (const [name, id] of [
      ["the mermaid template dialog", "mermaidTemplateOverlay"],
      ["the insert-table dialog", "tableInsertOverlay"],
    ]) {
      const d = JSON.parse(await exec(openDialog(id)));
      check(
        `${name} offers a corner grab handle`,
        d.resize === "both",
        JSON.stringify(d),
      );
      check(
        `${name}'s grab handle does not sit on top of its own buttons`,
        d.grabberClearOfButtons === true,
        JSON.stringify(d),
      );
    }

    // Dragging the corner must move the layout, not just the box: the footer
    // has to stay pinned inside the dialog and the body has to absorb the
    // change. Without `display:flex; flex-direction:column` on the dialog and
    // `flex: 1 1 auto; min-height: 0` on the body, the footer overflows the
    // resized box and the buttons hang outside it.
    const resized = JSON.parse(
      await exec(`
        (async () => {
          const overlay = document.getElementById('mermaidTemplateOverlay');
          const dlg = overlay.querySelector('.note-dialog');
          overlay.classList.add('visible');
          await new Promise(r => setTimeout(r, 300));
          const before = dlg.getBoundingClientRect().height;
          const bodyBefore = dlg.querySelector('.note-dialog-body').getBoundingClientRect().height;
          dlg.style.height = Math.round(before + 200) + 'px';
          dlg.style.width = '760px';
          await new Promise(r => setTimeout(r, 300));
          const r = dlg.getBoundingClientRect();
          const fr = dlg.querySelector('.note-dialog-footer').getBoundingClientRect();
          const bodyAfter = dlg.querySelector('.note-dialog-body').getBoundingClientRect().height;
          const out = {
            before: Math.round(before),
            after: Math.round(r.height),
            grew: r.height > before + 100,
            footerInside: fr.bottom <= r.bottom + 1 && fr.top >= r.top,
            bodyBefore: Math.round(bodyBefore),
            bodyAfter: Math.round(bodyAfter),
            bodyAbsorbed: bodyAfter > bodyBefore + 100,
            stillOnScreen: r.top >= 0 && r.bottom <= window.innerHeight,
          };
          dlg.style.width = ''; dlg.style.height = '';
          overlay.classList.remove('visible');
          return JSON.stringify(out);
        })()
      `),
    );
    check(
      "enlarging a dialog really does enlarge it",
      resized.grew === true,
      JSON.stringify(resized),
    );
    check(
      "an enlarged dialog keeps its footer buttons inside itself",
      resized.footerInside === true,
      JSON.stringify(resized),
    );
    check(
      "an enlarged dialog gives the extra room to its content, not to dead space",
      resized.bodyAbsorbed === true,
      JSON.stringify(resized),
    );

    // The reason the mermaid preview's fixed 340px cap was dropped: it existed
    // only as a stand-in for a dialog height limit, and with one in place it
    // would have made the dialog resizable without making the preview - the
    // thing a reader enlarges it to see - any bigger.
    const preview = JSON.parse(
      await exec(`
        (async () => {
          const overlay = document.getElementById('mermaidTemplateOverlay');
          const dlg = overlay.querySelector('.note-dialog');
          overlay.classList.add('visible');
          await new Promise(r => setTimeout(r, 300));
          const pv = dlg.querySelector('.mermaid-template-preview');
          const before = pv.getBoundingClientRect().height;
          dlg.style.height = Math.round(dlg.getBoundingClientRect().height + 220) + 'px';
          await new Promise(r => setTimeout(r, 300));
          const after = pv.getBoundingClientRect().height;
          const out = {
            before: Math.round(before),
            after: Math.round(after),
            maxHeight: getComputedStyle(pv).maxHeight,
            grew: after > before + 100,
          };
          dlg.style.height = '';
          overlay.classList.remove('visible');
          return JSON.stringify(out);
        })()
      `),
    );
    check(
      "enlarging the mermaid dialog enlarges the diagram preview with it",
      preview.grew === true,
      JSON.stringify(preview),
    );

    // Same property for the other resizable dialog. GPT-5.4's review caught
    // that the table dialog's textarea plumbing was not pinned by anything:
    // the dialog could grow while the markdown box the reader types into
    // stayed put, so the resize bought nothing but dead space.
    const tableGrow = JSON.parse(
      await exec(`
        (async () => {
          const overlay = document.getElementById('tableInsertOverlay');
          const dlg = overlay.querySelector('.note-dialog');
          overlay.classList.add('visible');
          await new Promise(r => setTimeout(r, 300));
          const ta = document.getElementById('tableInsertMarkdown');
          const before = ta.getBoundingClientRect().height;
          dlg.style.height = Math.round(dlg.getBoundingClientRect().height + 220) + 'px';
          await new Promise(r => setTimeout(r, 300));
          const after = ta.getBoundingClientRect().height;
          const out = {
            before: Math.round(before),
            after: Math.round(after),
            grew: after > before + 100,
          };
          dlg.style.height = '';
          overlay.classList.remove('visible');
          return JSON.stringify(out);
        })()
      `),
    );
    check(
      "enlarging the insert-table dialog enlarges the markdown box with it",
      tableGrow.grew === true,
      JSON.stringify(tableGrow),
    );

    // Measurements say the dialogs fit and resize; only a picture says they
    // read correctly. Captured with a dialog actually open and a template
    // selected - the earlier version of this capture fired after every overlay
    // had been closed again, which would have been an artifact of nothing.
    await exec(`
      (async () => {
        const overlay = document.getElementById('mermaidTemplateOverlay');
        const dlg = overlay.querySelector('.note-dialog');
        overlay.classList.add('visible');
        const btn = document.querySelector('.mermaid-tpl-btn');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 1200));
        dlg.style.width = '820px';
        dlg.style.height = Math.round(dlg.getBoundingClientRect().height + 160) + 'px';
        return null;
      })()
    `);
    await sleep(900);
    await captureScreenshot(win, "dialog-resizable");
    await exec(`
      (() => {
        const overlay = document.getElementById('mermaidTemplateOverlay');
        const dlg = overlay.querySelector('.note-dialog');
        dlg.style.width = ''; dlg.style.height = '';
        overlay.classList.remove('visible');
        return null;
      })()
    `);

    // The short window is the case the whole section exists for, so it gets a
    // picture too.
    await resizeWindow({ ...dialogBounds, width: 1200, height: 420 });
    await exec(`
      (async () => {
        document.getElementById('tableInsertOverlay').classList.add('visible');
        await new Promise(r => setTimeout(r, 400));
        return null;
      })()
    `);
    await sleep(600);
    await captureScreenshot(win, "dialog-short-window");
    await exec(
      `(() => { document.getElementById('tableInsertOverlay').classList.remove('visible'); return null; })()`,
    );
    await resizeWindow(dialogBounds);
  }

  // --- 17. The editor/viewer splitter -------------------------------------
  // Ported from upstream ef81474. The geometry matters here for the same reason
  // the rest of this suite exists: .content-wrapper is `overflow: hidden`, so a
  // row whose parts add up to more than its width silently clips the viewer
  // rather than reporting anything. Upstream's own change had to move #viewer
  // off `width: 50%` for exactly that reason once a 6px handle was inserted.
  {
    const splitBounds = win.getBounds();
    await resizeWindow({ ...splitBounds, width: 1600, height: 1000 });
    const s = JSON.parse(
      await exec(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const res = {};
          // Seed the ratio rather than inheriting whatever the last run left in
          // localStorage. Without this the "did the drag shrink the pane"
          // assertion depends on where a previous run happened to stop - the
          // same "geometric assertions pass or fail on history" defect this
          // suite already fixed for window bounds, and it produced a spurious
          // COLLATERAL verdict on R190 before it was fixed here.
          // Seeded to 0.65, deliberately NOT 0.5: 0.5 is the value a
          // double-click is supposed to STORE, so seeding 0.5 makes the
          // "double-click remembers an even split" assertion pass on the seed
          // alone. That is exactly how it went vacuous and turned R189 into a
          // WRONG-GUARD - the guard was reading its own setup.
          localStorage.setItem('editorSplitRatio', '0.65');
          applyEditorSplitRatio(0.65);
          if (!isEditMode) toggleEditBtn.click();
          await sleep(800);
          // Re-applied after the mode switch as well, so the seed cannot be
          // undone by anything the transition does to the panel's width.
          applyEditorSplitRatio(0.65);
          await sleep(80);
          const wrap = document.querySelector('.content-wrapper');
          const sp = document.getElementById('editorSplitter');
          const ep = document.getElementById('editorPanel');
          const vw = document.getElementById('viewer');
          const wr = wrap.getBoundingClientRect();
          const sum = () => {
            const a = ep.getBoundingClientRect(), b = sp.getBoundingClientRect(), c = vw.getBoundingClientRect();
            return { total: a.width + b.width + c.width, wrap: wr.width, panel: a.width };
          };
          res.splitterVisible = getComputedStyle(sp).display !== 'none';
          const before = sum();
          res.fitsBefore = Math.abs(before.total - before.wrap) <= 1;
          res.seededPanelRatio = before.panel / before.wrap;
          res.seededStore = localStorage.getItem('editorSplitRatio');
          // Real PointerEvents: the handler binds pointerdown, and a MouseEvent
          // carries no pointerId, so dispatching MouseEvents here would not
          // reach it at all - and previously hid that the capture branch was
          // dead code.
          let pid = 20;
          const fire = (el, type, x, buttons) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: wr.top + 200,
            button: 0, buttons: buttons === undefined ? 1 : buttons,
            pointerId: pid, pointerType: 'mouse',
          }));
          const targetX = wr.left + wr.width * 0.30;
          // Capture cannot be OBSERVED with synthetic events: the pointer is
          // not real, so Chromium accepts setPointerCapture without promoting
          // it and hasPointerCapture stays false (measured). What IS observable
          // - and what was actually broken - is whether the code ASKS for
          // capture with a real pointerId at all. Binding mousedown meant
          // e.pointerId was undefined and the call never happened. Spying the
          // DOM method is an oracle at the boundary, not the implementation's
          // own helper.
          const realCapture = sp.setPointerCapture.bind(sp);
          let captureArg = 'never-called';
          sp.setPointerCapture = (id) => { captureArg = id; try { realCapture(id); } catch (e) {} };
          fire(sp, 'pointerdown', wr.left + before.panel);
          res.captureRequestedWith = captureArg;
          res.captureRequestedCorrectId = captureArg === pid;
          sp.setPointerCapture = realCapture;
          fire(document, 'pointermove', targetX);
          await sleep(120);
          res.dragging = document.body.classList.contains('splitter-dragging') && sp.classList.contains('dragging');
          res.handleTrackingErrorPx = Math.round((sp.getBoundingClientRect().left - targetX) * 100) / 100;
          fire(document, 'pointerup', targetX, 0);
          await sleep(120);
          res.dragClassesCleared = !document.body.classList.contains('splitter-dragging') && !sp.classList.contains('dragging');
          const after = sum();
          res.fitsAfter = Math.abs(after.total - after.wrap) <= 1;
          res.panelShrank = after.panel < before.panel - 100;
          res.stored = parseFloat(localStorage.getItem('editorSplitRatio'));
          // A drag whose pointerup this window never saw - released outside the
          // frame. The next move arrives with no buttons held; the drag must
          // end itself rather than resize for ever.
          pid++;
          const preLost = ep.getBoundingClientRect().width;
          fire(sp, 'pointerdown', wr.left + preLost);
          fire(document, 'pointermove', wr.left + wr.width * 0.40);
          await sleep(80);
          res.lostUpWasDragging = document.body.classList.contains('splitter-dragging');
          fire(document, 'pointermove', wr.left + wr.width * 0.70, 0);
          await sleep(80);
          res.lostUpEndedDrag = !document.body.classList.contains('splitter-dragging') && !sp.classList.contains('dragging');
          const strandedWidth = ep.getBoundingClientRect().width;
          fire(document, 'pointermove', wr.left + wr.width * 0.20, 0);
          await sleep(80);
          res.lostUpStopsResizing = Math.abs(ep.getBoundingClientRect().width - strandedWidth) < 1;
          // The viewer is its own scroller in split view (R61/R63). Changing it
          // from width:50% to flex must not cost that.
          vw.scrollTop = vw.scrollHeight;
          await sleep(150);
          // Vacuity guard: on a document that already fits, scrollTop stays 0
          // and "reaches the bottom" would be measuring nothing.
          res.viewerCanScroll = vw.scrollHeight > vw.clientHeight + 100;
          res.viewerReachesBottom = vw.scrollTop > 0 &&
            Math.abs(vw.scrollTop + vw.clientHeight - vw.scrollHeight) <= 2;
          vw.scrollTop = 0;
          // Clamps: dragging past either edge must not collapse a pane.
          pid++;
          fire(sp, 'pointerdown', wr.left + ep.getBoundingClientRect().width);
          fire(document, 'pointermove', wr.left - 800);
          await sleep(80);
          res.minRatio = ep.getBoundingClientRect().width / wr.width;
          fire(document, 'pointermove', wr.right + 800);
          await sleep(80);
          res.maxRatio = ep.getBoundingClientRect().width / wr.width;
          fire(document, 'pointerup', wr.right + 800, 0);
          await sleep(80);
          res.storedBeforeDblClick = localStorage.getItem('editorSplitRatio');
          sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await sleep(150);
          res.afterDblClick = ep.getBoundingClientRect().width / wr.width;
          res.storedAfterDblClick = localStorage.getItem('editorSplitRatio');
          toggleEditBtn.click();
          await sleep(700);
          res.hiddenOutsideSplitView = getComputedStyle(sp).display === 'none';
          return JSON.stringify(res);
        })()
      `),
    );
    check(
      "the splitter is laid out in split view and nowhere else",
      s.splitterVisible === true && s.hiddenOutsideSplitView === true,
      JSON.stringify(s),
    );
    check(
      "inserting the splitter does not push the viewer out of the window",
      s.fitsBefore === true && s.fitsAfter === true,
      JSON.stringify(s),
    );
    check(
      "dragging the splitter really resizes the editor pane",
      s.dragging === true &&
        s.panelShrank === true &&
        // Vacuity guard: the drag has to have started from the seeded ratio, or
        // "it shrank" could be measuring where a previous run left the pane.
        Math.abs(s.seededPanelRatio - 0.65) < 0.01,
      JSON.stringify(s),
    );
    // The handle has to land where the pointer is, not near it. Upstream's
    // denominator (container width minus the handle) is off by a fraction of
    // the handle width that grows with the travel - measured at 1.81px here.
    check(
      "the splitter lands under the pointer rather than near it",
      Math.abs(s.handleTrackingErrorPx) <= 1,
      JSON.stringify(s),
    );
    check(
      "a finished drag leaves no drag state behind",
      s.dragClassesCleared === true,
      JSON.stringify(s),
    );
    check(
      "the split ratio is remembered",
      s.stored > 0.25 && s.stored < 0.35,
      JSON.stringify(s),
    );
    check(
      "the viewer can still be scrolled to the bottom in split view",
      s.viewerCanScroll === true && s.viewerReachesBottom === true,
      JSON.stringify(s),
    );
    check(
      "the splitter really asks for pointer capture rather than only appearing to",
      s.captureRequestedCorrectId === true &&
        typeof s.captureRequestedWith === "number",
      JSON.stringify(s),
    );
    check(
      "a drag whose pointerup went missing ends itself instead of resizing for ever",
      s.lostUpWasDragging === true &&
        s.lostUpEndedDrag === true &&
        s.lostUpStopsResizing === true,
      JSON.stringify(s),
    );
    check(
      "neither pane can be dragged away to nothing",
      Math.abs(s.minRatio - 0.15) < 0.01 && Math.abs(s.maxRatio - 0.85) < 0.01,
      JSON.stringify(s),
    );
    check(
      "double-clicking the splitter restores an even split, and remembers it",
      Math.abs(s.afterDblClick - 0.5) < 0.01 &&
        s.storedAfterDblClick === "0.5" &&
        // Vacuity guard: "0.5 is stored" means nothing unless something else
        // was stored a moment earlier. Seeding 0.5 is what made this pass on
        // its own setup and turned R189 into a WRONG-GUARD.
        s.storedBeforeDblClick !== "0.5",
      JSON.stringify(s),
    );

    // A stored ratio has to survive a restart, and it has to be applied to a
    // pane that is not visible yet - the editor panel is display:none until
    // split view is entered, so a ratio applied at load must still be in force
    // when the panel appears.
    const restored = JSON.parse(
      await exec(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          localStorage.setItem('editorSplitRatio', '0.25');
          applyEditorSplitRatio(0.25);
          if (!isEditMode) toggleEditBtn.click();
          await sleep(800);
          const wrap = document.querySelector('.content-wrapper').getBoundingClientRect();
          const ratio = document.getElementById('editorPanel').getBoundingClientRect().width / wrap.width;
          toggleEditBtn.click();
          await sleep(700);
          localStorage.setItem('editorSplitRatio', '0.5');
          applyEditorSplitRatio(0.5);
          return JSON.stringify({ ratio });
        })()
      `),
    );
    check(
      "a remembered ratio is in force the moment split view opens",
      Math.abs(restored.ratio - 0.25) < 0.01,
      JSON.stringify(restored),
    );

    await resizeWindow(splitBounds);
  }

  // --- 18. The measurement pass is BATCHED, not interleaved -------------------
  //
  // This is a performance property, and the obvious way to assert it - time the
  // pass - is exactly the way that produces a flaky suite. So assert the
  // STRUCTURE that makes it fast instead, which is deterministic and says what
  // broke when it fails.
  //
  // The defect: `preferredTableWidth()` used to write `width: max-content` onto
  // a table and then immediately read its rect. A write followed by a read
  // forces a synchronous layout, so doing it once per table costs one FULL
  // DOCUMENT layout per table - O(tables x document). Measured on a 1 MB
  // document (2919 tables): 35.5s of a 45.6s render, with the per-table cost
  // rising 3.3 -> 5.7 -> 12.2ms as the document grew, which is the signature of
  // thrash rather than of expensive measurement. Batched, the same pass takes
  // 2.3s.
  //
  // The observable difference: when every table is written FIRST and read
  // afterwards, all N tables are simultaneously at `max-content` at the moment
  // any one of their rects is read. Interleaved, exactly one ever is. So patch
  // getBoundingClientRect, and on each TABLE read count how many tables are
  // currently at max-content. Batched => N. Thrashing => 1.
  //
  // The assertion is on the MINIMUM of those counts, not the maximum, and the
  // difference is the whole strength of the oracle. A maximum is satisfied by
  // the FIRST sample alone, so an implementation that wrote every table up
  // front but then restored each one inside the read loop would produce
  // N, N-1, N-2, ... - a maximum of N, and a green test - while forcing a fresh
  // layout for every table after the first and leaving the pass just as
  // quadratic as before. The minimum can only reach N if no table was released
  // before the last one was read, which is the property being claimed.
  //
  // The only TABLE rects read during this pass are the ones in
  // tablePreferredRead: the container reads are on a DIV and
  // measureTextColumnCap's probe reads a CELL, so the tagName filter isolates
  // the phase exactly. Probe tables are excluded by their absolute positioning
  // anyway, so a future probe that outlived its measurement could not inflate
  // the count.
  win.unmaximize();
  await resizeWindow({ x: 40, y: 40, width: 2000, height: 1100 });
  const batching = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        if (isEditMode) { toggleEditBtn.click(); await sleep(700); }
        await renderMarkdown(${JSON.stringify(DOC)}, "full");
        await sleep(1800);

        const viewer = document.getElementById('viewer');
        const atMaxContent = () => [...viewer.querySelectorAll('.table-container > table')]
          .filter(t => t.style.width === 'max-content' && t.style.position !== 'absolute').length;

        const samples = [];
        const real = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this.tagName === 'TABLE') samples.push(atMaxContent());
          return real.apply(this, arguments);
        };
        try {
          applyTableBreakout();
        } finally {
          Element.prototype.getBoundingClientRect = real;
        }

        return JSON.stringify({
          tableReads: samples.length,
          maxConcurrent: samples.length ? Math.max.apply(null, samples) : 0,
          minConcurrent: samples.length ? Math.min.apply(null, samples) : 0,
          containers: viewer.querySelectorAll('.table-container').length,
          // Nothing may be left at max-content: the restore pass has to put
          // every table back before the apply pass reads the layout again.
          leftAtMaxContent: atMaxContent(),
        });
      })()
    `),
  );
  // Vacuity guard. With fewer than three measurable tables "all of them at once"
  // and "one at a time" are not distinguishable enough to be worth asserting,
  // and a document that silently stopped rendering tables would otherwise
  // satisfy the assertion below by measuring nothing at all.
  check(
    "the batching probe really measured several tables",
    batching.tableReads >= 3,
    JSON.stringify(batching),
  );
  check(
    "every table is sized for measurement before any of them is measured",
    batching.tableReads >= 3 && batching.minConcurrent === batching.tableReads,
    JSON.stringify(batching),
  );
  check(
    "the measurement pass leaves no table stuck at max-content",
    batching.leftAtMaxContent === 0,
    JSON.stringify(batching),
  );

  // Exception safety, which BATCHING is what made worth asserting. The
  // un-batched version held one table's write and its restore in a single
  // scope, so a throw could strand exactly one table at max-content. Writing
  // every table up front turns that into every table in the document, and
  // nothing puts them back: the restore only runs on the next
  // applyTableBreakout(), and the ResizeObserver that would call it is
  // width-guarded, so no resize means no repair. The user is left looking at a
  // page of tables stretched past their containers.
  //
  // The throw is injected into the READ, which is the phase that runs after
  // every table has already been written - the worst moment, and the one the
  // `finally` exists for.
  const stranded = JSON.parse(
    await exec(`
      (async () => {
        const viewer = document.getElementById('viewer');
        const atMaxContent = () => [...viewer.querySelectorAll('.table-container > table')]
          .filter(t => t.style.width === 'max-content' && t.style.position !== 'absolute').length;

        let reads = 0, threw = false;
        const real = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this.tagName === 'TABLE') {
            reads++;
            if (reads === 2) throw new Error('injected measurement failure');
          }
          return real.apply(this, arguments);
        };
        try {
          applyTableBreakout();
        } catch (e) {
          threw = true;
        } finally {
          Element.prototype.getBoundingClientRect = real;
        }
        const left = atMaxContent();
        // Put the page back for anything that runs after this.
        applyTableBreakout();
        return JSON.stringify({ reads, threw, left, after: atMaxContent() });
      })()
    `),
  );
  // Vacuity guard: if the injected failure never fired, or never propagated,
  // the assertion below would be satisfied by a pass that simply succeeded.
  check(
    "the injected measurement failure really did abort the pass",
    stranded.threw === true && stranded.reads >= 2,
    JSON.stringify(stranded),
  );
  check(
    "a measurement that throws part way through still puts every table back",
    stranded.left === 0,
    JSON.stringify(stranded),
  );

  // The equivalence claim itself, measured rather than argued. Batching is only
  // legitimate if asking every table at once gives the SAME answer as asking
  // them one at a time; if it did not, this would be an approximation dressed
  // up as an optimisation.
  //
  // Review singled out nested tables as the shape where "a table at max-content
  // cannot change what another table sees" is least obvious, and the reasoning
  // offered against it - that raw HTML becomes a sandboxed iframe, so a nested
  // table never reaches the viewer - is WRONG: a raw <table> is wrapped like
  // any other and its inner table is wrapped too. The shape is reachable, so it
  // is included here deliberately rather than assumed away.
  const equiv = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        await renderMarkdown(${JSON.stringify(
          [
            "# Nested",
            "",
            "<table><tr><td><table><tr><td>inner cell content</td></tr></table></td></tr></table>",
            "",
            "| column one | column two | column three |",
            "|---|---|---|",
            "| a value here | another value | and a third |",
            "",
            "<div><table><tr><td>table inside a div</td></tr></table></div>",
          ].join("\n"),
        )}, "full");
        await sleep(1200);

        const viewer = document.getElementById('viewer');
        const cs = [...viewer.querySelectorAll('.table-container')];

        // Batched: write every table, read every table, restore every table.
        const batchedMemo = new Map();
        const states = cs.map(c => tablePreferredBegin(c, batchedMemo));
        const batched = states.map(s => s ? tablePreferredRead(s) : 0);
        states.forEach(s => { if (s) tablePreferredRestore(s); });

        // One at a time, through the wrapper that keeps the original shape.
        const singleMemo = new Map();
        const single = cs.map(c => preferredTableWidth(c, singleMemo));

        return JSON.stringify({
          containers: cs.length,
          nested: viewer.querySelectorAll('.table-container table table').length,
          batched,
          single,
          identical: batched.length === single.length &&
                     batched.every((v, i) => Math.abs(v - single[i]) < 0.01),
        });
      })()
    `),
  );
  // Vacuity guard. Two empty lists are trivially "identical", and a document
  // whose nested table silently stopped being wrapped would make this assertion
  // stop covering the shape it was written for without ever failing.
  check(
    "the equivalence probe really measured several tables including a nested one",
    equiv.containers >= 3 && equiv.nested >= 1,
    JSON.stringify(equiv),
  );
  check(
    "measuring every table at once gives the same widths as measuring them one at a time",
    equiv.identical === true,
    JSON.stringify(equiv),
  );

  // --- 12d. Zoom keeps the reader's place --------------------------------
  // THE DEFECT, measured against a pre-registered formula before anything was
  // written: `.content-wrapper` is the scroller in normal view and `#viewer`
  // carries the CSS `zoom`, so the scroller sits OUTSIDE the scaled subtree.
  // Scaling grows scrollHeight and leaves scrollTop exactly where it was, which
  // throws the reader
  //     scrollTop * (newDocHeight / oldDocHeight - 1)
  // pixels down the document on every zoom step. It is depth-PROPORTIONAL,
  // which is why it survived for years: 154px at the top of a document and
  // 24,747px - about 24 screens - at 90% depth. Three clicks of the zoom button
  // and whatever you were reading is gone.
  //
  // THE ORACLE IS DELIBERATELY NOT THE FIX'S OWN MODEL. The fix remembers a
  // point as (element, fraction of that element's height); an oracle built the
  // same way would be judging a formula with a copy of that formula, which is
  // the defect GPT-5.4 found in test-tab-refresh.js Scenario 4 and it cannot
  // fail. It also would not WORK here: in split view the anchor can be a 91,429
  // px section whose text genuinely RE-WRAPS under zoom (offsetWidth 932 -> 704,
  // 3,845 -> 3,864 line boxes), so its height moves 1.3055x against the text's
  // 1.3000x and the oracle slides relative to the words on the screen. Measured
  // with that oracle the split-view depth-0 cell read -58px for the shipped
  // design and -33px for a cruder one; measured with the leaf-edge oracle below
  // the same two cells read -6px and +33px, i.e. the ORDER INVERTED. The
  // oracle, not the fix, was what moved.
  //
  // So: find the LEAF element nearest the pane centre - no element children,
  // non-empty text - and track its TOP EDGE relative to the pane centre. No
  // fraction, no height model, nothing a re-wrap can distort.
  //
  // The oracle has one inherent error, and it is SUBTRACTED rather than
  // tolerated. The leaf's top sits some distance from the aimed point, and that
  // distance is in DOCUMENT space, so it scales with the zoom even under a
  // perfect fix: exactly offset * (ratio - 1). residualOf() removes that term,
  // so the bars below measure the FIX's error rather than the instrument's.
  //
  // CORRECTION, and both reviewers reached it independently: the subtraction is
  // EXACTLY affine at any distance, not a local linearisation. `offset * (ratio
  // - 1)` is the closed form of how a document-space distance scales, so it is
  // just as exact at 11,741px as at 10px and there is no linearisation error to
  // bound. The earlier claim that it "is only linear while the leaf is near the
  // aimed point" was simply wrong, and it mattered: a future editor believing
  // it would relax the 40px guard from 40 to 200 on entirely false grounds.
  // What that guard really bounds is REFLOW - the further the leaf sits from
  // the aimed point, the more re-wrap can happen between them and change the
  // distance itself, which no closed form can subtract.
  //
  // Every cell is run TWICE. The OFF arm neutralises window.captureZoomAnchor,
  // which really does disable the fix in the real pipeline - renderer.js is a
  // classic script, so its top-level function declarations are writable
  // properties of the global object AND the internal call sites resolve through
  // that binding. With nothing captured applyZoomAnchor() returns immediately,
  // so the OFF arm is exactly HEAD. It is the sensitivity control: without it,
  // an oracle that had quietly stopped measuring anything would report every
  // cell at 0px drift and read as a flawless pass.
  const ZOOM_ANCHOR_DOC = (() => {
    const out = ["# Zoom anchor fixture", ""];
    for (let i = 1; i <= 220; i++) {
      out.push("## Section " + i + " of the zoom anchor fixture", "");
      out.push(
        "Paragraph " + i + " exists to give the document height so that a zoom " +
          "step has somewhere to throw the reader. The defect is proportional " +
          "to scrollTop, so a short document cannot exhibit it.",
        "",
      );
    }
    // ONE SECTION TALLER THAN THE PANE, and it is what makes the refinement
    // walk reachable at all. makeHeadersCollapsible() wraps everything under a
    // heading into a single .collapsible-section, so this is one box thousands
    // of px high whose paragraphs RE-WRAP when the reading measure narrows -
    // i.e. the THIRD-PARTY-NOTICES.md shape the walk exists for. The 220 short
    // sections above cannot exercise it: each is smaller than the pane, so
    // refineZoomAnchor returns on its first iteration and the walked and
    // unwalked versions are byte-identical. R415 was VACUOUS until this existed.
    out.push("## The tall section", "");
    for (let i = 1; i <= 140; i++) {
      out.push(
        "Tall-section paragraph " + i + " is deliberately long enough to wrap " +
          "over several line boxes at the full window width, so that narrowing " +
          "the reading measure in split view genuinely re-flows it and the " +
          "enclosing section's height does not scale in step with the text.",
        "",
      );
    }
    return out.join("\n");
  })();
  // Fixtures for the direct-mutation cell far below. Built here with this
  // section's other fixtures, and interpolated with JSON.stringify at every use
  // site - a newline written as an escape inside the exec() template literal is
  // eaten by Node before the renderer ever sees it, which is the same family as
  // the recorded backtick trap. (Backticks reaching the renderer via a runtime
  // interpolation are safe; only ones written literally in the template source
  // terminate it.)
  const MUT_TABLE_MD = [
    "| Mut heading one | Mut heading two |",
    "| --- | --- |",
    "| mutation cell one | mutation cell two |",
    "",
  ].join("\n");
  const MUT_MERMAID_CODE = ["graph TD;", "  MutA-->MutB;"].join("\n");
  // Exactly ONE mermaid block, so deleteMermaidFromSource takes its
  // single-block path and no text-similarity scoring is involved.
  const MUT_MERMAID_DOC = [
    "# Mutation mermaid fixture",
    "",
    "```mermaid",
    MUT_MERMAID_CODE,
    "```",
    "",
  ].join("\n");

  const OFF_MIN = 100; // px the same point must move with the fix disabled

  // THE WIDE-TABLE FIXTURE, and it exists to answer a specific reviewer
  // finding both models raised independently (Opus S4, Luna #1, which Luna
  // rated blocking): updateZoom() schedules a table-breakout REMEASURE that
  // lands ~120ms later, whereas the anchor correction is applied on the next
  // frame. If that later pass changes the height of anything ABOVE the reading
  // position, the reader is shifted again and nothing re-corrects it.
  //
  // 12d's timing was never the gap - arm() already sleeps 500ms after the last
  // click, so it measures well after the coalesced pass. The gap was that
  // ZOOM_ANCHOR_DOC contains no table, so applyTableBreakout() had nothing to
  // change and the leg was silently vacuous.
  //
  // Kept as its OWN document rather than by adding tables to ZOOM_ANCHOR_DOC:
  // every existing cell aims at a fraction of the scroll range, so injecting
  // thousands of px of table would move all six of them and re-tune the bar
  // that was just derived, along with the R412-R418 evidence resting on it.
  // Tables are stacked at the TOP and the reading content below them, because
  // a table below the aimed point can change height all it likes without
  // moving anything the reader is looking at - only the ones above can.
  const ZOOM_ANCHOR_TABLE_DOC = (() => {
    const out = ["# Zoom anchor table fixture", ""];
    const COLS = 9; // wide enough that the rendered table overflows the 900px
    const head = [];                                   // reading column and so
    const sep = [];                                    // qualifies for breakout
    for (let c = 1; c <= COLS; c++) { head.push("Column heading " + c); sep.push("---"); }
    for (let t = 1; t <= 12; t++) {
      out.push("## Table section " + t, "");
      out.push("| " + head.join(" | ") + " |");
      out.push("| " + sep.join(" | ") + " |");
      for (let r = 1; r <= 6; r++) {
        const row = [];
        for (let c = 1; c <= COLS; c++) {
          // Long enough to WRAP, which is the entire point: a table whose cells
          // cannot re-wrap changes width without changing height, and would
          // exhibit nothing no matter how the breakout budget moved.
          row.push("row " + r + " column " + c + " holding enough words to wrap");
        }
        out.push("| " + row.join(" | ") + " |");
      }
      out.push("");
    }
    for (let i = 1; i <= 200; i++) {
      out.push("## Reading section " + i, "");
      out.push(
        "Paragraph " + i + " sits below every table in this fixture, so any " +
          "height the breakout remeasure adds or removes above it displaces " +
          "this text after the anchor has already been applied.",
        "",
      );
    }
    return out.join("\n");
  })();  // THE ORACLE HAS A KNOWN, COMPUTABLE INSTRUMENT ERROR, AND IT IS SUBTRACTED
  // RATHER THAN ABSORBED INTO THE TOLERANCE. The tracked leaf's top edge sits
  // `offset` px from the aimed-at point, and that distance is in DOCUMENT space,
  // so under a perfect fix - which holds the AIMED point still - the leaf top
  // moves by exactly offset * (ratio - 1). Folding that into a blanket
  // tolerance would mean the bar quietly loosening whenever the pick landed
  // further from the centre, which is the "a floor that describes the status
  // quo" disease. Subtracting it makes the number below the FIX's own error.
  //
  // The two residual bars differ for a MEASURED reason, not a convenient one.
  // In normal view the scroller sits outside the zoom-scaled subtree, so every
  // box scales by exactly the zoom ratio and the correction can be exact. In
  // split view #viewer is both scroller and zoom carrier and the reading measure
  // NARROWS as zoom grows (offsetWidth 932 -> 704 across a 1.3x step), so text
  // genuinely re-wraps - 3,845 -> 3,864 line boxes on the notices document - and
  // exact preservation is impossible in principle there.
  // NORMAL WAS 8 AND THAT WAS AN EMPIRICAL FLOOR, NOT A DERIVED ONE - both
  // reviewers flagged it. It is now 3, reached by two independent routes that
  // agree, which is what makes it a bar rather than a description of the
  // status quo (the licence audit's `> 200` against a real 220 disease):
  //   MEASURED - with the scrollerScale() divisor error fixed, the three normal
  //   cells read -0.2 / 0 / -0.8 px. Worst 0.8, so 3 is 3.75x of headroom.
  //   DERIVED - the error sources are the applyZoomAnchor deadband (<=0.5), the
  //   rounding of the reported drift (0.5), the tare's own rounding (~0.15) and
  //   layout quantisation (~1). That budget is ~2.2, i.e. the same number.
  // At 8 this bar could not see the divisor defect at all: the cells read
  // 2.8 / 4.0 / -2.8 before the fix and every one of them passed. R418 is what
  // keeps that true - it restores the defect, and only a bar near the derived
  // value fails. Split stays 24 because its residual is dominated by genuine
  // re-wrap, not by arithmetic: one line box at line-height 1.8 on 13-16px text
  // is 24-29px, so 24 is one line and there is nothing tighter to derive.
  const RESID_MAX = { normal: 3, split: 24 };
  const residualOf = (c) => {
    const ratio = c.from > 0 ? c.till / c.from : 1;
    return c.drift - c.offset * (ratio - 1);
  };
  const zoomAnchor = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        if (isEditMode) { toggleEditBtn.click(); await sleep(900); }
        await renderMarkdown(${JSON.stringify(ZOOM_ANCHOR_DOC)}, "full");
        await sleep(1500);

        const viewer = document.getElementById('viewer');
        const reset = document.getElementById('zoomReset');
        const centreOf = (s) => { const r = s.getBoundingClientRect(); return r.top + r.height / 2; };

        // The leaf-edge oracle. Walks the real rendered tree rather than asking
        // document.elementFromPoint, which is what the fix itself uses - an
        // oracle sharing the implementation's lookup would share its mistakes.
        // Returns the PITCH as well: the spacing to the neighbouring leaf tops.
        // The nearest top to a given point is at most half a pitch away, so the
        // pitch is what bounds this oracle's own offset, and the soundness
        // guard below can check that identity instead of a magic number.
        const pick = (s) => {
          const cy = centreOf(s);
          const tops = [];
          const walk = (n) => {
            for (let i = 0; i < n.children.length; i++) {
              const c = n.children[i];
              if (c.children.length === 0) {
                if ((c.textContent || '').trim()) {
                  const cr = c.getBoundingClientRect();
                  if (cr.height > 0) tops.push([cr.top, c]);
                }
              } else walk(c);
            }
          };
          walk(viewer);
          if (!tops.length) return null;
          tops.sort((a, b) => a[0] - b[0]);
          let bi = 0, bd = Infinity;
          for (let i = 0; i < tops.length; i++) {
            const d = Math.abs(tops[i][0] - cy);
            if (d < bd) { bd = d; bi = i; }
          }
          const gapPrev = bi > 0 ? tops[bi][0] - tops[bi - 1][0] : 0;
          const gapNext = bi < tops.length - 1 ? tops[bi + 1][0] - tops[bi][0] : 0;
          return { el: tops[bi][1], pitch: Math.round(Math.max(gapPrev, gapNext)) };
        };
        const where = (el, s) => el.getBoundingClientRect().top - centreOf(s);

        const arm = async (depth, dir, off, gap, pre, perStep) => {
          reset.click();
          await sleep(450);
          // OPTIONAL PRELUDE, and it buys two things no other cell has. Every
          // cell below starts from 100% because arm() resets - so the whole
          // upper half of the 50-400% range, and the ordinary case of a step
          // taken FROM a level that is not 100%, were both unmeasured. Run
          // before the scroll position is chosen, because zooming changes the
          // scroll range the depth is a fraction of.
          if (pre) {
            const pb = document.getElementById('zoomIn');
            for (let i = 0; i < pre; i++) pb.click();
            await sleep(800);
          }
          const s = getViewerScroller();
          const range = s.scrollHeight - s.clientHeight;
          s.scrollTop = Math.round(range * depth);
          await sleep(250);

          // GAP AIM. Put the pane centre in the MARGIN between two paragraphs
          // of the tallest block, which is the only way to make
          // document.elementFromPoint resolve to something taller than the pane
          // and so the only way the refinement walk runs at all. Zoom is at
          // 100% here (reset was just clicked), so viewport px and scroller px
          // coincide and no conversion is needed.
          if (gap) {
            let tall = null, tallH = 0;
            for (let i = 0; i < viewer.children.length; i++) {
              const h = viewer.children[i].getBoundingClientRect().height;
              if (h > tallH) { tallH = h; tall = viewer.children[i]; }
            }
            if (tall && tall.children.length > 4) {
              const k = Math.floor(tall.children.length / 2);
              const a = tall.children[k].getBoundingClientRect();
              const b = tall.children[k + 1].getBoundingClientRect();
              s.scrollTop = Math.round(s.scrollTop + (a.bottom + b.top) / 2 - centreOf(s));
              await sleep(250);
            }
          }

          const sr0 = s.getBoundingClientRect();
          const hit = document.elementFromPoint(sr0.left + sr0.width / 2, sr0.top + sr0.height / 2);
          // Does the product's own lookup land somewhere the walk will descend
          // from? Recorded rather than assumed, because a fixture that stopped
          // producing the gap would leave the walk unexercised and silent.
          const walkFires =
            !hit || hit === viewer || !viewer.contains(hit) ||
            hit.getBoundingClientRect().height > sr0.height;

          const picked = pick(s);
          if (!picked) return { picked: false };
          const el = picked.el;
          const before = where(el, s);
          const startLevel = reset.textContent;

          const real = window.captureZoomAnchor;
          if (off) window.captureZoomAnchor = function () {};
          // HOW MANY TIMES THE CORRECTION ACTUALLY RAN. This is the control
          // that makes the stepwise cells mean something: without it "the
          // gesture path holds the reading position" is satisfied just as well
          // by a stepwise run that silently behaved as a burst. renderer.js is
          // a classic script, so the rAF booked by scheduleZoomAnchorRestore
          // resolves applyZoomAnchor off the global at call time and this
          // counts the real thing rather than a copy of it.
          const realApply = window.applyZoomAnchor;
          let applied = 0;
          window.applyZoomAnchor = function () {
            applied++;
            return realApply.apply(this, arguments);
          };
          const btn = document.getElementById(dir > 0 ? 'zoomIn' : 'zoomOut');
          // TWO DIFFERENT PRODUCT PATHS, and until this option existed only one
          // of them was measured. Three clicks in ONE task is a HELD KEY: the
          // pendingZoomAnchor guard makes only the first click capture, so the
          // whole burst is corrected once, against the position the reader held
          // before any of it. The ordinary gesture - click, look, click - is the
          // opposite shape: each step captures and applies its OWN anchor, so
          // three independent corrections compose and any per-step bias
          // accumulates instead of being taken once. 250ms is past the anchor
          // frame AND past the 120ms coalesced remeasure, so every step starts
          // from a fully settled layout, which is what makes it the gesture
          // rather than a slower burst.
          for (let i = 0; i < 3; i++) {
            btn.click();
            if (perStep) await sleep(250);
          }
          await sleep(500);
          window.applyZoomAnchor = realApply;
          if (off) window.captureZoomAnchor = real;

          const sr = s.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          // NO REGEX HERE, DELIBERATELY. This whole block is a Node template
          // literal, and a template literal EATS a single backslash escape it
          // does not recognise: /(\d+)/ arrives in the renderer as /(d+)/, which
          // matches nothing in "130%". It cost a full run - from/till came back
          // 0 for every cell, residualOf() silently fell back to the raw drift,
          // and the only reason it was caught is that the zoom-levels guard
          // below prints the numbers it is clearing. parseInt stops at the '%'
          // and has no escape to lose. Same family as the recorded backtick
          // trap; see the NOTE FOR EDITORS above.
          const lv = (t) => { const n = parseInt(t, 10); return n > 0 ? n : 0; };
          return {
            picked: true,
            tag: el.tagName,
            offset: Math.round(before),
            pitch: picked.pitch,
            // The irreducible bound for any cell where the reading measure
            // re-wraps: the anchored point can land at worst one line box away.
            // Read off the tracked leaf itself, in the subtree's own pixels -
            // the caller scales it by the zoom to reach viewport pixels, which
            // is the space the drift is measured in.
            lineH: (() => {
              const cs = getComputedStyle(el);
              const lh = parseFloat(cs.lineHeight);
              if (lh > 0) return Math.round(lh);
              const fs = parseFloat(cs.fontSize);
              return fs > 0 ? Math.round(fs * 1.8) : 0;
            })(),
            drift: Math.round(where(el, s) - before),
            moved: startLevel !== reset.textContent,
            from: lv(startLevel),
            till: lv(reset.textContent),
            range: Math.round(range),
            walkFires,
            applied,
            hitTag: hit ? hit.tagName : 'none',
            // The reader-facing statement, independent of any tolerance: is the
            // thing they were reading still in the pane at all?
            onScreen: er.bottom > sr.top && er.top < sr.bottom,
          };
        };

        const cells = [];
        let tablesDoc = false;
        const run = async (view, depth, dir, gap, pre, perStep) => {
          const label = (tablesDoc ? 'tables ' : '') + view + ' depth ' +
            (gap ? 'gap-aim' : Math.round(depth * 100) + '%') +
            ' zoom ' + (dir > 0 ? 'in' : 'out') + (pre ? ' from+' + pre : '') +
            (perStep ? ' stepwise' : '');
          const on = await arm(depth, dir, false, gap, pre, perStep);
          const off = await arm(depth, dir, true, gap, pre, perStep);
          cells.push({ label, view, gap: !!gap, tables: tablesDoc, hi: !!pre, stepwise: !!perStep, on, off });
        };

        await run('normal', 0.50, +1);
        // THE ORDINARY GESTURE, as opposed to the held key every other cell
        // measures. See the perStep comment in arm(): a burst is corrected
        // ONCE, a gesture three times, so any per-step bias that the burst
        // takes a single share of is taken three times here.
        await run('normal', 0.50, +1, false, 0, true);
        await run('normal', 0.90, +1);
        await run('normal', 0.50, -1);
        // ABOVE THE MAX-WIDTH THRESHOLD. #viewer is max-width:900px in its own
        // pixels, so it paints 900*zoom wide and stops being the binding
        // constraint once that exceeds the window - about 221% on this pinned
        // 2000px harness. Past that, normal view narrows its own measure and
        // re-wraps exactly like split view, which is the premise the tight
        // normal bar rests on. 13 prelude steps put the start at 230% and the
        // measured step spans 230->260%, so both ends are past the threshold.
        await run('normal', 0.50, +1, false, 13);

        if (!isEditMode) toggleEditBtn.click();
        await sleep(900);
        const splitScroller = getViewerScroller();
        await run('split', 0.00, +1);
        await run('split', 0.50, +1);
        // The gesture path where re-wrap is real. Split view narrows the
        // reading measure on every step, so this is the leg where three
        // independent corrections have the most to disagree about.
        await run('split', 0.50, +1, false, 0, true);
        await run('split', 0.50, -1);
        // The walk's own cell. Split view on purpose: in normal view the
        // scroller sits outside the zoom-scaled subtree, so EVERY box scales by
        // exactly the zoom ratio and tracking a fraction of a huge box is exact.
        // Only where the reading measure narrows - split view - does a tall
        // block re-wrap and stop scaling in step with its own text.
        await run('split', 0.50, +1, true);
        toggleEditBtn.click();
        await sleep(900);

        // THE BREAKOUT LEG. Normal view only, and that is not a shortcut:
        // publishBreakoutBudget() disables breakout outright in split view, so
        // a split cell here would measure the ABSENCE of the mechanism and
        // report a clean pass for the wrong reason.
        tablesDoc = true;
        await renderMarkdown(${JSON.stringify(ZOOM_ANCHOR_TABLE_DOC)}, "full");
        await sleep(2000);
        await run('normal', 0.60, +1);
        await run('normal', 0.60, -1);
        tablesDoc = false;

        // AND THE PRECONDITION, measured separately rather than assumed. The
        // cells above can only speak to S4 if the coalesced remeasure really
        // does move table geometry AFTER the anchor has been applied. This
        // samples the same zoom step at two instants: once past the correction
        // frame but before the 120ms pass, and once after it. getBoundingClientRect
        // forces layout, so both samples are settled rather than mid-relayout.
        // If they agree, these cells clear nothing and the note must say so.
        const tableEvidence = await (async () => {
          reset.click();
          await sleep(450);
          const tabs = Array.from(viewer.querySelectorAll('table'));
          const sumH = () => Math.round(
            tabs.reduce((a, t) => a + t.getBoundingClientRect().height, 0)
          );
          const w0 = tabs.length ? Math.round(tabs[0].getBoundingClientRect().width) : 0;
          const h0 = sumH();
          document.getElementById('zoomIn').click();
          // PAST THE ANCHOR FRAME, DETERMINISTICALLY. captureZoomAnchor books
          // its restore with requestAnimationFrame from inside the click
          // handler, so a callback registered here - after the handler has
          // returned - is queued BEHIND it in the same frame, and a second
          // hop lands in the frame after that. A fixed sleep was a bet on
          // machine load in both directions: too short and this samples
          // BEFORE the correction, too long and it drifts into the 120ms
          // coalesced remeasure this sample exists to be earlier than. Two
          // frames is ~16-33ms, so the margin against 120ms is wide.
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const hMid = sumH();
          const wMid = tabs.length ? Math.round(tabs[0].getBoundingClientRect().width) : 0;
          await sleep(700);  // past the coalesced remeasure
          const hAfter = sumH();
          const wAfter = tabs.length ? Math.round(tabs[0].getBoundingClientRect().width) : 0;
          const paneW = Math.round(viewer.getBoundingClientRect().width);
          reset.click();
          await sleep(400);
          return { n: tabs.length, paneW, w0, wMid, wAfter, h0, hMid, hAfter };
        })();

        // THE STALENESS GUARDS, driven directly. Each is a one-frame window in
        // the product, so no end-to-end cell can reach them - the same
        // situation as R202/R416, and handled the same way: drive the REAL
        // functions against the REAL document and real layout, rather than
        // restating the branch in a mock that could agree with a broken one.
        // renderer.js is a classic script, so captureZoomAnchor,
        // applyZoomAnchor and refineZoomAnchor are all reachable as globals.
        const staleness = await (async () => {
          reset.click();
          await sleep(400);
          const s = getViewerScroller();
          // Recomputes exactly what captureZoomAnchor just anchored to, by
          // calling the same refinement on the same aimed point in the same
          // layout. Needed because the pending anchor is deliberately private.
          const anchorEl = () => {
            const sr = s.getBoundingClientRect();
            const aimY = sr.top + sr.height / 2;
            let e = document.elementFromPoint(sr.left + sr.width / 2, aimY);
            if (e === viewer || (e && !viewer.contains(e))) e = null;
            return window.refineZoomAnchor(e || viewer, aimY, sr.height);
          };
          // capture -> perturb the layout the way a zoom step does -> break one
          // precondition -> apply, and report whether the correction ran.
          const guardDiag = {};
          const trial = async (breakIt, label) => {
            viewer.style.zoom = '1';
            await sleep(140);
            s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.5);
            await sleep(160);
            window.captureZoomAnchor();
            const el = anchorEl();
            const g0 = renderGeneration, m0 = viewerMutationGen;
            const top0 = s.scrollTop;
            const capturedAt = performance.now();
            viewer.style.zoom = '1.3';
            void viewer.getBoundingClientRect().height; // settle before reading
            const undo = breakIt ? await breakIt(el) : null;
            const t0 = s.scrollTop;
            if (label) guardDiag[label] = {
              dGen: renderGeneration - g0,
              dMut: viewerMutationGen - m0,
              age: Math.round(performance.now() - capturedAt),
              maxAge: ZOOM_ANCHOR_MAX_AGE_MS,
              top0: Math.round(top0),
              topNow: Math.round(s.scrollTop),
              slack: ZOOM_ANCHOR_SCROLL_SLACK,
              maxNow: Math.round(Math.max(0, s.scrollHeight - s.clientHeight)),
              // The one that actually mattered: an anchor has to still BE
              // pending for "did not move" to say anything about the guards.
              pending: !!pendingZoomAnchor,
            };
            window.applyZoomAnchor();
            const moved = Math.abs(s.scrollTop - t0) > 0.5;
            if (undo) undo();
            viewer.style.zoom = '1';
            await sleep(140);
            return moved;
          };

          // The sensitivity control. Without it every "did not move" below
          // would be satisfied by a probe that had stopped applying anything.
          const control = await trial(null, 'control');
          // THE AGE TRIAL HAS TO PARK THE SCHEDULED FRAME, AND THAT IS THE
          // WHOLE POINT RATHER THAN A CONVENIENCE. captureZoomAnchor() books
          // its own restore frame on its last line (renderer.js,
          // scheduleZoomAnchorRestore), so an anchor is NEVER left pending for
          // longer than one frame by simply waiting. The first version of this
          // trial just slept 700ms: the product's own rAF fired during the
          // sleep, applied the correction, and cleared pendingZoomAnchor, so
          // the manual apply below returned at its very first line with no
          // anchor at all. It reported "did not move" for a reason that has
          // nothing to do with the age limit, and R420 duly came back VACUOUS -
          // the age line could be deleted with this assertion still green.
          //
          // A FIRST DIAGNOSIS OF THAT WAS WRONG AND IS RECORDED HERE SO IT IS
          // NOT REPEATED. The measured scrollTop drift across the sleep
          // (17115 -> 22363) was first attributed to the ENGINE's scroll
          // anchoring compensating for the zoom reflow. It was not; it was the
          // product's own restore frame doing exactly what it is for. Two
          // mechanisms could produce that number and it was assigned to one of
          // them by assumption instead of by reading scheduleZoomAnchorRestore.
          //
          // Cancelling the booked frame models the case the guard exists for
          // MORE faithfully than sleeping does: a rAF in a throttled background
          // window is parked, not merely late. The scroller is then put back
          // where it was captured so the supersede clause - the one
          // IMMEDIATELY BELOW the age check - cannot be what fires, leaving
          // exactly one broken precondition, the way the boxless and outside
          // trials each break exactly one.
          const aged = await trial(async () => {
            const held = s.scrollTop;
            cancelAnimationFrame(zoomAnchorFrame);
            zoomAnchorFrame = 0;
            await sleep(700);
            s.scrollTop = held;
            return null;
          }, 'aged');
          const boxless = await trial((el) => {
            const prev = el.style.display;
            el.style.display = 'none';
            return () => { el.style.display = prev; };
          });
          const outside = await trial((el) => {
            const p = el.parentNode, n = el.nextSibling;
            document.body.appendChild(el);
            return () => { p.insertBefore(el, n); };
          });

          // LUNA'S CASE, reproduced rather than argued about. Re-rendering the
          // SAME content is the sharpest form of it: patchViewerDOM's LCS diff
          // matches every node, so the captured element stays connected AND
          // stays inside #viewer, and isConnected and containment both still
          // pass. Only the render generation can tell that the document under
          // the anchor was rebuilt. survived records that premise instead of
          // assuming it - if a future diff stopped preserving nodes this cell
          // would still pass for the wrong reason, and survived says so.
          let survived = null;
          const regen = await trial(async (el) => {
            await window.renderMarkdown(${JSON.stringify(ZOOM_ANCHOR_TABLE_DOC)}, 'light-format');
            survived = el.isConnected && viewer.contains(el);
            return null;
          });

          // THE IN-FLIGHT RENDER CASE, which renderGeneration alone CANNOT
          // reach. renderMarkdown bumps renderGeneration on its first line but
          // renderMarkdownFull is async, so a render already running when the
          // anchor is captured has already bumped it - anchor.gen matches, and
          // that render LANDING one frame later is invisible to the compare.
          // The same hole covers the post-render passes: addCodeBlockCopyButtons
          // runs in a requestIdle callback AFTER the render promise resolves and
          // REPARENTS every pre into a new container, with no render starting at
          // all. viewerMutationGen is bumped where the DOM is mutated rather
          // than where a render is requested, which is why this stands down and
          // the regen case above cannot be stretched to cover it.
          //
          // Driven through the product's own notifier, which is the same call
          // every reparent site makes. That this cell asserts the CONTRACT
          // rather than the call sites is deliberate; the call sites are
          // measured separately, by the product-wrapper cell further down,
          // which reads the counter across a real wrap.
          const mutated = await trial(async () => {
            window.noteViewerMutation();
            return null;
          });

          // THE BOTTOM CLAMP, which no end-to-end cell can reach. Zooming OUT
          // near the end of a document shortens it, and the ENGINE clamps
          // scrollTop down to the new maximum. That is a consequence of the
          // zoom, not another agent scrolling, and it must NOT stand the
          // correction down - but the two are indistinguishable unless the
          // guard compares against the NEW maximum rather than against where
          // the reader was. Every other cell in this section sits at depth
          // 0.50-0.90, where maxNow never falls below anchor.top and the
          // Math.min() is inert, so writing plain anchor.top would keep all of
          // them green.
          //
          // Note the clamp lands the scroller EXACTLY at the new maximum by
          // construction, so this is driven as a unit rather than through a
          // residual: from the bottom only an upward correction is applicable
          // at all, and whether this fixture happens to want one is a property
          // of the fixture, not of the guard.
          const bottomClamp = await (async () => {
            viewer.style.zoom = '1';
            await sleep(160);
            const range = s.scrollHeight - s.clientHeight;
            s.scrollTop = Math.round(range * 0.97);
            await sleep(180);
            const top0 = s.scrollTop;
            viewer.style.zoom = '0.7';
            void viewer.getBoundingClientRect().height; // settle before reading
            const maxNow = Math.max(0, s.scrollHeight - s.clientHeight);
            const nowTop = s.scrollTop;
            // The premise: the engine really did drag the scroller down past
            // the slack. Without this the two readings below prove nothing.
            const clamped = nowTop < top0 - 2 && maxNow < top0;
            // The real guard, against the real scroller in the real post-zoom
            // layout. Only .scroller and .top are read, so an anchor built here
            // is the same input the product builds.
            const held = window.zoomAnchorSuperseded({ scroller: s, top: top0 });
            // ...and the controls, one per clause, both driven to the OPPOSITE
            // verdict so neither clause can have been disabled rather than
            // corrected. agentUp is the important one: it is the SAME clause
            // the excusal above rides on, with the scroller genuinely moved
            // above the new maximum instead of resting on it.
            s.scrollTop = Math.max(0, maxNow - 500);
            const agentUp = window.zoomAnchorSuperseded({ scroller: s, top: maxNow });
            s.scrollTop = maxNow;
            const agentDown = window.zoomAnchorSuperseded({ scroller: s, top: nowTop - 100 });
            viewer.style.zoom = '1';
            await sleep(160);
            return {
              top0: Math.round(top0), nowTop: Math.round(nowTop),
              maxNow: Math.round(maxNow), clamped, held, agentUp, agentDown,
            };
          })();

          // SET-AND-SCHEDULE MUST BE ATOMIC, and this is the only way to see
          // it. pendingZoomAnchor doubles as the burst guard - captureZoomAnchor
          // returns early while one is outstanding - and it is cleared ONLY by
          // applyZoomAnchor. So if the anchor is stored in one function and the
          // frame that consumes it is booked by the caller, anything throwing
          // in between latches the guard with no frame booked, and the feature
          // is silently dead for the rest of the SESSION rather than for one
          // step. Booking the frame inside captureZoomAnchor makes that
          // unreachable; this drives capture ALONE - no updateZoom, so no
          // caller tail to book anything - and asks whether the correction
          // still runs. The control trial above is its sensitivity guard:
          // that same setup is already shown to move the scroller when an
          // anchor is applied, so a "did not move" here is the missing booking
          // and not a probe that has stopped observing.
          const scheduled = await (async () => {
            window.applyZoomAnchor(); // drain any anchor left outstanding above
            viewer.style.zoom = '1';
            await sleep(160);
            s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.5);
            await sleep(180);
            const t0 = s.scrollTop;
            window.captureZoomAnchor();
            viewer.style.zoom = '1.3';
            await sleep(140); // several frames - the booked rAF must have run
            const moved = Math.abs(s.scrollTop - t0) > 0.5;
            window.applyZoomAnchor(); // and drain again, latched or not
            viewer.style.zoom = '1';
            await sleep(160);
            return moved;
          })();

          reset.click();
          await sleep(400);
          return { control, aged, boxless, outside, regen, survived, mutated, bottomClamp, scheduled, guardDiag };
        })();
        reset.click();
        await sleep(400);
        // ---- OUT-OF-FLOW EQUIVALENCE: the trap for the rejected binary search.
        //
        // refineZoomAnchor() walks arbitrary descendant lists 16 deep, and
        // SANITIZE_CONFIG keeps the style attribute while filterCssDeclarations
        // (NOTE FOR EDITORS: never a backtick inside this template literal.)
        // only strips URLs - so a float, a position:absolute box or a negative
        // margin arrives from ORDINARY MARKDOWN and inverts the children's
        // bottoms. A sub-linear search over that list is wrong: measured on the
        // real app, a binary version broke this postcondition at 426 of 1800
        // aims, and in a nested list returned null where a child did reach the
        // aim - so the walk fell through to kids[last] and anchored on an
        // unrelated block. See the record above firstChildReaching().
        //
        // THE ORACLE IS THE POSTCONDITION, NOT A COPIED SCAN. Comparing against
        // a duplicate of the shipped loop would only restate the implementation.
        // This asks the rendered layout directly: the returned child must reach
        // the aim, and no child before it may. That holds the shipped version to
        // account too, and it is what a future "optimisation" has to satisfy.
        const scan = (() => {
          const sc = getViewerScroller();
          sc.scrollTop = 0;
          const host = document.createElement('div');
          host.setAttribute('data-scan-probe', '1');
          // position:relative so the absolutely positioned child is laid out
          // against THIS box rather than the initial containing block, which
          // makes the fixture's shape independent of the page and the machine.
          host.setAttribute('style', 'position:relative;height:4000px');
          const add = (css, text) => {
            const d = document.createElement('div');
            d.setAttribute('style', css);
            d.textContent = text;
            host.appendChild(d);
          };
          add('float:left;width:160px;height:1800px;background:#eef', 'float');
          add('position:absolute;top:80px;left:0;width:90px;height:2000px', 'abs');
          add('margin-top:-300px;height:60px', 'pulled up');
          add('height:0;overflow:hidden', 'zero height');
          add('height:120px', 'one');
          add('height:120px', 'two');
          add('height:120px', 'three');
          viewer.appendChild(host);
          const kids = host.children;
          const r0 = host.getBoundingClientRect(); // also forces layout

          const holds = (aimY, r) => {
            if (r === null) {
              for (let i = 0; i < kids.length; i++) {
                if (kids[i].getBoundingClientRect().bottom >= aimY) return false;
              }
              return true;
            }
            for (let i = 0; i < kids.length; i++) {
              if (kids[i] === r) break;
              if (kids[i].getBoundingClientRect().bottom >= aimY) return false;
            }
            return r.getBoundingClientRect().bottom >= aimY;
          };

          let checks = 0;
          let violations = 0;
          let minAim = Infinity;
          let maxAim = -Infinity;
          for (let q = 0; q <= 40; q++) {
            const aimY = r0.top + (r0.height * q) / 40;
            if (!(aimY > 0)) continue; // the aim is a viewport coordinate
            checks++;
            if (aimY < minAim) minAim = aimY;
            if (aimY > maxAim) maxAim = aimY;
            if (!holds(aimY, window.firstChildReaching(kids, aimY))) violations++;
          }

          // VACUITY GUARD: the fixture must really be out of order. Degenerate
          // (all-zero) children are excluded because they are skipped for free -
          // a zero bottom never reaches a positive aim - so what has to be
          // non-monotone is the NON-degenerate subsequence, which is exactly the
          // sequence a binary search would assume was sorted.
          let inversions = 0;
          let zeroSized = 0;
          let prev = -Infinity;
          for (let i = 0; i < kids.length; i++) {
            const r = kids[i].getBoundingClientRect();
            if (r.width === 0 && r.height === 0) {
              zeroSized++;
              continue;
            }
            if (r.bottom < prev - 0.01) inversions++;
            if (r.bottom > prev) prev = r.bottom;
          }

          // THE REACHABILITY PREMISE, asserted rather than assumed. If the
          // sanitizer ever stripped these declarations the whole fixture would
          // become synthetic, and this cell would be pinning a shape the product
          // cannot produce.
          const sanitized = window.sanitizeHtml(
            '<div style="float:left;height:100px">x</div>' +
            '<div style="position:absolute;height:100px">y</div>' +
            '<div style="margin-top:-100px">z</div>'
          );
          host.remove();
          return {
            n: kids.length,
            checks: checks,
            violations: violations,
            inversions: inversions,
            zeroSized: zeroSized,
            minAim: Math.round(minAim),
            maxAim: Math.round(maxAim),
            keepsFloat: sanitized.indexOf('float') !== -1,
            keepsAbsolute: sanitized.indexOf('absolute') !== -1,
            keepsNegativeMargin: sanitized.indexOf('-100px') !== -1,
          };
        })();
        // ---- THE SAME TRAP, WITHOUT ANY AUTHOR CSS.
        //
        // The block above builds its inversion from inline styles, which is a
        // real route (the sanitizer keeps them) but not the only one, and not
        // the strongest. Folia's own block wrappers already invert these lists:
        // every wrapper appends an absolutely-positioned button AFTER the tall
        // content it decorates. The button is positioned by the STYLESHEET, so
        // the state survives even if the sanitizer is ever tightened to strip
        // style attributes.
        //
        // WHAT THIS CELL DOES AND DOES NOT PROVE. It assembles a
        // .code-block-container BY HAND, so it demonstrates that the stylesheet
        // inverts the order for that class - and nothing more. It does NOT show
        // the product emits that child order, and an independent review was
        // right to press the point: a fixture that restates the claim it exists
        // to test is its own oracle, and this one would keep passing if
        // addCodeBlockCopyButtons() were changed to PREPEND the button. The
        // product claim is measured separately, further down, by rendering a
        // REAL fenced code block and reading the container the product built.
        // Keep both: this cell is the controlled geometry, that one is the
        // evidence.
        //
        // It does not break a binary search TODAY only because those lists have
        // exactly two children: the first probe is always index 0, so the
        // search either returns index 0 or advances to index 1 - it skips
        // nothing, and so cannot miss an earlier child that reaches. THE THIRD
        // CHILD HERE IS DELIBERATELY ANTICIPATORY - a language label, a
        // line-number gutter or a wrap toggle would each add one - and it is
        // what stops "only two children" from being mistaken for a safety
        // margin.
        //
        // NOTE ON WHAT THE strandedLast COUNTER BELOW REACHES. It does NOT
        // observe the null -> kids[kids.length - 1] fall-through: the sweep
        // continues as soon as the scan returns null, before refineZoomAnchor
        // is called. The null case is forbidden outright by fellThrough === 0
        // in the sibling assertion instead, so the property is covered - just
        // across two assertions rather than one. Read them together.
        //
        // (NOTE FOR EDITORS: no backticks in this comment. It sits inside an
        // exec() template literal, and a backtick here is a syntax error in
        // this file, reported at a line far above. That trap has now bitten
        // eight times, including in this very block.)
        const wrap = (() => {
          const scw = getViewerScroller();
          scw.scrollTop = 0;
          const host = document.createElement('div');
          host.className = 'code-block-container';
          host.setAttribute('data-wrap-probe', '1');
          const pre = document.createElement('pre');
          pre.style.height = '1600px';
          pre.textContent = 'tall';
          const btn = document.createElement('button');
          btn.className = 'code-copy-btn';
          btn.textContent = 'Copy';
          const third = document.createElement('div');
          third.style.height = '120px';
          third.textContent = 'third';
          host.appendChild(pre);
          host.appendChild(btn);
          host.appendChild(third);
          viewer.appendChild(host);

          const kids = host.children;
          const r0 = host.getBoundingClientRect();
          // CAPTURE BEFORE PERTURBING: getComputedStyle returns a LIVE
          // declaration, so reading .position after host.remove() yields "".
          const btnPosition = window.getComputedStyle(btn).position;

          const bottoms = [];
          for (let i = 0; i < kids.length; i++) {
            bottoms.push(Math.round(kids[i].getBoundingClientRect().bottom - r0.top));
          }

          const holds = (aimY, r) => {
            for (let i = 0; i < kids.length; i++) {
              if (kids[i] === r) break;
              if (kids[i].getBoundingClientRect().bottom >= aimY) return false;
            }
            return r !== null && r.getBoundingClientRect().bottom >= aimY;
          };

          let checks = 0;
          let violations = 0;
          let fellThrough = 0;
          let strandedLast = 0;
          for (let q = 0; q <= 40; q++) {
            const aimY = r0.top + (r0.height * q) / 40;
            if (!(aimY > 0)) continue;
            checks++;
            const hit = window.firstChildReaching(kids, aimY);
            if (hit === null) {
              fellThrough++;
              continue;
            }
            if (!holds(aimY, hit)) violations++;
            // S2: the walk must not land on the last child while an earlier one
            // reaches the aim. That is what a wrongly-null scan looks like from
            // refineZoomAnchor's side.
            const walked = window.refineZoomAnchor(host, aimY, 10);
            if (walked === kids[kids.length - 1] && hit !== kids[kids.length - 1]) {
              strandedLast++;
            }
          }

          let inversions = 0;
          let prev = -Infinity;
          for (let i = 0; i < kids.length; i++) {
            const b = kids[i].getBoundingClientRect().bottom;
            if (b < prev - 0.01) inversions++;
            if (b > prev) prev = b;
          }

          host.remove();
          return {
            n: kids.length,
            checks: checks,
            violations: violations,
            fellThrough: fellThrough,
            strandedLast: strandedLast,
            inversions: inversions,
            bottoms: bottoms,
            btnPosition: btnPosition,
            btnInlineStyle: btn.getAttribute('style'),
          };
        })();
        // THE DIVISOR ITSELF, read off the real scroller in the real layout.
        // In normal view the scroller sits OUTSIDE the zoomed subtree, so the
        // true scale is exactly 1 - a value the raw ratio never produces,
        // because getBoundingClientRect().height is fractional (1007.333 here)
        // while offsetHeight is integer-rounded (1007).
        const _ssc = getViewerScroller();
        const _ssr = _ssc.getBoundingClientRect();
        const scale = {
          normal100: window.scrollerScale(_ssc),
          // The two raw terms, printed so the note shows WHETHER the ratio was
          // off-grid at this instant. It is layout-dependent: the same scroller
          // measured 1007.333/1007 during diagnosis and integral here, which is
          // exactly why normal100 cannot be the snap's pin.
          rectH: Math.round(_ssr.height * 1000) / 1000,
          offH: _ssc.offsetHeight,
          // Pass-through control. 1.0123 is further from the 1/20 grid than the
          // rounding of a 1007px divisor could explain, so it must survive
          // untouched - otherwise the estimator is just rounding everything and
          // would mangle any scale that is genuinely off-grid.
          unitSnap: window.snapScrollerScale(1.000331, 1007),
          unitPass: window.snapScrollerScale(1.0123, 1007),
        };
        return JSON.stringify({
          cells,
          tableEvidence,
          staleness,
          scan,
          wrap,
          scale,
          clamp: [
            [window.clampZoomFraction(-0.119), 0],
            [window.clampZoomFraction(-4), 0],
            [window.clampZoomFraction(1.7), 1],
            [window.clampZoomFraction(0.25), 0.25],
            [window.clampZoomFraction(0), 0],
            [window.clampZoomFraction(1), 1],
            [window.clampZoomFraction(NaN), 0],
          ],
          // Proves the split legs really ran against the other scroller. In
          // split view #viewer IS the scroller, and the fix has to convert its
          // correction through scrollerScale() there; a leg that silently stayed
          // in normal view would exercise none of that.
          splitScrollerWasViewer: splitScroller === viewer,
        });
      })()
    `),
  );
  const zaCells = zoomAnchor.cells || [];
  const zaTable = zoomAnchor.tableEvidence || {};
  const zaStale = zoomAnchor.staleness || {};
  const zaScan = zoomAnchor.scan || {};
  const zaScale = zoomAnchor.scale || {};
  console.log("note: scrollerScale " + JSON.stringify(zaScale));
  console.log("note: out-of-flow scan " + JSON.stringify(zaScan));
  check(
    "the reading-position walk finds the first block reaching the aim even when children are out of flow",
    zaScan.violations === 0,
    "violations=" +
      zaScan.violations +
      " of " +
      zaScan.checks +
      " aims (" +
      zaScan.minAim +
      ".." +
      zaScan.maxAim +
      "px)",
  );
  // THE VACUITY GUARD, and it is the whole reason this cell can fail. A search
  // that assumes sorted bottoms is CORRECT on a fixture whose bottoms happen to
  // be sorted, so without a measured inversion the assertion above would pass
  // for the rejected implementation too.
  check(
    "the out-of-flow fixture really does invert block order (the walk assertion is not vacuous)",
    zaScan.inversions > 0 && zaScan.checks >= 20 && zaScan.n >= 6,
    "inversions=" +
      zaScan.inversions +
      " children=" +
      zaScan.n +
      " zeroSized=" +
      zaScan.zeroSized +
      " aims=" +
      zaScan.checks,
  );
  // Without this the fixture is synthetic and the cell above pins a shape the
  // product cannot produce. `style` is in SANITIZE_CONFIG's ADD_ATTR and
  // filterCssDeclarations only strips URLs, so these survive - measured, not
  // assumed, because it is the fact that makes the finding a product concern.
  check(
    "out-of-flow layout is reachable from ordinary markdown (an inline style survives sanitization)",
    zaScan.keepsFloat === true &&
      zaScan.keepsAbsolute === true &&
      zaScan.keepsNegativeMargin === true,
    "float=" +
      zaScan.keepsFloat +
      " absolute=" +
      zaScan.keepsAbsolute +
      " negativeMargin=" +
      zaScan.keepsNegativeMargin,
  );
  // ---- THE SAME TRAP FROM THE PRODUCT'S OWN MARKUP, no author CSS involved.
  const zaWrap = zoomAnchor.wrap || {};
  console.log("note: wrapper scan " + JSON.stringify(zaWrap));
  check(
    "the reading-position walk holds inside a Folia block wrapper, whose own button inverts the child order",
    zaWrap.violations === 0 && zaWrap.fellThrough === 0 && zaWrap.checks === 41,
    "violations=" +
      zaWrap.violations +
      " fellThrough=" +
      zaWrap.fellThrough +
      " of " +
      zaWrap.checks +
      " aims; bottoms=" +
      JSON.stringify(zaWrap.bottoms),
  );
  // S2: the fall-through is the worst measured symptom of a wrongly-null scan -
  // refineZoomAnchor takes kids[last] and anchors on an unrelated block. Nothing
  // else in this section reaches it.
  //
  // THIS IS A CONTRACT, NOT A PROVEN GUARD, and saying so is the point. R430 -
  // the rejected binary search - does NOT fire it: on this fixture that version
  // returns a wrong child rather than null, so it trips the postcondition
  // assertion above instead. The property still deserves an assertion because
  // the fall-through is a SEPARATE line (el = next || kids[kids.length - 1]) and
  // a future edit to it would not be caught by anything else. Same precedent as
  // R202 and N7: an unreachable guard is still a contract. Do not delete it as
  // dead because no revert currently reaches it.
  //
  // WHAT IT MEASURES IS NARROWER THAN ITS NAME SUGGESTS, and an independent
  // review was right to press on it. The sweep `continue`s when the scan
  // returns null, so this counter never observes the null -> kids[last]
  // fall-through directly; it only fires when refineZoomAnchor lands on the
  // last child while our own scan found an earlier one, i.e. when the walk's
  // INTERNAL scan disagrees with the one under test. The null case is not
  // unmeasured - `fellThrough === 0` in the assertion above forbids it outright
  // on this fixture - but the two halves live in different assertions, so read
  // them together rather than reading this name as covering both.
  check(
    "the walk never lands on the last child while an earlier one reaches the aim",
    zaWrap.strandedLast === 0 && zaWrap.checks === 41,
    "strandedLast=" + zaWrap.strandedLast + " of " + zaWrap.checks + " aims",
  );
  // VACUITY GUARD, and the reason this state exists at all: the inversion must
  // come from the STYLESHEET, not from an inline style, and the list must have
  // more than two children. With exactly two, the search's first probe is
  // always index 0 - it either returns index 0 or advances to index 1, so it
  // skips nothing and cannot miss an earlier child that reaches. (An earlier
  // draft of this comment called that an "in-order exhaustive probe", which is
  // wrong: it stops after ONE read when index 0 reaches. The conclusion that
  // two children are safe is unchanged; the reason is that nothing is skipped,
  // not that everything is visited.)
  check(
    "the wrapper really inverts its children, from product CSS rather than an inline style",
    zaWrap.inversions > 0 &&
      zaWrap.n >= 3 &&
      zaWrap.btnPosition === "absolute" &&
      zaWrap.btnInlineStyle === null,
    "inversions=" +
      zaWrap.inversions +
      " n=" +
      zaWrap.n +
      " btnPosition=" +
      zaWrap.btnPosition +
      " btnInlineStyle=" +
      zaWrap.btnInlineStyle,
  );

  // THE PRODUCT'S OWN MARKUP, MEASURED RATHER THAN REBUILT.
  //
  // The cell above constructs a .code-block-container by hand. That proves the
  // STYLESHEET positions the button out of flow, but it does NOT prove the
  // product emits that child order - the fixture restates the claim it exists
  // to test, so it would keep passing if addCodeBlockCopyButtons() were changed
  // to PREPEND the button tomorrow. An independent review caught this, and it
  // is the recorded disease in its purest form: a fixture that is a copy of the
  // formula is its own oracle. The reachability argument in renderer.js leads
  // with "Folia's own wrappers invert their child lists", so that claim has to
  // be a MEASUREMENT, not a reading of the source.
  //
  // The hand-built fixture also diverged in a way that mattered: the product
  // only wraps a <pre> that CONTAINS a <code> element (addCodeBlockCopyButtons
  // returns early otherwise), and the synthetic <pre> had no <code> at all - so
  // the product would never have wrapped it.
  //
  // So this cell renders a REAL fenced code block through renderMarkdown(),
  // reads the container the product built, and only then appends one controlled
  // child to reach the three-child length at which a binary search can skip.
  const FENCE = "\u0060\u0060\u0060"; // three backticks, spelled by code point:
  // a literal backtick inside an exec() template literal is the trap that has
  // bitten this file seven times.
  const CODE_BLOCK_DOC = (() => {
    const lines = ["# Wrapper fixture", "", FENCE + "js"];
    // Long enough that the rendered <pre> is far taller than the copy button,
    // which is what makes the child order observably inverted.
    for (let i = 1; i <= 80; i++) lines.push("const line" + i + " = " + i + ";");
    lines.push(FENCE, "");
    return lines.join("\n");
  })();
  const wrapReal = JSON.parse(
    await exec(`
      (async () => {
        await window.renderMarkdown(${JSON.stringify(CODE_BLOCK_DOC)}, "full");
        // AWAITING THE RENDER IS NOT ENOUGH, and this cell measured that rather
        // than assuming it: addCodeBlockCopyButtons() runs inside the
        // requestIdle() callback at the end of renderMarkdownFull, which fires
        // AFTER the promise resolves. A first version of this cell read
        // .code-block-container immediately and found nothing at all.
        const waitFor = async (fn, ms) => {
          const t0 = performance.now();
          for (;;) {
            const v = fn();
            if (v) return v;
            if (performance.now() - t0 > ms) return null;
            await new Promise((r) => setTimeout(r, 16));
          }
        };
        // THE COUNTER ACROSS A REAL WRAP. Read after the render promise has
        // already resolved, so the patchViewerDOM bump is excluded and only the
        // post-render idle pass can move it. This is what proves the product
        // CALLS the notifier at its reparent sites; the staleness cell above
        // proves only that a noted mutation stands the anchor down.
        const mutAfterRender = window.viewerMutationGeneration();
        try {
        const host = await waitFor(() => {
          // FIXTURE IDENTITY, NOT JUST FIXTURE SHAPE. Querying for the first
          // .code-block-container would accept a wrapper left over from a
          // stale or failed render: it would have two children, a <pre><code>,
          // a copy button and inverted geometry, and would satisfy every
          // assertion below while describing a DIFFERENT document. So the
          // sentinel from this doc's last line has to be present in the
          // product-built <pre> before the container is accepted.
          const cs = document.querySelectorAll('.code-block-container');
          for (let i = 0; i < cs.length; i++) {
            const p = cs[i].querySelector('pre');
            if (p && p.textContent.indexOf('const line80 = 80;') !== -1) return cs[i];
          }
          return null;
        }, 5000);
        if (!host) return JSON.stringify({ found: false });
        const mutAfterWrap = window.viewerMutationGeneration();
        const bot = (e) => e.getBoundingClientRect().bottom;
        const prod = Array.prototype.slice.call(host.children);
        const btn = host.querySelector('.code-copy-btn');
        // CAPTURE BEFORE PERTURBING: getComputedStyle returns a LIVE
        // declaration, so these must be resolved to plain values now.
        const btnPosition = btn ? window.getComputedStyle(btn).position : "";
        const btnInlineStyle = btn ? btn.getAttribute('style') : "missing";
        const hostTop = host.getBoundingClientRect().top;
        const out = {
          found: true,
          nProd: prod.length,
          firstIsPre: prod.length > 0 && prod[0].tagName === 'PRE',
          firstHasCode: prod.length > 0 && !!prod[0].querySelector('code'),
          lastIsCopyBtn:
            prod.length > 0 &&
            prod[prod.length - 1].classList.contains('code-copy-btn'),
          prodInverted:
            prod.length >= 2 && bot(prod[prod.length - 1]) < bot(prod[0]) - 0.01,
          btnPosition: btnPosition,
          btnInlineStyle: btnInlineStyle,
          prodBottoms: prod.map((e) => Math.round(bot(e) - hostTop)),
          mutAfterRender: mutAfterRender,
          mutAfterWrap: mutAfterWrap,
          preHeight:
            prod.length > 0
              ? Math.round(prod[0].getBoundingClientRect().height)
              : 0,
        };
        const third = document.createElement('div');
        third.style.height = '120px';
        third.textContent = 'third';
        host.appendChild(third);
        const kids = host.children;
        const r0 = host.getBoundingClientRect();
        const holds = (aimY, r) => {
          for (let i = 0; i < kids.length; i++) {
            if (kids[i] === r) break;
            if (kids[i].getBoundingClientRect().bottom >= aimY) return false;
          }
          return r !== null && r.getBoundingClientRect().bottom >= aimY;
        };
        let checks = 0;
        let violations = 0;
        let fellThrough = 0;
        for (let q = 0; q <= 40; q++) {
          const aimY = r0.top + (r0.height * q) / 40;
          if (!(aimY > 0)) continue;
          checks++;
          const hit = window.firstChildReaching(kids, aimY);
          if (hit === null) { fellThrough++; continue; }
          if (!holds(aimY, hit)) violations++;
        }
        let inversions = 0;
        let prev = -Infinity;
        const bottoms = [];
        for (let i = 0; i < kids.length; i++) {
          const b = kids[i].getBoundingClientRect().bottom;
          if (b < prev - 0.01) inversions++;
          if (b > prev) prev = b;
          bottoms.push(Math.round(b - r0.top));
        }
        out.n = kids.length;
        out.checks = checks;
        out.violations = violations;
        out.fellThrough = fellThrough;
        out.inversions = inversions;
        out.bottoms = bottoms;
        third.remove();
        return JSON.stringify(out);
        } finally {
          // RESTORE ON EVERY EXIT PATH. The poll above can time out and return
          // early, and anything in between can throw; either way this section's
          // code-block fixture would otherwise be left on screen and every
          // later cell would measure the wrong document. The restore is the
          // last thing to run, not the last thing written.
          await window.renderMarkdown(${JSON.stringify(ZOOM_ANCHOR_TABLE_DOC)}, "full");
        }
      })()
    `),
  );
  console.log("note: product wrapper " + JSON.stringify(wrapReal));
  // THE REACHABILITY CLAIM ITSELF, and the only assertion in this file that
  // measures it. Every clause is a separate way the claim could be false:
  // the product might stop wrapping, might emit one child, might put the button
  // first, might position it in flow, or might set the offset inline (in which
  // case a future sanitizer change could strip it and the argument would rest
  // on nothing). prodInverted is the claim in one line - the LAST child's
  // bottom is ABOVE the first's, with no author CSS anywhere in the document.
  check(
    "the product's own rendered code-block wrapper puts its copy button after the code and out of flow",
    wrapReal.found === true &&
      wrapReal.nProd === 2 &&
      wrapReal.firstIsPre === true &&
      wrapReal.firstHasCode === true &&
      wrapReal.lastIsCopyBtn === true &&
      wrapReal.prodInverted === true &&
      wrapReal.btnPosition === "absolute" &&
      wrapReal.btnInlineStyle === null,
    JSON.stringify(wrapReal),
  );
  // The same sweep as the synthetic cell, but on the container the PRODUCT
  // built. checks is pinned exactly rather than as a floor: the sweep is 41
  // aims by construction, so a fixture that quietly stopped being laid out
  // would otherwise satisfy "violations === 0" by measuring nothing - which is
  // exactly the hole an independent review found in the cell above.
  check(
    "the reading-position walk holds inside the product's own wrapper once a third child makes the list skippable",
    wrapReal.violations === 0 &&
      wrapReal.fellThrough === 0 &&
      wrapReal.checks === 41 &&
      wrapReal.n === 3 &&
      wrapReal.inversions > 0,
    JSON.stringify(wrapReal),
  );
  // THE CALL SITE, not the contract. addCodeBlockCopyButtons reparents every
  // <pre> into a new .code-block-container from a requestIdle callback that
  // runs AFTER renderMarkdownFull has resolved, so this delta is measured from
  // a reading taken once the render promise was already settled - the
  // patchViewerDOM bump cannot account for it. Without this, the staleness cell
  // would assert that a NOTED mutation stands an anchor down while nothing
  // checked that the product ever notes one.
  // EXACTLY ONE, NOT "AT LEAST ONE". `>` reports that SOMETHING in this window
  // bumped the counter, which is not the claim in the assertion's name - and it
  // is the disjunction defect this project keeps rediscovering. Two paths
  // already bump on a render (patchViewerDOM and this one), so the moment a
  // third starts bumping inside the same window, `>` would keep this green
  // under its own revert. The measured delta is exactly 1.
  check(
    "wrapping a code block in its container is reported as a viewer mutation",
    wrapReal.found === true && wrapReal.mutAfterWrap === wrapReal.mutAfterRender + 1,
    JSON.stringify(wrapReal),
  );

  // THE DELEGATION, WHICH NOTHING PREVIOUSLY MEASURED.
  //
  // custom-tabs.js has its own scrollerScale() that delegates to renderer.js's
  // when that one is present, and otherwise runs a private copy. Every existing
  // assertion reads offsetWithin's RESULT - and both implementations produce
  // almost the same number, so those assertions measure the DISJUNCTION and
  // would stay green if the delegation were deleted. That is the recorded
  // disease: an assertion whose subject can be supplied by more than one source
  // measures the disjunction, not the source it is named for.
  //
  // It matters because the two are not equivalent: only the renderer's version
  // applies snapScrollerScale, so the fallback silently reintroduces the
  // off-grid divisor on a path where offsets reach tens of thousands of pixels
  // - tab scroll restore, this fork's primary feature.
  //
  // Spying on window.scrollerScale is the only way to tell them apart, and it
  // duplicates nothing: the spy delegates straight back to the real function,
  // so the VALUE still comes from the product. restored is not decoration - a
  // spy left installed would corrupt every later assertion in this file.
  const deleg = JSON.parse(
    await exec(`
      (() => {
        const CT = window.CustomTabs;
        if (!CT || typeof CT.__offsetWithin !== 'function') {
          return JSON.stringify({ seam: false });
        }
        const sc = getViewerScroller();
        const el = viewer.querySelector('h2, h1, p');
        if (!sc || !el) return JSON.stringify({ seam: true, target: false });
        const real = window.scrollerScale;
        let calls = 0;
        let sameArg = false;
        window.scrollerScale = (s) => {
          calls++;
          if (s === sc) sameArg = true;
          return real(s);
        };
        let value = null;
        try {
          value = CT.__offsetWithin(sc, el);
        } finally {
          window.scrollerScale = real;
        }
        return JSON.stringify({
          seam: true,
          target: true,
          calls: calls,
          sameArg: sameArg,
          finite: Number.isFinite(value),
          restored: window.scrollerScale === real,
        });
      })()
    `),
  );
  console.log("note: scrollerScale delegation " + JSON.stringify(deleg));
  check(
    "the tab overlay's scroll arithmetic goes through the renderer's scroller scale, not its own fallback",
    deleg.seam === true &&
      deleg.target === true &&
      deleg.calls > 0 &&
      deleg.sameArg === true &&
      deleg.finite === true &&
      deleg.restored === true,
    JSON.stringify(deleg),
  );

  // THE SIX DIRECT-MUTATION SITES, WHICH THE GUARD'S CONTRACT COVERS AND
  // NOTHING PREVIOUSLY DROVE.
  //
  // viewerMutationGen exists so that ANY structural change to the viewer
  // subtree stands a pending zoom anchor down. R432 proves the product reports
  // the code-block wrap; it says nothing about the other paths that reparent or
  // remove nodes without going through a render at all. Those were found by
  // review to be HALF-COVERED: renderTableInDOM and renderMermaidInDOM each
  // reported their `replace` branch and stayed silent on their `insert` branch,
  // which appends straight into #viewer and displaces everything below it.
  //
  // A later review round found the COVERAGE half-covered in the mirror image:
  // the four legs below drove insert and delete but never `replace`, so the
  // two branches that had prompted the whole cell were themselves unpinned and
  // could be deleted with every assertion staying green. Both replace branches
  // are now driven (R445/R446), which is what makes this cell exhaustive over
  // the function rather than over the accident that was found first.
  //
  // So this cell calls the REAL product functions - not copies of them - and
  // requires the counter to move across each one. It reads the counter around
  // each call individually rather than once at the end, because a single
  // end-to-end delta would be satisfied by any ONE of the six reporting.
  //
  // Each site gets its own revert for the same reason R431 and R432 are two
  // entries: one revert cannot distinguish which site went silent.
  //
  // The source document is saved and restored, and so is the rendered fixture -
  // both delete functions REWRITE originalMarkdown, and the restore is in a
  // finally because the poll-and-throw lesson from the wrapper cell above
  // applies here with more force: this one perturbs global state, not just the
  // DOM.
  const mutSites = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const gen = () => window.viewerMutationGeneration();
        const savedSource = window.originalMarkdown;
        const out = { ran: [] };
        try {
          // 1. TABLE INSERT. Synchronous, and appends a .table-container to
          // #viewer via the else branch of renderTableInDOM.
          const beforeTI = gen();
          const nBefore = viewer.querySelectorAll('.table-container').length;
          window.renderTableInDOM(${JSON.stringify(MUT_TABLE_MD)}, 'insert');
          out.tableInsertDelta = gen() - beforeTI;
          out.tableInsertAdded =
            viewer.querySelectorAll('.table-container').length - nBefore;
          out.ran.push('tableInsert');

          // 1b. TABLE REPLACE - the context-menu "Edit Table" path, and the
          // branch review found UNPINNED: nothing in this file called
          // renderTableInDOM with mode='replace', so its noteViewerMutation()
          // could be deleted and every assertion here would stay green.
          //
          // Replaces with the SAME markdown deliberately. The delete leg below
          // scores against MUT_TABLE_MD, and a different replacement would
          // leave it nothing to find. IDENTITY, not content, is the oracle:
          // the old container must be gone from the viewer and the count must
          // not have moved, which distinguishes a replace from an insert.
          const preTR = viewer.querySelectorAll('.table-container');
          const oldTC = preTR[preTR.length - 1];
          const oldTableEl = oldTC ? oldTC.querySelector('table') : null;
          if (!oldTableEl) {
            out.tableReplaceDelta = null;
          } else {
            const beforeTR = gen();
            window.renderTableInDOM(${JSON.stringify(MUT_TABLE_MD)}, 'replace', oldTableEl);
            out.tableReplaceDelta = gen() - beforeTR;
            out.tableReplaceSwapped =
              !viewer.contains(oldTC) &&
              viewer.querySelectorAll('.table-container').length === preTR.length;
            out.ran.push('tableReplace');
          }

          // 2. TABLE DELETE. Driven against the container just inserted, with
          // the source pointed at the same markdown so the product's own
          // scoring can find it. Anchoring the delete on the inserted table
          // keeps this independent of the fixture's 12 tables.
          const inserted = viewer.querySelectorAll('.table-container');
          const lastC = inserted[inserted.length - 1];
          const tEl = lastC ? lastC.querySelector('table') : null;
          if (!tEl) {
            out.tableDeleteDelta = null;
          } else {
            window.originalMarkdown = ${JSON.stringify(MUT_TABLE_MD)};
            const heads = Array.prototype.map.call(
              tEl.querySelectorAll('th'), (e) => e.textContent.trim());
            const cells = Array.prototype.map.call(
              tEl.querySelectorAll('td'), (e) => e.textContent.trim());
            const beforeTD = gen();
            window.deleteTableFromSource(tEl, heads, cells);
            out.tableDeleteDelta = gen() - beforeTD;
            out.tableDeleteRemoved = !viewer.contains(lastC);
            out.ran.push('tableDelete');
          }

          // 3. MERMAID INSERT. Async, but the insert happens BEFORE the
          // mermaid render is attempted, so this does not depend on mermaid
          // succeeding - which is deliberate: the contract is about the DOM
          // mutation, not about the diagram.
          window.originalMarkdown = ${JSON.stringify(MUT_MERMAID_DOC)};
          const mBefore = viewer.querySelectorAll('.mermaid-container').length;
          const beforeMI = gen();
          await window.renderMermaidInDOM(${JSON.stringify(MUT_MERMAID_CODE)}, 'insert');
          out.mermaidInsertDelta = gen() - beforeMI;
          out.mermaidInsertAdded =
            viewer.querySelectorAll('.mermaid-container').length - mBefore;
          out.ran.push('mermaidInsert');

          // 3b. MERMAID REPLACE - the context-menu "Edit Diagram" path, the
          // other branch review found unpinned. Same identity oracle as the
          // table replace above, and the same reason for reusing the source:
          // the delete leg reads MUT_MERMAID_DOC.
          const preMR = viewer.querySelectorAll('.mermaid-container');
          const oldMC = preMR[preMR.length - 1];
          if (!oldMC) {
            out.mermaidReplaceDelta = null;
          } else {
            const beforeMR = gen();
            await window.renderMermaidInDOM(${JSON.stringify(MUT_MERMAID_CODE)}, 'replace', oldMC);
            out.mermaidReplaceDelta = gen() - beforeMR;
            out.mermaidReplaceSwapped =
              !viewer.contains(oldMC) &&
              viewer.querySelectorAll('.mermaid-container').length === preMR.length;
            out.ran.push('mermaidReplace');
          }

          // 4. MERMAID DELETE. The source above holds exactly ONE mermaid
          // block, so the product takes its single-block path and no scoring
          // is involved.
          const mcs = viewer.querySelectorAll('.mermaid-container');
          const lastM = mcs[mcs.length - 1];
          const mEl = lastM ? lastM.querySelector('.mermaid') : null;
          if (!mEl) {
            out.mermaidDeleteDelta = null;
          } else {
            const beforeMD = gen();
            window.deleteMermaidFromSource([], mEl);
            out.mermaidDeleteDelta = gen() - beforeMD;
            out.mermaidDeleteRemoved = !viewer.contains(lastM);
            out.ran.push('mermaidDelete');
          }
          return JSON.stringify(out);
        } finally {
          window.originalMarkdown = savedSource;
          await window.renderMarkdown(${JSON.stringify(ZOOM_ANCHOR_TABLE_DOC)}, "full");
        }
      })()
    `),
  );
  console.log("note: direct mutation sites " + JSON.stringify(mutSites));
  // Soundness first: an assertion that the counter moved means nothing if the
  // product function never mutated anything. Each leg has to be shown to have
  // actually inserted or removed the node it claims to.
  check(
    "each direct viewer-mutation path under test really inserted or removed the node it reports",
    mutSites.ran.length === 6 &&
      mutSites.tableInsertAdded === 1 &&
      mutSites.tableReplaceSwapped === true &&
      mutSites.tableDeleteRemoved === true &&
      mutSites.mermaidInsertAdded === 1 &&
      mutSites.mermaidReplaceSwapped === true &&
      mutSites.mermaidDeleteRemoved === true,
    JSON.stringify(mutSites),
  );
  // Six separate assertions, one per site, so a revert naming one of them
  // cannot be satisfied by another going silent.
  //
  // THE FOUR SYNCHRONOUS SITES ARE PINNED AT EXACTLY 1, not >= 1. A `>=` on a
  // counter reports a DISJUNCTION - "something bumped" - rather than the site
  // the assertion is named for. renderTableInDOM, deleteTableFromSource and
  // deleteMermaidFromSource are all plain `function`s, so no task boundary
  // opens between the two reads and the coalesced breakout pass (which bumps
  // per wrap) provably cannot land inside the window.
  //
  // The two mermaid RENDER legs stay at >= 1 for exactly that reason inverted:
  // renderMermaidInDOM is `async` and awaits ensureMermaid()/queueMermaidWork(),
  // so a 120ms-debounced breakout pass CAN land mid-call and add a second bump.
  // Measured at 1 today; pinning it there would be pinning the scheduler.
  check(
    "inserting a table into the DOM is reported as a viewer mutation",
    mutSites.tableInsertDelta === 1,
    JSON.stringify(mutSites),
  );
  check(
    "replacing a table in the DOM is reported as a viewer mutation",
    mutSites.tableReplaceDelta === 1,
    JSON.stringify(mutSites),
  );
  check(
    "deleting a table from the DOM is reported as a viewer mutation",
    mutSites.tableDeleteDelta === 1,
    JSON.stringify(mutSites),
  );
  check(
    "inserting a mermaid diagram into the DOM is reported as a viewer mutation",
    mutSites.mermaidInsertDelta >= 1,
    JSON.stringify(mutSites),
  );
  check(
    "replacing a mermaid diagram in the DOM is reported as a viewer mutation",
    mutSites.mermaidReplaceDelta >= 1,
    JSON.stringify(mutSites),
  );
  check(
    "deleting a mermaid diagram from the DOM is reported as a viewer mutation",
    mutSites.mermaidDeleteDelta === 1,
    JSON.stringify(mutSites),
  );

  // ZOOMING OUT AT AND NEAR THE BOTTOM (Opus S3), WHICH NO CELL REACHED.
  //
  // Every cell above aims at a fraction of the scroll range with room below it,
  // so none of them ever meets the case where the document SHORTENS under the
  // reader and the engine clamps the scroll. Measured first, then written, and
  // the measurement produced two DIFFERENT contracts that had to be separated:
  //
  //   AT THE HARD BOTTOM the anchor is exactly NEUTRAL. Measured on this
  //   fixture, the final scroll is byte-identical with the anchor on and off
  //   (both 57708, the new maximum), and the tracked content shifts by the same
  //   117.2px either way. That drift is not a defect and cannot be fixed: at
  //   the bottom the last line is pinned, so content above it must move toward
  //   it as the document shrinks. Hand-checked - a point 510px above the bottom
  //   at 130% sits (932-422)/1.3 = 392px above it at 100%, i.e. y = 540 against
  //   539.4 measured. Asserting a small drift here would be asserting something
  //   geometrically false; what IS assertable is that the anchor does not push
  //   the scroll away from the clamp.
  //
  //   NEAR THE BOTTOM the anchor is LOAD-BEARING, and this is the case worth
  //   having. At 95% depth the pre-zoom scroll (71432) exceeds the post-zoom
  //   maximum (57708), so with the correction disabled the engine clamps and
  //   the reader is thrown ~2774px - about three screens - to the very end of
  //   the document. With it, the position is held at 54934 and is NOT clamped.
  //
  // Scroll positions only, deliberately. The bottom leg needs no element oracle
  // to state either contract, and re-deriving the leaf walk here would
  // duplicate pick() for nothing.
  const zaBottom = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const reset = document.getElementById('zoomReset');
        const to100 = async () => {
          for (let i = 0; i < 12 && reset.textContent.trim() !== '100%'; i++) {
            reset.click();
            await sleep(70);
          }
          await sleep(300);
        };
        const leg = async (depth, off) => {
          const s = getViewerScroller();
          await to100();
          // Zoom IN first, so zooming back out genuinely shortens the document.
          for (let i = 0; i < 3; i++) { document.getElementById('zoomIn').click(); await sleep(250); }
          await sleep(500);
          const beforeRange = s.scrollHeight - s.clientHeight;
          s.scrollTop = Math.round(beforeRange * depth);
          await sleep(400);
          const beforeScroll = s.scrollTop;
          const realCap = window.captureZoomAnchor;
          if (off) window.captureZoomAnchor = function () {};
          const from = parseInt(reset.textContent, 10);
          for (let i = 0; i < 3; i++) { document.getElementById('zoomOut').click(); await sleep(250); }
          await sleep(800);
          if (off) window.captureZoomAnchor = realCap;
          const afterRange = s.scrollHeight - s.clientHeight;
          const till = parseInt(reset.textContent, 10);
          return {
            depth: depth,
            off: off,
            from: from,
            till: till,
            moved: from > 0 && till > 0 && from !== till,
            beforeScroll: beforeScroll,
            beforeRange: beforeRange,
            afterScroll: s.scrollTop,
            afterRange: afterRange,
            // The pre-zoom position is past the post-zoom maximum, which is
            // what makes the clamp the thing under test rather than incidental.
            wouldClamp: beforeScroll > afterRange,
            clamped: s.scrollTop >= afterRange - 1,
          };
        };
        try {
          const out = {
            hardOn: await leg(1.0, false),
            hardOff: await leg(1.0, true),
            nearOn: await leg(0.95, false),
            nearOff: await leg(0.95, true),
          };
          return JSON.stringify(out);
        } finally {
          await to100();
          getViewerScroller().scrollTop = 0;
        }
      })()
    `),
  );
  console.log("note: zoom-out at bottom " + JSON.stringify(zaBottom));
  // Soundness before contract: every leg must really have changed the zoom, and
  // both near-bottom legs must really be in the regime where the raw scroll
  // would be clamped. Without that second clause the "not clamped" assertion
  // below would pass trivially on a document that never shortened enough.
  const zbLegs = [zaBottom.hardOn, zaBottom.hardOff, zaBottom.nearOn, zaBottom.nearOff];
  check(
    "the zoom-out-at-bottom legs really zoomed out into the clamping regime",
    zbLegs.every((l) => l && l.moved === true && l.till < l.from && l.afterRange < l.beforeRange) &&
      zaBottom.nearOn.wouldClamp === true &&
      zaBottom.nearOff.wouldClamp === true &&
      zaBottom.hardOn.wouldClamp === true,
    JSON.stringify(zbLegs.map((l) => [l.depth, l.off, l.from, l.till, l.beforeScroll, l.afterRange, l.wouldClamp])),
  );
  // THE CASE THE FIX EARNS ITS KEEP IN. Both clauses are needed: the first is
  // the contract, the second is the sensitivity control that shows the engine
  // really would have clamped and that the correction is what prevented it.
  check(
    "zooming out near the bottom holds the reading position instead of jumping to the end",
    zaBottom.nearOn.clamped === false && zaBottom.nearOff.clamped === true,
    JSON.stringify([zaBottom.nearOn, zaBottom.nearOff]),
  );
  // The distance the reader is spared. A sensitivity floor in the same family
  // as OFF_MIN above - measured 2774px against a 932px pane, so the bar is set
  // at one full pane height rather than at the measured value, which would be a
  // floor describing the status quo.
  check(
    "the reading position held near the bottom is at least a full pane clear of the end",
    zaBottom.nearOff.afterScroll - zaBottom.nearOn.afterScroll >= 900,
    JSON.stringify([
      zaBottom.nearOn.afterScroll,
      zaBottom.nearOff.afterScroll,
      zaBottom.nearOff.afterScroll - zaBottom.nearOn.afterScroll,
    ]),
  );
  // AT THE HARD BOTTOM, NEUTRALITY IS THE WHOLE CONTRACT. The scroll must stay
  // clamped and must be the SAME with the correction and without it - the
  // anchor may not drag the reader off the end of the document it is pinned to.
  check(
    "at the very bottom the zoom anchor leaves the clamped position exactly where the engine put it",
    zaBottom.hardOn.clamped === true &&
      zaBottom.hardOff.clamped === true &&
      zaBottom.hardOn.afterScroll === zaBottom.hardOff.afterScroll,
    JSON.stringify([zaBottom.hardOn, zaBottom.hardOff]),
  );

  // ---------------------------------------------------------------------
  // S8: AN ORDINARY ZOOM STEP CROSSES THE wrap-anyway THRESHOLD, AND WHAT
  // ABSORBS IT IS CHROMIUM'S OWN SCROLL ANCHORING.
  //
  // applyTableBreakout() toggles `wrap-anyway` on `wanted > available`.
  // `available` is measured OUTSIDE the zoom-scaled subtree, so it is invariant
  // under zoom; `wanted` is measured INSIDE it, so it scales linearly with
  // zoom. A single zoom step can therefore cross that threshold with NO resize,
  // NO stale budget and NO DOM mutation at all - which means
  // noteViewerMutation() never fires and the anchor cannot stand itself down.
  // Measured on this fixture: every table flips, and the document grows AFTER
  // the anchor frame has already restored the reading position.
  //
  // The reader nevertheless does not move, and that was established by an A/B
  // rather than inferred. With overflow-anchor at its default the on-screen
  // displacement is 0.11px and scrollTop moves +27; with it set to none the
  // displacement is 26.3px and scrollTop does not move at all. The two shift
  // profiles are mirror images offset by the same 26.4px.
  //
  // THAT IS EXACTLY WHY IT IS PINNED HERE. Nothing in src/ mentions
  // overflow-anchor, so the thing doing the work is an ENGINE DEFAULT that one
  // future declaration - overflow-anchor: none, or a containment /
  // content-visibility experiment on the scroller - could remove silently,
  // handing the reader a 26px jump with nothing failing.
  //
  // WINDOW WIDTH IS PART OF THE FIXTURE, not incidental. The crossing point is
  // available/wanted; at the suite's 2000px window available is 1924 against a
  // wanted of 1120, which no 10% step from 100% can reach. At 1300px available
  // is 1224 and the crossing point is 1224/1120.41 = 1.0925, straddled exactly
  // by the 100 -> 110 step.
  const s8Bounds = win.getBounds();
  const S8_DOC = (() => {
    const out = [];
    const headers = [];
    const cells = [];
    for (let c = 0; c < 9; c++) {
      headers.push("Column heading " + c);
      cells.push("value-" + c + "-payload");
    }
    for (let i = 0; i < 40; i++) {
      out.push("## Section " + i);
      out.push("");
      out.push(
        "Paragraph " + i +
          " with enough words in it to occupy a couple of lines of the reading column so the document is genuinely tall.",
      );
      out.push("");
      if (i % 8 === 0) {
        out.push("| " + headers.join(" | ") + " |");
        out.push("|" + headers.map(() => "---").join("|") + "|");
        for (let r = 0; r < 4; r++) out.push("| " + cells.join(" | ") + " |");
        out.push("");
      }
    }
    return out.join("\n");
  })();
  await resizeWindow({ ...s8Bounds, width: 1300 });
  await exec("renderMarkdown(" + JSON.stringify(S8_DOC) + ", 'full')");
  await sleep(2500);
  await exec("applyTableBreakout(); null;");
  await sleep(600);
  // NOTE FOR EDITORS: never a backtick or a regex literal inside this exec body.
  const s8 = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const v = document.getElementById('viewer');
        const reset = document.getElementById('zoomReset');
        const WA = () => Array.prototype.slice
          .call(v.querySelectorAll('.table-container table'))
          .map((t) => (t.classList.contains('wrap-anyway') ? 1 : 0));
        const MARKS = () => Array.prototype.slice
          .call(v.querySelectorAll('h2'))
          .map((h) => Math.round(h.getBoundingClientRect().top * 100) / 100);
        const to100 = async () => {
          for (let i = 0; i < 12 && reset.textContent.trim() !== '100%'; i++) {
            reset.click();
            await sleep(70);
          }
          applyTableBreakout();
          await sleep(500);
        };
        const leg = async (anchoring) => {
          const s = getViewerScroller();
          // overflow-anchor: none on the scroller excludes its whole subtree
          // from being chosen as an anchor, which is the whole mechanism.
          s.style.overflowAnchor = anchoring ? '' : 'none';
          await to100();
          // Below every table, where the accumulated displacement is largest
          // and where a reading anchor has real work to do. At scrollTop 0 it
          // is trivially correct.
          s.scrollTop = Math.round(s.scrollHeight * 0.7);
          await new Promise(r => requestAnimationFrame(r));
          const paneH = s.clientHeight;
          const from = parseInt(reset.textContent, 10);
          document.getElementById('zoomIn').click();
          // Two rAFs is strictly after the single rAF applyZoomAnchor restores
          // in, so this is the state the reader is left in once the anchor has
          // finished - i.e. anything measured after it is invisible to the fix.
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const hMid = Math.round(v.scrollHeight);
          const waMid = WA();
          const mMid = MARKS();
          const sMid = Math.round(s.scrollTop);
          await sleep(900);
          const shifts = MARKS().map((t, i) => Math.round((t - mMid[i]) * 100) / 100);
          const worstOf = (a) => a.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0);
          return {
            anchoring: getComputedStyle(s).overflowAnchor,
            from: from,
            till: parseInt(reset.textContent, 10),
            paneH: paneH,
            waMid: waMid,
            waAfter: WA(),
            heightMovedAfterAnchor: Math.round(v.scrollHeight) - hMid,
            scrollTopMoved: Math.round(s.scrollTop) - sMid,
            onScreen: shifts.filter((sh, i) => mMid[i] >= -50 && mMid[i] <= paneH).length,
            worst: worstOf(shifts.filter((sh, i) => mMid[i] >= -50 && mMid[i] <= paneH)),
            // The deepest heading is below every table, so it carries the FULL
            // reflow - which is what makes the control an identity rather than
            // a floor.
            deepest: worstOf(shifts),
          };
        };
        try {
          const on = await leg(true);
          const off = await leg(false);
          return JSON.stringify({ on: on, off: off });
        } finally {
          getViewerScroller().style.overflowAnchor = '';
          await to100();
          getViewerScroller().scrollTop = 0;
        }
      })()
    `),
  );
  await resizeWindow(s8Bounds);
  const s8FlipsOf = (l) => l.waMid.map((w, i) => (w !== l.waAfter[i] ? i : -1)).filter((i) => i >= 0);
  const s8OnFlips = s8FlipsOf(s8.on);
  const s8OffFlips = s8FlipsOf(s8.off);
  console.log(
    "note: S8 wrap-anyway zoom step  on=" + JSON.stringify(s8.on) +
      "  off=" + JSON.stringify(s8.off) +
      "  flips=" + JSON.stringify([s8OnFlips, s8OffFlips]),
  );
  // PRECONDITION, NOT OUTCOME. A leg that never crossed the threshold reports
  // zero displacement - the identical number a working leg reports if the
  // engine absorbs it - so the two are indistinguishable unless the crossing is
  // asserted separately. Both legs must additionally take the SAME step and
  // flip the SAME tables, or the A/B below compares two different experiments.
  //
  // DELIBERATELY SAYS NOTHING ABOUT ANCHORING. "The cell reached the
  // phenomenon" and "the A/B legs really differed" are separate claims that
  // fail under separate accidents: a stylesheet declaring overflow-anchor:none
  // on the scroller leaves this one true and makes the control vacuous, while a
  // fixture that no longer crosses the threshold does the opposite. Folding
  // them together made a revert of the first report COLLATERAL and prove
  // nothing.
  check(
    "an ordinary zoom step really does flip wrap-anyway AFTER the anchor frame, identically in both legs",
    s8.on.from === 100 &&
      s8.off.from === 100 &&
      s8.on.till === 110 &&
      s8.off.till === 110 &&
      s8OnFlips.length > 0 &&
      s8OnFlips.join(",") === s8OffFlips.join(",") &&
      s8.on.waMid.every((w) => w === 0) &&
      s8.off.waMid.every((w) => w === 0) &&
      Math.abs(s8.on.heightMovedAfterAnchor) > 1 &&
      Math.abs(s8.off.heightMovedAfterAnchor) > 1 &&
      s8.on.onScreen >= 3 &&
      s8.off.onScreen >= 3,
    JSON.stringify([s8.on, s8.off, s8OnFlips, s8OffFlips]),
  );
  // THE CONTROL'S OWN VACUITY GUARD, AND IT NAMES THE CAUSE. The ON leg is the
  // product as shipped, so its scroller must be at the engine's anchoring
  // DEFAULT - overflow-anchor appears nowhere in src/, which is precisely why a
  // future declaration could remove the thing doing the work with nothing else
  // failing. Stated as "not none" rather than as an equality with "auto" so a
  // future engine default of a different name does not read as a defect.
  check(
    "the two legs really did run with different scroll anchoring (the A/B is a genuine comparison)",
    s8.on.anchoring !== "none" && s8.off.anchoring === "none",
    JSON.stringify([s8.on.anchoring, s8.off.anchoring]),
  );
  // THE CONTRACT. The document reflows after the anchor frame; with compact
  // padding it may now shrink instead of grow, but the reader must not move.
  check(
    "the reflow an ordinary zoom step triggers after the anchor frame does not move the reader",
    Math.abs(s8.on.worst) <= RESID_MAX.normal,
    JSON.stringify([s8.on.worst, RESID_MAX.normal, s8.on.heightMovedAfterAnchor, s8.on.scrollTopMoved]),
  );
  // THE CONTROL, AND IT IS AN IDENTITY RATHER THAN A FLOOR. With anchoring off
  // the scroll does not move, so the deepest heading - below every table - is
  // displaced by exactly the reflow above it: heightMovedAfterAnchor is in
  // #viewer's own pre-zoom px and a rect is in viewport px, so the two are
  // related by the zoom factor and nothing else. Measured 30 * 1.10 = 33.0
  // against 32.87. A round px floor would have been a description of the status
  // quo; this cannot flake and it names the mechanism.
  const s8Predicted = s8.off.heightMovedAfterAnchor * (s8.off.till / 100);
  check(
    "with the engine's scroll anchoring disabled the same step displaces the reader by exactly the reflow",
    Math.abs(s8.off.deepest - s8Predicted) <= 1.5 &&
      Math.abs(s8.off.worst) > RESID_MAX.normal &&
      s8.off.scrollTopMoved === 0 &&
      s8.on.scrollTopMoved !== 0,
    JSON.stringify([s8.off.deepest, s8Predicted, s8.off.worst, s8.off.scrollTopMoved, s8.on.scrollTopMoved]),
  );

  // ---------------------------------------------------------------------
  // S5: A ZOOM STEP LANDING INSIDE THE 120ms COALESCING WINDOW USED TO PUBLISH
  // A BUDGET MEASURED AGAINST THE PREVIOUS WINDOW SIZE.
  //
  // republishBreakoutBudgetForZoom() deliberately reads NO layout (item 4 took
  // 190-235ms per step off the zoom path that way) and divides the cached
  // `lastBreakoutAvailable` by the new zoom factor. Both resize paths defer the
  // recompute that refreshes that cache by TABLE_BREAKOUT_COALESCE_MS, so a
  // zoom inside that window published a stale budget; the deferred pass then
  // corrected the layout AFTER the anchor frame, moving the reader.
  //
  // THE STALENESS IS MANUFACTURED IN-RENDERER RATHER THAN BY RESIZING THE
  // WINDOW, and that is a requirement rather than a shortcut: resizeWindow()
  // polls until the inner size has arrived and held still, which takes far
  // longer than 120ms, so by the time it returns the debounce has already run
  // and the flag is down. The existing fixtures cannot reach this state at all,
  // which is exactly why S5 survived five review rounds. Setting an inline
  // width on .content-wrapper drives the REAL ResizeObserver path - one of the
  // two places the flag is raised - and lets the zoom land inside the window
  // deterministically.
  //
  // The precondition asserted below is that the cache genuinely DISAGREED with
  // live layout at the moment of the click. That reads identically on a broken
  // and a fixed tree, which is what makes it a vacuity guard rather than a
  // restatement of the outcome.
  const s5 = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const v = document.getElementById('viewer');
        const w = document.querySelector('.content-wrapper');
        const reset = document.getElementById('zoomReset');
        const pane = document.getElementById('editorPanel');
        const avail = () => w.clientWidth - (pane ? pane.offsetWidth : 0) - TABLE_BREAKOUT_GUTTER * 2;
        const budget = () => parseFloat(getComputedStyle(v).getPropertyValue('--mv-breakout-budget'));
        const zoomOf = () => parseFloat(getComputedStyle(v).zoom) || 1;
        const contW = () => {
          const c = v.querySelector('.table-container');
          return c ? Math.round(c.getBoundingClientRect().width * 100) / 100 : 0;
        };
        const to100 = async () => {
          for (let i = 0; i < 12 && reset.textContent.trim() !== '100%'; i++) {
            reset.click();
            await sleep(70);
          }
          applyTableBreakout();
          await sleep(500);
        };
        try {
          await to100();
          const wideAvailable = avail();
          // Narrow the reading area through the ResizeObserver, then wait ONLY
          // until the flag is up - never for the coalesced pass, which is the
          // thing the zoom must beat.
          //
          // max-width, NOT width: .content-wrapper is flex:1 (styles.css),
          // i.e. flex-basis 0 with grow 1, and a resolved flex length beats the
          // width property outright - an inline width was MEASURED to leave
          // clientWidth at 1972 and the observer silent. max-width clamps the
          // resolved flex length, so it really does move the box.
          w.style.maxWidth = '1272px';
          let raised = false;
          for (let i = 0; i < 40; i++) {
            if (typeof breakoutBudgetStale === 'boolean' && breakoutBudgetStale === true) {
              raised = true;
              break;
            }
            await sleep(5);
          }
          const cacheAtZoom = typeof lastBreakoutAvailable === 'number' ? lastBreakoutAvailable : null;
          const liveAvailable = avail();
          document.getElementById('zoomIn').click();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const zoom = zoomOf();
          const budgetMid = budget();
          const contMid = contW();
          const hMid = Math.round(v.scrollHeight);
          await sleep(900);
          return JSON.stringify({
            raised: raised,
            wideAvailable: wideAvailable,
            cacheAtZoom: cacheAtZoom,
            liveAvailable: liveAvailable,
            zoom: zoom,
            // Written as available/zoom, so multiplying back recovers the
            // viewport-pixel width the budget was derived from.
            budgetPublished: Math.round(budgetMid * zoom * 100) / 100,
            contMid: contMid,
            contAfter: contW(),
            heightMovedAfterAnchor: Math.round(v.scrollHeight) - hMid,
          });
        } finally {
          w.style.removeProperty('max-width');
          applyTableBreakout();
          await sleep(300);
          await to100();
          getViewerScroller().scrollTop = 0;
        }
      })()
    `),
  );
  console.log("note: S5 stale-budget zoom step " + JSON.stringify(s5));
  const s5CacheErr = s5.cacheAtZoom === null ? null : Math.round((s5.cacheAtZoom - s5.liveAvailable) * 100) / 100;
  check(
    "the stale-budget window really was reached (the cached width disagreed with live layout at the click)",
    s5.raised === true && s5CacheErr !== null && Math.abs(s5CacheErr) > 100 && s5.zoom > 1,
    JSON.stringify([s5.raised, s5.cacheAtZoom, s5.liveAvailable, s5CacheErr, s5.zoom]),
  );
  // THE CONTRACT, stated on the budget itself rather than on a downstream
  // symptom: the width the zoom path publishes must describe the reading area
  // the reader can actually see, not the one they had 35ms ago.
  check(
    "a zoom step inside the coalescing window publishes a budget measured against the CURRENT reading area",
    Math.abs(s5.budgetPublished - s5.liveAvailable) <= 1,
    JSON.stringify([s5.budgetPublished, s5.liveAvailable, s5.cacheAtZoom, s5.zoom]),
  );
  // THE READER-VISIBLE CONSEQUENCE. A budget 700px too wide let the container
  // paint 1232.45px wide in the anchor frame and the deferred pass then pulled
  // it back to 1224 - 8.45px of movement after the reading position had already
  // been restored. Stated as "does not move" rather than as a magnitude,
  // because zero is the only defensible value.
  check(
    "the table container does not move between the anchor frame and the coalesced pass",
    Math.abs(s5.contAfter - s5.contMid) <= 1,
    JSON.stringify([s5.contMid, s5.contAfter, s5.contAfter - s5.contMid]),
  );

  // ─── S9. Ctrl+wheel is anchored too, and that is now the USER'S DECISION ──
  //
  // Put to the user explicitly after they reported losing their place on
  // Ctrl+wheel: hold the pane's reading position (what the +/- buttons do), or
  // hold the point under the mouse cursor (what browsers and VS Code do). They
  // chose the reading position for every zoom path. This pins that choice, the
  // same way the `ul` 2em gutter and `breaks: false` are pinned - a deliberate
  // non-change recorded as a contract rather than left as an omission.
  //
  // It holds today for a reason that is easy to lose by accident:
  // captureZoomAnchor() is the FIRST statement of updateZoom() (renderer.js),
  // so every entry point inherits the anchor for free. The realistic accident
  // is a wheel path that stops going through updateZoom() - which is exactly
  // what "zoom toward the cursor" or "make the wheel path cheaper" would do.
  //
  // THE ORACLE IS AN EQUIVALENCE, NOT A RESIDUAL, and that is deliberate. The
  // button path's quality is already pinned by twelve cells against a derived
  // bar; asserting the wheel path lands where the BUTTON path lands from an
  // identical start inherits all of it, and cannot drift away from it later.
  // A residual copy here would be a second bar to keep in step with the first.
  //
  // A SYNTHETIC WheelEvent IS THE RIGHT INSTRUMENT HERE, and the reason is
  // measured rather than assumed. An untrusted event cannot drive Chromium's
  // NATIVE zoom - but a trusted CDP probe showed there is no native zoom to
  // drive (webFrame zoom factor stayed 1.0 across Ctrl+wheel steps, because
  // Electron disables ctrl+wheel page zoom by default), and no native scroll
  // either: the listener is registered { passive: false } (renderer.js, at the
  // end of the wheel handler) so its preventDefault() is honoured. Measured at
  // the zoom limits, where the handler's own guard refuses to act and so
  // nothing can mask a stray scroll, the scroll moved 0px while a plain
  // no-Ctrl wheel in the same probe moved exactly 120px.
  //
  // A CORRECTION KEPT ON THE RECORD, because the wrong version was written
  // down first: this listener was described as "forced passive" on the
  // strength of a console warning that was never traced to it. It is not - the
  // passive-by-default rule applies only where `passive` is unspecified. The
  // 0px reading was right; the reason given for it was wrong, and a measured
  // number attached to a false mechanism is exactly the failure this project
  // keeps rediscovering.
  //
  // NOTE FOR EDITORS: never a backtick or regex literal inside this exec().
  const s9 = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const s = getViewerScroller();
        const to100 = async () => {
          zoomLevel = 100; updateZoom(); await sleep(700);
        };

        // One start state, replayed for both legs. scrollTop is set BEFORE the
        // zoom in each leg so neither inherits the other's correction.
        // Against the SCROLL RANGE, not scrollHeight, matching the sibling
        // zoom cells: at 0.4 the two happen not to differ, but scrollHeight
        // overstates the reachable depth and would clamp silently further down.
        const range = s.scrollHeight - s.clientHeight;
        const START = Math.round(range * 0.4);

        await to100();
        s.scrollTop = START;
        await sleep(400);
        const startTop = s.scrollTop;

        // Leg A - the toolbar button, i.e. the path the suite already trusts.
        document.getElementById('zoomIn').click();
        await sleep(900);
        const btn = { zoom: zoomLevel, top: s.scrollTop };

        // Leg B - a real Ctrl+wheel through the product's own listener.
        await to100();
        s.scrollTop = START;
        await sleep(400);
        const startTopB = s.scrollTop;
        document.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true
        }));
        await sleep(900);
        const wheel = { zoom: zoomLevel, top: s.scrollTop };

        await to100();
        s.scrollTop = 0;
        await sleep(300);

        return JSON.stringify({
          startTop: startTop, startTopB: startTopB,
          pane: s.clientHeight, range: range,
          btnZoom: btn.zoom, wheelZoom: wheel.zoom,
          btnTop: btn.top, wheelTop: wheel.top,
          delta: wheel.top - btn.top
        });
      })()
    `),
  );
  console.log("note: S9 ctrl+wheel vs button:  " + JSON.stringify(s9));
  // TWO PRECONDITIONS, NOT ONE, and the split is the lesson S8 taught: a
  // precondition that answers two claims at once cannot say which of them
  // failed, and R440 proved that costs a revert its verdict.
  //
  // (i) THE EXPERIMENT RAN. Without this the contract passes vacuously
  // whenever the wheel event never reaches the handler - both legs would sit
  // where they started and agree perfectly.
  check(
    "a Ctrl+wheel really does drive a zoom step, from the same start as the button leg",
    s9.wheelZoom === 110 && s9.btnZoom === 110 && Math.abs(s9.startTop - s9.startTopB) <= 1,
    JSON.stringify([s9.startTop, s9.startTopB, s9.btnZoom, s9.wheelZoom]),
  );
  // (ii) THERE WAS REAL WORK TO DO - the half an equivalence oracle cannot
  // supply for itself. "Both legs anchored identically" and "neither leg
  // anchored at all" are the same reading, so the cell must prove the fixture
  // is genuinely scrolled AND that the button leg really made a correction.
  // The bar is DERIVED, not picked: a 100->110 step grows the document 10%, so
  // a reader at depth D has to be moved by about 0.1*D; half of that is a
  // generous floor that still cannot be cleared by a document sitting at 0.
  check(
    "the S9 fixture is deep enough, and the button leg really had a correction to make",
    s9.startTop > s9.pane && Math.abs(s9.btnTop - s9.startTop) >= s9.startTop * 0.05,
    JSON.stringify([s9.startTop, s9.pane, s9.range, s9.btnTop, s9.btnTop - s9.startTop]),
  );
  // THE CONTRACT, and the user's recorded decision.
  check(
    "Ctrl+wheel holds the reading position exactly as the zoom buttons do",
    Math.abs(s9.delta) <= 1,
    JSON.stringify([s9.btnTop, s9.wheelTop, s9.delta]),
  );

  // ─── S10. The stale budget path must not force a layout into the handler ──
  //
  // FOUND BY REVIEW, CONFIRMED BY MEASUREMENT, and it corrected the reviewers
  // as well as the code. Both independent reviewers flagged that the stale
  // branch of republishBreakoutBudgetForZoom() calls publishBreakoutBudget(),
  // which reads wrapper.clientWidth - and that this ran AFTER updateZoom() had
  // written viewer.style.zoom, making it a forced synchronous relayout of the
  // whole zoomed document inside the click handler. Measured on a
  // 9-table/90-section document: 14.7ms against 0.7ms for the cheap path.
  //
  // One reviewer additionally predicted a CORRECTNESS failure - that Chromium's
  // scroll anchoring would fire during that forced layout, move scrollTop
  // before zoomAnchorSuperseded() sampled it, trip the 2px slack and silently
  // discard the reader's correction. That was REFUTED by measurement: the shift
  // was 0.00px on both paths, with a positive control proving the stale branch
  // really ran (publishBreakoutBudget lowers the flag as a side effect, so a
  // flag still raised would have meant the leg measured nothing).
  //
  // The other reviewer proposed simply moving the zoom write later. That would
  // have been WRONG: publishBreakoutBudget derived the factor from computed
  // style, so it would have published `available / oldZoom`. Passing the factor
  // explicitly is what makes the reorder safe, and the budget assertion below
  // is what pins that - it is the half that has a crisp, timing-free oracle.
  const S10_DOC = (() => {
    const out = [];
    const headers = [];
    const cells = [];
    for (let c = 0; c < 8; c++) {
      headers.push("Heading column " + c);
      cells.push("payload-" + c + "-value");
    }
    for (let i = 0; i < 90; i++) {
      out.push("## Section " + i);
      out.push("");
      out.push("Paragraph " + i + " with enough words to occupy a couple of lines of the reading column.");
      out.push("");
      if (i % 6 === 0) {
        out.push("| " + headers.join(" | ") + " |");
        out.push("|" + headers.map(() => "---").join("|") + "|");
        for (let r = 0; r < 5; r++) out.push("| " + cells.join(" | ") + " |");
        out.push("");
      }
    }
    return out.join("\n");
  })();
  await exec("renderMarkdown(" + JSON.stringify(S10_DOC) + ", 'full')");
  await sleep(2500);
  await exec("applyTableBreakout(); null;");
  await sleep(600);
  // NOTE FOR EDITORS: never a backtick or a regex literal inside this exec body.
  const s10 = JSON.parse(
    await exec(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const s = getViewerScroller();
        const leg = async (stale) => {
          zoomLevel = 100; updateZoom(); await sleep(800);
          const range = s.scrollHeight - s.clientHeight;
          s.scrollTop = Math.round(range * 0.45);
          await sleep(400);
          breakoutBudgetStale = stale;
          const entry = breakoutBudgetStale;
          const availBefore = lastBreakoutAvailable;
          // The clock brackets the SYNCHRONOUS handler only, so a forced
          // relayout lands inside it and the frame's own relayout does not.
          const t0 = performance.now();
          document.getElementById('zoomIn').click();
          const t1 = performance.now();
          // READ SYNCHRONOUSLY, and that is not a detail. Sampled after the
          // settle sleep instead, this reads the value the COALESCED pass
          // publishes 120ms later - which is always correct, because by then
          // computed style carries the new zoom. The zoom path's own
          // publication is only observable in this window, and reading it late
          // made the assertion blind to exactly the revert it exists to catch
          // (R444 reported WRONG-GUARD until this moved up).
          const budget = parseFloat(viewer.style.getPropertyValue('--mv-breakout-budget'));
          const after = breakoutBudgetStale;
          await sleep(900);
          return {
            entry: entry, after: after, zoom: zoomLevel,
            avail: lastBreakoutAvailable, availBefore: availBefore,
            ms: t1 - t0,
            budget: budget
          };
        };
        const clean = await leg(false);
        const stale = await leg(true);
        zoomLevel = 100; updateZoom(); await sleep(600);
        s.scrollTop = 0;
        return JSON.stringify({ clean: clean, stale: stale });
      })()
    `),
  );
  console.log("note: S10 stale-budget zoom step  clean=" + JSON.stringify(s10.clean) +
    " stale=" + JSON.stringify(s10.stale));
  // THE PRECONDITION, and it is the positive control the null result needs.
  // publishBreakoutBudget() lowers the flag as its own side effect, so a flag
  // still raised after the step proves the stale branch was never taken and
  // both assertions below would be measuring the cheap path twice.
  check(
    "the S10 stale leg really took the measuring branch, and the clean leg really did not",
    s10.stale.entry === true && s10.stale.after === false &&
      s10.clean.entry === false && s10.stale.zoom === 110 && s10.clean.zoom === 110,
    JSON.stringify([s10.clean.entry, s10.clean.after, s10.stale.entry, s10.stale.after]),
  );
  // THE TIMING-FREE HALF. The measuring branch runs BEFORE the zoom is written,
  // so computed style still reports the OLD factor; the budget must therefore
  // be scaled by the factor passed in, not the one on the DOM. Reading it back
  // would publish `available / 1.0` here - a budget 10% too wide, which is
  // exactly the class of stale width R70's clamp exists to cap.
  check(
    "the zoom path's re-measured budget is scaled by the zoom being applied, not the one being left",
    Math.abs(s10.stale.budget - s10.stale.avail / 1.1) <= 0.5,
    JSON.stringify([s10.stale.budget, s10.stale.avail, s10.stale.avail / 1.1]),
  );
  // THE BAR IS DERIVED FROM THE SAME RUN, not picked. The cheap path touches no
  // layout at all, so it is the honest zero for this machine and this document;
  // a forced relayout was measured at 21x it. Comparing against a self-measured
  // companion rather than an absolute millisecond figure is what keeps this
  // stable on a loaded machine while still catching a regression of that size.
  check(
    "a zoom step on the stale-budget path does not force a layout into the click handler",
    s10.stale.ms <= s10.clean.ms * 4 + 2,
    JSON.stringify([s10.clean.ms, s10.stale.ms, s10.clean.ms * 4 + 2]),
  );
  // PINNED HERE RATHER THAN THROUGH THE RESIDUALS, and that is a measured
  // decision that CORRECTED AN EARLIER CLAIM. The normal-view residuals were
  // predicted to collapse once this divisor was fixed, and they did - but a
  // controlled run with only the snap removed reproduced them UNCHANGED
  // (0.3/0.3/-0.3 either way), so the collapse was never attributable to it.
  // The arithmetic agrees: the divisor scales the CORRECTION, which is
  // offset*(ratio-1) ~ 3515px here, so 3.3e-4 of it is ~1.2px and can never
  // account for the 4px that was being explained by it.
  //
  // The error is real all the same, and it is simply too small for a zoom
  // residual to see: custom-tabs.js offsetWithin() inherits the same divisor
  // through the delegation, and there offsets reach tens of thousands of px on
  // a refresh, which is the fork's primary feature. Same precedent as R202 and
  // R416 - an effect the end-to-end oracle cannot resolve is still a contract,
  // so it is restated where it can bite.
  check(
    "the scroller scale reads exactly 1 where the scroller is outside the zoomed subtree",
    zaScale.normal100 === 1,
    JSON.stringify(zaScale),
  );
  // ...and THIS is the snap's actual pin. The assertion above is a real product
  // contract but it cannot carry the revert: whether the raw ratio is off-grid
  // at that instant depends on whether layout happened to land on a whole pixel,
  // and measured here it lands on 1007/1007 exactly, so it reads 1 with or
  // without the estimator. Discovered by a WRONG-GUARD verdict, which is the
  // harness refusing to let a revert claim an assertion it does not move.
  check(
    "the scroller scale estimator snaps inside its noise bound and passes through outside it",
    zaScale.unitSnap === 1 && zaScale.unitPass === 1.0123,
    JSON.stringify(zaScale),
  );
  console.log(
    "note: zoom anchor staleness guards:  " + JSON.stringify(zaStale),
  );
  // Every clause of applyZoomAnchor's staleness gate, each one shown to matter
  // by the control immediately above it: with nothing broken the correction
  // DOES run, so a "did not move" below is the guard acting and not the probe
  // going quiet. `survived` carries the premise of the re-render case.
  check(
    "a zoom anchor is applied when nothing has invalidated it",
    zaStale.control === true,
    JSON.stringify(zaStale),
  );
  check(
    "a zoom anchor whose frame was delayed past its age limit is dropped",
    zaStale.aged === false,
    JSON.stringify(zaStale),
  );
  // THE NON-VACUITY PRECONDITION FOR THE ASSERTION IMMEDIATELY ABOVE, and it
  // exists because that assertion was measured going vacuous. It pins the
  // three things that make "did not move" mean "the AGE clause dropped it":
  // an anchor was still PENDING when the apply ran (the first version of this
  // trial let the product's own restore frame consume it during the sleep, so
  // applyZoomAnchor returned at its first line and the age line could be
  // deleted with the assertion still green); the anchor really was older than
  // the limit; and the scroller was still where it was captured, so the
  // supersede clause sitting immediately below the age check cannot have been
  // the one that fired. dGen/dMut are pinned at 0 for the same reason one
  // clause up. Without all four, a future change silently turns the age proof
  // back into a disjunction, which is exactly how R420 came back VACUOUS.
  check(
    "the age trial really aged a still-pending anchor without tripping any other clause",
    !!zaStale.guardDiag &&
      !!zaStale.guardDiag.aged &&
      zaStale.guardDiag.aged.pending === true &&
      zaStale.guardDiag.aged.age > zaStale.guardDiag.aged.maxAge &&
      Math.abs(zaStale.guardDiag.aged.topNow - zaStale.guardDiag.aged.top0) <=
        zaStale.guardDiag.aged.slack &&
      zaStale.guardDiag.aged.dGen === 0 &&
      zaStale.guardDiag.aged.dMut === 0,
    JSON.stringify(zaStale.guardDiag),
  );
  check(
    "a zoom anchor whose element lost its box is dropped",
    zaStale.boxless === false,
    JSON.stringify(zaStale),
  );
  check(
    "a zoom anchor whose element left the viewer is dropped",
    zaStale.outside === false,
    JSON.stringify(zaStale),
  );
  check(
    "a zoom anchor is dropped when the document was re-rendered under it",
    zaStale.regen === false && zaStale.survived === true,
    JSON.stringify(zaStale),
  );
  // THE CASE renderGeneration CANNOT SEE. Both reviewers reached it
  // independently: renderMarkdown bumps renderGeneration on its first line, but
  // renderMarkdownFull is async, so a render already in flight when the anchor
  // is captured has already bumped it - the compare passes and the landing goes
  // unnoticed. The post-render wrap passes are the same hole with no render
  // starting at all: addCodeBlockCopyButtons reparents every pre into a fresh
  // container from a requestIdle callback that fires AFTER the render promise
  // resolves. Paired with the control above, which proves the correction does
  // run when nothing has invalidated it.
  check(
    "a zoom anchor is dropped when the viewer tree was mutated under it without a new render",
    zaStale.mutated === false && zaStale.control === true,
    JSON.stringify(zaStale),
  );
  // THE OTHER DIRECTION, and the one the residual cells structurally cannot
  // reach: a scroll the ENGINE performed because the document got shorter is
  // not a competing agent and must not stand the correction down. `clamped` is
  // the premise (the engine really did drag the scroller down past the slack),
  // `held` the claim, and the two agents are the controls - one per clause of
  // the gate, each driven to the OPPOSITE verdict, so neither clause can have
  // been disabled rather than corrected.
  check(
    "a scroll the engine clamped because zooming out shortened the document is not treated as a competing scroll",
    zaStale.bottomClamp &&
      zaStale.bottomClamp.clamped === true &&
      zaStale.bottomClamp.held === false &&
      zaStale.bottomClamp.agentUp === true &&
      zaStale.bottomClamp.agentDown === true,
    JSON.stringify(zaStale.bottomClamp),
  );
  // N1: the burst guard and the frame that clears it must be set together. See
  // the probe's own comment for why a separated pair is a session-scoped
  // failure rather than a one-step one.
  check(
    "capturing a zoom anchor books the frame that applies it",
    zaStale.scheduled === true && zaStale.control === true,
    JSON.stringify(zaStale),
  );
  // Printed unconditionally, like the residual line below and for the same
  // reason: the wide-table cells are only evidence about the deferred breakout
  // remeasure if that remeasure actually moves geometry after the correction
  // frame. hMid is sampled past the anchor and before the 120ms pass, hAfter
  // past it - if those two agree, the cells clear nothing.
  console.log(
    "note: zoom breakout geometry (paneW " + zaTable.paneW + ", " + zaTable.n +
      " tables):  width " + zaTable.w0 + " -> " + zaTable.wMid + " -> " + zaTable.wAfter +
      "  |  summed height " + zaTable.h0 + " -> " + zaTable.hMid + " -> " + zaTable.hAfter +
      "  |  deferred pass moved height by " + (zaTable.hAfter - zaTable.hMid) + "px",
  );
  const zaOn = zaCells.map((c) => c.on);
  const zaOff = zaCells.map((c) => c.off);
  // The tolerances below are only meaningful next to the numbers they are
  // clearing. A floor that passes at a value nobody has ever read is how a
  // guard silently decays into a description of the status quo (the licence
  // audit's `> 200` against a real 220, and DEFAULT_SELECTION_FLOOR's
  // placeholder 1.0, were both found that way). So print them, every run.
  console.log(
    "note: zoom anchor px (residual<=normal " + RESID_MAX.normal + "/split " +
      RESID_MAX.split + ", OFF>" + OFF_MIN + "):  " +
      zaCells
        .map(
          (c) =>
            c.label + " on=" + c.on.drift + " resid=" + Math.round(residualOf(c.on) * 10) / 10 +
            " off=" + c.off.drift + " leaf=" + c.on.tag + "@" + c.on.offset +
            " " + c.on.from + "->" + c.on.till + "%" +
            " hit=" + c.on.hitTag + (c.on.walkFires ? " walk" : ""),
        )
        .join(" | "),
  );
  // Vacuity guards, in the order the measurement depends on them.
  check(
    "the zoom-anchor fixture is tall enough to exhibit a depth-proportional drift",
    zaCells.length === 12 && zaOn.every((c) => c.picked === true && c.range > 8000),
    JSON.stringify(zaCells.map((c) => [c.label, c.on.range])),
  );
  check(
    "every zoom-anchor cell reported the zoom levels its instrument error is derived from",
    zaOn.every((c) => c.from > 0 && c.till > 0 && c.from !== c.till) &&
      zaOff.every((c) => c.from > 0 && c.till > 0 && c.from !== c.till),
    JSON.stringify(zaCells.map((c) => [c.label, c.on.from, c.on.till])),
  );
  // THE WALK'S OWN VACUITY GUARD. refineZoomAnchor only descends when the
  // product's own elementFromPoint lands on something taller than the pane, so
  // without a cell that provably does, the walked and unwalked versions are
  // byte-identical and any revert of the walk reports VACUOUS. Asserted from
  // BOTH sides: the gap-aim cell must fire it in BOTH arms (it is the only cell
  // that does so by construction rather than by where the text happened to
  // fall), and the sweep must still contain cells that do NOT - otherwise the
  // ordinary on-content path has stopped being represented at all.
  check(
    "the refinement walk is exercised, and the sweep still covers the on-content path",
    zaCells.length === 12 &&
      zaCells.filter((c) => c.gap).length === 1 &&
      zaCells.filter((c) => c.stepwise).length === 2 &&
      zaCells.filter((c) => c.gap).every((c) => c.on.walkFires === true && c.off.walkFires === true) &&
      zaCells.filter((c) => !c.gap && !c.on.walkFires).length >= 4 &&
      // The wide-table fixture must actually be present, or the breakout leg
      // has silently stopped running and its clean residuals mean nothing.
      zaCells.filter((c) => c.tables).length === 2,
    JSON.stringify(zaCells.map((c) => [c.label, c.gap, c.on.walkFires, c.on.hitTag])),
  );
  check(
    "every zoom-anchor cell really moved the zoom level",
    zaOn.every((c) => c.moved === true) && zaOff.every((c) => c.moved === true),
    JSON.stringify(zaCells.filter((c) => !c.on.moved || !c.off.moved).map((c) => c.label)),
  );
  check(
    "the split-view legs really ran against #viewer as its own scroller",
    zoomAnchor.splitScrollerWasViewer === true,
    String(zoomAnchor.splitScrollerWasViewer),
  );
  // Soundness guard for the oracle itself: see the note above. If the tracked
  // leaf drifts far from the aimed point the oracle's own scaling error grows
  // and the tolerance below stops meaning what it says.
  //
  // THIS WAS `<= 40` AND THAT WAS A MAGIC NUMBER SITTING INSIDE THE FIXTURE'S
  // OWN JITTER. The depth-90% cell reported +40 on one run and -41 on the very
  // next against a byte-identical fixture: the aimed point lands midway between
  // two paragraphs and which one is "nearest" simply flips. A bound a fixture
  // can cross by tie-breaking is not a bound.
  //
  // Replaced by the identity that actually holds. pick() takes the leaf whose
  // top is nearest the aimed point, so that distance is at most HALF the
  // spacing to its neighbours - always, by construction. Checking |offset|
  // against the measured pitch therefore verifies the oracle really did pick
  // the nearest leaf (a walk that silently returned some other element would
  // violate it) and cannot flake, because the same layout supplies both sides.
  // The absolute closeness the comment above cares about is then carried by the
  // second clause: the fixture's leaf granularity must stay fine, so that
  // "nearest leaf" is never far in the first place. 200px is roughly three
  // paragraphs and the measured pitch is well inside it.
  check(
    "the tracked leaf sat close enough to the pane centre for the oracle to be sound",
    zaOn.every((c) => Math.abs(c.offset) <= c.pitch / 2 + 2 && c.pitch <= 200) &&
      zaOff.every((c) => Math.abs(c.offset) <= c.pitch / 2 + 2 && c.pitch <= 200),
    JSON.stringify(zaCells.map((c) => [c.label, c.on.offset, c.on.pitch, c.off.offset, c.off.pitch])),
  );
  // The sensitivity control. Without the fix the same measurement must report a
  // large drift in EVERY cell - otherwise a probe that had stopped observing
  // anything would satisfy the assertions below by measuring nothing.
  check(
    "with the zoom anchor disabled the same measurement sees the drift",
    zaOff.every((c) => Math.abs(c.drift) > OFF_MIN),
    JSON.stringify(zaCells.map((c) => [c.label, c.off.drift])),
  );
  // OPUS S4 - THE GESTURE PATH, WHICH EVERY OTHER CELL STRUCTURALLY CANNOT
  // REACH. arm() fires its three clicks in one task, so pendingZoomAnchor's
  // burst guard admits only the first: the whole run is ONE capture and ONE
  // correction, taken against the position the reader held before any of it.
  // That is a held key. It is a real path and worth measuring - but it is not
  // the path a reader takes. Click, read, click captures and applies three
  // separate times, so three independent corrections compose, and a per-step
  // bias that the burst pays for once is paid three times here.
  //
  // THE `applied` COUNT IS WHAT MAKES THIS MORE THAN A SLOWER COPY of the burst
  // cells. Without it, a stepwise run that silently coalesced back into one
  // correction would satisfy the residual bar for exactly the wrong reason -
  // the recorded disease where an assertion's subject can be supplied by more
  // than one path and it reports the disjunction.
  check(
    "the ordinary click-look-click gesture holds the reading position, not only a held-key burst",
    zaCells.filter((c) => c.stepwise).length === 2 &&
      zaCells
        .filter((c) => c.stepwise)
        .every((c) => c.on.applied === 3 && Math.abs(residualOf(c.on)) <= RESID_MAX[c.view]),
    JSON.stringify(
      zaCells
        .filter((c) => c.stepwise)
        .map((c) => [c.label, c.on.applied, c.on.drift, Math.round(residualOf(c.on) * 10) / 10]),
    ),
  );
  // The other half of the same measurement, stated rather than assumed: the
  // burst really is coalesced. If it ever stops being, the cells above lose
  // the property that distinguishes them and this says so.
  check(
    "a held-key zoom burst is corrected once, not once per step",
    zaCells.filter((c) => !c.stepwise).length === 10 &&
      zaCells.filter((c) => !c.stepwise).every((c) => c.on.applied === 1),
    JSON.stringify(zaCells.map((c) => [c.label, c.on.applied])),
  );
  // The fix. Split by view mode so a failure names which coordinate space
  // broke: split view is the leg that needs the scrollerScale() conversion.
  check(
    "zooming in normal view keeps the reader's place",
    zaCells
      .filter((c) => c.view === "normal" && !c.tables && !c.hi)
      .every((c) => Math.abs(residualOf(c.on)) <= RESID_MAX.normal),
    JSON.stringify(
      zaCells
        .filter((c) => c.view === "normal" && !c.tables && !c.hi)
        .map((c) => [c.label, c.on.drift, Math.round(residualOf(c.on) * 10) / 10]),
    ),
  );
  // THE WIDE-TABLE LEG (Opus S4, Luna #1 - which Luna rated blocking). Held to
  // the SAME bar as the other normal-view cells, deliberately: if the deferred
  // breakout pass displaced the reader, these would be the cells to show it,
  // and giving them a looser bar would be assuming the answer.
  check(
    "zooming with wide tables above the reading position keeps the reader's place",
    zaCells
      .filter((c) => c.tables)
      .every((c) => Math.abs(residualOf(c.on)) <= RESID_MAX.normal),
    JSON.stringify(
      zaCells
        .filter((c) => c.tables)
        .map((c) => [c.label, c.on.drift, Math.round(residualOf(c.on) * 10) / 10]),
    ),
  );
  // ...and the leg's own vacuity guard. The cells above are only evidence if
  // the fixture really produced tables that BROKE OUT of the reading column and
  // whose height really moved across the step. Both measured, neither assumed.
  check(
    "the wide-table fixture really broke out and really changed height under zoom",
    zaTable.n >= 10 && zaTable.w0 > zaTable.paneW && zaTable.hMid !== zaTable.h0,
    JSON.stringify(zaTable),
  );
  // THE FINDING ITSELF, pinned. Both reviewers predicted the ~120ms coalesced
  // remeasure would relayout AFTER the anchor was applied and re-introduce
  // drift nothing corrects. MEASURED, it does not: the whole height change
  // lands synchronously inside updateZoom() - 4183 -> 4592 by the time the
  // correction frame runs - and the deferred pass then re-derives the identical
  // widths and moves nothing. That is by design; republishBreakoutBudgetForZoom()
  // is the correctness-critical half and is deliberately synchronous (R70).
  // Asserting it keeps the refutation true: the day someone moves real layout
  // work out of the synchronous half and into the coalesced one, this fails and
  // the anchor genuinely will need re-anchoring around that pass.
  check(
    "the deferred table-breakout pass changes no geometry after the anchor frame",
    zaTable.hAfter === zaTable.hMid && zaTable.wAfter === zaTable.wMid,
    JSON.stringify(zaTable),
  );
  // ABOVE THE MAX-WIDTH THRESHOLD, normal view is a RE-WRAP regime and the
  // tight bar above simply does not apply - Opus S5, confirmed by measurement:
  // this cell reads -31.8px where the sub-threshold cells read 0.3. That is not
  // a defect, it is the same irreducible limit split view has, and it is bounded
  // by ONE LINE BOX in the pixels the drift is measured in. Derived rather than
  // observed: lineH is read off the tracked leaf in the subtree's own px and
  // scaled by the zoom the step ended at.
  //
  // THE MULTIPLY IS THE PART THAT WAS QUESTIONED (Opus S7, "the rewrapBar
  // derivation is overstated") and it is settled by MEASUREMENT, not argument -
  // this project has been wrong about coordinate spaces under CSS `zoom` three
  // times. Probing one leaf at 100/130/200/260%: getComputedStyle().lineHeight
  // reads 23.4 at EVERY level (ratio to base 1.000), while the same leaf's
  // getBoundingClientRect().height reads 46.8 / 60.83 / 93.6 / 121.68 - exactly
  // 1.3x, 2.0x, 2.6x. So the computed length is in the subtree's OWN pre-zoom
  // pixels and the rect is in viewport pixels, which is precisely the conversion
  // this multiply performs. S7 REFUTED on its stated point: the bar does not
  // double-count the zoom.
  // The bar keeps real slack over the measured residual, and that is the
  // INTENDED shape - it is a derivation (one line box), not an empirical floor
  // fitted to the status quo, which is exactly the fault the old 8/24 bars had.
  // The numbers are PRINTED on every run below rather than asserted in prose,
  // where an earlier "~75px" estimate sat unverified for want of anyone reading
  // it back off a run.
  // The split cells keep their measured 24 rather than adopting this rule,
  // because at 130% the same derivation yields ~38 and 24 is the tighter of the
  // two - there is no reason to loosen a bar that passes with margin.
  const rewrapBar = (a) => Math.max(8, Math.round((a.lineH || 0) * (a.till / 100)));
  console.log(
    "note: re-wrap bar vs measured residual " +
      JSON.stringify(
        zaCells
          .filter((c) => c.hi)
          .map((c) => [c.label, c.on.lineH, c.on.till, rewrapBar(c.on), Math.round(residualOf(c.on) * 10) / 10]),
      ),
  );
  check(
    "zooming in normal view above the max-width threshold stays within one line box",
    zaCells
      .filter((c) => c.hi)
      .every((c) => Math.abs(residualOf(c.on)) <= rewrapBar(c.on)),
    JSON.stringify(
      zaCells
        .filter((c) => c.hi)
        .map((c) => [c.label, c.on.drift, Math.round(residualOf(c.on) * 10) / 10, rewrapBar(c.on)]),
    ),
  );
  // ...and it must really have crossed the threshold, or it is just another
  // sub-threshold cell wearing a different label.
  check(
    "the above-threshold cell really ran entirely above the max-width threshold",
    zaCells.filter((c) => c.hi).length === 1 &&
      zaCells.filter((c) => c.hi).every((c) => c.on.from >= 230 && c.on.till >= 260),
    JSON.stringify(zaCells.filter((c) => c.hi).map((c) => [c.label, c.on.from, c.on.till, c.on.lineH])),
  );
  check(
    "zooming in split view keeps the reader's place",
    zaCells
      .filter((c) => c.view === "split")
      .every((c) => Math.abs(residualOf(c.on)) <= RESID_MAX.split),
    JSON.stringify(
      zaCells
        .filter((c) => c.view === "split")
        .map((c) => [c.label, c.on.drift, Math.round(residualOf(c.on) * 10) / 10]),
    ),
  );
  check(
    "what the reader was looking at is still on screen after a zoom burst",
    zaOn.every((c) => c.onScreen === true),
    JSON.stringify(zaCells.map((c) => [c.label, c.on.onScreen, c.on.drift])),
  );
  // The clamp, pinned at the unit level. Its end-to-end effect is bounded by
  // construction at a handful of px - |excess| * height * (ratio - 1), with the
  // height capped at the pane by refineZoomAnchor - so it is unreachable
  // through the drift tolerance above at any fixture shape, and a revert
  // measured that way comes back VACUOUS rather than wrong. renderer.js is a
  // classic script, so the extracted helper is directly reachable here.
  check(
    "an out-of-range zoom anchor fraction is clamped to the block's nearest edge",
    Array.isArray(zoomAnchor.clamp) &&
      zoomAnchor.clamp.length === 7 &&
      zoomAnchor.clamp.every((p) => p[0] === p[1]),
    JSON.stringify(zoomAnchor.clamp),
  );

  // --- SEC-31 end-to-end, from a real DOCUMENT ---------------------------
  // test:popups drives ipcMain "open-table-popup" directly with a hand-written
  // payload, so it measures the BOUNDARY and nothing else. That leaves the
  // producer unproven: if extractTableData() started emitting a differently
  // shaped column - a nested `columns` array, a `titleHtml` key, a title the
  // boundary never sees - the boundary assertions would still pass while a
  // real document reached Tabulator unescaped. This is the only assertion in
  // the project that exercises markdown -> extractTableData -> IPC ->
  // normaliseTablePayload -> Tabulator as one path.
  // THE FIXTURE USES ENTITIES ON PURPOSE, and the first attempt at it is worth
  // recording. Written as literal `<img src=x onerror=...>` markdown, this
  // measured elements:0, imgs:0, pwned:null but paintsRaw:FALSE - and the error
  // sentinel caught two broken images. That is the document path defending
  // itself twice over: DOMPurify keeps <img> but strips onerror, and then
  // extractTableData() reads the header's textContent, which drops the element
  // entirely. So literal markup can never reach a column title from a document,
  // and a fixture written that way proves nothing about the boundary.
  //
  // Entities survive both layers as TEXT, so textContent yields the characters
  // `<img src=x onerror=...>` verbatim - which is exactly the payload SEC-31 is
  // about, now arriving through the real producer instead of a hand-written
  // IPC message.
  const HOSTILE_HEADER =
    "| Name&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt; | B |\n" +
    "| --- | --- |\n" +
    "| one | two |\n";
  await exec(
    `(async () => {
      renderMarkdown(${JSON.stringify(HOSTILE_HEADER)}, "full");
      await new Promise(r => setTimeout(r, 1200));
      const c = document.querySelector('#viewer .table-container');
      const b = c && c.querySelector('.table-maximize-btn');
      if (b) b.click();
      return 1;
    })()`,
  );
  let tablePopup = null;
  for (let i = 0; i < 40 && !tablePopup; i++) {
    await sleep(250);
    tablePopup = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed()) || null;
  }
  if (tablePopup) {
    await sleep(2500);
    const e2e = JSON.parse(
      await tablePopup.webContents.executeJavaScript(
        `(() => {
          const t = document.querySelector('.tabulator-col-title');
          return JSON.stringify({
            found: !!t,
            // The header must be TEXT, so it has no element children...
            elements: t ? t.querySelectorAll('*').length : -1,
            // ...and it must still carry the document's own characters, which
            // is what separates "escaped" from "silently dropped".
            paintsRaw: t ? t.textContent.indexOf('<img') !== -1 : false,
            imgs: document.body.querySelectorAll('img').length,
            pwned: typeof window.__pwned === 'undefined' ? null : window.__pwned,
          });
        })()`,
        true,
      ),
    );
    check(
      "SEC-31 a hostile header in a real DOCUMENT reaches the popup as text",
      e2e.found === true &&
        e2e.elements === 0 &&
        e2e.paintsRaw === true &&
        e2e.imgs === 0 &&
        e2e.pwned === null,
      JSON.stringify(e2e),
    );
    tablePopup.destroy();
    await sleep(400);
  } else {
    check("SEC-31 a hostile header in a real DOCUMENT reaches the popup as text", false, "no popup window appeared");
  }


  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const report = await sentinel.stop();
  check(
    "no page errors while rendering tables",
    report.hits.length === 0,
    JSON.stringify(report.hits).slice(0, 400),
  );
  check(
    "the sentinel never stalled reaching the renderer",
    report.stalls.length === 0,
    JSON.stringify(report.stalls),
  );
}

function writeReport(summary) {
  try {
    fs.writeFileSync(
      path.join(__dirname, "test-table-display-results.txt"),
      results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`).join("\n") +
        "\n" +
        summary +
        "\n",
    );
  } catch {
    /* non-fatal */
  }
}

app.whenReady().then(async () => {
  await sleep(4000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log("FAIL  no window at ready - another instance is probably holding the single-instance lock.");
    clearTimeout(watchdog);
    app.exit(1);
    return;
  }
  let failed = 0;
  try {
    await run(win);
  } catch (e) {
    check("suite ran to completion", false, e.message);
  }
  failed = results.filter((r) => !r.ok).length;
  const summary = `=== ${results.length - failed}/${results.length} passed ===`;
  app.once("quit", () => console.log("\n" + summary + "\n"));
  writeReport(summary);
  app.once("will-quit", () => {
    clearTimeout(watchdog);
    app.exit(failed === 0 ? 0 : 1);
  });
  app.quit();
});
