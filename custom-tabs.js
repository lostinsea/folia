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
  const fileInfoBar = document.getElementById("fileInfoBar");

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
    return normaliseNewlines(a) === normaliseNewlines(b);
  }

  // renderer.js keeps `hasUnsavedChanges` module-private, and its
  // `#unsavedIndicator` element is not a reliable proxy: exiting edit mode
  // leaves the flag and the element's inline style set (renderer.js:1838-1852),
  // so reading it bleeds one tab's dirty state onto the next. Derive dirtiness
  // from the tab's own cache instead - it is exact and needs no renderer state.
  function isDirty(tab) {
    return !sameDocument(tab.content, tab.originalContent);
  }

  // The document as the user currently has it. In edit mode the textarea is
  // authoritative (it holds keystrokes renderer has not folded back into
  // `originalMarkdown` yet); in view mode renderer's `originalMarkdown` is.
  function liveDocument() {
    return window.isEditMode && window.markdownEditor
      ? window.markdownEditor.value
      : window.originalMarkdown;
  }

  function getMtime(filePath) {    try {
      return window.fs ? window.fs.statSync(filePath).mtimeMs : null;
    } catch (error) {
      return null;
    }
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
    result = fileHelpers.wrapOmniWareContent(result, filePath);
    return result;
  }

  function readFromDisk(filePath) {
    return normaliseFileContent(
      window.fs.readFileSync(filePath, "utf8"),
      filePath,
    );
  }

  // renderer.js owns the toast DOM and the i18n table. Reuse both when
  // available so overlay messages match the selected interface language, and
  // degrade to English rather than throwing if either is missing.
  function t(key, fallback) {
    return typeof window.i18n === "function" ? window.i18n(key) : fallback;
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
        "Re-add the export in renderer.js (see CUSTOMIZATIONS.md).",
    );
    const toast = document.getElementById("fileUpdateToast");
    if (toast) toast.classList.remove("show");
  }

  // ============================================
  // Scroll Position Preservation
  // ============================================

  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

  function offsetWithin(scroller, element) {
    return (
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
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

    const mtime = getMtime(tab.filePath);
    if (mtime === null) return false; // missing or unreadable - keep the cache
    if (tab.mtimeMs !== null && mtime === tab.mtimeMs) return false;

    try {
      const content = readFromDisk(tab.filePath);
      tab.content = content;
      tab.originalContent = content;
      tab.mtimeMs = mtime;
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

  function createTab(filePath, content) {
    const tabId = ++tabIdCounter;
    const pathParts = filePath.split(/[\\/]/);
    const filename = pathParts[pathParts.length - 1];

    const tab = {
      id: tabId,
      filePath: filePath,
      filename: filename,
      content: content,
      originalContent: content,
      hasUnsavedChanges: false,
      scrollPosition: 0,
      anchor: null,
      mtimeMs: getMtime(filePath),
    };

    tabs.push(tab);
    console.log(
      "[CustomTabs] Created tab:",
      filename,
      "Total tabs:",
      tabs.length,
    );
    renderTabs();
    switchToTab(tabId);
    saveTabs();

    return tab;
  }

  function renderTabs() {
    console.log("[CustomTabs] Rendering tabs, count:", tabs.length);

    if (tabs.length === 0) {
      tabsContainer.style.display = "none";
      fileInfoBar.style.display = "none";
      return;
    }

    // Show tabs when 2+ files open, otherwise show file info bar
    if (tabs.length >= 2) {
      tabsContainer.style.display = "flex";
      fileInfoBar.style.display = "none";
    } else {
      tabsContainer.style.display = "none";
      fileInfoBar.style.display = "flex";
    }

    // Clear and rebuild tabs
    tabsElement.innerHTML = "";

    tabs.forEach((tab) => {
      const tabElement = document.createElement("div");
      tabElement.className = "tab" + (tab.id === activeTabId ? " active" : "");
      tabElement.dataset.tabId = tab.id;

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

      tabsElement.appendChild(tabElement);
    });
  }

  // Fold whatever the renderer currently holds back into the tab record.
  // Must run before anything trusts tab.content / tab.hasUnsavedChanges.
  function snapshotActiveTab() {
    if (!activeTabId) return null;
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (!currentTab) return null;

    const scroller = getScroller();
    if (scroller) {
      currentTab.scrollPosition = scroller.scrollTop;
    }
    currentTab.anchor = captureAnchor();

    if (window.isEditMode && window.markdownEditor) {
      // Only adopt the editor's text if it is a real edit. If it differs from
      // the cached copy solely by the newline normalisation the textarea
      // applied when switchToTab assigned it, keeping the cached copy
      // preserves the file's original CRLF endings instead of silently
      // rewriting the document to LF.
      const edited = window.markdownEditor.value;
      if (!sameDocument(edited, currentTab.content)) {
        currentTab.content = edited;
      }
    } else if (
      typeof window.originalMarkdown === "string" &&
      !sameDocument(window.originalMarkdown, currentTab.originalContent)
    ) {
      // View-mode edits (tables, checkboxes, notes) are applied by
      // renderer.js to originalMarkdown rather than to the editor.
      currentTab.content = window.originalMarkdown;
    }
    currentTab.hasUnsavedChanges = isDirty(currentTab);
    return currentTab;
  }

  // Bumped on every switch so a superseded render's .then() cannot drag the
  // newly active tab to the previous tab's anchor.
  let renderGeneration = 0;

  function switchToTab(tabId) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    snapshotActiveTab();

    activeTabId = tabId;
    console.log("[CustomTabs] Switched to tab:", tab.filename);

    // The file may have been rewritten while this tab sat in the background.
    // Pick that up now so switching never repaints a stale copy.
    const autoReloaded = refreshTabFromDisk(tab);

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

    // Update file info if present
    if (window.updateFileInfo) {
      window.updateFileInfo(tab.filePath);
    }

    // Set global current file path and originalMarkdown.
    // This must be tab.content, not tab.originalContent: renderer.js applies
    // view-mode edits (notes, tables, checkboxes) as incremental string splices
    // on originalMarkdown. Seeding it with the on-disk copy while rendering the
    // edited copy makes the next splice build on the wrong base and silently
    // drop every earlier unsaved edit. When the tab is clean the two are equal.
    window.currentFilePath = tab.filePath;
    if (window.originalMarkdown !== undefined) {
      window.originalMarkdown = tab.content;
    }

    // Render content
    if (window.renderMarkdown) {
      const position = positionOf(tab);
      const generation = ++renderGeneration;
      window.renderMarkdown(tab.content).then(() => {
        if (generation === renderGeneration) {
          restorePosition(position);
        }
      });
    }

    // Update editor if in edit mode
    if (window.isEditMode && window.markdownEditor) {
      window.markdownEditor.value = tab.content;
    }

    // renderer.js tracks unsaved state in a single global. Restore this tab's
    // value so its refresh / exit-edit guards apply to the right document.
    if (window.setUnsavedState) {
      window.setUnsavedState(tab.hasUnsavedChanges);
    }

    // Notify main process. Watching is paused while a document has unsaved
    // edits, and that is per-document state, so it has to move with the tab -
    // otherwise a clean tab inherits a pause and is never watched, or a dirty
    // tab inherits an armed watcher and prompts mid-edit.
    if (window.ipcRenderer) {
      window.ipcRenderer.send("set-active-file", tab.filePath);
      window.ipcRenderer.send(
        tab.hasUnsavedChanges ? "pause-file-watching" : "resume-file-watching",
      );
    }

    saveTabs();
  }

  function closeTab(tabId) {
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];

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
          window.ipcRenderer.send("stop-file-watching");
        }
        window.currentFilePath = null;
        if (window.setUnsavedState) {
          window.setUnsavedState(false);
        }
        dismissUpdatePrompt();
        if (window.viewer) {
          window.viewer.innerHTML = `
            <div class="welcome">
              <h1>Welcome to Markdown Viewer</h1>
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
  }

  function updateTabContent(content, hasChanges) {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) {
      tab.content = content;
      tab.hasUnsavedChanges = hasChanges;
      if (!hasChanges) {
        tab.originalContent = content;
        tab.mtimeMs = getMtime(tab.filePath);
      }
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
          tabsData.forEach((tabData) => {
            try {
              if (window.fs.existsSync(tabData.filePath)) {
                const content = readFromDisk(tabData.filePath);
                const tab = createTab(tabData.filePath, content);
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
          });

          // Re-activate the tab that was active when the app was closed.
          if (tabs.length > 0) {
            const restored =
              (savedActiveTabPath && findTabByPath(savedActiveTabPath)) ||
              tabs[0];
            switchToTab(restored.id);
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

  function findTabByPath(filePath) {
    return tabs.find((t) => t.filePath === filePath);
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId);
  }

  // ============================================
  // Intercept file-opened events
  // ============================================

  if (window.ipcRenderer) {
    // Store original listener
    const originalListeners = window.ipcRenderer._events
      ? window.ipcRenderer._events["file-opened"]
      : null;

    // Remove existing listeners and add our interceptor
    window.ipcRenderer.removeAllListeners("file-opened");

    window.ipcRenderer.on("file-opened", (event, data) => {
      console.log("[CustomTabs] Intercepted file-opened:", data.path);

      const { content, path: filePath, allPaths } = data;

      // Check if file already open
      const existingTab = findTabByPath(filePath);
      if (existingTab) {
        console.log("[CustomTabs] File already open, switching to tab");
        switchToTab(existingTab.id);
        return;
      }

      // Create new tab
      createTab(filePath, content);

      // If multiple files selected, open them all
      if (allPaths && allPaths.length > 1) {
        allPaths.slice(1).forEach((extraPath) => {
          if (!findTabByPath(extraPath) && window.fs) {
            try {
              createTab(extraPath, readFromDisk(extraPath));
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
    });
  }

  // ============================================
  // Keep the tab store in sync with disk
  // ============================================

  if (window.ipcRenderer) {
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
          if (window.isEditMode && window.markdownEditor) {
            window.markdownEditor.value = data.content;
          }
          if (window.setUnsavedState) {
            window.setUnsavedState(false);
          }
          notify(t("notif.fileReloaded", "File reloaded successfully"), 2000);
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

    window.ipcRenderer.on("file-reload-result", (event, data) => {
      if (!data || !data.success) {
        delegateReload(event, data).catch((error) =>
          console.error("[CustomTabs] Reload handler failed:", error),
        );
        return;
      }

      const targetTab = data.path ? findTabByPath(data.path) : getActiveTab();
      const activeTab = getActiveTab();
      const isBackground = !!(targetTab && activeTab && targetTab.id !== activeTab.id);
      const anchor = captureAnchor();

      if (targetTab) {
        targetTab.content = data.content;
        targetTab.originalContent = data.content;
        targetTab.hasUnsavedChanges = false;
        targetTab.mtimeMs = getMtime(targetTab.filePath);
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
              targetTab.content = live;
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
        })
        .catch((error) =>
          console.error("[CustomTabs] Reload handler failed:", error),
        );
    });

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
      const isForCurrent =
        !data || !data.path || data.path === window.currentFilePath;

      if (isForCurrent) {
        rendererSaveHandlers.forEach((fn) => {
          try {
            fn(event, data);
          } catch (error) {
            console.error("[CustomTabs] Save handler failed:", error);
          }
        });
      } else {
        console.log("[CustomTabs] Save result is for a background tab:", data.path);
      }

      if (!data || !data.success) return;

      const tab = data.path ? findTabByPath(data.path) : getActiveTab();
      // The tab was closed while the write was in flight. Falling back to the
      // active tab would overwrite an unrelated document's cache and falsely
      // mark it clean.
      if (!tab) return;

      try {
        if (window.fs) {
          const content = readFromDisk(tab.filePath);
          tab.content = content;
          tab.originalContent = content;
        }
      } catch (error) {
        console.error("[CustomTabs] Post-save read failed:", error);
      }

      tab.hasUnsavedChanges = false;
      tab.mtimeMs = getMtime(tab.filePath);
      renderTabs();
      saveTabs();
    });

    // The watcher follows the active tab, but a change event queued just
    // before a tab switch can still arrive afterwards. renderer.js prompts
    // without checking which file the event was for, and its "Reload" action
    // reloads currentFilePath - i.e. the wrong document. Drop stale events.
    // Installed unconditionally so the filter survives a renderer refactor
    // that registers its listener later than this module runs.
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
        console.log("[CustomTabs] Ignoring stale change event:", data.path);
        return;
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

    if (typeof window.reloadCurrentFile === "function") {
      window.reloadCurrentFile();
    } else if (window.ipcRenderer && window.currentFilePath) {
      window.ipcRenderer.send("reload-file", {
        filePath: window.currentFilePath,
      });
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

  // Monitor edit button clicks to track edit mode state
  document.addEventListener("DOMContentLoaded", () => {
    bindUpdatePrompt();

    const toggleEditBtn = document.getElementById("toggleEdit");
    if (toggleEditBtn) {
      toggleEditBtn.addEventListener("click", () => {
        // Wait a tick for renderer.js to update isEditMode
        setTimeout(() => {
          // Check if we're in edit mode by checking the class
          const contentWrapper = document.querySelector(".content-wrapper");
          window.isEditMode =
            contentWrapper && contentWrapper.classList.contains("split-view");
          console.log("[CustomTabs] Edit mode changed to:", window.isEditMode);
        }, 10);
      });
    }
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
// Header Integration
// Merges the file-info-bar into the header row,
// hides back/forward nav buttons, shortens the
// home-dir portion of the path to ~, and adds
// responsive compact mode for narrow windows.
// ============================================
(function initHeaderIntegration() {
  "use strict";

  const os = require("os");
  const homeDir = os.homedir();

  function shortenPath(text) {
    if (text && text.startsWith(homeDir)) {
      return text.replace(homeDir, "~");
    }
    return text;
  }

  function integrateFileInfoBar() {
    const header = document.querySelector(".header");
    const controls = document.querySelector(".controls");
    const fileInfoBarEl = document.getElementById("fileInfoBar");

    if (!header || !controls || !fileInfoBarEl) return;

    // Move fileInfoBar into .header before the controls group
    header.insertBefore(fileInfoBarEl, controls);
    header.classList.add("header-integrated");

    // Hide back / forward navigation buttons (tabs replace this workflow)
    const navBack = document.getElementById("navBackBtn");
    const navForward = document.getElementById("navForwardBtn");
    if (navBack) navBack.style.display = "none";
    if (navForward) navForward.style.display = "none";

    // Watch #filePath for text changes.
    // renderer.js sets filePath = directory and fileName = filename separately.
    // We combine them into a single "~/dir/filename.md" string so the tab name
    // is not repeated in the bar. Clicking still copies the full path (handled
    // by the existing click listener in renderer.js which uses currentFilePath).
    const filePathEl = document.getElementById("filePath");
    const fileNameEl = document.getElementById("fileName");

    function buildFullPath() {
      const dir = filePathEl ? filePathEl.textContent : "";
      const name = fileNameEl ? fileNameEl.textContent : "";
      // Only combine when the dir looks like a real path.
      // Notification strings (e.g. "✓ Path copied to clipboard") start with
      // neither "/" nor "~", so we leave them untouched.
      if (!name || !dir || (!dir.startsWith("/") && !dir.startsWith("~")))
        return dir;
      // Guard: already ends with the filename — nothing to do
      if (dir.endsWith("/" + name)) return dir;
      return dir + "/" + name;
    }

    if (filePathEl) {
      const observerOpts = {
        childList: true,
        characterData: true,
        subtree: true,
      };

      const observer = new MutationObserver(() => {
        const combined = shortenPath(buildFullPath());
        if (combined !== filePathEl.textContent) {
          observer.disconnect();
          filePathEl.textContent = combined;
          observer.observe(filePathEl, observerOpts);
        }
      });
      observer.observe(filePathEl, observerOpts);

      // Apply immediately if a path is already set
      if (filePathEl.textContent) {
        filePathEl.textContent = shortenPath(buildFullPath());
      }
    }

    // Responsive compact mode: narrow window → "MV" + icon-only buttons
    function applyCompact() {
      document.body.classList.toggle("compact-header", window.innerWidth < 780);
    }
    applyCompact();
    window.addEventListener("resize", applyCompact);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(integrateFileInfoBar, 150);
  } else {
    document.addEventListener("DOMContentLoaded", integrateFileInfoBar);
  }
})();
