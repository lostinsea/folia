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
const MAIN = path.join(ROOT, "main.js");
const VISUAL = path.join(ROOT, "test", "test-visual-utils.js");
const RELEASE = path.join(ROOT, "scripts", "release.js");
const PKG = path.join(ROOT, "package.json");
const NOTICES = path.join(ROOT, "THIRD-PARTY-NOTICES.md");
const LICENSE_TXT = path.join(ROOT, "LICENSE.txt");
const LICENSE_MD = path.join(ROOT, "LICENSE");
const NOTICES_GEN = path.join(ROOT, "scripts", "generate-notices.js");
const ATTRS = path.join(ROOT, ".gitattributes");
const HTML = path.join(ROOT, "index.html");
const CUSTOM_CSS = path.join(ROOT, "custom-styles.css");

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
    expect: [
      /breakout survives repeated recalculation/,
      // The sharper of the two oracles, and the reason this entry stopped
      // being parity-dependent: "still broken at the end" says at least one
      // sample landed wrong, while this says the three samples DISAGREE, which
      // is what oscillation actually is. Named explicitly so the pin cannot be
      // weakened without the prover noticing.
      /every recalculation lands on the same width, not just the last one/,
    ],
    // Positive evidence that this revert oscillates rather than breaking
    // breakout outright. The candidate proposed in review - "a table too wide
    // for the reading column is widened" - was MEASURED and rejected: it is
    // itself parity-dependent under R57 (it passed when R57 ran alone and
    // failed in a three-revert batch), so it turned a real proof into
    // COLLATERAL at random. What is parity-independent is a table that is
    // never widened in the first place: the removing else-branch only fires on
    // a container that already fits, so on such a container it is a no-op and
    // no oscillation can start.
    mustPass: [/a table that fits is not widened beyond the reading column/],
  },
  {
    id: "R55",
    what: "do not recalculate when entering split view (table stays sized for the full window)",
    file: RENDERER,
    from: "    applyTableBreakout();\n    // Capture the baseline BEFORE the flag is zeroed",
    to: "    // Capture the baseline BEFORE the flag is zeroed",
    // Breakout is deliberately stood down in split view (the 900px reading
    // column is not in effect there, and #viewer must be its own scroller so a
    // breakout could only be clipped). Skipping the recalculation therefore
    // leaves the full-window width in place, overlapping the editor pane.
    // This revert was VACUOUS against the settled assertions, and the reason is
    // worth keeping: a ResizeObserver on .content-wrapper (added later, for the
    // ToC drawer) schedules the same 120ms debounce, so the backstop repairs the
    // layout ~140ms after the transition - well inside the 500ms those
    // assertions settle for. MEASURED twice: a stack-traced applyTableBreakout
    // showed entering fires at t+1ms from the handler and again at t+141ms from
    // a timer with no caller frames, and a second probe attributed that timer by
    // instrumenting both schedulers - the ResizeObserver fired with
    // contentRect.width moving 1972 <-> 1988, window resize fired zero times.
    // The explicit call is therefore what the USER sees, and it is pinned by an
    // assertion that reads the DOM synchronously after the click, before any
    // task boundary, where the debounce provably cannot have run.
    expect: [/entering split view stands the breakout down at the transition/],
    // The backstop must still be intact: if the settled assertions fail too,
    // the revert has broken breakout outright rather than merely delaying it.
    // The vacuity guard is listed too - "not widened after the click" is
    // satisfied for free by a scenario in which the table was never widened.
    mustPass: [
      /stood down in split view/,
      /never overlaps the editor pane in split view/,
      /the split-view scenario starts from a widened table/,
    ],
  },
  {
    id: "R56",
    what: "do not recalculate when leaving split view (table stays sized for the narrow viewer)",
    file: RENDERER,
    from: "    applyTableBreakout();\n    toggleEditBtn.style.background = '';",
    to: "    toggleEditBtn.style.background = '';",
    // Vacuous against the settled assertion for the same reason as R55: the
    // ResizeObserver backstop restores the width ~140ms later and the settled
    // assertion waits 500ms. Pinned synchronously instead.
    expect: [/leaving split view restores the widened width at the transition/],
    mustPass: [/leaving split view restores the full widened width/],
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
    from: "      m.wanted = Math.max(m.rect * m.overflow, preferred);",
    to: "    m.wanted = m.rect * m.overflow;",
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
  {
    id: "R86",
    suite: "test:tabs",
    what: "send the textarea on save regardless of mode (in view mode it is stale, so a view-mode edit plus Ctrl+Z plus Ctrl+S writes the undone content to disk)",
    file: RENDERER,
    from: "    alert(i18n('alert.noFileOpen'));\n    return;\n  }\n\n  const content = isEditMode ? markdownEditor.value : originalMarkdown;",
    to: "    alert(i18n('alert.noFileOpen'));\n    return;\n  }\n\n  const content = markdownEditor.value;",
    expect: [/saving in view mode writes the content on screen/],
  },
  {
    // The other half of the same defect, and separately reachable: even with
    // the correct bytes on disk, copying the textarea back over
    // originalMarkdown discards the saved document in memory.
    id: "R87",
    suite: "test:tabs",
    what: "resync originalMarkdown from the textarea after every successful save, including view-mode saves",
    file: RENDERER,
    from: "      if (entry && !storeMovedDuringWrite) {\n        originalMarkdown = entry.content;\n      } else if (!entry && isEditMode) {",
    to: "      if (false) {\n        originalMarkdown = entry.content;\n      } else if (true) {",
    expect: [/a successful view-mode save does not overwrite the in-memory document/],
  },
  {
    // Exiting edit mode used to promise a discard and not perform one, leaving
    // the typing in the textarea, the dirty flag set and the preview showing
    // content `originalMarkdown` did not hold. Re-entering then destroyed the
    // typing and reported "clean".
    id: "R88",
    suite: "test:tabs",
    what: "leave the unsaved editor buffer in place when exiting edit mode instead of discarding it",
    file: RENDERER,
    from: "    if (discardOnExit) {",
    to: "    if (false && discardOnExit) {",
    expect: [
      /exiting edit mode discards the unsaved edit from every store/,
      /the preview is repainted from the saved content/,
    ],
  },
  {
    // A discard that leaves its own undo entries behind is not a discard: one
    // Ctrl+Z puts the text back into the document, with no dirty indicator.
    id: "R89",
    suite: "test:tabs",
    what: "keep the discarded edit session's undo entries, so Ctrl+Z resurrects discarded content",
    file: RENDERER,
    from: "        historyRestore(baseline.history);",
    to: "        void baseline.history;",
    expect: [/undo cannot resurrect discarded content/],
  },
  {
    // The bug BOTH reviewers found independently, kept as a permanent trap.
    // Rolling the history back by counting pushes looks equivalent to restoring
    // a snapshot, and is - right up until the session uses undo or redo, which
    // move entries between the stacks without going through historyPush. Then
    // the count over-drops and eats an undo point made BEFORE the session.
    // Scenario 7 only catches this because it undoes twice and redoes once
    // inside the session; with straight-line typing the two implementations
    // agree and this revert would pass.
    id: "R91",
    suite: "test:tabs",
    what: "roll the history back by counting the session's pushes instead of restoring the snapshot taken when the session started",
    file: RENDERER,
    from: "        historyRestore(baseline.history);",
    to: "        const sessionPushes = 2;\n        undoHistory.length = Math.max(0, undoHistory.length - sessionPushes);\n        redoHistory = [];",
    expect: [/undo cannot resurrect discarded content, and older undo points survive/],
  },
  {
    // The document baseline is what makes the discard survive a tab round
    // trip. Restoring "from originalMarkdown" looks equivalent and is not:
    // switchToTab seeds that global from tab.content, which by then carries
    // the session's own unsaved text.
    id: "R92",
    suite: "test:tabs",
    what: "restore the discard from originalMarkdown instead of the baseline captured when the session started",
    file: RENDERER,
    from: "        historyRestore(baseline.history);\n        originalMarkdown = baseline.document;\n        hasUnsavedChanges = baseline.dirty;",
    to: "        historyRestore(baseline.history);\n        hasUnsavedChanges = baseline.dirty;",
    expect: [/discarding after a tab round trip does not restore the discarded text/],
  },
  {
    // Fixing only the renderer's globals is not enough: the tab record keeps
    // its own copy and the next switch seeds the globals back from it.
    id: "R93",
    suite: "test:tabs",
    what: "leave the discarded text in the tab record, so the next tab switch replays it",
    file: RENDERER,
    from: "      if (activeTab && window.CustomTabs.updateTabContent) {",
    to: "      if (false && activeTab && window.CustomTabs.updateTabContent) {",
    expect: [/a later tab switch cannot replay the discarded text from the tab record/],
  },
  {
    // Without the hook only the tab the session STARTED on has a baseline, so
    // discarding on any other tab degrades to "keep the text, mark it clean".
    id: "R94",
    suite: "test:tabs",
    what: "skip re-baselining when the active document changes while edit mode stays on",
    file: TABS,
    from: "    if (window.isEditMode && window.rebaseEditSession) {\n      window.rebaseEditSession();\n    }",
    to: "    /* baseline not rebased on tab switch */",
    expect: [/undo cannot resurrect content discarded on a tab the session did not start on/],
  },
  {
    // Raised by GPT-5.4 while reviewing the discard, then measured: Save
    // dispatches an async write and clears nothing, so an Exit inside that
    // window warned that the changes would be DISCARDED - right after the user
    // asked to save them - and then discarded them in the renderer while the
    // main process wrote them to disk. File and app held different documents.
    id: "R95",
    suite: "test:tabs",
    what: "exit edit mode without waiting for an in-flight save to come back",
    file: RENDERER,
    from: "  if (isEditMode) {\n    const inFlight = pendingSaveFor(currentFilePath);",
    to: "  if (false) {\n    const inFlight = pendingSaveFor(currentFilePath);",
    expect: [
      /exiting during a save does not warn that the changes will be discarded/,
      /the document the app shows after a save-then-exit is the document on disk/,
    ],
  },
  {
    // The write persisted the bytes it was HANDED. Re-reading the textarea when
    // the reply lands adopts anything typed since, so `originalMarkdown` starts
    // describing a document that was never written to disk.
    id: "R96",
    suite: "test:tabs",
    what: "resync the document store from the textarea after a save instead of from the bytes that were written",
    file: RENDERER,
    from: "      if (entry && !storeMovedDuringWrite) {\n        originalMarkdown = entry.content;",
    to: "      if (false) {\n        originalMarkdown = entry.content;",
    expect: [
      /after a save the document store holds the bytes that were written, not later keystrokes/,
    ],
  },
  {
    // Declaring the document clean when keystrokes arrived during the write
    // hides genuinely unsaved bytes, which the next exit then discards without
    // warning - the dirty flag is what the whole discard path keys off.
    id: "R97",
    suite: "test:tabs",
    what: "declare the document clean after a save even if it was typed into while the write was in flight",
    file: RENDERER,
    from: "      hasUnsavedChanges = isEditMode\n        ? markdownEditor.value !== originalMarkdown\n        : storeMovedDuringWrite;",
    to: "      hasUnsavedChanges = false;",
    expect: [/keystrokes made during a save are still reported as unsaved/],
  },
  {
    // Both reviewers found this independently. custom-tabs.js owns the
    // save-markdown-result channel and used to drop replies for background
    // documents, which stranded the promise the exit path waits on.
    id: "R98",
    suite: "test:tabs",
    what: "swallow save results for background documents instead of passing every result to the renderer",
    file: TABS,
    from: "      if (!isForCurrent) {\n        console.log(\"[CustomTabs] Save result is for a background tab:\", data.path);\n      }\n      rendererSaveHandlers.forEach((fn) => {",
    to: "      if (!isForCurrent) return;\n      rendererSaveHandlers.forEach((fn) => {",
    expect: [
      /a save whose reply arrived on another tab is not offered for discard on return/,
    ],
  },
  {
    // The renderer's own half of the same problem: a reply that describes a
    // background document must not be written into the stores, which describe
    // the document on screen.
    id: "R99",
    suite: "test:tabs",
    what: "apply every save result to the document currently on screen, whichever document was written",
    file: RENDERER,
    from: "  const isForCurrent = !savedPath || savedPath === currentFilePath;",
    to: "  const isForCurrent = true;",
    expect: [
      /a save that completes for a background document is not applied to the document on screen/,
    ],
  },
  {
    // Opus found this one alone: the baseline records the dirty flag, and
    // capturing it before switchToTab moves that flag bakes in the PREVIOUS
    // tab's unsaved state.
    id: "R100",
    suite: "test:tabs",
    what: "capture the arriving tab's edit baseline before its unsaved state has been restored",
    file: TABS,
    from: "    if (window.setUnsavedState) {\n      window.setUnsavedState(tab.hasUnsavedChanges);\n    }\n\n    if (window.isEditMode && window.rebaseEditSession) {\n      window.rebaseEditSession();\n    }",
    to: "    if (window.isEditMode && window.rebaseEditSession) {\n      window.rebaseEditSession();\n    }\n\n    if (window.setUnsavedState) {\n      window.setUnsavedState(tab.hasUnsavedChanges);\n    }",
    expect: [
      /discarding on a clean tab does not inherit the previous tab's unsaved state/,
    ],
  },
  {
    // Both reviewers, again independently: a reload replaces the document
    // underneath an open session, so a discard afterwards rolls the reload back
    // as well - the user's original complaint reappearing by another route.
    id: "R101",
    suite: "test:tabs",
    what: "leave the edit-session baseline on the pre-reload document when a file is reloaded mid-session",
    file: RENDERER,
    from: "      // The reload replaced the document underneath an open edit session, so\n      // the session's baseline now describes content that is no longer on\n      // disk. Without moving it, exiting with a discard would restore the\n      // PRE-reload text and silently undo the reload as well.\n      captureEditSessionBaseline(true);",
    to: "      /* baseline not moved on reload */",
    expect: [
      /discarding after a reload restores the reloaded document, not the pre-reload text/,
    ],
  },
  {
    // Found by a test written for a different reason: two concurrent writes to
    // one path are ordered by the OS, and the older content won.
    id: "R102",
    suite: "test:tabs",
    what: "write concurrent saves to the same file without serialising them",
    file: MAIN,
    from: "    queueSave(filePath, () => new Promise((done) => {",
    to: "    Promise.resolve().then(() => new Promise((done) => {",
    expect: [
      // NOT the disk outcome. Which write lands last without queueSave is
      // decided by the OS, so an outcome-based expectation reports VACUOUS
      // whenever the scheduler happens to cooperate - which is exactly what
      // this entry did. Overlap is a property of the code: with the fix
      // removed both writes are open at once, every time.
      /two saves to one path are serialised: their writes never overlap/,
    ],
  },
  {
    // The warning has to name the consequence; "Exit edit mode anyway?" reads
    // like the changes are kept somewhere.
    id: "R90",
    suite: "test:tabs",
    what: "warn about unsaved changes without saying they will be discarded",
    file: RENDERER,
    from: "'confirm.unsavedExit': 'You have unsaved changes. Exiting edit mode will DISCARD them. Exit anyway?'",
    to: "'confirm.unsavedExit': 'You have unsaved changes. Exit edit mode anyway?'",
    expect: [/the exit warning states that the changes will be discarded/],
  },
  // --- Upstream 03b5423, evaluated and partly taken (item 6f) --------------
  {
    // Measured before porting: with suppressErrors:false, a document holding
    // one valid and one unparseable diagram left the VALID diagram with no
    // .mermaid-container and no pop-out button, because the throw jumped past
    // the maximize-button loop that runs after the batch.
    id: "R103",
    suite: "test:mermaid",
    what: "let one invalid diagram abort the whole render batch again",
    file: RENDERER,
    from: "          await mermaid.run({ nodes: toRender, suppressErrors: true });",
    to: "          await mermaid.run({ nodes: toRender, suppressErrors: false });",
    expect: [/keeps its pop-out button when a sibling fails/],
    // If mermaid.run happens to throw BEFORE the good diagram is drawn, the good
    // one has no SVG, the fix assertion short-circuits, and R103 would report
    // PROVEN having demonstrated nothing about pop-out buttons.
    mustPass: [/13a fixture really does mix one rendered diagram with one failure/],
  },
  {
    // The theme path's catch falls back to a FULL re-render, so the same throw
    // makes every dark/light toggle re-render the document.
    id: "R104",
    suite: "test:mermaid",
    what: "let one invalid diagram abort the re-theme batch again",
    file: RENDERER,
    from:
      "    // theme toggle for as long as the bad diagram is in the document.\n" +
      "    await mermaid.run({ nodes: toRender, suppressErrors: true });",
    to:
      "    // theme toggle for as long as the bad diagram is in the document.\n" +
      "    await mermaid.run({ nodes: toRender, suppressErrors: false });",
    expect: [
      /does not re-render the whole document just because a diagram is invalid/,
    ],
    mustPass: [
      // R104 only fails because the catch's fallback re-render actually fires,
      // and that fallback is guarded on the document store being non-empty -
      // which 13d supplies by assigning `window.originalMarkdown`. If that seed
      // ever stopped reaching the renderer's own binding, the fallback would not
      // fire, `fullRenders` would stay 0, and R104 would go VACUOUS with the
      // defect fully present. These two assertions fail loudly in that case.
      /13d's render observable is still the synchronous first statement/,
      /window\.originalMarkdown really writes through to the renderer's own binding/,
    ],
  },
  {
    // error.message quotes the diagram SOURCE back, so an innerHTML assignment
    // here is a document-controlled HTML sink in the privileged renderer.
    id: "R105",
    suite: "test:mermaid",
    what: "write the mermaid error message back into innerHTML",
    file: RENDERER,
    from: "        el.replaceChildren(buildMermaidErrorBanner(error));",
    to:
      "        el.innerHTML = '<div style=\"color:red\"><strong>Mermaid Rendering Error:</strong><br>' +\n" +
      "          error.message + '</div>';",
    expect: [/renders a hostile message as text, not as markup/],
    mustPass: [/13b2 the forced throw really reached the error banner/],
  },
  {
    // Same sink, different call site. R105's anchor names the variable `error`
    // and this one names it `err`, so neither can match the other's line.
    id: "R105b",
    suite: "test:mermaid",
    what: "write the single-diagram error message back into innerHTML",
    file: RENDERER,
    from: "    mermaidEl.replaceChildren(buildMermaidErrorBanner(err));",
    to:
      "    mermaidEl.innerHTML = '<div style=\"color:red\"><strong>Mermaid Rendering Error:</strong><br>' +\n" +
      "      err.message + '</div>';",
    // Both legs, and this is the point of the split: R110 can only pin the
    // FLAG (13e, direct entry), while this revert pins the SINK on BOTH the
    // direct entry and the real dialog path. Listing 13e2 here is what makes
    // "13e2 covers the product path" a proven claim rather than a comment.
    expect: [
      /single-diagram error path renders a hostile message as text/,
      /dialog insert error path renders a hostile message as text/,
    ],
    // Distinguishes this proof from R110's, which breaks the same assertion for
    // a different reason (no message at all rather than an injected one).
    mustPass: [
      /13e the invalid diagram really reached the single-diagram error path/,
      /13e2 the real dialog path reached the single-diagram error banner/,
      // 13e2's remaining precondition. It is an ordinary suite assertion
      // already, but listing it here makes it fail as COLLATERAL during a
      // proof run rather than only in a normal run: if the scenario stops
      // marking the document dirty, this revert's proof is measuring a
      // scenario that no longer does what its name claims.
      /a dialog insert marks the document unsaved even when the diagram fails/,
    ],
  },
  {
    // The dialog is pre-filled with the DOCUMENT's own diagram source on Edit,
    // so mermaid.render()'s rejection quotes document text back into this
    // element. Pre-existing sink, found in review of this change, fixed with it.
    id: "R109",
    suite: "test:mermaid",
    what: "write the dialog validation error back into innerHTML",
    file: RENDERER,
    from: "      mermaidTemplatePreviewEl.replaceChildren(buildMermaidPreviewError(err, fallback));",
    to: "      mermaidTemplatePreviewEl.innerHTML = '<span class=\"mermaid-preview-error\">' + (err && err.message ? err.message : fallback) + '</span>';",
    expect: [/dialog preview renders a hostile message as text/],
    mustPass: [/13f the dialog validation path really rejected and reported/],
  },
  {
    // Rule 5: the DECISION to keep suppressErrors:false at the one-diagram call
    // site is only recorded if flipping it breaks something named. The first
    // version of this entry expected the RE-ATTACH to break, on the strength of
    // the comment that was in the code. It came back WRONG-GUARD: reattached
    // stayed true. What actually breaks is the diagnosis - the user gets a
    // silent block instead of a banner naming what is wrong with the diagram
    // they just typed. Comment corrected, expectation repointed at what was
    // measured rather than at what was assumed.
    id: "R110",
    suite: "test:mermaid",
    what: "suppress errors at the single-diagram site too (the catch then never reports the failure)",
    file: RENDERER,
    from: "      await mermaid.run({ nodes: [mermaidEl], suppressErrors: false });",
    to: "      await mermaid.run({ nodes: [mermaidEl], suppressErrors: true });",
    expect: [/13e the invalid diagram really reached the single-diagram error path/],
    mustPass: [
      // 13e2 must NOT fail here, and that is a measured property rather than an
      // omission. It patches `mermaid.run` wholesale to throw, so the option
      // this revert flips is never consulted on that leg - the throw is the
      // test double's, not mermaid's. 13e2 therefore pins the SINK on the real
      // dialog path (R105b proves it there) while 13e is the only leg that can
      // pin the FLAG. Listing it here makes that split explicit, so a future
      // edit that accidentally makes 13e2 flag-sensitive shows up as a
      // COLLATERAL verdict instead of quietly widening what R110 claims.
      /13e2 the real dialog path reached the single-diagram error banner/,
    ],
  },
  {
    // Rule 5 again, for the hunk of 03b5423 that was REJECTED. Upstream's rule
    // is a stated mermaid 10.6.1 workaround; on 11.16.0 it is a hard-coded grey
    // with !important that beats themeVariables.actorLineColor. Every "are the
    // lifelines drawn" assertion passes with it applied - which is exactly why
    // the theme-tracking assertion had to exist before this could be pinned.
    id: "R108",
    suite: "test:mermaid",
    what: "take upstream's actor-lifeline !important override (rejected: freezes the theme colour)",
    file: CSS,
    // Anchored to the marker comment that RECORDS the rejection, not to an
    // unrelated section header. The comment is the artifact being defended, the
    // same way R106/R107's are: delete it and SETUP-FAILED is the right answer.
    from: "   REJECTION IS PINNED: test-mermaid-render.js scenario 13c, revert R108. */",
    to:
      "   REJECTION IS PINNED: test-mermaid-render.js scenario 13c, revert R108. */\n" +
      ".mermaid line[id^=\"actor\"] {\n" +
      "  stroke: #888 !important;\n" +
      "  stroke-width: 1.5px !important;\n" +
      "}\n" +
      "body.dark-mode .mermaid line[id^=\"actor\"] {\n" +
      "  stroke: #777 !important;\n" +
      "}",
    expect: [/lifeline colour still follows the mermaid theme/],
    mustPass: [/the sequence fixture produced actor lifelines to measure/],
  },
  {
    // Promoting the viewport rasterizes the SVG once and stretches that bitmap.
    id: "R106",
    suite: "test:popups",
    what: "promote the mermaid pop-out viewport to its own composited layer again",
    file: MAIN,
    from: "            /* No will-change here, deliberately. Promoting the viewport to its",
    to: "            will-change: transform;\n            /* No will-change here, deliberately. Promoting the viewport to its",
    expect: [/mermaid pop-out renders crisply at 600%/],
    mustPass: [/sharpness: the mermaid pop-out opened/],
  },
  {
    // Beyond upstream: the image pop-out is not raster-only, because
    // safeImageSrc() admits data:image/svg+xml and .svg paths.
    id: "R107",
    suite: "test:popups",
    what: "promote the image pop-out viewport to its own composited layer again",
    file: MAIN,
    from: "      /* will-change is deliberately absent here too - see the mermaid popup for",
    to: "      will-change: transform;\n      /* will-change is deliberately absent here too - see the mermaid popup for",
    expect: [/image pop-out renders vector content crisply at 600%/],
    mustPass: [/sharpness: the image pop-out opened/],
  },

  // ----------------------------------------------------------------------
  // Folia rebrand + review findings. Not table work, but this is the
  // project's only permanent revert harness and a proof that lives in a
  // throwaway script is a proof that expires the moment the script is
  // deleted - which is precisely how these fixes could be reintroduced
  // silently later.
  // ----------------------------------------------------------------------
  {
    // On Windows the taskbar, jump list, pinning and toasts identify the app
    // by AppUserModelID, not by window title, so a rename that stops here
    // leaves the app grouping and notifying under the old identity.
    id: "R111",
    suite: "test:packaging",
    what: "drop the explicit setAppUserModelId call",
    file: MAIN,
    from: "    if (appId) app.setAppUserModelId(appId);",
    to: "    void appId;",
    expect: [/sets an explicit AppUserModelId/],
  },
  {
    id: "R112",
    suite: "test:packaging",
    what: "hardcode the AppUserModelId instead of deriving it from build.appId",
    file: MAIN,
    from: '    const { appId } = require("./package.json").build;\n    if (appId) app.setAppUserModelId(appId);',
    to: '    const appId = "io.github.lostinsea.folia";\n    if (appId) app.setAppUserModelId("io.github.lostinsea.folia");',
    expect: [/read from build\.appId rather than duplicated/],
    mustPass: [/sets an explicit AppUserModelId/],
  },
  {
    // Chromium marks a fully covered window hidden and suspends its layout, so
    // renderer-side window metrics go stale while getContentBounds() keeps
    // tracking. Measured A/B: covered window reported document.hidden=true and
    // a resize to 1900 left outerWidth frozen at 1200.
    id: "R113",
    suite: "test:visual",
    what: "never apply the occlusion switches at all",
    file: VISUAL,
    from: "if (app && app.commandLine && !app.isReady()) {",
    to: "if (false) {",
    // Neutralises the whole block, so both switch assertions fail. Declared
    // rather than narrowed: the alternative is weakening one of two
    // assertions that cover the same block from different angles.
    expect: [
      /native window occlusion is disabled/,
      /backgrounding are disabled too/,
    ],
  },
  {
    // Measured, not assumed: appendSwitch("disable-features", A) followed by
    // appendSwitch("disable-features", B) leaves B ALONE. A naive second
    // append therefore silently discards whatever Electron already disabled.
    id: "R114",
    suite: "test:visual",
    what: "merge disabled features by clobbering, as a naive appendSwitch would",
    file: VISUAL,
    from: "  for (const f of wanted) if (!seen.includes(f)) seen.push(f);\n  return seen.join(\",\");",
    to: "  return wanted.join(\",\");",
    expect: [/merging preserves features/],
  },
  {
    id: "R115",
    suite: "test:visual",
    what: "drop the two boolean backgrounding switches",
    file: VISUAL,
    from: '    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");\n    app.commandLine.appendSwitch("disable-renderer-backgrounding");',
    to: "    void 0;",
    expect: [/backgrounding are disabled too/],
    mustPass: [/native window occlusion is disabled/],
  },
  {
    // This checkout carries three remotes and two are other people's
    // repositories, so an unpinned `gh release delete --yes` can destroy
    // releases on the vendor's project.
    id: "R116",
    suite: "test:packaging",
    what: "unpin the destructive gh release delete from an explicit --repo",
    file: RELEASE,
    from: "exec(`gh release delete ${tag} ${ghRepo} --yes`",
    to: "exec(`gh release delete ${tag} --yes`",
    expect: [/pinned to an explicit --repo/],
  },
  {
    // The --repo pin covers `gh`, not `git`. Deleting a REMOTE tag targets
    // `origin`, which is not guaranteed to be the repo package.json names.
    id: "R117",
    suite: "test:packaging",
    what: "delete the remote tag without checking which repo origin is",
    file: RELEASE,
    from: "    const originSlug = remoteSlug('origin');",
    to: "    const originSlug = repo;",
    expect: [/verifies origin against the package\.json repo/],
  },
  {
    // A native-Windows host cannot build Linux artifacts, so hardcoded notes
    // published download instructions for two files never uploaded.
    id: "R118",
    suite: "test:packaging",
    what: "hardcode the Linux downloads in the release notes",
    file: RELEASE,
    from: "if (appImage) downloads.push(",
    to: "if (true) downloads.push(",
    expect: [/do not offer Linux downloads that were not built/],
    mustPass: [/name the Windows installer that was collected/],
  },
  {
    id: "R119",
    suite: "test:packaging",
    what: "advertise Linux artifacts in the dry-run list unconditionally",
    file: RELEASE,
    from: "    if (willBuildLinux()) {\n      expectedArtifacts.push(`Folia-${version}.AppImage`);",
    to: "    if (true) {\n      expectedArtifacts.push(`Folia-${version}.AppImage`);",
    expect: [/advertises Linux builds only where they can be produced/],
    mustPass: [/willBuildLinux\(\) agrees with the host/],
  },
  {
    // dist/ is never cleaned, so a previous version's installer matches the
    // same patterns and gets attached to the release under a name that looks
    // right.
    id: "R120",
    suite: "test:packaging",
    what: "upload every matching file in dist/, including a previous version's",
    file: RELEASE,
    from: "          if (!file.includes(version) && !/^latest.*\\.yml$/i.test(file)) {",
    to: "          if (false) {",
    expect: [/ignores a previous version left in dist/],
    mustPass: [/collects this version's files/],
  },
  {
    // A plain recursive copy writes the destination incrementally, so an
    // interruption leaves a TRUNCATED file; the next launch sees it exists,
    // force:false skips it, and the sentinel blesses the corrupt profile
    // permanently.
    id: "R121",
    suite: "test:migration",
    what: "copy the legacy profile straight into the target instead of staging it",
    file: MAIN,
    from: "    moveTreeNoClobber(staging, target);",
    to: "    fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });",
    expect: [/reaches the profile by an atomic rename/],
  },
  {
    id: "R122",
    suite: "test:migration",
    what: "stage, but copy into place instead of renaming (truncation window returns)",
    file: MAIN,
    from: "      fs.renameSync(src, dst);",
    to: "      fs.copyFileSync(src, dst);",
    expect: [
      /reaches the profile by an atomic rename/,
      /non-atomic copy/,
    ],
  },
  {
    id: "R123",
    suite: "test:migration",
    what: "merge stale staging debris from a dead run into the profile",
    file: MAIN,
    from: "    fs.rmSync(staging, { recursive: true, force: true });\n    fs.cpSync(legacy, staging,",
    to: "    fs.cpSync(legacy, staging,",
    expect: [/wiped rather than merged/],
  },
  {
    id: "R124",
    suite: "test:migration",
    what: "leave the staging area behind after a successful migration",
    file: MAIN,
    from: "    moveTreeNoClobber(staging, target);\n    fs.rmSync(staging, { recursive: true, force: true });",
    to: "    moveTreeNoClobber(staging, target);",
    expect: [/staging area does not survive/],
  },
  {
    // The user's report: with the table of contents open there was no way to
    // scroll the document. The scroller and its 16px gutter are unchanged -
    // the absolutely positioned drawer simply PAINTS over the scrollbar, which
    // only elementFromPoint can see.
    id: "R125",
    what: "let the ToC drawer overlay the scroller instead of narrowing it",
    file: CSS,
    from: ".content-wrapper:has(> #indexPanel.visible) {\n  margin-right: var(--toc-width);",
    to: ".content-wrapper:has(> #indexPanel.visible) {\n  margin-right: 0;",
    expect: [
      /does not paint over the document scrollbar in normal view/,
      /does not paint over the document scrollbar in split view/,
      /scroller ends at or before the ToC panel/,
      /re-measures breakout tables instead of clipping them under it/,
    ],
    mustPass: [
      /really opened the panel and split view really engaged/,
      /scrollable, scrollbar-bearing scroller/,
    ],
  },
  {
    // Narrowing the scroller changes how much space a table has, and a class
    // toggle fires no `resize`. Without the observer a broken-out table keeps
    // its full-window width and is silently clipped by .content-wrapper's
    // overflow-x: hidden the moment the drawer opens.
    id: "R126",
    what: "stop re-measuring breakout when the scroller itself changes width",
    file: RENDERER,
    from: "if (typeof ResizeObserver === 'function') {\n  const scrollerHost = document.querySelector('.content-wrapper');",
    to: "if (false) {\n  const scrollerHost = document.querySelector('.content-wrapper');",
    expect: [/re-measures breakout tables instead of clipping them under it/],
    mustPass: [
      /a widened table was on screen to be squeezed by the drawer/,
      /does not paint over the document scrollbar in normal view/,
    ],
  },
  {
    // Re-aimed after measurement. This entry used to move the notices file
    // above `!**/*.md` in build.files, on the theory that its position there
    // was what shipped it. A probe build (four planted files, one per
    // position) showed BOTH halves of that theory were half-right and the
    // conclusion was wrong: ordering IS honoured (a probe after the negation
    // reaches the asar, one before it does not), but a file that is also an
    // extraResources source is REMOVED from the asar so it is not shipped
    // twice. The build.files entry was therefore inert, and a revert of inert
    // configuration can only ever be vacuous. extraResources is the whole
    // mechanism, so that is what this now neutralises - and the file then
    // ships nowhere at all.
    id: "R127",
    suite: "test:packaging",
    what: "ship an installer with no third-party notices in it",
    file: PKG,
    from: '        "from": "THIRD-PARTY-NOTICES.md",',
    to: '        "from": "README.md",',
    expect: [/notices file ships unpacked in resources/],
    mustPass: [/committed notices file is not stale/],
  },
  {
    // The real historical state: upstream carried LICENSE at 2025 and
    // LICENSE.txt at 2026, and nothing noticed because nothing compared them.
    // Only LICENSE.txt is packaged and shown by the NSIS installer, so the
    // copy a user actually agrees to was the one nobody was reading.
    id: "R128",
    suite: "test:packaging",
    what: "let LICENSE.txt drift away from LICENSE again",
    file: LICENSE_TXT,
    // Deliberately a single-line anchor. LICENSE/LICENSE.txt are stored LF in
    // the index and checked out CRLF only where core.autocrlf=true, so an
    // anchor spanning a line break would match on Windows and silently
    // SETUP-FAIL on a Linux CI checkout - proving the fix on one platform only.
    from: "Copyright (c) 2025-2026 Omnicore",
    to: "Copyright (c) 2026 Omnicore",
    expect: [/LICENSE and LICENSE\.txt have not drifted apart/],
    mustPass: [
      /LICENSE retains the upstream copyright/,
      /LICENSE also asserts the fork's own copyright/,
    ],
  },
  {
    // MIT grants the right to redistribute ON CONDITION that the original
    // copyright notice is retained. Replacing the upstream line with the
    // fork's own - the obvious thing to do when rebranding - is precisely the
    // move the licence forbids.
    id: "R129",
    suite: "test:packaging",
    what: "drop the upstream copyright when rebranding, as MIT forbids",
    file: LICENSE_MD,
    // Single-line anchor, for the portability reason given on R128. Replacing
    // the upstream line with the fork's own is exactly the rebrand mistake
    // being guarded against, and it leaves no Omnicore attribution at all.
    from: "Copyright (c) 2025-2026 Omnicore",
    to: "Copyright (c) 2026 Folia contributors",
    expect: [
      /LICENSE retains the upstream copyright/,
      /LICENSE and LICENSE\.txt have not drifted apart/,
    ],
    mustPass: [/LICENSE also asserts the fork's own copyright/],
  },
  {
    // A generated file that is committed is a cache, and a cache with no
    // invalidation goes stale silently. Adding or upgrading a dependency
    // without regenerating leaves the shipped notices describing a tree that
    // is no longer the one in the installer.
    id: "R130",
    suite: "test:packaging",
    what: "let the committed notices drift from the installed dependency tree",
    file: NOTICES,
    from: "# Third-party notices",
    to: "# Third-party notices (stale copy)",
    expect: [/committed notices file is not stale/],
    mustPass: [
      /every production dependency in package-lock\.json has a notice/,
      /vendored Tabulator is documented/,
    ],
  },
  {
    // Proves the VENDORED-coverage oracle is live rather than decorative, and
    // it has to perturb the GENERATOR rather than the committed file: that
    // oracle reads `documentedNames(regenerated)`, so editing
    // THIRD-PARTY-NOTICES.md by hand cannot reach it. R131 used to try exactly
    // that (it removed dompurify's heading from the committed file) and could
    // only ever fail the staleness check - it named an assertion it was
    // structurally incapable of breaking.
    //
    // Dropping prismjs from VENDORED_ROOTS reproduces the 8b defect exactly.
    // prismjs is the right subject and that was MEASURED by driving the
    // generator's own closure - each root removed in turn, then collect() and
    // render() compared against the baseline. The four roots behave in three
    // different ways, and only one of them reaches the coverage oracle:
    //
    //   drop dompurify -> 0 names lost, rendered text BYTE-IDENTICAL. mermaid
    //     declares `dompurify ^3.3.3` and there is no nested copy, so the
    //     top-level package is reachable from mermaid regardless of this list.
    //     Fully vacuous, and the first attempt at this entry used it.
    //   drop marked -> 0 names lost, but `marked 9.1.6` lost. mermaid resolves
    //     to its OWN nested marked 16.4.2, so the top-level 9.1.6 really is
    //     held here alone - but the coverage oracle strips versions, so the
    //     name stays documented by the nested copy and only the staleness
    //     check would fire. A half-subject: it cannot prove the assertion this
    //     entry exists for.
    //   drop mermaid -> 109 headings lost. It collapses the whole closure
    //     (marked and dompurify with it), so the failure would not identify
    //     what broke.
    //   drop prismjs -> exactly one name and one heading lost.
    //
    // prismjs is reachable from nothing, is a devDependency so the lockfile's
    // non-dev walk never sees it, and is COMMITTED under libs/prismjs/ rather
    // than copied by vendor-libs.js, so this list is the only thing putting it
    // in the notices while its code goes on shipping.
    //
    // The marked case is the one worth keeping: an earlier version of this
    // comment claimed marked was "reachable transitively" from mermaid, which
    // is FALSE - it was derived from a name-keyed BFS instead of npm's
    // nearest-node_modules rule, i.e. the exact mistake resolveLockKey() exists
    // to prevent. Measure the closure with the closure code, never with a
    // hand-rolled walk beside it.
    //
    // It also exercises the deliberately MONOTONIC scope: the oracle unions the
    // generator's list with the one discovered from libs/ and vendor-libs.js,
    // so shrinking VENDORED_ROOTS shrinks what is documented without shrinking
    // what is checked, which is the whole point of that union.
    id: "R131",
    suite: "test:packaging",
    what: "drop a vendored library from the generator's roots while its code still ships",
    file: path.join(ROOT, "scripts", "generate-notices.js"),
    from: '  "prismjs",\n',
    to: "",
    expect: [
      /every library vendored into libs\/ has a notice/,
      /committed notices file is not stale/,
    ],
    mustPass: [
      /the vendoring oracle is policing the libraries that actually ship/,
      /vendored Tabulator is documented/,
      /Fira Code is documented/,
    ],
  },
  {
    // The sibling oracle, and it needs its own subject. R131 used to name this
    // assertion too and could never fail it: it removes dompurify's heading,
    // and dompurify has not been a production dependency since 8b. The pin read
    // as sound for as long as nobody re-ran it - a revert that names an
    // assertion it cannot break is the same class of defect as a vacuous test.
    //
    // lazy-val is a real transitive production dependency (electron-updater ->
    // builder-util-runtime -> lazy-val), it is not vendored, and no other
    // assertion names it, so the failure is unambiguous.
    //
    // That chain is what makes the anchor stable, so it is also what would rot
    // it: if electron-updater ever leaves the tree, this pin needs retargeting
    // at whatever non-dev package survives. It fails LOUD when that happens -
    // a missing anchor is SETUP-FAILED, not a silent pass - but the signal only
    // arrives when the harness is next run, so retarget it in the same change
    // rather than waiting to be told.
    //
    // The version is deliberately left OFF the anchor. The coverage oracle's
    // heading regex strips a trailing version, so `### (removed-prod) 1.0.5`
    // documents a package called "(removed-prod)" and the assertion fires - and
    // an upgrade of lazy-val cannot rot the anchor.
    id: "R131b",
    suite: "test:packaging",
    what: "ship notices with a production dependency missing from them",
    file: NOTICES,
    from: "### lazy-val",
    to: "### (removed-prod)",
    expect: [
      /every production dependency in package-lock\.json has a notice/,
      /committed notices file is not stale/,
    ],
    mustPass: [
      /every library vendored into libs\/ has a notice/,
      /dompurify's reproduced licence text is the one elected/,
    ],
  },
  {
    // The NSIS agreement page is the one licence a Windows user is actually
    // shown. electron-builder resolves this path at build time, so a typo here
    // is a broken installer rather than a broken test.
    id: "R132",
    suite: "test:packaging",
    what: "point the installer agreement at a licence file that does not exist",
    file: PKG,
    from: '"license": "LICENSE.txt"',
    to: '"license": "LICENSE-does-not-exist.txt"',
    expect: [/NSIS installer agreement points at a licence file that exists/],
    mustPass: [/LICENSE and LICENSE\.txt have not drifted apart/],
  },
  {
    // Pointing the marker at the REJECTED limb simulates the real hazard:
    // upstream renaming its licence files so filename order no longer happens
    // to coincide with the election. Simply deleting the marker proves nothing
    // today - the shortest-filename tiebreak selects the same Apache file, so
    // the output is byte-identical and the suite stays green. That is precisely
    // why the coincidence needed replacing with something load-bearing.
    id: "R133",
    suite: "test:packaging",
    what: "select a dual-licensed package's text by something other than the elected licence",
    file: NOTICES_GEN,
    from: '    marker: /\\bApache License\\b/i,',
    to: '    marker: /\\bMozilla Public License\\b/i,',
    expect: [
      /dompurify's reproduced licence text is the one elected/,
      /dompurify does not reproduce the rejected limb's text instead/,
      /committed notices file is not stale/,
    ],
    mustPass: [
      /dompurify's entry names the licence Folia elects/,
      /jszip's reproduced licence text is the one elected/,
    ],
  },
  {
    // The repo has core.autocrlf=true. Unpin the notices file and a fresh
    // checkout gets CRLF while the generator keeps emitting LF, so the
    // byte-for-byte staleness check fails on a clean clone and regenerating
    // cannot fix it.
    id: "R134",
    suite: "test:packaging",
    what: "stop pinning the generated notices to LF under core.autocrlf=true",
    file: ATTRS,
    from: "THIRD-PARTY-NOTICES.md text eol=lf",
    to: "# THIRD-PARTY-NOTICES.md text eol=lf",
    expect: [/\.gitattributes pins the generated notices to LF/],
    mustPass: [
      /committed notices file is LF/,
      /committed notices file is not stale/,
    ],
  },
  {
    // OVER-INCLUSION. The generator originally walked
    // `npm ls --omit=dev --all --parseable`, which reports whatever is on
    // disk INCLUDING extraneous packages left behind by earlier installs.
    // Measured on this machine: 259 packages against the lockfile's 219, with
    // 23 extraneous names among them. One of those, jsdom@30.0.0, was
    // documented in the shipped notices while being absent from the built
    // app.asar - so the file described the developer's workstation rather
    // than the product, and two developers would generate different notices
    // from the same commit. Dropping the dev filter reproduces that class of
    // error from the lockfile side, and the asar - which no part of the
    // generator reads - is what catches it.
    id: "R135",
    suite: "test:packaging",
    what: "document packages that are not in the shipped app.asar",
    file: NOTICES_GEN,
    from: "    if ((meta.dev || meta.devOptional) && !vendored.has(key)) continue;",
    to: "    if (false && !vendored.has(key)) continue;",
    expect: [/notices document nothing that is absent from the built app\.asar/],
    mustPass: [
      /every package inside the built app\.asar has a notice/,
      /vendored Tabulator is documented/,
      /Fira Code is documented/,
    ],
  },
  {
    // The README harvester. Its first version returned null for every package
    // in the tree (`\Z` is not a JavaScript escape, and the heading-level
    // lookahead was inverted), and that presented as "no package happens to
    // state its licence in prose" rather than as a failure - which is why the
    // probe below asserts on a planted README rather than on the real tree.
    id: "R136",
    suite: "test:packaging",
    what: "stop harvesting licence prose from READMEs",
    file: NOTICES_GEN,
    from: "  const atxLevel = (l) => {",
    to: "  const atxLevel = () => 0; const unusedAtxLevel = (l) => {",
    expect: [/README harvester extracts real licence prose/],
    mustPass: [
      /README SPDX declaration reader discriminates/,
      /no shipped package is left with a placeholder/,
    ],
  },
  {
    // Six shipped packages publish no licence file at all, and ten more keep
    // their licence in a LICENSE.md that `!**/*.md` strips out of the
    // packaged app. Without the canonical-text fallback those packages'
    // terms appear nowhere in the distribution, and the notices say so in
    // prose - which is an admission that the condition attached to the grant
    // was not met, not a notice.
    id: "R137",
    suite: "test:packaging",
    what: "leave packages that publish no licence file with a placeholder instead of terms",
    file: NOTICES_GEN,
    from: "      const template = spdx && CANONICAL[spdx];",
    to: "      const template = null;",
    expect: [
      /no shipped package is left with a placeholder/,
      /every component entry reproduces operative licence language/,
    ],
    mustPass: [/README harvester extracts real licence prose/],
  },
  {
    // Records a DECISION rather than guarding a behaviour, in the same way as
    // the deliberately un-widened `ul` gutter. A probe build proved that
    // electron-builder removes a file from the asar when it is also an
    // extraResources source, so listing it in build.files as well is dead
    // configuration that reads as load-bearing - and the earlier revert
    // written against that entry could only ever have been vacuous.
    id: "R138",
    suite: "test:packaging",
    what: "reintroduce the inert build.files entry for an extraResources file",
    file: PKG,
    from: '      "!**/*.md",',
    to: '      "!**/*.md",\n      "THIRD-PARTY-NOTICES.md",',
    expect: [/notices file is not also listed in build\.files/],
    mustPass: [
      /notices file ships unpacked in resources/,
      /committed notices file is not stale/,
    ],
  },
  {
    // Not hypothetical: `git add` REFUSED this file until it was pinned.
    // core.safecrlf blocks staging an LF file on a machine with
    // core.autocrlf=true because the LF -> repo -> CRLF round trip is not
    // reversible. Unpinning it means a fresh clone gets a CRLF copy of the
    // OFL, which breaks the byte-for-byte provenance check and alters the
    // very file OFL clause 2 requires to travel with the font binaries.
    id: "R139",
    suite: "test:packaging",
    what: "let checkout rewrite the line endings of a verbatim third-party licence",
    file: ATTRS,
    from: "assets/fonts/LICENSE-FiraCode.txt text eol=lf",
    to: "# assets/fonts/LICENSE-FiraCode.txt text eol=lf",
    expect: [/pins assets\/fonts\/LICENSE-FiraCode\.txt to LF/],
    mustPass: [
      /pins libs\/tabulator\/LICENSE to LF/,
      /the OFL ships beside the fonts it covers/,
    ],
  },
  {
    // The user reported this one: the app still called itself by its old name
    // in one place. The compact header (< 780px) swapped the title for an
    // abbreviated span reading "MV" - Markdown Viewer - which survived the
    // rename because two letters in markup is not a string anyone greps for.
    // Removing the abbreviation rather than translating it is what makes the
    // class of bug go away: there is now one copy of the name in the markup,
    // and it is checked against package.json rather than against itself.
    id: "R140",
    suite: "test:packaging",
    what: "reintroduce an abbreviated second copy of the product name in the header",
    file: path.join(ROOT, "index.html"),
    from: '<span class="app-title">Folia</span>',
    to: '<span class="app-title">Folia</span>\n            <span class="app-title-short">MV</span>',
    expect: [/header carries no abbreviated second copy of the product name/],
    mustPass: [
      /the visible header title is the product name/,
      /the window title is the product name/,
    ],
  },
  {
    // R141 IS DELETED, and the deletion is the finding. It neutralised the
    // pako entry in the CONJUNCTIVE table and expected the generator to refuse
    // to emit. That stopped being possible the moment Word export went: pako
    // left with html-to-docx's 70-package closure, no conjunctive package
    // remains, and the table is therefore inert - so nothing the revert did
    // could make `assertConjunctiveCovered` fire. It was VACUOUS and reported
    // itself as such.
    //
    // Retargeting it was considered and rejected on a structural ground: the
    // table is only ever read by `collect()`, keyed on a package name found on
    // disk, so it cannot be exercised at all without a real conjunctive
    // dependency installed. A revert cannot supply one. Project precedent for a
    // permanently vacuous entry is deletion (R110b), not a weakened assertion
    // that reads as coverage.
    //
    // Nothing is left unguarded by the deletion, and that is the reason it is
    // safe rather than merely tidy. The property R141 was aimed at - the guard
    // rejects an entry that drops a limb - is covered by the SYNTHETIC guard
    // probe in test-packaging.js, which drives `assertConjunctiveCovered`
    // directly and so is immune to which packages happen to be installed. The
    // pako entry itself is removed from the table with this: it was data for a
    // package that is not in the tree, nothing reads it, and no test could
    // notice it rotting.
    //
    // R142 survives because its subject - the RENDER loop - CAN be driven
    // synthetically, and now is.
    id: "R142",
    suite: "test:packaging",
    what: "collect a conjunctive licence's extra terms but never render them",
    file: path.join(ROOT, "scripts", "generate-notices.js"),
    from: "for (const e of c.extraLicences || []) {",
    to: "for (const e of []) {",
    // The guard being SATISFIED while the output is wrong is the dangerous
    // state, because it is the one that looks fine: `collect()` populates
    // `extraLicences`, `assertConjunctiveCovered` is happy, the generator runs,
    // and a binding limb is silently missing from the notices. Only an
    // assertion on the reproduced TEXT catches it.
    expect: [
      /a conjunctive entry reproduces the operative terms of every limb/,
      /a conjunctive entry states which part of the package the extra terms cover/,
    ],
    mustPass: [
      /the notices generator runs/,
      // The guard must stay green, or this is proving the guard rather than
      // the renderer - which is the distinction the whole entry exists for.
      /the conjunctive-licence guard really rejects an entry that drops a limb/,
      /the conjunctive guard accepts a fully described conjunctive licence/,
      /a conjunctive entry says plainly that no election is made, and claims none/,
      // Narrows the verdict to "the EXTRA limbs were lost". Without this the
      // same two failures would be consistent with the entry collapsing whole.
      /a conjunctive entry still reproduces the primary licence text/,
    ],
  },
  {
    // README.md is not repository prose, it is a SHIPPED surface: extraResources
    // puts it in the installer and the in-app welcome button opens it. Before
    // the rewrite it described the upstream vendor's product by name, which
    // both independent licence reviews rated blocking. The rewrite is not
    // self-defending - prose has no compiler - so the pin is that the title is
    // derived from package.json rather than being a fourth hand-maintained copy
    // of the name.
    id: "R143",
    suite: "test:packaging",
    what: "let the shipped README present the app as the upstream vendor's product",
    file: path.join(ROOT, "README.md"),
    from: "# Folia\n",
    to: "# Omnicore Markdown Viewer\n",
    expect: [/README titles itself with the product name/],
  },
  {
    // The one assertion here that is invisible on GitHub. A relative <img src>
    // renders perfectly in a web view of this file, so nothing about reviewing
    // the README on github.com would reveal the defect - it only appears once
    // the APP opens the file, where baseURI is index.html inside the asar and
    // the image resolves to nothing. Measured: naturalWidth=0 for every
    // relative form, 512 for a data: URI. This revert restores exactly the
    // mistake that is easy to make (a tidy `logo.png` reference instead of a
    // 12 KB blob) and shows the suite refusing it.
    // INVERTED, and the inversion is the point. This used to restore a
    // relative path to prove images had to be EMBEDDED. Since
    // resolveDocumentRelativeImageSrc() the app resolves relative paths
    // itself, and the embedding was what broke GitHub - which strips `data:`
    // from an <img src> - so the README's screenshots were broken icons on the
    // project's own front page while every assertion here passed.
    id: "R144",
    suite: "test:packaging",
    what: "embed a README image as a data: URI, which GitHub silently strips",
    file: path.join(ROOT, "README.md"),
    from: ' alt="Folia" width="100">',
    to: ' alt="Folia" width="100">\n  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Folia">',
    expect: [/no README image is embedded as a data: URI/],
  },
  {
    // The other half of the same rule, and the half that is invisible from
    // GitHub: an image can be perfectly correct in the repository and still be
    // a broken icon in the installed app, because the README ships into
    // resources/ with only what extraResources puts beside it. Points the
    // reference at a real file in a directory extraResources does not ship, so
    // the repo-existence assertion keeps passing and only the shipping one
    // fails - otherwise this would prove nothing more than a typo would.
    id: "R236",
    suite: "test:packaging",
    what: "reference a README image from a directory the installer does not ship",
    file: path.join(ROOT, "README.md"),
    from: '<img src="docs/images/folia.png"',
    to: '<img src="assets/app-icon.png"',
    expect: [/ships beside the installed README/],
    mustPass: [/every README image exists in the repository/],
  },
  {
    // The defect that produced this assertion was MINE, and it survived all
    // 197 assertions that existed at the time: an edit inserting two sections
    // consumed the `## Development` heading, orphaning the install and test
    // commands under the section above. It was caught only by rendering the
    // README in the app and counting <h2> elements.
    id: "R237",
    suite: "test:packaging",
    what: "delete a README section heading, orphaning its body under the section above",
    file: path.join(ROOT, "README.md"),
    from: "## Development\n",
    to: "",
    expect: [/every section the shipped README promises a reader is still present/],
  },
  {
    // The one defect here that is invisible BOTH on GitHub and in the test
    // output of every other suite: a shields.io badge renders perfectly on the
    // web and passes every assertion about branding, wording and versions,
    // while making the app phone a third party each time it opens its own
    // documentation. It was found by driving the real open path and measuring
    // naturalWidth, not by reading the file.
    id: "R145",
    suite: "test:packaging",
    what: "put a remote badge back into the README the app itself opens",
    file: path.join(ROOT, "README.md"),
    from: "# Folia\n",
    to: "# Folia\n\n![License](https://img.shields.io/badge/license-MIT-green)\n",
    expect: [/fetches no images over the network/],
  },
  {
    // The README is offered from the app's welcome screen, so its links are
    // product surface. They resolve against the DOCUMENT's directory, which
    // after installation is resources/ - containing only what extraResources
    // put there. Every one of these links works on GitHub, and the first draft
    // had 7 of 8 dangling in an install, so neither reading the file nor
    // browsing the repository would have caught it. This restores the most
    // deceptive instance: `LICENSE`, which exists in the repo and ships only
    // as `LICENSE.txt`.
    id: "R146",
    suite: "test:packaging",
    what: "link the README at a repository file that does not ship with the app",
    file: path.join(ROOT, "README.md"),
    from: "MIT - see [`LICENSE`](LICENSE.txt).",
    to: "MIT - see [`LICENSE`](LICENSE).",
    expect: [/every relative README link points at a file that ships beside it/],
  },
  {
    id: "R147",
    suite: "test:security",
    what: "resolve relative image sources against document.baseURI again (index.html inside the asar, so a sibling PNG never loads)",
    file: RENDERER,
    // Anchored at the CALL, not inside the resolver: this neutralises the
    // feature wherever the resolver is later refactored to, and cannot rot
    // when its internals change.
    from: "      const resolved = resolveDocumentRelativeImageSrc(raw, currentFilePath);",
    to: "      const resolved = null;",
    expect: [
      /document-relative images load: markdown/,
      /percent-encoded relative images load/,
      /relative image traversing \.\. resolves/,
      /authored src is preserved for the note/,
    ],
  },
  {
    id: "R148",
    suite: "test:security",
    what: "stop recording the authored image src (the note feature rebuilds `![alt](src)` and searches the markdown source for it, so it stops matching)",
    file: RENDERER,
    from: "        node.setAttribute('data-original-src', raw);",
    to: "        void raw;",
    // Deliberately narrow, and that is the point: the images still LOAD under
    // this revert. Only the source-matching contract breaks, which is the half
    // a "does the picture appear" test can never see.
    expect: [/authored src is preserved for the note/],
  },
  {
    id: "R149",
    suite: "test:security",
    what: "search the markdown source for `![alt](src)` and nothing else (marked normalises `<a b.png>` into `a%20b.png`, so the source text never contains the rendered src)",
    file: RENDERER,
    from: "  for (const pattern of markdownImageCandidates(alt, src)) {",
    to: "  for (const pattern of [`![${alt}](${src})`]) {",
    // Both consumers, driven through their real context-menu handlers. This is
    // what makes "the note feature still works" a measured claim
    // rather than an inference from the fact that the image now loads - R148
    // already showed those two properties are independent.
    expect: [
      /add-note-to-image finds an image whose markdown destination marked normalised/,
    ],
  },
  {
    id: "R150",
    suite: "test:security",
    what: "resolve a fragment-only image src too, baking the document's own absolute path into the attribute and into every export made from it",
    file: RENDERER,
    from: "  if (value.startsWith('#')) return null;",
    to: "  if (false) return null;",
    expect: [/fragment-only image src is not resolved/],
  },
  {
    id: "R151",
    suite: "test:packaging",
    what: "derive the notices from the lockfile's non-dev tree alone, so code that ships pre-bundled under libs/ as a devDependency is documented nowhere",
    file: NOTICES_GEN,
    // Neutralise the FUNCTION rather than a line inside it, so the entry
    // survives the body being restructured (the R53 lesson).
    from: "function lockfileClosure(packages, roots) {",
    to: "function lockfileClosure(packages, roots) { if (roots) return new Set();",
    expect: [/every library vendored into libs\/ has a notice/],
  },
  {
    id: "R152",
    suite: "test:packaging",
    // Tabulator is vendored into libs/tabulator/ and is NOT an npm dependency,
    // so no dependency-tree walk can reach it. Before the libs/ oracle was
    // widened, deleting this entry and regenerating simply produced a smaller
    // notices file that every assertion accepted.
    what: "drop the hand-written Tabulator notice, losing the licence for code that ships in libs/tabulator/",
    file: NOTICES_GEN,
    from: '    name: "Tabulator",',
    to: '    name: "TabulatorDropped",',
    expect: [/every library vendored into libs\/ has a notice/],
  },
  {
    id: "R153",
    suite: "test:packaging",
    // The nearest-node_modules walk is what finds mermaid's OWN marked 16.4.2
    // rather than the repository's root marked 9.1.6. Collapsed to a root-only
    // lookup, the notices still contain a heading called "marked", so every
    // name-level assertion stays green while the licence for the code actually
    // bundled into libs/vendor/mermaid.min.js goes missing. Only the
    // version-level assertion can see this.
    what: "resolve nested dependencies against the lockfile root only, silently documenting the wrong version of a bundled package",
    file: NOTICES_GEN,
    from: "function resolveLockKey(packages, fromKey, name) {",
    to: "function resolveLockKey(packages, fromKey, name) { if (name) return packages['node_modules/' + name] ? 'node_modules/' + name : null;",
    expect: [
      /every bundled version is documented, including duplicate versions of the same package/,
    ],
  },
  {
    id: "R154",
    suite: "test:packaging",
    // Where this item started: build.publish was null, so electron-builder
    // wrote no app-update.yml, electron-updater had no feed, and the startup
    // check could only ever fail - while the app still paid for it 5s after
    // every packaged launch. The pre-existing "does not point at the upstream
    // parent" assertion passes just as happily in that state, because null
    // points at nobody, so nothing caught the regression on the way back.
    what: "disable auto-update again by nulling build.publish, so no update feed is packaged",
    file: path.join(ROOT, "package.json"),
    // ROTTED ONCE, SILENTLY, AND THAT IS THE LESSON. The original anchor
    // quoted this block as a single line naming `"repo": "markdown-viewer"`.
    // Renaming the fork to Folia changed the repo name AND reformatted the
    // block across seven lines, so this revert had been reporting
    // SETUP-FAILED - i.e. proving nothing - from the rename onward, and would
    // have gone on doing so until the next multi-hour full run. Found in one
    // second by `node scripts/prove-table-fixes.js --anchors`, which does the
    // string half of every revert's setup and runs no suite; use it after any
    // rename, move or reformat.
    from:
      '"publish": [\n' +
      "      {\n" +
      '        "provider": "github",\n' +
      '        "owner": "lostinsea",\n' +
      '        "repo": "folia"\n' +
      "      }\n" +
      "    ],",
    to: '"publish": null,',
    expect: [
      /auto-update publishes to this fork's own GitHub releases/,
      // Not collateral. With no feed, electron-builder emits no manifests, so
      // a dry run that lists them describes a release the real run cannot
      // assemble - which is precisely what this assertion exists to catch, and
      // what the list said before this change.
      /dry-run artifact list does not advertise update manifests that are never built/,
    ],
  },
  {
    id: "R155",
    suite: "test:packaging",
    // electron-builder's default publish mode is onTagOrDraft. With a feed
    // configured, a tag build would upload from all three matrix legs at once,
    // racing create-release - the single job that is supposed to hold
    // contents: write. Harmless while publish was null, because nothing could
    // upload regardless, which is exactly why the flag is easy to drop.
    what: "let a build script publish implicitly by dropping --publish never",
    file: path.join(ROOT, "package.json"),
    from: '"build": "electron-builder --win portable --publish never"',
    to: '"build": "electron-builder --win portable"',
    expect: [/every electron-builder script disables implicit publishing/],
  },
  {
    id: "R156",
    suite: "test:packaging",
    // This revert introduces the DEFECT rather than removing the fix, because
    // the fix here is a detector and the only honest way to prove a detector is
    // to hand it the thing it is meant to detect. The single stray \r below is
    // exactly what an automated edit put into test-packaging.js: it makes git
    // classify the whole file as `-text`, which turns off autocrlf for it, so
    // the working tree's CRLF is committed verbatim and a 285-line change lands
    // as 1913 insertions / 1642 deletions. Nothing else reports it - not
    // `git status`, not `git diff --numstat`, not any editor.
    //
    // Note this can only exercise the byte scan. The companion `i/-text`
    // assertion reads the INDEX, which a worktree-only revert cannot move; it
    // fired for real on the committed defect and is kept as the post-commit
    // half of the same guard.
    what: "put a lone CR back into a tracked source file, as a stray automated edit would",
    file: path.join(ROOT, "docs/CUSTOMIZATIONS.md"),
    from: "## Modifying Customizations",
    to: "## Modifying Customizations\r",
    expect: [/no tracked source file contains a lone CR/],
  },
  // R157 pinned the export rasteriser's use of the SVG's own viewBox rather
  // than getBoundingClientRect(), so that an exported diagram's resolution did
  // not depend on how the reader had zoomed the window. Both the entry and the
  // function it guarded (mermaidToPngDataUrl) were removed with Word export:
  // that handler was its only caller, and the image-zoom popup rasterises an
  // <img> in its own window without going near it. Recorded rather than left
  // silent, because the measurement behind it - viewBox 126.2 at every zoom
  // level against a rect reading 63.1 / 126.2 / 189.2 - is the reason to reach
  // for viewBox again if diagram-to-image export ever comes back.
  {
    id: "R158",
    suite: "test:mermaid",
    // mermaid BAKES its colours into the emitted SVG, so dropping the
    // .dark-mode class is not enough - the diagram has to be re-rendered under
    // the light theme, or a reader in dark mode gets dark diagrams on a white
    // page. On a gantt chart that meant a light grey title and date axis on
    // white.
    //
    // This entry used to pin the Word export handler, which was the path that
    // had the defect. Word export was removed with html-to-docx, and no revert
    // covered the identical call in the PDF handler - the assertion below was
    // green but unpinned, so a regression there would have shipped. Re-pointed
    // rather than deleted.
    what: "export to PDF without re-theming, so a reader in dark mode gets dark diagrams on a white page",
    file: RENDERER,
    // The anchor carries beginExportThemeHold() because
    // `await setExportTheme(false);` is a whole line that could plausibly
    // recur; pinning it to the hold makes the site unambiguous.
    from:
      "  beginExportThemeHold();\n" +
      "  await setExportTheme(false);",
    to:
      "  beginExportThemeHold();\n" +
      "  document.body.classList.remove('dark-mode');",
    expect: [/PDF export re-themes the diagrams to match the light page/],
    // The body class must still go light, or this would be proving nothing
    // more than "the export broke".
    mustPass: [/PDF export drops dark mode on the body/],
  },
  {
    id: "R161",
    suite: "test:mermaid",
    // PERF-07 re-themes only the diagrams the reader can currently see and
    // defers the rest to idle chunks, so updateMermaidTheme() resolves while
    // off-screen diagrams still wear the old theme. An export reads the WHOLE
    // document, so without the settle wait a long document exports a MIXTURE:
    // the diagrams above the fold light, the ones below still dark. Found in
    // independent review, not by the tests - which is why section 8d exists.
    what: "let an export start as soon as the visible diagrams are re-themed, leaving the off-screen ones on the reader's theme",
    file: RENDERER,
    from: "    await whenMermaidSettled();",
    to: "    await Promise.resolve();",
    expect: [
      /every diagram below the fold is re-themed before an export reads it/,
    ],
  },
  {
    id: "R159",
    suite: "test:packaging",
    // The 130 MB finding in its general form. A package listed in
    // `dependencies` is installed into every user's machine whether shipped
    // code requires it or not, because build.files ships node_modules/**/* and
    // electron-builder prunes only devDependencies. html2canvas was exactly
    // this: 3.22 MB on disk and 13.7 ms of renderer startup for one call site
    // the engine's own SVG rasteriser now serves.
    what: "declare a production dependency that no shipped line requires",
    file: path.join(ROOT, "package.json"),
    from: '"electron-updater":',
    to: '"html2canvas": "^1.4.1",\n    "electron-updater":',
    expect: [/every production dependency is actually required by shipped code/],
  },
  {
    id: "R160",
    suite: "test:packaging",
    // electron-builder writes app-update.yml only when an nsis target is in
    // the build (app-builder-lib's isSuitableWindowsTarget). Release from a
    // portable-only build and the shipped app carries no feed, so every update
    // check fails at config load - silently, and with main.js still carrying a
    // portable update-install path that can then never be reached. Nothing
    // else catches it: build.publish is still set, so the config-level
    // assertions stay green and only the artefact is wrong.
    what: "release a Windows build with no auto-updatable target, so no update feed is packed",
    file: path.join(ROOT, ".github", "workflows", "release.yml"),
    from: "run: npm run build-all",
    to: "run: npm run build",
    expect: [/the Windows release build includes an auto-updatable target/],
  },
  {
    id: "R162",
    suite: "test:mermaid",
    // An export is awaited across the rasterisation of every diagram, and the
    // reader can toggle the theme inside that window. Restoring from a
    // snapshot of the body class taken before the export started then puts
    // them back into the theme they had just left - silently, seconds after
    // the toggle, so it reads as the toggle itself having failed. The
    // preference is the source of truth, and setExportTheme deliberately never
    // writes it, so it is unaffected by the export's own light-mode forcing.
    what: "restore the theme after a PDF export from a stale snapshot instead of the reader's current preference",
    file: RENDERER,
    // Re-pointed from the Word handler to the PDF handler when Word export was
    // removed. The two handlers ran identical restore logic, so the property is
    // unchanged - only the site that carries it is. Indentation is two spaces
    // here rather than the Word path's four.
    from:
      "    const restoreDark = resolveDarkPreference();\n" +
      "    if (restoreDark !== document.body.classList.contains('dark-mode')) {\n" +
      "      await setExportTheme(restoreDark);\n" +
      "    }\n" +
      "  }",
    to:
      "    if (document.body.dataset.wasDark === '1') await setExportTheme(true);\n" +
      "  }",
    // The paired edit takes the snapshot, where the removed one was taken.
    also: {
      from:
        "  beginExportThemeHold();\n" +
        "  await setExportTheme(false);",
      to:
        "  beginExportThemeHold();\n" +
        "  document.body.dataset.wasDark = document.body.classList.contains('dark-mode') ? '1' : '0';\n" +
        "  await setExportTheme(false);",
    },
    expect: [
      /a theme change made during a PDF export is not undone when it finishes/,
    ],
  },
  {
    id: "R163",
    suite: "test:mermaid",
    // An export forces the document light, then spends seconds rasterising
    // every diagram. A theme change made from the menu inside that window does
    // NOT go through a preference write alone - custom-theme.js clicks the
    // real toggle, which re-renders every mermaid SVG under the new theme,
    // underneath an export that is still reading them. Measured on a PDF
    // export interrupted by picking Dark: the exported PNG came out closer to
    // the DARK reference (21.07) than the light one (21.54). That measurement
    // was originally taken on the Word path, which has since been removed; the
    // fix being reverted here is in the darkModeToggle handler and was never
    // Word-specific, so only the export driving the test changed.
    //
    // Neither the settle wait (R161) nor the preference-based restore (R162)
    // catches this. Both are about what the export does with the theme; this
    // is about what someone ELSE does to it while the export runs. Nothing is
    // lost by holding it - the preference is already written, and the restore
    // applies it a moment later.
    what: "let a theme change from the menu re-theme the diagrams an export is still reading",
    file: RENDERER,
    from: "  if (exportThemeHold > 0) {",
    to: "  if (false) {",
    expect: [
      /a theme change made during a PDF export cannot re-theme the diagrams it is exporting/,
    ],
  },
  {
    id: "R164",
    suite: "test:mermaid",
    // Pins a DECISION rather than a defect. Review proposed "fix the footgun
    // at source" by having the legacy toggle handler write 'themeMode' as
    // well as the legacy key, so the two can never desync. It must not:
    // custom-theme.js writes the preference FIRST - and the value may be
    // 'desktop' - then delegates to this button for the mermaid side effects.
    // A handler that wrote 'themeMode' would overwrite "Follow Desktop" with
    // the concrete theme it had just resolved, and the app would stop
    // following the OS from that click on. The failure is silent and only
    // visible on the next OS theme change.
    what: "have the legacy toggle handler write the preference, destroying Follow Desktop",
    file: RENDERER,
    from: "  localStorage.setItem('darkMode', isDarkMode ? 'enabled' : 'disabled');",
    to:
      "  localStorage.setItem('darkMode', isDarkMode ? 'enabled' : 'disabled');\n" +
      "  localStorage.setItem('themeMode', isDarkMode ? 'dark' : 'light');",
    expect: [/choosing Follow Desktop survives the toggle it delegates to/],
  },
  {
    id: "R166",
    suite: "test:mermaid",
    // Nothing serialises exports: ipcMain.on('export-pdf') has no re-entrancy
    // guard and the renderer stays responsive while main runs printToPDF, so a
    // reader can start a second export on top of one that is still
    // rasterising, and both then read the document for seconds. If every
    // release restores the reader's theme rather than only the last one out,
    // the finishing export puts the document back into dark UNDERNEATH the one
    // still capturing, and the diagrams it has not reached yet bake in the
    // reader's theme rather than the light export theme.
    //
    // Found in independent review; reproduced only after the fixture was
    // scrolled to the BOTTOM, because PERF-07 re-themes what the reader can
    // see and at the top the export loop is always ahead of the damage.
    // Measured on 30 diagrams: the worst diagram in the finished export sat
    // 2.55 from the DARK reference and 99.17 from the light one.
    //
    // This was originally a PAIR of reverts, one per export path - R165 gated
    // the Word result handler and R166 the PDF one. Word export was removed
    // with html-to-docx, leaving a single gate, so R165 was deleted rather
    // than left pointing at code that no longer exists. The overlap it proved
    // is still reachable, because two PDF exports can overlap each other.
    what: "restore the reader's theme on every export release instead of only the last one out",
    file: RENDERER,
    // Now that the Word handler's four-space copy is gone this two-space
    // anchor is unique on its own, so it no longer needs the preceding comment
    // line to disambiguate it.
    from: "  if (endExportThemeHold() === 0) {",
    to: "  if ((endExportThemeHold(), true)) {",
    expect: [
      /a concurrent export cannot re-theme the diagrams the export it overlaps is still reading/,
    ],
    // The overlapping export must genuinely have run, or "no damage" would
    // just mean "nothing happened".
    mustPass: [/the overlapping PDF export really ran to completion/],
  },
  {
    id: "R166b",
    suite: "test:mermaid",
    // R166's partner, and it exists because of a gap found in independent
    // review AFTER R165 was deleted. R166 proves the gate must not fire EARLY.
    // Nothing proved it must fire AT ALL: under R166's revert both "the
    // reader's theme comes back once the last export has finished" and "two
    // overlapping exports leave no theme hold behind" still passed, because a
    // premature restore still restores. R165 used to be the entry that failed
    // when a release stopped acting, and removing Word took it away.
    //
    // So this one makes the gate unreachable instead of over-reachable. The
    // counter still decrements - the hold assertions must keep passing, which
    // is what separates "the gate never fires" from "the release is gone".
    what: "make the export release never restore the reader's theme at all",
    file: RENDERER,
    from: "  if (endExportThemeHold() === 0) {",
    to: "  if (endExportThemeHold() === -1) {",
    expect: [
      /the reader's theme comes back once the last export has finished/,
      /the theme the reader picked during the export is applied once it finishes/,
    ],
    // The release must still RUN and still decrement; only its restore is
    // gated out. If these fail too, the revert has removed the release rather
    // than its effect and proves something weaker than it claims.
    mustPass: [
      /two overlapping exports leave no theme hold behind/,
      /a completed PDF export leaves no theme hold behind/,
    ],
  },
  {
    id: "R167",
    suite: "test:mermaid",
    // Found by independent review of the Word-export removal, then confirmed
    // by reading applyMermaidTheme: it has no "already this theme" early
    // return, so it clears mermaidSvgCache and re-runs every visible diagram
    // even when asked for the theme those diagrams are already drawn in. A
    // second export starting on top of a first asks for exactly that, and
    // renderMermaidBatch writes data-mermaid-src back SYNCHRONOUSLY before it
    // awaits mermaid.run - so the diagrams go to raw source text with no <svg>
    // while main may still be running printToPDF over the live page.
    //
    // The old section 8f measured that wipe as unobservable FROM A RENDERER
    // TASK and was deleted with the Word rasteriser. Its conclusion never
    // transferred to this case: printToPDF runs in main and captures painted
    // output. Rather than chase a paint-timing window, the guard removes the
    // redundant work entirely and the assertion pins its absence.
    what: "re-theme mermaid on every export prepare, even when the diagrams are already in that theme",
    file: RENDERER,
    from: "    if (mermaidDesiredDark !== dark) {",
    to: "    if (true) {",
    expect: [
      /does not re-render diagrams that are already in the export theme/,
    ],
    // The measurement is only meaningful while the FIRST prepare still has
    // real work to do, and while the export theme itself still lands.
    mustPass: [
      /the first export really did have diagrams to re-theme/,
      /a concurrent export cannot re-theme the diagrams the export it overlaps is still reading/,
    ],
  },
  {
    id: "R179",
    suite: "test:patch",
    // Ported from upstream ef81474. The reader selects RENDERED text, so a
    // selection crossing inline formatting yields a string that exists nowhere
    // in the source - "one two three" is not in `one *two* three`. The exact
    // search returned -1 and Edit Text refused the edit with "text not found",
    // which reads as a bug in the editor rather than a limitation of the
    // search. Removing the projection fallback restores that behaviour.
    what: "locate an Edit Text selection by exact source search only, with no marker-tolerant fallback",
    file: RENDERER,
    from: "  if (exact !== -1) return { index: exact, length: plainText.length };",
    to: "  return exact === -1 ? null : { index: exact, length: plainText.length };",
    expect: [
      /Edit Text finds the source for: a selection spanning an italic span/,
      /editing a selection that spans formatting rewrites the source/,
    ],
    // The ordinary exact path must survive, or this proves only that the
    // function was broken outright rather than that the fallback is load-bearing.
    mustPass: [
      /Edit Text finds the source for: plain text with no formatting at all/,
      /editing a selection that needs no projection still works/,
    ],
  },
  {
    id: "R180",
    suite: "test:patch",
    // The correction made to ef81474 while porting it. Upstream never extends
    // the run backwards, so a selection that begins INSIDE a span orphans the
    // span's opening marker: on `*hello* world`, selecting the rendered
    // "hello world" replaces `hello* world` and leaves `*newText` behind. That
    // is not valid markdown - the stray `*` silently changes how the rest of
    // the document renders - and it is written to the file.
    what: "leave the opening marker behind when an Edit Text selection starts inside a formatted span",
    file: RENDERER,
    from: "  while (start > 0 && isMarker(source[start - 1])) start--;",
    to: "  while (false && isMarker(source[start - 1])) start--;",
    expect: [
      /a selection starting inside a span takes its opening marker too/,
      /a selection ending inside a span takes its closing marker too/,
      /replacing a selection that spans formatting leaves no unbalanced marker/,
    ],
    // The fallback itself must still work: this revert removes only the
    // backward walk, not the projection search that finds the run at all.
    // Note the "ending inside a span" row is an EXPECTED failure, not a
    // surviving one - `one *two* three` with "two three" selected starts at the
    // `t` inside the span, so recovering its opening `*` is the backward walk's
    // job too. Listing it as mustPass is what the COLLATERAL check caught.
    mustPass: [
      /Edit Text finds the source for: a selection spanning an italic span/,
      /Edit Text finds the source for: plain text with no formatting at all/,
    ],
  },
  {
    id: "R181",
    suite: "test:security",
    // The one thing this fork ADDS to upstream's drag-and-drop. openFile()
    // (main.js) applies no extension check and no size check - it reads the
    // whole file as a UTF-8 string and renders it - and a drop is a hand
    // movement, not a considered choice. Without the allowlist, dropping an
    // executable or a video onto the window reads it into memory and paints
    // the mojibake as a document.
    what: "open whatever file is dropped on the window, with no extension check",
    file: RENDERER,
    from: "    if (!file.name.includes('.') || DROPPABLE_EXTENSIONS.indexOf(ext) === -1) {",
    to: "    if (false) {",
    expect: [
      /dropping an executable is refused rather than opened/,
      /dropping an executable tells the reader why/,
      /dropping a video is refused rather than opened/,
      /dropping a video tells the reader why/,
      /dropping a file with no extension at all is refused rather than opened/,
      /dropping a file with no extension at all tells the reader why/,
      /dropping something merely markdown-ish is refused rather than opened/,
      /dropping something merely markdown-ish tells the reader why/,
    ],
    // Dropping a real document must still work, or this proves only that the
    // drop handler was broken outright.
    mustPass: [
      /dropping a markdown file asks the main process to open exactly that path/,
      /every extension the Open File dialog accepts can also be dropped/,
    ],
  },
  {
    id: "R182",
    suite: "test:security",
    // dragenter/dragleave bubble from every element the pointer crosses, so a
    // plain boolean (or a counter that resets on the first leave) makes the
    // overlay strobe on and off while the reader is still dragging.
    what: "drop the drag overlay on the first dragleave, ignoring nesting",
    file: RENDERER,
    from: "    dragCounter = Math.max(0, dragCounter - 1);",
    to: "    dragCounter = 0;",
    expect: [/the drop overlay survives a dragleave from a child element/],
    // The overlay must still come down at the end of a real drag: a revert that
    // also broke that would be pinning nothing in particular.
    mustPass: [
      /the drop overlay goes away once the drag really has left/,
      /dropping a file clears the overlay/,
    ],
  },
  {
    id: "R183",
    suite: "test:security",
    // A drag abandoned outside the window fires no drop, and on some window
    // managers no final dragleave either. The overlay is a full-window layer,
    // so stranding it leaves the reader looking at their document through it
    // with no way to dismiss it short of restarting.
    what: "leave the drag overlay up when a drag is abandoned outside the window",
    file: RENDERER,
    from: "  window.addEventListener('blur', clearDropState);",
    to: "  void clearDropState;",
    expect: [/an abandoned drag cannot strand the overlay over the document/],
    mustPass: [/dragging a file over the window shows the drop overlay/],
  },
  {
    id: "R184",
    suite: "test:tables",
    // The half of upstream ef81474 that is a bug fix rather than a feature.
    // .note-dialog-overlay is position:fixed with overflow visible and centres
    // its child, so a dialog taller than the viewport spills off BOTH edges
    // with nothing to scroll. Measured before the fix at a 390px viewport: the
    // mermaid template dialog was 492px tall, top -51, Insert at bottom 441 -
    // the dialog could be opened but not used and not closed by its own button.
    what: "let a dialog grow taller than the window with nothing to scroll",
    file: CSS,
    from: "  max-height: 95vh;\n  /* Upstream ships flat px minimums here, which DEFEAT the cap above: CSS",
    to: "  max-height: none;\n  /* Upstream ships flat px minimums here, which DEFEAT the cap above: CSS",
    expect: [
      /the mermaid template dialog fits inside a short window instead of spilling off it/,
      /the mermaid template dialog's title bar is still on screen in a short window/,
      /the mermaid template dialog's primary button can actually be pressed in a short window/,
    ],
    // The dialog must still be resizable and still lay out correctly; this
    // revert removes the cap only.
    mustPass: [
      /the mermaid template dialog offers a corner grab handle/,
      /an enlarged dialog keeps its footer buttons inside itself/,
    ],
  },
  {
    id: "R185",
    suite: "test:tables",
    // The defect found IN upstream's own hunk while porting it. CSS applies
    // min-* last, so a flat `min-height: 420px` beats the `max-height: 95vh`
    // shipped beside it and the dialog stays 420px tall on a 390px viewport -
    // measured at top: -15, header off screen. Taking upstream's values
    // verbatim would have left the bug it was meant to fix.
    what: "take upstream's flat pixel minimums, which override the viewport cap they ship with",
    file: CSS,
    from: "  min-height: min(420px, 95vh);",
    to: "  min-height: 420px;",
    expect: [
      /the mermaid template dialog fits inside a short window instead of spilling off it/,
      /the mermaid template dialog's title bar is still on screen in a short window/,
    ],
    // Narrow by construction: the insert-table dialog has its own smaller
    // minimum and must be unaffected, or this is catching R184's defect instead.
    mustPass: [
      /the insert-table dialog fits inside a short window instead of spilling off it/,
      /the insert-table dialog's title bar is still on screen in a short window/,
      /the mermaid template dialog's primary button can actually be pressed in a short window/,
    ],
  },
  {
    id: "R186",
    suite: "test:tables",
    // Making the dialog resizable without this plumbing gives the reader a grab
    // handle that changes the box and nothing else: the panes sized to their own
    // content, so the extra height became dead space under them. Measured before
    // the fix: preview 220px before a +220px drag and 220px after.
    what: "size the mermaid dialog's panes to their content so enlarging it adds only dead space",
    file: CSS,
    from: "  align-items: stretch;\n  flex: 1 1 auto;\n  min-height: 0;\n}",
    to: "  align-items: flex-start;\n}",
    expect: [/enlarging the mermaid dialog enlarges the diagram preview with it/],
    // The dialog itself must still resize and still hold its footer, or this
    // proves only that the layout was broken outright.
    mustPass: [
      /enlarging a dialog really does enlarge it/,
      /an enlarged dialog keeps its footer buttons inside itself/,
      /an enlarged dialog gives the extra room to its content, not to dead space/,
    ],
  },
  {
    id: "R187",
    suite: "test:tables",
    // The change upstream ef81474 had to make once a 6px handle was inserted
    // between the two panes, and the one that fails silently: `width: 50%` on
    // each pane totals the whole row, so the handle pushes the viewer past the
    // edge of .content-wrapper - which is `overflow: hidden`, so nothing is
    // reported and the right-hand 6px of the document is simply gone.
    what: "size the split-view viewer at a fixed 50% so the splitter overflows the row",
    file: CSS,
    from: "  flex: 1 1 0;",
    to: "  width: 50%;",
    expect: [/inserting the splitter does not push the viewer out of the window/],
    // The splitter must still be there and still work, or this is proving that
    // split view was broken outright rather than that the sizing is wrong.
    mustPass: [
      /the splitter is laid out in split view and nowhere else/,
      /dragging the splitter really resizes the editor pane/,
    ],
  },
  {
    id: "R188",
    suite: "test:tables",
    // Upstream's arithmetic: the ratio is taken against the container width
    // MINUS the handle, then written back as a percentage OF the container. The
    // two denominators disagree by the handle's width, so the handle drifts
    // away from the pointer in proportion to the travel - measured at 1.81px on
    // a 1588px container at 30%, and approaching the full 6px near the end.
    what: "take the split ratio against a different width from the one it is written back to",
    file: RENDERER,
    from: "        (ev.clientX - containerRect.left) / containerRect.width",
    to: "        (ev.clientX - containerRect.left) / (containerRect.width - editorSplitter.getBoundingClientRect().width)",
    expect: [/the splitter lands under the pointer rather than near it/],
    // Deliberately narrow: the drag itself still works, the panes still fit and
    // the ratio is still stored. Only the tracking is wrong.
    mustPass: [
      /dragging the splitter really resizes the editor pane/,
      /inserting the splitter does not push the viewer out of the window/,
      /the split ratio is remembered/,
    ],
  },
  {
    id: "R189",
    suite: "test:tables",
    // Without persistence the splitter is a per-session toy: every restart
    // throws the reader's chosen split away and returns to 50/50.
    what: "forget the split ratio instead of remembering it",
    file: RENDERER,
    from: "    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));",
    to: "    void ratio;",
    expect: [
      /the split ratio is remembered/,
      /double-clicking the splitter restores an even split, and remembers it/,
    ],
    // The drag and the double-click must still change the layout; only the
    // memory of it is removed.
    mustPass: [
      /dragging the splitter really resizes the editor pane/,
      /a remembered ratio is in force the moment split view opens/,
    ],
  },
  {
    id: "R190",
    suite: "test:tables",
    // Without the clamp a drag to either edge collapses a pane to nothing, and
    // the collapsed state is then PERSISTED - so the next launch opens edit mode
    // with no editor (or no preview) and no handle wide enough to find.
    what: "let the splitter collapse either pane to nothing",
    file: RENDERER,
    from: "  const clamped = Math.max(SPLITTER_MIN_RATIO, Math.min(SPLITTER_MAX_RATIO, ratio));",
    to: "  const clamped = ratio;",
    expect: [/neither pane can be dragged away to nothing/],
    mustPass: [
      /dragging the splitter really resizes the editor pane/,
      /double-clicking the splitter restores an even split, and remembers it/,
    ],
  },
  {
    id: "R191",
    suite: "test:tables",
    // The whole point of the departure from upstream. Bound to mousedown, the
    // handler receives a MouseEvent, whose pointerId is undefined - so the
    // capture call is never made and the "capture keeps the drag tracking"
    // rationale is dead code that merely LOOKS like a robustness measure. Two
    // independent reviewers caught this; the assertion is what stops it coming
    // back.
    what: "bind the splitter to mousedown, where there is no pointer to capture",
    file: RENDERER,
    from: "  editorSplitter.addEventListener('pointerdown', (e) => {",
    to: "  editorSplitter.addEventListener('mousedown', (e) => {",
    expect: [
      /the splitter really asks for pointer capture rather than only appearing to/,
    ],
  },
  {
    id: "R192",
    suite: "test:tables",
    // A pointerup this window never saw - released outside the frame - would
    // otherwise leave the drag live for ever: the splitter keeps tracking the
    // bare cursor and resizing the pane with no button held.
    what: "keep dragging after a pointerup the window never received",
    file: RENDERER,
    from: "      if (ev.buttons === 0) {",
    to: "      if (ev.buttons === 999) {",
    expect: [
      /a drag whose pointerup went missing ends itself instead of resizing for ever/,
    ],
    mustPass: [/dragging the splitter really resizes the editor pane/],
  },
  {
    id: "R195",
    suite: "test:tables",
    // Enlarging the Insert Table dialog has to give the extra room to the
    // markdown box the reader is actually typing into. Without this the dialog
    // grows and the textarea stays put, so the resize buys dead space.
    what: "let the insert-table dialog grow without growing its markdown box",
    file: CSS,
    from: ".table-insert-dialog #tableInsertMarkdown {\n  flex: 1 1 auto;",
    to: ".table-insert-dialog #tableInsertMarkdown {\n  flex: 0 0 auto;",
    expect: [/enlarging the insert-table dialog enlarges the markdown box with it/],
  },
  {
    id: "R193",
    suite: "test:security",
    // `String.prototype.replace` with a STRING replacement expands `$&`, "$`",
    // `$'` and `$$` found in that string. The interpolated values include file
    // names, whose shape the user does not control, so a rejected drop of a
    // file called `a$'.md` would garble its own error message.
    what: "interpolate i18n values as replacement patterns rather than literally",
    file: RENDERER,
    from: "      str = str.replace('${' + k + '}', () => String(v));",
    to: "      str = str.replace('${' + k + '}', v);",
    expect: [/a rejected file name is reported literally, not as a replacement pattern/],
  },
  {
    id: "R194",
    suite: "test:security",
    // Without preventDefault on dragover the drop is never delivered: the
    // browser takes the default action and NAVIGATES the window to the dropped
    // file. Synthetic dispatch bypasses the default-action gate, so only an
    // explicit assertion that dragover is cancelled can catch this.
    what: "stop cancelling dragover, so a real drop navigates instead of opening",
    file: RENDERER,
    from: "  window.addEventListener('dragover', (e) => {",
    to: "  window.addEventListener('dragover-disabled', (e) => {",
    expect: [/a drag over the window is cancelled, so a real drop is delivered to us/],
  },
  {
    // 8c1 — document translation removed. The property being defended is not
    // "the feature is gone" (an absence is trivially satisfied by never having
    // added it) but "the privileged egress route it created is gone". While
    // `translate-text` was registered, any script in this nodeIntegration
    // renderer could invoke it and post document text out through the MAIN
    // process, where connect-src does not apply at all.
    //
    // The revert restores a working handler, so it fails BOTH halves of the
    // assertion at once: the route answers instead of reporting "No handler
    // registered", and a live endpoint URL reappears in main.js source.
    id: "R168",
    suite: "test:security",
    what: "re-register the translate-text IPC route that sent document text to a third party",
    file: MAIN,
    from: "// SEC-09 — RESOLVED BY REMOVAL.",
    to:
      'ipcMain.handle("translate-text", async (event, payload) => {\n' +
      '  const text = payload && payload.text ? payload.text : "";\n' +
      "  const url =\n" +
      '    "https://translate.googleapis.com/translate_a/single?client=gtx" +\n' +
      '    "&sl=auto&tl=fr&dt=t&q=" + encodeURIComponent(text);\n' +
      "  const response = await fetch(url);\n" +
      "  const data = await response.json();\n" +
      '  return (data && data[0] ? data[0] : []).map((s) => (s && s[0]) || "").join("");\n' +
      "});\n" +
      "// SEC-09 — RESOLVED BY REMOVAL.",
    expect: [
      /the translate-text IPC route and its endpoint are removed from main\.js/,
    ],
    // The renderer-side CSP assertion is a SEPARATE property and must survive:
    // it is about what the renderer may reach, and re-adding a main-process
    // handler does not change that. If it fails too, this revert is measuring
    // the CSP rather than the route.
    mustPass: [
      /the former translation endpoint is refused \(connect-src 'none'\)/,
    ],
  },
  {
    // Removing the override lets electron-updater put its persistent UUID back
    // on the wire. The oracle is the stand-in feed's received headers, so this
    // fails on the value actually transmitted, not on the source text.
    id: "R169",
    suite: "test:startup",
    what: "restore the persistent x-user-staging-id sent on every update check",
    file: MAIN,
    from: '  autoUpdater.requestHeaders = { "x-user-staging-id": "" };',
    to: "  // reverted by R169",
    expect: [/no update request carries a staging-id value/],
    // The request must still be MADE. If this fails too, the revert has broken
    // the update check outright and the assertion above is passing vacuously
    // rather than because the identifier reappeared.
    mustPass: [/the update check really reached the stand-in feed/],
  },
  {
    // The slider was removed in 8c2, so there is no code left to break. What
    // CAN regress is the claim that legacy documents degrade: this reinstates
    // the extraction step alone, which swallows the marker block into a bare
    // placeholder string with nothing left to expand it. Measured under the
    // revert: imgCount drops from 2 to 0 -- the images vanish outright, which
    // is exactly the "unrendered rather than degraded" failure the assertion
    // exists to catch.
    id: "R170",
    suite: "test:security",
    what: "half-restore the slider by extracting its blocks with nothing left to render them",
    file: RENDERER,
    from: "    // First, extract mermaid blocks and replace with placeholders",
    to:
      "    content = content.replace(\n" +
      "      /<!--\\s*slider-start\\s*-->([\\s\\S]*?)<!--\\s*slider-end\\s*-->/g,\n" +
      '      () => "SLIDER_PLACEHOLDER_0",\n' +
      "    );\n" +
      "    // First, extract mermaid blocks and replace with placeholders",
    expect: [/a legacy slider document degrades to plain images/],
    // An unrelated document must still render. If this fails too, the revert
    // has broken rendering outright rather than only the degradation path.
    mustPass: [/mermaid source containing '<\|--' survives intact/],
  },
  {
    // The light-format twin of R170, and the measurement that settles a
    // reviewer disagreement: one reviewer held that the SEC-26 light-format
    // assertion already covered legacy-document degradation. It does not.
    // SEC-26 asserts only that window.__pwned stayed null, which a blank page
    // satisfies. Under this revert the light-format path swallows the marker
    // block, the images disappear, and SEC-26 still passes -- which is exactly
    // why the dedicated light-format degradation assertion had to be added.
    id: "R171",
    suite: "test:security",
    what: "swallow legacy slider blocks on the light-format path, so the images disappear instead of degrading",
    file: RENDERER,
    from: "  // Extract and placeholder special blocks (same as full render)",
    to:
      "  content = content.replace(\n" +
      "    /<!--\\s*slider-start\\s*-->([\\s\\S]*?)<!--\\s*slider-end\\s*-->/g,\n" +
      '    () => "SLIDER_PH_0",\n' +
      "  );\n" +
      "  // Extract and placeholder special blocks (same as full render)",
    expect: [/a legacy slider document degrades on the light-format path too/],
    // The full-render twin must KEEP passing: this revert touches only
    // renderLightFormat, so a failure there would mean the two assertions are
    // not actually measuring separate paths.
    mustPass: [
      /a legacy slider document degrades to plain images/,
      /SEC-26 legacy slider payload is blocked on the light-format path too/,
    ],
  },

  // ── 8c3: the interface-language switcher and its two non-English locales ──
  // These five all drive test:packaging, which is a static suite: the failure
  // mode being defended against is a LEFTOVER, and a leftover is a source
  // fact. Each revert reintroduces exactly one leftover so the five oracles
  // are shown to be independent rather than five spellings of one check.
  {
    id: "R172",
    suite: "test:packaging",
    what: "put a language-selector attribute back into the toolbar markup",
    file: HTML,
    from: '            <div class="tools-menu" id="viewMenu">',
    to:
      '            <div class="tools-menu" id="viewMenu" data-lang="en">',
    expect: [/the language switcher is gone from every shipped script/],
    // The overlay-file and Tools-menu oracles must not notice this: markup
    // attributes and file registration are separate failure modes.
    mustPass: [
      /the Ukrainian overlay file is deleted, not merely unregistered/,
      /the emptied Tools menu was removed rather than left as a dead button/,
    ],
  },
  {
    id: "R173",
    suite: "test:packaging",
    what: "re-register the deleted Ukrainian overlay in index.html",
    file: HTML,
    from: '    <script src="custom-tabs.js"></script>',
    to:
      '    <script src="custom-language.js"></script>\n' +
      '    <script src="custom-tabs.js"></script>',
    expect: [/the Ukrainian overlay file is deleted, not merely unregistered/],
    mustPass: [
      /the language switcher is gone from every shipped script/,
      /the emptied Tools menu was removed rather than left as a dead button/,
    ],
  },
  {
    id: "R174",
    suite: "test:packaging",
    what: "reintroduce the emptied Tools menu container in the toolbar markup",
    file: HTML,
    from: '            <div class="tools-menu" id="viewMenu">',
    to:
      '            <div class="tools-menu" id="toolsMenu"></div>\n' +
      '            <div class="tools-menu" id="viewMenu">',
    expect: [/the emptied Tools menu was removed rather than left as a dead button/],
    mustPass: [
      /the language switcher is gone from every shipped script/,
      /the Ukrainian overlay file is deleted, not merely unregistered/,
    ],
  },
  {
    id: "R175",
    suite: "test:packaging",
    what: "delete the submenu styling along with the language menu, which would silently unstyle the Theme submenu custom-theme.js injects into the View menu",
    file: CSS,
    from: "/* Nested submenu */\n.tools-submenu {",
    to: "/* Nested submenu */\n.removed-with-the-language-menu {",
    expect: [
      /the shared submenu styling the Theme menu depends on survived the removal/,
    ],
  },
  {
    id: "R176",
    suite: "test:packaging",
    what: "let an unreferenced string back into the table - the rot that had already accumulated 19 dead entries unnoticed",
    file: RENDERER,
    from: "const UI_STRINGS = {\n  'file': 'File',",
    to: "const UI_STRINGS = {\n  'title.tools': 'Tools',\n  'file': 'File',",
    expect: [/every UI string has a consumer/],
    // The parse itself must stay healthy, or "0 orphaned" would be measuring
    // an empty set rather than a clean table.
    mustPass: [
      /the UI string table really was parsed/,
      /UI_STRINGS is a flat single-locale table/,
    ],
  },
  {
    id: "R177",
    suite: "test:patch",
    what: "remove the checkmark that marks the selected Theme option, the indicator that survives in custom-styles.css now that the language menu's own .lang-check has gone",
    file: CUSTOM_CSS,
    from: '.custom-theme-option.active::before {\n  content: "\u2713";',
    to: '.custom-theme-option.active::before {\n  content: "";',
    expect: [/the selected theme carries a checkmark the unselected ones do not/],
    // The submenu must still be built, populated and OPEN - otherwise "no
    // checkmark" would just mean "no options were found", and the icon-opacity
    // assertion must survive so this entry is pinned to the checkmark alone.
    mustPass: [
      /the Theme submenu still offers all three modes after the language menu was removed/,
      /the Theme submenu still floats over the menu - the shared \.tools-submenu rule survived/,
      /the selected theme's icon is emphasised relative to the unselected ones/,
    ],
  },
  {
    id: "R178",
    suite: "test:patch",
    what: "delete the shared submenu styling - the same neutralisation as R175, but measured on the LIVE Theme submenu rather than on CSS text, since a rule can exist and still resolve to nothing",
    file: CSS,
    from: "/* Nested submenu */\n.tools-submenu {",
    to: "/* Nested submenu */\n.removed-with-the-language-menu {",
    expect: [
      /the Theme submenu still floats over the menu - the shared \.tools-submenu rule survived/,
    ],
    // The options must still be found and ticked, or "not floating" would just
    // mean the submenu was never built at all.
    mustPass: [
      /the Theme submenu still offers all three modes after the language menu was removed/,
      /the selected theme carries a checkmark the unselected ones do not/,
    ],
  },

  // ---------------------------------------------------------------------
  // View-mode editing: gated to edit mode, except notes, which auto-save.
  // ---------------------------------------------------------------------
  {
    id: "R196",
    suite: "test:patch",
    // Neutralising the CALL rather than the function body, so the entry cannot
    // rot when the gating is restructured - the same anti-rot shape as R53.
    what: "stop gating the viewer context menu, so view mode again offers a dozen edits it cannot save",
    file: RENDERER,
    from: "  applyEditModeMenuGating();",
    to: "  /* gating removed by revert */;",
    expect: [
      /no document-editing item is offered in view mode/,
      /table edit and delete are not offered on a table in view mode/,
    ],
    // If the probe itself failed, "the items are visible" would just mean the
    // menu never opened.
    mustPass: [
      /the view-mode context-menu probe rendered its sample document/,
      /notes stay reachable in view mode/,
      /the read-only items are untouched in view mode/,
    ],
  },
  {
    id: "R197",
    suite: "test:patch",
    // The bug this pins was WRITTEN and caught by the test, not hypothesised:
    // gating that only ever sets display:none hides the formatting items
    // permanently, because nothing else in the codebase gives them a display.
    what: "make the gating one-way, so an item hidden in view mode never comes back in edit mode",
    file: RENDERER,
    from: "  const display = isEditMode ? '' : 'none';",
    to: "  const display = 'none';\n  if (isEditMode) return;",
    expect: [/entering edit mode restores every editing item the gating hid/],
    mustPass: [
      /no document-editing item is offered in view mode/,
      /table edit and delete come back on a table in edit mode/,
    ],
  },
  {
    id: "R198",
    suite: "test:patch",
    what: "stop collapsing the separators that framed the hidden items, leaving empty sections in the menu",
    file: RENDERER,
    from: "  tidyContextMenuSeparators();",
    to: "  /* separator tidy removed by revert */;",
    expect: [/hiding a run of items leaves no stray separator behind/],
    mustPass: [/no document-editing item is offered in view mode/],
  },
  {
    id: "R199",
    suite: "test:patch",
    // The original defect, in its most common form: the reader annotates a
    // document in view mode and the note is gone after the next reload.
    what: "stop persisting a note added in view mode",
    file: RENDERER,
    from:
      "          const newContent = markdownContent.substring(0, textIndex) + noteHtml + markdownContent.substring(textIndex + savedSelection.length);\n" +
      "          commitViewModeNote(newContent, scrollPosition);",
    to:
      "          const newContent = markdownContent.substring(0, textIndex) + noteHtml + markdownContent.substring(textIndex + savedSelection.length);\n" +
      "          commitViewModeEdit(newContent, scrollPosition);",
    expect: [/a note added in view mode is written to disk without any save action/],
    mustPass: [/the Add Note dialog reached its Save button/],
  },
  {
    id: "R200",
    suite: "test:patch",
    // A separate entry from R199 on purpose: the edit path does NOT share an
    // implementation with the add path - it hand-rolls its own store update -
    // so one call site being wired says nothing about the other.
    what: "stop persisting an EDIT to an existing note in view mode",
    file: RENDERER,
    from: "        commitViewModeNoteSilently(newContent);",
    to:
      "        originalMarkdown = newContent;\n" +
      "        hasUnsavedChanges = true;\n" +
      "        updateUnsavedIndicator();",
    expect: [/editing a note in view mode is written to disk/],
    mustPass: [/the Edit Note dialog reached its Save button/],
  },
  {
    id: "R201",
    suite: "test:patch",
    // There are TWO delete surfaces with two implementations. The first pass
    // of this work wired only the notes-panel one and left the viewer's own
    // Delete Note unsaved; the suite caught it. This is that trap, kept.
    what: "stop persisting a note deleted from the VIEWER's context menu (the notes panel has its own, separate handler)",
    file: RENDERER,
    from:
      "      // Note as the single note action that still vanished on reload.\n" +
      "      commitViewModeNoteSilently(newContent);",
    to:
      "      // Note as the single note action that still vanished on reload.\n" +
      "      originalMarkdown = newContent;\n" +
      "      hasUnsavedChanges = true;\n" +
      "      updateUnsavedIndicator();",
    expect: [/deleting a note in view mode is written to disk/],
    mustPass: [/the Delete Note handler ran/],
  },
  {
    id: "R202",
    suite: "test:patch",
    // The other direction. Auto-save is scoped to view mode deliberately:
    // edit mode has an explicit Save and an unsaved-changes contract built on
    // top of it, and silently writing behind that contract would break the
    // discard-on-exit behaviour 6d exists to provide.
    what: "auto-save notes in EDIT mode too, breaking the explicit-save contract the editor is built on",
    file: RENDERER,
    from: "  if (isEditMode) return false;   // edit mode keeps explicit-save semantics",
    to: "  // edit-mode guard removed by revert",
    expect: [
      /autoSaveViewModeNote\(\) refuses to write while edit mode is on/,
      /nothing reached the disk when the edit-mode guard refused/,
    ],
    // No CURRENT call site reaches this function in edit mode - the edit-mode
    // branches of the note handlers simply do not call it - so the end-to-end
    // assertion below passes structurally either way and cannot pin the guard.
    // It is listed here so that a future wiring change which DOES make it
    // reachable reports as COLLATERAL rather than quietly widening this proof.
    mustPass: [
      /the edit-mode Add Note dialog reached its Save button/,
      /the edit-mode note really was added, in memory/,
      /a note added in edit mode is NOT auto-saved/,
      /the guarded document really did have unsaved content to write/,
    ],
  },

  // ---------------------------------------------------------------------
  // Second round: what two independent reviewers found in the above.
  //
  // Three of the seven auto-save call sites had no probe reaching them, so
  // deleting the write from any of them left the suite green. All seven now go
  // through one of two helpers, which turns "did this site remember to save?"
  // into "does this site call the note helper or the plain one?" - and that is
  // what these entries perturb, one site at a time.
  // ---------------------------------------------------------------------
  {
    id: "R203",
    suite: "test:patch",
    what: "leave a note added to a MARKDOWN IMAGE unsaved, the way an unwired site silently is",
    file: RENDERER,
    from:
      "          const newContent = markdownContent.substring(0, idx) + noteHtml + markdownContent.substring(idx + mdImgPattern.length);\n" +
      "          commitViewModeNote(newContent, scrollPosition);",
    to:
      "          const newContent = markdownContent.substring(0, idx) + noteHtml + markdownContent.substring(idx + mdImgPattern.length);\n" +
      "          commitViewModeEdit(newContent, scrollPosition);",
    expect: [/a note on a markdown image is written to disk in view mode/],
    // If the dialog never ran, "not on disk" would say nothing about saving.
    mustPass: [/the Add Note dialog ran against a markdown image/],
  },
  {
    id: "R204",
    suite: "test:patch",
    // A different branch from R203: the markdown-image lookup misses on a raw
    // <img> and a regex fallback does the replacement instead.
    what: "leave a note added to a RAW <img> unsaved",
    file: RENDERER,
    from:
      "            const newContent = markdownContent.replace(match[0], noteHtml);\n" +
      "            commitViewModeNote(newContent, scrollPosition);",
    to:
      "            const newContent = markdownContent.replace(match[0], noteHtml);\n" +
      "            commitViewModeEdit(newContent, scrollPosition);",
    expect: [/a note on a raw <img> is written to disk in view mode/],
    mustPass: [/the Add Note dialog ran against a raw <img>/],
  },
  {
    id: "R205",
    suite: "test:patch",
    what: "leave a LABEL BADGE unsaved - the no-selection branch, which nothing drove before",
    file: RENDERER,
    from:
      "      const newContent = activeContent + '\\n' + noteHtml;\n" +
      "      commitViewModeNote(newContent, scrollPosition);",
    to:
      "      const newContent = activeContent + '\\n' + noteHtml;\n" +
      "      commitViewModeEdit(newContent, scrollPosition);",
    expect: [/a label badge added in view mode is written to disk/],
    mustPass: [/the Add Note dialog ran with no selection/],
  },
  {
    id: "R206",
    suite: "test:patch",
    // The trap from the first round, in its other half: the notes panel and
    // the viewer context menu are SEPARATE hand-rolled deletes. R201 pins the
    // viewer one; this pins the panel one.
    what: "leave a delete made from the NOTES PANEL unsaved",
    file: RENDERER,
    from:
      "        activeSource.substring(match.index + match[0].length);\n\n" +
      "      commitViewModeNote(newContent, scrollPosition);",
    to:
      "        activeSource.substring(match.index + match[0].length);\n\n" +
      "      commitViewModeEdit(newContent, scrollPosition);",
    expect: [/deleting a note from the NOTES PANEL is written to disk in view mode/],
    mustPass: [/the notes-panel Delete handler ran/],
  },
  {
    id: "R207",
    suite: "test:patch",
    // Both reviewers found this independently, and it is the original disease:
    // a document silently reverting. View-mode undo reassigned the store
    // without marking it dirty, and the next note wrote that reverted document
    // over the file.
    what: "let Ctrl+Z mutate the document in VIEW mode, so the next note auto-saves the reverted text",
    file: RENDERER,
    from: "document.addEventListener('keydown', (e) => {\n  if (!isEditMode) return;\n  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {",
    to: "document.addEventListener('keydown', (e) => {\n  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {",
    expect: [
      /Ctrl\+Z does not alter the document in view mode/,
      /the store and the file still agree after a view-mode Ctrl\+Z/,
    ],
    // The undo must have had something to undo, and edit mode must still have
    // its undo, or this would pass for the wrong reasons.
    mustPass: [
      /a note exists on disk before the undo keystroke/,
      /Ctrl\+Z still undoes in edit mode/,
    ],
  },
  {
    id: "R208",
    suite: "test:patch",
    // The retry the failure alert asks for was itself what destroyed the note.
    what: "clear the dirty flag when entering edit mode, discarding a note whose auto-save failed",
    file: RENDERER,
    from:
      "    hasUnsavedChanges =\n      hasUnsavedChanges &&\n      (saveFailedFor(currentFilePath) || hasPendingSaveFor(currentFilePath));",
    to: "    hasUnsavedChanges = false;",
    expect: [
      /entering edit mode after a failed auto-save preserves the unsaved state/,
      /entering edit mode with a write still unanswered keeps the document marked unsaved/,
    ],
    mustPass: [
      /a failed view-mode auto-save records the failure and keeps the document dirty/,
      /the provoked save failure really did reach the console/,
    ],
  },
  {
    id: "R209",
    suite: "test:patch",
    // The guards asked `isEditMode && hasUnsavedChanges`, which was complete
    // only while edit mode was the only way to hold unsaved bytes.
    what: "leave the reload/open guards keyed on edit mode, so a failed view-mode note is discarded silently",
    file: RENDERER,
    from: "  return hasUnsavedChanges && (isEditMode || saveFailedFor(currentFilePath));",
    to: "  return hasUnsavedChanges && isEditMode;",
    expect: [/a failed view-mode auto-save arms the reload\/open guards/],
    mustPass: [/a failed view-mode auto-save records the failure and keeps the document dirty/],
  },
  {
    id: "R210",
    suite: "test:patch",
    what: "stop recording a failed view-mode write, so nothing downstream knows the note is only in memory",
    file: RENDERER,
    from: "    if (savedPath) failedSaves.add(savedPath);\n    if (isForCurrent) {\n      hasUnsavedChanges = true;",
    to: "    if (savedPath) failedSaves.delete(savedPath);\n    if (isForCurrent) {\n      hasUnsavedChanges = false;",
    expect: [
      /a failed view-mode auto-save records the failure and keeps the document dirty/,
      /a failed view-mode auto-save arms the reload\/open guards/,
      /entering edit mode after a failed auto-save preserves the unsaved state/,
      /a save failure arriving after the user entered edit mode is still recorded/,
      /a successful save of one document does not clear another document's recorded failure/,
      /returning to the document whose save failed finds its reload guard still armed/,
    ],
    mustPass: [/the provoked save failure really did reach the console/],
  },
  {
    id: "R212",
    suite: "test:patch",
    // BOTH independent reviewers found this one, from opposite ends: documents
    // are per-tab, custom-tabs.js restores `hasUnsavedChanges` per tab, and it
    // has no hook for a renderer-global. A single boolean loses A's failure the
    // moment B saves successfully.
    what: "make the failed-save record a single global flag again instead of a per-path set",
    file: RENDERER,
    from: "    if (data.success && savedPath) failedSaves.delete(savedPath);",
    to: "    if (data.success) failedSaves.clear();",
    expect: [
      /a successful save of one document does not clear another document's recorded failure/,
      /returning to the document whose save failed finds its reload guard still armed/,
    ],
    mustPass: [
      /a failed view-mode auto-save records the failure and keeps the document dirty/,
      /a failure recorded for another document does not make the on-screen document look unsaved/,
    ],
  },
  {
    id: "R213",
    suite: "test:patch",
    // The failure branch used to ignore any reply that landed while the user
    // had entered edit mode - which is precisely what the retry advice tells
    // them to do while the note's own write is still unanswered.
    what: "ignore a save failure that arrives once the user has entered edit mode",
    file: RENDERER,
    from: "    if (savedPath) failedSaves.add(savedPath);\n    if (isForCurrent) {",
    to: "    if (savedPath && !isEditMode) failedSaves.add(savedPath);\n    if (isForCurrent && !isEditMode) {",
    expect: [/a save failure arriving after the user entered edit mode is still recorded/],
    mustPass: [
      /a failed view-mode auto-save records the failure and keeps the document dirty/,
      /entering edit mode with a write still unanswered keeps the document marked unsaved/,
    ],
  },
  {
    id: "R214",
    suite: "test:patch",
    // Not keeping the moved store is only half the fix: the newer note has no
    // write of its own yet, so declaring the document clean loses it at the
    // next reload with no prompt.
    what: "declare the document clean after a reply whose store had already moved on",
    file: RENDERER,
    from: "        : storeMovedDuringWrite;",
    to: "        : false;",
    expect: [/a store that moved mid-write is left marked unsaved, not clean/],
    mustPass: [
      /a save reply does not overwrite a view-mode store that moved while the write was in flight/,
    ],
  },
  {
    id: "R211",
    suite: "test:patch",
    // Unreachable before this phase - view mode never wrote - and reachable on
    // every note now. The store is the document in view mode, so adopting a
    // stale in-flight payload silently drops the newer note.
    what: "adopt the in-flight payload unconditionally, dropping a note confirmed while the write was still out",
    file: RENDERER,
    from: "      if (entry && !storeMovedDuringWrite) {",
    to: "      if (entry) {",
    expect: [/a save reply does not overwrite a view-mode store that moved while the write was in flight/],
    mustPass: [
      /a note added in view mode is written to disk without any save action/,
      /the document is not left looking unsaved after a note auto-save/,
    ],
  },
  {
    id: "R217",
    suite: "test:mermaid",
    // Found by BOTH independent reviewers, and measured before being fixed: a
    // webContents.reload() rebuilds the JS realm and its require('electron')
    // module instance, so a one-shot trap install is destroyed by it.
    //   before { flag: true,  openExternalPatched: true  }
    //   after  { flag: false, openExternalPatched: false }
    // The mermaid suite reloads mid-run to observe lazy loading from a clean
    // realm, so every assertion after that point used to run with the real
    // opener live - one clicked http link away from the leak this whole phase
    // exists to close. The trap therefore re-arms on did-finish-load, and this
    // revert removes that re-arm.
    what: "install the external-open trap only once, so a mid-suite reload silently un-traps the harness",
    file: VISUAL,
    from: "  if (!trapRearmed.has(wc)) {",
    to: "  if (false) {",
    expect: [
      /the external-open trap re-arms itself after a reload, so the rest of the suite still cannot reach the browser/,
      /the re-armed trap really replaced the shell functions, not just its own marker/,
    ],
    // The reload itself, and the lazy-loading assertions it exists to serve,
    // must be untouched - otherwise the revert has broken the suite rather
    // than exposing the hole.
    mustPass: [/mermaid is not loaded at startup/, /the lazy loader is present to fetch it later/],
  },
  {
    id: "R216",
    suite: "test:patch",
    // REPORTED BY THE USER, not found by a reviewer: the suite dispatched a
    // real click on a real http anchor, so renderer.js handed it to
    // shell.openExternal and the OS opened it in whatever browser they were
    // working in - stealing focus, and leaving one dead tab per suite run
    // (a full revert chain runs the suite dozens of times). Nothing failed,
    // which is why it survived until a human noticed their tab bar.
    //
    // The revert neutralises the install for EVERY suite at once, which is the
    // right blast radius: the trap is a property of the harness, not of one
    // test. Note what it does NOT do: it never clears a flag that was set. It
    // makes the install block unreachable, so the marker and the two shell
    // mutations disappear TOGETHER - and that pairing is what keeps the proof
    // free. The patch suite refuses to dispatch the click unless the marker is
    // set, so a revert that broke the mutation while leaving the marker true
    // would prove the same point by performing the very leak it documents.
    what: "stop trapping shell.openExternal in the harness, letting a clicked link reach the real browser",
    file: VISUAL,
    from: "    if (!window.__externalTrapInstalled) {",
    to: "    if (false) {",
    expect: [
      /external opens are trapped before any link is clicked, so the suite cannot reach the real browser/,
      /clicking a link inside a heading does not collapse the section/,
      /clicking a link inside a heading hands the URL to the external opener/,
    ],
    // The suite must otherwise be intact: if these fail too, the revert has
    // broken the harness rather than demonstrating the leak.
    mustPass: [
      /heading ids are slugs derived from the heading text/,
      /an in-document anchor target resolves by slug/,
    ],
  },
  {
    id: "R215",
    suite: "test:security",
    // Measured, not inferred: on the original expression a single trailing
    // space after the opening fence made it not match, and the raw HTML went
    // down the ordinary sanitized path with no diagnostic anywhere.
    what: "restore the intolerant @@@html fence, so a trailing space silently un-blocks the raw HTML",
    file: RENDERER,
    from: "const RAW_HTML_FENCE = /@@@html(?:\\([^)\\r\\n]*\\))?[ \\t]*[\\r\\n]+([\\s\\S]*?)[\\r\\n][ \\t]*@@@[ \\t]*/g;",
    to: "const RAW_HTML_FENCE = /@@@html[\\r\\n]+([\\s\\S]*?)[\\r\\n]@@@/g;",
    expect: [
      /FENCE a trailing space after the opening fence still produces a sandboxed @@@html frame \(full\)/,
      /FENCE a trailing space after the opening fence still produces a sandboxed @@@html frame \(light-format\)/,
      /FENCE a trailing tab after the opening fence still produces a sandboxed @@@html frame \(full\)/,
      /FENCE a trailing tab after the opening fence still produces a sandboxed @@@html frame \(light-format\)/,
      /FENCE an indented closing fence still produces a sandboxed @@@html frame \(full\)/,
      /FENCE an indented closing fence still produces a sandboxed @@@html frame \(light-format\)/,
      /FENCE an upstream parameter list still produces a sandboxed @@@html frame \(full\)/,
      /FENCE an upstream parameter list still produces a sandboxed @@@html frame \(light-format\)/,
    ],
    // The plain fence and the not-a-fence guard must survive the revert. If
    // they fail too, the revert has broken @@@html outright rather than
    // demonstrating the tolerance, and the proof would mean nothing.
    mustPass: [
      /FENCE the plain fence still produces a sandboxed @@@html frame \(full\)/,
      /FENCE the plain fence still produces a sandboxed @@@html frame \(light-format\)/,
      /FENCE a word glued to the opening fence is NOT treated as an @@@html block/,
      /SEC-01 @@@html iframe cannot reach window\.parent \(full render\)/,
    ],
  },
  {
    id: "R218",
    suite: "test:packaging",
    // The README is a SHIPPED surface (extraResources puts it in the installer
    // and the in-app welcome button opens it), and it now describes a POLICY
    // rather than just a feature list: the document is read-only in view mode.
    // Prose describing a mechanism rots when the mechanism moves, and this one
    // rots dangerously - a reader told the document cannot change under a
    // right-click, who is wrong, edits a file they meant only to read.
    //
    // So the claim is paired with the code that makes it true. This revert
    // removes the gate call and leaves the prose alone, which is precisely the
    // drift the pairing exists to catch: the README goes on promising a
    // read-only view mode that the product no longer has.
    what: "unwire the edit-mode context-menu gate while the README still promises a read-only view mode",
    file: RENDERER,
    from: "  applyEditModeMenuGating();",
    to: "  ;",
    expect: [/\.\.\.and the context menu is gated on edit mode, so that claim is still true/],
    // The prose half must survive: if the README assertions fail too, the
    // revert has perturbed both sides at once and demonstrates nothing about
    // the pairing.
    mustPass: [
      /the README states that document editing is confined to edit mode/,
      /the README names the inline formatting commands as edit-mode only/,
      /the README promises a view-mode note is written to the file immediately/,
    ],
  },
  {
    id: "R219",
    suite: "test:packaging",
    // The mirror of R218, and it is a separate entry because it fails from the
    // other side. R218 proves the code half is live; this proves the prose half
    // is. A single revert covering both would not distinguish "the claim is
    // checked" from "the mechanism is checked", and the whole value of the
    // pairing is that either one moving on its own is reported.
    //
    // The rewrite here is the plausible one - someone relaxing the policy and
    // updating the README to match, without noticing the gate is still in
    // place. That direction matters: it is how the prose and the product drift
    // apart in the harmless-looking direction, and it is the one a reviewer
    // reading only the diff would wave through.
    what: "reword the README's read-only claim so the shipped prose no longer describes the product",
    file: path.join(ROOT, "README.md"),
    from: "In view mode the document is read-only",
    to: "In view mode the document is fully editable",
    expect: [/the README states that document editing is confined to edit mode/],
    // The mechanism half must survive, or this is R218 wearing a different hat.
    mustPass: [
      /\.\.\.and the context menu is gated on edit mode, so that claim is still true/,
      /\.\.\.and the note commit helpers auto-save, so that claim is still true/,
      // The README's other shipped-surface guards must be untouched: this
      // reverts prose, and prose is exactly what those sweep.
      /vendor branding in the README is confined to the provenance section/,
      /the shipped README fetches no images over the network when the app opens it/,
    ],
  },
  {
    id: "R220",
    suite: "test:patch",
    // The defect this pins was LIVE and shipped: the README's keyboard table
    // claimed Ctrl+B / Ctrl+I / Ctrl+` (bold, italic, code) and Ctrl+D (dark
    // mode), and not one of the four had a handler anywhere in the app - no
    // renderer listener, no before-input-event branch, and this app registers
    // no Electron menu accelerators at all. A shortcut table is the part of a
    // README a reader tests within seconds, so a false row is discovered by
    // every user and reported by none of them.
    //
    // The revert restores ONE of the four, which is the honest reproduction:
    // documentation rots a row at a time, not a table at a time. It has to
    // fail two different assertions - the classification sweep (the row is not
    // measurable, main-process or element-scoped) and the explicit absence
    // check - because those are the two independent ways a false row can be
    // caught, and a guard that only had one of them would be pinned here by
    // accident rather than on purpose.
    what: "put the never-implemented Ctrl+D dark-mode row back into the README's shortcut table",
    file: path.join(ROOT, "README.md"),
    from: "| `Ctrl+F` | Search |\n",
    to: "| `Ctrl+F` | Search |\n| `Ctrl+D` | Toggle dark mode |\n",
    expect: [
      /every documented shortcut is classified, so none can be skipped by omission/,
      /the README no longer claims the four shortcuts that were never implemented/,
    ],
    // The measurement side must survive untouched. If the dispatch probe also
    // fails, this revert is reporting a broken harness rather than a false
    // claim - and the positive control is what says which.
    mustPass: [
      /every shortcut the README documents at document level is actually bound/,
      /the dispatch probe can observe a handled key, so an unhandled result means something/,
      /the four shortcuts the README used to claim really are unimplemented/,
    ],
  },
  {
    id: "R221",
    suite: "test:patch",
    // The mirror of R220, from the code side. Ctrl+R is the refresh shortcut,
    // which is the single most-used affordance in this fork - the whole
    // project started from "I refresh a file and another tab reverts" - and it
    // was MISSING from the README until this change. Documenting it is only
    // worth anything if the documentation is checked against the binding, so
    // this neutralises the binding and requires the suite to notice.
    //
    // Anchored at the condition rather than at the body: a future refactor may
    // move reloadCurrentFile() or add an unsaved-work branch, and neither
    // should rot the pin. Killing the condition kills the shortcut however its
    // body is written.
    what: "neutralise the Ctrl+R refresh binding while the README goes on documenting it",
    file: RENDERER,
    from: "  if ((e.ctrlKey || e.metaKey) && e.key === 'r') {",
    to: "  if (false) {",
    expect: [/every shortcut the README documents at document level is actually bound/],
    // The positive control must still hold: if the probe can no longer observe
    // ANY handled key then this is measuring a broken dispatch, not a missing
    // shortcut, and the failure above would be worthless.
    mustPass: [
      /the dispatch probe can observe a handled key, so an unhandled result means something/,
      /the four shortcuts the README used to claim really are unimplemented/,
      /every documented shortcut is classified, so none can be skipped by omission/,
    ],
  },
  {
    id: "R222",
    suite: "test:packaging",
    // THE PROOF THAT THE TIGHTENING WAS LOAD-BEARING. Both independent
    // reviewers, separately, called the first version of these mechanism
    // oracles a source-text grep that could pass with the behaviour broken.
    // This revert is the demonstration: commenting the call out disables the
    // gate completely, and the ORIGINAL regex (/applyEditModeMenuGating\(\);/)
    // would have gone on matching the commented line and reported green. The
    // structural oracle parses showContextMenu's body and ignores comment
    // lines, so it fails.
    //
    // Kept distinct from R218, which DELETES the call. Deletion is the easy
    // case that any substring check catches; disabling-in-place is the case
    // that separates a real oracle from a grep, and it is also the more likely
    // accident - it is what a developer does while bisecting.
    what: "comment out the context-menu gate call, leaving the identifier in place for a grep to find",
    file: RENDERER,
    from: "  applyEditModeMenuGating();",
    to: "  // applyEditModeMenuGating();",
    expect: [/\.\.\.and the context menu is gated on edit mode, so that claim is still true/],
    mustPass: [
      /the README states that document editing is confined to edit mode/,
      /\.\.\.and the gate owns those items and restores them in edit mode, so that claim is still true/,
      /\.\.\.and the note commit helpers auto-save, so that claim is still true/,
    ],
  },
  {
    id: "R223",
    suite: "test:packaging",
    // The same demonstration for the auto-save half, which was the weakest of
    // the three: the original regex matched FOUR lines, one of them a comment
    // and one the function's own definition, so deleting BOTH call sites - i.e.
    // breaking view-mode note auto-save outright - left two matches behind and
    // the assertion green. Removing one call site here drops the live count
    // below the required two.
    what: "unwire one of the two view-mode note auto-save call sites",
    file: RENDERER,
    // The call line on its own appears twice, once per commit helper, so the
    // anchor needs the preceding line for uniqueness. \n is correct here: the
    // harness expands it to the file's own EOL (renderer.js is CRLF).
    from: "  commitViewModeEdit(newContent, scrollPosition);\n  return autoSaveViewModeNote();",
    to: "  commitViewModeEdit(newContent, scrollPosition);\n  return false;",
    expect: [/\.\.\.and the note commit helpers auto-save, so that claim is still true/],
    mustPass: [
      /the README promises a view-mode note is written to the file immediately/,
      /\.\.\.and the context menu is gated on edit mode, so that claim is still true/,
    ],
  },
  {
    id: "R224",
    suite: "test:packaging",
    // And for the third: the original regex matched only the function's
    // SIGNATURE, so emptying the returned list - which makes every inline
    // formatting command visible in view mode, the exact policy violation the
    // README describes - could not fail it. The oracle now requires the body to
    // name all eight controls the README bullet enumerates, so prose and list
    // close the loop on each other.
    what: "drop one control from the edit-mode gate's list while the README goes on enumerating it",
    file: RENDERER,
    from: "    ctxBold, ctxItalic, ctxCode, ctxList, ctxRemoveFormat,",
    to: "    ctxItalic, ctxCode, ctxList, ctxRemoveFormat,",
    expect: [/\.\.\.and the gate owns those items and restores them in edit mode, so that claim is still true/],
    mustPass: [
      /the README names the inline formatting commands as edit-mode only/,
      /\.\.\.and the context menu is gated on edit mode, so that claim is still true/,
    ],
  },
  {
    id: "R225",
    suite: "test:packaging",
    // The shipped README claimed the installer registers all seven supported
    // extensions. It registers three. A reader who believes it right-clicks a
    // .markdown file, finds no Folia entry under Open with, and concludes the
    // install is broken. Measured against package.json's own fileAssociations,
    // so the sentence cannot drift from the build again in either direction.
    what: "claim an extension the installer does not actually register",
    file: path.join(ROOT, "README.md"),
    from: "handler for `.md`, `.mmd` and `.mermaid`",
    to: "handler for `.md`, `.mmd`, `.mermaid` and `.markdown`",
    expect: [/the README names exactly the extensions the installer actually registers/],
    mustPass: [
      /the build declares the file associations the README's claim is checked against/,
      /the README's download table lists every artefact the release publishes/,
    ],
  },
  {
    id: "R226",
    suite: "test:packaging",
    // The download table listed three of the five artefacts release.yml
    // publishes, so a macOS reader - and anyone wanting the portable build -
    // was told their platform did not exist. The check is driven from
    // build.win/mac/linux targets, so adding a target without a row fails, and
    // the "every target is one the check knows how to look for" assertion stops
    // a NEW target from being silently unchecked rather than reported missing.
    what: "drop the Windows portable row from the README's download table",
    file: path.join(ROOT, "README.md"),
    from: "| Windows | `Folia X.X.X.exe` | Portable, no installation |\n",
    to: "",
    expect: [/the README's download table lists every artefact the release publishes/],
    mustPass: [
      /every build target is one the download-table check knows how to look for/,
      /the README names exactly the extensions the installer actually registers/,
    ],
  },
  {
    id: "R227",
    // The performance defect, restored exactly: measure each table on its own,
    // write-then-read, which forces one full-document layout per table and
    // makes the pass O(tables x document). Measured at 35.5s of a 45.6s render
    // on a 1 MB document, against 2.3s batched.
    //
    // Note this revert is GEOMETRICALLY CORRECT - preferredTableWidth() is the
    // same measurement, taken one table at a time - so nothing else may fail.
    // That is the point: the only thing separating the two versions is when the
    // layouts happen, and a suite that could not tell them apart would have let
    // this regress silently.
    what: "measure each table one at a time (write-then-read per table, forcing a full-document layout for every table)",
    file: RENDERER,
    from: "      preferredStates.push(tablePreferredBegin(m.container, capMemo));",
    to: "      preferredStates.push(null);",
    also: {
      from: "      const preferred = preferredStates[i] ? tablePreferredRead(preferredStates[i]) : 0;",
      to: "      const preferred = preferredTableWidth(m.container, capMemo);",
    },
    expect: [/every table is sized for measurement before any of them is measured/],
    mustPass: [
      // Geometry must be untouched. If these fail, the revert has broken the
      // measurement rather than merely un-batching it.
      /a table too wide for the reading column is widened/,
      /an explanation column is given a readable measure/,
      /the measurement pass leaves no table stuck at max-content/,
    ],
  },
  {
    id: "R228",
    suite: "test:patch",
    // Drain the parsed blocks one at a time instead of in bulk. Removing a
    // child costs time proportional to the container's size, so this is the
    // O(n^2) half of the render: 23.7s against 36ms on a 1 MB document.
    //
    // The revert leaves temp populated, so every node is still attached to it
    // when viewer.insertBefore detaches it - which is precisely what the
    // assertion observes.
    what: "leave the parsed blocks attached to their parser container, so each insert detaches one node at a time",
    file: RENDERER,
    from: "  temp.replaceChildren();",
    to: "  /* bulk drain reverted for proof */",
    expect: [/every new block is already detached when it is inserted/],
    mustPass: [
      /the bulk-drain probe really replaced a whole document/,
      /a full replacement clears the viewer in one go rather than node by node/,
    ],
  },
  {
    id: "R229",
    suite: "test:patch",
    // The other half: when nothing was reused, clear the viewer node by node.
    // Kept as a separate revert from R228 because the two are independent
    // defects on opposite sides of the same loop, and a fix for one does not
    // imply the other.
    what: "clear the viewer node by node even when nothing was reused",
    file: RENDERER,
    from: "  if (!pairs.length) {\n    viewer.replaceChildren();\n  } else {\n    oldEls.forEach((el, i) => {\n      if (!reusedOld[i]) el.remove();\n    });\n  }",
    to: "  oldEls.forEach((el, i) => {\n    if (!reusedOld[i]) el.remove();\n  });",
    expect: [/a full replacement clears the viewer in one go rather than node by node/],
    mustPass: [
      /the bulk-drain probe really replaced a whole document/,
      /every new block is already detached when it is inserted/,
    ],
  },
  {
    id: "R230",
    // The batching oracle's own blind spot, found in review. Writing every
    // table up front and then releasing each one as soon as it has been read is
    // still one forced layout per table - the quadratic, restored - but the
    // FIRST sample still sees all N at max-content. An assertion on the MAXIMUM
    // concurrent count therefore stays green. Only the minimum can tell the two
    // apart, and this revert is what proves it does.
    //
    // Geometrically identical to the fix: restoring a table after its own read
    // cannot change that read. Nothing but the batching assertion may fail.
    what: "release each table as soon as it is read, so only the first measurement sees a batched document",
    file: RENDERER,
    from: "      const preferred = preferredStates[i] ? tablePreferredRead(preferredStates[i]) : 0;\n      m.wanted = Math.max(m.rect * m.overflow, preferred);",
    to: "      const preferred = preferredStates[i] ? tablePreferredRead(preferredStates[i]) : 0;\n      if (preferredStates[i]) tablePreferredRestore(preferredStates[i]);\n      m.wanted = Math.max(m.rect * m.overflow, preferred);",
    expect: [/every table is sized for measurement before any of them is measured/],
    mustPass: [
      /the batching probe really measured several tables/,
      /the measurement pass leaves no table stuck at max-content/,
      /a table too wide for the reading column is widened/,
    ],
  },
  {
    id: "R231",
    // Exception safety. Batching is what makes this matter: the un-batched
    // version could strand one table at max-content, this one strands every
    // table in the document, and no resize follows to repair it.
    what: "restore table widths outside a finally, so a throw mid-measurement strands every table at max-content",
    file: RENDERER,
    from: "  const preferredStates = [];\n  try {",
    to: "  const preferredStates = [];\n  {",
    also: {
      from: "  } finally {\n    // Write pass: put every table's own width back before anything is applied,\n    // so the apply pass below starts from the layout the reader had.\n    preferredStates.forEach((state) => {\n      if (state) tablePreferredRestore(state);\n    });\n  }",
      to: "  }\n  preferredStates.forEach((state) => {\n    if (state) tablePreferredRestore(state);\n  });",
    },
    expect: [/a measurement that throws part way through still puts every table back/],
    mustPass: [
      /the injected measurement failure really did abort the pass/,
      /every table is sized for measurement before any of them is measured/,
      /the measurement pass leaves no table stuck at max-content/,
    ],
  },
  {
    id: "R232",
    suite: "test:patch",
    // The staging half of the drain guard. This revert still leaves every node
    // parentless before it is inserted, so the "already detached" assertion
    // stays green - it is only the one-at-a-time detach that is restored, which
    // is the whole cost. An oracle that watched only the viewer would miss it.
    what: "drain the staging container one child at a time instead of in one bulk clear",
    file: RENDERER,
    from: "  temp.replaceChildren();",
    to: "  while (temp.firstChild) temp.removeChild(temp.firstChild);",
    expect: [/the staging container is drained in one go rather than node by node/],
    mustPass: [
      /the bulk-drain probe really replaced a whole document/,
      /every new block is already detached when it is inserted/,
    ],
  },
  {
    id: "R233",
    suite: "test:patch",
    // Same defect as R229, reached through a different API. The first version
    // of this oracle counted only Element.prototype.remove, so clearing the
    // viewer with removeChild would have restored the quadratic and stayed
    // green. Counting by effect rather than by method is what this proves.
    what: "clear the viewer with removeChild in a loop rather than one bulk clear",
    file: RENDERER,
    from: "    viewer.replaceChildren();",
    to: "    while (viewer.firstChild) viewer.removeChild(viewer.firstChild);",
    expect: [/a full replacement clears the viewer in one go rather than node by node/],
    mustPass: [
      /the bulk-drain probe really replaced a whole document/,
      /every new block is already detached when it is inserted/,
    ],
  },
  {
    id: "R234",
    suite: "test:tabs",
    // The decline path. A guard that always proceeds still ASKS, so an oracle
    // that only counted dialogs would call this fixed; what breaks is that the
    // answer is ignored, and the reader is dragged onto a document they
    // declined. Note it also stops asking on the second and third visits,
    // because the memo records an acceptance that never happened.
    what: "ignore the reader's answer and switch to the expensive tab anyway",
    file: TABS,
    from: "    if (tabId !== activeTabId && !confirmLargeTab(tab)) {",
    to: "    if (false) {",
    expect: [
      /opening an expensive file asks, and declining leaves the reader put/,
      /switching to an expensive tab asks first/,
      /declining leaves the reader on the tab they were viewing/,
      /declining leaves the document they were reading on screen/,
      /accepting switches to the expensive tab/,
    ],
    mustPass: [
      /the guard sample really is scored as expensive and the control is not/,
      /an ordinary document is never asked about/,
    ],
  },
  {
    id: "R235",
    suite: "test:tabs",
    // The memo. Without it the reader is asked about the same document every
    // time they come back to its tab, which is the same mistake as guarding
    // the refresh path: a confirmation that fires dozens of times a session is
    // one the reader learns to dismiss without reading.
    what: "ask again about a document whose cost was already accepted",
    file: TABS,
    from: "    if (largeConfirmed.has(tab.id)) return true;",
    to: "    // memo disabled",
    expect: [/a cost already accepted is not asked about again/],
    mustPass: [
      /declining leaves the reader on the tab they were viewing/,
      /accepting switches to the expensive tab/,
    ],
  },
];

const argv = process.argv.slice(2);
// A refactor cannot break a revert's ASSERTIONS without also running its suite,
// but it breaks a revert's ANCHOR - the text the harness perturbs - for free,
// silently, and the report only arrives hours later at the end of a full run.
// Moving files between directories does it wholesale. `--anchors` does just the
// string half of the setup for every revert and runs no suite at all, so the
// class of damage a refactor actually causes is checkable in a second.
// It is deliberately NOT a substitute for a real run: an anchor that still
// matches proves nothing about whether the assertions it is paired with still
// fail.
const anchorsOnly = argv.includes("--anchors");
const only = argv.filter((a) => a !== "--anchors");
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
// A file that has MOVED is the other half of the refactor hazard, and it used
// to surface as an unhandled ENOENT that killed the whole run before the first
// revert. Report it per-revert instead, so one stale path cannot hide the state
// of the other 190.
const absentFiles = [...touched].filter((f) => !fs.existsSync(f));
for (const f of touched) if (!absentFiles.includes(f)) snapshots.set(f, fs.readFileSync(f, "utf8"));

for (const r of chosen) {
  // A revert may need more than one paired edit - sometimes in DIFFERENT files
  // - to restore the shape of the previous implementation; applying only half
  // of it would prove nothing. Originals are keyed by path so every touched
  // file is restored, including when the run throws.
  const edits = [{ file: r.file, from: r.from, to: r.to }].concat(
    r.also ? [Object.assign({ file: r.file }, r.also)] : [],
  );
  let setupFailed = null;
  const originals = new Map();
  for (const e of edits) {
    if (absentFiles.includes(e.file)) {
      setupFailed = `file does not exist: ${path.relative(ROOT, e.file)}`;
      break;
    }
    if (!originals.has(e.file)) originals.set(e.file, fs.readFileSync(e.file, "utf8"));
  }
  const working = new Map(originals);
  for (const e of setupFailed ? [] : edits) {
    // `to` is written with plain \n and expanded to the file's own EOL below.
    // A literal \r\n therefore becomes \r\r\n - a lone CR, which silently marks
    // the file `-text` in git and defeats EOL normalisation for it. That is the
    // very defect R156 exists to detect, so a revert must never introduce it by
    // accident. (A bare \r with no \n is legitimate: that IS R156's payload.)
    if (/\r\n/.test(e.to) || /\r\n/.test(e.from)) {
      setupFailed = `revert text contains a literal CRLF; use \\n - the harness expands it to the file's EOL`;
      break;
    }
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
  if (anchorsOnly) {
    console.log(`${r.id}  anchor OK  (${path.relative(ROOT, r.file)})`);
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
  // A revert can "prove" itself by coincidence: if the setup assertion that
  // makes the real assertion meaningful ALSO fails, the expected name still
  // appears in the failure list while nothing has actually been demonstrated.
  // mustPass names the assertions that have to survive the revert for its
  // proof to mean what it claims.
  const collateral = (r.mustPass || []).filter((re) => fails.some((f) => re.test(f)));
  if (fails.length === 0) {
    console.log(`${r.id}  VACUOUS       suite stayed green with the fix removed  (${r.what})`);
    bad += 1;
  } else if (missing.length) {
    console.log(
      `${r.id}  WRONG-GUARD   failed, but not on the expected assertions. missing=${missing} got=${JSON.stringify(fails.slice(0, 4))}`,
    );
    bad += 1;
  } else if (collateral.length) {
    console.log(
      `${r.id}  COLLATERAL    the expected assertion failed, but so did its own setup, so it proves nothing. broke=${collateral}`,
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

console.log(
  anchorsOnly
    ? bad === 0
      ? `\nALL ${chosen.length} ANCHORS RESOLVE - nothing is proven; run without --anchors for that`
      : `\n${bad} revert(s) can no longer find what they perturb`
    : bad === 0
      ? "\nALL REVERTS PROVEN"
      : `\n${bad} revert(s) did not prove their fix`,
);
process.exit(bad === 0 && dirty === 0 ? 0 : 1);
