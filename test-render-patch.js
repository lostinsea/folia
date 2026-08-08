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
  const { startErrorSentinel, proveSentinelAlive, captureScreenshot } = require("./test-visual-utils");
  const sentinel = startErrorSentinel(win, { label: "patch" });
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
  await render(exec, "# Plain\n\nbody\n\n# [Linked](https://example.invalid/x)\n\nmore body\n", "full");
  const linkGuard = await exec(`
    (() => {
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
