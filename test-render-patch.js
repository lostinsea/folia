// Regression harness for the incremental render pipeline: patchViewerDOM(),
// heading identity, and the collapsible-section wrappers built on top of them.
// Run with: npm run test:patch
//
// Everything here guards one root defect and its two consequences.
//
// The defect: makeHeadersCollapsible() rewrites the viewer from a flat list of
// top-level blocks into [h1, div.collapsible-section, h2, ...], while the freshly
// parsed HTML that patchViewerDOM() diffs against is always flat. From the first
// heading onwards the positional comparison lined a wrapper up against an
// ordinary block, _getBlockHash() returned null for the wrapper, and the whole
// section was replaced. On a 60-heading / 60-code-block document that meant
// 1 of 1263 nodes survived a one-word edit - the incremental-patch optimisation
// was, in practice, doing nothing at all on any document with a heading in it.
//
// Consequence 1: heading ids were positional (`header-${index}`), and the
// collapsed-state map is keyed by them, so inserting a heading migrated every
// section's collapsed state onto its neighbour. Ids are now content-derived
// slugs, which also makes in-document anchor links work for the first time
// (marked 9 ignores the `headerIds: true` option still passed to setOptions).
//
// Consequence 2: nothing downstream could ever reuse a node, which hid the fact
// that the full render path called Prism.highlightAll() - a whole-document
// re-tokenise that ignores the .prism-highlighted marker.
//
// Note on what is asserted: node-survival counts, not milliseconds. A timing
// threshold would be flaky on shared hardware and would not say what broke;
// "the paragraph I edited is the only block that was replaced" is exact.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("./main.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-patch-"));

// Heading-rich and code-rich: headings are what triggers the wrapper
// mismatch, and code blocks are the most expensive thing a needless replace
// throws away (Prism spans plus the copy button).
function buildDoc(introText) {
  let doc = `# Document\n\n${introText}\n\n`;
  for (let i = 1; i <= 40; i++) {
    doc += `## Section ${i}\n\nBody text for section ${i}.\n\n`;
    doc += "```js\nconst x" + i + " = " + i + ";\n```\n\n";
  }
  return doc;
}
const DOC = buildDoc("Intro paragraph.");
const DOC_EDITED = buildDoc("Intro paragraph, edited.");

// Three named sections, so collapsed state can be tracked per section by name
// rather than by position - which is the whole point of the fix.
const DOC_ABC = "# Alpha\n\nalpha body\n\n# Beta\n\nbeta body\n\n# Gamma\n\ngamma body\n";
const DOC_ZABC = "# Zero\n\nzero body\n\n" + DOC_ABC;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

function writeReport(summary) {
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`);
  lines.push(summary);
  try {
    fs.writeFileSync(path.join(__dirname, "test-render-patch-results.txt"), lines.join("\n") + "\n");
  } catch (e) {
    console.log("could not write test-render-patch-results.txt: " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(exec, label, expression, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// A render is only finished once the idle callback that highlights code and
// hides the loading overlay has run. Polling for that is what makes the
// preservation counts below meaningful rather than racing the pipeline.
const RENDER_SETTLED = `
  (() => {
    const pending = viewer.querySelectorAll('pre code:not(.prism-highlighted)').length;
    const overlayUp = loadingScreen.classList.contains('active');
    return pending === 0 && !overlayUp;
  })()
`;

async function render(exec, markdown, mode) {
  await exec(`renderMarkdown(${JSON.stringify(markdown)}, ${JSON.stringify(mode)})`);
  await waitFor(exec, `render(${mode}) to settle`, RENDER_SETTLED);
}

// Tag every element currently under the viewer. Survivors of the next render
// are exactly the nodes patchViewerDOM reused. An expando property is used
// rather than an attribute so that tagging cannot itself change any element's
// serialised HTML and therefore its block hash.
const TAG_ALL = `
  (() => {
    let n = 0;
    viewer.querySelectorAll('*').forEach(el => { el.__probeTag = ++n; });
    return n;
  })()
`;

// After a render, makeHeadersCollapsible() has already folded the viewer into
// [h1, div.collapsible-section, ...], so viewer.children is NOT the list of
// top-level blocks - a 10-paragraph document reads as 2 children. Descend
// through the app's own wrappers to recover the flat block list the diff
// actually operates on. (A probe that skipped this reported total:2 and made
// every preservation assertion look broken.)
const TOP_BLOCKS = `
  (() => {
    const out = [];
    for (const el of viewer.children) {
      if (el.classList && el.classList.contains('collapsible-section') && el.dataset.mvCollapsible) {
        out.push(...el.children);
      } else {
        out.push(el);
      }
    }
    return out;
  })()
`;

async function run(win) {
  const { startErrorSentinel, proveSentinelAlive, captureScreenshot, trapExternalOpens, readExternalOpens, clearExternalOpens } = require("./test-visual-utils");
  const sentinel = startErrorSentinel(win, { label: "patch" });
  // Before ANY click: this suite dispatches real anchor clicks, and an http
  // anchor would otherwise launch the user's browser. See trapExternalOpens().
  await trapExternalOpens(win);
  const exec = (c) => win.webContents.executeJavaScript(c, true);

  await exec(`localStorage.clear(); null`);

  // ---------------------------------------------------------------------
  // 1. Heading ids are content-derived, not positional.
  //    Reverting to `header-${index}` fails every assertion in this section.
  // ---------------------------------------------------------------------
  await render(exec, DOC_ABC, "full");
  const ids = await exec(`JSON.stringify([...viewer.querySelectorAll('h1')].map(h => h.id))`);
  const idList = JSON.parse(ids);
  check("heading ids are slugs derived from the heading text", JSON.stringify(idList) === JSON.stringify(["alpha", "beta", "gamma"]), ids);
  check("no heading keeps a positional header-N id", !idList.some((i) => /^header-\d+$/.test(i)), ids);

  // An in-document anchor link is the user-visible half of the same fix: marked
  // 9 emits no id at all, so [x](#beta) resolved to nothing before this.
  const anchorOk = await exec(`!!document.getElementById('beta') && document.getElementById('beta').tagName === 'H1'`);
  check("an in-document anchor target resolves by slug", anchorOk === true, anchorOk);

  // ---------------------------------------------------------------------
  // 2. Collapsed state survives a heading being inserted above it.
  //    This is the defect a reader actually hits: an agent rewrites the file,
  //    a heading appears near the top, and every collapsed section shifts.
  //    With positional ids the observed result was
  //    (alpha,beta,gamma) = (true,false,true) -> (false,true,false).
  // ---------------------------------------------------------------------
  await exec(`
    (() => {
      // Guarded so that a regression in section 1 reports as a failed
      // assertion here rather than throwing and skipping every later section.
      ['alpha','gamma'].forEach(id => { const h = document.getElementById(id); if (h) h.click(); });
      return true;
    })()
  `);
  const before = await exec(`JSON.stringify({alpha: !!collapsedHeaders.get(_collapseKey('alpha')), beta: !!collapsedHeaders.get(_collapseKey('beta')), gamma: !!collapsedHeaders.get(_collapseKey('gamma'))})`);
  check("clicking a heading collapses exactly that section", before === JSON.stringify({ alpha: true, beta: false, gamma: true }), before);

  await render(exec, DOC_ZABC, "full");
  const after = await exec(`JSON.stringify({zero: !!collapsedHeaders.get(_collapseKey('zero')), alpha: !!collapsedHeaders.get(_collapseKey('alpha')), beta: !!collapsedHeaders.get(_collapseKey('beta')), gamma: !!collapsedHeaders.get(_collapseKey('gamma'))})`);
  check("collapsed state stays with its own section when a heading is inserted above", after === JSON.stringify({ zero: false, alpha: true, beta: false, gamma: true }), after);

  // The map is bookkeeping; what the reader sees is the class on the wrapper.
  const domState = await exec(`
    JSON.stringify(['zero','alpha','beta','gamma'].map(id => {
      const w = viewer.querySelector('.collapsible-section[data-for-header="' + id + '"]');
      return id + '=' + (w ? (w.classList.contains('collapsed') ? '1' : '0') : 'missing');
    }))
  `);
  check("the rendered wrappers show the same collapsed state as the map", domState === JSON.stringify(["zero=0", "alpha=1", "beta=0", "gamma=1"]), domState);

  // ---------------------------------------------------------------------
  // 2b. Collapse All / Expand All write into the SAME key space.
  //     custom-collapse.js keyed the shared collapsedHeaders Map by the raw
  //     header id while renderer.js only ever reads it through _collapseKey()
  //     (which prefixes the current file path). The writes therefore landed in
  //     a key space nothing reads, so Collapse All silently unwound on the next
  //     re-render - and would have leaked across documents had anything read
  //     them. Driven through the real menu item, not the internal function.
  //     H2 headings: Collapse All deliberately skips H1 (the document title).
  // ---------------------------------------------------------------------
  const DOC_H2 = "# Title\n\n## Alpha\n\na\n\n## Beta\n\nb\n\n## Gamma\n\nc\n";
  await render(exec, DOC_H2, "full");
  const collapsedAll = await exec(`
    (() => {
      const btn = document.getElementById('collapseAllBtn');
      if (!btn) return 'missing-button';
      btn.click();
      return JSON.stringify({
        map: ['alpha','beta','gamma'].map(id => !!collapsedHeaders.get(_collapseKey(id))),
        raw: ['alpha','beta','gamma'].map(id => collapsedHeaders.has(id)),
      });
    })()
  `);
  check(
    "Collapse All records state under the same key the renderer reads",
    collapsedAll === JSON.stringify({ map: [true, true, true], raw: [false, false, false] }),
    collapsedAll,
  );

  // The bug is only visible after a re-render: the DOM classes are set either
  // way, so asserting on them alone would pass with the defect present.
  await render(exec, DOC_H2, "full");
  const survived = await exec(`
    JSON.stringify(['alpha','beta','gamma'].map(id => {
      const w = viewer.querySelector('.collapsible-section[data-for-header="' + id + '"]');
      return w ? (w.classList.contains('collapsed') ? 1 : 0) : 'missing';
    }))
  `);
  check(
    "Collapse All survives a re-render instead of silently unwinding",
    survived === JSON.stringify([1, 1, 1]),
    survived,
  );

  await exec(`
    (() => {
      const btn = document.getElementById('expandAllBtn');
      if (btn) btn.click();
      return true;
    })()
  `);
  await render(exec, DOC_H2, "full");
  const expanded = await exec(`
    JSON.stringify(['alpha','beta','gamma'].map(id => {
      const w = viewer.querySelector('.collapsible-section[data-for-header="' + id + '"]');
      return w ? (w.classList.contains('collapsed') ? 1 : 0) : 'missing';
    }))
  `);
  check(
    "Expand All likewise survives a re-render",
    expanded === JSON.stringify([0, 0, 0]),
    expanded,
  );

  // ---------------------------------------------------------------------
  // 3. Slug collisions and non-Latin headings.
  //    \w is ASCII-only; using it here would slug a Cyrillic heading to the
  //    empty string, send it to the fallback, and re-create the shifting bug
  //    for non-Latin documents.
  // ---------------------------------------------------------------------
  await render(exec, "# Notes\n\na\n\n# Notes\n\nb\n\n# Привет мир\n\nc\n\n# Другой раздел\n\nd\n", "full");
  const ids2 = await exec(`JSON.stringify([...viewer.querySelectorAll('h1')].map(h => h.id))`);
  const idList2 = JSON.parse(ids2);
  check("repeated heading text produces distinct ids", idList2[0] === "notes" && idList2[1] === "notes-1", ids2);
  check("a non-Latin heading keeps a meaningful slug", idList2[2] === "привет-мир" && idList2[3] === "другой-раздел", ids2);
  check("every heading has a unique id", new Set(idList2).size === idList2.length, ids2);

  // ---------------------------------------------------------------------
  // 3b. Table-of-contents navigation scrolls whichever element actually
  //     scrolls. .content-wrapper owns the scrollbar in normal view but is
  //     `overflow: hidden` in split view, where #viewer scrolls its own half -
  //     so a hard-coded contentWrapper.scrollTo() is a silent no-op while the
  //     editor is open and clicking a TOC entry appears to do nothing. There
  //     was no TOC coverage at all before this.
  // ---------------------------------------------------------------------
  const TOC_DOC =
    "# Top\n\n" +
    Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n` + "filler paragraph.\n\n".repeat(12)).join("");
  await render(exec, TOC_DOC, "full");

  // The scroll target is only reachable if the document actually overflows;
  // otherwise both legs would trivially read 0 and prove nothing.
  const scrollTo = async (splitView, zoom) => {
    await exec(`
      (() => {
        const cw = document.querySelector('.content-wrapper');
        cw.classList.toggle('split-view', ${splitView ? "true" : "false"});
        zoomLevel = ${zoom};
        updateZoom();
        cw.scrollTop = 0;
        document.getElementById('viewer').scrollTop = 0;
        return true;
      })()
    `);
    await sleep(180);
    const before = await exec(`
      (() => {
        const s = getViewerScroller();
        return JSON.stringify({
          scroller: s.id || s.className,
          overflows: s.scrollHeight > s.clientHeight + 1,
        });
      })()
    `);
    await exec(`
      (() => {
        const item = [...document.querySelectorAll('.index-item')]
          .find((i) => i.dataset.headerId === 'section-9');
        if (!item) return 'missing';
        item.click();
        return true;
      })()
    `);
    // scrollTo uses behavior:'smooth', so the position is not final on return.
    // A fixed sleep is a coin toss on a slow machine, but a naive
    // "two consecutive equal samples" poll is worse: the animation may not have
    // STARTED yet, so the first two samples are both the pre-scroll position
    // and the poll exits having measured nothing. Require several consecutive
    // stable samples and a minimum elapsed time, so neither the start of the
    // animation nor a flat stretch of its easing tail can be mistaken for the
    // end of it.
    const STABLE_SAMPLES = 4;
    const MIN_ELAPSED_MS = 300;
    const started = Date.now();
    let last = null;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const now = await exec(`Math.round(getViewerScroller().scrollTop)`);
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (stable >= STABLE_SAMPLES && Date.now() - started >= MIN_ELAPSED_MS) break;
    }
    const after = await exec(`
      (() => {
        const s = getViewerScroller();
        const h = document.getElementById('section-9');
        const hr = h.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        return JSON.stringify({
          top: Math.round(s.scrollTop),
          headingOffset: Math.round(hr.top - sr.top),
        });
      })()
    `);
    return { before: JSON.parse(before), after: JSON.parse(after) };
  };

  // Zoom is the axis this used to be blind to. `zoom` is applied to #viewer
  // (renderer.js:1157), and the two scroll targets sit on opposite sides of it:
  // in normal view the scroller is .content-wrapper, OUTSIDE the zoomed
  // subtree, so scrollTop and getBoundingClientRect() are in the same units; in
  // split view the scroller IS #viewer, so scrollTop is in the subtree's own
  // pixels while getBoundingClientRect() stays in viewport pixels. Mixing those
  // in one expression is the exact coordinate-space error the table work hit
  // twice, and upstream fixed the same class of bug in its own TOC handler
  // (80646de). Covering only 100% zoom cannot see it, because the two spaces
  // coincide at 1.0.
  for (const splitView of [false, true]) {
    for (const zoom of [100, 200]) {
      const label = `${splitView ? "split view" : "normal view"} at ${zoom}%`;
      const { before, after } = await scrollTo(splitView, zoom);
      check(
        `the document really overflows in ${label}, so the scroll assertion can fail`,
        before.overflows === true,
        JSON.stringify(before),
      );
      check(
        `clicking a table-of-contents entry scrolls the page in ${label}`,
        after.top > 100,
        `scroller=${before.scroller} scrollTop=${after.top}`,
      );
      // What the reader cares about is the heading arriving near the top, not
      // that some number moved. The tolerance is expressed in VIEWPORT pixels
      // and scales with zoom, because the handler's own 20px top padding is
      // laid out inside the zoomed subtree and so is 40 viewport px at 200%.
      const tolerance = 40 + 20 * (zoom / 100);
      check(
        `the chosen heading ends up near the top of the view in ${label}`,
        Math.abs(after.headingOffset) < tolerance,
        `headingOffset=${after.headingOffset} tolerance=${tolerance} scroller=${before.scroller}`,
      );
      await captureScreenshot(
        win,
        `toc-nav-${splitView ? "split" : "normal"}-${zoom}`,
      );
    }
  }
  await exec(
    `zoomLevel = 100; updateZoom(); document.querySelector('.content-wrapper').classList.remove('split-view'); true`,
  );

  // ---------------------------------------------------------------------
  // 3c. Clicking an entry in the All Notes panel brings the note into view.
  //     This path had NO coverage at all - only the SEC-13 escaping test
  //     touched the panel, and it asserts the click does not throw, not that
  //     it goes anywhere. It shares scrollElementIntoView() with the TOC but
  //     asks for `center` rather than `start`, and it used to subtract
  //     `scrollerRect.height / 2` by hand on top of the same mixed-space sum,
  //     so it carried the zoom defect twice over.
  // ---------------------------------------------------------------------
  const NOTE_DOC =
    "# Notes\n\n" +
    "filler paragraph.\n\n".repeat(60) +
    '<span class="noted-text" data-note-id="1" data-note-title="t" data-note-content="c">the noted phrase</span>\n\n' +
    "filler paragraph.\n\n".repeat(60);
  await render(exec, NOTE_DOC, "full");

  for (const splitView of [false, true]) {
    for (const zoom of [100, 200]) {
      const label = `${splitView ? "split view" : "normal view"} at ${zoom}%`;
      await exec(`
        (() => {
          const cw = document.querySelector('.content-wrapper');
          cw.classList.toggle('split-view', ${splitView ? "true" : "false"});
          zoomLevel = ${zoom};
          updateZoom();
          cw.scrollTop = 0;
          document.getElementById('viewer').scrollTop = 0;
          updateNotesList();
          const item = document.querySelector('#notesList .notes-item');
          if (item) item.click();
          return true;
        })()
      `);
      await sleep(900);
      const note = JSON.parse(
        await exec(`
          (() => {
            const s = getViewerScroller();
            const el = document.querySelector('#viewer [data-note-id="1"]');
            const sr = s.getBoundingClientRect();
            const er = el.getBoundingClientRect();
            return JSON.stringify({
              // Both in viewport pixels, so this comparison needs no
              // conversion regardless of where the zoom sits.
              offsetFromCentre: Math.round(er.top + er.height / 2 - (sr.top + sr.height / 2)),
              scrollable: s.scrollHeight > s.clientHeight + 1,
              scrolled: Math.round(s.scrollTop),
            });
          })()
        `),
      );
      check(
        `the note really starts off screen in ${label}, so centring can fail`,
        note.scrollable === true && note.scrolled > 100,
        JSON.stringify(note),
      );
      // Generous but far tighter than the ~2000px a mis-scaled scroll produces.
      check(
        `clicking an All Notes entry centres the note in ${label}`,
        Math.abs(note.offsetFromCentre) < 120,
        JSON.stringify(note),
      );
    }
  }
  await exec(
    `zoomLevel = 100; updateZoom(); document.querySelector('.content-wrapper').classList.remove('split-view'); true`,
  );

  // ---------------------------------------------------------------------
  // 3d. An ordered list's left gutter has to be at least as wide as its widest
  //     marker. `list-style-position: outside` lays the marker box out inside
  //     that padding, so anything wider spills out of the list box - in split
  //     view three-digit markers ended up hard against the pane edge, visibly
  //     out of line with the two-digit ones above them.
  //
  //     Upstream fixed this for TWO digits (b0e991b). That case does not
  //     reproduce here, so this is not a cherry-pick: measured in the app's own
  //     13px Fira Code, "10." occupies 24px and fits the 26px that 2em buys,
  //     while "100." occupies 40px and does not.
  //
  //     The marker is measured, not computed from a digit count and a canvas.
  //     A canvas measurement of the marker TEXT understates the marker BOX by
  //     exactly one character - the generated marker is "N." plus a separating
  //     space - and sizing the gutter to the bare glyphs left "9999." clipped
  //     even though the arithmetic said it fit. Flipping the list to
  //     `list-style-position: inside` puts the marker into the inline flow, so
  //     the distance the text shifts IS the marker's real advance, whatever the
  //     UA's suffix happens to be. Nothing about the font, the digit count or
  //     the suffix is assumed - which also removes any need to reconstruct the
  //     marker string from start/value attributes.
  // ---------------------------------------------------------------------
  const LIST_DOC =
    "# Lists\n\n- bullet alpha\n- bullet beta\n\n" +
    "1. item one\n2. item two\n\nA paragraph, so the next list is a separate list.\n\n" +
    "98. item ninety eight\n99. item ninety nine\n100. item one hundred\n101. item one hundred one\n\n" +
    "Another paragraph.\n\n" +
    "9998. item four digits\n9999. item four digits\n";
  await render(exec, LIST_DOC, "full");
  const gutter = JSON.parse(
    await exec(`
      (() => {
        // First line box only. If an item ever wraps, the bounding rect's left
        // is the content edge from the second line and would report no shift.
        const firstLineLeft = (li) => {
          const r = document.createRange();
          r.selectNodeContents(li);
          const rects = r.getClientRects();
          return rects.length ? rects[0].left : r.getBoundingClientRect().left;
        };
        const measure = (list) => {
          const items = [...list.querySelectorAll(':scope > li')];
          const before = items.map(firstLineLeft);
          list.style.listStylePosition = 'inside';
          const after = items.map(firstLineLeft);
          list.style.listStylePosition = '';
          return {
            // Every item, not just the last: "widest marker" has to mean what
            // it says even if a value= reset ever makes the tail narrower.
            widestMarker: Math.max(...after.map((x, i) => x - before[i])),
            padding: parseFloat(getComputedStyle(list).paddingLeft),
          };
        };
        const ul = document.querySelector('#viewer ul');
        return JSON.stringify({
          lists: [...document.querySelectorAll('#viewer ol')].map(measure),
          ulPadding: parseFloat(getComputedStyle(ul).paddingLeft),
          ulFontSize: parseFloat(getComputedStyle(ul).fontSize),
        });
      })()
    `),
  );
  const widest = Math.max(...gutter.lists.map((l) => l.widestMarker));
  // Vacuity guard, written against the two reverts it exists to keep honest
  // rather than against a marker string. R82 restores the 2em bullet gutter and
  // R83 restores the 3em upstream uses; if the sample ever stopped containing a
  // marker wider than both, both reverts would silently pass and the assertion
  // below would hold for any padding at all.
  check(
    "the ordered-list sample really has a marker too wide for both the bullet gutter and 3em",
    widest > 3 * gutter.ulFontSize,
    JSON.stringify({ widest, lists: gutter.lists }),
  );
  check(
    "every ordered list's gutter is wide enough for its widest marker",
    gutter.lists.every((l) => l.padding >= l.widestMarker),
    JSON.stringify(gutter),
  );
  // Records a deliberate decision rather than an accident: bullets keep the
  // narrower gutter, because a wide one reads as disconnected from a single dot
  // and widening it would re-indent every unordered list to fix a problem those
  // lists do not have.
  check(
    "bullet lists keep the narrower gutter",
    Math.abs(gutter.ulPadding - 2 * gutter.ulFontSize) < 0.5,
    JSON.stringify(gutter),
  );
  // Screenshots as artifacts, not baselines. The numbers above prove the gutter
  // is wide enough; only a human (or an agent reading the image) can say the
  // result still LOOKS like a list. Split view is captured because that is
  // where the overflow was actually visible - markers hard against the pane
  // edge, out of line with the ones above them.
  for (const splitView of [false, true]) {
    await exec(`
      (() => {
        document.querySelector('.content-wrapper').classList.toggle('split-view', ${splitView});
        return true;
      })()
    `);
    await sleep(200);
    await captureScreenshot(win, `patch-lists-${splitView ? "split" : "normal"}`);
  }
  await exec(
    `(() => { document.querySelector('.content-wrapper').classList.remove('split-view'); return true; })()`,
  );

  // ---------------------------------------------------------------------
  // 3e. A soft break in the source stays a line break on screen.
  //
  //     This pins a DELIBERATE DIVERGENCE from upstream, not an accident.
  //     Upstream's 6089305 flips marked's `breaks` to false, which is what
  //     CommonMark and GitHub do: consecutive source lines reflow into one
  //     paragraph. That half of the commit is deliberately not taken.
  //
  //     The reason is this fork's actual use: the documents opened here are
  //     written by AI agents and are hard-wrapped, and a reader who wrote three
  //     lines expects three lines. Measured on a sample of hard-wrapped prose,
  //     an address block and a wrapped list item, `breaks: false` produced 1
  //     <br> against 6, and collapsed the address onto a single line. The user
  //     was shown both renderings and chose to render as typed.
  //
  //     Asserted on the rendered DOM rather than on the options object, so it
  //     still holds if the option is ever renamed or moved: what is being
  //     defended is the output, not the setting.
  // ---------------------------------------------------------------------
  await render(exec, "line one\nline two\n\npara two\n", "full");
  const breaks = JSON.parse(
    await exec(`
      (() => {
        const ps = [...document.querySelectorAll('#viewer p')];
        return JSON.stringify({
          brs: document.querySelectorAll('#viewer p br').length,
          paras: ps.length,
          text: ps.map(p => p.textContent),
        });
      })()
    `),
  );
  // Vacuity guard: a sample that lost its second line, or that split into two
  // paragraphs, would satisfy the <br> count for the wrong reason.
  check(
    "the soft-break sample really is one paragraph holding both lines",
    breaks.paras === 2 && breaks.text[0].includes("line one") && breaks.text[0].includes("line two"),
    JSON.stringify(breaks),
  );
  check(
    "a soft break in the source renders as a line break, not a reflowed paragraph",
    breaks.brs === 1,
    JSON.stringify(breaks),
  );

  // ---------------------------------------------------------------------
  // 4. patchViewerDOM actually preserves unchanged blocks.
  //    Without flattenCollapsibleSections() this measured 1 preserved node out
  //    of 1263 on the equivalent document, and topLevelKept was 1.
  // ---------------------------------------------------------------------
  for (const mode of ["full", "light-format"]) {
    await render(exec, DOC, "full");
    const tagged = await exec(TAG_ALL);
    await render(exec, DOC_EDITED, mode);

    const survivors = JSON.parse(
      await exec(`
        (() => {
          flattenCollapsibleSections();
          const all = [...viewer.querySelectorAll('*')];
          const top = [...viewer.children];
          return JSON.stringify({
            nodesNow: all.length,
            preserved: all.filter(el => el.__probeTag).length,
            topLevelNow: top.length,
            topLevelKept: top.filter(el => el.__probeTag).length,
            replacedTags: top.filter(el => !el.__probeTag).map(el => el.tagName)
          });
        })()
      `),
    );
    check(`[${mode}] the tagging probe saw a populated document`, tagged > 100 && survivors.topLevelNow > 100, JSON.stringify({ tagged, survivors }));
    check(
      `[${mode}] a one-paragraph edit replaces exactly one top-level block`,
      survivors.topLevelKept === survivors.topLevelNow - 1 && JSON.stringify(survivors.replacedTags) === JSON.stringify(["P"]),
      JSON.stringify(survivors),
    );
    check(
      `[${mode}] almost every node in the document survives the re-render`,
      survivors.preserved / survivors.nodesNow > 0.95,
      JSON.stringify(survivors),
    );

    // ------------------------------------------------------------------
    // 5. Preserved code blocks are not re-tokenised.
    //    The full path called Prism.highlightAll(), which ignores the
    //    .prism-highlighted marker: every <code> node survived and 0 of its
    //    540 syntax spans did.
    // ------------------------------------------------------------------
    const prism = JSON.parse(
      await exec(`
        (() => {
          const spans = [...viewer.querySelectorAll('pre code span')];
          const codes = [...viewer.querySelectorAll('pre code')];
          return JSON.stringify({
            spanTotal: spans.length,
            spanKept: spans.filter(el => el.__probeTag).length,
            codeTotal: codes.length,
            codeKept: codes.filter(el => el.__probeTag).length,
            buttons: viewer.querySelectorAll('.code-block-container button').length
          });
        })()
      `),
    );
    check(`[${mode}] the document really does contain highlighted code to preserve`, prism.spanTotal > 100 && prism.codeTotal === 40, JSON.stringify(prism));
    check(`[${mode}] preserved code blocks keep their syntax highlighting spans`, prism.spanKept === prism.spanTotal, JSON.stringify(prism));
    check(`[${mode}] every code block still has exactly one copy button`, prism.buttons === prism.codeTotal, JSON.stringify(prism));
  }

  // ---------------------------------------------------------------------
  // 6. The collapse toggle keeps working across re-renders.
  //    Now that headings survive a render, re-attaching a listener per heading
  //    per render stacks them. Each stacked handler flips header.classList
  //    again, so the parity of the listener count decides the outcome: with an
  //    odd number the last handler happens to write the right value to the live
  //    wrapper and the bug is invisible. Asserting after one, two and three
  //    re-renders covers both parities - checking only one of them is how this
  //    assertion first passed against the very code it was written to reject.
  //    Delegation cannot accumulate, so all three counts behave identically.
  // ---------------------------------------------------------------------
  for (const extraRenders of [1, 2, 3]) {
    await render(exec, "# Unrelated\n\nresets the heading nodes\n", "full");
    await render(exec, DOC_ABC, "full");
    for (let i = 0; i < extraRenders; i++) await render(exec, DOC_ABC, "light-format");

    const toggles = JSON.parse(
      await exec(`
        (() => {
          collapsedHeaders.clear();
          const h = document.getElementById('beta');
          const w = viewer.querySelector('.collapsible-section[data-for-header="beta"]');
          if (!h || !w) return JSON.stringify({ err: 'beta section missing', seq: [] });
          w.classList.remove('collapsed');
          h.classList.remove('collapsed');
          const seq = [];
          h.click(); seq.push(w.classList.contains('collapsed'));
          h.click(); seq.push(w.classList.contains('collapsed'));
          h.click(); seq.push(w.classList.contains('collapsed'));
          return JSON.stringify({ seq, map: collapsedHeaders.get(_collapseKey('beta')) });
        })()
      `),
    );
    check(
      `after ${extraRenders} re-render(s) a heading still toggles its own section`,
      JSON.stringify(toggles.seq) === JSON.stringify([true, false, true]),
      JSON.stringify(toggles),
    );
    check(
      `after ${extraRenders} re-render(s) the collapsed map agrees with the DOM`,
      toggles.map === true,
      JSON.stringify(toggles),
    );
  }

  // A link inside a heading must navigate, not collapse the section.
  //
  // "Navigate" was previously only half-asserted: the old check said the
  // section did not collapse, which a link whose handler never ran at all would
  // also satisfy. The external-open trap makes the other half observable, and
  // asserting on it is also what PINS the trap - delete it and the real
  // shell.openExternal fires, nothing is recorded, and this fails rather than
  // silently going back to opening a browser tab on the user's desktop.
  await render(exec, "# Plain\n\nbody\n\n# [Linked](https://example.invalid/x)\n\nmore body\n", "full");
  await clearExternalOpens(win);
  // Checked BEFORE the click, and the click itself refuses to fire without it.
  // Ordering is the whole point: an assertion placed after the dispatch would
  // report the missing trap only once the browser tab had already opened, so
  // proving this guard would cost the user the exact thing it prevents.
  const trapReady = await exec(`window.__externalTrapInstalled === true`);
  check(
    "external opens are trapped before any link is clicked, so the suite cannot reach the real browser",
    trapReady === true,
    String(trapReady),
  );
  const linkGuard = await exec(`
    (() => {
      if (window.__externalTrapInstalled !== true) return 'trap-missing';
      const a = viewer.querySelector('h1 a');
      if (!a) return 'no link in heading';
      const h = a.closest('h1');
      const w = viewer.querySelector('.collapsible-section[data-for-header="' + h.id + '"]');
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(evt);
      return w.classList.contains('collapsed') ? 'collapsed' : 'ok';
    })()
  `);
  check("clicking a link inside a heading does not collapse the section", linkGuard === "ok", linkGuard);
  const headingLinkOpens = await readExternalOpens(win);
  check(
    "clicking a link inside a heading hands the URL to the external opener",
    headingLinkOpens.length === 1 && headingLinkOpens[0] === "https://example.invalid/x",
    JSON.stringify(headingLinkOpens),
  );

  // ---------------------------------------------------------------------
  // 7. Wrapping is idempotent.
  //    makeHeadersCollapsible() is reachable from paths that do not run
  //    patchViewerDOM() first; without its own flatten it would nest every
  //    section inside a fresh wrapper on each call.
  // ---------------------------------------------------------------------
  await render(exec, DOC_ABC, "full");
  const idem = JSON.parse(
    await exec(`
      (() => {
        const once = viewer.querySelectorAll('.collapsible-section').length;
        makeHeadersCollapsible();
        const twice = viewer.querySelectorAll('.collapsible-section').length;
        makeHeadersCollapsible();
        makeHeadersCollapsible();
        return JSON.stringify({ once, twice, thrice: viewer.querySelectorAll('.collapsible-section').length });
      })()
    `),
  );
  check("re-wrapping an already-wrapped viewer does not nest wrappers", idem.once > 0 && idem.once === idem.twice && idem.twice === idem.thrice, JSON.stringify(idem));

  // Flattening must restore the original block order, not merely remove divs.
  const flatOrder = await exec(`
    (() => {
      flattenCollapsibleSections();
      return [...viewer.children].map(el => el.tagName + (el.id ? '#' + el.id : '')).join(',');
    })()
  `);
  check("flattening restores the original top-level block order", flatOrder === "H1#alpha,P,H1#beta,P,H1#gamma,P", flatOrder);

  // ---------------------------------------------------------------------
  // 8. A rendered mermaid diagram survives a re-render.
  //    Once drawn, a .mermaid element is wrapped in div.mermaid-container by
  //    the maximize button, so patchViewerDOM's mermaid branch - which used to
  //    require the 'mermaid' class on BOTH sides - stopped matching after the
  //    first render and threw the drawn diagram away. The full path redrew it,
  //    so nothing failed; it was found by looking at a screenshot.
  // ---------------------------------------------------------------------
  const MERMAID_DOC = "# Diagram Doc\n\nIntro.\n\n```mermaid\ngraph LR\n  PatchA --> PatchB\n```\n";
  const MERMAID_DOC2 = MERMAID_DOC.replace("Intro.", "Intro, edited.");
  await exec(`renderMarkdown(${JSON.stringify(MERMAID_DOC)}, 'full')`);
  await waitFor(exec, "the diagram to be drawn", `viewer.querySelectorAll('.mermaid svg').length === 1`);
  await waitFor(exec, "the maximize button to wrap it", `viewer.querySelectorAll('.mermaid-container').length === 1`);

  // The mode is chosen by the app, not forced: detectRenderMode() always
  // returns 'full' for a document containing a mermaid fence, so forcing
  // 'light-format' here would test a state the app can never reach.
  const mermaidMode = await exec(`detectRenderMode(${JSON.stringify(MERMAID_DOC)}, ${JSON.stringify(MERMAID_DOC2)})`);
  check("a mermaid document is still routed through the full render path", mermaidMode === "full", mermaidMode);

  await exec(`
    (() => {
      viewer.querySelector('.mermaid-container').__probeCon = 1;
      viewer.querySelector('.mermaid').__probeMer = 1;
      return true;
    })()
  `);
  await exec(`renderMarkdown(${JSON.stringify(MERMAID_DOC2)})`);
  await waitFor(exec, "the edited paragraph to appear", `viewer.textContent.includes('Intro, edited.')`);
  await waitFor(exec, "a drawn diagram after the re-render", `viewer.querySelectorAll('.mermaid svg').length === 1`);

  const mermaidState = JSON.parse(
    await exec(`
      (() => {
        const c = viewer.querySelector('.mermaid-container');
        const m = viewer.querySelector('.mermaid');
        return JSON.stringify({
          containerSurvived: !!(c && c.__probeCon),
          mermaidSurvived: !!(m && m.__probeMer),
          drawn: viewer.querySelectorAll('.mermaid svg').length,
          labels: m ? m.textContent.replace(/\\s+/g, ' ').trim() : '',
          maxBtns: viewer.querySelectorAll('.mermaid-maximize-btn').length,
          errorCards: viewer.querySelectorAll('.mermaid [style*="color: red"]').length
        });
      })()
    `),
  );
  check("the drawn diagram element is reused rather than replaced", mermaidState.containerSurvived && mermaidState.mermaidSurvived, JSON.stringify(mermaidState));
  check("the diagram is still drawn, with its own labels, after the re-render", mermaidState.drawn === 1 && /PatchA/.test(mermaidState.labels) && /PatchB/.test(mermaidState.labels), JSON.stringify(mermaidState));
  check("the diagram did not collect a second maximize button or an error card", mermaidState.maxBtns === 1 && mermaidState.errorCards === 0, JSON.stringify(mermaidState));

  // ---------------------------------------------------------------------
  // 9. A .collapsible-section the DOCUMENT author wrote is not eaten.
  //    DOMPurify keeps `class`, so a document can legitimately contain one.
  //    An unscoped flatten deleted the author's div - and its id, styles and
  //    every other attribute - on every re-render.
  // ---------------------------------------------------------------------
  const AUTHORED = '# Authored\n\n<div class="collapsible-section" id="mine" data-for-header="pwn" style="border:1px solid red">author content</div>\n\ntail\n';
  await render(exec, AUTHORED, "full");
  await render(exec, AUTHORED, "light-format");
  await render(exec, AUTHORED, "light-format");
  const authored = JSON.parse(
    await exec(`
      (() => {
        const el = viewer.querySelector('#mine');
        return JSON.stringify({
          present: !!el,
          keptAttrs: el ? (el.getAttribute('style') || '') : '',
          text: el ? el.textContent : '',
          ownWrappers: viewer.querySelectorAll('.collapsible-section[data-mv-collapsible]').length
        });
      })()
    `),
  );
  check("a document-authored .collapsible-section survives repeated re-renders", authored.present === true && authored.text === "author content", JSON.stringify(authored));
  check("its attributes are not stripped by the flatten pass", /red/.test(authored.keptAttrs), JSON.stringify(authored));

  // ---------------------------------------------------------------------
  // 10. Duplicate ids arriving from raw HTML are re-slugged.
  //     collapsedHeaders and expandToHeader() both resolve ids with
  //     getElementById, which silently addresses only the first of a pair.
  // ---------------------------------------------------------------------
  await render(exec, '<h1 id="dup">First</h1>\n\na\n\n<h1 id="dup">Second</h1>\n\nb\n', "full");
  const dupes = await exec(`JSON.stringify([...viewer.querySelectorAll('h1')].map(h => h.id))`);
  const dupList = JSON.parse(dupes);
  check("two headings sharing a raw-HTML id do not both keep it", dupList.length === 2 && new Set(dupList).size === 2, dupes);
  check("the first heading keeps the id the author wrote", dupList[0] === "dup", dupes);

  // ---------------------------------------------------------------------
  // 11. Post-processing does not double-inject over preserved nodes.
  //     Everything that adds a button guards on a wrapper already existing;
  //     preserved nodes are the case those guards now actually have to handle.
  // ---------------------------------------------------------------------
  const INJ = "# Inject\n\nintro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n";
  await render(exec, INJ, "full");
  await render(exec, INJ.replace("intro", "intro edited"), "full");
  await render(exec, INJ.replace("intro", "intro edited twice"), "full");
  const injected = JSON.parse(
    await exec(`
      JSON.stringify({
        copy: viewer.querySelectorAll('.code-block-container button').length,
        codeContainers: viewer.querySelectorAll('.code-block-container').length,
        tableBtns: viewer.querySelectorAll('.table-maximize-btn').length,
        tableContainers: viewer.querySelectorAll('.table-container').length
      })
    `),
  );
  check("preserved code blocks do not accumulate copy buttons or wrappers", injected.copy === 1 && injected.codeContainers === 1, JSON.stringify(injected));
  check("preserved tables do not accumulate maximize buttons or wrappers", injected.tableBtns === 1 && injected.tableContainers === 1, JSON.stringify(injected));

  // ---------------------------------------------------------------------
  // 12. Inserting a block in the MIDDLE preserves the blocks after it.
  //     The diff used to compare index i to index i, so a single inserted
  //     paragraph shifted every later block by one and the whole tail was
  //     rebuilt. Reverting to the positional loop preserves only the blocks
  //     ABOVE the insertion point and fails both assertions here.
  //     This is the most common edit shape there is - an agent appending a
  //     section to a file the reader has open - so it is the case the whole
  //     optimisation exists for.
  // ---------------------------------------------------------------------
  const paras = (extra) => {
    let md = "# Middle\n\n";
    for (let i = 1; i <= 10; i++) {
      md += `paragraph number ${i}\n\n`;
      if (extra && i === 5) md += "freshly inserted paragraph\n\n";
    }
    return md;
  };
  await render(exec, paras(false), "light-format");
  await exec(TAG_ALL);
  await render(exec, paras(true), "light-format");
  const mid = JSON.parse(
    await exec(`
      (() => {
        const tops = ${TOP_BLOCKS};
        const texts = tops.map(el => el.textContent.trim());
        return JSON.stringify({
          total: tops.length,
          tagged: tops.filter(el => el.__probeTag !== undefined).length,
          inserted: texts.filter(t => t === 'freshly inserted paragraph').length,
          after6kept: tops.filter(el => el.__probeTag !== undefined &&
            /^paragraph number (6|7|8|9|10)$/.test(el.textContent.trim())).length,
          order: texts.filter(t => /^paragraph number|freshly/.test(t)).join('|')
        });
      })()
    `),
  );
  check("the inserted paragraph appears exactly once, in the right place", mid.inserted === 1 && /number 5\|freshly inserted paragraph\|paragraph number 6/.test(mid.order), JSON.stringify(mid));
  check("every paragraph AFTER the insertion point is the same DOM node", mid.after6kept === 5, JSON.stringify(mid));

  // Deletion is the same problem mirrored.
  await render(exec, paras(false), "light-format");
  await exec(TAG_ALL);
  await render(exec, paras(false).replace("paragraph number 3\n\n", ""), "light-format");
  const del = JSON.parse(
    await exec(`
      (() => {
        const tops = ${TOP_BLOCKS};
        return JSON.stringify({
          gone: tops.filter(el => el.textContent.trim() === 'paragraph number 3').length,
          tailKept: tops.filter(el => el.__probeTag !== undefined &&
            /^paragraph number (4|5|6|7|8|9|10)$/.test(el.textContent.trim())).length
        });
      })()
    `),
  );
  check("a deleted paragraph is removed and the blocks below it are reused", del.gone === 0 && del.tailKept === 7, JSON.stringify(del));

  // ---------------------------------------------------------------------
  // 13. A heading whose slug collides with one of the app's own element ids
  //     must still be reachable by anchor. `# Viewer` is given id "viewer-1"
  //     to avoid clashing with the #viewer container, so a link to #viewer
  //     has to fall through to the slug search. Reverting the containment
  //     guard in the anchor handler makes this scroll to the top instead.
  // ---------------------------------------------------------------------
  await render(exec, "# Intro\n\n[Jump](#viewer)\n\n" + "filler\n\n".repeat(60) + "# Viewer\n\nthe real section\n\n" + "tail filler\n\n".repeat(60), "full");
  const collide = JSON.parse(
    await exec(`
      (async () => {
        const heads = [...viewer.querySelectorAll('h1')];
        const target = heads.find(h => h.textContent.trim() === 'Viewer');
        const link = [...viewer.querySelectorAll('a')].find(a => a.getAttribute('href') === '#viewer');
        contentWrapper.scrollTop = 0;
        if (link) link.click();
        // The handler scrolls with behavior:'smooth'; wait for it to settle.
        let last = -1, stable = 0;
        for (let i = 0; i < 60 && stable < 4; i++) {
          await new Promise(r => setTimeout(r, 50));
          if (contentWrapper.scrollTop === last) stable++; else { stable = 0; last = contentWrapper.scrollTop; }
        }
        const hRect = target ? target.getBoundingClientRect() : null;
        const cRect = contentWrapper.getBoundingClientRect();
        return JSON.stringify({
          headingId: target ? target.id : null,
          globalViewerIsContainer: document.getElementById('viewer') === viewer,
          hadLink: !!link,
          scrollTop: Math.round(contentWrapper.scrollTop),
          headingOffsetFromTop: hRect ? Math.round(hRect.top - cRect.top) : null
        });
      })()
    `),
  );
  check("a heading colliding with an app id is renamed, not left ambiguous", collide.headingId === "viewer-1" && collide.globalViewerIsContainer === true, JSON.stringify(collide));
  // The real assertion: clicking [Jump](#viewer) must land on the HEADING.
  // Without the containment guard, document.getElementById('viewer') returns
  // the app container, whose offset resolves to the very top - scrollTop 0.
  check("clicking an anchor that collides with an app id scrolls to the heading", collide.hadLink === true && collide.scrollTop > 200, JSON.stringify(collide));
  check("the heading ends up at the top of the reading area, not off screen", collide.headingOffsetFromTop !== null && Math.abs(collide.headingOffsetFromTop) < 60, JSON.stringify(collide));

  // ---------------------------------------------------------------------
  // 14. Wrappers added by post-processing must be visible to the diff.
  //     img-zoom-container / omniware-container were not in the wrapper list,
  //     so _getBlockHash() returned null for them and an unrelated edit
  //     elsewhere replaced an untouched image on every render. Removing them
  //     from _BLOCK_WRAPPER_CLASSES drops imgKept to 0.
  // ---------------------------------------------------------------------
  // A real file, not a placeholder: this block is compared by DOM identity, and
  // a src that 404s renders a broken-image icon that the error sentinel (quite
  // rightly) fails the run for. Using an image that actually loads also makes
  // the check stronger - the reused node is one that really painted.
  const IMGDOC =
    '# Images\n\nintro paragraph\n\n<img src="app-icon.png" alt="one">\n\ntail paragraph\n';
  await render(exec, IMGDOC, "full");
  await exec(TAG_ALL);
  await render(exec, IMGDOC.replace("intro paragraph", "intro paragraph edited"), "full");
  const imgs = JSON.parse(
    await exec(`
      (() => {
        const tops = ${TOP_BLOCKS};
        const wrapped = tops.filter(el => el.querySelector && el.querySelector('img'));
        return JSON.stringify({
          imgBlocks: wrapped.length,
          imgKept: wrapped.filter(el => el.__probeTag !== undefined).length,
          tailKept: tops.filter(el => el.__probeTag !== undefined &&
            el.textContent.trim() === 'tail paragraph').length
        });
      })()
    `),
  );
  check("an untouched top-level image block is reused when an unrelated block changes", imgs.imgBlocks === 1 && imgs.imgKept === 1, JSON.stringify(imgs));
  check("the block after the image is reused too", imgs.tailKept === 1, JSON.stringify(imgs));

  // ---------------------------------------------------------------------
  // 15. Collapsed state must not leak between documents.
  //     Slug ids are content-derived, so two different files that both
  //     contain "# Setup" produce the same id. With a bare id key, collapsing
  //     that section in one tab collapsed it in the other - a direct
  //     consequence of moving off positional ids, and exactly the multi-tab
  //     case this app is built around. Reverting _collapseKey() to the raw
  //     header id makes docB.collapsedInB true.
  // ---------------------------------------------------------------------
  const DOC_A = "# Setup\n\nalpha body for document A\n\n# Other\n\ntail\n";
  const DOC_B = "# Setup\n\nbeta body for document B\n\n# Different\n\ntail\n";

  await exec(`window.currentFilePath = 'C:/docs/A.md'; null`);
  await render(exec, DOC_A, "full");
  await exec(`document.getElementById('setup') && document.getElementById('setup').click(); null`);
  const collapsedInA = await exec(`!!(document.getElementById('setup') || {}).classList && document.getElementById('setup').classList.contains('collapsed')`);

  await exec(`window.currentFilePath = 'C:/docs/B.md'; null`);
  await render(exec, DOC_B, "full");
  const collapsedInB = await exec(`!!(document.getElementById('setup') || {}).classList && document.getElementById('setup').classList.contains('collapsed')`);

  await exec(`window.currentFilePath = 'C:/docs/A.md'; null`);
  await render(exec, DOC_A, "full");
  const backInA = await exec(`!!(document.getElementById('setup') || {}).classList && document.getElementById('setup').classList.contains('collapsed')`);

  check("collapsing a heading in one document actually collapses it", collapsedInA === true, String(collapsedInA));
  check("a same-named heading in a DIFFERENT document is not collapsed too", collapsedInB === false, String(collapsedInB));
  check("returning to the first document restores its own collapsed state", backInA === true, String(backInA));
  await exec(`window.currentFilePath = null; null`);

  const noErrors = await exec(`JSON.stringify(window.__testErrors || [])`);
  check("no uncaught renderer errors", noErrors === "[]", noErrors);

  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  // ---------------------------------------------------------------------
  // Theme submenu selected-state. The Theme submenu shares the .tools-submenu
  // CSS family with the language menu that was removed, so it is pinned here
  // to prove the removal did not take its styling with it.
  //
  // The oracle deliberately measures the mechanism that ACTUALLY marks the
  // selection - the ::before checkmark and the icon opacity, both in
  // custom-styles.css - rather than colour or font-weight. Sampling the wrong
  // properties reports "no indicator" on a menu that is visibly ticked, which
  // is precisely the proxy-measurement error this project keeps re-learning.
  // ---------------------------------------------------------------------
  const themeState = await exec(`(() => {
    document.getElementById('viewBtn').click();
    const item = document.getElementById('customThemeMenuItem');
    if (item) item.classList.add('theme-open');
    const opts = [...document.querySelectorAll('.custom-theme-option')];
    const active = opts.find(o => o.classList.contains('active'));
    const inactive = opts.find(o => !o.classList.contains('active'));
    if (!active || !inactive) return JSON.stringify({ error: 'options missing', count: opts.length });
    const mark = (el) => getComputedStyle(el, '::before').content;
    const icon = (el) => {
      const i = el.querySelector('.theme-icon');
      return i ? getComputedStyle(i).opacity : null;
    };
    const sub = getComputedStyle(document.getElementById('customThemeSubmenu'));
    return JSON.stringify({
      count: opts.length,
      activeMode: active.dataset.mode,
      activeMark: mark(active),
      inactiveMark: mark(inactive),
      activeIconOpacity: icon(active),
      inactiveIconOpacity: icon(inactive),
      submenuDisplay: sub.display,
      submenuPosition: sub.position,
      submenuBackground: sub.backgroundColor,
      submenuZ: sub.zIndex,
    });
  })()`);
  const theme = JSON.parse(themeState);
  check(
    "the Theme submenu still offers all three modes after the language menu was removed",
    theme.count === 3,
    themeState,
  );
  check(
    "the Theme submenu still floats over the menu - the shared .tools-submenu rule survived",
    theme.submenuDisplay === "block" &&
      theme.submenuPosition === "absolute" &&
      theme.submenuZ === "1001" &&
      !/rgba\(0, 0, 0, 0\)/.test(theme.submenuBackground),
    themeState,
  );
  check(
    "the selected theme carries a checkmark the unselected ones do not",
    /\u2713/.test(theme.activeMark) && !/\u2713/.test(theme.inactiveMark),
    themeState,
  );
  check(
    "the selected theme's icon is emphasised relative to the unselected ones",
    theme.activeIconOpacity !== null &&
      parseFloat(theme.activeIconOpacity) > parseFloat(theme.inactiveIconOpacity),
    themeState,
  );

  // ---------------------------------------------------------------------
  // Edit Text: locating a DOM selection that spans markdown markers
  //
  // The reader selects RENDERED text. When that selection crosses inline
  // formatting, the string it yields does not exist anywhere in the source -
  // "one two three" is nowhere in `one *two* three` - so the exact search the
  // save path used simply failed and the edit was refused with "text not
  // found". Ported from upstream ef81474.
  //
  // Tested against the real renderer function rather than a copy, table-driven
  // because the interesting behaviour is entirely about index arithmetic and
  // every row is a boundary someone could get wrong. Each row states the source
  // it EXPECTS to be replaced, so a wrong offset shows up as the wrong text
  // rather than as a number nobody can interpret.
  // ---------------------------------------------------------------------
  {
    const rows = [
      // [label, source, selection, occurrence, expected replaced substring]
      ["plain text with no formatting at all", "one two three", "two", 0, "two"],
      ["an exact match is preferred over the projection", "a *b* a b", "a", 0, "a"],
      ["the occurrence index still selects the right exact match", "cat dog cat", "cat", 1, "cat"],
      ["a selection spanning an italic span", "one *two* three", "one two three", 0, "one *two* three"],
      ["a selection spanning bold", "say **loud** now", "say loud now", 0, "say **loud** now"],
      ["a selection spanning a code span", "run `cmd` now", "run cmd now", 0, "run `cmd` now"],
      ["a selection spanning a strikethrough", "was ~~old~~ new", "was old new", 0, "was ~~old~~ new"],
      ["a selection spanning an underscore span", "an _em_ word", "an em word", 0, "an _em_ word"],
      ["formatting in the middle, plain text on both sides", "one *two* three four", "one two three", 0, "one *two* three"],
      // The correction over upstream. The selection begins AFTER the opening
      // marker, so a range that starts at the letter leaves that marker
      // stranded: upstream produced `*newText`, which is not valid markdown and
      // silently italicises the rest of the document.
      ["a selection starting inside a span takes its opening marker too", "*hello* world", "hello world", 0, "*hello* world"],
      ["a selection ending inside a span takes its closing marker too", "one *two* three", "two three", 0, "*two* three"],
      ["text that is genuinely absent is reported as absent", "one two three", "nowhere", 0, null],
      // A LIMITATION, pinned deliberately rather than left as an omission.
      // GPT-5.4's review of this port found it. The projection strips `*_`~`
      // everywhere, including where those characters are literal CONTENT
      // inside a code span, so the rendered text still contains a character
      // the projection has removed and no match is possible.
      //
      // Measured against the pre-6e1 code: `findNthOccurrence` returned -1 for
      // these too, so this is an UNFIXED case, not a regression - 6e1 turns
      // four previously-unfindable cases into found ones and breaks none. The
      // property that matters is that it degrades to "not found", which leaves
      // the document untouched, rather than guessing a span and silently
      // corrupting it.
      ["literal markers inside a code span are not found - safely, not wrongly", "use `snake_case` now", "use snake_case now", 0, null],
      ["a literal asterisk inside a code span is not found - safely, not wrongly", "run `a*b` now", "run a*b now", 0, null],
    ];

    const found = await exec(`
      (() => (${JSON.stringify(rows)}).map(([label, source, sel, occ]) => {
        const r = findPlainTextInSource(source, sel, occ);
        return r === null ? null : source.substr(r.index, r.length);
      }))()
    `);

    rows.forEach(([label, source, sel, occ, expected], i) => {
      check(
        `Edit Text finds the source for: ${label}`,
        found[i] === expected,
        `source=${JSON.stringify(source)} selection=${JSON.stringify(sel)} expected=${JSON.stringify(expected)} got=${JSON.stringify(found[i])}`,
      );
    });

    // Vacuity guard. Every row above asserts on the value of a replaced
    // substring, so a function that always returned null would fail loudly -
    // but a function that was never CALLED (renamed, or not yet defined at this
    // point in the file) would throw and take the suite down instead of
    // reporting. Prove the symbol is the real one.
    check(
      "Edit Text's source locator is a real renderer function, not a test copy",
      (await exec(`typeof findPlainTextInSource === 'function' && findPlainTextInSource.length === 3`)) === true,
      "findPlainTextInSource must be defined in renderer.js and take (source, plainText, occurrence)",
    );

    // The whole point of replacing a WIDER span than the reader selected is
    // that what is left behind is still valid markdown. Assert that directly,
    // on the case that used to break, rather than trusting the offsets above.
    const balanced = await exec(`
      (() => {
        const src = '*hello* world';
        const r = findPlainTextInSource(src, 'hello world', 0);
        if (!r) return 'not found';
        const out = src.substring(0, r.index) + 'REPLACED' + src.substring(r.index + r.length);
        return out;
      })()
    `);
    check(
      "replacing a selection that spans formatting leaves no unbalanced marker",
      balanced === "REPLACED" && !/[*_\`~]/.test(balanced),
      `result=${JSON.stringify(balanced)}`,
    );
  }

  // ---------------------------------------------------------------------
  // Edit Text end to end, through the real dialog.
  //
  // The table above measures the locator in isolation. This drives the actual
  // product path - set the saved selection, open the dialog, type, click Save -
  // because the guard added alongside the locator lives in the SAVE handler,
  // not in the locator: partialDOMReplace rewrites one text node in place, so
  // it is only valid when the source matched exactly. A match that spanned
  // formatting covers more source than the node holds, and letting the fast
  // path take it would leave the DOM saying one thing and the source another -
  // a divergence that survives until the next full render and then silently
  // reverts the reader's edit.
  // ---------------------------------------------------------------------
  {
    const editTextEndToEnd = async (source, selection, replacement) => {
      await exec(`
        (async () => {
          isEditMode = false;
          originalMarkdown = ${JSON.stringify(source)};
          await renderMarkdown(${JSON.stringify(source)});
          savedSelection = ${JSON.stringify(selection)};
          savedSelectionOccurrence = 0;
          openEditTextDialog();
          editTextArea.value = ${JSON.stringify(replacement)};
          editTextSaveBtn.click();
          return true;
        })()
      `);
      await waitFor(exec, "the edited document to settle", RENDER_SETTLED);
      return exec(`({
        source: originalMarkdown,
        text: viewer.textContent.replace(/\\s+/g, ' ').trim(),
        dialogOpen: editTextOverlay.classList.contains('visible'),
      })`);
    };

    // The case that could not be edited at all before this port: the selection
    // is real on screen but appears nowhere in the source.
    const spanned = await editTextEndToEnd("one *two* three", "one two three", "REPLACED");
    check(
      "editing a selection that spans formatting rewrites the source",
      spanned.source === "REPLACED",
      JSON.stringify(spanned),
    );
    check(
      "editing a selection that spans formatting leaves the document readable",
      spanned.text === "REPLACED",
      JSON.stringify(spanned),
    );
    check(
      "the rendered document and the source agree after a spanning edit",
      spanned.text === spanned.source,
      `source=${JSON.stringify(spanned.source)} rendered=${JSON.stringify(spanned.text)}`,
    );
    check(
      "the Edit Text dialog closes after a spanning edit",
      spanned.dialogOpen === false,
      JSON.stringify(spanned),
    );

    // The ordinary case must keep working - this path is shared, and the fast
    // partial-DOM route is the one it takes.
    const plain = await editTextEndToEnd("alpha bravo charlie", "bravo", "DELTA");
    check(
      "editing a selection that needs no projection still works",
      plain.source === "alpha DELTA charlie" && plain.text === "alpha DELTA charlie",
      JSON.stringify(plain),
    );
  }

  // ---------------------------------------------------------------------
  // View-mode editing: the context menu is gated, and notes persist.
  //
  // The reader could reach a dozen editing actions from the viewer's own
  // context menu while in view mode, and NONE of them could reach the disk:
  // saveMarkdownFile() is only bound to a button inside the hidden editor
  // panel and to a Ctrl+S gated on isEditMode. Every one of those edits was
  // therefore discarded by the next reload, with no warning and no indicator.
  //
  // The decision (user's) was to split the surface rather than wire a
  // view-mode Save to all of it: notes stay, and auto-save; everything else
  // becomes edit-mode only, where the viewer is still on screen in split
  // view so no capability is actually lost.
  //
  // These assertions are on OBSERVED VISIBILITY and on DISK BYTES, never on
  // the isEditMode flag or on the gating function's own return value.
  //
  // A REAL file is opened first and left open for both blocks. That is not
  // scene-setting: several of these menu items are additionally gated on
  // `currentFilePath`, so probing them with no file open reports them hidden
  // for a reason that has nothing to do with the mode and would have made the
  // gating assertions agree with a broken implementation.
  // ---------------------------------------------------------------------
  const notePath = path.join(dir, "notes-autosave.md");
  {
    fs.writeFileSync(notePath, "# Notes\n\npick me up\n", "utf8");
  }

  const openNoteFileForReal = async () => {
    await exec(`ipcRenderer.send('open-file-path', ${JSON.stringify(notePath)}); null`);
    await waitFor(
      exec,
      "the file to open for real",
      `currentFilePath === ${JSON.stringify(notePath)} && originalMarkdown.indexOf('pick me up') !== -1`,
    );
    await waitFor(exec, "the opened document to settle", RENDER_SETTLED);
  };

  // Reading a file while the main process is truncating it for a rewrite
  // returns "" - which is not an assertion failure, it is a torn read. Poll
  // for a settled state rather than sampling once.
  const readWhenSettled = async (predicate) => {
    const started = Date.now();
    let text = "";
    while (Date.now() - started < 15000) {
      try {
        text = fs.readFileSync(notePath, "utf8");
      } catch (e) {
        text = "";
      }
      if (text.length > 0 && predicate(text)) return text;
      await sleep(100);
    }
    return text;
  };

  await openNoteFileForReal();

  {
    const menuState = await exec(`
      (async () => {
        const ids = ['ctxBold','ctxItalic','ctxCode','ctxList','ctxRemoveFormat',
                     'ctxEditText','ctxInsertImage','ctxDeleteImage',
                     'ctxInsertMermaid','ctxEditMermaid','ctxDeleteMermaid',
                     'ctxInsertTable','ctxEditTable','ctxDeleteTable',
                     'ctxCopy','ctxCopyPlain','ctxAddNote','ctxEditNote',
                     'ctxDeleteNote','ctxFindNote','ctxSelectAll'];

        const shown = () => {
          const o = {};
          ids.forEach(id => {
            const el = document.getElementById(id);
            o[id] = !!(el && el.offsetParent !== null);
          });
          return o;
        };

        // Separator hygiene, read off the LIVE menu rather than the markup:
        // no leading separator, no two visible in a row, none trailing.
        const separators = () => {
          const kids = Array.from(contextMenu.children);
          const seq = kids
            .filter(el => el.offsetParent !== null || el.classList.contains('context-menu-separator'))
            .filter(el => getComputedStyle(el).display !== 'none')
            .map(el => el.classList.contains('context-menu-separator') ? 'sep' : 'item');
          let bad = 0;
          if (seq[0] === 'sep') bad++;
          if (seq[seq.length - 1] === 'sep') bad++;
          for (let i = 1; i < seq.length; i++) if (seq[i] === 'sep' && seq[i - 1] === 'sep') bad++;
          return { bad, seq: seq.join(',') };
        };

        // A real right-click on a real element, so the click-target branches
        // run for real and the gating pass has something to override.
        const rightClick = (el) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + Math.min(8, r.height / 2)),
          }));
        };

        const src = '# Doc\\n\\npick me up\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |\\n';
        const savedSource = originalMarkdown;
        originalMarkdown = src;
        isEditMode = false;
        await renderMarkdown(src);

        const para = Array.from(viewer.querySelectorAll('p'))
          .find(p => p.textContent.includes('pick me up'));
        const cell = viewer.querySelector('table td');
        if (!para || !cell) return { err: 'sample document did not render', para: !!para, cell: !!cell };

        // A selection, so the formatting items are not merely disabled for
        // want of one - that would make the gating assertion vacuous.
        const select = (el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        };

        select(para);
        rightClick(para);
        const viewPara = shown();
        const viewSeps = separators();

        rightClick(cell);
        const viewCell = shown();

        isEditMode = true;
        select(para);
        rightClick(para);
        const editPara = shown();

        rightClick(cell);
        const editCell = shown();

        isEditMode = false;
        hideContextMenu();
        window.getSelection().removeAllRanges();

        // Put the real document back. Leaving the store on this sample while
        // currentFilePath still points at the opened file is exactly the kind
        // of desync that later auto-saves the wrong bytes over a real file -
        // which is what happened the first time this ran.
        originalMarkdown = savedSource;
        await renderMarkdown(savedSource);

        return { viewPara, viewCell, editPara, editCell, viewSeps };
      })()
    `);

    check(
      "the view-mode context-menu probe rendered its sample document",
      !menuState.err,
      JSON.stringify(menuState),
    );

    const EDIT_ONLY = ['ctxBold','ctxItalic','ctxCode','ctxList','ctxRemoveFormat',
                       'ctxEditText','ctxInsertImage','ctxInsertMermaid','ctxInsertTable'];

    check(
      "no document-editing item is offered in view mode",
      EDIT_ONLY.every(id => menuState.viewPara[id] === false),
      JSON.stringify(menuState.viewPara),
    );

    check(
      "table edit and delete are not offered on a table in view mode",
      menuState.viewCell.ctxEditTable === false && menuState.viewCell.ctxDeleteTable === false,
      JSON.stringify(menuState.viewCell),
    );

    // Notes are the deliberate exception. If this fails the gating has taken
    // the one feature it was supposed to keep.
    check(
      "notes stay reachable in view mode",
      menuState.viewPara.ctxAddNote === true && menuState.viewPara.ctxFindNote === true,
      JSON.stringify(menuState.viewPara),
    );

    check(
      "the read-only items are untouched in view mode",
      menuState.viewPara.ctxCopy === true && menuState.viewPara.ctxCopyPlain === true
        && menuState.viewPara.ctxSelectAll === true,
      JSON.stringify(menuState.viewPara),
    );

    // THE REVERSIBILITY ASSERTION, and it is not hypothetical: the first
    // version of this gating only ever SET display:none, so the formatting
    // items - which no other code gives a display to - stayed hidden forever
    // once view mode had hidden them once. Entering edit mode has to bring
    // them back.
    check(
      "entering edit mode restores every editing item the gating hid",
      EDIT_ONLY.every(id => menuState.editPara[id] === true),
      JSON.stringify(menuState.editPara),
    );

    check(
      "table edit and delete come back on a table in edit mode",
      menuState.editCell.ctxEditTable === true && menuState.editCell.ctxDeleteTable === true,
      JSON.stringify(menuState.editCell),
    );

    // The other half of the target-decided rule: gating must not RESTORE an
    // item whose click target does not justify it.
    check(
      "edit mode does not offer table edit on a paragraph",
      menuState.editPara.ctxEditTable === false && menuState.editPara.ctxDeleteTable === false,
      JSON.stringify(menuState.editPara),
    );

    check(
      "hiding a run of items leaves no stray separator behind",
      menuState.viewSeps && menuState.viewSeps.bad === 0,
      JSON.stringify(menuState.viewSeps),
    );
  }

  // ---------------------------------------------------------------------
  // Notes auto-save in view mode - measured on DISK, through the real file.
  //
  // The oracle is deliberately the file itself, read by the harness process
  // rather than by the renderer: the renderer's own idea of what it saved is
  // exactly the thing that was wrong before, so asking it would prove nothing.
  // ---------------------------------------------------------------------
  {
    await waitFor(exec, "the restored document to settle", RENDER_SETTLED);
    await exec(`isEditMode = false; null`);

    // Drive the real dialog: select the rendered text, open Add Note, type,
    // click Save. No product function is called directly.
    const addNoteInViewMode = async (title, body) => exec(`
      (async () => {
        const para = Array.from(viewer.querySelectorAll('p'))
          .find(p => p.textContent.includes('pick me up'));
        if (!para) return 'paragraph missing';
        savedSelection = 'pick me up';
        savedSelectionOccurrence = 0;
        rightClickTarget = para;
        openNoteDialog();
        noteTitleInput.value = ${JSON.stringify(title)};
        noteContentInput.value = ${JSON.stringify(body)};
        noteSaveBtn.click();
        return 'ok';
      })()
    `);

    const diskHas = (needle) => readWhenSettled((t) => t.includes(needle));

    // Vacuity guard: the note must not already be on disk, or "it is on disk
    // afterwards" measures nothing. Also proves the menu probe above put the
    // real document back rather than leaving its own sample in the store.
    const seeded = await readWhenSettled(() => true);
    check(
      "the note file starts without the note, holding the document that is open",
      seeded.indexOf("AUTOSAVED") === -1 && seeded.includes("# Notes"),
      JSON.stringify(seeded),
    );
    check(
      "the store and the file agree before the first note is added",
      (await exec(`originalMarkdown`)) === seeded,
      JSON.stringify({ store: await exec(`originalMarkdown`), disk: seeded }),
    );

    const added = await addNoteInViewMode("AUTOSAVED", "added in view mode");
    check("the Add Note dialog reached its Save button", added === "ok", String(added));

    const afterAdd = await diskHas("AUTOSAVED");
    check(
      "a note added in view mode is written to disk without any save action",
      afterAdd.includes("AUTOSAVED") && afterAdd.includes('class="noted-text"'),
      JSON.stringify(afterAdd),
    );

    // A write that leaves the document looking dirty is only half a fix - the
    // next Exit or refresh would still warn about changes that are on disk.
    const cleanAfterAdd = await waitFor(
      exec,
      "the unsaved indicator to clear after the auto-save",
      `(hasUnsavedChanges === false && unsavedIndicator.style.display === 'none') ? 'clean' : false`,
      15000,
    ).catch((e) => String(e && e.message));
    check(
      "the document is not left looking unsaved after a note auto-save",
      cleanAfterAdd === "clean",
      String(cleanAfterAdd),
    );

    // The user's ORIGINAL complaint in a new disguise: the tab layer caches
    // per-tab content, so a write that does not reach that cache reverts on
    // the next tab switch. custom-tabs re-reads from disk on save success,
    // which only happens because the note now goes through saveMarkdownFile().
    const tabCache = await exec(`
      (() => {
        if (!window.CustomTabs || !CustomTabs.getTabs) return 'no tab layer';
        const t = CustomTabs.getTabs().find(t => t.filePath === ${JSON.stringify(notePath)});
        if (!t) return 'tab not found';
        return {
          cached: (t.content || '').includes('AUTOSAVED'),
          // originalContent is the on-disk baseline the tab layer diffs against
          // to decide dirtiness. If content carries the note but originalContent
          // does not, the tab is permanently and wrongly dirty and the next
          // switch offers to discard a note that IS on disk.
          baseline: (t.originalContent || '').includes('AUTOSAVED'),
          dirty: !!t.hasUnsavedChanges,
        };
      })()
    `);
    check(
      "the tab cache holds the auto-saved note, so a tab switch cannot revert it",
      tabCache === 'no tab layer' || tabCache === 'tab not found'
        ? false
        : (tabCache.cached === true && tabCache.baseline === true && tabCache.dirty === false),
      JSON.stringify(tabCache),
    );

    // Edit an existing note. This path hand-rolls its own store update and
    // never went through commitViewModeEdit(), so it needed wiring separately.
    const edited = await exec(`
      (async () => {
        const noteEl = viewer.querySelector('.noted-text');
        if (!noteEl) return 'note element missing';
        rightClickTarget = noteEl;
        openNoteDialogForEdit(noteEl);
        noteTitleInput.value = 'REEDITED';
        noteContentInput.value = 'changed in view mode';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    check("the Edit Note dialog reached its Save button", edited === "ok", String(edited));

    const afterEdit = await diskHas("REEDITED");
    check(
      "editing a note in view mode is written to disk",
      afterEdit.includes("REEDITED") && !afterEdit.includes("AUTOSAVED"),
      JSON.stringify(afterEdit),
    );

    // Delete it again, through the real context-menu handler.
    const deleted = await exec(`
      (async () => {
        const noteEl = viewer.querySelector('.noted-text');
        if (!noteEl) return 'note element missing';
        rightClickTarget = noteEl;
        ctxDeleteNote.click();
        return 'ok';
      })()
    `);
    check("the Delete Note handler ran", deleted === "ok", String(deleted));

    const afterDelete = await readWhenSettled((t) => !t.includes("REEDITED"));
    check(
      "deleting a note in view mode is written to disk",
      !afterDelete.includes("REEDITED") && afterDelete.includes("pick me up"),
      JSON.stringify(afterDelete),
    );

    // THE NON-REGRESSION. Edit mode keeps explicit-save semantics: a note
    // added there must NOT reach the disk on its own, or the auto-save has
    // quietly turned the whole editor into an autosaving one.
    //
    // The edit-mode branch of Add Note reads the TEXTAREA's own selection, not
    // `savedSelection` - the two halves of this feature take their input from
    // different places - so the selection has to be made there for this leg to
    // exercise anything.
    const beforeEditMode = await readWhenSettled(() => true);
    const editModeAdd = await exec(`
      (async () => {
        isEditMode = true;
        markdownEditor.value = originalMarkdown;
        const at = markdownEditor.value.indexOf('pick me up');
        if (at === -1) return 'anchor text missing from the editor';
        markdownEditor.focus();
        markdownEditor.selectionStart = at;
        markdownEditor.selectionEnd = at + 'pick me up'.length;
        savedSelection = 'pick me up';
        savedSelectionOccurrence = 0;
        rightClickTarget = null;
        openNoteDialog();
        noteTitleInput.value = 'EDITMODEONLY';
        noteContentInput.value = 'must not auto-save';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    check("the edit-mode Add Note dialog reached its Save button", editModeAdd === "ok", String(editModeAdd));

    await sleep(1500);
    const afterEditMode = fs.readFileSync(notePath, "utf8");
    check(
      "a note added in edit mode is NOT auto-saved",
      !afterEditMode.includes("EDITMODEONLY") && afterEditMode === beforeEditMode,
      JSON.stringify(afterEditMode),
    );
    // ...and it really was added, so the assertion above is about the WRITE
    // and not about the note having failed to happen at all.
    check(
      "the edit-mode note really was added, in memory",
      (await exec(`markdownEditor.value.includes('EDITMODEONLY')`)) === true,
      await exec(`markdownEditor.value`),
    );
    // The dirty state has to survive too: an unsaved edit-mode note that
    // reports itself clean would be lost by the next exit without a warning.
    check(
      "an unsaved edit-mode note leaves the document marked dirty",
      (await exec(`hasUnsavedChanges === true && unsavedIndicator.style.display === 'inline'`)) === true,
      await exec(`JSON.stringify({dirty: hasUnsavedChanges, indicator: unsavedIndicator.style.display})`),
    );

    // The assertion above passes STRUCTURALLY - the edit-mode branch of Add
    // Note simply has no auto-save call in it - so on its own it says nothing
    // about the mode guard inside autoSaveViewModeNote(). That guard is the
    // function's CONTRACT, and it is what protects the explicit-save behaviour
    // if a future note path is wired up without noticing the distinction, so
    // it is worth pinning directly rather than deleting as unreachable.
    // Measured on disk, with a document that is genuinely dirty, so a write
    // would be both possible and visible.
    const guardDisk = await readWhenSettled(() => true);
    // Captured BEFORE the call. Reading it afterwards measures the aftermath,
    // not the precondition: with the guard removed the write succeeds, the
    // reply clears the dirty flag, and the vacuity guard destroys itself.
    const guardPrecondition = await exec(
      `JSON.stringify({dirty: hasUnsavedChanges, diverged: markdownEditor.value !== originalMarkdown})`,
    );
    const guardReturn = await exec(`autoSaveViewModeNote()`);
    await sleep(1200);
    check(
      "the guarded document really did have unsaved content to write",
      JSON.parse(guardPrecondition).dirty === true || JSON.parse(guardPrecondition).diverged === true,
      guardPrecondition,
    );
    check(
      "autoSaveViewModeNote() refuses to write while edit mode is on",
      guardReturn === false,
      `returned ${JSON.stringify(guardReturn)} with isEditMode=${await exec(`isEditMode`)}`,
    );
    check(
      "nothing reached the disk when the edit-mode guard refused",
      (await readWhenSettled(() => true)) === guardDisk,
      JSON.stringify({ before: guardDisk, after: await readWhenSettled(() => true) }),
    );

    await exec(`
      isEditMode = false;
      hasUnsavedChanges = false;
      updateUnsavedIndicator();
      markdownEditor.value = originalMarkdown;
      null
    `);
  }

  // The four note branches the first pass wired but never drove, plus the two
  // mutation paths that the context-menu gate does not cover. Every one of
  // these was raised by an independent reviewer against the first version of
  // this change: three of the seven auto-save call sites had no probe reaching
  // them at all, so removing the write from any of them left the suite green.
  {
    const openFresh = async (file, body) => {
      const p = path.join(dir, file);
      fs.writeFileSync(p, body, "utf8");
      await exec(`ipcRenderer.send('open-file-path', ${JSON.stringify(p)}); null`);
      await waitFor(
        exec,
        `${file} to become the open document`,
        `(currentFilePath === ${JSON.stringify(p)} && originalMarkdown === ${JSON.stringify(body)}) ? 'ok' : false`,
        20000,
      );
      return p;
    };
    // Torn reads are real: main.js truncates before it rewrites, so a poll that
    // lands mid-write returns "".
    const settle = async (p, predicate) => {
      const deadline = Date.now() + 15000;
      let text = "";
      while (Date.now() < deadline) {
        try {
          text = fs.readFileSync(p, "utf8");
        } catch { text = ""; }
        if (text.length > 0 && predicate(text)) return text;
        await sleep(120);
      }
      return text;
    };

    // A src that 404s paints a broken-image icon, which the error sentinel
    // fails the run for - quite rightly. Copying a real PNG in means the note
    // is attached to an image that actually painted, which is the stronger
    // measurement anyway.
    const realPng = path.join(__dirname, "app-icon.png");
    for (const name of ["pic.png", "raw.png"]) {
      try {
        fs.copyFileSync(realPng, path.join(dir, name));
      } catch {
        // 1x1 transparent PNG, so the probe still has something that loads.
        fs.writeFileSync(
          path.join(dir, name),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
      }
    }

    // ---- 1. A note on a MARKDOWN image ----
    const imgPath = await openFresh("note-on-image.md", "# Img\n\n![pic](pic.png)\n");
    const imgAdd = await exec(`
      (async () => {
        const img = viewer.querySelector('img');
        if (!img) return 'no img element';
        savedSelection = null;
        rightClickTarget = img;
        editingNoteElement = null;
        openNoteDialog();
        noteTitleInput.value = 'IMGNOTE';
        noteContentInput.value = 'note on a markdown image';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    check("the Add Note dialog ran against a markdown image", imgAdd === "ok", String(imgAdd));
    const imgDisk = await settle(imgPath, (t) => t.includes("IMGNOTE"));
    check(
      "a note on a markdown image is written to disk in view mode",
      imgDisk.includes("IMGNOTE") && imgDisk.includes("noted-image") && !imgDisk.includes("![pic]"),
      JSON.stringify(imgDisk),
    );

    // ---- 2. A note on a RAW <img>, which is a different branch: the markdown
    // image lookup misses and a regex fallback does the replacement. ----
    const rawPath = await openFresh("note-on-rawimg.md", '# Raw\n\n<img src="raw.png" alt="r">\n');
    const rawAdd = await exec(`
      (async () => {
        const img = viewer.querySelector('img');
        if (!img) return 'no img element';
        savedSelection = null;
        rightClickTarget = img;
        editingNoteElement = null;
        openNoteDialog();
        noteTitleInput.value = 'RAWNOTE';
        noteContentInput.value = 'note on a raw img tag';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    check("the Add Note dialog ran against a raw <img>", rawAdd === "ok", String(rawAdd));
    const rawDisk = await settle(rawPath, (t) => t.includes("RAWNOTE"));
    check(
      "a note on a raw <img> is written to disk in view mode",
      rawDisk.includes("RAWNOTE") && rawDisk.includes("noted-image"),
      JSON.stringify(rawDisk),
    );

    // ---- 3. A LABEL BADGE, the no-selection branch ----
    const labelPath = await openFresh("note-label.md", "# Label\n\nplain body\n");
    const labelAdd = await exec(`
      (async () => {
        savedSelection = null;
        rightClickTarget = viewer.querySelector('p');
        editingNoteElement = null;
        rightClickLabelPos = { left: 40, top: 60 };
        openNoteDialog();
        noteTitleInput.value = 'BADGETITLE';
        noteContentInput.value = 'badge body';
        noteLabelInput.value = 'BADGE';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    check("the Add Note dialog ran with no selection", labelAdd === "ok", String(labelAdd));
    const labelDisk = await settle(labelPath, (t) => t.includes("BADGE"));
    check(
      "a label badge added in view mode is written to disk",
      labelDisk.includes("note-label") && labelDisk.includes("BADGE"),
      JSON.stringify(labelDisk),
    );

    // ---- 4. Delete through the NOTES PANEL, which is a separate hand-rolled
    // implementation from the viewer's own Delete Note. ----
    const panelDeleted = await exec(`
      (async () => {
        const el = viewer.querySelector('.note-label');
        if (!el) return 'no note element';
        const nid = el.getAttribute('data-note-id');
        if (!nid) return 'note has no id';
        notesPanelContextNoteId = nid;
        ctxNotesPanelDelete.click();
        return 'ok';
      })()
    `);
    check("the notes-panel Delete handler ran", panelDeleted === "ok", String(panelDeleted));
    const panelDisk = await settle(labelPath, (t) => !t.includes("BADGE"));
    check(
      "deleting a note from the NOTES PANEL is written to disk in view mode",
      !panelDisk.includes("BADGE") && panelDisk.includes("plain body"),
      JSON.stringify(panelDisk),
    );

    // ---- 5. Undo/redo is edit-mode only ----
    // Both reviewers found this independently. In view mode historyUndo()
    // reassigned originalMarkdown without marking the document dirty, so the
    // store silently diverged from the file - and once notes auto-save, the
    // NEXT note writes that reverted document out, destroying every note saved
    // before it. Measured on the store AND on disk, after a real keystroke.
    const undoPath = await openFresh("note-undo.md", "# Undo\n\nundo body\n");
    await exec(`
      (async () => {
        savedSelection = 'undo body';
        savedSelectionOccurrence = 0;
        rightClickTarget = viewer.querySelector('p');
        editingNoteElement = null;
        openNoteDialog();
        noteTitleInput.value = 'KEEPME';
        noteContentInput.value = 'must survive undo';
        noteSaveBtn.click();
        return 'ok';
      })()
    `);
    const undoSeeded = await settle(undoPath, (t) => t.includes("KEEPME"));
    check(
      "a note exists on disk before the undo keystroke, so the probe can measure a loss",
      undoSeeded.includes("KEEPME"),
      JSON.stringify(undoSeeded),
    );
    const storeBeforeUndo = await exec(`originalMarkdown`);
    await exec(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      null
    `);
    await sleep(600);
    check(
      "Ctrl+Z does not alter the document in view mode",
      (await exec(`originalMarkdown`)) === storeBeforeUndo,
      JSON.stringify({ before: storeBeforeUndo, after: await exec(`originalMarkdown`) }),
    );
    // Divergence is the actual defect, so the comparison has to be between the
    // file and the store AS IT IS NOW. Comparing the file to the PRE-undo
    // store cannot detect it: the file is unchanged either way, so that pair
    // matches precisely when the store has silently moved out from under it.
    const storeAfterUndo = await exec(`originalMarkdown`);
    check(
      "the store and the file still agree after a view-mode Ctrl+Z",
      (await settle(undoPath, () => true)) === storeAfterUndo,
      JSON.stringify({ disk: await settle(undoPath, () => true), store: storeAfterUndo }),
    );
    // The gate must not have cost edit mode its undo.
    const editUndo = await exec(`
      (async () => {
        isEditMode = true;
        markdownEditor.value = originalMarkdown;
        hasUnsavedChanges = false;
        historyPush(markdownEditor.value);
        markdownEditor.value = markdownEditor.value + '\\nTYPED\\n';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        return markdownEditor.value.includes('TYPED');
      })()
    `);
    check("Ctrl+Z still undoes in edit mode", editUndo === false, String(editUndo));
    await exec(`
      isEditMode = false;
      hasUnsavedChanges = false;
      failedSaves.clear();
      updateUnsavedIndicator();
      historyClear();
      null
    `);

    // ---- 6. A FAILED auto-save must not leave the note quietly discardable ----
    // View mode has no retry: Ctrl+S is edit-mode only and the Save button
    // lives in the editor panel. So a failed write has to keep the document
    // dirty AND carry that dirty state into edit mode, which is where the
    // retry lives. alert/confirm are stubbed because a real modal here would
    // hang the harness forever.
    const failPath = await openFresh("note-failsave.md", "# Fail\n\nfail body\n");
    // A deliberate negative test: the save is MEANT to fail, so the console
    // error it produces is a result, not a finding. mute() is the harness's
    // sanctioned way to say so, and it records the window for review rather
    // than silently widening what the sentinel ignores.
    await sentinel.mute("view-mode auto-save failure recovery: EISDIR is provoked on purpose");
    const failState = await exec(`
      (async () => {
        const realAlert = window.alert, realConfirm = window.confirm;
        window.alert = () => {}; window.confirm = () => true;
        const restore = () => { window.alert = realAlert; window.confirm = realConfirm; };
        const good = currentFilePath;
        // A directory is a real, reproducible write failure (EISDIR).
        currentFilePath = ${JSON.stringify(dir)};
        originalMarkdown = originalMarkdown + '\\n<span class="note-label" data-note-id="9" data-note-title="LOST" data-note-content="x" style="background-color:#f00">LOST</span>\\n';
        hasUnsavedChanges = true;
        updateUnsavedIndicator();
        const wrote = autoSaveViewModeNote();
        await new Promise(r => setTimeout(r, 2500));
        const afterFail = {
          wrote,
          failed: saveFailedFor(currentFilePath),
          dirty: hasUnsavedChanges,
          guarded: hasUnsavedWork(),
        };
        toggleEditBtn.click();
        for (let i = 0; i < 60 && !isEditMode; i++) await new Promise(r => setTimeout(r, 100));
        const afterEnterEdit = { dirty: hasUnsavedChanges, mode: isEditMode };
        isEditMode = false;
        contentWrapper.classList.remove('split-view');
        currentFilePath = good;
        failedSaves.clear();
        hasUnsavedChanges = false;
        updateUnsavedIndicator();
        restore();
        return { afterFail, afterEnterEdit };
      })()
    `);
    // The mute is asserted to have caught the failure it was opened for: a
    // mute that suppresses nothing is a mute that has stopped describing the
    // test, and would quietly hide a real regression later.
    const failMute = sentinel.currentMute();
    await sentinel.unmute();
    check(
      "the provoked save failure really did reach the console, so the mute is not hiding a silent no-op",
      !!failMute && (failMute.suppressed || []).some((s) => String(s.detail || "").includes("EISDIR")),
      JSON.stringify(failMute && failMute.suppressed),
    );
    check(
      "a failed view-mode auto-save records the failure and keeps the document dirty",
      failState && failState.afterFail && failState.afterFail.wrote === true
        && failState.afterFail.failed === true && failState.afterFail.dirty === true,
      JSON.stringify(failState),
    );
    check(
      "a failed view-mode auto-save arms the reload/open guards",
      failState && failState.afterFail && failState.afterFail.guarded === true,
      JSON.stringify(failState && failState.afterFail),
    );
    check(
      "entering edit mode after a failed auto-save preserves the unsaved state, so the note can be retried",
      failState && failState.afterEnterEdit && failState.afterEnterEdit.dirty === true
        && failState.afterEnterEdit.mode === true,
      JSON.stringify(failState && failState.afterEnterEdit),
    );

    // ---- 7. A store that moves while a write is in flight ----
    // In view mode originalMarkdown IS the document, and a second note can be
    // confirmed before the first note's reply arrives. Adopting the in-flight
    // payload then drops the newer note from the store while its own write
    // still lands on disk, so store and file describe different documents and
    // the next note writes the stale one back out.
    //
    // Driven deterministically by replaying a reply for a save whose payload
    // is already stale, rather than by racing a real write - a timing race
    // would be flaky and would not say what broke.
    const inFlight = await exec(`
      (() => {
        const stale = originalMarkdown;
        const fresher = originalMarkdown + '\\nSECOND NOTE\\n';
        const rid = nextSaveRequestId++;
        const entry = { path: currentFilePath, content: stale, resolve: () => {} };
        entry.promise = Promise.resolve(true);
        pendingSaves.set(rid, entry);
        originalMarkdown = fresher;   // the second note lands first
        ipcRenderer.emit('save-markdown-result', {}, {
          success: true, path: currentFilePath, requestId: rid,
        });
        const kept = originalMarkdown === fresher;
        // CAPTURED BEFORE THE RESET. Reading it after the cleanup below would
        // report false unconditionally and the assertion would be decorative -
        // the same "capture observations before perturbing the system" trap
        // that has bitten this suite twice already.
        const dirtyWhileNewerPending = hasUnsavedChanges;
        originalMarkdown = stale;
        hasUnsavedChanges = false;
        failedSaves.clear();
        updateUnsavedIndicator();
        return { kept, dirtyWhileNewerPending };
      })()
    `);
    check(
      "a save reply does not overwrite a view-mode store that moved while the write was in flight",
      inFlight && inFlight.kept === true,
      JSON.stringify(inFlight),
    );
    // Not keeping the store is only half of it: the document is now genuinely
    // unsaved (the newer note has no write of its own yet), so the flag has to
    // say so or the next reload discards it without a prompt.
    check(
      "a store that moved mid-write is left marked unsaved, not clean",
      inFlight && inFlight.dirtyWhileNewerPending === true,
      JSON.stringify(inFlight),
    );

    // ---- 8. A failed save is PER DOCUMENT, not a global flag ----
    // Both independent reviewers found this one. Documents are per-tab and
    // custom-tabs.js restores `hasUnsavedChanges` per tab, but it has no hook
    // for a renderer-global. A single boolean therefore fails in both
    // directions: a successful save on tab B disarms the guards protecting
    // tab A's unsaved note, and a failure on tab A makes clean tab B claim
    // unsaved changes it does not have.
    const tabAPath = await openFresh("fail-tab-a.md", "# A\n\nbody A\n");
    const tabBPath = await openFresh("fail-tab-b.md", "# B\n\nbody B\n");
    // The failure below is synthetic and deliberate, so its console.error is a
    // result and not a finding. Muted rather than tolerated, and the mute is
    // asserted to have caught it - a mute that suppresses nothing has stopped
    // describing the test.
    await sentinel.mute("cross-tab failure isolation: a save failure is injected on purpose");
    const crossTab = await exec(`
      (async () => {
        const realAlert = window.alert, realConfirm = window.confirm;
        window.alert = () => {}; window.confirm = () => true;
        const A = ${JSON.stringify(tabAPath)}, B = ${JSON.stringify(tabBPath)};
        // Record a failure against A while B is the document on screen. This is
        // the shape a background write failure really has - the reply names the
        // path, not the screen.
        ipcRenderer.emit('save-markdown-result', {}, {
          success: false, path: A, error: 'synthetic failure for tab A',
        });
        const bClean = { dirty: hasUnsavedChanges, guarded: hasUnsavedWork(), on: currentFilePath === B };
        // A real, successful save of B must not clear A's failure.
        originalMarkdown = originalMarkdown + '\\nB EDIT\\n';
        saveMarkdownFile();
        await new Promise(r => setTimeout(r, 2000));
        const afterBSaved = { aStillFailed: saveFailedFor(A), bFailed: saveFailedFor(B) };
        window.alert = realAlert; window.confirm = realConfirm;
        return { bClean, afterBSaved };
      })()
    `);
    const crossTabMute = sentinel.currentMute();
    await sentinel.unmute();
    check(
      "the injected cross-tab failure really did reach the console, so its mute is not vacuous",
      !!crossTabMute && (crossTabMute.suppressed || []).some((s) =>
        String(s.detail || "").includes("synthetic failure for tab A")),
      JSON.stringify(crossTabMute && crossTabMute.suppressed),
    );
    check(
      "a failure recorded for another document does not make the on-screen document look unsaved",
      crossTab && crossTab.bClean && crossTab.bClean.on === true
        && crossTab.bClean.dirty === false && crossTab.bClean.guarded === false,
      JSON.stringify(crossTab && crossTab.bClean),
    );
    check(
      "a successful save of one document does not clear another document's recorded failure",
      crossTab && crossTab.afterBSaved && crossTab.afterBSaved.aStillFailed === true
        && crossTab.afterBSaved.bFailed === false,
      JSON.stringify(crossTab && crossTab.afterBSaved),
    );
    // And the failure must still be ARMED when the user comes back to A.
    const backOnA = await exec(`
      (async () => {
        const t = window.CustomTabs.findTabByPath(${JSON.stringify(tabAPath)});
        if (!t) return { found: false };
        window.CustomTabs.switchToTab(t.id);
        await new Promise(r => setTimeout(r, 1200));
        hasUnsavedChanges = true;   // the note that never reached disk
        return { found: true, on: currentFilePath === ${JSON.stringify(tabAPath)}, guarded: hasUnsavedWork() };
      })()
    `);
    check(
      "returning to the document whose save failed finds its reload guard still armed",
      backOnA && backOnA.found === true && backOnA.on === true && backOnA.guarded === true,
      JSON.stringify(backOnA),
    );

    // ---- 9. A failure that arrives after the user has entered edit mode ----
    // Found by one reviewer only, and real: the failure branch used to ignore
    // any reply that landed while isEditMode was true. A view-mode note's write
    // can still be unanswered when the user enters edit mode (that is exactly
    // what the retry advice tells them to do), and which mode the user happens
    // to be in when the reply lands says nothing about whether the write
    // succeeded. Combined with entering edit mode zeroing the dirty flag, the
    // note ended up unsaved AND unmarked.
    // Same deliberate-failure treatment as the cross-tab probe above.
    await sentinel.mute("late save failure: the reply is injected on purpose");
    const lateFail = await exec(`
      (async () => {
        const realAlert = window.alert, realConfirm = window.confirm;
        window.alert = () => {}; window.confirm = () => true;
        failedSaves.clear();
        const p = currentFilePath;
        // A write that is out and unanswered - the state a just-added note is in.
        const rid = nextSaveRequestId++;
        const entry = { path: p, content: originalMarkdown + '\\nNOTE\\n', resolve: () => {} };
        entry.promise = Promise.resolve(true);
        pendingSaves.set(rid, entry);
        hasUnsavedChanges = true;
        updateUnsavedIndicator();
        toggleEditBtn.click();
        for (let i = 0; i < 60 && !isEditMode; i++) await new Promise(r => setTimeout(r, 100));
        const carried = hasUnsavedChanges;
        ipcRenderer.emit('save-markdown-result', {}, {
          success: false, path: p, requestId: rid, error: 'synthetic late failure',
        });
        const after = { dirty: hasUnsavedChanges, recorded: saveFailedFor(p), guarded: hasUnsavedWork() };
        isEditMode = false;
        contentWrapper.classList.remove('split-view');
        failedSaves.clear();
        pendingSaves.clear();
        hasUnsavedChanges = false;
        updateUnsavedIndicator();
        window.alert = realAlert; window.confirm = realConfirm;
        return { carried, after };
      })()
    `);
    const lateMute = sentinel.currentMute();
    await sentinel.unmute();
    check(
      "the injected late failure really did reach the console, so its mute is not vacuous",
      !!lateMute && (lateMute.suppressed || []).some((s) =>
        String(s.detail || "").includes("synthetic late failure")),
      JSON.stringify(lateMute && lateMute.suppressed),
    );
    check(
      "entering edit mode with a write still unanswered keeps the document marked unsaved",
      lateFail && lateFail.carried === true,
      JSON.stringify(lateFail),
    );
    check(
      "a save failure arriving after the user entered edit mode is still recorded",
      lateFail && lateFail.after && lateFail.after.recorded === true
        && lateFail.after.dirty === true && lateFail.after.guarded === true,
      JSON.stringify(lateFail && lateFail.after),
    );
  }

  // ---------------------------------------------------------------------
  // 19. Every keyboard shortcut the README documents is real, and the ones it
  //     no longer documents really are absent.
  //
  // Found by auditing the README against the code: the shipped table claimed
  // `Ctrl+B` / `Ctrl+I` / `Ctrl+\`` (bold, italic, code) and `Ctrl+D` (dark
  // mode). NONE of those four had a handler anywhere - not in renderer.js, not
  // in main.js's before-input-event hook, and there are no Electron menu
  // accelerators in this app at all. Meanwhile `Ctrl+R`, the refresh shortcut
  // that is central to this fork, was not documented. A shortcut table is the
  // one part of a README a reader tests immediately, so a false row is found
  // by every user and fixed by none of them.
  //
  // THE ORACLE IS BEHAVIOURAL, NOT TEXTUAL. Grepping renderer.js for `'b'`
  // would prove nothing (this project's recurring anti-pattern): it cannot see
  // a listener that is registered but unreachable, and it cannot see one that
  // lives in a file the grep did not think to open. Instead a real cancelable
  // KeyboardEvent is dispatched at `document` and `defaultPrevented` is read
  // back. Every genuine Ctrl shortcut in this app calls e.preventDefault()
  // unconditionally inside its own branch, so that single property is a
  // uniform yes/no answer across the whole table with no per-row special
  // casing - and it is the real listener chain answering, not a copy of it.
  //
  // The classification is exhaustive BY CONSTRUCTION: every row parsed out of
  // the README's Keyboard table must fall into exactly one of measured /
  // main-process / element-scoped, and an unrecognised row FAILS. So a future
  // row added to the docs cannot be undocumented-by-omission here - either it
  // is measured, or somebody has to say in this file why it cannot be.
  // ---------------------------------------------------------------------
  {
    const readmeText = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
    // Bounded at the next heading. An unbounded split runs on into the
    // provenance table much further down the file and silently classifies
    // "Electron" and "Fira Code" as undocumented keyboard shortcuts - caught
    // on the first run, and a reminder that a parser with no end marker
    // reports on text nobody claimed it was reading.
    const kbSection = (readmeText.split(/^### Keyboard$/m)[1] || "").split(/^#{1,6} /m)[0];
    const kbRows = kbSection
      .split(/\r?\n/)
      .filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l) && !/^\|\s*Shortcut/.test(l))
      .map((l) => l.split("|")[1].trim());
    const documented = [];
    for (const cell of kbRows) {
      for (const tok of cell.split("/")) {
        const t = tok.trim().replace(/^`|`$/g, "").trim();
        if (t) documented.push(t);
      }
    }
    check(
      "the README's keyboard table was found and parsed",
      documented.length >= 10,
      JSON.stringify(documented),
    );

    // Handled in the MAIN process via webContents before-input-event, which is
    // fed by real OS input. A renderer-side dispatchEvent structurally cannot
    // reach it, so these are named rather than measured - see main.js:607.
    const MAIN_PROCESS = ["Ctrl+O", "F11"];
    // Bound to a specific element (a dialog overlay, the search box, the
    // editor textarea) rather than to `document`, so "did document's listener
    // chain cancel it" is the wrong question for them.
    const ELEMENT_SCOPED = ["Ctrl+Enter", "Enter", "Shift+Enter", "Escape", "Tab"];
    // key = the KeyboardEvent.key the handler actually tests for; mode = the
    // mode the README row claims it works in.
    const MEASURED = {
      "Ctrl+R": { key: "r", edit: false },
      "Ctrl+S": { key: "s", edit: true },
      "Ctrl+Z": { key: "z", edit: true },
      "Ctrl+Y": { key: "y", edit: true },
      "Ctrl+F": { key: "f", edit: false },
      "Ctrl++": { key: "+", edit: false },
      "Ctrl+-": { key: "-", edit: false },
      "Ctrl+0": { key: "0", edit: false },
    };
    const unclassified = documented.filter(
      (d) => !MAIN_PROCESS.includes(d) && !ELEMENT_SCOPED.includes(d) && !MEASURED[d],
    );
    check(
      "every documented shortcut is classified, so none can be skipped by omission",
      unclassified.length === 0,
      JSON.stringify(unclassified),
    );

    // Removed from the README by this change. Asserted absent so the false
    // rows cannot quietly return - and so that implementing any of them forces
    // the table to be updated in the same commit.
    const ABSENT = { "Ctrl+B": "b", "Ctrl+I": "i", "Ctrl+`": "`", "Ctrl+D": "d" };
    check(
      "the README no longer claims the four shortcuts that were never implemented",
      Object.keys(ABSENT).every((k) => !documented.includes(k)),
      JSON.stringify(documented),
    );

    const kbFile = path.join(dir, "shortcuts.md");
    fs.writeFileSync(kbFile, "# Shortcuts\n\nbody\n", "utf8");
    await exec(`ipcRenderer.send('open-file-path', ${JSON.stringify(kbFile)}); null`);
    await waitFor(
      exec,
      "the shortcut probe document to open",
      `currentFilePath === ${JSON.stringify(kbFile)} ? 'ok' : false`,
      20000,
    );

    // Undo/redo run against an EMPTY history on purpose: both handlers
    // preventDefault before historyUndo/historyRedo return early, so the
    // binding is measured without moving the document underneath the rest of
    // the suite. Ctrl+S is likewise pointed at unmodified content.
    const probe = await exec(`
      (async () => {
        const fire = (key) => {
          const ev = new KeyboardEvent('keydown', {
            key, ctrlKey: true, bubbles: true, cancelable: true,
          });
          document.dispatchEvent(ev);
          return ev.defaultPrevented;
        };
        const zoomBefore = zoomLevel;
        const searchWasOpen = searchPanel.classList.contains('active');
        historyClear();
        const handled = {};
        const spec = ${JSON.stringify(MEASURED)};
        for (const [label, s] of Object.entries(spec)) {
          if (s.edit) {
            isEditMode = true;
            markdownEditor.value = originalMarkdown;
            hasUnsavedChanges = false;
          } else {
            isEditMode = false;
          }
          handled[label] = fire(s.key);
        }
        const absent = {};
        isEditMode = false;
        for (const [label, key] of Object.entries(${JSON.stringify(ABSENT)})) {
          absent[label] = fire(key);
        }
        // Put back everything the sweep was allowed to move.
        zoomLevel = zoomBefore;
        updateZoom();
        if (searchPanel.classList.contains('active') !== searchWasOpen) toggleSearchPanel();
        isEditMode = false;
        contentWrapper.classList.remove('split-view');
        hasUnsavedChanges = false;
        updateUnsavedIndicator();
        historyClear();
        return { handled, absent, zoom: zoomLevel };
      })()
    `);
    // Ctrl+R really does reload, and Ctrl+S really does write; let both land
    // before the suite's closing sentinel checks read the page.
    await sleep(1200);

    const unhandled = Object.keys(MEASURED).filter((k) => probe.handled[k] !== true);
    check(
      "every shortcut the README documents at document level is actually bound",
      unhandled.length === 0,
      JSON.stringify(probe.handled),
    );
    // THE POSITIVE CONTROL. Without it, a dispatch built the wrong way - wrong
    // event type, non-cancelable, aimed at the wrong node - reports "not
    // handled" for everything, and the four absence assertions below all pass
    // for the worst possible reason.
    check(
      "the dispatch probe can observe a handled key, so an unhandled result means something",
      probe.handled["Ctrl+F"] === true && probe.handled["Ctrl+0"] === true,
      JSON.stringify(probe.handled),
    );
    const stillLive = Object.keys(ABSENT).filter((k) => probe.absent[k] !== false);
    check(
      "the four shortcuts the README used to claim really are unimplemented",
      stillLive.length === 0,
      JSON.stringify(probe.absent),
    );
    check(
      "the shortcut sweep left the zoom level where it found it",
      probe.zoom === (await exec(`ZOOM_CONFIG.level`)),
      JSON.stringify({ after: probe.zoom }),
    );
  }

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
}

app.whenReady().then(async () => {
  if (!BrowserWindow.getAllWindows().length) {
    console.log("FAIL  no window at ready - another instance is probably holding the single-instance lock.");
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
    await win.webContents.executeJavaScript(
      `window.__testErrors = []; window.addEventListener('error', e => window.__testErrors.push(String(e.message))); null`,
      true,
    );
    await run(win);
  } catch (e) {
    check("harness completed without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  const passed = results.filter((r) => r.ok).length;
  const summary = `=== ${passed}/${results.length} passed ===`;
  console.log(summary);
  writeReport(summary);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
  app.exit(passed === results.length ? 0 : 1);
});
