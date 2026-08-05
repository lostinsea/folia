#!/usr/bin/env node
// Revert-proof harness for the table-display work.
//
// A test that passes is worthless if it would also pass with the fix removed.
// This deliberately breaks one fix at a time, runs the suite, and requires that
// the SPECIFIC assertions that fix exists to protect are the ones that fail.
// Anything that stays green under its own revert is vacuous.
//
// Usage: node scripts/prove-table-fixes.js [id ...]
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSS = path.join(ROOT, "styles.css");
const RENDERER = path.join(ROOT, "renderer.js");
const TABS = path.join(ROOT, "custom-tabs.js");
const COLLAPSE = path.join(ROOT, "custom-collapse.js");

const REVERTS = [
  {
    id: "R49",
    what: "table-layout: auto -> fixed (the equal-split the user complained about)",
    file: CSS,
    from: "table-layout: auto;\n  border-collapse: collapse;",
    to: "table-layout: fixed;\n  border-collapse: collapse;",
    expect: [/most of the width/, /not all the same width/],
  },
  {
    id: "R50",
    what: "reintroduce word-break: break-word on header cells (min-content collapses to one character under auto layout)",
    file: CSS,
    from: "border-bottom: 2px solid var(--border-color);\n  overflow-wrap: break-word;",
    to: "border-bottom: 2px solid var(--border-color);\n  overflow-wrap: break-word;\n  word-break: break-word;",
    // Measured directly rather than through the rendered headers: the headers
    // are now double-protected by markShortColumns()' nowrap, which would hide
    // the cause coming back.
    expect: [/a header cell's min-content width is the longest word/],
  },
  {
    id: "R50b",
    what: "reintroduce word-break: break-word on body cells (min-content collapses to one character under auto layout)",
    file: CSS,
    from: "border-bottom: 1px solid var(--border-color);\n  overflow-wrap: break-word;",
    to: "border-bottom: 1px solid var(--border-color);\n  overflow-wrap: break-word;\n  word-break: break-word;",
    expect: [/a body cell's min-content width is the longest word/],
  },
  {
    id: "R51",
    what: ".collapsible-section display:flow-root -> overflow:hidden (clips breakout)",
    file: CSS,
    from: "  display: flow-root;\n}",
    to: "  overflow: hidden;\n}",
    expect: [/not clipped by an ancestor either/],
  },
  {
    id: "R52",
    what: "#viewer overflow:visible -> overflow-y:auto (computes overflow-x to auto, clips breakout)",
    file: CSS,
    from: "  overflow: visible;\n  position: relative;",
    to: "  overflow-y: auto;\n  position: relative;",
    expect: [/not clipped by an ancestor either/],
  },
  {
    id: "R53",
    what: "do not call applyTableBreakout (wide tables stay clipped in the reading column)",
    file: RENDERER,
    // Reverting a single call site would only cover one render path now that
    // the call has moved out of addTableMaximizeButtons() and into both
    // pipelines. Neutralising the function itself covers every call site,
    // present and future, and cannot rot when a call site moves again.
    from:
      "function applyTableBreakout() {\n" +
      "  const containers = viewer.querySelectorAll('.table-container');",
    to:
      "function applyTableBreakout() {\n" +
      "  if (true) return; /* reverted for proof */\n" +
      "  const containers = viewer.querySelectorAll('.table-container');",
    expect: [/table too wide for the reading column is widened/],
  },
  {
    id: "R54",
    what: "measure without resetting first (a widened table already 'fits', so its width is never recomputed)",
    file: RENDERER,
    from:
      "    c.classList.remove('table-breakout');\n" +
      "    c.style.removeProperty('--table-breakout-width');",
    to: "    /* reset removed for proof */",
    // Without the reset the class is never cleared, so entering split view
    // leaves it on; and a width computed while the window was small is never
    // recomputed when a section is expanded after the window has grown.
    expect: [
      /stood down in split view/,
      /expanding after the window grew re-measures/,
    ],
  },
  {
    id: "R57",
    what: "the original shape: no reset, plus an else-branch that removes breakout (oscillates across calls)",
    file: RENDERER,
    from:
      "    c.classList.remove('table-breakout');\n" +
      "    c.style.removeProperty('--table-breakout-width');",
    to:
      "    /* reset removed for proof */",
    also: {
      from:
        "      container.classList.add('table-breakout');\n" +
        "    }\n" +
        "  });",
      to:
        "      container.classList.add('table-breakout');\n" +
        "    } else if (!(wanted > given + 1)) {\n" +
        "      container.classList.remove('table-breakout');\n" +
        "      container.style.removeProperty('--table-breakout-width');\n" +
        "    }\n" +
        "  });",
    },
    expect: [/breakout survives repeated recalculation/],
  },
  {
    id: "R55",
    what: "do not recalculate when entering split view (table stays sized for the full window)",
    file: RENDERER,
    from: "    applyTableBreakout();\n    markdownEditor.value = originalMarkdown;",
    to: "    markdownEditor.value = originalMarkdown;",
    // Breakout is deliberately stood down in split view (the 900px reading
    // column is not in effect there, and #viewer must be its own scroller so a
    // breakout could only be clipped). Skipping the recalculation therefore
    // leaves the full-window width in place, overlapping the editor pane.
    expect: [/stood down in split view/, /never overlaps the editor pane in split view/],
  },
  {
    id: "R56",
    what: "do not recalculate when leaving split view (table stays sized for the narrow viewer)",
    file: RENDERER,
    from: "    applyTableBreakout();\n    toggleEditBtn.style.background = '';",
    to: "    toggleEditBtn.style.background = '';",
    expect: [/leaving split view restores the full widened width/],
  },
  {
    id: "R58",
    what: "remove the print neutralisation (a widened table runs off the printed page / PDF)",
    file: CSS,
    from:
      "  .markdown-body .table-container.table-breakout {\n" +
      "    width: 100% !important;\n" +
      "    max-width: 100% !important;\n" +
      "    margin-left: 0 !important;\n" +
      "    transform: none !important;\n" +
      "  }",
    to: "  /* print neutralisation removed for proof */",
    expect: [/print media neutralises the breakout/, /not displaced from where the content starts/],
  },
  {
    id: "R59",
    what: "write the width in viewport pixels without converting into the zoomed subtree's own pixels",
    file: RENDERER,
    from: "        Math.min(wanted, available) / zoomFactor + 'px'\n      );\n      container.classList.add('table-breakout');",
    to: "        Math.min(wanted, available) + 'px'\n      );\n      container.classList.add('table-breakout');",
    // A length written onto a descendant of #viewer is in the subtree's own
    // pixels and is multiplied by zoom when painted, while every measurement
    // above is in viewport pixels. Skipping the conversion hands the table
    // zoom-times the space it asked for, and the surplus goes to the one column
    // able to absorb it: the explanation column runs to 112 characters a line.
    // (It does not leave the window: the --mv-breakout-budget CSS clamp still
    // catches that, which is precisely what that safety net is for.)
    expect: [/prose column keeps a readable character measure when zoomed in/],
  },
  {
    id: "R60",
    what: "do not recalculate on zoom (a width set at 100% is 4x too wide at 400%)",
    file: RENDERER,
    from: "  applyTableBreakout();\n}\n\n// ============================================\n// ZOOM CONTROLS",
    to: "}\n\n// ============================================\n// ZOOM CONTROLS",
    expect: [/never leaves the window at any zoom level/],
  },
  {
    id: "R61",
    what: "remove the split-view scroller (the bottom of the document is unreachable while editing)",
    file: CSS,
    from: "  overflow-y: auto;\n}\n\n/* Editor Panel */",
    to: "}\n\n/* Editor Panel */",
    expect: [/offers the user a way to scroll in split view/],
  },
  {
    id: "R62",
    what: "recalculate hidden containers too (a breakout inside a collapsed section is stripped)",
    file: RENDERER,
    from: "    if (c.clientWidth > 0) visible.push(c);",
    to: "    visible.push(c);",
    expect: [/collapsed does not strip its breakout/, /keeps its widened width/],
  },
  {
    id: "R63",
    suite: "test:tabs",
    what:
      "infer the split-view scroller from a class name again, then move the scroller " +
      "to .content-wrapper (the pairing drifts and every tab's reading position is lost)",
    file: TABS,
    from:
      "    if (typeof getViewerScroller === \"function\") return getViewerScroller();\n" +
      "    const wrapper = document.querySelector(\".content-wrapper\");\n" +
      "    const viewerEl = document.getElementById(\"viewer\");\n" +
      "    const scrollable = (el) =>\n" +
      "      el && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY);\n" +
      "    if (scrollable(viewerEl)) return viewerEl;\n" +
      "    if (scrollable(wrapper)) return wrapper;\n" +
      "    return wrapper || viewerEl;",
    to:
      "    const wrapper = document.querySelector(\".content-wrapper\");\n" +
      "    if (wrapper && wrapper.classList.contains(\"split-view\")) {\n" +
      "      return document.getElementById(\"viewer\") || wrapper;\n" +
      "    }\n" +
      "    return wrapper || document.getElementById(\"viewer\");",
    // Paired: move the scroller off #viewer. The computed-overflow version
    // follows it; the class-based version keeps pointing at #viewer, whose
    // scrollTop is then permanently 0.
    also: {
      file: CSS,
      from: "  overflow-y: auto;\n}\n\n/* Editor Panel */",
      to: "  overflow: visible;\n}\n\n.content-wrapper.split-view { overflow-y: auto; }\n\n/* Editor Panel */",
    },
    expect: [/really entered split view on a scrollable pane/],
  },
  {
    id: "R64",
    what: "reintroduce white-space: nowrap on compact tables (a 6-column table with one long column runs off to the right)",
    file: CSS,
    from: ".markdown-body table.compact-table {\n  font-size: 11px;",
    to: ".markdown-body table.compact-table {\n  white-space: nowrap;\n  font-size: 11px;",
    expect: [/long column of a compact table wraps/],
  },
  {
    id: "R65",
    what: "do not mark short columns (a compact table wraps 'teamalpha' over four lines)",
    file: RENDERER,
    from: "    markShortColumns(table);",
    to: "    /* markShortColumns(table); reverted for proof */",
    // Deliberately NOT pointed at the dense 16-column table: that one is
    // widened to its full preferred width anyway, so its values stay on one
    // line with or without this. The table that needs it is the compact one,
    // which stays inside the reading column and shares a fixed budget.
    expect: [
      /recognised as holding short values/,
      /short columns of a compact table keep their values on one line/,
    ],
  },
  {
    id: "R66",
    what: "widen only when clipped (a table squeezed into narrow columns still 'fits', so it is never widened)",
    file: RENDERER,
    from: "      wanted: Math.max(rect * overflow, preferredTableWidth(container, capMemo)),",
    to: "      wanted: rect * overflow,",
    expect: [/table too wide for the reading column is widened/],
  },
  {
    id: "R67",
    what: "never fall back to wrapping (a table wider than a narrow window scrolls sideways again)",
    file: RENDERER,
    from: "    if (table) table.classList.toggle('wrap-anyway', wanted > available);",
    to: "    /* wrap-anyway fallback removed for proof */",
    expect: [/wraps instead of scrolling/],
  },
  {
    id: "R68",
    what: "context-menu Insert/Edit Table never applies breakout (the one table kind that still scrolls sideways)",
    file: RENDERER,
    from: "  applyTableBreakout(); // context-menu insert/edit builds its own container",
    to: "  /* applyTableBreakout() reverted for proof */",
    expect: [/inserted from the context menu is widened/],
  },
  {
    id: "R69",
    what: "expanding a section never re-measures (collapse at one window size, expand at another, and the width is stale)",
    file: RENDERER,
    from: "  applyTableBreakout(); // heading toggle changes what can be measured",
    to: "  /* applyTableBreakout() reverted for proof */",
    expect: [/expanding after the window grew re-measures/],
  },
  {
    id: "R70",
    what: "use the stored breakout width raw instead of clamping it to the current budget (a stale width paints off both window edges)",
    file: CSS,
    from: "  --mv-breakout-applied: min(var(--table-breakout-width), var(--mv-breakout-budget, 100%));",
    to: "  --mv-breakout-applied: var(--table-breakout-width);",
    expect: [/clamped inside the window by CSS alone/],
  },
  {
    id: "R71",
    what: "go back to a fixed pixel reading measure (the cap stops tracking the cell font, so it means a different number of characters in every table and at every zoom level)",
    file: RENDERER,
    from: "  const cap = measureTextColumnCap(container, table, row.cells[0], memo);",
    to: "  const cap = 520;",
    expect: [
      // A fixed 520px means a different number of characters in every table
      // (the .compact-table cell font is 11px vs the body's 13px) and at every
      // zoom level. The at-100% prose column overshoots the reading measure.
      /an explanation column is given a readable measure/,
    ],
  },
  {
    id: "R72",
    what: "leave wrap-anyway behind when the apply pass is skipped (short columns keep wrapping in split view, where there is room for them)",
    file: RENDERER,
    from: "    if (t) t.classList.remove('wrap-anyway');",
    to: "    /* wrap-anyway reset removed for proof */",
    expect: [/wrap-anyway is cleared on entering split view/],
  },
  {
    id: "R73",
    suite: "test:patch",
    what: "key Collapse All by the raw header id again (writes land in a key space nothing reads, so it unwinds on the next re-render)",
    file: COLLAPSE,
    from: "        collapsedHeaders.set(_collapseKey(header.id), true);",
    to: "        collapsedHeaders.set(header.id, true);",
    // The DOM classes are set either way, so the defect is only visible after a
    // re-render - which is exactly what the second assertion observes.
    expect: [
      /Collapse All records state under the same key/,
      /Collapse All survives a re-render/,
    ],
  },
  {
    id: "R73b",
    suite: "test:patch",
    what: "key Expand All by the raw header id again (the inverse of R73: an expand recorded in the wrong key space lets the collapse come back on re-render)",
    file: COLLAPSE,
    from: "        collapsedHeaders.set(_collapseKey(header.id), false);",
    to: "        collapsedHeaders.set(header.id, false);",
    expect: [/Expand All likewise survives a re-render/],
  },
  {
    id: "R74",
    suite: "test:patch",
    what: "hard-code contentWrapper as the scroll target for in-view navigation (a silent no-op in split view, where contentWrapper is overflow:hidden)",
    file: RENDERER,
    from: "  el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });",
    to:
      "  const scroller = contentWrapper;\n" +
      "  const r = scroller.getBoundingClientRect();\n" +
      "  const t = el.getBoundingClientRect();\n" +
      "  const off = block === 'center' ? r.height / 2 : 20;\n" +
      "  scroller.scrollTo({ top: t.top - r.top + scroller.scrollTop - off, behavior: 'smooth' });",
    // Only the split-view legs may fail: .content-wrapper genuinely is the
    // scroller in normal view, so the normal-view legs must stay green or the
    // assertion is measuring something other than the defect.
    expect: [
      /clicking a table-of-contents entry scrolls the page in split view/,
      /the chosen heading ends up near the top of the view in split view/,
    ],
  },
  {
    id: "R75",
    what: "measure before makeHeadersCollapsible on the incremental path (tables the reader has collapsed are measured in the transient flat layout)",
    file: RENDERER,
    from:
      "  makeHeadersCollapsible();\n" +
      "  // Deliberately AFTER makeHeadersCollapsible(): it wraps sections and applies",
    to:
      "  applyTableBreakout();\n" +
      "  makeHeadersCollapsible();\n" +
      "  // Deliberately AFTER makeHeadersCollapsible(): it wraps sections and applies",
    // Paired: remove the correctly-placed call, or the later one would simply
    // clean up after the early one and the revert would prove nothing.
    also: {
      file: RENDERER,
      from: "  // gets rather than the transient flat one.\n  applyTableBreakout();",
      to: "  // gets rather than the transient flat one.",
    },
    expect: [/never measured in the transient flat layout \(incremental\)/],
  },
  {
    id: "R76",
    what: "measure before makeHeadersCollapsible on the full-render path (same defect, other call site)",
    file: RENDERER,
    from:
      "    // Make headers collapsible\n" +
      "    makeHeadersCollapsible();",
    to:
      "    applyTableBreakout();\n" +
      "    // Make headers collapsible\n" +
      "    makeHeadersCollapsible();",
    also: {
      file: RENDERER,
      from:
        "    // tables that are about to be hidden.\n" +
        "    applyTableBreakout();",
      to: "    // tables that are about to be hidden.",
    },
    expect: [/never measured in the transient flat layout \(full\)/],
  },
  {
    id: "R77",
    what: "drop the per-call column-cap memo (the probe layout runs once per table instead of once per table shape)",
    file: RENDERER,
    from: "  if (memo && memo.has(key)) return memo.get(key);",
    to: "  /* memo lookup removed for proof */",
    expect: [/probe runs once per table SHAPE/],
  },
  {
    id: "R78",
    what: "key the column-cap memo on the table's class again (two tables of the same class in different font contexts share one cap, so one of them gets the wrong reading measure)",
    file: RENDERER,
    from:
      "  const cs = getComputedStyle(templateCell);\n" +
      "  const key = [\n" +
      "    table.className,\n" +
      "    templateCell.tagName,\n" +
      "    cs.fontSize,",
    to:
      "  const cs = getComputedStyle(templateCell);\n" +
      "  const key = [\n" +
      "    table.className,\n" +
      "    templateCell.tagName,\n" +
      "    '',",
    // Paired: strip the remaining font/box longhands too, leaving exactly the
    // className+tagName key this reintroduces.
    also: {
      file: RENDERER,
      from:
        "    cs.fontFamily,\n" +
        "    cs.fontWeight,\n" +
        "    cs.fontStyle,\n" +
        "    cs.fontStretch,\n" +
        "    cs.letterSpacing,\n" +
        "    cs.wordSpacing,\n" +
        "    cs.paddingLeft,\n" +
        "    cs.paddingRight,\n" +
        "    cs.borderLeftWidth,\n" +
        "    cs.borderRightWidth,\n",
      to: "",
    },
    expect: [/measured on its own, not handed a cached cap/],
  },
  {
    // Added after the vscode-extension sub-project was dropped, which forced
    // the FiraCode TTFs to be relocated to the tracked assets/fonts/. The two
    // reviewers DISAGREED about whether this belongs in a *table* harness at
    // all. It does, and the reason is measured rather than argued: moving
    // fonts/*.ttf aside does not merely fail the font assertions, it breaks
    // FOUR geometric ones - breakout stops triggering (breakout=false) and the
    // prose column blows out to 93.7 characters, far outside the 45-80 measure
    // this redesign exists to hold. measureTextColumnCap() sizes a column by
    // rendering 66 zeros in the cell's RESOLVED font, so font availability is a
    // direct input to every table width in this suite. Without this entry the
    // guard could later be refactored into vacuity unnoticed.
    id: "R79",
    what: "point a declared @font-face at a TTF that was never vendored (the app silently falls back and every table width is measured in the wrong font)",
    file: CSS,
    from: "  src: url('fonts/FiraCode-Regular.ttf') format('truetype');",
    to: "  src: url('fonts/FiraCode-Regular-NEVER-VENDORED.ttf') format('truetype');",
    expect: [
      /every Fira Code weight the stylesheet declares is really loaded/,
      /exists in the vendored/,
    ],
  },
  {
    // R74 and R80 break the SAME line for different reasons, and the difference
    // is the whole point. R74 restores a scroller that is simply wrong in split
    // view - it fails at every zoom. R80 restores the scroller-correct hand
    // arithmetic that shipped in this fork for months and passes perfectly at
    // 100%: it adds a VIEWPORT-pixel rect delta to a scrollTop expressed in the
    // zoomed subtree's OWN pixels. Those two spaces coincide at zoom 1, so the
    // defect is invisible until the matrix includes a second zoom level - which
    // is exactly why it survived until now. Measured overshoot: 2145px.
    id: "R80",
    suite: "test:patch",
    what: "compute the scroll destination by hand again (correct scroller, but a viewport-pixel rect delta added to a scrollTop in the zoomed subtree's own pixels)",
    file: RENDERER,
    from: "  el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });",
    to:
      "  const scroller = getViewerScroller();\n" +
      "  const r = scroller.getBoundingClientRect();\n" +
      "  const t = el.getBoundingClientRect();\n" +
      "  const off = block === 'center' ? r.height / 2 : 20;\n" +
      "  scroller.scrollTo({ top: t.top - r.top + scroller.scrollTop - off, behavior: 'smooth' });",
    // Deliberately narrow: only the zoomed split-view leg may fail. If the
    // 100% legs fail too, the assertion is catching the scroller choice (R74's
    // job) rather than the coordinate-space error this entry exists to pin.
    expect: [
      /the chosen heading ends up near the top of the view in split view at 200%/,
      /clicking an All Notes entry centres the note in split view at 200%/,
    ],
  },
  {
    // The sibling of R80, in the other file. custom-tabs.js remembers the
    // reading position as "heading + pixel delta", and that delta is computed
    // by the same rect-minus-rect-plus-scrollTop shape. Symmetric capture and
    // restore hide it whenever nothing reflows above the anchor, so only the
    // zoomed split-view scenario can see it - which is why this entry exists
    // rather than trusting the 100% scenario that was already there.
    id: "R81",
    suite: "test:tabs",
    what: "drop the viewport-to-scroller conversion from offsetWithin() (the remembered reading position is scaled by the zoom factor in split view)",
    file: TABS,
    from: "        scrollerScale(scroller) +",
    to: "        1 +",
    expect: [/reading position survives a tab switch in split view while zoomed/],
  },
  {
    id: "R82",
    suite: "test:patch",
    what: "give ordered lists the same gutter as bullets again (a wide numeric marker is wider than 2em, so it spills out of the list box)",
    file: CSS,
    from: ".markdown-body ol {\n  padding-left: 6ch;\n}",
    to: ".markdown-body ol {\n  padding-left: 2em;\n}",
    expect: [/every ordered list's gutter is wide enough for its widest marker/],
  },
  {
    // Distinct from R82: this one keeps a WIDER-than-bullet gutter and only
    // takes away the last digit of headroom, which is exactly the regression a
    // three-digit-ceiling value like the `3em` upstream uses would reintroduce.
    // Without the four-digit case in the sample this revert stays green.
    id: "R83",
    suite: "test:patch",
    what: "express the ordered-list gutter as a font-size multiple with a three-digit ceiling (the `3em` upstream uses) instead of a character count",
    file: CSS,
    from: ".markdown-body ol {\n  padding-left: 6ch;\n}",
    to: ".markdown-body ol {\n  padding-left: 3em;\n}",
    expect: [/every ordered list's gutter is wide enough for its widest marker/],
  },
  {
    // The narrowest of the three, and the one that caught a real mistake: 5ch
    // is exactly the width of the "9999." GLYPHS, so a gutter sized from a
    // canvas measurement of the marker text looked correct and still clipped,
    // because the marker box also carries a separating space. Only the
    // four-digit list fails here - "101." fits 5ch exactly - so if this ever
    // reports failures on the shorter lists it is catching R82's defect
    // instead, and the difference is the point.
    id: "R84",
    suite: "test:patch",
    what: "size the ordered-list gutter to the marker's glyphs only, ignoring the separating space the marker box also occupies",
    file: CSS,
    from: ".markdown-body ol {\n  padding-left: 6ch;\n}",
    to: ".markdown-body ol {\n  padding-left: 5ch;\n}",
    expect: [/every ordered list's gutter is wide enough for its widest marker/],
  },
  {
    // Not a bug being reverted but a DECISION being defended: upstream's
    // 6089305 sets this to false (CommonMark/GitHub reflow). The user was
    // shown both renderings and chose to render as typed, so a future merge
    // that quietly takes the upstream value has to fail a named assertion
    // rather than silently changing how every document looks.
    id: "R85",
    suite: "test:patch",
    what: "take upstream's CommonMark soft-break behaviour, reflowing hard-wrapped prose into one paragraph",
    file: RENDERER,
    from: "  breaks: true,",
    to: "  breaks: false,",
    expect: [/a soft break in the source renders as a line break/],
  },
];

const only = process.argv.slice(2);
const chosen = only.length ? REVERTS.filter((r) => only.includes(r.id)) : REVERTS;
// Fail loud rather than silently reporting success on an empty set. A typo in
// an id (or a `--only R1,R2` that this script does not accept) otherwise ends
// with "ALL REVERTS PROVEN" having proven nothing at all - which is exactly the
// kind of vacuous green this harness exists to prevent.
if (only.length && chosen.length !== only.length) {
  const unknown = only.filter((id) => !REVERTS.some((r) => r.id === id));
  console.error(
    `Unknown revert id(s): ${unknown.join(", ")}\n` +
      `Pass bare ids, e.g. "node scripts/prove-table-fixes.js R53 R63".\n` +
      `Known ids: ${REVERTS.map((r) => r.id).join(", ")}`,
  );
  process.exit(2);
}

function runSuite(suite) {
  try {
    const out = execFileSync("npm", ["run", suite || "test:tables"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out;
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

function failedNames(out) {
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("FAIL"))
    .map((l) => l.trim());
}

// The CSS in this repo is CRLF and the JS is LF. Matching a literal multi-line
// anchor therefore silently fails on one of them - which reads as "fix not
// found" and would quietly skip the proof. Anchors are matched as line-ending
// agnostic regexes instead.
function anchorRe(s) {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\n/g, "\\r?\\n"));
}

let bad = 0;
// A revert harness that leaves the tree dirty is worse than none at all: the
// next run would measure a file it had itself corrupted. Snapshot every file
// any chosen revert can touch, and compare at the end. (The previous version of
// this check read `git diff --stat` into an `if` with an empty body, so it
// reported nothing and could not fail - found in review.)
const touched = new Set();
for (const r of chosen) {
  touched.add(r.file);
  if (r.also) touched.add(r.also.file || r.file);
}
const snapshots = new Map();
for (const f of touched) snapshots.set(f, fs.readFileSync(f, "utf8"));

for (const r of chosen) {
  // A revert may need more than one paired edit - sometimes in DIFFERENT files
  // - to restore the shape of the previous implementation; applying only half
  // of it would prove nothing. Originals are keyed by path so every touched
  // file is restored, including when the run throws.
  const edits = [{ file: r.file, from: r.from, to: r.to }].concat(
    r.also ? [Object.assign({ file: r.file }, r.also)] : [],
  );
  const originals = new Map();
  for (const e of edits) {
    if (!originals.has(e.file)) originals.set(e.file, fs.readFileSync(e.file, "utf8"));
  }
  const working = new Map(originals);
  let setupFailed = null;
  for (const e of edits) {
    const text = working.get(e.file);
    const re = anchorRe(e.from);
    const m = re.exec(text);
    if (!m) {
      setupFailed = `anchor not found in ${path.basename(e.file)}: ${JSON.stringify(e.from.slice(0, 60))}`;
      break;
    }
    if (anchorRe(e.from).test(text.slice(m.index + m[0].length))) {
      setupFailed = `anchor is not unique in ${path.basename(e.file)}`;
      break;
    }
    const eol = m[0].includes("\r\n") ? "\r\n" : "\n";
    working.set(
      e.file,
      text.slice(0, m.index) + e.to.replace(/\n/g, eol) + text.slice(m.index + m[0].length),
    );
  }
  if (setupFailed) {
    console.log(`${r.id}  SETUP-FAILED  ${setupFailed}`);
    bad += 1;
    continue;
  }
  for (const [file, text] of working) fs.writeFileSync(file, text);
  let out;
  try {
    out = runSuite(r.suite);
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
  const fails = failedNames(out);
  const missing = r.expect.filter((re) => !fails.some((f) => re.test(f)));
  if (fails.length === 0) {
    console.log(`${r.id}  VACUOUS       suite stayed green with the fix removed  (${r.what})`);
    bad += 1;
  } else if (missing.length) {
    console.log(
      `${r.id}  WRONG-GUARD   failed, but not on the expected assertions. missing=${missing} got=${JSON.stringify(fails.slice(0, 4))}`,
    );
    bad += 1;
  } else {
    console.log(`${r.id}  PROVEN        ${fails.length} assertion(s) failed  <- ${r.what}`);
    for (const f of fails.slice(0, 4)) console.log(`        ${f}`);
  }
}

// Every file the harness touched must be byte-identical to how it was found.
let dirty = 0;
for (const [f, before] of snapshots) {
  if (fs.readFileSync(f, "utf8") !== before) {
    dirty++;
    console.error(`\nLEFT MODIFIED: ${f} - a revert was not restored. Check git diff before trusting anything above.`);
  }
}

console.log(bad === 0 ? "\nALL REVERTS PROVEN" : `\n${bad} revert(s) did not prove their fix`);
process.exit(bad === 0 && dirty === 0 ? 0 : 1);
