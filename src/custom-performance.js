/**
 * Custom Performance Optimizations
 * Reduces CPU usage when app is idle or not in focus
 * Part of customization overlay - loaded after renderer.js
 */

(function() {
  'use strict';

  console.log('[CustomPerf] Loading performance optimizations...');

  let isWindowFocused = document.hasFocus();
  let mouseMoveThrottleTimeout = null;

  function init() {
    console.log('[CustomPerf] Initializing...');

    // ---- Focus / blur ----
    window.addEventListener('focus', () => {
      isWindowFocused = true;
    });

    window.addEventListener('blur', () => {
      isWindowFocused = false;
      // Dismiss floating panels that run continuous rendering
      const recentPanel = document.querySelector('.recent-panel');
      if (recentPanel && recentPanel.classList.contains('visible')) {
        recentPanel.classList.remove('visible');
      }
    });

    // ---- Page visibility (switching apps / screen lock) ----
    document.addEventListener('visibilitychange', () => {
      isWindowFocused = !document.hidden;
      if (document.hidden) {
        const recentPanel = document.querySelector('.recent-panel');
        if (recentPanel) recentPanel.classList.remove('visible');
      }
    });

    // ---- IPC events from main process ----
    if (window.ipcRenderer) {
      // Window minimised / restored
      window.ipcRenderer.on('window-visibility-changed', (_event, data) => {
        console.log('[CustomPerf] Window visibility:', data.visible);
        isWindowFocused = data.visible;
        if (!data.visible) {
          const recentPanel = document.querySelector('.recent-panel');
          const fileUpdateToast = document.getElementById('fileUpdateToast');
          const appUpdateToast  = document.getElementById('appUpdateToast');
          if (recentPanel)      recentPanel.classList.remove('visible');
          if (fileUpdateToast)  fileUpdateToast.classList.remove('show');
          if (appUpdateToast)   appUpdateToast.classList.remove('show');
        }
      });
    }

    // ---- Throttle mousemove to reduce CPU from upstream's unthrottled listener ----
    let lastMouseX = -1;
    let lastMouseY = -1;
    const MOUSE_THROTTLE_MS = 80;

    document.addEventListener('mousemove', (e) => {
      // Drop events entirely when window is not active
      if (!isWindowFocused || document.hidden) {
        e.stopImmediatePropagation();
        return;
      }

      // Drop events that arrive faster than the throttle window
      if (mouseMoveThrottleTimeout) {
        e.stopImmediatePropagation();
        return;
      }

      // Drop micro-movements (< 5px)
      const dx = Math.abs(e.clientX - lastMouseX);
      const dy = Math.abs(e.clientY - lastMouseY);
      if (dx < 5 && dy < 5) {
        e.stopImmediatePropagation();
        return;
      }

      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      // Allow this event, then gate the next batch
      mouseMoveThrottleTimeout = setTimeout(() => {
        mouseMoveThrottleTimeout = null;
      }, MOUSE_THROTTLE_MS);

    }, true); // capture phase – runs before renderer.js listener

    console.log('[CustomPerf] Active: mousemove throttled, idle-window gating enabled');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
