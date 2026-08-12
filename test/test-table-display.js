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

require("../main.js");

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
  const cssText = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
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

  // Still narrow, so wrap-anyway is on. Entering split view skips the apply
  // pass entirely (breakout cannot work there), so unless the reset clears it,
  // the class is stranded and short columns keep wrapping in a pane that has
  // room for them. Driven through the real edit toggle.
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
    "wrap-anyway is cleared on entering split view, not stranded",
    strandedWrap.after === false,
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
  // document. Diagnosed by measurement rather than from the CSS - the scroller
  // does not change and the gutter is still 16px wide, so every width-based
  // check reads clean. What changes is what is PAINTED there: .index-panel is
  // `position: absolute; right: 0; z-index: 50`, anchored to .main-content, so
  // it lands exactly on top of the scrollbar. elementFromPoint is the only
  // probe that sees it.
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
          panelLeft: Math.round(panel.getBoundingClientRect().left),
          scrollerRight: Math.round(r.right),
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
        out.breakoutRight = Math.round(tr.right);
        out.breakoutUnderPanel = tr.right > panel.getBoundingClientRect().left + 1;
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
    "the scroller ends at or before the ToC panel rather than under it",
    tocGutter.modes.normalOpen.scrollerRight <=
      tocGutter.modes.normalOpen.panelLeft + 1,
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

  // Without this the sentinel reporting nothing and the sentinel having quietly
  // stopped watching are indistinguishable - the vacuity this harness exists to
  // rule out. Both channels are proven because they fail independently.
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
  clearTimeout(watchdog);
  failed = results.filter((r) => !r.ok).length;
  const summary = `=== ${results.length - failed}/${results.length} passed ===`;
  console.log("\n" + summary + "\n");
  writeReport(summary);
  app.exit(failed === 0 ? 0 : 1);
});
