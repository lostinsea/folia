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

## Measurement methodology

- Machine: **AMD EPYC 7763**, 16 vCPU exposed / 32 logical processors, **127.9GB RAM**, **Windows 11 Enterprise 26200**
- Runtime: **Electron v41.7.1**, **Node v20.18.3**
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

## Findings

### PERF-01 — Eager main-process `require()`s block startup

> **Status: fixed** (commit `2416fc3`). `html-to-docx` and `electron-updater` are now
> loaded through `getHTMLtoDOCX()` / `getAutoUpdater()` on first use. Guarded by
> `test-startup-perf.js`, which reads the real `require.cache`.

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
- **Specific proposed alternative:** lazy-load `html-to-docx` inside the export handler, and lazy-load `electron-updater` only when packaged and after the first window is shown (or on first manual update check).
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
