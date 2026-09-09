/**
 * Custom Tabs Functionality
 * This module adds tab management to the markdown viewer.
 * Can be easily reapplied after upstream merges.
 *
 * Load this after renderer.js in index.html
 */

(function () {
  "use strict";

  // Get DOM elements for tabs
  const tabsContainer = document.getElementById("tabsContainer");
  const tabsElement = document.getElementById("tabs");

  // Per-tab context menu. `clipboard` and the positioning helper are required
  // directly rather than borrowed off renderer.js's script scope so this module
  // stays self-contained.
  const { clipboard, ipcRenderer: tabIpc } = require("electron");
  const {
    positionContextMenu: positionTabMenu,
    hideContextMenu: hideTabMenuEl,
  } = require("./context-menu-utils");
  const tabContextMenu = document.getElementById("tabContextMenu");
  const ctxTabCopyPath = document.getElementById("ctxTabCopyPath");
  const ctxTabOpenFolder = document.getElementById("ctxTabOpenFolder");
  let tabContextPath = null;

  function showTabContextMenu(x, y, filePath) {
    if (!tabContextMenu || !filePath) return;
    tabContextPath = filePath;
    positionTabMenu(tabContextMenu, x, y);
  }

  function hideTabContextMenu() {
    if (!tabContextMenu) return;
    hideTabMenuEl(tabContextMenu);
    tabContextPath = null;
  }

  if (tabContextMenu) {
    document.addEventListener("click", (e) => {
      if (!tabContextMenu.contains(e.target)) hideTabContextMenu();
    });
    document.addEventListener("scroll", hideTabContextMenu, true);
    window.addEventListener("resize", hideTabContextMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideTabContextMenu();
    });
  }

  ctxTabCopyPath &&
    ctxTabCopyPath.addEventListener("click", () => {
      const p = tabContextPath;
      hideTabContextMenu();
      if (!p) return;
      clipboard.writeText(p);
      if (typeof window.showNotification === "function") {
        window.showNotification(
          typeof window.i18n === "function"
            ? window.i18n("notif.pathCopied")
            : "Path copied to clipboard",
          1500,
        );
      }
    });

  ctxTabOpenFolder &&
    ctxTabOpenFolder.addEventListener("click", () => {
      const p = tabContextPath;
      hideTabContextMenu();
      if (p) tabIpc.send("open-folder-in-explorer", p);
    });

  // Tab management state
  let tabs = [];
  let activeTabId = null;
  let tabIdCounter = 0;

  // ============================================
  // Shared Helpers
  // ============================================

  // Which element scrolls is a CSS fact, not something to infer from a class
  // name. It was inferred here, and the table-breakout work changed #viewer's
  // overflow - which silently pointed save/restore at an element whose
  // scrollTop is always 0, losing every tab's reading position in split view.
  // This asks the engine instead, so the pairing cannot drift out of sync with
  // the stylesheet again.
  //
  // Delegates to renderer.js's getViewerScroller() when it is present so there
  // is one definition, but keeps its own copy as a fallback: this is an overlay
  // file that must not hard-depend on renderer internals.
  //
  // Deliberately tests only the computed overflow, never scrollHeight: during
  // a restore the new document may not be laid out yet, so a
  // "is it scrolled right now" test would report the wrong element precisely
  // when the answer matters most.
  function getScroller() {
    if (typeof getViewerScroller === "function") return getViewerScroller();
    const wrapper = document.querySelector(".content-wrapper");
    const viewerEl = document.getElementById("viewer");
    const scrollable = (el) =>
      el && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY);
    if (scrollable(viewerEl)) return viewerEl;
    if (scrollable(wrapper)) return wrapper;
    return wrapper || viewerEl;
  }

  // A <textarea> normalises CRLF/CR to LF on assignment (HTML spec: the API
  // value is the newline-normalised raw value), so any text that has been
  // through the editor can never be compared byte-for-byte against text that
  // came from disk. Every comparison that spans that boundary must normalise
  // both sides, or a plain Windows-line-ending file reads as "edited" the
  // moment it is shown in edit mode.
  function normaliseNewlines(value) {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
  }

  function sameDocument(a, b) {
    if (a === b) return true;
    if (
      typeof a === "string" &&
      typeof b === "string" &&
      a.indexOf("\r") < 0 &&
      b.indexOf("\r") < 0
    ) {
      // Deliberately the comparison again and not a bare `false`, even though
      // the identity check above has already answered no. This branch has to be
      // CORRECT on its own: if the check above is ever removed or bypassed,
      // returning a hard false would make sameDocument report two equal
      // documents as different, and a tab that is falsely dirty is a tab that
      // asks the reader to discard work that does not exist. The redundant
      // comparison costs one scan at an EDIT, which is no longer on the close
      // path at all.
      return a === b;
    }
    return normaliseNewlines(a) === normaliseNewlines(b);
  }

  // THE DIRTY ANSWER IS MAINTAINED, NOT RECOMPUTED ON SHUTDOWN. Every way out
  // of the app asks every open tab whether it is dirty, and the answer used to
  // be a full comparison of `content` against `originalContent`, memoised on
  // the VALUES - which means the memo's own validity check was itself a full
  // comparison. Measured (bench/run-f22-shutdown.js, 25 tabs x 2 MB, every tab
  // freshly edited): raw p95 22.49 ms with LF endings and 98.19 ms with CRLF,
  // against a 16.7 ms budget, because a close that follows an edit re-reads and
  // re-normalises every byte of every open document.
  //
  // The comparison belongs to the EDIT, not to the close. It is made once, at
  // the moment the text changes, and shutdown then reads one boolean per tab.
  //
  // `content` and `originalContent` are ACCESSORS for that reason, and not by
  // convention: this file, renderer.js, the suites and the benchmark all assign
  // them directly (`tab.content = x`), so an update rule that had to be invoked
  // by hand would be one refactor away from a stale flag - and a stale flag
  // here reads as "nothing unsaved" and throws the document away. There is no
  // path that can move the text without passing through these setters.
  //
  // renderer.js's own `hasUnsavedChanges` is not usable for this: exiting edit
  // mode leaves the flag and its indicator element set, so reading it bleeds
  // one tab's dirty state onto the next.
  const documentState = new WeakMap();
  let shutdownFreeze = null;
  let frozenMutationAttemptCount = 0;
  const frozenMutationAttemptsBySource = new Map();
  const frozenMutationAttemptsByCategory = new Map();
  // Phase-two freeze blocks document adoption, not delivery. IPC replies are
  // one-shot, so park them in arrival order and run their normal validators
  // again only after a genuine thaw.
  const frozenDocumentOperations = [];
  let frozenDocumentOperationDeferCount = 0;
  let frozenDocumentOperationReplayCount = 0;

  function isDocumentFrozen() {
    return shutdownFreeze !== null;
  }

  function mutationCategory(source) {
    const text = typeof source === "string" ? source : "unknown";
    const separator = text.indexOf(":");
    if (separator >= 0) return text.slice(0, separator);
    const dash = text.indexOf("-");
    return dash < 0 ? text : text.slice(0, dash);
  }

  function mayMutateDocument(source = "unknown") {
    if (!isDocumentFrozen()) return true;
    frozenMutationAttemptCount += 1;
    frozenMutationAttemptsBySource.set(
      source,
      (frozenMutationAttemptsBySource.get(source) || 0) + 1,
    );
    const category = mutationCategory(source);
    frozenMutationAttemptsByCategory.set(
      category,
      (frozenMutationAttemptsByCategory.get(category) || 0) + 1,
    );
    shutdownFreeze.adoptionsRefused += 1;
    return false;
  }

  function deferFrozenDocumentOperation(source, replay) {
    if (!isDocumentFrozen()) return false;
    mayMutateDocument(source);
    frozenDocumentOperations.push({ source, replay });
    frozenDocumentOperationDeferCount += 1;
    return true;
  }

  function replayFrozenDocumentOperations() {
    if (isDocumentFrozen() || frozenDocumentOperations.length === 0) return;
    const pending = frozenDocumentOperations.splice(0);
    for (let index = 0; index < pending.length; index += 1) {
      if (isDocumentFrozen()) {
        frozenDocumentOperations.unshift(...pending.slice(index));
        return;
      }
      const operation = pending[index];
      try {
        operation.replay();
        frozenDocumentOperationReplayCount += 1;
      } catch (error) {
        console.error(
          `[CustomTabs] Deferred ${operation.source} replay failed:`,
          error,
        );
      }
    }
  }

  function defineDocumentAccessors(tab, content) {
    const state = {
      content: content,
      originalContent: content,
      dirty: false,
      // The live document this tab's fold last looked at. See
      // snapshotActiveTab(): it is what tells a reader's edit apart from a
      // value written straight into the cache behind the renderer's back.
      foldedLive: content,
      // A reload result was refused because the document or request identity
      // moved after send. Even if the current bytes happen to equal the old
      // disk baseline, the rejected disk read is not authority to call them
      // clean; only a later accepted reload or save clears this witness.
      reloadConflict: false,
      // Physical identity adopted for this path spelling. It is deliberately
      // stable across ordinary lookups so retargeting a symlink cannot make an
      // in-flight save/reload reply address another tab.
      pathKey: null,
    };
    documentState.set(tab, state);
    Object.defineProperty(tab, "content", {
      get() {
        return state.content;
      },
      set(value) {
        if (!mayMutateDocument("tab:content-setter")) return;
        state.content = value;
        state.dirty = !sameDocument(value, state.originalContent);
        bumpDocumentRevision();
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(tab, "originalContent", {
      get() {
        return state.originalContent;
      },
      set(value) {
        if (!mayMutateDocument("tab:original-content-setter")) return;
        state.originalContent = value;
        state.dirty = !sameDocument(state.content, value);
        bumpDocumentRevision();
      },
      enumerable: true,
      configurable: true,
    });
    return state;
  }

  // THE REVISION IS WHAT MAKES CONSENT SPECIFIC. An approval is an answer about
  // a document state, and between the answer and the act there is a gap - main
  // defers the continuation to a fresh turn of the loop, and the reader can type
  // in it. Comparing the document GENERATION cannot see that: the same document
  // with new text in it is the same generation. This counter moves on every
  // mutation, so an approval can name the exact state it was given about and the
  // commit below can refuse to act on a stale one.
  let documentRevision = 0;

  function bumpDocumentRevision() {
    documentRevision += 1;
  }

  // Both halves at once, and no comparison at all: the caller is stating that
  // this text IS the document as it now stands on disk. Every "the tab is clean
  // again" site uses it - a disk refresh, a completed save, a reload takeover -
  // because assigning the two properties in sequence compares the new text
  // against the OLD original in between, which is a full document scan whose
  // answer is discarded by the very next line.
  function setCleanDocument(tab, content) {
    if (!mayMutateDocument("tab:set-clean-document")) return false;
    const state = documentState.get(tab);
    if (!state) {
      tab.originalContent = content;
      tab.content = content;
      return true;
    }
    state.content = content;
    state.originalContent = content;
    state.dirty = false;
    state.foldedLive = content;
    state.reloadConflict = false;
    bumpDocumentRevision();
    return true;
  }

  function isDirty(tab) {
    const state = documentState.get(tab);
    // A tab this module did not build carries no maintained answer. Compute it
    // rather than report clean: an unknown document is never "nothing to lose".
    if (!state) return !sameDocument(tab.content, tab.originalContent);
    return state.dirty || state.reloadConflict;
  }

  // WHICH MODE THE APP IS IN IS A DOM FACT, NOT A REMEMBERED ONE. This used to
  // read `window.isEditMode`, a shadow copy that a click listener refreshed on a
  // 10 ms timer. The real transition is not bounded by 10 ms: leaving edit mode
  // can await an in-flight save for up to five seconds, so the timer sampled the
  // OLD state, wrote it down, and never looked again. The window then sat in
  // view mode with the shadow still saying "edit", and every fold below took the
  // edit-mode branch - reading a hidden textarea holding pre-exit text, and
  // missing every view-mode edit made afterwards. That is silent data loss with
  // a five-second fuse.
  //
  // `.content-wrapper.split-view` is toggled inside renderer.js's
  // `toggleEditMode()` in the same synchronous statement that flips its own
  // `isEditMode`, so it is the authoritative state and it can never be stale.
  // The shadow is consulted only where no wrapper exists at all - a headless or
  // foreign DOM - which is also what lets a suite drive this without a layout.
  function inEditMode() {
    const wrapper =
      typeof document !== "undefined" && document.querySelector
        ? document.querySelector(".content-wrapper")
        : null;
    if (wrapper) return wrapper.classList.contains("split-view");
    return !!window.isEditMode;
  }

  // The document as the user currently has it. In edit mode the textarea is
  // authoritative (it holds keystrokes renderer has not folded back into
  // `originalMarkdown` yet); in view mode renderer's `originalMarkdown` is.
  function liveDocument() {
    return inEditMode() && window.markdownEditor
      ? window.markdownEditor.value
      : window.originalMarkdown;
  }

  // Content and fold witness move together. A site that puts a value into the
  // cache AND knows the live document now holds that same value must say so in
  // ONE step: leaving the witness behind makes the next fold believe the live
  // copy has not moved, so an undo back to the witness's value is skipped and
  // the abandoned text survives - the resurrection defect, re-entered through a
  // different door.
  function adoptDocumentContent(tab, content) {
    if (!mayMutateDocument("tab:adopt-document-content")) return false;
    tab.content = content;
    const state = documentState.get(tab);
    if (state) state.foldedLive = content;
    return true;
  }

  function diskVersionFromStats(stats) {
    return Object.freeze({
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    });
  }

  function normaliseDiskVersion(value) {
    if (
      !value ||
      !Number.isFinite(value.dev) ||
      !Number.isFinite(value.ino) ||
      !Number.isFinite(value.size) ||
      !Number.isFinite(value.mtimeMs) ||
      !Number.isFinite(value.ctimeMs)
    ) {
      return null;
    }
    return Object.freeze({
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
    });
  }

  function sameDiskVersion(left, right) {
    return !!(
      left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
    );
  }

  function getDiskVersion(filePath) {
    try {
      return window.fs
        ? diskVersionFromStats(window.fs.statSync(filePath))
        : null;
    } catch (error) {
      return null;
    }
  }

  function getMtime(filePath) {
    const version = getDiskVersion(filePath);
    return version ? version.mtimeMs : null;
  }

  function diskVersionForAdoption(filePath, modifiedTime, suppliedVersion) {
    const supplied = normaliseDiskVersion(suppliedVersion);
    if (
      supplied &&
      (!Number.isFinite(modifiedTime) || supplied.mtimeMs === modifiedTime)
    ) {
      return supplied;
    }
    const current = getDiskVersion(filePath);
    if (
      current &&
      (!Number.isFinite(modifiedTime) || current.mtimeMs === modifiedTime)
    ) {
      return current;
    }
    return null;
  }

  // Reading a file in the renderer must produce byte-identical text to
  // main.js's `readMarkdownFile()` (file-helpers.js), otherwise a tab read here
  // disagrees with the same tab opened through the normal IPC path. That
  // matters for .mmd/.mermaid/.ow files, which main wraps in a fenced block:
  // read raw, the fence is lost and the diagram source is rendered as plain
  // text. Three overlay paths read from disk directly - auto-refresh on tab
  // switch, session restore, and multi-file open - so all three were affected.
  //
  // Require the real helper rather than re-implementing it - the two copies
  // would drift on the next upstream change to the wrapping rules.
  // (nodeIntegration is on, and file-helpers.js only pulls in fs/path.)
  let fileHelpers = null;
  try {
    fileHelpers = require("./file-helpers");
  } catch (error) {
    console.error(
      "[CustomTabs] file-helpers unavailable; falling back to raw reads:",
      error,
    );
  }

  function normaliseFileContent(content, filePath) {
    if (!fileHelpers) {
      return content && content.charCodeAt(0) === 0xfeff
        ? content.substring(1)
        : content;
    }
    let result = fileHelpers.removeBOM(content);
    result = fileHelpers.wrapMermaidContent(result, filePath);
    return result;
  }

  function readFromDisk(filePath) {
    return normaliseFileContent(
      window.fs.readFileSync(filePath, "utf8"),
      filePath,
    );
  }

  function readStableDiskSnapshot(filePath) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = diskVersionFromStats(window.fs.statSync(filePath));
      const content = readFromDisk(filePath);
      const after = diskVersionFromStats(window.fs.statSync(filePath));
      if (sameDiskVersion(before, after)) {
        return Object.freeze({
          content,
          modifiedTime: after.mtimeMs,
          diskVersion: after,
        });
      }
    }
    throw new Error(`File changed repeatedly while being read: ${filePath}`);
  }

  // renderer.js owns the toast DOM and the string table. Reuse both when
  // available so overlay messages come from the same source as the toolbar's
  // own labels, and fall back to the inline literal rather than throwing if
  // either is missing. Note for the dead-string sweep in test-packaging.js:
  // keys reached only through this wrapper are NOT written as i18n('...'),
  // so the sweep matches t('...') as well.
  function t(key, fallback, params) {
    return typeof window.i18n === "function"
      ? window.i18n(key, params)
      : fallback;
  }

  function notify(message, duration = 3000) {
    const toast = document.getElementById("notificationToast");
    const messageEl = document.getElementById("notificationMessage");
    if (!toast || !messageEl) return;
    messageEl.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), duration);
  }

  // The actionable "File Updated / Reload / Dismiss" toast (#fileUpdateToast)
  // is bound to whatever renderer.js currently has in currentFilePath. Once we
  // have auto-reloaded that document, or moved to a different one, the prompt
  // is stale: clicking Reload would either be a redundant round-trip or act on
  // the wrong file. Take it down in both cases.
  function dismissUpdatePrompt() {
    if (typeof window.dismissFileUpdateNotification === "function") {
      window.dismissFileUpdateNotification();
      return;
    }
    // renderer.js stopped exporting the resetter. We can hide the toast, but
    // its module-private `fileUpdateNotificationShown` flag stays true, so the
    // next external change is silently swallowed for up to 10s. Warn loudly
    // rather than pretend this worked.
    console.error(
      "[CustomTabs] window.dismissFileUpdateNotification is missing - " +
        "update prompts will be suppressed until renderer's timer expires. " +
        "Re-add the export in renderer.js (see docs/CUSTOMIZATIONS.md).",
    );
    const toast = document.getElementById("fileUpdateToast");
    if (toast) toast.classList.remove("show");
  }

  // ============================================
  // Scroll Position Preservation
  // ============================================

  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

  // Returns `element`'s top in the SCROLLER'S OWN coordinate space, i.e. the
  // same space as `scroller.scrollTop`, so the two can be added and compared.
  //
  // The division is not decoration. getBoundingClientRect() reports VIEWPORT
  // pixels even for an element inside (or carrying) a CSS `zoom`, while
  // scrollTop, clientHeight and scrollHeight are all in the scroller's own
  // pre-zoom pixels. In normal view the scroller is .content-wrapper, which is
  // outside the zoom renderer.js applies to #viewer, so the two spaces coincide
  // and the ratio is 1. In split view the scroller IS #viewer, so at 200% every
  // rect delta is twice the scrollTop it was being added to - measured directly,
  // not inferred: moving scrollTop by 300 moved the rect delta by 600.
  //
  // The ratio is derived from the scroller itself rather than read off
  // `getComputedStyle(...).zoom`, so it needs no assumption about which metrics
  // report in which space and keeps working if the scale ever arrives by some
  // other route. Borders are added back because rect.height is a border-box
  // measurement while clientHeight is padding-box.
  //
  // Delegates to renderer.js's scrollerScale() when it is present, for the same
  // reason getScroller() delegates to getViewerScroller(): the zoom
  // reading-position anchor needs the identical conversion, and two copies of
  // it are two copies that can silently disagree. The body below is kept as the
  // fallback for the case where this overlay loads without the renderer.
  function scrollerScale(scroller) {
    if (typeof window.scrollerScale === "function" && window.scrollerScale !== scrollerScale) {
      return window.scrollerScale(scroller);
    }
    const cs = getComputedStyle(scroller);
    const borders =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const local = scroller.clientHeight + borders;
    if (!local) return 1;
    const scale = scroller.getBoundingClientRect().height / local;
    return scale > 0 ? scale : 1;
  }

  function offsetWithin(scroller, element) {
    return (
      (element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top) /
        scrollerScale(scroller) +
      scroller.scrollTop
    );
  }

  // Position is remembered as "the Nth heading with this text, plus a pixel
  // delta". A raw pixel offset is wrong after a re-render because the content
  // above the viewport usually changed too - which is exactly the refresh case.
  function captureAnchor() {
    const scroller = getScroller();
    if (!scroller) return null;

    const anchor = {
      scrollTop: scroller.scrollTop,
      text: null,
      ordinal: 0,
      delta: 0,
    };

    const viewerEl = document.getElementById("viewer");
    if (!viewerEl) return anchor;

    const headings = Array.from(viewerEl.querySelectorAll(HEADING_SELECTOR));
    let anchorHeading = null;
    for (const heading of headings) {
      if (offsetWithin(scroller, heading) <= scroller.scrollTop + 1) {
        anchorHeading = heading;
      } else {
        break;
      }
    }
    if (!anchorHeading) return anchor;

    const text = (anchorHeading.textContent || "").trim();
    if (!text) return anchor;

    anchor.text = text;
    anchor.ordinal = headings
      .filter((h) => (h.textContent || "").trim() === text)
      .indexOf(anchorHeading);
    anchor.delta = scroller.scrollTop - offsetWithin(scroller, anchorHeading);
    return anchor;
  }

  function resolveAnchorTop(anchor) {
    const scroller = getScroller();
    if (!scroller || !anchor) return null;
    if (!anchor.text) return anchor.scrollTop;

    const viewerEl = document.getElementById("viewer");
    if (!viewerEl) return anchor.scrollTop;

    const matches = Array.from(
      viewerEl.querySelectorAll(HEADING_SELECTOR),
    ).filter((h) => (h.textContent || "").trim() === anchor.text);

    const target = matches[anchor.ordinal] || matches[0];
    if (!target) return anchor.scrollTop;
    return offsetWithin(scroller, target) + anchor.delta;
  }

  // Only one restore may be in flight. A superseded restore (rapid tab
  // switching) would otherwise keep dragging the new tab to the old anchor for
  // the length of its observer window.
  let cancelActiveRestore = null;

  function restorePosition(anchor) {
    if (cancelActiveRestore) {
      cancelActiveRestore();
      cancelActiveRestore = null;
    }
    if (!anchor) return;

    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      if (!mayMutateDocument("render:restore-observer")) {
        cancelled = true;
        if (cancelActiveRestore) {
          const cancel = cancelActiveRestore;
          cancelActiveRestore = null;
          cancel();
        }
        return;
      }
      const scroller = getScroller();
      const top = resolveAnchorTop(anchor);
      if (scroller && top !== null) {
        scroller.scrollTop = Math.max(0, top);
      }
    };

    apply();
    requestAnimationFrame(apply);

    // Diagrams (mermaid/d2), images and syntax highlighting settle after
    // renderMarkdown() resolves and change the document height, which shifts
    // the anchor. Keep re-applying while the document is still growing, but
    // only for a bounded window and only until the user takes over.
    const viewerEl = document.getElementById("viewer");
    if (!viewerEl || typeof ResizeObserver === "undefined") {
      const timer = setTimeout(apply, 250);
      cancelActiveRestore = () => {
        cancelled = true;
        clearTimeout(timer);
      };
      return;
    }

    const scroller = getScroller();
    const observer = new ResizeObserver(apply);
    observer.observe(viewerEl);

    const dispose = () => {
      cancelled = true;
      observer.disconnect();
      if (scroller) {
        scroller.removeEventListener("wheel", dispose);
        scroller.removeEventListener("mousedown", dispose);
      }
      document.removeEventListener("keydown", dispose);
      clearTimeout(timer);
      if (cancelActiveRestore === dispose) {
        cancelActiveRestore = null;
      }
    };

    if (scroller) {
      scroller.addEventListener("wheel", dispose, { passive: true });
      scroller.addEventListener("mousedown", dispose);
    }
    document.addEventListener("keydown", dispose);

    const timer = setTimeout(dispose, 1200);
    cancelActiveRestore = dispose;
  }

  function positionOf(tab) {
    return (
      tab.anchor || {
        scrollTop: tab.scrollPosition || 0,
        text: null,
        ordinal: 0,
        delta: 0,
      }
    );
  }

  // ============================================
  // Disk Synchronisation
  // ============================================

  // Pull newer content off disk into the tab's cache. Returns true when the
  // cached copy was replaced.
  function refreshTabFromDisk(tab) {
    if (!tab || !window.fs) return false;
    // Never discard edits the user has not saved yet.
    if (tab.hasUnsavedChanges) return false;
    const adoptedPath = tabPathKey(tab);
    const currentPath = resolveTabPath(tab.filePath);
    if (adoptedPath && currentPath && adoptedPath !== currentPath) {
      // A symlink spelling still belongs to the physical document this tab
      // adopted. Only an accepted reload/reopen may move that binding.
      return false;
    }

    const observedVersion = getDiskVersion(tab.filePath);
    if (!observedVersion) return false; // missing or unreadable - keep the cache
    if (sameDiskVersion(tab.diskVersion, observedVersion)) return false;

    try {
      const snapshot = readStableDiskSnapshot(tab.filePath);
      setCleanDocument(tab, snapshot.content);
      tab.mtimeMs = snapshot.modifiedTime;
      tab.diskVersion = snapshot.diskVersion;
      console.log("[CustomTabs] Reloaded from disk:", tab.filename);
      return true;
    } catch (error) {
      console.error("[CustomTabs] Failed to reload:", tab.filePath, error);
      return false;
    }
  }

  // ============================================
  // Tab Management Functions
  // ============================================

  /**
   * @param {string} filePath
   * @param {string} content
   * @param {{
   *   activate?: boolean,
   *   confirmed?: boolean,
   *   modifiedTime?: number,
   *   diskVersion?: object
   * }} [options]
   *   activate  - false for BATCH creation (session restore, the trailing
   *               files of a multi-select). Creating a tab used to switch to
   *               it unconditionally, so restoring four tabs rendered four
   *               documents and only the last was ever seen - measured at 5
   *               renders for 4 tabs - and asked the large-document question
   *               once per expensive file before the app was usable.
   *   confirmed - the cost of this document has ALREADY been accepted, so the
   *               per-tab guard must not ask again. main.js runs
   *               confirmLargeDocument() before it emits `file-opened`, and
   *               without this the reader answered the identical dialog twice
   *               for a single open (measured).
   */
  function createTab(filePath, content, options) {
    if (!mayMutateDocument("tab:create")) return null;
    const opts = options || {};
    const tabId = ++tabIdCounter;
    const pathParts = filePath.split(/[\\/]/);
    const filename = pathParts[pathParts.length - 1];

    const diskVersion = diskVersionForAdoption(
      filePath,
      opts.modifiedTime,
      opts.diskVersion,
    );
    const tab = {
      id: tabId,
      filePath: filePath,
      filename: filename,
      hasUnsavedChanges: false,
      scrollPosition: 0,
      anchor: null,
      mtimeMs: Number.isFinite(opts.modifiedTime)
        ? opts.modifiedTime
        : diskVersion
          ? diskVersion.mtimeMs
          : null,
      diskVersion,
    };
    // `content` and `originalContent` are installed as accessors rather than
    // written as plain fields, so that every later assignment - from anywhere -
    // keeps the maintained dirty answer in step. See defineDocumentAccessors.
    const state = defineDocumentAccessors(tab, content);
    state.pathKey = canonicalTabPath(filePath);

    tabs.push(tab);
    console.log(
      "[CustomTabs] Created tab:",
      filename,
      "Total tabs:",
      tabs.length,
    );
    // Must precede the switch below, or the switch asks a question main.js has
    // already had answered.
    if (opts.confirmed) largeConfirmed.add(tabId);
    renderTabs();
    if (opts.activate !== false) switchToTab(tabId);
    saveTabs();

    return tab;
  }

  function renderTabs() {
    console.log("[CustomTabs] Rendering tabs, count:", tabs.length);

    if (tabs.length === 0) {
      tabsContainer.style.display = "none";
      return;
    }

    // A lone document is still a tab.
    //
    // This used to swap between the tab strip and the file-info bar on a
    // `tabs.length >= 2` test, so opening one file showed a path bar and no
    // tab at all - the tab only appeared once a second file arrived. The bar
    // is gone and the strip is now the single place a document is named, so
    // there is one presentation for every count.
    tabsContainer.style.display = "flex";

    // Clear and rebuild tabs
    tabsElement.innerHTML = "";

    tabs.forEach((tab) => {
      const tabElement = document.createElement("div");
      tabElement.className = "tab" + (tab.id === activeTabId ? " active" : "");
      tabElement.dataset.tabId = tab.id;
      // The whole tab carries the location, not just the label: the label is
      // narrower than the tab and stops at the ellipsis, so hovering the
      // padding, the unsaved dot or the gap next to the close button used to
      // produce no tooltip at all.
      tabElement.title = tab.filePath;

      const titleSpan = document.createElement("span");
      titleSpan.className = "tab-title";
      titleSpan.textContent = tab.filename;
      titleSpan.title = tab.filePath;

      const closeButton = document.createElement("span");
      closeButton.className = "tab-close";
      closeButton.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="12" y2="12"></line><line x1="12" y1="4" x2="4" y2="12"></line></svg>';
      closeButton.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });

      tabElement.appendChild(titleSpan);

      if (tab.hasUnsavedChanges) {
        const unsavedDot = document.createElement("span");
        unsavedDot.className = "tab-unsaved";
        tabElement.appendChild(unsavedDot);
      }

      tabElement.appendChild(closeButton);

      tabElement.addEventListener("click", () => {
        switchToTab(tab.id);
      });

      tabElement.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, tab.filePath);
      });

      tabsElement.appendChild(tabElement);
    });

    // Keep the active tab reachable. The strip scrolls horizontally once the
    // tabs outgrow it, and nothing else moves it, so opening or switching to a
    // document whose tab sits past the right edge left the reader looking at a
    // strip in which the document they are reading is not visible at all.
    const activeEl = tabsElement.querySelector(".tab.active");
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  // Fold whatever the renderer currently holds back into the tab record.
  // Must run before anything trusts tab.content / tab.hasUnsavedChanges.
  function snapshotActiveTab({ capturePosition = true } = {}) {
    if (!activeTabId) return null;
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (!currentTab) return null;
    if (!mayMutateDocument("snapshot:active-tab")) return currentTab;

    if (capturePosition) {
      const scroller = getScroller();
      if (scroller) {
        currentTab.scrollPosition = scroller.scrollTop;
      }
      currentTab.anchor = captureAnchor();
    }

    if (inEditMode() && window.markdownEditor) {
      // Only adopt the editor's text if it is a real edit. If it differs from
      // the cached copy solely by the newline normalisation the textarea
      // applied when switchToTab assigned it, keeping the cached copy
      // preserves the file's original CRLF endings instead of silently
      // rewriting the document to LF.
      const edited = window.markdownEditor.value;
      if (!sameDocument(edited, currentTab.content)) {
        currentTab.content = edited;
      }
    } else if (typeof window.originalMarkdown === "string") {
      // View-mode edits (tables, checkboxes, notes) are applied by
      // renderer.js to originalMarkdown rather than to the editor.
      //
      // WHICH SIDE MOVED IS THE WHOLE QUESTION, and no pair of values can
      // answer it. Two entirely different situations produce the identical
      // state `live === originalContent && content !== originalContent`:
      //
      //   1. The reader made a view-mode edit and then UNDID it. The live
      //      document is back at the file's text while the cache still holds
      //      the abandoned edit, so the cache must follow - otherwise the tab
      //      goes on holding text the reader discarded, reports itself dirty
      //      about it, and hands it to the next switchToTab and to save.
      //   2. Something wrote straight into `tab.content` without going through
      //      the renderer - a reload takeover, a completed background save, a
      //      test seam - so the CACHE is the newer copy. Folding here reverts
      //      that write, and the tab then reads clean and is clobbered by the
      //      next disk refresh. (Measured: `unsaved edits survive an on-disk
      //      change`, `edit base matches the rendered (unsaved) content on a
      //      dirty tab` and `sequential view-mode edits both survive a tab
      //      round-trip` all fail that way.)
      //
      // Comparing the live copy against the cache cannot separate them, and
      // comparing it against the file cannot either: both are the same in both
      // cases. What separates them is whether the LIVE document has moved since
      // this fold last looked at it - the one fact neither value records, so it
      // is recorded here.
      //
      // The witness is compared with `!==`, not sameDocument: both sides come
      // from window.originalMarkdown, so any change the renderer made is a
      // move, and a newline-only difference between them is still caught by the
      // sameDocument test below before anything is adopted. It is also the
      // cheap comparison, which matters because this runs on the close path.
      const live = window.originalMarkdown;
      const state = documentState.get(currentTab);
      // A COMMITTED FREEZE IS THE LAST WORD ON THIS DOCUMENT. The reader's
      // consent was taken against a revision and confirmed against it; adopting
      // anything after that would put text into the cache that the consent was
      // not about, on a document that is on its way out. Refusals are counted
      // rather than silent, so a test can see the attempt, and the freeze is
      // released on every path that leaves the app running - after which the
      // next fold adopts normally, so nothing is lost by refusing here.
      if (shutdownFreeze) {
        shutdownFreeze.adoptionsRefused += 1;
      } else {
        const liveMoved = !state || live !== state.foldedLive;
        if (liveMoved && !sameDocument(live, currentTab.content)) {
          // Equal to the file except for line endings: keep the file's own bytes
          // rather than the renderer's normalised copy, so a CRLF document that
          // has been edited and undone is byte-for-byte its original again
          // instead of being silently rewritten to LF.
          currentTab.content = sameDocument(live, currentTab.originalContent)
            ? currentTab.originalContent
            : live;
        }
        if (state) state.foldedLive = live;
      }
    }
    currentTab.hasUnsavedChanges = isDirty(currentTab);
    return currentTab;
  }

  // Bumped on every switch so a superseded render's .then() cannot drag the
  // newly active tab to the previous tab's anchor.
  let renderGeneration = 0;

  // Tabs whose cost the reader has already accepted. A document is expensive
  // once; asking again every time the tab is revisited would be the same
  // mistake as guarding the refresh path.
  const largeConfirmed = new Set();

  /**
   * Rendering is the expensive step, and tabs render lazily - createTab() only
   * stores the text, switchToTab() is what pays for it. So a file that arrived
   * through multi-select or a restored session has never passed the open-time
   * guard in main.js, and clicking its tab is the first moment the cost is
   * real. This is that guard, at the point where the work actually happens.
   *
   * @param {object} tab
   * @param {boolean} silent - true on a BATCH path (session restore), where a
   *   modal is wrong: the reader did not ask for anything, the dialog appears
   *   before the app is usable, and there is one per expensive file. The
   *   document is restored anyway - it is the one they were reading when they
   *   closed the app - and the cost is reported passively instead.
   * @returns {boolean} true if the switch should proceed
   */
  function confirmLargeTab(tab, silent) {
    if (!fileHelpers || typeof fileHelpers.isLargeDocument !== "function") return true;
    if (largeConfirmed.has(tab.id)) return true;

    let verdict;
    try {
      verdict = fileHelpers.isLargeDocument(tab.content);
    } catch (error) {
      // A guard that throws must not make a tab unreachable.
      console.error("[CustomTabs] size estimate failed:", error);
      return true;
    }
    if (!verdict.large) return true;

    const seconds = Math.round(verdict.estimatedMs / 1000);

    if (silent) {
      // Rendering it is the point, so record the acceptance: being asked later
      // about a document already on screen would be nonsense.
      largeConfirmed.add(tab.id);
      notify(
        t(
          "notif.largeDocumentRestored",
          `"${tab.filename}" is large - it may take about ${seconds}s to display`,
          { name: tab.filename, seconds: seconds },
        ),
        6000,
      );
      return true;
    }

    let proceed = true;
    try {
      proceed = window.ipcRenderer.sendSync("confirm-large-render", {
        name: tab.filename,
        seconds: seconds,
      });
    } catch (error) {
      console.error("[CustomTabs] size confirmation failed:", error);
      return true;
    }
    if (proceed) largeConfirmed.add(tab.id);
    return proceed;
  }

  /**
   * @param {number} tabId
   * @param {{
   *   silent?: boolean,
   *   skipSnapshot?: boolean,
   *   fileOpenData?: object,
   *   fileOpenLifecycleOptions?: object,
   *   fileOpenOptions?: object
   * }} [options] - silent suppresses the large-document MODAL only (see
   *   confirmLargeTab). fileOpenData marks an accepted main-process open whose
   *   renderer lifecycle must record navigation/recents exactly once.
   */
  function switchToTab(tabId, options) {
    if (!mayMutateDocument("tab:switch")) return;
    const opts = options || {};
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tabId !== activeTabId && !confirmLargeTab(tab, opts.silent)) {
      // Declining means the switch does not happen: the reader stays where
      // they were, with the document they were reading still on screen. This
      // runs BEFORE snapshotActiveTab() and before any state is mutated, so
      // there is nothing to unwind.
      console.log("[CustomTabs] Large tab switch declined:", tab.filename);
      return;
    }
    if (
      !opts.fileOpenData &&
      typeof window.cancelPendingNavigation === "function"
    ) {
      // beginFileOpen below immediately asserts this tab's watcher ownership;
      // reasserting the old document first would send a conflicting IPC pair.
      window.cancelPendingNavigation("superseded-by-tab-switch");
    }

    if (!opts.skipSnapshot) snapshotActiveTab();

    // The file may have been rewritten while this tab sat in the background.
    // Pick that up now so switching never repaints a stale copy.
    const autoReloaded = opts.fileOpenData ? false : refreshTabFromDisk(tab);

    // Renderer owns the canonical synchronous document transition. Direct tab
    // switches deliberately skip open-history/recents; a main file-open keeps
    // those enabled. In both cases history is cleared, renderer stores and
    // edit baseline move together, and the returned sequence owns completion.
    let fileOpenContext = null;
    if (
      typeof window.beginFileOpen === "function" &&
      typeof window.completeFileOpen === "function"
    ) {
      const lifecycleData = opts.fileOpenData
        ? { ...opts.fileOpenData, path: tab.filePath, content: tab.content }
        : {
            path: tab.filePath,
            content: tab.content,
            allPaths: null,
            modifiedTime: tab.mtimeMs,
            diskVersion: tab.diskVersion,
          };
      fileOpenContext = window.beginFileOpen(lifecycleData, {
        source: opts.fileOpenData ? "ipc-file-opened" : "tab-switch",
        recordNavigation: !!opts.fileOpenData,
        recordRecents: !!opts.fileOpenData,
        normalScroll: "caller",
        clearFailedSave:
          !!opts.fileOpenData && !tab.hasUnsavedChanges,
        preserveEditBaseline: !opts.fileOpenData,
        hasUnsavedChanges: tab.hasUnsavedChanges,
        trackingActive: !tab.hasUnsavedChanges,
        ...(opts.fileOpenLifecycleOptions || {}),
        ...(opts.fileOpenOptions || {}),
      });
      if (!fileOpenContext) return;
    }

    activeTabId = tabId;
    console.log("[CustomTabs] Switched to tab:", tab.filename);

    // Any pending "File Updated - Reload?" prompt belongs to the tab we just
    // left, or to this tab's pre-reload state. Either way it is now stale.
    dismissUpdatePrompt();
    if (autoReloaded) {
      // Passive confirmation: the reload already happened, so asking the user
      // to trigger one would be noise.
      notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
    }

    // Update UI
    renderTabs();

    // Legacy fallback only. Normal production uses beginFileOpen above, which
    // moves these stores once before the visual render.
    // This must be tab.content, not tab.originalContent: renderer.js applies
    // view-mode edits (notes, tables, checkboxes) as incremental string splices
    // on originalMarkdown. Seeding it with the on-disk copy while rendering the
    // edited copy makes the next splice build on the wrong base and silently
    // drop every earlier unsaved edit. When the tab is clean the two are equal.
    if (!fileOpenContext) {
      if (window.updateFileInfo) {
        window.updateFileInfo(tab.filePath);
      }
      window.currentFilePath = tab.filePath;
      if (window.originalMarkdown !== undefined) {
        window.originalMarkdown = tab.content;
      }
    }
    // The fold's witness moves with the document that is going on screen. From
    // here on, any difference between window.originalMarkdown and this value is
    // an edit the reader made - not a cache that was written behind the
    // renderer's back. Set unconditionally: renderer.js may not have published
    // originalMarkdown yet, but this tab's text is still what it is about to
    // show. See snapshotActiveTab().
    const switchedState = documentState.get(tab);
    if (switchedState) switchedState.foldedLive = tab.content;

    // Render content
    if (window.renderMarkdown) {
      const position = positionOf(tab);
      const generation = ++renderGeneration;
      window.renderMarkdown(tab.content).then(() => {
        const restore = () => {
          if (
            generation === renderGeneration &&
            mayMutateDocument("render:restore-position")
          ) {
            restorePosition(position);
          }
        };
        if (fileOpenContext) {
          window.completeFileOpen(fileOpenContext, restore);
        } else {
          restore();
        }
      });
    }

    if (!fileOpenContext) {
      // Update editor if in edit mode
      if (inEditMode() && window.markdownEditor) {
        window.markdownEditor.value = tab.content;
      }

    // Exiting edit mode discards the session by restoring the document and
    // history captured when the session began. Switching tabs changes WHICH
    // document that is, so the baseline has to move with it - otherwise a
    // discard here would write the previously active tab's text over this one.
    //
    // This MUST run after setUnsavedState below has moved the renderer's dirty
    // flag to this tab's value: the baseline records that flag, and capturing
    // it first would bake the PREVIOUS tab's dirty state into this tab's
    // baseline, so a later discard would restore a dirty indicator for a
    // document with nothing unsaved in it.

    // renderer.js tracks unsaved state in a single global. Restore this tab's
    // value so its refresh / exit-edit guards apply to the right document.
      if (window.setUnsavedState) {
        window.setUnsavedState(tab.hasUnsavedChanges);
      }

      if (inEditMode() && window.rebaseEditSession) {
        window.rebaseEditSession();
      }
    }

    // beginFileOpen normally asserted both document ownership and watcher
    // intent at the same synchronous boundary. Keep only a compatibility path
    // here so legacy renderer builds do not send a second, conflicting pair.
    if (!fileOpenContext && window.ipcRenderer) {
      if (typeof window.assertFileTrackingOwnership === "function") {
        window.assertFileTrackingOwnership(
          tab.filePath,
          !tab.hasUnsavedChanges,
          {
            adoptBaseline: !tab.hasUnsavedChanges,
            modifiedTime: tab.mtimeMs,
            diskVersion: tab.diskVersion,
          },
        );
      } else if (tab.hasUnsavedChanges) {
        window.ipcRenderer.send("pause-file-watching");
        window.ipcRenderer.send("set-active-file", tab.filePath);
      } else {
        window.ipcRenderer.send("set-active-file", tab.filePath);
        window.ipcRenderer.send("resume-file-watching");
      }
    }

    saveTabs();
  }

  const closingTabs = new Set();

  async function closeTab(tabId) {
    if (!mayMutateDocument("tab:close")) return;
    if (closingTabs.has(tabId)) return;
    closingTabs.add(tabId);
    try {
      let tabIndex = tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return;
      let tab = tabs[tabIndex];

      // A save belongs to the tab generation that issued it. Do not remove
      // that generation while its write can still land: reopening the same
      // path would otherwise let the old write overwrite the new tab.
      if (typeof window.waitForPendingSaves === "function") {
        await window.waitForPendingSaves(tab.filePath);
      }
      if (!mayMutateDocument("tab:close-after-save")) return;

      // The tab may have moved or been closed through another path while this
      // close was waiting for its save result.
      tabIndex = tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return;
      tab = tabs[tabIndex];

      // The active tab's cached state is only as fresh as the last switch, so
      // fold in the renderer's current state before trusting hasUnsavedChanges.
      if (tab.id === activeTabId) {
        snapshotActiveTab();
      }

      // Check for unsaved changes
      if (tab.hasUnsavedChanges) {
        const userConfirmed = confirm(
          `"${tab.filename}" has unsaved changes. Close anyway?`,
        );
        if (!userConfirmed) return;
      }

      console.log("[CustomTabs] Closing tab:", tab.filename);
      tabs.splice(tabIndex, 1);

      // Switch to another tab if closing active
      if (tab.id === activeTabId) {
        if (tabs.length > 0) {
          const newActiveTab = tabs[Math.max(0, tabIndex - 1)];
          switchToTab(newActiveTab.id);
        } else {
          activeTabId = null;
          // Nothing is open any more. Leaving the watcher armed on the file we
          // just closed makes an external change raise a "reload?" prompt over
          // the welcome screen, for a document that no longer has a tab.
          if (window.ipcRenderer) {
            if (typeof window.stopFileTrackingIntent === "function") {
              window.stopFileTrackingIntent();
            } else {
              window.ipcRenderer.send("stop-file-watching");
            }
          }
          window.currentFilePath = null;
          if (window.setUnsavedState) {
            window.setUnsavedState(false);
          }
          dismissUpdatePrompt();
          if (window.viewer) {
            // Replaces the WHOLE viewer subtree with the welcome screen. A zoom
            // anchor captured against the document being closed cannot describe
            // anything afterwards, so it is stood down. Guarded because this file
            // is an IIFE loaded alongside renderer.js, matching the convention
            // used for window.setUnsavedState above.
            if (window.noteViewerMutation) {
              window.noteViewerMutation();
            }
            window.viewer.innerHTML = `
              <div class="welcome">
                <h1>Welcome to Folia</h1>
                <p>Press <kbd>Ctrl+O</kbd> to open a markdown file</p>
              </div>
            `;
          }
          if (window.updateFileInfo) {
            window.updateFileInfo(null);
          }
        }
      }

      renderTabs();
      saveTabs();
    } finally {
      closingTabs.delete(tabId);
    }
  }

  function updateTabContent(content, hasChanges) {
    if (!mayMutateDocument("tab:update-content")) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) {
      if (hasChanges) {
        // The caller has just put this text into the renderer's live copy as
        // well, so the fold witness moves with it. Without that, an undo back
        // to the witness's old value reads as "the live document has not
        // moved", the fold is skipped, and this content survives the undo.
        adoptDocumentContent(tab, content);
      } else {
        // Stated, not compared: this text has just become the document on
        // disk, so the tab is clean by construction. Assigning `content` and
        // then `originalContent` in sequence would compare the new text
        // against the old original in between, at full document cost, for an
        // answer overwritten one line later.
        setCleanDocument(tab, content);
        // This path is also used when discarding an edit session. `content`
        // then comes from the tab's existing clean baseline, not from a fresh
        // disk read, so re-statting here would pair old bytes with a newer
        // external version and make the next switch skip the needed reload.
      }
      tab.hasUnsavedChanges = hasChanges;
      renderTabs();
      saveTabs();
    }
  }

  function saveTabs() {
    const activeTab = getActiveTab();
    const tabsData = tabs.map((tab) => ({
      filePath: tab.filePath,
      scrollPosition: tab.scrollPosition,
      anchor: tab.anchor,
    }));
    localStorage.setItem("openTabs", JSON.stringify(tabsData));
    // Tab ids are handed out fresh on every startup, so the id alone cannot
    // identify which tab to re-activate after a restart.
    localStorage.setItem("activeTabPath", activeTab ? activeTab.filePath : "");
    console.log("[CustomTabs] Saved tabs to localStorage");
  }

  function loadSavedTabs() {
    try {
      const savedTabs = localStorage.getItem("openTabs");
      const savedActiveTabPath = localStorage.getItem("activeTabPath");

      if (savedTabs) {
        const tabsData = JSON.parse(savedTabs);
        console.log("[CustomTabs] Restoring", tabsData.length, "tabs");

        // Load files directly using fs (available since nodeIntegration: true)
        if (tabsData.length > 0 && window.fs) {
          let restorationRefused = false;
          for (const tabData of tabsData) {
            try {
              if (window.fs.existsSync(tabData.filePath)) {
                const snapshot = readStableDiskSnapshot(tabData.filePath);
                // activate:false - a restore must not switch to every tab it
                // creates. It used to, so restoring N tabs rendered N
                // documents and raised the large-document dialog once per
                // expensive file, all before the window was usable.
                const tab = createTab(tabData.filePath, snapshot.content, {
                  activate: false,
                  modifiedTime: snapshot.modifiedTime,
                  diskVersion: snapshot.diskVersion,
                });
                // A retained shutdown freeze intentionally refuses creation.
                // Stop the batch at the first refusal: every later create
                // would be refused for the same reason, and no restored-tab,
                // active-tab or persisted-session state may move on behalf of
                // a restoration that did not happen.
                if (!tab) {
                  restorationRefused = true;
                  break;
                }
                tab.scrollPosition = tabData.scrollPosition || 0;
                tab.anchor = tabData.anchor || null;
                console.log("[CustomTabs] Restored tab:", tabData.filePath);
              } else {
                console.log(
                  "[CustomTabs] File no longer exists:",
                  tabData.filePath,
                );
              }
            } catch (error) {
              console.error(
                "[CustomTabs] Error restoring tab:",
                tabData.filePath,
                error,
              );
            }
          }

          // Re-activate the tab that was active when the app was closed.
          if (!restorationRefused && tabs.length > 0) {
            const restored =
              (savedActiveTabPath && findTabByPath(savedActiveTabPath)) ||
              tabs[0];
          // The one switch a restore performs. silent:true because the reader
          // did not ask for it: this is the document they left open, so it is
          // restored and its cost reported passively rather than behind a
          // modal that blocks the app before it is even visible.
          switchToTab(restored.id, { silent: true });
          }
        } else {
          console.log("[CustomTabs] No fs module or no tabs to restore");
        }
      } else {
        console.log("[CustomTabs] No saved tabs in localStorage");
      }
    } catch (error) {
      console.error("[CustomTabs] Error loading saved tabs:", error);
    }
  }

  const tabPathAliases = new Map();

  function normaliseTabPath(filePath) {
    if (typeof filePath !== "string" || filePath.length === 0) return null;
    let resolved;
    try {
      const pathApi = window.path || require("path");
      resolved = pathApi.normalize(pathApi.resolve(filePath));
    } catch (error) {
      console.error("[CustomTabs] Failed to resolve document path:", error);
      return null;
    }

    return Object.freeze({
      resolved,
      spelling:
        process.platform === "win32" ? resolved.toLowerCase() : resolved,
    });
  }

  function resolveTabPath(filePath) {
    const normalised = normaliseTabPath(filePath);
    if (!normalised) return null;
    let canonical = normalised.resolved;
    try {
      const fsApi = window.fs || require("fs");
      const realpathSync =
        typeof fsApi.realpathSync.native === "function"
          ? fsApi.realpathSync.native
          : fsApi.realpathSync;
      if (typeof realpathSync === "function") {
        canonical = realpathSync(normalised.resolved);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        console.error("[CustomTabs] Failed to canonicalize document path:", error);
      }
      return null;
    }

    return process.platform === "win32"
      ? canonical.toLowerCase()
      : canonical;
  }

  function canonicalTabPath(filePath) {
    const normalised = normaliseTabPath(filePath);
    if (!normalised) return null;
    if (tabPathAliases.has(normalised.spelling)) {
      return tabPathAliases.get(normalised.spelling);
    }
    const key = resolveTabPath(normalised.resolved) || normalised.spelling;
    tabPathAliases.set(normalised.spelling, key);
    return key;
  }

  function rebindTabPath(filePath) {
    const normalised = normaliseTabPath(filePath);
    if (!normalised) return null;
    const key = resolveTabPath(normalised.resolved) || normalised.spelling;
    tabPathAliases.set(normalised.spelling, key);
    return key;
  }

  function tabPathKey(tab) {
    if (!tab) return null;
    const state = documentState.get(tab);
    return state && state.pathKey
      ? state.pathKey
      : canonicalTabPath(tab.filePath);
  }

  function adoptTabPathIdentity(tab, filePath = tab && tab.filePath) {
    if (!tab || !filePath) return null;
    const key = rebindTabPath(filePath);
    const state = documentState.get(tab);
    if (state) state.pathKey = key;
    return key;
  }

  function findTabByPath(filePath) {
    const exact = tabs.find((tab) => tab.filePath === filePath);
    if (exact) return exact;
    const canonical = canonicalTabPath(filePath);
    return tabs.find(
      (tab) => canonical && tabPathKey(tab) === canonical,
    );
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId);
  }

  // ============================================
  // Intercept file-opened events
  // ============================================

  let cleanReopenAdoptCount = 0;
  let dirtyReopenPreserveCount = 0;
  let staleNavigationOpenDropCount = 0;
  const rendererFileOpenHandler = window.rendererFileOpenHandler;
  const canOwnFileOpen =
    typeof window.beginFileOpen === "function" &&
    typeof window.completeFileOpen === "function" &&
    typeof window.preflightFileOpen === "function" &&
    typeof rendererFileOpenHandler === "function";

  if (window.ipcRenderer) {
    if (!canOwnFileOpen) {
      // Keep renderer's public fallback in control. The wrapper adds only the
      // freeze queue; after thaw it invokes the exact upstream handler once.
      if (typeof rendererFileOpenHandler === "function") {
        window.ipcRenderer.removeListener(
          "file-opened",
          rendererFileOpenHandler,
        );
        const handleCompatibleFileOpened = (event, data) => {
          if (
            deferFrozenDocumentOperation("ipc:file-opened", () =>
              handleCompatibleFileOpened(event, data),
            )
          ) {
            return;
          }
          rendererFileOpenHandler(event, data);
        };
        window.ipcRenderer.on("file-opened", handleCompatibleFileOpened);
      }
      console.error(
        "[CustomTabs] Renderer file-open lifecycle API unavailable; " +
          "keeping the upstream file-open handler in control.",
      );
    } else {
      window.ipcRenderer.removeListener(
        "file-opened",
        rendererFileOpenHandler,
      );

      const handleFileOpened = (event, data) => {
        if (
          deferFrozenDocumentOperation("ipc:file-opened", () =>
            handleFileOpened(event, data),
          )
        ) {
          return;
        }
        if (!mayMutateDocument("ipc:file-opened")) return;
        const preflight = window.preflightFileOpen(data);
        if (!preflight || !preflight.accepted) {
          staleNavigationOpenDropCount += 1;
          return;
        }
        console.log("[CustomTabs] Intercepted file-opened:", data.path);

        const { content, path: filePath, allPaths } = data;
        let targetTab = findTabByPath(filePath);
        const targetWasActive = !!(
          targetTab && targetTab.id === activeTabId
        );
        let preserveCachedDocument = false;

        if (targetTab) {
          if (targetWasActive) snapshotActiveTab();
          preserveCachedDocument = isDirty(targetTab);
          console.log("[CustomTabs] File already open, switching to tab");
          // A dirty or reload-conflicted tab owns bytes not represented by the
          // disk payload and must be preserved. A truly clean tab has no such
          // ownership: atomically adopt the freshly-read content so reopening
          // cannot display or later save a stale cache over a newer file.
          if (preserveCachedDocument) {
            targetTab.hasUnsavedChanges = true;
            dirtyReopenPreserveCount += 1;
          } else {
            adoptTabPathIdentity(targetTab, filePath);
            setCleanDocument(targetTab, content);
            targetTab.hasUnsavedChanges = false;
            targetTab.diskVersion = diskVersionForAdoption(
              targetTab.filePath,
              data.modifiedTime,
              data.diskVersion,
            );
            targetTab.mtimeMs = Number.isFinite(data.modifiedTime)
              ? data.modifiedTime
              : targetTab.diskVersion
                ? targetTab.diskVersion.mtimeMs
                : null;
            cleanReopenAdoptCount += 1;
          }
          largeConfirmed.add(targetTab.id);
        } else {
          // Create without activation: switchToTab owns the one renderer
          // lifecycle transition and the one visual render below.
          targetTab = createTab(filePath, content, {
            activate: false,
            confirmed: true,
            modifiedTime: data.modifiedTime,
            diskVersion: data.diskVersion,
          });
          if (!targetTab) return;
        }

        // If multiple files were selected, open them all. activate:false - the
        // trailing files of a multi-select are a cache-only batch.
        if (allPaths && allPaths.length > 1) {
          allPaths.slice(1).forEach((extraPath) => {
            if (!findTabByPath(extraPath) && window.fs) {
              try {
                const snapshot = readStableDiskSnapshot(extraPath);
                createTab(extraPath, snapshot.content, {
                  activate: false,
                  modifiedTime: snapshot.modifiedTime,
                  diskVersion: snapshot.diskVersion,
                });
              } catch (error) {
                console.error(
                  "[CustomTabs] Error loading file:",
                  extraPath,
                  error,
                );
              }
            }
          });
        }

        switchToTab(targetTab.id, {
          fileOpenData: data,
          skipSnapshot: targetWasActive,
          fileOpenLifecycleOptions:
            preflight.lifecycleOptions || undefined,
          fileOpenOptions: {
            preserveEditBaseline: preserveCachedDocument,
            adoptPathIdentity: !preserveCachedDocument,
          },
        });
      };

      window.ipcRenderer.on("file-opened", handleFileOpened);
    }

    const rendererFileOpenResultHandlers = window.ipcRenderer.listeners
      ? window.ipcRenderer.listeners("file-open-result").slice()
      : [];
    if (rendererFileOpenResultHandlers.length > 0) {
      window.ipcRenderer.removeAllListeners("file-open-result");
      const handleFileOpenResult = (event, data) => {
        if (
          deferFrozenDocumentOperation("ipc:file-open-result", () =>
            handleFileOpenResult(event, data),
          )
        ) {
          return;
        }
        rendererFileOpenResultHandlers.forEach((handler) =>
          handler(event, data),
        );
      };
      window.ipcRenderer.on("file-open-result", handleFileOpenResult);
    }
  }

  // ============================================
  // Keep the tab store in sync with disk
  // ============================================

  let rejectedReloadResultCount = 0;
  let foreignReloadResultCount = 0;
  let foreignReloadFailureCount = 0;
  let acceptedReloadFailureCount = 0;
  let acceptedBackgroundReloadFailureCount = 0;
  let lastRejectedReloadWhy = null;
  let lastAcceptedReloadSequence = 0;
  let lastAcceptedReloadFailureSequence = 0;

  // A reload takeover is only safe after CustomTabs has taken ownership of
  // file-open lifecycle. In compatibility mode there may be no target tab, so
  // leave renderer's reload listener installed rather than dropping replies.
  if (window.ipcRenderer && canOwnFileOpen) {
    window.customTabsOwnsReloadResults = true;
    // renderer.js handles 'file-reload-result' by updating its own
    // module-level `originalMarkdown` and repainting the viewer. It has no
    // knowledge of tabs, so the refreshed text never reaches `tab.content` -
    // and the next switchToTab() repaints the pre-refresh copy, silently
    // reverting the document the user just refreshed.
    //
    // We take over the channel (delegating to renderer's own handler) so we
    // can: capture the scroll position before the repaint, write the fresh
    // content into the tab store, restore the position afterwards, and skip
    // the repaint entirely if the user switched tabs while the disk read was
    // still in flight.
    const rendererReloadHandlers = window.ipcRenderer.listeners
      ? window.ipcRenderer.listeners("file-reload-result").slice()
      : [];

    if (rendererReloadHandlers.length > 0) {
      window.ipcRenderer.removeAllListeners("file-reload-result");
    } else {
      console.warn(
        "[CustomTabs] No existing 'file-reload-result' handler found; " +
          "renderer.js may have changed its reload channel.",
      );
    }

    const delegateReload = (event, data) => {
      // No renderer handler to delegate to (its registration moved or the
      // channel was renamed). Apply the reload here so a refresh is never a
      // silent no-op, and sync the renderer state the handler would have set -
      // leaving originalMarkdown stale would corrupt subsequent view-mode edits.
      if (rendererReloadHandlers.length === 0) {
        if (data && data.success && window.renderMarkdown) {
          if (typeof window.originalMarkdown !== "undefined") {
            window.originalMarkdown = data.content;
          }
          if (inEditMode() && window.markdownEditor) {
            window.markdownEditor.value = data.content;
          }
          if (window.setUnsavedState) {
            window.setUnsavedState(false);
          }
          return Promise.resolve(window.renderMarkdown(data.content));
        }
        notify(
          t("notif.reloadFailed", "Failed to reload file: ") +
            ((data && data.error) || ""),
          4000,
        );
        return Promise.resolve();
      }
      try {
        return Promise.all(rendererReloadHandlers.map((fn) => fn(event, data)));
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const validateReloadResult = (
      data,
      targetTab,
      activeTab,
      options = {},
    ) => {
      const request = data && data.reloadRequest;
      const session = data && data.reloadSession;
      const currentSession =
        typeof window.getReloadRequestSession === "function"
          ? window.getReloadRequestSession()
          : request && request.session;
      if (
        !request ||
        !Number.isSafeInteger(request.sequence) ||
        !Number.isSafeInteger(request.tabId) ||
        typeof request.path !== "string" ||
        typeof request.snapshot !== "string" ||
        typeof request.session !== "string" ||
        request.session !== currentSession ||
        !session ||
        !Number.isSafeInteger(session.epoch) ||
        session.pageSession !== currentSession
      ) {
        return "foreign-page-identity";
      }
      const requestPath = canonicalTabPath(request.path);
      const resultPath = canonicalTabPath(data.path);
      const targetPath = targetTab && canonicalTabPath(targetTab.filePath);
      if (!targetTab || targetTab.id !== request.tabId) {
        return "foreign-tab-generation";
      }
      if (
        !requestPath ||
        requestPath !== resultPath ||
        requestPath !== targetPath
      ) {
        return "foreign-target";
      }
      if (
        options.requireActive &&
        (!activeTab || !targetTab || activeTab.id !== targetTab.id)
      ) {
        return "foreign-background-failure";
      }
      const latest =
        typeof window.getLatestReloadRequestSequence === "function"
          ? window.getLatestReloadRequestSequence(request.path)
          : request.sequence;
      if (latest !== request.sequence) return "foreign-stale-sequence";

      if (options.checkSnapshot !== false) {
        const currentSnapshot =
          activeTab && targetTab && activeTab.id === targetTab.id
            ? liveDocument()
            : targetTab && targetTab.content;
        if (
          typeof currentSnapshot !== "string" ||
          !sameDocument(currentSnapshot, request.snapshot)
        ) {
          return "document-moved-after-request";
        }
      }
      return null;
    };

    const rejectReloadResult = (targetTab, activeTab, why, data) => {
      rejectedReloadResultCount += 1;
      lastRejectedReloadWhy = why;
      if (targetTab) {
        const isActive = !!(activeTab && activeTab.id === targetTab.id);
        if (isActive) {
          const live = liveDocument();
          if (typeof live === "string") {
            adoptDocumentContent(targetTab, live);
          }
        }
        const state = documentState.get(targetTab);
        if (state && !state.reloadConflict) {
          state.reloadConflict = true;
          bumpDocumentRevision();
        }
        targetTab.hasUnsavedChanges = true;
        if (typeof window.markReloadConflict === "function") {
          window.markReloadConflict(targetTab.filePath);
        } else if (isActive && window.setUnsavedState) {
          window.setUnsavedState(true);
          window.ipcRenderer.send("pause-file-watching");
        }
        renderTabs();
        saveTabs();
      }
      console.log("[CustomTabs] Rejected stale reload result:", why);
      notify(
        t(
          "notif.reloadConflict",
          "The document changed while reloading. Current edits were kept.",
        ),
        4000,
      );
      return data;
    };

    const handleReloadResult = (event, data) => {
      const failed = !data || !data.success;
      const targetTab =
        data && data.path
          ? findTabByPath(data.path)
          : failed
            ? null
            : getActiveTab();
      const activeTab = getActiveTab();
      const validationWhy = validateReloadResult(
        data,
        targetTab,
        activeTab,
        failed ? { checkSnapshot: false } : undefined,
      );

      if (isDocumentFrozen()) {
        const frozenSource = failed
          ? "ipc:reload-failure"
          : "ipc:reload-result";
        if (
          validationWhy &&
          (failed || validationWhy !== "document-moved-after-request")
        ) {
          mayMutateDocument(frozenSource);
          if (failed) {
            foreignReloadFailureCount += 1;
          } else {
            foreignReloadResultCount += 1;
          }
          lastRejectedReloadWhy = validationWhy;
          console.log(
            `[CustomTabs] Dropped foreign reload ${failed ? "failure" : "result"}:`,
            validationWhy,
          );
          return;
        }
        deferFrozenDocumentOperation(
          frozenSource,
          () => handleReloadResult(event, data),
        );
        return;
      }

      if (failed) {
        const failureWhy = validationWhy;
        if (failureWhy) {
          foreignReloadFailureCount += 1;
          lastRejectedReloadWhy = failureWhy;
          console.log(
            "[CustomTabs] Dropped foreign reload failure:",
            failureWhy,
          );
          return;
        }
        acceptedReloadFailureCount += 1;
        lastAcceptedReloadFailureSequence = data.reloadRequest.sequence;
        const isForeground = !!(
          targetTab && activeTab && targetTab.id === activeTab.id
        );
        if (!isForeground) {
          acceptedBackgroundReloadFailureCount += 1;
          notify(
            t("notif.reloadFailed", "Failed to reload file: ") +
              `${targetTab.filename}: ${(data && data.error) || ""}`,
            4000,
          );
          return;
        }
        delegateReload(event, data).catch((error) =>
          console.error("[CustomTabs] Reload handler failed:", error),
        );
        return;
      }
      if (!mayMutateDocument("ipc:reload-result")) return;

      const rejectedWhy = validationWhy;
      if (rejectedWhy) {
        if (rejectedWhy !== "document-moved-after-request") {
          foreignReloadResultCount += 1;
          lastRejectedReloadWhy = rejectedWhy;
          console.log("[CustomTabs] Dropped foreign reload result:", rejectedWhy);
          return;
        }
        rejectReloadResult(targetTab, activeTab, rejectedWhy, data);
        return;
      }
      lastAcceptedReloadSequence = data.reloadRequest.sequence;
      if (typeof window.clearReloadConflict === "function" && targetTab) {
        window.clearReloadConflict(targetTab.filePath);
      }
      const isBackground = !!(targetTab && activeTab && targetTab.id !== activeTab.id);
      const anchor = captureAnchor();

      if (targetTab) {
        adoptTabPathIdentity(targetTab, data.path || targetTab.filePath);
        setCleanDocument(targetTab, data.content);
        targetTab.hasUnsavedChanges = false;
        targetTab.diskVersion = diskVersionForAdoption(
          targetTab.filePath,
          data.modifiedTime,
          data.diskVersion,
        );
        targetTab.mtimeMs = Number.isFinite(data.modifiedTime)
          ? data.modifiedTime
          : targetTab.diskVersion
            ? targetTab.diskVersion.mtimeMs
            : null;
        if (isBackground) {
          // The captured anchor belongs to the visible tab, and this tab's
          // stored pixel offset refers to pre-refresh content. Drop both
          // rather than scroll somewhere meaningless on the next switch.
          targetTab.anchor = null;
          targetTab.scrollPosition = 0;
        } else if (anchor) {
          targetTab.anchor = anchor;
          targetTab.scrollPosition = anchor.scrollTop;
        }
        renderTabs();
        saveTabs();
      }

      // A tab switch raced the disk read. Repainting now would paint the wrong
      // document over the active tab; the content is already safe in the store.
      if (isBackground) {
        if (typeof window.adoptFileTrackingBaseline === "function") {
          window.adoptFileTrackingBaseline(
            data.path,
            data.modifiedTime,
            data.diskVersion,
          );
        }
        console.log(
          "[CustomTabs] Reload result is for a background tab:",
          targetTab.filename,
        );
        notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
        return;
      }

      // renderMarkdown() is genuinely async (mermaid/D2 diagrams can take
      // seconds), so the user can switch tabs or start typing before this
      // reload's render settles. Scope the completion to the tab and the
      // render that started it.
      const reloadTabId = activeTab ? activeTab.id : activeTabId;
      const generation = ++renderGeneration;

      const reloadPromise = delegateReload(event, data);
      if (
        rendererReloadHandlers.length === 0 &&
        typeof window.adoptFileTrackingBaseline === "function"
      ) {
        window.adoptFileTrackingBaseline(
          data.path,
          data.modifiedTime,
          data.diskVersion,
        );
      }

      // Baseline for the "was it edited during the render?" test below.
      //
      // It must be sampled here, not derived from `data.content`. renderer's
      // handler runs synchronously up to its `await renderMarkdown(...)`, so by
      // now it has already done `markdownEditor.value = data.content` - and a
      // <textarea> normalises CRLF/CR to LF on assignment. Comparing the live
      // editor text against the raw `data.content` therefore reports every
      // Windows-line-ending file as edited on every reload, with no user input
      // at all: the tab is permanently dirtied (which pauses its watcher and
      // prompts on close) and the next save rewrites the file to LF.
      //
      // Reading the baseline back through the same expression as `live` makes
      // the comparison self-consistent under any DOM normalisation, not just
      // line endings.
      const baseline = liveDocument();

      reloadPromise
        .then(() => {
          if (generation !== renderGeneration || activeTabId !== reloadTabId) {
            // Superseded by a tab switch or a newer render. Touching renderer
            // state now would clear the NEW tab's unsaved flag and scroll it
            // to this tab's anchor.
            console.log("[CustomTabs] Discarding superseded reload completion");
            return;
          }

          // The document may have been edited while the render was in flight.
          // Clearing the unsaved flag then would silently mark those edits
          // saved, and the next refresh would discard them without warning.
          const live = liveDocument();

          if (
            typeof live === "string" &&
            typeof baseline === "string" &&
            live !== baseline
          ) {
            console.log("[CustomTabs] Edited during reload; keeping dirty");
            if (targetTab) {
              // The value being adopted IS the live document - it was just read
              // from it - so the fold witness moves with it, or the next undo
              // back to the old witness is skipped and this text survives it.
              adoptDocumentContent(targetTab, live);
              targetTab.hasUnsavedChanges = true;
              renderTabs();
              saveTabs();
            }
          } else if (window.setUnsavedState) {
            // renderer.js only clears its unsaved flag when the reload happens
            // in edit mode. In view mode the flag would stay set even though
            // the document was just replaced by the on-disk copy, leaving a
            // phantom "unsaved changes" state that suppresses later prompts.
            window.setUnsavedState(false);
          }

          restorePosition(anchor);
          notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
        })
        .catch((error) =>
          console.error("[CustomTabs] Reload handler failed:", error),
        );
    };

    window.ipcRenderer.on("file-reload-result", handleReloadResult);
  } else if (window.ipcRenderer) {
    // Compatibility mode still needs freeze-safe delivery even though the
    // upstream renderer remains the sole owner of reload acceptance.
    const compatibilityReloadHandlers = window.ipcRenderer.listeners
      ? window.ipcRenderer.listeners("file-reload-result").slice()
      : [];
    if (compatibilityReloadHandlers.length > 0) {
      window.ipcRenderer.removeAllListeners("file-reload-result");
      const handleCompatibleReloadResult = (event, data) => {
        const source =
          data && data.success
            ? "ipc:reload-result"
            : "ipc:reload-failure";
        if (
          deferFrozenDocumentOperation(source, () =>
            handleCompatibleReloadResult(event, data),
          )
        ) {
          return;
        }
        compatibilityReloadHandlers.forEach((handler) =>
          handler(event, data),
        );
      };
      window.ipcRenderer.on(
        "file-reload-result",
        handleCompatibleReloadResult,
      );
    }
  }

  if (window.ipcRenderer) {
    // Save completion is independent: captured renderer handlers are always
    // delegated, and tab mirroring already no-ops when no target tab exists.
    // Saving writes renderer state to disk. Mirror it into the tab so the
    // saved text is not reverted by the next tab switch. Key off data.path:
    // the write is async, so the user may have switched tabs meanwhile.
    //
    // renderer.js's own handler does not check the path either - it blindly
    // does `originalMarkdown = markdownEditor.value` and clears the unsaved
    // flag. If the user switched tabs during the write that marks the WRONG
    // document clean. Take the channel over and only delegate when the result
    // belongs to the document the renderer is currently showing.
    const rendererSaveHandlers = window.ipcRenderer.listeners
      ? window.ipcRenderer.listeners("save-markdown-result").slice()
      : [];
    window.ipcRenderer.removeAllListeners("save-markdown-result");

    window.ipcRenderer.on("save-markdown-result", (event, data) => {
      const expectedSaveResult =
        typeof window.isExpectedSaveResult === "function"
          ? window.isExpectedSaveResult(data)
          : true;
      const resultPath = data && data.path
        ? canonicalTabPath(data.path)
        : null;
      const currentPath = canonicalTabPath(window.currentFilePath);
      const isForCurrent =
        !resultPath || (!!currentPath && resultPath === currentPath);

      // Always delegate. The renderer's handler is itself path-aware now: it
      // only touches the document stores when the reply describes the document
      // on screen, and it has to see every reply - including background ones
      // and failures - to settle the promise that the exit-edit path parks on.
      // Filtering here used to strand that promise, so an Exit after a
      // save-then-switch sat on its timeout and then offered to DISCARD a save
      // that had already succeeded.
      if (!isForCurrent) {
        console.log("[CustomTabs] Save result is for a background tab:", data.path);
      }
      rendererSaveHandlers.forEach((fn) => {
        try {
          fn(event, data);
        } catch (error) {
          console.error("[CustomTabs] Save handler failed:", error);
        }
      });

      if (!expectedSaveResult) return;
      if (!data || !data.success) return;
      if (!mayMutateDocument("ipc:save-result")) return;

      const tab = data.path ? findTabByPath(data.path) : getActiveTab();
      // The tab was closed while the write was in flight. Falling back to the
      // active tab would overwrite an unrelated document's cache and falsely
      // mark it clean.
      if (!tab) return;

      const activeTab = getActiveTab();
      const currentDocument =
        activeTab && activeTab.id === tab.id ? liveDocument() : tab.content;
      if (
        typeof data.savedContent === "string" &&
        !sameDocument(currentDocument, data.savedContent)
      ) {
        // The tab moved again while this write was in flight. The acknowledged
        // bytes are on disk, but replacing the cache with them would erase the
        // newer in-memory edit (especially for a background tab).
        if (
          activeTab &&
          activeTab.id === tab.id &&
          typeof currentDocument === "string"
        ) {
          adoptDocumentContent(tab, currentDocument);
        }
        tab.hasUnsavedChanges = true;
        renderTabs();
        saveTabs();
        return;
      }

      if (typeof data.savedContent === "string") {
        setCleanDocument(tab, data.savedContent);
      } else {
        try {
          if (window.fs) {
            setCleanDocument(tab, readFromDisk(tab.filePath));
          }
        } catch (error) {
          console.error("[CustomTabs] Post-save read failed:", error);
        }
      }

      tab.hasUnsavedChanges = false;
      tab.diskVersion = diskVersionForAdoption(
        tab.filePath,
        data.modifiedTime,
        data.diskVersion,
      );
      tab.mtimeMs = Number.isFinite(data.modifiedTime)
        ? data.modifiedTime
        : tab.diskVersion
          ? tab.diskVersion.mtimeMs
          : null;
      renderTabs();
      saveTabs();
    });
  }

  if (window.ipcRenderer && canOwnFileOpen) {
    // The watcher follows the active tab, but a change event queued just
    // before a tab switch can still arrive afterwards. renderer.js prompts
    // without checking which file the event was for, and its "Reload" action
    // reloads currentFilePath - i.e. the wrong document. Drop stale events.
    // This filter is installed only while CustomTabs owns file-open lifecycle;
    // compatibility mode leaves renderer's notification handler untouched.
    const rendererChangeHandlers = window.ipcRenderer.listeners
      ? window.ipcRenderer.listeners("file-changed-externally").slice()
      : [];
    window.ipcRenderer.removeAllListeners("file-changed-externally");

    window.ipcRenderer.on("file-changed-externally", (event, data) => {
      const activeTab = getActiveTab();
      if (!activeTab) {
        // No tab is open (all closed): there is nothing to prompt about.
        console.log("[CustomTabs] Ignoring change event with no active tab");
        return;
      }
      if (data && data.path && data.path !== activeTab.filePath) {
        const eventPath = canonicalTabPath(data.path);
        const activePath = canonicalTabPath(activeTab.filePath);
        if (!eventPath || !activePath || eventPath !== activePath) {
          console.log("[CustomTabs] Ignoring stale change event:", data.path);
          return;
        }
      }
      rendererChangeHandlers.forEach((fn) => {
        try {
          fn(event, data);
        } catch (error) {
          console.error("[CustomTabs] Change handler failed:", error);
        }
      });
    });
  }

  // ============================================
  // "File Updated" prompt (actively-viewed tab)
  // ============================================

  // The prompt is only raised for the tab the user is looking at - background
  // tabs are reloaded silently on switch instead. Its Reload button is wired
  // in index.html as `onclick="reloadCurrentFile()"`, which reloads whatever
  // renderer.js has in currentFilePath and does so without any unsaved-changes
  // guard (unlike the toolbar refresh button). Rebind it so the prompt can
  // never discard edits the user has not saved.
  //
  // Assigning .onclick replaces the inline attribute handler rather than
  // adding a second one, so renderer.js's own call sites are unaffected and
  // the user is never asked to confirm twice.
  function reloadFromUpdatePrompt() {
    const tab = snapshotActiveTab();
    if (tab && tab.hasUnsavedChanges) {
      const message = t(
        "confirm.unsavedRefresh",
        "You have unsaved changes. Reload from disk and discard them?",
      );
      // Confirm BEFORE dismissing: backing out of the confirmation is not the
      // same as pressing Dismiss. The file is still stale, so the prompt has
      // to stay up or the user loses their only way back to it.
      if (!window.confirm(message)) return;
    }

    dismissUpdatePrompt();

    const requestReload =
      typeof window.requestCurrentFileReload === "function"
        ? window.requestCurrentFileReload
        : typeof window.reloadCurrentFile === "function"
          ? window.reloadCurrentFile
          : null;
    if (requestReload) {
      requestReload();
    } else {
      notify(
        t(
          "notif.reloadFailed",
          "Reload is unavailable because request metadata cannot be created.",
        ),
        4000,
      );
    }
  }

  function bindUpdatePrompt() {
    const reloadBtn = document.getElementById("reloadFileBtn");
    if (reloadBtn) {
      reloadBtn.onclick = reloadFromUpdatePrompt;
    }
    // Both buttons used to carry inline onclick= attributes in index.html.
    // Those are gone (SEC-09: they are the one thing a CSP cannot tell apart
    // from injected markup), so Dismiss has to be wired here. Reload was
    // already overridden below anyway - its inline handler called the
    // *unguarded* reloadCurrentFile(), which discarded unsaved edits without
    // asking.
    const dismissBtn = document.getElementById("dismissFileUpdateBtn");
    if (dismissBtn) {
      dismissBtn.onclick = dismissUpdatePrompt;
    }
  }

  // The overlay is loaded at the end of <body>, so DOMContentLoaded has not
  // fired yet - but bind immediately too in case that ever changes.
  if (document.readyState !== "loading") {
    bindUpdatePrompt();
  }

  // ============================================
  // Sync with renderer's isEditMode
  // ============================================

  // THE SHADOW COPY IS GONE, AND ITS TIMER WITH IT. This block used to sample
  // `.content-wrapper.split-view` 10 ms after the edit button was clicked and
  // write the answer into `window.isEditMode`, which every fold below then
  // trusted. Leaving edit mode can await an in-flight save for up to five
  // seconds, so the sample was taken while the app was still in the OLD mode and
  // was never corrected: the window ended up in view mode with the shadow still
  // saying "edit", and the fold read a hidden textarea instead of the live
  // document, silently discarding every view-mode edit made afterwards.
  //
  // `inEditMode()` reads the class directly, so there is nothing to keep in
  // step and nothing that can be stale. `window.isEditMode` survives only as
  // the fallback for a DOM with no `.content-wrapper` at all.
  document.addEventListener("DOMContentLoaded", () => {
    bindUpdatePrompt();
  });

  // ============================================
  // Shutdown approval (F22)
  // ============================================

  // The main process cannot answer "is anything unsaved?" - it holds no
  // document state, and saveTabs() persists paths and anchors, never content.
  // So every way out of the app (the window's X, Ctrl+Q, an ordinary quit, an
  // update install) asks HERE, over one channel, and waits for this answer.
  //
  // THE SNAPSHOT IS LOAD-BEARING AND MUST COME FIRST. A tab's cached `content`
  // is only as fresh as the last switch: the active document's edits live in
  // the textarea (edit mode) or in window.originalMarkdown (view-mode table,
  // checkbox and note edits) until something folds them back in.
  // snapshotActiveTab() is that fold, and without it the one document the
  // reader is actually typing into is the one document this cannot see.
  //
  // EVERY tab is then tested, not just the active one. Dirtiness is
  // isDirty() - content against originalContent, newline-normalised - rather
  // than the cached `hasUnsavedChanges` flag, so a background tab edited
  // before a switch is still reported.
  let approvalRendererGeneration = null;
  let highestShutdownRequestId = 0;
  let pendingSaveShutdownRetry = null;
  const PENDING_SAVE_STATUS_EVENT = "folia-pending-save-status-changed";
  // BOUNDED TO ONE ENTRY, AND PRUNED WHERE IT GROWS. Only the answer to the
  // HIGHEST id observed can ever be asked for again: main.js re-dispatches a
  // request only while it is still the open one, and every lower id is refused
  // below as stale before it can reach a replay. Without the clear() at the
  // write site this map retained one frozen response - and the filename array
  // inside it - for every shutdown the reader ever cancelled, for the life of
  // the document, to serve a duplicate that by construction can only ever name
  // the newest id. (A navigation builds a fresh module with an empty map, so
  // nothing here has to survive one.)
  const shutdownResponses = new Map();

  function pendingSaveStatusForShutdown() {
    if (typeof window.getPendingSaveStatus !== "function") {
      throw new Error("pending-save status is unavailable");
    }
    // Open-tab saves are the required blocker. Include a just-closed tab's
    // still-running write as well so shutdown never terminates the main process
    // in the middle of an operation the renderer has not yet settled.
    return window.getPendingSaveStatus();
  }

  function dirtyTabNames() {
    // Edit mode with no editor to read is a state this cannot answer for: the
    // snapshot would fall back to window.originalMarkdown and report the
    // document clean while the reader's keystrokes sat in a textarea it could
    // not see. Say so instead, and let the main process ask.
    //
    // Defensive rather than observed: renderer.js publishes window.markdownEditor
    // unconditionally today, and inEditMode() reads the same DOM the editor
    // lives in. It is here so that a refactor which breaks that pairing fails
    // CLOSED - the one direction this whole path cannot afford to get wrong.
    if (inEditMode() && !window.markdownEditor) {
      throw new Error("edit mode is active but the editor is unavailable");
    }
    const pendingStatus = pendingSaveStatusForShutdown();
    if (pendingStatus.pending) {
      const error = new Error("save pending for an open tab");
      error.code = "FOLIA_PENDING_SAVE";
      error.status = pendingStatus;
      throw error;
    }
    // Shutdown only needs the current document bytes. A cancelled request may
    // leave the previous anchor in memory; every existing no-argument snapshot
    // caller still captures the current position before its normal work.
    snapshotActiveTab({ capturePosition: false });
    return tabs.filter(isDirty).map((tab) => tab.filename);
  }

  window.addEventListener(PENDING_SAVE_STATUS_EVENT, () => {
    // Pending-save state is part of the shutdown answer even when document
    // bytes do not move. Advancing the revision on both dispatch and settlement
    // invalidates an answer taken on the other side of either transition.
    bumpDocumentRevision();
    if (!pendingSaveShutdownRetry || pendingSaveShutdownRetry.sent) return;
    let status;
    try {
      status = pendingSaveStatusForShutdown();
    } catch (error) {
      return;
    }
    if (status.pending) return;
    pendingSaveShutdownRetry.sent = true;
    tabIpc.send("quit-approval-retry", {
      id: pendingSaveShutdownRetry.id,
      gen: pendingSaveShutdownRetry.gen,
      revision: documentRevision,
    });
  });

  // ============================================
  // Two-phase commit (F22)
  // ============================================
  //
  // AN ANSWER IS NOT A COMMIT. The reply below describes the document at one
  // instant; main then defers the approved continuation to a fresh turn of the
  // loop, and the reader can type in that gap. Re-checking the document
  // GENERATION cannot see it - the same document with new text in it is the
  // same generation - so the approval was acted on without anything having
  // looked at the document again.
  //
  // So the answer carries a REVISION, and main must come back and commit
  // against it. The commit re-runs the fold, which genuinely re-reads the
  // textarea or the live copy, and refuses if anything moved. On success the
  // document is FROZEN: the editor is made read-only so no further keystroke
  // can enter a document that is about to go away. Ordinarily a fresh request
  // supersedes and releases it. A Folia-owned NSIS hand-off is different:
  // phase two is already the final approval and main marks any serialized
  // request retainFreeze so UAC/process startup cannot expose editable text to
  // the installer's forced process-kill phase.
  function freezeDocument(id, generation) {
    if (shutdownFreeze) {
      // The replacement commit has already re-checked its revision. Keep IPC
      // results parked while swapping freezes; replaying here would mutate the
      // document after that check and then commit the replacement approval
      // against state it never observed.
      thawDocument("superseded", { replayDeferred: false });
    }
    const editor = window.markdownEditor;
    // THE TEXTAREA IS NOT THE ONLY WAY IN. View-mode edits arrive through
    // clicks - a checkbox, a table cell, a note - and making only the editor
    // read-only left every one of those live while the app was on its way out.
    // `inert` is the platform's own interaction boundary: it removes the whole
    // subtree from hit-testing, focus and the tab order in one property, which
    // is exactly "the reader can no longer act on this document" and is not a
    // set of individual handlers that a later feature can forget to join.
    // Body is the interaction owner: the header/tab strip/tools, document,
    // drag target and already-open overlays are siblings, so inerting only the
    // content wrapper leaves programmatic document mutators reachable. Native
    // main-process dialogs and IPC/status rendering do not depend on pointer or
    // keyboard interaction and remain available.
    const inertOwner =
      typeof document !== "undefined" ? document.body : null;
    shutdownFreeze = {
      id: id,
      gen: generation,
      editor: editor || null,
      previousReadOnly: editor ? editor.readOnly : null,
      inertOwner: inertOwner || null,
      inertOwnerLabel: inertOwner ? "body" : null,
      // Restored rather than cleared: `inert` may legitimately already be set
      // by something else, and a freeze must put back what it found.
      previousInert: inertOwner ? inertOwner.inert : null,
      adoptionsRefused: 0,
    };
    if (editor) editor.readOnly = true;
    if (inertOwner) inertOwner.inert = true;
    if (
      typeof window.assertFileTrackingOwnership === "function" &&
      window.currentFilePath
    ) {
      window.assertFileTrackingOwnership(window.currentFilePath, true, {
        adoptBaseline: false,
      });
    }
  }

  function thawDocument(why, options = {}) {
    if (!shutdownFreeze) return false;
    const frozen = shutdownFreeze;
    shutdownFreeze = null;
    if (frozen.editor) frozen.editor.readOnly = frozen.previousReadOnly;
    if (frozen.inertOwner) {
      frozen.inertOwner.inert = frozen.previousInert;
    }
    if (options.replayDeferred !== false) {
      replayFrozenDocumentOperations();
    }
    if (
      typeof window.assertFileTrackingOwnership === "function" &&
      window.currentFilePath
    ) {
      window.assertFileTrackingOwnership(window.currentFilePath, true, {
        adoptBaseline: false,
      });
    }
    console.log("[CustomTabs] Shutdown freeze released:", why, frozen.id);
    return true;
  }

  tabIpc.on("quit-approval-commit", (event, data) => {
    const id = data && data.id;
    const generation = data && data.gen;
    const revision = data && data.revision;
    // Declared before `reply` closes over it: the early refusals below run
    // before the re-check, and reading it there would be a temporal-dead-zone
    // throw inside the one handler that must always answer.
    let recheckedDirtyFiles = null;
    const reply = (committed, why) =>
      tabIpc.send("quit-approval-committed", {
        id: id,
        gen: generation,
        committed: committed,
        why: why,
        revision: documentRevision,
        dirtyFiles: committed ? null : recheckedDirtyFiles,
      });
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(generation) ||
      !Number.isSafeInteger(revision) ||
      generation !== approvalRendererGeneration
    ) {
      // Not answerable and not ours. Replying "not committed" is the
      // fail-closed direction: main asks again rather than acting.
      reply(false, "stale-commit-request");
      return;
    }
    try {
      // The fold is the re-read. It pulls the textarea (edit mode) or the live
      // copy (view mode) back into the tab, so an edit made since the answer
      // moves the revision here and is caught below rather than lost.
      recheckedDirtyFiles = dirtyTabNames();
    } catch (error) {
      console.error("[CustomTabs] Commit re-check failed:", error);
      reply(
        false,
        error && error.code === "FOLIA_PENDING_SAVE"
          ? "pending-save"
          : "unreadable",
      );
      return;
    }
    if (documentRevision !== revision) {
      reply(false, "revision-moved");
      return;
    }
    freezeDocument(id, generation);
    reply(true, "committed");
  });

  tabIpc.on("quit-approval-thaw", () => {
    thawDocument("main-released");
  });

  // Registered BEFORE readiness is announced below: the announcement is what
  // makes the main process start sending on this channel, so a request could
  // otherwise arrive before there was anything to receive it.
  //
  // EVERY PATH OUT OF THIS HANDLER ANSWERS, except the deliberate
  // stale/malformed drop. A request that is accepted and then left unanswered
  // strands the main process with no timeout to release it - the one failure
  // this side can cause and cannot recover from - so an unreadable state is
  // REPORTED as unreadable rather than becoming silence.
  tabIpc.on("quit-approval-request", (event, data) => {
    const id = data && data.id;
    const generation = data && data.gen;
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(generation) ||
      generation !== approvalRendererGeneration
    ) {
      console.log("[CustomTabs] Ignoring stale shutdown request:", id);
      return;
    }

    // A request can be re-dispatched with the same id when this document was
    // briefly considered unavailable. Re-send the exact answer already
    // observed for that id; recomputing after more edits would make one consent
    // token mean two different document states.
    const retryingPendingSave = !!(
      pendingSaveShutdownRetry &&
      pendingSaveShutdownRetry.id === id &&
      pendingSaveShutdownRetry.gen === generation
    );
    const cached = shutdownResponses.get(id);
    if (cached) {
      tabIpc.send("quit-approval-response", cached);
      return;
    }
    if (
      id < highestShutdownRequestId ||
      (id === highestShutdownRequestId && !retryingPendingSave)
    ) {
      console.log("[CustomTabs] Ignoring stale shutdown request:", id);
      return;
    }
    if (id > highestShutdownRequestId) {
      highestShutdownRequestId = id;
      pendingSaveShutdownRetry = null;
    } else if (retryingPendingSave) {
      pendingSaveShutdownRetry = null;
    }
    // A NEW QUESTION normally releases the old answer's freeze. Main can
    // explicitly retain it while a Windows installer hand-off is pending or
    // ambiguous; that hand-off may still kill this process, so making the
    // document editable here would invalidate the final approval after the
    // point where it can be safely retaken.
    if (!data.retainFreeze) thawDocument("newer-request");

    let dirtyFiles = null;
    try {
      dirtyFiles = dirtyTabNames();
    } catch (error) {
      if (error && error.code === "FOLIA_PENDING_SAVE") {
        pendingSaveShutdownRetry = {
          id,
          gen: generation,
          sent: false,
        };
        tabIpc.send("quit-approval-response", {
          id,
          gen: generation,
          dirtyFiles: null,
          pendingSaves: true,
          revision: documentRevision,
        });
        return;
      }
      // An explicit "I do not know", never a silent yes: the main process
      // asks the reader rather than assuming there is nothing to lose.
      console.error("[CustomTabs] Could not check for unsaved changes:", error);
      dirtyFiles = null;
    }
    const response = Object.freeze({
      id: id,
      gen: generation,
      dirtyFiles: dirtyFiles,
      // The document state this answer describes. Main hands it back at the
      // commit below, and the answer is refused if anything has moved since.
      revision: documentRevision,
    });
    // Replaces rather than accumulates: this id is now the highest, so every
    // answer it displaces has become unreachable above.
    shutdownResponses.clear();
    shutdownResponses.set(id, response);
    tabIpc.send("quit-approval-response", response);
  });

  // ============================================
  // Export API
  // ============================================

  window.CustomTabs = {
    createTab,
    switchToTab,
    // Exposed so the regression suite can assert that scroll save/restore
    // targets the element the engine actually scrolls, rather than re-deriving
    // that guess in the test and proving nothing.
    __getScroller: getScroller,
    // Exposed so the suite can prove the DELEGATION fires, not merely that the
    // arithmetic is right. offsetWithin() produces almost the same number
    // through either implementation - renderer.js's scrollerScale() or the
    // fallback below it - so an end-to-end assertion on its RESULT measures the
    // disjunction and would stay green if the delegation were deleted. The only
    // way to tell them apart is to spy on window.scrollerScale while calling
    // the real offsetWithin. Same test-seam convention as __getScroller: assert
    // on the real function, never on a re-implementation of it.
    __offsetWithin: offsetWithin,
    // Session restore runs on DOMContentLoaded, so the only way to drive the
    // real batch path without reloading the window - which would destroy the
    // suite's error sentinel and its state - is to call it. Same test-seam
    // convention as __getScroller: assert on the real function, never on a
    // re-implementation of it.
    __loadSavedTabs: loadSavedTabs,
    // Exposed because "the replay cache is bounded" is an assertion of ABSENCE
    // and there is no other way to observe it. Counting dialogs or responses
    // cannot tell a cache of one from a cache of fifty: every one of those
    // shutdowns answers correctly either way. This reports what is actually
    // RETAINED, so a test can drive fifty cancelled shutdowns and read the
    // number rather than trusting that nothing accumulated.
    __shutdownReplayCache: () =>
      Object.freeze({
        retained: shutdownResponses.size,
        id: shutdownResponses.keys().next().value ?? 0,
        highestRequestId: highestShutdownRequestId,
      }),
    // Exposed because "the dirty answer is maintained rather than recomputed"
    // is an assertion about WORK NOT DONE, and no observable result can carry
    // it: a tab reports the same dirtiness either way. This reports whether the
    // answer is maintained at all, what it currently says, and whether the
    // fold's witness is in step - so a test can drive the real mutation paths
    // and read the state they were supposed to keep, rather than inferring it.
    __documentState: (tab) => {
      const state = documentState.get(tab);
      if (!state) {
        return Object.freeze({
          maintained: false,
          dirty: !sameDocument(tab.content, tab.originalContent),
          reloadConflict: false,
          liveWitnessMatchesContent: false,
        });
      }
      return Object.freeze({
        maintained: true,
        dirty: state.dirty || state.reloadConflict,
        reloadConflict: state.reloadConflict,
        liveWitnessMatchesContent: state.foldedLive === state.content,
      });
    },
    __reloadState: () =>
      Object.freeze({
        rejectedCount: rejectedReloadResultCount,
        foreignCount: foreignReloadResultCount,
        foreignFailureCount: foreignReloadFailureCount,
        acceptedFailureCount: acceptedReloadFailureCount,
        acceptedBackgroundFailureCount:
          acceptedBackgroundReloadFailureCount,
        rejectedWhy: lastRejectedReloadWhy,
        acceptedSequence: lastAcceptedReloadSequence,
        acceptedFailureSequence: lastAcceptedReloadFailureSequence,
      }),
    __fileOpenState: () =>
      Object.freeze({
        cleanReopenAdoptCount,
        dirtyReopenPreserveCount,
        staleNavigationOpenDropCount,
      }),
    // The two-phase commit's own state. A freeze is an assertion about what
    // CANNOT happen next, so nothing observable in a document can carry it -
    // a test has to be able to read whether one is standing, which request it
    // belongs to, and whether the editor was really made read-only.
    __shutdownFreeze: () => {
      return Object.freeze({
        frozen: !!shutdownFreeze,
        id: shutdownFreeze ? shutdownFreeze.id : 0,
        editorReadOnly: !!(window.markdownEditor && window.markdownEditor.readOnly),
        wrapperInert: !!(
          shutdownFreeze &&
          shutdownFreeze.inertOwner &&
          shutdownFreeze.inertOwner.inert
        ),
        bodyInert: !!(
          shutdownFreeze &&
          shutdownFreeze.inertOwner === document.body &&
          document.body.inert
        ),
        inertOwner: shutdownFreeze ? shutdownFreeze.inertOwnerLabel : null,
        adoptionsRefused: shutdownFreeze ? shutdownFreeze.adoptionsRefused : 0,
        mutationAttemptCount: frozenMutationAttemptCount,
        mutationAttemptsBySource: Object.fromEntries(
          frozenMutationAttemptsBySource,
        ),
        mutationAttemptsByCategory: Object.fromEntries(
          frozenMutationAttemptsByCategory,
        ),
        deferredOperationCount: frozenDocumentOperations.length,
        totalDeferredOperations: frozenDocumentOperationDeferCount,
        replayedOperations: frozenDocumentOperationReplayCount,
        revision: documentRevision,
      });
    },
    isDocumentFrozen,
    mayMutateDocument,
    __inEditMode: inEditMode,
    // THE PRODUCT'S OWN ANSWER TO "IS ANYTHING UNSAVED?", exposed so a test can
    // establish its starting state with the same function the shutdown scan
    // uses rather than with a re-implementation of it. A setup control that
    // asks a different question than the code under test is how a scenario ends
    // up measuring a protocol it did not intend to enter.
    __dirtyTabNames: dirtyTabNames,
    closeTab,
    updateTabContent,
    renderTabs,
    findTabByPath,
    getActiveTab,
    getTabs: () => tabs,
    getActiveTabId: () => activeTabId,
  };

  // ============================================
  // Initialize
  // ============================================

  console.log("[CustomTabs] Module loaded");

  // Announce that this renderer can answer the shutdown question. Until this
  // arrives the main process HOLDS a close rather than answering it without
  // us, so it is sent as the last step of module setup - once the listener
  // above exists - and re-sent by every fresh renderer after a navigation.
  //
  // Restored tabs are clean by construction (saveTabs persists no content and
  // loadSavedTabs re-reads from disk), so announcing before the DOMContentLoaded
  // restore below cannot under-report anything unsaved.
  tabIpc
    .invoke("quit-approval-generation")
    .then((generation) => {
      if (!Number.isSafeInteger(generation)) {
        throw new Error("main returned an invalid renderer generation");
      }
      approvalRendererGeneration = generation;
      tabIpc.send("quit-approval-ready", { gen: generation });
    })
    .catch((error) => {
      console.error(
        "[CustomTabs] Could not register shutdown approval:",
        error,
      );
    });

  // Load saved tabs on startup
  document.addEventListener("DOMContentLoaded", () => {
    console.log("[CustomTabs] DOM loaded, restoring tabs");
    loadSavedTabs();
  });

  // If DOM already loaded
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(loadSavedTabs, 100);
  }
})();

// ============================================
// Responsive compact mode
//
// This block used to do far more: it moved the file-info bar into the header,
// hid the back/forward buttons, and ran a MutationObserver that recombined the
// separately-rendered filename and directory back into one ~-shortened string.
// All of that existed to make a SECOND header row presentable. There is only
// one row now and it carries no path, so the observer, the path shortener and
// the .header-integrated class went with it. What is left is the part that was
// never about the file-info bar at all.
// ============================================
(function initCompactHeader() {
  "use strict";

  function applyCompact() {
    document.body.classList.toggle("compact-header", window.innerWidth < 780);
  }

  function start() {
    applyCompact();
    window.addEventListener("resize", applyCompact);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();
