/**
 * Custom Theme Selector
 * Replaces the upstream binary Dark Mode toggle with a three-way submenu:
 *   Light | Dark | Follow Desktop
 *
 * Overlay file — safe across upstream merges.
 * Load after renderer.js in index.html.
 *
 * Strategy: keep the original #darkModeToggle hidden but intact so its click
 * handler (which re-renders Mermaid diagrams, etc.) is still
 * called when we need to actually change the theme.  We only trigger it when
 * the desired state differs from the current state.
 */

(function initCustomTheme() {
  "use strict";

  const PREF_KEY = "themeMode"; // 'light' | 'dark' | 'desktop'

  // ─── Apply a theme mode ────────────────────────────────────────────────────

  function applyTheme(mode) {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const wantDark = mode === "dark" || (mode === "desktop" && prefersDark);
    const isDark = document.body.classList.contains("dark-mode");

    localStorage.setItem(PREF_KEY, mode);

    // Delegate to the original toggle so Mermaid side-effects run
    if (wantDark !== isDark) {
      const toggle = document.getElementById("darkModeToggle");
      if (toggle) toggle.click();
    }

    // Mark the active option in our submenu
    document.querySelectorAll(".custom-theme-option").forEach((el) => {
      el.classList.toggle("active", el.dataset.mode === mode);
    });
  }

  // ─── Build the replacement submenu ────────────────────────────────────────

  function buildThemeMenuItem() {
    const item = document.createElement("div");
    item.className = "tools-menu-item has-submenu";
    item.id = "customThemeMenuItem";

    const sunSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>`;
    const moonSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>`;
    const monitorSvg = `<svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>`;

    item.innerHTML = `
      <span>Theme</span>
      <span class="submenu-arrow">›</span>
      <div class="tools-submenu" id="customThemeSubmenu">
        <div class="tools-submenu-item custom-theme-option" data-mode="light">${sunSvg} Light</div>
        <div class="tools-submenu-item custom-theme-option" data-mode="dark">${moonSvg} Dark</div>
        <div class="tools-submenu-item custom-theme-option" data-mode="desktop">${monitorSvg} Desktop</div>
      </div>
    `;

    const submenu = item.querySelector("#customThemeSubmenu");

    // ── JS-controlled hover with a grace-period delay ──────────────────────
    // Pure CSS :hover fires the submenu close the instant the mouse crosses
    // the 4 px gap between the parent item and the submenu panel.
    // Using mouseenter/mouseleave + a 200 ms timeout gives the user time to
    // move diagonally without the panel vanishing.
    let hideTimer = null;

    function showSubmenu() {
      clearTimeout(hideTimer);
      item.classList.add("theme-open");
    }

    function scheduleHide() {
      hideTimer = setTimeout(() => item.classList.remove("theme-open"), 200);
    }

    item.addEventListener("mouseenter", showSubmenu);
    item.addEventListener("mouseleave", scheduleHide);
    submenu.addEventListener("mouseenter", showSubmenu); // keep open while inside panel
    submenu.addEventListener("mouseleave", scheduleHide);

    item.querySelectorAll(".custom-theme-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        applyTheme(opt.dataset.mode);
        item.classList.remove("theme-open");
        // Close the parent dropdown by simulating an outside click
        setTimeout(() => document.body.click(), 10);
      });
    });

    return item;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    const originalToggle = document.getElementById("darkModeToggle");
    if (!originalToggle || document.getElementById("customThemeMenuItem"))
      return;

    // Hide the upstream toggle — our submenu replaces it in the UI
    originalToggle.style.display = "none";

    // Insert the new submenu item right before the hidden toggle
    const themeMenuItem = buildThemeMenuItem();
    originalToggle.parentNode.insertBefore(themeMenuItem, originalToggle);

    // React to OS theme changes when the user has chosen "Follow Desktop"
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if ((localStorage.getItem(PREF_KEY) || "desktop") === "desktop") {
          applyTheme("desktop");
        }
      });

    // Restore saved preference.
    // Migrate from the legacy 'darkMode' key if 'themeMode' was never set.
    let saved = localStorage.getItem(PREF_KEY);
    if (!saved) {
      const legacy = localStorage.getItem("darkMode");
      saved =
        legacy === "enabled"
          ? "dark"
          : legacy === "disabled"
            ? "light"
            : "desktop";
    }
    applyTheme(saved);
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
