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
const VISUAL = path.join(ROOT, "test-visual-utils.js");
const RELEASE = path.join(ROOT, "scripts", "release.js");
const PKG = path.join(ROOT, "package.json");
const NOTICES = path.join(ROOT, "THIRD-PARTY-NOTICES.md");
const LICENSE_TXT = path.join(ROOT, "LICENSE.txt");
const LICENSE_MD = path.join(ROOT, "LICENSE");
const NOTICES_GEN = path.join(ROOT, "scripts", "generate-notices.js");
const ATTRS = path.join(ROOT, ".gitattributes");

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
    from: "    applyTableBreakout();\n    // Capture the baseline BEFORE the flag is zeroed",
    to: "    // Capture the baseline BEFORE the flag is zeroed",
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
    from: "      if (entry) {\n        originalMarkdown = entry.content;\n        invalidateTranslationCache();\n      } else if (isEditMode) {",
    to: "      if (false) {\n        originalMarkdown = entry.content;\n        invalidateTranslationCache();\n      } else if (true) {",
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
    from: "      if (entry) {\n        originalMarkdown = entry.content;",
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
    from: "      hasUnsavedChanges = isEditMode\n        ? markdownEditor.value !== originalMarkdown\n        : false;",
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
      /the two-writes-in-flight case really was set up: the last write won on disk/,
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
      // 13e2's two preconditions. Both are ordinary suite assertions already,
      // but listing them here makes them fail as COLLATERAL during a proof run
      // rather than only in a normal run: if the scenario ever starts with a
      // file open (so its invalidateTranslationCache() kicks off real work) or
      // stops marking the document dirty, this revert's proof is measuring a
      // scenario that no longer does what its name claims.
      /13e2 runs with no file open, so its translation-cache invalidation is inert/,
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
    // Proves the coverage oracle is live rather than decorative. NOTE: since
    // the generator was changed to read package-lock.json directly, this
    // oracle shares a source with it and so checks the walk and the rendering
    // rather than the source. The asar oracle (R135) is the independent one.
    id: "R131",
    suite: "test:packaging",
    what: "ship notices with a production dependency missing from them",
    file: NOTICES,
    from: "### dompurify 3.4.12",
    to: "### (removed)",
    expect: [
      /every production dependency in package-lock\.json has a notice/,
      /committed notices file is not stale/,
    ],
    mustPass: [
      /vendored Tabulator is documented/,
      /Fira Code is documented/,
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
    from: "    if (meta.dev || meta.devOptional) continue;",
    to: "    if (false) continue;",
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
    // The pako defect this defends was NOT that a licence was missing from the
    // tree - pako's MIT text was reproduced correctly all along, and the entry
    // read as complete. `(MIT AND Zlib)` was silently treated as if it were one
    // of the `OR` expressions, so the second, equally binding limb was dropped.
    // Neutralising the CONJUNCTIVE table restores exactly that state, which is
    // why the assertion this is aimed at looks for Zlib's OWN operative clauses
    // rather than for the presence of a second block: a block could be there
    // and still say the wrong thing.
    //
    // The generator's own guard throws when it sees this state, so the reverted
    // run fails at generation. That is the intended behaviour and the reason
    // `the notices generator runs` is NOT in mustPass - a fail-loud generator
    // is the fix, not collateral damage.
    id: "R141",
    suite: "test:packaging",
    what: "treat a conjunctive (AND) licence as if one limb were enough",
    file: path.join(ROOT, "scripts", "generate-notices.js"),
    from: "const CONJUNCTIVE = {\n  pako: {",
    to: "const CONJUNCTIVE = {\n  __disabled_pako: {",
    expect: [/the notices generator runs/],
  },
  {
    // R141 and R142 are deliberately NOT the same proof, and the split is the
    // point. R141 shows the GUARD is load-bearing: drop the table and the
    // generator refuses to emit at all. R142 shows the guard is not SUFFICIENT:
    // `collect()` still populates `extraLicences`, so the guard is satisfied
    // and the generator runs happily - while the rendered notices silently lose
    // the Zlib text. That second state is the dangerous one, because it is the
    // one that looks fine, and only an assertion on the reproduced TEXT catches
    // it. Without this entry, a refactor of `render()` could re-open the
    // original defect with every guard still green.
    id: "R142",
    suite: "test:packaging",
    what: "collect a conjunctive licence's extra terms but never render them",
    file: path.join(ROOT, "scripts", "generate-notices.js"),
    from: "for (const e of c.extraLicences || []) {",
    to: "for (const e of []) {",
    expect: [/reproduces the operative terms of every limb/],
    mustPass: [/the notices generator runs/],
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
    id: "R144",
    suite: "test:packaging",
    what: "reference a README image by relative path, which the app cannot resolve",
    file: path.join(ROOT, "README.md"),
    from: ' alt="Folia" width="100">',
    to: ' alt="Folia" width="100">\n  <img src="logo.png" alt="Folia">',
    expect: [/README images are embedded/],
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
      /authored src is preserved for the note and slider/,
    ],
  },
  {
    id: "R148",
    suite: "test:security",
    what: "stop recording the authored image src (the note and slider features rebuild `![alt](src)` and search the markdown source for it, so they stop matching)",
    file: RENDERER,
    from: "        node.setAttribute('data-original-src', raw);",
    to: "        void raw;",
    // Deliberately narrow, and that is the point: the images still LOAD under
    // this revert. Only the source-matching contract breaks, which is the half
    // a "does the picture appear" test can never see.
    expect: [/authored src is preserved for the note and slider/],
  },
  {
    id: "R149",
    suite: "test:security",
    what: "search the markdown source for `![alt](src)` and nothing else (marked normalises `<a b.png>` into `a%20b.png`, so the source text never contains the rendered src)",
    file: RENDERER,
    from: "  for (const pattern of markdownImageCandidates(alt, src)) {",
    to: "  for (const pattern of [`![${alt}](${src})`]) {",
    // Both consumers, driven through their real context-menu handlers. This is
    // what makes "the note and slider features still work" a measured claim
    // rather than an inference from the fact that the image now loads - R148
    // already showed those two properties are independent.
    expect: [
      /add-to-slider finds an image whose markdown destination marked normalised/,
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
    from: '"publish": [{ "provider": "github", "owner": "lostinsea", "repo": "markdown-viewer" }],',
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
    file: path.join(ROOT, "CUSTOMIZATIONS.md"),
    from: "## Modifying Customizations",
    to: "## Modifying Customizations\r",
    expect: [/no tracked source file contains a lone CR/],
  },
  {
    id: "R157",
    suite: "test:mermaid",
    // The export used to size the raster from getBoundingClientRect(), which
    // reports VIEWPORT pixels and therefore scales with the app's CSS zoom.
    // Measured on one diagram: the rect read 63.1 / 126.2 / 189.2 at 50% /
    // 100% / 150% while the SVG's own viewBox stayed 126.2 throughout. So the
    // resolution of an exported diagram depended on how the reader happened to
    // have zoomed the window - a property of the reader leaking into the
    // document. Every other assertion in the section passes under this revert,
    // because a wrongly-sized raster still decodes and still draws its labels.
    what: "size the export raster from the on-screen rect again, so the zoom level leaks into the exported file",
    file: RENDERER,
    from: "  const box = svg.viewBox && svg.viewBox.baseVal;",
    to: "  const box = svg.getBoundingClientRect();",
    expect: [/the exported diagram is the same size whatever the reader's zoom/],
  },
  {
    id: "R158",
    suite: "test:mermaid",
    // mermaid BAKES its colours into the emitted SVG, so dropping the
    // .dark-mode class is not enough - the diagram has to be re-rendered under
    // the light theme. The PDF path has done this for a long time; the Word
    // path never did, and exported dark diagrams onto white Word pages. On a
    // gantt chart that meant a light grey title and date axis on white.
    what: "export to Word without re-theming, so a reader in dark mode gets dark diagrams on a white page",
    file: RENDERER,
    // The anchor carries the preceding comment line, because
    // `await setExportTheme(false);` alone is not unique - the PDF handler
    // makes the identical call - and a non-unique anchor is rejected by this
    // harness rather than silently patching the wrong site. The revert
    // reproduces the historical defect exactly: drop the body class and leave
    // the diagrams underneath it baked in the reader's dark theme.
    from:
      "  beginExportThemeHold();\n" +
      "  try {\n" +
      "    await setExportTheme(false);",
    to:
      "  beginExportThemeHold();\n" +
      "  try {\n" +
      "    document.body.classList.remove('dark-mode');",
    expect: [
      /the Word export renders diagrams in the light theme, not the reader's dark one/,
      // The mid-export assertion fails for the same root cause: with no
      // re-theme at all, whatever the diagrams happen to be wearing when the
      // rasteriser reaches them is what lands in the document. Listed rather
      // than tolerated silently, so the pair is a recorded relationship. This
      // list is what MUST fail, not an exhaustive one - section 8e's overlap
      // assertions read the same diagrams and go down with it too.
      /a theme change made during a Word export cannot re-theme the diagrams it is exporting/,
    ],
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
    what: "restore the theme after a Word export from a stale snapshot instead of the reader's current preference",
    file: RENDERER,
    from:
      "      const restoreDark = resolveDarkPreference();\n" +
      "      if (restoreDark !== document.body.classList.contains('dark-mode')) {\n" +
      "        await setExportTheme(restoreDark);\n" +
      "      }\n" +
      "    }",
    to:
      "      if (document.body.dataset.wasDark === '1') await setExportTheme(true);\n" +
      "    }",
    // The paired edit takes the snapshot, where the removed one was taken.
    also: {
      from:
        "  beginExportThemeHold();\n" +
        "  try {\n" +
        "    await setExportTheme(false);",
      to:
        "  beginExportThemeHold();\n" +
        "  try {\n" +
        "    document.body.dataset.wasDark = document.body.classList.contains('dark-mode') ? '1' : '0';\n" +
        "    await setExportTheme(false);",
    },
    expect: [
      /a theme change made during a Word export is not undone when it finishes/,
    ],
  },
  {
    id: "R163",
    suite: "test:mermaid",
    // An export forces the document light, then spends seconds rasterising
    // every diagram. A theme change made from the menu inside that window does
    // NOT go through a preference write alone - custom-theme.js clicks the
    // real toggle, which re-renders every mermaid SVG under the new theme,
    // underneath an export that is still reading them. Measured on a Word
    // export interrupted by picking Dark: the exported PNG came out closer to
    // the DARK reference (21.07) than the light one (21.54).
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
      /a theme change made during a Word export cannot re-theme the diagrams it is exporting/,
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
    id: "R165",
    suite: "test:mermaid",
    // Two exports can overlap - start a Word export, reopen the File menu and
    // choose Export as PDF - and both read the document for seconds. If every
    // release restores the reader's theme rather than only the last one out,
    // the PDF's restore puts the document back into dark UNDERNEATH a Word
    // export that is still rasterising, and the diagrams it has not reached
    // yet are baked in the reader's theme. Found in independent review;
    // reproduced only after the fixture was scrolled to the BOTTOM, because
    // PERF-07 re-themes what the reader can see and at the top the export loop
    // is always ahead of the damage. Measured on 30 diagrams: the worst one in
    // the finished Word file sat 2.55 from the DARK reference and 99.17 from
    // the light one.
    what: "restore the reader's theme on every export release instead of only the last one out",
    file: RENDERER,
    from: "    if (endExportThemeHold() === 0) {",
    to: "    if ((endExportThemeHold(), true)) {",
    expect: [
      /an export that finishes cannot restore the theme while a PDF export is still capturing/,
    ],
  },
  {
    id: "R166",
    suite: "test:mermaid",
    // The same gate on the PDF side, which is the half that actually fires in
    // the overlap: the Word export is the one still rasterising, so it is the
    // PDF result handler whose restore has to stand down. Reviewed as a gap -
    // the Word path had a revert and the identical PDF reconciliation had
    // none, so a regression there would have shipped green.
    what: "let a finishing PDF export restore the theme while another export is still reading the document",
    file: RENDERER,
    // Two spaces of indent is a SUBSTRING of the Word path's four, which the
    // harness would reject as a non-unique anchor, so this carries the
    // preceding comment line to pin it to the PDF handler.
    from:
      "  // back while the Word export is still rasterising.\n" +
      "  if (endExportThemeHold() === 0) {",
    to:
      "  // back while the Word export is still rasterising.\n" +
      "  if ((endExportThemeHold(), true)) {",
    expect: [
      /a concurrent export cannot re-theme the diagrams the export it overlaps is still reading/,
    ],
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

console.log(bad === 0 ? "\nALL REVERTS PROVEN" : `\n${bad} revert(s) did not prove their fix`);
process.exit(bad === 0 && dirty === 0 ? 0 : 1);
