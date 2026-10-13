# Customizations

This document tracks custom modifications made to the forked repository that differ from upstream.

## Approach

We use an **overlay customization system** to make it easy to maintain customizations across upstream merges:

- **custom-styles.css** - Style overrides loaded after base styles.css
- **custom-tabs.js** - Tab management functionality loaded after renderer.js
- **custom-performance.js** - Performance optimizations loaded after renderer.js

This approach means after an upstream merge, you only need to ensure these files are:
1. Still present in the repository
2. Still referenced in index.html

> **Scope of the overlay convention (updated).** The overlay is still the
> preferred home for *behavioural* customizations, and the files above are still
> the first place to look. But this fork no longer tracks upstream by wholesale
> merge — upstream changes are now taken as targeted cherry-picks, evaluated
> individually. Keeping `main.js` / `renderer.js` byte-clean against upstream is
> therefore no longer a binding constraint, and the security and performance
> work (see `SECURITY-AUDIT.md` and `PERF-AUDIT.md`) edits those files directly.
> Such edits are kept tightly scoped and commented with their finding ID so they
> can be offered upstream later. Do not read point 2 under "Benefits" below as
> forbidding that.

## Custom Features

### 1. Compact Header (custom-styles.css)
- Reduced header padding from `12px 20px` to `6px 16px`
- Logo reduced from 32px to 24px height
- Button padding reduced from 8px 16px to 3px 8px
- Tighter spacing (gap reduced from 12px to 8px)
- Makes the header more compact while remaining usable

### 2. Enhanced Scrollbar (custom-styles.css)
- Wider scrollbar (16px instead of 12px)
- Always visible with transparent track
- Easier to grab and use for scrolling large documents
- Custom dark mode styling

### 3. Tab System (custom-tabs.js + custom-styles.css)
- Multiple files can be opened in tabs
- Each tab shows filename and can be closed individually
- Active tab is clearly distinguished with accent color border
- Unsaved changes indicator (dot) on tabs
- Tabs persist across app restarts (saved to localStorage)
- Switching tabs preserves scroll position
- Shows file info bar when only 1 file open, tabs when 2+ files

#### 3a. Tab state synchronisation (fixes "refreshing one tab reverts another")

Each tab caches its own `content`, and `switchToTab()` repaints from that cache.
Upstream's reload/save paths only update renderer.js's module-level
`originalMarkdown`, so a refreshed or saved document never reached the tab cache
and the next tab switch silently repainted the pre-refresh copy.

`custom-tabs.js` now keeps the cache authoritative:

- **`file-reload-result` is intercepted** (renderer's own handler is captured and
  delegated to) so the fresh content is written into the tab, the scroll
  position is preserved across the repaint, and the repaint is skipped entirely
  if the user switched tabs while the disk read was in flight.
- **`save-markdown-result` is mirrored** into the tab identified by `data.path`
  (not the currently active tab - the write is async and the user may have
  switched away).
- **Switching to a tab re-reads the file** when its `mtime` changed, so a
  background tab is never shown stale. Tabs with unsaved edits are skipped.

- **Dirty state is structural**: the tab's cached `content` versus its
  `originalContent`, compared with line endings normalised. Reading renderer's
  `#unsavedIndicator` was tried first and is *not* safe - the element keeps its
  inline style after exiting edit mode, so dirty state bled between tabs.
  `renderer.js` exports `window.setUnsavedState()` so the per-tab value is
  restored into renderer's global on every switch.
- **Text that has been through the editor is never compared raw against text
  from disk.** A `<textarea>` normalises CRLF/CR to LF on assignment (HTML
  spec: the API value is the newline-normalised raw value). Since `switchToTab`
  writes `tab.content` into the editor and `snapshotActiveTab` reads it back
  out, an unmodified Windows-line-ending file otherwise came back 2 bytes per
  line shorter and read as edited with zero keystrokes - showing a phantom
  unsaved dot, pausing its file watcher, prompting on close, and converting the
  file to LF on the next save. `sameDocument()` normalises both sides, and the
  snapshot keeps the cached copy when the only difference is that
  normalisation.
- **Scroll position survives a refresh** via a heading anchor ("Nth heading with
  this text, plus a pixel delta") rather than a raw pixel offset, because a
  refresh usually changed the content above the viewport too. A `ResizeObserver`
  re-applies it while diagrams/images settle, cancelled on user input.
- **`getScroller()`** picks `.content-wrapper` in normal view and `#viewer` in
  split/edit view, matching the CSS.

**Disk-version policy (F22, 2026-10-01).** Main, renderer and the tab overlay
compare device, inode, size and `mtimeMs` when checking a file version;
they carry but do not compare `ctimeMs`. Windows can advance ctime after a
file is selected without changing its bytes, causing false Save conflicts
and rejected tab switches. This is an explicit maintainer trade-off, not a
claim that every same-size external change is detected: a different writer
can change bytes without changing the file's identity or size, then restore
its old mtime. In that case the version tuple alone cannot distinguish the
external edit, and a later Save may overwrite it. Deletion, path identity
and ordinary size/mtime mismatch protections remain separate. The stronger
raw-byte witness design is tracked after wave 2 as `ctime-byte-witness` in
`docs/PLANNED-WORK.md`; do not silently restore a strict ctime comparison
without resolving the original false conflicts and measuring the result.

**Clean-tab refresh read boundary (SEC-08, 2026-10-07, unintegrated).** The
changed-disk content read now crosses an owner-bound main-process IPC rather
than reading content in the renderer. Main retains a case-preserving physical
target, pins the read to an opened descriptor and checks both pathname
identities before replying. The lowercased Windows owner key is not an I/O
pathname. Ordinary inode replacement and in-place changes can retry within
the existing stable-read bound, but only while the owner/target remain
authorized. An unchanged clean tab still returns synchronously without a new
snapshot IPC. The renderer rechecks live edits, mutation revision, ownership
and switch currentness before its separate disk-adoption attestation, so a
held read cannot bless a superseded tab's new cache.

This is a preparatory boundary, not completed Node isolation: renderer owner
registration and restored paths remain provisional. Preserve the fail-closed
case-only-rename limitation rather than folding physical pathnames; explicit
reload recovery is source-traced but not runtime-proven. The real-main
replacement regression distinguishes the old descriptor from the replacement
inode and requires replacement-only bytes plus descriptor cleanup. On Windows
the controlled move-aside/install fixture exercises that boundary without
claiming OS-level atomicity. R714-R718 individually protect this slice;
broader Wave 2 and release gates remain separate.

**Production preload consumers (2026-10-12, unintegrated).** Main windows
always load `main-preload.js`; marked unpackaged test preloads augment rather
than replace it. Clean-tab snapshots and one-use multi-select extras use fixed,
validated methods. Dialog extras carry an opaque main-issued grant, never an
arbitrary read path; main retains sender/session/batch authorization and its
post-read recheck. Response copying validates the existing version tuple
without changing its comparison policy. The unchanged tab path remains
synchronous and makes no snapshot IPC. These are consumer migrations, not a
claim that main-window Node access, provisional registration or restore
authority are already removed.

**Browser crypto and byte counting (2026-10-12, unintegrated).** Session IDs
and tab disk attestation use native browser crypto and exact UTF-8 encoding.
Diagnostic byte counts share a pure browser/CommonJS helper instead of Node
Buffer. Surrogate parity and complete Unicode adoption are protected without
introducing IPC or work on the default diagnostic-disabled path. Main
authorization/adoption semantics are unchanged; remaining isolation and final
responsiveness gates are separate.

**Disk-adoption capability ports (2026-10-12, unintegrated).** Preparation,
commit, completion and abandonment use four fixed validated preload methods,
with the original async/sync ordering and main checks unchanged. Distinct
nullable/current/proposed owners, historical-deletion resolution, disk version,
nonce/digest and completion's unresolved-evidence signal survive the boundary.
The bridge adds no read or IPC; remaining authority/consumer transitions and
final responsiveness acceptance stay open.

**Right-click menu fit (2026-10-12, unintegrated).** Menus fit their untransformed
layout size with normal viewport margins, scroll vertically when needed and
wrap at extremely narrow widths. Only scrolling inside a menu avoids the
existing document-scroll dismissal; ordinary document scrolling still closes
it, and reopening starts at the first command. The existing flat command set,
actual handlers and unrelated nested toolbar menus are preserved.

**Narrow-window menus (2026-10-12, unintegrated).** The upstream viewport-cap
fix is adapted without its nested-flyout clipping. Wide menus preserve their
original minimum widths and cap content expansion; compact menus put nested
File/View/Theme panels in normal flow under a bounded scrolling root.
The supported lower bound is the OS-achievable window, not the compact-header
threshold. Labels and controls wrap at that bound; returning wide restores
left-opening flyouts. Document zoom does not resize the toolbar. Preserve the
wide frozen declarations as well as compact reachability when picking later
upstream menu changes; R741/R742 protect the two layouts.

**"File Updated" prompt behaviour.** The bottom-left toast
(`#fileUpdateToast`) is only appropriate for the tab the user is actually
looking at, because that is the only one we deliberately do *not* reload
automatically - yanking the document out from under a reader would be worse
than asking:

- A background tab is reloaded silently on switch and confirmed with the
  passive "File reloaded successfully" notification instead of an actionable
  prompt.
- Switching tabs dismisses any pending prompt. It is bound to renderer's
  `currentFilePath`, so after a switch its Reload button would act on a
  different document than the one it was raised for.
- The prompt's Reload button is rebound to a guarded handler. Upstream wires it
  as `onclick="reloadCurrentFile()"`, which - unlike the toolbar refresh button
  - reloads with no unsaved-changes confirmation. Assigning `.onclick` replaces
  the inline attribute rather than adding a second listener, so renderer's own
  call sites are untouched and the user is never asked to confirm twice.
- After any foreground reload the overlay calls `window.setUnsavedState(false)`.
  Renderer only clears its own flag when reloading *in edit mode*, so a
  view-mode reload otherwise left a phantom dirty state that suppressed all
  later update prompts.

**The foreground reload completion is scoped to the tab and render that started
it.** `renderMarkdown()` is genuinely async - mermaid/D2 diagrams take seconds -
and renderer's `file-reload-result` handler awaits it. Anything the overlay does
after that `await` therefore runs against whatever document is active *then*,
not the one that was reloaded. Two real failures came out of this:

- Typing during the render, then having the completion call
  `setUnsavedState(false)`, marks the new edits saved; the next refresh
  discards them with no warning. The completion now compares the live document
  against a baseline and, if they differ, writes the live text back and keeps
  the tab dirty instead of clearing the flag. The baseline is *sampled through
  the same expression as the live read*, immediately after `delegateReload()`
  returns - not taken from `data.content`. Renderer runs synchronously up to
  its `await renderMarkdown(...)`, so by then it has already assigned
  `markdownEditor.value = data.content`, and a `<textarea>` normalises CRLF to
  LF on assignment. Comparing against the raw `data.content` reported every
  Windows-line-ending file as edited on every reload with no user input at all,
  permanently dirtying the tab (which pauses its watcher and prompts on close)
  and rewriting the file to LF on the next save.
- Switching to a dirty tab during the render made the completion clear *that*
  tab's flag and scroll it to the old tab's anchor - and, once the check above
  existed, write the new tab's text into the old tab's cache. A
  `renderGeneration` counter plus the originating tab id are captured before
  `delegateReload()`; if either has moved on, the completion is discarded
  outright. (`switchToTab` was already generation-guarded; the reload path was
  not.)

**Overlay disk reads go through `file-helpers.js`.** Three overlay paths read
files directly rather than over IPC - auto-refresh on tab switch, session
restore, and multi-file open. `main.js` does not hand the renderer raw file
bytes: `readMarkdownFile()` strips the BOM *and* wraps `.mmd`/`.mermaid`/`.ow`
content in a fenced code block. A plain `fs.readFileSync` in the overlay
therefore produced different text than the same file opened normally, silently
dropping the fence so the diagram source rendered as plain text. The overlay now
`require()`s the same helper instead of re-implementing the rules, so the two
paths cannot drift when upstream changes them.

Two small upstream edits were unavoidable:

- `main.js` gained an `ipcMain.on("set-active-file")` handler. `custom-tabs.js`
  had always sent this on every tab switch but **nothing handled it**, so the
  file watcher stayed pinned to whichever file was opened first. It honours a
  `watchingPaused` flag so a tab switch cannot re-arm a watcher the renderer
  deliberately paused during an edit.
- **Closing the last tab disarms the watcher** (`stop-file-watching`) and clears
  `currentFilePath`. Otherwise the watcher stayed armed on the file just closed
  and an external change raised a "reload?" prompt over the welcome screen, for
  a document with no tab.
- `renderer.js` exports `window.i18n`, `window.setUnsavedState` and
  `window.dismissFileUpdateNotification`. The last one is already an implicit
  global today, but the overlay must not rely on that: renderer's
  `fileUpdateNotificationShown` flag is module-private, so a DOM-only dismissal
  would leave it stuck `true` and silently swallow the next external-change
  notification for up to 10 seconds.

Regression coverage: `npm run test:tabs` (see below).

### 4. Fixed EPIPE Error (main.js)
- Replaced `console.log/error` with safe `log()` function in file operations
- Prevents crashes when app is launched by double-clicking .md files (no terminal attached)
- Fixes "write EPIPE" errors in stopFileWatching and other functions

### 5. PDF Export Optimizations (custom-styles.css)
- Hides header, tabs, and file info bar in PDF exports
- Forces light mode colors for PDF (white background, dark text)
- Ensures PDFs are printer-friendly regardless of app theme
- Removes editor view from exports if in split mode

### 6. Performance Optimizations (custom-performance.js + main.js + package.json)

**Problem**: ~10% CPU usage when app is visible but unfocused.

**Root cause**: Two compounding issues:
1. Electron 27 overrides a private macOS API (`_cornerMask`) forcing macOS WindowServer to recalculate window shadows every display frame
2. Upstream has an unthrottled global `mousemove` listener firing on every pixel of movement

**Solutions**:
- **Electron upgraded to ^43.2.0** — the `_cornerMask` bug is fixed from ^37 onward (merged in [electron/electron#48376](https://github.com/electron/electron/pull/48376)); ^41.7.1 or later is additionally required to clear the security advisories affecting every earlier line
- **`backgroundThrottling: true`** in `main.js` BrowserWindow options — lets Electron reduce activity when window is in background
- **`custom-performance.js`** — throttles mousemove to 80ms intervals, drops events entirely when window is unfocused, dismisses floating panels (recent files, toasts) on blur
- **Electron upgrade is protected** via `scripts/post-upstream-merge.sh` which re-pins to `^43.2.0` after any upstream merge

**Important**: If an upstream merge resets `package.json` electron to `^27`, run `./scripts/post-upstream-merge.sh` to restore `^43.2.0`. Electron 43+ requires Node >= 22.12, which is pinned in `.nvmrc` and enforced by `engine-strict`, so the Electron pin and the Node pin must be raised together.

### 7. Mermaid label measurement and compact wrapping (renderer.js + mermaid-config.js)

Mermaid's HTML-label measurements use viewport coordinates, but its SVG layout
uses document coordinates. Folia's reader zoom previously mixed those units:
adding diagrams and manually reloading at 150% could produce clipped labels
that stayed clipped after returning to 100%, while reopening the same document
fresh rendered correctly.

All three drawing paths now measure in a hidden, inert staging container
outside the zoomed reader. Each staged diagram retains its logical width and
typography, including the width-dependent Gantt layout. The live diagram stays
in place until the new SVG is ready; cancelling zoom on the live reader instead
was rejected because it moved the reading position during theme changes.
Adoption checks the caller's generation and the original node's source and
identity. Moving actual child nodes preserves Mermaid's native bindings; stale
output is neither adopted nor cached, and the staging container is always
removed, including after a rejected batch.

Flowchart labels use a 160px wrapping budget, the existing 14px font and 6px
padding, plus emergency wrapping for unbroken identifiers. This makes the
representative decision label wrap as "Each query or" / "stage language"
instead of growing a wide square diamond. It is a global wrapping choice, not
a per-shape sizing override: longer prose can gain lines, and explicit line
breaks can wrap further. Short labels remain intrinsic. Mermaid still owns
shape geometry and connector placement; no polygons are resized after layout.

The targeted suite covers the real add/reload/zoom-reset journey, theme and
insertion paths, full-label geometry, compact decisions, bindings, stale
adoption, scrolling in normal/split view and width-dependent layouts. Its
roomy 100% and constrained/zoomed captures must be opened when checking visual
changes; merely writing PNGs is not visual verification.

## How to Maintain After Upstream Merge

**After every upstream merge, run the post-merge script:**

```bash
./scripts/post-upstream-merge.sh
```

This script automatically:
- Re-pins Electron to `^43.2.0` (overwriting any upstream downgrade)
- Checks all custom file references in `index.html`
- Checks all custom files in `package.json` build list
- Verifies `backgroundThrottling: true` in `main.js`
- Runs `npm install` with the correct Electron version

### Manual Checklist (if not using the script)

### 1. Check Files Exist
```bash
ls custom-styles.css custom-tabs.js custom-performance.js scripts/post-upstream-merge.sh
```

### 2. Verify index.html References
Ensure index.html contains:
```html
<head>
  ...
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="custom-styles.css">  <!-- This line -->
</head>
<body>
  ...
  <script src="renderer.js"></script>
  <script src="custom-tabs.js"></script>  <!-- This line -->
  <script src="custom-performance.js"></script>  <!-- This line -->
</body>
```

### 3. Test Functionality
```bash
npm run test:tabs   # automated tab regression suite
npm start           # manual smoke test
```

`npm run test:tabs` runs `test-tab-refresh.js`, which boots the real `main.js`
in Electron and drives the renderer through the multi-tab scenarios that the
overlay is responsible for (refresh does not revert other tabs, background tabs
auto-reload from disk, unsaved edits are never clobbered, refresh keeps the
reader at the same heading, the "File Updated" prompt appears only for the tab
being actively viewed). It needs no test framework - only the Electron
that already ships as a devDependency. **Run it after every upstream merge**:
it is the fastest way to detect that upstream changed its reload, save or
watcher contract.

Two things to know when editing the harness:

- A native `confirm()` / `alert()` blocks `executeJavaScript` **forever**, so a
  bug turns into a silent hang. There is a 180s watchdog that fails loudly and
  prints partial results. If it fires, look for a modal dialog.
- `closeTab()` re-derives dirtiness from live renderer state via
  `snapshotActiveTab()`, so teardown must leave `window.originalMarkdown` in
  agreement with the active tab or it will raise a real confirm dialog.

When adding a regression check, prove it is meaningful: revert the fix it
covers, confirm the check fails, then restore. Every assertion in the suite has
been validated this way.

Verify manually:
- [ ] Scrollbar is visible and wide
- [ ] Header is compact
- [ ] Opening multiple files creates tabs
- [ ] Tabs can be switched and closed
- [ ] Tabs persist after restart
- [ ] Refreshing one tab does not revert another
- [ ] The "File Updated" prompt appears for the tab you are looking at, but a
      background tab reloads silently with a passive notification
- [ ] CPU usage is low when app is idle (~0-1% instead of ~10%)
- [ ] PDF exports don't include header/tabs and use light colors

### 4. If Something Breaks

Check browser console (F12) for errors. Common issues:

**Tabs not working:**
- Check if `tabsContainer` element exists in index.html
- Verify custom-tabs.js loads after renderer.js
- Check console for `[CustomTabs]` log messages

**Styles not applying:**
- Verify custom-styles.css loads after styles.css
- Use `!important` if upstream styles override (already done)
- Check for CSS syntax errors

**File opening in wrong way:**
- The custom-tabs.js intercepts `file-opened` IPC events
- If renderer.js changes its file handling, may need adjustment

## Modifying Customizations

### To Change Header Size
Edit `custom-styles.css`, find:
```css
.header {
  padding: 6px 16px !important;
}
```

### To Change Scrollbar Width
Edit `custom-styles.css`, find:
```css
::-webkit-scrollbar {
  width: 16px !important;
}
```

### To Modify Tab Behavior
Edit `custom-tabs.js` - all tab logic is in this file.
Key functions:
- `createTab()` - Creates a new tab
- `switchToTab()` - Switches active tab
- `closeTab()` - Closes a tab
- `renderTabs()` - Updates tab UI

## Version History

- **2026-02-07**: Initial customization overlay system created
  - Extracted tab functionality from original fork
  - Created modular overlay approach for easier maintenance
  - Preserved scrollbar and header customizations

## Benefits of This Approach

1. **Easy to Maintain**: After upstream merge, just verify 2 files + 2 lines in index.html
2. **Non-Invasive**: Doesn't modify upstream files directly
3. **Clear Separation**: Custom code is isolated and documented
4. **Easy to Disable**: Remove 2 lines from index.html to disable
5. **Easy to Extend**: Add more custom-*.js or custom-*.css files as needed

## Future Customizations

When adding new customizations:

1. Create new `custom-<feature>.css` or `custom-<feature>.js` file
2. Add reference to index.html
3. Document here in CUSTOMIZATIONS.md
4. Use descriptive console.log prefixes like `[CustomFeature]`
5. Wrap JS in IIFE to avoid global scope pollution
