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

require("./main.js");

const { captureScreenshot, startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");

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
  async function resizeWindow(bounds) {
    const cur = win.getBounds();
    const same = ["x", "y", "width", "height"].every(
      (k) => bounds[k] === undefined || bounds[k] === cur[k],
    );
    if (same) {
      await sleep(150);
      return;
    }
    const read = () =>
      exec("window.innerWidth + 'x' + window.innerHeight").then(String);
    const before = await read();
    win.setBounds(bounds);
    let last = before;
    let stable = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(25);
      const now = await read();
      stable = now !== before && now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 3) return;
    }
    console.log(
      "WARNING: window never settled at " +
        JSON.stringify(bounds) +
        " (inner size still " +
        last +
        "); downstream vacuity guards should catch this",
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
  const cssText = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
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
    .filter((f) => f && !fs.existsSync(path.join(__dirname, "fonts", f)));
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
      applyTableBreakout();
      applyTableBreakout();
      applyTableBreakout();
      const c = document.querySelectorAll('#viewer .table-container')[2];
      return JSON.stringify({
        stillBroken: c.classList.contains('table-breakout'),
        width: c.getBoundingClientRect().width,
      });
    })()`),
  );
  check(
    "breakout survives repeated recalculation",
    repeat.stillBroken === true,
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
      document.getElementById('toggleEdit').click();
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
      await new Promise(r => setTimeout(r, 500));
      const restored = c.getBoundingClientRect().width;
      mo.disconnect();
      return JSON.stringify({
        inSplitView,
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

  // The widened table has been measured but never looked at. Scroll it into
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
