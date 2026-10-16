# Performance Audit

## Executive summary

| ID | Issue | Measured impact | Estimated fix effort | ROI |
|---|---|---:|---|---|
| PERF-01 | **[FIXED]** `main.js` eagerly loads heavy optional modules on startup | `require("html-to-docx")` = **370.1ms**; `require("electron-updater")` = **174.7ms**; **544.8ms** total main-thread startup blocking before the window loads | Low | High |
| PERF-02 | **[FIXED]** Search rewrites the entire rendered DOM on every keystroke | On a **2.0MB / 2001-heading** doc, `highlightSearchTerm()` took **316.0ms** JS time for a common term (3591 matches) | Medium | High |
| PERF-03 | **[FIXED]** Mermaid is eagerly loaded at startup even for plain markdown | Shipped `libs/vendor/mermaid.min.js` is **3259.3KB**; measured against the real shipped build, launches that open no diagram went from **473ms to 348ms** (about **125ms** saved) | Medium | High |
| PERF-04 | **[FIXED]** Any doc containing Mermaid is forced down the full render path for small text edits | On a **225KB / 20-diagram** doc, a 1-line edit still ran `renderMarkdownFull()` for **93.9ms** even though `mermaid.run()` was **not called** | Medium | High |
| PERF-05 | **[FIXED]** Code-heavy updates still re-highlight and re-wrap all code blocks | On a **1.46MB / 200-code-block** doc, a small edit still spent **48.5ms** in Prism highlighting + **9.9ms** adding copy buttons | Medium | High |
| PERF-06 | **[FIXED]** TOC + collapsible-section rebuild runs on every render | On a **2.0MB / 2001-heading** doc, `buildTableOfContents()` + `makeHeadersCollapsible()` cost **27.1ms** on full render and about **30ms** on changed renders | Medium | Medium |
| PERF-07 | **[FIXED]** Mermaid theme changes synchronously re-render every diagram | Toggling theme on a **20-diagram** doc spent **423.7ms** in `mermaid.run()` and **431.6ms** total in `updateMermaidTheme()`; visible-first rendering cut the blocking toggle to **~85ms** | Medium | Medium |
| PERF-10 | **[FIXED]** The shutdown approval scan recomputed every open document's dirtiness | Closing after editing every tab, at **25 tabs x 2MB**: raw p95 **22.4936ms** (LF) and **98.1947ms** (CRLF) against a predeclared **16.7ms** budget; maintaining the answer at the edit instead brought the same observations to **1.002ms** and **1.2792ms** | Medium | High |
| PERF-11 | **[FIXED ON INTEGRATION BRANCH; UNRELEASED]** Closing with an active 2 MB editor rebuilt newline spelling and repeated whole-document comparisons | At **25 tabs x 2MB**, active-editor raw p95 **90.654ms** (LF) / **117.275ms** (CRLF), versus **9.6951ms** / **11.7335ms** on the latest product bytes; predeclared budget **16.7ms**, final matrix **42/42** within budget | Medium | High |

## Measurement methodology

- Original audit machine: **AMD EPYC 7763**, 16 vCPU exposed / 32 logical processors, **127.9GB RAM**, **Windows 11 Enterprise 26200**
- Original audit runtime: **Electron v41.7.1**, **Node v20.18.3**; later experiments specify their own environment below.
- Harness: copied the `test-tab-refresh.js` pattern:
  - `require("./main.js")`
  - wait for `BrowserWindow.getAllWindows()[0]`
  - run probes inside the renderer with `webContents.executeJavaScript(...)`
- Safety:
  - killed stale `electron.exe` first (`Get-CimInstance Win32_Process ...` + `Stop-Process -Id <pid>`)
  - replaced `alert()` / `confirm()` in the renderer so `executeJavaScript` could not hang
  - added a 10-minute watchdog
- The scratch harness was `perf-bench-temp.js` in repo root and wrote fixtures/results under `tmp\perf-audit\`.
- Instrumentation wrapped these real functions to get per-function timings:
  - `marked.parse`
  - `DOMPurify.sanitize`
  - `renderMarkdownFull`
  - `renderLightFormat`
  - `mermaid.run`
  - `Prism.highlightAll` / `Prism.highlightElement`
  - `buildTableOfContents`
  - `makeHeadersCollapsible`
  - `CustomTabs.switchToTab`
- Important interpretation note: end-to-end `totalMs` numbers included a conservative post-render “settle” window so async idle work could finish. For ranking, I used the wrapped function timings above, not the settle-inclusive totals, whenever those diverged.

### Fixtures used

| Fixture | Size | Headings | Code blocks | Mermaid diagrams |
|---|---:|---:|---:|---:|
| plain50k | 70,451 B | 101 | 0 | 0 |
| plain500k | 705,852 B | 1001 | 0 | 0 |
| plain2m | 2,097,550 B | 2001 | 0 | 0 |
| code10 | 86,685 B | 121 | 10 | 0 |
| code200 | 1,457,212 B | 2001 | 200 | 0 |
| mermaid5 | 92,249 B | 121 | 0 | 5 |
| mermaid20 | 225,380 B | 301 | 0 | 20 |

### Repro harness outline

```js
const { app, BrowserWindow } = require("electron");
require("./main.js");

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  // install wrappers for marked.parse, DOMPurify.sanitize, mermaid.run,
  // Prism.highlightAll/Element, renderMarkdownFull, renderLightFormat,
  // buildTableOfContents, makeHeadersCollapsible, CustomTabs.switchToTab

  // generate fixture files under tmp\\perf-audit\\
  // call window.renderMarkdown(...) / window.updateMermaidTheme(...)
  // measure with performance.now() inside the renderer
  // record results as JSON
});
```

## Sticky table-header scrolling

- Baseline: `66ac16ea`; candidate uses the same locked dependencies and fixture.
- Runtime: Windows, Electron 43.4.1. Open TOC, narrow 850 x 800 window,
  two long tables, a horizontally overflowing table, prose and five diagrams.
- Three serial runs per version, interleaved baseline/candidate. Each run uses
  an isolated profile and 90 bidirectional/jump frames per scroll owner.
- Normal view uses 100% zoom; split view uses 200%.
- Median of the three frame-p95 samples: normal 32.1ms baseline / 32.3ms
  candidate (+0.2ms); split 32.2ms / 32.3ms (+0.1ms).
- Candidate table callback p95: 0.10ms in each run. This is a real added cost,
  not a zero-overhead claim. Settled scrolling reads no table/heading geometry
  and performs no viewer scans. No 50ms long tasks were recorded.
- These are local programmatic-scroll measurements, not a 60fps certificate
  or a measurement of cache rebuilds. Native-wheel behavior has a separate
  functional check.
- Repeat the bounded probe with `FOLIA_READING_PERF=1` and
  `node test\test-reading.js`. Raw paired samples are retained in the reading
  feature session's `reading-performance.json`.

## Dark Mermaid boundary styling

- These measurements cover product commit `18dd44b8` and its 2px/3px widths.
  The later user-selected 1.5px/2px revision keeps the same styling path, but
  has not been separately benchmarked. Do not relabel these samples as new bytes.
- Machine: Windows, AMD EPYC 7763, 32 logical processors.
  Runtime: Electron 43.4.1, Mermaid 11.17.0.
- Baseline: `cf12589ebf5b664e98185ed7f7e3413b8c5fc3e4`.
  Both versions use the same dependencies and isolated profiles.
- Method: the existing reading fixture, with long/wide tables, prose, an open
  TOC and five diagrams. Run baseline/candidate/candidate/baseline/baseline/candidate
  serially, with no other suite running. Each process measures three forced
  uncached full renders and 90 scroll frames per scroll owner.
- Reparsing every diagram adds a measured render cost: median 161.8ms to 193.2ms
  (+31.4ms); mean 170.1ms to 198.1ms (+28.0ms). This is not accepted as noise.
  The current code avoids that redundant parse for configuration-free source.
- Before the optimized run, the budget was at most 16.7ms added fresh-render
  median/mean, 1ms added scroll p95, 0.1ms added callback p95, and no settled-scroll
  geometry/scans or 50ms long tasks.
- Optimized fresh renders: median 165.8ms baseline / 162.9ms candidate; mean
  173.1ms / 172.8ms. Sample ranges are 155.9-196.5ms / 150.3-203.1ms.
  No fresh-render regression was observed; the spread does not support a speedup claim.
- Settled-scroll medians remain 16.6-16.7ms. Optimized frame p95 ranges are
  17.7-18.1ms baseline and 17.6-18.3ms candidate. Both record zero viewer geometry
  reads, viewer scans and 50ms long tasks; callback p95 is about 0.1ms.
- Styling still scans and reads/writes boundary styles once on a new dark SVG.
  Configured sources still require the public parser; their added cost is not
  separately measured here. Cache hits and scrolling do not repeat that work.
- Normal view uses 100% zoom; split view uses 200%. These local measurements
  do not prove all document sizes, rebuild costs or native-wheel frame rates.
- Evidence: the reading session's `mermaid-boundary-performance-final.json`
  (unconditional parse) and `mermaid-boundary-performance-fast.json` (2px/3px source).
  The bounded probe uses `FOLIA_READING_PERF=1 node test\test-reading.js`.

## Left TOC tracking

### Method and scope

- Baseline: `c0d41f284f013e1982971dfa4ed70f1ffffb4cb2`, frozen from Git into the feature session, not the primary checkout.
- Runtime: Windows, AMD EPYC 7763, Electron 43.4.1. Both sides use the same locked dependencies, 1280 x 850 window, 100% reader zoom and an open TOC.
- Test both the normal `.content-wrapper` scroller and the actual split/edit `#viewer` scroller. Split view is entered through the real edit toggle.
- Workloads: 1,001 headings / 1,083,194 bytes, and 241 headings / 262,926 bytes with eight real Mermaid diagrams and local SVG images. Include long gaps between headings.
- Per workload and view: three 240-frame bidirectional/jump sweeps, then three native-wheel runs. Run baseline and feature serially, with isolated profiles.
- Record animation-frame intervals, long tasks, heading geometry reads and Chrome script/style/layout/task counters. Time the frame-coalesced tracker separately. Keep opening, reopening, resizing and image-reflow callback samples outside settled-scroll measurements.
- Check the current heading against live geometry, not the tracker's cached positions. View captures with the active row visible in the left drawer.
- This remote display reports about 31.3ms between frames. Unchanged cadence here is not a 60fps result and cannot prove behavior on every machine or display.
- The prospective engineering checks were tracker p95 below 1ms, frame-p95 increase no greater than the larger of 2ms or 10%, and no tracker-related long task of 50ms or more. These checks do not redefine the user's no-noticeable-slowdown requirement.

### Investigation and separate PoC

- The initial baseline attempt had the TOC closed. Its results are retained but excluded from the comparison.
- The first working candidate read sidebar rectangles during scrolling and changed active-row font weight. It caused about 232 layouts per 240-frame sweep and a 1.6ms tracker p95; it was rejected.
- Caching sidebar bounds and keeping active styling metric-stable removed that layout work. The refined PoC's tracker p95 was about 0.4ms, with no settled heading geometry reads or layouts.
- PoC cache-refresh samples were 6.2-9.7ms for 1,001 headings and 1.6-4ms for the mixed document. They are not final-product opening measurements.
- The product uses passive, frame-coalesced scrolling, cached geometry and binary search. Dynamic content can still require a full geometry refresh; there is no claim of zero overhead.
- An earlier product run recorded a 27.1ms initial split-view tracker callback for 1,001 headings. Retain this cost separately from settled scrolling: opening an extreme outline can consume more than a 60Hz frame.
- Arbitrary CSS animation that moves headings without a DOM or observed size change is not continuously tracked. Tracking every animation frame was not added.

### Final-source results

- All measured settled-scroll windows had zero heading rectangle reads, zero layouts and no long tasks of 50ms or more.
- Frame p95 is pooled across the three sweeps. Native-wheel p95 shows the range across the three repetitions; keep the observed 0.1ms differences.

| Workload / view | Sweep frame p95, baseline -> feature | Native-wheel frame p95, baseline -> feature | Tracker p95 |
|---|---:|---:|---:|
| 1,001 headings / normal | 31.3 -> 31.3ms | 31.3 -> 31.3ms | 0.5ms |
| 1,001 headings / split | 31.3 -> 31.3ms | 31.3 -> 31.3-31.4ms | 0.5ms |
| Mixed / normal | 31.3 -> 31.3ms | 31.3 -> 31.3-31.4ms | 0.5ms |
| Mixed / split | 31.3 -> 31.3ms | 31.3 -> 31.3-31.4ms | 0.4ms |

- There is real extra CPU/style/paint work. These Chrome counters are milliseconds accumulated per roughly 7.5-second sweep, not frame times. Ranges include every repetition.

| Workload / view | Script, baseline -> feature | Style, baseline -> feature | Total task, baseline -> feature |
|---|---:|---:|---:|
| 1,001 headings / normal | 28.7-28.8 -> 60.6-65.2 | 0 -> 83.7-89.8 | 778-794 -> 1,019-1,165 |
| 1,001 headings / split | 27.4-29.0 -> 62.5-67.2 | 0 -> 87.1-95.1 | 780-805 -> 1,193-1,507 |
| Mixed / normal | 27.5-29.9 -> 52.6-57.4 | 0 -> 69.6-80.5 | 447-514 -> 711-774 |
| Mixed / split | 26.1-27.4 -> 52.6-54.9 | 0 -> 69.9-72.0 | 480-542 -> 708-769 |

- Separate opening/reflow checks recorded these largest tracker callbacks. They include any layout paid by the callback; they are not isolated cache-loop timings or end-to-end opening times.

| Workload / view | Initial layout | Reopen | Resize | Image grow/restore |
|---|---:|---:|---:|---:|
| 1,001 headings / normal | 8.3ms | 5.3ms | 6.2ms | N/A |
| 1,001 headings / split | 26.3ms | 4.9ms | 5.7ms | N/A |
| Mixed / normal | 3.0ms | 1.7ms | 1.2ms | 1.1ms |
| Mixed / split | 2.3ms | 1.1ms | 1.1ms | 1.1ms |

- Conclusion: no observed scrolling-cadence regression in these workloads/runtime, with measurable additional work. Initial opening of the extreme split-view outline remains a cost, not a hitch-free-opening or high-refresh-display guarantee.

### Evidence

- Nonshipping runner, frozen baseline, source/fixture hashes, raw samples, excluded attempts and viewed screenshots are retained in session `e4dc74e3-37ed-4a60-8879-1bb617017e84`, under `files/`.
- Runner: `toc-poc-runner.cjs`; excluded attempt: `toc-baseline-a`; rejected candidate: `toc-poc-c`; refined candidate: `toc-poc-d`.
- Final comparison: `toc-baseline-normal-r1.json`, `toc-baseline-split-r1.json`, `toc-production-normal-r3.json`, `toc-production-split-r3.json` and `toc-final-comparison.txt`. Earlier product runs are retained, including the 27.1ms initial callback.
- Fixture SHA256: headings `ba32e4f068c3d799d46b14903dc5c52ac744067c1f38e660e248c1b806f9a3b9`; mixed `eb9ce720151ac3cf71708737eebb6511de3c367e03dbb97c338dc01200aca3b6`.
- Focused behavior coverage is `npm run test:toc`; the related table and theme suites cover drawer geometry and native-button styling. Revert records in `scripts/prove-table-fixes.js` name the exact failing assertions and independent passing controls.
- The real H1-H6 fixture checks each child heading's exact identity during normal/split 100/200% scrolling, skipped levels, long nested sections and clicks. Excluding H4-H6 from the cache makes those checks fail while the hierarchy and existing scroll controls still pass.
- Existing focused browser-isolation and empty-Prism overlay controls pass 40/40 on the same final product source. Evidence: `toc-isolation-prism-controls-r2.log`; its generated captures and native-read records are retained in `toc-isolation-controls-captures/`.
- The render-patch suite remains 105/109, matching its pre-change baseline failures around external-open instrumentation. Its existing normal/split 100/200% TOC navigation checks pass; this is not a claim that the full application suite is green.

## Findings

### PERF-01 — Eager main-process `require()`s block startup

> **Status: fixed** (commit `2416fc3`). `html-to-docx` and `electron-updater` are now
> loaded through `getHTMLtoDOCX()` / `getAutoUpdater()` on first use. Guarded by
> `test-startup-perf.js`, which reads the real `require.cache`.
>
> **Superseded in part.** Word export and `html-to-docx` were later removed from
> the product entirely, which retires the larger half of this finding by deletion
> rather than by deferral: the 370.1ms is no longer merely deferred to first
> export, it cannot be paid at all. `electron-updater` is now the only production
> dependency and is still lazy-loaded, so the assertion that survives in
> `test-startup-perf.js` covers it alone. The measurements below are left as
> recorded — they were taken when both modules were present, and rewriting them
> would falsify the audit rather than update it.

- **File:line:** `main.js:49-50`, `main.js:66`
- **Code:**
  ```js
  const { exec } = require("child_process");
  const HTMLtoDOCX = require("html-to-docx");
  ...
  autoUpdater = require("electron-updater").autoUpdater;
  ```
- **Why it is slow:** both modules are parsed and executed on the main process before the BrowserWindow starts loading. `html-to-docx` pulls in a large `xmlbuilder2` tree; `electron-updater` also loads a substantial dependency graph. This is pure startup tax even when the user only opens a plain markdown file and never exports or checks for updates.
- **Measured cost:**
  - `require("html-to-docx")`: **370.1ms**
  - `require("electron-updater")`: **174.7ms**
  - Combined avoidable startup blocking: **544.8ms**
  - Window first paint after `loadFile()`: **594ms**
- **Specific proposed alternative:** lazy-load `html-to-docx` inside the export handler, and lazy-load `electron-updater` only when packaged and after the first window is shown (or on first manual update check). *(The `html-to-docx` half is no longer applicable — the package was uninstalled with the Word export feature, so its 370.1ms is not deferred but gone. Only the `electron-updater` half of this proposal is still live, and it is implemented.)*
- **Estimated gain:** roughly **0.5s off cold startup**.

### PERF-02 — Search does full-document DOM surgery on every input event

> **Status: fixed** (commit `acd59ce`). Highlighting is debounced at 150ms, with an
> explicit flush before any action that depends on the highlights being current.
> `normalize()` is now called once per parent instead of once per match, and
> current-match tracking is O(1). Two bugs surfaced while fixing it were fixed in
> the same commit: nav buttons went dead for the debounce window, and search state
> was never invalidated when the document re-rendered underneath it. Guarded by
> `test-search.js` (25 assertions).

- **File:line:** `renderer.js:2126-2189`, `renderer.js:2253-2254`
- **Code:**
  ```js
  searchInput.addEventListener('input', (e) => {
    highlightSearchTerm(e.target.value);
  });
  ...
  const walker = document.createTreeWalker(viewer, NodeFilter.SHOW_TEXT, ...);
  ...
  textNodes.forEach(textNode => {
    const matches = [...text.matchAll(searchRegex)];
    ...
    textNode.parentNode.replaceChild(fragment, textNode);
  });
  ```
- **Why it is slow:** every keystroke walks the entire rendered document, allocates an array of text nodes, finds matches, replaces text nodes with fragments, and then later clears them again. Complexity is proportional to the whole rendered tree, not the delta since the previous search character.
- **Measured cost (plain2m fixture, 2.0MB / 2001 headings):**
  - Common term (`perfneedle`, 3591 matches): `highlightSearchTerm()` = **316.0ms**
  - Clearing previous highlights: `clearSearchHighlights()` = **21.4ms**
  - Rare no-match term: `highlightSearchTerm()` = **14.3ms**
- **Specific proposed alternative:** debounce search while typing, or switch to a find-in-page/indexed model that does not mutate the whole rendered DOM on every keystroke. If highlight overlays are needed, apply them only after debounce/Enter, not per character.
- **Estimated gain:** remove roughly **250-300ms per keystroke** on very large docs.

### PERF-03 — Mermaid is eagerly loaded on every launch

> **Status: fixed.** `index.html` no longer carries a `<script>` tag for mermaid;
> `ensureMermaid()` in `renderer.js` injects it on first actual need. Re-measured
> with `bench-mermaid-startup.js` against the shipped build, 7 interleaved
> cold-cache runs with a discarded warm-up pair: **473ms eager vs 348ms lazy**
> (minimum; medians agreed), so about **125ms off every launch** that does not
> open a diagram — which is most of them.
>
> The audit's 178.6ms figure above was measured by re-evaluating the payload in
> an iframe in the same process, and is not reliable: V8's code cache makes a
> repeat in-process eval roughly 10x cheaper (113ms -> 9.6ms when checked), so
> that method understates a genuinely cold load. The 125ms figure comes from
> real application launches instead.
>
> Prism was deliberately left eager. It is 96KB against mermaid's 3.2MB, it is
> needed by almost every document rather than a minority, and the loading screen
> is already gated on its `requestIdleCallback` completing.
>
> Making the load lazy introduced a new suspension point inside
> `renderMarkdownFull`, which opened a race the eager build could not have: a
> superseded render would resume after the load and keep editing the document
> that had replaced it - resetting the scroll position, rebuilding the table of
> contents, and, if its draw failed, overwriting the winning document's diagram
> source with an error card (the winner's own draw then rendered mermaid's
> "Syntax error in text" graphic). Three generation checks around the mermaid
> block close it; `test-mermaid-render.js` sections 11, 11b and 11c cover them
> individually, and each was confirmed to fail with its own check removed.

- **File:line:** `index.html:22-26`
- **Code:**
  ```html
  <script src="libs/vendor/marked.min.js"></script>
  <script src="libs/vendor/mermaid.min.js"></script>
  <script src="libs/vendor/purify.min.js"></script>
  <script src="libs/prismjs/prism-bundle.js"></script>
  ```
- **Why it is slow:** the app parses/evaluates Mermaid and Prism at startup even when the opened document has no diagrams and no code blocks. Mermaid is especially large.
- **Measured cost:**
  - `libs/vendor/mermaid.min.js` size: **3259.3KB**
  - `libs/prismjs/prism-bundle.js` size: **96.0KB**
  - Fresh load/eval of equivalent Mermaid 10.6.1 payload in a clean iframe: **178.6ms**
  - Fresh Prism bundle load/eval in a clean iframe: **16.7ms**
  - Startup first paint after `loadFile()`: **594ms**
- **Specific proposed alternative:** lazy-load Mermaid only when a document actually contains a Mermaid block or a `.mmd/.mermaid` file is opened. Prism can also be delayed until the first code block is encountered.
- **Estimated gain:** about **180-200ms** on plain-document startup, plus lower startup memory pressure.

### PERF-04 — Mermaid documents miss the light-format fast path for tiny edits

> **STATUS: FIXED** (see "Incremental patching root cause" below). Mermaid
> documents still route through `'full'`, but that path is no longer expensive:
> `patchViewerDOM()` now preserves the drawn diagram, so the cost that made the
> fast path desirable is gone.
>
> The code quoted below is the snapshot as audited and is left unedited as a
> dated record. Two of the features it names have since been removed from the
> fork: OmniWare (`7b`) and the image slider (`8c2`). `detectRenderMode` now
> tests `hasMermaid` alone, and the proposed alternative's reference to
> "Mermaid / OmniWare / slider blocks" should be read as "Mermaid blocks".

- **File:line:** `renderer.js:2888-2898`, `renderer.js:3077-3385`, `renderer.js:3241-3263`
- **Code:**
  ```js
  function detectRenderMode(oldContent, newContent) {
    if (!oldContent) return 'full';
    const hasMermaid = /```mermaid/i.test(newContent) || /```mermaid/i.test(oldContent);
    ...
    if (!hasMermaid && !hasOmniware && !hasSlider) {
      ...
      return 'light-format';
    }
    return 'full';
  }
  ...
  if (mermaidSvgCache.has(src)) {
    el.innerHTML = mermaidSvgCache.get(src);
  } else {
    toRender.push(el);
  }
  ```
- **Why it is slow:** the presence of *any* Mermaid block forces `renderMarkdown()` onto `renderMarkdownFull()` for every later edit, even when the diagram text itself did not change. The cache successfully skips `mermaid.run()`, but the rest of the full pipeline still runs.
- **Measured cost (mermaid20 fixture, 225KB / 20 diagrams, 1-line text edit):**
  - `renderMarkdownFull()`: **93.9ms**
  - `marked.parse`: **7.8ms**
  - `DOMPurify.sanitize`: **4.9ms**
  - `patchViewerDOM`: **8.0ms**
  - `mermaid.run`: **0 calls / 0ms**
  - End-to-end settle time: **264.4ms**
- **Specific proposed alternative:** detect diagram-block stability separately. If Mermaid / OmniWare / slider blocks are byte-identical, allow the same light-format path plain markdown uses and preserve the existing rendered diagram nodes.
- **Estimated gain:** likely **2-4x faster small edits** in diagram-heavy docs.

### PERF-05 — Code-heavy updates still re-highlight every code block

> **STATUS: FIXED.** The full render path called `Prism.highlightAll()`, which
> ignores the `.prism-highlighted` marker the light path honours, so every code
> block was re-tokenised on every render. Replaced with
> `highlightNewElements()` (document-scoped, so it keeps `highlightAll`'s reach
> into dialogs). Measured span preservation went 0/540 -> 540/540.

- **File:line:** `renderer.js:3047-3055`, `renderer.js:3375-3383`, `renderer.js:3577-3635`
- **Code:**
  ```js
  highlightNewElements();
  addCodeBlockCopyButtons();
  ...
  viewer.querySelectorAll('pre code:not(.prism-highlighted)').forEach(el => {
    Prism.highlightElement(el);
  });
  ...
  Prism.highlightAll();
  ```
- **Why it is slow:** even in the light-format path, code blocks are re-highlighted and re-wrapped with copy-button containers after changes. On large docs that turns non-code edits into O(number of code blocks) work.
- **Measured cost (code200 fixture, 1.46MB / 200 code blocks):**
  - Full render: `Prism.highlightAll()` = **49.6ms**, `Prism.highlightElement()` total = **48.4ms**, `addCodeBlockCopyButtons()` = **11.8ms**
  - Small changed render: `Prism.highlightElement()` total = **48.5ms**, `addCodeBlockCopyButtons()` = **9.9ms**
  - So unchanged-code updates still spend about **58ms** in code-block post-processing
- **Specific proposed alternative:** preserve unchanged `<pre><code>` subtrees during patching, or track a per-block hash so only changed code blocks get re-highlighted / re-wrapped.
- **Estimated gain:** about **60ms per edit** on code-heavy documents.

### PERF-06 — TOC and collapsible sections are rebuilt every render

> **STATUS: FIXED, and it was far worse than this entry estimated.**
>
> Investigating the ~30ms rebuild uncovered that the incremental-patch
> optimisation was defeated *entirely* on any document containing a heading.
> `makeHeadersCollapsible()` restructures `#viewer` into
> `[h1, div.collapsible-section, ...]`, while the freshly parsed HTML is flat,
> so `patchViewerDOM()`'s positional diff misaligned from the first heading
> onward and `_getBlockHash()` returned null for every wrapper. Measured on a
> 60-heading document: **1 of 1263 nodes preserved (0%)** — a one-word edit
> rebuilt the whole document.
>
> Fixes, in the order they were found:
> 1. `flattenCollapsibleSections()` before diffing (0% -> 52%)
> 2. `Prism.highlightAll()` -> `highlightNewElements()` (52% -> **100%**,
>    1201/1202 — the one replacement is the block that actually changed)
> 3. Content-derived slug ids replacing positional `header-${index}`, so
>    collapse state and anchors survive an inserted heading
> 4. One delegated click listener instead of per-heading listeners (they
>    stacked, and *parity* of the count decided whether sections responded)
> 5. `_mermaidNode()` so a drawn diagram wrapped in `.mermaid-container` is
>    still matched — found by looking at a screenshot, not by any assertion
> 6. LCS (keyed) diff instead of index-to-index comparison, so inserting or
>    deleting a block no longer rebuilds the entire tail below it
> 7. `omniware-container` / `img-zoom-container` added to the wrapper list
>
> Guarded by `test-render-patch.js` (`npm run test:patch`), 49 assertions, each
> proven to fail when its fix is individually reverted.

- **File:line:** `renderer.js:2275-2366`, `renderer.js:3043-3044`, `renderer.js:3365-3368`
- **Code:**
  ```js
  buildTableOfContents();
  makeHeadersCollapsible();
  ...
  indexList.innerHTML = '';
  headers.forEach((header, index) => { ... });
  ```
- **Why it is slow:** every render re-queries all headings, clears the TOC container, rebuilds TOC nodes/listeners, and rebuilds collapsible wrappers. That is O(number of headings) work even when no heading changed.
- **Measured cost (plain2m fixture, 2.0MB / 2001 headings):**
  - Full render: `buildTableOfContents()` = **9.7ms**, `makeHeadersCollapsible()` = **17.4ms**
  - Isolated TOC rebuild: **12.3ms**
  - Changed renders on the same doc were in the same **~30ms** range for TOC + collapse work
- **Specific proposed alternative:** cache heading metadata and only rebuild TOC / collapse wrappers when heading blocks actually changed.
- **Estimated gain:** **20-30ms per render** on heading-heavy docs.

### PERF-07 — Theme toggle re-renders every Mermaid diagram synchronously

- **File:line:** `renderer.js:1168-1197`
- **Code:**
  ```js
  async function updateMermaidTheme(isDark) {
    mermaidSvgCache.clear();
    mermaid.initialize(getMermaidConfig(isDark));
    ...
    await mermaid.run({ nodes: toRender, suppressErrors: false });
  }
  ```
- **Why it is slow:** toggling theme restores source text into every `.mermaid` node, invalidates the cache, and re-runs Mermaid for the whole document synchronously.
- **Measured cost (mermaid20 fixture, 20 diagrams):**
  - `mermaid.run()`: **423.7ms**
  - `updateMermaidTheme()`: **431.6ms**
- **Specific proposed alternative:** rerender visible diagrams first, defer offscreen ones with `requestIdleCallback`, or keep the theme toggle responsive and progressively refresh SVGs afterward.
- **Estimated gain:** removes a **~0.4s hitch** on theme changes in diagram-heavy docs.

### Status: FIXED — `renderer.js:1495-1660`

`applyMermaidTheme()` now splits `.mermaid` nodes into on-screen (plus one
viewport of margin) and the rest. The on-screen batch renders inline and the
toggle resolves; the remainder is caught up in chunks of 4 under
`requestIdleCallback`, re-sorted by visibility at every chunk so that scrolling
during the catch-up promotes whatever the user just brought into view.

Off-screen nodes are deliberately left showing their **old SVG** until their
chunk runs. The previous code restored `data-mermaid-src` into every node up
front, which would now mean the whole document showing raw diagram source for
the duration of the pass — correct, but far uglier than a stale colour.

**Measured on the same 20-diagram document, same session, after warm-up:**

| | blocking toggle | full settle |
|---|---|---|
| Old (single batch) | 398.8ms / 402.7ms | same |
| New (visible-first) | **84.0ms / 86.5ms** | 422.0ms / 449.6ms |

So the user-visible hitch drops **~4.7×** and the total work is unchanged — the
tail simply moved into idle time. The idle deadline is 100ms rather than the
250ms first tried, which shortened the tail from ~1.4s to ~0.45s and so shortened
the window in which scrolling could reveal an un-retimed diagram.

**New correctness hazard this introduces, and how it is handled.** Work now spans
several queued jobs, so a superseded update *can* exist — which the previous
comment in this file explicitly said could never happen. `mermaidRunSeq` is the
generation token: a chunk whose seq is stale renders nothing and writes nothing
to `mermaidSvgCache`. Note that `scheduleMermaidCatchUp()` also cancels the
pending idle callback, which **masks** the token end to end; the token covers the
window the cancel cannot — a chunk already queued on the mermaid mutex, whose
`.then()` would otherwise re-arm the abandoned chain and clobber the live one's
handle.

**Coverage:** 5 assertions in `test-mermaid-render.js`. Revert-proof: removing
the generation guards makes "a catch-up pass from a superseded generation
renders nothing" fail with `{"count":14,"changed":4}`. The end-to-end supersede
assertion alone does **not** fail — it is protected by the cancel — which is why
the guard is also tested directly.

### PERF-08 — `applyTableBreakout()` forced one full-document layout per table

- **File:line:** `renderer.js`, `preferredTableWidth()` — since split into `tablePreferredBegin()` / `tablePreferredRead()` / `tablePreferredRestore()`
- **Why it is slow:** the function wrote `table.style.width = 'max-content'` and then read `table.getBoundingClientRect()`. A write followed by a read forces a synchronous layout, so doing it once per table costs **one full-document layout per table** — O(n²) in table count.
- **Diagnostic signature:** the *per-table* cost rises with table count — **3.3 → 5.7 → 12.2 ms** from 0.25 MB to 1 MB. That is layout thrash, not an expensive measurement. A pass that were merely slow would show a flat per-table cost.
- **Fix:** four batched passes (read all containers, write all tables, read all tables, restore all tables), taking the pass from ~1 forced layout per table to **~4 in total**.
- **Why batching is layout-equivalent, not an approximation:** `.table-container` is `width:100%; overflow-x:auto`, so a table at `max-content` is contained by its own scroller and cannot change what any other table measures; and `max-content` is an *intrinsic* size, so it does not depend on available space either. This argument is written into the code, because a stylesheet change could invalidate it.
- **Measured:** `applyTableBreakout` at 1 MB **35.5 s → 2.3 s**. The residual is consistent with ~4 full-document layouts of an 82k-node tree — the floor, not remaining thrash.

### PERF-09 — `patchViewerDOM()` drained the viewer one child at a time

- **File:line:** `renderer.js`, `patchViewerDOM()`
- **Why it is slow:** in Blink, removing a child costs time proportional to the **container's** size, so draining a container child-by-child is O(n²). Measured: **24.2 s for 29,055 blocks**.
- **Fix:** bulk drain with `replaceChildren()` (no arguments) before the insert loop, plus a bulk `viewer.replaceChildren()` when nothing at all was matched. Linear — **16 ms** for the same 29k — and it genuinely detaches (`parentNode === null` afterwards, references stay valid).
- **Measured:** **23,687 ms → 36.2 ms** (654x).
- **Counter-intuitive, and the reason this needs a permanent guard rather than a comment:** batching the *insert* side does **not** help. `viewer.append(...nodes)`, DocumentFragment-then-append and `replaceChildren(...nodes)` were all measured and are all just as slow (**22.9 / 33.9 / 34.0 s** at 1 MB), because each still detaches every argument from its current parent first. **The detach is the cost, so the detach is what must be batched.** An "optimisation" that replaced the insert loop with any of those would look obviously better and buy nothing.
- **The incremental path deliberately keeps per-node removal**, and the bulk clear is gated on `!pairs.length` for exactly that reason: a bulk clear would detach and reattach *reused* nodes, discarding state that lives in their layout objects — inner scroll offset, a loaded `@@@html` sandboxed iframe (detaching an iframe destroys and reloads its document), focus, running transitions. Event listeners, Prism highlighting, copy buttons and `<img>` decode state all survive a detach; the layout-object state does not.
- **Scroll preservation was measured, not assumed:** a bulk clear plus re-append in one task with no intervening layout read gives `before=4000, after=4000`, because layout — and therefore `scrollTop` clamping — is deferred.

### PERF-08/09 combined effect

Same synthetic dense document (~135 nodes/KB), end to end:

| Document | Before | After | Speedup |
|---|---:|---:|---:|
| 1 MB | 41.3 s | 5.0 s | 8.2x |
| 2 MB | 187.1 s | 7.8 s | 24x |
| 5 MB | 445.6 s | 60.9 s | 7.3x |

Per-phase at 1 MB: total render **45.6 s → 3.8 s**; `applyTableBreakout`
**35.5 s → 2.3 s**; `patchViewerDOM` **8.45 s → 0.25 s**. Scaling across
0.25 / 0.5 / 1 MB is now near-linear (1174 / 1978 / 3812 ms).

**The main thread was completely wedged, not merely busy** — and that was
measured rather than inferred. `executeJavaScript` queues on the renderer's main
thread, so its round-trip time *is* the block: firing `renderMarkdown()` without
awaiting it and polling from the main process, only **2 polls** got through an
entire 187 s render at 2 MB.

**Oracles are structural, not timed** — a timing assertion is how this suite
would become flaky, and it would not say what broke. `test-table-display.js` §18
patches `getBoundingClientRect` and counts how many tables are at `max-content`
on each *table* read (batched ⇒ N, thrashing ⇒ 1). `test-render-patch.js` §16
patches `insertBefore`/`remove` and asserts every new block is already
parentless when inserted. R227 is deliberately a **geometrically correct**
revert — `preferredTableWidth()` is the same measurement taken one table at a
time — so its `mustPass` list requires the geometry assertions to keep passing;
the only difference between the two versions is *when* the layouts happen.

**Still open:** the partial-reuse removal path (many removals *with* some reuse)
has not been measured and is likely still quadratic. The 5 MB leg remains
super-linear, so something else becomes quadratic at that scale; the render-cost
guard covers it rather than a fix.

### PERF-10 — The shutdown approval scan recomputed every open document

**Different harness, different runtime — do not read this against the
methodology block at the top of this file.** PERF-01 to PERF-09 were measured
with the scratch render harness on Electron v41.7.1 / Node v20.18.3. This finding
was produced by `npm run bench:f22` (`bench/run-f22-shutdown.js`), a
process-isolated parent/worker gate on the Electron pinned in this repository at
the time of the run. Full method, all three runs and the durability limitation of
the second are recorded in `bench/BASELINE.md`, *The F22 shutdown-approval gate*.

**The defect.** The F22 shutdown protocol asks the renderer whether anything is
unsaved, and the renderer answered by comparing each tab's `content` against its
`originalContent`. That answer was memoised — but the memo was keyed on the
**values**, so its own validity check was itself a full document comparison.
A close that followed an edit therefore re-read every byte of every open
document, and for CRLF documents re-normalised both sides of every comparison as
well.

**Measured, against a budget fixed before the run:** p95 <= **16.7ms**, one frame
at 60 Hz. At 25 tabs of 2MB with every tab freshly edited:

| Observation | Raw p95 before | Raw p95 after |
|---|---:|---:|
| All-dirty, LF endings | **22.4936ms** | **1.002ms** |
| All-dirty, CRLF endings | **98.1947ms** | **1.2792ms** |
| Single dirty tab, CRLF | 1.048ms | 0.7076ms |
| Cold close, worst of nine points | 2.538ms | 2.5902ms |
| Warm close, worst of nine points | 0.993ms | 1.0375ms |

The two all-dirty rows are the finding; the other three are there to show the
change did not buy the worst case at the expense of the common one.

**The fix — `src/custom-tabs.js`.** The comparison belongs to the **edit**, not
to the close. `content` and `originalContent` are now accessor properties whose
setters settle dirtiness once, at the moment the text changes; the shutdown scan
reads one boolean per tab. Accessors rather than a convention, deliberately:
`custom-tabs.js`, `renderer.js`, the suites and the benchmark all assign those
properties directly, so an update rule that had to be invoked by hand would be
one refactor away from a stale flag — and a stale flag here reads as "nothing
unsaved" and discards the document. `setCleanDocument()` states the clean case
(disk refresh, completed save, reload takeover) atomically instead of comparing
twice on the way to an answer already known.

**Why this is the ordering that matters.** The work is not removed, it is moved
to where it is already paid for — one comparison per edit, on the tab being
edited, instead of a comparison per tab on every close. The close path becomes
O(number of tabs) plus at most one active-tab reconciliation.

**Non-vacuity.** Each all-dirty observation is verified against an exact filename
oracle: every open document must be named, in tab order. The observation is
recorded **before** the oracle is checked, so a mismatch does not erase the
timing — it marks the run **failed**, which means the number is **not accepted as
a gate result**, though raw diagnostic timing may remain in the output and in the
durable artifact. Without the oracle a scan that found nothing would report an
excellent number and be entirely wrong about it.

### PERF-11 — An active editor reintroduced whole-document close work

The PERF-10 shutdown scan fix did not eliminate the separate **active editor
fold** before the scan. The later file-lifecycle reconstruction added newline
spelling preservation, and reconciling a 2 MB textarea on close repeated
semantic comparisons and constructed a per-character newline array even for
uniform endings. It failed the *same predeclared* raw-p95 **16.7 ms** frame
budget: **90.654 ms** for LF and **117.275 ms** for CRLF at 25 tabs. The
initial failure comes from the predecessor handoff; no new raw-sample artifact
is claimed for it. Intermediate attempted fixes and their honest failures are
retained in `bench/BASELINE.md`.

**The correction — `src/custom-tabs.js`.** Enumerate newline boundaries
instead of every document character; take the uniform LF/CRLF/bare-CR path
without running mixed-ending alignment; reuse the already computed
byte-inequality and known dirty state rather than recompare large strings
while folding the active tab. Keep mixed endings on the alignment path and
preserve the document's original disk spelling when its semantic text has
not changed.

The latest product-source benchmark, after the separate failed-Save
tab-switch and accepted-background-adoption corrections, records raw
active-editor p95 **9.6951 ms LF** and **11.7335 ms CRLF** (20 samples each),
**42/42 observations** at or below the budget and **zero failures**. The
worker asserts the active edit and checks the exact dirty filenames; a fast
empty scan cannot pass. Raw arrays are in the machine-local
`f22-p3-background-disk-adoption-benchmark.json`, with its console
transcript beside it. The measured F22 product bytes have since landed on
the integration branch; this remains performance evidence for that source,
**not** a passing combined suite, full revert inventory or release gate.

### SEC-08 test-only preload selection — bounded startup check (unreleased)

The first SEC-08 harness unit conditionally selects a test-only preload
at main-window creation. Production and unmarked development launches
do not select it; the main window is still Node-privileged. Before
measurement, the regression budget was set to **both >10% and >25 ms**
at either p50 or p95 for either startup-to-first-contentful-paint
(FCP) or main-window `did-finish-load`. All comparisons used Electron
**43.4.1** on the same Windows machine, seven fresh isolated-profile
processes per variant, with the preload marker absent.

The first real-file, strictly before/after-interleaved comparison
used the integration checkout and a *different-path* SEC-08 worktree.
It crossed the budget at p50: entry-to-FCP **805.3 to 906.9 ms**
(+101.6 ms, +12.62%) and entry-to-load **843.0 to 940.3 ms**
(+97.3 ms, +11.54%). The p95 changes were **+15.2 ms** and
**+26.7 ms**. Individual paired deltas changed sign, with median
paired FCP delta about **+17 ms**; these observations are retained,
not relabelled as a pass or attributed to the new gate on code
inspection alone.

A second, **same-path** attribution check ran the unchanged HEAD and
candidate `main.js` program sources under the same candidate-worktree
filename, helper paths and renderer URL, with alternating AB/BA order.
A staged-source check verified that the sole program difference was
the test-preload selection block and its `webPreferences` spread.
Both variants loaded a real Folia window; all samples had valid
Chromium FCP entries. Entry-to-FCP p50/p95 were **1168.0/1203.0 ms**
for HEAD and **1161.6/1190.5 ms** for the candidate; entry-to-load
were **1203.3/1234.5 ms** and **1193.9/1230.7 ms**, respectively.
Neither metric regressed in this controlled comparison. Raw records,
positive controls, sample spreads and the predeclared budget are in
the machine-local `sec08-browser-window-fcp-results-20261005.json`
and `sec08-attribution-results-20261005.json`.

This bounds the **unmarked startup gate** on an initially empty,
`show:false` main window. The FCP clock begins when the probe script
runs (not at Electron process creation); the same-path comparison
uses in-memory `Module._compile`, not a normal disk `require`. It
does not measure representative file-open rendering, packaged
startup, the eventual isolated preload, or the full SEC-08 benchmark
set. The initial path-confounded result remains unexplained; the
same-path result does not license a claim that all SEC-08 performance
gates have passed.

### SEC-08 utility-loader preparation — real-file startup check (integration branch)

This SEC-08 unit loads the existing `utils.js` as a local classic
script before `renderer.js`, keeps its CommonJS API and uses a
browser global without a Node fallback. The main window is still
Node-privileged. Before measurement, the material-regression budget
was fixed at **both >10% and >25 ms** at p50 or p95 for either
entry-to-FCP or entry-to-`did-finish-load`. Within each run, A/B
uses one identical disposable app path and real files, Electron
**43.4.1** / Chromium **150.0.7871.224** on the same AMD EPYC
Windows 11 host (release **10.0.26300**), fresh profiles, and
alternating AB/BA order (V2: four AB/three BA; V3: seven each).
The pooled observations span two disposable app roots, balanced
within each variant. Chromium's original buffered paint entry
timestamp supplies FCP; the wait for that entry is not part of
its timestamp. This is a startup probe, not the full SEC-08
benchmark set.

The first run stopped at pair 3B: `did-finish-load` had fired but
the FCP entry was not yet buffered when queried immediately.
Its three baseline and two candidate samples cannot establish
the seven-pair p50/p95 gate. The corrected runner waited up to
1.8 seconds for the actual entry and completed **seven A and
seven B** observations, all with valid FCP entries. Baseline
to candidate entry-to-FCP p50 was **1214.2 to 1221.0 ms**
(+6.8 ms, +0.56%); p95 was **1601.0 to 1812.4 ms**
(**+211.4 ms, +13.20%**), crossing the fixed budget.
Entry-to-load p50 was **1210.76 to 1239.56 ms**
(+28.80 ms, +2.38%) and p95 **1790.43 to 1814.80 ms**
(+24.37 ms, +1.36%), neither crossing it. Paired FCP
candidate-minus-baseline deltas were -317.9, +6.8, +102.7,
+69.6, +674.5, -453.2 and -250.0 ms: large outliers
occurred on both variants, but the failed p95 cannot be waived
by inspection. Original candidate source hashes matched after
the run, the disposable app was restored and no probe-owned
process remained. Raw samples, snapshots and logs are retained
in session artifacts `files/sec08-loader-fcp-probe-20261005`
and `files/sec08-loader-fcp-probe-v2-20261005`.

After that run the unit was **blocked**. Before another measurement,
one machine-exclusive confirmation was predeclared: add 14 balanced
pairs and judge the pooled 21-per-variant p50/p95 against the
unchanged budget, retaining the failed observation regardless of
the outcome. No further retry or load-only substitution was
authorized.

The single predeclared confirmation completed **14 additional
balanced pairs** with no excluded samples. V3 entry-to-FCP
p50/p95 baseline to candidate was **1202.1/1660.9 to
1167.9/1534.6 ms** (deltas -34.2/-126.3 ms); entry-to-load
was **1216.47/1893.38 to 1198.64/1585.58 ms**
(-17.83/-307.80 ms). Pooling the immutable V2 observations
with V3 gives **21 samples per variant**: entry-to-FCP p50/p95
**1213.8/1601.0 to 1211.9/1534.6 ms**
(-1.9/-66.4 ms), entry-to-load
**1216.47/1790.43 to 1218.36/1585.58 ms**
(+1.89/-204.85 ms). **No pooled metric crosses the unchanged
both >10% and >25 ms budget.** With nearest-rank p95, seven
observations select the maximum, while 21 select the
second-highest: B's failed **1812.4 ms** sample is retained
in the pooled data but not selected by pooled p95
(**1534.6 ms**). The pooled maxima, a descriptive
cross-check rather than the predeclared decision statistic,
are **1660.9 ms A** and **1812.4 ms B**
(+151.5 ms, +9.12%); this comparison also stays below
the >10% part of the fixed budget. Pooled p95 A came from
V2 and B from V3, so this is a balanced-across-runs
comparison, **not** one common app-path run. V3 paired FCP
deltas ranged from **-178.4 to +104.0 ms**, well above
the budget's 25 ms component in either direction; the
probe cannot exclude a small cost from the extra script.
The raw observations, all paired deltas, source hashes, fixed
pooled rule and complete Electron/Chromium versions are retained in
`files/sec08-loader-fcp-probe-v3-20261005/results.json`.
The initial seven-pair FCP p95 failure remains in the record;
larger balanced sampling did not reproduce a material
regression, rather than proving that the original result
was impossible or that the module has zero cost. The reviewed
worktree's candidate bytes and the disposable app's candidate
sources were restored, and the probe left no child processes.
This clears only the bounded empty-window real-file startup
comparison, not packaged startup, file-open/render, Electron
bootstrap before the probe entry, compositor presentation or
the complete SEC-08 performance matrix.

### SEC-08 Mermaid-config loader — real-file startup check (integration branch)

The next loader unit publishes the existing `mermaid-config.js`
as a local classic script before `renderer.js`, keeping its
CommonJS API and using a browser global without a Node fallback.
The main window remains Node-privileged. Before measurement
the material-regression rule was fixed: candidate worse by
**both >10% and >25 ms** at p50 or p95 of entry-to-FCP or
entry-to-`did-finish-load`. One disposable real-file app path
was used for both variants, with only `mermaid-config.js`,
`index.html` and `renderer.js` swapped from immutable baseline
`839e1f8` and reviewed candidate snapshots. On the same AMD
EPYC Windows 11 host (release **10.0.26300**), Electron
**43.4.1** / Chromium **150.0.7871.224** launched **21 fresh
isolated profiles per variant** in alternating AB/BA order
(11 AB, 10 BA). All 42 launches produced an actual buffered
Chromium FCP entry within a bounded 1.8-second wait after
`did-finish-load`; each metric uses the original paint entry
timestamp rather than wait time, with no load-only fallback,
excluded outlier or repeated collection.

| Entry-to metric | Baseline A p50 / p95 | Candidate B p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| FCP | 978.300 / 1141.800 ms | 988.800 / 1089.100 ms | +10.500 ms (+1.073%) / -52.700 ms (-4.616%) |
| `did-finish-load` | 999.989 / 1125.363 ms | 1005.036 / 1127.190 ms | +5.046 ms (+0.505%) / +1.827 ms (+0.162%) |

**No p50 or p95 crosses the predeclared material-regression rule.**
The A/B FCP maxima were 1302.6/1152.2 ms, but individual
paired FCP differences ranged **-213.5 to +231.5 ms**
(load **-336.346 to +266.412 ms**). The paired FCP
median/mean were **-11.40/-19.63 ms** (11/21 pairs faster
for B), opposite the unpaired p50's +10.5 ms. With
nearest-rank p95 and 21 samples, each p95 is just the
second-highest single launch, not a stable tail estimate.
This probe is too noisy to establish zero added cost or
exclude a small regression.
Its clock begins when the probe runs, not at Electron process
creation. It measures an initially empty, nonpackaged window,
not file-open/render, OS compositor presentation or the
complete SEC-08 performance matrix. Source hashes in the
review worktree matched the pre-run candidate, and disposable
sources were restored to those candidate bytes. Raw ordered samples,
source snapshots, logs and the fixed rule are in session
artifacts `files/sec08-mermaid-loader-fcp-20261005/results.json`.

### SEC-08 context-menu loader — real-file startup check (integration branch)

This unit loads `context-menu-utils.js` as a local classic script
before both `renderer.js` and `custom-tabs.js`; both consumers now use
its browser global rather than a Node fallback. The main window
remains Node-privileged. Before measurement, the material-regression
rule was fixed as candidate worse by **both >10% and >25 ms** at
p50 or p95 of entry-to-FCP or entry-to-`did-finish-load`. Each
comparison used one disposable app path for both variants, swapping only
the four changed product files from immutable baseline `97e66cc`
and the reviewed candidate snapshot. On the same AMD EPYC Windows
11 host (release **10.0.26300**), Electron **43.4.1** / Chromium
**150.0.7871.224** launched **21 fresh isolated profiles per
variant** in each run, alternating AB/BA (11 AB, 10 BA).
Chromium FCP entries use their original timestamps rather than
the later observation time. No sample was excluded or retried
within a run.

The first run passed the numeric threshold but did not monitor
competing processes throughout; it is **not** the acceptance run:

| Entry-to metric | Baseline A p50 / p95 | Candidate B p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| FCP | 936.5 / 1026.0 ms | 943.4 / 1124.0 ms | +6.9 ms (+0.737%) / +98.0 ms (+9.552%) |
| `did-finish-load` | 938.171 / 1064.835 ms | 960.077 / 1115.381 ms | +21.906 ms (+2.335%) / +50.546 ms (+4.747%) |

**No percentile crossed the predeclared numeric regression rule.**
The FCP p95 moved close to its 10% limb, and the candidate's
1979.0 ms maximum FCP (baseline maximum 1301.3 ms) remained in
the results. In pair 20 (BA), candidate FCP was **1979.0 vs
979.4 ms** baseline and load **2004.706 vs 970.593 ms**;
with nearest-rank p95 over 21 samples, that maximum does not
determine p95. Paired FCP differences spanned
**-302.6 to +999.6 ms** with median **-15.2 ms** (12/21
candidate launches faster); load differences spanned
**-458.238 to +1034.113 ms**, median **+25.791 ms**.
Its ordered samples and source hashes remain in
`files/sec08-context-loader-fcp-20261005/results.json`.
A second retained comparison also passed numerically, but
its monitor classified Electron helpers without following
parentage, so it could not establish exclusivity
(`files/sec08-context-loader-fcp-exclusive-20261005/`).
Neither prior run was discarded to improve percentiles.

**Acceptance repeat.** The third run used the same baseline,
candidate bytes, fixed threshold, balanced 21-pair method and
fresh profiles. The integration owner scheduled no other
Folia harness, Electron suite, screenshot or benchmark work
during the run. Preflight saw zero Electron processes; an
ancestry-based monitor took **78 process samples over 70.2
seconds**, recording 206 observations of the probe's own
Electron processes, **zero** unrelated Electron processes and
**zero** other Folia test or benchmark Node processes. All
**42/42** launches produced actual buffered FCP entries within
the 1.8-second bound, with no retry or excluded sample.

| Entry-to metric | Baseline A p50 / p95 | Candidate B p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| FCP | 1010.4 / 1104.8 ms | 1023.8 / 1120.9 ms | +13.4 ms (+1.326%) / +16.1 ms (+1.457%) |
| `did-finish-load` | 1033.097 / 1140.885 ms | 1037.735 / 1117.770 ms | +4.638 ms (+0.449%) / -23.115 ms (-2.026%) |

**The machine-exclusive per-unit startup gate passes on the
monitored repeat**, within the repository's no-competing-Folia-work
scope. Baseline had a **1755.8 ms** maximum FCP (candidate
maximum **1153.1 ms**), showing how one outlier can move
between variants. Paired FCP differences spanned **-671.0
to +158.1 ms**, median **0.0 ms**; load differences spanned
**-759.486 to +128.575 ms**, median **+5.056 ms**.
Nearest-rank p95 is still the second-highest of only 21
launches; this does not establish zero cost or stable tails.
The process monitor sampled, rather than continuously traced,
process lifetimes: a brief competitor between samples or
unrelated CPU work was not instrumented. Its overhead applied
to both variants. The probe clock starts after process creation;
the nonpackaged, initially empty window does not cover document
rendering, compositor presentation, packaged startup or the
full SEC-08 matrix. Candidate source hashes matched before
and after, and the disposable app was restored to its candidate
bytes. Ordered samples, snapshots and the monitor summary are
in `files/sec08-context-loader-fcp-lineage-20261005/`.

### SEC-08 emoji dependency-chain loader — real-file startup check

This unit loads `emoji-map.js` then `emoji-parser.js` as local
classic scripts before `renderer.js`, removing the renderer's
last non-builtin local CommonJS import. It does not change the
main window's Node privileges. The predeclared material rule
was candidate worse by **both >10% and >25 ms** at p50 or
p95 of entry-to-FCP or entry-to-`did-finish-load`. One
disposable real-file app path alternated immutable baseline
`b039eb7` and the reviewed candidate's four changed product
files. On the AMD EPYC Windows 11 host (10.0.26300),
Electron **43.4.1** / Chromium **150.0.7871.224** launched
**21 fresh isolated profiles per variant**, alternating
AB/BA (11/10). All **42** produced a buffered Chromium FCP
entry within the 1.8-second bound; its original timestamp,
not collection time, is reported. No sample was excluded
or retried.

| Entry-to metric | Baseline A p50 / p95 | Candidate B p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| FCP | 1288.9 / 1571.1 ms | 1224.2 / 1431.5 ms | -64.7 ms (-5.020%) / -139.6 ms (-8.885%) |
| `did-finish-load` | 1321.728 / 1624.677 ms | 1266.897 / 1475.644 ms | -54.831 ms (-4.148%) / -149.033 ms (-9.173%) |

**No material regression under the fixed rule.** The
integration owner scheduled no competing Folia Electron
suite, mutation harness, screenshot or benchmark run.
Preflight found no Electron process; an ancestry-based
monitor took **76 process samples over 82.7 seconds**,
finding 210 observations of the probe's own Electron
processes, no unrelated Electron and no other Folia test
or benchmark Node process. Paired FCP differences ranged
**-384.0 to +130.7 ms**, median **-37.7 ms** (15/21
candidate launches faster); load ranged **-573.985 to
+150.769 ms**, median **-32.081 ms**. These noisy
observations do not establish that the loader made startup
faster. Nearest-rank p95 is the second-highest of only 21
launches; process sampling may miss brief competitors and
does not instrument unrelated CPU activity. The probe
clock starts after Electron process creation and measures
an initially empty, nonpackaged window, not file rendering,
compositor presentation or the full SEC-08 matrix.
Candidate source hashes matched before and after; disposable
sources were restored. Raw ordered samples, snapshots and
monitor summary are in
`files/sec08-emoji-loader-fcp-20261005/`.

### SEC-08 browser-safe file-helper core — real-file startup check

This unit extracts the pure shared normalizers and render-cost
estimator into `file-helpers-core.js`, loaded before the renderer
and tabs; the original main-process `file-helpers.js` retains
its Node I/O. The main window remains Node-privileged. The
fixed material-regression rule was candidate worse by **both
>10% and >25 ms** at p50 or p95 of entry-to-FCP or
entry-to-`did-finish-load`. One disposable real-file app path
alternated immutable baseline `04e1d14` and the reviewed
candidate's four changed source files. The baseline did
**not** contain `file-helpers-core.js`, so that file was
absent from each A launch and restored for B. Both variants
used the candidate `package.json` (its changed `build.files`
list does not run at startup). On the AMD EPYC Windows 11
host (10.0.26300), Electron **43.4.1** / Chromium
**150.0.7871.224** launched **21 fresh isolated profiles
per variant**, alternating AB/BA (11/10). All **42**
reported actual buffered FCP entries within the 1.8-second
bound; timestamps are the original paint events, not their
collection time. No retry or excluded sample.

| Entry-to metric | Baseline A p50 / p95 | Candidate B p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| FCP | 932.1 / 1193.8 ms | 960.0 / 1004.7 ms | +27.9 ms (+2.993%) / -189.1 ms (-15.840%) |
| `did-finish-load` | 962.334 / 1489.661 ms | 987.720 / 1033.688 ms | +25.385 ms (+2.638%) / -455.973 ms (-30.609%) |

**No metric crosses both limbs of the predeclared regression
rule.** The integration owner scheduled no competing Folia
test, screenshot, mutation or benchmark work; preflight
found no Electron process. An ancestry-based monitor took
**69 process samples over 59.5 seconds**, finding 192
observations of the probe's own Electron processes and
zero unrelated Electron or Folia test processes. Paired
FCP differences spanned **-619.8 to +108.7 ms** with
median **+17.8 ms** (6/21 candidate launches faster);
load spanned **-626.804 to +104.591 ms**, median
**+17.574 ms**. The unpaired p95 improvements reflect
noisy baseline tails, not demonstrated speedup. Nearest-rank
p95 uses the second-highest of 21 launches. The monitor
samples rather than continuously traces process lifetimes,
and unrelated CPU work is not instrumented. This clock
starts after process creation; an initially empty,
nonpackaged window cannot establish document-render,
compositor, packaged startup or full SEC-08 performance.
Original candidate and disposable sources were restored
and source hashes matched. Raw samples, snapshots and
process-monitor evidence are in
`files/sec08-file-helpers-core-fcp-20261005/`.

### SEC-08 dialog-selected extra reads — multi-open latency check

This unit replaces the renderer's synchronous read of each
additional file selected by the native multi-select dialog
with a main-owned, one-use grant and an asynchronous stable
read. The fixed material-regression rule, declared before
the run, was candidate worse by **both >10% and >25 ms**
at p50 or p95. A disposable real-file Folia app alternated
immutable baseline `cbe233f` and the reviewed candidate's
`main.js` and `custom-tabs.js` bytes at the same path.
The host was Windows 11 (10.0.26300), AMD EPYC, Electron
**43.4.1** / Chromium **150.0.7871.224**. For each
**50 KiB, 500 KiB and 2 MiB** plain extra file, one
fresh-profile launch of each variant made **21 timed
multi-open repetitions**. Launch order was AB for 50 KiB,
BA for 500 KiB and AB for 2 MiB; these are six launches,
**not** 21 independent process pairs per size.

The native dialog's selected-path result was stubbed
deterministically, but the real `open-file-dialog` IPC,
main-process read/delivery and renderer tab path ran.
Each repetition measured renderer `performance.now()` from
sending the dialog request to the extra tab's DOM creation.
After that endpoint, the extra tab was activated and its
unique fixture marker verified in the rendered document,
then the fixture tabs were closed and hidden leftover DOM
nodes cleared before the next request. Every repetition
created and verified its extra tab. The baseline had no
`read-dialog-extra` handler or invokes; the candidate made
exactly one successful invoke per repetition.

| Extra | Baseline p50 / p95 | Candidate p50 / p95 | B-A p50 / p95 |
|---|---:|---:|---:|
| 50 KiB | 40.1 / 48.8 ms | 42.0 / 61.7 ms | +1.9 ms (+4.7%) / +12.9 ms (+26.4%) |
| 500 KiB | 45.2 / 65.5 ms | 51.2 / 67.4 ms | +6.0 ms (+13.3%) / +1.9 ms (+2.9%) |
| 2 MiB | 53.6 / 102.2 ms | 68.1 / 108.4 ms | +14.5 ms (+27.1%) / +6.2 ms (+6.1%) |

**No p50 or p95 delta crosses both limbs of the predeclared
material-regression rule.** The 2 MiB p50 increase is
real in these samples and is not a speedup claim or a
no-cost claim. Process monitoring took **52 samples**,
including **40** that observed the probe's own Electron
processes and none that found an unrelated Electron
process. Monitoring is sampled, not continuous,
and does not enumerate Node-only Folia test processes;
other CPU work was not instrumented. A first diagnostic
attempt timed out on hidden-tab cleanup before a valid
comparison and was retained, not incorporated into these
samples. Each size has only one process per variant, so
launch-to-launch noise and within-process repetition drift
remain visible rather than corrected. This measures
extra-tab arrival before content rendering and disk-owner
completion, not packaged startup or the full SEC-08
benchmark matrix. The disposable candidate and review
worktree hashes matched after the run. Raw ordered samples,
fixture manifests, process monitors, failed diagnostic
and restoration evidence are under
`files/sec08-dialog-ipc-perf-20261006/`.

### SEC-08 clean-tab refresh — practical diagnosis (isolated, not integrated)

**2026-10-11: performance acceptance remains inconclusive/blocked.** Under
the maintainer's revised ordinary-case validation contract, the isolated
stream used established Node/Electron tooling, fresh profiles/fixtures and
successful native runner outcomes rather than continuing recursive launcher
qualification. Stronger historical assurance requirements remain unmet; no
old stage, E attempt or contaminated P6 namespace was replayed or qualified.

Product bytes are unchanged: baseline `790c1bc` and candidate `main.js`
`5F636290...` / `custom-tabs.js` `EC72BDD9...`. A focused, symmetrically traced
2 MiB/10-tab ABBA diagnostic completed four workers/168 timings. Changed
pooled median was **425.2 -> 431.8 ms**; unchanged **402.3 -> 404.1 ms**.
Chromium Layout event durations totalled **11.18-11.29 seconds per worker**
in both arms; these nested durations are not additive wall-clock accounting.
The large historical candidate slowdown was not reproduced, and no
candidate-specific defect supporting a product fix was established. This
focused traced block is **not acceptance evidence** or proof of the old cause.

One complete untraced A/A matrix retained the original nine cells, AB/BA
schedule, 21 changed/unchanged samples per arm/cell, heading endpoint and
nearest-rank statistics. All 18 workers/756 timings completed with native
runner exit 0 and the common coordination lock released. Identical baseline
inputs nevertheless crossed the retained **absolute unchanged p95 noise
limit of 2 ms**: 500 KiB/1, /10, /25 differed by **2.7, 2.7, 8.1 ms**;
2 MiB/1, /10 by **7.5, 3.5 ms**. This is measured calibration variability,
not demonstrated external-load causation or a candidate regression.

The already-started untraced A/B matrix completed normally with all
18 workers/756 timings, native runner exit 0 and the common lock released.
Its raw numbers crossed no regression thresholds, but it is explicitly
**diagnostic/nonacceptance in every cell** because A/A failed its prerequisite.
No noise subtraction,
threshold waiver, traced-ABBA substitution or repeat-until-green is allowed.
All seven historical refresh-performance failures remain **FAILED/OPEN**.
The ordinary tab/refresh suite returned **500/500, native exit 0**; correctness
success does not clear performance. Raw runs, native execution records and
the bounded diagnosis are retained under session
`b0e6dcc1-20b9-4d91-8e8b-f8069c36b9ac`,
`files/sec08-practical-performance-20261011/`. No integration/release claim.
Independent latest Sol/high and Luna/high method/result assessments agree
with the blocked conclusion. They identified two small DATA-reader issues
(both: A/A filename; Luna additionally: exact candidate/source checks);
these were corrected and confirmed without a benchmark rerun.

**2026-10-12: existing-data tail-noise follow-up; no new benchmark.**
The five A/A failures do not have one common distribution shape:

| Cell | B-A unchanged p50 / p95 ms | Retained distribution |
|---|---:|---|
| 500 KiB / 1 | -0.9 / +2.7 | Faster B centre, slower upper tail. |
| 500 KiB / 10 | +1.3 / +2.7 | Small centre shift and upper-tail spread. |
| 500 KiB / 25 | +0.1 / +8.1 | Nearly equal centres, multiple early high B values. |
| 2 MiB / 1 | -9.1 / -7.5 | Broad faster B shift, not one isolated extreme. |
| 2 MiB / 10 | -3.4 / +3.5 | Faster B centre, early slower upper tail. |

With 21 samples, nearest-rank p95 is the **second-largest** observation.
At 500 KiB/25 the maxima differ by only 0.7 ms, but the second-largest
values differ by 8.1 ms; removing the maximum would not explain away
the retained failure. At 2 MiB/1 the quartiles and mean also shift:
B is faster at 19 of 21 same repetition indices. These are descriptive
sequential-worker comparisons, not randomized concurrent pairs.

Exact initial fixture bytes, source/worker/static assets and per-repetition
A/A setup/measured I/O and watcher counts match; the measured ledger spans
the switch through post-heading completion/quiescence checks, not only the
heading timer. The timing predicate requires the distinct heading in the
active viewer's DOM, not loading-overlay removal or compositor presentation.
The timer includes observer setup before the click; this unmeasured
interval is not a demonstrated cause of these tails. Full `innerText`/layout
cost belongs to the frozen endpoint. Counter stability is not a CPU-idle/GC/
compositor witness, and no per-leg focus, load or A/A trace was retained.
The existing traced A/B block cannot identify the causes of individual
A/A tails. No verified material product or measurement defect justifies
rerunning unchanged benchmarks. The decision required is to retain/defer
the blocker, or separately approve a revised precision/experimental contract
before new measurements; this entry adopts no such change. All samples,
numerical rules, diagnostic-only A/B status and seven **FAILED/OPEN** gates
remain unchanged. Bounded analysis is retained in the same session under
`files/sec08-tail-noise-analysis-20261012/`.

### Prospective repeated-worker calibration (2026-10-12): attempted, invalid/incomplete

The user subsequently authorized a prospective redesign, not another rerun of
the old method. The fixed declaration uses eight fresh-worker pairs per cell,
four AB/four BA orientations, all original 21 changed/21 unchanged observations,
and the original cells, fixtures, heading endpoint and material thresholds.
Inference is over paired empirical worker-quantile material margins, with
conditional extrema bounds and all-cell/observed-pair/pooled vetoes. It is not
a population-p95 or rare-regression certificate. The original 2 ms precision
goal is explicitly nonblocking under this new policy; a missed goal is reported,
not described as the old prerequisite passed. The phase budget is 60 minutes
admissibility, one attempt, no outcome-driven extension/replacement.

Independent current-policy Sol/high and Luna/high reviews supported that
limited model. Before data, corrections closed strict floating-boundary,
complete/continuous freeze, bounded-command and composed-cleanup defects.
Actual premeasurement declaration: SHA-256
`356f402a806c4c419f438a5b2d9aac753ace618987554ea33cfb06b0b4144a4d`.
The worker and product bytes were unchanged.

The one AA attempt ran from 05:27:52.308 to caller return 05:29:23.828 UTC.
Three complete workers retained 126 successful worker timings; the fourth,
baseline 2 MiB/1 A, returned native worker exit 1 on changed repetition 1.
Its heading appeared at 521 ms, but the required completion returned false and
the tab was protected as dirty/conflicted. That leg is not a successful sample.
Observed file metadata changed between recorded checks; the precise reason
for the completion rejection and the metadata change is not established.
No candidate execution, candidate regression or external actor is inferred.

The only completed 500 KiB/10 BA pair had no material predicate crossing;
unchanged p95 was 134.4/137.0 ms (2.6 ms difference), missing the original 2 ms
goal for that pair. It cannot qualify the incomplete eight-pair/all-cell phase.
Separately, the caller recorded native runner exit as null/capture false:
its local LASTEXITCODE reset shadows the status scope. The outer tool/caller
exit 1 is not retroactively substituted for the missing Node runner exit.
Readback found no Electron process or common lock. No complete AA result,
acceptance AB, replacement attempt or product fix followed.

This is **invalid/incomplete calibration**, not statistical non-regression or
regression evidence. Seven historical gates remain **FAILED/OPEN** and SEC08
**INCOMPLETE**. Frozen tooling/data/review pins and the concrete completion/
capture blockers are retained under the same session at
`files/sec08-prospective-calibration-20261012/`; no old evidence was requalified.

### Concrete capture correction and completion diagnosis (2026-10-12)

A separately authorized corrective unit used a **new** ordinary PowerShell
wrapper with explicit global `LASTEXITCODE` capture; the frozen executed wrapper
and old invalid AA were not changed. Real benign Node controls captured exits
0/7 and an owned worker-7/runner-23 distinction. Under `-Command`, captured Node
7 and enclosing PowerShell caller 1 were kept distinct. A local-variable
mutation captured zero under `-File` but lost the known benign zero under
`-Command`, supporting an invocation-dependent scope mechanism. It does not
recover the old Node status, which stays **UNKNOWN**.

Exactly one new **nonacceptance** baseline 2 MiB/1 diagnostic retained the
original schedule, heading endpoint, comparisons, completion/protection and
watcher behavior. The caller ran 06:03:59.848-06:04:08.868 UTC (8.996 s):
captured Node exit 1, capture success true; worker exit 1, no signal, no timeout.
Known native status was recorded before cleanup; ordinary cleanup settled and
released its exact shared lock. No process was killed. After three accepted
changed and three accepted unchanged legs, changed repetition 4 reached the
heading at 444.3 ms but its completion was correctly refused.

The per-leg trace identifies the refusal: paths still matched and the active
sequence/generation agreed, but the late disk mtime was **1791785044783.797**
against approved **1791785047497.6616**, with identical dev/inode/size and finite
ctimes. Tabs' post-render source-version check returned false and protected the
tab; renderer completion then refused the same mtime mismatch. The older value
exactly matched the producer's repetition-2 write. Later readback still matched
all changed-4 bytes while retaining that older mtime. This is observed metadata
rollback, **not** ctime-only drift or proof of who changed the metadata.

No timestamp setter was found in the inspected staged app/worker route, but
that is not an exhaustive writer/OS proof. The actor/provenance and the old AA's
unrecorded decisive predicate remain unknown. No product fix or relaxation of
mtime/approval/dirty-state guards is justified. Fresh independent Sol/Luna
reviews converged after targeted capture-retention and per-leg attribution
corrections; native controls and narrowly scoped DATA guard/cursor/cleanup
controls are retained at
`files/sec08-capture-completion-correction-20261012/` in the continuation session.
No further reproduction, AA/AB or statistical claim followed. Seven gates
remain **FAILED/OPEN**, SEC08 **INCOMPLETE**; capture is corrected, but the
baseline runtime completion prerequisite remains blocked.

### Corrected private-OS-temp AA (2026-10-12): performance acceptance DEFERRED

A separately authorized prospective attempt reused the selected eight-pair
method and original worker/product bytes, with corrected native-exit capture
and fresh measured fixtures **and profiles** under a new physical OS-temp root.
Both arms used baseline `790c1bc`; no diagnostic renderer instrumentation was
timed. The new fixed 90-minute phase budget was declared before data, not an
extension of the closed invalid attempt.

The caller ran 07:16:25.986-07:23:18.608 UTC (412.627 s). Actual Node,
wrapper and caller exits were **0**, capture succeeded and ordinary cleanup
released the lock. The first round retained **18 workers / 9 pairs / 756
accepted legs** (378 changed, 378 unchanged), not the planned complete
144-worker / 72-pair matrix. Native success is not calibration qualification.

The predeclared first material veto stopped AA at **50 KiB / one tab, BA**:
unchanged p50 was **27.7 -> 33.0 ms**, **+5.3 ms / +19.13%**, exceeding
the unchanged **>2 ms AND >10%** boundary. Both arms were identical baseline
source, so this is observed calibration variability, not candidate causation.
AA was incomplete/nonqualified; **AB did not start**. The original unchanged-p95
2 ms precision goal was also missed in four observed cells (worst 8.1 ms).
No current non-regression, global typical-pair or population-p95 certificate
was established; no external actor or impossibility under other conditions
is inferred. Raw outcome and method details remain in the continuation session
at `files/sec08-corrected-prospective-20261012/handoff.md`.

**Closeout decision: performance acceptance is DEFERRED on the current setup.**
No more local benchmark, method-redesign or tracing campaigns; no threshold
waiver or green reclassification. Historical sections and consumed attempts
remain unchanged. Product-correctness evidence is retained, the seven
historical gates remain **FAILED/OPEN**, and SEC08 remains **INCOMPLETE**.
No delivery or release is authorized.

### SEC-08 conditional clean-tab version gate — performance still unqualified

The 2026-10-13 continuation replaces the renderer's synchronous version/physical
gate with one fixed conditional Main request. On the unchanged branch Main
performs asynchronous binding checks around one retained-target metadata stat,
then returns only status, path key and finite disk-version fields. No descriptor,
body, adoption or document-sized string crosses that branch. Changed content
uses the existing pinned stable reader through the same conditional request,
not a second metadata-plus-body round trip. Functional counters and exact raw
receipt shape are pinned in `conditional-refresh-exact-proofs-r2.log`; they
measure operation/receipt behavior, not latency.

This intentionally supersedes the former synchronous, zero-IPC fast-path claim.
The new IPC and asynchronous probes have **not** been qualified against the
user's no-visible-regression requirement or the existing numerical contracts.
Neither functional passes nor the earlier frozen/skipped comparison certifies
these bytes, much less future final isolated sources. Comparable startup/open/
reload/tab-switch/Save/scroll/Mermaid measurements remain a release gate.
The later user direction authorized continuing release work while retaining
isolation responsiveness as mandatory; it does not waive thresholds or erase
the historical failed/open observations above.

### SEC-08 adoption metadata fence — responsiveness still unqualified

The bounded adoption migration removes renderer physical/version probes only
inside `verifyDiskAdoption`. It retains Main's body/digest preparation and
transactional commit/completion, adds a pre-dialog metadata fence in Main and
uses one small synchronous committed-capability check after approval. No body
is serialized by that new check, and the unchanged conditional-refresh branch
does not enter adoption. Remaining selection/post-completion helpers still
use raw renderer metadata; this staged change does not certify isolation.
The IPC and relocated/additional metadata work have not been measured against
the final-source responsiveness contracts. Native-backed core 109/109 and exact
R852-R857 controls (`adoption-fence-exact-proofs-r2.log`) pin actual grant/
refusal behavior, not latency. No literal zero-overhead claim is made.

### SEC-08 settled native reopen — unchanged normal operation count, not latency

The pending-Save consumer removes only its legacy renderer fallback. A normal
native reopen still waits for Save and makes the same existing one-use Main
ticket request, whose body is read behind the existing queue/revision/epoch
fences. No normal-path IPC, digest, read or large-string transfer is added by
this change. Actual resolved receipts and explicit missing-ticket refusal are
covered by the focused 28/28 and exact R858-R860 controls, not by a timing run.
Unchanged operation count does not qualify final-source responsiveness; the
remaining renderer metadata migrations and isolation flags still require the
already-defined representative final measurements.

### SEC-08 post-render metadata port — latency unqualified

`completeFileOpen` now batches its owner/source binding checks into one fixed
synchronous Main metadata request with one target stat. It carries only native
owner/source strings and finite version metadata, not content or a new
capability; distinct paths retain separate binding fences. Ordinary completion
without an approved adoption and the clean-tab unchanged fast path do not take
this port.
Replacing renderer metadata probes with this small RPC is not a timing verdict.
Native success/refusal and authority controls are green on corrected r2 source;
these are functional evidence only, not latency measurements.
Actual final isolated-source journeys and their existing numerical gates remain
required; no measurement in the earlier frozen comparison qualifies these bytes.

The source-diff-verified historical comparison reference is
`f87aa779b4d402c5c3b398880dd1c2adb313dd26`, immediately before `c44308c` moved
production dialog-extra reads from renderer stat/read/stat to Main-owned
one-use grants. It already includes browser-loader preparation, but not that
production reader-authority migration. Its application source/package/assets
match the historically exercised `cbe233f8c679d49cf7cd8aa89523ee6fff7d6d3f`
reference; it has now been freshly launched through the native-action harness.
Compare the real historical
application rather than disabling flags on the final architecture. Disclose
later Mermaid rendering/wrapping (`8e075ad`), diagnostic logging (`d553f22`),
menu layout and label changes: this is not isolation-only causal attribution.
The corpus runner loads production Main but times direct `renderMarkdown`
after warmup, excluding native admission/IPC and startup/reload/tab/Save/scroll
journeys. Its render measurements remain useful only within that scope.
Minimal real-action timing in the existing harness is still required after
final wiring; no timing, threshold change or synthetic backport is claimed.

The renderer boundary migration reuses the committed-capability check
before an approved selection and the retained-owner metadata check afterward
and on each side of delegated reload rendering. No new endpoint, body read or
body serialization is added. Other paths are not migrated by this unit and no
latency comparison has yet qualified the additional small metadata RPCs.
The corrected native combined controls reach 119/119 with source packaging
390/0 and converged independent Sol/Luna review. These prove function and
authority ordering, not responsiveness. The source-only fixture abort and
actual renderer-destruction barrier do not add shipped RPCs or rendering work.
The original combined timeout remains unexplained; a diagnostic pass despite
contaminated cleanup is not timing evidence, and the parent GUI launch with
lost stdout is retained as unusable rather than a latency sample.

### SEC-08 custom-tab authority consumers — responsiveness still unqualified

The tab migration reuses the existing committed/retained metadata ports around
staging and completion. Nonapproval creation/restore and successful Save add
bounded ref-bound metadata queries; receipt version fields travel on existing
messages, without a new endpoint or body read. The unchanged-switch controls
prove zero additional approval/adoption queries or body reads, not zero total
IPC. Rejected frozen/superseded render continuations perform no late native
metadata/authority checks; their local relevance/freeze guards still run.
Parent reproduces creation 55/55, reload/Save 120/120, background 20/20 and
extras/restore 24/24, with source packaging 390/0 and matching source hashes.
These are functional controls, not latency samples. Exact reverts and viewed
captures do not establish no visible performance effect.

The corrected fixture retains its private inputs through native process death
because observed handles do not prove all queued Main continuations ended.
Its deliberate delayed continuation is a sensitivity control, not observed
production stall duration. The historical intermittent issuance delay remains
unexplained. Low-ROI retarget/capacity permutations and the explicitly deferred
Save-alias/shutdown/ordinary-CI campaigns are not timing certificates.
The real `f87aa77` reference's locked-version-matched vendor bytes and tracked
fonts are prepared, recorded with hashes/provenance and `RuntimeVerified: false`
in `.context-viewport-evidence/performance-reference-f87aa77/runtime-preparation.json`.
That stopped preparation record remains unchanged. Subsequent successful R6
historical/current smokes are retained under
`native-actions-fixtures-r1/small-reference-smoke-r6` and
`native-actions-fixtures-r1/small-candidate-smoke`: actual open, multi-open,
tab click, changed reload, editor Save/accepted Main ACK, moved scroll and
added/repeated Mermaid at 150%, then 100%, complete with a live error sentinel
and no remaining Electron. Their captures were actually viewed; historical
100% clips the representative labels, whereas current labels wrap and the
decision diamond is compact and centered. The first failed sentinel/witness
attempts remain retained and do not establish product failures.
The single smoke startup is 905.68 ms historical versus 1283.93 ms current.
That observed difference is not dismissed or attributed to environment;
smoke is not the paired p50/p95 comparison. Final source still needs the
agreed action comparison and applicable contracts. The fixed comparison plan
uses fresh profiles, alternating AB/BA, identical library/font bytes and
complete source pins; no retries, trimming, overhead or threshold waiver.

The original `native-action-paired-r1` command survived the reported session
error and stopped at its declared 45-minute between-launch ceiling. It completed
73 of 84 planned launches, all exit 0: all 21 small pairs, 15 large pairs and
the large-16 candidate. The exact 11 unexecuted jobs remain in
`native-action-comparison-r1/phase-outcome.json`; no continuation or replacement
comparison was dispatched. Shipping sources remained frozen and owned Electron
processes exited. A transient diagnostic edit to the unloaded tab test during
two small candidate launches was byte-exactly restored and disclosed without
excluding samples.

This partial comparison does **not** qualify responsiveness. Raw small native
open/tab-switch medians change by +2.64/+0.93 ms; changed Refresh changes by
+8.37 ms at p50 and +20.61 ms at p95. Partial large edited-body Save changes
from 371.18 to 814.26 ms at p50 and from 749.80 to 8576.12 ms at p95
(45 historical versus 48 current samples, repeated within launches).
Current large Save reaches 17,605 ms with Main-loop maximum 16,836 ms;
historical Save also reaches 12,827 ms with Main-loop maximum 12,709 ms.
Cold Mermaid reload reaches 10,699 ms historical and 18,689 ms current,
with renderer Long Tasks 10,509/18,471 ms and Main-loop maxima below 25 ms.
These distinguish observed blocking channels, not their causes. No
environmental explanation or isolation-only attribution is established.

Fresh independent Sol/Luna analysis review agrees that module-entry-to-usable
startup is not the historical FCP/load endpoint, and explicit Native Refresh
is not conditional clean-tab switching. The analyzer reports raw deltas and
clearly labeled borrowed-budget diagnostics, not renamed historical gates.
It also preserves absent Long-Task instrumentation as unknown and counts only
qualified executed jobs. Existing gates remain unchanged and unqualified by
these distinct endpoints. Bounded separate Main/renderer CPU profiling of the
already-observed Save/Mermaid stalls is the next diagnostic step; it is neither
a retry nor acceptance evidence. Packaging/publication remains blocked on
actual responsiveness qualification.

The separate historical CPU diagnostic did not reach production readiness:
2026-10-13 21:35:23.478-07:00 to 21:35:48.581-07:00, exit 1,
no action samples and no live error-sentinel witness. It was executed by the
Luna reviewer after an ambiguous owner instruction; this is not owner execution.
The candidate was not launched. Retained profiles cover pre-readiness work,
not Save or Mermaid, and do not establish environmental or profiler causation.
Evidence remains unchanged under `stall-diagnostic-r1/reference`.
The user subsequently authorized only the owner to execute one distinct
current-only 1MiB Save diagnostic: normal startup and readiness before either
profiler attaches, one actual Save through correlated accepted Main ACK and
complete disk-body equality, then stop. Existing action guards and the
300-second outer launch bound remain. Readiness failures retain component and
resource state; no reference retry or acceptance claim is authorized.

That owner-only current diagnostic completed 2026-10-13
21:57:21.891-07:00 to 21:57:39.634-07:00, exit 0, with the live sentinel,
exact complete saved disk body, matching accepted Main ACK and no remaining
Electron. A PowerShell Boolean-literal error before any process dispatch was
corrected and separately retained; it was not another app launch.
The single Save was 152.57 ms command-to-usable, 116.80 ms renderer-to-usable
and 68.67 ms Main receipt-to-accepted ACK. Selected truncate/write/fsync
durations were 0.334/1.065/14.965 ms; inclusive outgoing dispatch was 2.01 ms.
The Main queued-Save callback's inclusive sampled stack was about 37 ms;
the custom-tabs `handleSaveResult` inclusive stack about 28 ms and the UTF-8
scan sampled self-time about 7.7 ms. Inclusive stacks overlap and cannot be
summed into a wall-time decomposition. These are sampled stack
durations, not isolated CPU utilization or independently measured bridge,
serialization or async-queue cost. Both profiles begin after observed
did-finish-load and positive production readiness, and include post-ACK
full-body verification. Evidence: `current-save-diagnostic-r1` beneath
`native-action-comparison-r1`.

This fast singleton does not reproduce or explain the paired large-Save
median/tail. A separate setup-control-tab stall in the same launch was
11,047.88 ms, renderer Long Task 10,661 ms and Main-loop maximum 10,670 ms,
before CPU collection; its cause remains unknown. The current and actual
historical source both retain truncate/write/fsync and stable post-write
readback. No newly dominant isolation bottleneck or justified product
correction is established by these profiles. The earlier unqualified
comparison and user-visible stalls remain release blockers. No further
profiling, historical retry or missing-job continuation is automatically
dispatched; a distinct next diagnostic or changed acceptance needs an
explicit decision.

The subsequent coordinator-authorized current-only tab diagnostic executed
once, owner 22:33:23.407-22:33:30.016 -07:00, native exit 0 with no Electron
survivors. Both CPU collections started after normal readiness but before the
same setup-control-tab action and stopped after its usable endpoint. The
observed command-to-usable interval was 342.306 ms, renderer interval 341.2 ms,
renderer Long Task 245 ms and Main-loop maximum 20.283 ms. Main sampled mostly
idle; renderer renderMarkdownFull was 242.834 ms inclusive / 132.556 ms self.
Marked (~47.195 ms) and sanitization (~27.18 ms) are overlapping nested sampled
stacks, not additional elapsed costs. Selected stat calls were 0.062-0.140 ms.
No multi-second stall or concrete costly NEW isolation implementation was
captured, so these observations justify no product correction. Independent
read-only Sol/Luna evidence checks agree with this limited conclusion, with no
disagreement. Frozen product hashes match after cleanup.

Evidence: `current-tab-diagnostic-r1` beneath `native-action-comparison-r1`.
The faster singleton does not clear the original partial paired comparison
or explain the earlier 11-second setup stall. No-visible-slowdown remains
unqualified; no further performance launch or publication follows automatically.

The first ordinary packaged correctness smoke subsequently found a genuine
startup diagnostics caller/registration mismatch, separate from performance.
The narrow R3 fix keeps diagnostic IPC development-only and makes the
production preload return explicit false without invoking an absent handler.
Main/preload source identities therefore advance beyond profiled R2. Neither
the older partial comparison nor either fast singleton is acceptance for
these changed final bytes; no additional performance run is dispatched.

## 2026-10-14 retained Save evidence and corrected proposal

- Read-only investigation uses every completed launch and Save sample from
  the stopped comparison; no replacement run or profiler was launched.
- Historical `f87aa779` and current setup do not schedule work identically.
  `bench/native-actions.js:500-517` uses bare `crypto.subtle.digest` after
  editor input. Historical classic-script `crypto` resolves to Node crypto;
  current resolves to browser crypto. The normal 400 ms preview and 800 ms
  history callbacks are not explicitly awaited before the Save clock.
- Large Save 371.18 -> 814.26 ms remains a real observed interval difference,
  but is **not an isolated Save, durability or bridge-cost delta**.
  Different excluded setup intervals may move preview work across its
  boundary. Do not subtract those intervals or estimate an explained share.
- Every completed large pair has a worse candidate median. Long
  ingress-to-ACK stalls remain unexplained; unchanged dispatch cost does not
  exclude other isolation overhead. Low CPU or overlapping pauses do not
  establish an environmental cause. Fast singleton diagnostics clear neither.
- Both sources already write, fsync and verify the saved body. Current adds
  a synchronous metadata request; its individual cost was not measured.
  Keep that guard. ACK, renderer tab/store adoption, visible preview and
  asynchronous session-layout durability are different endpoints.

**One proposed correction to the existing harness; not authorized execution**

- Use identical `window.crypto.subtle.digest` calls, input bytes and encoding
  in both apps. Do not let historical lexical globals select another API.
- Preserve the same real tab selection and changed/unchanged Reload setup.
  Those actions perform adoption, ownership/tracking and layout work;
  retain their whole intervals and any failures, not just Save samples.
- For **settled-editor -> Save**, dispatch normal input; observe the natural
  preview of those exact draft bytes in the DOM, completed rendering/frames
  and that edit's history update. Settle prior layout work separately using
  the existing current layout promise; historical layout writes are
  synchronous. Require the same owner/editor/dirty/nonpending state.
  Then use the unchanged native Save-to-usable endpoint.
- Separately preserve **immediate input -> Save** on an equivalently prepared
  clean document: start before input and click Save with no digest or preview
  wait between them. Report both the existing usable endpoint and the edit's
  eventual preview/history/Save settlement, so waiting cannot hide a stall.
- Retain Main ingress, write/fsync/verification, ACK and renderer/store/view
  timings separately. Keep the metadata guard inside Save; distinguish its
  cost if a future authorized measurement can observe it. Report final layout
  settlement separately from ACK, which does not certify that async tail.
- No new statistical framework, historical-results replacement, uncertainty
  waiver or promise of performance qualification follows from this proposal.

Evidence: `final-verification-20261014/retained-save-analysis.json` beneath
`.context-viewport-evidence/`. No source-supported isolation root fix was
established. Actual no-visible-slowdown acceptance remains unmet.

## 2026-10-14 corrected Save phase stopped before its first pair

- Later coordinator authorization allowed one new large-document phase:
  the original 21 matched pairs, 42 launches maximum, and a fixed 60-minute
  ceiling. The closed 73-of-84 comparison was not continued or overwritten.
- The corrected existing harness uses explicit browser SHA-256/UTF-8 in
  both apps. Normal input drives actual preview/render/history callbacks.
  Settled Save waits for those callbacks and prior layout; immediate Save
  clicks in the same input action without an intervening wait.
- First natural-view observation is independent of ACK and preserved.
  Store, post-Save view, layout barriers and full setup intervals remain
  separate. Main receipt/ACK and observed layout replies are recorded;
  isolated metadata, serialization, fsync and future-layout costs remain
  unknown. No guard or durability behavior changed.
- Fresh Sol/Luna feedback converged. Both required actual runtime identity,
  not the CLI's assumed resolution. Direct verified Electron and installed
  dependency bytes are frozen. Sol's timestamp, failure-preservation and
  process-ownership corrections were applied. Luna withdrew two findings
  after checking the actual readiness bound and VM source slices.
- **Fixed outcome: one reference launch completed; no candidate launched;
  zero matched pairs.** All six reference Saves passed normal mode, exact
  disk/store, natural preview/history and accepted-ACK controls.
- The supervisor stopped after 43.38 seconds when its second
  `Set-Content progress.json` failed with a Windows file-sharing exception.
  The file holder is unknown. This is a private result-journal failure,
  not evidence of an application defect or its performance cause.
- The reference's first natural-draft setup took 14,330.77 ms and recorded
  14,235.47 ms maximum Main-loop delay. Its natural draft was observed at
  867.90 ms; its later Save endpoint took 169.44 ms. Keep all these distinct
  observations; do not subtract them into an explained share or infer an
  environmental cause.

| Reference-only observations, three per mode | Save-to-usable median | Input-to-natural-draft median |
|---|---:|---:|
| Settled editor | 116.63 ms | 867.90 ms |
| Immediate input | 454.16 ms | 851.60 ms |

- These are **not comparative results**. Candidate controls remain
  unexecuted, so overhead persistence or removal cannot be concluded.
  All remaining 41 jobs are unexecuted; no retry, replacement, profiler or
  second campaign followed. No owned app process survived.
- Source apps were actual `f87aa779` and current `41389fe` with shipping
  implementation `668d17f3`, not a mismatched private asar. The frozen plan
  also records shared runtime/dependencies and later Mermaid/logging/menu
  differences; it is not a pure isolation experiment.
- Evidence: `.context-viewport-evidence/corrected-large-save-comparison-r1/`
  (`declaration.json`, `plan.json`, `phase-outcome.json`, `analysis.json`,
  `review-outcome.json`, and the first reference's raw logs/result).
- The original worse candidate medians and long ingress-to-ACK stalls remain
  relevant. No-visible-slowdown acceptance remains unmet; publication stays
  held. Further comparative execution is not automatic.

## 2026-10-14 Save syscall diagnosis and guarded writer correction

- The user authorized end-to-end completion, including necessary tooling
  repairs, real product fixes and their revalidation. Earlier no-retry stops
  do not override that direction; isolation and no-visible-slowdown still apply.
- Supervisor checkpoints now use exclusive immutable files. Actual app
  outcomes and reporting failures remain separate. Local controls exercise
  the real parsing/checkpoint handlers; focused Sol/Luna feedback converged.
- Corrected R2 stopped at a natural-draft watchdog. A separate candidate
  diagnostic observed a hidden document after one successful normal Save.
  The actor now has an independent natural-draft deadline and the same normal
  visible-window precondition in both apps. Neither correction weakens the
  exact preview/history/layout predicates or Save deadline.
- Corrected R3 completed both modes on both actual revisions in one matched
  pair, then failed on the next candidate's session-manifest rename: `EPERM`.
  Its 229.54-second outcome leaves 39 jobs unexecuted. The reference's settled
  median was 11,468.29 ms; candidate partial Saves reached 12,654.16 and
  16,527.39 ms. One skewed pair cannot qualify responsiveness or isolate
  architectural overhead. The manifest holder/cause remains unknown.
- A separate, bounded candidate I/O/CPU diagnostic completed six normal Saves.
  `ftruncateSync` took 10,627.56 and 12,860.50 ms; corresponding Saves took
  10,905.57 and 13,093.05 ms. A setup `stdout.write` took 10,750.19 ms.
  These measured calls blocked Main; their underlying OS causes are unknown.
  `fsyncSync` reached 14.26 ms and async manifest rename 27.06 ms in that
  diagnostic, not proof that either is always fast. The earlier instrumentation
  attempt lost `realpathSync.native` and failed before open; it remains separate.
- Save now writes UTF-8 bytes at explicit descriptor offsets, handles partial
  writes, rejects zero progress and truncates only when the new body is shorter.
  It retains the same checked descriptor/inode, final owner/path/version/lifecycle
  and deletion guards, no-yield critical section, fsync and stable readback.
  This removes unnecessary truncate-to-zero calls; it does not make all writes
  asynchronous or claim multi-writer atomicity.
- Actual-code controls cover growth, equal size, UTF-8 shrink, empty bodies,
  partial writes and no progress. Source packaging is 414/0. R922 is individually
  exact PROVEN, with its three intended failures and semantic controls passing;
  Main was restored byte-for-byte. Sol caught an overly specific shrink control;
  the corrected control still requires exact bytes and durability. Both
  independent final reviews found no product blocker.
- A twelve-write local probe preserved all exact bodies, but did not reproduce
  a long truncate stall. It supplies no quantified speedup. Post-fix comparison
  R4 freezes Main `25DDE236FF113CC398E9410473C86E4D50D4C301DB47BBD7C4C6B18C86153E06`,
  the original 21-pair large-only schedule and unchanged deadlines. R4 stopped
  after 109.99 seconds: reference completed, then the harness's fixture reset
  failed on truncate-on-open with `UNKNOWN`, after three accepted candidate
  Saves. Zero full pairs and 40 unexecuted jobs remain; this is not a Save failure.
- The corrected fixture reset uses an existing `r+` descriptor in both arms,
  positioned exact UTF-8 writes, conditional shrink truncation and fsync.
  Its inode and complete successful/failed setup intervals are retained;
  errors are not retried or swallowed. Actual helper controls pass with the
  corpus at 332/332; independent Sol/Luna feedback found no blocker.
- R5 stopped after 1,393.67 seconds: 22 launches, 21 normal validated launches,
  10 complete matched pairs and 20 unexecuted jobs. Both actual apps exercised
  both normal Save modes. The next candidate's `setup-primary-tab` timed out
  with a hidden-document witness, after its initial visible precondition.
  The same launch had a 13,931.73 ms open interval and 13,547.60 ms Main-loop
  maximum. The failure and pause causes are not attributed to the environment.
- All observed R5 settled-Save medians are 187.17 -> 217.16 ms; immediate
  medians are 354.94 -> 406.37 ms. Median completed-pair deltas are +29.96 and
  +53.81 ms; eight of ten pairs are slower in each mode. Preserve the whole
  distribution and failures: incomplete/unbalanced data is not acceptance,
  and removing unnecessary truncation has not cleared responsiveness.
- The PC-restart pause preserved all source/evidence. Resume verified HEAD
  and all seven dirty identities. A separate two-launch, ten-minute diagnostic
  uses the existing CPU/I/O tooling, actual synchronous metadata-handler spans
  and visibility events. It is not a replacement cohort or performance gate.
- That diagnostic completed both declared journeys in 67.38 seconds, with six
  accepted Saves per app and no owned app survivor. Both documents stayed
  observed visible. Its `qualified` flags cover exact source/runtime and native
  action controls only, not comparative or performance acceptance.
- Current metadata guards ran 98 times during open/reload/setup, reaching
  4.98 ms per callback; none ran within the six measured Save windows. This
  does not measure full synchronous IPC wait/transport cost or prove guards
  always fast. Current fsync reached 17.87 ms and manifest rename 7.13 ms.
- Profiled settled-Save medians were 209.55 -> 216.60 ms; immediate medians
  were 346.37 -> 332.60 ms. These two singleton journeys do not erase R5's
  worse paired medians or qualify responsiveness. No multi-second stall was
  reproduced; its earlier underlying causes remain unresolved. No guard,
  logging policy, deadline or durability change follows from these samples.
- Evidence: `.context-viewport-evidence/corrected-large-save-comparison-r2/`,
  `natural-draft-diagnostic-r1/`, `corrected-large-save-comparison-r3/`,
  `save-io-diagnostic-r1/`, `save-io-diagnostic-r2/`,
  `truncate-order-diagnostic-r1/`, `corrected-large-save-comparison-r4/`,
  `corrected-large-save-comparison-r5/` and `save-postrestart-diagnostic-r2/`.
  R1's pre-runtime staging/instrumentation defects remain separately retained.
  The prior private 407-check archive matches the older `668d17f3` Main,
  not this writer. No final-version package, integration or release is claimed.

## 2026-10-15 actual default-package Save comparison and viewed preparation

- Compare actual `f87aa779b4d402c5c3b398880dd1c2adb313dd26` against
  `d52fd0aa62f506fd0240f2a2a666698d2fb9b19d`, both ordinary private
  0.4.0 packages on this Windows host with Electron 43.4.1 / Node 24.18.1.
  Current Main SHA-256 is
  `25dde236ff113cc398e9410473c86e4d50d4c301db47bbd7c4c6b18c86153e06`.
  Keep later Mermaid, menu and logging changes in scope: this is not a
  pure isolation experiment.
- Default packaged Main naturally excludes development newline reporting;
  the actor does not disable it or replace the production preload.
  The synchronous disk-adoption query remains mandatory. Its separately
  observed current callback spans were 0.827-1.161 ms; these exclude
  transport, scheduling and renderer synchronous wait.
- The declared large-only, balanced 21-pair schedule stopped after 25
  launches in 1,088.513 seconds: 24 control-qualified launches, twelve
  complete pairs, 144 accepted exact Saves. Reference 13 timed out during
  natural-draft setup before any Save; candidate 13 and both arms of pairs
  14-21 remain unexecuted. No replacement samples or selected green subset.
- The failed stage lasted 237,277.086 ms before the original 240-second
  Main watchdog. Native exit 1, no survivors or reporting errors. It is a
  reference readiness/liveness failure, not a supervisor write failure
  or demonstrated candidate regression. Its count-only visibility event
  establishes neither hiding nor continued visibility; cause remains unknown.
- Standard medians average both middle observations when the count is even.
  All 36 retained observations per mode/arm are included below.

| Endpoint median (ms) | Reference | Current |
|---|---:|---:|
| Settled Save, renderer action to usable | 122.60 | 122.65 |
| Immediate input/Save, renderer action to usable | 247.80 | 247.80 |
| Settled Save, Main command to usable | 186.047 | 185.917 |
| Immediate input/Save, Main command to usable | 315.661 | 316.436 |
| Settled Save, ingress to accepted ACK | 41.679 | 42.779 |
| Immediate input/Save, ingress to accepted ACK | 181.452 | 183.756 |
| Settled mode, input to natural draft | 899.80 | 895.15 |
| Immediate mode, input to natural draft | 897.75 | 896.55 |
| Settled mode, input to layout tail | 1211.25 | 1206.40 |
| Immediate mode, input to layout tail | 958.10 | 957.30 |

- Median twelve-pair renderer deltas are +0.2 ms settled and +2.1 ms
  immediate; seven pairs are slower in each mode. Renderer maxima are
  246.7 -> 153.1 ms settled and 306.2 -> 304.4 ms immediate.
  Input-to-layout maxima are 1337.5 -> 1635.6 ms settled and
  980.5 -> 973.1 ms immediate. The current settled maximum includes a
  separately observed 433.5 ms layout wait after the visible draft;
  historical layout has no equivalent async tail API.
- The approximately 248 ms immediate Save endpoint does not include
  completed natural preview/history. Intervals and medians are not additive.
  Completed packaged observations do not reproduce the earlier typical Save
  penalty, but this incomplete declared phase is **not acceptance**, a
  whole-app responsiveness certificate or a pooled p95 qualification.
  Earlier failed/partial phases and startup/Mermaid stalls remain retained.
- One separate reference-only liveness diagnostic completed six Saves in
  51.931 seconds. Its sparse read-only 30-second observer never fired;
  all 53 observed visibility events were `visible:true`. That successful
  run does not establish the failed run's visibility state or explain it.
  No missing comparison jobs, profiler or deadline change followed.
- Current ordinary portable/NSIS preparation passed strict actual-asar
  checks 414/0 and every shipped source/resource identity; private/test
  evidence roots are excluded. Archive SHA-256:
  `506e057ba3917f3bcbdf42d6312e2bff68a968b2e1061832e9c0870216fd574e`.
  Assets are unsigned private 0.4.0, not installed or published evidence.
- Ten current-package visual scenes were actually opened. Eight R2 views
  were accepted: six schemes with table/list/code/inline styles, Search,
  and complete Mermaid decision/answer labels at 150%. TOC and Insert Table
  were rejected as transition-time captures despite passing native controls.
  A distinct two-scene correction waited for the actual 300 ms TOC slide
  and 200 ms dialog animation. Both new images were opened and accepted:
  full readable TOC and opaque dialog within the short window. R3 completed
  in 8.549 seconds, exit 0/no survivors; no product change or rebuild.
- Evidence beneath `.context-viewport-evidence/`:
  `save-packaged-default-r1/`, `packaged-large-save-comparison-r1/`
  (including `retained-standard-median-analysis.json` and exact unexecuted
  list), `save-packaged-stage-witness-r1/`, and `final-wave-visuals-r1/`
  through `final-wave-visuals-r3/`. Both viewed-assessment files preserve
  the accepted/rejected distinction. All earlier outcomes stay unchanged.

**Enclosing setup deadline correction**

- Source analysis found a real actor gap, not the failed run's cause:
  successful `observeDraft()` clears its timer, then the caller awaits
  another double animation frame outside that timer. Main previously
  awaited the whole execution without a stage deadline.
- Main now bounds that existing setup execution to 30 seconds after the
  unchanged visible-window precondition. Timeout remains failure and reaches
  the existing bounded failure capture; no frame, preview, history or
  durability requirement is removed. Failure witnesses retain input-return,
  natural-draft, layout and final-frame progress markers.
- Existing deterministic corpus controls extract the actual setup and callback:
  completed natural observation with withheld final frames, silent execution,
  and healthy two-frame completion. Corpus 335/335; R923 is exact PROVEN
  with healthy controls and byte-exact actor restoration. Independent
  Sol/Luna source feedback is clear.
- Both repaired authentic-package controls completed in 56.705 seconds,
  three settled and three immediate Saves per app, opposite first modes,
  exit 0/no survivors. This verifies normal actor wiring, not comparative
  acceptance or the old failure's cause. Evidence:
  `save-packaged-bounded-setup-r1/`; old phases remain closed and unchanged.

**Complete corrected packaged Save comparison**

- A distinct, frozen R2 ran the original balanced 21-pair / 42-launch
  large-document schedule after the concrete setup-deadline repair.
  Actor, driver and controls match the successful repaired two-app controls.
  Same f87/d52 packages, fresh ordinary profiles, explicit browser UTF-8
  crypto, natural preview/history and real frame requirements; unchanged
  240-second job / 300-second launch deadlines and 60-minute phase ceiling.
- Complete in 1,125.210 seconds: 42 launches, 21 matched pairs, 252 exact
  accepted Saves, 63 observations per arm/mode. No failed or unexecuted
  launches, reporting errors or owned survivors. Earlier phases are not pooled.
- Medians use every declared observation. p95 below is nearest-rank within
  these samples, not a population guarantee. Values are reference -> current.

| Endpoint (ms) | Median | Sample p95 |
|---|---:|---:|
| Settled Save, renderer action to usable | 123.3 -> 123.2 | 124.3 -> 124.2 |
| Immediate input/Save, renderer action to usable | 236.5 -> 238.2 | 295.8 -> 279.9 |
| Settled Save, Main command to usable | 186.558 -> 186.438 | 187.815 -> 187.455 |
| Immediate input/Save, Main command to usable | 303.332 -> 305.946 | 364.016 -> 347.758 |
| Settled Save, ingress to accepted ACK | 40.702 -> 39.652 | 55.019 -> 48.159 |
| Immediate input/Save, ingress to accepted ACK | 171.932 -> 172.592 | 225.828 -> 221.089 |
| Settled mode, input to store | 1016.5 -> 1018.2 | 1037.0 -> 1035.6 |
| Immediate mode, input to store | 190.0 -> 194.9 | 244.4 -> 243.2 |
| Settled mode, input to natural draft/history | 893.6 -> 895.8 | 909.6 -> 914.1 |
| Immediate mode, input to natural draft/history | 896.5 -> 899.4 | 914.8 -> 915.8 |
| Settled mode, input to post-Save view | 1205.0 -> 1206.6 | 1225.8 -> 1224.1 |
| Immediate mode, input to post-Save view | 957.2 -> 960.1 | 974.6 -> 976.3 |
| Settled mode, input to layout tail | 1205.3 -> 1207.0 | 1226.2 -> 1224.5 |
| Immediate mode, input to layout tail | 957.6 -> 960.5 | 975.0 -> 976.6 |
| Settled mode, full setup through tail | 2899.534 -> 2958.023 | 3032.110 -> 3033.093 |
| Immediate mode, full setup through tail | 2664.052 -> 2685.108 | 2823.105 -> 2808.314 |

- Per-action Main Save timing starts **after** its visible-window precondition;
  that precondition is recorded separately and included in full setup.
  Setup-stage timing includes its own visibility wait. Do not mix those clocks
  or subtract their medians to assign dispatch, serialization or disk cost.
- Median paired renderer deltas: -0.2 ms settled, +5.4 ms immediate.
  Current is slower in 6/21 settled pairs, with two ties, and 13/21 immediate
  pairs. Full-setup median increases remain +58.489 / +21.056 ms.
- Current's largest immediate Save is real: 406.2 ms renderer, 666.062 ms
  Main command, 320.146 ms ingress-to-ACK, 298.582 ms Main-loop maximum and
  a 209 ms renderer long task. Its input-to-layout tail is 968.5 ms.
  Reference's settled maximum is 466.5 ms renderer, 398.005 ms ingress-to-ACK
  and 373.031 ms Main-loop maximum. No multi-second individual Save/setup
  operation stall reproduced; accumulated setup still takes about 2.7-3.0 seconds.
- Independent Sol/Luna reviews agree: this complete frozen packaged workload
  does not demonstrate a consistent noticeable Save median/p95 penalty.
  Neither review establishes practical equivalence, pure isolation attribution,
  cold-start/Mermaid readiness or whole-app responsiveness. No causal stack
  attributes the retained spikes; no guard or durability shortcut followed.
- Evidence: `.context-viewport-evidence/packaged-large-save-comparison-r2/`,
  including `plan.json`, `phase-outcome.json`,
  `complete-standard-median-analysis.json` and
  `complete-stage-maxima-and-outlier.json`. Raw-result hashes are retained.
  Earlier failures and the user's no-visible-slowdown requirement stay intact.

**Packaged cold-path comparison and no-op idle overlay**

- Separate ordinary f87/d52 package controls first verified existing pre-actor
  Chrome navigation/paint entries, actual process birth and the original
  native Mermaid journey. A distinct balanced 21-pair / 42-launch phase then
  completed in 330.558 seconds, all observations retained, no failures,
  unexecuted jobs, reporting errors or survivors. Fixed 20-minute phase ceiling;
  unchanged action / 240-second job / 300-second launch guards.
- Fresh process/profile and genuinely unloaded Mermaid library, not a cold
  OS/file-cache claim. No Save, profiler, replacement preload, fake readiness,
  extra screenshot or product change during data. Same original large open,
  multi-open, empty Mermaid tab, 150% zoom, newly added exact diagram,
  cold/warm reload and return-to-100% reload. Later app differences still
  preclude pure isolation attribution.
- Standard medians and sample-local nearest-rank p95, reference -> current;
  one observation per endpoint/arm in each matched pair:

| Endpoint (ms) | Median | Sample p95 |
|---|---:|---:|
| Process birth to contentful paint | 762.0 -> 692.7 | 809.6 -> 749.4 |
| Navigation to contentful paint | 392.0 -> 324.0 | 420.0 -> 364.0 |
| Navigation to DOMContentLoaded end | 393.7 -> 341.7 | 420.6 -> 369.4 |
| Navigation to load end | 394.2 -> 342.0 | 420.9 -> 369.7 |
| Large open, renderer usable | 463.9 -> 463.8 | 464.9 -> 494.1 |
| Multi-open, renderer usable | 373.3 -> 403.5 | 404.6 -> 435.9 |
| Cold Mermaid at 150%, renderer usable | 360.1 -> 363.2 | 391.5 -> 394.7 |
| Warm Mermaid at 150%, renderer usable | 153.8 -> 153.6 | 154.5 -> 154.5 |
| Return-100% reload, renderer usable | 124.2 -> 154.1 | 154.6 -> 154.9 |

- Do not hide adverse paired results behind pooled medians: cold Mermaid's
  paired median is +20.1 ms, current slower 19/21; multi-open +30.6 ms,
  slower 18/21; return-100% +30.0 ms, slower 17/21. The last crosses the
  retained diagnostic >25 ms AND >10% median rule. No tolerance change or
  performance acceptance follows. Contentful paint is not final app usability;
  startup long tasks before actor attachment remain unobserved, not zero.
- Independent Astra analysis reproduced all raw hashes and endpoint summaries.
  Return-100% settlement worsens in every pair, median +6.5 ms; most remaining
  endpoint difference is after notification, before renderer completion.
  Main observation/verification overhead does not explain that tail. Reference
  has two distinct endpoint levels; orientation alone does not explain them.
  This does not establish an environmental or IPC cause.
- A separate two-app boundary witness completed in 16.006 seconds. At actual
  return-100% notification, both overlays were active with zero pending code.
  Reference/current notification: 36.9/42.7 ms; overlay first observed clear:
  60.5/92.1 ms; final existing frame: 123.0/155.2 ms. These are observed
  boundaries, not exact overlay-hide timestamps or a paired qualification.
- Source shows an unnecessary dependency: every full render with Prism waited
  for an idle callback to hide the click-blocking overlay, even with no code
  left to highlight. The narrow fix queues highlighting only when the same
  document-wide pending-code selector finds work. Empty and already-highlighted
  documents take the existing immediate cleanup path. New/external code keeps
  its bounded idle callback, generation/overlay ownership, tokens and buttons.
  No authorization, metadata, durability or real-frame guard is removed.
- Actual isolated native controls pass 40/40. Exact R924 restores unconditional
  idle scheduling: only the empty/already-highlighted no-op assertions fail;
  new-code, external-code and isolation controls pass. Renderer restored
  byte-for-byte. The initial legacy patch-suite attempt remains failed on its
  Node-only trap/raw-IPC actor; it is not a full-suite pass. The new controls
  now use the existing isolated browser suite, not a new harness.
- Independent final Sol/Luna reviews agree the product fix is sound. Sol also
  found an older idle-deadline test still rendering plain text while expecting
  deferred highlighting. It now renders real code and proves that setup;
  the timeout outcome is unchanged. Both focused follow-ups found no blocker.
  Final native controls remain 40/40 and R924 is exact PROVEN/restored.
  Authentic package revalidation remains; the older d52 archive is not
  post-fix evidence.
  Evidence beneath `.context-viewport-evidence/`:
  `packaged-cold-mermaid-controls-r1/`,
  `packaged-cold-mermaid-comparison-r1/complete-analysis.json`, and
  `packaged-mermaid-tail-witness-r1/` including positive/proof/failed-actor logs.

**Post-fix ordinary 0.5.0 package**

- Product fix `676e274f`; version/lock preparation `e2909a95`. The ordinary
  Windows build passes strict actual-asar checks 414/0. All frozen shipping
  files match source; only the renderer changed from d52, plus version metadata.
  Runtime/dependencies, Main, preload and tabs are unchanged. Both executables
  are unsigned. Local update-feed SHA512/size checks pass; private evidence is
  excluded. This initial build record does not itself verify installation or
  publication; the installed follow-up is recorded below.
- A separate post-fix phase completed all 42 launches / 21 matched pairs in
  323.861 seconds, without failures, missing jobs, reporting errors or survivors.
  Same successful method modules, balanced order, fixtures, endpoints and fixed
  20-minute / 240-second job / 300-second launch guards. No competing runtime,
  source, proof or build changes. All earlier phases remain separate.

| Endpoint (ms), reference -> current | Median | Sample p95 | Paired median delta |
|---|---:|---:|---:|
| Process birth to contentful paint | 767.4 -> 683.3 | 816.6 -> 743.4 | -56.2 |
| Navigation to contentful paint | 376.0 -> 328.0 | 432.0 -> 376.0 | -60.0 |
| Large open, renderer usable | 463.7 -> 390.8 | 494.9 -> 404.5 | -73.4 |
| Multi-open, renderer usable | 373.5 -> 406.4 | 404.7 -> 419.8 | +16.8 |
| Empty Mermaid tab, renderer usable | 123.0 -> 60.2 | 123.8 -> 61.4 | -62.9 |
| Cold Mermaid at 150%, renderer usable | 332.2 -> 275.9 | 362.4 -> 304.8 | -59.7 |
| Warm Mermaid at 150%, renderer usable | 153.1 -> 85.6 | 154.4 -> 96.9 | -58.0 |
| Return-100% reload, renderer usable | 123.6 -> 91.8 | 154.4 -> 92.8 | -31.9 |

- Open and all three Mermaid reload endpoints improve in every pair.
  Multi-open remains slower in 17/21 pairs: +32.9 ms / +8.8% pooled median,
  paired median +16.8 ms. It is a measured residual cost, not erased or
  established as human-visible. None of the declared app/Main-loop endpoints
  crosses the retained >25 ms AND >10% diagnostic rule.
- Keep setup outliers separate: the actor's synchronous fixture-write interval
  has reference/current median 8.731/7.071 ms, sample p95 17.640/220.446 ms,
  maximum 20.027/328.478 ms. These actual writes/fsyncs are retained, not app
  action timings or evidence of an environmental cause. Other setup/zoom
  observations remain in the raw records.
- Independent Sol/Luna evaluations reproduced the complete endpoint results.
  Both found no remaining evidence of a noticeable slowdown in these
  representative release journeys and support the remaining delivery checks
  without a performance waiver. Both retain the multi-open cost and setup
  outliers. This is not global equivalence, a population-p95 certificate, pure
  isolation attribution, or proof that earlier multi-second stalls never occur.
- The earlier complete Save comparison remains scoped evidence on unchanged
  Main/preload/tabs/dependencies, not a new post-fix timing cohort. A separate
  final-package functional smoke completed six exact settled/immediate Saves
  and real code highlighting/copy-button/input-unblocked controls. All three
  necessary captures were actually viewed: readable highlighted code, settled
  TOC, and opaque short Insert Table with usable controls. Unchanged earlier
  schemes/Search/Mermaid views are reused, not called newly captured.
- New evidence beneath `.context-viewport-evidence/`:
  `postfix-cold-mermaid-comparison-r1/complete-analysis.json`,
  `release-050-preparation-r1/artifact-manifest.json`, and
  `release-050-native-smoke-r1/`. A Windows ASAR-path preparation failure
  occurred before any launch and is retained separately. No samples were
  replaced. This comparison is separate from the installed follow-up below;
  it does not supply final delivery.

**Installed 0.5.0 verification**

- User approved installation and handled Windows elevation; no warning or
  administrator prompt was bypassed. Windows registers machine-wide Folia
  0.5.0 under `C:\Program Files\lostinsea\Folia`.
- Installed executable and asar match the verified ordinary build byte-for-byte.
  The same successful native functional method completed in 19.955 seconds:
  six exact settled/immediate Saves, code/token/copy-button/overlay controls,
  three fresh code/TOC/short-dialog captures actually viewed, no errors or
  survivors. Fresh private profile and owned copies; normal user files untouched.
- This verifies the installed app's tested paths, not updater/association
  behavior or the deferred shutdown/Save-alias campaigns. Evidence:
  `.context-viewport-evidence/release-050-installed-smoke-r1/`.
  Copied generic-method "NOT installed" / "viewed-pending" labels remain
  unchanged in raw outcomes. Actual deployment/path identities and the
  separate owner-viewed assessment establish this scoped installed follow-up.
  Final integration and published artifact verification remain.

**Published artifact follow-up**

- v0.5.0 is published from `f5b219818a9846a3ca2ddcc3ad7d79fe27c6d744`;
  release workflow 38676428597 completed all platform builds and attestations.
- Actual downloaded Windows portable runtime matches the measured ordinary
  build completely, including the executable/asar already tested installed.
  No timing cohort or installed-app run is fabricated for the downloaded copy.
- All published download SHA256/sizes, updater SHA512/sizes and exact tag-bound
  runtime attestations verify. Windows remains unsigned; macOS app signing
  was skipped. Provenance is not OS signing or a broader performance guarantee.
- The comparison limits, residual multi-open cost, setup-write outliers and
  earlier failed phases above remain unchanged. Published evidence:
  `.context-viewport-evidence/release-050-published-verification-r1/`.

## Measured and found already fast
- **Custom tab sync I/O is not the current bottleneck.**
  - `custom-tabs.js:69-111,640`
  - `statSync()` on a 2MB file: **0.05ms avg**
  - `existsSync()`: **0.08ms avg**
  - `readFileSync()` on a 2MB file: **3.95ms avg**
  - `CustomTabs.switchToTab()` with **25 tabs**: **3.4ms** JS time on the measured small-doc case
  - Conclusion: the renderer-side sync file checks are real, but they are low ROI compared with render/search/startup work.

- **Scroll handling did not show the classic O(n)-per-frame scroll-spy problem.**
  - I did not find a heading-activation scroll spy in `renderer.js`; TOC work is click-driven.
  - A 160-step scroll stress test on the 2001-heading document averaged **16.65ms/frame** with **0 long tasks** attributed by the Long Task API.

- **Mermaid caching is already working for unchanged diagrams.**
  - On the 20-diagram fixture, initial `mermaid.run()` cost was **493.3ms**.
  - On the 1-line changed render of the same document, `mermaid.run()` was **not called at all**.
  - The performance problem is the fallback to the full non-Mermaid pipeline, not redundant diagram rerendering.

- **No obvious tab/memory leak showed up in the measured open/close cycle.**
  - 12 Mermaid-heavy tabs opened/closed across 3 GC-stabilized cycles returned to baseline within **0.0-0.2MB** of `heapUsed`.
  - `rendererErrors` stayed empty during the loop.

- **D2 and KaTeX are not active runtime paths in this fork.**
  - D2: repository search found only comments mentioning D2, not a renderer implementation to benchmark.
  - KaTeX: found in `package-lock.json`, but not in the actual `renderer.js` / `index.html` runtime path.
