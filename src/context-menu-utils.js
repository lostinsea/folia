// ============================================
// context-menu-utils.js - Context Menu Helpers
// ============================================

/**
 * Position a context menu element at the given coordinates
 * Automatically adjusts position if menu would go off screen
 * @param {HTMLElement} menuElement - The context menu element
 * @param {number} x - X coordinate (clientX)
 * @param {number} y - Y coordinate (clientY)
 */
function positionContextMenu(menuElement, x, y) {
  // Set initial position
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;

  // Show the menu (needed to get accurate dimensions)
  menuElement.classList.add('visible');

  // Adjust position if menu goes off screen
  const menuRect = menuElement.getBoundingClientRect();
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  if (menuRect.right > windowWidth) {
    menuElement.style.left = `${windowWidth - menuRect.width - 10}px`;
  }
  if (menuRect.bottom > windowHeight) {
    menuElement.style.top = `${windowHeight - menuRect.height - 10}px`;
  }
}

/**
 * Hide a context menu element
 * @param {HTMLElement} menuElement - The context menu element
 */
function hideContextMenu(menuElement) {
  menuElement.classList.remove('visible');
}

// Export for use in other modules
module.exports = {
  positionContextMenu,
  hideContextMenu
};
