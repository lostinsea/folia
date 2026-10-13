(function () {
// ============================================
// context-menu-utils.js - Context Menu Helpers
// ============================================

const scrollProtectedMenus = new WeakSet();

/**
 * Position a context menu element at the given coordinates
 * Automatically adjusts position if menu would go off screen
 * @param {HTMLElement} menuElement - The context menu element
 * @param {number} x - X coordinate (clientX)
 * @param {number} y - Y coordinate (clientY)
 */
function positionContextMenu(menuElement, x, y) {
  if (!scrollProtectedMenus.has(menuElement)) {
    // The caller dismisses on document scroll in capture phase. Intercept only
    // this menu's scroll earlier, so its commands stay reachable while the
    // document's ordinary scroll-to-dismiss behaviour remains unchanged.
    menuElement.ownerDocument.defaultView.addEventListener('scroll', (event) => {
      if (event.target.nodeType && menuElement.contains(event.target)) event.stopPropagation();
    }, true);
    scrollProtectedMenus.add(menuElement);
  }

  // A fixed auto-width box shrink-wraps against its left inset. Measure from
  // the viewport edge, not the click point, before choosing its final position.
  menuElement.style.left = '10px';
  menuElement.style.top = '10px';

  // Show the menu (needed to get accurate dimensions)
  menuElement.classList.add('visible');

  // Adjust position if menu goes off screen
  // Fade-in scales the painted rectangle; fitting that transient rectangle
  // leaves the final menu outside the viewport. Use untransformed layout size.
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;
  const left = Math.max(10, Math.min(x, windowWidth - menuElement.offsetWidth - 10));
  const top = Math.max(10, Math.min(y, windowHeight - menuElement.offsetHeight - 10));
  menuElement.style.left = `${left}px`;
  menuElement.style.top = `${top}px`;
  menuElement.scrollTop = 0;
  menuElement.scrollLeft = 0;
}

/**
 * Hide a context menu element
 * @param {HTMLElement} menuElement - The context menu element
 */
function hideContextMenu(menuElement) {
  menuElement.classList.remove('visible');
}

// Export for use in other modules
const contextMenuUtils = {
  positionContextMenu,
  hideContextMenu
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = contextMenuUtils;
}
if (typeof window !== 'undefined') {
  window.FoliaContextMenu = contextMenuUtils;
}
})();
