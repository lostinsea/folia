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

  // Keep the per-tab clipboard local instead of borrowing renderer.js's scope.
  // The menu helpers come from the preceding classic script, not a Node require.
  if (!window.FoliaDocumentEvents) {
    throw new Error("FoliaDocumentEvents must load before custom-tabs.js");
  }
  const documentEvents = window.FoliaDocumentEvents;
  if (!window.FoliaContextMenu) {
    throw new Error("FoliaContextMenu must load before custom-tabs.js");
  }
  if (!window.FoliaFileHelpers) {
    throw new Error("FoliaFileHelpers must load before custom-tabs.js");
  }
  const fileHelpers = window.FoliaFileHelpers;
  const {
    positionContextMenu: positionTabMenu,
    hideContextMenu: hideTabMenuEl,
  } = window.FoliaContextMenu;
  let newlineAlignmentDiagnosticsEnabled = false;
  let newlineAlignmentWitnessSequence = 0;
  let pendingNewlineAlignmentWitness = null;
  let newlineAlignmentFlushScheduled = false;
  try {
    window.folia
      .getNewlineAlignmentDiagnosticsEnabled()
      .then((enabled) => {
        newlineAlignmentDiagnosticsEnabled = enabled === true;
      })
      .catch(() => {
        newlineAlignmentDiagnosticsEnabled = false;
      });
  } catch (_error) {
    newlineAlignmentDiagnosticsEnabled = false;
  }

  function flushNewlineAlignmentWitness() {
    newlineAlignmentFlushScheduled = false;
    const witness = pendingNewlineAlignmentWitness;
    pendingNewlineAlignmentWitness = null;
    if (!newlineAlignmentDiagnosticsEnabled || !witness) return;
    if (newlineAlignmentWitnessSequence >= Number.MAX_SAFE_INTEGER) return;
    newlineAlignmentWitnessSequence += 1;
    try {
      window.folia.reportNewlineAlignmentWitness({
        callId: newlineAlignmentWitnessSequence,
        ...witness,
      });
    } catch (_error) {
      // Diagnostics must never become part of the save path's correctness.
    }
  }

  function reportNewlineAlignment(
    restoredSpans,
    bytesScanned,
    mode,
    degraded = false,
    ambiguousBoundaries = 0,
  ) {
    if (!newlineAlignmentDiagnosticsEnabled) return;
    ambiguousBoundaries = Number.isSafeInteger(ambiguousBoundaries)
      ? Math.max(0, ambiguousBoundaries)
      : 0;
    const pending = pendingNewlineAlignmentWitness;
    pendingNewlineAlignmentWitness = {
      callCount: Math.min(
        Number.MAX_SAFE_INTEGER,
        (pending ? pending.callCount : 0) + 1,
      ),
      restoredSpans: Math.min(
        Number.MAX_SAFE_INTEGER,
        (pending ? pending.restoredSpans : 0) + restoredSpans,
      ),
      bytesScanned: Math.min(
        Number.MAX_SAFE_INTEGER,
        (pending ? pending.bytesScanned : 0) + bytesScanned,
      ),
      degradedCount: Math.min(
        Number.MAX_SAFE_INTEGER,
        (pending ? pending.degradedCount : 0) + (degraded ? 1 : 0),
      ),
      ambiguousBoundaries: Math.min(
        Number.MAX_SAFE_INTEGER,
        (pending ? pending.ambiguousBoundaries : 0) + ambiguousBoundaries,
      ),
      mode:
        pending && pending.mode !== mode
          ? pending.degradedCount > 0 || degraded
            ? "mixed-degraded"
            : "mixed"
          : pending
            ? pending.mode
            : mode,
    };
    if (!newlineAlignmentFlushScheduled) {
      newlineAlignmentFlushScheduled = true;
      queueMicrotask(flushNewlineAlignmentWitness);
    }
  }

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
    ctxTabCopyPath.addEventListener("click", async () => {
      const p = tabContextPath;
      hideTabContextMenu();
      if (!p) return;
      if (await window.copyTextToClipboard(p) &&
          typeof window.showNotification === "function") {
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
      if (p) window.revealApprovedDocumentFolder(p);
    });

  // Tab management state
  let tabs = [];
  let activeTabId = null;
  let activeTabForMutations = null;
  let tabIdCounter = 0;

  function reserveDocumentIdentity(tab = null) {
    if (
      nextDocumentGeneration >= Number.MAX_SAFE_INTEGER ||
      (!tab && tabIdCounter >= Number.MAX_SAFE_INTEGER)
    ) {
      console.error("[CustomTabs] Document identity space is exhausted");
      notify("The document cannot be opened: identity space is exhausted.", 6000);
      return null;
    }
    return Object.freeze({
      tabId: tab ? tab.id : ++tabIdCounter,
      documentGeneration: ++nextDocumentGeneration,
    });
  }

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
    const sameBytes = a === b;
    if (sameBytes) return true;
    if (
      typeof a === "string" &&
      typeof b === "string" &&
      a.indexOf("\r") < 0 &&
      b.indexOf("\r") < 0
    ) {
      // Reuse the byte comparison rather than scanning a large LF document
      // again on close; this branch still answers equality independently of
      // the early return.
      return sameBytes;
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
  // here reads as "nothing unsaved" and throws the document away. The one
  // internal exception is a fold that has already compared against the disk
  // baseline and records that known-dirty answer with its content update.
  //
  // renderer.js's own `hasUnsavedChanges` is not usable for this: exiting edit
  // mode leaves the flag and its indicator element set, so reading it bleeds
  // one tab's dirty state onto the next.
  const documentState = new WeakMap();
  let nextDocumentGeneration = 0;
  let nextPreparedSaveSequence = 0;
  let approvalRendererGeneration = null;
  let pendingHandshakeTrackingAssertion = null;
  let pendingRestoredTabId = null;
  const pendingHandshakeFileOpens = [];
  let shutdownFreeze = null;
  let frozenMutationAttemptCount = 0;
  const frozenMutationAttemptsBySource = new Map();
  const frozenMutationAttemptsByCategory = new Map();
  // Phase-two freeze blocks document adoption, not delivery. IPC replies are
  // one-shot, so park them in arrival order and run their normal validators
  // again only after a genuine thaw.
  const MAX_FROZEN_DOCUMENT_OPERATIONS = 256;
  const MAX_DROPPED_FROZEN_OPERATION_SOURCES = 32;
  const frozenDocumentOperations = [];
  const droppedFrozenDocumentOperations = [];
  let frozenDocumentOperationOverflowCount = 0;
  // STICKY, and deliberately not cleared by a thaw. A dropped one-shot is a
  // document fact that never arrived - a save result never folded back into
  // its tab, a file never opened - and nothing later can reconstruct it. From
  // that point on this page cannot honestly answer "is anything unsaved?", so
  // it stops claiming it can.
  let frozenDocumentOperationsDropped = false;
  const appliedTabSaveDecisions = new WeakSet();
  const queuedFrozenSaveRequests = new Set();
  const appliedDiskAdoptionApprovals = new WeakSet();
  const handedOffDiskAdoptionApprovals = new WeakSet();
  const pendingActivationTabs = new WeakSet();

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

  function deferFrozenDocumentOperation(source, replay, onOverflow = null) {
    if (!isDocumentFrozen()) return false;
    mayMutateDocument(source);
    if (
      frozenDocumentOperations.length >=
      MAX_FROZEN_DOCUMENT_OPERATIONS
    ) {
      frozenDocumentOperationOverflowCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        frozenDocumentOperationOverflowCount + 1,
      );
      // FAIL CLOSED, AND SAY SO. The operation still must not run against a
      // frozen document and the queue must stay bounded, so this one-shot is
      // lost - but it is never lost quietly. Returning "deferred" here without
      // the rest of this block was a success-shaped answer for an event that
      // had already been acknowledged upstream and would never be replayed:
      // the shutdown answer stayed clean, the commit succeeded, and the
      // reader was told nothing.
      frozenDocumentOperationsDropped = true;
      shutdownFreeze.deferredOperationsOverflowed = true;
      if (
        droppedFrozenDocumentOperations.length <
        MAX_DROPPED_FROZEN_OPERATION_SOURCES
      ) {
        droppedFrozenDocumentOperations.push(source);
      }
      bumpDocumentRevision();
      console.error(
        `[CustomTabs] Deferred operation capacity exceeded; dropping ${source}`,
      );
      notify(
        "Folia could not hold a document update while closing. " +
          "Check your open documents before relying on them.",
        6000,
      );
      window.folia.reportQuitApprovalOverflow({
        id: shutdownFreeze.id,
        gen: shutdownFreeze.gen,
      });
      if (onOverflow) onOverflow();
      return true;
    }
    frozenDocumentOperations.push({ source, replay });
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
      } catch (error) {
        console.error(
          `[CustomTabs] Deferred ${operation.source} replay failed:`,
          error,
        );
      }
    }
  }

  function defineDocumentAccessors(tab, content, reservedGeneration = null) {
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
      // A write failed after this tab supplied its bytes. Kept separately from
      // semantic dirtiness so a failed Save of an otherwise clean document
      // does not invent an edit, while close/refresh/shutdown still fail closed.
      saveFailure: false,
      // External deletion is retained independently from dirty/conflict UI.
      // It blocks implicit background refresh until an explicit disk adoption.
      deletionTombstone: null,
      // Physical identity adopted for this path spelling. It is deliberately
      // stable across ordinary lookups so retargeting a symlink cannot make an
      // in-flight save/reload reply address another tab.
      pathKey: null,
      mutationRevision: 0,
      generation: reservedGeneration === null
        ? ++nextDocumentGeneration
        : reservedGeneration,
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
        bumpDocumentRevision(tab);
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
        bumpDocumentRevision(tab);
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

  function bumpTabMutationRevision(state) {
    if (state) state.mutationRevision += 1;
  }

  function bumpDocumentRevision(tab = null) {
    documentRevision += 1;
    if (tab) bumpTabMutationRevision(documentState.get(tab));
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
    state.saveFailure = false;
    bumpDocumentRevision(tab);
    return true;
  }

  function adoptCleanDocument(
    tab, content, reservedGeneration = null,
  ) {
    const state = documentState.get(tab);
    if (
      reservedGeneration !== null &&
      (!state ||
        !Number.isSafeInteger(reservedGeneration) ||
        reservedGeneration <= state.generation ||
        reservedGeneration > nextDocumentGeneration)
    ) {
      console.error("[CustomTabs] Refusing a superseded disk adoption");
      return false;
    }
    if (!setCleanDocument(tab, content)) return false;
    if (state) {
      state.generation = reservedGeneration === null
        ? ++nextDocumentGeneration
        : reservedGeneration;
      state.deletionTombstone = null;
    }
    return true;
  }

  function hasUnsavedMutation(tab) {
    const state = documentState.get(tab);
    return state
      ? state.dirty
      : !sameDocument(tab.content, tab.originalContent);
  }

  function isDirty(tab) {
    const state = documentState.get(tab);
    // A tab this module did not build carries no maintained answer. Compute it
    // rather than report clean: an unknown document is never "nothing to lose".
    if (!state) return !sameDocument(tab.content, tab.originalContent);
    return state.dirty || state.reloadConflict || state.saveFailure;
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

  // THE CACHE KEEPS THE FILE'S OWN BYTES WHENEVER THE LIVE TEXT IS ONLY A
  // RESPELLING OF THEM. A <textarea> normalises CRLF to LF on assignment, so
  // every value that has been through the editor - and every renderer store
  // seeded from it - comes back with LF endings even when the reader changed
  // nothing, or changed something and then undid it. Adopting that value leaves
  // the tab SEMANTICALLY clean (sameDocument says so, and the maintained dirty
  // flag agrees) while its bytes no longer match the document on disk, and the
  // next switch, edit or save then writes the whole file out as LF - a silent
  // rewrite of every line ending in a document the reader never edited.
  //
  // `sameDocument` is what "this is still the file's text" means everywhere
  // else in this module, so it decides when the original bytes remain owner.
  // For a real edit, unchanged terminators come from the last exact tab value
  // and inserted lines inherit the nearest/dominant document convention.
  function splitNewlineSpellings(content) {
    const endings = new Map();
    let removedCarriageReturns = 0;
    // Only newline boundaries need positions; building an array of every
    // character makes a 2 MB editor fold expensive on the shutdown path.
    for (const match of content.matchAll(/\r\n|\r|\n/g)) {
      endings.set(match.index - removedCarriageReturns, match[0]);
      if (match[0] === "\r\n") removedCarriageReturns += 1;
    }
    return { normalised: normaliseNewlines(content), endings };
  }

  function preferredNewline(endings, before, after) {
    if (endings.has(before)) return endings.get(before);
    if (endings.has(after)) return endings.get(after);
    const counts = new Map();
    for (const ending of endings.values()) {
      counts.set(ending, (counts.get(ending) || 0) + 1);
    }
    let preferred = "\n";
    let preferredCount = 0;
    for (const [ending, count] of counts) {
      if (count > preferredCount) {
        preferred = ending;
        preferredCount = count;
      }
    }
    return preferred;
  }

  // Map unchanged lines through multiple disjoint edits. A single
  // prefix/suffix comparison cannot see unchanged material between two edits,
  // and would respell those internal line endings with the document default.
  // Myers' frontier is bounded because a wholesale rewrite has no useful
  // unchanged spelling to recover; ordinary typing and undo stay far below
  // this edit-distance ceiling.
  function matchingLines(contentLines, referenceLines) {
    if (contentLines.length === referenceLines.length) {
      const mismatches = [];
      const contentChanges = new Set();
      const referenceChanges = new Set();
      for (let index = 0; index < contentLines.length; index += 1) {
        if (contentLines[index] === referenceLines[index]) continue;
        mismatches.push(index);
        contentChanges.add(contentLines[index]);
        referenceChanges.add(referenceLines[index]);
      }
      const shifted = mismatches.some(
        (index) =>
          referenceChanges.has(contentLines[index]) ||
          contentChanges.has(referenceLines[index]),
      );
      if (!shifted) return true;
    }
    const comparisonLimit = 8 * 1024 * 1024;
    let comparisons = 0;
    const distanceLimit = Math.min(
      contentLines.length + referenceLines.length,
      256,
    );
    const offset = distanceLimit + 1;
    const frontier = new Int32Array(distanceLimit * 2 + 3);
    frontier.fill(-1);
    frontier[offset + 1] = 0;
    const trace = [];

    for (let distance = 0; distance <= distanceLimit; distance += 1) {
      trace.push(frontier.slice());
      for (
        let diagonal = -distance;
        diagonal <= distance;
        diagonal += 2
      ) {
        const frontierIndex = offset + diagonal;
        let contentIndex;
        if (
          diagonal === -distance ||
          (diagonal !== distance &&
            frontier[frontierIndex - 1] <
              frontier[frontierIndex + 1])
        ) {
          contentIndex = frontier[frontierIndex + 1];
        } else {
          contentIndex = frontier[frontierIndex - 1] + 1;
        }
        let referenceIndex = contentIndex - diagonal;
        while (
          contentIndex < contentLines.length &&
          referenceIndex < referenceLines.length &&
          contentLines[contentIndex] === referenceLines[referenceIndex]
        ) {
          comparisons += 1;
          if (comparisons > comparisonLimit) return null;
          contentIndex += 1;
          referenceIndex += 1;
        }
        comparisons += 1;
        if (comparisons > comparisonLimit) return null;
        frontier[frontierIndex] = contentIndex;
        if (
          contentIndex < contentLines.length ||
          referenceIndex < referenceLines.length
        ) {
          continue;
        }

        const matches = new Map();
        let backContent = contentLines.length;
        let backReference = referenceLines.length;
        for (let depth = distance; depth >= 0; depth -= 1) {
          const previous = trace[depth];
          const backDiagonal = backContent - backReference;
          const backIndex = offset + backDiagonal;
          const previousDiagonal =
            backDiagonal === -depth ||
            (backDiagonal !== depth &&
              previous[backIndex - 1] < previous[backIndex + 1])
              ? backDiagonal + 1
              : backDiagonal - 1;
          const previousContent = previous[offset + previousDiagonal];
          const previousReference =
            previousContent - previousDiagonal;
          while (
            backContent > previousContent &&
            backReference > previousReference
          ) {
            backContent -= 1;
            backReference -= 1;
            matches.set(backContent, backReference);
          }
          backContent = previousContent;
          backReference = previousReference;
        }
        return matches;
      }
    }
    return null;
  }

  function uniformNewlineEnding(content) {
    const hasCarriageReturn = content.includes("\r");
    const hasLineFeed = content.includes("\n");
    if (!hasCarriageReturn) return hasLineFeed ? "\n" : null;
    if (!hasLineFeed) return "\r";
    let uniform = null;
    for (const match of content.matchAll(/\r\n|\r|\n/g)) {
      if (uniform !== null && uniform !== match[0]) return null;
      uniform = match[0];
    }
    return uniform;
  }

  function mapConsensusLineEndings(
    contentLines,
    referenceLines,
    referenceLineEndings,
    matchedEndings,
    contentStart,
    contentEnd,
  ) {
    const consensus = new Map();
    for (
      let referenceLine = 0;
      referenceLine < referenceLineEndings.length;
      referenceLine += 1
    ) {
      const text = referenceLines[referenceLine];
      const ending = referenceLineEndings[referenceLine];
      if (!consensus.has(text)) {
        consensus.set(text, {
          ending,
          referenceLine,
          count: 1,
        });
      } else {
        const entry = consensus.get(text);
        entry.count += 1;
        if (entry.ending !== ending) entry.ending = null;
      }
    }

    const contentCounts = new Map();
    for (
      let contentLine = 0;
      contentLine < contentLines.length;
      contentLine += 1
    ) {
      const text = contentLines[contentLine];
      contentCounts.set(text, (contentCounts.get(text) || 0) + 1);
    }
    let ambiguous = 0;
    const matches = new Map();
    for (
      let contentLine = contentStart;
      contentLine < contentEnd && contentLine < matchedEndings.length;
      contentLine += 1
    ) {
      const text = contentLines[contentLine];
      if (!consensus.has(text)) continue;
      const entry = consensus.get(text);
      if (
        entry.ending &&
        entry.count === 1 &&
        contentCounts.get(text) === 1
      ) {
        matchedEndings[contentLine] = entry.ending;
        matches.set(contentLine, entry.referenceLine);
      } else {
        ambiguous += 1;
      }
    }
    return { ambiguous, matches };
  }

  // Preserve every unchanged raw line ending and use the nearest existing
  // convention for new/changed lines. Textarea input cannot tell CRLF, CR and
  // LF apart, so the tab's last exact spelling is the only valid authority.
  function restoreNewlineSpelling(content, exactReference) {
    if (
      typeof content !== "string" ||
      typeof exactReference !== "string" ||
      content.indexOf("\n") < 0
    ) {
      return content;
    }
    const normalisedContent = normaliseNewlines(content);
    // Uniform files need no line alignment. Keep the mixed-ending path below
    // for documents whose individual terminators carry distinct spelling.
    const uniformEnding = uniformNewlineEnding(exactReference);
    if (uniformEnding) {
      const result = uniformEnding === "\n"
        ? normalisedContent
        : normalisedContent.replace(/\n/g, uniformEnding);
      if (newlineAlignmentDiagnosticsEnabled) {
        reportNewlineAlignment(
          result.includes(uniformEnding) ? 1 : 0,
          fileHelpers.utf8ByteLength(content) +
            fileHelpers.utf8ByteLength(exactReference),
          "uniform",
        );
      }
      return result;
    }
    const reference = splitNewlineSpellings(exactReference);

    const referenceLineEndings = Array.from(reference.endings.values());
    let prefix = 0;
    const commonLength = Math.min(
      normalisedContent.length,
      reference.normalised.length,
    );
    while (
      prefix < commonLength &&
      normalisedContent[prefix] === reference.normalised[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < commonLength - prefix &&
      normalisedContent[normalisedContent.length - 1 - suffix] ===
        reference.normalised[reference.normalised.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const referenceSuffixStart = reference.normalised.length - suffix;
    const insertedEnding = preferredNewline(
      reference.endings,
      prefix - 1,
      referenceSuffixStart,
    );
    const contentLines = normalisedContent.split("\n");
    const referenceLines = reference.normalised.split("\n");
    const matchedEndings = new Array(
      Math.max(0, contentLines.length - 1),
    ).fill(null);

    let prefixLines = 0;
    while (
      prefixLines < contentLines.length &&
      prefixLines < referenceLines.length &&
      contentLines[prefixLines] === referenceLines[prefixLines]
    ) {
      if (
        prefixLines < matchedEndings.length &&
        prefixLines < referenceLineEndings.length
      ) {
        matchedEndings[prefixLines] = referenceLineEndings[prefixLines];
      }
      prefixLines += 1;
    }
    let suffixLines = 0;
    while (
      suffixLines < contentLines.length - prefixLines &&
      suffixLines < referenceLines.length - prefixLines &&
      contentLines[contentLines.length - 1 - suffixLines] ===
        referenceLines[referenceLines.length - 1 - suffixLines]
    ) {
      const contentLine = contentLines.length - 1 - suffixLines;
      const referenceLine = referenceLines.length - 1 - suffixLines;
      if (
        contentLine < matchedEndings.length &&
        referenceLine < referenceLineEndings.length
      ) {
        matchedEndings[contentLine] = referenceLineEndings[referenceLine];
      }
      suffixLines += 1;
    }

    const contentInteriorStart = prefixLines;
    const contentInteriorEnd = contentLines.length - suffixLines;
    const referenceInteriorStart = prefixLines;
    const referenceInteriorEnd = referenceLines.length - suffixLines;
    const interiorMatches = matchingLines(
      contentLines.slice(contentInteriorStart, contentInteriorEnd),
      referenceLines.slice(referenceInteriorStart, referenceInteriorEnd),
    );
    const lineMatches =
      interiorMatches === true
        ? true
        : interiorMatches
          ? new Map(
              Array.from(interiorMatches, ([contentLine, referenceLine]) => [
                contentLine + contentInteriorStart,
                referenceLine + referenceInteriorStart,
              ]),
            )
          : null;
    const alignmentMode =
      lineMatches === true
        ? "positional"
        : lineMatches
          ? prefixLines > 0 || suffixLines > 0
            ? "trimmed-myers"
            : "myers"
          : "content-consensus";
    if (lineMatches === true) {
      const interiorLength = contentInteriorEnd - contentInteriorStart;
      for (let offset = 0; offset < interiorLength; offset += 1) {
        const contentLine = contentInteriorStart + offset;
        const referenceLine = referenceInteriorStart + offset;
        if (
          contentLine < matchedEndings.length &&
          referenceLine < referenceLineEndings.length
        ) {
          matchedEndings[contentLine] =
            referenceLineEndings[referenceLine] || null;
        }
      }
    } else if (lineMatches) {
      const orderedMatches = Array.from(lineMatches.entries()).sort(
        (left, right) => left[0] - right[0],
      );
      let previousContentLine = prefixLines - 1;
      let previousReferenceLine = prefixLines - 1;
      for (const [contentLine, referenceLine] of [
        ...orderedMatches,
        [contentInteriorEnd, referenceInteriorEnd],
      ]) {
        const contentGap = contentLine - previousContentLine - 1;
        const referenceGap = referenceLine - previousReferenceLine - 1;
        if (contentGap === referenceGap) {
          for (let offset = 0; offset < contentGap; offset += 1) {
            const contentBoundary =
              previousContentLine + offset + 1;
            const referenceBoundary =
              previousReferenceLine + offset + 1;
            if (
              contentBoundary < matchedEndings.length &&
              referenceBoundary < referenceLineEndings.length &&
              !matchedEndings[contentBoundary]
            ) {
              matchedEndings[contentBoundary] =
                referenceLineEndings[referenceBoundary];
            }
          }
        }
        previousContentLine = contentLine;
        previousReferenceLine = referenceLine;
      }
      for (const [contentLine, referenceLine] of orderedMatches) {
        if (
          contentLine > 0 &&
          referenceLine > 0 &&
          !matchedEndings[contentLine - 1]
        ) {
          matchedEndings[contentLine - 1] =
            referenceLineEndings[referenceLine - 1];
        }
        if (
          contentLine < matchedEndings.length &&
          referenceLine < referenceLineEndings.length &&
          !matchedEndings[contentLine]
        ) {
          matchedEndings[contentLine] =
            referenceLineEndings[referenceLine];
        }
      }
      // A replacement line is not text-equal, but when an unmatched run is
      // the same length on both sides it is a positional substitution rather
      // than an insertion/deletion. Its terminator still belongs to that line
      // and keeps the reference spelling.
      const anchors = Array.from(lineMatches.entries())
        .sort((left, right) => left[0] - right[0]);
      anchors.unshift([prefixLines - 1, prefixLines - 1]);
      anchors.push([contentInteriorEnd, referenceInteriorEnd]);
      for (let anchor = 1; anchor < anchors.length; anchor += 1) {
        const previous = anchors[anchor - 1];
        const next = anchors[anchor];
        const contentGap = next[0] - previous[0] - 1;
        const referenceGap = next[1] - previous[1] - 1;
        if (contentGap <= 0 || contentGap !== referenceGap) continue;
        for (let gap = 1; gap <= contentGap; gap += 1) {
          const contentLine = previous[0] + gap;
          const referenceLine = previous[1] + gap;
          if (
            contentLine < matchedEndings.length &&
            referenceLine < referenceLineEndings.length
          ) {
            matchedEndings[contentLine] =
              referenceLineEndings[referenceLine];
          }
        }
      }
    }
    const consensusResult = mapConsensusLineEndings(
      contentLines,
      referenceLines,
      referenceLineEndings,
      matchedEndings,
      contentInteriorStart,
      contentInteriorEnd,
    );
    if (lineMatches === null) {
      const anchors = Array.from(consensusResult.matches.entries()).sort(
        (left, right) => left[0] - right[0],
      );
      anchors.unshift([prefixLines - 1, prefixLines - 1]);
      anchors.push([contentInteriorEnd, referenceInteriorEnd]);
      for (let anchor = 1; anchor < anchors.length; anchor += 1) {
        const previous = anchors[anchor - 1];
        const next = anchors[anchor];
        const contentGap = next[0] - previous[0] - 1;
        const referenceGap = next[1] - previous[1] - 1;
        if (contentGap <= 0 || contentGap !== referenceGap) continue;
        for (let offset = 1; offset <= contentGap; offset += 1) {
          const contentLine = previous[0] + offset;
          const referenceLine = previous[1] + offset;
          if (
            contentLine < matchedEndings.length &&
            referenceLine < referenceLineEndings.length &&
            !matchedEndings[contentLine]
          ) {
            matchedEndings[contentLine] =
              referenceLineEndings[referenceLine];
          }
        }
      }
    }
    const ambiguousBoundaries = consensusResult.ambiguous;
    // Identical textarea lines carry no identity. When copies of a line had
    // different raw terminators and the number of copies changed, neither a
    // Myers tie-break nor a nearest-neighbour guess can prove which original
    // copy survived. Refuse rather than silently respell unchanged bytes.
    const referenceSpellings = new Map();
    const referenceCounts = new Map();
    const contentCounts = new Map();
    for (let index = 0; index < referenceLineEndings.length; index += 1) {
      const text = referenceLines[index];
      const spellings = referenceSpellings.get(text) || new Set();
      spellings.add(referenceLineEndings[index]);
      referenceSpellings.set(text, spellings);
      referenceCounts.set(text, (referenceCounts.get(text) || 0) + 1);
    }
    for (const text of contentLines) {
      contentCounts.set(text, (contentCounts.get(text) || 0) + 1);
    }
    let interiorTexts = null;
    for (const [text, spellings] of referenceSpellings) {
      if (spellings.size < 2) continue;
      if (lineMatches !== true && !interiorTexts) {
        interiorTexts = new Set();
        for (
          let index = contentInteriorStart;
          index < contentInteriorEnd;
          index += 1
        ) {
          interiorTexts.add(contentLines[index]);
        }
        for (
          let index = referenceInteriorStart;
          index < referenceInteriorEnd;
          index += 1
        ) {
          interiorTexts.add(referenceLines[index]);
        }
      }
      if (
        (referenceCounts.get(text) !== (contentCounts.get(text) || 0) ||
          (lineMatches !== true &&
            interiorTexts.has(text)))
      ) {
        throw new Error(
          "Mixed-newline line identity is ambiguous; save was not sent.",
        );
      }
    }
    if (lineMatches === null) {
      for (
        let index = contentInteriorStart;
        index < contentInteriorEnd && index < matchedEndings.length;
        index += 1
      ) {
        if (
          !matchedEndings[index] &&
          referenceSpellings.has(contentLines[index])
        ) {
          throw new Error(
            "Mixed-newline alignment exceeded its proof limit; save was not sent.",
          );
        }
      }
    }
    const previousMatched = new Array(matchedEndings.length).fill(-1);
    const nextMatched = new Array(matchedEndings.length).fill(-1);
    let nearest = -1;
    for (let line = 0; line < matchedEndings.length; line += 1) {
      if (matchedEndings[line]) nearest = line;
      previousMatched[line] = nearest;
    }
    nearest = -1;
    for (let line = matchedEndings.length - 1; line >= 0; line -= 1) {
      if (matchedEndings[line]) nearest = line;
      nextMatched[line] = nearest;
    }
    const restored = [];
    let restoredSpans = 0;
    let previousEndingRestored = false;
    let line = 0;
    for (let index = 0; index < normalisedContent.length; index += 1) {
      if (normalisedContent[index] !== "\n") {
        restored.push(normalisedContent[index]);
        continue;
      }
      let ending = null;
      let endingRestored = false;
      if (!ending && matchedEndings[line]) {
        ending = matchedEndings[line];
        endingRestored = true;
      }
      if (!ending) {
        const previousLine = previousMatched[line];
        const nextLine = nextMatched[line];
        const nearestLine =
          previousLine >= 0 &&
          (nextLine < 0 || line - previousLine <= nextLine - line)
            ? previousLine
            : nextLine;
        if (nearestLine >= 0) ending = matchedEndings[nearestLine];
      }
      if (endingRestored && !previousEndingRestored) restoredSpans += 1;
      previousEndingRestored = endingRestored;
      restored.push(ending || insertedEnding);
      line += 1;
    }
    const result = restored.join("");
    if (newlineAlignmentDiagnosticsEnabled) {
      reportNewlineAlignment(
        restoredSpans,
        fileHelpers.utf8ByteLength(content) +
          fileHelpers.utf8ByteLength(exactReference),
        alignmentMode,
        lineMatches === null,
        ambiguousBoundaries,
      );
    }
    return result;
  }

  function cachedSpellingFor(tab, content, differentFromCache = false) {
    if (typeof content !== "string") return content;
    const original = tab.originalContent;
    if (typeof original === "string" && sameDocument(content, original)) {
      return original;
    }
    if (typeof tab.content === "string") {
      if (!differentFromCache && sameDocument(content, tab.content)) {
        return tab.content;
      }
      try {
        // The cache comparison above (or the caller's fold guard) already
        // established this is a real edit; alignment must not repeat it.
        return restoreNewlineSpelling(content, tab.content);
      } catch (error) {
        notify(error.message, 6000);
        throw error;
      }
    }
    return content;
  }

  function foldDocumentContent(tab, content) {
    const cached = cachedSpellingFor(tab, content, true);
    const state = documentState.get(tab);
    if (!state || cached === tab.originalContent) {
      tab.content = cached;
      return;
    }
    if (!mayMutateDocument("tab:content-setter")) return;
    // cachedSpellingFor returns the original string for semantic equality.
    // Otherwise it has already proved the edit dirty; the accessor would
    // compare the entire document with the same baseline a second time.
    state.content = cached;
    state.dirty = true;
    bumpDocumentRevision(tab);
  }

  // Content and fold witness move together. A site that puts a value into the
  // cache AND knows the live document now holds that same value must say so in
  // ONE step: leaving the witness behind makes the next fold believe the live
  // copy has not moved, so an undo back to the witness's value is skipped and
  // the abandoned text survives - the resurrection defect, re-entered through a
  // different door.
  //
  // The witness records the LIVE value, not the cached one: it answers "has the
  // live document moved since the last fold?", and the live document really is
  // the normalised copy even when the cache keeps the file's own spelling of
  // the same text.
  function adoptDocumentContent(tab, content) {
    if (!mayMutateDocument("tab:adopt-document-content")) return false;
    tab.content = cachedSpellingFor(tab, content);
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
    // Windows ctime-only drift is not a content change. A same-size edit
    // with restored mtime remains a deferred risk (ctime-byte-witness).
    return !!(
      left &&
      right &&
      Number.isFinite(left.ctimeMs) &&
      Number.isFinite(right.ctimeMs) &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs
    );
  }

  function getDiskVersion(filePath) {
    try {
      return window.fs
        ? diskVersionFromStats(window.fs.statSync(filePath))
        : null;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        console.error("[CustomTabs] Could not inspect disk version:", error);
      }
      return null;
    }
  }

  function getMtime(filePath) {
    const version = getDiskVersion(filePath);
    return version ? version.mtimeMs : null;
  }

  function diskVersionForAdoption(filePath, modifiedTime, suppliedVersion) {
    const supplied = normaliseDiskVersion(suppliedVersion);
    if (suppliedVersion != null && !supplied) return null;
    if (supplied && Number.isFinite(modifiedTime) &&
        supplied.mtimeMs !== modifiedTime) return null;
    const current = getDiskVersion(filePath);
    if (!current || (Number.isFinite(modifiedTime) &&
        current.mtimeMs !== modifiedTime)) return null;
    return supplied
      ? sameDiskVersion(supplied, current) ? supplied : null
      : current;
  }

  // Reading a file in the renderer must produce byte-identical text to
  // main.js's `readMarkdownFile()` (file-helpers.js), otherwise a tab read here
  // disagrees with the same tab opened through the normal IPC path. That
  // matters for .mmd/.mermaid/.ow files, which main wraps in a fenced block:
  // read raw, the fence is lost and the diagram source is rendered as plain
  // text. Three overlay paths read from disk directly - auto-refresh on tab
  // switch, session restore, and multi-file open - so all three were affected.
  //
  function normaliseFileContent(content, filePath) {
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

  function matchesDiskAdoptionApproval(
    approval, tab, filePath, content, diskVersion,
    { applied = false, reservedIdentity = null } = {},
  ) {
    const incoming = normaliseTabPath(filePath);
    const version = normaliseDiskVersion(diskVersion);
    const tabState = tab && documentState.get(tab);
    const expectedGeneration = applied
      ? tabState && tabState.generation
      : approval && approval.replaceDocument
        ? reservedIdentity
          ? reservedIdentity.documentGeneration
          : nextDocumentGeneration + 1
        : tabState && tabState.generation;
    return !!(
      approval &&
      approval.committed === true &&
      typeof approval.capability === "string" &&
      incoming &&
      approval.incomingSpelling === incoming.spelling &&
      approval.ownerSpelling ===
        (tab ? tabSpellingKey(tab) : incoming.spelling) &&
      approval.tabId === (tab
        ? tab.id
        : reservedIdentity
          ? reservedIdentity.tabId
          : tabIdCounter + 1) &&
      approval.documentGeneration === expectedGeneration &&
      approval.pathKey === resolveTabPath(filePath) &&
      sameDiskVersion(approval.version, version) &&
      approval.content === content &&
      (applied
        ? appliedDiskAdoptionApprovals.has(approval) &&
          !handedOffDiskAdoptionApprovals.has(approval)
        : !appliedDiskAdoptionApprovals.has(approval))
    );
  }

  function snapshotTabAdoption(tab, sourcePath) {
    const state = documentState.get(tab);
    const spelling = normaliseTabPath(sourcePath).spelling;
    return {
      content: state.content,
      originalContent: state.originalContent,
      dirty: state.dirty,
      foldedLive: state.foldedLive,
      reloadConflict: state.reloadConflict,
      saveFailure: state.saveFailure,
      deletionTombstone: state.deletionTombstone,
      generation: state.generation,
      pathKey: state.pathKey,
      admission: state.admission,
      diskVersion: tab.diskVersion,
      mtimeMs: tab.mtimeMs,
      hasUnsavedChanges: tab.hasUnsavedChanges,
      spelling,
      hadAlias: tabPathAliases.has(spelling),
      alias: tabPathAliases.get(spelling),
    };
  }

  function restoreTabAdoption(tab, prior) {
    const state = documentState.get(tab);
    for (const key of [
      "content", "originalContent", "dirty", "foldedLive",
      "reloadConflict", "saveFailure", "deletionTombstone",
      "generation", "pathKey", "admission",
    ]) {
      state[key] = prior[key];
    }
    tab.diskVersion = prior.diskVersion;
    tab.mtimeMs = prior.mtimeMs;
    tab.hasUnsavedChanges = prior.hasUnsavedChanges;
    if (prior.hadAlias) tabPathAliases.set(prior.spelling, prior.alias);
    else tabPathAliases.delete(prior.spelling);
    bumpDocumentRevision(tab);
  }

  function completeDiskAdoption(approval, tab, filePath) {
    const session = window.getReloadRequestSession();
    const identity = documentIdentity(tab, session);
    const result = identity &&
      typeof window.completeDocumentDiskAdoption === "function"
      ? window.completeDocumentDiskAdoption({
          capability: approval.capability,
          pageSession: session,
          rendererGeneration: approval.rendererGeneration,
          filePath,
          ownerFilePath: tab.filePath,
          actualOwner: identity,
          revision: approval.revision,
        })
      : null;
    if (result && result.completed === true &&
        result.capability === approval.capability) {
      if (result.unresolvedEvidence === true) {
        console.error("[CustomTabs] Disk adoption left deletion evidence:", result);
        const state = documentState.get(tab);
        if (state) {
          state.reloadConflict = true;
          bumpTabMutationRevision(state);
        }
        tab.hasUnsavedChanges = isDirty(tab);
        notify("The file was read, but its earlier deletion remains unresolved. Keep the earlier copy.", 8000);
      }
      return true;
    }
    console.error("[CustomTabs] Disk adoption completion refused:", result);
    notify("Disk adoption was refused. The earlier copy was kept.", 6000);
    return false;
  }

  function abandonDiskAdoption(capability) {
    if (typeof window.abandonDocumentDiskAdoption === "function") {
      window.abandonDocumentDiskAdoption(
        capability, approvalRendererGeneration,
      );
    }
  }

  function restoreNavigationAfterFailedAdoption(prior) {
    if (!prior) return;
    if (
      typeof window.restoreFileOpenNavigation !== "function" ||
      !window.restoreFileOpenNavigation(prior)
    ) {
      console.error("[CustomTabs] Could not restore superseded navigation");
      notify("Navigation changed during adoption; the earlier copy was kept.", 6000);
    }
  }

  function removeUnactivatedTab(tab) {
    const index = tabs.indexOf(tab);
    if (index < 0 || tab.id === activeTabId) return false;
    tabs.splice(index, 1);
    largeConfirmed.delete(tab.id);
    bumpDocumentRevision(tab);
    renderTabs();
    saveTabs();
    return true;
  }

  async function verifyDiskAdoption(
    tab, filePath, content, modifiedTime, diskVersion,
    {
      allowPathReplacement = false,
      replaceDocument = true,
      stillCurrent = null,
      reservedIdentity = null,
      allowUnsavedMutation = null,
      documentAdmission = null,
    } = {},
  ) {
    const supplied = normaliseDiskVersion(diskVersion);
    const tabState = tab && documentState.get(tab);
    const admission = documentAdmission || tabState?.admission;
    // This proposes an admitted identity; only Main attests its current binding.
    const freshKey = admission?.pathKey;
    const boundKey = tabState?.pathKey;
    const retargeted = !!boundKey && boundKey !== freshKey;
    const previousGeneration = tabState && tabState.generation;
    const previousMutationRevision =
      tabState && tabState.mutationRevision;
    const previousContent = tab && tab.content;
    const previousLive = tab && tab.id === activeTabId
      ? liveDocument()
      : null;
    if (
      typeof content !== "string" ||
      !supplied ||
      !Number.isFinite(modifiedTime) ||
      supplied.mtimeMs !== modifiedTime ||
      typeof freshKey !== "string" || !freshKey || freshKey.includes("\0") ||
      !admission || !/^[a-f0-9]{64}$/.test(admission.ref) ||
      (tab && (!tabs.includes(tab) || !boundKey)) ||
      (retargeted && !allowPathReplacement) ||
      typeof window.prepareDocumentDiskAdoption !== "function" ||
      typeof window.commitDocumentDiskAdoption !== "function" ||
      typeof window.folia?.checkCommittedDiskAdoption !== "function"
    ) {
      notify("The file target changed. The in-memory copy was kept.", 6000);
      return null;
    }
    const session =
      typeof window.getReloadRequestSession === "function"
        ? window.getReloadRequestSession()
        : null;
    const identity = tab
      ? documentIdentity(tab, session)
      : {
          pageSession: session,
          rendererGeneration: approvalRendererGeneration,
          tabId: null,
        };
    if (!identity || !session) {
      notify("Document ownership is not ready; retry opening this file.", 6000);
      return null;
    }
    const proposedGeneration = tab && !replaceDocument
      ? tabState.generation
      : reservedIdentity
        ? reservedIdentity.documentGeneration
        : nextDocumentGeneration + 1;
    const proposedTabId = tab
      ? tab.id
      : reservedIdentity
        ? reservedIdentity.tabId
        : tabIdCounter + 1;
    if (
      reservedIdentity &&
      (reservedIdentity.tabId !== proposedTabId ||
        reservedIdentity.documentGeneration !== proposedGeneration)
    ) {
      notify("The document identity moved before disk verification.", 6000);
      return null;
    }
    let contentDigest;
    let state;
    let preparation;
    try {
      const digest = await window.crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(content),
      );
      contentDigest = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      preparation = Object.freeze({
        filePath,
        ownerFilePath: tab ? tab.filePath : filePath,
        pageSession: session,
        rendererGeneration: approvalRendererGeneration,
        tabId: identity.tabId,
        documentGeneration: identity.documentGeneration,
        pathKey: identity.pathKey,
        ...(identity.documentRef ? { documentRef: identity.documentRef } : {}),
        proposedOwner: {
          pageSession: session,
          rendererGeneration: approvalRendererGeneration,
          tabId: proposedTabId,
          documentGeneration: proposedGeneration,
          pathKey: freshKey,
          documentRef: admission.ref,
        },
        modifiedTime,
        diskVersion: supplied,
        contentDigest,
        replaceDocument,
      });
      for (let resolved = 0; resolved <= 128; resolved += 1) {
        state = await window.prepareDocumentDiskAdoption(preparation);
        if (
          !state ||
          state.why !== "resolve-historical-episode" ||
          typeof state.capability !== "string"
        ) break;
        if (
          (tab && (
            !tabs.includes(tab) ||
            tabState.generation !== previousGeneration ||
            tabState.mutationRevision !== previousMutationRevision ||
            tab.content !== previousContent ||
            (previousLive !== null && liveDocument() !== previousLive)
          )) ||
          (stillCurrent && !stillCurrent()) ||
          isDocumentFrozen()
        ) {
          abandonDiskAdoption(state.capability);
          notify("The file moved before an older copy could be reviewed.", 6000);
          return null;
        }
        const outcome = window.commitDocumentDiskAdoption({
          ...preparation,
          oldOwner: tab ? identity : null,
          capability: state.capability,
          revision: state.revision,
        });
        if (
          !outcome ||
          outcome.why !== "resolved-historical-episode" ||
          !Number.isSafeInteger(outcome.revision) ||
          outcome.revision <= state.revision
        ) {
          abandonDiskAdoption(state.capability);
          console.error("[CustomTabs] Earlier copy was retained:", outcome);
          notify("An older file copy was kept. No document was replaced.", 6000);
          return null;
        }
        if (resolved === 128) {
          console.error("[CustomTabs] Too many historical file targets");
          notify("Review older file copies before reopening this document.", 6000);
          return null;
        }
      }
    } catch (error) {
      console.error("[CustomTabs] Could not attest document bytes:", error);
      notify("The file could not be verified. The in-memory copy was kept.", 6000);
      return null;
    }
    if (
      !state ||
      state.known !== true ||
      state.versionMatches !== true ||
      state.pathKey !== freshKey ||
      !Number.isSafeInteger(state.revision) ||
      typeof state.capability !== "string"
    ) {
      if (state && state.capability) {
        abandonDiskAdoption(state.capability);
      }
      console.error("[CustomTabs] Disk adoption attestation refused:", state);
      notify(
        state && state.why === "live-sibling-deletion-evidence"
          ? "Another open copy still depends on the earlier deletion. Review that tab first."
          : state && state.why === "matched-owner-deletion-evidence"
            ? "Another open tab acquired deletion evidence. Its copy was kept; retry opening this file."
          : "Disk adoption could not be verified. The in-memory copy was kept.",
        6000,
      );
      return null;
    }
    if (
      (tab && (
        !tabs.includes(tab) ||
        tabState.generation !== previousGeneration ||
        tabState.mutationRevision !== previousMutationRevision ||
        tab.content !== previousContent ||
        (previousLive !== null && liveDocument() !== previousLive) ||
        ((hasUnsavedMutation(tab) || tabState.saveFailure) &&
          !(allowUnsavedMutation && allowUnsavedMutation()))
      )) ||
      (stillCurrent && !stillCurrent()) ||
      isDocumentFrozen()
    ) {
      abandonDiskAdoption(state.capability);
      notify("The file changed after confirmation. Nothing was replaced.", 6000);
      return null;
    }
    const committed = window.commitDocumentDiskAdoption({
      ...preparation,
      capability: state.capability,
      oldOwner: tab ? identity : null,
      revision: state.revision,
    });
    if (
      !committed ||
      committed.accepted !== true ||
      committed.capability !== state.capability ||
      committed.pathKey !== freshKey ||
      committed.incomingSpelling !== normaliseTabPath(filePath).spelling ||
      committed.ownerSpelling !==
        (tab ? tabSpellingKey(tab) : normaliseTabPath(filePath).spelling) ||
      committed.tabId !== proposedTabId ||
      committed.documentGeneration !== proposedGeneration ||
      committed.contentDigest !== contentDigest ||
      !sameDiskVersion(committed.version, supplied)
    ) {
      abandonDiskAdoption(state.capability);
      console.error("[CustomTabs] Disk adoption was refused:", committed);
      notify("The file changed before adoption. The in-memory copy was kept.", 6000);
      return null;
    }
    let checked;
    try {
      checked = window.folia.checkCommittedDiskAdoption({
        capability: committed.capability,
        pageSession: session,
        rendererGeneration: approvalRendererGeneration,
      });
    } catch (error) {
      abandonDiskAdoption(committed.capability);
      console.error("[CustomTabs] Could not check committed disk adoption:", error);
      notify("The file could not be verified after approval. Nothing was replaced.", 6000);
      return null;
    }
    if (
      !checked || checked.valid !== true || checked.pathKey !== freshKey ||
      !sameDiskVersion(checked.version, supplied) ||
      (tab && (
        !tabs.includes(tab) ||
        tabState.generation !== previousGeneration ||
        tabState.mutationRevision !== previousMutationRevision ||
        tab.content !== previousContent ||
        (previousLive !== null && liveDocument() !== previousLive) ||
        ((hasUnsavedMutation(tab) || tabState.saveFailure) &&
          !(allowUnsavedMutation && allowUnsavedMutation()))
      )) ||
      (stillCurrent && !stillCurrent()) ||
      isDocumentFrozen()
    ) {
      abandonDiskAdoption(state.capability);
      notify("The file changed after approval. Nothing was replaced.", 6000);
      return null;
    }
    return Object.freeze({
      ...committed,
      committed: true,
      rendererGeneration: approvalRendererGeneration,
      replaceDocument,
      content,
      reservedIdentity,
    });
  }

  // Pull newer content off disk into the tab's cache. Returns true when the
  // cached copy was replaced.
  function refreshTabFromDisk(
    tab, stillCurrent = null, { deferCompletion = false } = {},
  ) {
    if (!tab) return false;
    // Never discard edits the user has not saved yet.
    if (isDirty(tab)) return false;
    const state = documentState.get(tab);
    const startingGeneration = state && state.generation;
    if (state && state.deletionTombstone) return false;
    const filePath = tab.filePath;
    const session = window.getReloadRequestSession?.();
    const identity = state && state.pathKey && state.admission &&
      documentIdentity(tab, session);
    const startingVersion = normaliseDiskVersion(tab.diskVersion);
    if (!identity || !startingVersion) {
      console.error("[CustomTabs] Cannot refresh a tab without document ownership");
      return false;
    }
    const startingMutationRevision = state.mutationRevision;
    const startingContent = tab.content;
    // The renderer remains live while the owned read crosses IPC. The tab
    // cache was folded before this refresh began, so neither its dirty bit nor
    // its generation can witness an edit made in that gap. Keep both the live
    // value and its mutation revision: the value catches an outstanding edit,
    // while the revision catches edit-then-undo back to the same text.
    const activeReadWitness = tab.id === activeTabId && state
      ? Object.freeze({
          live: liveDocument(),
          mutationRevision: state.mutationRevision,
        })
      : null;
    const refreshRequestStillCurrent = () => {
      const stillOwned = state.pathKey && documentIdentity(tab, session);
      return !(
        isDocumentFrozen() ||
        (stillCurrent && !stillCurrent()) ||
        !tabs.includes(tab) ||
        tab.filePath !== filePath ||
        documentState.get(tab) !== state ||
        state.generation !== startingGeneration ||
        state.mutationRevision !== startingMutationRevision ||
        tab.content !== startingContent ||
        !sameDiskVersion(tab.diskVersion, startingVersion) ||
        state.deletionTombstone ||
        isDirty(tab) ||
        (activeReadWitness && (
          activeTabId !== tab.id ||
          liveDocument() !== activeReadWitness.live ||
          state.mutationRevision !== activeReadWitness.mutationRevision
        )) ||
        !stillOwned ||
        stillOwned.pageSession !== identity.pageSession ||
        stillOwned.rendererGeneration !== identity.rendererGeneration ||
        stillOwned.documentGeneration !== identity.documentGeneration ||
        stillOwned.pathKey !== identity.pathKey ||
        stillOwned.documentRef !== identity.documentRef
      );
    };
    let snapshot;
    let reservation;
    const readAndVerify = async () => {
      snapshot = await window.folia.refreshOwnedTabDiskSnapshot({
        filePath,
        pageSession: session,
        rendererGeneration: identity.rendererGeneration,
        owner: identity,
        diskVersion: startingVersion,
      });
      const current = refreshRequestStillCurrent();
      if (!snapshot) {
        if (current && stillCurrent) {
          state.reloadConflict = true;
          bumpDocumentRevision(tab);
          tab.hasUnsavedChanges = isDirty(tab);
          if (typeof window.markReloadConflict === "function") {
            window.markReloadConflict(filePath);
          }
          console.error("[CustomTabs] Owned refresh refused for current tab:", filePath);
          renderTabs();
          saveTabs();
          notify("The disk refresh was refused. The earlier copy is protected; retry the reload.", 8000);
        }
        return null;
      }
      if (!current) return null;
      if (snapshot.status !== "changed") return null;
      reservation = reserveDocumentIdentity(tab);
      if (!reservation) return null;
      return verifyDiskAdoption(
        tab,
        filePath,
        snapshot.content,
        snapshot.modifiedTime,
        snapshot.diskVersion,
        { stillCurrent, reservedIdentity: reservation },
      );
    };
    return readAndVerify().then((approval) => {
      if (!snapshot || !reservation) return false;
      let grantCompleted = false;
      let handedOff = false;
      try {
      if (!refreshRequestStillCurrent()) return false;
      if (
        !approval ||
        !matchesDiskAdoptionApproval(
          approval, tab, tab.filePath,
          snapshot.content, snapshot.diskVersion,
          { reservedIdentity: reservation },
        )
      ) {
        if (state) {
          state.reloadConflict = true;
          bumpDocumentRevision(tab);
        }
        tab.hasUnsavedChanges = isDirty(tab);
        return false;
      }
      const prior = snapshotTabAdoption(tab, tab.filePath);
      appliedDiskAdoptionApprovals.add(approval);
      if (!adoptCleanDocument(
        tab, snapshot.content, reservation.documentGeneration,
      )) {
        appliedDiskAdoptionApprovals.delete(approval);
        return false;
      }
      tab.mtimeMs = snapshot.modifiedTime;
      tab.diskVersion = snapshot.diskVersion;
      if (deferCompletion) {
        handedOff = true;
        return { approval, prior };
      }
      if (!completeDiskAdoption(approval, tab, tab.filePath)) {
        restoreTabAdoption(tab, prior);
        appliedDiskAdoptionApprovals.delete(approval);
        return false;
      }
      grantCompleted = true;
      registerTabDiskOwner(tab);
      if (!approvedReloadSnapshotMatches(
        approval, tab.filePath, tab.filePath,
      )) {
        const identity = documentIdentity(
          tab, window.getReloadRequestSession(),
        );
        if (state) {
          state.reloadConflict = true;
          bumpTabMutationRevision(state);
        }
        tab.hasUnsavedChanges = true;
        if (typeof window.reportAdoptionTrackingConflict === "function") {
          window.reportAdoptionTrackingConflict(tab.filePath, identity);
        }
        bumpDocumentRevision(tab);
        return false;
      }
      console.log("[CustomTabs] Reloaded from disk:", tab.filename);
      return approval;
      } finally {
        if (approval && !grantCompleted && !handedOff) {
          abandonDiskAdoption(approval.capability);
        }
      }
    }).catch((error) => {
      console.error("[CustomTabs] Failed to reload:", filePath, error);
      notify("The disk refresh failed. The in-memory copy was kept.", 6000);
      return false;
    });
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
    const reservation = opts.reservedIdentity || null;
    const pathParts = filePath.split(/[\\/]/);
    const filename = pathParts[pathParts.length - 1];

    const diskVersion = diskVersionForAdoption(
      filePath,
      opts.modifiedTime,
      opts.diskVersion,
    );
    if (
      (opts.diskVersion != null && !diskVersion) ||
      (reservation &&
        (!Number.isSafeInteger(reservation.tabId) ||
          !Number.isSafeInteger(reservation.documentGeneration) ||
          reservation.tabId <= 0 ||
          reservation.documentGeneration <= 0 ||
          reservation.tabId > tabIdCounter ||
          reservation.documentGeneration > nextDocumentGeneration ||
          tabs.some((existing) => existing.id === reservation.tabId))) ||
      (opts.verifiedDiskAdoption &&
        (!appliedDiskAdoptionApprovals.has(opts.verifiedDiskAdoption) ||
          opts.verifiedDiskAdoption.tabId !==
            (reservation ? reservation.tabId : tabIdCounter + 1) ||
          opts.verifiedDiskAdoption.documentGeneration !==
            (reservation
              ? reservation.documentGeneration
              : nextDocumentGeneration + 1) ||
          opts.verifiedDiskAdoption.incomingSpelling !==
            normaliseTabPath(filePath)?.spelling ||
          opts.verifiedDiskAdoption.pathKey !==
            resolveTabPath(filePath) ||
          !sameDiskVersion(
            opts.verifiedDiskAdoption.version,
            diskVersion,
          )))
    ) {
      notify("The file could not be verified before its tab was created.", 6000);
      return null;
    }
    const tabId = reservation ? reservation.tabId : ++tabIdCounter;
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
    const state = defineDocumentAccessors(
      tab, content,
      reservation ? reservation.documentGeneration : null,
    );
    state.admission = opts.documentAdmission || null;
    state.pathKey = opts.documentAdmission
      ? opts.documentAdmission.pathKey
      : opts.verifiedDiskAdoption
      ? opts.verifiedDiskAdoption.pathKey
      : canonicalTabPath(filePath);

    tabs.push(tab);
    if (!opts.deferOwnerRegistration) registerTabDiskOwner(tab);
    bumpDocumentRevision();
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
    if (opts.activate !== false) {
      switchToTab(tabId).catch((error) => {
        console.error("[CustomTabs] Could not activate new tab:", error);
        notify("The document could not be activated.", 6000);
      });
    }
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

      if (isDirty(tab)) {
        const unsavedDot = document.createElement("span");
        unsavedDot.className = "tab-unsaved";
        tabElement.appendChild(unsavedDot);
      }

      tabElement.appendChild(closeButton);

      tabElement.addEventListener("click", () => {
        switchToTab(tab.id).catch((error) => {
          console.error("[CustomTabs] Tab switch failed:", error);
          notify("The document could not be selected.", 6000);
        });
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
      //
      // THE CACHED COPY IS NOT THE ONLY THING THIS HAS TO PROTECT. A tab whose
      // cache holds a REAL edit is a tab whose cache is not the file, so the
      // test above passes the moment the reader undoes that edit in the
      // textarea - and the undone text is the LF copy, not the file's bytes.
      // Adopting it makes the tab read clean while it is byte-different from
      // disk, and the next switch, edit or save rewrites every CRLF in the
      // document. Semantic equality with the file is what "the reader undid
      // it" means, so the file's own string is what the cache takes back.
      const edited = window.markdownEditor.value;
      if (!sameDocument(edited, currentTab.content)) {
        foldDocumentContent(currentTab, edited);
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
          foldDocumentContent(currentTab, live);
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
  let latestTabSwitchIntent = 0;

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
      proceed = window.folia.confirmLargeRender({
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
   *   fileOpenOptions?: object,
   *   onTrackingRefused?: function,
   *   onTrackingCommitted?: function
   * }} [options] - silent suppresses the large-document MODAL only (see
   *   confirmLargeTab). fileOpenData marks an accepted main-process open whose
   *   renderer lifecycle must record navigation/recents exactly once.
   */
  async function switchToTab(tabId, options) {
    if (!mayMutateDocument("tab:switch")) return;
    const intent = ++latestTabSwitchIntent;
    if (pendingConfirmedReload) pendingConfirmedReload.invalidated = true;
    const selectedAtStart = activeTabId;
    const opts = options || {};
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (pendingActivationTabs.has(tab) && !opts.fileOpenData) {
      notify("This file is still being verified. Retry switching when its open completes.", 4000);
      return false;
    }
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

    let autoReloaded = false;
    let ownApproval = null;
    let ownAdoptionRestored = false;
    let refusedAutoRefresh = false;
    let trackingCommitted = false;
    try {
    if (!opts.skipSnapshot) snapshotActiveTab();

    let protectedState = isDirty(tab);

    // The file may have been rewritten while this tab sat in the background.
    // Pick that up now so switching never repaints a stale copy.
    const maybeReloaded = opts.fileOpenData
      ? false
      : refreshTabFromDisk(
          tab,
          () => intent === latestTabSwitchIntent &&
            activeTabId === selectedAtStart &&
            tabs.includes(tab),
          { deferCompletion: true },
        );
    const waited = !!maybeReloaded &&
      typeof maybeReloaded.then === "function";
    autoReloaded = waited
      ? await maybeReloaded
      : maybeReloaded;
    if (autoReloaded) ownApproval = autoReloaded.approval;
    if (
      intent !== latestTabSwitchIntent ||
      activeTabId !== selectedAtStart ||
      !tabs.includes(tab) ||
      isDocumentFrozen()
    ) {
      return;
    }
    // An active tab just refreshed from disk has a newer cache than the
    // still-unmoved renderer. Folding that old renderer copy now would turn
    // the new disk baseline into an apparent edit.
    if (waited && !opts.skipSnapshot &&
        !(autoReloaded && tabId === activeTabId)) {
      snapshotActiveTab();
    }
    protectedState = isDirty(tab);
    let adoptionApproval =
      opts.fileOpenOptions &&
      opts.fileOpenOptions.deletionAdoptionApproval;
    if (!opts.fileOpenData && !autoReloaded &&
        opts.fileOpenOptions &&
        opts.fileOpenOptions.adoptPathIdentity === true &&
        !protectedState) {
      adoptionApproval = await verifyDiskAdoption(
        tab, tab.filePath, tab.content, tab.mtimeMs, tab.diskVersion,
        {
          replaceDocument: false,
          stillCurrent: () =>
            intent === latestTabSwitchIntent &&
            activeTabId === selectedAtStart &&
            tabs.includes(tab),
        },
      );
      ownApproval = adoptionApproval;
      if (!adoptionApproval) return;
      if (
        intent !== latestTabSwitchIntent ||
        activeTabId !== selectedAtStart ||
        !tabs.includes(tab) ||
        isDocumentFrozen()
      ) {
        return;
      }
    }
    if (autoReloaded) adoptionApproval = autoReloaded.approval;
    protectedState = isDirty(tab);
    const sourcePath = opts.fileOpenData
      ? opts.fileOpenData.path
      : tab.filePath;
    const adoptsDisk = !!autoReloaded ||
      !!(opts.fileOpenOptions && opts.fileOpenOptions.adoptPathIdentity);
    const alreadyApplied = !!autoReloaded || !!opts.fileOpenData;
    if (!protectedState && adoptsDisk) {
      if (!matchesDiskAdoptionApproval(
        adoptionApproval, tab, sourcePath, tab.content,
        tab.diskVersion, { applied: alreadyApplied },
      )) {
        notify("The disk version or approval no longer belongs to this tab. The switch was refused.", 6000);
        if (typeof opts.onTrackingRefused === "function") {
          opts.onTrackingRefused();
        }
        return;
      }
      if (!alreadyApplied) {
        appliedDiskAdoptionApprovals.add(adoptionApproval);
      }
    }
    if (
      adoptionApproval &&
      (typeof window.beginFileOpen !== "function" ||
        typeof window.completeFileOpen !== "function")
    ) {
      notify("The document cannot be verified for this switch. Its earlier copy was kept.", 6000);
      if (typeof opts.onTrackingRefused === "function") {
        opts.onTrackingRefused();
      }
      return false;
    }

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
      const lifecycleOptions = {
        source: opts.fileOpenData ? "ipc-file-opened" : "tab-switch",
        recordNavigation: !!opts.fileOpenData,
        recordRecents: !!opts.fileOpenData,
        normalScroll: "caller",
        clearFailedSave:
          (!!autoReloaded ||
            !!opts.fileOpenData ||
            !!(opts.fileOpenOptions &&
              opts.fileOpenOptions.adoptPathIdentity === true)) &&
          !protectedState,
        preserveEditBaseline: !opts.fileOpenData && !autoReloaded,
        hasUnsavedChanges: tab.hasUnsavedChanges,
        trackingActive: !protectedState,
        ...(opts.fileOpenLifecycleOptions || {}),
        ...(opts.fileOpenOptions || {}),
        adoptPathIdentity:
          !!autoReloaded ||
          !!(opts.fileOpenOptions &&
            opts.fileOpenOptions.adoptPathIdentity),
        deletionAdoptionApproval: adoptionApproval || null,
        fileOpenSourcePath: sourcePath,
        // The document being selected belongs to THIS tab, which is not the
        // active one yet - `activeTabId` still names the tab being left. The
        // watcher ownership asserted inside beginFileOpen decides who an
        // external deletion is reported to, so it has to be told. Stated after
        // the caller's options rather than before: every other field here is
        // deliberately overridable, but the identity of the tab this open
        // belongs to is not a preference.
        ownerTabId: tab.id,
        onTrackingRefused: () => {
          if (autoReloaded && !ownAdoptionRestored) {
            restoreTabAdoption(tab, autoReloaded.prior);
            appliedDiskAdoptionApprovals.delete(autoReloaded.approval);
            ownAdoptionRestored = true;
          }
          if (typeof opts.onTrackingRefused === "function") {
            opts.onTrackingRefused();
          }
        },
        onTrackingCommitted: () => {
          trackingCommitted = true;
          if (typeof opts.onTrackingCommitted === "function") {
            opts.onTrackingCommitted();
          }
        },
      };
      queuePreHandshakeTrackingAssertion(
        tab,
        lifecycleData,
        lifecycleOptions,
        protectedState,
      );
      fileOpenContext = window.beginFileOpen(lifecycleData, lifecycleOptions);
      if (!fileOpenContext) {
        pendingHandshakeTrackingAssertion = null;
        if (adoptionApproval && !autoReloaded && !opts.fileOpenData &&
            !alreadyApplied) {
          appliedDiskAdoptionApprovals.delete(adoptionApproval);
        }
        if (adoptionApproval && !protectedState && !opts.fileOpenData) {
          if (autoReloaded) {
            refusedAutoRefresh = true;
          } else {
            const state = documentState.get(tab);
            if (state && !state.reloadConflict) {
              state.reloadConflict = true;
              bumpDocumentRevision(tab);
            }
            tab.hasUnsavedChanges = isDirty(tab);
            const identity = documentIdentity(
              tab, window.getReloadRequestSession(),
            );
            if (typeof window.reportAdoptionTrackingConflict === "function") {
              window.reportAdoptionTrackingConflict(
                tab.filePath, identity,
              );
            }
            renderTabs();
            saveTabs();
          }
        }
        return false;
      }
      if (fileOpenContext.unresolvedEvidence === true ||
          fileOpenContext.postSelectionPathConflict === true) {
        const state = documentState.get(tab);
        if (state) {
          state.reloadConflict = true;
          bumpTabMutationRevision(state);
        }
        tab.hasUnsavedChanges = isDirty(tab);
      }
      if (adoptionApproval && !protectedState) {
        handedOffDiskAdoptionApprovals.add(adoptionApproval);
      }
    }

    activeTabId = tabId;
    activeTabForMutations = tab;
    console.log("[CustomTabs] Switched to tab:", tab.filename);

    // Any pending "File Updated - Reload?" prompt belongs to the tab we just
    // left, or to this tab's pre-reload state. Either way it is now stale.
    dismissUpdatePrompt();
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
        if (adoptionApproval && !approvedReloadSnapshotMatches(
          adoptionApproval, sourcePath, tab.filePath,
        )) {
          if (!mayMutateDocument("render:approved-open-conflict")) return;
          const state = documentState.get(tab);
          if (state && tabs.includes(tab) &&
              state.generation === adoptionApproval.documentGeneration) {
            state.reloadConflict = true;
            tab.hasUnsavedChanges = true;
            bumpDocumentRevision(tab);
            if (typeof window.markReloadConflict === "function") {
              window.markReloadConflict(tab.filePath);
            }
            if (typeof window.reportAdoptionTrackingConflict === "function") {
              window.reportAdoptionTrackingConflict(
                tab.filePath,
                fileOpenContext && fileOpenContext.approvedOwner,
              );
            }
            renderTabs();
            saveTabs();
          }
        }
        const restore = () => {
          if (
            generation === renderGeneration &&
            mayMutateDocument("render:restore-position")
          ) {
            restorePosition(position);
          }
        };
        if (fileOpenContext) {
          const completed = window.completeFileOpen(fileOpenContext, restore);
          if (completed && autoReloaded &&
              !isDirty(tab) &&
              generation === renderGeneration &&
              activeTabId === tabId) {
            notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
          }
        } else {
          restore();
        }
      }).catch((error) => {
        console.error("[CustomTabs] Could not render selected document:", error);
        const state = documentState.get(tab);
        if (adoptionApproval && state && tabs.includes(tab) &&
            state.generation === adoptionApproval.documentGeneration &&
            mayMutateDocument("render:approved-open-failure")) {
          state.reloadConflict = true;
          tab.hasUnsavedChanges = true;
          bumpDocumentRevision(tab);
          if (typeof window.markReloadConflict === "function") {
            window.markReloadConflict(tab.filePath);
          }
          if (!approvedReloadSnapshotMatches(
            adoptionApproval, sourcePath, tab.filePath,
          ) && typeof window.reportAdoptionTrackingConflict === "function") {
            window.reportAdoptionTrackingConflict(
              tab.filePath,
              fileOpenContext && fileOpenContext.approvedOwner,
            );
          }
          renderTabs();
          saveTabs();
        }
        notify(
          adoptionApproval && state && tabs.includes(tab)
            ? "The document could not be displayed. Its tab is protected; retry before saving."
            : "The document could not be displayed. Retry opening it.",
          8000,
        );
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
          !protectedState,
          {
            adoptBaseline: !protectedState,
            modifiedTime: tab.mtimeMs,
            diskVersion: tab.diskVersion,
            ownerTabId: tab.id,
          },
        );
      } else if (protectedState) {
        console.error(
          "[CustomTabs] Refusing legacy path-only watcher transition",
        );
      } else {
        console.error(
          "[CustomTabs] Refusing legacy path-only watcher transition",
        );
      }
    }

    saveTabs();
    return true;
    } finally {
      if (ownApproval && !trackingCommitted) {
        try {
          if (autoReloaded && !ownAdoptionRestored) {
            restoreTabAdoption(tab, autoReloaded.prior);
          }
          appliedDiskAdoptionApprovals.delete(ownApproval);
        } finally {
          abandonDiskAdoption(ownApproval.capability);
        }
      }
      if (refusedAutoRefresh && tabs.includes(tab) &&
          mayMutateDocument("tab:refused-auto-refresh")) {
        const state = documentState.get(tab);
        state.reloadConflict = true;
        tab.hasUnsavedChanges = true;
        bumpDocumentRevision(tab);
        if (typeof window.markReloadConflict === "function") {
          window.markReloadConflict(tab.filePath);
        }
        if (typeof window.reportAdoptionTrackingConflict === "function") {
          window.reportAdoptionTrackingConflict(
            tab.filePath,
            documentIdentity(tab, window.getReloadRequestSession()),
          );
        }
        renderTabs();
        saveTabs();
        notify("The file changed before its refreshed tab could be selected. The earlier copy is protected; retry the reload.", 8000);
      }
    }
  }

  // Mirrors main's safeFileLabel. A filename containing newlines would
  // otherwise forge the text of the confirm() the reader is about to answer,
  // and an absurdly long one pushes the buttons out of reach.
  function safeDocumentLabel(name) {
    const filename = String(name).split(/[\\/]/).pop();
    return filename.replace(/\s+/g, " ").slice(0, 120);
  }

  function consultDocumentDeletionState(filePath, identity) {
    if (typeof window.queryDocumentDeletionState !== "function") return null;
    const state = window.queryDocumentDeletionState(filePath, identity);
    // `known: false` means main could not authenticate this document, which is
    // not the same as "there is no deletion". Collapsed to one "no
    // authoritative answer" value so no caller can read an absent field as a
    // clean result.
    return state && typeof state === "object" && state.known === true
      ? state
      : null;
  }

  const closingTabs = new Set();

  async function closeTab(tabId) {
    if (!mayMutateDocument("tab:close")) return;
    if (closingTabs.has(tabId)) return;
    if (pendingConfirmedReload?.tab.id === tabId) {
      pendingConfirmedReload.invalidated = true;
    }
    closingTabs.add(tabId);
    try {
      let tabIndex = tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return;
      let tab = tabs[tabIndex];

      // A save belongs to the tab generation that issued it. Do not remove
      // that generation while its write can still land: reopening the same
      // path would otherwise let the old write overwrite the new tab.
      const pendingStatus =
        typeof window.getPendingSaveStatus === "function"
          ? window.getPendingSaveStatus(tab.filePath)
          : null;
      if (
        pendingStatus &&
        pendingStatus.pending &&
        typeof window.waitForPendingSaves === "function"
      ) {
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
      tab.hasUnsavedChanges = isDirty(tab);

      const state = documentState.get(tab);
      const deletionTombstone =
        state && state.deletionTombstone
          ? state.deletionTombstone
          : null;
      const dirty = isDirty(tab);
      const pageSession =
        typeof window.getReloadRequestSession === "function"
          ? window.getReloadRequestSession()
          : null;
      const closingIdentity = documentIdentity(tab, pageSession);
      if (!closingIdentity) {
        notify("Document ownership is not ready. Retry closing this tab.", 6000);
        return;
      }

      // THE RENDERER'S TOMBSTONE IS NOT THE DELETION STATE. It exists only
      // once a report was delivered AND consumed here, so a report that was
      // parked behind a freeze, compacted out of the delivery table, refused
      // as malformed, or still in flight is completely invisible to this side.
      // A clean tab in that state used to close with no deletion warning at
      // all, and then erase the evidence on the way out. Ask the side that
      // holds the records instead, before deciding what to warn about.
      //
      // Only a document main has an identity for can be asked about. One it
      // has no identity for cannot have an owner-scoped record either, so the
      // consumed tombstone remains the best available answer for it.
      const deletionState = closingIdentity
        ? consultDocumentDeletionState(tab.filePath, closingIdentity)
        : null;
      if (!deletionState) {
        notify("The deletion state could not be checked. Retry closing this tab.", 6000);
        return;
      }
      // The authoritative answer decides the wording BEFORE anything is
      // mutated. When main cannot authenticate this document at all it holds
      // no owner-scoped record for it either - the same envelope authenticates
      // both calls - so there is nothing it could be hiding, and the consumed
      // tombstone remains the best available answer. Anything main does know
      // that this side does not is caught by its refusal below, which is the
      // guarantee: evidence nobody was warned about is never erased.
      const deleted =
        !!deletionTombstone || !!(deletionState && deletionState.unresolved);
      const label = safeDocumentLabel(tab.filename);
      const closeWarning =
        dirty && deleted
          ? `"${label}" has unsaved changes and was deleted outside Folia. Close this unsaved in-memory copy anyway?`
          : dirty
            ? `"${label}" has unsaved changes. Close anyway?`
            : deleted
              ? `"${label}" was deleted outside Folia. Close this in-memory copy anyway?`
              : null;
      if (closeWarning && !confirm(closeWarning)) return;
      // What the reader was actually shown. Main will not erase deletion
      // evidence that nobody was warned about, and this is the only thing that
      // says they were.
      let deletionAcknowledged = !!closeWarning && deleted;

      // A consumed deletion notification leaves a durable owner tombstone in
      // main until this exact document adopts disk or closes. Retire it before
      // removing the tab: once the tab is gone there is no owner left that can
      // authenticate the event, and leaking one record per close eventually
      // exhausts the bounded delivery capacity.
      if (deletionTombstone || closingIdentity) {
        if (typeof window.retireDeletionTombstone !== "function") {
          notify(
            "The document could not be closed safely. Please try again.",
            4000,
          );
          return;
        } else {
          // Bounded at two attempts, and the second is only reached when main
          // reports evidence that appeared between the question above and this
          // call. Once the reader has confirmed, retirement is owner-scoped and
          // authoritative, so an already-confirmed close is never made to wait
          // on a state that keeps moving.
          let outcome = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            outcome = window.retireDeletionTombstone(
              tab.filePath,
              closingIdentity,
              deletionTombstone,
              {
                acknowledgedDeletion: deletionAcknowledged,
              },
            );
            if (outcome && outcome.retired === true) break;
            if (
              !outcome ||
              outcome.why !== "deletion-unacknowledged" ||
              deletionAcknowledged
            ) {
              break;
            }
            if (
              !confirm(
                `"${label}" was deleted outside Folia. Close this in-memory copy anyway?`,
              )
            ) {
              notify("The file became unavailable or changed before adoption.", 6000);
              return;
            }
            deletionAcknowledged = true;
          }
          if (!outcome || outcome.retired !== true) {
            notify(
              "The document could not be closed safely. Please try again.",
              4000,
            );
            return;
          }
        }
      }

      console.log("[CustomTabs] Closing tab:", tab.filename);
      const closingLastActive =
        tab.id === activeTabId && tabs.length === 1;
      if (
        closingLastActive &&
        typeof window.stopFileTrackingIntent === "function"
      ) {
        window.stopFileTrackingIntent();
      }
      tabs.splice(tabIndex, 1);
      if (tab.id === activeTabId) activeTabForMutations = null;
      bumpDocumentRevision();

      // Switch to another tab if closing active
      if (tab.id === activeTabId) {
        if (tabs.length > 0) {
          const newActiveTab = tabs[Math.max(0, tabIndex - 1)];
          await switchToTab(newActiveTab.id);
        } else {
          activeTabId = null;
          // Nothing is open any more. Leaving the watcher armed on the file we
          // just closed makes an external change raise a "reload?" prompt over
          // the welcome screen, for a document that no longer has a tab.
          if (
            window.ipcRenderer &&
            typeof window.stopFileTrackingIntent !== "function"
          ) {
            console.error(
              "[CustomTabs] Refusing legacy path-only watcher stop",
            );
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

  let sessionRestoreStarted = false;
  let sessionRestoreInProgress = false;
  let sessionRestoreToken = 0;
  let sessionLayoutRequested = false;
  let sessionLayoutTail = Promise.resolve();
  let pendingSessionLayout = null;
  let sessionLayoutRunning = false;
  let sessionLayoutRevision = 0;
  let durableSessionLayoutRevision = 0;
  let sessionLayoutFailure = null;
  let resolveSessionOwnerReady;
  const sessionOwnerReady = new Promise(resolve => {
    resolveSessionOwnerReady = resolve;
  });

  function saveTabs() {
    const activeTab = getActiveTab();
    if (isDocumentFrozen() || approvalRendererGeneration === null) return null;
    sessionLayoutRequested = true;
    if (sessionRestoreInProgress) return null;
    sessionLayoutRequested = false;
    // Only Main-issued IDs can enter the private layout. Unseen restore
    // entries stay protected by Main; provisional tabs cannot suppress a
    // legitimate close of an admitted tab.
    const entries = tabs.filter(tab => documentState.get(tab)?.admission).map((tab) => ({
      id: documentState.get(tab).admission.entryId,
      documentRef: documentState.get(tab).admission.ref,
      scrollPosition: tab.scrollPosition,
      anchor: tab.anchor ? { ...tab.anchor } : null,
    }));
    const layout = {
      entries,
      activeEntryId: activeTab ? documentState.get(activeTab)?.admission?.entryId || null : null,
    };
    pendingSessionLayout = { layout, revision: ++sessionLayoutRevision };
    startSessionLayoutWriter();
    return sessionLayoutRevision;
  }

  function startSessionLayoutWriter() {
    if (sessionLayoutRunning) return;
    sessionLayoutRunning = true;
    sessionLayoutTail = (async () => {
      while (pendingSessionLayout) {
        const request = pendingSessionLayout;
        pendingSessionLayout = null;
        try {
          await window.folia.saveSessionLayout(request.layout);
          durableSessionLayoutRevision = request.revision;
          sessionLayoutFailure = null;
        } catch (error) {
          sessionLayoutFailure = error;
          if (!pendingSessionLayout) {
            console.error("[CustomTabs] Could not persist open tabs:", error);
            notify("The open tabs could not be saved for the next session. Free storage and retry.", 6000);
          }
        }
      }
      if (sessionLayoutFailure) throw sessionLayoutFailure;
    })().finally(() => {
      sessionLayoutRunning = false;
      if (pendingSessionLayout) startSessionLayoutWriter();
    });
    // The error remains observable to shutdown/explicit settlement even if
    // nobody is awaiting this background persistence operation yet.
    sessionLayoutTail.catch(() => {});
  }

  async function settleSessionLayout() {
    let tail;
    do {
      tail = sessionLayoutTail;
      await tail;
    } while (tail !== sessionLayoutTail || pendingSessionLayout);
    if (sessionLayoutFailure) throw sessionLayoutFailure;
    if (sessionLayoutRequested || sessionRestoreInProgress) {
      throw new Error("The open tabs are still awaiting document restore");
    }
    return durableSessionLayoutRevision;
  }

  async function loadSavedTabs({ repeat = false } = {}) {
    if (sessionRestoreInProgress || (sessionRestoreStarted && !repeat)) return;
    sessionRestoreStarted = true;
    const restoreToken = ++sessionRestoreToken;
    const openIntent = latestFileOpenIntent;
    const switchIntent = latestTabSwitchIntent;
    const selected = activeTabId;
    const stillCurrent = () => restoreToken === sessionRestoreToken &&
      openIntent === latestFileOpenIntent &&
      switchIntent === latestTabSwitchIntent && selected === activeTabId &&
      !isDocumentFrozen();
    sessionRestoreInProgress = true;
    try {
      const ready = await sessionOwnerReady;
      if (!ready || !stillCurrent()) return;
      const saved = await window.folia.restoreSession();
      if (!saved || saved.superseded || !stillCurrent()) return;
      if (saved.error) {
        notify(`The previous document session could not be restored: ${saved.error}`, 8000);
        return;
      }
      const restored = [];
      for (const entry of saved.entries) {
        if (!stillCurrent()) return;
        if (entry.error) {
          console.error("[CustomTabs] Could not restore document:", entry.filePath, entry.error);
          notify(`Could not restore ${safeDocumentLabel(entry.filePath)}. Its session entry was kept.`, 6000);
          continue;
        }
        if (findTabForAdmission(entry.filePath, entry.document)) continue;
        const tab = createTab(entry.filePath, entry.content, {
          activate: false,
          modifiedTime: entry.modifiedTime,
          diskVersion: entry.diskVersion,
          documentAdmission: entry.document,
        });
        if (!tab) return;
        tab.scrollPosition = entry.scrollPosition;
        tab.anchor = entry.anchor;
        restored.push(tab);
      }
      if (!stillCurrent()) return;
      const active = restored.find(tab =>
        documentState.get(tab).admission.entryId === saved.activeEntryId) || restored[0];
      if (active) {
        await switchToTab(active.id, {
          silent: true, fileOpenOptions: { adoptPathIdentity: true },
        });
      }
    } catch (error) {
      console.error("[CustomTabs] Error loading saved tabs:", error);
    } finally {
      if (restoreToken === sessionRestoreToken) {
        sessionRestoreInProgress = false;
        saveTabs();
      }
    }
  }

  const tabPathAliases = new Map();
  const MAX_TAB_PATH_ALIASES = 512;

  // Bounded, but never at the expense of a spelling an open tab still depends
  // on: tabPathKey() falls back to the alias when a tab has no recorded
  // document key, so evicting a live tab's spelling would silently re-resolve
  // that tab's identity behind it. When every entry is live the map is left
  // alone - it is then bounded by the number of open documents.
  function rememberTabPathAlias(spelling, key) {
    if (!spelling || !key) return key;
    if (!tabPathAliases.has(spelling) &&
      tabPathAliases.size >= MAX_TAB_PATH_ALIASES) {
      const live = new Set();
      for (const tab of tabs) {
        const tabSpelling = tabSpellingKey(tab);
        if (tabSpelling) live.add(tabSpelling);
      }
      for (const candidate of tabPathAliases.keys()) {
        if (live.has(candidate)) continue;
        tabPathAliases.delete(candidate);
        break;
      }
    }
    tabPathAliases.set(spelling, key);
    return key;
  }

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
    return rememberTabPathAlias(normalised.spelling, key);
  }

  function rebindTabPath(filePath) {
    const normalised = normaliseTabPath(filePath);
    if (!normalised) return null;
    const key =
      resolveTabPath(normalised.resolved) || normalised.spelling;
    return rememberTabPathAlias(normalised.spelling, key);
  }

  function tabPathKey(tab) {
    if (!tab) return null;
    const state = documentState.get(tab);
    return state && state.pathKey
      ? state.pathKey
      : canonicalTabPath(tab.filePath);
  }

  function adoptTabPathIdentity(
    tab, filePath = tab && tab.filePath, approvedPathKey = null,
  ) {
    if (!tab || !filePath) return null;
    if (approvedPathKey !== null &&
        resolveTabPath(filePath) !== approvedPathKey) return null;
    const key = approvedPathKey === null
      ? rebindTabPath(filePath)
      : rememberTabPathAlias(
          normaliseTabPath(filePath).spelling, approvedPathKey,
        );
    const state = documentState.get(tab);
    if (state && state.pathKey !== key) {
      state.pathKey = key;
      bumpDocumentRevision(tab);
    }
    return key;
  }

  function approvedReloadPathsMatch(pathKey, sourcePath, ownerPath) {
    return typeof pathKey === "string" &&
      resolveTabPath(sourcePath) === pathKey &&
      resolveTabPath(ownerPath) === pathKey;
  }

  function approvedReloadSnapshotMatches(approval, sourcePath, ownerPath) {
    return !!approval &&
      approvedReloadPathsMatch(
        approval.pathKey, sourcePath, ownerPath,
      ) &&
      sameDiskVersion(getDiskVersion(sourcePath), approval.version) &&
      sameDiskVersion(getDiskVersion(ownerPath), approval.version);
  }

  function tabSpellingKey(tab) {
    const normalised = tab ? normaliseTabPath(tab.filePath) : null;
    return normalised ? normalised.spelling : null;
  }

  // Exact spelling still identifies its existing tab when a target vanishes.
  // Canonical candidates, however, must resolve NOW to their sticky binding;
  // a retargeted symlink cannot steal an open for its former target.
  function findTabByPath(filePath, preferredTabId = activeTabId) {
    const normalised = normaliseTabPath(filePath);
    if (!normalised) return undefined;
    const spelling = normalised.spelling;
    const exactMatches = tabs.filter(
      (tab) => tabSpellingKey(tab) === spelling,
    );
    if (exactMatches.length > 0) {
      return (
        exactMatches.find((tab) => tab.id === preferredTabId) ||
        exactMatches[0]
      );
    }
    const canonical = resolveTabPath(filePath);
    if (!canonical) return undefined;
    const canonicalMatches = tabs.filter(
      (tab) =>
        tabPathKey(tab) === canonical &&
        resolveTabPath(tab.filePath) === canonical,
    );
    return (
      canonicalMatches.find((tab) => tab.id === preferredTabId) ||
      canonicalMatches[0]
    );
  }

  function findTabForAdmission(filePath, admission) {
    // A native reference owns this exact logical path. Do not transfer it to
    // a differently spelled tab merely because both resolve to one file.
    if (admission) return tabs.find(
      tab => normaliseTabPath(tab.filePath)?.resolved === admission.logicalPath,
    );
    return findTabByPath(filePath);
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId);
  }

  function documentIdentity(tab, pageSession = null) {
    if (!tab) return null;
    const state = documentState.get(tab);
    const pathKey = tabPathKey(tab);
    const authoritativeSession =
      typeof window.getReloadRequestSession === "function"
        ? window.getReloadRequestSession()
        : null;
    if (
      !state ||
      !Number.isSafeInteger(state.generation) ||
      state.generation <= 0 ||
      !Number.isSafeInteger(tab.id) ||
      tab.id <= 0 ||
      !Number.isSafeInteger(approvalRendererGeneration) ||
      approvalRendererGeneration <= 0 ||
      typeof pageSession !== "string" ||
      pageSession.length === 0 ||
      pageSession !== authoritativeSession ||
      !pathKey
    ) {
      return null;
    }
    return Object.freeze({
      pageSession,
      rendererGeneration: approvalRendererGeneration,
      tabId: tab.id,
      documentGeneration: state.generation,
      pathKey,
      ...(state.admission ? { documentRef: state.admission.ref } : {}),
    });
  }

  function registerTabDiskOwner(tab) {
    if (
      !tab ||
      typeof window.registerDocumentOwner !== "function" ||
      !normaliseDiskVersion(tab.diskVersion)
    ) return false;
    const session =
      typeof window.getReloadRequestSession === "function"
        ? window.getReloadRequestSession()
        : null;
    const identity = documentIdentity(tab, session);
    return !!identity && window.registerDocumentOwner(
      tab.filePath, identity, tab.diskVersion, tab.mtimeMs,
    );
  }

  function markCompletedBackgroundAdoptionConflict(tab, approval, sourcePath) {
    if (approvedReloadSnapshotMatches(
      approval, sourcePath, tab.filePath,
    )) return false;
    const state = documentState.get(tab);
    if (!state) {
      console.error("[CustomTabs] Completed background tab has no document state");
      notify("Background adoption lost its document state. Do not save this tab.", 8000);
      return true;
    }
    state.reloadConflict = true;
    tab.hasUnsavedChanges = true;
    bumpDocumentRevision(tab);
    const identity = documentIdentity(
      tab, window.getReloadRequestSession(),
    );
    const quarantined =
      registerTabDiskOwner(tab) &&
      typeof window.quarantineBackgroundDocumentOwner === "function" &&
      window.quarantineBackgroundDocumentOwner(
        tab.filePath, identity, approval.version,
      );
    if (!quarantined) {
      console.error("[CustomTabs] Background owner could not be quarantined");
    }
    if (typeof window.markReloadConflict === "function") {
      window.markReloadConflict(tab.filePath);
    }
    if (typeof window.reportAdoptionTrackingConflict === "function") {
      window.reportAdoptionTrackingConflict(
        tab.filePath, identity,
      );
    }
    renderTabs();
    saveTabs();
    notify(
      quarantined
        ? "The file moved after its background adoption. Its approved copy remains in the tab with a conflict; review before saving."
        : "Background tracking could not be quarantined. The tab is conflicted and Save is refused; reopen the file before saving.",
      8000,
    );
    return true;
  }

  function getActiveDocumentIdentity(filePath = null, pageSession = null) {
    const tab = getActiveTab();
    if (!tab) return null;
    if (
      filePath &&
      canonicalTabPath(filePath) !== tabPathKey(tab)
    ) {
      return null;
    }
    return documentIdentity(tab, pageSession);
  }

  function getDocumentIdentityForTab(tabId, filePath, pageSession = null) {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (
      !tab ||
      (filePath && canonicalTabPath(filePath) !== tabPathKey(tab))
    ) {
      return null;
    }
    return documentIdentity(tab, pageSession);
  }

  function queuePreHandshakeTrackingAssertion(
    tab,
    lifecycleData,
    lifecycleOptions,
    protectedState,
  ) {
    if (
      Number.isSafeInteger(approvalRendererGeneration) &&
      approvalRendererGeneration > 0
    ) {
      pendingHandshakeTrackingAssertion = null;
      return;
    }
    const state = tab && documentState.get(tab);
    const pathKey = tabPathKey(tab);
    if (!tab || !state || !pathKey) {
      pendingHandshakeTrackingAssertion = null;
      return;
    }
    pendingHandshakeTrackingAssertion = Object.freeze({
      tabId: tab.id,
      documentGeneration: state.generation,
      pathKey,
      filePath: tab.filePath,
      content: tab.content,
      dirty: protectedState,
      trackingActive:
        !protectedState && lifecycleOptions.trackingActive !== false,
      adoptBaseline:
        !protectedState && lifecycleOptions.adoptDiskBaseline !== false,
      adoptPathIdentity: lifecycleOptions.adoptPathIdentity === true,
      modifiedTime: lifecycleData.modifiedTime,
      diskVersion: lifecycleData.diskVersion || null,
    });
  }

  function activatePreHandshakeTrackingAssertion() {
    const assertion = pendingHandshakeTrackingAssertion;
    pendingHandshakeTrackingAssertion = null;
    if (
      !assertion ||
      typeof window.assertFileTrackingOwnership !== "function" ||
      activeTabId !== assertion.tabId ||
      window.currentFilePath !== assertion.filePath
    ) {
      return false;
    }
    const tab = tabs.find((candidate) => candidate.id === assertion.tabId);
    const state = tab && documentState.get(tab);
    if (
      !tab ||
      !state ||
      tabPathKey(tab) !== assertion.pathKey
    ) {
      return false;
    }
    // Edits can arrive while the generation handshake is pending. The queued
    // clean assertion must not bless its old disk snapshot over those edits,
    // but the selected document still needs an authenticated owner for Save.
    const unchanged =
      state.generation === assertion.documentGeneration &&
      tab.content === assertion.content &&
      isDirty(tab) === assertion.dirty;
    const protectedState = isDirty(tab) || hasUnsavedMutation(tab);
    return window.assertFileTrackingOwnership(
      assertion.filePath,
      unchanged && !protectedState && assertion.trackingActive,
      {
        adoptBaseline: unchanged && !protectedState && assertion.adoptBaseline,
        adoptPathIdentity: unchanged && assertion.adoptPathIdentity,
        modifiedTime: unchanged ? assertion.modifiedTime : null,
        diskVersion: unchanged ? assertion.diskVersion : null,
        ownerTabId: assertion.tabId,
        expectedDocumentGeneration: state.generation,
        expectedPathKey: assertion.pathKey,
      },
    );
  }

  function prepareSaveRequest(filePath, pageSession, requestedSequence = null) {
    const tab = snapshotActiveTab({ capturePosition: false });
    const baseIdentity = getActiveDocumentIdentity(filePath, pageSession);
    const selectionGeneration =
      typeof window.getActiveFileSelectionGeneration === "function"
        ? window.getActiveFileSelectionGeneration()
        : null;
    if (
      !tab ||
      !baseIdentity ||
      typeof tab.content !== "string" ||
      !Number.isSafeInteger(selectionGeneration) ||
      selectionGeneration <= 0
    ) {
      return null;
    }
    if (documentState.get(tab)?.reloadConflict) {
      console.error("[CustomTabs] Refusing Save with an unresolved reload conflict");
      notify("Save is blocked by a file conflict. Copy any edits to a safe place before reloading or reopening.", 8000);
      return null;
    }
    const hasRequestedSequence =
      Number.isSafeInteger(requestedSequence) && requestedSequence > 0;
    if (
      !hasRequestedSequence &&
      nextPreparedSaveSequence === Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    const sequence = hasRequestedSequence
      ? requestedSequence
      : nextPreparedSaveSequence + 1;
    if (hasRequestedSequence) {
      nextPreparedSaveSequence = Math.max(
        nextPreparedSaveSequence,
        requestedSequence,
      );
    } else {
      nextPreparedSaveSequence = sequence;
    }
    const identity = Object.freeze({
      ...baseIdentity,
      selectionGeneration,
      sequence,
    });
    bumpTabMutationRevision(documentState.get(tab));
    return Object.freeze({
      identity,
      content: tab.content,
    });
  }

  function tabForDocumentIdentity(identity) {
    if (
      !identity ||
      !Number.isSafeInteger(identity.tabId) ||
      identity.tabId <= 0 ||
      !Number.isSafeInteger(identity.documentGeneration) ||
      identity.documentGeneration <= 0 ||
      !Number.isSafeInteger(identity.rendererGeneration) ||
      identity.rendererGeneration !== approvalRendererGeneration ||
      typeof identity.pathKey !== "string" ||
      typeof window.getReloadRequestSession !== "function" ||
      identity.pageSession !== window.getReloadRequestSession()
    ) {
      return null;
    }
    const tab = tabs.find((candidate) => candidate.id === identity.tabId);
    const state = tab && documentState.get(tab);
    return (
      tab &&
      state &&
      state.generation === identity.documentGeneration &&
      tabPathKey(tab) === identity.pathKey
    )
      ? tab
      : null;
  }

  function ownsDocumentIdentity(identity) {
    return !!tabForDocumentIdentity(identity);
  }

  function retainDeletionTombstone(identity, filePath, delivery) {
    if (
      !identity ||
      !delivery ||
      !Number.isSafeInteger(delivery.eventId) ||
      delivery.eventId <= 0 ||
      !Number.isSafeInteger(delivery.selectionGeneration) ||
      delivery.selectionGeneration <= 0 ||
      !Number.isSafeInteger(delivery.watcherGeneration) ||
      delivery.watcherGeneration <= 0 ||
      !Number.isSafeInteger(delivery.attempt) ||
      delivery.attempt <= 0 ||
      delivery.pageSession !== identity.pageSession ||
      delivery.rendererGeneration !== identity.rendererGeneration ||
      typeof window.getReloadRequestSession !== "function" ||
      typeof identity.pageSession !== "string" ||
      identity.pageSession !== window.getReloadRequestSession()
    ) {
      return false;
    }
    const tab = tabForDocumentIdentity(identity);
    if (
      !tab ||
      canonicalTabPath(filePath) !== identity.pathKey
    ) {
      return false;
    }
    const state = documentState.get(tab);
    if (
      state.deletionTombstone &&
      state.deletionTombstone.eventId > delivery.eventId
    ) {
      return false;
    }
    const tombstone = Object.freeze({
      eventId: delivery.eventId,
      pageSession: identity.pageSession,
      rendererGeneration: identity.rendererGeneration,
      tabId: identity.tabId,
      documentGeneration: identity.documentGeneration,
      pathKey: identity.pathKey,
      selectionGeneration: delivery.selectionGeneration,
      watcherGeneration: delivery.watcherGeneration,
      attempt: delivery.attempt,
    });
    if (
      state.deletionTombstone &&
      state.deletionTombstone.eventId === delivery.eventId
    ) {
      state.deletionTombstone = tombstone;
      bumpDocumentRevision(tab);
      return true;
    }

    state.deletionTombstone = tombstone;
    bumpDocumentRevision(tab);
    return true;
  }

  function applySaveResultDecision(decision) {
    if (!decision || decision.mayMutate !== true) return false;
    const tab = tabForDocumentIdentity(decision.identity);
    if (!tab) return false;
    if (!mayMutateDocument("ipc:save-result")) return false;

    if (tab.id === activeTabId) {
      snapshotActiveTab({ capturePosition: false });
    }
    const state = documentState.get(tab);
    if (decision.success) {
      const savedContent = decision.savedContent;
      if (typeof savedContent !== "string") return false;
      const currentContent = tab.content;
      state.originalContent = savedContent;
      state.reloadConflict = false;
      state.saveFailure = false;
      if (sameDocument(currentContent, savedContent)) {
        state.content = savedContent;
        state.dirty = false;
      } else {
        state.dirty = true;
      }
      if (tab.id === activeTabId) state.foldedLive = liveDocument();
      tab.hasUnsavedChanges = isDirty(tab);
      tab.diskVersion = diskVersionForAdoption(
        tab.filePath,
        decision.modifiedTime,
        decision.diskVersion,
      );
      tab.mtimeMs = Number.isFinite(decision.modifiedTime)
        ? decision.modifiedTime
        : tab.diskVersion
          ? tab.diskVersion.mtimeMs
          : null;
    } else {
      if (!decision.deleted) {
        state.saveFailure = true;
        if (decision.conflict) state.reloadConflict = true;
      }
      tab.hasUnsavedChanges = isDirty(tab);
    }
    bumpDocumentRevision(tab);
    renderTabs();
    saveTabs();
    return true;
  }

  // ============================================
  // Intercept file-opened events
  // ============================================

  const rendererFileOpenHandler = window.rendererFileOpenHandler;
  let latestFileOpenIntent = 0;
  let latestFileOpenPath = null;
  const canOwnFileOpen =
    typeof window.beginFileOpen === "function" &&
    typeof window.completeFileOpen === "function" &&
    typeof window.preflightFileOpen === "function" &&
    typeof rendererFileOpenHandler === "function";

  function deferPreHandshakeFileOpen(replay) {
    if (approvalRendererGeneration !== null) return false;
    if (pendingHandshakeFileOpens.length >= 256) {
      console.error("[CustomTabs] File open refused before ownership was ready");
      notify("Too many files were opened before document ownership was ready. Retry opening the file.", 6000);
      return true;
    }
    pendingHandshakeFileOpens.push(replay);
    return true;
  }

  if (documentEvents) {
    if (!canOwnFileOpen) {
      // Keep renderer's public fallback in control. The wrapper adds only the
      // freeze queue; after thaw it invokes the exact upstream handler once.
      if (typeof rendererFileOpenHandler === "function") {
        documentEvents.removeListener(
          "file-opened",
          rendererFileOpenHandler,
        );
        const handleCompatibleFileOpened = (event, data) => {
          if (
            deferPreHandshakeFileOpen(() =>
              handleCompatibleFileOpened(event, data),
            )
          ) return;
          if (
            deferFrozenDocumentOperation("ipc:file-opened", () =>
              handleCompatibleFileOpened(event, data),
            )
          ) {
            return;
          }
          rendererFileOpenHandler(event, data);
        };
        documentEvents.on("file-opened", handleCompatibleFileOpened);
      }
      console.error(
        "[CustomTabs] Renderer file-open lifecycle API unavailable; " +
          "keeping the upstream file-open handler in control.",
      );
    } else {
      documentEvents.removeListener(
        "file-opened",
        rendererFileOpenHandler,
      );

      const openAdditionalFiles = async (
        allPaths, extraReadGrants, stillCurrent,
      ) => {
        if (!allPaths || allPaths.length <= 1 || !stillCurrent()) return;
        if (
          !Array.isArray(extraReadGrants) ||
          extraReadGrants.length !== allPaths.length - 1
        ) {
          throw new Error("Dialog extras have no matching read grants");
        }
        for (const [index, extraPath] of allPaths.slice(1).entries()) {
          if (!stillCurrent()) return;
          const logicalExtraPath = normaliseTabPath(extraPath)?.resolved;
          if (tabs.some(tab => normaliseTabPath(tab.filePath)?.resolved === logicalExtraPath)) continue;
          let extraApproval = null;
          let extraTab = null;
          let extraCompleted = false;
          try {
            const extraReservation = reserveDocumentIdentity();
            if (!extraReservation) continue;
            const snapshot = await window.folia.readDialogExtra({
              grant: extraReadGrants[index],
              pageSession: window.getReloadRequestSession(),
              rendererGeneration: approvalRendererGeneration,
            });
            if (!snapshot || snapshot.path !== extraPath ||
                typeof snapshot.content !== "string") {
              throw new Error("Dialog extra read returned an invalid snapshot");
            }
            if (!stillCurrent()) return;
            extraApproval = await verifyDiskAdoption(
              null, extraPath, snapshot.content,
              snapshot.modifiedTime, snapshot.diskVersion,
              { reservedIdentity: extraReservation, stillCurrent,
                documentAdmission: snapshot.document },
            );
            if (!stillCurrent()) return;
            const extraVersion = diskVersionForAdoption(
              extraPath, snapshot.modifiedTime, snapshot.diskVersion,
            );
            if (
              !extraVersion ||
              !matchesDiskAdoptionApproval(
                extraApproval, null, extraPath,
                snapshot.content, extraVersion,
                { reservedIdentity: extraReservation },
              )
            ) {
              notify(`Could not verify ${safeDocumentLabel(extraPath)} for the open batch.`, 6000);
              continue;
            }
            appliedDiskAdoptionApprovals.add(extraApproval);
            extraTab = createTab(extraPath, snapshot.content, {
              activate: false,
              modifiedTime: snapshot.modifiedTime,
              diskVersion: extraVersion,
              verifiedDiskAdoption: extraApproval,
              deferOwnerRegistration: true,
              reservedIdentity: extraReservation,
              documentAdmission: snapshot.document,
            });
            if (!extraTab) continue;
            if (!completeDiskAdoption(
              extraApproval, extraTab, extraPath,
            )) continue;
            extraCompleted = true;
            rememberTabPathAlias(
              normaliseTabPath(extraPath).spelling,
              extraApproval.pathKey,
            );
            if (markCompletedBackgroundAdoptionConflict(
              extraTab, extraApproval, extraPath,
            )) continue;
            registerTabDiskOwner(extraTab);
          } catch (error) {
            if (!stillCurrent()) return;
            console.error(
              "[CustomTabs] Error loading file:",
              extraPath,
              error,
            );
            notify(`Could not open ${safeDocumentLabel(extraPath)}.`, 6000);
          } finally {
            if (!extraCompleted) {
              if (extraTab) removeUnactivatedTab(extraTab);
              if (extraApproval) {
                appliedDiskAdoptionApprovals.delete(extraApproval);
                abandonDiskAdoption(extraApproval.capability);
              }
            }
          }
        }
      };

      const handleFileOpened = async (event, data) => {
        if (
          deferPreHandshakeFileOpen(() => handleFileOpened(event, data))
        ) return;
        if (
          deferFrozenDocumentOperation("ipc:file-opened", () =>
            dispatchFileOpened(event, data),
            () => notify(
              `File open was refused while closing: ${
                data && data.path ? data.path : "unknown file"
              }`,
              6000,
            ),
          )
        ) {
          return;
        }
        if (!mayMutateDocument("ipc:file-opened")) return;
        const intent = ++latestFileOpenIntent;
        const primaryReservation = reserveDocumentIdentity();
        if (!primaryReservation) return;
        latestFileOpenPath = data && data.path;
        const selectedAtIntent = activeTabId;
        let openData = data;
        if (
          data &&
          data.path &&
          typeof window.getPendingSaveStatus === "function" &&
          typeof window.waitForPendingSaves === "function" &&
          window.getPendingSaveStatus(data.path).pending
        ) {
          await window.waitForPendingSaves(data.path);
          if (!mayMutateDocument("ipc:file-opened-after-save")) return;
          try {
            if (!data.document || typeof data.document.openTicket !== "string" ||
                !/^[a-f0-9]{64}$/.test(data.document.openTicket)) {
              throw new Error("Reopening after Save requires a current native open ticket");
            }
            const settledSnapshot = await window.folia.readOpenTicketSnapshot({
              openTicket: data.document.openTicket,
            });
            if (!settledSnapshot) {
              throw new Error("The admitted open was superseded or its ticket was spent");
            }
            openData = {
              ...data,
              content: settledSnapshot.content,
              modifiedTime: settledSnapshot.modifiedTime,
              diskVersion: settledSnapshot.diskVersion,
              ...(settledSnapshot.document ? { document: settledSnapshot.document } : {}),
            };
          } catch (error) {
            console.error(
              "[CustomTabs] Refusing stale reopen after save settlement:",
              error,
            );
            notify(
              t("notif.reloadFailed", "Failed to reload file: ") +
                error.message,
              4000,
            );
            return;
          }
        }
        const superseded =
          intent !== latestFileOpenIntent ||
          activeTabId !== selectedAtIntent;
        if (superseded && openData.openRequest) return;
        const preflight = superseded
          ? { accepted: true, lifecycleOptions: null }
          : window.preflightFileOpen(openData, { commit: false });
        if (!preflight || !preflight.accepted) {
          return;
        }
        // A newer intent for the same document owns both its bytes and its
        // selection. Never let an older awaited read overwrite that tab.
        if (
          superseded &&
          intent !== latestFileOpenIntent &&
          (openData.path === latestFileOpenPath ||
            (findTabByPath(openData.path) &&
              findTabByPath(openData.path) ===
                findTabByPath(latestFileOpenPath)))
        ) {
          return;
        }
        console.log("[CustomTabs] Intercepted file-opened:", openData.path);

        const {
          content, path: filePath, allPaths, extraReadGrants,
        } = openData;
        const overtakenForSameDocument = () =>
          intent !== latestFileOpenIntent &&
          (filePath === latestFileOpenPath ||
            (!!findTabByPath(filePath) &&
              findTabByPath(filePath) ===
                findTabByPath(latestFileOpenPath)));
        let targetTab = findTabForAdmission(filePath, openData.document);
        let adoptionApproval = null;
        let grantCompleted = false;
        let approvedNavigationPrior = null;
        let priorAdoption = null;
        let priorAdoptionRestored = false;
        let provisionalTab = false;
        let selectionCommitted = false;
        let refusedExistingOpenSelection = false;
        let priorLargeConfirmation = null;
        let targetGenerationBeforeAdoption = null;
        let preserveCachedDocument = false;
        try {
        if (
          targetTab &&
          tabSpellingKey(targetTab) !== normaliseTabPath(filePath).spelling
        ) {
          const aliasState =
            typeof window.queryDocumentDiskAdoptionState === "function"
              ? window.queryDocumentDiskAdoptionState(
                  filePath,
                  {
                    pageSession: window.getReloadRequestSession(),
                    rendererGeneration: approvalRendererGeneration,
                    tabId: null,
                  },
                  openData.modifiedTime,
                  openData.diskVersion,
                  filePath,
                )
              : null;
          if (
            !aliasState ||
            aliasState.known !== true ||
            aliasState.versionMatches !== true ||
            aliasState.pathKey !== resolveTabPath(filePath)
          ) {
            notify("The file alias could not be verified. The open was refused.", 6000);
            return;
          }
          // An incoming spelling with its own deletion episode cannot
          // transfer that consent to a differently spelled live tab.
          if (
            aliasState.ownDeletion ||
            aliasState.orphaned ||
            aliasState.pathOnly ||
            aliasState.overflow
          ) {
            targetTab = undefined;
          } else {
            const existingSession = window.getReloadRequestSession();
            const existingIdentity = documentIdentity(
              targetTab, existingSession,
            );
            const existingState =
              existingIdentity &&
              typeof window.queryDocumentDeletionState === "function"
                ? window.queryDocumentDeletionState(
                    targetTab.filePath, existingIdentity,
                  )
                : null;
            if (!existingState || existingState.known !== true ||
                existingState.unresolved === true) {
              targetTab = undefined;
            }
          }
        }
        const targetWasActive = !!(
          targetTab && targetTab.id === activeTabId
        );
        targetGenerationBeforeAdoption =
          targetTab && documentState.get(targetTab)?.generation;
        const targetReservation = targetTab
          ? Object.freeze({
              tabId: targetTab.id,
              documentGeneration:
                primaryReservation.documentGeneration,
            })
          : primaryReservation;
        if (targetTab) {
          const targetState = documentState.get(targetTab);
          const live = targetWasActive ? liveDocument() : null;
          preserveCachedDocument =
            hasUnsavedMutation(targetTab) ||
            !!(targetState && targetState.saveFailure) ||
            (typeof live === "string" &&
              !sameDocument(live, targetTab.originalContent));
          if (!preserveCachedDocument) {
            adoptionApproval = adoptionApproval || await verifyDiskAdoption(
              targetTab,
              filePath,
              content,
              openData.modifiedTime,
              openData.diskVersion,
              {
                allowPathReplacement:
                  tabSpellingKey(targetTab) ===
                  normaliseTabPath(filePath).spelling,
                stillCurrent: () => !overtakenForSameDocument(),
                reservedIdentity: targetReservation,
                documentAdmission: openData.document,
              },
            );
            if (isDocumentFrozen()) {
              if (adoptionApproval) {
                abandonDiskAdoption(adoptionApproval.capability);
              }
              deferFrozenDocumentOperation(
                "ipc:file-opened-after-attestation",
                () => dispatchFileOpened(event, data),
              );
              return;
            }
            if (!adoptionApproval) return;
          }
          if (overtakenForSameDocument()) {
            return;
          }
          const verifiedVersion = preserveCachedDocument
            ? null
            : diskVersionForAdoption(
                filePath, openData.modifiedTime, openData.diskVersion,
              );
          if (
            !preserveCachedDocument &&
            (!verifiedVersion || !matchesDiskAdoptionApproval(
              adoptionApproval, targetTab, filePath,
              content, verifiedVersion,
              { reservedIdentity: targetReservation },
            ))
          ) {
            return;
          }
          if (targetWasActive) snapshotActiveTab();
          if (
            !preserveCachedDocument &&
            (hasUnsavedMutation(targetTab) ||
              !!(targetState && targetState.saveFailure))
          ) {
            return;
          }
          if (
            !superseded &&
            !window.preflightFileOpen(openData, { commit: false }).accepted
          ) {
            return;
          }
          const navigationPrior = !superseded &&
            typeof window.captureFileOpenNavigation === "function"
            ? window.captureFileOpenNavigation()
            : null;
          approvedNavigationPrior = navigationPrior;
          if (
            !superseded &&
            !window.preflightFileOpen(openData).accepted
          ) {
            return;
          }
          console.log("[CustomTabs] File already open, switching to tab");
          // A dirty or reload-conflicted tab owns bytes not represented by the
          // disk payload and must be preserved. A truly clean tab has no such
          // ownership: atomically adopt the freshly-read content so reopening
          // cannot display or later save a stale cache over a newer file.
          if (preserveCachedDocument) {
            targetTab.hasUnsavedChanges = isDirty(targetTab);
          } else {
            const prior = snapshotTabAdoption(targetTab, filePath);
            priorAdoption = prior;
            appliedDiskAdoptionApprovals.add(adoptionApproval);
            if (adoptTabPathIdentity(
              targetTab, filePath, adoptionApproval.pathKey,
            ) !== adoptionApproval.pathKey ||
              !adoptCleanDocument(
              targetTab, content,
              targetReservation.documentGeneration,
            )) {
              restoreTabAdoption(targetTab, prior);
              priorAdoptionRestored = true;
              appliedDiskAdoptionApprovals.delete(adoptionApproval);
              restoreNavigationAfterFailedAdoption(navigationPrior);
              return;
            }
            targetTab.hasUnsavedChanges = false;
            targetTab.diskVersion = verifiedVersion;
            targetTab.mtimeMs = verifiedVersion.mtimeMs;
            if (openData.document) targetState.admission = openData.document;
            pendingActivationTabs.add(targetTab);
            rememberTabPathAlias(
              normaliseTabPath(filePath).spelling,
              adoptionApproval.pathKey,
            );
          }
          priorLargeConfirmation = largeConfirmed.has(targetTab.id);
          largeConfirmed.add(targetTab.id);
        } else {
          adoptionApproval = adoptionApproval || await verifyDiskAdoption(
            null,
            filePath,
            content,
            openData.modifiedTime,
            openData.diskVersion,
            {
              stillCurrent: () => !overtakenForSameDocument(),
              reservedIdentity: targetReservation,
              documentAdmission: openData.document,
            },
          );
          if (isDocumentFrozen()) {
            deferFrozenDocumentOperation(
              "ipc:file-opened-after-attestation",
              () => dispatchFileOpened(event, data),
            );
            return;
          }
          if (!adoptionApproval) return;
          if (overtakenForSameDocument()) {
            return;
          }
          const verifiedVersion = diskVersionForAdoption(
            filePath, openData.modifiedTime, openData.diskVersion,
          );
          if (!verifiedVersion || !matchesDiskAdoptionApproval(
            adoptionApproval, null, filePath, content, verifiedVersion,
            { reservedIdentity: targetReservation },
          )) {
            notify("The file became unavailable or changed before adoption.", 6000);
            return;
          }
          appliedDiskAdoptionApprovals.add(adoptionApproval);
          // Create without activation: switchToTab owns the one renderer
          // lifecycle transition and the one visual render below.
          targetTab = createTab(filePath, content, {
            activate: false,
            confirmed: true,
            modifiedTime: openData.modifiedTime,
            diskVersion: verifiedVersion,
            verifiedDiskAdoption: adoptionApproval,
            deferOwnerRegistration: true,
            reservedIdentity: targetReservation,
            documentAdmission: openData.document,
          });
          if (!targetTab) {
            appliedDiskAdoptionApprovals.delete(adoptionApproval);
            return;
          }
          provisionalTab = true;
          pendingActivationTabs.add(targetTab);
          if (
            !superseded &&
            !window.preflightFileOpen(openData, { commit: false }).accepted
          ) {
            return;
          }
          const navigationPrior = !superseded &&
            typeof window.captureFileOpenNavigation === "function"
            ? window.captureFileOpenNavigation()
            : null;
          approvedNavigationPrior = navigationPrior;
          if (
            !superseded &&
            !window.preflightFileOpen(openData).accepted
          ) {
            return;
          }
          rememberTabPathAlias(
            normaliseTabPath(filePath).spelling,
            adoptionApproval.pathKey,
          );
        }

        if (
          superseded ||
          intent !== latestFileOpenIntent ||
          activeTabId !== selectedAtIntent
        ) {
          // The settled disk snapshot may still refresh a background tab; it
          // must not undo the user's intervening navigation.
          if (adoptionApproval && targetTab.id === activeTabId) {
            notify("The file became active through another selection. Its earlier copy was kept; retry opening it.", 6000);
            restoreNavigationAfterFailedAdoption(approvedNavigationPrior);
            return;
          }
          if (adoptionApproval && !completeDiskAdoption(
            adoptionApproval, targetTab, filePath,
          )) {
            restoreNavigationAfterFailedAdoption(approvedNavigationPrior);
            return;
          }
          if (adoptionApproval) {
            grantCompleted = true;
            if (markCompletedBackgroundAdoptionConflict(
              targetTab, adoptionApproval, filePath,
            )) {
              pendingActivationTabs.delete(targetTab);
              return;
            }
            registerTabDiskOwner(targetTab);
          }
          pendingActivationTabs.delete(targetTab);
          saveTabs();
          renderTabs();
          await openAdditionalFiles(
            allPaths, extraReadGrants,
            () => intent === latestFileOpenIntent,
          );
          return;
        }
        const selected = await switchToTab(targetTab.id, {
          fileOpenData: openData,
          navigationPrior: approvedNavigationPrior,
          skipSnapshot: targetWasActive,
          fileOpenLifecycleOptions:
            preflight.lifecycleOptions || undefined,
          onTrackingRefused: () => {
            refusedExistingOpenSelection = true;
            if (priorAdoption && !priorAdoptionRestored &&
                documentState.get(targetTab)?.generation ===
                  adoptionApproval.documentGeneration) {
              restoreTabAdoption(targetTab, priorAdoption);
              appliedDiskAdoptionApprovals.delete(adoptionApproval);
              priorAdoptionRestored = true;
            }
          },
          onTrackingCommitted: () => {
            selectionCommitted = true;
            if (adoptionApproval) grantCompleted = true;
          },
          fileOpenOptions: {
            preserveEditBaseline: preserveCachedDocument,
            adoptPathIdentity: !preserveCachedDocument,
            deletionAdoptionApproval: adoptionApproval,
          },
        });
        if (!selected) {
          return;
        }
        pendingActivationTabs.delete(targetTab);
        await openAdditionalFiles(
          allPaths, extraReadGrants,
          () => intent === latestFileOpenIntent,
        );
        } finally {
          try {
            if (!grantCompleted && adoptionApproval) {
              if (provisionalTab && pendingActivationTabs.has(targetTab)) {
                removeUnactivatedTab(targetTab);
              } else if (priorAdoption && !priorAdoptionRestored &&
                  documentState.get(targetTab)?.generation ===
                    adoptionApproval.documentGeneration) {
                restoreTabAdoption(targetTab, priorAdoption);
                priorAdoptionRestored = true;
              }
              appliedDiskAdoptionApprovals.delete(adoptionApproval);
            }
            if (!selectionCommitted && !grantCompleted &&
                approvedNavigationPrior) {
              restoreNavigationAfterFailedAdoption(approvedNavigationPrior);
            }
            if (!grantCompleted && priorLargeConfirmation === false &&
                targetTab) largeConfirmed.delete(targetTab.id);
          } finally {
            if (targetTab) pendingActivationTabs.delete(targetTab);
            if (adoptionApproval && !grantCompleted) {
              abandonDiskAdoption(adoptionApproval.capability);
            }
          }
          if (
            adoptionApproval &&
            !grantCompleted &&
            !provisionalTab &&
            !preserveCachedDocument &&
            tabs.includes(targetTab) &&
            (!documentState.get(targetTab) ||
              documentState.get(targetTab).generation ===
                (priorAdoption
                  ? priorAdoption.generation
                  : targetGenerationBeforeAdoption)) &&
            (refusedExistingOpenSelection ||
              !approvedReloadSnapshotMatches(
                adoptionApproval, filePath, targetTab.filePath,
              )) &&
            mayMutateDocument("ipc:file-opened-rollback-conflict")
          ) {
            const state = documentState.get(targetTab);
            if (state) {
              state.reloadConflict = true;
              targetTab.hasUnsavedChanges = true;
              bumpDocumentRevision(targetTab);
              if (typeof window.markReloadConflict === "function") {
                window.markReloadConflict(targetTab.filePath);
              }
              const active = getActiveTab();
              let restoredOwner = false;
              if (
                active === targetTab &&
                typeof window.assertFileTrackingOwnership === "function"
              ) {
                const assertion = window.assertFileTrackingOwnership(
                  targetTab.filePath, false, {
                    adoptBaseline: false,
                    ownerTabId: targetTab.id,
                    returnDecision: true,
                  },
                );
                restoredOwner = assertion &&
                  assertion.accepted === true &&
                  assertion.trackingActive === false;
              }
              if (!restoredOwner &&
                  typeof window.reportAdoptionTrackingConflict === "function") {
                window.reportAdoptionTrackingConflict(
                  targetTab.filePath,
                  documentIdentity(
                    targetTab, window.getReloadRequestSession(),
                  ),
                );
              }
              if (active === targetTab && !restoredOwner) {
                console.error("[CustomTabs] Earlier file owner could not be reasserted after open refusal");
                notify("The earlier document owner could not be confirmed. Keep the in-memory copy and reopen its physical file before saving.", 8000);
              }
              renderTabs();
              saveTabs();
              notify("The file changed before the existing tab could reopen. Its earlier copy remains conflicted; copy any edits before reloading.", 8000);
            } else {
              console.error("[CustomTabs] Refused open lost its tab document state");
              notify("The earlier document state could not be verified. Keep its in-memory copy and do not Save.", 8000);
            }
          }
        }
      };

      const dispatchFileOpened = (event, data) => {
        handleFileOpened(event, data).catch((error) => {
          console.error("[CustomTabs] File open failed:", error);
          notify("The file could not be opened.", 6000);
        });
      };
      documentEvents.on("file-opened", dispatchFileOpened);
    }

    const rendererFileOpenResultHandlers = documentEvents.listeners
      ? documentEvents.listeners("file-open-result").slice()
      : [];
    if (rendererFileOpenResultHandlers.length > 0) {
      documentEvents.removeAllListeners("file-open-result");
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
      documentEvents.on("file-open-result", handleFileOpenResult);
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
  let pendingConfirmedReload = null;

  function noteActiveContentMutation() {
    const tab = activeTabForMutations;
    if (tab && tab.id === activeTabId) {
      bumpTabMutationRevision(documentState.get(tab));
    }
  }

  function confirmedReloadStillCurrent(data, tab) {
    const consent = pendingConfirmedReload;
    const request = data && data.reloadRequest;
    const state = tab && documentState.get(tab);
    const pending = typeof window.getPendingSaveStatus === "function"
      ? window.getPendingSaveStatus([tab.filePath])
      : null;
    return !!(
      consent && !consent.invalidated && request && state &&
      consent.tab === tab && tabs.includes(tab) && activeTabId === tab.id &&
      consent.switchIntent === latestTabSwitchIntent &&
      Number.isSafeInteger(consent.revision) &&
      consent.revision === state.mutationRevision &&
      consent.deferredOverflowCount === frozenDocumentOperationOverflowCount &&
      consent.session === window.getReloadRequestSession?.() &&
      consent.session === request.session &&
      consent.sequence === request.sequence &&
      consent.sequence === window.getLatestReloadRequestSequence?.(tab.filePath) &&
      consent.identity.tabId === request.tabId &&
      consent.identity.documentGeneration === request.documentGeneration &&
      consent.identity.rendererGeneration === request.rendererGeneration &&
      consent.identity.pathKey === request.pathKey &&
      consent.selectionGeneration === request.selectionGeneration &&
      consent.selectionGeneration ===
        window.getActiveFileSelectionGeneration?.() &&
      state.generation === consent.identity.documentGeneration &&
      tabPathKey(tab) === consent.identity.pathKey &&
      canonicalTabPath(tab.filePath) === consent.requestPath &&
      request.path === consent.requestPath &&
      request.snapshot === consent.live &&
      tab.content === consent.content &&
      tab.originalContent === consent.originalContent &&
      liveDocument() === consent.live &&
      pending && !pending.pending &&
      !isDocumentFrozen()
    );
  }

  // A reload takeover is only safe after CustomTabs has taken ownership of
  // file-open lifecycle. In compatibility mode there may be no target tab, so
  // leave renderer's reload listener installed rather than dropping replies.
  if (documentEvents && canOwnFileOpen) {
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
    const rendererReloadHandlers = documentEvents.listeners
      ? documentEvents.listeners("file-reload-result").slice()
      : [];

    if (rendererReloadHandlers.length > 0) {
      documentEvents.removeAllListeners("file-reload-result");
    } else {
      console.warn(
        "[CustomTabs] No existing 'file-reload-result' handler found; " +
          "renderer.js may have changed its reload channel.",
      );
    }

    const delegateReload = (event, data) => {
      // A missing renderer handler must not turn an unverified reply into a
      // second route that silently replaces the current document.
      if (rendererReloadHandlers.length === 0) {
        if (
          data && data.success &&
          data.trackingSelection &&
          data.trackingSelection.accepted === true &&
          window.renderMarkdown
        ) {
          if (typeof window.originalMarkdown !== "undefined") {
            window.originalMarkdown = data.content;
          }
          if (inEditMode() && window.markdownEditor) {
            window.markdownEditor.value = data.content;
          }
          if (window.setUnsavedState) {
            window.setUnsavedState(
              data.trackingSelection.unresolvedEvidence === true,
            );
          }
          return Promise.resolve(window.renderMarkdown(data.content));
        }
        console.error("[CustomTabs] Reload handler unavailable");
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
          : null;
      if (
        !request ||
        !Number.isSafeInteger(request.sequence) ||
        request.sequence <= 0 ||
        !Number.isSafeInteger(request.tabId) ||
        request.tabId <= 0 ||
        !Number.isSafeInteger(request.documentGeneration) ||
        request.documentGeneration <= 0 ||
        typeof request.path !== "string" ||
        typeof request.pathKey !== "string" ||
        typeof request.documentRef !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.documentRef) ||
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
      const targetState = documentState.get(targetTab);
      if (
        !targetState ||
        targetState.generation !== request.documentGeneration ||
        targetState.admission?.ref !== request.documentRef ||
        tabPathKey(targetTab) !== request.pathKey
      ) {
        return "foreign-document-generation";
      }
      if (
        !requestPath ||
        requestPath !== resultPath ||
        requestPath !== targetPath ||
        requestPath !== request.pathKey
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
          bumpDocumentRevision(targetTab);
        }
        targetTab.hasUnsavedChanges = isDirty(targetTab);
        if (typeof window.markReloadConflict === "function") {
          window.markReloadConflict(targetTab.filePath);
        } else if (isActive && window.setUnsavedState) {
          window.setUnsavedState(true);
          console.error(
            "[CustomTabs] Refusing legacy path-only watcher pause",
          );
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

    const quarantineSelectedReload = (
      targetTab, activeTab, why, data, selection, approval, prior = null,
    ) => {
      if (prior) {
        restoreTabAdoption(targetTab, prior);
        appliedDiskAdoptionApprovals.delete(approval);
      }
      const previousKey = tabPathKey(targetTab);
      const quarantined =
        typeof window.quarantineSelectedFileReload === "function" &&
        window.quarantineSelectedFileReload(
          data, targetTab.filePath, selection,
        );
      if (!quarantined) {
        if (typeof window.reportAdoptionTrackingConflict === "function") {
          window.reportAdoptionTrackingConflict(
            targetTab.filePath, selection.owner,
          );
        }
        rejectReloadResult(targetTab, activeTab, why, data);
        console.error("[CustomTabs] Could not reconcile the selected owner");
        notify("Tracking could not be reconciled. The earlier copy is protected; reopen its physical file directly before saving.", 8000);
        return false;
      }
      const state = documentState.get(targetTab);
      state.pathKey = selection.pathKey;
      state.generation = selection.owner.documentGeneration;
      state.reloadConflict = true;
      targetTab.hasUnsavedChanges = true;
      rememberTabPathAlias(tabSpellingKey(targetTab), selection.pathKey);
      rememberTabPathAlias(
        normaliseTabPath(data.path).spelling, selection.pathKey,
      );
      bumpDocumentRevision(targetTab);
      rejectReloadResult(targetTab, activeTab, why, data);
      if (previousKey !== selection.pathKey) {
        notify("The file link moved to a different target after approval. The previous copy remains in memory; Save is blocked until you resolve the conflict.", 8000);
      }
      return true;
    };

    const handleReloadResult = async (event, data) => {
      const failed = !data || !data.success;
      const requestedTabId =
        data &&
        data.reloadRequest &&
        Number.isSafeInteger(data.reloadRequest.tabId)
          ? data.reloadRequest.tabId
          : null;
      const targetTab =
        requestedTabId
          ? tabs.find((tab) => tab.id === requestedTabId) || null
          : data && data.path
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
          () => dispatchReloadResult(event, data),
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
      const pendingBeforeReload =
        typeof window.getPendingSaveStatus === "function"
          ? window.getPendingSaveStatus([targetTab.filePath])
          : null;
      if (!pendingBeforeReload || pendingBeforeReload.pending) {
        notify("Save status could not be cleared. Retry the reload after Save finishes.", 6000);
        return;
      }
      const requiresDirtyConsent = !!(
        pendingConfirmedReload &&
        pendingConfirmedReload.sequence === data.reloadRequest.sequence &&
        pendingConfirmedReload.session === data.reloadRequest.session
      );
      if (requiresDirtyConsent &&
          !confirmedReloadStillCurrent(data, targetTab)) {
        notify("The document changed after reload confirmation. Its edits were kept.", 6000);
        return;
      }
      const startedSwitchIntent = latestTabSwitchIntent;
      const reloadReservation = reserveDocumentIdentity(targetTab);
      if (!reloadReservation) return;
      const adoptionApproval = await verifyDiskAdoption(
        targetTab,
        data.path,
        data.content,
        data.modifiedTime,
        data.diskVersion,
        {
          allowPathReplacement: true,
          reservedIdentity: reloadReservation,
          allowUnsavedMutation: requiresDirtyConsent
            ? () => confirmedReloadStillCurrent(data, targetTab)
            : null,
          stillCurrent: () =>
            !isDocumentFrozen() &&
            tabs.includes(targetTab) &&
            (!requiresDirtyConsent ||
              confirmedReloadStillCurrent(data, targetTab)) &&
            validateReloadResult(data, targetTab, getActiveTab()) === null,
        },
      );
      if (isDocumentFrozen()) {
        if (adoptionApproval) {
          abandonDiskAdoption(adoptionApproval.capability);
        }
        deferFrozenDocumentOperation(
          "ipc:reload-result",
          () => dispatchReloadResult(event, data),
        );
        return;
      }
      if (!adoptionApproval) return;
      let grantCompleted = false;
      let foregroundSelection = null;
      try {
      if (!tabs.includes(targetTab)) {
        return;
      }
      const afterAttestation = validateReloadResult(
        data, targetTab, getActiveTab(),
      );
      if (requiresDirtyConsent &&
          !confirmedReloadStillCurrent(data, targetTab)) {
        notify("The document changed during reload verification. Its edits were kept.", 6000);
        return;
      }
      if (afterAttestation) {
        if (afterAttestation === "document-moved-after-request") {
          rejectReloadResult(targetTab, getActiveTab(), afterAttestation, data);
        } else {
          lastRejectedReloadWhy = afterAttestation;
          console.error("[CustomTabs] Reload superseded during attestation:", afterAttestation);
        }
        return;
      }
      const verifiedVersion = diskVersionForAdoption(
        data.path, data.modifiedTime, data.diskVersion,
      );
      if (!verifiedVersion || !matchesDiskAdoptionApproval(
        adoptionApproval, targetTab, data.path,
        data.content, verifiedVersion,
        { reservedIdentity: reloadReservation },
      )) {
        notify("The file became unavailable or changed before reload adoption.", 6000);
        return;
      }
      const pendingAfterAttestation =
        typeof window.getPendingSaveStatus === "function"
          ? window.getPendingSaveStatus([targetTab.filePath])
          : null;
      if (!pendingAfterAttestation || pendingAfterAttestation.pending) {
        notify("Save status changed during verification. Retry the reload after Save finishes.", 6000);
        return;
      }
      const activeAfter = getActiveTab();
      if (!activeAfter) {
        return;
      }
      const isBackground = !!(
        targetTab && activeAfter && targetTab.id !== activeAfter.id
      );
      if (isBackground && inEditMode() &&
          (targetTab.filePath === activeAfter.filePath ||
            typeof window.invalidateBackgroundEditSessionBaseline !==
              "function")) {
        console.error("[CustomTabs] Background reload cannot safely update its edit baseline");
        notify("This tab's edit baseline could not be updated. Retry its reload after selecting it.", 6000);
        return;
      }
      if (
        !isBackground &&
        startedSwitchIntent !== latestTabSwitchIntent
      ) {
        rejectReloadResult(targetTab, activeAfter, "navigation-changed", data);
        return;
      }
      const anchor = captureAnchor();
      let trackingSelection = null;
      if (!isBackground) {
        if (rendererReloadHandlers.length === 0) {
          rejectReloadResult(
            targetTab, activeAfter, "renderer-handler-unavailable", data,
          );
          return;
        }
        const originalGeneration =
          documentState.get(targetTab).generation;
        trackingSelection =
          typeof window.selectStagedFileReload === "function"
            ? window.selectStagedFileReload(
                data, targetTab.filePath, targetTab.id,
                originalGeneration, adoptionApproval, reloadReservation,
              )
            : null;
        if (
          !trackingSelection ||
          trackingSelection.accepted !== true ||
          trackingSelection.pathKey !== adoptionApproval.pathKey ||
          !sameDiskVersion(
            trackingSelection.diskVersion, adoptionApproval.version,
          ) ||
          !trackingSelection.owner ||
          trackingSelection.owner.pathKey !== adoptionApproval.pathKey ||
          trackingSelection.owner.tabId !== targetTab.id ||
          trackingSelection.owner.documentGeneration !==
            reloadReservation.documentGeneration ||
          (trackingSelection.trackingActive !== true &&
            trackingSelection.unresolvedEvidence !== true &&
            trackingSelection.trackingConflict !== true)
        ) {
          rejectReloadResult(
            targetTab, activeAfter, "tracking-selection-refused", data,
          );
          return;
        }
        grantCompleted = true;
        foregroundSelection = trackingSelection;
      }

      if (!approvedReloadSnapshotMatches(
        adoptionApproval, data.path, targetTab.filePath,
      )) {
        if (!isBackground) {
          quarantineSelectedReload(
            targetTab, activeAfter, "disk-moved-after-approval",
            data, trackingSelection, adoptionApproval,
          );
        } else {
          rejectReloadResult(
            targetTab, activeAfter, "background-disk-moved", data,
          );
        }
        return;
      }
      let appliedPrior = null;
      if (targetTab) {
        const prior = snapshotTabAdoption(targetTab, data.path);
        appliedPrior = prior;
        appliedDiskAdoptionApprovals.add(adoptionApproval);
        if (adoptTabPathIdentity(
          targetTab, data.path || targetTab.filePath,
          adoptionApproval.pathKey,
        ) !== adoptionApproval.pathKey ||
          !approvedReloadSnapshotMatches(
            adoptionApproval, data.path, targetTab.filePath,
          ) ||
          !adoptCleanDocument(
            targetTab, data.content,
            reloadReservation.documentGeneration,
          )) {
          if (!isBackground) {
            quarantineSelectedReload(
              targetTab, activeAfter, "post-selection-cache-refused",
              data, trackingSelection, adoptionApproval, prior,
            );
          } else {
            restoreTabAdoption(targetTab, prior);
            appliedDiskAdoptionApprovals.delete(adoptionApproval);
            rejectReloadResult(
              targetTab, activeAfter, "background-cache-refused", data,
            );
          }
          return;
        }
        if (!approvedReloadSnapshotMatches(
          adoptionApproval, data.path, targetTab.filePath,
        )) {
          if (!isBackground) {
            quarantineSelectedReload(
              targetTab, activeAfter, "disk-moved-during-adoption",
              data, trackingSelection, adoptionApproval, prior,
            );
          } else {
            restoreTabAdoption(targetTab, prior);
            appliedDiskAdoptionApprovals.delete(adoptionApproval);
            rejectReloadResult(
              targetTab, activeAfter, "background-disk-moved", data,
            );
          }
          return;
        }
        targetTab.hasUnsavedChanges = false;
        targetTab.diskVersion = verifiedVersion;
        targetTab.mtimeMs = verifiedVersion.mtimeMs;
        if (isBackground && !completeDiskAdoption(
          adoptionApproval, targetTab, data.path,
        )) {
          restoreTabAdoption(targetTab, prior);
          appliedDiskAdoptionApprovals.delete(adoptionApproval);
          return;
        }
        grantCompleted = true;
        if (isBackground) {
          registerTabDiskOwner(targetTab);
          if (!approvedReloadSnapshotMatches(
            adoptionApproval, data.path, targetTab.filePath,
          )) {
            const identity = documentIdentity(
              targetTab, window.getReloadRequestSession(),
            );
            if (typeof window.reportAdoptionTrackingConflict === "function") {
              window.reportAdoptionTrackingConflict(targetTab.filePath, identity);
            }
            rejectReloadResult(
              targetTab, activeAfter, "background-target-moved", data,
            );
            return;
          }
          if (inEditMode() &&
              !window.invalidateBackgroundEditSessionBaseline(
                targetTab.filePath,
              )) {
            console.error("[CustomTabs] Could not invalidate the reloaded tab's edit baseline");
            notify("The tab was reloaded, but its previous edit baseline could not be cleared.", 6000);
          }
        }
        lastAcceptedReloadSequence = data.reloadRequest.sequence;
        if (trackingSelection &&
            (trackingSelection.unresolvedEvidence === true ||
              trackingSelection.trackingConflict === true)) {
          const state = documentState.get(targetTab);
          state.reloadConflict = true;
          targetTab.hasUnsavedChanges = true;
          bumpTabMutationRevision(state);
          notify(
            trackingSelection.trackingConflict === true
              ? "The file changed again during reload. The earlier disk copy is in the tab; retry before saving."
              : "The file was reloaded, but an earlier deletion is still unresolved. Keep the earlier copy.",
            8000,
          );
        } else if (typeof window.clearReloadConflict === "function") {
          window.clearReloadConflict(targetTab.filePath, {
            preserveCurrent: isBackground,
          });
        }
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
        if (!approvedReloadSnapshotMatches(
          adoptionApproval, data.path, targetTab.filePath,
        )) {
          rejectReloadResult(
            targetTab, getActiveTab(), "background-target-moved", data,
          );
          return;
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

      if (!approvedReloadSnapshotMatches(
        adoptionApproval, data.path, targetTab.filePath,
      )) {
        quarantineSelectedReload(
          targetTab, getActiveTab(), "disk-moved-before-render",
          data, trackingSelection, adoptionApproval, appliedPrior,
        );
        return;
      }
      const reloadPromise = delegateReload(event, {
        ...data,
        trackingSelection,
      });

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
          if (!approvedReloadSnapshotMatches(
            adoptionApproval, data.path, targetTab.filePath,
          )) {
            if (!mayMutateDocument("ipc:reload-result-after-render")) return;
            quarantineSelectedReload(
              targetTab, getActiveTab(), "disk-moved-during-render",
              data, trackingSelection, adoptionApproval,
            );
            return;
          }
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
          } else if (
            window.setUnsavedState &&
            trackingSelection.unresolvedEvidence !== true &&
            trackingSelection.trackingConflict !== true
          ) {
            // renderer.js only clears its unsaved flag when the reload happens
            // in edit mode. In view mode the flag would stay set even though
            // the document was just replaced by the on-disk copy, leaving a
            // phantom "unsaved changes" state that suppresses later prompts.
            window.setUnsavedState(false);
          }

          if (!approvedReloadSnapshotMatches(
            adoptionApproval, data.path, targetTab.filePath,
          )) {
            quarantineSelectedReload(
              targetTab, getActiveTab(), "disk-moved-before-reload-notice",
              data, trackingSelection, adoptionApproval,
            );
            return;
          }
          restorePosition(anchor);
          if (trackingSelection.unresolvedEvidence !== true &&
              trackingSelection.trackingConflict !== true) {
            notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
          }
        })
        .catch((error) => {
          console.error("[CustomTabs] Reload handler failed:", error);
          if (!mayMutateDocument("ipc:reload-render-failure")) return;
          if (
            error.code === "RELOAD_PATH_RETARGETED" ||
            error.code === "RELOAD_PATH_MOVED_DURING_RENDER" ||
            !approvedReloadSnapshotMatches(
              adoptionApproval, data.path, targetTab.filePath,
            )
          ) {
            const preservePrior =
              error.code === "RELOAD_PATH_RETARGETED" &&
              appliedPrior && tabs.includes(targetTab) &&
              documentState.get(targetTab)?.generation ===
                reloadReservation.documentGeneration &&
              targetTab.content === data.content
                ? appliedPrior
                : null;
            quarantineSelectedReload(
              targetTab, getActiveTab(), "reload-render-disk-moved",
              data, trackingSelection, adoptionApproval, preservePrior,
            );
            return;
          }
          const state = documentState.get(targetTab);
          if (state && tabs.includes(targetTab)) {
            state.reloadConflict = true;
            targetTab.hasUnsavedChanges = true;
            bumpTabMutationRevision(state);
            if (typeof window.markReloadConflict === "function") {
              window.markReloadConflict(targetTab.filePath);
            }
            renderTabs();
            saveTabs();
          }
          if (generation !== renderGeneration ||
              activeTabId !== reloadTabId) return;
          notify(
            "The reloaded file could not be displayed. Its disk copy is in the tab; retry the reload before saving.",
            8000,
          );
        });
      } catch (error) {
        if (foregroundSelection &&
            tabs.includes(targetTab) &&
            getActiveTab() === targetTab) {
          rejectReloadResult(
            targetTab, targetTab, "post-selection-reload-error", data,
          );
          if (typeof window.reportAdoptionTrackingConflict === "function") {
            window.reportAdoptionTrackingConflict(
              targetTab.filePath, foregroundSelection.owner,
            );
          }
        }
        throw error;
      } finally {
        if (!grantCompleted) {
          abandonDiskAdoption(adoptionApproval.capability);
        }
      }
    };

    const dispatchReloadResult = (event, data) => {
      const consent = pendingConfirmedReload;
      handleReloadResult(event, data)
        .catch((error) => {
          console.error("[CustomTabs] Reload result processing failed:", error);
          notify("The reload result could not be applied.", 6000);
        })
        .finally(() => {
          if (
            consent &&
            pendingConfirmedReload === consent &&
            data?.reloadRequest?.sequence === consent.sequence &&
            data.reloadRequest.session === consent.session
          ) pendingConfirmedReload = null;
        });
    };
    documentEvents.on("file-reload-result", dispatchReloadResult);
  } else if (documentEvents) {
    // Compatibility mode still needs freeze-safe delivery even though the
    // upstream renderer remains the sole owner of reload acceptance.
    const compatibilityReloadHandlers = documentEvents.listeners
      ? documentEvents.listeners("file-reload-result").slice()
      : [];
    if (compatibilityReloadHandlers.length > 0) {
      documentEvents.removeAllListeners("file-reload-result");
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
      documentEvents.on(
        "file-reload-result",
        handleCompatibleReloadResult,
      );
    }
  }

  if (documentEvents) {
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
    const rendererSaveHandlers = documentEvents.listeners
      ? documentEvents.listeners("save-markdown-result").slice()
      : [];
    const rendererSaveHandler =
      rendererSaveHandlers.length === 1
        ? rendererSaveHandlers[0]
        : null;
    if (!rendererSaveHandler) {
      console.error(
        `[CustomTabs] Expected exactly one renderer save handler, found ${rendererSaveHandlers.length}`,
      );
    }
    documentEvents.removeAllListeners("save-markdown-result");

    const handleSaveResult = (event, data) => {
      if (isDocumentFrozen()) {
        const requestId = data && data.requestId;
        if (queuedFrozenSaveRequests.has(requestId)) return;
        const queuedBefore = frozenDocumentOperations.length;
        deferFrozenDocumentOperation(
          "ipc:save-result",
          () => {
            queuedFrozenSaveRequests.delete(requestId);
            handleSaveResult(event, data);
          },
        );
        if (frozenDocumentOperations.length > queuedBefore) {
          queuedFrozenSaveRequests.add(requestId);
        }
        return;
      }
      let decision = null;
      if (rendererSaveHandler) {
        try {
          const candidate = rendererSaveHandler(event, data);
          if (candidate) decision = candidate;
        } catch (error) {
          console.error("[CustomTabs] Save handler failed:", error);
        }
      }
      if (
        !decision ||
        decision.mayMutate !== true ||
        appliedTabSaveDecisions.has(decision)
      ) return;
      const applyDecision = () => {
        if (appliedTabSaveDecisions.has(decision)) return;
        if (typeof window.applyRendererSaveResultDecision === "function") {
          window.applyRendererSaveResultDecision(decision);
        }
        if (applySaveResultDecision(decision)) {
          appliedTabSaveDecisions.add(decision);
        }
      };
      applyDecision();
    };
    documentEvents.on("save-markdown-result", handleSaveResult);
  }

  if (documentEvents && canOwnFileOpen) {
    // The watcher follows the active tab, but a change event queued just
    // before a tab switch can still arrive afterwards. renderer.js prompts
    // without checking which file the event was for, and its "Reload" action
    // reloads currentFilePath - i.e. the wrong document. Drop stale events.
    // This filter is installed only while CustomTabs owns file-open lifecycle;
    // compatibility mode leaves renderer's notification handler untouched.
    const rendererChangeHandlers = documentEvents.listeners
      ? documentEvents.listeners("file-changed-externally").slice()
      : [];
    documentEvents.removeAllListeners("file-changed-externally");

    documentEvents.on("file-changed-externally", (event, data) => {
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
  function requestReloadWithConfirmation() {
    if (isDocumentFrozen() ||
        !mayMutateDocument("tab:confirmed-reload")) return false;
    const tab = snapshotActiveTab({ capturePosition: false });
    if (!tab || tab.id !== activeTabId) return false;
    const state = documentState.get(tab);
    if (!state) return false;
    const pending = typeof window.getPendingSaveStatus === "function"
      ? window.getPendingSaveStatus([tab.filePath])
      : null;
    const promptRevision = state.mutationRevision;
    const promptOverflowCount = frozenDocumentOperationOverflowCount;
    const promptContent = tab.content;
    const promptOriginalContent = tab.originalContent;
    const promptLive = liveDocument();
    const promptSwitchIntent = latestTabSwitchIntent;
    if (
      isDirty(tab) ||
      (typeof window.hasUnsavedWorkForReload === "function"
        ? window.hasUnsavedWorkForReload()
        : true) ||
      !pending || pending.pending
    ) {
      const message = t(
        "confirm.unsavedRefresh",
        "You have unsaved changes. Reload from disk and discard them?",
      );
      if (!window.confirm(message)) {
        if (pendingConfirmedReload) pendingConfirmedReload.invalidated = true;
        return false;
      }
    }
    const pendingAfterPrompt = window.getPendingSaveStatus?.([tab.filePath]);
    if (
      !pending || pending.pending ||
      !pendingAfterPrompt || pendingAfterPrompt.pending ||
      !Number.isSafeInteger(promptRevision) ||
      state.mutationRevision !== promptRevision ||
      frozenDocumentOperationOverflowCount !== promptOverflowCount ||
      tab.content !== promptContent ||
      tab.originalContent !== promptOriginalContent ||
      liveDocument() !== promptLive ||
      latestTabSwitchIntent !== promptSwitchIntent ||
      getActiveTab() !== tab
    ) {
      notify("The document changed during reload confirmation. Its edits were kept.", 6000);
      return false;
    }
    const requestReload =
      typeof window.requestCurrentFileReload === "function"
        ? window.requestCurrentFileReload
        : typeof window.reloadCurrentFile === "function"
          ? window.reloadCurrentFile
          : null;
    if (!requestReload) {
      notify(
        t(
          "notif.reloadFailed",
          "Reload is unavailable because request metadata cannot be created.",
        ),
        4000,
      );
      return false;
    }
    const session = window.getReloadRequestSession?.();
    const identity = documentIdentity(tab, session);
    const requestPath = canonicalTabPath(tab.filePath);
    const priorSequence = window.getLatestReloadRequestSequence?.(tab.filePath);
    const content = tab.content;
    const originalContent = tab.originalContent;
    const live = liveDocument();
    const revision = state.mutationRevision;
    const deferredOverflowCount = frozenDocumentOperationOverflowCount;
    const switchIntent = latestTabSwitchIntent;
    const selectionGeneration = window.getActiveFileSelectionGeneration?.();
    if (pendingConfirmedReload) pendingConfirmedReload.invalidated = true;
    pendingConfirmedReload = null;
    if (!requestReload()) return false;
    if (isDirty(tab)) {
      const sequence = window.getLatestReloadRequestSequence?.(tab.filePath);
      const pendingAfterRequest =
        window.getPendingSaveStatus?.([tab.filePath]);
      if (
        !identity || !requestPath || typeof live !== "string" ||
        !Number.isSafeInteger(selectionGeneration) ||
        !Number.isSafeInteger(priorSequence) ||
        !Number.isSafeInteger(sequence) || sequence <= priorSequence ||
        !Number.isSafeInteger(revision) ||
        state.mutationRevision !== revision ||
        frozenDocumentOperationOverflowCount !== deferredOverflowCount ||
        !pendingAfterRequest || pendingAfterRequest.pending ||
        tab.content !== content ||
        liveDocument() !== live
      ) return false;
      pendingConfirmedReload = {
        tab, identity, requestPath, sequence, session, content,
        originalContent, live, revision, switchIntent,
        selectionGeneration, deferredOverflowCount,
        invalidated: false,
      };
    }
    return true;
  }

  function reloadFromUpdatePrompt() {
    // Declining keeps the stale-file prompt visible.
    if (requestReloadWithConfirmation()) {
      dismissUpdatePrompt();
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

  function dirtyTabNames(
    includeDeletionConflicts = false,
    { failOnDroppedOperations = true } = {},
  ) {
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
    // A one-shot document update was dropped while this document was frozen
    // and cannot be reconstructed, so the cached state this answer would be
    // computed from is no longer known to describe the document. Checked
    // BEFORE the pending-save deferral: waiting cannot make a dropped event
    // arrive, and the honest answer is already available. Reported as
    // unreadable, which routes the close through the explicit fallback
    // question rather than a clean list nothing can stand behind.
    //
    // PHASE ONE ONLY. Phase two asks a narrower question - "has the document
    // moved since the answer you already have?" - and by the time it runs, the
    // reader has been shown the unreadable question and has answered it.
    // Refusing there as well would put the app in a loop between the same
    // dialog and the same refusal with no way out, which is a worse failure
    // than the one this guard exists to prevent. The drop itself already bumped
    // the revision, so real movement is still caught by the revision check.
    if (failOnDroppedOperations && frozenDocumentOperationsDropped) {
      throw new Error(
        "document updates were dropped while frozen: " +
          droppedFrozenDocumentOperations.join(", "),
      );
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
    return tabs
      .filter((tab) => {
        if (isDirty(tab)) return true;
        if (!includeDeletionConflicts) return false;
        const state = documentState.get(tab);
        return !!(state && state.deletionTombstone);
      })
      .map((tab) => tab.filename);
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
    window.folia.requestQuitApprovalRetry({
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
      deferredOperationsOverflowed: false,
    };
    if (editor) editor.readOnly = true;
    if (inertOwner) inertOwner.inert = true;
    if (
      typeof window.assertFileTrackingOwnership === "function" &&
      window.currentFilePath
    ) {
      // Disk notifications can arrive after the commit ACK but before main
      // continues. Keep the owner, but stop the active watcher until thaw so
      // no file-change prompt is applied to a frozen document.
      window.assertFileTrackingOwnership(window.currentFilePath, false, {
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

  window.folia.onQuitApprovalCommit(async data => {
    const id = data && data.id;
    const generation = data && data.gen;
    const revision = data && data.revision;
    // Declared before `reply` closes over it: the early refusals below run
    // before the re-check, and reading it there would be a temporal-dead-zone
    // throw inside the one handler that must always answer.
    let recheckedDirtyFiles = null;
    const reply = (committed, why) =>
      window.folia.respondToQuitCommit({
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
      recheckedDirtyFiles = dirtyTabNames(true, {
        failOnDroppedOperations: false,
      });
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
    if (sessionRestoreInProgress) {
      sessionRestoreToken += 1;
      sessionRestoreInProgress = false;
    }
    const active = getActiveTab();
    if (active) {
      active.scrollPosition = getScroller()?.scrollTop || 0;
      active.anchor = captureAnchor();
    }
    const layoutRevision = saveTabs();
    if (!Number.isSafeInteger(layoutRevision)) {
      reply(false, "session-layout-unavailable");
      return;
    }
    freezeDocument(id, generation);
    const frozen = shutdownFreeze;
    try {
      await settleSessionLayout();
    } catch (error) {
      if (shutdownFreeze === frozen) thawDocument("session-layout-persistence-failed");
      reply(false, "session-layout-persistence-failed");
      return;
    }
    if (shutdownFreeze !== frozen || approvalRendererGeneration !== generation ||
        documentRevision !== revision || sessionLayoutRevision !== layoutRevision ||
        durableSessionLayoutRevision !== layoutRevision) {
      if (shutdownFreeze === frozen) thawDocument("session-layout-revision-moved");
      reply(false, "revision-moved");
      return;
    }
    reply(true, "committed");
  });

  window.folia.onQuitApprovalThaw(() => {
    thawDocument("main-released");
  });

  window.folia.onQuitApprovalVerification(data => {
    const valid = !!(
      data &&
      shutdownFreeze &&
      shutdownFreeze.id === data.id &&
      shutdownFreeze.gen === data.gen &&
      data.gen === approvalRendererGeneration &&
      data.revision === documentRevision &&
      !sessionLayoutRunning && !pendingSessionLayout && !sessionLayoutFailure &&
      durableSessionLayoutRevision === sessionLayoutRevision &&
      !shutdownFreeze.deferredOperationsOverflowed
    );
    window.folia.respondToQuitVerification({
      id: data && data.id,
      gen: data && data.gen,
      revision: documentRevision,
      valid,
    });
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
  window.folia.onQuitApprovalRequest(data => {
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
      window.folia.respondToQuitApproval(cached);
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
      dirtyFiles = dirtyTabNames(true);
    } catch (error) {
      if (error && error.code === "FOLIA_PENDING_SAVE") {
        pendingSaveShutdownRetry = {
          id,
          gen: generation,
          sent: false,
        };
        window.folia.respondToQuitApproval({
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
    window.folia.respondToQuitApproval(response);
  });

  // ============================================
  // Export API
  // ============================================

  window.CustomTabs = {
    createTab,
    switchToTab,
    requestReloadWithConfirmation,
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
    __loadSavedTabs: () => loadSavedTabs({ repeat: true }),
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
          deletionTombstone: false,
          deletionEventId: 0,
          liveWitnessMatchesContent: false,
          mutationRevision: null,
        });
      }
      const deletionTombstone = state.deletionTombstone;
      return Object.freeze({
        maintained: true,
        dirty: state.dirty || state.reloadConflict || state.saveFailure,
        reloadConflict: state.reloadConflict,
        // This is the renderer-owned evidence, not main's path tombstone.
        // Keeping the summary fixed-size lets a regression prove that a
        // recreated path and a tab round-trip did not silently adopt disk.
        deletionTombstone: !!deletionTombstone,
        deletionEventId: deletionTombstone
          ? deletionTombstone.eventId
          : 0,
        liveWitnessMatchesContent: state.foldedLive === state.content,
        mutationRevision: state.mutationRevision,
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
        deferredOperationLimit: MAX_FROZEN_DOCUMENT_OPERATIONS,
        deferredOperationOverflowCount:
          frozenDocumentOperationOverflowCount,
        // Sticky for the life of the page, unlike the per-freeze flag below:
        // the shutdown answer stays unreadable while it is set.
        deferredOperationsDropped: frozenDocumentOperationsDropped,
        droppedDeferredOperationSources: Object.freeze(
          droppedFrozenDocumentOperations.slice(),
        ),
        deferredOperationsOverflowed: !!(
          shutdownFreeze &&
          shutdownFreeze.deferredOperationsOverflowed
        ),
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
    getDocumentDescriptor: (tabId = activeTabId) =>
      documentState.get(tabs.find(tab => tab.id === tabId))?.admission || null,
    settleSessionLayout,
    getActiveDocumentIdentity,
    getDocumentIdentityForTab,
    ownsDocumentIdentity,
    retainDeletionTombstone,
    noteActiveContentMutation,
    prepareSaveRequest,
    applySaveResultDecision,
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
  window.folia
    .getQuitApprovalGeneration()
    .then((generation) => {
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error("main returned an invalid renderer generation");
      }
      approvalRendererGeneration = generation;
      const pageSession =
        typeof window.getReloadRequestSession === "function"
          ? window.getReloadRequestSession()
          : null;
      if (
        typeof pageSession !== "string" ||
        pageSession.length === 0 ||
        pageSession.length > 128
      ) {
        throw new Error("renderer page session is unavailable");
      }
      window.folia.announceQuitApprovalReady({
        gen: generation,
        pageSession,
      });
      for (const tab of tabs) registerTabDiskOwner(tab);
      // A restore can finish before this asynchronous handshake. Re-activate
      // only the exact tab/generation/path snapshot that performed that restore,
      // carrying its original disk version so newer bytes cannot be blessed
      // underneath the stale cached document.
      activatePreHandshakeTrackingAssertion();
      if (pendingRestoredTabId !== null) {
        const tabId = pendingRestoredTabId;
        pendingRestoredTabId = null;
        switchToTab(tabId, {
          silent: true,
          fileOpenOptions: { adoptPathIdentity: true },
        }).catch((error) => {
          console.error("[CustomTabs] Deferred tab restore failed:", error);
        });
      }
      for (const replay of pendingHandshakeFileOpens.splice(0)) {
        try {
          Promise.resolve(replay()).catch((error) => {
            console.error("[CustomTabs] Deferred file open failed:", error);
            notify("Could not open a file after document ownership became ready.", 6000);
          });
        } catch (error) {
          console.error("[CustomTabs] Deferred file open failed:", error);
          notify("Could not open a file after document ownership became ready.", 6000);
        }
      }
      resolveSessionOwnerReady(true);
    })
    .catch((error) => {
      resolveSessionOwnerReady(false);
      pendingHandshakeTrackingAssertion = null;
      if (pendingHandshakeFileOpens.length > 0) {
        pendingHandshakeFileOpens.length = 0;
        notify("Files could not be opened because document ownership did not become ready.", 6000);
      }
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
