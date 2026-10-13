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
