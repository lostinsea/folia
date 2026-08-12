/**
 * Custom Collapse/Expand Module
 * Adds "Collapse All" and "Expand All" to the top of the View menu.
 *
 * The upstream renderer already implements per-heading collapsible sections
 * via makeHeadersCollapsible() (called after every render). It creates
 * .collapsible-section wrappers, persists state in the collapsedHeaders Map,
 * and handles individual heading clicks with ▼/▶ indicators.
 *
 * This overlay only adds the two "Collapse/Expand All" shortcuts to the View
 * menu and wires them to the upstream infrastructure.
 * H1 headings are intentionally skipped by Collapse All — collapsing the
 * document title makes no practical sense.
 *
 * Overlay file — never touched by upstream merges.
 * Load after renderer.js in index.html.
 */

(function initCustomCollapse() {
  "use strict";

  // ── Collapse / Expand all ─────────────────────────────────────────────────
  // Uses the same .collapsed class + collapsedHeaders Map that the upstream
  // makeHeadersCollapsible() uses, so state is consistent across re-renders.

  function collapseAll() {
    const v = document.getElementById("viewer");
    if (!v) return;

    // Collapse each heading's section, skip H1 (top-level title)
    v.querySelectorAll("h2,h3,h4,h5,h6").forEach((header) => {
      if (!header.id) return;
      header.classList.add("collapsed");
      const section = v.querySelector(
        `.collapsible-section[data-for-header="${CSS.escape(header.id)}"]`,
      );
      if (section) section.classList.add("collapsed");
      // Persist state in the upstream Map so re-renders restore it correctly.
      // The key MUST go through _collapseKey(): the Map is shared by every open
      // document and renderer.js only ever reads it under that prefixed key, so
      // a raw header.id is written into a key space nothing reads - Collapse All
      // would silently unwind on the next re-render.
      if (
        typeof collapsedHeaders !== "undefined" &&
        typeof _collapseKey === "function"
      ) {
        collapsedHeaders.set(_collapseKey(header.id), true);
      }
    });

    // Tables inside a section that is now hidden cannot be measured, and tables
    // elsewhere may gain room as the page shortens. See applyTableBreakout.
    if (typeof applyTableBreakout === "function") applyTableBreakout();
  }

  function expandAll() {
    const v = document.getElementById("viewer");
    if (!v) return;

    v.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((header) => {
      if (!header.id) return;
      header.classList.remove("collapsed");
      const section = v.querySelector(
        `.collapsible-section[data-for-header="${CSS.escape(header.id)}"]`,
      );
      if (section) section.classList.remove("collapsed");
      if (
        typeof collapsedHeaders !== "undefined" &&
        typeof _collapseKey === "function"
      ) {
        collapsedHeaders.set(_collapseKey(header.id), false);
      }
    });

    // Every table revealed here was last measured before it was hidden, and the
    // window may have been resized in between. Without this, collapse at one
    // size then expand at another leaves a table painted off both edges.
    if (typeof applyTableBreakout === "function") applyTableBreakout();
  }

  // ── Inject View menu items ────────────────────────────────────────────────

  function injectViewMenuItems() {
    const viewMenu = document.getElementById("viewMenu");
    if (!viewMenu || document.getElementById("collapseAllBtn")) return;

    const collapseSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
      <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>`;
    const expandSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>`;

    const collapseItem = document.createElement("div");
    collapseItem.className = "tools-menu-item custom-collapse-item";
    collapseItem.id = "collapseAllBtn";
    collapseItem.innerHTML = `${collapseSvg}<span>Collapse All</span>`;
    collapseItem.addEventListener("click", (e) => {
      e.stopPropagation();
      collapseAll();
      // Close the View dropdown by simulating a document click
      setTimeout(() => document.dispatchEvent(new MouseEvent("click")), 10);
    });

    const expandItem = document.createElement("div");
    expandItem.className = "tools-menu-item custom-collapse-item";
    expandItem.id = "expandAllBtn";
    expandItem.innerHTML = `${expandSvg}<span>Expand All</span>`;
    expandItem.addEventListener("click", (e) => {
      e.stopPropagation();
      expandAll();
      setTimeout(() => document.dispatchEvent(new MouseEvent("click")), 10);
    });

    const separator = document.createElement("div");
    separator.className = "tools-menu-separator";

    // Prepend: Collapse All, Expand All, separator, then existing items
    viewMenu.prepend(separator);
    viewMenu.prepend(expandItem);
    viewMenu.prepend(collapseItem);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    injectViewMenuItems();
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(init, 150);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
